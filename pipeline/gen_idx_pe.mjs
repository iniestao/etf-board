/**
 * 指数 PE 历史与分位 → dist/idx_pe.json + dist/idxpe/{code}.txt
 * =================================================================
 * 需求：每个 ETF 点开能看到它跟踪指数的估值分位（3 / 5 / 10 年）。
 *
 * ---- 为什么只有 PE，没有 PB ----
 * 免费日频 PB 历史实际上不存在，这一条是逐个源试出来的，不是没找：
 *   中证官网 index-perf   只有 peg（PE）、无 PB，20 年日频 ✔
 *   中证官网 indicator.xls PE1/PE2/股息率1/2，无 PB，且只回 20 个交易日 ✘
 *   国证官网接口          改版后 404 ✘
 *   恒生官网              只有当前值页面 ✘
 *   蛋卷 /\ 雪球          PE+PB 都有，但只覆盖 47 个指数（16% 的 ETF）✘
 * PB 要全量只能靠 Wind / iFinD 终端，那需要在 Windows 上挂客户端，云端拿不到。
 * 所以在公开源前提下，这张表只有 PE 一列。
 *
 * ---- peg 这个字段名是错的 ----
 * 接口里字段叫 peg，值是 13.27 这种量级，不是 PEG 而是 PE-TTM。逐日对比官方
 * 估值表的 PE1（总股本口径）后发现，peg ≈ PE1 × 0.950，比值在 8 个交易日里
 * 稳定在 0.950~0.951 —— 形态完全一致，绝对值系统性低 5%。
 * 结论：**分位不受影响，绝对值不要直接展示**。页面只给分位，曲线纵轴标
 * 「中证 PE-TTM（总股本口径，绝对值较官方表低约 5%）」。
 *
 * ---- 为什么要限速 ----
 * 实测并发拉一千多次会被中证 WAF 拦成 403，之后连正常请求也拒。所以这里
 * 串行骨架 + 小并发（默认 3）+ 每请求间隔，且失败按指数退避重试，不整体重跑。
 * 单指数 11 年响应约 0.6~1.0MB（带 OHLC 等用不上的字段），483 个约 300MB。
 *
 * ---- 为什么原始响应要缓存 ----
 * 抓一轮 8~15 分钟，改分位算法或改输出格式时不该重抓。缓存放
 * /tmp/idxpe_raw/{code}.json.gz，命中直接读；--fresh 才重抓。
 *
 * 用法：
 *   node pipeline/gen_idx_pe.mjs                  # 全量（带缓存）
 *   node pipeline/gen_idx_pe.mjs --only 000300,931787
 *   node pipeline/gen_idx_pe.mjs --fresh          # 忽略缓存
 *   node pipeline/gen_idx_pe.mjs --start 20150101 --conc 3 --gap 260
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = k => argv.includes(k);

const MAP = argOf('--map', 'pipeline/etf_idx_map.json');
const START = argOf('--start', '20150101');     // 11 年，够算 10 年窗口还有余量
const CONC = Number(argOf('--conc', '3'));
const GAP = Number(argOf('--gap', '260'));      // ms，每个请求之间的最小间隔
const RAW = argOf('--raw', '/tmp/idxpe_raw');
const OUT = argOf('--out', 'dist/idx_pe.json');
const CURVE = argOf('--curve', 'dist/idxpe');
const FRESH = has('--fresh');
// 增量：只抓最近 N 天的点，和本地已有曲线合并后重算分位。
// 每日 Actions 用它把 15 分钟压到 3~5 分钟——PE 一天只变一次，没必要每天
// 重下 300MB 的二十年历史。
const DAILY = has('--daily');
const DAYS = Number(argOf('--days', '10'));
const ONLY = (argOf('--only', '') || '').split(',').filter(Boolean);

const END = argOf('--end', new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const URL = (c, start) => `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${c}&startDate=${start || START}&endDate=${END}`;

/** 窗口：按交易日数截，不按自然日。2500 天 ≈ 10 年 */
const WINDOWS = [
  { k: 'p3', days: 730 },
  { k: 'p5', days: 1215 },
  { k: 'p10', days: 2430 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ 抓取 */
function rawPath(code) { return join(RAW, code + '.json.gz'); }

async function fetchOne(code, start = START, attempt = 0) {
  // 缓存只服务全量抓取（本地调试）。增量那几天不值得缓存，也不能缓存——
  // 同一个文件名会盖掉全量那份。
  const useCache = start === START;
  if (useCache && !FRESH && existsSync(rawPath(code))) {
    try { return JSON.parse(gunzipSync(readFileSync(rawPath(code))).toString('utf8')); } catch { /* 坏了就重抓 */ }
  }
  try {
    const r = await fetch(URL(code, start), {
      headers: { 'User-Agent': UA, Referer: 'https://www.csindex.com.cn/' },
      signal: AbortSignal.timeout(90000),
    });
    if (r.status === 403) throw Object.assign(new Error('HTTP 403 (WAF)'), { waf: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (!txt.trim().startsWith('{')) throw new Error('非 JSON 响应: ' + txt.slice(0, 60));
    const data = (JSON.parse(txt).data) || [];
    if (useCache) {
      if (!existsSync(RAW)) mkdirSync(RAW, { recursive: true });
      writeFileSync(rawPath(code), gzipSync(Buffer.from(JSON.stringify(data))));
    }
    return data;
  } catch (e) {
    if (attempt >= 2) throw e;
    const wait = (e.waf ? 20000 : 1500) * Math.pow(2, attempt);
    console.error(`  ${code} ${e.message}，${wait / 1000}s 后重试（第 ${attempt + 1} 次）`);
    await sleep(wait);
    return fetchOne(code, start, attempt + 1);
  }
}

/* ---------------------------------------------------------------- 分位计算 */
/**
 * 分位 = count(PE ≤ 当前) / N，含当日。
 * 用严格小于会普遍低 1~2 个百分点，且对「今天是区间最低」这种情形给 0%，
 * 语义上不如「≤」直观。
 *
 * 有效点只收 PE > 0 的日子：中证对亏损指数会给 0 或空，收进来会把分位拉低。
 * 当前 PE 若为 0/空，分位直接给 null（「当前无 PE 口径」），不拿历史值凑。
 */
function parseRows(rows) {
  return rows
    .map(x => ({ d: String(x.tradeDate || ''), pe: Number(x.peg) }))
    .filter(x => /^\d{8}$/.test(x.d) && Number.isFinite(x.pe) && x.pe > 0)
    .sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** 读本地已有曲线，增量模式要拿它当底座 */
function readCurve(code) {
  const f = join(CURVE, code + '.txt');
  if (!existsSync(f)) return null;
  const out = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const s = line.split('\t');
    if (s.length < 2) continue;
    const v = Number(s[1]);
    if (/^\d{8}$/.test(s[0]) && Number.isFinite(v) && v > 0) out.push({ d: s[0], pe: v });
  }
  return out.length ? out : null;
}

/** 按日期合并：新点覆盖同日旧点（当日数据会随收盘修正） */
function mergeCurve(a, b) {
  const m = new Map();
  for (const p of a) m.set(p.d, p.pe);
  for (const p of b) m.set(p.d, p.pe);
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, pe]) => ({ d, pe }));
}

function dayAgo(n) {
  const t = new Date(Date.now() + 8 * 3600e3 - n * 86400e3);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

function calc(pts) {
  if (!pts.length) return null;
  const cur = pts[pts.length - 1].pe;
  const out = { pe: cur, n: pts.length, f: pts[0].d, l: pts[pts.length - 1].d, pts };
  for (const w of WINDOWS) {
    const seg = pts.length >= w.days ? pts.slice(-w.days) : pts;
    out[w.k] = Math.round((seg.filter(x => x.pe <= cur).length / seg.length) * 1000) / 10;
    out[w.k + 'n'] = seg.length;
  }
  return out;
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  const doc = JSON.parse(readFileSync(MAP, 'utf8'));
  /* 映射文件两份表：idx 是指数 → {简称, 旗下 ETF 只数}，etf 是 ETF → 指数代码。
     后者给前端用（弹窗里只有 ETF 代码），前者决定抓谁、按谁排序。 */
  const mapAll = doc.idx || doc;
  const etf2idx = doc.etf || {};
  let codes = Object.keys(mapAll);
  if (ONLY.length) codes = codes.filter(c => ONLY.includes(c));
  // ETF 只数多的排前面：抓一半断掉时，覆盖的 ETF 数量也是最多的
  codes.sort((a, b) => (mapAll[b].e || 0) - (mapAll[a].e || 0));

  console.error(`指数 ${codes.length} 个，窗口从 ${START} 起，并发 ${CONC}，间隔 ${GAP}ms`);

  // 旧结果先读进来：抓取失败的指数沿用上一版，不让一个 403 把整表打空
  const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { items: [] };
  const oldBy = new Map((old.items || []).map(x => [x.c, x]));

  const items = [];
  const curves = new Map();
  let ok = 0, blank = 0, fail = 0, i = 0;

  async function worker(slot) {
    while (i < codes.length) {
      const code = codes[i++];
      const meta = mapAll[code] || {};
      let rows = null;
      // 增量判断按指数走，不按整体：新上市的指数本地那条本来就只有几百天，
      // 拿「最近 10 天」去合并等于把分位算在 10 天样本上，必须退回全量。
      const oldPts = DAILY ? readCurve(code) : null;
      const inc = !!(DAILY && oldPts && oldPts.length >= 800);
      try {
        rows = await fetchOne(code, inc ? dayAgo(DAYS) : START);
      } catch (e) {
        fail++;
        const prev = oldBy.get(code);
        if (prev) items.push(prev);          // 沿用上一版，标 stale
        console.error(`  ✗ ${code} ${meta.n || ''} — ${e.message}`);
        continue;
      }
      let pts = parseRows(rows || []);
      if (inc) pts = mergeCurve(oldPts, pts);
      const res = calc(pts);
      if (!res) {
        blank++;
        items.push({ c: code, n: meta.n || '', e: meta.e || 0, pe: null, why: 'no-pe' });
        continue;
      }
      ok++;
      curves.set(code, res.pts);
      items.push({
        c: code, n: meta.n || '', e: meta.e || 0,
        pe: Math.round(res.pe * 1000) / 1000,
        p3: res.p3, p5: res.p5, p10: res.p10,
        n3: res.p3n, n5: res.p5n, n10: res.p10n,
        f: res.f, l: res.l,
      });
      if (ok % 25 === 0) console.error(`  进度 ${ok}/${codes.length}（空 ${blank} 失败 ${fail}）`);
      await sleep(GAP);
    }
  }

  await Promise.all(Array.from({ length: CONC }, (_, s) => worker(s)));

  // 未抓到的（--only 模式）保留旧条目，保证汇总表始终是全量
  if (ONLY.length) {
    const got = new Set(items.map(x => x.c));
    for (const x of old.items || []) if (!got.has(x.c)) items.push(x);
  }
  items.sort((a, b) => (b.e || 0) - (a.e || 0) || a.c.localeCompare(b.c));

  const d = items.map(x => x.l).filter(Boolean).sort().pop() || '';
  // ETF → 指数 的反查表也放进来：前端在弹窗里只知道 ETF 代码，要先换到指数
  // 代码才能取曲线。1744 条约 35KB，和汇总表一起发，不必再单独一个文件。
  const etfMap = etf2idx;

  const payload = {
    d, gen: new Date().toISOString().slice(0, 19) + 'Z',
    src: 'csindex index-perf / peg (= PE-TTM 总股本口径)',
    note: '分位 = count(PE ≤ 当前)/样本数，含当日；窗口按交易日 730/1215/2430 截取，不足则按成立以来',
    n: items.length,
    items,
    map: etfMap,
  };
  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload));

  // 曲线：一条指数一个文本文件，每行「交易日\tPE」。不塞进汇总表——324 条曲线
  // 一起下是 5MB，而用户一次只看一条，按需取更合适。
  mkdirSync(CURVE, { recursive: true });
  let bytes = 0;
  for (const [code, pts] of curves) {
    const txt = pts.map(p => p.d + '\t' + p.pe).join('\n') + '\n';
    writeFileSync(join(CURVE, code + '.txt'), txt);
    bytes += txt.length;
  }

  console.error(`\n完成：有 PE ${ok}，无 PE ${blank}，失败 ${fail}；汇总 ${items.length} 条到 ${d}`);
  console.error(`曲线 ${curves.size} 条，${(bytes / 1048576).toFixed(1)}MB → ${CURVE}`);
  console.error(`汇总表 ${(JSON.stringify(payload).length / 1024).toFixed(0)}KB → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
