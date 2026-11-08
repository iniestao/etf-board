/**
 * 回算「全 A 个股口径」的集中度与宽度 → worker/src/mkt_hist.js
 * ============================================================
 * 这一版把宽度的分母从「128 个行业」换成「5563 只个股」。
 *
 * 为什么换：
 *   行业是等权样本，一个行业里 500 只股票 8 只涨 492 只跌，行业层面看是「跌」，
 *   个股层面是「1.6% 在涨」——两者差着两个数量级。宽度问的本来就是
 *   「今天有多少票在涨」，用行业答是隔着一层皮。
 *
 * 数据怎么来：
 *   个股日 K（push2his，fqt=1 前复权）字段 f51 日期 / f57 成交额 / f59 涨跌幅。
 *   5563 只 × 250 天，8 并发实测约 1 分钟、48MB——边拉边聚合，不驻留原始 K 线。
 *   行业归属仍取个股的 f100 字段（一只股票只归一个行业，不会像板块列表那样
 *   把「电子」和「半导体」各算一遍），用来算集中度。
 *
 * 口径定义：
 *   b = 上涨家数 ÷ (上涨 + 下跌) × 1000
 *       平盘和停牌不参与分母。这样 50% 就是「涨跌各半」的自然中线，
 *       横轴虚线才有意义；若用全部 5563 只做分母，常年几百只平盘会把
 *       中线永久压偏到 45% 附近。
 *   c = TOP3 行业成交额 ÷ 全 A 个股成交额 × 1000
 *       分母是全部个股（含 338 只无 f100 归属的），不是「有行业的个股之和」，
 *       否则集中度会虚高。
 *
 * 已知偏差（均可忽略，但写下来）：
 *   - 行业归属用的是**当前**快照，250 天里个股改过行业的算在新行业里；
 *   - 期间退市的股票不在当前列表里，早期那几天的成交额会略微低估。
 *
 * 用法：node pipeline/gen_mkt_hist.mjs [--days 250] [--out worker/src/mkt_hist.js]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DAYS = +argOf('--days', 250);
const OUT = argOf('--out', 'worker/src/mkt_hist.js');
const JSON_OUT = argOf('--json', 'dist/mkt_hist.json');
const CH = +argOf('--concurrency', 8);

const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function jget(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(180 * (i + 1));
    }
  }
  throw last;
}

const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
  + '?pn=%d&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=%s&fields=%s';
// 沪深主板 + 创业板 + 科创板。北交所不进：流动性和涨跌幅规则都不同，
// 混进来会让宽度在极端日多抖动 2-3 个百分点。
const FS_STOCK = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';

/** 翻页拉全量。fid=f12（代码）排序，盘中成交额变动不会让翻页错位。 */
async function clistAll(fs, fields, cap = 9000) {
  const out = [];
  let total = 0;
  for (let pn = 1; pn <= 90; pn++) {
    const j = await jget(CLIST.replace('%d', pn).replace('%s', fs).replace('%s', fields));
    const d = (j.data && j.data.diff) || [];
    total = (j.data && j.data.total) || total;
    out.push(...d);
    if (!d.length || out.length >= total) break;
  }
  if (out.length < total * 0.97) throw new Error(`列表不全 ${out.length}/${total}`);
  return out;
}

// ---- 1. 全 A 个股清单：代码 / 市场 / 行业归属 ----
console.log('拉全 A 个股清单…');
const stocks = await clistAll(FS_STOCK, 'f12,f13,f14,f100');
const indSet = new Set();
let noInd = 0;
for (const x of stocks) {
  if (x.f100 && x.f100 !== '-') indSet.add(x.f100); else noInd++;
}
const indNames = [...indSet].sort();
console.log(`  ${stocks.length} 只 · ${indNames.length} 个行业 · ${noInd} 只无行业归属`);

// ---- 2. 逐只拉 K 线，边拉边按日聚合 ----
// 只留聚合结果：每天 {up, dn, flat} + 每行业每天成交额。
// 不缓存原始 K 线，48MB 的原始数据留在 GC 里就行。
const beg = (() => {
  const d = new Date(Date.now() + 8 * 3600e3);
  d.setUTCDate(d.getUTCDate() - Math.round(DAYS * 1.7) - 20);   // 250 交易日 ≈ 350 自然日，留足余量
  return d.toISOString().slice(0, 10).replace(/-/g, '');
})();
console.log(`拉个股 K 线（${beg} 起，${CH} 并发）…`);

const dayUp = new Map(), dayDn = new Map(), dayFlat = new Map(), dayN = new Map();
const dayAllAmt = new Map();
const indAmtByDay = new Map();   // ind -> Map(day -> amt)
const failed = [];               // 网络/解析错误，可重试
const empty = [];                // K 线为空：新股未上市、已退市。正常，重试也没用

const kurl = (secid) => 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid
  + '&klt=101&fqt=1&beg=' + beg + '&end=20500101&fields1=f1,f2&fields2=f51,f53,f57,f59';

/** 拉一只并聚合。失败时把标的推回 failed 供补拉，不在此处吞掉。 */
async function one(x) {
  const secid = (x.f13 === 1 ? '1.' : '0.') + x.f12;
  let j;
  try { j = await jget(kurl(secid)); } catch (e) { failed.push(x); return; }
  const ks = (j && j.data && j.data.klines) || [];
  // 空 K 线不是错误：退市股（退市泽达）、未上市新股都长这样。重试只会更慢。
  if (!ks.length) { empty.push(x.f12); return; }

  const ind = x.f100 && x.f100 !== '-' ? x.f100 : null;
  let im = null;
  if (ind) {
    im = indAmtByDay.get(ind);
    if (!im) { im = new Map(); indAmtByDay.set(ind, im); }
  }

  for (const line of ks) {
    const a = line.split(',');
    const d = a[0];
    const amt = +a[2] || 0;
    const chg = +a[3];
    // 停牌日东财不返回该行；有行但成交额为 0 的是当日停牌/无成交，不计入家数
    if (amt > 0) {
      dayN.set(d, (dayN.get(d) || 0) + 1);
      dayAllAmt.set(d, (dayAllAmt.get(d) || 0) + amt);
      if (im) im.set(d, (im.get(d) || 0) + amt);
      if (Number.isFinite(chg)) {
        if (chg > 0) dayUp.set(d, (dayUp.get(d) || 0) + 1);
        else if (chg < 0) dayDn.set(d, (dayDn.get(d) || 0) + 1);
        else dayFlat.set(d, (dayFlat.get(d) || 0) + 1);
      }
    }
  }
}

for (let i = 0; i < stocks.length; i += CH) {
  await Promise.all(stocks.slice(i, i + CH).map(one));
  const n = Math.min(i + CH, stocks.length);
  if (n % 400 < CH || n === stocks.length) process.stdout.write(`  ${n}/${stocks.length}\r`);
}
console.log('');

// 补拉：东财偶发 fetch failed（socket 被断），单轮失败率 3%-6%。
// 隔一轮降并发重拉更省时间——实测第二轮能捞回九成以上。
for (let round = 1; round <= 3 && failed.length; round++) {
  const todo = failed.splice(0, failed.length);
  console.log(`  补拉第 ${round} 轮：${todo.length} 只（并发 4）…`);
  await sleep(1200 * round);
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(one));
  }
}
if (empty.length) console.log(`  ${empty.length} 只 K 线为空（退市/未上市），已跳过`);
if (failed.length > stocks.length * 0.02) {
  throw new Error(`K 线失败率过高 ${failed.length}/${stocks.length}，上游可能限流`);
}
if (failed.length) console.log(`  ${failed.length} 只补拉后仍失败，已跳过`);

// ---- 3. 按日回算 ----
const allDays = [...dayN.keys()].sort();
const dates = allDays.slice(-DAYS);
if (dates.length < 200) throw new Error(`交易日不足 200 天（${dates.length}），上游可能限流`);

const C = [], B = [], N = [], UP = [], DN = [];
// 每天的前三大行业（存索引，不存名字）。点散点时要回答「那天钱堆在哪条线上」，
// 只有一个 24% 的集中度数字不够用。250 天 × 3 个索引 ≈ 2KB，比存中文名省一半。
const T = [];
const indIdx = new Map(indNames.map((n, i) => [n, i]));
let lastTop3 = [];
for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  const up = dayUp.get(d) || 0, dn = dayDn.get(d) || 0;
  const tot = dayAllAmt.get(d) || 0;

  // 当日各行业成交额，取 TOP3
  const vals = [];
  for (const [ind, m] of indAmtByDay) {
    const v = m.get(d);
    if (v > 0) vals.push([ind, v]);
  }
  vals.sort((a, b) => b[1] - a[1]);
  const top = vals.slice(0, 3);
  T.push(top.map(([k]) => indIdx.has(k) ? indIdx.get(k) : -1));
  if (i === dates.length - 1) lastTop3 = top.map(([k]) => k);

  C.push(tot > 0 ? Math.round(vals.slice(0, 3).reduce((s, x) => s + x[1], 0) / tot * 1000) : 0);
  // 分母只算有方向的家数：平盘不压低宽度，50% 才是真正的「涨跌各半」
  B.push(up + dn > 0 ? Math.round(up / (up + dn) * 1000) : 0);
  N.push(dayN.get(d) || 0);
  UP.push(up); DN.push(dn);
}

// ---- 4. 自检：口径必须对得上 ----
const last = dates.length - 1;
console.log('自检：');
console.log(`  最后交易日 ${dates[last]} · 全 A 成交 ${(dayAllAmt.get(dates[last]) / 1e8).toFixed(0)} 亿`
  + ` · ${N[last]} 只有成交（${UP[last]} 涨 ${DN[last]} 跌 ${(dayFlat.get(dates[last]) || 0)} 平）`);
console.log(`  集中度 ${(C[last] / 10).toFixed(1)}% · TOP3 ${lastTop3.join('、')}`);
console.log(`  宽度 ${(B[last] / 10).toFixed(1)}%`);
// 成交额量级：全 A 单日正常在 5000 亿 ~ 3 万亿，超出说明字段串了
const amtBad = dates.filter((d) => { const v = dayAllAmt.get(d) / 1e8; return !(v > 3000 && v < 40000); });
if (amtBad.length > dates.length * 0.1) {
  throw new Error(`成交额量级异常 ${amtBad.length}/${dates.length} 天，检查 K 线字段索引`);
}
// 宽度应该分散在两端，若 90% 的天都挤在同一个 5% 区间说明口径退化
const bVals = B.filter((v) => v > 0);
const bSpread = Math.max(...bVals) - Math.min(...bVals);
if (bSpread < 200) throw new Error(`宽度几乎不动（极差 ${bSpread / 10}pt），口径可能退化`);
console.log(`  250 天宽度极差 ${(bSpread / 10).toFixed(0)} 分位点，分布正常`);

// ---- 5. 落盘 ----
const payload = { d: dates, c: C, b: B, n: N, u: UP, w: DN, t3: lastTop3,
  t: T, ind: indNames, inds: indNames.length };
const head = '// 由 pipeline/gen_mkt_hist.mjs 回算生成，勿手改。\n'
  + '// 全 A 个股口径（5563 只，东财 f100 归行业）：\n'
  + '//   c = TOP3 行业成交额 ÷ 全 A 个股成交额（千分位，24.1% → 241）\n'
  + '//   b = 上涨家数 ÷ (上涨+下跌) 家数（千分位；平盘/停牌不进分母，50% = 涨跌各半）\n'
  + '//   n = 当日有成交的个股数（分母规模，随上市/停牌浮动）\n'
  + '//   u / w = 当日上涨 / 下跌家数（绝对数，卡片直接显示）\n'
  + `// ${dates.length} 个交易日（${dates[0]} → ${dates[dates.length - 1]}）\n`;
const js = head + 'export const MKT_HIST = ' + JSON.stringify(payload) + ';\n'
  // 行业名单单独导出：Worker 的 /api/mkt 要用它从 496 个板块里筛出这 128 个。
  // 写死在 Worker 里不行——东财偶尔会改名/拆合行业，名单得跟历史一起重新生成。
  + 'export const MKT_INDS = ' + JSON.stringify(indNames) + ';\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, js);
mkdirSync(dirname(JSON_OUT), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  last_trade_date: dates[last],
  inds: indNames.length,
  stocks: stocks.length,
  ...payload
}));

console.log('');
console.log(`${OUT}  ${(js.length / 1024).toFixed(1)} KB`);
console.log(`  ${dates.length} 个交易日 · ${dates[0]} → ${dates[dates.length - 1]}`);
