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
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DAYS = +argOf('--days', 250);
const OUT = argOf('--out', 'worker/src/mkt_hist.js');
const JSON_OUT = argOf('--json', 'dist/mkt_hist.json');
const IND_MAP = argOf('--ind', 'pipeline/ind_em2016.json');
// 紧跟 --out 走：本地用 --out /tmp/x.js 试跑时不该往仓库里写东西
const IND_OUT = join(dirname(OUT), 'mkt_ind.js');
const SENTI_OUT = join(dirname(OUT), 'senti_hist.js');
const SENTI_JSON = join(dirname(JSON_OUT), 'senti_hist.json');
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
      if (!r.ok) { console.log(`  新浪清单第 ${p} 页 HTTP ${r.status}，停止翻页`); break; }
      arr = JSON.parse(await r.text());
    } catch (e) { console.log(`  新浪清单第 ${p} 页失败：${e.message}`); break; }
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

/* 新浪清单被挡时的兜底：行业映射表本身就是一张全 A 名单（5000+ 只带名称），
   只是新股要等映射刷新才进表——比整天不出数强。
   2026-11-20 那轮新浪返回 0 只，gen_mkt_hist 和 gen_senti_base 一起抛错，
   两份文件没生成，发布时又被当成"这轮不发布"，直接从 data 分支上消失了。 */
function mapList() {
  const f = JSON.parse(readFileSync(IND_MAP, 'utf8'));
  const out = [];
  for (const code of Object.keys(f.items || {})) {
    const c = code[0];
    if (c !== '6' && c !== '0' && c !== '3') continue;   // 剔北交所、B 股
    out.push((c === '6' ? 'sh' : 'sz') + code);
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
let list = await sinaList();
if (list.length < 4000) {
  const alt = mapList();
  console.log(`  新浪只给了 ${list.length} 只，改用行业映射表的 ${alt.length} 只兜底`
    + '（新股可能晚几天才进表，其余口径不变）');
  if (alt.length > list.length) list = alt;
}
if (list.length < 4000) throw new Error(`清单只有 ${list.length} 只，新浪和映射表都不正常`);
const noMap = list.filter((s) => !indOf(s)).length;
console.log(`  ${list.length} 只（hs_a，已剔北交所）· 行业表 ${mapAge.toFixed(1)} 天前`
  + ` · ${noMap} 只无行业归属`);

// ---- 逐只拉 K 线，边拉边按日聚合 ----
const dayUp = new Map(), dayDn = new Map(), dayFlat = new Map(), dayN = new Map();
const dayAllAmt = new Map();
const dayAmts = new Map();          // 每天个股成交额列表，算 p5
const indAmtByDay = new Map();      // 三级行业 -> Map(day -> amt)
/* 三级行业 -> Map(day -> Σ(amt × 当日涨跌幅))。除以当日行业成交额就是
   **成交额加权的行业涨幅**，和盘中 aggLive 里那个 indPv 完全同一个算法。
   不加这个，收盘 20:00 之后卡片改读静态日档，浮窗就只剩三个名字、
   没有涨跌——用户看到「额前三 集成电路、电子元件、通信传输设备」会直接
   读成「这三个在涨」，而当天它们可能全绿。 */
const indPvByDay = new Map();
const indAmtL2 = new Map();         // 二级行业 -> Map(day -> amt)，只用于口径对比
const failed = [];
const empty = [];

/* ---------------- 3b. 情绪口径（涨跌停） ----------------
 * 「昨日涨停池今日表现」这类指标盘中任何时刻样本都不变，是唯一能在 10:00 就定调
 * 的那一组（涨停家数 10:00 只完成 17%~58%，SD 13.9pt，纯噪声）。所以历史里必须
 * 有「每天哪些票涨停、次日表现如何」，否则盘中只能拿收盘数糊弄。
 *
 * 规则必须与 worker 的 aggSenti 完全一致，差一个字盘中「今天」和历史「那一刻」
 * 就没法比了。20cm 是 688/300/301/302——科创、创业板的 ST 仍是 20%；只有
 * 「主板 + ST/*ST」才是 5%。
 *
 * 已知偏差：ST 状态取当前简称，250 天里摘帽/戴帽的票会算错一档（行业归属用当前
 * 快照也是同性质偏差）。复牌日 chg 跨停牌期，靠 rate*1.6 上限挡掉，不单独处理。 */
const ztDay = new Map(), dtDay = new Map(), touchDay = new Map();
const zPoolByDay = new Map();       // day -> [[code, 连板数], …]
const dPoolByDay = new Map();       // day -> [code, …]
/* 只存「曾涨停或曾跌停过」的票的逐日表现（约 2000 只 × 250 天）。
 * 全存是 130 万条、几十 MB；只存这些票就够回算承接，省一个数量级。 */
const dayRec = new Map();           // code -> {days:[], p:[], h:[], c:[]}
const nmOf = (code) => (indFile.items[code] && indFile.items[code].n) || '';
/* 历史口径一律忽略 ST —— 下面两处调用都刻意传 false。
 * 原因：ST 状态只有「当前」快照（行业表里的简称），250 天里戴帽摘帽改过好几轮。
 * 实测 11-13：*ST闻泰、ST椰岛、*ST未名、*ST威领、*ST华鹏 这些票当时都不是 ST，
 * 按今天的简称套 5% 会把它们 -6% 的下跌判成跌停，跌停家数从 33 虚报到 44，
 * 涨停也从 37 虚报到 40。反方向（当时是 ST、现在摘帽）只会漏判几只，不会凭空多票。
 * 漏判比多判安全：池子少一只 ST 对承接率影响 < 2%；凭空多 11 只会让「昨日跌停池
 * 今日仍跌停」整体失真。盘中实时则相反——当天的 ST 就写在当天简称里，必须判 5%，
 * 那份逻辑在 worker 的 aggSenti 里，与这里不是同一份代码。 */
function sentiRate(code, isSt) {
  const p = code.slice(0, 3);
  if (p === '688' || p === '300' || p === '301' || p === '302') return 0.20;
  return isSt ? 0.05 : 0.10;
}

async function one(sym) {
  let rows;
  try { rows = await txKline(sym, SNAP); } catch (e) { failed.push(sym); return; }
  // 空 K 线不是错误：新股未上市、退市股都长这样，重试只会更慢
  if (!rows.length) { empty.push(sym); return; }

  const em = indOf(sym);
  const code = sym.slice(2);
  const rate = sentiRate(code, false);
  let streak = 0, ztEver = false, dtEver = false;
  const rec = { days: [], p: [], h: [], c: [] };
  const l3 = em ? em.split('-')[2] : null;
  const l2 = em ? em.split('-')[1] : null;
  let m3 = null, m2 = null, m3p = null;
  if (l3) {
    m3 = indAmtByDay.get(l3); if (!m3) { m3 = new Map(); indAmtByDay.set(l3, m3); }
    m3p = indPvByDay.get(l3); if (!m3p) { m3p = new Map(); indPvByDay.set(l3, m3p); }
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
    if (m3p) m3p.set(d, (m3p.get(d) || 0) + amt * chg);

    /* 涨跌停判定：一律走整数分，不用「涨跌幅 ± 比例容差」。
       比例容差是个陷阱——涨停价 round 到分之后，低价股的实际涨停涨幅只有
       9.71%（1.03 → 1.13），而中价股 -9.7% 的真实跌幅又会被 0.3pt 容差吞进来。
       实测这一条会让 11-13 的跌停家数从 33 虚报到 53，多出来的 20 只全是
       跌 9.7%~9.9% 但没封板的票（600183、002384、002463 …）。
       qfq 价格带小数，round 到分本身有 ±0.5 分误差，边界票仍可能错一只，
       但比 0.3pt 容差准确一个数量级。
       上限 rate*1.6 挡掉新股首日与复牌跳空——那些日子没有涨跌幅限制。 */
    const prevC = Math.round(prev * 100), closeC = Math.round(close * 100);
    const hiC = Math.round((+a[3] || 0) * 100);
    const limUp = Math.round(prevC * (1 + rate));
    const limDn = Math.round(prevC * (1 - rate));
    const inBand = chg <= rate * 1.6 && chg >= -rate * 1.6;
    const isZt = closeC >= limUp && inBand;
    const isTouch = hiC >= limUp && inBand;
    const isDt = closeC <= limDn && inBand;

    if (isZt) {
      ztEver = true;
      // 连板：停牌日上面已经 continue 过了，streak 不会被打断——交易所口径
      // 也是「连续交易日」，停一天不算断板
      streak++;
      let zl = zPoolByDay.get(d);
      if (!zl) { zl = []; zPoolByDay.set(d, zl); }
      zl.push([code, streak]);
      ztDay.set(d, (ztDay.get(d) || 0) + 1);
    } else streak = 0;
    if (isDt) {
      dtEver = true;
      let dl = dPoolByDay.get(d);
      if (!dl) { dl = []; dPoolByDay.set(d, dl); }
      dl.push(code);
      dtDay.set(d, (dtDay.get(d) || 0) + 1);
    }
    if (isTouch) touchDay.set(d, (touchDay.get(d) || 0) + 1);
    if (ztEver || dtEver) {
      /* p = 当日涨跌幅；h / c = 最高价 / 收盘价的「整数分」。
         存分而不是比例，是为了回算时还能重算涨停价——比例容差在低价股上
         会把 -9.7% 当成跌停（见上面的注释）。 */
      rec.days.push(d); rec.p.push(chg); rec.h.push(hiC); rec.c.push(closeC);
    }

    if (chg > 0.0001) dayUp.set(d, (dayUp.get(d) || 0) + 1);
    else if (chg < -0.0001) dayDn.set(d, (dayDn.get(d) || 0) + 1);
    else dayFlat.set(d, (dayFlat.get(d) || 0) + 1);
  }
  if (ztEver || dtEver) dayRec.set(code, rec);
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
/* 每天 TOP3 行业的当日涨幅与成交额，和 T 一一对应（250 × 3）。
   涨幅存「百分数 × 100」的整数（−292 = −2.92%），与盘中 live 两位小数同精度；
   成交额存亿元整数。没它，「额前三」这三个名字在静态日档里就是没有数字的裸名。 */
const T3P = [], T3A = [];
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

  /* 三个行业的涨幅：Σ(amt×chg) ÷ Σamt，与盘中 aggLive 的 indPv/indAmt 同算法。
     除出来是比例（−0.0292），×10000 变成「百分数 ×100」的整数（−292）。 */
  T3P.push(top.map(([k, amt]) => {
    const m = indPvByDay.get(k);
    const pv = m ? (m.get(d) || 0) : 0;
    return amt > 0 ? Math.round(pv / amt * 10000) : 0;
  }));
  T3A.push(top.map(([, amt]) => Math.round(amt / 1e8)));

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

/* ---------------- 4b. 承接回算（昨日池 → 今日表现） ----------------
 * 分母用「当日仍有成交的池成员数」，不是池总数：停牌票没有涨跌幅，算进分母
 * 会把红盘率往下拽。卡片上同时显示样本数，用户看得见分母是谁。
 * 中位涨幅存「百分数 × 100」的整数（−427 = −4.27%），与盘中两位小数同精度。 */
const pC = new Map();               // code -> Map(day -> 该日在本票记录里的下标)
for (const [code, r] of dayRec) pC.set(code, new Map(r.days.map((d, i) => [d, i])));

function sideOf(pool, day, isZt) {
  let n = 0, red = 0, big = 0, promo = 0, touch = 0, still = 0;
  const ps = [];
  for (const it of pool) {
    const code = isZt ? it[0] : it;
    const r = dayRec.get(code);
    if (!r) continue;
    const m = pC.get(code);
    const k = m ? m.get(day) : undefined;
    if (k === undefined) continue;    // 当日停牌/无成交
    const p = r.p[k];
    n++;
    if (p > 0) red++;
    if (p <= -0.07) big++;
    ps.push(p);
    const rate = sentiRate(code, false);
    // 昨日收盘价反推（r.c 是收盘整数分、p 是涨跌幅），再算今日涨停 / 跌停价。
    // 与循环里那套整数分判定同源，不引入第二套容差。
    const prevC = Math.round((r.c[k] / (1 + p)));
    const limUp = Math.round(prevC * (1 + rate));
    const limDn = Math.round(prevC * (1 - rate));
    if (isZt) {
      if (r.c[k] >= limUp) promo++;
      if (r.h[k] >= limUp) touch++;
    } else if (r.c[k] <= limDn) still++;        // 今日仍跌停
  }
  ps.sort((x, y) => x - y);
  return { n, red, big, promo, touch, still,
    mid: ps.length ? Math.round(ps[ps.length >> 1] * 10000) : 0 };
}

const SZT = [], SDT = [], STOUCH = [], STOUCHN = [], SRED = [], SMID = [], SBIG = [];
const SPROMO = [], SPN = [], SYRED = [], SYSTILL = [], SDN = [];
for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  SZT.push(ztDay.get(d) || 0);
  SDT.push(dtDay.get(d) || 0);
  STOUCH.push(touchDay.get(d) || 0);
  const pd = i > 0 ? dates[i - 1] : null;
  const a = pd ? sideOf(zPoolByDay.get(pd) || [], d, true) : { n: 0 };
  const b = pd ? sideOf(dPoolByDay.get(pd) || [], d, false) : { n: 0 };
  SRED.push(a.n ? Math.round(a.red / a.n * 1000) : 0);
  SMID.push(a.n ? a.mid : 0);
  SBIG.push(a.n ? Math.round(a.big / a.n * 1000) : 0);
  SPROMO.push(a.promo || 0);
  SPN.push(a.n || 0);
  STOUCHN.push(a.touch || 0);
  SYRED.push(b.n ? Math.round(b.red / b.n * 1000) : 0);
  SYSTILL.push(b.n ? Math.round(b.still / b.n * 1000) : 0);
  SDN.push(b.n || 0);
}

/* 只留最近 30 天涨停池 / 10 天跌停池：卡片只需要「昨日」那一池，
 * 多留是给回看与对账用的。全 250 天会让这个文件从 40KB 涨到 200KB，
 * 而 Worker 每次启动都要 import 它。 */
const zpool = {}, dpool = {};
for (const d of dates.slice(-30)) if (zPoolByDay.has(d)) zpool[d] = zPoolByDay.get(d);
for (const d of dates.slice(-10)) if (dPoolByDay.has(d)) dpool[d] = dPoolByDay.get(d);

/* 新鲜度探针：最后一日两个池的收盘价。运行时拿池内票的「今日昨收(f18)」与这里
 * 比，命中 < 80% 说明历史表不是上一交易日（春节/国庆用日历差会误杀，用价格不会）。 */
const lastD = dates[dates.length - 1];
const zpx = {}, dpx = {};
for (const [code] of (zPoolByDay.get(lastD) || [])) {
  const m = pC.get(code), k = m ? m.get(lastD) : undefined;
  if (k !== undefined) zpx[code] = dayRec.get(code).c[k] / 100;
}
for (const code of (dPoolByDay.get(lastD) || [])) {
  const m = pC.get(code), k = m ? m.get(lastD) : undefined;
  if (k !== undefined) dpx[code] = dayRec.get(code).c[k] / 100;
}

/* ---------------- 5. 自检 ---------------- */
const last = dates.length - 1;
const amtLast = dayAllAmt.get(dates[last]) || 0;
console.log('自检：');
console.log(`  最后交易日 ${dates[last]} · 全 A 成交 ${(amtLast / 1e8).toFixed(0)} 亿`
  + ` · ${N[last]} 只有成交（${UP[last]} 涨 ${DN[last]} 跌 ${(dayFlat.get(dates[last]) || 0)} 平）`);
console.log(`  集中度 L3 ${(C[last] / 10).toFixed(1)}% · TOP3 ${lastTop3.join('、')}`);
console.log(`  TOP3 涨幅 ${T3P[last].map((v) => (v > 0 ? '+' : '') + (v / 100).toFixed(2) + '%').join(' / ')}`
  + ` · 成交 ${T3A[last].join(' / ')} 亿`);
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
  t3p: T3P, t3a: T3A,
  cVer: 'em2016-l3', cStale: false,
};
const head = '// 由 pipeline/gen_mkt_hist.mjs 回算生成，勿手改。\n'
  + '// 全 A 个股口径（新浪清单 + 腾讯日线 + EM2016 三级行业）：\n'
  + '//   c = TOP3 三级行业成交额 ÷ 全 A 个股成交额（千分位，21.6% → 216）\n'
  + '//   b = 上涨家数 ÷ (上涨+下跌) 家数（千分位；平盘/停牌不进分母，50% = 涨跌各半）\n'
  + '//   n = 当日有成交的个股数（分母规模，随上市/停牌浮动）\n'
  + '//   u / w = 当日上涨 / 下跌家数（绝对数，卡片直接显示）\n'
  + '//   a = 当日全 A 成交额（亿元）\n'
  + '//   t / t3p / t3a = 当日成交额 TOP3 行业的下标 / 涨幅（百分数×100）/ 成交额（亿元）\n'
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

/* ---------------- 7. 盘中实时用的「代码 → 行业」映射 ----------------
 * Worker 的 /api/mkt 盘中要拿当天逐只成交额现算集中度，就得知道每只票落在
 * 哪个三级行业。mkt_hist.js 里只有行业名表和每天的前三名下标，没有这个映射。
 *
 * 顺序必须与 MKT_IND_NAMES 完全一致——两边都取自同一次运行里的 l3Names，
 * Worker 端 build.mjs 会断言 MKT_IND_NAMES === MKT_INDS，顺序错了构建直接失败。
 * 所以这份表只能在这个脚本里生成，不能挪到 gen_ind_map.mjs：那边没有 l3Names，
 * 它按「当天有成交的行业」排序，换个脚本算出来的下标就会整体错位。 */
const indIdx = new Map(l3Names.map((n, i) => [n, i]));
const indFlat = {};
/* 反向表：行业下标 → 成分股代码数组。卡片上点「集成电路」要看这 110 只票，
   与其在 Worker 里每次遍历 5223 条 indFlat 重建一次（免费版 CPU 10ms，
   每个请求都做纯属浪费），不如在这里按天生成好。 */
const indMem = l3Names.map(() => []);
/* 代码 → 简称。行情接口只回代码和数字，界面上光看 688981 认不出是谁；
   抓 emweb F10 时本来就带回了名字，顺手存下来，省得运行时再查一次。 */
const stkName = {};
let noL3 = 0;
for (const [code, it] of Object.entries(indFile.items)) {
  const p = it && it.em ? it.em.split('-') : null;
  const k = p && p.length > 2 ? indIdx.get(p[2]) : undefined;
  // 没有三级归属的不塞进来：Worker 那边查不到就只计入全市场分母、不进行业，
  // 与历史口径一致（历史也是「有行业的算行业，没行业的只进分母」）
  if (k == null) { noL3++; continue; }
  indFlat[code] = k;
  indMem[k].push(code);
  if (it && it.n) stkName[code] = it.n;
}
// 每个行业内部按代码升序：列表默认按成交额排，但页面还没拿到行情时先按代码显示，
// 顺序稳定的列表不会在两次刷新之间跳来跳去
for (const a of indMem) a.sort();
const indJs = '// 由 pipeline/gen_mkt_hist.mjs 生成，勿手改。\n'
  + '// EM2016 三级行业映射：MKT_IND_OF[6 位代码] = MKT_IND_NAMES 的下标。\n'
  + '// 顺序与 mkt_hist.js 的 MKT_INDS 严格一致（build.mjs 会断言）。\n'
  + `// ${Object.keys(indFlat).length} 只 / ${l3Names.length} 个行业`
  + `（${noL3} 只没有三级归属，只计入全市场分母）。\n`
  + 'export const MKT_IND_NAMES = ' + JSON.stringify(l3Names) + ';\n'
  + 'export const MKT_IND_OF = ' + JSON.stringify(indFlat) + ';\n'
  + '// 反向表：行业下标 → 成分股代码。给「点行业名看有哪些票」用。\n'
  + 'export const MKT_IND_MEM = ' + JSON.stringify(indMem) + ';\n'
  + '// 代码 → 简称。行情接口只有代码，界面上认不出是谁。\n'
  + 'export const MKT_STK_NAME = ' + JSON.stringify(stkName) + ';\n';
writeFileSync(IND_OUT, indJs);
console.log(`${IND_OUT}  ${(indJs.length / 1024).toFixed(1)} KB · ${Object.keys(indFlat).length} 只映射`
  + ` · 最大行业 ${Math.max(...indMem.map((a) => a.length))} 只`);

/* ---------------- 8. 情绪历史落盘 → worker/src/senti_hist.js ----------------
 * 单独一个文件，不并进 mkt_hist.js：后者在 Worker 里是 JSON.parse 出来的
 * （index.js 的 mktPack），多 40KB 就是每次冷启动都白烧一遍 CPU；而这两份数据
 * 的失败语义也不同（集中度缺了还能显示家数，情绪池缺了整套指标都得降级）。 */
const sLast = dates.length - 1;
console.log('情绪自检：');
console.log(`  ${dates[sLast]} 涨停 ${SZT[sLast]} 家 · 曾触板 ${STOUCH[sLast]} · 跌停 ${SDT[sLast]}`
  + ` · 昨日涨停池 ${SPN[sLast]} 只（红盘 ${(SRED[sLast] / 10).toFixed(0)}%`
  + ` 中位 ${(SMID[sLast] / 100).toFixed(2)}% 大面 ${(SBIG[sLast] / 10).toFixed(0)}%）`);
console.log(`  昨日跌停池 ${SDN[sLast]} 只（红盘 ${(SYRED[sLast] / 10).toFixed(0)}%`
  + ` 仍跌停 ${(SYSTILL[sLast] / 10).toFixed(0)}%）· 最高连板 `
  + Math.max(...(zpool[lastD] || [[0, 0]]).map((x) => x[1])));

/* 结构断言，量级断言只兜底：真实值（11-13 涨停 37、曾触 58）随日期变，
   写死会天天误报，所以只在日志里打出来给人看。 */
for (let i = 0; i < dates.length; i++) {
  if (STOUCH[i] < SZT[i]) throw new Error(`曾触板 ${STOUCH[i]} < 涨停 ${SZT[i]}（${dates[i]}），判定口径错了`);
}
const sBad = SZT.filter((v) => !(v >= 0 && v <= 400));
if (sBad.length > dates.length * 0.02) throw new Error(`涨停家数量级异常 ${sBad.length}/${dates.length} 天`);
if (SPN[sLast] < 10) throw new Error(`昨日涨停池只有 ${SPN[sLast]} 只有效样本，日线口径有问题`);
if (Object.keys(zpx).length < 20) throw new Error(`zpx 探针只有 ${Object.keys(zpx).length} 条，少于 20`);

const sPayload = {
  d: dates,
  zt: SZT, dt: SDT, touch: STOUCH,
  red: SRED, mid: SMID, big: SBIG, promo: SPROMO, pn: SPN, touchN: STOUCHN,
  ydtRed: SYRED, ydtStill: SYSTILL, ydtN: SDN,
  zpool, dpool, zpx, dpx,
  lastDay: lastD, cVer: 'senti-v1',
};
const sHead = '// 由 pipeline/gen_mkt_hist.mjs 回算生成，勿手改。\n'
  + '// 短线情绪的 250 天历史基准（全 A 个股口径，与盘中 aggSenti 同一套规则）：\n'
  + '//   zt/dt/touch = 当日涨停 / 跌停 / 曾触板家数（收盘口径，只作背景，不可与盘中比）\n'
  + '//   red/mid/big = 昨日涨停池今日 红盘率(‰) / 中位涨幅(百分数×100) / 大面率(‰)\n'
  + '//   promo/pn/touchN = 昨池今日晋级数 / 有效样本数 / 曾触板数\n'
  + '//   ydtRed/ydtStill/ydtN = 昨日跌停池今日 红盘率(‰) / 仍跌停率(‰) / 有效样本数\n'
  + '//   zpool = 最近 30 日涨停池 [[code, 连板], …]；dpool = 最近 10 日跌停池 [code, …]\n'
  + '//   zpx/dpx = 最后一日两池收盘价，运行时作新鲜度探针（命中 < 80% 判历史过期）\n'
  + `// ${dates.length} 个交易日（${dates[0]} → ${lastD}）\n`;
const sJs = sHead + 'export const SENTI_HIST = ' + JSON.stringify(sPayload) + ';\n';
mkdirSync(dirname(SENTI_OUT), { recursive: true });
writeFileSync(SENTI_OUT, sJs);
mkdirSync(dirname(SENTI_JSON), { recursive: true });
writeFileSync(SENTI_JSON, JSON.stringify({ generated_at: new Date().toISOString(), ...sPayload }));
console.log(`${SENTI_OUT}  ${(sJs.length / 1024).toFixed(1)} KB · 涨停池 ${Object.keys(zpool).length} 天`
  + ` · 跌停池 ${Object.keys(dpool).length} 天 · 探针 ${Object.keys(zpx).length}/${Object.keys(dpx).length}`);
