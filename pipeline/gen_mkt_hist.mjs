/**
 * 回算「全 A 行业口径」的集中度与宽度 → worker/src/mkt_hist.js
 * ==========================================================
 * 板块地图上的四象限原本用 ETF 成交额算，这是错的：
 *
 *   1) 分母不是市场，是「有 ETF 跟踪的那 18 个行业格」。ETF 池子里 TOP3
 *      天然占一半以上（11-06：58.7%），但全 A 真实的行业集中度只有 24.1%。
 *      这个 58.7% 测的是「ETF 资金分布」，不是「市场结构」。
 *   2) ETF 二级市场成交是份额转让，不产生股票成交。半导体 ETF 一天 200 亿
 *      和半导体个股一天 2245 亿是两套资金，不能互相替代。
 *
 * 所以改成东财行业的全 A 口径：
 *   - 行业 = 个股的 f100 字段（128 个，东财二/三级行业），一只股票只归一个行业，
 *     不会像板块列表那样把「电子」和「半导体」重复计一遍；
 *   - 集中度 = TOP3 行业成交额 ÷ 全部行业成交额；
 *   - 宽度   = 上涨行业数 ÷ 有成交行业数。
 *
 * 历史用「行业板块 K 线」回算（每个行业一次请求，128 次 ≈ 20 秒），
 * 与当天实时口径完全一致——板块成交额就是板块内个股成交额之和
 * （11-06 实测：128 个行业合计 16576 亿 = 全 A 个股合计 16576 亿）。
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

const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function jget(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(250 * (i + 1));
    }
  }
  throw last;
}

const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
  + '?pn=%d&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6&fs=%s&fields=%s';
const FS_STOCK = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';   // 沪深主板+创业板+科创板
const FS_BOARD = 'm:90+t:2';                              // 东财行业板块

/** 翻页拉全量。东财单页上限 100，5000 多只股票要 56 页。 */
async function clistAll(fs, fields, cap = 8000) {
  const out = [];
  for (let pn = 1; out.length < cap; pn++) {
    const j = await jget(CLIST.replace('%d', pn).replace('%s', fs).replace('%s', fields));
    const d = (j.data && j.data.diff) || [];
    out.push(...d);
    if (!d.length || out.length >= (j.data.total || 0)) break;
  }
  return out;
}

// ---- 1. 行业清单：以个股 f100 为准，不用板块列表自己推 ----
// 板块列表里有「电子」也有「半导体」，直接加总会把同一批股票算两遍；
// 个股的 f100 是扁平的单个行业名，天然不重复。
console.log('拉全 A 个股行业分布…');
const stocks = await clistAll(FS_STOCK, 'f12,f3,f6,f100');
const byInd = {};
let stockAmt = 0, stockUp = 0, stockDn = 0, stockFlat = 0;
for (const x of stocks) {
  const a = +x.f6 || 0, r = +x.f3;
  stockAmt += a;
  if (r > 0) stockUp++; else if (r < 0) stockDn++; else stockFlat++;
  const k = x.f100 && x.f100 !== '-' ? x.f100 : null;
  if (k) byInd[k] = (byInd[k] || 0) + a;
}
const indNames = Object.keys(byInd).sort((a, b) => byInd[b] - byInd[a]);
if (indNames.length < 60) throw new Error('行业数异常：' + indNames.length);
console.log(`  ${stocks.length} 只股票 · ${indNames.length} 个行业 · ${(stockAmt / 1e8).toFixed(0)} 亿`);

// ---- 2. 行业名 → 板块代码（BKxxxx），历史 K 线要用 ----
console.log('拉行业板块清单…');
const boards = await clistAll(FS_BOARD, 'f12,f14');
const codeOf = new Map(boards.map((b) => [b.f14, b.f12]));
const pairs = indNames.map((k) => [k, codeOf.get(k)]).filter(([, c]) => c);
const missing = indNames.filter((k) => !codeOf.has(k));
if (missing.length) console.log(`  未匹配到板块代码：${missing.join('、')}`);
if (pairs.length < indNames.length * 0.85) {
  throw new Error(`行业名匹配率过低 ${pairs.length}/${indNames.length}，东财可能改了板块命名`);
}

// ---- 3. 逐行业拉 K 线（成交额 + 涨跌幅），8 并发 ----
const beg = (() => {
  const d = new Date(Date.now() + 8 * 3600e3);
  d.setUTCDate(d.getUTCDate() - Math.round(DAYS * 1.6) - 20);   // 按自然日留够余量
  return d.toISOString().slice(0, 10).replace(/-/g, '');
})();
console.log(`拉 ${pairs.length} 个行业 K 线（${beg} 起）…`);
const kline = {};
const CH = 8;
for (let i = 0; i < pairs.length; i += CH) {
  await Promise.all(pairs.slice(i, i + CH).map(async ([name, bk]) => {
    const u = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.' + bk
      + '&klt=101&fqt=1&beg=' + beg + '&end=20500101&fields1=f1,f2&fields2=f51,f53,f57,f59';
    const j = await jget(u);
    const ks = (j.data && j.data.klines) || [];
    kline[name] = ks.map((l) => {
      const a = l.split(',');
      // fields2=f51,f53,f57,f59 → 日期、收盘、成交额、涨跌幅
      return [a[0], +a[2] || 0, +a[3]];
    });
  }));
  const n = Math.min(i + CH, pairs.length);
  if (n % 32 === 0 || n === pairs.length) process.stdout.write(`  ${n}/${pairs.length}\r`);
}
console.log('');

// ---- 4. 按日回算 ----
const dset = new Set();
for (const rows of Object.values(kline)) for (const [d] of rows) dset.add(d);
const dates = [...dset].sort().slice(-DAYS);
const at = new Map(dates.map((d, i) => [d, i]));

const amt = {}, chg = {};
for (const [name, rows] of Object.entries(kline)) {
  const A = new Array(dates.length).fill(0);
  const C = new Array(dates.length).fill(NaN);
  for (const [d, a, c] of rows) {
    const i = at.get(d);
    if (i == null) continue;
    A[i] = a;
    C[i] = c;
  }
  amt[name] = A; chg[name] = C;
}

const C = [], B = [], N = [];
let lastTop3 = [];
for (let i = 0; i < dates.length; i++) {
  const vals = [];
  for (const k in amt) if (amt[k][i] > 0) vals.push([k, amt[k][i]]);
  vals.sort((a, b) => b[1] - a[1]);
  if (i === dates.length - 1) lastTop3 = vals.slice(0, 3).map(([k]) => k);
  const tot = vals.reduce((s, x) => s + x[1], 0);
  // 千分位整数，和 sec_hist 里 c / b 的单位一致（24.1% → 241）
  C.push(tot > 0 ? Math.round((vals.slice(0, 3).reduce((s, x) => s + x[1], 0) / tot) * 1000) : 0);
  let up = 0, n = 0;
  for (const k in chg) {
    const v = chg[k][i];
    if (!Number.isFinite(v)) continue;
    n++;
    if (v > 0) up++;
  }
  N.push(n);
  B.push(n ? Math.round((up / n) * 1000) : 0);
}

if (dates.length < 60) throw new Error('K 线不足 60 天，上游可能限流');

// ---- 5. 落盘 ----
const payload = { d: dates, c: C, b: B, n: N, t3: lastTop3 };
const head = '// 由 pipeline/gen_mkt_hist.mjs 回算生成，勿手改。\n'
  + `// 全 A 行业口径（东财 f100，${indNames.length} 个行业）：\n`
  + '//   c = TOP3 行业成交额 ÷ 全部行业成交额（千分位，24.1% → 241）\n'
  + '//   b = 上涨行业数 ÷ 有成交行业数（千分位）\n'
  + '//   n = 当天有成交的行业数（分母，会随上市/停牌小幅变化）\n'
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
  last_trade_date: dates[dates.length - 1],
  inds: indNames.length,
  ...payload
}));

const last = dates.length - 1;
console.log(`${OUT}  ${(js.length / 1024).toFixed(1)} KB`);
console.log(`  ${dates.length} 个交易日 · ${dates[0]} → ${dates[dates.length - 1]}`);
console.log(`  今日 集中度 ${(C[last] / 10).toFixed(1)}% · 宽度 ${(B[last] / 10).toFixed(1)}%`
  + `（${Math.round(B[last] / 1000 * N[last])}/${N[last]} 个行业在涨）`);
console.log(`  个股口径对照：${stockUp} 涨 ${stockDn} 跌 ${stockFlat} 平`
  + `（${(stockUp / stocks.length * 100).toFixed(1)}%）· 成交 ${(stockAmt / 1e8).toFixed(0)} 亿`);
