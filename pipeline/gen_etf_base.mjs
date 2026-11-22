/**
 * 盯市提醒的日线基线 → dist/etf_base.json
 * ==========================================
 * 盘中的提醒只有一份「今天的快照」，判不了三件事：
 *   1) 今天这个量算不算大 —— 需要它自己前 20 日的日均成交额；
 *   2) 现在站在什么位置 —— 需要 250 日高低、20 日高低、MA20、布林带；
 *   3) 是不是刚跨过去 —— 需要「昨天不在、今天在」这个边沿，也就是昨天的收盘与均线。
 * 这三件事都是日线口径，且每天只变一次，所以收盘后算一遍、存成一个小文件，
 * 页面按代码 O(1) 取，不必盘中逐只拉历史（1700 只 × /api/hist 是不可能的事）。
 *
 * ---- 为什么锚点要往前挪一根 ----
 * 所有「昨日」量（MA20、250 日高低、20 日均额、连阳根数）都必须**不含今天**，
 * 因为今天要拿实时价去跟它们比。如果区间里含了今天，今天的价格永远在自己区间
 * 的内部，「创新高」这件事就永远不会触发——它被自己的最高价盖住了。
 * 16:35 那轮跑的时候今天已收盘入库，末根就是今天，锚点退到 n-2；
 * 07:00 那轮补跑时末根还是上一交易日，锚点就是 n-1。判据是末根日期等不等今天。
 *
 * ---- 为什么自己算 MA20 而不用文件里的 ma20 列 ----
 * ETH1 里的 ma20/boll 是**复权价**算完再换算回来的，而 close 列是原始成交价
 * （那是为了让 K 线和券商软件对得上）。两者在 20 日窗口内遇分红就差一点点。
 * 提醒要和「今天实时价」直接比大小，混用两套口径会让「站上 MA20」在分红日
 * 前后各错一次。统一用 close 自己算，简单均线、simple sd，两边同源。
 *
 * ---- 池子为什么在这里定 ----
 * 池子 = 同指数去重（每个指数留 20 日均额最大的一只）→ 剔债券货币 →
 * 20 日均额 ≥ 5000 万。放在服务端定的好处是只有一个事实来源：
 * 页面不再自己算「谁是代表」，直接认这份文件里的代码，两端不会因为
 * 「按当日成交额选代表」和「按 20 日均额选代表」选出不同的人而错位。
 * 代价是池子只能一天一调，盘中不跟着成交额换人——对提醒来说这恰恰是优点，
 * 代表标的早盘换一次、下午换一次，位置信号的基线跟着跳，反而不可读。
 *
 * 用法：node pipeline/gen_etf_base.mjs
 *      node pipeline/gen_etf_base.mjs --min-amt 3e7 --out /tmp/base.json
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const HIST = argOf('--hist', 'dist/hist');
const MAN = argOf('--manifest', 'dist/manifest.json');
const MAP = argOf('--map', 'pipeline/index_map.json');
const OUT = argOf('--out', 'dist/etf_base.json');
/* 5000 万这条线是实测出来的：去重后 501 只里，日均可交易额过 5000 万的只有 235 只，
   剩下的多半是几百万的小票——它们的「放量 2 倍」是几百万变一千万，照样走不掉货，
   价格也不可信。2000 万那档会把 300 只扫进来，前 N 名里就会混进这类票。 */
const MIN_AMT = +argOf('--min-amt', 5e7);

// ---- ETH1 解析（与 gen_sec_hist.mjs 同一套，见 alpha/compute.py 的格式注释） ----
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
    if (i < 0) return null;
    return view(i + 1, Float32Array);
  };
  return {
    n, code: hdr.code,
    dates: view(0, Int32Array),
    close: at('close'), high: at('high'), low: at('low'), amount: at('amount'),
  };
}

/* 北京时区的今天，YYYYMMDD。runner 是 UTC：16:35 北京那轮是同日 08:35 UTC，
   07:00 北京那轮是前一日 23:00 UTC——直接用 UTC 日期会把两个批次判成不同的日子。 */
function todayBJ() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

const R_BOND = ['债', '政金', '信用', '国开', '短融', '融资', '城投'];
const R_MONEY = ['货币', '现金', '保证金', '日利', '添益', '快线', '快钱', '理财', '财富宝', '金管家'];
/* 「自由现金流」「300现金流」是因子策略，名字里的「现金」不是现金管理。
   前端 calcGroup 里也有这条前置判断，两边必须一致——否则页面觉得它是宽基、
   这里把它当货币剔掉，池子就对不上了。 */
function cls(name) {
  const n = String(name || '');
  if (n.includes('现金流') || n.includes('自由现金')) return 'stock';
  for (const w of R_MONEY) if (n.includes(w)) return 'money';
  for (const w of R_BOND) if (n.includes(w)) return 'bond';
  return 'stock';
}

// ---- 1. 清单与映射 ----
if (!existsSync(MAN)) {
  console.error(`找不到 ${MAN}，先跑 alpha/compute.py`);
  process.exit(1);
}
const man = JSON.parse(readFileSync(MAN, 'utf8'));
const names = new Map();
for (const it of man.items || []) names.set(it.code, it.name || '');

let ixOf = new Map();
if (existsSync(MAP)) {
  const mp = JSON.parse(readFileSync(MAP, 'utf8'));
  for (const [code, v] of Object.entries(mp.map || {})) {
    const ix = v && (v.idx || v.index);
    if (ix) ixOf.set(code, String(ix));
  }
}

// ---- 2. 逐只算指标 ----
const codes = [];
for (const f of readdirSync(HIST)) if (f.endsWith('.bin')) codes.push(f.slice(0, -4));
codes.sort();

const TD = todayBJ();
const rows = new Map();   // code -> { ...指标, amt20 }
let skipped = 0;

for (const code of codes) {
  let p;
  try { p = parseEth1(readFileSync(join(HIST, code + '.bin'))); } catch (e) { skipped++; continue; }
  const { n, close, high, low, amount } = p;
  if (!close || !high || !low || n < 70) { skipped++; continue; }

  // 锚点：末根是「今天」就退一根，否则末根就是最近一个已收盘日
  let e = (p.dates[n - 1] === TD) ? n - 2 : n - 1;
  if (e < 60) { skipped++; continue; }

  // ---- 位置：250 日 / 20 日高低，区间到锚点为止 ----
  const s250 = Math.max(0, e - 249);
  let hi250 = -Infinity, lo250 = Infinity;
  for (let i = s250; i <= e; i++) {
    if (high[i] > hi250) hi250 = high[i];
    if (low[i] > 0 && low[i] < lo250) lo250 = low[i];
  }
  const s20 = Math.max(0, e - 19);
  let up20 = -Infinity, dn20 = Infinity;
  for (let i = s20; i <= e; i++) {
    if (high[i] > up20) up20 = high[i];
    if (low[i] > 0 && low[i] < dn20) dn20 = low[i];
  }

  // ---- MA20 与布林（close 口径，与实时价同源） ----
  let sum = 0, cnt = 0;
  for (let i = s20; i <= e; i++) if (close[i] > 0) { sum += close[i]; cnt++; }
  if (!cnt) { skipped++; continue; }
  const ma20 = sum / cnt;
  let sq = 0;
  for (let i = s20; i <= e; i++) if (close[i] > 0) sq += (close[i] - ma20) ** 2;
  const sd20 = Math.sqrt(sq / cnt);
  const bup = ma20 + 2 * sd20;
  const blo = ma20 - 2 * sd20;

  // ---- 20 日均额（元），锚点为止 ----
  let asum = 0, acnt = 0;
  for (let i = s20; i <= e; i++) if (amount[i] > 0) { asum += amount[i]; acnt++; }
  const amt20 = acnt ? asum / acnt : 0;

  // ---- 截至锚点的连阳(正)/连阴(负)根数，截断到 ±9 ----
  let st = 0;
  for (let i = e; i > 0; i--) {
    const d = close[i] - close[i - 1];
    if (!(Math.abs(d) > 1e-9)) break;
    const g = d > 0 ? 1 : -1;
    if (st === 0) st = g;
    else if (st > 0 === g > 0) st += g;
    else break;
    if (Math.abs(st) >= 9) break;
  }

  rows.set(code, {
    prev: close[e], hi250, lo250, up20, dn20, ma20, bup, blo,
    amt20, streak: st, ix: ixOf.get(code) || '', cls: cls(names.get(code)),
  });
}

// ---- 3. 同指数去重：一个指数一票，留 20 日均额最大的那只 ----
const best = new Map();   // key -> code
for (const [code, r] of rows) {
  // 没有跟踪标的的（映射没抓到）判断不了重复，各自成一组——宁可多扫一只，
  // 也不要把一只没人跟的票静默藏掉。这与页面 isRep 的取舍一致。
  const key = r.ix || ('__' + code);
  const cur = best.get(key);
  if (!cur || r.amt20 > rows.get(cur).amt20) best.set(key, code);
}

// ---- 4. 过滤与输出 ----
const keep = [];
for (const code of best.values()) {
  const r = rows.get(code);
  if (r.amt20 < MIN_AMT) continue;
  // 债券和货币整个类别不进：债券量太小，量能倍数与涨跌幅都没意义；货币价格恒定。
  // 折溢价它们本来值得看，但 0.5% 那种阈值放到一个另有 200 只股票类标的的弹窗
  // 队列里，只会把真信号挤掉。要看折价去「今日变化」那栏。
  if (r.cls !== 'stock') continue;
  keep.push(code);
}
keep.sort();

/* 紧凑输出：10 个数字一组，字段顺序写死在 header 里。
   用数组不用对象，是因为对象每只都要重复 10 个键名——200 只就多 8KB，
   而这份文件每 60 秒被拉一次的概率不高但也不低，能省则省。 */
const FIELDS = ['prev', 'hi250', 'lo250', 'up20', 'dn20', 'ma20', 'bup', 'blo', 'amt20', 'streak'];
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const vals = keep.map((code) => {
  const r = rows.get(code);
  return [
    r4(r.prev), r4(r.hi250), r4(r.lo250), r4(r.up20), r4(r.dn20),
    r4(r.ma20), r4(r.bup), r4(r.blo),
    Math.round(r.amt20 / 1e4),   // 万元，整数：比元短 4 位，比亿多位精度
    r.streak,
  ];
});

/* 数据截止日取 manifest 的 last_trade_date，不自己从末根推：
   停牌标的的末根可能停在几个月前，逐只取会算出五花八门的日期。 */
const lastDate = String(man.last_trade_date || '').replace(/-/g, '');

const out = {
  v: 1,
  // 页面拿截止日跟今天的快照日期比，判断基线是不是过期了：
  // 差一天正常（当天收盘前基线还是昨天的），差三天以上说明 Actions 断了。
  d: lastDate,
  n: keep.length,
  f: FIELDS,     // 字段顺序：数值数组按它解释，加字段时改这里、旧文件也不会静默错位
  c: keep,
  data: vals,
};

/* 池子塌了就别写盘：宁可线上继续用昨天那份基线，也不要发一份只有几十只的
   出去——页面会拿它当「全市场」，然后静默地什么都不报。 */
if (keep.length < 100) {
  console.error(`池子只剩 ${keep.length} 只，明显不正常，不覆盖 ${OUT}`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out), 'utf8');

const bytes = readFileSync(OUT).length;
const amts = vals.map((x) => x[8]);
const med = amts.length ? amts.slice().sort((a, b) => a - b)[Math.floor(amts.length / 2)] : 0;
console.log(`基线：${keep.length} 只（去重代表 ∩ 20 日均额 ≥ ${(MIN_AMT / 1e4).toFixed(0)} 万）`);
console.log(`  候选 ${rows.size} 只，去重后 ${best.size} 组，剔除债券/货币与薄票后 ${keep.length} 只`);
console.log(`  20 日均额中位数 ${(med / 1e4).toFixed(2)} 亿，最小 ${(Math.min(...amts) / 1e4).toFixed(2)} 亿，`
  + `最大 ${(Math.max(...amts) / 1e4).toFixed(2)} 亿`);
console.log(`  截止 ${lastDate}，跳过 ${skipped} 只（历史不足或无数据）`);
console.log(`  → ${OUT}（${(bytes / 1024).toFixed(1)} KB）`);
