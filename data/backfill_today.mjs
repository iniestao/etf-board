#!/usr/bin/env node
/**
 * 补齐「当天」那一根日线 —— 新浪的 T 日 K 线要等到深夜甚至次日才出，
 * 16:35 这轮定时任务拿到的永远是最新 T-1，页面因此整天慢一天。
 * 东财的收盘快照在 15:00 之后就有当天数据，用它补上这一根。
 *
 * 为什么不是「再跑一遍新浪」：2026-11-11 18:35 实测，四只代表标的的新浪
 * K 线最新都还是 11-10，而东财已经是 11-11。重跑同一个源不会让数据提前，
 * 只会把同一份旧数据再算一遍。
 *
 * 用法：
 *   node backfill_today.mjs                    # 默认 etf.db
 *   node backfill_today.mjs --db etf.db --dry   # 只报数，不写库
 *
 * 安全阀：
 *   · 15:05 之前直接退出（盘中 f2 是最新价，不是收盘价，写进去比缺数据更糟）
 *   · 只有当快照时间戳落在「今天」才认（否则今天没开盘，节假日不该补）
 *   · 单只校验 close ∈ [low, high]、|close/昨收−1| ≤ 30%，不合规的丢进日志不写
 */
import { DatabaseSync } from 'node:sqlite';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? (process.argv[i + 1] ?? true) : d;
};
const DRY = process.argv.includes('--dry');
const DBF = String(arg('db', 'etf.db'));
const MIN_CLOSE = Number(arg('min-close', 905));   // 北京 15:05 = 905 分钟

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
const FS = 'b:MK0021,b:MK0022,b:MK0023,b:MK0024';
const FIELDS = 'f12,f14,f2,f5,f6,f15,f16,f17,f18,f124';

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const log = (m) => console.log(m);

/** 北京时间的今天与"当天第几分钟"（容器是 UTC，不能直接读本地时区） */
function bjNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
const bjDateOf = (sec) => {
  const d = new Date(sec * 1000 + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

async function getJSON(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || typeof j !== 'object') throw new Error('返回不是 JSON 对象');
      return j;
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(600 * (i + 1));
    }
  }
  throw last;
}

/** 东财全市场收盘快照。f2 最新价 f5 成交量(手) f6 成交额(元) f15 高 f16 低 f17 开 f18 昨收 */
async function pullSnapshot() {
  const out = new Map();
  let pages = 0, stampDay = null, stampToday = 0;
  const today = bjNow().date;
  for (let pn = 1; pn <= 25; pn++) {
    const u = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn
      + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent(FS)
      + '&fields=' + FIELDS;
    const j = await getJSON(u);
    // 翻过最后一页时东财返回 data:null（不是空数组），不能当错误看
    const diff = (j.data && j.data.diff) || [];
    if (!diff.length) break;
    pages++;
    for (const x of diff) {
      const code = String(x.f12 || '');
      if (!/^\d{6}$/.test(code)) continue;
      const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
      const ts = num(x.f124);
      if (ts) {
        const day = bjDateOf(ts);
        if (!stampDay || day > stampDay) stampDay = day;
        if (day === today) stampToday++;
      }
      out.set(code, {
        name: String(x.f14 || ''),
        open: num(x.f17), high: num(x.f15), low: num(x.f16),
        close: num(x.f2), prev: num(x.f18),
        vol: num(x.f5), amt: num(x.f6),
      });
    }
    await sleep(220);          // 连着打十几页会被限流
  }
  return { snap: out, pages, stampDay, stampToday, today };
}

const { date: TODAY, min: NOW_MIN } = bjNow();

if (NOW_MIN < MIN_CLOSE) {
  log(`[skip] 北京 ${Math.floor(NOW_MIN / 60)}:${String(NOW_MIN % 60).padStart(2, '0')} 还没收盘，`
    + '盘中 f2 是最新价而不是收盘价，补进去比缺更糟');
  process.exit(0);
}

log(`[pull] 东财收盘快照（目标 ${TODAY}）`);
let pulled;
try {
  pulled = await pullSnapshot();
} catch (e) {
  log(`[fail] 快照拉取失败：${e.message}。跳过补齐，等下一轮`);
  process.exit(0);           // 不判红：这是补丁，主数据由新浪负责
}
const { snap, pages, stampDay, stampToday } = pulled;
log(`   ${pages} 页 / ${snap.size} 只 / 快照日期 ${stampDay || '未知'}`);

if (stampToday < 100) {
  log(`[skip] 快照里只有 ${stampToday} 只落在 ${TODAY}，今天不是交易日（或尚未开盘），不补`);
  process.exit(0);
}
if (stampDay && stampDay < TODAY) {
  log(`[skip] 快照最新只到 ${stampDay}，数据源还没更新，不补`);
  process.exit(0);
}

const db = new DatabaseSync(DBF);
const lastRow = db.prepare('SELECT date, adj_factor FROM etf_daily WHERE code = ? ORDER BY date DESC LIMIT 1');
const ins = db.prepare(`INSERT OR REPLACE INTO etf_daily
  (code,date,open,high,low,close,volume,amount,adj_factor) VALUES (?,?,?,?,?,?,?,?,?)`);
const bumpMeta = db.prepare('UPDATE etf_meta SET last_date = ? WHERE code = ? AND last_date < ?');

const stats = { done: 0, has: 0, halt: 0, dirty: 0, stale: 0, gap: 0 };
const dirty = [];
const gapDays = [];

if (!DRY) db.exec('BEGIN');
for (const [code, q] of snap) {
  const last = lastRow.get(code);
  if (!last) { stats.stale++; continue; }                 // 库里没有这只，交给新浪主流程
  if (last.date >= TODAY) { stats.has++; continue; }      // 已经有当天（第二轮重跑时）
  if (!q.close || q.close <= 0 || !q.vol || q.vol <= 0) { stats.halt++; continue; }

  // 停牌或异常：收盘价跑到 [low, high] 之外，或相对昨收跳得离谱
  if (q.high && q.low && (q.close > q.high * 1.001 || q.close < q.low * 0.999)) {
    stats.dirty++; dirty.push(`${code} 收 ${q.close} 不在 [${q.low}, ${q.high}]`); continue;
  }
  if (q.prev && Math.abs(q.close / q.prev - 1) > 0.30) {
    stats.dirty++; dirty.push(`${code} 相对昨收 ${q.prev} 跳 ${((q.close / q.prev - 1) * 100).toFixed(1)}%`);
    continue;
  }

  // 库里最新不是上一交易日 → 中间断过档，补今天会在 K 线上留个缺口
  if (last.date < prevWorkday(TODAY)) {
    stats.gap++;
    if (gapDays.length < 5) gapDays.push(`${code} 库内最新 ${last.date}`);
  }

  if (!DRY) {
    ins.run(code, TODAY, q.open || q.close, q.high || q.close, q.low || q.close,
      q.close, Math.round(q.vol * 100), Math.round(q.amt || 0), last.adj_factor);
    bumpMeta.run(TODAY, code, TODAY);
  }
  stats.done++;
}
if (!DRY) db.exec('COMMIT');

const filled = stats.done;
log(`\n[结果] ${DRY ? '（演练，未写库）' : ''}补入 ${filled} 只`);
log(`  已有当天 ${stats.has} · 停牌/无成交 ${stats.halt} · 校验不过 ${stats.dirty}`
  + ` · 库内无此只 ${stats.stale}`);
if (dirty.length) log('  校验不过样例：' + dirty.slice(0, 5).join('；'));
if (stats.gap) log(`  ! ${stats.gap} 只库内最新不是上一交易日（有断档）：` + gapDays.join('；'));

const covered = snap.size ? (filled / snap.size * 100).toFixed(1) : '0';
log(`  覆盖 ${filled}/${snap.size} = ${covered}%（东财不含货币/债券 ETF，余下的等新浪）`);

// 补 0 只有两种可能：本来就有当天（兜底批次重跑，正常），或者源没更新（异常）。
// 不区分的话，每天第二批都会报一条假警。
if (!DRY && filled === 0 && stats.has === 0) {
  log('\n[警告] 一只都没补上，且库里也没有当天数据：源没更新或校验全被拦');
  process.exitCode = 1;
}

function prevWorkday(d) {
  const t = new Date(d + 'T00:00:00Z');
  do { t.setUTCDate(t.getUTCDate() - 1); } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
}
