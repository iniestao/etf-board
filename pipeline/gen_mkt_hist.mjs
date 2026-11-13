/**
 * 回算「全 A 个股口径」的集中度与宽度 → worker/src/mkt_hist.js
 * ============================================================
 * 宽度 b 的分母是「全 A 个股」，不是行业——行业是等权样本，一个行业里 500 只
 * 股票 8 只涨 492 只跌，行业层面看是「跌」，个股层面是「1.6% 在涨」，差两个
 * 数量级。宽度问的本来就是「今天有多少票在涨」。
 *
 * 集中度 c 的分母是「全 A 个股成交额」，行业归属取 EM2016（东方财富自建分类，
 * 三级，形如「家电-白色家电-白色家电」）。一只股票只归一个三级行业，互不重叠。
 *
 * ---- 为什么不再走东财 push2 ----
 * 2026-11-11 起 push2 / push2his 的 /api/qt/* 对数据中心出口一律「TLS 握手成功后
 * 直接断连」（curl exit 52，Node fetch failed，Actions 上 502）。同一台机器上
 * 首页、datacenter-web、emweb F10 都还是 200——是接口路径被拦，不是域名挂了。
 * 于是三个数据源全换掉：
 *   清单：新浪 hs_a（5223 只，剔北交所）           —— 原 push2 clist
 *   日线：腾讯 newfqkline（qfq，320 根）           —— 原 push2his kline
 *   行业：本地 pipeline/ind_em2016.json            —— 原 clist f100
 * 行业是慢变量，一只股票一年未必换一次，没必要每天重拉 5223 次 emweb。
 * 那份表由 gen_ind_map.mjs 按周/按月刷新，回算只读本地文件。
 *
 * 换源的额外好处：不再有「东财挂了就走增量、c 停在前一天」的降级分支。
 * 每天都是 250 天全量重算，c 和 b 永远同一天，不会出现半新半旧的数组。
 *
 * 口径定义：
 *   b = 上涨家数 ÷ (上涨 + 下跌) × 1000
 *       平盘和停牌不参与分母。50% 就是「涨跌各半」的自然中线。
 *   c = TOP3 三级行业成交额 ÷ 全 A 个股成交额 × 1000
 *       分母是全部个股（含少数无行业归属的），不是「有行业个股之和」，
 *       否则集中度会虚高。
 *   p5 = 成交额最大的 5% 个股 ÷ 全 A 成交额 × 1000
 *       行业口径抓的是「行业抱团」，个股口径抓的是「个股抱团」——
 *       寒武纪单票一天吃掉全市场 2% 成交时，行业口径只显示半导体 22%。
 *
 * 已知偏差（均可忽略，但写下来）：
 *   - 行业归属用当前快照，250 天里改过行业的算在新行业里；
 *   - 期间退市的股票不在当前清单里，早期成交额会略微低估；
 *   - 停牌复牌日按「相邻前复权收盘比」算涨跌，会把停牌期间涨幅并到复牌日
 *     （东财口径是交易所当日涨跌幅，两者在复牌日会差一些，方向通常一致）。
 *
 * 用法：node pipeline/gen_mkt_hist.mjs [--days 250] [--out worker/src/mkt_hist.js]
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DAYS = +argOf('--days', 250);
const OUT = argOf('--out', 'worker/src/mkt_hist.js');
const JSON_OUT = argOf('--json', 'dist/mkt_hist.json');
const IND_MAP = argOf('--ind', 'pipeline/ind_em2016.json');
const CH = +argOf('--concurrency', 10);
const SNAP = DAYS + 70;   // 多要一些根：第一根没有前收要丢，停牌股还会少几根

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36' };

/* ---------------- 1. 全 A 清单（新浪 hs_a） ---------------- */
const SINA_LIST = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php'
  + '/Market_Center.getHQNodeData';

async function sinaList() {
  const seen = new Set();
  const out = [];
  for (let p = 1; p <= 70; p++) {
    let arr;
    try {
      const r = await fetch(`${SINA_LIST}?page=${p}&num=100&sort=symbol&asc=1&node=hs_a`,
        { headers: { ...UA, Referer: 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) break;
      arr = JSON.parse(await r.text());
    } catch (e) { break; }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const x of arr) {
      const s = String(x.symbol || '');
      // 北交所（bj）不进：流动性和涨跌幅规则都不同，混进来宽度会多抖 2-3 个点
      if (!/^(sh|sz)\d{6}$/.test(s) || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/* ---------------- 2. 行业映射（EM2016） ---------------- */
if (!existsSync(IND_MAP)) {
  throw new Error(`行业映射缺失：${IND_MAP}，先跑 node pipeline/gen_ind_map.mjs`);
}
const indFile = JSON.parse(readFileSync(IND_MAP, 'utf8'));
const indOf = (sym) => {
  const it = indFile.items[sym.slice(2)];
  return it && it.em ? it.em : null;
};
const mapAge = (Date.now() - Date.parse(indFile.generated_at)) / 86400e3;

/* ---------------- 3. 日线（腾讯 qfq） ---------------- */
/** 腾讯日线。列序：[日期, 开, 收, 高, 低, 量(手), {}, 涨跌幅%, 成交额(万元)]
 *  涨跌不取第 7 列：除权日是未复权口径会虚高，用相邻前复权收盘比更稳。 */
async function txKline(sym, n) {
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param='
    + sym + ',day,,,' + n + ',qfq';
  const r = await fetch(url, { headers: { ...UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const node = j && j.data && j.data[sym];
  const rows = (node && (node.qfqday || node.day)) || [];
  return rows;
}

console.log('拉全 A 清单…');
const list = await sinaList();
if (list.length < 4000) throw new Error(`新浪清单只有 ${list.length} 只，上游不正常`);
const noMap = list.filter((s) => !indOf(s)).length;
console.log(`  ${list.length} 只（hs_a，已剔北交所）· 行业表 ${mapAge.toFixed(1)} 天前`
  + ` · ${noMap} 只无行业归属`);

// ---- 逐只拉 K 线，边拉边按日聚合 ----
const dayUp = new Map(), dayDn = new Map(), dayFlat = new Map(), dayN = new Map();
const dayAllAmt = new Map();
const dayAmts = new Map();          // 每天个股成交额列表，算 p5
const indAmtByDay = new Map();      // 三级行业 -> Map(day -> amt)
const indAmtL2 = new Map();         // 二级行业 -> Map(day -> amt)，只用于口径对比
const failed = [];
const empty = [];

async function one(sym) {
  let rows;
  try { rows = await txKline(sym, SNAP); } catch (e) { failed.push(sym); return; }
  // 空 K 线不是错误：新股未上市、退市股都长这样，重试只会更慢
  if (!rows.length) { empty.push(sym); return; }

  const em = indOf(sym);
  const l3 = em ? em.split('-')[2] : null;
  const l2 = em ? em.split('-')[1] : null;
  let m3 = null, m2 = null;
  if (l3) {
    m3 = indAmtByDay.get(l3); if (!m3) { m3 = new Map(); indAmtByDay.set(l3, m3); }
  }
  if (l2) {
    m2 = indAmtL2.get(l2); if (!m2) { m2 = new Map(); indAmtL2.set(l2, m2); }
  }

  for (let i = 1; i < rows.length; i++) {
    const a = rows[i];
    const d = a[0];
    const close = +a[2];
    const prev = +rows[i - 1][2];
    const amt = (+a[8] || 0) * 1e4;      // 万元 → 元
    // 停牌日腾讯不返回该行；有行但成交额为 0 的算当日无成交，不进家数
    if (!(amt > 0 && prev > 0 && close > 0)) continue;
    dayN.set(d, (dayN.get(d) || 0) + 1);
    dayAllAmt.set(d, (dayAllAmt.get(d) || 0) + amt);
    let al = dayAmts.get(d);
    if (!al) { al = []; dayAmts.set(d, al); }
    al.push(amt);
    if (m3) m3.set(d, (m3.get(d) || 0) + amt);
    if (m2) m2.set(d, (m2.get(d) || 0) + amt);
    const chg = close / prev - 1;
    if (chg > 0.0001) dayUp.set(d, (dayUp.get(d) || 0) + 1);
    else if (chg < -0.0001) dayDn.set(d, (dayDn.get(d) || 0) + 1);
    else dayFlat.set(d, (dayFlat.get(d) || 0) + 1);
  }
}

console.log(`拉个股日线（每只 ${SNAP} 根，${CH} 并发）…`);
const t0 = Date.now();
for (let i = 0; i < list.length; i += CH) {
  await Promise.all(list.slice(i, i + CH).map(one));
  const n = Math.min(i + CH, list.length);
  if (n % 500 < CH || n === list.length) {
    process.stdout.write(`  ${n}/${list.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\r`);
  }
}
console.log('');

// 补拉：腾讯偶发 socket 断连，单轮失败率通常 1% 以内
for (let round = 1; round <= 3 && failed.length; round++) {
  const todo = failed.splice(0, failed.length);
  console.log(`  补拉第 ${round} 轮：${todo.length} 只（并发 4）…`);
  await sleep(1200 * round);
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(one));
  }
}
if (empty.length) console.log(`  ${empty.length} 只 K 线为空（退市/未上市），已跳过`);
if (failed.length > list.length * 0.02) {
  throw new Error(`K 线失败率过高 ${failed.length}/${list.length}，上游可能限流`);
}
if (failed.length) console.log(`  ${failed.length} 只补拉后仍失败，已跳过`);

/* ---------------- 4. 按日回算 ---------------- */
/* 完整性闸门：两件事要分开判。
 *   1) 「今天」这根在 15:05 之前一定是半截——开盘 20 分钟就有 5000 多只成交、
 *      成交额也能到 5000 亿以上，用绝对阈值根本拦不住。按北京时间判最稳。
 *   2) 其余日子的异常（上游漏数据）用绝对量级兜底：全 A 单日成交常态
 *      8000 亿 ~ 3 万亿、有成交个股 4500+ 只。
 * 闸门放在聚合之后而不是取数阶段：每只都多给了几十根，退回上一根是免费的。 */
const bjNow = new Date(Date.now() + 8 * 3600e3);
const todayStr = bjNow.toISOString().slice(0, 10);
const bjMins = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
const allDays = [...dayN.keys()].sort();
const complete = allDays.filter((d) => {
  // 15:05 之前，今天的 K 线还没走完（含收盘集合竞价落定）
  if (d === todayStr && bjMins < 15 * 60 + 5) return false;
  const tot = dayAllAmt.get(d) || 0;
  return tot > 5e11 && (dayN.get(d) || 0) > 4500;
});
const cSet = new Set(complete);
const skipped = allDays.filter((d) => !cSet.has(d));
if (skipped.length) {
  console.log(`  跳过 ${skipped.length} 个不完整交易日`);
  for (const d of [...skipped.slice(0, 3), ...skipped.slice(-3)]) {
    console.log(`    ${d} 成交 ${((dayAllAmt.get(d) || 0) / 1e8).toFixed(0)} 亿 · ${dayN.get(d) || 0} 只`);
  }
}

const dates = complete.slice(-DAYS);
if (dates.length < 200) throw new Error(`交易日不足 200 天（${dates.length}），上游可能限流`);

const C = [], C2 = [], B = [], N = [], UP = [], DN = [], P5 = [], T = [], A = [];
const l3Names = [...new Set([...indAmtByDay.keys()])].sort();
const l3Idx = new Map(l3Names.map((n, i) => [n, i]));
/** 某日成交额 TOP3 行业。排序只在这 250 天内做，全量 244 个键 × 250 天 = 6 万次比较，可忽略。 */
const tops = (src, d) => [...src.entries()]
  .map(([k, m]) => [k, m.get(d) || 0])
  .filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3);

let lastTop3 = [];
for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  const up = dayUp.get(d) || 0, dn = dayDn.get(d) || 0;
  const tot = dayAllAmt.get(d) || 0;

  const top = tops(indAmtByDay, d);
  T.push(top.map(([k]) => (l3Idx.has(k) ? l3Idx.get(k) : -1)));
  if (i === dates.length - 1) lastTop3 = top.map(([k]) => k);

  C.push(tot > 0 ? Math.round(top.reduce((s, x) => s + x[1], 0) / tot * 1000) : 0);
  const top2 = tops(indAmtL2, d);
  C2.push(tot > 0 ? Math.round(top2.reduce((s, x) => s + x[1], 0) / tot * 1000) : 0);

  const amts = (dayAmts.get(d) || []).slice().sort((a, b) => b - a);
  const k5 = Math.max(1, Math.round(amts.length * 0.05));
  const sum5 = amts.slice(0, k5).reduce((s, x) => s + x, 0);
  const sumAll = amts.reduce((s, x) => s + x, 0);
  P5.push(amts.length > 200 ? Math.round(sum5 / sumAll * 1000) : 0);

  B.push(up + dn > 0 ? Math.round(up / (up + dn) * 1000) : 0);
  N.push(dayN.get(d) || 0);
  UP.push(up); DN.push(dn);
  // 全 A 成交额（亿元）。页面要显示「缩量普涨」这类组合，光有家数不够。
  A.push(Math.round(tot / 1e8));
}

/* ---------------- 5. 自检 ---------------- */
const last = dates.length - 1;
const amtLast = dayAllAmt.get(dates[last]) || 0;
console.log('自检：');
console.log(`  最后交易日 ${dates[last]} · 全 A 成交 ${(amtLast / 1e8).toFixed(0)} 亿`
  + ` · ${N[last]} 只有成交（${UP[last]} 涨 ${DN[last]} 跌 ${(dayFlat.get(dates[last]) || 0)} 平）`);
console.log(`  集中度 L3 ${(C[last] / 10).toFixed(1)}% · TOP3 ${lastTop3.join('、')}`);
console.log(`  集中度 L2 ${(C2[last] / 10).toFixed(1)}%（对照，不写入）`);
console.log(`  宽度 ${(B[last] / 10).toFixed(1)}% · 个股前5%成交占比 ${(P5[last] / 10).toFixed(1)}%`);

const p5Bad = P5.filter((v) => !(v > 50 && v < 900));
if (p5Bad.length > dates.length * 0.05) throw new Error(`个股前5%占比量级异常 ${p5Bad.length}/${dates.length} 天`);
const amtBad = dates.filter((d) => { const v = dayAllAmt.get(d) / 1e8; return !(v > 3000 && v < 40000); });
if (amtBad.length > dates.length * 0.1) throw new Error(`成交额量级异常 ${amtBad.length}/${dates.length} 天`);
const cBad = C.filter((v) => !(v > 30 && v < 800));
if (cBad.length > dates.length * 0.05) throw new Error(`集中度量级异常 ${cBad.length}/${dates.length} 天（应 3%~80%）`);
const bVals = B.filter((v) => v > 0);
const bSpread = Math.max(...bVals) - Math.min(...bVals);
if (bSpread < 200) throw new Error(`宽度几乎不动（极差 ${bSpread / 10}pt），口径可能退化`);
console.log(`  250 天宽度极差 ${(bSpread / 10).toFixed(0)} 分位点 · 集中度 ${(Math.min(...C) / 10).toFixed(1)}% ~ ${(Math.max(...C) / 10).toFixed(1)}%`);

/* ---------------- 6. 落盘 ---------------- */
const payload = {
  d: dates, c: C, b: B, n: N, u: UP, w: DN, p5: P5, a: A,
  t3: lastTop3, t: T, ind: l3Names, inds: l3Names.length,
  cVer: 'em2016-l3', cStale: false,
};
const head = '// 由 pipeline/gen_mkt_hist.mjs 回算生成，勿手改。\n'
  + '// 全 A 个股口径（新浪清单 + 腾讯日线 + EM2016 三级行业）：\n'
  + '//   c = TOP3 三级行业成交额 ÷ 全 A 个股成交额（千分位，21.6% → 216）\n'
  + '//   b = 上涨家数 ÷ (上涨+下跌) 家数（千分位；平盘/停牌不进分母，50% = 涨跌各半）\n'
  + '//   n = 当日有成交的个股数（分母规模，随上市/停牌浮动）\n'
  + '//   u / w = 当日上涨 / 下跌家数（绝对数，卡片直接显示）\n'
  + '//   a = 当日全 A 成交额（亿元）\n'
  + `// ${dates.length} 个交易日（${dates[0]} → ${dates[dates.length - 1]}）\n`;
const js = head + 'export const MKT_HIST = ' + JSON.stringify(payload) + ';\n'
  + 'export const MKT_INDS = ' + JSON.stringify(l3Names) + ';\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, js);
mkdirSync(dirname(JSON_OUT), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  last_trade_date: dates[last],
  inds: l3Names.length,
  stocks: list.length,
  ind_map_age_days: +mapAge.toFixed(1),
  no_ind: noMap,
  c_l2: C2,
  ...payload,
}));

console.log('');
console.log(`${OUT}  ${(js.length / 1024).toFixed(1)} KB · ${dates.length} 天 · ${l3Names.length} 个三级行业`);
