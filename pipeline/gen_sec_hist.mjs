/**
 * 回算「板块占比史」→ worker/src/sec_hist.js
 * ==========================================
 * 页面上的板块地图只有今天一个点：半导体 39%、通信 5%，看不出这是刚起来
 * 还是已经走了一半。这个脚本把过去 250 个交易日 × 36 格的占比算出来，
 * 让每一格都能画出自己的位置。
 *
 * 口径必须和页面一致，否则曲线和格子上的数字对不上：
 *   - 每个跟踪指数只算成交额最大的那只 ETF（不是把同指数十几只加起来）；
 *   - 三组（A股 / 港股 / 跨境）各算各的分母，跨市场不混；
 *   - 主题格（人工智能、新能源、中韩半导体）不计入分母，但自己也算一条曲线。
 *
 * 分类逻辑不在这里重写一遍——直接从 page.js 里取 SEC_GROUPS 和 secClass，
 * 保证「哪里算什么」只有一个来源。page.js 结构变了脚本会直接报错，
 * 不会悄悄产出一份口径不同的数据。
 *
 * 用法：node pipeline/gen_sec_hist.mjs [data/etf.db]
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { IDX_GROUPS } from '../worker/src/idx_data.js';

const DAYS = 250;
const DB = process.argv[2] || 'data/etf.db';
const OUT = 'worker/src/sec_hist.js';

// ---- 1. 从 page.js 取分类逻辑（只取这三段，取不到就停）----
const page = readFileSync('worker/src/page.js', 'utf8');
const cut = (a, b) => {
  const i = page.indexOf(a);
  if (i < 0) throw new Error('page.js 里找不到：' + a);
  const j = page.indexOf(b, i);
  if (j < 0) throw new Error('page.js 里找不到结束标记：' + b);
  return page.slice(i, j + b.length);
};
const code =
  cut('var SEC_GROUPS = [', '\n];') + '\n' +
  cut('var SEC_HK = [', '];') + '\n' +
  cut('var SEC_COMMOD = [', '];') + '\n' +
  'var SEC_CACHE={};\n' +
  cut('function secClass(ix){', '\n}\n');
const secClass = new Function(code + '\nreturn secClass;')();

// ---- 2. 读日线，按「指数→日期→成交额」压实 ----
const db = new DatabaseSync(DB);
const dates = db.prepare(
  'SELECT DISTINCT date FROM etf_daily ORDER BY date DESC LIMIT ?'
).all(DAYS).map((r) => r.date).reverse();
if (dates.length < 60) throw new Error('日线不足 60 天，先跑 data/import_etf.mjs');

const rows = db.prepare('SELECT code, date, amount FROM etf_daily WHERE date >= ?').all(dates[0]);
const byCode = new Map();
for (const r of rows) {
  let m = byCode.get(r.code);
  if (!m) byCode.set(r.code, (m = new Map()));
  m.set(r.date, r.amount);
}

// 每个指数每天取组内成交额最大的那只。ETF 停牌（amount=0）自然被跳过。
const ixDay = new Map();
for (const [ix, codes] of Object.entries(IDX_GROUPS)) {
  const arr = new Array(dates.length).fill(0);
  for (let di = 0; di < dates.length; di++) {
    let mx = 0;
    for (const c of codes) {
      const v = byCode.get(c)?.get(dates[di]) || 0;
      if (v > mx) mx = v;
    }
    arr[di] = mx;
  }
  ixDay.set(ix, arr);
}

// ---- 3. 归格 + 算占比 ----
const meta = new Map();   // ix -> { key, code, th }
const keys = new Map();   // key -> { code, th }
for (const ix of ixDay.keys()) {
  const c = secClass(ix);
  if (!c) continue;
  const key = c.code + '/' + c.k;
  meta.set(ix, { key, code: c.code, th: !!c.th });
  if (!keys.has(key)) keys.set(key, { code: c.code, th: !!c.th });
}

const cell = new Map();
for (const k of keys.keys()) cell.set(k, new Array(dates.length).fill(0));

const den = { a: [], hk: [], x: [] };
const conc = [];

for (let di = 0; di < dates.length; di++) {
  const tot = { a: 0, hk: 0, x: 0 };
  for (const [ix, m] of meta) {
    const v = ixDay.get(ix)[di];
    if (!v) continue;
    cell.get(m.key)[di] += v;
    if (!m.th) tot[m.code] += v;
  }
  den.a.push(tot.a); den.hk.push(tot.hk); den.x.push(tot.x);
  // 集中度：A 股前三大板块占 A 股行业成交额的比重（抱团 vs 扩散）
  const vals = [...keys].filter(([, v]) => v.code === 'a' && !v.th)
    .map(([k]) => cell.get(k)[di]).sort((x, y) => y - x);
  conc.push(tot.a > 0 ? Math.round((vals.slice(0, 3).reduce((s, v) => s + v, 0) / tot.a) * 1000) : 0);
}

const s = {};
for (const [k, v] of keys) {
  const code2 = v.code;
  s[k] = cell.get(k).map((amt, di) =>
    den[code2][di] > 0 ? Math.round((amt / den[code2][di]) * 1000) : 0);
}

// ---- 4. 写文件 ----
const body = JSON.stringify({ d: dates, s, c: conc });
const js = '// 由 pipeline/gen_sec_hist.mjs 回算生成，勿手改。\n'
  + `// ${DAYS} 个交易日（${dates[0]} → ${dates[dates.length - 1]}）\n`
  + '// s[k] 是「占本组行业格成交额」的千分位整数（12.9% → 129），分母分组、主题不计入，与页面口径一致。\n'
  + '// c 是 A 股行业格每日 TOP3 集中度（千分位），用来判断抱团/扩散。\n'
  + 'export const SEC_HIST = ' + body + ';\n';
writeFileSync(OUT, js);

// ---- 5. 自检：占比合计必须接近 100%，否则就是分母或归格错了 ----
let sum = 0;
for (const [k, v] of keys) if (v.code === 'a' && !v.th) sum += s[k][dates.length - 1];
if (Math.abs(sum / 10 - 100) > 2) throw new Error(`A 股行业格占比合计 ${sum / 10}%，应为 100% 左右`);

console.log(`${OUT}  ${(js.length / 1024).toFixed(1)} KB`);
console.log(`  ${keys.size} 格 · ${dates.length} 个交易日 · ${dates[0]} → ${dates[dates.length - 1]}`);
console.log(`  A股行业格占比合计 ${(sum / 10).toFixed(1)}% · 集中度 ${(conc[conc.length - 1] / 10).toFixed(1)}%`);
