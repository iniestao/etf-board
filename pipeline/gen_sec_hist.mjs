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
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IDX_GROUPS } from '../worker/src/idx_data.js';

const DAYS = 250;
const ARGV = process.argv.slice(2);
const JSON_ONLY = ARGV.includes('--json-only');     // GitHub Actions 只更新日档，不改源码
const ARG = ARGV.find((a) => !a.startsWith('--'));
const DB = ARG || 'data/etf.db';
const HIST_DIR = 'dist/hist';
const OUT = 'worker/src/sec_hist.js';
const DAILY_OUT = 'dist/sec_daily.json';
const DAILY_KEEP = 90;    // 日档只需要「最近一个基准」，90 天足够覆盖长假和长停牌

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
// 数据源优先用 dist/hist 的 ETH1 二进制：那是 Actions 每天收盘后现生成的、
// 页面 K 线用的同一份文件，永远是最新交易日。本地 data/etf.db 是 gitignored 的，
// 只有手动跑 import_etf.mjs 才会往前走一步——拿它当唯一来源，基线就会卡在
// 「上次手动跑的那天」，而页面上今天的点是实时的，两者越差越远。
// 显式传 .db 参数仍走老路（离线回溯、对账时用）。
function parseEth1(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  if (dv.getUint32(0, false) !== 0x45544831) throw new Error('不是 ETH1 格式');
  const hl = dv.getUint32(4, true);
  const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, hl)));
  const n = hdr.n, base = 8 + hl, cols = hdr.cols;
  const view = (i, T) => {
    const o = base + i * 4 * n;
    return o % 4 === 0 ? new T(ab, o, n) : new T(ab.slice(o, o + 4 * n), 0, n);
  };
  const at = (name) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`hist 缺列 ${name}（${hdr.code}）`);
    return view(i + 1, Float32Array);
  };
  return { n, dates: view(0, Int32Array), close: at('close'), amount: at('amount'), adj: at('adj_ratio') };
}

const fmtD = (d) => {
  const s = String(d);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
};

function loadHist(dir) {
  const parsed = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.bin')) continue;
    parsed.push([f.slice(0, -4), parseEth1(readFileSync(join(dir, f)))]);
  }
  const dset = new Set();
  for (const [, p] of parsed) for (let i = 0; i < p.n; i++) dset.add(p.dates[i]);
  const dates = [...dset].sort((a, b) => a - b).slice(-DAYS).map(fmtD);
  const keep = new Set(dates);
  const byCode = new Map();
  for (const [code, p] of parsed) {
    const m = new Map();
    for (let i = 0; i < p.n; i++) {
      const ds = fmtD(p.dates[i]);
      if (!keep.has(ds)) continue;
      m.set(ds, { a: p.amount[i] || 0, c: (p.close[i] || 0) * (p.adj[i] || 1) });
    }
    byCode.set(code, m);
  }
  return { dates, byCode, src: `${dir}（${parsed.length} 只，${dates[0]} → ${dates[dates.length - 1]}）` };
}

function loadDb(file) {
  const db = new DatabaseSync(file);
  const dates = db.prepare(
    'SELECT DISTINCT date FROM etf_daily ORDER BY date DESC LIMIT ?'
  ).all(DAYS).map((r) => r.date).reverse();
  const rows = db.prepare(
    'SELECT code, date, amount, close, adj_factor FROM etf_daily WHERE date >= ?'
  ).all(dates[0]);
  const byCode = new Map();
  for (const r of rows) {
    let m = byCode.get(r.code);
    if (!m) byCode.set(r.code, (m = new Map()));
    m.set(r.date, { a: r.amount || 0, c: (r.close || 0) * (r.adj_factor || 1) });
  }
  db.close();
  return { dates, byCode, src: `${file}（${dates[0]} → ${dates[dates.length - 1]}）` };
}

const useHist = !ARG && existsSync(HIST_DIR);
const SRC = useHist ? loadHist(HIST_DIR) : loadDb(DB);
const { dates, byCode } = SRC;
if (dates.length < 60) throw new Error('日线不足 60 天，先跑 data/import_etf.mjs');
const amtOf = (code, d) => byCode.get(code)?.get(d)?.a || 0;

// 每个指数每天取组内成交额最大的那只。ETF 停牌（amount=0）自然被跳过。
const ixDay = new Map();
for (const [ix, codes] of Object.entries(IDX_GROUPS)) {
  const arr = new Array(dates.length).fill(0);
  for (let di = 0; di < dates.length; di++) {
    let mx = 0;
    for (const c of codes) {
      const v = amtOf(c, dates[di]);
      if (v > mx) mx = v;
    }
    arr[di] = mx;
  }
  ixDay.set(ix, arr);
}

// 注：这里曾经还算过「ETF 口径的集中度与宽度」（18 个格 TOP3 占比、203 个指数里
// 多少在涨）。2026-11-08 换成全 A 个股口径（见 gen_mkt_hist.mjs）：那个 57.7% 的分母
// 只覆盖有 ETF 跟踪的行业，测的是「ETF 资金分布」不是市场结构，和全 A 的真实 24%
// 差 2.4 倍。两个数并排放，会让人以为是同一件事的两个时点。
// 现在这个脚本只管 36 格的占比，集中度 / 宽度归 gen_mkt_hist.mjs。

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

for (let di = 0; di < dates.length; di++) {
  const tot = { a: 0, hk: 0, x: 0 };
  for (const [ix, m] of meta) {
    const v = ixDay.get(ix)[di];
    if (!v) continue;
    cell.get(m.key)[di] += v;
    if (!m.th) tot[m.code] += v;
  }
  den.a.push(tot.a); den.hk.push(tot.hk); den.x.push(tot.x);
}

const s = {};
for (const [k, v] of keys) {
  const code2 = v.code;
  s[k] = cell.get(k).map((amt, di) =>
    den[code2][di] > 0 ? Math.round((amt / den[code2][di]) * 1000) : 0);
}

// ---- 4. 写文件 ----
const body = JSON.stringify({ d: dates, s });
const js = '// 由 pipeline/gen_sec_hist.mjs 回算生成，勿手改。\n'
  + `// ${DAYS} 个交易日（${dates[0]} → ${dates[dates.length - 1]}）\n`
  + '// s[k] 是「占本组行业格成交额」的千分位整数（12.9% → 129），分母分组、主题不计入，与页面口径一致。\n'
  + '// c 是 A 股行业格每日 TOP3 集中度（千分位），b 是当日上涨格数占比（千分位）。c×b 画四象限。\n'
  + 'export const SEC_HIST = ' + body + ';\n';
if (!JSON_ONLY) writeFileSync(OUT, js);

// ---- 4b. 日档（38 格的绝对成交额，不是占比）----
// 用途只有一个：资金箭头拿「今天某格占比」减去「上一交易日同一格占比」。
// 必须存绝对值——两天的分母不同（今天半导体多、昨天通信多），存占比就减不出东西。
// 以前这份数据由浏览器在收盘后写 KV，没人打开页面就没有那天；
// 现在由 Actions 每天从全市场日线回算，与 hist 同源同时刻。
const dailyDays = [];
for (let di = Math.max(0, dates.length - DAILY_KEEP); di < dates.length; di++) {
  const sd = {};
  for (const [k] of keys) sd[k] = Math.round(cell.get(k)[di]);
  dailyDays.push({ d: dates[di], s: sd });
}
const daily = {
  generated_at: new Date().toISOString(),
  last_trade_date: dates[dates.length - 1],
  days: dailyDays
};
mkdirSync('dist', { recursive: true });
writeFileSync(DAILY_OUT, JSON.stringify(daily));

// ---- 5. 自检：占比合计必须接近 100%，否则就是分母或归格错了 ----
let sum = 0;
for (const [k, v] of keys) if (v.code === 'a' && !v.th) sum += s[k][dates.length - 1];
if (Math.abs(sum / 10 - 100) > 2) throw new Error(`A 股行业格占比合计 ${sum / 10}%，应为 100% 左右`);

console.log(`${DAILY_OUT}  ${(JSON.stringify(daily).length / 1024).toFixed(1)} KB`
  + `（${dailyDays.length} 天 × ${keys.size} 格）`);
if (!JSON_ONLY) console.log(`${OUT}  ${(js.length / 1024).toFixed(1)} KB`);
console.log(`  ${keys.size} 格 · ${dates.length} 个交易日 · ${dates[0]} → ${dates[dates.length - 1]}`);
console.log(`  A股行业格占比合计 ${(sum / 10).toFixed(1)}%`);
