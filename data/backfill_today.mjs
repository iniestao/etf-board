#!/usr/bin/env node
/**
 * 补齐「当天」那一根日线 —— 新浪的 T 日 K 线要等到深夜甚至次日才出，
 * 16:35 那轮定时任务拿到的永远是最新 T-1，页面因此整天慢一天。
 * 收盘后的实时快照里已经有当天 OHLCV，用它补上这一根。
 *
 * 为什么不是「再跑一遍」：2026-11-11 18:35 实测，四只代表标的的新浪 K 线
 * 最新都还是 11-10，而两个实时源都已经是 11-11。重跑同一个源不会让数据
 * 提前，只会把同一份旧数据再算一遍。
 *
 * 两个源：
 *   1. 东财 clist 快照   —— 17 页拿全市场，但成交量只有「手」（×100 有取整误差），
 *                           且对云 IP 间歇性 502（2026-11-11 19:01 那次全挂）
 *   2. 新浪 hq 实时快照  —— 22 批拿全市场，成交量直接是「份」，更准
 * 主用东财、不足时用新浪补齐；新浪拿到的条目优先（量更准）。
 *
 * 用法：
 *   node backfill_today.mjs                    # 默认 etf.db
 *   node backfill_today.mjs --db etf.db --dry   # 只报数，不写库
 *
 * 安全阀：
 *   · 15:05 之前直接退出（盘中拿到的是最新价，不是收盘价，写进去比缺数据更糟）
 *   · 快照日期必须等于今天（否则今天没开盘，节假日不该补）
 *   · 单只校验 close ∈ [low, high]、|close/昨收−1| ≤ 30%，不合规的丢进日志不写
 *   · 两个源合计不足 800 只就整批放弃：补一半会让页面显示成「一半标的停牌」
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
const HDR = {
  'User-Agent': UA,
  Referer: 'https://quote.eastmoney.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};
// 同一份接口挂在几个 CDN 节点上。Actions 的出口 IP 打东财会间歇性 502，
// 轮着试比死磕一个域名强。
const HOSTS = [
  'push2.eastmoney.com',
  '82.push2.eastmoney.com',
  '1.push2.eastmoney.com',
  'push2delay.eastmoney.com',
];
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
const { date: TODAY, min: NOW_MIN } = bjNow();

async function getJSON(pathAndQuery, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    const host = HOSTS[i % HOSTS.length];
    try {
      const r = await fetch('https://' + host + pathAndQuery, {
        headers: HDR,
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || typeof j !== 'object') throw new Error('返回不是 JSON 对象');
      return j;
    } catch (e) {
      last = e;
      // 1,2,4,8,16 秒：502 往往持续十几秒，打太急只会一直撞在同一个坑上
      if (i < tries - 1) await sleep(1000 * Math.pow(2, i));
    }
  }
  throw last;
}

/** 东财全市场收盘快照。f2 收 f5 量(手) f6 额 f15 高 f16 低 f17 开 f18 昨收 */
async function pullEM() {
  const out = new Map();
  let pages = 0, stampDay = null, stampToday = 0;
  let failedPages = 0, streak = 0;
  for (let pn = 1; pn <= 25; pn++) {
    const u = '/api/qt/clist/get?pn=' + pn
      + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent(FS)
      + '&fields=' + FIELDS;
    let j;
    try {
      j = await getJSON(u);
    } catch (e) {
      failedPages++;
      streak++;
      log(`  ! 第 ${pn} 页失败（${e.message}），跳过这 100 只`);
      // 连续三页都挂就不是单页抖动，是整条链路不可用（限流/被封）。
      // 继续翻只会把 25 页 × 6 次重试全撞一遍，白耗十分钟。
      if (streak >= 3) {
        log('  ! 连续 3 页失败，判定为链路不可用，停止拉取');
        break;
      }
      await sleep(2000);
      continue;
    }
    // 翻过最后一页时东财返回 data:null（不是空数组），不能当错误看
    const diff = (j.data && j.data.diff) || [];
    if (!diff.length) break;
    pages++;
    streak = 0;
    for (const x of diff) {
      const code = String(x.f12 || '');
      if (!/^\d{6}$/.test(code)) continue;
      const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
      const ts = num(x.f124);
      if (ts) {
        const day = bjDateOf(ts);
        if (!stampDay || day > stampDay) stampDay = day;
        if (day === TODAY) stampToday++;
      }
      const vol = num(x.f5);
      const amt = num(x.f6);
      out.set(code, {
        name: String(x.f14 || ''),
        open: num(x.f17), high: num(x.f15), low: num(x.f16),
        close: num(x.f2), prev: num(x.f18),
        vol: vol === null ? null : vol * 100,   // 手 → 份
        amt, src: 'em',
      });
    }
    await sleep(220);          // 连着打十几页会被限流
  }
  return { out, pages, failedPages, stampDay, stampToday };
}

/**
 * 新浪实时快照。字段：名称,开,昨收,现价,高,低,买一,卖一,成交量(份),成交额(元),…,日期,时间
 * 需要在第一次请求时初始化 TextDecoder('gbk') —— 返回是 GBK 编码。
 */
async function pullSina(codes) {
  const out = new Map();
  let batches = 0, okB = 0, failB = 0, dated = 0;
  const dec = new TextDecoder('gbk');
  for (let i = 0; i < codes.length; i += 80) {
    batches++;
    const list = codes.slice(i, i + 80)
      .map((c) => (c[0] === '5' ? 'sh' : 'sz') + c).join(',');
    let txt = null;
    for (let k = 0; k < 3; k++) {
      try {
        const r = await fetch('https://hq.sinajs.cn/list=' + list, {
          headers: { ...HDR, Referer: 'https://finance.sina.com.cn' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        txt = dec.decode(await r.arrayBuffer());
        break;
      } catch (e) {
        if (k === 2) failB++;
        else await sleep(800 * (k + 1));
      }
    }
    if (!txt) { await sleep(300); continue; }
    okB++;
    for (const line of txt.split('\n')) {
      const m = line.match(/hq_str_(?:sh|sz)(\d{6})="([^"]*)"/);
      if (!m) continue;
      const f = m[2].split(',');
      if (f.length < 31) continue;                 // 停牌时后面字段会被截断
      if (f[30] !== TODAY) continue;               // 只认今天的快照
      dated++;
      const num = (v) => {
        const n = parseFloat(v);
        return isFinite(n) ? n : null;
      };
      const vol = num(f[8]);
      if (!vol || vol <= 0) continue;
      out.set(m[1], {
        name: f[0],
        open: num(f[1]), prev: num(f[2]), close: num(f[3]),
        high: num(f[4]), low: num(f[5]),
        vol, amt: num(f[9]), src: 'sina',
      });
    }
    await sleep(180);
  }
  return { out, batches, okB, failB, dated };
}

// ------------------------------------------------------------------ 主流程

if (NOW_MIN < MIN_CLOSE) {
  log(`[skip] 北京 ${Math.floor(NOW_MIN / 60)}:${String(NOW_MIN % 60).padStart(2, '0')} 还没收盘，`
    + '盘中拿到的是最新价而不是收盘价，补进去比缺更糟');
  process.exit(0);
}

const db = new DatabaseSync(DBF);
const codes = db.prepare('SELECT DISTINCT code FROM etf_daily').all().map((r) => r.code);
log(`[pull] 目标 ${TODAY}，库内 ${codes.length} 只`);

const snap = new Map();
let emNote = '', sinaNote = '';

try {
  const em = await pullEM();
  for (const [k, v] of em.out) snap.set(k, v);
  emNote = `${em.pages} 页 / ${em.out.size} 只 / 日期 ${em.stampDay || '未知'}`
    + (em.failedPages ? ` / ${em.failedPages} 页失败` : '');
  log(`  东财：${emNote}`);
  if (em.out.size && em.stampToday < 100) {
    log(`  ! 东财快照只有 ${em.stampToday} 只落在今天，可能不是交易日`);
  }
} catch (e) {
  emNote = '全页失败';
  log(`  东财：${emNote}（${e.message}）`);
}

// 东财覆盖不到（货币/债券 ETF）或整条链路挂了，用新浪补
if (snap.size < 1500) {
  try {
    const si = await pullSina(codes);
    let added = 0;
    // 新浪的量精确到份，已存在的一并覆盖
    for (const [k, v] of si.out) { if (!snap.has(k)) added++; snap.set(k, v); }
    sinaNote = `${si.okB}/${si.batches} 批 / ${si.out.size} 只（新增 ${added}）`
      + (si.failB ? ` / ${si.failB} 批失败` : '');
    log(`  新浪：${sinaNote}`);
  } catch (e) {
    sinaNote = '失败';
    log(`  新浪：${sinaNote}（${e.message}）`);
  }
} else {
  log('  东财已覆盖全市场，不再打新浪');
}

if (!snap.size) {
  log('[fail] 两个源都没拿到数据（限流/被封），跳过补齐，等下一轮');
  process.exit(0);
}
if (snap.size < 800) {
  // 只拿到零头时补一半没意义：剩下的次日新浪会补，但当天页面会显示成
  // 「一半标的停牌」，比缺一天更容易误导
  log(`[skip] 两个源合计只有 ${snap.size} 只（不足 800），链路不稳，本轮不补`);
  process.exit(0);
}

const lastRow = db.prepare('SELECT date, adj_factor FROM etf_daily WHERE code = ? ORDER BY date DESC LIMIT 1');
const ins = db.prepare(`INSERT OR REPLACE INTO etf_daily
  (code,date,open,high,low,close,volume,amount,adj_factor) VALUES (?,?,?,?,?,?,?,?,?)`);
const bumpMeta = db.prepare('UPDATE etf_meta SET last_date = ? WHERE code = ? AND last_date < ?');

const stats = { done: 0, has: 0, halt: 0, dirty: 0, stale: 0, gap: 0, em: 0, sina: 0 };
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
      q.close, Math.round(q.vol), Math.round(q.amt || 0), last.adj_factor);
    bumpMeta.run(TODAY, code, TODAY);
  }
  if (q.src === 'sina') stats.sina++; else stats.em++;
  stats.done++;
}
if (!DRY) db.exec('COMMIT');

const filled = stats.done;
log(`\n[结果] ${DRY ? '（演练，未写库）' : ''}补入 ${filled} 只`
  + `（东财 ${stats.em} · 新浪 ${stats.sina}）`);
log(`  已有当天 ${stats.has} · 停牌/无成交 ${stats.halt} · 校验不过 ${stats.dirty}`
  + ` · 库内无此只 ${stats.stale}`);
if (dirty.length) log('  校验不过样例：' + dirty.slice(0, 5).join('；'));
if (stats.gap) log(`  ! ${stats.gap} 只库内最新不是上一交易日（有断档）：` + gapDays.join('；'));

const total = new Set([...snap.keys()]).size;
log(`  快照覆盖 ${(filled + stats.has)}/${total}`
  + `，库内 ${codes.length} 只中 ${codes.length - total} 只两个源都没给（货币/债券 ETF 等）`);

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
