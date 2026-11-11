/**
 * ETF 份额日档生成器
 * ==================
 * 把「每日份额」变成「每日净申购金额」，并处理份额折算。
 *
 * 输入
 *   data/shares/sz_hist.json   深市份额（份），每只一行
 *   data/shares/sh_hist.json   沪市份额（份）
 *   data/etf.db                收盘价（etf_daily）+ 折算事件表（etf_adjust）
 *   pipeline/index_map.json    code → 跟踪指数
 *   dist/manifest.json         最新交易日 T
 *
 * 输出（data 分支 shares/）
 *   last.json        {d, ax, c:{code:份额亿份}, f:{code:净流入亿元}, ix:{code:指数名}}
 *   <code>.json      {c, n, v:[每日净流入亿元], s:最新份额, cv:{下标:折算乘子}}
 *   ix.json          {d, ax, ix:{指数名:{v:[每日汇总], n:成员数}}}
 *
 * 口径
 *   净流入_t = (S_t − S_{t−1} × k_t) × close_t / 1e8   （亿元，红=净申购）
 *   k_t 是该日的折算份额乘子（无折算 = 1）。折算日不修正会凭空多出几百亿，
 *   详见 data/shares/README.md。
 *
 * 用法
 *   node pipeline/gen_shares.mjs                  # 用现有份额算，输出 dist/shares
 *   node pipeline/gen_shares.mjs --fetch          # 先抓当日份额（收盘后跑）
 *   node pipeline/gen_shares.mjs --ax 250         # 轴长
 *   node pipeline/gen_shares.mjs --dry            # 只打印统计不写盘
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, dv) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : dv; };
const flag = (k) => argv.includes('--' + k);

const AX = parseInt(arg('ax', '250'), 10);
const OUT = path.join(ROOT, 'dist/shares');
const DBF = arg('db', path.join(ROOT, 'data/etf.db'));
const DRY = flag('dry');
const SZ_F = path.join(ROOT, 'data/shares/sz_hist.json');
const SH_F = path.join(ROOT, 'data/shares/sh_hist.json');

const log = (...a) => console.log(...a);
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- 文件读写

/** 每只一行地写份额文件（与 tools/xlsx2shares.py 的 write_shares 同格式）。 */
async function writeSharesFile(file, obj) {
  const head = {};
  for (const k of Object.keys(obj)) if (k !== 'n' && k !== 'c') head[k] = obj[k];
  const codes = Object.keys(obj.c);
  const lines = [JSON.stringify(head).slice(0, -1) + ',"n":{'];
  codes.forEach((c, i) => {
    lines.push(`${JSON.stringify(c)}:${JSON.stringify(obj.n?.[c] ?? '')}${i < codes.length - 1 ? ',' : ''}`);
  });
  lines.push('},"c":{');
  codes.forEach((c, i) => {
    lines.push(`${JSON.stringify(c)}:${JSON.stringify(obj.c[c])}${i < codes.length - 1 ? ',' : ''}`);
  });
  lines.push('}}');
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, lines.join('\n') + '\n');
  await fs.rename(tmp, file);
}

async function loadShares() {
  const out = [];
  for (const [f, mkt] of [[SZ_F, 'SZ'], [SH_F, 'SH']]) {
    if (!existsSync(f)) { log(`  · ${mkt} 份额文件不存在，跳过`); continue; }
    const d = JSON.parse(await fs.readFile(f, 'utf8'));
    out.push({ mkt, d: d.d, c: d.c, n: d.n || {}, raw: d });
    log(`  · ${mkt} ${Object.keys(d.c).length} 只 × ${d.d.length} 天（${d.d[0]} ~ ${d.d[d.d.length - 1]}）`);
  }
  if (!out.length) throw new Error('没有任何份额文件，先跑 tools/xlsx2shares.py / tools/sse_hist.py');
  return out;
}

// ---------------------------------------------------------------- 抓当日份额

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 深市：东财 clist 的 f38（总份额，单位份）。只在收盘后采信。 */
/** 东财 f38：一次拿到沪深两市的份额。深市只有这一个源；沪市拿它给上交所兜底。 */
async function fetchEMShares() {
  const out = { sz: {}, sh: {} };
  for (let pn = 1; pn <= 20; pn++) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get'
      + `?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=b:MK0021&fields=f12,f14,f38`;
    let d = null;
    for (let k = 0; k < 4; k++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        d = await r.json();
        break;
      } catch (e) { await sleep(1500 * (k + 1)); }
    }
    const diff = d?.data?.diff;
    if (!diff || !diff.length) break;
    for (const x of diff) {
      const c = String(x.f12 || '');
      const v = typeof x.f38 === 'number' && x.f38 > 0 ? Math.round(x.f38) : null;
      if (!v) continue;
      if (/^15\d{4}$/.test(c)) out.sz[c] = v;
      else if (/^5\d{5}$/.test(c)) out.sh[c] = v;
    }
    await sleep(350);            // 东财会限流，别打太急
  }
  // 空结果必须返回 null：原来返回 {} 会让上层判成「抓取成功、追加 0 只有值」，
  // 日志一片绿但其实什么都没拿到。东财被限流时正是这个表现（Empty reply）。
  if (!Object.keys(out.sz).length && !Object.keys(out.sh).length) return null;
  return out;
}

/** 沪市：上交所 ETF 规模报表的 TOT_VOL（万份）。必须校验 STAT_DATE 回显。 */
/**
 * 深交所 ETF 规模报表（CATALOGID=1945）给的 dqgm 就是「当前规模」，单位万份，
 * 与 sz_hist 的份额口径一致（158076 两边都是 10,169.75 万份）。
 *
 * 这是深市的**第二源**：东财 f38 对云 IP 会整段拒连（2026-11-11 Actions 上
 * 25 页全挂），而深市份额断一天就再也补不回来——它不像沪市能用 STAT_DATE 回查。
 * 所以宁可翻 78 页（每页固定 10 行，传 PAGESIZE 无效）也要拿到。
 */
async function fetchSZSE(day) {
  const bases = [
    'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1945&txtDate=' + day,
    'http://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1945&txtDate=' + day,
  ];
  const out = {};
  let pages = 0;
  for (let pg = 1; pg <= 90; pg++) {
    let d = null, why = '';
    for (let k = 0; k < 3; k++) {
      try {
        const r = await fetch(bases[k % bases.length] + '&PAGENO=' + pg + '&random=' + Math.random(),
          { headers: { 'User-Agent': UA, Referer: 'https://www.szse.cn/', Accept: '*/*' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        d = Array.isArray(j) ? j[0] : null;
        if (!d) why = '返回结构不对';
        break;
      } catch (e) { why = e.message; await sleep(600 * (k + 1)); }
    }
    if (!d) { log(`    （深交所第 ${pg} 页拿不到：${why}）`); break; }
    // 报表表头带日期，不是目标日说明当天还没发布
    const stamp = String((d.metadata && d.metadata.subname) || '').trim();
    if (pg === 1 && stamp && stamp !== day) {
      log(`    （深交所报表日期是 ${stamp}，不是 ${day}，当天还没发布）`);
      return null;
    }
    const rows = d.data || [];
    if (!rows.length) break;
    pages++;
    for (const r of rows) {
      const m = /code=(\d{6})/.exec(r.sys_key || '');
      const v = parseFloat(String(r.dqgm || '').replace(/,/g, ''));
      if (m && v > 0) out[m[1]] = Math.round(v * 1e4);
    }
    if (d.metadata && d.metadata.pagecount && pg >= d.metadata.pagecount) break;
    await sleep(120);
  }
  if (!Object.keys(out).length) return null;
  log(`    （深交所 ${pages} 页 / ${Object.keys(out).length} 只）`);
  return out;
}

async function fetchSH(day) {
  const url = 'http://query.sse.com.cn/commonQuery.do'
    + '?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L'
    + `&STAT_DATE=${day}&pageHelp.pageSize=5000&pageHelp.pageNo=1`;
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'http://www.sse.com.cn/', Accept: '*/*' },
      });
      const d = await r.json();
      if (d.STAT_DATE && d.STAT_DATE !== day) return null;   // 该日还没发布
      const res = d.result || [];
      if (!res.length) { await sleep(1500 + k * 1000); continue; }
      const out = {};
      for (const x of res) {
        const c = String(x.SEC_CODE || '').trim();
        const v = parseFloat(x.TOT_VOL);
        if (/^5\d{5}$/.test(c) && v > 0) out[c] = Math.round(v * 1e4);
      }
      return Object.keys(out).length ? out : null;
    } catch (e) { await sleep(1500 + k * 1000); }
  }
  return null;
}

/** 把某天的份额追加到轴上；数据源没更新则不动。 */
async function fetchAppend(mk) {
  const T = mk.last_trade_date;
  log(`\n[fetch] 目标日 ${T}`);

  /* 份额轴必须逐格对齐。原来只 push 一个 T：沪深两份文件是各追各的，某天
     只有一边抓成功（上交所报表比东财晚，或反向），那一份的 d 就少一天，
     而 c 数组按索引对应 —— 下次再 push，整条历史就永久错开一天，且看不出来。
     所以这里按「价格库的交易日历」把中间缺的日子一并补上，缺的那天写 null。 */
  let db = null;
  const daysBetween = (after) => {
    if (!db) db = openDb();
    return db.prepare('SELECT DISTINCT date FROM etf_daily WHERE date > ? AND date <= ? ORDER BY date')
      .all(after, T).map((r) => r.date);
  };

  let emCache = null;
  const emShares = async () => { if (!emCache) emCache = await fetchEMShares(); return emCache; };

  for (const m of await loadShares()) {
    if (m.d[m.d.length - 1] >= T) { log(`  · ${m.mkt} 轴已到 ${m.d[m.d.length - 1]}，跳过`); continue; }
    /* 深市只有东财一个源；沪市上交所优先（TOT_VOL 万份、口径最正），
       但它约 1/3 概率返回空（未发布或限流），失败就降级到东财 f38。 */
    let got = null, srcNote = '';
    if (m.mkt === 'SZ') {
      got = (await emShares())?.sz || null;
      // 东财整段挂掉时只拿到几只甚至 0 只，这时改走深交所
      if (!got || Object.keys(got).length < 700) {
        const s = await fetchSZSE(T);
        if (s && Object.keys(s).length > (got ? Object.keys(got).length : 0)) {
          got = s; srcNote = '（东财没给，降级深交所）';
        }
      }
    } else {
      got = await fetchSH(T);
      if (!got) {
        const em = await emShares();
        if (em && Object.keys(em.sh).length) { got = em.sh; srcNote = '（上交所没给，降级东财）'; }
      }
    }
    if (!got) { log(`  ✗ ${m.mkt} 抓取失败/未发布，本轮不追加`); continue; }

    // 防「数据源还没更新」：新值与最后一天 80% 以上完全相同 → 判定为陈旧快照
    const last = m.d.length - 1;
    let same = 0, tot = 0;
    for (const [code, arr] of Object.entries(m.c)) {
      const v = arr[last];
      if (v && got[code]) { tot++; if (Math.abs(got[code] - v) <= v * 1e-9) same++; }
    }
    if (tot > 50 && same / tot > 0.8) {
      log(`  ✗ ${m.mkt} 新值与 ${m.d[last]} 有 ${(same / tot * 100).toFixed(0)}% 完全相同 → 数据源未更新，跳过`);
      continue;
    }

    const fill = daysBetween(m.d[m.d.length - 1]);
    if (!fill.length) { log(`  ✗ ${m.mkt} 价格库里没有更晚的交易日，不追加`); continue; }
    if (fill.length > 1) {
      log(`  ! ${m.mkt} 断档 ${fill.length - 1} 天（${fill.slice(0, -1).join(' ')}），按 null 补齐以保证轴对齐`);
    }
    m.d.push(...fill);
    const gap = fill.length - 1;
    let filled = 0;
    for (const [code, arr] of Object.entries(m.c)) {
      for (let i = 0; i < gap; i++) arr.push(null);
      if (got[code]) { arr.push(got[code]); filled++; } else arr.push(null);
    }
    // 当天新上市、老表里没有的代码
    for (const [code, v] of Object.entries(got)) {
      if (m.c[code]) continue;
      m.c[code] = new Array(m.d.length).fill(null);
      m.c[code][m.d.length - 1] = v;
      m.n[code] = '';
      filled++;
    }
    m.raw.d = m.d; m.raw.c = m.c; m.raw.n = m.n;
    m.raw.imported = new Date().toISOString();
    if (!DRY) await writeSharesFile(m.mkt === 'SZ' ? SZ_F : SH_F, m.raw);
    log(`  ✓ ${m.mkt} 追加 ${T}：${filled} 只有值（比对 ${tot} 只，与上日相同仅 ${same} 只）${srcNote}`);
  }
}

// ---------------------------------------------------------------- 价格与折算

function openDb() {
  if (!existsSync(DBF)) throw new Error(`找不到 ${DBF}（先跑 data/import_etf.mjs）`);
  const db = new DatabaseSync(DBF, { readOnly: true });
  return db;
}

/** code → [{date, close}]（按日期升序），只取窗口内的。 */
function readPrices(db, fromDate, codes) {
  const rows = db.prepare('SELECT code, date, close FROM etf_daily WHERE date >= ? ORDER BY code, date').all(fromDate);
  const px = new Map();      // code -> Map(date -> close)
  const seq = new Map();     // code -> [date]（升序）
  const want = codes || null;
  for (const r of rows) {
    if (want && !want.has(r.code)) continue;
    if (!(r.close > 0)) continue;
    let m = px.get(r.code);
    if (!m) { m = new Map(); px.set(r.code, m); seq.set(r.code, []); }
    m.set(r.date, r.close);
    seq.get(r.code).push(r.date);
  }
  return { px, seq };
}

/**
 * 折算乘子表：code → Map(份额跳变日 → k)。
 *
 * 两个来源：
 *  1. etf_adjust 的 split 记录。注意它的 date 是**价格跳空日**，而份额在它的
 *     前一个交易日就变了（T 日盘后登记，T+1 才按新净值开盘）。实测 159325：
 *     份额 09-11 翻倍，价格 09-14 才腰斩，表里记的是 09-14。
 *  2. 表外补检：|Δ份额| > 22% 且「份额倍数 × 次日价格跳空 ≈ 1」。
 */
function readSplits(db, seq, sharesByCode, px, dates) {
  const kmap = new Map();
  const put = (code, date, k) => {
    if (!kmap.has(code)) kmap.set(code, new Map());
    kmap.get(code).set(date, k);
  };

  let fromTable = 0;
  const rows = db.prepare("SELECT code, date, step FROM etf_adjust WHERE kind = 'split'").all();
  for (const r of rows) {
    const ds = seq.get(r.code);
    if (!ds || !(r.step > 0) || !sharesByCode.get(r.code)) continue;
    // 找该 code 在跳空日之前最近的一个交易日 = 份额跳变日
    let lo = 0, hi = ds.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ds[mid] < r.date) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0) continue;
    put(r.code, ds[hit], r.step);
    fromTable++;
  }

  // 表外：靠「份额倍数 × 次日价格跳空 ≈ 1」
  let detected = 0, pending = 0;
  for (const [code, arr] of sharesByCode) {
    const pm = px.get(code);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      if (!a || !b) continue;
      const r = b / a;
      if (Math.abs(r - 1) <= 0.22) continue;
      if (kmap.get(code)?.has(dates[i])) continue;
      const p0 = pm?.get(dates[i]), p1 = pm?.get(dates[i + 1]);
      if (!p0 || !p1) { pending++; continue; }
      const m = r * (p1 / p0);
      if (Math.abs(m - 1) < 0.15 && m < 1.25) { put(code, dates[i], r); detected++; }
    }
  }
  return { kmap, fromTable, detected, pending };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'dist/manifest.json'), 'utf8'));
  log(`清单交易日 ${manifest.last_trade_date}，${manifest.items.length} 只`);

  /* manifest 的 last_trade_date 是 compute.py 写的，它一旦中途失败就停在旧日期。
     而份额轴该跟「行情实际到哪天」走：K 线已经到 T、份额还停在 T-1，等于白抓
     一天，且深市那一天再也补不回来。取二者较大的，日志里说清楚是从哪来的。 */
  try {
    const dbLast = openDb().prepare('SELECT MAX(date) AS d FROM etf_daily').get().d;
    if (dbLast && dbLast > (manifest.last_trade_date || '')) {
      log(`  价格库已到 ${dbLast}，比 manifest 新 → 按 ${dbLast} 追加份额`);
      manifest.last_trade_date = dbLast;
    }
  } catch (e) { log(`  ! 读价格库失败（${e.message}），仍按 manifest 的日期`); }

  if (flag('fetch')) await fetchAppend(manifest);

  log('\n[1/5] 载入份额');
  const files = await loadShares();

  // 统一日期轴（并集，升序）
  const dateSet = new Set();
  for (const f of files) for (const d of f.d) dateSet.add(d);
  const dates = [...dateSet].sort();
  log(`  轴：${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  // code → 份额数组（对齐轴）
  const shares = new Map();
  const names = new Map();
  for (const f of files) {
    const idx = new Map(f.d.map((d, i) => [d, i]));
    for (const [code, arr] of Object.entries(f.c)) {
      const al = dates.map((d) => { const i = idx.get(d); return i === undefined ? null : arr[i]; });
      if (shares.has(code)) {                       // 两市同名代码不可能，防御一下
        const old = shares.get(code);
        for (let i = 0; i < al.length; i++) if (!old[i]) old[i] = al[i];
      } else shares.set(code, al);
      if (f.n[code]) names.set(code, f.n[code]);
    }
  }
  log(`  份额覆盖 ${shares.size} 只`);

  log('\n[2/5] 读收盘价');
  const db = openDb();
  const { px, seq } = readPrices(db, dates[0], new Set(shares.keys()));
  log(`  有价格的 ${px.size} 只`);

  log('\n[3/5] 识别份额折算');
  const { kmap, fromTable, detected, pending } = readSplits(db, seq, shares, px, dates);
  let kTotal = 0;
  for (const m of kmap.values()) kTotal += m.size;
  log(`  折算事件 ${kTotal} 次（etf_adjust 表内 ${fromTable}，价格反推 ${detected}）`
    + (pending ? `；另有 ${pending} 处份额跳变缺次日价格，暂时分不清是折算还是真实申赎` : ''));

  log('\n[4/5] 计算净流入');
  const vByCode = new Map();
  let noPrice = 0;
  for (const [code, arr] of shares) {
    const pm = px.get(code) || new Map();
    const kk = kmap.get(code);
    const v = new Array(dates.length).fill(null);
    for (let i = 1; i < dates.length; i++) {
      const s0 = arr[i - 1], s1 = arr[i];
      if (!s0 || !s1) continue;
      const p = pm.get(dates[i]);
      if (!p) { noPrice++; continue; }
      const k = kk?.get(dates[i]) ?? 1;
      v[i] = r2(((s1 - s0 * k) * p) / 1e8);
    }
    vByCode.set(code, v);
  }
  log(`  完成（${noPrice} 个「有份额无价格」格，跳过）`);

  // 只保留最近 AX 天
  const ax = dates.slice(-AX);
  const cut = dates.length - ax.length;

  log('\n[5/5] 汇总与写盘');
  const idxMap = JSON.parse(await fs.readFile(path.join(ROOT, 'pipeline/index_map.json'), 'utf8')).map || {};
  const codeIx = new Map();
  const groups = new Map();
  for (const [code, o] of Object.entries(idxMap)) {
    if (!o?.idx) continue;
    codeIx.set(code, o.idx);
    if (!groups.has(o.idx)) groups.set(o.idx, []);
    groups.get(o.idx).push(code);
  }

  // 指数汇总（只用成员 ≥2 的组，单只没有「汇总」可言）
  const ixOut = {};
  let ixGroups = 0;
  for (const [name, members] of groups) {
    if (members.length < 2) continue;
    const v = new Array(ax.length).fill(null);
    let any = false;
    for (let t = 0; t < ax.length; t++) {
      let sum = 0, n = 0;
      for (const c of members) {
        const x = vByCode.get(c)?.[t + cut];
        if (x === null || x === undefined) continue;
        sum += x; n++;
      }
      if (n) { v[t] = r2(sum); any = true; }
    }
    if (!any) continue;
    ixOut[name] = { v, n: members.length };
    ixGroups++;
  }
  log(`  指数汇总 ${ixGroups} 组（共 ${groups.size} 组，单只组不汇总）`);

  if (DRY) {
    const t = dates.length - 1;
    const top = [...vByCode.entries()].filter(([, v]) => v[t] !== null)
      .sort((a, b) => Math.abs(b[1][t]) - Math.abs(a[1][t])).slice(0, 5);
    log(`\n  抽样 ${dates[t]} 净流入 top5：`);
    for (const [c, v] of top) log(`    ${c} ${v[t] > 0 ? '+' : ''}${v[t]} 亿元`);
    return;
  }

  await fs.mkdir(OUT, { recursive: true });

  // 单只
  const t = dates.length - 1;
  const lastC = {}, lastF = {}, codeIxOut = {};
  let wrote = 0;
  for (const [code, vArr] of vByCode) {
    const axV = vArr.slice(cut);
    const kk = kmap.get(code);
    const cv = {};
    if (kk) for (const [d, k] of kk) {
      const i = ax.indexOf(d);
      if (i >= 0) cv[i] = k;
    }
    const s = shares.get(code)?.[t];
    const obj = { ok: 1, c: code, n: names.get(code) || '', s: s ? r2(s / 1e8) : null, v: axV };
    if (Object.keys(cv).length) obj.cv = cv;
    await fs.writeFile(path.join(OUT, `${code}.json`), JSON.stringify(obj));
    if (s) lastC[code] = r2(s / 1e8);
    const f = axV[axV.length - 1];
    if (f !== null && f !== undefined) lastF[code] = f;
    if (codeIx.has(code)) codeIxOut[code] = codeIx.get(code);
    wrote++;
  }

  const last = {
    ok: 1, v: 1, d: dates[t], ax,
    c: lastC, f: lastF, ix: codeIxOut,
  };
  await fs.writeFile(path.join(OUT, 'last.json'), JSON.stringify(last));
  await fs.writeFile(path.join(OUT, 'ix.json'), JSON.stringify({ ok: 1, d: dates[t], ax, ix: ixOut }));

  log(`  写出 ${wrote} 个单只 + last.json + ix.json → ${path.relative(ROOT, OUT)}`);

  // 自检
  const bad = [];
  const warn = [];
  const c510300 = lastC['510300'], f510300 = lastF['510300'];
  /* 末日只有深市、沪市是 null 是**正常**的：上交所那份报表当天往往 18:00 后才发，
     21:00 那轮仍拿不到就留空，次日 sse_hist.py 会按 STAT_DATE 回补（沪市可回查，
     深市不行）。所以这里只提示，不判错——判错会让整条流水线为了一件明天自愈的事红掉。
     2026-11-11 就是这么红的：深市 772 只有了，沪市还没发布。 */
  const nLastC = Object.keys(lastC).length;
  if (nLastC < 1500) {
    warn.push(`末日只有 ${nLastC} 只有份额（另一市场当天未发布），产物不完整，等回补`);
  }
  if (c510300 && (c510300 < 100 || c510300 > 2000)) {
    bad.push(`510300 份额 ${c510300} 亿份，超出 100~2000 的合理区间`);
  }

  const cov = Object.keys(lastF).length / Object.keys(lastC).length;
  if (cov < 0.9) warn.push(`末日净流入只覆盖 ${(cov * 100).toFixed(1)}% 的标的（${Object.keys(lastF).length}/${Object.keys(lastC).length}）——多半是新浪当天 K 线没补全`);

  const hs300 = ixOut['沪深300'];
  if (!hs300) bad.push('ix 里没有沪深300');
  else if (hs300.v.at(-1) === null && nLastC >= 1500) bad.push('沪深300 最新汇总为 null');

  // 汇总自洽：随机两个指数，重算成员和
  for (const name of Object.keys(ixOut).slice(0, 2)) {
    const t2 = ax.length - 1;
    let s = 0;
    for (const c of groups.get(name)) s += (vByCode.get(c)?.[t2 + cut] ?? 0);
    if (Math.abs(r2(s) - ixOut[name].v[t2]) > 0.02) bad.push(`${name} 汇总不自洽：${ixOut[name].v[t2]} vs 重算 ${r2(s)}`);
  }

  // 折算日残留：修正后不该再有「单日净流入 > 30 亿元 且 > 该只规模 60%」的巨值。
  // 两个条件都要：小规模 ETF 的 0.6 亿也能占 60%，那是正常波动；折算漏修的
  // 假值动辄几百亿，绝对额一定兜得住。
  let convBig = 0;
  for (const [code, kk] of kmap) {
    const scale = (lastC[code] || 0) * (px.get(code)?.get(dates[t]) || 0);
    for (const d of kk.keys()) {
      const i = ax.indexOf(d);
      if (i < 0) continue;
      const v = vByCode.get(code)[i + cut];
      if (v !== null && Math.abs(v) > 30 && scale > 0 && Math.abs(v) > scale * 0.6) convBig++;
    }
  }
  if (convBig) warn.push(`${convBig} 个折算日的净流入仍超过该只规模的 60%，可能 k 取错或有叠加申赎`);

  if (bad.length) { log('\n✗ 自检失败：\n  · ' + bad.join('\n  · ')); process.exitCode = 1; }
  else log(`\n✓ 自检通过：510300 ${c510300} 亿份 / 净流入 ${f510300} 亿元；沪深300 汇总 ${hs300.v.at(-1)} 亿元；覆盖率 ${(cov * 100).toFixed(1)}%`);
  if (warn.length) log('⚠ 提醒：\n  · ' + warn.join('\n  · '));

  const all = Object.values(lastF);
  const pos = all.filter((x) => x > 0).length, neg = all.filter((x) => x < 0).length;
  log(`末日 ${dates[t]}：有值 ${all.length} 只，申购 ${pos} / 赎回 ${neg}，合计 ${r2(all.reduce((a, b) => a + b, 0))} 亿元`);
}

await main();
