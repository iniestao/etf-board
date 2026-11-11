/**
 * ETF 历史日线导入器
 * ==================
 * 拉取全市场 ETF 的完整日线历史（含成交额）与分红记录，写入 SQLite。
 *
 * 数据源：新浪 hisdata_klc2/klc_kl.js（全历史，已验证 510300 可回溯到 2012-05-28）
 *         + hfq.js（分红记录，用于计算复权因子）
 *
 * 用法：
 *   node import_etf.mjs                       # 全市场，输出 etf.db
 *   node import_etf.mjs --limit 50            # 只导 50 只（试跑）
 *   node import_etf.mjs --out my.db --delay 100
 *   node import_etf.mjs --resume              # 跳过已导入的代码，断点续跑
 *   node import_etf.mjs --codes 510300,513180 # 只导指定代码
 *
 * 零依赖：只用 Node 内置 fetch 与 node:sqlite（Node >= 22.5）
 */

import { DatabaseSync } from 'node:sqlite';
import decode from './sina_klc_decode.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const HDR = { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' };

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const arg = (k, dv) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dv;
};
const flag = (k) => argv.includes('--' + k);

const OUT = arg('out', 'etf.db');
const LIMIT = parseInt(arg('limit', '0'), 10);
const DELAY = parseInt(arg('delay', '70'), 10);   // 每只间隔 ms，别调太低
const RESUME = flag('resume');
const ONLY = (arg('codes', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const RETRY = parseInt(arg('retry', '2'), 10);

// ---------------------------------------------------------------- 工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d2s = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function get(url, tries = RETRY + 1) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- ETF 列表
/* 两个源都要，缺一个就少几百只：
   - 新浪 etf_hq_fund 给的是**短简称**（「科创债WJ」「信用债DC」这种只有它有），
     但节点口径会变：2026-11-11 它的 count 接口自报 938 只，而前一天还是 1719。
     靠它单独当名单，数据会静默腰斩（完整性断言才拦下来）。
   - 东财 b:MK0021..MK0024 覆盖 1660 只、名称规范，但漏掉那 60 只债券 ETF。
   所以两个源取并集：新浪的简称优先保留，东财补覆盖。 */
const EM_HDR = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };

async function getEM(url, tries = RETRY + 1) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: EM_HDR });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(500 * (i + 1));
    }
  }
  throw last;
}

async function listETF() {
  if (ONLY.length) return ONLY.map((c) => ({ code: c, name: '' }));
  const out = [];
  const seen = new Set();
  const push = (c, n) => {
    const code = String(c || '');
    if (!/^\d{6}$/.test(code) || seen.has(code)) return;
    seen.add(code);
    out.push({ code, name: String(n || '') });
  };

  // 1) 新浪：短简称，量少但补得上债券 ETF
  let sinaN = 0;
  for (let p = 1; p <= 30; p++) {
    const u = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
      + 'Market_Center.getHQNodeData?page=' + p
      + '&num=100&sort=symbol&asc=1&node=etf_hq_fund&symbol=&_s_r_a=page';
    let arr;
    try { arr = JSON.parse(await get(u)); } catch { arr = null; }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const x of arr) {
      // 新浪的 symbol 自带 sh/sz 前缀，统一剥成 6 位数字
      push(String(x.symbol || x.code || '').replace(/^(sh|sz)/i, ''), x.name);
    }
    sinaN = out.length;
    await sleep(120);            // 连着打十几页会被限流，前面就是这样静默断在第 10 页
  }

  // 2) 东财：覆盖全，名称规范
  const fss = 'b:MK0021,b:MK0022,b:MK0023,b:MK0024';
  for (let pn = 1; pn <= 25; pn++) {
    const u = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn
      + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent(fss)
      + '&fields=f12,f14';
    let d = null;
    try { d = JSON.parse(await getEM(u)); } catch { d = null; }
    const diff = (d && d.data && d.data.diff) || [];
    if (!diff.length) break;
    for (const x of diff) push(String(x.f12 || ''), x.f14);
    await sleep(200);
  }

  console.log(`名单：新浪 ${sinaN} 只，并上东财后共 ${out.length} 只`);
  if (out.length < 1500) {
    console.log('::warning::名单只有 ' + out.length + ' 只，两个上游可能都在降级');
  }
  return out;
}

// 代码 -> 新浪前缀
const toSym = (code) => (/^[56]/.test(code) ? 'sh' : 'sz') + code;

// ---------------------------------------------------------------- 单只历史
async function getBars(code) {
  const sym = toSym(code);
  const t = await get(`https://finance.sina.com.cn/realstock/company/${sym}/hisdata_klc2/klc_kl.js`);
  if (!t.includes('=')) throw new Error('未返回数据');
  const b64 = t.split('=').slice(1).join('=').split(';')[0].replace(/"/g, '').trim();
  const arr = decode(b64);
  if (!Array.isArray(arr) || !arr.length) throw new Error('历史为空');
  return arr.map((x) => ({
    date: d2s(x.date),
    open: +x.open, high: +x.high, low: +x.low, close: +x.close,
    volume: Math.round(+x.volume || 0),
    amount: Math.round(+x.amount || 0),
  })).filter((b) => b.date && b.close > 0);
}

// 分红记录：u 为累计每份分红，相邻差值即本次分红
async function getDivs(code) {
  const sym = toSym(code);
  try {
    const t = await get(`https://finance.sina.com.cn/realstock/company/${sym}/hfq.js`);
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i < 0 || j < 0) return [];
    const o = JSON.parse(t.slice(i, j + 1));
    const rows = (o.data || [])
      .map((r) => ({ d: r.d, u: parseFloat(r.u) }))
      .filter((r) => r.d && r.d !== '1900-01-01' && isFinite(r.u))
      .sort((a, b) => (a.d < b.d ? -1 : 1));   // 正序
    const out = [];
    for (let k = 1; k < rows.length; k++) {
      const div = +(rows[k].u - rows[k - 1].u).toFixed(6);
      if (div > 0) out.push({ date: rows[k].d, div });
    }
    return out;
  } catch { return []; }
}

/**
 * 计算后复权因子。
 *
 * 有两类事件会让价格不连续，都必须还原：
 *   1) 分红除权：价格下跌 div 元，乘子 = preClose / (preClose - div)
 *   2) 份额折算：净值重新标定（1:3.6、1:10、1:0.5…），乘子 = 实际跳空 / 分红能解释的部分
 *
 * 折算在 hfq.js 里没有记录，只能靠价格跳变识别。A 股 ETF 有 10% 涨跌停，
 * 单日跳空超过 ±30% 必然是折算而非真实行情，因此用 1.3 / 0.77 作初筛阈值。
 *
 * 【因子方向】后复权 = 把历史分红不断加回去，让最新价变成「分红再投资的当前价值」。
 * 所以因子是「从最早累乘到该日」的前缀积：
 *   factor(t) = ∏(所有事件日 <= t 的乘子)，最早日 = 1，最新日 = 全部乘子之积 ≥ 1
 * 后复权价 = 原价 × factor。
 * 前复权价 = 原价 × factor / factor(最新)。
 *
 * 反过来做（乘在事件日之前的 bar 上）会把分红收益吃掉：
 * 510300 十四年含分红再投资实际 +95.6%，那样算只有 +26%。
 */
function adjFactors(bars, divs) {
  const events = [];
  const dayDiv = new Map();   // date -> 当日分红合计

  // ---- 1. 分红 ----
  for (const dv of divs) {
    let pre = null;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].date < dv.date) { pre = bars[i].close; break; }
    }
    if (!pre || pre <= 0) continue;
    const base = pre - dv.div;
    if (base <= 0) continue;
    events.push({ date: dv.date, kind: 'div', value: dv.div, step: pre / base });
    dayDiv.set(dv.date, (dayDiv.get(dv.date) || 0) + dv.div);
  }

  // ---- 2. 份额折算（跳变检测）----
  // 统一乘子口径：step = 老价格 / 新价格
  //   分红：pre / (pre - div)      —— 价格下跌，后续价格要乘 >1 的因子
  //   缩股：pre / open = 1/ratio   —— 价格上跳，后续价格要乘 <1 的因子
  // 两者都是「把新口径价格还原回老口径」的倍数，所以能连乘。
  for (let i = 1; i < bars.length; i++) {
    const pre = bars[i - 1].close, op = bars[i].open;
    if (pre <= 0 || op <= 0) continue;
    const actual = op / pre;
    const div = dayDiv.get(bars[i].date) || 0;
    // 分红能解释的理论跳空
    const explained = div > 0 && pre - div > 0 ? (pre - div) / pre : 1;
    // 扣掉分红后仍有的大幅跳空，才算折算
    const residual = actual / explained;
    if (residual > 1.3 || residual < 0.77) {
      events.push({ date: bars[i].date, kind: 'split', value: residual, step: 1 / residual });
    }
  }

  if (!events.length) return { factors: bars.map(() => 1), events };

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 前缀积：按日期升序累乘
  const factors = new Array(bars.length);
  let acc = 1, ei = 0;
  for (let i = 0; i < bars.length; i++) {
    while (ei < events.length && events[ei].date <= bars[i].date) {
      acc *= events[ei].step;
      ei++;
    }
    factors[i] = acc;
  }
  return { factors, events };
}

// ---------------------------------------------------------------- 建表
const SCHEMA = `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE IF NOT EXISTS etf_meta (
  code       TEXT PRIMARY KEY,
  name       TEXT,
  exchange   TEXT,
  first_date TEXT,
  last_date  TEXT,
  bars       INTEGER,
  divs       INTEGER,
  updated_at TEXT
);

-- 日线：主键 (code, date)，WITHOUT ROWID 省 30% 空间
CREATE TABLE IF NOT EXISTS etf_daily (
  code       TEXT NOT NULL,
  date       TEXT NOT NULL,
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     INTEGER NOT NULL DEFAULT 0,
  amount     INTEGER NOT NULL DEFAULT 0,
  adj_factor REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS etf_dividend (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  div  REAL NOT NULL,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

-- 复权事件全记录：分红除权 + 份额折算，可直接查询审计
CREATE TABLE IF NOT EXISTS etf_adjust (
  code   TEXT NOT NULL,
  date   TEXT NOT NULL,
  kind   TEXT NOT NULL,          -- 'div' 分红 | 'split' 份额折算
  value  REAL NOT NULL,          -- 分红金额(元/份) 或 折算比例
  step   REAL NOT NULL,          -- 实际乘子（后复权时老价格乘这个数）
  PRIMARY KEY (code, date, kind)
) WITHOUT ROWID;
`;

// ---------------------------------------------------------------- 主流程
const t0 = Date.now();

// 只查名单，不建库、不抓 K 线：上游口径变了要先能一眼看到数量，
// 而不是等九天跑完一条条往下翻
if (flag('list-only')) {
  const l = await listETF();
  console.log(JSON.stringify(l.slice(0, 3)));
  console.log(`共 ${l.length} 只`);
  process.exit(0);
}

const db = new DatabaseSync(OUT);
db.exec(SCHEMA);

console.log(`输出: ${OUT}`);
const list = await listETF();
console.log(`ETF 列表: ${list.length} 只`);

// 断点续跑：读出已完成的代码
const done = new Set();
if (RESUME) {
  for (const r of db.prepare('SELECT code FROM etf_meta').all()) done.add(r.code);
  if (done.size) console.log(`续跑：已有 ${done.size} 只，跳过`);
}

let todo = list.filter((x) => !done.has(x.code));
if (LIMIT > 0) todo = todo.slice(0, LIMIT);

const insBar = db.prepare(`INSERT OR REPLACE INTO etf_daily
  (code,date,open,high,low,close,volume,amount,adj_factor) VALUES (?,?,?,?,?,?,?,?,?)`);
const insMeta = db.prepare(`INSERT OR REPLACE INTO etf_meta
  (code,name,exchange,first_date,last_date,bars,divs,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
const insDiv = db.prepare('INSERT OR REPLACE INTO etf_dividend (code,date,div) VALUES (?,?,?)');
const insAdj = db.prepare('INSERT OR REPLACE INTO etf_adjust (code,date,kind,value,step) VALUES (?,?,?,?,?)');
const delBar = db.prepare('DELETE FROM etf_daily WHERE code = ?');
const delAdj = db.prepare('DELETE FROM etf_adjust WHERE code = ?');

const fails = [];
let ok = 0, totalBars = 0, totalDivs = 0;

for (let i = 0; i < todo.length; i++) {
  const { code, name } = todo[i];
  const tag = `[${String(i + 1).padStart(4)}/${todo.length}] ${code}`;
  try {
    const bars = await getBars(code);
    const divs = await getDivs(code);
    const { factors, events } = adjFactors(bars, divs);

    db.exec('BEGIN');
    try {
      delBar.run(code);               // 幂等：重跑时先清旧数据
      delAdj.run(code);
      for (let k = 0; k < bars.length; k++) {
        const b = bars[k];
        insBar.run(code, b.date, b.open, b.high, b.low, b.close, b.volume, b.amount, factors[k]);
      }
      for (const dv of divs) insDiv.run(code, dv.date, dv.div);
      for (const ev of events) insAdj.run(code, ev.date, ev.kind, +ev.value.toFixed(6), +ev.step.toFixed(6));
      insMeta.run(code, name, toSym(code).slice(0, 2), bars[0].date, bars[bars.length - 1].date,
        bars.length, divs.length, new Date().toISOString().slice(0, 19));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    ok++; totalBars += bars.length; totalDivs += divs.length;
    if ((i + 1) % 20 === 0 || i === todo.length - 1) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / (i + 1)) * (todo.length - i - 1);
      process.stdout.write(`\r${tag} ✓ ${bars.length}条 | 累计 ${totalBars.toLocaleString()} 条`
        + ` | 失败 ${fails.length} | ${el.toFixed(0)}s 剩余${eta.toFixed(0)}s   `);
    }
  } catch (e) {
    fails.push({ code, err: String(e.message || e).slice(0, 60) });
    if ((i + 1) % 20 === 0) process.stdout.write(`\r${tag} ✗ ${e.message.slice(0, 40)}   `);
  }
  await sleep(DELAY);
}

// 建索引（导入后建更快）
console.log('\n\n建索引...');
db.exec('CREATE INDEX IF NOT EXISTS idx_daily_date ON etf_daily(date)');
db.exec('ANALYZE');

// ---------------------------------------------------------------- 报告
const stat = db.prepare(`SELECT
  (SELECT COUNT(*) FROM etf_meta) m,
  (SELECT COUNT(*) FROM etf_daily) d,
  (SELECT COUNT(*) FROM etf_dividend) v,
  (SELECT COUNT(*) FROM etf_adjust WHERE kind='split') s,
  (SELECT COUNT(DISTINCT code) FROM etf_adjust WHERE kind='split') sc,
  (SELECT MIN(date) FROM etf_daily) f,
  (SELECT MAX(date) FROM etf_daily) l`).get();
const sizeMB = (db.prepare('PRAGMA page_count').get().page_count
  * db.prepare('PRAGMA page_size').get().page_size) / 1024 / 1024;

console.log(`\n${'='.repeat(56)}`);
console.log(`ETF      ${stat.m} 只（成功 ${ok}，失败 ${fails.length}）`);
console.log(`日线     ${stat.d.toLocaleString()} 条`);
console.log(`分红     ${stat.v.toLocaleString()} 条`);
console.log(`折算     ${stat.s} 次（涉及 ${stat.sc} 只，已计入复权因子）`);
console.log(`区间     ${stat.f} ~ ${stat.l}`);
console.log(`库大小   ${sizeMB.toFixed(1)} MB`);
console.log(`耗时     ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
if (fails.length) {
  console.log(`\n失败 ${fails.length} 只（可加 --resume 重跑）:`);
  fails.slice(0, 15).forEach((f) => console.log(`  ${f.code}  ${f.err}`));
  if (fails.length > 15) console.log(`  ... 还有 ${fails.length - 15} 只`);
}
db.close();
