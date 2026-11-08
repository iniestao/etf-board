import { IDX_GROUPS } from './idx_data.js';
import { MKT_INDS } from './mkt_hist.js';

/**
 * ETF 全市场行情 API —— Cloudflare Worker
 * =========================================
 * 覆盖境内上市全部 ETF（1700+ 只，含跨境/债券/货币/商品）
 *
 * 【CPU 预算约束】
 * Cloudflare Workers 免费版只有 10ms CPU / 请求。实测在 Worker 里
 * JSON.parse 全量(0.6MB) 3.4ms + 分类1717次 10.3ms + 排序 1.2ms ≈ 15ms，
 * 必然触发 1102 错误。因此本 Worker 刻意「零解析」：
 *   - 只把上游 20 页文本拼成一个 JSON 数组字符串直接透传（实测 0.7ms）
 *   - 字段映射、分类、排序、筛选全部交给浏览器（浏览器没有 CPU 限制）
 *
 * 【多源竞速 + 自动降级】
 *   东财 push2delay（带 IOPV/溢价率） vs 新浪 etf_hq_fund（全量稳定）
 *   并发发起，先返回且条数有效的胜出，败者静默丢弃。
 *
 * 路由：
 *   GET  /                    前端页面（带 ETag，需口令）
 *   POST /__auth              口令登录，成功后种 Cookie（唯一免口令的入口）
 *   GET  /__out               退出登录，清 Cookie
 *   GET  /api/all             全市场原始数据（透传）
 *   GET  /api/quote?codes=    自选批量（东财 ulist，失败返回 ok:false）
 *   GET  /api/probe           多源自检
 *   GET  /api/hist?code=      单只历史二进制（R2 透传，需绑定 BUCKET）
 *   GET  /api/watch           读云端自选（需绑定 KV）
 *   POST /api/watch           写云端自选，body {"list":["510300",...]}
 *   GET  /api/status          部署自检：R2/KV 绑定状态、历史数据日期
 *
 * 【访问控制】除 /__auth 外全部需要口令（env.ACCESS_PASS），
 * 细节见下方「访问门禁」一节。没配 ACCESS_PASS 时整站拒绝服务，宁可不给也不裸奔。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TTL = 5;              // 边缘缓存秒数
const EM_TIMEOUT = 2800;    // 东财竞速超时
const SINA_PAGES = 20;      // 1717 只约需 18 页
const MIN_ROWS = 100;       // 认定某源有效的最少条数（防止半页空响应被当成成功）
const GOOD_ROWS = 1500;     // 超过这个数才算「完整快照」，先到可以直接采信
const WAIT_TOTAL = 6000;    // 先到者不完整时，等另一个源的上限

// ---- 全市场快照的三层缓存 ----
// 起因：东财对机房 IP 直接 502，全部压力落到新浪；而新浪 20 页从 Cloudflare
// 出口打过去实测要 43 秒（沙箱侧只要 2 秒），任何「一次请求内拉完」的写法都
// 必然撞超时，页面就整块空白。现在改成：只用缓存回答，刷新放后台。
const ALL_TTL = 60;                 // 边缘缓存有效期（秒）
const ALL_FRESH_MS = 180000;        // KV 快照多久算「新鲜」
// 为什么是 3 分钟而不是 60 秒：16:00 那次线上自检，新浪 20 页 6 秒内就回来了；
// 17:50 再测要 43 秒。中间唯一的变量就是新加的 60 秒轮询把请求量放大了一个量级，
// 撞上游限流。既然自选已经走腾讯 5 秒实时，全市场 3 分钟够用，先把压力降下来。
const ALL_BUDGET = 22000;           // 冷启动时同步等上游的硬上限
const ALL_KV = 'all-last-v1';       // KV 里最近一次成功快照
const ALL_KV_GAP = 2 * 60 * 1000;   // KV 最少间隔 2 分钟写一次（免费额度 1000 写/天，720 次留足余量）
const SINA_ABORT = 9000;            // 新浪单页超时
const SINA_CONC = 6;                // 新浪并发页数（20 个并发会被对端限速）

// ---------------------------------------------------------------- 东财全量
async function emPage(pn) {
  const qs = new URLSearchParams({
    pn: String(pn), pz: '100', po: '1', np: '1',
    ut: 'bd1d9ddb04089700cf9c27f6f7426281',
    fltt: '2', invt: '2', wbp2u: '|0|0|0|web', fid: 'f12',
    fs: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0827',
    fields: 'f2,f3,f6,f8,f10,f12,f14,f15,f16,f17,f18,f441',
  });
  const r = await fetch('https://push2delay.eastmoney.com/api/qt/clist/get?' + qs, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
  });
  if (!r.ok) throw new Error('EM HTTP ' + r.status);
  const j = await r.json();
  const d = j && j.data;
  if (!d || !d.diff) throw new Error('EM empty');
  return { total: d.total || 0, diff: Array.isArray(d.diff) ? d.diff : Object.values(d.diff) };
}

async function fetchEM() {
  const first = await emPage(1);
  if (!first.diff.length) throw new Error('EM no rows');
  const pages = Math.min(Math.ceil((first.total || 100) / 100), 24);
  let all = first.diff;
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        emPage(i + 2).then((x) => x.diff).catch(() => []))
    );
    for (const rs of rest) all = all.concat(rs);
  }
  // 透传格式：{src, ts, n, raw}，raw 为东财原始 diff 数组
  return JSON.stringify({ src: 'eastmoney', n: all.length, raw: all });
}

// ---------------------------------------------------------------- 新浪全量
async function sinaPage(p) {
  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
    + 'Market_Center.getHQNodeData?page=' + p
    + '&num=100&sort=symbol&asc=1&node=etf_hq_fund&symbol=&_s_r_a=page';
  // 单页偶发失败会让总数少 100 只（1717 → 1617），而 1617 仍高于完整性阈值，
  // 于是残缺结果被当成完整快照、静默上线。重试一次的成本远低于此，所以在这里堵住。
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        // 单页必须有超时：没有它，一页卡住会把整次刷新拖到 40 秒以上，
        // 而 Worker 的请求是有墙钟上限的，超了连兜底逻辑都跑不到。
        signal: AbortSignal.timeout(SINA_ABORT),
      });
      if (!r.ok) throw new Error('SINA HTTP ' + r.status);
      const t = (await r.text()).trim();
      // 空页是正常的（末页之后），不重试
      if (!t || t === 'null' || t === '[]') return '';
      return t.slice(1, -1);   // 去掉外层 []
    } catch (e) {
      if (attempt >= 2) throw e;   // 最多 3 次，退避 120/300ms
      await new Promise((res) => setTimeout(res, attempt === 0 ? 120 : 300));
    }
  }
}

/** 并发上限 worker pool：20 页一次性打出去会被对端当成攻击，反而更慢 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      out[k] = await fn(items[k]).catch(() => '');
    }
  });
  await Promise.all(runners);
  return out;
}

async function fetchSina() {
  const pages = Array.from({ length: SINA_PAGES }, (_, i) => i + 1);
  const parts = await mapLimit(pages, SINA_CONC, sinaPage);
  const inner = parts.filter(Boolean).join(',');
  if (!inner) throw new Error('SINA empty');
  // 关键：不做 JSON.parse，直接拼成 {src,...,raw:[...]} 的文本
  return '{"src":"sina","n":' + countRows(inner) + ',"raw":[' + inner + ']}';
}

// 粗略数条数（不算 CPU 大头的 JSON.parse）：每条记录以 '{"symbol"' 开头
function countRows(s) {
  let n = 0, i = 0;
  while ((i = s.indexOf('{"symbol"', i)) !== -1) { n++; i += 9; }
  return n;
}

// ---------------------------------------------------------------- 缓存适配
/**
 * 跨运行时缓存层。
 *   Cloudflare Workers : caches.default（全局默认缓存）
 *   Deno Deploy        : caches.open(name)（只有命名缓存，没有 default）
 * 两者都是 Web Cache API，match/put 语义一致，所以适配一层即可。
 * 都不可用时返回 null，代码退化为「仅进程内 L1 缓存」。
 */
let _cacheP = null;
function getCache() {
  if (typeof caches === 'undefined') return Promise.resolve(null);
  if (!_cacheP) {
    _cacheP = (async () => {
      try {
        if (caches.default) return caches.default;                    // Cloudflare
        if (typeof caches.open === 'function') return await caches.open('etf-board-v1'); // Deno
      } catch (e) { /* 降级到无缓存 */ }
      return null;
    })();
  }
  return _cacheP;
}

// ---------------------------------------------------------------- 竞速
let L1 = { ts: 0, body: null };

async function loadAll() {
  const now = Date.now();
  if (L1.body && now - L1.ts < TTL * 1000) return L1.body;

  // 两个源同时打，不串行——串行会让首屏白等一个源的往返
  const emP = fetchEM().catch(() => null);
  const snP = fetchSina().catch(() => null);

  // 先到者只有在「看起来是完整快照」时才直接采信。
  //
  // 之前只要 >= MIN_ROWS 就先到先赢，结果东财被限流、只回了 600 条时
  // 也能秒杀新浪的 1717 条，页面直接少三分之二标的。机房 IP 下几乎必现。
  // 现在改成：不完整就继续等另一个源，最后取条数多的；都等不到才退而求其次。
  const early = await withTimeout(Promise.race([emP, snP]), EM_TIMEOUT);

  let body = null;
  if (early && rowsOf(early) >= GOOD_ROWS) {
    body = early;
  } else {
    const both = await withTimeout(Promise.all([emP, snP]), WAIT_TOTAL);
    body = pickBest(both) || (rowsOf(early) >= MIN_ROWS ? early : null);
  }

  if (!body) throw new Error('所有行情源均不可用');
  L1 = { ts: now, body };
  return body;
}

// ---------------------------------------------------------------- 全市场：缓存优先
// 快照外层加 ts（毫秒），前端据此显示「数据时间」并判断是不是旧数据。
// 用字符串拼接而不是 JSON.parse：600KB 解析在 Worker 里是实打实的 CPU 开销。
function withMeta(body, ts, stale) {
  return '{' + '"ts":' + ts + (stale ? ',"stale":1' : '') + ',' + body.slice(1);
}
function tsOf(body) {
  const m = /^\{"ts":(\d+)/.exec(body || '');
  return m ? +m[1] : 0;
}

const ALL_CACHE_KEY = 'https://etf.internal/all-v1';

async function kvGetAll(env) {
  try {
    if (!env || !env.WATCH) return null;
    return await env.WATCH.get(ALL_KV);
  } catch (e) { return null; }
}
async function kvPutAll(env, body) {
  try {
    if (env && env.WATCH) await env.WATCH.put(ALL_KV, body);
  } catch (e) { /* KV 写失败不影响本次响应 */ }
}

function allResp(body, stale) {
  return new Response(body, {
    headers: {
      ...CORS,
      'X-All-Stale': stale ? '1' : '0',
      'Cache-Control': 'public, max-age=' + (stale ? 5 : ALL_TTL),
    },
  });
}

/** 后台刷新：拉一次全量，写 KV（限频）和边缘缓存。失败时静默，旧的继续用 */
async function refreshAll(env, cache) {
  const body = await loadAll();
  const ts = Date.now();
  const out = withMeta(body, ts, false);
  const prev = await kvGetAll(env);
  if (!prev || ts - tsOf(prev) > ALL_KV_GAP) await kvPutAll(env, out);
  if (cache) {
    try {
      await cache.put(ALL_CACHE_KEY, new Response(out, {
        headers: { ...CORS, 'Cache-Control': 'public, max-age=' + ALL_TTL },
      }));
    } catch (e) { /* 缓存写入失败不影响主流程 */ }
  }
  return out;
}

async function serveAll(env, ctx) {
  const cache = await getCache();
  const now = Date.now();

  // 1. 边缘缓存：60 秒内的请求直接命中，不打上游
  if (cache) {
    try {
      const hit = await cache.match(ALL_CACHE_KEY);
      if (hit) return hit;
    } catch (e) { /* 缓存不可用时降级 */ }
  }

  // 2. KV 里最近一次成功快照（跨 isolate、跨实例，冷启动也有货）
  const last = await kvGetAll(env);
  const age = last ? now - tsOf(last) : Infinity;

  if (last && age < ALL_FRESH_MS) return allResp(last, false);

  // 3. 有旧数据但过期：先给后台刷新 5 秒的机会，抢到新的就直接给新的；
  //    抢不到（上游慢/挂）立刻回落旧的，绝不让用户为一个 43 秒的上游干等。
  if (last) {
    const job = refreshAll(env, cache).catch(() => null);
    const fresh = await Promise.race([
      job,
      new Promise((res) => setTimeout(() => res(null), 5000)),
    ]);
    if (fresh) return allResp(fresh, false);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    else await job;
    return allResp(withMeta(last, tsOf(last), true), true);
  }

  // 4. 一份都没有（全新部署/首次访问）：只能同步等，但要设上限
  try {
    const body = await withTimeout(refreshAll(env, cache), ALL_BUDGET);
    if (!body) throw new Error('行情源响应超时');
    return allResp(body, false);
  } catch (e) {
    // retry:1 让前端知道「过一会儿重试」比「数据有问题」更准确
    return json({ ok: false, error: String(e.message || e), retry: 1 });
  }
}

// ---------------------------------------------------------------- 板块成交额日档
/* 为什么需要它：板块地图只显示「今天谁强」，回答不了「钱是在进还是在出」。
   要看后者必须跟昨天比，而盘中拿今天的累计额直接比昨天全天，是被时间进度污染的
   ——10:30 的 3 亿跟昨天的 8 亿不是一回事。

   为什么不用分钟线自己算昨日同期：新浪 minline 只有当天（kind=min 无日期参数），
   东财 trends2 在本项目里实测连不通（见 fetchMin 的注释）。没有历史分钟数据，
   「昨日同一时刻」这条路就堵死了。

   所以改用占比口径：板块成交额 ÷ 当日行业板块成交额合计。分子分母同时被时间进度
   放大，比值基本抵消掉。它衡量的不是「放了多大成交量」，而是「钱有多集中在这条线」。

   为什么让前端 POST 存档而不是服务端自己解析：全量快照是 600KB 的原始 JSON，
   在 Worker 里 parse 一次要吃掉不少 CPU；而且板块划分（SEC_DEF 关键词表）在
   page.js 里，服务端再复制一份就会两边漂移。前端算完只 POST 三十几个数字，成本可忽略。
   代价是「当天没人打开页面就缺一天」，5 日均值缺一两天不影响结论。

   2026-11-07 从 v1 升到 v2：板块成员变了（科创半导体/芯片/创新药 这类主题原先
   被 '科创' 前缀判成宽基，整块不进分子），半导体一天差 170 多亿。口径变了，
   旧记录不能混进均值，直接换 key 重新攒。

   同日再升到 v3：板块成交额改成「每个跟踪指数只算代表标的」，不再把同指数
   克隆的成交额相加（克隆倍数 1.1×~2.3×，半导体 39.8%→42.8%）。

   同日再升到 v4：板块从 12 格重划成 16 格（申万骨架 + 港股单列），键不一样了。

   同日再升到 v5：板块分成 A股/港股/跨境 三组，各组独立分母，键改成「组码/板块名」
   （A股和港股都有「医药」「消费」，只用板块名会互相覆盖）。 */

const SEC_DAILY_KEY = 'sec-daily-v6';
const MKT_LAST_KEY = 'mkt-last';   // /api/mkt 最近一次成功的结果，上游挂掉时兜底
const SEC_DAILY_KEEP = 12;

/**
 * 每日板块成交额日档。
 *
 * 曾经只有 KV 一份：前端收盘后打开页面才写一条，「今天没人开页面」就等于没记录。
 * 漏一天，资金箭头就跨两天比；漏几天，箭头直接消失。
 *
 * 现在主来源换成 data 分支的 sec_daily.json——GitHub Actions 每天 16:35 拉完全市场
 * 日线后顺手回算 90 天（pipeline/gen_sec_hist.mjs），不依赖任何人打开页面。
 * KV 退成兜底：Actions 挂了、文件还没发布时，至少还有前端现场记的那几条。
 */
async function loadSecDaily(env) {
  try {
    if (histSource(env)) {
      const a = await readAsset(env, 'sec_daily.json');
      if (a) {
        const j = JSON.parse(await a.text());
        if (j && Array.isArray(j.days) && j.days.length) {
          // 半小时边缘缓存：一天只变一次，没必要每次都穿透到 GitHub
          return json({ ok: true, days: j.days, src: 'data', last: j.last_trade_date }, 1800);
        }
      }
    }
  } catch (e) { /* 源文件读不到，往下走 KV */ }

  try {
    const raw = env && env.WATCH ? await env.WATCH.get(SEC_DAILY_KEY) : null;
    const days = raw ? JSON.parse(raw) : [];
    return json({ ok: true, days: Array.isArray(days) ? days : [], src: 'kv' }, 60);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) });
  }
}

async function saveSecDaily(request, env) {
  if (!env || !env.WATCH) return json({ ok: false, error: 'kv_not_bound' });
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad_json' });
  }
  const d = String((body && body.d) || '');
  const s = body && body.s;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ ok: false, error: 'bad_date' });
  if (!s || typeof s !== 'object' || Array.isArray(s)) return json({ ok: false, error: 'bad_sectors' });

  // 键名与成交额都做一次清洗：这个接口在前端跑，挡不住有人手搓。
  // 上限 64 个：分三组后是 18+8+约 6 格，键名形如「hk/港股互联网」（组码/板块名）。
  const clean = {};
  let n = 0;
  for (const k in s) {
    if (n++ > 64) break;
    const v = +s[k];
    if (!k || !isFinite(v) || v < 0) continue;
    clean[k.slice(0, 20)] = Math.round(v);
  }
  if (!Object.keys(clean).length) return json({ ok: false, error: 'empty' });

  try {
    const prev = await env.WATCH.get(SEC_DAILY_KEY);
    let days = prev ? JSON.parse(prev) : [];
    if (!Array.isArray(days)) days = [];
    // 同一天多次 POST 取最后一次：收盘后成交额只会增不会减，后到的更完整
    days = days.filter((x) => x && x.d !== d);
    const rec = { d, t: String((body && body.t) || '').slice(0, 5), s: clean };
    // 集中度/宽度（千分位）是可选的：老客户端不传，也就没有这两个字段，
    // 前端读到缺字段的日档会跳过——四象限的散点云少一个点，不影响别的。
    const cv = Math.round(+body.c), bv = Math.round(+body.b);
    if (isFinite(cv) && cv > 0 && cv <= 1000) rec.c = cv;
    if (isFinite(bv) && bv >= 0 && bv <= 1000) rec.b = bv;
    days.push(rec);
    days.sort((a, b) => (a.d < b.d ? -1 : 1));
    if (days.length > SEC_DAILY_KEEP) days = days.slice(-SEC_DAILY_KEEP);
    await env.WATCH.put(SEC_DAILY_KEY, JSON.stringify(days));
    return json({ ok: true, days: days.length });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) });
  }
}

// 只解析头部元信息，不解析 raw（避免 CPU 开销）
function safeParse(b) {
  if (typeof b !== 'string') return null;
  const m = b.match(/^\{"src":"(\w+)","n":(\d+),"raw":\[/);
  return m ? { src: m[1], n: parseInt(m[2], 10) } : null;
}

/** 给 promise 套一个上限；超时返回 fallback 而不是抛错（这里超时不算异常，只算「没等到」）*/
async function withTimeout(p, ms, fallback = null) {
  let t;
  try {
    return await Promise.race([
      p,
      new Promise((res) => { t = setTimeout(() => res(fallback), ms); }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/** 只看条数，不建对象 */
function rowsOf(b) {
  const j = b ? safeParse(b) : null;
  return j ? j.n : 0;
}

/** 多源候选里挑条数最多的；不足 MIN_ROWS 的一律丢弃 */
function pickBest(list) {
  let best = null, bestN = 0;
  for (const b of list || []) {
    const n = rowsOf(b);
    if (n >= MIN_ROWS && n > bestN) { best = b; bestN = n; }
  }
  return best;
}

// ---------------------------------------------------------------- 自选批量（东财 ulist）
async function fetchQuote(codes) {
  const secids = codes.map((c) => (c[0] === '5' || c[0] === '6' ? '1.' : '0.') + c).join(',');
  const qs = new URLSearchParams({
    secids, ut: 'bd1d9ddb04089700cf9c27f6f7426281', fltt: '2', invt: '2',
    fields: 'f2,f3,f6,f8,f12,f14,f15,f16,f18,f441',
  });
  const r = await fetch('https://push2delay.eastmoney.com/api/qt/ulist.np/get?' + qs, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const d = j && j.data;
  if (!d || !d.diff) throw new Error('empty');
  const diff = Array.isArray(d.diff) ? d.diff : Object.values(d.diff);
  return diff;
}

// ---------------------------------------------------------------- 历史数据源
/**
 * 历史数据有两个落脚点，优先级 R2 > GitHub 仓库：
 *
 *   R2     ：快，但开通要绑卡验身份（额度内不扣费，只是这道门槛）
 *   GitHub ：Actions 把 dist/hist 推到 data 分支，Worker 从 raw 读。
 *            完全免费、零配置，代价是回源慢一点，靠边缘缓存兜住
 *
 * 两者都没有时返回 null，页面把历史面板标成「未启用」，其余功能不受影响。
 */
function histSource(env) {
  if (env && env.BUCKET) return 'r2';
  if (env && env.HIST_BASE) return 'gh';
  return null;
}

/** 抹平 R2Object 与 fetch Response 的差异，只暴露 body / text / etag */
async function readAsset(env, key) {
  if (env && env.BUCKET) {
    const o = await env.BUCKET.get(key);
    if (!o) return null;
    return { body: o.body, text: () => o.text(), etag: o.httpEtag || null };
  }
  // 私有仓库：raw.githubusercontent.com 对匿名请求一律 404，必须走 API 取原始字节。
  // 配了令牌就走这条，没配说明仓库是公开的，走下面的 raw 直连。
  if (env.GITHUB_TOKEN) {
    try {
      const hit = await getViaApi(env, key);
      if (hit !== undefined) return hit;
    } catch (e) { /* 令牌失效或限流，降级到公开路径 */ }
  }

  const base = String(env.HIST_BASE).replace(/\/+$/, '');
  try {
    return await getFrom(base, key);
  } catch (e) {
    // raw.githubusercontent.com 在部分网络下会被阻断。jsDelivr 是同内容镜像，
    // 地址规则不同（gh/{owner}/{repo}@{branch}），能推导出来就自动切一次。
    const mirror = mirrorOf(base);
    if (!mirror) throw e;
    return await getFrom(mirror, key);
  }
}

/**
 * 用 GitHub Contents API 取原始字节。
 *
 * Accept: application/vnd.github.raw 让接口直接返回文件内容，
 * Worker 只做字节透传，不做 base64 解码——否则 36KB 的文件解一遍
 * 就要吃掉几十毫秒 CPU，免费版（10ms）直接超限。
 *
 * 返回 null 表示文件不存在，undefined 表示这条路径不适用（地址推不出 owner/repo）。
 */
async function getViaApi(env, key) {
  const base = String(env.HIST_BASE).replace(/\/+$/, '');
  const m = base.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return undefined;
  const url = 'https://api.github.com/repos/' + m[1] + '/' + m[2]
    + '/contents/' + key + '?ref=' + m[3];
  const r = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'etf-board-worker',
    },
    signal: AbortSignal.timeout(6000),
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub API ' + r.status);
  return { body: r.body, text: () => r.text(), etag: r.headers.get('etag') };
}

async function getFrom(base, key) {
  const r = await fetch(base + '/' + key, {
    // 3 秒还没下来就别等了，交给镜像
    signal: AbortSignal.timeout(3000),
    // 让 Cloudflare 边缘再兜一层，减少对上游的依赖
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (r.status === 404) return null;   // 确实没有这个文件，不用再试镜像
  if (!r.ok) throw new Error('上游 HTTP ' + r.status);
  return { body: r.body, text: () => r.text(), etag: r.headers.get('etag') };
}

/**
 * raw → jsDelivr 的地址换算：
 *   https://raw.githubusercontent.com/owner/repo/data
 *   → https://cdn.jsdelivr.net/gh/owner/repo@data
 * 不是 raw 地址就返回 null（比如用户直接填了 jsDelivr，就不需要再切）。
 */
function mirrorOf(base) {
  const m = base.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return 'https://cdn.jsdelivr.net/gh/' + m[1] + '/' + m[2] + '@' + m[3];
}

// ---------------------------------------------------------------- 历史数据
/**
 * 取单只 ETF 的精简历史二进制。
 *
 * 为什么不在 Worker 里解 Parquet：单只 2.27MB / 165 列，zstd 解压这一步
 * 就会吃掉几百毫秒，而免费版只有 10ms CPU。所以 Actions 侧另导了一份
 * 定长二进制（近 500 天 × 17 字段，约 36KB），Worker 只做原样透传，
 * 解析交给浏览器——那边没有 CPU 配额。
 *
 * 缓存 6 小时：历史数据一天只变一次，没必要每次回源。
 */
async function serveHist(code, env, ctx) {
  if (!histSource(env)) {
    return json({ ok: false, code: 'NO_HIST', error: '未配置历史数据源' });
  }

  const KEY = 'hist-v1/' + code;
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(KEY);
      if (hit) return hit;
    } catch (e) { /* 无缓存继续回源 */ }
  }

  let obj;
  try {
    obj = await readAsset(env, 'hist/' + code + '.bin');
  } catch (e) {
    return json({ ok: false, code: 'HIST_ERR', error: '读取历史数据失败: ' + (e.message || e) });
  }
  if (!obj) return json({ ok: false, code: 'NOT_FOUND', error: '无此标的的历史数据' });

  const h = new Headers();
  if (obj.etag) h.set('ETag', obj.etag);
  h.set('Content-Type', 'application/octet-stream');
  h.set('Cache-Control', 'public, max-age=21600');
  h.set('Access-Control-Allow-Origin', '*');

  const resp = new Response(obj.body, { headers: h });
  if (cache) {
    try {
      const p = cache.put(KEY, resp.clone());
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
      else await p;
    } catch (e) { /* 写缓存失败不影响本次响应 */ }
  }
  return resp;
}

// ---------------------------------------------------------------- 自选同步（KV）
/**
 * 云端自选：一个 key，几 KB。
 *
 * 故意用 PUT 覆盖而不是合并：合并需要知道「删除」意图，只靠并集会
 * 让删掉的自选复活。由前端保证提交的是完整列表。
 */
const WATCH_KEY = 'watch:list';
const WATCH_MAX = 80;

/**
 * 每份自选按 uid 分桶。
 *
 * 一个 key 存所有人意味着：陌生人打开这个网址，看到的是你的自选，
 * 他一按「+」就把你的覆盖掉。uid 由前端生成存在 localStorage，
 * 想把自选带到另一台设备，就把链接加上 ?u=<同步码> 打开。
 */
function watchKey(url) {
  const raw = (url.searchParams.get('u') || 'default');
  const uid = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!uid || uid === 'default') return WATCH_KEY;   // 老链接/无 uid 沿用原有那份
  return WATCH_KEY + ':' + uid;
}

async function serveWatch(request, env) {
  if (!env || !env.WATCH) {
    return json({ ok: false, code: 'NO_KV', error: '未绑定 KV，自选仅存本地' });
  }
  const KEY = watchKey(new URL(request.url));
  if (request.method === 'GET') {
    try {
      // 必须区分「没写过」和「写了空数组」：前者要用本地列表初始化云端，
      // 后者代表用户主动清空了自选，其他设备必须跟着清空。
      // 只返回 list 的话两者都是 []，清空操作会在另一台设备上被"复活"。
      const raw = await env.WATCH.get(KEY);
      let list = [];
      if (raw) {
        try { list = JSON.parse(raw); } catch (e) { list = []; }
      }
      return json({ ok: true, exists: raw != null, list: Array.isArray(list) ? list : [] });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) });
    }
  }
  // POST
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'body 不是合法 JSON' });
  }
  const list = (Array.isArray(body && body.list) ? body.list : [])
    .filter((c) => typeof c === 'string' && /^\d{6}$/.test(c))
    .slice(0, WATCH_MAX);
  try {
    await env.WATCH.put(KEY, JSON.stringify(list));
    return json({ ok: true, n: list.length });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) });
  }
}

/**
 * 当天的因子研究数据（IC 检验 + 样本外回测）。
 *
 * 页面里内嵌的是「部署那一刻的快照」，data 分支上的是每天 Actions 重算的。
 * 这里只负责把远端那份吐出去；拿不到就返回 ok:false，让前端继续用内嵌的——
 * 不把「没数据」包装成错误，页面才不会因为一次请求失败而空掉。
 */
/**
 * 全市场异动快照。
 *
 * 数据由 alpha/events.py 在收盘后算好，跟着 hist 目录发布到 data 分支——
 * 之所以放在 hist/ 下面，是因为发布流水线只整目录复制 dist/hist，
 * 单独复制一个顶层文件要改 workflow，而当前 token 没有 workflow 权限。
 *
 * 26KB，边缘缓存 30 分钟。它一天只变一次，缓存成本可以忽略。
 */
/* ---------------------------------------------------------------- 隔夜行情
   盘前 8:30 打开页面，第一个问题是「隔夜发生了什么、对哪些 A 股 ETF 有影响」。
   这条接口只管行情本身：美股收盘 + 外盘期货，赛道到 ETF 的映射在前端做——
   页面上本来就有 1717 只的名单和 IDX_GROUPS 映射，服务端再解析一份 600KB
   快照纯浪费 CPU，而且映射表跟界面同源，永远不会两边漂移。

   数据源分工（都实测过）：
   - 美股/美股指数：腾讯 qt.gtimg.cn，v_usXXX 一批全量返回。a[3] 现价、
     a[4] 昨收、a[30] 时间、a[32] 涨跌幅%——和 A 股同一套下标，解析函数共用。
     美股此时已收盘，a[1] 就是最近一个完整交易日的收盘价。
   - 外盘期货：东财 push2delay 批量（103.NQ00Y 纳指 / 104.CN00Y A50 /
     101.GC00Y 黄金 / 102.CL00Y 原油），f3 直接就是涨跌幅%，与全量快照同一条
     链路——新浪 hq.sinajs.cn 对部分数据中心出口 IP 直接 403（workbuddy 发布
     平台实测中招），腾讯对 hf_ 返回 200 空体，所以东财当主源，新浪降级备源，
     两边都挂才空，前端隐藏期货行不挡美股主数据。
   - 汇率/夜期恒指这类字段不稳定（fx_ 偶发 403），v1 不接，宁缺毋滥。

   美股收盘时间：美东 16:00 = 北京 04:00（冬令时 05:00）。盘前看这个数，
   看到的就是「昨晚美股收盘」。edge 缓存 10 分钟：期货整夜在动，美股不动。 */
const ON_US_SYMS = ['usNVDA','usAMD','usAVGO','usTSM','usMRVL','usAMAT','usLRCX',
  'usKLAC','usASML','usANET','usCOHR','usCIEN','usLITE','usFN','usMSFT','usGOOG',
  'usAMZN','usMETA','usORCL','usSNOW','usADBE','usCRM','usNOW','usPLTR','usAPP',
  'usVST','usCEG','usTLN','usNRG','usGEV','usAAPL','usDELL','usSMCI','usTSLA',
  'usUBER','usBABA','usJD','usPDD','usBIDU','usNTES','usLLY','usMRK','usAZN',
  'usNVO','usPFE','usNDX','usINX','usDJI'];
/* 亚太行：和美股/期货同一批 ulist 拉回来。A股三大指数 + 恒生科技是「今天正在
   交易」的市场，日经/KOSPI 开盘更早——A股开盘前，它们已经是「今天」的了，
   和隔夜（还没开盘的美股）正好互补。代码来自东财搜索接口：
   MktNum 100 = 全球指数、124 = 港股指数、1/0 = 沪/深 A 股指数。 */
const ON_ASIA_SECIDS = [
  ['1.000001', '上证指数'], ['1.000688', '科创50'], ['0.399006', '创业板指'],
  ['124.HSTECH', '恒生科技'], ['100.N225', '日经225'], ['100.KS11', '韩国KOSPI'],
];

const ON_FUT_SECIDS = [
  ['103.NQ00Y', 'hf_NQ', '纳指期货'],
  ['104.CN00Y', 'hf_CHA50CFD', '富时A50期货'],
  ['101.GC00Y', 'hf_GC', 'COMEX黄金'],
  ['102.CL00Y', 'hf_CL', 'NYMEX原油'],
];

/** 期货主源：东财 push2delay（和全量快照同链路，数据中心出口不被 403） */
/* 东财 ulist 偶发空返回/短超时（实测沙箱与 Worker 都遇到过，一次重试基本必中）。
   这两个函数都是纯读取，重试无害。 */
function emRetry(fn, wait) {
  return fn().catch((e1) => new Promise((res, rej) => setTimeout(() => {
    fn().then(res, (e2) => rej(e2 instanceof Error ? e2 : e1));
  }, wait || 400)));
}

async function fetchFutEm() {
  const qs = ON_FUT_SECIDS.map((x) => x[0]).join(',');
  const r = await fetch('https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
    + '&secids=' + qs + '&fields=f2,f3,f12,f14', {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('FUT(EM) HTTP ' + r.status);
  const j = await r.json();
  const rows = j && j.data && j.data.diff;
  if (!rows || !rows.length) throw new Error('FUT(EM) empty');
  const out = {};
  for (const row of (Array.isArray(rows) ? rows : Object.values(rows))) {
    const hit = ON_FUT_SECIDS.find((x) => x[0].split('.')[1] === row.f12);
    if (!hit || !isFinite(+row.f3)) continue;
    out[hit[1]] = { n: hit[2], p: +row.f2, chg: +row.f3 };
  }
  if (!Object.keys(out).length) throw new Error('FUT(EM) unparseable');
  return out;
}

/** 亚太指数：和期货同一个 ulist 批量接口，一组 secid 一次拿完 */
async function fetchAsia() {
  const qs = ON_ASIA_SECIDS.map((x) => x[0]).join(',');
  const r = await fetch('https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
    + '&secids=' + qs + '&fields=f2,f3,f12,f14', {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('ASIA HTTP ' + r.status);
  const j = await r.json();
  const rows = j && j.data && j.data.diff;
  if (!rows) throw new Error('ASIA empty');
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : Object.values(rows))) {
    const hit = ON_ASIA_SECIDS.find((x) => x[0].split('.')[1] === row.f12);
    if (hit && isFinite(+row.f3)) out.push({ sid: hit[0], n: row.f14 || hit[1], p: +row.f2, chg: +row.f3 });
  }
  // 按配置顺序输出，不给上游排序自由
  out.sort((a, b) => ON_ASIA_SECIDS.findIndex((x) => x[0] === a.sid) - ON_ASIA_SECIDS.findIndex((x) => x[0] === b.sid));
  return out;
}

/** 期货备源：新浪 hf_（f0 现价、f7 昨结算，涨跌基准是昨结算——期货的规矩） */async function fetchFutSina() {
  const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const r = await fetch('https://hq.sinajs.cn/list=' + ON_FUT_SECIDS.map((x) => x[1]).join(','), {
    headers: { 'User-Agent': UA2, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('FUT HTTP ' + r.status);
  const text = new TextDecoder('gbk').decode(await r.arrayBuffer());
  const out = {};
  const re = /var hq_str_(\S+?)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const f = m[2].split(',');
    const p = +f[0], base = +f[7];
    if (!(p > 0) || !(base > 0)) continue;
    const hit = ON_FUT_SECIDS.find((x) => x[1] === m[1]);
    out[m[1]] = { n: hit ? hit[2] : (f[13] || m[1]), p, chg: (p / base - 1) * 100 };
  }
  return out;
}

async function serveOvernight() {
  const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const usP = fetch('https://qt.gtimg.cn/q=' + ON_US_SYMS.join(','), {
    headers: { 'User-Agent': UA2, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(9000),
  }).then(async (r) => {
    if (!r.ok) throw new Error('US HTTP ' + r.status);
    const text = new TextDecoder('gbk').decode(await r.arrayBuffer());
    const out = {};
    const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) {
      const a = m[2].split('~');
      if (a.length < 35 || m[1].slice(0, 2).toLowerCase() !== 'us') continue;
      const p = +a[3], prev = +a[4], chg = +a[32];
      if (!(p > 0) || !isFinite(chg)) continue;    // 上游对不认识的代码返回 200 空壳
      out[m[1].toLowerCase()] = { s: m[1].slice(2).toUpperCase(), n: a[1], p, chg, d: a[30] || '' };
    }
    if (!Object.keys(out).length) throw new Error('US empty');
    return out;
  });

  const futP = emRetry(fetchFutEm)
    .catch(() => fetchFutSina())
    .catch(() => ({}));   // 期货整体失败允许：返回空对象，前端隐藏该行
  const asiaP = emRetry(fetchAsia).catch(() => []);   // 亚太失败同样只缺一行

  const [us, fut, asia] = await Promise.all([usP, futP, asiaP]);
  return json({ ok: true, us, fut, asia, ts: Date.now() }, 600);
}

/* 分时代理：隔夜/亚太条目点开画的线。东财 trends2，ndays=1 取最近一个
   完整交易时段——美股指数/期货拿到的是昨晚那场，亚太拿到的是今天（或最近
   半场）。secid 白名单限定全球/港股指数 + A 股指数 + 外盘期货市场号，
   不给任意转发。 */
/* A 股指数精确白名单：只放行亚太行用到的几个（直接对齐 ON_ASIA_SECIDS，
   防止 6 位数字规则把个股也放进来——个股走 K 线面板，不给任意转发）。 */
const OV_SID_RE = /^(100|101|102|103|104|124)\.[A-Za-z0-9]{1,12}$/;
function isOvSid(sid) {
  return OV_SID_RE.test(sid) || ON_ASIA_SECIDS.some((x) => x[0] === sid);
}

async function serveOvMin(sid, env, ctx) {
  const cache = await getCache();
  const key = new Request('https://etf.internal/ovmin/' + sid, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 降级直连 */ }
  }
  const r = await fetch('https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + sid
    + '&fields1=f1,f2&fields2=f51,f53&iscr=0&ndays=1', {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) return json({ ok: false, error: '分时上游 HTTP ' + r.status });
  const j = await r.json();
  const trends = j && j.data && j.data.trends;
  if (!trends || !trends.length) return json({ ok: false, error: '没有分时数据' });
  const pts = trends.map((s) => {
    const a = s.split(',');
    return [a[0].slice(5, 16), +a[1]];      // '11-06 22:30', 24602.48
  });
  const res = json({ ok: true, sid, pts, ts: Date.now() }, 120);
  if (cache) {
    try { await cache.put(key, res.clone()); } catch (e) { /* 忽略 */ }
  }
  return res;
}

/**
 * 全 A 行业口径的市场结构快照（集中度 × 宽度）。
 *
 * 板块地图上的四象限原本用 ETF 成交额算，那是错的：ETF 池子里只有 18 个行业格，
 * TOP3 天然占一半以上（11-06：58.7%），而全 A 真实的行业集中度只有 24.1%。
 * 更根本的是——ETF 二级市场成交是份额转让、不产生股票成交，半导体 ETF 一天
 * 200 亿和半导体个股一天 2245 亿是两套资金，前者不能代表后者。
 *
 * 口径：东财行业板块列表返回 496 个（含「电子」这种一级和「半导体」这种二级，
 * 直接加总会把同一批股票算两遍）。这里只取 MKT_INDS 里那 128 个扁平行业名——
 * 个股的 f100 就是这套名字，一只股票只归一个行业，所以互不重叠。
 *
 * 4 页 × 100 条，约 0.4 秒。60 秒边缘缓存：盘中不必秒级，收盘后基本不动。
 */
async function serveMkt(env, ctx) {
  const cache = await getCache();
  const key = new Request('https://etf-board.internal/mkt/v1', { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
  }

  // 排序键必须是**不变**的字段。用 fid=f6（成交额）翻页，盘中成交额每秒都在动，
  // 第 2 页可能混进第 1 页已经出现过的板块、又漏掉另一批——实测只捞到 98/128 个行业。
  // f12 是板块代码，天然稳定，5 页 496 条实测零重复零遗漏。
  const CL = 'https://push2.eastmoney.com/api/qt/clist/get?pn=%d&pz=100&po=1&np=1'
    + '&fltt=2&invt=2&fid=f12&fs=m:90+t:2&fields=f12,f14,f3,f6,f104,f105';
  const one = async (pn) => {
    let last;
    for (let k = 0; k < 2; k++) {
      try {
        const r = await fetch(CL.replace('%d', pn), {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          cf: { cacheTtl: 30 }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { last = e; }
    }
    throw last;
  };

  try {
    // 顺序拉，不并发：并发 4 页会被上游断连（socket closed）。
    // 5 页约 0.5 秒，比一次失败的 1.5 秒快。
    const all = [];
    let total = 0;
    for (let pn = 1; pn <= 8; pn++) {
      const j = await one(pn);
      if (!j || !j.data || !j.data.diff) throw new Error('上游无数据 p' + pn);
      total = j.data.total || total;
      all.push(...j.data.diff);
      if (!j.data.diff.length || all.length >= total) break;
    }

    const want = new Set(MKT_INDS);
    const pick = [];
    for (const b of all) if (want.has(b.f14)) pick.push(b);
    if (pick.length < want.size * 0.9) throw new Error('行业匹配不全 ' + pick.length + '/' + want.size);

    let amt = 0, upInd = 0, n = 0, sUp = 0, sDn = 0;
    for (const b of pick) {
      const a = +b.f6 || 0;
      amt += a;
      if (+b.f3 > 0) upInd++;
      if (a > 0) n++;
      sUp += +b.f104 || 0;
      sDn += +b.f105 || 0;
    }
    pick.sort((x, y) => (+y.f6 || 0) - (+x.f6 || 0));
    const top3 = pick.slice(0, 3);
    const t3 = amt > 0 ? top3.reduce((s, b) => s + (+b.f6 || 0), 0) / amt * 100 : 0;

    // 报「行情对应的交易日」，不是「北京今天」。周六早上打开页面，成交额还是周五
    // 收盘的，报成今天会让人以为周末在交易。周末和开盘前一律退到上一个工作日；
    // 盘中（09:15 之后）就是今天。法定节假日识别不了——那天本来就没人看。
    const bj = new Date(Date.now() + 8 * 3600e3);
    const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    const wd = bj.getUTCDay();
    const back = new Date(bj);
    if (wd === 0 || wd === 6 || mins < 9 * 60 + 15) {
      do { back.setUTCDate(back.getUTCDate() - 1); } while (back.getUTCDay() === 0 || back.getUTCDay() === 6);
    }
    const d = back.toISOString().slice(0, 10);
    const t = String(bj.getUTCHours()).padStart(2, '0') + ':' + String(bj.getUTCMinutes()).padStart(2, '0');

    // 宽度的分母是个股，不是行业：128 个行业里 9 个在涨（7.0%）和
    // 716 只个股在涨（13.9%）是同一件事的两个切面，后者才是「有多少票在涨」。
    // sUp/sDn 来自板块的 f104/f105（板块内上涨/下跌家数），128 个行业加总
    // 就是全 A——11-06 实测 716 涨 4431 跌，与逐只个股 K 线回算的 716/4431 完全一致。
    const sDir = sUp + sDn;
    const out = {
      ok: true, d, t,
      inds: want.size, n,
      c: +t3.toFixed(2), b: sDir ? +(sUp / sDir * 100).toFixed(2) : 0,
      up: upInd, top3: top3.map((b) => b.f14),
      amt: +(amt / 1e8).toFixed(0),
      stockUp: sUp, stockDn: sDn, stockN: sDir,
      src: 'eastmoney'
    };

    // 顺带把 250 天的历史也带回去：页面内联的那份是部署时固化的，
    // 一个月不重新发布，「今天」就会飘到散点云外面去。这份由 Actions 每天重写。
    // 读不到就不带，页面继续用内联兜底——不会因此让整张卡片挂掉。
    try {
      if (histSource(env)) {
        const a = await readAsset(env, 'mkt_hist.json');
        if (a) {
          const h = JSON.parse(await a.text());
          if (h && Array.isArray(h.d) && h.d.length >= 60) {
            // t/ind 是「每天的前三大行业」+ 行业名表：点散点时要用它回答
            // 「那天钱压在哪条线」，光两个数字不够。
            out.hist = { d: h.d, c: h.c, b: h.b, n: h.n, u: h.u, w: h.w,
              t3: h.t3 || [], t: h.t, ind: h.ind, p5: h.p5 };
          }
        }
      }
    } catch (e) { /* 历史读不到，只有今天这个点 */ }
    const res = json(out, 60);
    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    }
    // 留一份最近成功的快照。东财的板块接口限流比 ETF 行情狠，连续翻几页就可能被断，
    // 失败时退回「几小时前的那份」，比让卡片掉回基线（可能是好几天前）强得多。
    if (env && env.WATCH) {
      const keep = { ...out };
      delete keep.hist;
      const put = env.WATCH.put(MKT_LAST_KEY, JSON.stringify(keep), { expirationTtl: 259200 });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.resolve(put).catch(() => {}));
      else await put.catch(() => {});
    }
    return res;
  } catch (e) {
    // 上游挂了：先看有没有最近成功的快照，没有才报错
    try {
      if (env && env.WATCH) {
        const raw = await env.WATCH.get(MKT_LAST_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved && saved.c > 0) {
            return json({ ...saved, ok: true, stale: true, src: 'kv' }, 60);
          }
        }
      }
    } catch (e2) { /* KV 也读不到，往下报错 */ }
    return json({ ok: false, error: String((e && e.message) || e) });
  }
}

async function serveEvents(env, ctx) {
  if (!histSource(env)) {
    return json({ ok: false, code: 'NO_SOURCE', error: '未配置历史数据源' });
  }
  // 走 getCache() 而不是直接取 caches.default：Node/容器里根本没有 caches 这个全局，
  // 硬引用会让整个接口 500（沙箱版实测踩过）。没有缓存层时退化为每次读源文件。
  const cache = await getCache();
  const key = new Request('https://etf-board.internal/events/v1', { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
  }

  try {
    const a = await readAsset(env, 'hist/events.json');
    if (!a) return json({ ok: false, code: 'NOT_FOUND', error: '还没有异动快照' });
    const txt = await a.text();
    const res = new Response(txt, {
      headers: {
        ...CORS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
      },
    });
    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(cache.put(key, res.clone())); } catch (e) { /* 忽略 */ }
    }
    return res;
  } catch (e) {
    return json({ ok: false, code: 'FETCH_ERR', error: String(e.message || e) });
  }
}

// ---------------------------------------------------------------- 日内分时
/**
 * 分时走新浪 minline：一次一天，含价格 / 均价 / 分钟量，约 14KB。
 *
 * 为什么不用东财 trends2（更「正宗」的行情接口）：实测裸域名
 * push2his.eastmoney.com、push2.eastmoney.com 都在 TLS 握手完成后直接空回复，
 * 沙箱和 Worker 两侧表现一致；分片域名 1./60.push2his 时好时坏，几十秒内
 * 打几次就整体失灵。新浪这条与全量快照同源（probe 里 1718 只稳定返回），
 * 链路风险最低——分时是高频调用的接口，不能压在一个会抽的源上。
 *
 * 返回紧凑数组：[时刻, 价, 均价, 分钟量]。240 个点用数组比对象数组省一半字节。
 */
async function fetchMin(code) {
  const sym = (code[0] === '5' || code[0] === '6' ? 'sh' : 'sz') + code;
  const url = 'https://quotes.sina.cn/cn/api/openapi.php/CN_MinlineService.getMinlineData'
    + '?symbol=' + sym + '&kind=min';
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error('SINA HTTP ' + r.status);
  const j = await r.json();
  const arr = j && j.result && Array.isArray(j.result.data) ? j.result.data : null;
  if (!arr || !arr.length) throw new Error('MIN empty');
  const pts = [];
  for (const x of arr) {
    const t = String(x.m || '').slice(0, 5);
    const p = +x.p;
    if (t.length !== 5 || !isFinite(p) || p <= 0) continue;
    // 09:25 是集合竞价撮合价，横轴上没有它的位置（09:30 那根已经含开盘）
    if (t < '09:30') continue;
    const avg = +x.avg_p;
    const v = +x.v;
    pts.push([t, p, isFinite(avg) && avg > 0 ? avg : 0, isFinite(v) && v > 0 ? v : 0]);
  }
  if (!pts.length) throw new Error('MIN empty');
  return pts;
}

async function serveMin(ctx, code) {
  // 30 秒一桶：盘中够用，且同一桶内多人访问只打一次上游
  const bucket = Math.floor(Date.now() / 30000);
  const key = new Request('https://etf-board.internal/min/v2/' + code + '/' + bucket, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
  }
  try {
    const pts = await fetchMin(code);
    const res = json({ ok: true, code, n: pts.length, pts, src: 'sina' }, 30);
    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(cache.put(key, res.clone())); } catch (e) { /* 忽略 */ }
    }
    return res;
  } catch (e) {
    return json({ ok: false, code, error: String(e.message || e) });
  }
}

/* ---------------------------------------------------------------- ETF 成分股穿透
   「ETF 涨了 1%，是哪几只权重股拉的？」——只看 ETF 自己的涨跌幅回答不了。

   数据分两段，来源不同、更新频率也差很远，必须分开缓存：

   1) 成分与权重：天天基金「基金档案 → 股票投资明细」，季报口径。宽基通常给到
      前 40 大、行业 ETF 前 20 上下、跨境前 10。**不是全部持仓**——季报只强制
      披露前十大，更全的要等半年报/年报或交易所每日 PCF 清单（PCF 是 XML，
      按日更新，解析成本高，暂时没接）。所以界面上必须写清「前 N 大 · 合计 x%」，
      否则用户会以为剩下的仓位不存在，把「前十大贡献 0.3%，ETF 涨 1%」当成算错。
      季报三个月才变一次，KV 存 3 天没有意义损失。

   2) 实时涨跌幅：hq.sinajs.cn 一次批量，A 股 / 港股 / 美股同一套接口。返回是
      GBK，要靠 TextDecoder('gbk') 解（Cloudflare 和 Node 都支持完整编码表）。
      一次请求带几十只标的，所以这批不吃 Cloudflare 的「每请求 50 个子请求」
      配额——那条限制是**子请求数**，不是标的数。

   权重合计与「其余部分」的贡献是这一栏的重点：前 N 大能解释多少、剩下多少是
   别的原因（其他持仓、折现溢价、现金），一眼分开看，比一个笼统的涨跌幅有用。
*/
const HOLD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOLD_MAX = 60;          // 单次最多拉多少只成分股行情（一只一个代码，不是子请求）
const HOLD_KV_TTL = 3 * 86400;

async function fetchHoldHtml(code) {
  const url = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code='
    + code + '&topline=' + HOLD_MAX;
  const r = await fetch(url, {
    headers: { 'User-Agent': HOLD_UA, Referer: 'https://fundf10.eastmoney.com/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('HOLD HTTP ' + r.status);
  return r.text();
}

/**
 * 解析持仓表。页面里是多期表格纵向排列（本期 + 前几期），只取第一张——
 * 混着取会把同一只票算三四遍，权重瞬间超过 100%。
 *
 * 每行的 secid 藏在行情链接里（/unify/r/0.300308、/unify/r/116.09999），
 * 直接拿来当行情参数，省得自己判断沪/深/港/美。
 */
function parseHoldHtml(html) {
  const i = html.indexOf('<tbody>');
  if (i < 0) return null;
  const j = html.indexOf('</tbody>', i);
  const seg = html.slice(i + 7, j < 0 ? html.length : j);

  const nm = (/<h4[^>]*>[\s\S]*?title='([^']*)'/.exec(html) || [])[1] || '';
  const asof = (/截止至：[^>]*>([\d-]+)</.exec(html) || [])[1] || '';

  const items = [], seen = {};
  const re = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(seg))) {
    const tr = m[1];
    const sec = /\/unify\/r\/(\d+)\.([A-Za-z0-9.]+)/.exec(tr);
    const wm = />\s*([\d.]+)%\s*</.exec(tr);
    if (!sec || !wm) continue;
    // 占比四舍五入到 0.00% 的条目直接丢：它们贡献恒为 0，只会占行高，
    // 还会把「权重合计」的口径和行数搞乱
    if (!(+wm[1] > 0)) continue;
    const c = sec[2].toUpperCase();
    if (seen[c]) continue;
    seen[c] = 1;
    // 第一个 <a> 是代码、第二个是名称，后面还有「股吧 / 行情」两个链接
    const as = [];
    const ar = /<a[^>]*>([^<]*)<\/a>/g;
    let a;
    while ((a = ar.exec(tr))) as.push(a[1].replace(/&nbsp;/g, ' ').trim());
    const name = as.filter((x) => x && x.toUpperCase() !== c && !/^(股吧|行情|资讯)$/.test(x))[0] || '';
    items.push({ s: sec[1] + '.' + sec[2], c, n: name, w: +wm[1] });
  }
  if (!items.length) return null;
  return { name: nm, asof, items };
}

/** 东财 secid → 新浪代码。前缀：0 深、1 沪、116 港股、105/106/107 美股 */
function sinaSymOf(secid) {
  const k = String(secid).split('.');
  if (k.length !== 2) return null;
  const mk = k[0], c = k[1];
  if (mk === '0') return 'sz' + c;
  if (mk === '1') return 'sh' + c;
  if (mk === '116') return 'hk' + c;
  if (mk === '105' || mk === '106' || mk === '107') return 'gb_' + c.toLowerCase();
  return null;                 // 90/128 是 B 股，203 是回购，这类不画
}

/**
 * 单只行情字段是按市场分的，不能用一套下标套三个市场：
 *   A 股  sh600519  → 0 名称 1 今开 2 昨收 3 现价 …
 *   港股  hk00700   → 0 英文名 1 中文名 2 今开 3 昨收 4 高 5 低 6 现价 7 涨跌额 8 涨跌幅%
 *   美股  gb_aapl   → 0 名称 1 现价 2 涨跌幅%
 * 涨跌幅口径也不统一：A 股自己用现价/昨收算，港股美股直接取字段。
 *
 * prev（昨收）是给 PCF 算权重用的：权重 = 股数 × 昨收，和净值同口径。
 * 用现价算也行，但那样权重会跟着当日涨跌漂，同一只票上午和收盘的权重不一样。
 */
function parseHq(sym, raw) {
  if (!raw) return null;
  /* 腾讯用 ~ 分隔、新浪用 , 分隔。同一份代码里两个源都留着（腾讯主、新浪备），
     解析按分隔符自动分派，调用方不用关心这条行情是谁给的。 */
  if (raw.indexOf('~') >= 0) return parseHqTx(raw);
  const f = raw.split(',');
  if (!f.length) return null;
  if (sym.slice(0, 3) === 'gb_') {
    const p = +f[1], chg = +f[2];
    if (!(p > 0) || !isFinite(chg)) return null;
    // 新浪美股不给昨收，从涨跌幅倒推：p / (1 + chg/100)。chg=-100 时无解，交给下面判
    const prev = p / (1 + chg / 100);
    return { p, chg, prev: prev > 0 ? prev : 0 };
  }
  if (sym.slice(0, 2) === 'hk') {
    const p = +f[6], chg = +f[8], prev = +f[3];
    if (!(p > 0) || !isFinite(chg)) return null;
    return { p, chg, prev: prev > 0 ? prev : 0 };
  }
  const p = +f[3], prev = +f[2];
  if (!(p > 0) || !(prev > 0)) return null;
  return { p, chg: (p / prev - 1) * 100, prev };
}

/**
 * 腾讯行情串 → 和 parseHq 同一套结构。
 *
 * 字段（v_sz000001="51~平安银行~000001~11.60~11.64~11.62~…~-0.04~-0.34~…"）：
 *   1 名称  3 现价  4 昨收  32 涨跌幅%
 * A 股 / 港股 / 美股**下标完全一致**——这比新浪省事得多（新浪是三套下标：
 * A 股现价在 3、港股在 6、美股在 1，还各有一套涨跌幅口径）。所以腾讯这条
 * 只按一套下标取，不再分市场。
 */
function parseHqTx(raw) {
  const f = raw.split('~');
  const p = +f[3], prev = +f[4];
  if (!(p > 0) || !(prev > 0)) return null;
  const c = +f[32];
  const chg = isFinite(c) ? c : (p / prev - 1) * 100;
  return { p, chg, prev };
}

/** 内部代码（sh/sz/hk/gb_）→ 腾讯代码（美股是 us 前缀 + 纯大写） */
function toTxSym(sym) {
  return sym.slice(0, 3) === 'gb_' ? 'us' + sym.slice(3).toUpperCase() : sym;
}

/** 内部代码（sh/sz/hk/gb_）→ 新浪代码 */
function toSinaSym(sym) {
  return sym.slice(0, 2) === 'us' ? 'gb_' + sym.slice(2).toLowerCase() : sym;
}

/**
 * 腾讯批量行情。返回 { 内部代码: 原始串 }。
 *
 * 为什么拿它当主源：hq.sinajs.cn 对云端出口 IP 有随机风控，实测同一批代码
 * 连测 6 次，403 出现 2~3 次，且**与批量大小无关**（30 只和 279 只一样会 403）。
 * 也就是说失败不是「请求太大」，重试一次只有 4 成概率撞回来；一只 300 成分的
 * 宽基 ETF 只要这一批失手，整张成分表就变成「有持仓、零行情」。
 * qt.gtimg.cn 同样的代码连测 24 次（60/120/200/279 只各 6 次）零失败。
 */
async function fetchHqTx(syms) {
  if (!syms.length) return {};
  const r = await fetch('https://qt.gtimg.cn/q=' + syms.map(toTxSym).join(','), {
    headers: { 'User-Agent': HOLD_UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('HQ(tx) HTTP ' + r.status);
  const text = new TextDecoder('gbk').decode(await r.arrayBuffer());
  const out = {};
  const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    // 键换回内部代码，下游一律按 sym 取值，不关心上游是谁
    const sym = toSinaSym(m[1]);
    if (m[2]) out[sym] = m[2];
  }
  if (!Object.keys(out).length) throw new Error('HQ(tx) empty');
  return out;
}

/** 新浪批量行情（备用源）。腾讯那条挂了才走这里。 */
async function fetchHqSina(syms) {
  if (!syms.length) return {};
  const r = await fetch('https://hq.sinajs.cn/list=' + syms.join(','), {
    headers: { 'User-Agent': HOLD_UA, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('HQ HTTP ' + r.status);
  const text = new TextDecoder('gbk').decode(await r.arrayBuffer());
  const out = {};
  const re = /var hq_str_(\S+?)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  /* 新浪这条链路会偶发「HTTP 200 但正文是 Forbidden / 空」——只解出 0 条却
     不报错，前端就拿不到任何涨跌幅。这里当失败抛出，交给上层重试。 */
  if (!Object.keys(out).length) throw new Error('HQ empty');
  return out;
}

/**
 * 一次批量行情：腾讯 3 次（退避）→ 新浪 2 次兜底。
 *
 * 重试次数为什么从 1 提到 3：新浪 403 是随机风控，不是请求有问题，多打两次
 * 就回来了；而这一批失手的代价是整张成分表没有涨跌幅，比多一次子请求贵得多。
 */
async function fetchHqRetry(syms) {
  let last = null;
  for (let a = 0; a < 3; a++) {
    try { return await fetchHqTx(syms); } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 180 + a * 320 + Math.random() * 160));
    }
  }
  for (let a = 0; a < 2; a++) {
    try { return await fetchHqSina(syms); } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 + a * 350));
    }
  }
  throw last || new Error('HQ 失败');
}

/* ---------------------------------------------------- 交易所每日 PCF（申购赎回清单）

   季报口径的前 N 大有个硬伤：只强制披露前十大，宽基 ETF 只能解释 26% 的仓位，
   剩下 74% 全塞进「其余」。交易所 PCF 不一样——它是**当日**申购赎回用的完整
   组合：沪深300ETF 给到 301 只、中证500ETF 给到 500 只，每只都带真实股数，
   每天开盘前换一次。用它算出来的权重是持仓权重，不是前十大。

   两家格式完全不兼容，只能分开写：

   上交所 query.sse.com.cn 返回 JSON：
     INSTRUMENT_ID 代码、INSTRUMENT_NAME 名称、QUANTITY 股数、
     UNDERLYION_SECURITY_ID 市场（101 沪 / 102 深 / 103 港 / 9999 其他）

   深交所是一个固定宽度的 GBK 文本（ETF{code}{yyyymmdd}.txt），列靠空格对齐，
   中文占双字节——不能按字符位置切，只能用「代码 + 名称 + 股数 + 现金替代标志」
   这种语义正则抓，再用行尾的「深圳市场/上海市场」判沪深。

   权重不取交易所给的百分比（PCF 里没有），而是 **股数 × 昨收 归一化到 100%**。
   两个好处：省掉一次取净值的请求；汇率自动约掉（跨境 ETF 的分子分母同乘外币
   汇率），纳指 ETF 的美股成分也能算对。停牌股拿不到昨收就从分母剔掉，不会把
   剩下的权重算歪。

   已知偏差：PCF 组合 + 现金差额才等于申赎单位净值，所以股票部分归一化到 100%
   会把权重整体放大约百分之零点几。相比季报「只覆盖 26%」，这点偏差无所谓。
*/

const PCF_KV = 'pcf-v3/';
const PCF_TTL = 43200;            // 12 小时：PCF 每天开盘前换一次，盘中不会变
const PCF_MAX_Q = 520;            // 中证500 有 500 只，留点余量

/** 北京时间第 off 天前的 YYYYMMDD（Worker 跑在 UTC，必须自己加 8 小时） */
function cstDay(off) {
  const t = new Date(Date.now() + 8 * 3600e3 - (off || 0) * 86400e3);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 上交所市场码 → 新浪代码。
 *
 * 港股要补前导零：交易所给的 INSTRUMENT_ID 是**去掉前导零**的（石药集团给
 * 「1093」，不是「01093」），直接拼成 hk1093 新浪认不出来，整只 ETF 的成分
 * 就全变成「无行情」。实测 513120 港股创新药 41 只全是四位码。
 */
function symOfSse(mkt, c) {
  if (mkt === '101') return 'sh' + c;
  if (mkt === '102') return 'sz' + c;
  if (mkt === '103') return 'hk' + c.padStart(5, '0');
  /* 9999 是「其他」：美股用纯字母代码，但货币 ETF 的现金替代码 SSXJ 也长这样，
     不排掉的话它会被当成一只美股 gb_ssxj 去查行情，查不到，整只 ETF 就变成
     「有持仓、零行情」的空表。 */
  if (mkt === '9999') {
    if (c === 'SSXJ' || c === 'CASH') return null;
    return /^[A-Z]{1,6}$/.test(c) ? 'gb_' + c.toLowerCase() : null;
  }
  return null;                    // 90/128 B 股、203 回购，不画
}

async function fetchPcfSse(code) {
  const u = 'https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=' + code
    + '&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C';
  const r = await fetch(u, {
    headers: {
      'User-Agent': HOLD_UA, Accept: '*/*',
      Referer: 'https://www.sse.com.cn/disclosure/fund/etflist/detail.shtml?fundid=' + code,
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('PCF HTTP ' + r.status);
  const j = await r.json();
  const list = (j && j.result) || [];
  if (!list.length) throw new Error('PCF 空表');
  const items = [];
  for (const x of list) {
    const c = String(x.INSTRUMENT_ID || '').trim().toUpperCase();
    const q = +String(x.QUANTITY || '0').replace(/,/g, '');
    if (!c || !(q > 0)) continue;
    const sym = symOfSse(String(x.UNDERLYION_SECURITY_ID || '').trim(), c);
    if (!sym) continue;
    items.push({ c, n: (x.INSTRUMENT_NAME || c).trim(), q, sym });
  }
  if (!items.length) throw new Error('PCF 无可交易成分');
  return { ex: 'sse', day: cstDay(), items };
}

/** 解析深交所固定宽度文本里的组合信息段 */
function parsePcfSzseTxt(txt) {
  const items = [];
  // 一行长这样（列间是多空格）：
  // 000001   平安银行   1,600   允许   34.00%   0.00%   0.0000   0.0000   深圳市场
  /* 代码位数按市场分：沪深 6 位、港股 4~6 位、美股是纯字母。
     港股这一列**位数不固定**：同一个交易所的文件，有的写 00700、有的写 100、
     1211、1698（去掉前导零）。之前只写了 (\d{6}|[A-Z]{1,6})，于是 159792 互联网、
     159740 恒生科技、159303 HS医疗这一整类深市港股通 ETF 一行都匹配不上——
     文件明明下下来了（9~23KB），解析出来却是 0 只，界面报「清单里没有可取成分」，
     看起来像交易所没发布。 */
  const re = /^[ \t]*(\d{4,6}|[A-Z]{1,6})[ \t]+(.+?)[ \t]+([\d,]+)[ \t]+(?:允许|必须|禁止)/gm;
  let m;
  while ((m = re.exec(txt))) {
    const c = m[1];
    const q = +m[3].replace(/,/g, '');
    // 159900 是跨市场 ETF 的虚拟券，代表「所有沪市成分的现金替代合计」，不是持仓
    if (!(q > 0) || c === '159900') continue;
    const eol = txt.indexOf('\n', m.index);
    const line = txt.slice(m.index, eol < 0 ? txt.length : eol);
    let sym = null;
    // 用行尾的挂牌市场判沪深：看代码首位靠不住（688/605 是沪、300/301 是深）
    if (line.indexOf('上海市场') >= 0) sym = 'sh' + c;
    else if (line.indexOf('深圳市场') >= 0) sym = 'sz' + c;
    // 港股同样要补前导零（清单里是 00700 这种 5 位，补到 5 位不变）
    else if (line.indexOf('香港市场') >= 0) sym = 'hk' + c.padStart(5, '0');
    else if (/^[A-Z]/.test(c)) sym = 'gb_' + c.toLowerCase();
    if (!sym) continue;
    items.push({ c, n: m[2].trim(), q, sym });
  }
  return items.length ? items : null;
}

/** 深交所清单文件头里的「目标指数代码：399006」——这是唯一一处能白拿到的
 *  跟踪指数（上交所的清单里没有，只能靠基金全称推）。 */
function pcfSzseIndex(txt) {
  const m = String(txt || '').match(/目标指数代码[：:]\s*([0-9A-Za-z]{4,10})/);
  return m ? m[1] : '';
}

async function fetchPcfSzse(code, days) {
  /* 文件按日命名，取不到就往回找 8 天：盘前文件还没生成、周末、长假都取不到。
     每一次尝试是一个子请求，所以上限压到 8——真遇到长假，回退季报也不算错。

     预热时传 days=2：那时候只可能用到「今天」这一份，找不到就说明还没发布，
     回头再试就行，没必要为了长尾的一只把子请求烧掉 8 次。 */
  const maxOff = days > 0 ? days : 8;
  for (let off = 0; off < maxOff; off++) {
    const day = cstDay(off);
    const u = 'https://reportdocs.static.szse.cn/files/text/etf/ETF' + code + day + '.txt';
    let txt = null;
    /* 403 要和 404 分开看：404 是「这一天没有这份文件」，403 是「现在不给」。
       实测同一天同一只，单发 200、五路并发 403（静态文件服务器的并发保护），
       隔一会儿再请求就正常。所以 403/429 在同一天内重试一次，别急着翻页——
       翻到前一天等于把一份昨天的清单当成今天的用。

       重试只在「现场拉」时做（days 省略）：预热一轮 20 只，每只多两次尝试就是
       四十个子请求，直接顶穿 Cloudflare 的五十上限，整轮报废。预热的容错交给
       后面轮次和盘中现场拉。 */
    for (let a = 0; a < 2; a++) {
      let st = 0;
      try {
        const r = await fetch(u, {
          headers: { 'User-Agent': HOLD_UA, Referer: 'https://www.szse.cn/', Accept: '*/*' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) { txt = new TextDecoder('gbk').decode(await r.arrayBuffer()); break; }
        st = r.status;
      } catch (e) { /* 网络抖动，也算一次 */ }
      if ((st !== 403 && st !== 429) || days > 0) break;
      await new Promise((r2) => setTimeout(r2, 400));
    }
    if (!txt) continue;
    const items = parsePcfSzseTxt(txt);
    if (items) return { ex: 'szse', day, items, idx: pcfSzseIndex(txt) };
  }
  throw new Error('深交所 PCF 取不到（今天可能还没发布）');
}

/**
 * 取一只 ETF 的当日 PCF。三级：单片 KV → 分片 KV（每日预热）→ 现场抓。
 * key 里带日期，跨天第一次访问自然失效，不依赖 TTL 的边界。
 */
async function getPcf(code, env) {
  const day = cstDay();
  const KVK = PCF_KV + code + '/' + day;
  try {
    if (env && env.WATCH) {
      const hit = await env.WATCH.get(KVK, 'json');
      if (hit && hit.items && hit.items.length) return hit;
    }
  } catch (e) { /* KV 读失败就走下一级 */ }

  // 每日预热写的是分片（见下面「PCF 预热」），命中就省掉一次现场拉
  try {
    if (env && env.WATCH) {
      const txt = await env.WATCH.get(shardKey(day, code));
      if (txt) {
        const p = pickFromShard(txt, code);
        if (p && p.items && p.items.length) return p;
      }
    }
  } catch (e) { /* 分片读失败当没预热过 */ }

  /* 5 开头是上交所、1 开头（159/158）是深交所。

     上交所这条要重试：并发抓六七只时实测会有一两只「TLS 完成后空回复」，
     单发从来没有过。一次失败就让那只退回季报不值得，重试两次就够了
     （PCF 是幂等 GET，重试没有副作用）。深交所本身就是按日期回溯，自带重试。 */
  let pcf = null;
  if (code.charAt(0) === '5') {
    let lastErr = null;
    for (let a = 0; a < 3; a++) {
      try { pcf = await fetchPcfSse(code); break; } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 + a * 250));
      }
    }
    if (!pcf) throw lastErr || new Error('PCF 失败');
  } else {
    pcf = await fetchPcfSzse(code);
  }
  try {
    if (env && env.WATCH) {
      await env.WATCH.put(KVK, JSON.stringify(pcf), { expirationTtl: PCF_TTL });
    }
  } catch (e) { /* 写不进 KV 不影响本次响应 */ }
  return pcf;
}

/**
 * 一次批量取行情，返回 { sym: {p, prev, chg} }。
 *
 * 分块 + **补抓缺失**：一次 150 只，某块整块失手（上游风控）时只丢这 150 只，
 * 第二轮把这批「没回来的」单独再打一次。这一层很关键——原来的写法是
 * Promise.all 里 catch(() => ({})) 静默吞掉，失败那一块的成分股直接不进
 * rowsFromPcf 的分母，界面照样显示「权重合计 100%」，但其实是把 300 只的
 * 盘子缩成了 150 只、权重全体放大一倍。宁可补抓，也不要这种看起来正常的错表。
 *
 * 剩下的零星缺失（退市、停牌无昨收、美股换代码）属于真没有，不算失败。
 */
async function priceMap(syms) {
  const seen = {}, uniq = [];
  for (const s of syms) if (s && !seen[s]) { seen[s] = 1; uniq.push(s); }

  const slice = (arr, n) => {
    const r = [];
    for (let k = 0; k < arr.length; k += n) r.push(arr.slice(k, k + n));
    return r;
  };

  const q = {};
  const got = await Promise.all(slice(uniq, 150).map((c) => fetchHqRetry(c).catch(() => ({}))));
  for (const g of got) Object.assign(q, g);

  const miss = uniq.filter((s) => !q[s]);
  if (miss.length) {
    for (const c of slice(miss, 100)) {
      try { Object.assign(q, await fetchHqRetry(c)); } catch (e) { /* 认了，下面按命中率兜 */ }
    }
  }

  const res = {};
  for (const s of uniq) {
    const o = parseHq(s, q[s]);
    if (o) res[s] = o;
  }

  /* 命中率低于四成：不是「个别没有」，是行情源这一轮整体不可用。此时返回
     那点残渣会让界面把权重归一化到极少数股票上，涨跌幅看着合理其实全错。
     抛出去让上层明说「行情源暂时不可用」，比给一张假表强。 */
  const n = Object.keys(res).length;
  if (n && n < uniq.length * 0.4) throw new Error('行情源命中率过低 ' + n + '/' + uniq.length);
  return res;
}

/** PCF 成分 + 行情 → 带权重和贡献的明细行 */
function rowsFromPcf(pcf, q) {
  const base = [];
  let sumMv = 0, hit = 0;
  for (const it of pcf.items) {
    const o = q[it.sym];
    // 没有昨收就没法算市值，直接不进分母：宁可少算一只，也不能把权重摊歪
    if (!o || !(o.prev > 0)) continue;
    const mv = it.q * o.prev;
    sumMv += mv;
    base.push([it, o, mv]);
    hit++;
  }
  if (!sumMv) return { rows: [], wsum: 0, hit: 0, ctr: 0 };
  let ctr = 0;
  const rows = base.map(([it, o, mv]) => {
    const w = (mv / sumMv) * 100;
    const c = (w / 100) * o.chg;
    ctr += c;
    return {
      c: it.c, n: it.n, w: +w.toFixed(2),
      p: +o.p.toFixed(3), chg: +o.chg.toFixed(2), ctr: +c.toFixed(3),
    };
  });
  return { rows, wsum: 100, hit, ctr: +ctr.toFixed(3) };
}

/**
 * 成分穿透入口。**PCF 优先，季报兜底**：
 *
 *   PCF  = 当日交易所公布的完整组合，权重是真实持仓比例，合计 100%，
 *          「前 N 大能解释多少」这个问题不再成立（全都解释了）；
 *   季报 = 交易所取不到时的退路（新上市、长假期间文件未生成、跨境品种等），
 *          只有前十大，权重合计二十几个点，界面必须标明口径，否则用户会
 *          把「前十大贡献 0.3%，ETF 涨 1%」当成算错。
 *
 * 两条路的响应都带 src / day 两个字段，前端据此决定表头和脚注怎么写。
 */
async function serveHold(ctx, code, env) {
  let pcf = null, pcfErr = '';
  try {
    pcf = await getPcf(code, env);
  } catch (e) {
    pcfErr = String(e.message || e);
  }
  if (pcf && pcf.items && pcf.items.length) {
    return serveHoldPcf(ctx, code, pcf);
  }
  return serveHoldReport(ctx, code, env, pcfErr);
}

async function serveHoldPcf(ctx, code, pcf) {
  // 行情按 30 秒分桶：和涨速榜同口径，同一桶内多人打开只打一次上游
  const stamp = fpOf(code + '|pcf|' + pcf.ex + pcf.day + '|' + pcf.items.length);
  const bucket = Math.floor(Date.now() / 30000);
  const ck = new Request('https://etf-board.internal/hold2/' + code + '/' + stamp + '/' + bucket, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) return hit;
    } catch (e) { /* 忽略 */ }
  }

  let q = {};
  try {
    q = await priceMap(pcf.items.map((x) => x.sym));
  } catch (e) {
    /* 清单拿到了、行情没拿到——这两件事必须分开说。原来一律报「清单里没有
       可取成分」，于是华泰柏瑞 510300 这种 300 只全 A 股的宽基也会显示
       「黄金/债券/货币类常见，穿透不适用」，把人往错误方向带。 */
    return json({
      ok: false, code, src: 'pcf', day: pcf.day, total: pcf.items.length,
      error: '成分清单已取到（' + pcf.items.length + ' 只），但这一轮成分行情没响应：'
        + String(e.message || e) + '。稍等几秒再点一次。',
    }, 0);
  }
  const r = rowsFromPcf(pcf, q);

  /* 清单有成分、却一条行情都对不上：多半是商品/货币类（清单里只有黄金合约或
     现金替代，代码不在股票行情范围），也可能是上游全挂。别回一张空表让人以为
     是加载中。 */
  if (!r.rows.length) {
    return json({
      ok: false, code, src: 'pcf', day: pcf.day, total: pcf.items.length,
      error: '这只 ETF 的申购赎回清单里没有可取的股票成分（商品 / 境外指数 / 债券类常见），穿透不适用',
    });
  }

  const body = json({
    ok: true, code, src: 'pcf', ex: pcf.ex, day: pcf.day,
    name: '', asof: pcf.day,
    n: r.rows.length, total: pcf.items.length,
    miss: Math.max(0, pcf.items.length - r.rows.length),
    wsum: +r.wsum.toFixed(2), hit: r.hit,
    rows: r.rows, ms: 0,
  }, r.hit > 0 ? 30 : 0);
  if (r.hit > 0 && cache && ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(cache.put(ck, body.clone())); } catch (e) { /* 忽略 */ }
  }
  return body;
}

async function serveHoldReport(ctx, code, env, pcfErr) {
  const KVK = 'hold-v2/' + code;
  let hold = null;
  try {
    if (env && env.WATCH) hold = await env.WATCH.get(KVK, 'json');
  } catch (e) { /* KV 读失败就走现场抓 */ }

  if (!hold || !hold.items || !hold.items.length) {
    try {
      hold = parseHoldHtml(await fetchHoldHtml(code));
    } catch (e) {
      return json({ ok: false, code, error: '持仓读取失败：' + String(e.message || e) });
    }
    if (!hold) {
      return json({ ok: false, code, error: '这只没有股票持仓明细（指数/债券/商品 ETF 常见）' });
    }
    try {
      if (env && env.WATCH) {
        await env.WATCH.put(KVK, JSON.stringify(hold), { expirationTtl: HOLD_KV_TTL });
      }
    } catch (e) { /* 写不进 KV 不影响本次响应 */ }
  }

  const stamp = fpOf(code + '|' + hold.items.length + '|' + hold.asof);
  const bucket = Math.floor(Date.now() / 30000);
  const ck = new Request('https://etf-board.internal/hold/' + code + '/' + stamp + '/' + bucket, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) return hit;
    } catch (e) { /* 忽略 */ }
  }

  const list = hold.items.slice(0, HOLD_MAX);
  const syms = [], pair = [];
  for (const it of list) {
    const sym = sinaSymOf(it.s);
    if (!sym) continue;
    syms.push(sym);
    pair.push([it, sym]);
  }

  /* 走和 PCF 同一条行情链路：腾讯主源 + 新浪兜底 + 缺失补抓。原来这里自己
     分 50 只一批、失败静默吞掉，季报这条路会「有前十大、没有涨跌幅」。 */
  let q = {}, qErr = '';
  try { q = await priceMap(syms); } catch (e) { qErr = String(e.message || e); }

  let wsum = 0, ctr = 0, hit = 0;
  const rows = pair.map(([it, sym]) => {
    const o = q[sym] || null;
    const w = it.w;
    wsum += w;
    // 贡献：权重 × 涨跌幅（百分点）。ETF 涨跌幅 ≈ 各成分贡献之和 + 折溢价
    const c = o ? (w / 100) * o.chg : null;
    if (c != null) { ctr += c; hit++; }
    return { c: it.c, n: it.n || it.c, w: +w.toFixed(2),
      p: o ? +o.p.toFixed(3) : null, chg: o ? +o.chg.toFixed(2) : null,
      ctr: c == null ? null : +c.toFixed(3) };
  });

  /* 行情一只都没拿到时不给缓存：新浪这条链路偶发一次空响应（实测港股那一批
     第一次全空），如果照样缓存 30 秒，用户接下来半分钟看到的都是「权重有、
     涨跌幅没有」，刷新也没用。宁可不缓存，下一次请求重新打上游。 */
  const res = json({
    ok: true, code, src: 'report', name: hold.name || '', asof: hold.asof || '',
    n: rows.length, wsum: +wsum.toFixed(2), hit,
    rows, ms: 0,
    pcfErr: pcfErr ? pcfErr.slice(0, 120) : undefined,
    qErr: qErr ? qErr.slice(0, 160) : undefined,
  }, hit > 0 ? 30 : 0);
  if (hit > 0 && cache && ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(cache.put(ck, res.clone())); } catch (e) { /* 忽略 */ }
  }
  return res;
}

/* ---------------------------------------------------------------- 自选「主要贡献」

   自选表一行一只 ETF，看得到「涨了 0.8%」，看不到「是谁拉的」。这一栏补上：
   每只 ETF 给贡献最大的 3 只成分股。

   为什么按 |贡献| 排而不是按正贡献排：跌的时候想知道的是「谁在砸」，把三只
   涨的票列出来对下跌的 ETF 毫无用处。取绝对值，涨跌两种行情都有信息。

   成本控制：一次最多 10 只 ETF。每只的 PCF 走 KV（当日只抓一次），成分行情
   合并去重后统一批量拉。10 只宽基全量约 5000 条成分，去重后 1000 出头，
   分 4 批就能拉完；PCF 冷启动时 10 只各 1~3 个子请求，加上行情批次仍远低于
   Cloudflare 免费版的 50 上限。
*/
const TOP3_MAX = 10;
const TOP3_K = 3;

async function serveTop3(ctx, codes, env) {
  const pcfs = await Promise.all(codes.map(async (c) => {
    try {
      return [c, await getPcf(c, env)];
    } catch (e) {
      return [c, null];
    }
  }));

  // 先把所有成分代码收齐再统一拉行情：宽基之间重叠极高，分开拉等于打十遍
  const syms = [];
  for (const [, p] of pcfs) {
    if (p) for (const it of p.items) syms.push(it.sym);
  }

  const stamp = fpOf(codes.join(',') + '|' + syms.length);
  const bucket = Math.floor(Date.now() / 60000);   // 1 分钟一桶：这一栏不需要 30 秒精度
  const ck = new Request('https://etf-board.internal/top3/' + stamp + '/' + bucket, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) return hit;
    } catch (e) { /* 忽略 */ }
  }

  const q = await priceMap(syms);
  const rows = {};
  let any = false;
  for (const [c, p] of pcfs) {
    if (!p) { rows[c] = { ok: false }; continue; }
    const r = rowsFromPcf(p, q);
    if (!r.rows.length) { rows[c] = { ok: false }; continue; }
    const items = r.rows.slice()
      .sort((a, b) => Math.abs(b.ctr) - Math.abs(a.ctr))
      .slice(0, TOP3_K)
      .map((x) => ({ n: x.n, c: x.c, w: x.w, chg: x.chg, ctr: x.ctr }));
    rows[c] = { ok: true, day: p.day, n: r.rows.length, ctr: r.ctr, items };
    any = true;
  }

  const body = json({ ok: any, rows }, any ? 60 : 0);
  if (any && cache && ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(cache.put(ck, body.clone())); } catch (e) { /* 忽略 */ }
  }
  return body;
}

/* ---------------------------------------------------------------- PCF 预热

   PCF 每天开盘前换一次、盘中不变——所以盘中每打开一只 ETF 都去交易所现场
   拉一遍是纯浪费：慢（300~900ms）、会失败（上交所并发时偶发空回复），还占
   掉单次请求的子请求预算。改成每天早上按成交额从大到小把当天的清单全量抓一遍
   存进 KV，盘中只读 KV。

   **为什么不是「一只一个 key」**：全市场一千七百多只，而 KV 免费版每天只有
   1000 次写。一只一键 = 1718 次写，第一天就超额，之后就再也写不进去（读没
   问题，但每只都要现场拉，等于白做）。改成「分片」——同族的几十只打进一个
   value，写次数从 1718 降到 247：

       沪市 5xxxxx → 取前 4 位   510300 / 510310 → "5103"
       深市 159xxx → 取前 5 位   159915 / 159919 → "15991"

   深市要更细一位：159xxx 一共 771 只，按 4 位切只有 10 片、每片七八十只，
   一次 cron 要发七八十个子请求，必然撞 50 的上限。

   分片键里带日期，跨天自然失效；读的时候先按单片查（1 次 KV 读），命中就
   在文本里把这一只的 JSON 抠出来——不 JSON.parse 整个分片，免得为一只是 7 只
   的分片付几十毫秒 CPU。

   节奏：Cron 每分钟一轮，每轮处理「尽可能多的完整分片」（约 20~25 只）。
   按跟踪指数归并后约一千只，四十来轮；07:00 开跑，08:00 前铺满一遍，09:30
   开盘时全市场都在 KV 里（归并规则见 groupKeyOf 上面那段，被并掉的非龙头
   走 getPcf 的现场拉）。

   08:35 开跑，跟着交易所的公布时间走：上交所「ETF公告申购赎回清单」栏目交易日
   08:30 统一更新，深交所的静态文件实测每天 08:11–08:12 生成（HTTP Last-Modified）。
   这时候抓到的就是今天的清单，一遍就够。

   万一到点还没换（探 510300 的 TRADING_DAY 还是上一交易日）就先等着不抓——抓了
   也要归零重抓一遍，白烧一倍请求。09:05 还没等到就按昨天的来：交易所 08:30 就该
   换好，超过半小时属于异常，宁可先用旧的也别让盯市空手。
*/
const PCFS_KV = 'pcfsh-v1/';
const PCFW_KV = 'pcfwarm-v1/';
const PCFP_KV = 'pcfpool-v4/';
const PCFS_TTL = 3 * 86400;       // 分片留 3 天：周末回来还能给周五的清单兜个底
const WARM_PER_RUN = 20;          // 每轮至少这么多只（按整片取，允许超出）
const WARM_PROBE = '510300';      // 沪深300ETF：盘前清单发布的风向标

/** 分片键：沪市看前 4 位，深市看前 5 位（见上面为什么） */
function shardOf(code) {
  return code.charAt(0) === '5' ? code.slice(0, 4) : code.slice(0, 5);
}
function shardKey(day, code) {
  return PCFS_KV + day + '/' + shardOf(code);
}

/** 从分片文本里抠出一只的 JSON：定位 → 括号配对（字符串里的括号要跳过） */
function pickFromShard(txt, code) {
  const tag = '"' + code + '":';
  const at = txt.indexOf(tag);
  if (at < 0) return null;
  const s = txt.indexOf('{', at + tag.length);
  if (s < 0) return null;
  let depth = 0, inStr = false;
  for (let j = s; j < txt.length; j++) {
    const c = txt.charCodeAt(j);
    if (inStr) {
      if (c === 92) j++;                    // 转义
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (!depth) {
        try { return JSON.parse(txt.slice(s, j + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/** 上交所某只 ETF 今日的清单交易日；没发布时返回上一个交易日 */
async function pcfTradingDay(code) {
  const u = 'https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=' + code
    + '&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C';
  const r = await fetch(u, {
    headers: {
      'User-Agent': HOLD_UA, Accept: '*/*',
      Referer: 'https://www.sse.com.cn/disclosure/fund/etflist/detail.shtml?fundid=' + code,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('JBXX HTTP ' + r.status);
  const j = await r.json();
  const x = (j && j.result && j.result[0]) || null;
  return (x && String(x.TRADING_DAY || '').trim()) || '';
}

/* 一只指数常有一打 ETF 跟踪：沪深300 有 29 只、中证A500 有 40 只、中证500 有 29 只。
   它们穿透出来的成分几乎一样，全抓一遍等于把同一个答案抄二十遍，一天白烧一千多
   个子请求。所以预热只取每个指数里成交额最大的那只，其余等真被点开时再现场拉
   （getPcf 的三级读取里，「现场拉」那一级本来就是给这种长尾准备的）。

   分组用的是**界面「同指数去重」那份映射**（idx_data.js，天天基金基金档案的
   「跟踪标的」字段，247 组 / 1449 只），不另建一套。理由很直接：预热的目的就是
   让「界面上看得到的那些」点开就有成分，所以「哪个代码属于哪个指数」必须和界面
   是同一个答案。之前去上交所扒 ETF_FULLNAME、去深交所 PCF 文件头攒指数代码，
   等于把同一件事再做一遍，两份映射一旦不一致就会出现「界面显示 A、预热的却是 B」，
   A 点开照样等五秒——这比不预热更糟，因为它看起来像缓存失效。 */
const IX_OF = (() => {
  const m = Object.create(null);
  for (const k in IDX_GROUPS) for (const c of IDX_GROUPS[k]) m[c] = k;
  return m;
})();

/** 预热分组键：映射里有就按指数分，没有的（新上市、货币/债券漏网）各算一组。
 *  不退回简称猜——猜错了会把不同指数并成一个，代价是其中一只永远不预热。 */
function groupKeyOf(code) {
  const ix = IX_OF[code];
  return ix ? 'i:' + ix : '#' + code;
}

/** 当天的预热顺序：每指数一只 → 成交额降序 → 按分片聚拢（片间按片内最大成交额排） */
async function buildWarmPlan(day, env) {
  const got = [];
  const pages = Array.from({ length: 20 }, (_, i) => i + 1);
  const parts = await mapLimit(pages, 4, async (pg) => {
    const u = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
      + 'Market_Center.getHQNodeData?page=' + pg + '&num=100&sort=amount&asc=0'
      + '&node=etf_hq_fund&symbol=&_s_r_a=page';
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('SINA HTTP ' + r.status);
    const t = (await r.text()).trim();
    if (!t || t === 'null' || t === '[]') return [];
    return JSON.parse(t);
  });
  for (const arr of parts) {
    for (const x of arr || []) {
      const c = String(x.code || '').trim();
      if (!/^\d{6}$/.test(c)) continue;
      /* 债券 / 货币 ETF 的申购赎回清单里没有股票成分（只有现金替代和债券），
         抓了也是白抓——实测成交额前十里有一半是这类，一轮二十只就废掉七八个
         子请求。名字里带这些字的一律跳过；真要看它们的成分也没意义，
         穿透算的是「哪只票在拉」，债券基金没有这个答案。

         「自由现金流」「自由现金」是因子策略，名字里的「现金」不是现金管理，
         被误伤过一次——界面上它们明明在，点开却要等五秒现场拉。 */
      const nm = String(x.name || '');
      if (/债|货币|短融|添益|日利|保证金|理财/.test(nm)) continue;
      if (nm.indexOf('现金') >= 0 && !/自由现金|现金流/.test(nm)) continue;
      /* 商品和境外指数也没有股票成分：黄金（518880 那批）、日经 / 东证 / 巴西、
         豆粕、能源化工。实测 400 只成交额榜里这类有 21 只，每只预热要烧 1~3 个
         子请求还必然失败，一轮二十只的预算直接被吃掉一小半。
         注意别按「有色」筛：159980 有色ETF 是商品期货，但 159881 有色50 是股票
         指数，同一个词两种品种，宁可留一只漏网的也不误伤。 */
      if (/黄金|金ETF|上海金|日经|东证|巴西|豆粕|能源化工/.test(nm)) continue;
      got.push({ c, a: +x.amount || 0, m: String(x.name || '') });
    }
  }
  if (!got.length) throw new Error('取不到 ETF 列表');

  /* 同指数只留成交额最大的一只。用 Map 边遍历边比，天然保留最大者，
     顺便记下被并掉的只数，好在 /api/pcfwarm 里对账。 */
  const byCore = new Map();
  let exact = 0;      // 走指数映射分到组的只数（剩下的是映射里没有、各算一组的）
  for (const x of got) {
    const k = groupKeyOf(x.c);
    if (k.charCodeAt(0) === 105) exact++;   // 'i:' 有指数映射、'#' 独立成组
    const cur = byCore.get(k);
    if (!cur || x.a > cur.a) byCore.set(k, x);
  }
  const leaders = [...byCore.values()];
  const dropped = got.length - leaders.length;

  /* 自选无条件进清单：用户天天看的那几十只，不该因为是「同指数里的非龙头」
     而在盘中第一次点开时等一次现场拉。自选取不到不影响主流程。 */
  const amt = new Map(got.map((x) => [x.c, x.a]));
  const keep = new Map(leaders.map((x) => [x.c, x]));
  try {
    if (env && env.WATCH) {
      const raw = await env.WATCH.get(WATCH_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const code = String(c);
          if (/^\d{6}$/.test(code) && !keep.has(code)) keep.set(code, { c: code, a: amt.get(code) || 0, m: '' });
        }
      }
    }
  } catch (e) { /* 自选读失败：这轮就只预热龙头 */ }

  const picked = [...keep.values()];
  const byShard = new Map();
  for (const x of picked) {
    const k = shardOf(x.c);
    if (!byShard.has(k)) byShard.set(k, []);
    byShard.get(k).push(x);
  }
  const groups = [...byShard.values()];
  for (const g of groups) g.sort((a, b) => b.a - a.a);
  groups.sort((a, b) => b[0].a - a[0].a);
  const codes = [];
  for (const g of groups) for (const x of g) codes.push(x.c);
  return { day, n: codes.length, codes, grp: byCore.size, dropped, all: got.length, exact };
}

/** 预热阶段抓一只：上交所重试 2 次，深交所只认今天的文件 */
async function pcfForWarm(code) {
  if (code.charAt(0) !== '5') return fetchPcfSzse(code, 2);
  let last = null;
  for (let a = 0; a < 3; a++) {
    try { return await fetchPcfSse(code); } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150 + a * 200));
    }
  }
  throw last || new Error('PCF 失败');
}

/**
 * 跑一轮预热。返回进度：{ day, i, n, got, wrote, done, wait }
 * 设计成「一轮 = 若干完整分片」，所以每片只写一次，不做 read-modify-write。
 */
async function warmRound(env) {
  if (!env || !env.WATCH) return { ok: false, error: '没有 KV 绑定，预热无从谈起' };
  const day = cstDay();

  let plan = null;
  try { plan = await env.WATCH.get(PCFP_KV + day, 'json'); } catch (e) { /* 重建 */ }
  let built = false;
  if (!plan || !plan.codes || !plan.codes.length) {
    plan = await buildWarmPlan(day, env);
    built = true;
    try {
      await env.WATCH.put(PCFP_KV + day, JSON.stringify(plan), { expirationTtl: PCFS_TTL });
    } catch (e) { /* 写不进就下一轮重建，代价是又拉一次列表 */ }
  }

  let st = null;
  try { st = await env.WATCH.get(PCFW_KV + day, 'json'); } catch (e) { /* 从头开始 */ }
  if (!st || typeof st.i !== 'number' || st.n !== plan.n) {
    st = { i: 0, n: plan.n, ok: 0, fail: 0, t: 0, pday: '', probeAt: 0, refresh: 0 };
  }

  // 建计划这一轮不抓清单：20 页列表已经吃掉不少子请求，再抓二十几只容易撞上限
  if (built) {
    return { ok: true, built: true, day, i: st.i, n: st.n, grp: plan.grp, dropped: plan.dropped, all: plan.all, exact: plan.exact };
  }

  /* 清单日期探测：两个用途——还没开抓时判断要不要等，抓过之后判断要不要归零重抓。

     上交所的成分接口不带日期、深交所的文件按日命名，所以"这份是不是今天的"只能
     问 510300 的基本信息（TRADING_DAY）。8:35 开跑时它应该已经是今天；如果还是
     昨天，说明交易所没换，先等（抓手一轮就白抓一轮）。抓过之后再探到日期变了，
     说明遇上了延迟发布，把游标按回 0 重抓一遍，成交额大的先换成新组合；重抓是
     原地覆盖分片，不会出现半张空表。

     这个诊断接口自己会抽风（实测一半请求回 System Error），所以 5 分钟内只探一次，
     结果连同 probeAt 一起存在状态里跨轮复用。 */
  if (!st.probeAt || Date.now() - st.probeAt > 5 * 60e3) {
    let tday = '';
    for (let a = 0; a < 3; a++) {
      try { tday = await pcfTradingDay(WARM_PROBE); } catch (e) { tday = ''; }
      if (tday === day) break;
      await new Promise((r) => setTimeout(r, 150 + a * 250));
    }
    st.probeAt = Date.now();
    if (tday) {
      if (!st.pday) st.pday = tday;
      else if (tday !== st.pday) {
        st.pday = tday;
        if (st.i > 0) { st.i = 0; st.refresh = (st.refresh || 0) + 1; }
      }
    }

    /* 一只都还没抓、又明确看到交易所还挂着上一交易日的清单：等，别抓。
       8:30 是上交所公布的固定时点，9:05 还没等到就按昨天的来（交易所延迟属于
       异常，这时候让盯市空手比用旧清单更糟）。 */
    const cst = new Date(Date.now() + 8 * 3600e3);
    const hm = cst.getUTCHours() * 100 + cst.getUTCMinutes();
    if (st.i === 0 && st.pday && st.pday !== day && hm < 905) {
      try { await env.WATCH.put(PCFW_KV + day, JSON.stringify(st), { expirationTtl: PCFS_TTL }); } catch (e) { /* 忽略 */ }
      return { ok: true, wait: true, day, sse: st.pday, i: 0, n: plan.n, grp: plan.grp, dropped: plan.dropped, exact: plan.exact };
    }
  }

  if (st.i >= plan.n) {
    try { await env.WATCH.put(PCFW_KV + day, JSON.stringify(st), { expirationTtl: PCFS_TTL }); } catch (e) { /* 忽略 */ }
    return { ok: true, done: true, day, i: st.i, n: st.n, pday: st.pday, refresh: st.refresh, grp: plan.grp, dropped: plan.dropped, exact: plan.exact };
  }

  // 从游标开始，按整片累加到 WARM_PER_RUN 只以上（片不切，保证每片只写一次）
  const from = st.i;
  let to = from;
  while (to < plan.n) {
    const sh = shardOf(plan.codes[to]);
    let end = to;
    while (end + 1 < plan.n && shardOf(plan.codes[end + 1]) === sh) end++;
    to = end + 1;
    if (to - from >= WARM_PER_RUN) break;
  }
  const batch = plan.codes.slice(from, to);

  const res = {};
  let ok = 0, fail = 0;
  await mapLimit(batch, 3, async (code) => {
    try {
      const p = await pcfForWarm(code);
      if (p && p.items && p.items.length) { res[code] = p; ok++; } else fail++;
    } catch (e) { fail++; }
  });

  const shards = {};
  for (const code of Object.keys(res)) {
    const k = shardOf(code);
    (shards[k] = shards[k] || {})[code] = res[code];
  }
  let wrote = 0;
  for (const k of Object.keys(shards)) {
    try {
      await env.WATCH.put(PCFS_KV + day + '/' + k, JSON.stringify(shards[k]), { expirationTtl: PCFS_TTL });
      wrote++;
    } catch (e) { /* 单片写失败，下一轮不会补（游标已过），盘中退回现场拉 */ }
  }

  st = { ...st, i: to, n: plan.n, ok: st.ok + ok, fail: st.fail + fail, t: Date.now() };
  try { await env.WATCH.put(PCFW_KV + day, JSON.stringify(st), { expirationTtl: PCFS_TTL }); } catch (e) { /* 忽略 */ }
  return {
    ok: true, day, i: st.i, n: st.n, got: ok, fail, wrote, done: st.i >= st.n,
    pday: st.pday, refresh: st.refresh, grp: plan.grp, dropped: plan.dropped, all: plan.all, exact: plan.exact,
  };
}

/* ---------------------------------------------------------------- 涨速榜
   一分钟点只有「价格 + 这一分钟的量」，没有涨速字段（东财的 f22 在这台机器
   上 TLS 层就不通，见 README）。所以 3/5 分钟涨速只能自己从分时里回溯算。

   两个口径上的坑，都是收盘数据一眼能看出来的：

   1) 横轴不是等距的。11:30 之后直接跳 13:00，午后第一分钟回溯 3 格会落到
      上午 11:28——那不是「3 分钟涨速」，是把午休的跳空算进来了。所以用
      slot（9:30 起算的交易分钟序号，午休折叠）而不是数组下标来回溯。

   2) 15:00 那一根不是一分钟。14:57–14:59 没有连续竞价数据，收盘集合竞价
      的成交全部记在 15:00 名下，量常是平时一根的 4~10 倍。按 1 分钟算量比
      会凭空多出 10 倍放量，所以它的权重记 4 分钟。 */
function slotOf(t) {
  const h = +t.slice(0, 2), m = +t.slice(3, 5);
  const x = h * 60 + m;
  return x <= 690 ? x - 570 : x - 780 + 120;
}
function weightOf(t) { return t === '15:00' ? 4 : 1; }

/**
 * 当日 09:30 至今的走势，降采样到最多 48 点，**每个点是以今开为基准的涨跌幅（%）**。
 *
 * 给前端画迷你线用——「+0.31%」这个数字看不出是一路缓涨还是最后两笔拉起来，
 * 形状才看得出。原先只取最近 20 分钟，只能看到「刚才这一下」，上午冲高、午后
 * 回落这种全天节奏全被截掉了；改成全天之后，「现在这个位置是从哪儿走过来的」
 * 直接能从线的形状读出来。
 *
 * 为什么传百分比而不是价格：ETF 的价格最小变动单位是 0.001，512000 那种 0.48
 * 元的低价品种，一整天在 0.483–0.486 之间走，只有三个台阶——画在 24 像素高的
 * 框里就是一段阶梯，看不出形状。换成相对今开的百分比，同样的行情能落到 0.01%
 * 的刻度上，而 0.62% 的振幅也就能画出六十多级。顺带还统一了纵向语义：中线永远
 * 是今开，不用每行自己去猜基准价。
 *
 * 采样按点数均分，正好等于按交易分钟均分：分时数据本身就是一分钟一个点、
 * 午休没有点，所以 11:30 到 13:00 之间不会凭空多出一段平线。
 *
 * 只传百分比不传量，40 只 × 48 点约 9KB（gzip 后三成）。
 */
function trailOf(pts) {
  if (!pts.length) return [];
  const base = pts[0][1];
  if (!(base > 0)) return [];
  const pct = (v) => +(((v / base) - 1) * 100).toFixed(2);
  if (pts.length <= 48) return pts.map((x) => pct(x[1]));
  const out = [];
  for (let k = 0; k < 48; k++) out.push(pct(pts[Math.round((k * (pts.length - 1)) / 47)][1]));
  return out;
}

/**
 * @param {Array} pts [[时刻, 价, 均价, 量], ...]（已按时间升序）
 * @param {number} wmin 回看窗口（分钟）
 * @returns {{r:number, q:number, p:number, t:string, sp:number}|null}
 *   r = 区间涨幅%，q = 量比（最近窗口的每分钟量 ÷ 此前 30 分钟的每分钟量），
 *   sp = 实际跨度（分钟）。sp 明显大于 wmin 说明基准点被数据缺口推远了。
 */
function calcSpeed(pts, wmin) {
  const n = pts.length;
  if (n < 4) return null;
  const last = pts[n - 1];
  const sl = slotOf(last[0]);
  let j = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (slotOf(pts[k][0]) <= sl - wmin) { j = k; break; }
  }
  if (j < 0) return null;
  /* 基准点落在上午、终点落在下午 = 这个窗口跨了午休。数值上算得出来（
     11:27 → 13:00 的价差是真实的），但它不是「盘中 3 分钟拉起来」，而是
     把 93 分钟的跳空塞进 3 分钟，还会顺带把午休后的第一波量算成十几倍
     放量（实测 512880 在 13:00 那个点 q=14.9）。比少几行数据糟得多。

     判据必须用原始时刻字符串、不能用 slot：11:30 和 13:00 的 slot 都是
     120（午休折叠），只看 slot 的话 11:27 到 11:30 这段正常窗口会被一起误杀。

     但也不能整段返回 null：那样 13:00 一过整个榜单会空掉三四分钟。折中办
     法是退到午后第一根做基准（等于「午后开盘以来」的涨速），此时 sp 会
     小于窗口，前端按 sp 标 ~ 说明窗口不足。13:00 这个点本身没有可比基准
     （前一根是 11:30），只能空着。 */
  const tj = pts[j][0], tl = last[0];
  if (tj <= '11:30' && tl >= '13:00') {
    j = n - 2;
    if (j < 0 || pts[j][0] <= '11:30') return null;
  }
  const base = pts[j][1];
  if (!(base > 0)) return null;
  const r = (last[1] / base - 1) * 100;

  let num = 0, numW = 0;
  for (let k = j + 1; k < n; k++) { num += pts[k][3]; numW += weightOf(pts[k][0]); }
  const floor = slotOf(pts[j][0]) - 30;
  let den = 0, denW = 0;
  for (let k = j; k >= 0; k--) {
    if (slotOf(pts[k][0]) < floor) break;
    den += pts[k][3]; denW += weightOf(pts[k][0]);
  }
  const q = (numW > 0 && denW > 0 && den > 0) ? (num / numW) / (den / denW) : 0;

  return { r, q, p: last[1], t: last[0], sp: sl - slotOf(pts[j][0]) };
}

/** 稳定的字符串指纹：进缓存 key 用，避免把 40 个代码原样拼进 URL */
function fpOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36) + '_' + s.length;
}

/**
 * 一次算一批标的的 3/5 分钟涨速。
 *
 * 池子由前端挑好再传进来，不在服务端自己筛：服务端要筛就得先把全市场快照
 * 解析一遍，629KB JSON 在免费版 10ms CPU 里根本放不下（现有 /api/all 用
 * 字符串拼接绕开 JSON.parse 就是同一个原因）。前端手里本来就有这份快照。
 *
 * 代码数量硬上限 48：Cloudflare 免费计划每个请求最多 50 个子请求，
 * 留 2 个余量给缓存读写和兜底。沙箱版不受这个限制，但不放宽——
 * 一处代码两个运行时，口径必须一样。
 */
const SPEED_MAX = 48;
async function serveSpeed(ctx, codes) {
  const list = codes.slice(0, SPEED_MAX);
  const stamp = fpOf(list.join(','));
  const bucket = Math.floor(Date.now() / 30000);
  /* v2：pv 从「价格数组」改成了「相对今开的百分比数组」，键里必须带上版本，
     否则部署后最先点开的几个人会撞上 30 秒内的旧缓存，前端按百分比画价格，
     整条线会飞出框外。 */
  const key = new Request('https://etf-board.internal/speed/v2/' + stamp + '/' + bucket, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
  }

  const t0 = Date.now();
  // 并发 16：实测 40 只并发 40 也就 64ms，但新浪对突发连接敏感（全量快照
  // 20 页并发 20 会被限速），这里保守一档，换来的是不会抖。
  const parts = await mapLimit(list, 16, async (c) => {
    try {
      const pts = await fetchMin(c);
      const a = calcSpeed(pts, 3);
      const b = calcSpeed(pts, 5);
      if (!a) return null;
      return { c, p: a.p, r3: +a.r.toFixed(3), r5: b ? +b.r.toFixed(3) : null,
        q3: +a.q.toFixed(2), q5: b ? +b.q.toFixed(2) : null,
        t: a.t, sp: a.sp, pv: trailOf(pts) };
    } catch (e) { return null; }
  });
  const rows = parts.filter(Boolean);
  const res = json({
    ok: true, n: rows.length, ask: list.length,
    ms: Date.now() - t0, rows,
  }, 30);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(cache.put(key, res.clone())); } catch (e) { /* 忽略 */ }
  }
  return res;
}

async function serveResearch(env) {
  if (!histSource(env)) {
    return json({ ok: false, code: 'NO_SOURCE', error: '未配置历史数据源' });
  }
  try {
    const a = await readAsset(env, 'research.json');
    if (!a) return json({ ok: false, code: 'NOT_FOUND', error: 'data 分支还没有 research.json' });
    const txt = await a.text();
    return new Response(txt, {
      headers: {
        ...CORS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
      },
    });
  } catch (e) {
    return json({ ok: false, code: 'FETCH_ERR', error: String(e.message || e) });
  }
}

// ---------------------------------------------------------------- 部署自检
/**
 * 部署完第一件事就是访问 /api/status：它把「R2 绑没绑、KV 绑没绑、
 * 历史数据是哪天的」一次说清，省得去翻日志猜。
 */
async function serveStatus(env) {
  const src = histSource(env);
  const out = {
    ok: true,
    bindings: { r2: src === 'r2', kv: !!(env && env.WATCH), gh: src === 'gh' },
    hist: null,
    watch_n: null,
    quote: null,
  };
  if (src) {
    try {
      const m = await readAsset(env, 'manifest.json');
      if (m) {
        const j = JSON.parse(await m.text());
        out.hist = {
          source: src,
          last_trade_date: j.last_trade_date,
          codes: j.codes,
          format: j.hist && j.hist.format,
          cols: j.hist && j.hist.cols ? j.hist.cols.length : null,
          bytes: j.hist && j.hist.bytes,
        };
      } else {
        out.hist = {
          error: src === 'r2'
            ? 'R2 里没有 manifest.json，Actions 还没跑过？'
            : 'data 分支里没有 manifest.json，Actions 还没跑过？',
        };
      }
    } catch (e) {
      out.hist = { error: String(e.message || e) };
    }
  }
  if (env && env.WATCH) {
    try {
      const v = await env.WATCH.get(WATCH_KEY, 'json');
      out.watch_n = Array.isArray(v) ? v.length : 0;
    } catch (e) { out.watch_n = -1; }
  }
  return json(out);
}

// ---------------------------------------------------------------- 访问门禁
// 为什么做在 Worker 里而不是 Cloudflare Access：
// Access 只能挂在「自定义域名 / 路由」上，对 *.workers.dev 这个默认域名
// 一律不生效——也就是说开了 Access 也照样谁都能打开 workers.dev 地址。
// 想用 Access 就得先有域名并绑上去。没有域名时，唯一可靠的做法是自己守住门口。
//
// 机制：口令存 env.ACCESS_PASS（wrangler secret / Dashboard 变量），
// 绝不写进代码——仓库是 public 的，写进去等于没锁。
// 校验通过后种一个 HttpOnly Cookie，值是 HMAC(口令)，无法伪造；
// 服务端不存会话，所以不需要 KV，也不必担心重启丢失。
// 没登录的人拿不到 HTML，也拿不到任何 /api/* 数据。

const CK = 'etfb';
const CK_SALT = 'etf-board::gate::v1';
const CK_AGE = 60 * 60 * 24 * 365;

const TEE = new TextEncoder();

function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cookie 值由口令单向推导：口令换了，所有人的旧 Cookie 立刻失效。
async function gateToken(pass) {
  const key = await crypto.subtle.importKey(
    'raw', TEE.encode(pass), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, TEE.encode(CK_SALT));
  return b64url(sig).slice(0, 43);
}

// 定长比较，避免按字符提前返回造成的时序侧信道
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function readCookie(header, name) {
  if (!header) return '';
  for (const raw of header.split(';')) {
    const s = raw.trim();
    const i = s.indexOf('=');
    if (i > 0 && s.slice(0, i) === name) return s.slice(i + 1);
  }
  return '';
}

// 只接受站内相对路径，挡住 /__auth?next=https://evil.com 这类开放重定向
function safeNext(n) {
  if (!n || typeof n !== 'string' || n[0] !== '/' || n[1] === '/') return '/';
  if (n.startsWith('/__')) return '/';
  return n.slice(0, 200);
}

// 单 isolate 内的失败计数：挡脚本爆破，够用且零成本。
// isolate 之间不共享，但爆破请求会落到多个 isolate 上，同样会被各拦一道。
const _fail = new Map();
const FAIL_MAX = 6;
const FAIL_WIN = 10 * 60 * 1000;
const FAIL_LOCK = 10 * 60 * 1000;

function ipOf(request) {
  // Cloudflare 一定带 CF-Connecting-IP；沙箱/容器版走反向代理，只有 X-Forwarded-For。
  // 少了这个兜底，Node 下所有请求都会算成同一个 'anon'，失败锁定会互相牵连。
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'anon';
}

function gateLocked(ip) {
  const rec = _fail.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.until && rec.until > now) return Math.ceil((rec.until - now) / 1000);
  if (now - rec.t > FAIL_WIN) { _fail.delete(ip); return 0; }
  return 0;
}

function gateFail(ip) {
  if (_fail.size > 5000) _fail.clear();
  const now = Date.now();
  const rec = _fail.get(ip) || { n: 0, t: now, until: 0 };
  if (now - rec.t > FAIL_WIN) { rec.n = 0; rec.t = now; }
  rec.n++;
  if (rec.n >= FAIL_MAX) { rec.until = now + FAIL_LOCK; rec.n = 0; }
  _fail.set(ip, rec);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function gatePage(next, err) {
  const e = err === 'bad' ? '口令不对，再试一次' : err === 'lock' ? '尝试次数过多，请 10 分钟后再来' : '';
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="color-scheme" content="dark">
<title>需要口令</title>
<style>
:root{--bg:#0f1115;--bg2:#161a21;--line:#262c37;--txt:#e6e9ef;--txt2:#9aa4b2;--txt3:#5f6b7d;--acc:#3b82f6}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:radial-gradient(1000px 600px at 50% -10%,#182030 0%,var(--bg) 55%);
color:var(--txt);display:flex;align-items:center;justify-content:center;padding:20px;
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
-webkit-font-smoothing:antialiased}
.box{width:100%;max-width:340px;background:var(--bg2);border:1px solid var(--line);
border-radius:14px;padding:28px 24px 22px;box-shadow:0 20px 50px -20px #000}
.brand{font-size:15px;font-weight:600;letter-spacing:.5px;margin-bottom:6px}
.brand i{font-style:normal;color:var(--acc)}
.sub{color:var(--txt2);font-size:12.5px;margin-bottom:20px}
input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;
padding:11px 13px;color:var(--txt);font-size:14px;outline:none;transition:.15s}
input:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgb(59 130 246 / 15%)}
button{width:100%;margin-top:12px;background:var(--acc);border:0;border-radius:8px;
padding:11px;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer;transition:.15s}
button:hover{background:#2f74e0}
button:active{transform:translateY(1px)}
.err{color:#f87171;font-size:12px;margin-top:10px;min-height:16px}
.tip{color:var(--txt3);font-size:11px;margin-top:14px;line-height:1.5}
</style></head><body>
<form class="box" method="POST" action="/__auth">
  <div class="brand">ETF<i> · BOARD</i></div>
  <div class="sub">私有面板，请输入访问口令</div>
  <input name="p" type="password" autocomplete="current-password" placeholder="访问口令"
         autofocus required ${err === 'lock' ? 'disabled' : ''}>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit" ${err === 'lock' ? 'disabled' : ''}>进入</button>
  <div class="err">${esc(e)}</div>
  <div class="tip">通过后这台浏览器会记住一年，不必每次输入。</div>
</form></body></html>`;
}

// 口令没配置时既不能放行（等于没锁），也不能只丢一个 500（用户不知道该干嘛）。
// 给一张说明页：不泄露任何行情数据，只告诉你下一步怎么做。
const NO_PASS_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>未配置口令</title>
<style>body{background:#0f1115;color:#e6e9ef;font:14px/1.8 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px}
.b{max-width:460px;background:#161a21;border:1px solid #262c37;border-radius:12px;padding:26px 26px 20px}
h1{font-size:15px;margin:0 0 10px}p{color:#9aa4b2;font-size:13px;margin:0 0 10px}
code{background:#0f1115;border:1px solid #262c37;border-radius:5px;padding:2px 6px;color:#7dd3fc;font-size:12.5px}
</style></head><body><div class="b">
<h1>站点已上锁，但还没设口令</h1>
<p>为防止公开访问，Worker 在没有 <code>ACCESS_PASS</code> 时会拒绝一切请求——包括你自己。</p>
<p>去 Cloudflare Dashboard → Workers → <b>etf-board</b> → Settings → Variables，
新增变量 <code>ACCESS_PASS</code>，值填一串只有你知道的口令，保存后再刷新本页。</p>
<p>命令行等价操作：<code>npx wrangler secret put ACCESS_PASS</code></p>
</div></body></html>`;

const htmlNoStore = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

async function gateCheck(request, env, url) {
  const p = url.pathname;

  // 静态噪音直接吞掉，不必过门禁
  if (p === '/favicon.ico' || p === '/robots.txt') {
    return new Response(null, { status: 204, headers: { 'X-Robots-Tag': 'noindex' } });
  }

  const pass = (env && env.ACCESS_PASS) || '';

  // 退出登录：清 Cookie 回门口
  if (p === '/__out') {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `${CK}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  if (p === '/__auth') {
    if (!pass) return new Response(NO_PASS_PAGE, { status: 503, headers: htmlNoStore });
    const ip = ipOf(request);
    const left = gateLocked(ip);
    if (left) return new Response(gatePage('/', 'lock'), { status: 429, headers: htmlNoStore });

    let form;
    try {
      form = new URLSearchParams(await request.text());
    } catch (e) {
      form = new URLSearchParams();
    }
    const next = safeNext(form.get('next') || '/');

    if (safeEq(form.get('p') || '', pass)) {
      _fail.delete(ip);
      const tok = await gateToken(pass);
      return new Response(null, {
        status: 302,
        headers: {
          Location: next,
          'Set-Cookie': `${CK}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CK_AGE}`,
        },
      });
    }
    gateFail(ip);
    // 失败故意慢半拍，把撞库速度压下来（sleep 只耗墙钟，不耗 10ms CPU 预算）
    await new Promise((r) => setTimeout(r, 600));
    return new Response(gatePage(next, 'bad'), { status: 401, headers: htmlNoStore });
  }

  if (!pass) {
    const h = { ...CORS, 'Cache-Control': 'no-store' };
    return p.startsWith('/api/')
      ? new Response(JSON.stringify({ ok: false, error: 'access_pass_not_configured' }), { status: 503, headers: h })
      : new Response(NO_PASS_PAGE, { status: 503, headers: htmlNoStore });
  }

  const ck = readCookie(request.headers.get('Cookie') || '', CK);
  if (ck && safeEq(ck, await gateToken(pass))) return null;   // 放行

  // 未登录：接口给 JSON，页面给登录框
  if (p.startsWith('/api/')) {
    const h = { ...CORS, 'Cache-Control': 'no-store' };
    // 状态探针留一个不含数据的存活回执，方便外部监控判断「服务活着但在锁着」
    if (p === '/api/status') {
      return new Response(JSON.stringify({ ok: true, locked: true }), { status: 200, headers: h });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized', locked: true }),
      { status: 401, headers: h });
  }
  return new Response(gatePage(url.pathname + url.search, ''), { status: 401, headers: htmlNoStore });
}

// ---------------------------------------------------------------- 路由
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(o, maxAge = 0) {
  const h = { ...CORS };
  if (maxAge) h['Cache-Control'] = 'public, max-age=' + maxAge;
  return new Response(JSON.stringify(o), { headers: h });
}

// 页面 HTML 是模块级常量，部署时内容就固定了。
// 用内容哈希当 ETag：改版后哈希变、浏览器自然拿到新页面；
// 没改就是 304，省掉每次 60KB 的重复下载。
// 惰性求值：build.mjs 打包后 index.js 排在 page.js 前面，
// 顶层直接引用 HTML 会撞上 TDZ（Cannot access 'HTML' before initialization）。
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
let _etag = null;
function htmlEtag() {
  if (_etag === null) _etag = '"' + djb2(HTML) + '"';
  return _etag;
}

// 沙箱版（server/app.mjs）用它做「没有 Cron 时的等价物」，和 Worker 的
// scheduled 走的是同一个函数，不各写一份
export { warmRound };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // 门禁先行：没通过口令的人，下面所有分支都到不了
    const gate = await gateCheck(request, env, url);
    if (gate) return gate;

    // /research 与首页共用同一个 HTML：前端按 pathname 决定是整页因子面板
    // 还是盯盘首页。一份模板，样式和渲染代码不会两边走偏。
    if (p === '/' || p === '/index.html'
        || p === '/research' || p === '/research/' || p === '/r' || p === '/r/') {
      const etag = htmlEtag();
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, Vary: 'Cookie', 'Cache-Control': 'private, no-cache' } });
      }
      return new Response(HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // private + Vary:Cookie —— 防止任何中间缓存把「已登录才有的页面」
          // 回放给没登录的人，把门禁绕过去
          'Cache-Control': 'private, no-cache, must-revalidate',
          Vary: 'Cookie',
          ETag: etag,
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      });
    }

    if (p === '/api/hist') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!/^\d{6}$/.test(code)) return json({ ok: false, error: 'code 需为 6 位数字' });
      return serveHist(code, env, ctx);
    }

    if (p === '/api/watch') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return json({ ok: false, error: '只支持 GET/POST' });
      }
      return serveWatch(request, env);
    }

    if (p === '/api/research') {
      return serveResearch(env);
    }

    if (p === '/api/events') {
      return serveEvents(env, ctx);
    }

    if (p === '/api/status') {
      return serveStatus(env);
    }

    if (p === '/api/all') {
      // 三层：边缘缓存 → KV 最近一次成功 → 现场拉（只在前两者都没有时才等上游）
      return serveAll(env, ctx);
    }

    if (p === '/api/overnight') {
      // 盘前卡：美股收盘 + 外盘期货 + 亚太指数。赛道→ETF 映射在前端用 IDX_GROUPS 做
      return serveOvernight();
    }

    if (p === '/api/ovmin') {
      // 隔夜/亚太条目的日内分时（东财 trends2 代理，secid 白名单）
      const sid = (url.searchParams.get('sid') || '').trim().toUpperCase();
      if (!isOvSid(sid)) return json({ ok: false, error: 'sid 非法' });
      return serveOvMin(sid, env, ctx);
    }

    if (p === '/api/mkt') {
      // 全 A 行业口径的集中度 / 宽度（四象限卡片的当天点）
      return serveMkt(env, ctx);
    }

    if (p === '/api/secdaily') {
      return request.method === 'POST'
        ? saveSecDaily(request, env)
        : loadSecDaily(env);
    }

    if (p === '/api/quote') {
      const codes = (url.searchParams.get('codes') || '')
        .split(',').map((s) => s.trim()).filter((s) => /^\d{5,6}$/.test(s)).slice(0, 60);
      if (!codes.length) return json({ ok: false, error: 'codes 为空' });
      try {
        const diff = await fetchQuote(codes);
        return json({ ok: true, src: 'eastmoney', raw: diff });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e), raw: [] });
      }
    }

    if (p === '/api/min') {
      const code = (url.searchParams.get('code') || '').trim().replace(/^(sh|sz)/i, '');
      if (!/^\d{5,6}$/.test(code)) return json({ ok: false, error: 'code 非法' });
      return serveMin(ctx, code);
    }

    if (p === '/api/top3') {
      const raw = (url.searchParams.get('codes') || '').trim();
      const list = raw.split(',').map((x) => x.trim().replace(/^(sh|sz)/i, ''))
        .filter((x) => /^\d{5,6}$/.test(x));
      const uniq = [];
      const seen = {};
      for (const c of list) { if (!seen[c]) { seen[c] = 1; uniq.push(c); } }
      if (!uniq.length) return json({ ok: false, error: 'codes 非法' });
      if (uniq.length > TOP3_MAX) return json({ ok: false, error: '一次最多 ' + TOP3_MAX + ' 只' });
      return serveTop3(ctx, uniq, env);
    }

    if (p === '/api/hold') {
      const code = (url.searchParams.get('code') || '').trim().replace(/^(sh|sz)/i, '');
      if (!/^\d{5,6}$/.test(code)) return json({ ok: false, error: 'code 非法' });
      return serveHold(ctx, code, env);
    }

    // 手动跑一轮预热（Cron 之外的补刀）：换设备/改配置时用来确认链路通不通
    if (p === '/api/pcfwarm') {
      try {
        return json({ ok: true, ...(await warmRound(env)) });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) });
      }
    }

    if (p === '/api/speed') {
      const raw = (url.searchParams.get('codes') || '').trim();
      const list = raw.split(',').map((s) => s.trim().replace(/^(sh|sz)/i, ''))
        .filter((s) => /^\d{5,6}$/.test(s));
      // 去重但不改顺序：前端按成交额排好了，顺序本身是「流动性优先级」，
      // 服务端返回时保持它，前端就不用再排一次
      const seen = new Set();
      const codes = list.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
      if (!codes.length) return json({ ok: false, error: 'codes 为空' });
      return serveSpeed(ctx, codes);
    }

    if (p === '/api/probe') {
      const t0 = Date.now();
      const emP = fetchEM().then((b) => {
        const j = safeParse(b);
        return { ok: j ? j.n : 0, ms: Date.now() - t0, src: 'eastmoney', hasIopv: true };
      }).catch((e) => ({ ok: 0, ms: Date.now() - t0, src: 'eastmoney', err: e.message }));
      const t1 = Date.now();
      const snP = fetchSina().then((b) => {
        const j = safeParse(b);
        return { ok: j ? j.n : 0, ms: Date.now() - t1, src: 'sina', hasIopv: false };
      }).catch((e) => ({ ok: 0, ms: Date.now() - t1, src: 'sina', err: e.message }));
      const [em, sn] = await Promise.all([emP, snP]);
      return json({
        eastmoney: em, sina: sn,
        note: 'ok>0 表示该源在当前离线环境可用。东财额外提供 IOPV/溢价率。',
      });
    }

    // 注意 json() 的第二个参数是缓存秒数，不是状态码——想给 404 得自己构造
    return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
      status: 404,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  },

  /**
   * Cloudflare Cron Trigger（见 wrangler.toml 的 [triggers]）：
   * 每分钟一轮 PCF 预热，从 09:00 跑到 16:00（北京时间）。预热完 1718 只大约
   * 86 轮，之后每轮只读一次进度就返回。沙箱版没有 Cron，由 server/app.mjs
   * 用同一个 warmRound 定时调用，两边逻辑不重复。
   */
  async scheduled(event, env, ctx) {
    const job = warmRound(env).catch((e) => {
      console.log('[pcfwarm] ' + String(e && e.message || e));
      return null;
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    else await job;
  },
};

// ---- 内联的前端页面（由 build.mjs 生成，勿手改）----
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETF 全市场盯盘</title>
<style>
:root{--bg:#f5f6f8;--bg2:#ffffff;--bg3:#f0f2f5;--line:#e3e6eb;--txt:#15181d;
--txt2:#5b6472;--txt3:#939aa7;--up:#d93a3a;--down:#0e9a61;--accent:#2563eb;
--mono:"SF Mono",Consolas,"Roboto Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
font-variant-numeric:tabular-nums;padding:14px 18px 40px}
.wrap{max-width:1560px;margin:0 auto}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:16px;font-weight:600;letter-spacing:.4px}
h1 em{color:var(--txt3);font-weight:400;font-size:11.5px;font-style:normal;margin-left:8px}
.sp{flex:1}
.dot{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;
background:var(--bg3);border:1px solid var(--line);font-size:11.5px;color:var(--txt2)}
.dot i{width:7px;height:7px;border-radius:50%;background:var(--txt3)}
.dot.up i{background:var(--down);box-shadow:0 0 0 3px rgba(14,154,97,.16)}
.dot.down i{background:var(--up);box-shadow:0 0 0 3px rgba(217,58,58,.16)}
.dot.down{color:var(--up)}
#btnRs{padding:3px 11px;border-radius:20px;font-size:11.5px;color:var(--txt2);display:inline-block;
text-decoration:none;
background:var(--bg3)}
#btnRs:hover{color:var(--txt);border-color:var(--accent)}
/* 吸顶锚点导航：页面 7000px+，没有跳转每次找自选都要滚半天。
   top:0 吸顶（主页面 header 不吸顶，滚过就让它走），毛玻璃压住下面的内容。
   --navH 由 JS 量出来，区块 scroll-margin-top 和表头 sticky 都引用它。 */
.secnav{position:sticky;top:0;z-index:6;display:flex;gap:2px;align-items:center;
  margin:-2px 0 10px;padding:4px 0;background:rgba(245,246,248,.9);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.secnav a{font-size:13px;color:var(--txt2);padding:4px 14px;border-radius:6px;cursor:pointer;
  user-select:none;white-space:nowrap}
.secnav a:hover{color:var(--txt)}
.secnav a.on{background:var(--bg2);color:var(--txt);border:1px solid var(--line);padding:3px 13px;font-weight:600}
.sec[id],.oncard[id]{scroll-margin-top:var(--navH,42px)}
.cards{display:flex;gap:9px;margin-bottom:12px;flex-wrap:wrap}
.cards .card{width:186px;flex:0 0 auto}
@media(max-width:560px){.cards .card{width:calc(50% - 5px)}}
/* 隔夜映射卡：美股收盘 + 外盘期货按「赛道」折算到 A 股 ETF。
   盘前打开页面第一眼要看的东西，所以放在统计卡上面。
   涨红跌绿是 A 股习惯，美股数据进来也按这个上色——
   页面要迁就读者的眼睛，不是迁就数据源的习惯。 */
.oncard{background:var(--bg2);border:1px solid var(--line);border-radius:8px;
  padding:8px 12px;margin-bottom:12px;font-size:12.5px}
.onhd{display:flex;align-items:baseline;gap:8px;color:var(--txt2)}
.onhd b{color:var(--txt1);font-size:12.5px}
.onhd .n{font-size:11.5px;color:var(--txt3)}
.onhd .ofold{margin-left:auto;cursor:pointer;color:var(--txt3);user-select:none}
.onfut{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.onfut span{background:var(--bg1);border:1px solid var(--line);border-radius:4px;
  padding:2px 7px;font-size:11.5px;color:var(--txt2)}
.ontrks{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.ontrk{cursor:pointer;border:1px solid var(--line);border-radius:5px;padding:3px 9px;
  background:var(--bg1);user-select:none;display:flex;gap:6px;align-items:baseline}
.ontrk b{font-weight:500;color:var(--txt1)}
.ontrk i{font-style:normal;font-size:11.5px}
.ontrk.sel{border-color:var(--txt3)}
.ondet{margin-top:7px;padding:7px 10px;border-top:1px dashed var(--line);line-height:1.8}
.ondet .ot{color:var(--txt2);font-size:11.5px;letter-spacing:.3px}
.ondet .ous{display:flex;gap:5px 12px;flex-wrap:wrap;margin:3px 0 5px}
.ondet .ous span{white-space:nowrap}
.ondet .oetfs{display:flex;gap:5px 12px;flex-wrap:wrap}
.ondet .oetfs span{white-space:nowrap}
.ondet .mine{outline:1px solid currentColor;border-radius:3px;padding:0 3px}
/* 上游故障时的横幅：贴在卡片下面，一进页面就能看见。
   放在 footer 里等于没有——100 行的表格把 footer 顶到 4600px 之外。 */
.stalebar{margin:-2px 0 12px;padding:7px 10px;border-radius:6px;font-size:12.5px;line-height:1.5;
  background:#fff8e8;border:1px solid #f0dcb0;color:#8a5a00}
.stalebar.bad{background:#fdeeee;border-color:#f3c7c7;color:#b02a2a}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 13px}
.card .k{font-size:11.5px;color:var(--txt2);letter-spacing:.3px;margin-bottom:4px}
.card .v{font-size:19px;font-weight:600;font-family:var(--mono);line-height:1.25}
.card .v small{font-size:11.5px;font-weight:400;color:var(--txt3);margin-left:3px}
.card .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
/* ---------- 全市场异动 ---------- */
.mktwrap{display:block}
.mkbox{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 13px}
.wbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:9px 0 7px;
  background:#eef1f5;box-shadow:inset 0 0 0 1px #e3e6eb}
.wbar i{display:block;height:8px}
.wstat{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;
  color:var(--txt3);font-family:var(--mono);flex-wrap:wrap}
.wstat b{color:var(--txt);font-weight:600}
.mtabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}
.mtab{font-size:11.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--line);
  background:var(--bg3);color:var(--txt2);cursor:pointer;user-select:none;white-space:nowrap}
.mtab:hover{border-color:#c9d6ef}
.mtab.on{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8;font-weight:600}
.mtab u{text-decoration:none;margin-left:5px;font-family:var(--mono);font-size:10.5px;opacity:.7}
.mhead,.mrow{display:grid;grid-template-columns:minmax(0,1fr) 44px 48px 46px 58px;
  gap:8px;align-items:center}
/* 宽屏两栏：13 行铺满 1376px 时，第一列会被 1fr 撑到 1148px，
   名称只有 120px，中间一大条空白，看着像错行。分两栏后每行 ~660px，
   名称和数字挨得上，同样高度还能多放一倍。表头跟着每栏各出一份。 */
.mcols{display:grid;grid-template-columns:1fr 1fr;gap:0 34px;align-items:start}
@media(max-width:1100px){.mcols{grid-template-columns:1fr;gap:0}}
@media(max-width:560px){
  /* 手机上一行放五列本来就紧，指数名让位给 ETF 名称，名称被截断更伤 */
  .mn em{display:none}
  .mhead,.mrow{grid-template-columns:minmax(0,1fr) 38px 34px 32px 50px;gap:5px}
}
.mhead{padding:0 0 5px;font-size:10.5px;color:var(--txt3);border-bottom:1px solid var(--line);
  font-family:var(--mono);letter-spacing:.3px}
.mhead span:not(:first-child){text-align:right}
.mrow{padding:5px 0;border-bottom:1px dashed var(--line);cursor:pointer;font-size:12.5px}
.mtag{font-size:10.5px;padding:1px 0;border-radius:4px;text-align:center;white-space:nowrap;
  font-weight:600;letter-spacing:.2px}
.mtag.t-up{background:#fdecee;color:#b02a2a;border:1px solid #f3c7c7}
.mtag.t-warn{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.mtag.t-down{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.mtag.t-info{background:#eaf1ff;color:#1d4ed8;border:1px solid #b9cdf7}
.mtag.t-mute{background:#f0f2f5;color:#6b7380;border:1px solid #e3e6eb}
.mrow:last-child{border-bottom:none}
.mrow:hover .mn{color:#1d4ed8}
.mn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.mn em{font-style:normal;font-size:10.5px;color:var(--txt3);margin-left:5px;font-family:var(--mono)}
.mnum{font-family:var(--mono);font-size:11.5px;text-align:right}
.mnum small{font-size:10.5px;color:var(--txt3);margin-right:2px}
/* ---- 急涨急跌 ---- */
.spdgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.spdcol{min-width:0}
.spdcol + .spdcol{border-left:1px solid var(--line);padding-left:14px}
.spdcol:first-child{padding-right:14px}
.spdnone{padding:9px 0;color:var(--txt3);font-size:11.5px}
.spdch{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--txt3);
  padding-bottom:5px;border-bottom:1px solid var(--line);margin-bottom:2px;letter-spacing:.3px}
.spdch b{font-weight:600;font-size:11.5px}
.spdch b.up{color:var(--up)}.spdch b.dn{color:var(--down)}
/* 用 flex 而不是 grid：名称 + 走势线是「左边一块信息」，涨速和量比是
   「右边两个数」。网格会把走势线顶到栏宽的中段，两边各留一片空白，
   看着像中间缺了内容。 */
.spdrow{display:flex;gap:8px;align-items:center;padding:5px 0;
  border-bottom:1px dashed var(--line);cursor:pointer;font-size:12.5px}
.spdrow:last-child{border-bottom:none}
.spdrow:hover{background:#f7f9fc}
.spdrow:hover .spdnm{color:#1d4ed8}
/* 给名字一个下限：不然「银行ETF华宝」和「沪深300ETF华泰柏瑞」两种长度
   会让走势线在每一行都往右挪一点，一列 spark 看着像锯齿。 */
/* 名字列给死宽度：名字长短不一时，走势线的左端会一行一行往右挪，
   一列 spark 参差错开，看着比数据本身还乱（这也是「比例怪」的一半原因）。
   死宽度 + 名字省略号，代码不缩——代码是拿来复制搜索的，比名字后半截有用。 */
.spdnm{flex:0 0 168px;display:flex;align-items:baseline;gap:4px;min-width:0;font-weight:500}
.spdnm .nmx{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spdnm em{flex:0 0 auto;font-style:normal;font-size:10.5px;color:var(--txt3);font-family:var(--mono)}
/* 走势线往右靠、紧贴两个数值：名字短的行中间留白，比「线飘在名字后面、
   数值孤零零在最右」稳。涨速/量比两个数成一组，才是「右块」。 */
.spk{display:block;flex:0 0 auto;margin-left:auto;overflow:visible}
.spdv{flex:0 0 56px;font-family:var(--mono);font-size:12.5px;
  text-align:right;font-weight:600}
.spdq{flex:0 0 40px;font-family:var(--mono);font-size:11.5px;text-align:right;color:var(--txt2)}
.spdq.hot{color:#a9660a;font-weight:600}
.spdnote{font-size:10.5px;color:var(--txt3);margin-top:7px;padding-top:6px;
  border-top:1px solid var(--line);line-height:1.5}
@media(max-width:760px){
  .spdgrid{grid-template-columns:1fr;gap:10px}
  .spdcol + .spdcol{border-left:none;border-top:1px solid var(--line);padding-left:0;padding-top:12px}
  .spdcol:first-child{padding-right:0}
  /* 手机上挤不下走势线，让位给名字——名字被截成两三个字更伤 */
  .spdrow{gap:6px}
  .spdrow .spk{display:none}
  .spdnm{flex:1 1 auto;min-width:0}
  .spdv{flex:0 0 52px;font-size:11.5px}
  .spdq{flex:0 0 36px;font-size:10.5px}
}
.mfoot{margin-top:7px;padding-top:7px;border-top:1px dashed var(--line);
  font-size:10.5px;color:var(--txt3);line-height:1.6}

/* ---------- 今日变化 + 组合体检 ---------- */
.split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:9px;align-items:start}
@media(max-width:860px){.split{grid-template-columns:1fr}}
.evtbox,.portbox{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 13px}
.evt{display:flex;gap:9px;padding:7px 0;border-bottom:1px dashed var(--line)}
.evt:last-child{border-bottom:none;padding-bottom:1px}
.evt i{width:6px;height:6px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:#c3c9d4}
.evt.lv3 i{background:#d93a3a}
.evt.lv2 i{background:#e0a12a}
.evt.lv1 i{background:#9aa3b2}
.eb{min-width:0}
.eb b{font-size:12.5px;font-weight:600}
.eb .ek{margin-left:7px;font-size:10.5px;color:var(--txt2);background:var(--bg3);
  border:1px solid var(--line);border-radius:4px;padding:0 5px;white-space:nowrap}
.evt.lv3 .ek{color:#b02a2a;background:#fdecee;border-color:#f3c7c7}
.evt.lv2 .ek{color:#a9660a;background:#fff6e5;border-color:#f0dcb4}
.es{font-size:11.5px;color:var(--txt2);margin-top:3px;line-height:1.55}
.eempty{padding:14px 2px 10px;font-size:12.5px;color:var(--txt2);line-height:1.7}
.eempty span{color:var(--txt3);font-size:11.5px}
.prow{display:flex;gap:16px;margin-bottom:2px}
.pk{font-size:10.5px;color:var(--txt3);margin-bottom:2px}
.pv{font-size:21px;font-weight:600;font-family:var(--mono);line-height:1.25}
.pv small{font-size:10.5px;color:var(--txt3);font-weight:400;margin-left:2px}
.pnote{font-size:11.5px;color:var(--txt2);line-height:1.65;border-top:1px dashed var(--line);
  padding-top:8px;margin-top:9px}
.pnote b{color:var(--txt)}

/* ---------- 位置诊断 ---------- */
/* 这一栏是整页唯一「不是行情软件」的东西：行情软件给报价，这里给位置和量能。
   位置条用蓝色深浅而不是红绿——红绿在这页已经被涨跌占用，再用一次就乱了。 */
.dnote{font-size:11.5px;color:var(--txt3);margin:-1px 0 9px;line-height:1.6}
.dgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:9px}
@media(max-width:560px){.dgrid{grid-template-columns:1fr}}
.dcard{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 12px 11px;
  cursor:pointer;transition:border-color .15s,box-shadow .15s;display:flex;flex-direction:column}
.dcard:hover{border-color:#c9d6ef;box-shadow:0 3px 12px rgba(23,32,54,.1)}
.dcard.pend{opacity:.55}
.dtop{display:flex;align-items:baseline;gap:7px;margin-bottom:9px;min-width:0}
.dtop .dn{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtop .dc{font-family:var(--mono);font-size:11.5px;color:var(--txt3);flex:0 0 auto}
.dtag{margin-left:auto;font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:5px;
  white-space:nowrap;flex:0 0 auto}
.dtag.d0{background:#f0f2f5;color:#5b6472;border:1px solid #e3e6eb}
.dtag.d1{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.dtag.d2{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.dtag.d3{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.dtag.d4{background:#fdecee;color:#b02a2a;border:1px solid #f3c7c7}
.posbar{position:relative;height:7px;border-radius:4px;background:#e7ebf1;overflow:visible}
.posbar u{position:absolute;left:0;top:0;height:7px;border-radius:4px;
  background:linear-gradient(90deg,#c9dbff,#5c92ec)}
.posbar i{position:absolute;top:-2.5px;width:4px;height:12px;border-radius:2px;background:#1d4ed8;
  box-shadow:0 0 0 2px #fff,0 1px 3px rgba(20,26,40,.25);transform:translateX(-2px)}
.poslb{display:flex;align-items:baseline;justify-content:space-between;font-size:10.5px;
  color:var(--txt3);font-family:var(--mono);margin-top:6px;letter-spacing:.2px}
.poslb .pz{font-size:15px;font-weight:600;color:var(--txt);font-family:var(--mono);line-height:1}
.poslb .pz em{font-style:normal;font-size:10.5px;color:var(--txt3);font-weight:400;margin-left:5px;
  letter-spacing:.2px}
.dchips{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px}
.dchip{font-size:10.5px;color:var(--txt3);background:var(--bg3);border:1px solid var(--line);
  border-radius:5px;padding:2px 7px;font-family:var(--mono);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dchip b{color:var(--txt);font-weight:600;margin-left:2px}
.dchip b.up{color:var(--up)}.dchip b.down{color:var(--down)}
.dwhy{margin-top:auto;padding-top:7px;font-size:11.5px;color:var(--txt2);line-height:1.55}

.bar{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input,select,button{background:var(--bg2);color:var(--txt);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font-size:12.5px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
input#q{width:180px}
button{cursor:pointer;transition:.15s}
button:hover{background:var(--bg3)}
button.pri{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:12.5px;
border:1px solid var(--line);background:var(--bg2);color:var(--txt2);transition:.15s;user-select:none}
.tag:hover{color:var(--txt)}
.tag.on{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8}
.tag b{font-weight:400;opacity:.6;font-size:10.5px;margin-left:3px}
.sec{margin-bottom:16px}
.sechd{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12.5px;color:var(--txt2)}
.sechd b{color:var(--txt);font-size:13.5px;font-weight:600;white-space:nowrap;flex:0 0 auto}
.sechd .n{color:var(--txt3);font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis}
/* overflow 用 clip 不用 hidden：hidden 会把 .tbl 变成滚动容器，theadd 的
   sticky 就地失效（表头吸顶不出来）；clip 同样裁掉圆角外的内容但不建立滚动盒。 */
.tbl{background:var(--bg2);border:1px solid var(--line);border-radius:8px;overflow:clip}
table{width:100%;border-collapse:collapse}
thead th{background:var(--bg3);font-size:10.5px;font-weight:500;color:var(--txt2);
letter-spacing:.3px;padding:9px;text-align:right;white-space:nowrap;
border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
/* 表头吸顶：榜单 100 行、自选表滚过去之后列名还在。top 对齐锚点导航下缘，
   背景色要实（不能透），否则行文字会从表头底下透出来。 */
.tbl thead th{position:sticky;top:var(--navH,42px);z-index:3}
thead th:hover{color:var(--txt)}
thead th.l{text-align:left}
thead th.ctr{text-align:center}
thead th.on{color:var(--accent)}
tbody td{padding:8px 9px;text-align:right;border-bottom:1px solid #e3e6eb;
font-family:var(--mono);font-size:12.5px;white-space:nowrap}
tbody tr:hover{background:#f7f9fd}
tbody tr:last-child td{border-bottom:none}
td.l{text-align:left;font-family:inherit}
td.ctr{text-align:center}
.code{color:var(--txt3);font-size:11.5px}
.nm{font-weight:500}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--txt3)}
.pm{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11.5px;font-weight:600;min-width:56px}
.pm.hi{background:#fdecec;color:#c62f34;border:1px solid #f5c9cb}
.pm.mid{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.pm.lo{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.pm.na{background:transparent;color:var(--txt3);border:none;font-weight:400}
.act{color:var(--txt3);cursor:pointer;font-size:15px;padding:1px 6px;border-radius:4px}
.act:hover{color:var(--accent);background:#eaf1ff}
.act.del:hover{color:var(--up);background:#fdeeee}
.ixb{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;font-size:10.5px;
font-weight:500;color:var(--txt3);background:#f0f2f5;border:1px solid var(--line);
vertical-align:1px;cursor:default}
.ixb.mx{color:#2563eb;background:#eaf1ff;border-color:#c9dbff}
.syn{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:10.5px;
color:#2563eb;background:#eaf1ff;border:1px solid #c9dbff;vertical-align:1px;font-weight:500}
tr.hr{cursor:pointer}
tr.hr:hover td{background:#f7f9fd}
@keyframes fu{0%{background:#ffe3e3}100%{background:transparent}}
@keyframes fd{0%{background:#d9f5ea}100%{background:transparent}}
.fu{animation:fu .7s ease-out}.fd{animation:fd .7s ease-out}
footer{margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--txt3)}
.err{color:var(--up)}
.empty{padding:20px;text-align:center;color:var(--txt3);font-size:12.5px}
/* 「今日变化」两格的空态不是错误也不是加载，只是一句话——按正文排版收紧行高，
   不再占一大块空白。 */
.evtbox .empty,.portbox .empty{padding:6px 2px;text-align:left;line-height:1.7}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#fff;box-shadow:0 8px 28px rgba(23,32,54,.16);
border:1px solid var(--line);padding:8px 16px;border-radius:6px;font-size:12.5px;opacity:0;
transition:.25s;pointer-events:none;z-index:9}
#toast.show{opacity:1}
@media(max-width:820px){.hide-sm{display:none}}
/* 「主要贡献」列到中等屏就收掉：自选表本来就有 14 列，1280 以下再加一列会把
   成交额和换手挤成一坨，反而更难读 */
@media(max-width:1280px){.hide-md{display:none}}
.t3cell{white-space:nowrap;text-align:left}
/* 三只成分压成一串小标签。用底色块而不是纯文字：三行名字连在一起时，
   靠颜色块才分得清哪一段是名称、哪一段是贡献数字 */
.t3{display:inline-block;padding:0 4px;margin-right:3px;border-radius:3px;
  background:#f3f6fb;font-size:10.5px;line-height:17px;color:var(--txt2);
  font-family:var(--sans);font-weight:500}
.t3 em{font-style:normal;font-family:var(--mono);margin-left:3px;font-weight:600}
.t3.up em{color:var(--up)}
.t3.dn em{color:var(--down)}
.t3ph{color:var(--txt3);font-size:11.5px;font-family:var(--mono)}

/* ---------- 历史 K 线面板 ---------- */
#histMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:60;display:none;
align-items:center;justify-content:center;padding:18px}
#histMask.on{display:flex}
.hpanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;min-width:0;
max-width:1060px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 8px 28px rgba(23,32,54,.16)}
.hhd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.hhd .nm{font-size:14.5px;font-weight:600}
.hhd .cd{font-family:var(--mono);font-size:12.5px;color:var(--txt3)}
.hhd .px{font-family:var(--mono);font-size:16px;font-weight:600;margin-left:4px}
.hhd .ch{font-family:var(--mono);font-size:12.5px}
.htabs{display:flex;gap:3px;margin-left:6px}
/* 分时 / K线 切换：做成独立分段控件，和右边周期条分开——
   两者语义不同（一个是「看什么」，一个是「看多长」），混在一排会读错 */
.hmodes{display:flex;gap:2px;background:var(--bg3);border:1px solid var(--line);
border-radius:6px;padding:2px;margin-left:auto}
.hmodes b{padding:2px 10px;border-radius:4px;font-size:11.5px;font-weight:400;
color:var(--txt2);cursor:pointer;user-select:none}
.hmodes b:hover{color:var(--txt)}
.hmodes b.on{background:#fff;color:var(--txt);font-weight:600;box-shadow:0 3px 12px rgba(23,32,54,.1)}
.hmodes b[data-m="min"].on{color:var(--accent)}
.htabs span{padding:3px 9px;border-radius:5px;font-size:11.5px;color:var(--txt2);
cursor:pointer;border:1px solid transparent;user-select:none}
.htabs span:hover{color:var(--txt)}
.htabs span.on{background:var(--bg3);border-color:var(--line);color:var(--txt)}
.hx{width:26px;height:26px;border-radius:6px;border:1px solid var(--line);background:transparent;
color:var(--txt2);cursor:pointer;font-size:15px;line-height:1;padding:0}
.hx:hover{color:var(--txt);background:var(--bg3)}
#histCv{display:block;width:100%;height:clamp(300px,62vh,430px);flex:0 0 auto;cursor:crosshair;min-width:0;max-width:100%}
/* 副图 / 叠加选择条：一行 chip，切换只重绘画布，不重新拉数据 */
.hsbar{display:flex;align-items:center;gap:4px;padding:8px 14px 2px;flex-wrap:wrap}
.hsbar .lb{font-size:10.5px;color:var(--txt3);margin-right:2px}
.hsbar .lb+.sg+.lb{margin-left:8px}
.hsbar .sg{display:flex;gap:3px;flex-wrap:wrap;min-width:0}
.hsbar b{padding:2px 7px;border:1px solid var(--line);border-radius:5px;font-size:11.5px;
font-family:var(--mono);font-weight:400;color:var(--txt2);cursor:pointer;user-select:none}
.hsbar b:hover{color:var(--txt)}
.hsbar b.on{background:var(--bg3);color:var(--txt);border-color:#c9d6ef}

/* ---- 成分穿透 ----
   一行 = 一只成分：权重、今日涨跌、贡献（权重×涨跌），中间一条以中线为 0 的
   双向条。条不是为了好看：0.02 个百分点的贡献和 0.4 个用数字看只差一个字，
   用长度看是一眼。条按当前表里最大 |贡献| 归一，所以每次打开尺度会变——
   换来的是小票也能看见，代价是不能跨股票比长度。 */
/* 高度必须自己封顶：flex-basis:0 在高度 auto 的父容器里算不出剩余空间，
   面板会塌成只剩标题栏；不封顶则 30 行把底部的合计挤出屏幕。 */
.hhold{display:none;flex:0 1 auto;max-height:calc(94vh - 132px);overflow-y:auto;padding:0 14px}
.hhold.on{display:block}
.hholdhd{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  font-size:10.5px;color:var(--txt3);padding:8px 0 7px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:var(--bg2);z-index:2}
.hholdhd b{color:var(--txt);font-weight:600}
.hcollapse{font-style:normal;cursor:pointer;color:#2f6fd0;border-bottom:1px dashed #9dbbeb}
.hhrow{display:grid;grid-template-columns:minmax(0,220px) 62px 66px minmax(70px,1fr) 62px;
  gap:10px;align-items:center;padding:5px 0;border-bottom:1px dashed var(--line);font-size:12.5px}
.hhrow:hover{background:#f7f9fc}
.hhrk{display:none}
.hhnm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.hhnm em{font-style:normal;font-size:10.5px;color:var(--txt3);margin-left:5px;font-family:var(--mono)}
.hhw,.hhc,.hhctr{font-family:var(--mono);text-align:right;font-size:11.5px}
.hhc.up{color:var(--up)}.hhc.dn{color:var(--down)}
/* 贡献列也要红涨绿跌：不写这条时负贡献会掉回默认的深灰，跟「-0.16 是坏事」
   这层意思对不上，整列看着像没上色 */
.hhctr{font-weight:600}
.hhctr.up{color:var(--up)}.hhctr.dn{color:var(--down)}
.hhbar{position:relative;height:7px;background:#eaeef4;border-radius:4px}
.hhbar:before{content:"";position:absolute;left:50%;top:0;width:1px;height:7px;background:#c9d2de}
.hhbar u{position:absolute;top:0;height:7px;border-radius:3px}
/* 合计行吸在底部：它是这一栏的结论（前 N 大解释了多少、剩下多少），
   被 30 行挤到屏幕外就等于没给。 */
.hhfoot{display:flex;flex-wrap:wrap;gap:14px;padding:9px 0 8px;font-size:11.5px;color:var(--txt2);
  position:sticky;bottom:0;background:var(--bg2);border-top:1px solid var(--line);z-index:1}
.hhfoot b{font-family:var(--mono);font-weight:600}
.hhfoot .k{color:var(--txt3)}
.hhnote{padding:8px 0 2px;font-size:10.5px;color:var(--txt3);line-height:1.75}
/* 展开按钮：整行居中，视觉上明显是「表格到此为止」的分界，不是又一条成分 */
.hhmore{display:flex;justify-content:center;padding:9px 0 4px}
.hhmore b{font-size:11.5px;font-weight:500;color:var(--acc,#2f6fd0);cursor:pointer;
  padding:5px 14px;border:1px solid #cfdcf0;border-radius:14px;background:var(--bg2)}
.hhmore b:hover{background:#eef4fe;border-color:#9dbbeb}
.hhmore b:active{transform:translateY(1px)}
.hempty{padding:28px 0;text-align:center;color:var(--txt3);font-size:12.5px;line-height:1.9}
@media(max-width:760px){
  .hhrow{grid-template-columns:minmax(0,1fr) 48px 54px 52px;gap:6px;font-size:11.5px}
  .hhbar{display:none}
  .hhw,.hhc,.hhctr{font-size:11.5px}
  .hhold{padding:0 12px 8px}
}
.hind .i.on{border-color:#c9d6ef;background:var(--bg3)}
.hleg{display:flex;gap:16px;padding:7px 14px 0;font-size:11.5px;color:var(--txt2);flex-wrap:wrap}
.hleg i{display:inline-block;width:8px;height:2px;vertical-align:3px;margin-right:4px}
.hnote{padding:5px 14px 12px;font-size:10.5px;color:var(--txt3);line-height:1.7}
.hnote:empty{display:none}
/* 指标明细：K 线下方一排小卡，把 17 个字段里最能看的那几个摊开 */
.hind{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;padding:6px 14px 2px;min-width:0}
.hind .i{background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:5px 8px;min-width:0}
.hind .i .k{font-size:10.5px;color:var(--txt3);letter-spacing:.2px;white-space:nowrap}
.hind .i .v{font-size:12.5px;font-family:var(--mono);font-weight:600;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hind .i .s{font-size:10.5px;color:var(--txt2);margin-top:1px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.hload{padding:70px 0;text-align:center;color:var(--txt2);font-size:12.5px;line-height:2}
@media(max-width:700px){
  /* 顶部一行装不下：名称/代码/价格/涨幅 + 4 个周期 + 关闭。
     不换行就会把面板撑得比屏幕还宽，连带右边价格轴一起被裁。 */
  /* 关闭按钮脱离 flex 流、钉在右上角。留在流里的话，它排在分段控件之后，
     一行剩不下 26px 就整颗掉到第二行，顶部凭空多出一行高度。 */
  .hhd{flex-wrap:wrap;gap:4px 6px;padding:9px 10px;padding-right:40px;position:relative}
  .hhd .cd{display:none}
  /* 名称不截断时，长名字（沪深300ETF华泰柏瑞）会把关闭按钮挤到第二行，
     面板顶部凭空多出一行，看着像渲染坏了 */
  .hhd .nm{font-size:13.5px;max-width:28vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .htabs{margin-left:0;order:9}
  .htabs span{padding:2px 7px}
  .hmodes{margin-left:auto;order:8;padding:2px}
  .hmodes b{padding:2px 5px;font-size:10.5px}
  .hx{position:absolute;right:8px;top:10px;margin:0}
  .hsbar{padding:7px 10px 2px;gap:3px;overflow:hidden}
  .hsbar .lb{font-size:10.5px}
  .hsbar .lb+.sg+.lb{margin-left:5px}
  .hsbar b{padding:2px 5px;font-size:10.5px}
  #histCv{height:300px}
  /* 小屏固定 3 列：auto-fit 在 400px 里会算出 4 列 96px，
     但 canvas 的固有宽度参与 flex 计算会把面板撑宽，导致第 4 列被裁掉 */
  .hind{grid-template-columns:repeat(3,minmax(0,1fr))}
}
/* 自选标题行右侧的小按钮：上一版这里是「同步」，复制一条带编号的链接，
   谁打开谁能写。换成纯文本导入导出后，只需要一个入口。 */
.sechd .io{margin-left:auto;font-size:11.5px;color:var(--txt);background:var(--bg3);
border:1px solid var(--line);border-radius:5px;padding:3px 9px;cursor:pointer;
user-select:none;white-space:nowrap}
.sechd .io:hover{border-color:#c3cad8}

/* 板块地图标题下的一行体检：多少格、多少指数、多少只有报价、多少只进不来。
   被「229 个单只指数整组丢掉」坑过一次，覆盖率要写在明面上，不靠人去猜。 */
.secmeta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10.5px;color:var(--txt3);
padding:0 2px 7px;line-height:1.5}
.secmeta b{color:var(--txt2);font-weight:600}
.secmeta span{white-space:nowrap}
/* 体检灯：一行灰字没人看，出事时必须先扎眼。绿=三项都过，
   黄/红=有异常且标签文字直接写出来，不用点开才知道。 */
.secmeta .mt{display:inline-flex;align-items:center;gap:5px;font-weight:600;
color:var(--txt2);cursor:pointer;user-select:none}
.secmeta .mt:hover{color:var(--txt)}
.secmeta .mt i{width:7px;height:7px;border-radius:50%;background:#2e9e5b;flex:none}
.secmeta .mt.warn i{background:#d9a013}
.secmeta .mt.bad i{background:#d64545}
.secmeta .mt.warn{color:#8a6a10}
.secmeta .mt.bad{color:#a03030}
/* 展开明细：flex-basis:100% 换到第二行，虚线隔开 */
.secmeta .mtdet{display:none;flex-basis:100%;align-items:center;flex-wrap:wrap;gap:3px 14px;
padding:3px 0 0;border-top:1px dashed var(--line);margin-top:2px;font-size:10.5px}
.secmeta.open .mtdet{display:flex}
.secmeta .mtdet .ok{color:#2e7d4f}
.secmeta .mtdet .warn{color:#a06a00}
.secmeta .mtdet .note{color:var(--txt3)}
.secmeta .mtdet .warnmsg{color:#a03030}
@media(max-width:560px){.secmeta .opt{display:none}}

/* 格子点开后的占比走势。存在的理由：页面只有「今天占比多少」，
   看不出这个数是刚起步还是已经走了一半。 */
.strend{margin:2px 0 10px;padding:9px 12px 7px;background:var(--bg2);
border:1px solid var(--line);border-radius:8px}
.sthd{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-size:11.5px;color:var(--txt3)}
.sthd b{font-size:15px;color:var(--txt);font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.sthd .sttag{font-size:10.5px;padding:1px 6px;border-radius:4px;background:var(--bg3);
color:var(--txt2);border:1px solid var(--line)}
.sthd .sttag.hi{color:#a8541c;border-color:#f0dcc8;background:#fdf6ef}
.sthd .sttag.lo{color:#1c6b8a;border-color:#cfe3ee;background:#f2f9fc}
.strend svg{display:block;width:100%;height:86px;margin-top:5px}
.stax{display:flex;justify-content:space-between;font-size:10.5px;color:var(--txt3);
margin-top:1px;font-variant-numeric:tabular-nums}

/* 集中度 × 宽度四象限。格子回答「钱在哪条线」，这张图回答
   「这种分布是常态还是异常」——只给一个 58.7% 没人知道算高算低。 */
.scq{margin:7px 0 8px;padding:8px 11px 6px;background:var(--bg2);
border:1px solid var(--line);border-radius:8px;position:relative}
.scqhd{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--txt3)}
.scqhd>span:first-child{color:var(--txt2);font-weight:600}
.scqhd .scqb{font-style:normal;font-weight:700;font-size:11.5px;padding:1px 7px;border-radius:4px;
background:var(--bg3);border:1px solid var(--line)}
.scqhd .scqtag{margin-left:auto;font-size:10.5px;color:var(--txt3);letter-spacing:.2px;cursor:help}
/* 四象限说明浮窗。四个角标签只有名字，不知道「抱团」和「涣散」差在哪，
   而且差的那一步正好决定该不该动手。浮窗用 2×2 小矩阵复刻图上的方位。 */
.scqhelp{flex:none;width:14px;height:14px;line-height:12px;text-align:center;border-radius:50%;
border:1px solid var(--line);background:var(--bg);color:var(--txt3);font-size:10.5px;cursor:pointer;
user-select:none;font-style:normal}
.scqhelp:hover{color:var(--txt2);border-color:var(--txt3)}
.scqpop{display:none;position:absolute;right:8px;top:26px;z-index:40;
width:min(424px,calc(100% - 16px));padding:10px 12px 9px;background:var(--bg);
border:1px solid var(--line);border-radius:9px;box-shadow:0 8px 28px rgba(23,32,54,.16)}
.scq.open .scqpop{display:block}
.scqaxs{font-size:10.5px;color:var(--txt3);margin:0 0 8px;letter-spacing:.2px}
.scqgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px}
.scqcell{border-left:3px solid var(--line);padding:1px 0 1px 8px;min-width:0}
.scqcell b{display:block;font-size:11.5px;color:var(--txt2);margin-bottom:2px}
.scqcell b i{font-style:normal;font-size:10.5px;color:#fff;background:var(--txt3);
border-radius:3px;padding:0 3px;margin-left:4px;vertical-align:1px}
.scqcell span{display:block;font-size:10.5px;color:var(--txt3);line-height:1.55}
.scqcell span.act{color:var(--txt2)}
.scqfoot{margin:8px 0 0;padding-top:6px;border-top:1px solid var(--line);
font-size:10.5px;color:var(--txt3);line-height:1.55}
.scqstk{margin:0;font-size:10.5px;color:var(--txt3);font-variant-numeric:tabular-nums}
/* 点中某一天的浮窗。锚在被点的点上（left/top 是点的百分比坐标），
   默认出现在点的右下方；靠右（px>60%）翻到左侧、靠下（py>52%）翻到上方。
   不跟随鼠标——移动端没有 hover，跟随毫无意义，固定锚点反而稳。 */
.scqplot{position:relative}
.scqtip{display:none;position:absolute;z-index:6;box-sizing:border-box;
min-width:230px;max-width:min(320px,calc(100% - 14px));
padding:7px 10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;
box-shadow:0 8px 28px rgba(23,32,54,.16);font-size:11.5px;color:var(--txt2);
line-height:1.65;font-variant-numeric:tabular-nums;pointer-events:none}
.scqtip.on{display:block}
.scqtip{transform:translate(10px,12px)}
.scqtip.rx{transform:translate(calc(-100% - 10px),12px)}
.scqtip.ry{transform:translate(10px,calc(-100% - 12px))}
.scqtip.rx.ry{transform:translate(calc(-100% - 10px),calc(-100% - 12px))}
.scqtip b{color:var(--txt);font-weight:600}
.scqtip i{font-style:normal;color:var(--txt);font-weight:700}
.scqtip em{font-style:normal;color:var(--txt3)}
.scqtip .esc{font-size:10.5px}
.scqplot svg{cursor:crosshair}
/* 电脑为主：图独占一行、放到 1000px，统计和描述缩到图下方一行。
   原来的三栏（360 图 + 190 统计 + 1fr 说明）在 1440 屏上图只有 360px，
   而右边 660px 全是小字——主次反了。 */
/* 图占满左侧，统计和一句话判断缩进右侧 292px。
   用 1000px 定宽会把卡片右边空出 400px，而散点图本来还能再宽。 */
.scqbody{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:18px;
  align-items:start;margin-top:4px}
.scqplot{max-width:none}
.scqplot svg{display:block;width:100%;height:auto}
.scqplot svg.m{display:none}
.scqax{display:flex;justify-content:flex-start;gap:16px;flex-wrap:wrap;
font-size:10.5px;color:var(--txt3);line-height:1.5;margin-top:1px}
/* 底部三块按图宽三等分：图 1000px，三项挤在左边 500px 会留下半屏空白，
   而且和上面的图对不齐。等分后每块一个竖排单元，读起来像一行表头。 */
.scqfoot{margin-top:0}
.scqstats{display:flex;flex-direction:column;gap:10px;
  padding:0 0 9px;border-bottom:1px solid var(--line)}
.scqe{display:flex;align-items:baseline;gap:6px;cursor:help}
.scqe>span{font-size:10.5px;color:var(--txt3);flex:none}
.scqe b{font-size:17px;color:var(--txt);font-variant-numeric:tabular-nums;letter-spacing:-.4px}
.scqe em{font-style:normal;font-size:10.5px;color:var(--txt3);line-height:1.45}
.scqdesc{display:flex;flex-direction:column;gap:5px;padding-top:0;min-width:260px;flex:1;max-width:680px}
.scqd{margin:0;font-size:12.5px;color:var(--txt2);line-height:1.7}
.scqnote{margin:0;font-size:10.5px;color:var(--txt3);line-height:1.75}
@media(max-width:820px){
  .scqbody{grid-template-columns:1fr;gap:4px}
  .scqplot{max-width:100%}
  /* 窄屏换成 360 画布，字号在原尺寸渲染，不再缩成 5px */
  .scqplot svg.d{display:none}
  .scqplot svg.m{display:block}
  .scqfoot{margin-top:4px}
  /* 三项等宽并排、各自竖排。横排 wrap 会在 390px 下折成 2+1，
     第三项孤零零占一整行，看着像漏了一块。 */
  .scqstats{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 8px;padding-top:6px}
  .scqe{flex-direction:column;align-items:flex-start;gap:0}
  .scqdesc{padding-top:6px;min-width:0}
}
@media(max-width:560px){.scq{padding:7px 9px 5px}.scqe b{font-size:15px}.scqnote{font-size:10.5px}}

/* ---- 自选导入导出 ---- */
#ioMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:80;display:none;
align-items:center;justify-content:center;padding:18px}
#trigMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:80;display:none;
align-items:center;justify-content:center;padding:18px}
#trigMask.on,#ioMask.on{display:flex}
.trigrule{border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin-bottom:9px;background:var(--bg)}
.trigrule.off{opacity:.55}
.trigrule .trow{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap}
.trigrule select,.trigrule input[type=text]{border:1px solid var(--line);border-radius:5px;
  background:var(--bg2);color:var(--txt);padding:4px 6px;font-size:12.5px;outline:none}
.trigrule input[type=text]{width:78px;font-family:var(--mono)}
.trigrule .tand{font-size:11.5px;color:var(--txt3);margin-left:2px}
.trigrule .tdel,.trigrule .tcdel{cursor:pointer;color:var(--txt3);font-size:13.5px;padding:0 4px;user-select:none}
.trigrule .tdel:hover,.trigrule .tcdel:hover{color:var(--down)}
.trigrule .tadd{cursor:pointer;color:var(--accent);font-size:11.5px;user-select:none}
.trigrule .tname{font-size:11.5px;color:var(--txt3)}
.trigcnt{font-size:11.5px;color:var(--txt3);line-height:1.65;margin-top:4px}
/* 隔夜/亚太条目点击看分时：可点的条目加指针和悬停反馈 */
.onfut span.ovclk{cursor:pointer}
.onfut span.ovclk:hover,.ontrk:hover{border-color:var(--txt3)}
#ovMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:80;display:none;
align-items:center;justify-content:center;padding:18px}
#ovMask.on{display:flex}
#ovBody svg{display:block;width:100%;height:auto}
.ovmeta{display:flex;gap:8px 16px;flex-wrap:wrap;font-size:11.5px;color:var(--txt2);
margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)}
#ioMask.on{display:flex}
.iobox{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:470px;box-shadow:0 8px 28px rgba(23,32,54,.16);overflow:hidden}
.iohd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line);
font-size:13.5px}
.iobody{padding:13px 14px}
.iotip{font-size:11.5px;color:var(--txt3);line-height:1.65;margin-bottom:9px}
#ioTxt{width:100%;height:104px;resize:vertical;font-family:var(--mono);font-size:12.5px;
line-height:1.7;padding:9px 10px;border:1px solid var(--line);border-radius:7px;
background:var(--bg);color:var(--txt);outline:none;box-sizing:border-box}
#ioTxt:focus{border-color:var(--accent)}
.iobar{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.iobar .iom{font-size:11.5px;color:var(--txt3);margin-left:auto}

/* ---- 因子研究面板 ---- */
#rsMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:70;display:none;
align-items:center;justify-content:center;padding:18px}
#rsMask.on{display:flex}
.rspanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:900px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 8px 28px rgba(23,32,54,.16)}
.rshd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line)}
/* 标题不许被压缩换行：以前「因子研究」在 390px 屏上会折成「因子/研究」两行，
   还把日期挤到旁边，看着像排版坏了。标题固定宽度，元信息自己换行。 */
.rshd b{font-size:14.5px;white-space:nowrap;flex:0 0 auto}
.rshd .sub{font-size:11.5px;color:var(--txt3);font-family:var(--mono);
min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsbody{overflow-y:auto;padding:14px}
.rssec{margin-bottom:18px}
.rssec h4{font-size:12.5px;color:var(--txt2);font-weight:600;margin-bottom:8px;
letter-spacing:.3px;display:flex;align-items:center;gap:7px}
.rssec h4::after{content:'';flex:1;height:1px;background:var(--line)}
.rsk{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.rsk .i{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.rsk .i .k{font-size:10.5px;color:var(--txt3);margin-bottom:3px}
.rsk .i .v{font-size:17px;font-family:var(--mono);font-weight:600}
.rsk .i .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
.rstbl{width:100%;border-collapse:collapse;font-size:11.5px}
/* 这几张表列多，手机上宽度不够时**宁可横向滚动**也不能把数字裁掉。
   之前直接裁在容器里，"最大回撤"和后面几列在 390px 宽的屏上完全看不见，
   但页面不报错、也不溢出，属于最难发现的一类排版 bug。 */
.rstwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.rstwrap::-webkit-scrollbar{height:4px}
.rstwrap::-webkit-scrollbar-thumb{background:var(--line);border-radius:2px}
/* 指标说明表是整段说明文字，该换行而不是横向滚。
   权重必须写成 .rstbl.indtbl，否则会被下面 .rstbl td 的 nowrap 盖掉。 */
.rstbl.indtbl td{white-space:normal}
.rstbl th{text-align:right;font-weight:500;color:var(--txt3);padding:5px 7px;
border-bottom:1px solid var(--line);font-size:10.5px;white-space:nowrap}
.rstbl th:first-child,.rstbl td:first-child{text-align:left}
.rstbl td{padding:4px 7px;border-bottom:1px solid rgba(38,44,55,.5);
font-family:var(--mono);text-align:right;white-space:nowrap}
.rstbl tr:hover td{background:var(--bg3)}
.rsnote{font-size:11.5px;color:var(--txt2);line-height:1.85;background:var(--bg3);
border-left:2px solid var(--accent);border-radius:0 6px 6px 0;padding:9px 12px}
.rsnote b{color:var(--txt)}
.rsnote .warn{border-left-color:var(--up)}
/* ---- 第二批因子：净值图、敏感性网格 ---- */
.labchart{background:var(--bg3);border:1px solid var(--line);border-radius:8px;
padding:10px 12px 6px;margin-top:10px}
.labchart svg{display:block;width:100%;height:auto;overflow:visible}
.labchart .cap{font-size:10.5px;color:var(--txt3);line-height:1.6;margin-top:6px}
.lablg{display:flex;gap:14px;font-size:10.5px;color:var(--txt2);margin-bottom:4px;flex-wrap:wrap}
.lablg i{display:inline-block;width:15px;height:2.5px;vertical-align:middle;margin-right:5px;border-radius:2px}
/* 两期热力表并排，窄屏自动上下叠 */
.labgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}
.labgrid .box{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.labgrid .box h5{font-size:10.5px;color:var(--txt3);font-weight:500;margin-bottom:6px}
.labgrid table{width:100%;border-collapse:collapse;font-size:11.5px;font-family:var(--mono)}
.labgrid th{font-size:10.5px;color:var(--txt3);font-weight:400;text-align:center;padding:3px 2px}
.labgrid td{text-align:center;padding:4px 2px;border-radius:3px}
.labgrid td.n{color:var(--txt3)}
.labtabs{display:flex;gap:6px;margin:0 0 9px;flex-wrap:wrap}
.labtabs button{padding:4px 11px;font-size:11.5px;border-radius:14px;background:var(--bg3);
border:1px solid var(--line);color:var(--txt2);cursor:pointer;font-family:inherit}
.labtabs button.on{background:rgba(76,141,255,.15);border-color:var(--accent);color:var(--txt)}
.labtbl td.nm{text-align:left;font-family:inherit;color:var(--txt3);white-space:normal;
font-size:10.5px;line-height:1.5;max-width:270px}
.labtbl td.fam{text-align:left;font-family:inherit;color:var(--txt3);font-size:10.5px;white-space:nowrap}
/* ---- 因子明细：点一行展开构造方式 ---- */
.fxtbl tr.fxr{cursor:pointer}
.fxtbl tr.fxr.on td{background:rgba(59,130,246,.10)}
.fxtbl tr.fxx{display:none}
.fxtbl td.fxnm{text-align:left;color:var(--txt2);font-family:inherit;white-space:normal}
.fxdet td{padding:0 0 7px!important;border-bottom:1px solid var(--line)!important;
text-align:left!important;white-space:normal!important;font-family:inherit!important;background:transparent!important}
.fxd{background:var(--bg);border-left:2px solid var(--accent);border-radius:0 7px 7px 0;padding:10px 13px}
.fxdn{font-size:11.5px;color:var(--txt2);margin-bottom:5px}
.fxdn b{color:#0e7490;font-family:var(--mono);font-weight:600;margin-right:7px}
.fxds{font-size:11.5px;color:var(--txt2);line-height:1.7;margin-bottom:8px}
.fxf{font-family:var(--mono);font-size:10.5px;color:#2a2f38;background:var(--bg3);
border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;
white-space:pre-wrap;word-break:break-word;line-height:1.75}
.rsmore{margin-top:9px;text-align:center}
.rsmore button{font-size:11.5px;padding:5px 14px;border-radius:6px}
.rssrc{font-size:10.5px;color:var(--txt3);margin-top:10px;text-align:right}
/* /research 是独立页面：复用同一份 DOM，把遮罩层改成文档流里的整页布局。
   好处是因子面板只有一套 HTML 和一套渲染代码，不会出现「弹窗里对、页面上错」。 */
.rback{display:none;font-size:11.5px;color:var(--txt2);text-decoration:none;padding:2px 8px;
border:1px solid var(--line);border-radius:5px;white-space:nowrap}
.rback:hover{color:var(--txt)}
body.rsmode{overflow:auto}
body.rsmode .wrap{display:none}
body.rsmode #rsMask{position:static;inset:auto;display:block;background:none;padding:0;
max-width:1120px;margin:0 auto}
body.rsmode .rspanel{max-width:none;max-height:none;border:0;border-radius:0;
background:transparent;box-shadow:none;overflow:visible}
body.rsmode .rshd{position:sticky;top:0;z-index:5;background:var(--bg);
border-bottom:1px solid var(--line);padding:12px 20px}
body.rsmode .rshd b{font-size:15px}
body.rsmode .rback{display:inline-block;margin-right:2px}
body.rsmode .rshd .hx{display:none}
body.rsmode .rsbody{overflow:visible;padding:18px 20px 60px}
@media(max-width:700px){
  .rsbody{padding:10px}
  /* 窄屏：标题和返回按钮占一行，日期/样本区间整体降到第二行 */
  .rshd{flex-wrap:wrap;gap:4px 8px;padding:9px 12px}
  .rshd .sub{flex:1 1 100%;order:9;white-space:normal;line-height:1.5}
  .rstbl{font-size:10.5px}
  .rstbl th,.rstbl td{padding:3px 4px}
  /* 列多的表给个宽度下限：窄屏下让它横向滚动，而不是把数字挤成省略或直接裁掉。
     指标说明表是整段文字，折行更好读，所以单独放开。 */
  .rstwrap>.rstbl{min-width:480px}
  .rstwrap>.btbl{min-width:620px}
  .rstwrap>.fxtbl{min-width:540px}
  .rstwrap>.indtbl{min-width:0}
  .rstwrap>.ytbl{min-width:0}
  .rstwrap>.labtbl{min-width:680px}
  /* 表格右侧被裁一半的样子容易被当成本站坏了，标一句「能滑」。
     只对会横向滚动的那几张表显示，指标说明表换了行不需要。 */
  .rssec:has(.rstwrap>table:not(.indtbl)) > h4::after{
    content:'  ← 左右滑动看全部列';color:var(--txt3);font-weight:400;font-size:10.5px}
}

/* ---------- 板块地图 ---------- */
.smhead{display:flex;align-items:baseline;gap:6px 12px;flex-wrap:wrap;margin-bottom:8px;
  font-size:11.5px;color:var(--txt2)}
.smhead b{font-variant-numeric:tabular-nums}
/* 三组（A股/港股/跨境）各自可折起。组头一行放得下「几个板块/合计/最强/最弱/分化/涨跌」，
   收起后这行本身就是摘要，不用点开也能看个大概。 */
.sgrp{margin-top:9px}
.sgrp:first-child{margin-top:0}
.sghd{display:flex;align-items:center;gap:3px 10px;flex-wrap:wrap;cursor:pointer;
  padding:5px 9px;margin-bottom:6px;border:1px solid var(--line);border-radius:6px;
  background:var(--bg3);font-size:11.5px;color:var(--txt2);user-select:none}
.sghd:hover{border-color:#c3cad8}
.sghd .sgc{width:0;height:0;flex:none;margin-right:2px;
  border-left:4.5px solid var(--txt3);border-top:3.5px solid transparent;
  border-bottom:3.5px solid transparent;transform:rotate(90deg);transition:transform .12s}
.sgrp.fold .sghd .sgc{transform:rotate(0)}
.sghd .sgk{font-size:12.5px;font-weight:700;color:var(--txt);letter-spacing:.2px}
.sghd .sgt{color:var(--txt3)}
.sghd .sgm{white-space:nowrap}
.sghd .sgm b{font-variant-numeric:tabular-nums}
/* 集中度后面那个小数字是「近一年分位」，不是百分比，所以做得比正文轻一档，
   避免被读成「集中 53.0% 的 89%」。 */
.sghd .sgm em{font-style:normal;color:var(--txt3);font-size:10.5px;margin-left:2px}

@media(max-width:880px){.sghd .sgm.opt{display:none}}
.sgrp.fold .smgrid,.sgrp.fold .sdet,.sgrp.fold .scq{display:none}
.smgrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
@media(max-width:1180px){.smgrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:760px){
  .smgrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
  .scell{padding:6px 7px 5px}
  .scell .sn{font-size:10.5px}
  .scell .sv{font-size:14px}
  .scell .ss{font-size:10.5px;gap:2px}
  .scell .sbar{display:none}
}
.scell{border:1px solid var(--line);border-radius:7px;padding:7px 9px 6px;background:var(--bg2);
  cursor:pointer;position:relative;overflow:hidden}
.scell:hover{border-color:#c3cad8}
.scell.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
/* 主题分界：AI / 新能源是跨行业的，虚线上方是行业格、下方是主题格。
   边框也用虚线，一眼能看出「这两格不能和上面的加在一起」。 */
.sth{grid-column:1/-1;display:flex;align-items:center;gap:6px;margin:4px 0 0;
  padding-top:6px;border-top:1px dashed #d7dce5;font-size:10.5px;color:var(--txt3)}
.sth b{color:var(--txt2);font-weight:600}
.scell.th{border-style:dashed}
.scell .sn{font-size:11.5px;color:var(--txt);display:flex;align-items:baseline;gap:4px}
/* 箭头紧跟板块名，不推到格子右边：右对齐时它正好落在「-3.25%」上方，
   读起来像涨跌幅的一部分。 */
.scell .sn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.scell .sn .sd{flex:none;font-size:10.5px;font-weight:700;
  font-variant-numeric:tabular-nums;letter-spacing:-.2px}
.scell .sv{font-size:16px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;
  letter-spacing:-.2px}
.scell .ss{font-size:10.5px;color:var(--txt3);margin-top:1px;
  font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:3px}
.scell .ss .si{white-space:nowrap}
.scell .ss .sa{color:var(--txt3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scell .sn .sd.up{color:var(--up)}
.scell .sn .sd.down{color:var(--down)}
.scell .sn .sd.na{color:var(--txt3);font-weight:400;opacity:.55}
.scell .sbar{height:3px;border-radius:2px;background:var(--bg3);margin-top:7px;overflow:hidden}
.scell .sbar i{display:block;height:3px;border-radius:2px;background:var(--txt3);opacity:.55}
.scell .sz{position:absolute;left:0;top:0;bottom:0;width:2.5px}
.sdet{margin-top:9px;border-top:1px dashed var(--line);padding-top:7px;display:none}
.sdet.show{display:block}
.sdet .sdhd{font-size:11.5px;color:var(--txt3);margin-bottom:4px}
/* 明细两列：指数多的时候（新能源 6 条、计算机 19 条）单列会把面板拉得很长，
   两列在 1500px 下正好，窄屏退回单列。 */
/* 用多列而不是 grid：这一列是按涨幅排序的，要竖着读。grid 是行优先，
   第二行会跳到右边一列，读起来是横着串的。column-rule 顺带把两列分开。 */
.sdet .sdrwrap{column-count:3;column-gap:26px;column-rule:1px solid #d7dce5}
@media(max-width:1240px){.sdet .sdrwrap{column-count:2}}
@media(max-width:900px){.sdet .sdrwrap{column-count:1}}
.sdet .sr{display:flex;gap:9px;align-items:baseline;padding:3px 0;font-size:11.5px;
  border-bottom:1px dotted var(--line)}
.sdet .sr:last-child{border-bottom:0}
.sdet .sr .nm2{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdet .sr .cd2{font-family:var(--mono);color:var(--txt3);font-size:10.5px;width:52px;text-align:right}
.sdet .sr .v2{font-variant-numeric:tabular-nums;width:56px;text-align:right;font-weight:600}
.sdet .sr .a2{font-variant-numeric:tabular-nums;width:62px;text-align:right;color:var(--txt3)}
/* ---------- 盘中提醒 ---------- */
.alertbar{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.abtn{cursor:pointer;padding:2px 9px;border-radius:20px;border:1px solid var(--line);
  color:var(--txt2);background:var(--bg2);white-space:nowrap;font-size:11.5px;user-select:none}
.abtn:hover{border-color:#c3cad8}
.abtn.on{background:#fdeeee;border-color:#f3c7c7;color:#b02a2a}
.abtn.on i{display:inline-block;width:5px;height:5px;border-radius:50%;background:#d93a3a;
  margin-right:4px;vertical-align:1px}
.aset{display:none;align-items:center;gap:5px;color:var(--txt3);font-size:11.5px}
.aset.show{display:inline-flex}
.aset input{width:40px;padding:1px 3px;font-size:11.5px;border:1px solid var(--line);
  border-radius:4px;background:var(--bg2);color:var(--txt);text-align:center;
  font-variant-numeric:tabular-nums}
.aset input:focus{outline:none;border-color:var(--accent)}
#alertBox{position:fixed;right:14px;top:14px;z-index:999;display:flex;flex-direction:column;
  gap:6px;pointer-events:none}
.aitem{background:var(--bg2);border:1px solid var(--line);border-left:3px solid var(--txt3);
  border-radius:6px;padding:7px 11px;box-shadow:0 3px 12px rgba(23,32,54,.1);font-size:12.5px;
  min-width:220px;max-width:300px;animation:ain .18s ease-out}
@keyframes ain{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
.aitem.up{border-left-color:var(--up)}
.aitem.dn{border-left-color:var(--down)}
.aitem b{font-size:12.5px;font-variant-numeric:tabular-nums}
.aitem small{display:block;color:var(--txt2);font-size:11.5px;margin-top:2px;line-height:1.4}
/* 提醒记录：浮层只停 9 秒，全市场模式下这个列表才是主要出口 */
#alertLog{position:fixed;right:14px;top:52px;z-index:998;width:min(340px,calc(100vw - 24px));
  max-height:64vh;background:var(--bg2);border:1px solid var(--line);border-radius:8px;
  box-shadow:0 8px 28px rgba(23,32,54,.16);display:none;flex-direction:column;overflow:hidden}
#alertLog.show{display:flex}
#alertLog .lh{padding:8px 11px;border-bottom:1px solid var(--line);font-size:12.5px;
  color:var(--txt3);display:flex;align-items:center;gap:8px;flex:none}
#alertLog .lh b{color:var(--txt);font-size:12.5px}
#alertLog .lh u{margin-left:auto;cursor:pointer;text-decoration:none;color:var(--txt3)}
#alertLog .lh u:hover{color:var(--txt)}
#alertLog .lb{overflow-y:auto;padding:2px 0}
#alertLog .li{padding:5px 11px;font-size:11.5px;border-left:2px solid transparent;
  display:flex;gap:7px;align-items:baseline}
#alertLog .li.up{border-left-color:var(--up)}
#alertLog .li.dn{border-left-color:var(--down)}
#alertLog .li em{font-style:normal;color:var(--txt3);font-variant-numeric:tabular-nums;flex:none}
#alertLog .li i{font-style:normal;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#alertLog .le{padding:18px 11px;text-align:center;color:var(--txt3);font-size:12.5px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>ETF 全市场盯盘 <em id="clock">--:--:--</em></h1>
  <div class="sp"></div>
  <span class="dot" id="d-src"><i></i><span id="srcName">连接中</span></span>
  <a id="btnRs" href="/research" title="201 个因子的 IC 检验、样本外回测与 PE 策略">因子研究</a>
</header>

<nav class="secnav" id="secNav" aria-label="区块导航">
  <a data-t="onCard">隔夜</a>
  <a data-t="secSec">板块地图</a>
  <a data-t="spdSec">急涨急跌</a>
  <a data-t="watchSec">自选</a>
  <a data-t="rankSec">清单</a>
</nav>

<div class="oncard" id="onCard" style="display:none"></div>
<div class="oncard" id="asiaCard" style="display:none"></div>

<div class="sec" id="secSec">
  <div class="sechd"><b>板块地图</b><span class="n" id="secN">-</span>
    <span class="sync" id="btnSec" title="丢掉缓存，按最新快照重算">重算</span></div>
  <div class="smhead" id="secHead"><span>读取中…</span></div>
  <div class="secmeta" id="secMeta"></div>
  <div id="secBody"><div class="empty">正在读取行情…</div></div>
</div>

<div class="cards">
  <div class="card"><div class="k">全市场 ETF</div><div class="v" id="cTotal">-</div><div class="s" id="cUni">-</div></div>
  <div class="card"><div class="k">涨 / 跌</div><div class="v" id="cUD">-</div><div class="s" id="cUDs">-</div></div>
  <div class="card"><div class="k">全市场成交额</div><div class="v" id="cAmt">-</div><div class="s">合计</div></div>
  <div class="card"><div class="k">今日诊断信号</div><div class="v" id="cSig">-</div><div class="s" id="cSigs">按位置 × 量能给标签</div></div>
</div>


<div class="sec" id="spdSec">
  <div class="sechd"><b>急涨急跌</b><span class="n" id="spdN">-</span>
    <span class="sync" id="btnSpd" title="立刻重算一次">刷新</span></div>
  <div class="dnote">上面那栏看「今天」，这一栏看「刚才」：过去几分钟谁在急拉、谁在急砸，量跟不跟得上。</div>
  <div class="mkbox">
    <div class="mtabs" id="spdTabs">
      <span class="mtab on" data-w="3">3 分钟</span>
      <span class="mtab" data-w="5">5 分钟</span>
      <span class="mtab" id="spdVol" title="量比低于 1.5 倍的不显示">只看放量</span>
    </div>
    <div class="spdgrid" id="spdGrid"><div class="empty">读取中…</div></div>
    <div class="spdnote" id="spdNote"></div>
  </div>
</div>

<div class="sec" id="watchSec">
  <div id="staleBar" class="stalebar" style="display:none"></div>
  <div class="sechd"><b>自选盯盘</b><span class="n" id="watchN"></span>
    <span class="io" id="btnIO" title="导出一行代码清单，或粘贴清单导入（只追加，不覆盖）">导入/导出</span></div>
  <div class="bar">
    <input id="addIn" placeholder="添加代码，支持逗号批量：510300,513180" style="width:290px">
    <button class="pri" id="btnAdd">添加</button>
    <button id="btnClear">清空</button>
    <span class="alertbar">
      <span class="abtn" id="btnAlert" title="在页面开着的时候，出现异动就提醒你（浏览器通知 + 页面浮层）">提醒 关</span>
      <span class="abtn" id="btnScope" title="自选：逐只提醒，5 秒一刷。全市场：扫同指数去重后的代表标的（500 只上下，一只一个指数），只弹汇总和极端个股，60 秒一刷——一只不漏地逐只弹，一天几百条，弹到第二次就没人看了">范围 自选</span>
      <span class="aset" id="alertSet">
        涨跌≥<input id="aChg" value="2.0">%
        急变≥<input id="aSpd" value="0.8">%/3分
        溢价≥<input id="aPm" value="2.0">%
        <span class="abtn" id="btnPerm" title="允许后，页面在后台也能弹系统通知">桌面通知</span>
      </span>
      <span class="abtn" id="btnLog" style="display:none" title="今天触发过的全部提醒，浮层只停留 9 秒，点这里回看">0 条</span>
      <span class="abtn" id="btnTrig" title="自定义组合触发器：自己拼条件（距新高、量能、位置、溢价……），全部满足才提醒">触发器 0</span>
    </span>
    <span class="n" id="quoteTip" style="font-size:11.5px;color:var(--txt3)"></span>
  </div>
  <div class="tbl"><table>
    <thead><tr>
      <th class="l">代码</th><th class="l">名称</th><th>现价</th><th>涨跌%</th>
      <th class="hide-md" title="贡献最大的三只成分股。贡献 = 权重 × 今日涨跌（百分点），
按绝对值排——涨的时候看谁在拉，跌的时候看谁在砸">主要贡献</th>
      <th>涨跌</th>
      <th class="ctr">溢价率</th><th>IOPV</th><th>成交额</th><th>换手</th>
      <th class="hide-sm">振幅</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th>
      <th class="ctr" style="width:36px"></th>
    </tr></thead>
    <tbody id="watchBody"><tr><td colspan="14" class="empty">加载中…</td></tr></tbody>
  </table></div>
</div>

<div class="sec">
  <div class="sechd"><b>今日变化</b><span class="n" id="evtN"></span></div>
  <div class="dnote">只看「相比昨天变了什么」，没发生事的标的不会出现——空白本身是信息。</div>
  <div class="split">
    <div class="evtbox" id="evtList"><div class="empty">正在读取历史…</div></div>
    <div class="portbox" id="portBox"><div class="empty">组合体检需要至少 2 只自选</div></div>
  </div>
</div>

<div class="sec" id="diagSec">
  <div class="sechd"><b>位置诊断</b><span class="n" id="diagN">-</span>
    <span class="sync" id="btnDiag" title="丢掉缓存，重新读一遍历史">重算</span></div>
  <div class="dnote">行情软件告诉你今天涨了多少；这一栏告诉你它站在近一年区间的什么位置、量能配不配合。</div>
  <div class="dgrid" id="diagGrid"><div class="empty">正在读取历史…</div></div>
</div>

<div class="sec" id="mktSec">
  <div class="sechd"><b>全市场异动</b>
    <span class="n" id="mktN" title="剔除债券货币，一个指数只留流动性最好的一只 ETF；上市不满半年、当日无成交的不计入">-</span>
    <span class="sync" id="btnMkt" title="重新读一遍收盘快照">刷新</span></div>
  <div class="dnote">跳出自己的自选池：全部指数今天谁创新高、谁在放量、谁在破位。一个指数只留流动性最好的那只 ETF。</div>
  <div class="mkbox" style="margin-bottom:9px">
    <div class="wstat" id="mktWidth"><span>读取中…</span></div>
    <div class="wbar" id="mktBar"></div>
    <div class="wstat" id="mktWidth2"></div>
  </div>
  <div class="mktwrap">
    <div class="mkbox">
      <div class="mtabs" id="mktTabs"></div>
      <div id="mktList"><div class="empty">读取中…</div></div>
    </div>
  </div>
</div>

<div class="sec" id="rankSec">
  <div class="sechd"><b>全市场清单</b><span class="n" id="listN"></span></div>
  <div class="bar">
    <span class="tag on" data-g="all">全部<b id="n-all"></b></span>
    <span class="tag" data-g="broad">宽基<b id="n-broad"></b></span>
    <span class="tag" data-g="cross">跨境<b id="n-cross"></b></span>
    <span class="tag" data-g="industry">行业主题<b id="n-industry"></b></span>
    <span class="tag" data-g="bond">债券<b id="n-bond"></b></span>
    <span class="tag" data-g="money">货币<b id="n-money"></b></span>
    <span class="tag" data-g="commodity">商品<b id="n-commodity"></b></span>
    <span class="tag on" id="dedupTag" title="同一跟踪指数的多只 ETF 只保留成交额最大的一只。点击切换">同指数去重<b id="n-dedup"></b></span>
    <input id="q" placeholder="搜索代码/名称">
    <select id="sortSel">
      <option value="amt">按成交额</option>
      <option value="chg">按涨幅</option>
      <option value="chgA">按跌幅</option>
      <option value="tr">按换手率</option>
      <option value="pm">按溢价率</option>
    </select>
    <select id="limitSel">
      <option value="50">前 50</option>
      <option value="100" selected>前 100</option>
      <option value="200">前 200</option>
      <option value="500">前 500</option>
      <option value="9999">全部</option>
    </select>
    <button id="btnProbe">源自检</button>
  </div>
  <div class="tbl"><table>
    <thead><tr>
      <th class="l">代码</th><th class="l">名称</th><th>现价</th><th>涨跌%</th>
      <th class="ctr">溢价率</th><th>成交额</th><th>换手</th>
      <th class="hide-sm">振幅</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th>
      <th class="ctr" style="width:36px"></th>
    </tr></thead>
    <tbody id="listBody"><tr><td colspan="11" class="empty">加载中…</td></tr></tbody>
  </table></div>
</div>

<footer>
  <span id="fTs">-</span><span id="fSrc">-</span><span id="fErr" class="err"></span>
</footer>
</div>
<div id="toast"></div>
<div id="alertBox"></div>
<div id="alertLog"><div class="lh"><b>今日提醒</b><span id="logSub"></span><u id="logClr">清空</u></div><div class="lb" id="logBody"></div></div>

<div id="histMask">
  <div class="hpanel">
    <div class="hhd">
      <span class="nm" id="hName">-</span>
      <span class="cd" id="hCode"></span>
      <span class="px" id="hPx">-</span>
      <span class="ch" id="hChg"></span>
      <div class="hmodes" id="hMode">
        <b data-m="min">分时</b><b data-m="k">K线</b><b data-m="hold">成分</b>
      </div>
      <div class="htabs" id="hTabs">
        <span data-r="63">3M</span>
        <span data-r="126">6M</span>
        <span data-r="250" class="on">1Y</span>
        <span data-r="0">全部</span>
      </div>
      <button class="hx" id="hClose" title="关闭 (Esc)">×</button>
    </div>
    <div class="hsbar" id="hSbar">
      <span class="lb">副图</span>
      <span class="sg" id="hSubs">
        <b data-s="rsi" class="on">RSI</b><b data-s="macd">MACD</b><b data-s="vr">量比</b><b data-s="hvol">波动率</b><b data-s="atr">ATR</b><b data-s="pb">BOLL%B</b>
      </span>
      <span class="lb">叠加</span>
      <span class="sg" id="hOv">
        <b data-o="ma" class="on">均线</b><b data-o="boll">布林</b>
      </span>
    </div>
    <canvas id="histCv"></canvas>
    <div class="hhold" id="hHold">
      <div class="hholdhd" id="hHoldHd"></div>
      <div id="hHoldBody"></div>
    </div>
    <div class="hleg" id="hLeg"></div>
    <div class="hind" id="hInd"></div>
    <div class="hnote" id="hNote"></div>
  </div>
</div>

<div id="ioMask">
  <div class="iobox">
    <div class="iohd"><b>自选清单</b>
      <button class="hx" id="ioClose" title="关闭 (Esc)" style="margin-left:auto">×</button></div>
    <div class="iobody">
      <div class="iotip">一行代码，逗号、空格或换行分隔，多余的字符会被忽略。
        导入<b>只追加</b>，不会删掉现有自选；重复的自动跳过。</div>
      <textarea id="ioTxt" spellcheck="false" placeholder="510300, 513180, 515880"></textarea>
      <div class="iobar">
        <button id="ioCopy">复制清单</button>
        <button class="pri" id="ioImport">导入清单</button>
        <span class="iom" id="ioMsg"></span>
      </div>
    </div>
  </div>
</div>

<div id="trigMask">
  <div class="iobox" style="max-width:680px">
    <div class="iohd"><b>自定义触发器</b>
      <button class="hx" id="trigClose" title="关闭 (Esc)" style="margin-left:auto">×</button></div>
    <div class="iobody">
      <div class="iotip">一条规则里的多个条件是<b>且</b>的关系，全部满足才算命中；从「不满足」
        变成「满足」的那一刻触发一次，同一条规则同一只 30 分钟内不重复响。
        触发器随顶部「提醒」开关一起工作，通知走同一条通道。
        带 ⏳ 的条件要等页面把该自选的历史拉完才生效（位置/量能类都从日线算）。</div>
      <div id="trigList"></div>
      <div class="iobar">
        <button class="pri" id="trigAdd">+ 新建规则</button>
        <span class="iom" id="trigMsg"></span>
      </div>
    </div>
  </div>
</div>

<div id="ovMask">
  <div class="iobox" style="max-width:760px">
    <div class="iohd"><b id="ovTitle">分时</b><span class="n" id="ovSub" style="font-size:11.5px;color:var(--txt3)"></span>
      <button class="hx" id="ovClose" title="关闭 (Esc)" style="margin-left:auto">×</button></div>
    <div class="iobody" id="ovBody"><div class="iotip">读取中…</div></div>
  </div>
</div>

<div id="rsMask">
  <div class="rspanel">
    <div class="rshd">
      <a class="rback" href="/">← 盯盘</a>
      <b>因子研究</b>
      <span class="sub" id="rsSub"></span>
      <button class="hx" id="rsClose" title="关闭 (Esc)" style="margin-left:auto">×</button>
    </div>
    <div class="rsbody" id="rsBody"></div>
  </div>
</div>

<script>
'use strict';
var IDX_GROUPS = {"中证港股通内地金融港元":["158000","159091","513190","526090"],"国证价值100":["158001","158043","159037","159042","159079","159085","159096","159098","159263"],"中证港股通医疗主题":["158003","159137","159167","159366","513620","520510","520850","526010"],"中证工程机械主题":["158005","159065","159070","159138","159161","159177","159542","512420","515970","516250","516440","560280","560920","561030","561070"],"细分化工":["158006","158017","158032","159082","159087","159093","159129","159133","159870","516020","516120","516220","561620"],"国证储能电池":["158008","159052","159071","159193","159305","159566"],"国证航天航空行业":["158009","158013","158030","159208","159227","159241","159267"],"中证医疗":["158010","159828","159847","512170","560260"],"创业板软件":["158011","158072","159107","159256"],"中证云计算50":["158012","159095","159099","560660","562110"],"中证电池主题":["158019","159077","159147","159155","159160","159175","159796","512460","560410","560910","561160","561910","562880"],"创业板综合":["158022","159287","159288","159289","159290","159291","159292","159293","159295","159541","159563"],"中证800红利低波动":["158023","159355","563980"],"创业板成长":["158025","159597"],"国证大盘成长":["158026","159203"],"中证工业互联网主题":["158027","159013","159075","159778"],"中证稀有金属主题":["158028","159045","159053","159055","159062","159608","159671","561050","561250","561390","561800"],"创业板人工智能":["158031","159242","159243","159246","159279","159363","159382","159388"],"中证卫星产业":["158036","158046","159218","512630","562420","563230","563530","563790"],"中证机器人":["158037","159213","159258","159526","159551","159770","560630","560770","562360","562500"],"国证粮食产业":["158038","158047","158065","159030","159031","159033","159038","159060","159063","159072","159073","159587","159698"],"标普港股通低波红利":["158039","159117","159118","159220","513630","520610"],"中证科创创业人工智能":["158040","159022","159139","159140","159141","159142","588410","588420","588430","588470","588480","588510","588530"],"创业板算力基础设施":["158041","158049","158050","158053","158055","158056","158057","158059","158061","158063"],"恒生科技":["158042","159740","159741","159742","513010","513130","513180","513260","513380","513580","513890","520570","520590","520920"],"中证金融科技主题":["158051","159086","159103","159299","159851","515720","516100","516860","562400","563570","563670"],"创业板金融科技":["158052","158058","158062","158067"],"中证大数据产业":["158066","515400","516000","516700"],"创业板电池":["158078","158079","158082"],"中证畜牧养殖":["159007","159011","159020","159023","159027","159165","159172","159865","159867","512450","516670","516760","561400","561470"],"中证全指证券公司":["159008","159058","159260","159841","159842","159848","512000","512570","512880","512900","515010","515560","515850","516200","560090","560400","562870"],"创业板新能源":["159009","159069","159076","159122","159149","159187","159190","159261","159368","159387"],"恒生港股通科技主题":["159010","159015","159120","159135","159152","159262","520670","520840"],"中证科创创业50":["159012","159603","159780","159781","159782","159783","588300","588310","588320","588330","588350","588360","588380","588390","588400","588660"],"中证证券公司30":["159016","159692","516730"],"国证石油天然气":["159017","159018","159019","159026","159148","159181","159189","159195","159197","159199","159588","159697"],"国证大盘价值":["159021","159391"],"中证家电龙头":["159025","159192","159328"],"恒生港股通汽车主题":["159028","159121","159186","159239","520730"],"中证有色金属矿业主题":["159029","159049","159163","159690","512940","560290","561330","561830","562450"],"中证工业有色金属主题":["159032","159157","159162","159168","159171","512470","515040","515540","560490","560860","560870","560970"],"中证软件服务":["159035","159852","560360","560790","562930"],"中证全指软件开发":["159036","561010"],"国证机器人产业":["159039","159048","159050","159272","159278","159530","159559"],"中证港股通互联网":["159040","159179","159568","159792","513040","513720","513770","520630","520650","520740","520790","520910"],"中证农业主题":["159041","159825","159827","512620","516810"],"中证全指食品":["159043","159151","515840","560130","560160","560320","560420","561020","563850"],"国证绿色电力":["159046","159061","159625","159669"],"中证港股通信息技术综合港元":["159047","159131","159185","159196","159198","513240","520710","520750","526000","526030","526050","526060"],"中证全指医疗器械":["159051","159056","159057","159797","159883","159898","561810","562600"],"中证全指电力公用事业":["159059","159146","159158","159611","512140","516370","560270","560450","560460","560480","560580","560830","560930","561560","561700","562350"],"中证A股":["159066","159078","515440","561730","561890","563330"],"中证全指软件":["159068","159590","159899","515230"],"中证红利低波动100":["159083","159228","159307","159549","515100","515480","560520","560720"],"国证港股通互联网":["159089","159170","159280"],"巴西BOVESPA":["159100","520870"],"国证港股通科技":["159101","159125","159128","159191","159251","159636"],"恒生生物科技":["159102","159105","159132","159169","159615","159892","513280","513930","520760","520930"],"中证民企300":["159106"],"国证工业软件主题":["159108","159145","159180"],"恒生港股通50":["159109","520950"],"深证AAA科技创新公司债":["159110","159400"],"中证AAA科技创新公司债":["159111","159112","159113","159115","159116","159200","159600","159700","551500","551510","551520","551550","551560","551580","551800","551900"],"中证800自由现金流":["159119","159229","516460","563580","563680","563990"],"中证港股通50港元":["159126","159711","159712","513550"],"中证A50":["159136","159390","159591","159592","159593","159595","159596","512030","512240","512250","560350","560820","561230","561750","563080","563350"],"恒生港股通中国央企红利":["159143","513920"],"深证50":["159150","159350"],"国证消费电子主题":["159153","159178","159732"],"国证新能源车电池":["159156","159755","159757","159767","159775","159840"],"中证全指公用事业":["159159","159301","560190","560620"],"国证自由现金流":["159166","159201","159221","159222","159223","159225","159276"],"中证全指农牧渔":["159173","159275","560210"],"中证全指家用电器":["159176","159182","159996","515640","560880","561120"],"中证新能源汽车":["159183","159637","159806","159824","515030","516660"],"标普中国A股红利100":["159188"],"恒生互联网科技业":["159202","159688","513330"],"创业板指":["159205","159247","159675","159676","159808","159810","159821","159908","159915","159948","159952","159956","159957","159958","159964","159971","159977"],"国证商用卫星通信产业":["159206"],"中证智选高股息策略":["159207"],"中证全指红利质量":["159209","515460","560250","560370","561430","561490","561630","561650","562150","562200"],"中证港股通汽车产业主题":["159210","159237","159323","520600","520680","520720","520780"],"深证100":["159211","159212","159216","159219","159576","159706","159716","159721","159901","159961","159970","159975"],"中证A500":["159215","159226","159240","159249","159338","159339","159351","159352","159353","159356","159357","159358","159359","159360","159361","159362","159376","159379","159380","159386","512020","512050","512080","512370","560510","560530","560610","560750","561090","563220","563360","563500","563550","563600","563630","563650","563660","563800","563860","563880"],"国证港股通创新药":["159217","159286","159297","159567","159570"],"国证通用航空产业":["159230","159231","159255","159257","159378","159392"],"中证全指自由现金流":["159232","159233","159235","159236","512130","561080","561870","563390","563620","563760","563770","563780","563830"],"沪深300":["159238","159300","159330","159393","159673","159919","159925","510300","510310","510320","510330","510350","510360","510370","510380","510390","515130","515310","515330","515350","515360","515380","515390","515660","561000","561300","561930","562070","563520"],"国证港股通消费主题":["159245","159265","159268","159285"],"中证人工智能主题":["159248","159819","512930","515070","515470","561460"],"中证银行":["159253","512410","512700","512730","512800","512820","515020","515290","516210","516310","560670","561530"],"国证成长100":["159259"],"中证港股通央企红利":["159266","159281","159333","513910"],"中证港股通科技":["159269","159751","513020","513150","513560","513860","513980","520530","520860"],"创业板200":["159270","159571","159572","159573","159575"],"恒生指数":["159271","159920","513210","513600","513660"],"中证沪港深云计算产业":["159273","159738","517130","517230","517390"],"中证港股通高股息投资港元":["159277","159302","159331","513530","513820","513830","520810"],"中证通用航空主题":["159283","561660","563320","563870"],"中证A500红利低波动":["159296","560570","561680","562180","563510","563590"],"创业板50":["159298","159367","159369","159370","159371","159372","159373","159375","159383","159681","159682","159949"],"恒生医疗保健":["159303","159557","513060"],"中证汽车零部件主题":["159306","159565","512740","562700"],"中证油气资源":["159309","561760","563150"],"中证芯片产业":["159310","159560","159599","516350","516640","516920"],"中证数字经济主题":["159311","159658","560800"],"恒指港股通":["159312","159318","159365","520770","520820","520940","520960","526070"],"中证沪深港黄金产业股票":["159315","159321","159322","159562","517400","517520"],"恒生港股通创新药":["159316"],"恒生A股电网设备":["159320","515940","560390","561380"],"中证半导体行业精选":["159325"],"中证电网设备主题":["159326"],"中证半导体材料设备主题":["159327","159558","560780","562590"],"富时沙特阿拉伯":["159329","520830"],"中证中央企业红利":["159332","561580"],"中证诚通央企科技创新":["159335"],"中证诚通央企红利":["159336"],"中证500":["159337","159500","159610","159678","159820","159922","159935","159968","159982","510500","510510","510530","510550","510560","510570","510580","510590","512500","512510","515190","515530","515550","560100","560950","561350","561550","561950","563030","563750"],"创业板医药卫生":["159377"],"中证诚通国企数字经济":["159385","159389","561220"],"深证基准做市信用债":["159395","159396","159397","159398"],"富时中国A股自由现金流聚焦":["159399"],"纳斯达克100":["159501","159513","159632","159659","159660","159696","159941","513100","513110","513300","513390","513870"],"标普生物科技精选行业":["159502"],"国证2000":["159505","159521","159543","159628","159907"],"恒生港股通创新药及医疗保健":["159506"],"国证通信":["159507","159695"],"国证生物医药":["159508","159839","159859"],"纳斯达克科技市值加权":["159509"],"中证智选300价值稳健策略":["159510"],"中证国有企业红利":["159515","561060","563890"],"中证800":["159517","159800","515800","515810"],"S&POil&GasExploration&ProductionSelectIndustry":["159518","513350"],"中证香港内地国有企业港元":["159519","513810"],"中证消费龙头":["159520","516130"],"中证智选300成长创新策略":["159523"],"中证红利低波动":["159525","159547","512890","560150","560730","563020","563690"],"中证云计算与大数据主题":["159527","159739","159890","516510","516630"],"中证国有企业改革":["159528"],"标普500消费精选":["159529"],"中证2000":["159531","159532","159533","159535","159536","159552","159553","159555","159556","560220","561370","562660","563200","563300"],"国证信息技术创新主题":["159537","159538","159539","159540"],"恒生港股通红利低波动":["159545","513950","520550","520890"],"中证全指集成电路":["159546","562820"],"中证沪港深互联网":["159550","159729","159856","517050","517200"],"法兰克福DAX":["159561","513030"],"国证港股通红利低波动率":["159569"],"MSCIUSA50Index":["159577","513850"],"深证主板50":["159578"],"中证红利":["159581","159589","515080","515180","515890","560020"],"中证半导体产业":["159582","561980"],"中证通信设备主题":["159583"],"中证全指计算机":["159586"],"MSCI中国A50互联互通":["159601","159602","560050","563000","563280"],"中证海外中国互联网30":["159605","159607"],"中证500质量成长":["159606","560500","562340"],"中证光伏产业":["159609","159618","159857","159863","159864","515370","515790","516180","516230","516290","516880","560230","560310","561410","562970"],"标准普尔500":["159612","159655","513500","513650"],"中证信息安全主题":["159613","562920"],"中证农牧主题":["159616"],"中证智选500价值稳健策略":["159617"],"中证基建工程":["159619","159635","516950","516970"],"中证智选500成长创新策略":["159620"],"MSCICHINAARMBESGUNIVERSALINDEX":["159621"],"中证沪港深创新药产业":["159622","159748","517110","517120"],"中证成渝地区双城经济圈":["159623"],"中证A100":["159627","159630","159631","159661","159686","159923","512060","512910","560380","561180","561200","561770","561880","562000"],"中证1000":["159629","159633","159677","159679","159680","159685","159845","512100","516300","560010","560110","560590","561280","561590","561780"],"中证智选航空航天科技":["159638"],"中证上海环交所碳中和":["159639","159640","159641","159642","560060","560550","561190","562990"],"国证疫苗与生物科技":["159643","159645","159657"],"中证中药":["159647","560080","561510","562390"],"中债-1-5年国开行债券全价":["159649"],"中债-0-3年国开行债券全价":["159650","159651"],"细分有色":["159652","516650","560470"],"国证ESG300":["159653","159717"],"沪深300成长":["159656","562310"],"国证交通运输行业":["159662"],"中证机床":["159663","159667"],"国证半导体芯片":["159665","159801","159813","159995"],"中证全指运输":["159666"],"中证消费50":["159670","159798","515650"],"中证主要消费":["159672","159689","159928","512600","560680"],"富时亚太低碳精选":["159687"],"中证港股通高股息精选港元":["159691"],"恒生消费":["159699","513970","520520","520620"],"中证物联网主题":["159701","159895","159896","516260","516330"],"中证新材料主题":["159703","159761","159763","516360","516710","516890"],"中证800地产":["159707"],"深证红利":["159708","159905"],"深圳物联网50":["159709"],"中证稀土产业":["159713","159715","516150","516780"],"中证港股通医药卫生综合港元":["159718","159776","513200","513700"],"富时中国国企开放共赢":["159719","517090","517180"],"中证智能电动汽车":["159720","516380","516590"],"中证沪港深科技龙头":["159723","517350"],"中证线上消费主题":["159725"],"恒生港股通中国内地企业红利":["159726"],"国证在线消费":["159728"],"国证龙头家电":["159730"],"中证石化产业":["159731","516570"],"中证港股通消费主题港元":["159735","513070","513230","513590"],"中证食品饮料":["159736"],"中证湖北新旧动能转换":["159743"],"中证全指建筑材料":["159745","159787","516750"],"中证香港科技":["159747","159750"],"中证内地新能源主题":["159752","516270"],"中证红利质量":["159758"],"国证公共卫生与医疗健康":["159760"],"中证旅游主题":["159766","562510"],"中证内地地产主题":["159768"],"创业板科技":["159773","159777"],"中证消费电子主题":["159779","561100","561310","561600","562950"],"中证虚拟现实主题":["159786"],"中证港股通中国100港元":["159788"],"中证内地低碳经济主题":["159790","159885","516070","560560","562300"],"沪深300ESG基准":["159791","516830","560180","561900"],"中证沪港深线上消费主题":["159793"],"中证智能汽车主题":["159795","159888","159889","515250","516520"],"国证创业板中盘精选88":["159804"],"中证传媒":["159805","512980"],"中证科技50":["159807"],"中证5G产业50":["159811"],"黄金9999":["159812","159934","159937","518660","518800","518850","518880"],"创业板大盘":["159814","159991"],"中证0-4年期地方政府债":["159816"],"标普中国新经济行业":["159822"],"上海金":["159830","159831","159834","518600","518680","518860","518890"],"中证创新药产业":["159835","159858","159992","515120","516060","516080","560900"],"创业板300":["159836"],"中证生物科技主题":["159837","159849","516500","516930"],"中证医药50":["159838","515950"],"国证食品饮料行业":["159843"],"恒生中国企业":["159850","159954","159960","510900"],"中证影视主题":["159855","516620"],"中证环保产业50":["159861"],"细分食品":["159862","515170","515710"],"东京日经225":["159866","513000","513520","513880"],"中证动漫游戏":["159869","516010","516770"],"中证有色金属":["159871","159876","159881"],"中证车联网主题":["159872"],"中证全指医疗保健设备与服务":["159873","159877","159891","516610","516790"],"中证新能源":["159875","516090","516160","516580","516850"],"国证有色金属行业":["159880"],"细分机械":["159886","516960"],"中证800银行":["159887"],"中小企业100":["159902"],"深证":["159903","159943"],"深证成长40":["159906"],"深证电子信息传媒产业50":["159909"],"深证基本面120":["159910"],"深证300":["159912"],"深证300价值":["159913"],"深证基本面60":["159916"],"中小创业企业400":["159918"],"中证医药卫生":["159929"],"中证能源":["159930"],"中证金融地产":["159931","512640"],"沪深300金融地产":["159933"],"中证全指可选消费":["159936","562580"],"中证全指医药卫生":["159938"],"中证全指信息技术":["159939","562560"],"中证全指金融地产":["159940"],"中证全指原材料":["159944"],"中证全指能源":["159945"],"中证央企结构调整":["159959","512950","512960"],"央视财经50":["159965"],"创业板低波价值":["159966"],"创业板动量成长":["159967"],"中证5年期地方政府债":["159972"],"国证民企领先100":["159973"],"中证央企创新驱动":["159974","515600","515680","515900"],"粤港澳大湾区创新100":["159976"],"上期有色金属":["159980"],"易盛郑商所能源化工指数A":["159981"],"大商所豆粕期货":["159985"],"国证证券龙头":["159993"],"中证5G通信主题":["159994","515050"],"中证电子":["159997"],"中证计算机主题":["159998","512720"],"上证180公司治理":["510010"],"上证超级大盘":["510020"],"上证180价值":["510030"],"上证180":["510040","510180","510670","530080","530180","530280","530300","530580","530680","530800"],"上证50":["510050","510100","510190","510600","510680","510710","510800","510850","510950","530000","530050","563090"],"上证中央企业50":["510060"],"责任":["510090"],"上证中盘":["510130"],"上证综合":["510140","510210","510760","510910","510980","530060","562810","563930"],"消费80":["510150"],"中证南方小康产业":["510160"],"上证商品":["510170"],"上证证券行业":["510200"],"上证180金融股":["510230"],"上证国企":["510270"],"上证380":["510290","530380"],"上证资源":["510410"],"上证主要消费行业":["510630"],"上证金融地产行业":["510650"],"上证医药卫生行业":["510660"],"上证国有企业红利":["510720","530880"],"上证G60战略新兴产业":["510770"],"中证上海国企":["510810"],"上证红利":["510880"],"中证180ESG":["510990"],"上证5年期国债":["511010"],"中证5-10年期国债活跃券":["511020"],"中债-中高等级公司债利差因子财富":["511030"],"上证5年期地方政府债":["511060"],"上证基准做市公司债":["511070","511110","511190","511200"],"中债-30年期国债财富":["511090"],"上证基准做市国债":["511100"],"上证AAA科技创新公司债":["511120","511150","551000","551030","551060","551300"],"上证30年期国债":["511130"],"中证1-3年国债":["511160"],"上证投资级可转债及可交换债券":["511180"],"上证城投债":["511220"],"上证10年期国债":["511260"],"上证10年期地方政府债":["511270"],"中证短融":["511360"],"中证可转债及可交换债券":["511380"],"中债-7-10年政策性金融债全价":["511520"],"中证国债及政策性金融债0-3年":["511580"],"沪深300医药卫生":["512010"],"中证国信价值":["512040"],"沪深300非银行金融":["512070"],"MSCI中国A股国际通":["512090","512160","512180","512520","512990","515160"],"细分医药":["512120"],"富时中国A50":["512150","512550"],"中证浙江凤凰行动50":["512190"],"中证全指房地产":["512200","515060"],"中证科技传媒通信150":["512220"],"中证500行业中性低波动":["512260"],"中证生物医药":["512290"],"中证500信息技术":["512330"],"MSCI中国A股国际":["512360"],"MSCI中国A股":["512380","515770"],"有色金属":["512400"],"中证家居家电":["512430","515730"],"中证全指半导体产品与设备":["512480"],"沪深300红利":["512530"],"中证军工":["512560","512660","512680","512810"],"中证环保产业":["512580"],"中证长三角一体化发展主题":["512650"],"中证国防":["512670"],"中证酒":["512690"],"中证军工龙头":["512710"],"中证锐联基本面50":["512750"],"中华交易服务半导体芯片行业":["512760"],"中国战略新兴产业":["512770"],"中证杭州湾区":["512870"],"中证粤港澳大湾区发展主题":["512970"],"中证海外中国互联网50":["513050"],"法国CAC40":["513080"],"中证香港证券投资主题港元":["513090"],"中证香港创新药":["513120"],"中证港股通金融服务":["513140"],"恒生港股通中国科技":["513160","520980"],"恒生中国央企":["513170"],"中证全球中国互联网":["513220"],"纳斯达克生物科技":["513290"],"中证韩交所中韩半导体":["513310"],"恒生港股通新经济":["513320"],"中证全球中国教育主题":["513360"],"道琼斯工业平均":["513400"],"恒生港股通红利":["513690"],"新交所泛东南亚科技":["513730"],"中证港股通非银行金融主题":["513750"],"中证港股通创新药":["513780","520700","520970"],"东证":["513800"],"中华港股通精选100港元":["513900"],"上证港股通":["513990"],"中证科技龙头":["515000","516050"],"中证可持续发展100":["515090"],"中证国企一带一路":["515110","515150","515990"],"中证研发创新100":["515200"],"中证钢铁":["515210"],"中证煤炭":["515220"],"中证电子50":["515260","515320"],"沪深300红利低波动":["515300"],"标普中国A股大盘红利低波50":["515450","561450"],"中证科技100":["515580"],"中证500等权重":["515590"],"中证800证券保险":["515630"],"中证新能源汽车产业":["515700","516390"],"中证科技50策略":["515750"],"中证浙江国资创新发展":["515760"],"中证新兴科技100策略":["515860"],"中证全指通信设备":["515880"],"MSCI中国A股国际质量":["515910"],"中证智能消费主题":["515920"],"中证医药健康100策略":["515960"],"中证人工智能产业":["515980"],"沪深300自由现金流":["516040","561420","562080","562170","563900"],"中证800汽车与零部件":["516110"],"中证文娱传媒":["516190"],"中证装备产业":["516320","562910"],"中证现代物流":["516530","516910"],"中证大农业":["516550"],"中证养老产业":["516560"],"消费服务":["516600"],"中证ESG120策略":["516720"],"中证智能制造主题":["516800"],"中证医药及医疗器械创新":["516820"],"中证全指汽车":["516840"],"食品饮料":["516900"],"中证证券公司先锋策略":["516980"],"中证沪港深500":["517000","517010","517080","517100","517170"],"中证沪港深300":["517030","517300"],"中证长江保护主题":["517160","517330"],"中证沪港深科技100":["517360"],"恒生沪深港创新药精选50":["517380"],"中证沪港深消费龙头":["517550"],"中证沪港深物联网主题":["517660"],"中证沪港深游戏及文化传媒":["517770"],"中证沪港深人工智能50":["517800"],"中证沪港深张江自主创新50":["517850"],"中证沪港深品牌消费50":["517880"],"中证银行AH价格优选":["517900"],"中证智选沪深港科技50":["517950"],"中证沪港深500医药卫生":["517990"],"恒生创新药":["520500"],"恒生中国30":["520560"],"iEdgeEmergingAsiaSelect50Index":["520580"],"中证国新港股通央企红利":["520660","520900","520990"],"恒生港股通创新药精选":["520690","520880"],"上证580":["530100","530530"],"中证800价值":["560030"],"中证国新央企股东回报":["560070","560700","561960"],"中证500自由现金流":["560120"],"中证国新央企科技引领":["560170","562380","563050"],"中证电信主题":["560300","560690","563010"],"沪深300价值":["560330","562320"],"中证智选船舶产业":["560710"],"中证诚通央企ESG":["560810"],"中证信息技术应用创新产业":["560850","562030","562570"],"中证光伏龙头30":["560980"],"中证科技先锋":["560990"],"中证新华社民族品牌工程":["561130"],"中证绿色电力":["561170","561610","562550","562960"],"中证国新央企现代能源":["561260","561790","562850"],"中证内地运输主题":["561320"],"中证油气产业":["561360","561570"],"中证企业核心竞争力50":["561500"],"沪深300质量":["561690","563960"],"中证疫苗与生物技术":["561920"],"中证绿色能源":["562010"],"中证制药":["562050"],"标普中国A股红利机会":["562060"],"中证500价值":["562330"],"中证智选1000成长创新策略":["562520"],"中证智选1000价值稳健策略":["562530"],"中证现代农业主题":["562900"],"中证国资央企50":["563060"],"中证高股息策略":["563180"],"恒生A股专精特新企业":["563210"],"中证全指航空航天":["563380"],"中证科技优势成长50策略":["563560"],"中证红利价值":["563700"],"上证科创板50":["588000","588040","588050","588060","588080","588090","588150","588180","588280","588370","588450","588460","588720","588840","588870","588940","588950","589150","589360","589850"],"上证科创板新材料":["588010","588160","589180","589510"],"上证科创板成长":["588020","588070","588110","589490","589700"],"上证科创板100":["588030","588120","588190","588210","588220","588500","588680","588800","588880","588900","588980","589270","589950","589980"],"上证科创板新一代信息技术":["588100","588260","588770"],"上证科创板生物医药":["588130","588250","588700","588860"],"上证科创板200":["588140","588230","588240","588270","588820","589200","589220","589320","589330","589460","589780","589820"],"上证科创板半导体材料设备主题":["588170","588710","589020"],"上证科创板芯片":["588200","588290","588750","588810","588890","588920","588990","589100","589130","589160","589190"],"上证科创板综合":["588520","588550","588670","588690","589000","589050","589060","589080","589280","589300","589500","589580","589600","589630","589660","589680","589770","589800","589860","589880","589890","589900","589990"],"上证科创板人工智能":["588730","588760","588790","588930","589010","589090","589110","589230","589310","589380","589410","589520","589560"],"上证科创板芯片设计主题":["588780","589030","589070","589170","589210","589250","589260","589290","589350","589390","589400","589420","589430","589480"],"上证科创板新能源主题":["588830","588960","589960"],"上证科创板工业机械":["588850"],"上证智选科创板创新价值":["588910"],"上证科创板创新药":["589120","589720"],"上证智选科创板价值50策略":["589550"]};
var RESEARCH = {"generated_at":"2026-11-04T13:35:17","window":["2023-11-03","2026-11-03"],"train":["2023-11-03","2025-08-18"],"test":["2025-08-19","2026-11-03"],"train_days":435,"test_days":291,"horizon":5,"clusters":73,"cluster_thresh":0.5,"corr":{"mean":0.1013,"median":0.0556,"p95":0.3556,"gt06":0.0104},"picks":[["a040",0.03095,0.187,3.87,0.5814,17],["a054",0.02327,0.104,2.17,0.5163,63],["a024",0.02121,0.104,2.16,0.5186,46],["a095",0.01726,0.149,3.1,0.5721,7],["a036",0.01595,0.121,2.52,0.5628,40],["a076",0.01541,0.115,2.38,0.5326,5],["a063",0.01525,0.096,1.99,0.5442,42],["a059",0.01517,0.144,2.98,0.5651,9]],"ic":{"n":101,"neg":36,"rows":[["a018",-0.02611,-0.101,-5.24,0.5361,2671],["a032",0.02498,0.076,3.74,0.5207,2397],["a060",0.02298,0.079,4.08,0.5223,2673],["a044",0.02202,0.144,7.46,0.5499,2677],["a085",0.02059,0.114,5.8,0.531,2595],["a006",0.01877,0.096,4.96,0.5477,2673],["a039",-0.01865,-0.06,-2.94,0.5276,2369],["a040",0.01823,0.084,4.33,0.5481,2671],["a054",0.01811,0.063,3.29,0.5171,2696],["a014",0.01753,0.091,4.71,0.5357,2673],["a073",-0.017,-0.055,-2.83,0.519,2684],["a093",-0.01642,-0.092,-4.6,0.5361,2524],["a075",0.01607,0.119,6.16,0.5356,2696],["a098",0.01521,0.087,4.43,0.5379,2584],["a065",-0.01474,-0.071,-3.71,0.5256,2696],["a072",0.01443,0.083,4.21,0.5457,2562],["a052",-0.01399,-0.051,-2.49,0.5245,2387],["a043",0.01322,0.053,2.73,0.5326,2657],["a063",-0.01304,-0.056,-2.76,0.5165,2389],["a083",0.01289,0.055,2.84,0.5153,2680],["a019",-0.01278,-0.038,-1.84,0.512,2369],["a062",0.0122,0.069,3.58,0.5159,2696],["a079",0.01106,0.069,3.6,0.523,2696],["a087",-0.01098,-0.058,-3.02,0.5142,2684],["a070",-0.01078,-0.048,-2.42,0.5224,2588],["a026",0.01072,0.064,3.22,0.5319,2570],["a008",0.01056,0.032,1.65,0.5006,2663],["a016",0.01044,0.081,4.19,0.5432,2684],["a071",0.01003,0.065,3.36,0.5107,2663],["a036",0.00998,0.05,2.45,0.5297,2445],["a022",0.00987,0.055,2.84,0.5232,2655],["a057",0.00977,0.042,2.16,0.5032,2645],["a094",-0.0085,-0.05,-2.46,0.5151,2378],["a009",0.00846,0.026,1.36,0.5084,2693],["a064",-0.00826,-0.036,-1.89,0.5111,2696],["a030",0.00821,0.031,1.61,0.5021,2657],["a100",0.00792,0.03,1.52,0.5039,2584],["a055",0.00769,0.056,2.86,0.5177,2652],["a077",-0.00744,-0.043,-2.19,0.5243,2657],["a041",-0.00737,-0.04,-2.07,0.5219,2696],["a081",-0.00728,-0.048,-2.47,0.5082,2696],["a047",-0.00719,-0.023,-1.17,0.5175,2657],["a013",0.00715,0.054,2.79,0.5268,2684],["a046",0.00714,0.024,1.22,0.5072,2693],["a029",-0.00711,-0.023,-1.19,0.5024,2681],["a015",0.00675,0.054,2.68,0.5298,2482],["a049",0.00674,0.02,1.04,0.5009,2693],["a095",0.00668,0.042,2.18,0.507,2696],["a002",-0.00663,-0.042,-2.19,0.5172,2680],["a051",0.00642,0.019,1,0.5009,2693],["a012",0.00625,0.035,1.79,0.5113,2693],["a058",0.00609,0.041,2.12,0.5247,2668],["a003",0.00609,0.043,2.21,0.5318,2640],["a059",0.00607,0.04,2.06,0.5317,2654],["a033",0.00573,0.015,0.8,0.4937,2696],["a091",0.00558,0.038,1.94,0.5187,2626],["a086",-0.00529,-0.037,-1.86,0.5283,2548],["a061",0.00512,0.027,1.4,0.4874,2696],["a037",0.00509,0.018,0.9,0.4914,2444],["a067",0.00509,0.022,1.12,0.5096,2651],["a020",0.00506,0.019,0.99,0.5032,2693],["a053",0.00464,0.015,0.79,0.4964,2613],["a089",0.00462,0.02,1.02,0.5064,2654],["a034",0.00461,0.016,0.81,0.4987,2671],["a031",0.0046,0.022,1.14,0.5013,2645],["a088",0.00459,0.029,1.49,0.5194,2680],["a096",0.00455,0.036,1.83,0.5238,2518],["a010",0.00453,0.015,0.76,0.5058,2693],["a076",-0.0039,-0.025,-1.26,0.4979,2667],["a068",-0.00371,-0.032,-1.68,0.5006,2685],["a078",-0.00359,-0.021,-1.04,0.5025,2565],["a048",0.00355,0.018,0.85,0.5131,2368],["a025",0.00352,0.012,0.63,0.4994,2657],["a080",-0.00351,-0.02,-1.03,0.5103,2665],["a092",-0.00346,-0.021,-1.11,0.5056,2696],["a101",-0.00337,-0.011,-0.55,0.49,2696],["a004",0.00318,0.013,0.69,0.5119,2696],["a023",0.00311,0.011,0.58,0.507,2696],["a005",0.003,0.013,0.67,0.4961,2673],["a028",0.00297,0.015,0.78,0.5096,2653],["a038",-0.00284,-0.008,-0.43,0.5122,2696],["a084",-0.00275,-0.009,-0.44,0.4968,2522],["a027",0.00261,0.02,1.02,0.5148,2696],["a024",0.0026,0.01,0.51,0.4944,2686],["a017",-0.00246,-0.009,-0.45,0.5073,2657],["a082",-0.0022,-0.01,-0.5,0.4983,2663],["a050",0.00218,0.016,0.82,0.5155,2543],["a099",-0.0021,-0.013,-0.66,0.4933,2696],["a001",0.00193,0.007,0.35,0.5089,2653],["a035",0.00193,0.007,0.35,0.5087,2693],["a056",-0.00185,-0.007,-0.34,0.5081,2649],["a042",-0.00175,-0.007,-0.36,0.5122,2696],["a007",-0.00145,-0.006,-0.34,0.5101,2666],["a011",-0.00127,-0.007,-0.39,0.5045,2686],["a069",0.00116,0.006,0.3,0.5019,2654],["a021",0.00107,0.004,0.23,0.4844,2665],["a097",0.00105,0.006,0.23,0.4966,1325],["a066",-0.00101,-0.007,-0.35,0.5096,2345],["a090",0.00078,0.004,0.23,0.4958,2612],["a045",-0.00058,-0.004,-0.21,0.4957,2544],["a074",0.00039,0.003,0.13,0.5052,2696]]},"bt":[["8因子组合 多头",290,-0.1249,0.2096,-0.596,-0.2819,0.5,-0.00679,-0.0355],["8因子组合 多空",290,-0.0953,0.1421,-0.67,-0.1738,0.4724,null,null],["101因子等权 多头",290,-0.1243,0.2144,-0.58,-0.2653,0.5034,-0.01122,-0.0527],["101因子等权 多空",290,-0.1001,0.1404,-0.713,-0.1226,0.4931,null,null],["单因子a040 多头",290,-0.1392,0.2273,-0.612,-0.3144,0.5069,-0.02091,-0.123],["单因子a040 多空",290,-0.1622,0.1255,-1.293,-0.1927,0.4828,null,null],["全市场等权 多头",291,0.0162,0.1959,0.083,-0.1917,0.512,null,null]]};
var ALPHA_META = {"a001":{"nm":"恐慌位置","ds":"近 5 日里「恐慌度」最极端的是哪一天。下跌日用 20 日波动率、上涨日用收盘价，再平方放大差距，取期间位置——位置越靠后说明恐慌刚刚发生。","f":"inner = ((returns < 0) ? ts_stddev(returns, 20) : close)\\n→ rank(ts_argmax(signedpower(inner, 2), 5))"},"a002":{"nm":"量变背离","ds":"成交量两日变化与日内涨跌的负相关。放量却收阴、缩量却收阳时因子走高，赌的是量价不同步之后的回归。","f":"→ −1 × ts_corr(rank(delta(log(volume), 2)), rank((close − open) ÷ open), 6)"},"a003":{"nm":"开盘量与价","ds":"开盘价排名与成交量排名的 10 日负相关。开盘越贵成交越少的标的得分越高。","f":"→ −1 × ts_corr(rank(open), rank(volume), 10)"},"a004":{"nm":"低价时点","ds":"最低价排名在过去 9 日中的位置，取负。价格创近期新低时因子走高。","f":"→ −1 × ts_rank(rank(low), 9)"},"a005":{"nm":"开盘离均价","ds":"开盘价相对 10 日 VWAP 均值的偏离，乘以收盘价偏离 VWAP 的幅度。两个偏离同向时信号被放大。","f":"→ rank((open − (ts_sum(vwap, 10) ÷ 10))) × (−1 × abs(rank((close − vwap))))"},"a006":{"nm":"开盘量能","ds":"开盘价与成交量的 10 日相关性取负。开盘价推高但量跟不上时得分高。","f":"→ −1 × ts_corr(open, volume, 10)"},"a007":{"nm":"放量后的七天动量","ds":"仅当成交量高于 20 日均量时生效：7 日涨跌幅的绝对值在 60 日中的分位，再按涨跌方向定符号。放量上涨得分低、放量下跌得分高。","f":"adv20 = adv(amount, 20)\\nd7 = delta(close, 7)\\n→ ((adv20 < volume) ? ((−1 × ts_rank(abs(d7), 60)) × sign(d7)) : −1.0)"},"a008":{"nm":"五日量价合成","ds":"开盘价和与 5 日收益率和的乘积，与 10 日前的同值比较取负。衡量量价配合程度的边际变化。","f":"x = ts_sum(open, 5) × ts_sum(returns, 5)\\n→ −1 × rank((x − delay(x, 10)))"},"a009":{"nm":"价差连续性","ds":"单日价差连续 5 日在同向时顺势取值，方向反转时反号——本质是在判断短期趋势是否还在延续。","f":"d1 = delta(close, 1)\\n→ ((ts_min(d1, 5) > 0) ? d1 : ((ts_max(d1, 5) < 0) ? d1 : (−1 × d1)))"},"a010":{"nm":"价差连续性（4日）","ds":"同 a009，但只用 4 日窗口判断价差是否连续同向，节奏更快、换手更高。","f":"d1 = delta(close, 1)\\n→ rank(((ts_min(d1, 4) > 0) ? d1 : ((ts_max(d1, 4) < 0) ? d1 : (−1 × d1))))"},"a011":{"nm":"VWAP 偏离极值","ds":"近 3 日 VWAP 减收盘的最大值与最小值之和，再乘以成交量 3 日变化。偏离越大、放量越猛，信号越强。","f":"spread = vwap − close\\n→ (rank(ts_max(spread, 3)) + rank(ts_min(spread, 3))) × rank(delta(volume, 3))"},"a012":{"nm":"量价反向","ds":"成交量变化的方向乘以收盘价变化的反号。放量下跌得正分，放量上涨得负分。","f":"→ sign(delta(volume, 1)) × (−1 × delta(close, 1))"},"a013":{"nm":"收盘量协方差","ds":"收盘价排名与成交量排名的 5 日协方差取负。量价同向变动时因子走低。","f":"→ −1 × rank(ts_cov(rank(close), rank(volume), 5))"},"a014":{"nm":"收益变化 × 开盘量能","ds":"3 日收益率变化的排名，乘以开盘价与成交量的 10 日相关性。前半看动能拐点，后半看量价配合。","f":"→ (−1 × rank(delta(returns, 3))) × ts_corr(open, volume, 10)"},"a015":{"nm":"高价量相关累积","ds":"最高价与成交量排名的 3 日相关性，做排名后累加 3 日，取负。","f":"→ −1 × ts_sum(rank(ts_corr(rank(high), rank(volume), 3)), 3)"},"a016":{"nm":"高价量协方差","ds":"最高价排名与成交量排名的 5 日协方差取负。高位放量被视为负面信号。","f":"→ −1 × rank(ts_cov(rank(high), rank(volume), 5))"},"a017":{"nm":"三重压制","ds":"收盘价时序分位、二阶价格变化、相对成交量分位三项连乘取负。任一项弱则整体弱，是典型的多条件共振因子。","f":"adv20 = adv(amount, 20)\\n→ ((−1 × rank(ts_rank(close, 10))) × rank(delta(delta(close, 1), 1))) × rank(ts_rank(volume ÷ adv20, 5))"},"a018":{"nm":"日内振幅背离","ds":"5 日振幅的均值加上当日涨跌，再加收盘与开盘的 10 日相关性，整体取负排名。振幅大且量价背离时得分低。","f":"→ −1 × rank(((ts_stddev(abs(close − open), 5) + (close − open)) + ts_corr(close, open, 10)))"},"a019":{"nm":"长期收益斜率","ds":"7 日价格变化的方向，乘以 250 日收益率累积的排名。短期方向与长期强度同时为正才给出强信号。","f":"→ (−1 × sign(((close − delay(close, 7)) + delta(close, 7)))) × (1 + rank((1 + ts_sum(returns, 250))))"},"a020":{"nm":"开盘跳空三重","ds":"开盘价相对昨日高、收、低三个价位的缺口连乘取负。三个缺口同向时信号最强。","f":"→ ((−1 × rank((open − delay(high, 1)))) × rank((open − delay(close, 1)))) × rank((open − delay(low, 1)))"},"a021":{"nm":"多条件判定","ds":"由若干个价格、成交量、均价条件组合成 +1/−1 的离散信号，条件都不满足时默认 −1。","f":"adv20 = adv(amount, 20)\\nvr = volume ÷ adv20\\ncond1 = (((ts_sum(close, 8) ÷ 8) + ts_stddev(close, 8)) < (ts_sum(close, 2) ÷ 2))\\ncond2 = ((ts_sum(close, 2) ÷ 2) < ((ts_sum(close, 8) ÷ 8) − ts_stddev(close, 8)))\\ncond3 = (vr ≥ 1)\\n→ (cond1 ? −1.0 : (cond2 ? 1.0 : (cond3 ? 1.0 : −1.0)))"},"a022":{"nm":"量价相关变化 × 波动","ds":"高价与成交量 5 日相关性的 5 日变化，乘以 20 日收盘波动率的排名，取负。","f":"→ −1 × (delta(ts_corr(high, volume, 5), 5) × rank(ts_stddev(close, 20)))"},"a023":{"nm":"高价突破","ds":"收盘价站上 20 日均高价时，取 2 日高价变化的反向；否则记 0。只在高位突破时给信号。","f":"→ (((ts_sum(high, 20) ÷ 20) < high) ? (−1 × delta(high, 2)) : 0.0)"},"a024":{"nm":"长期弱势判定","ds":"100 日均价相对 100 日前的涨幅不超过 5% 时，看当前价离 100 日最低有多远；否则看 3 日价格变化。区分「长期横盘」与「仍在下跌」。","f":"x = delta((ts_sum(close, 100) ÷ 100), 100) ÷ delay(close, 100)\\n→ ((x ≤ 0.05) ? (−1 × (close − ts_min(close, 100))) : (−1 × delta(close, 3)))"},"a025":{"nm":"量价负向加权","ds":"收益率、20 日均成交额、VWAP、日内回落幅度四者连乘取负排名。成交量越大、日内回落越深，得分越低。","f":"→ rank(((((−1 × returns) × adv(amount, 20)) × vwap) × (high − close)))"},"a026":{"nm":"量价分位相关极值","ds":"成交量 5 日分位与高价 5 日分位的相关性，取 3 日最大值再取负。","f":"→ −1 × ts_max(ts_corr(ts_rank(volume, 5), ts_rank(high, 5), 5), 3)"},"a027":{"nm":"缩量判定","ds":"5 日成交量之和的 1/20 高于当日量时记 −1，否则 +1。极简的放量/缩量二值信号。","f":"cond = (rank((ts_sum(ts_corr(rank(volume), rank(vwap), 6), 2) ÷ 2.0)) > 0.5)\\n→ (cond ? −1.0 : 1.0)"},"a028":{"nm":"均价低位","ds":"20 日均成交额与最低价的 5 日相关性，加上日内中价与收盘的差，整体缩放。均价托底时得分高。","f":"→ scale(((ts_corr(adv(amount, 20), low, 5) + ((high + low) ÷ 2)) − close))"},"a029":{"nm":"分层动量叠加","ds":"把多层排名、对数、连乘嵌套后取 5 日最小值，再叠加 6 日前收益的反向分位。论文里结构最绕的因子之一，结果仍是动量类信号。","f":"x = rank(rank((−1 × rank(delta((close − 1), 5)))))\\npart = ts_product(rank(rank(scale(log(ts_sum(ts_min(x, 2), 1))))), 1)\\n→ min_(part, 5) + ts_rank(delay((−1 × returns), 6), 5)"},"a030":{"nm":"量能转移","ds":"(1 − 5日与20日价格变化方向的排名) 乘以 5 日量占 20 日量的比重。资金正在集中而非分散时得分高。","f":"sgn = (sign((close − delay(close, 1))) + sign((delay(close, 1) − delay(close, 2)))) + sign((delay(close, 2) − delay(close, 3)))\\n→ ((1.0 − rank(sgn)) × ts_sum(volume, 5)) ÷ ts_sum(volume, 20)"},"a031":{"nm":"加权量价合成","ds":"三段加权：量价衰减相关的排名、价格衰减变化、低量惩罚，线性合成后取反向。","f":"part1 = rank(rank(rank(decay_linear((−1 × rank(rank(delta(close, 10)))), 10))))\\npart2 = rank((−1 × delta(close, 3)))\\npart3 = sign(scale(ts_corr(adv(amount, 20), low, 12)))\\n→ (part1 + part2) + part3"},"a032":{"nm":"均线偏离 + 长周期量价","ds":"7 日均价与收盘的偏离，加上 20 倍 VWAP 与 5 日前收盘的 230 日相关性。后者捕捉「超长期」量价关系，是全集里窗口最长的因子。","f":"→ scale(((ts_sum(close, 7) ÷ 7) − close)) + (20 × scale(ts_corr(vwap, delay(close, 5), 230)))"},"a033":{"nm":"开盘折价","ds":"开盘价相对收盘价的比例取负排名。开盘低于收盘（低开高走）时得分高。","f":"→ rank((−1 × (1 − open ÷ close)))"},"a034":{"nm":"波动比与价格变化","ds":"2 日与 5 日波动率之比，加上价格日变化的排名，合成后排名。短期波动突然收缩时得分高。","f":"→ rank(((1 − rank(ts_stddev(returns, 2) ÷ ts_stddev(returns, 5))) + (1 − rank(delta(close, 1)))))"},"a035":{"nm":"量价分位三重","ds":"成交量 32 日分位 × (1 − 日内振幅 16 日分位) × (1 − 收益率 32 日分位)。三者都低时得分高，是「平静」信号。","f":"→ (ts_rank(volume, 32) × (1 − ts_rank(((close + high) − low), 16))) × (1 − ts_rank(returns, 32))"},"a036":{"nm":"四段加权动量","ds":"2.21×量价相关排名 + 0.7×日内回落排名 + 0.73×短期动量排名 + 成交量加权。论文给出的权重，偏向量价配合。","f":"adv20 = adv(amount, 20)\\n→ ((((2.21 × rank(ts_corr((close − open), delay(volume, 1), 15))) + (0.7 × rank((open − close)))) + (0.73 × rank(ts_rank(delay((−1 × returns), 6), 5)))) + rank(abs(ts_corr(vwap, adv20, 6)))) + (0.6 × rank((((ts_sum(close, 200) ÷ 200) − open) × (close − open))))"},"a037":{"nm":"日内回落与长期相关","ds":"前一日 (开盘−收盘) 与收盘价的 200 日相关性排名，加上当日日内回落排名。","f":"→ rank(ts_corr(delay((open − close), 1), close, 200)) + rank((open − close))"},"a038":{"nm":"收盘分位 × 开收比","ds":"收盘价 10 日分位的排名，乘以收盘/开盘比值的排名，取负。","f":"→ (−1 × rank(ts_rank(close, 10))) × rank(close ÷ open)"},"a039":{"nm":"长期趋势 × 量能衰减","ds":"7 日价格变化 × (1 − 相对成交量的衰减排名)，再乘以 250 日累计收益。长周期动量与资金流入同时成立才有强信号。","f":"adv20 = adv(amount, 20)\\n→ (−1 × rank((delta(close, 7) × (1 − rank(decay_linear(volume ÷ adv20, 9)))))) × (1 + rank(ts_sum(returns, 250)))"},"a040":{"nm":"高价波动 × 量价背离","ds":"最高价 10 日波动率的排名，乘以高低价与成交量的 10 日相关性，取负。","f":"→ (−1 × rank(ts_stddev(high, 10))) × ts_corr(high, volume, 10)"},"a041":{"nm":"几何均价偏离","ds":"最高价与最低价的几何平均减去 VWAP。价格中枢高于成交均价时为正。","f":"→ np.sqrt((high × low)) − vwap"},"a042":{"nm":"VWAP 相对位置","ds":"VWAP 减收盘与 VWAP 加收盘两个排名之比。收盘远低于 VWAP 时得分高。","f":"→ rank((vwap − close)) ÷ rank((vwap + close))"},"a043":{"nm":"量能分位 × 跌幅分位","ds":"相对成交量 20 日分位，乘以 7 日跌幅的 8 日分位。放量下跌时信号最强。","f":"→ ts_rank(volume ÷ adv(amount, 20), 20) × ts_rank((−1 × delta(close, 7)), 8)"},"a044":{"nm":"高价量相关","ds":"最高价与成交量排名的 5 日相关性取负。","f":"→ −1 × ts_corr(high, rank(volume), 5)"},"a045":{"nm":"三重量价结构","ds":"5 日前收盘的 20 日均价排名 × 收盘与成交量的 2 日相关 × 短期与长期均价的相关排名，取负。","f":"→ −1 × ((rank((ts_sum(delay(close, 5), 20) ÷ 20)) × ts_corr(close, volume, 2)) × rank(ts_corr(ts_sum(close, 5), ts_sum(close, 20), 2)))"},"a046":{"nm":"日内位置分档","ds":"用收盘价在日内区间的位置分三档：高位给负、低位给正、中间用当日价格变化取反。区间用 2 日数据算。","f":"x = ((delay(close, 20) − delay(close, 10)) ÷ 10) − ((delay(close, 10) − close) ÷ 10)\\n→ ((x > 0.25) ? −1.0 : ((x < 0) ? 1.0 : (−1 × (close − delay(close, 1)))))"},"a047":{"nm":"量能加权反转","ds":"收盘倒数 × 相对量 × 高价相对回落，再减去 VWAP 的 5 日变化。","f":"adv20 = adv(amount, 20)\\ninner = ((rank((1 ÷ close)) × volume) ÷ adv20) ÷ (ts_sum(high, 5) ÷ 5) × (high × rank((high − close)))\\n→ inner − rank((vwap − delay(vwap, 5)))"},"a048":{"nm":"行业中性量价","ds":"价格二阶变化与 250 日相关的乘积，先做行业中性化（这里用资产类别代理）再除以波动率。全集里唯一显式做中性化的因子。","f":"num = ts_corr(delta(close, 1), delta(delay(close, 1), 1), 250) × delta(close, 1)\\nnum = indneutralize(num ÷ close, asset_class)\\nden = ts_sum(((delta(close, 1) ÷ delay(close, 1)) ^ 2), 250)\\n→ num ÷ den"},"a049":{"nm":"跌破均线","ds":"5 日均价相对 5 日前跌破 10% 时记 +1，否则取当日价格变化的反向。赌超跌反弹。","f":"x = ((delay(close, 20) − delay(close, 10)) ÷ 10) − ((delay(close, 10) − close) ÷ 10)\\n→ ((x < −0.1) ? 1.0 : (−1 × (close − delay(close, 1))))"},"a050":{"nm":"量价相关峰值","ds":"成交量排名与 VWAP 排名 5 日相关性的排名，取 5 日最大值再取负。","f":"→ −1 × ts_max(rank(ts_corr(rank(volume), rank(vwap), 5)), 5)"},"a051":{"nm":"跌破均线（5%）","ds":"同 a049，但阈值放宽到 −5%，触发更频繁。","f":"x = ((delay(close, 20) − delay(close, 10)) ÷ 10) − ((delay(close, 10) − close) ÷ 10)\\n→ ((x < −0.05) ? 1.0 : (−1 × (close − delay(close, 1))))"},"a052":{"nm":"低位反抽 × 长期收益","ds":"5 日最低价的变化，乘以 220 日累计收益的排名，再乘成交量分位。低位放量反抽时得分高。","f":"→ (((−1 × ts_min(low, 5)) + delay(ts_min(low, 5), 5)) × rank(((ts_sum(returns, 240) − ts_sum(returns, 20)) ÷ 220))) × ts_rank(volume, 5)"},"a053":{"nm":"日内位置变化","ds":"收盘价在日内区间中的相对位置，取 9 日变化的反向。位置快速上移时得分低。","f":"→ −1 × delta(((close − low) − (high − close)) ÷ (close − low), 9)"},"a054":{"nm":"价格幂次比","ds":"(低−收)×开盘^5 ÷ ((低−高)×收盘^5)。用五次幂放大开收盘差异，是全集里唯一带高次幂的因子。","f":"→ ((−1 × (low − close)) × (open ^ 5)) ÷ ((low − high) × (close ^ 5))"},"a055":{"nm":"区间位置与量","ds":"收盘在 12 日高低区间中的位置排名，与成交量排名做 6 日相关取负。","f":"rng = ts_max(high, 12) − ts_min(low, 12)\\n→ −1 × ts_corr(rank((close − ts_min(low, 12)) ÷ rng), rank(volume), 6)"},"a056":{"nm":"短长收益比 × 量价","ds":"10 日收益与 6 日收益之比排名，乘以收益率×成交额的排名，取负。","f":"→ −1 × (rank(ts_sum(returns, 10) ÷ ts_sum(ts_sum(returns, 2), 3)) × rank((returns × amount)))"},"a057":{"nm":"收盘离 VWAP","ds":"收盘价减 VWAP，除以收盘 30 日极值位置的衰减排名，取负。","f":"→ −1 × (close − vwap) ÷ decay_linear(rank(ts_argmax(close, 30)), 2)"},"a058":{"nm":"中性化 VWAP 量能","ds":"VWAP 做行业中性化后与成交量的 4 日相关，衰减加权后取 6 日分位，再取负。","f":"→ −1 × ts_rank(decay_linear(ts_corr(indneutralize(vwap, asset_class), volume, 4), 8), 6)"},"a059":{"nm":"中性化 VWAP 量能（加权）","ds":"同 a058，但 VWAP 先按 0.728 的权重与自身混合一次，衰减窗口从 8 拉长到 16。","f":"k = 0.728317\\n→ −1 × ts_rank(decay_linear(ts_corr(indneutralize(((vwap × k) + (vwap × (1 − k))), asset_class), volume, 4), 16), 8)"},"a060":{"nm":"日内位置量能","ds":"日内位置乘成交量后的排名缩放，减去收盘 10 日极值位置的排名缩放，取负。","f":"inner = ((close − low) − (high − close)) ÷ (high − low) × volume\\n→ −1 × ((2 × scale(rank(inner))) − scale(rank(ts_argmax(close, 10))))"},"a061":{"nm":"VWAP 低位","ds":"VWAP 离 16 日最低的距离排名，低于 VWAP 与 180 日均额的相关排名时记 1。","f":"→ (rank((vwap − ts_min(vwap, 16))) < rank(ts_corr(vwap, adv(amount, 180), 18)))"},"a062":{"nm":"多重排名比较","ds":"把 VWAP、均价、成交量、开盘价的多组排名做大小比较，输出 0/1 信号取负。","f":"cond = (rank(ts_corr(vwap, ts_sum(adv(amount, 20), 22), 10)) < rank(((rank(open) + rank(open)) < (rank(((high + low) ÷ 2)) + rank(high)))))\\n→ −1.0 × cond"},"a063":{"nm":"中性化价格变化差","ds":"收盘做行业中性化后的 2 日变化衰减排名，减去开盘价中性化后的同项，取负。","f":"k = 0.318108\\np1 = rank(decay_linear(delta(indneutralize(close, asset_class), 2), 8))\\np2 = rank(decay_linear(ts_corr(((vwap × k) + (open × (1 − k))), ts_sum(adv(amount, 180), 37), 14), 12))\\n→ −1 × (p1 − p2)"},"a064":{"nm":"加权开低 vs 均额","ds":"开盘与最低价加权后与 120 日均额的相关排名，低于日内中价与 15 日均额的相关排名时记 1，取负。","f":"k = 0.178404\\np1 = rank(ts_corr(ts_sum(((open × k) + (low × (1 − k))), 13), ts_sum(adv(amount, 120), 13), 17))\\np2 = rank(delta(((((high + low) ÷ 2) × k) + (vwap × (1 − k))), 4))\\n→ −1.0 × (p1 < p2)"},"a065":{"nm":"开盘 VWAP 加权","ds":"开盘与 VWAP 加权后与 60 日均额求相关，与最低价 VWAP 加权版本比较，输出 0/1。","f":"k = 0.00817205\\np1 = rank(ts_corr(((open × k) + (vwap × (1 − k))), ts_sum(adv(amount, 60), 9), 6))\\np2 = rank((open − ts_min(open, 14)))\\n→ −1.0 × (p1 < p2)"},"a066":{"nm":"VWAP 变化 + 位置","ds":"VWAP 4 日变化的衰减排名，加上日内位置相对 VWAP 的分位，取负。","f":"p1 = rank(decay_linear(delta(vwap, 4), 7))\\np2 = ts_rank(decay_linear((low − vwap) ÷ (open − ((high + low) ÷ 2)), 11), 7)\\n→ −1 × (p1 + p2)"},"a067":{"nm":"高价抬升 × 中性化量能","ds":"最高价相对 2 日最低的抬升排名，与中性化 VWAP 和均额相关的排名做幂运算，取负。","f":"p1 = rank((high − ts_min(high, 2)))\\np2 = rank(ts_corr(indneutralize(vwap, asset_class), indneutralize(adv(amount, 20), asset_class), 6))\\n→ −1 × (p1 ^ p2)"},"a068":{"nm":"高价量相关 vs 加权价","ds":"高价与 15 日均额相关的时序分位，低于收盘与最低价加权价的衰减变化排名时记 1，取负。","f":"p1 = ts_rank(ts_corr(rank(high), rank(adv(amount, 15)), 9), 14)\\np2 = rank(delta(((close × 0.518371) + (low × (1 − 0.518371))), 1))\\n→ −1.0 × (p1 < p2)"},"a069":{"nm":"中性化 VWAP 极值","ds":"中性化 VWAP 的 3 日变化 5 日最大值排名，与收盘和最低价加权后的相关性排名做幂运算，取负。","f":"p1 = rank(ts_max(delta(indneutralize(vwap, asset_class), 3), 5))\\np2 = ts_rank(ts_corr(((close × 0.490655) + (vwap × (1 − 0.490655))), adv(amount, 20), 5), 9)\\n→ −1 × (p1 ^ p2)"},"a070":{"nm":"VWAP 变化 × 中性化相关","ds":"VWAP 日变化排名，与中性化收盘和 50 日均额相关的分位做幂运算，取负。","f":"p1 = rank(delta(vwap, 1))\\np2 = ts_rank(ts_corr(indneutralize(close, asset_class), adv(amount, 50), 18), 18)\\n→ −1 × (p1 ^ p2)"},"a071":{"nm":"双分量取大","ds":"收盘与均额相关的衰减分位，与收盘分位和最低价相关的衰减分位，取较大者。","f":"p1 = ts_rank(decay_linear(ts_corr(ts_rank(close, 3), ts_rank(adv(amount, 180), 12), 18), 4), 16)\\np2 = ts_rank(decay_linear((rank(((low + open) − (2 × vwap))) ^ 2), 16), 4)\\n→ max_(p1, p2)"},"a072":{"nm":"日内中价 vs 最低价","ds":"日内中价与 40 日均额相关，除以最低价与均额相关，比值型因子。","f":"p1 = rank(decay_linear(ts_corr(((high + low) ÷ 2), adv(amount, 40), 9), 10))\\np2 = rank(decay_linear(ts_corr(ts_rank(vwap, 4), ts_rank(volume, 19), 7), 3))\\n→ p1 ÷ p2"},"a073":{"nm":"VWAP 变化最值","ds":"VWAP 5 日变化的衰减排名，与开盘最低加权价的分位，取较大者再取负。","f":"p1 = rank(decay_linear(delta(vwap, 5), 3))\\nk = 0.147155\\nx = (open × k) + (low × (1 − k))\\np2 = ts_rank(decay_linear((delta(x, 2) ÷ x × −1), 3), 17)\\n→ −1 × max_(p1, p2)"},"a074":{"nm":"收盘 vs 加权高价","ds":"收盘与 30 日均额的相关排名，低于高价与 VWAP 加权后的相关排名时记 1，取负。","f":"p1 = rank(ts_corr(close, ts_sum(adv(amount, 30), 37), 15))\\np2 = rank(ts_corr(rank(((high × 0.0261661) + (vwap × (1 − 0.0261661)))), rank(volume), 11))\\n→ −1.0 × (p1 < p2)"},"a075":{"nm":"VWAP 量比 vs 低价量比","ds":"VWAP 与成交量的 4 日相关排名，低于低价与 50 日均额相关排名时记 1。","f":"→ (rank(ts_corr(vwap, volume, 4)) < rank(ts_corr(rank(low), rank(adv(amount, 50)), 12)))"},"a076":{"nm":"VWAP 变化（双版本）","ds":"VWAP 日变化衰减排名，与中性化低价和均额相关的分位，取较大者取负。","f":"p1 = rank(decay_linear(delta(vwap, 1), 12))\\np2 = ts_rank(decay_linear(ts_rank(ts_corr(indneutralize(low, asset_class), adv(amount, 81), 8), 20), 17), 19)\\n→ −1 × max_(p1, p2)"},"a077":{"nm":"双衰减取小","ds":"日内中价相关组合与低价 VWAP 组合的衰减排名，取较小者。","f":"p1 = rank(decay_linear(((((high + low) ÷ 2) + high) − (vwap + high)), 20))\\np2 = rank(decay_linear(ts_corr(((high + low) ÷ 2), adv(amount, 40), 3), 6))\\n→ min_(p1, p2)"},"a078":{"nm":"低价 VWAP 加权幂","ds":"低价与 VWAP 加权后与 40 日均额相关，与日内中价相关做幂运算。","f":"k = 0.352233\\np1 = rank(ts_corr(ts_sum(((low × k) + (vwap × (1 − k))), 20), ts_sum(adv(amount, 40), 20), 7))\\np2 = rank(ts_corr(rank(vwap), rank(volume), 6))\\n→ p1 ^ p2"},"a079":{"nm":"中性化价格分位","ds":"中性化收盘低价加权价的日变化排名，低于 VWAP 分位与均额相关的分位时记 1。","f":"p1 = rank(delta(indneutralize(((close × 0.60733) + (open × (1 − 0.60733))), asset_class), 1))\\np2 = rank(ts_corr(ts_rank(vwap, 4), ts_rank(adv(amount, 150), 9), 15))\\n→ 1.0 × (p1 < p2)"},"a080":{"nm":"量价一致性的分位","ds":"收盘与成交量 5 日相关，做 18 日分位后再按成交量分位调整，取负。","f":"k = 0.868128\\np1 = rank(sign(delta(indneutralize(((open × k) + (high × (1 − k))), asset_class), 4)))\\np2 = ts_rank(ts_corr(high, adv(amount, 10), 5), 6)\\n→ −1 × (p1 ^ p2)"},"a081":{"nm":"VWAP 与均额（8日）","ds":"VWAP 与 10 日均额 8 日相关的四次幂排名，低于 VWAP 与成交量相关排名时记 1，取负。","f":"p1 = rank(log(ts_product(rank((rank(ts_corr(vwap, ts_sum(adv(amount, 10), 50), 8)) ^ 4)), 15)))\\np2 = rank(ts_corr(rank(vwap), rank(volume), 5))\\n→ −1.0 × (p1 < p2)"},"a082":{"nm":"开盘变化 vs 量价","ds":"开盘价日变化衰减排名，与收盘量价相关的衰减排名，取较小者取负。","f":"p1 = rank(decay_linear(delta(open, 1), 15))\\np2 = ts_rank(decay_linear(ts_corr(indneutralize(volume, asset_class), open, 17), 7), 13)\\n→ −1 × min_(p1, p2)"},"a083":{"nm":"振幅比 × 量","ds":"日内振幅占 5 日均价比例的 2 日滞后排名，乘以成交量排名，再除以振幅与 VWAP 偏离之比。","f":"x = (high − low) ÷ (ts_sum(close, 5) ÷ 5)\\n→ (rank(delay(x, 2)) × rank(rank(volume))) ÷ x ÷ (vwap − close)"},"a084":{"nm":"VWAP 极值分位幂","ds":"VWAP 距 15 日最高的分位，以价格 5 日变化为指数做幂运算。符号随价格变化翻转，是全集里最敏感的一个。","f":"p1 = signedpower(ts_rank((vwap − ts_max(vwap, 15)), 21), delta(close, 5))\\n→ p1"},"a085":{"nm":"高价权重相关","ds":"高价与收盘加权后与 30 日均额相关，再以高价分位与成交量分位相关的分位为指数。","f":"p1 = rank(ts_corr(((high × 0.876703) + (close × (1 − 0.876703))), adv(amount, 30), 10))\\np2 = rank(ts_corr(ts_rank(((high + low) ÷ 2), 4), ts_rank(volume, 10), 7))\\n→ p1 ^ p2"},"a086":{"nm":"收盘均额相关分位","ds":"收盘与 15 日均额 6 日相关的 20 日分位，低于开盘收盘和与 VWAP 和之差的排名时记 1，取负。","f":"p1 = ts_rank(ts_corr(close, ts_sum(adv(amount, 20), 15), 6), 20)\\np2 = rank(((open + close) − (vwap + open)))\\n→ −1.0 × (p1 < p2)"},"a087":{"nm":"加权价衰减差","ds":"收盘 VWAP 加权价的衰减变化排名，减去中性化 VWAP 与均额相关的衰减分位，取较大者再取负。","f":"p1 = rank(decay_linear(delta(((close × 0.369701) + (vwap × (1 − 0.369701))), 2), 3))\\np2 = ts_rank(decay_linear(abs(ts_corr(indneutralize(adv(amount, 81), asset_class), close, 13)), 5), 14)\\n→ −1 × max_(p1, p2)"},"a088":{"nm":"开低高收组合","ds":"开盘与最低价排名之和，减去高价与收盘排名之和，衰减后与收盘分位比较，取较小者。","f":"p1 = rank(decay_linear((((rank(open) + rank(low)) − rank(high)) − rank(close)), 8))\\np2 = ts_rank(decay_linear(ts_corr(ts_rank(close, 8), ts_rank(adv(amount, 60), 21), 8), 7), 3)\\n→ min_(p1, p2)"},"a089":{"nm":"低价均额 vs 中性化 VWAP","ds":"低价与 10 日均额相关的衰减排名，减去中性化 VWAP 变化的衰减分位，取负。","f":"p1 = ts_rank(decay_linear(ts_corr(low, adv(amount, 10), 7), 6), 4)\\np2 = ts_rank(decay_linear(delta(indneutralize(vwap, asset_class), 3), 10), 15)\\n→ p1 − p2"},"a090":{"nm":"收盘极值 vs 低价相关","ds":"收盘距 5 日最高的排名，低于低价与 40 日均额相关排名时记 1，取负。","f":"p1 = rank((close − ts_max(close, 5)))\\np2 = ts_rank(ts_corr(indneutralize(adv(amount, 40), asset_class), low, 5), 3)\\n→ −1 × (p1 ^ p2)"},"a091":{"nm":"双重衰减比较","ds":"收盘成交量相关的双层衰减分位，低于 VWAP 与 30 日均额相关的衰减排名时记 1，取负。","f":"p1 = ts_rank(decay_linear(decay_linear(ts_corr(indneutralize(close, asset_class), volume, 10), 16), 4), 5)\\np2 = rank(decay_linear(ts_corr(vwap, adv(amount, 30), 4), 3))\\n→ −1 × (p1 − p2)"},"a092":{"nm":"日内中价条件取值","ds":"日内中价低于开盘低价组合时取最低价，否则取中价，衰减后与低价相关分位取较小者。","f":"p1 = ts_rank(decay_linear(((((high + low) ÷ 2) + close) < (low + open)), 15), 19)\\np2 = ts_rank(decay_linear(ts_corr(rank(low), rank(adv(amount, 30)), 8), 7), 7)\\n→ min_(p1, p2)"},"a093":{"nm":"中性化 VWAP 长窗口","ds":"中性化 VWAP 与 81 日均额 17 日相关，衰减 20 日后再取 8 日分位，取负。","f":"p1 = ts_rank(decay_linear(ts_corr(indneutralize(vwap, asset_class), adv(amount, 81), 17), 20), 8)\\np2 = rank(decay_linear(delta(((close × 0.524434) + (vwap × (1 − 0.524434))), 3), 16))\\n→ p1 ÷ p2"},"a094":{"nm":"VWAP 极值幂","ds":"VWAP 距 12 日最低的排名，以 VWAP 分位与均额相关的分位为指数做幂运算，取负。","f":"p1 = rank((vwap − ts_min(vwap, 12)))\\np2 = ts_rank(ts_corr(ts_rank(vwap, 20), ts_rank(adv(amount, 60), 4), 18), 3)\\n→ −1 × (p1 ^ p2)"},"a095":{"nm":"振幅比 vs 低价相关","ds":"日内振幅占 5 日均价的衰减分位，低于低价与 40 日均额相关的衰减分位时记 1，取负。","f":"p1 = rank((open − ts_min(open, 12)))\\np2 = ts_rank((rank(ts_corr(ts_sum(((high + low) ÷ 2), 19), ts_sum(adv(amount, 40), 19), 13)) ^ 5), 12)\\n→ 1.0 × (p1 < p2)"},"a096":{"nm":"量价与极值取大","ds":"VWAP 成交量相关的衰减分位，与收盘分位和均额相关的极值分位，取较大者取负。","f":"p1 = ts_rank(decay_linear(ts_corr(rank(vwap), rank(volume), 4), 4), 8)\\np2 = ts_rank(decay_linear(ts_argmax(ts_corr(ts_rank(close, 7), ts_rank(adv(amount, 60), 4), 4), 13), 14), 13)\\n→ −1 × max_(p1, p2)"},"a097":{"nm":"中性化低价衰减差","ds":"中性化低价 VWAP 加权价的衰减变化排名，减去低价分位与均额相关的极值分位，取负。","f":"p1 = rank(decay_linear(delta(indneutralize(((low × 0.721001) + (vwap × (1 − 0.721001))), asset_class), 3), 20))\\np2 = ts_rank(decay_linear(ts_rank(ts_corr(ts_rank(low, 8), ts_rank(adv(amount, 60), 17), 5), 19), 16), 7)\\n→ −1 × (p1 − p2)"},"a098":{"nm":"VWAP 均额 + 开盘极值","ds":"VWAP 与 5 日均额相关的衰减分位取负，再减去开盘价与 15 日均额相关极值的分位。","f":"p1 = rank(decay_linear(ts_corr(vwap, ts_sum(adv(amount, 5), 26), 5), 7))\\np2 = rank(decay_linear(ts_rank(ts_argmin(ts_corr(rank(open), rank(adv(amount, 15)), 21), 9), 7), 8))\\n→ p1 − p2"},"a099":{"nm":"中价 vs 低价量","ds":"日内中价的 20 日均值与 60 日均额相关的排名，低于低价与成交量相关排名时记 1，取负。","f":"p1 = rank(ts_corr(ts_sum(((high + low) ÷ 2), 20), ts_sum(adv(amount, 60), 20), 9))\\np2 = rank(ts_corr(low, volume, 6))\\n→ −1.0 × (p1 < p2)"},"a100":{"nm":"日内位置量能（放大）","ds":"日内位置乘成交量的排名缩放 ×1.5 取负，减去 VWAP 与 5 日均额相关的缩放。","f":"inner = ((close − low) − (high − close)) ÷ (high − low) × volume\\np1 = scale(indneutralize(indneutralize(rank(inner), asset_class), asset_class))\\np2 = scale(indneutralize((ts_corr(close, rank(adv(amount, 20)), 5) − rank(ts_argmin(close, 30))), asset_class))\\n→ (−1 × ((1.5 × p1) − p2)) × volume ÷ adv(amount, 20)"},"a101":{"nm":"日内涨跌幅度","ds":"收盘减开盘，除以日内振幅。最朴素的一个：当天从开盘到收盘走了整个区间的百分之多少。","f":"→ (close − open) ÷ ((high − low) + 0.001)"}};
var LAB = {"generated_at":"2026-11-05T09:02:28","universe":{"n_idx":468,"n_etf":1617},"window":["2019-06-01","2026-11-03"],"param":{"hold":20,"top":0.2,"cost":0.0005},"pe":{"all":{"ann":0.12676575204425067,"vol":0.2049144430992687,"sharpe":0.685109446245538,"mdd":-0.2811909139939204,"win":0.52,"n":1800,"to":8.25147565348503,"holding":21.36277777777778,"b_ann":0.05443131923675537,"b_vol":0.18897031888529692,"b_sharpe":0.37512763173026653,"b_mdd":-0.3844228982925415,"b_win":0.5088888888888888,"b_n":1800},"yearly":[[2019,0.04817236707979977,0.12464368343353271,-0.07647131635373294],[2020,0.2572824373584115,0.3862694501876831,-0.1289870128292716],[2021,0.08013250689378482,0.01837158203125,0.061760924862534816],[2022,0.10674745788464146,-0.17774468660354614,0.2844921444881876],[2023,-0.093747831562348,-0.08523845672607422,-0.008509374836273786],[2024,0.16228046517025452,0.08235502243041992,0.0799254427398346],[2025,0.3158991118065151,0.29973936080932617,0.016159750997188915],[2026,0.10460138140698816,-0.11997127532958984,0.224572656736578]],"nav":[["2019-06-03",0.9964,0.9978],["2019-06-28",1.0278,1.0436],["2019-07-31",1.0356,1.0592],["2019-08-30",1.0324,1.0616],["2019-09-30",1.0188,1.0572],["2019-10-31",1.0182,1.0652],["2019-11-29",1.002,1.0518],["2019-12-31",1.0482,1.1246],["2020-01-23",1.0817,1.1614],["2020-02-28",1.0894,1.192],["2020-03-31",0.9851,1.0929],["2020-04-30",1.0641,1.1889],["2020-05-29",1.0803,1.1906],["2020-06-30",1.1772,1.3104],["2020-07-31",1.2997,1.4743],["2020-08-31",1.2999,1.49],["2020-09-30",1.2099,1.4027],["2020-10-30",1.2236,1.4247],["2020-11-30",1.2445,1.4773],["2020-12-31",1.3178,1.5591],["2021-01-29",1.321,1.5627],["2021-02-26",1.281,1.5231],["2021-03-31",1.217,1.4577],["2021-04-30",1.2721,1.5247],["2021-05-31",1.3077,1.5957],["2021-06-30",1.3768,1.6362],["2021-07-30",1.4761,1.5963],["2021-08-31",1.5233,1.605],["2021-09-30",1.4372,1.5746],["2021-10-29",1.3948,1.5883],["2021-11-30",1.4146,1.605],["2021-12-31",1.4235,1.5877],["2022-01-28",1.3299,1.4394],["2022-02-28",1.3759,1.457],["2022-03-31",1.3274,1.3688],["2022-04-29",1.2668,1.2781],["2022-05-31",1.3604,1.3273],["2022-06-30",1.5119,1.4576],["2022-07-29",1.4738,1.3821],["2022-08-31",1.4674,1.3537],["2022-09-30",1.3625,1.2396],["2022-10-31",1.3865,1.2061],["2022-11-30",1.5614,1.3074],["2022-12-30",1.5754,1.3055],["2023-01-31",1.653,1.3883],["2023-02-28",1.6279,1.3567],["2023-03-31",1.6812,1.3791],["2023-04-28",1.6435,1.361],["2023-05-31",1.5701,1.3061],["2023-06-30",1.5738,1.3212],["2023-07-31",1.588,1.3599],["2023-08-31",1.5303,1.2854],["2023-09-28",1.4883,1.2492],["2023-10-31",1.4487,1.228],["2023-11-30",1.4282,1.2246],["2023-12-29",1.4277,1.1942],["2024-01-31",1.2727,1.049],["2024-02-29",1.4212,1.1643],["2024-03-29",1.4263,1.1582],["2024-04-30",1.4394,1.172],["2024-05-31",1.4303,1.1661],["2024-06-28",1.3976,1.1316],["2024-07-31",1.3908,1.1333],["2024-08-30",1.3679,1.0964],["2024-09-30",1.6151,1.3219],["2024-10-31",1.6486,1.2982],["2024-11-29",1.693,1.3054],["2024-12-31",1.6594,1.2926],["2025-01-27",1.6752,1.2867],["2025-02-28",1.703,1.3581],["2025-03-31",1.7094,1.3549],["2025-04-30",1.6725,1.3176],["2025-05-30",1.6651,1.3487],["2025-06-30",1.7089,1.4126],["2025-07-31",1.8454,1.4923],["2025-08-29",2.0809,1.6407],["2025-09-30",2.2747,1.7149],["2025-10-31",2.251,1.6933],["2025-11-28",2.1984,1.6517],["2025-12-31",2.1836,1.68],["2026-01-30",2.284,1.785],["2026-02-27",2.3753,1.7898],["2026-03-31",2.1468,1.6492],["2026-04-30",2.2244,1.7726],["2026-05-29",2.3098,1.7652],["2026-06-30",2.6032,1.7826],["2026-07-31",2.5727,1.6688],["2026-08-31",2.6825,1.7215],["2026-09-30",2.604,1.6542],["2026-10-30",2.3853,1.4732],["2026-11-03",2.412,1.4785]]},"counts":{"n_new":100,"n_alpha":101,"sig_in":28,"alive":9,"only_out":25,"alive_list":["ITS","RANGE_POS","PE","a101","a039","a033","a038","a051","a099"],"fam_alive":{"Alpha101":6,"G 路径形态":2,"H 技术位置":1},"pos_out_new":44,"pos_out_alpha":21},"cross":[["AMT_SURGE","E 流动性",0.0223,4.5914,0.0035,-0.0023,-0.396,-0.0472,"成交额脉冲：5 日相对 60 日的放大倍数"],["MOM_12_1","B 动量反转",0.0487,4.3057,0.0496,0.0254,1.9178,-0.0411,"跳过最近 1 个月的 12 月动量：避开短期反转污染"],["MOM250","B 动量反转",0.0473,4.1457,0.0458,0.0269,2.0152,-0.0203,"12 个月动量"],["VMOM","B 动量反转",0.038,3.642,0.056,0.0188,1.7259,-0.0386,"波动率调整动量：单位风险的 120 日趋势"],["NH60","G 路径形态",0.0157,3.24,0.0256,0.016,2.3605,-0.0342,"创新高天数占比:信息缓慢扩散的标志"],["TURN_20_250","E 流动性",0.0166,3.2243,-0.0146,0.0305,7.2467,0.0204,"换手率（成交量/一年均值）：意见分歧与过度交易"],["ITS","G 路径形态",0.0275,3.0603,0.0184,0.027,2.4571,0.0233,"日内趋势强度：收盘在当日振幅中的位置"],["PATH_SKEW","G 路径形态",0.0203,3.0146,0.003,0.0192,2.4962,-0.0101,"路径偏度：日内收益分布的偏斜方向"],["MOM120","B 动量反转",0.031,2.6778,0.043,0.0226,1.732,-0.0105,"6 个月动量"],["NL60","G 路径形态",0.0158,2.6647,0.0264,0.0129,1.8163,-0.0211,"创新低天数占比"],["ILLIQ20","E 流动性",0.0084,2.6249,-0.0106,0.0172,6.0872,0.0083,"Amihud 非流动性：单位成交额的价格冲击"],["RESMOM120","B 动量反转",0.0276,2.5522,0.0432,0.0071,0.6186,-0.0205,"残差动量（120 日）"],["SKEW60","D 尾部风险",0.0199,2.5471,-0.0024,0.0244,3.1787,-0.0344,"收益偏度 60 日"],["W52","B 动量反转",0.0249,2.4275,0.0115,0.0291,2.6025,-0.014,"距 52 周高点的接近度：锚定效应下的动量"],["RANGE_POS","H 技术位置",0.0236,2.3367,0.017,0.0307,2.7213,0.0132,"区间位置：60 日高低区间中的相对位置"],["SHADOW","G 路径形态",0.013,2.0941,-0.0158,0.001,0.1342,-0.0491,"上下影线结构：上影线主导说明每次上攻遇抛压"],["PE","G 路径形态",0.0153,2.0766,0.0111,0.0245,2.8115,0.0484,"路径效率：净涨幅/路径总长度，越高越像信息驱动"],["TREND_R2","I 自相关",0.0166,2.0402,0.0257,-0.003,-0.3891,-0.0489,"趋势拟合优度：60 日对数价格线性回归 R²"],["CVAR5","D 尾部风险",0.0197,1.9577,-0.0028,0.0104,0.716,-0.0248,"5% 条件在险价值（左尾期望损失，取负号使大=安全）"],["VR20","I 自相关",0.0154,1.9454,0.0045,0.0164,1.573,0.0307,"方差比 20"],["RESMOM60","B 动量反转",0.0191,1.8337,0.009,0.0231,2.0513,0.0706,"残差动量（60 日）：剔除市场 beta 后的特质趋势"],["STREAK","G 路径形态",0.0147,1.8239,-0.0202,0.0195,2.2568,-0.0023,"连续涨跌强度：近 20 日最长连涨减最长连跌"],["IMPACT_ELAST","E 流动性",0.0081,1.6205,-0.029,0.0216,4.6086,0.0088,"冲击弹性：|收益| 对 ln(成交额) 的相关，越负越有深度"],["ILLIQ60","E 流动性",0.0054,1.6075,-0.0108,0.0165,5.6423,0.0045,"Amihud 非流动性 60 日"],["IVOL120","C 波动结构",0.01,1.5302,-0.0301,0.0415,4.7775,-0.0019,"特质波动率 120 日"],["SUPPORT","H 技术位置",0.0147,1.4192,0.0384,-0.0154,-1.4466,-0.0079,"支撑强度：近 60 日触及低点后反弹的幅度均值"],["PEERMOM","B 动量反转",0.0161,1.4118,-0.0045,0.0349,2.5915,0.0487,"同类相对动量：剥离板块 beta 后的组内强弱"],["TAIL_ASYM","D 尾部风险",0.0098,1.3358,-0.0054,0.0167,2.0593,-0.0246,"最大涨幅/最大跌幅：不对称的彩票属性"],["BREAKOUT","H 技术位置",0.0133,1.3335,-0.0108,0.0308,2.6051,-0.0138,"突破强度：收盘突破 60 日高点的幅度"],["DIST_L60","H 技术位置",0.0141,1.3313,0.0167,0,-0.0005,0.0326,"距 60 日低点高度"],["CRASHP","D 尾部风险",0.0069,1.3302,0.0179,-0.0137,-2.3179,-0.0531,"暴跌频率：超过 2 倍标准差的下跌日占比"],["UBETA","D 尾部风险",0.0149,1.2756,0.0275,-0.0089,-0.5401,-0.062,"上行 beta：跟涨能力弱说明弹性差"],["MOM60","B 动量反转",0.0145,1.2742,-0.0076,0.0318,2.4237,0.0455,"3 个月动量"],["MA_SLOPE60","H 技术位置",0.0141,1.2616,-0.0069,0.0285,2.2406,0.0401,"60 日均线斜率"],["RSVOL","C 波动结构",0.012,1.1952,-0.0149,0.0224,1.5221,-0.0109,"Rogers-Satchell 波动率：允许漂移的估计量"],["RSJ","C 波动结构",0.01,1.1732,-0.0234,-0.0165,-1.7268,-0.0999,"已实现偏度：右偏吸引彩票偏好"],["MAX5","D 尾部风险",0.0121,1.1593,-0.026,0.0169,1.1149,-0.0291,"前 5 大单日收益均值：彩票偏好"],["IVOL60","C 波动结构",0.0073,1.1475,-0.0238,0.0424,4.7588,-0.0047,"特质波动率：对市场回归残差的 60 日标准差"],["MAX20","D 尾部风险",0.0097,1.0148,-0.0348,0.0192,1.3449,-0.0238,"单日最大涨幅：最强彩票信号"],["TREND_SLOPE","I 自相关",0.0114,1.014,-0.0323,0.0192,1.5027,0.0192,"趋势斜率：60 日对数价格回归斜率（年化）"],["GKVOL","C 波动结构",0.0104,1.0077,-0.019,0.0232,1.5454,-0.0127,"Garman-Klass 波动率：用高低开收估计，比收盘价法高效"],["YZVOL","C 波动结构",0.01,1.0008,-0.0153,0.017,1.1427,-0.0214,"Yang-Zhang 波动率：同时处理隔夜跳空与日内漂移"],["RUV","C 波动结构",0.0074,0.984,-0.023,-0.0189,-4.1524,-0.0657,"下行方差占比：真实左尾风险暴露"],["AMT_CV","E 流动性",0.0034,0.8083,-0.0163,0.0089,1.9989,0.0106,"成交额变异系数：忽大忽小说明资金不稳定"],["MIN20","D 尾部风险",0.0077,0.7686,0.0324,-0.025,-1.7471,-0.0317,"单日最大跌幅（取绝对值前先保留符号）：超跌反弹"],["LIQ_BETA","E 流动性",0.0068,0.7565,-0.0184,0.0059,0.5122,0.0007,"流动性风险 beta：收益对市场流动性冲击的敏感度"],["OBV_SLOPE","F 量价关系",0.0051,0.7526,-0.0403,0.0085,1.2231,0.0177,"OBV 斜率：能量潮的 20 日趋势"],["GAPFILL","G 路径形态",0.0042,0.6556,-0.0323,0.0131,1.7273,0.0084,"跳空回补率：低开高走的日子占比（下方有承接）"],["AR1_60","I 自相关",0.004,0.5894,-0.0031,-0.0146,-1.8397,-0.0298,"一阶自相关 60 日"],["VWAPDEV5","F 量价关系",0.0024,0.5849,-0.0133,0.0072,2.6391,-0.0308,"VWAP 乖离 5 日：短期的尾盘拉抬"],["VWAPDEV20","F 量价关系",0.0024,0.5699,-0.015,0.0065,2.441,-0.0322,"收盘价相对当日均价（成交额/成交量）的乖离"],["VOV","C 波动结构",0.0032,0.3921,-0.0223,0.0283,3.9114,0.0604,"波动率的波动：风险本身的不确定性"],["MOM20","B 动量反转",0.003,0.2771,-0.0056,0.0137,1.0496,0.0373,"1 个月动量"],["RECOVERY","G 路径形态",0.0016,0.1501,0.0065,-0.0111,-0.8535,0.0289,"修复速度：从 20 日低点反弹的幅度"],["DIST_L20","H 技术位置",0.0012,0.1126,0.0114,-0.0095,-0.7092,0.0361,"距 20 日低点的高度"],["KURT60","D 尾部风险",0.0003,0.0356,-0.0339,0.0041,0.5413,0.0105,"收益峰度 60 日"],["MA_SLOPE20","H 技术位置",-0.0008,-0.0739,-0.0132,0.0126,0.9742,0.0285,"20 日均线斜率"],["ZERO_RET","E 流动性",-0.0005,-0.0894,-0.0356,-0.003,-0.3647,-0.0251,"零收益天数占比：交易稀疏的流动性折价"],["MA_ALIGN","H 技术位置",-0.0011,-0.097,-0.0286,0.0209,1.613,0.0627,"均线多头排列强度：5>20>60 的标准化差值"],["RKURT","C 波动结构",-0.0018,-0.248,-0.0446,0.0181,2.666,0.0271,"已实现峰度：跳跃频发"],["TURN_STAB","E 流动性",-0.0015,-0.3529,-0.0279,-0.0057,-1.3752,-0.0471,"换手稳定性：成交量变异系数的倒数，越不稳定越差"],["ON_VSHARE","A 隔夜日内",-0.0029,-0.5055,-0.0261,-0.0141,-1.8016,-0.0379,"隔夜波动占总波动的比例：定价发生在流动性最差的时点"],["ROLL_SPREAD","E 流动性",-0.0043,-0.5971,-0.0401,0.0072,0.746,0.0526,"Roll 隐含价差：收益负自相关的幅度"],["AR1_20","I 自相关",-0.0044,-0.6067,-0.019,-0.0249,-3.3648,-0.0788,"一阶自相关 20 日：正相关代表趋势延续"],["REV10","B 动量反转",-0.0067,-0.6296,-0.0458,-0.0202,-1.5677,-0.0852,"10 日反转"],["VOL_SKEW","C 波动结构",-0.005,-0.691,-0.0282,0.0073,1.0776,0.0308,"波动率序列本身的偏度：波动放大得越突兀越差"],["VELAST","F 量价关系",-0.0053,-0.8601,0.0419,-0.0131,-1.7808,0.0147,"量价弹性：收益对成交量变化的回归斜率"],["VR5","I 自相关",-0.0064,-0.8747,-0.0368,0.0067,0.8551,0.0005,"方差比 5：5 日收益方差/(5×日方差)，>1 趋势型"],["AMTRET","F 量价关系",-0.0083,-0.8956,-0.0153,0.0033,0.2979,0.0508,"成交额加权收益：大额成交日的方向更能代表知情资金"],["RV_RATIO","C 波动结构",-0.0075,-0.9331,-0.045,-0.0109,-1.314,-0.0571,"短期/长期波动比：波动率冲击后收益走弱"],["REV5","B 动量反转",-0.012,-1.1337,-0.0647,-0.021,-1.6613,-0.0897,"5 日反转"],["DBETA","D 尾部风险",-0.0128,-1.1652,-0.004,0.0117,0.7852,0.0707,"下行 beta：市场下跌时的放大系数"],["HURST","I 自相关",-0.0086,-1.2145,0.0001,0.0027,0.356,-0.0518,"Hurst 指数代理：log(σ5/σ1)/log(5)，>0.5 为持续"],["CORR_RV60","F 量价关系",-0.0072,-1.2315,0.0092,-0.011,-1.9113,0.0029,"收益与成交量变化的相关：放量伴随信息流入"],["ON_ID_CORR","A 隔夜日内",-0.0064,-1.2516,-0.0405,0.0094,1.8949,-0.0015,"隔夜与日内的 60 日相关：负相关说明隔夜是流动性冲击"],["MR_SPEED","I 自相关",-0.0099,-1.3479,-0.0246,-0.0105,-1.2649,-0.0361,"均值回复速度：偏离 20 日均线的回归强度"],["CS_SPREAD","E 流动性",-0.0134,-1.3971,-0.003,-0.0163,-1.1911,0.0235,"Corwin-Schultz 买卖价差：由高低价自协方差反推"],["DIST_H60","H 技术位置",-0.0137,-1.3991,-0.0208,-0.0279,-2.3821,-0.0617,"距 60 日高点距离"],["UPDN_VOL","G 路径形态",-0.0103,-1.4198,-0.0035,0.0018,0.5074,0.0041,"上行波动/下行波动：好波动多说明收益质量高"],["VPS","F 量价关系",-0.0085,-1.4208,-0.017,-0.0005,-0.0675,0.0478,"放量日平均收益：增量资金是否真的推动价格"],["MDD120","G 路径形态",-0.0155,-1.5316,-0.0007,-0.0247,-2.1787,-0.0338,"120 日最大回撤"],["MDD60","G 路径形态",-0.0155,-1.5443,-0.018,-0.0252,-2.1042,-0.0582,"60 日最大回撤：套牢盘出清后的修复空间"],["ID_REV20","A 隔夜日内",-0.0166,-1.6529,-0.0622,-0.0128,-1.121,-0.0456,"日内收益 20 日均值"],["W52LOW","B 动量反转",-0.0223,-1.9569,-0.0509,-0.0055,-0.4047,-0.0209,"距 52 周低点的距离：越远越弱"],["DIST_H20","H 技术位置",-0.0195,-2.0255,-0.042,-0.0348,-2.8536,-0.0672,"距 20 日高点的距离：越近越强（取负使方向为正）"],["ON_WIN","A 隔夜日内",-0.0087,-2.0615,-0.0461,0.0035,0.5518,-0.0108,"隔夜上涨天数占比"],["TUG20","A 隔夜日内",-0.0198,-2.3058,-0.0592,-0.0084,-0.916,-0.0273,"隔夜减日内（拉锯）：隔夜越强越像信息驱动"],["ID_REV5","A 隔夜日内",-0.0236,-2.4098,-0.0864,-0.0266,-2.3579,-0.0829,"日内收益 5 日均值：做市补偿，后续回吐"],["VOL_PERSIST","C 波动结构",-0.0198,-2.5679,-0.0482,0.0286,4.1031,0.0305,"波动率自相关：持续性越强说明风险越难消散"],["CORR_RV20","F 量价关系",-0.0152,-2.6837,-0.0195,-0.0017,-0.2835,0.0444,"收益与成交量变化的相关（20 日）"],["ID_WIN","A 隔夜日内",-0.0201,-2.9683,-0.064,-0.0212,-2.444,-0.0553,"日内上涨天数占比"],["VDS","F 量价关系",-0.0185,-3.103,-0.0187,-0.0208,-2.712,0.023,"缩量日平均收益：缩量阴跌代表买盘缺失"],["TUG60","A 隔夜日内",-0.0279,-3.2131,-0.0524,-0.0106,-1.224,-0.0287,"隔夜减日内 60 日"],["FROG","B 动量反转",-0.0287,-3.32,-0.0724,-0.0017,-0.281,-0.0484,"动量生命周期：涨得越平滑（阴线越少）惯性越强"],["CORR_RA60","F 量价关系",-0.0231,-3.5771,-0.0394,0.0008,0.1003,0.0425,"收益与成交额的相关：大资金推动的方向"],["ON_MOM60","A 隔夜日内",-0.0218,-3.9005,-0.0535,0.0026,0.4284,-0.0048,"隔夜收益 60 日均值（更慢的隔夜动量）"],["AMT_TREND","E 流动性",-0.0244,-4.7561,-0.0646,0.014,2.3025,0.05,"成交额趋势斜率：资金持续流入 vs 持续撤离"],["VOL_ASYM","F 量价关系",-0.0294,-4.9516,-0.0527,0.0017,0.3043,0.021,"涨跌量比：上涨日成交量/下跌日成交量"],["VPDIV","F 量价关系",-0.0238,-5.1816,-0.0387,-0.0079,-1.4576,0.0177,"量价背离：价格接近高点但成交额没有跟上"],["ON_MOM20","A 隔夜日内",-0.0308,-5.7706,-0.0647,0.0072,1.0679,0.0085,"隔夜收益 20 日均值：机构主导时段的信息持续性"],["a001","Alpha101",0.031,3.8782,0.0187,0.0199,2.3867,-0.0178,""],["a022","Alpha101",0.0185,3.8393,-0.0508,0.0066,1.1629,-0.05,""],["a018","Alpha101",0.0251,3.7947,0.0135,0.0171,2.1915,-0.0084,""],["a101","Alpha101",0.0327,3.6397,0.0224,0.0414,3.9361,0.0206,""],["a071","Alpha101",0.0112,3.5822,-0.0058,0.0071,2.0704,-0.0161,""],["a054","Alpha101",0.0277,3.4476,0.004,0.0274,2.5615,-0.0451,""],["a030","Alpha101",0.0233,3.3921,-0.0247,0.0181,2.3502,-0.0131,""],["a039","Alpha101",0.0349,3.3856,0.044,0.0271,2.4752,0.0313,""],["a066","Alpha101",0.011,3.3338,-0.0312,0.0029,0.9798,-0.0496,""],["a032","Alpha101",0.0271,3.2341,0.0369,0.0212,3.9528,-0.0093,""],["a033","Alpha101",0.03,3.1669,0.0086,0.035,3.1991,0.0343,""],["a095","Alpha101",0.0118,3.0246,-0.0045,0.0088,1.9552,-0.0145,""],["a047","Alpha101",0.0248,2.9785,0.0022,0.0295,2.8801,-0.0113,""],["a019","Alpha101",0.0298,2.9469,0.0452,0.0148,1.488,0.0388,""],["a045","Alpha101",0.0109,2.8027,-0.0343,0.0074,1.8209,-0.0423,""],["a038","Alpha101",0.0262,2.7917,0.0255,0.0284,2.6568,0.0528,""],["a055","Alpha101",0.0105,2.651,-0.0085,-0.0164,-4.3247,-0.0286,""],["a061","Alpha101",0.0105,2.6345,-0.0081,0.0095,1.5845,-0.0349,""],["a021","Alpha101",0.017,2.5719,-0.0246,0.0278,3.2672,-0.0253,""],["a059","Alpha101",0.0104,2.5421,-0.0198,0.0087,2.1051,-0.0446,""],["a042","Alpha101",0.0135,2.5012,0.0092,0.0171,2.557,-0.0253,""],["a056","Alpha101",0.0179,2.4625,-0.0241,0.0374,4.6076,0.0564,""],["a062","Alpha101",0.0104,2.375,-0.0473,0.0035,0.7337,-0.0344,""],["a010","Alpha101",0.0175,2.354,-0.0325,0.0005,0.0564,-0.0388,""],["a087","Alpha101",0.0098,2.3126,-0.019,0.0004,0.0901,-0.0607,""],["a015","Alpha101",0.0082,2.3081,-0.0378,0.0159,4.4981,-0.0388,""],["a093","Alpha101",0.0145,2.2056,-0.022,0.0176,2.624,-0.0016,""],["a086","Alpha101",0.0084,2.0833,0.0165,0.0024,0.5614,-0.0311,""],["a051","Alpha101",0.0211,2.0791,0.0147,0.0281,2.444,0.0245,""],["a099","Alpha101",0.0079,2.0269,0.0122,0.0094,2.0887,0.029,""],["a004","Alpha101",0.0167,1.9906,0.0044,0.0179,1.7679,0.0319,""],["a079","Alpha101",0.0067,1.9107,-0.0226,0.0056,1.2532,-0.0267,""],["a048","Alpha101",0.0131,1.8612,-0.0366,-0.0168,-1.7648,-0.0604,""],["a043","Alpha101",0.01,1.8338,-0.0579,0.0103,1.4707,-0.0487,""],["a070","Alpha101",0.009,1.8295,-0.022,0.0086,1.5096,-0.0303,""],["a027","Alpha101",0.007,1.8042,-0.0046,-0.0096,-2.7561,-0.026,""],["a031","Alpha101",0.0117,1.7812,-0.0436,0.0115,1.6621,-0.0692,""],["a012","Alpha101",0.0094,1.781,-0.0458,0.024,3.9361,-0.0568,""],["a044","Alpha101",0.0071,1.7453,-0.0488,0.017,3.9826,-0.0462,""],["a100","Alpha101",0.0091,1.6838,-0.0212,0.0106,1.6096,-0.0338,""],["a028","Alpha101",0.0085,1.6809,-0.0561,-0.0105,-1.7006,-0.1201,""],["a097","Alpha101",0.0063,1.652,-0.0111,0.0049,1.9269,-0.033,""],["a017","Alpha101",0.0134,1.6204,-0.0083,0.0103,1.1257,-0.0079,""],["a009","Alpha101",0.0138,1.6152,-0.0175,0.0109,1.104,-0.0099,""],["a049","Alpha101",0.0165,1.5881,0.015,0.0259,2.1469,0.0258,""],["a096","Alpha101",0.0057,1.5745,-0.0607,-0.0001,-0.0273,-0.062,""],["a025","Alpha101",0.0123,1.5631,-0.0152,0.0268,2.8833,0.013,""],["a075","Alpha101",0.0051,1.4986,-0.0255,0.0083,2.1159,-0.0302,""],["a029","Alpha101",0.012,1.4538,-0.0163,0.0129,1.3459,0.0286,""],["a040","Alpha101",0.0075,1.2997,-0.0494,0.0142,1.8347,-0.0592,""],["a085","Alpha101",0.0068,1.2994,-0.016,-0.0165,-3.1124,-0.0852,""],["a072","Alpha101",0.0051,1.1434,-0.0192,0.0079,2.0842,-0.0461,""],["a058","Alpha101",0.0044,1.1347,-0.0634,0.0114,2.8854,-0.0539,""],["a088","Alpha101",0.008,1.0789,-0.0563,0.0061,0.5492,-0.0628,""],["a023","Alpha101",0.0089,1.0646,0.003,-0.0016,-0.1657,0.0099,""],["a024","Alpha101",0.0077,1.0486,-0.0549,-0.0028,-0.3311,-0.123,""],["a046","Alpha101",0.0074,1.0323,-0.044,-0.0054,-0.5894,-0.1093,""],["a034","Alpha101",0.0091,1.0284,-0.0364,0.0351,3.737,0.0432,""],["a090","Alpha101",0.008,0.9716,-0.0218,0.014,1.5098,-0.0414,""],["a091","Alpha101",0.0045,0.9692,-0.0498,0.0041,0.8149,-0.0513,""],["a026","Alpha101",0.0044,0.9508,-0.05,0.0162,3.0299,-0.0544,""],["a053","Alpha101",0.005,0.8979,-0.056,0.0053,0.7429,-0.044,""],["a078","Alpha101",0.0047,0.8522,-0.0215,0.0059,1.1809,-0.0122,""],["a080","Alpha101",0.0059,0.835,-0.047,0.0109,1.3564,-0.0411,""],["a065","Alpha101",0.0049,0.8253,-0.0032,0.0069,0.8771,0.0276,""],["a036","Alpha101",0.0041,0.8188,-0.0235,-0.0017,-0.3509,-0.0715,""],["a092","Alpha101",0.0031,0.812,-0.0322,0.0101,2.3923,-0.0103,""],["a082","Alpha101",0.0068,0.7566,0,0.0242,2.3902,0.0611,""],["a052","Alpha101",0.0067,0.6747,-0.0016,-0.0232,-2.0916,-0.0964,""],["a005","Alpha101",0.0028,0.6687,-0.0261,0.0066,2.4627,-0.0236,""],["a014","Alpha101",0.0034,0.6685,-0.03,-0.0134,-2.2444,-0.0481,""],["a068","Alpha101",0.0022,0.6667,-0.0574,-0.0014,-0.4546,-0.0473,""],["a041","Alpha101",0.0027,0.6609,-0.0245,0.0071,2.6067,-0.0169,""],["a007","Alpha101",0.0044,0.6461,0.0016,0.0042,0.4928,0.0192,""],["a002","Alpha101",0.0026,0.6386,-0.0014,-0.0084,-2.2129,-0.0218,""],["a083","Alpha101",0.0026,0.6182,-0.0114,0.0069,2.603,-0.008,""],["a081","Alpha101",0.0021,0.5853,0.007,0.0027,0.6265,0.0045,""],["a013","Alpha101",0.0025,0.5739,-0.0179,-0.0063,-1.6129,-0.0162,""],["a069","Alpha101",0.0032,0.5163,-0.0119,-0.0078,-1.0795,-0.0213,""],["a089","Alpha101",0.0029,0.4949,-0.0521,0.0075,1.0429,-0.0762,""],["a077","Alpha101",0.002,0.4916,-0.0114,-0.0036,-1.0425,0.0129,""],["a050","Alpha101",0.0019,0.4729,-0.0209,-0.0088,-2.404,-0.0278,""],["a020","Alpha101",0.0025,0.4484,-0.0019,-0.0092,-1.3023,-0.0441,""],["a098","Alpha101",0.0019,0.4276,-0.022,0.0076,1.5039,0.0159,""],["a006","Alpha101",0.0021,0.4097,-0.0338,-0.0134,-2.2641,-0.0425,""],["a037","Alpha101",0.0027,0.3804,-0.0352,0.0121,1.6964,-0.0183,""],["a008","Alpha101",0.0033,0.3649,0.0035,0.0149,1.4056,-0.0078,""],["a064","Alpha101",0.0013,0.3595,0.0089,0.017,3.6211,0.0248,""],["a063","Alpha101",0.0024,0.3358,0.0088,0.0056,0.7699,-0.0191,""],["a003","Alpha101",0.0013,0.3344,-0.0558,-0.0165,-4.1118,-0.0305,""],["a035","Alpha101",0.0022,0.3109,-0.074,-0.012,-1.4001,-0.073,""],["a057","Alpha101",0.0013,0.3032,-0.0202,0.0091,3.48,-0.0325,""],["a073","Alpha101",0.0021,0.2774,-0.0287,0.0125,1.3308,-0.0087,""],["a076","Alpha101",0.0007,0.1637,-0.0483,-0.0014,-0.3216,-0.0595,""],["a060","Alpha101",0.001,0.1564,-0.0694,-0.0055,-0.7764,-0.0858,""],["a074","Alpha101",0.0004,0.1058,-0.0306,0.0052,1.2385,-0.0308,""],["a067","Alpha101",0.0007,0.092,-0.0369,0.0162,2.0987,-0.0175,""],["a094","Alpha101",0.0005,0.0857,-0.0396,-0.0088,-1.0832,-0.0608,""],["a084","Alpha101",-0.0003,-0.0376,-0.0405,0.0058,0.6719,-0.016,""],["a011","Alpha101",-0.0002,-0.0504,0.0119,-0.0059,-2.272,-0.022,""],["a016","Alpha101",-0.0002,-0.0508,-0.0183,-0.0078,-1.9203,-0.0256,""]],"sens":[[10,10,0.1,0.1344,0.0965],[10,10,0.2,0.1077,0.0948],[10,10,0.3,0.07,0.0808],[10,20,0.1,0.1157,0.0846],[10,20,0.2,0.0947,0.0845],[10,20,0.3,0.0646,0.0712],[10,30,0.1,0.1078,0.0455],[10,30,0.2,0.0891,0.0478],[10,30,0.3,0.0648,0.0353],[20,10,0.1,0.1467,0.1435],[20,10,0.2,0.1053,0.1322],[20,10,0.3,0.0712,0.0954],[20,20,0.1,0.1496,0.1591],[20,20,0.2,0.1128,0.1264],[20,20,0.3,0.0828,0.0808],[20,30,0.1,0.13,0.0839],[20,30,0.2,0.112,0.075],[20,30,0.3,0.0809,0.0434],[40,10,0.1,0.1203,0.0269],[40,10,0.2,0.0906,0.0593],[40,10,0.3,0.0682,0.0625],[40,20,0.1,0.0984,-0.0202],[40,20,0.2,0.0637,0.0388],[40,20,0.3,0.0467,0.0456],[40,30,0.1,0.0494,-0.0583],[40,30,0.2,0.0293,0.0062],[40,30,0.3,0.0246,0.0241],[60,10,0.1,-0.0035,-0.0598],[60,10,0.2,0.0113,0.0119],[60,10,0.3,0.0006,0.0339],[60,20,0.1,-0.0047,-0.0548],[60,20,0.2,0.0123,0.0207],[60,20,0.3,-0.0023,0.0396],[60,30,0.1,0.0012,-0.0693],[60,30,0.2,0.0093,-0.0001],[60,30,0.3,-0.0012,0.0239],[120,10,0.1,0.1186,-0.0267],[120,10,0.2,0.0652,0.007],[120,10,0.3,0.0444,0.0144],[120,20,0.1,0.1112,-0.0509],[120,20,0.2,0.0664,-0.0098],[120,20,0.3,0.0415,0.0071],[120,30,0.1,0.0841,-0.0698],[120,30,0.2,0.0574,-0.0306],[120,30,0.3,0.0321,-0.0113]]};
var SEC_HIST = {"d":["2025-10-28","2025-10-29","2025-10-30","2025-10-31","2025-11-03","2025-11-04","2025-11-05","2025-11-06","2025-11-07","2025-11-10","2025-11-11","2025-11-12","2025-11-13","2025-11-14","2025-11-17","2025-11-18","2025-11-19","2025-11-20","2025-11-21","2025-11-24","2025-11-25","2025-11-26","2025-11-27","2025-11-28","2025-12-01","2025-12-02","2025-12-03","2025-12-04","2025-12-05","2025-12-08","2025-12-09","2025-12-10","2025-12-11","2025-12-12","2025-12-15","2025-12-16","2025-12-17","2025-12-18","2025-12-19","2025-12-22","2025-12-23","2025-12-24","2025-12-25","2025-12-26","2025-12-29","2025-12-30","2025-12-31","2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09","2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16","2026-01-19","2026-01-20","2026-01-21","2026-01-22","2026-01-23","2026-01-26","2026-01-27","2026-01-28","2026-01-29","2026-01-30","2026-02-02","2026-02-03","2026-02-04","2026-02-05","2026-02-06","2026-02-09","2026-02-10","2026-02-11","2026-02-12","2026-02-13","2026-02-24","2026-02-25","2026-02-26","2026-02-27","2026-03-02","2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-09","2026-03-10","2026-03-11","2026-03-12","2026-03-13","2026-03-16","2026-03-17","2026-03-18","2026-03-19","2026-03-20","2026-03-23","2026-03-24","2026-03-25","2026-03-26","2026-03-27","2026-03-30","2026-03-31","2026-04-01","2026-04-02","2026-04-03","2026-04-07","2026-04-08","2026-04-09","2026-04-10","2026-04-13","2026-04-14","2026-04-15","2026-04-16","2026-04-17","2026-04-20","2026-04-21","2026-04-22","2026-04-23","2026-04-24","2026-04-27","2026-04-28","2026-04-29","2026-04-30","2026-05-06","2026-05-07","2026-05-08","2026-05-11","2026-05-12","2026-05-13","2026-05-14","2026-05-15","2026-05-18","2026-05-19","2026-05-20","2026-05-21","2026-05-22","2026-05-25","2026-05-26","2026-05-27","2026-05-28","2026-05-29","2026-06-01","2026-06-02","2026-06-03","2026-06-04","2026-06-05","2026-06-08","2026-06-09","2026-06-10","2026-06-11","2026-06-12","2026-06-15","2026-06-16","2026-06-17","2026-06-18","2026-06-22","2026-06-23","2026-06-24","2026-06-25","2026-06-26","2026-06-29","2026-06-30","2026-07-01","2026-07-02","2026-07-03","2026-07-06","2026-07-07","2026-07-08","2026-07-09","2026-07-10","2026-07-13","2026-07-14","2026-07-15","2026-07-16","2026-07-17","2026-07-20","2026-07-21","2026-07-22","2026-07-23","2026-07-24","2026-07-27","2026-07-28","2026-07-29","2026-07-30","2026-07-31","2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07","2026-08-10","2026-08-11","2026-08-12","2026-08-13","2026-08-14","2026-08-17","2026-08-18","2026-08-19","2026-08-20","2026-08-21","2026-08-24","2026-08-25","2026-08-26","2026-08-27","2026-08-28","2026-08-31","2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-07","2026-09-08","2026-09-09","2026-09-10","2026-09-11","2026-09-14","2026-09-15","2026-09-16","2026-09-17","2026-09-18","2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-28","2026-09-29","2026-09-30","2026-10-08","2026-10-09","2026-10-12","2026-10-13","2026-10-14","2026-10-15","2026-10-16","2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-26","2026-10-27","2026-10-28","2026-10-29","2026-10-30","2026-11-02","2026-11-03","2026-11-04","2026-11-05","2026-11-06"],"s":{"hk/港股金融":[424,559,320,274,212,263,228,342,242,334,280,237,231,184,209,243,239,269,185,183,198,167,228,230,200,193,236,192,405,396,229,257,180,307,358,277,395,345,307,327,328,384,433,479,303,278,331,273,429,271,286,323,309,234,311,234,282,255,274,240,283,226,326,296,244,316,275,247,210,245,246,194,237,144,196,131,225,162,257,186,188,181,218,176,162,193,168,147,161,159,177,155,266,163,191,168,216,216,162,187,150,150,181,149,100,154,150,206,159,391,250,215,117,220,188,209,178,273,183,127,198,259,287,250,225,178,211,260,225,204,151,168,152,188,169,235,160,199,188,197,154,191,152,157,182,148,164,183,173,198,188,283,324,299,239,191,410,287,205,319,217,154,201,329,154,186,133,122,115,139,132,131,125,169,102,156,158,170,143,180,133,142,138,138,132,131,103,113,149,112,107,135,101,127,119,87,119,95,130,65,124,115,91,226,203,195,161,224,155,219,210,214,162,156,197,171,122,118,169,127,144,128,105,107,137,139,99,83,86,129,144,132,111,156,108,148,136,112,113,145,126,115,111,150,138,213,182,141,94,90],"hk/港股医药":[167,153,210,431,453,305,318,276,304,289,246,409,401,401,321,303,305,277,255,269,305,433,306,325,273,260,266,324,201,243,328,240,317,253,232,241,185,240,283,245,274,249,193,124,208,232,200,304,204,352,342,331,263,327,268,264,273,319,248,276,233,297,265,253,228,185,260,175,194,222,198,250,234,430,281,232,202,214,198,206,241,198,178,211,269,278,237,281,286,308,270,285,281,292,249,268,241,285,226,309,410,410,368,477,554,499,521,315,413,253,338,376,521,324,448,290,349,290,376,423,274,357,250,320,252,289,240,342,350,244,222,276,250,301,335,296,244,181,233,276,265,360,329,220,303,326,349,283,333,355,328,339,261,232,277,400,212,337,376,310,337,456,369,479,444,439,522,384,350,363,499,418,468,505,486,418,405,384,439,419,457,420,341,336,362,285,312,352,365,426,569,508,548,447,553,492,530,463,489,665,495,469,593,524,520,422,454,380,471,482,393,345,483,421,400,374,564,408,462,511,501,574,447,545,504,470,587,650,522,484,457,452,375,469,564,537,540,488,401,440,424,535,529,484,470,414,393,473,405,450],"a/机械":[42,42,41,39,36,60,61,77,72,53,47,63,45,42,34,37,53,41,70,49,49,45,49,55,53,56,54,85,68,65,60,50,62,55,54,52,56,47,49,63,39,53,100,76,71,112,89,73,57,57,55,56,59,64,62,54,89,120,127,92,80,70,92,78,67,53,58,67,60,56,63,69,65,77,60,85,99,113,83,88,108,83,79,103,100,106,97,97,92,96,83,69,72,75,80,63,73,69,79,77,56,48,63,54,63,49,62,75,58,65,62,67,82,93,80,81,90,81,81,66,68,71,57,62,71,88,100,84,83,89,81,120,104,97,79,95,88,80,104,83,80,70,67,73,77,77,104,110,95,89,80,65,58,80,72,66,79,64,52,47,51,52,63,60,58,92,95,72,71,65,51,54,43,39,41,47,42,44,38,57,52,52,46,49,44,55,57,51,52,56,57,44,55,40,50,44,56,58,65,42,41,37,46,33,50,44,39,36,33,41,37,38,31,44,37,34,26,29,33,42,38,38,35,34,31,42,36,29,39,34,31,33,36,38,40,49,68,51,53,75,91,68,99,83,78,67,64,64,56,58],"a/材料":[18,15,21,24,24,20,17,31,58,50,24,35,33,26,38,43,32,20,20,28,24,19,23,18,26,28,24,16,20,17,18,13,12,14,15,14,28,22,20,23,14,20,16,21,29,23,19,21,24,25,22,23,24,18,17,20,20,38,37,33,43,35,42,35,41,34,35,49,33,26,35,57,35,29,43,33,40,37,75,37,39,47,37,34,26,40,43,33,41,36,39,59,47,41,43,47,33,25,32,30,31,26,27,38,23,20,30,41,36,25,32,21,23,21,28,23,26,15,24,29,22,19,30,20,26,36,19,26,20,17,26,25,30,16,21,14,15,18,15,11,16,19,13,14,12,24,13,17,14,14,16,29,26,19,19,25,21,18,19,15,13,14,14,16,18,17,21,19,17,17,10,11,12,8,10,13,12,10,12,16,14,11,11,11,13,8,11,9,12,13,11,13,17,17,18,10,11,12,10,10,10,13,17,16,16,23,14,16,15,15,14,13,13,17,14,15,15,20,11,13,9,15,11,16,14,17,13,16,17,13,17,14,15,15,13,10,8,12,12,10,9,10,9,9,9,8,11,8,11,8],"a/电池储能":[40,59,64,69,54,52,72,48,64,64,46,52,103,70,66,60,53,43,59,42,37,31,45,41,32,29,33,26,26,26,33,27,36,42,28,26,33,32,31,26,36,29,23,36,43,32,21,24,25,29,27,21,32,24,21,23,19,19,22,17,22,23,20,21,24,19,19,18,16,20,18,29,18,18,25,31,18,18,26,29,20,16,17,16,13,17,18,30,50,45,35,32,35,26,30,48,44,36,30,40,54,48,51,30,31,32,24,24,21,50,55,55,50,58,35,52,57,49,37,38,38,38,65,50,46,46,46,39,39,35,34,34,31,31,55,31,29,32,30,38,34,31,28,27,25,29,40,22,23,22,22,31,26,38,23,24,28,29,24,19,20,17,16,17,15,13,13,15,19,22,14,15,12,13,14,13,13,16,14,22,16,28,17,20,13,13,13,13,17,21,16,14,17,13,15,14,17,14,15,16,17,17,19,15,15,14,19,15,15,21,14,13,13,15,14,14,14,17,16,12,15,15,16,16,15,14,21,16,21,35,24,25,26,18,20,13,16,29,18,18,16,12,15,15,13,17,23,17,26,24],"a/军工":[61,52,42,36,30,37,30,30,39,29,32,61,31,33,65,41,71,36,47,86,53,58,43,45,47,51,52,47,54,58,39,39,54,52,74,51,55,87,66,56,57,74,99,73,64,70,77,64,52,63,76,121,111,114,83,80,57,72,70,47,74,94,76,53,51,37,42,37,54,55,38,45,47,54,58,46,59,59,62,66,54,94,70,53,45,61,50,47,44,50,49,32,37,40,35,32,35,37,37,38,33,41,49,34,34,40,29,47,37,39,37,49,50,44,40,76,60,50,53,47,44,47,37,46,45,40,61,50,53,46,54,42,38,37,28,32,34,37,35,32,31,41,27,33,35,26,34,33,27,28,27,44,31,28,30,28,26,22,20,19,22,20,29,20,22,30,31,27,25,24,57,55,36,24,23,26,24,22,20,22,22,28,20,21,21,22,24,20,19,20,21,25,25,19,19,19,19,18,33,21,21,17,18,19,21,27,26,22,40,27,30,23,26,47,38,27,27,24,21,23,23,27,23,23,22,23,22,19,24,27,23,37,34,25,44,40,32,32,27,26,30,30,26,39,33,28,28,28,21,21],"a/医药":[53,54,79,79,73,93,62,52,59,62,59,81,87,92,88,61,75,63,79,65,72,89,88,90,74,87,88,73,80,48,70,72,72,64,69,66,60,61,82,57,52,51,58,47,55,43,58,100,73,66,72,71,60,77,69,56,52,55,52,55,59,60,70,70,71,50,51,61,44,62,61,60,50,67,45,47,52,48,41,50,39,52,43,46,36,55,45,51,37,40,35,34,57,44,50,47,66,47,41,57,100,78,76,130,99,87,79,62,68,60,55,66,81,69,91,59,56,49,52,50,44,83,58,49,52,45,49,65,75,54,68,46,52,46,40,62,51,45,37,52,44,53,55,56,48,50,46,53,49,48,38,43,35,34,29,52,47,64,75,61,49,110,76,89,83,89,121,103,81,73,75,68,82,145,114,99,80,63,70,69,75,75,53,63,66,48,52,70,59,57,124,129,107,81,108,101,76,70,63,149,128,105,93,80,66,57,72,54,68,78,59,41,63,60,74,58,80,47,46,69,71,117,77,105,93,68,85,126,98,72,77,70,66,69,102,71,65,71,70,63,75,78,60,67,82,56,67,87,62,69],"a/计算机":[50,39,40,49,40,39,36,34,42,28,34,38,33,28,36,35,31,36,35,46,40,40,38,37,31,34,46,29,59,37,36,42,36,31,31,30,58,35,32,36,27,29,43,36,31,27,39,41,48,46,33,42,104,119,139,124,88,79,62,51,56,59,52,40,42,49,52,47,35,55,39,45,47,49,38,47,51,56,36,40,49,33,32,30,27,32,39,45,29,26,32,29,31,36,29,35,32,26,33,29,27,24,23,26,35,26,23,41,32,40,28,33,27,37,30,29,30,51,28,29,28,38,34,28,51,42,44,41,42,42,43,35,33,36,28,40,31,32,28,30,31,27,45,36,33,32,27,26,27,26,31,24,26,25,23,24,35,30,29,27,30,23,25,28,22,20,21,23,31,31,33,31,30,24,29,29,25,26,30,25,30,27,20,28,24,49,44,38,43,37,41,28,34,32,41,38,33,42,31,22,24,24,22,27,30,45,39,36,31,34,47,36,26,27,26,24,22,26,27,21,27,26,40,38,27,27,28,25,25,29,23,26,28,27,28,23,28,33,27,44,54,40,31,35,38,48,40,32,25,26],"a/资源":[90,87,102,71,102,85,101,86,84,79,74,73,100,112,105,82,83,82,101,74,67,55,66,73,109,103,90,96,97,92,96,80,91,89,82,81,81,85,103,107,82,115,101,126,196,185,138,109,112,145,136,118,113,100,98,158,144,120,126,132,124,119,173,197,232,288,276,196,286,189,171,166,134,129,174,173,163,159,175,152,189,291,347,354,296,239,259,271,283,264,282,269,215,220,277,246,261,373,231,248,233,216,185,198,230,227,263,202,191,146,160,158,145,143,117,122,122,119,155,114,104,134,146,134,121,143,117,106,109,109,89,107,105,96,87,75,95,107,105,86,91,72,91,102,107,127,90,126,97,94,111,110,159,132,107,101,110,112,104,88,74,65,60,50,69,85,79,67,70,66,45,48,97,57,52,64,59,64,77,104,106,75,65,59,64,53,60,60,86,130,108,105,131,111,97,85,82,73,66,96,109,116,117,147,105,102,148,134,158,126,103,92,113,130,120,134,116,114,114,140,97,102,98,107,114,119,115,85,108,134,111,86,113,95,98,82,103,77,118,94,104,95,89,95,115,124,92,91,94,91],"a/人工智能":[66,57,57,67,47,49,45,57,49,53,54,59,43,60,50,48,58,48,59,51,72,104,82,57,65,53,63,53,39,67,80,79,78,62,49,44,56,54,51,56,35,45,39,41,45,40,43,51,43,40,39,49,71,79,62,54,56,53,56,47,45,37,40,54,42,35,44,48,47,64,38,45,57,39,50,60,50,58,40,49,42,34,34,35,42,26,37,42,30,33,28,27,32,51,39,39,35,32,40,35,30,31,35,47,42,46,35,63,53,60,45,57,60,79,83,57,52,66,59,76,52,48,46,54,58,51,43,48,54,58,57,59,50,67,47,49,52,53,46,53,61,55,54,54,73,51,68,53,56,46,57,36,51,48,45,61,48,52,46,52,50,46,59,47,48,40,41,47,47,55,39,56,48,41,53,56,47,51,51,50,42,47,58,46,51,49,37,53,51,45,51,43,39,38,51,41,49,42,47,44,49,50,41,37,45,46,37,39,37,44,37,61,36,34,34,35,38,33,49,45,68,54,65,48,38,64,68,56,52,53,41,56,48,55,44,47,48,57,57,60,52,48,51,64,61,51,59,53,40,46],"a/农业":[6,8,5,8,7,6,6,6,8,10,9,9,9,9,15,5,10,8,9,7,5,6,9,9,6,15,14,8,4,6,5,6,7,4,8,6,6,6,8,10,4,15,5,8,13,6,5,8,9,6,4,5,6,4,3,4,5,6,5,9,4,3,8,5,7,7,11,10,4,8,7,6,5,4,5,5,12,5,6,6,6,6,5,11,11,20,19,14,13,19,15,13,17,14,12,15,14,9,10,9,9,12,10,7,14,13,11,9,10,10,16,15,12,13,12,9,8,10,9,9,10,12,17,11,8,10,9,15,10,8,8,6,10,8,7,5,6,6,6,6,5,4,5,6,5,7,8,6,5,6,5,6,7,7,5,5,5,5,5,6,7,6,5,7,6,6,8,8,7,5,5,5,4,6,8,6,6,5,5,6,6,5,4,5,6,3,5,5,4,5,5,8,7,5,6,6,7,15,11,11,9,8,10,8,11,14,12,19,16,12,21,14,19,18,17,10,12,14,13,17,10,13,9,13,9,10,8,9,9,7,9,7,9,10,10,6,8,17,10,9,7,6,7,7,6,7,9,5,6,8],"hk/港股红利":[29,24,30,20,31,51,28,36,55,42,60,70,55,52,74,59,71,52,49,48,46,56,60,68,74,119,82,54,42,49,67,75,74,50,55,65,43,54,57,71,67,58,85,74,84,57,65,55,58,42,41,40,29,40,34,51,47,69,50,49,78,74,59,61,69,66,85,77,54,62,53,62,76,50,63,73,59,77,84,65,67,78,110,99,91,53,85,79,78,95,97,58,55,71,85,59,65,70,60,68,61,47,50,42,39,49,60,34,47,31,44,35,35,29,34,40,61,48,48,31,57,40,56,61,43,52,66,42,53,49,38,50,71,58,53,48,57,90,42,63,77,39,48,34,42,46,42,64,39,42,44,36,55,58,68,70,53,46,38,43,51,27,39,30,43,44,27,36,35,26,23,32,33,28,24,37,42,44,32,41,55,29,64,53,54,62,52,46,58,70,39,41,31,51,29,38,38,36,37,28,44,50,51,50,44,38,44,64,54,40,35,51,42,69,56,56,39,82,45,46,33,33,54,55,47,50,33,31,43,34,60,66,55,66,35,36,42,44,51,45,42,36,33,48,48,51,71,41,33,39],"hk/港股科技":[180,111,212,138,155,181,190,162,171,147,198,141,150,154,182,189,179,210,256,227,197,161,203,183,205,188,213,216,167,150,170,213,190,178,178,218,171,191,173,177,162,157,119,140,173,195,196,164,157,158,171,146,163,169,185,200,188,173,215,214,207,193,177,174,213,218,179,252,253,219,219,240,202,174,219,248,268,236,194,251,220,255,247,249,225,218,266,232,235,230,225,252,215,238,230,233,234,215,238,207,174,195,192,169,158,138,110,224,187,154,185,187,151,202,162,216,193,168,201,213,252,167,197,194,259,255,267,188,189,240,261,275,273,229,246,204,320,304,315,282,256,214,248,281,237,303,255,272,251,235,247,155,184,209,232,185,170,181,207,165,220,178,215,81,175,185,173,220,220,231,176,213,200,124,160,171,183,202,193,182,176,206,208,221,203,233,211,183,182,178,130,148,125,162,150,184,157,180,152,110,148,168,132,98,130,140,175,143,164,136,158,200,171,164,181,198,129,182,167,136,175,118,139,112,154,164,140,113,158,156,156,164,189,160,134,118,140,177,216,176,230,166,182,145,145,160,168,167,172,172],"a/金融":[288,272,237,197,257,246,238,210,218,194,318,209,207,214,246,290,242,350,239,239,250,222,208,254,258,239,237,236,281,308,235,257,268,235,281,354,249,278,269,212,372,233,214,248,177,208,191,175,277,204,242,179,134,83,142,142,113,145,164,188,160,154,119,172,147,128,122,170,139,159,174,170,206,146,174,164,173,147,153,170,164,105,105,111,159,172,126,109,144,156,166,173,195,175,169,158,149,125,174,167,155,195,165,149,154,200,181,146,167,223,177,129,157,180,187,185,193,180,136,141,167,167,175,180,152,153,149,180,125,154,141,100,146,126,153,148,154,115,154,142,192,161,153,140,128,153,133,143,186,187,180,189,184,183,166,176,178,184,158,162,158,108,114,129,142,132,115,143,105,100,106,177,108,184,193,148,219,141,115,160,167,159,176,127,127,100,135,164,101,143,128,162,162,182,132,243,178,212,183,183,220,184,178,218,167,198,193,228,227,172,209,206,276,233,272,286,313,173,161,149,118,132,157,132,223,132,143,185,143,151,178,190,172,187,169,183,216,189,180,142,182,241,172,139,144,171,171,121,106,114],"a/新能源":[11,19,17,18,17,14,23,22,24,20,16,23,24,20,15,21,19,16,16,13,13,13,17,15,15,15,13,11,10,10,9,10,15,13,9,11,13,9,10,12,14,34,10,32,18,10,10,13,10,8,9,10,9,7,8,8,9,10,10,10,10,18,15,14,13,8,11,14,15,17,17,15,15,13,11,14,15,10,16,13,12,11,10,10,9,9,14,14,19,18,20,19,19,19,15,23,27,20,21,29,24,19,19,20,17,17,15,14,21,20,24,22,23,29,19,15,23,17,18,16,16,21,31,17,19,16,17,13,20,16,15,17,19,17,16,13,18,15,15,17,15,17,15,14,12,15,14,14,17,18,12,9,13,17,12,11,12,12,12,12,16,11,11,11,9,9,9,9,11,10,8,9,8,7,9,8,7,8,8,12,10,12,10,13,10,10,9,10,9,10,10,12,10,10,8,8,10,9,10,8,11,10,11,11,9,11,13,9,11,14,11,10,10,11,10,10,14,13,10,10,12,11,12,12,11,14,15,10,16,14,14,15,13,15,14,11,11,14,12,13,12,10,9,11,12,12,12,12,15,19],"a/消费":[46,43,59,63,56,57,58,41,40,154,93,88,86,75,69,49,51,46,52,55,57,49,57,58,56,68,84,69,39,46,72,56,45,63,66,47,49,55,65,65,49,56,57,47,51,35,49,58,49,46,35,32,41,41,36,30,39,38,46,57,32,31,46,37,40,96,67,59,49,71,95,67,58,63,46,57,43,55,37,35,26,34,29,36,31,48,28,26,23,30,37,37,46,33,31,30,35,25,26,33,36,34,51,35,34,30,30,40,37,45,43,58,40,32,54,33,39,27,51,33,34,28,39,35,38,34,34,30,35,32,42,30,29,26,25,22,27,29,23,56,31,50,30,31,33,29,29,28,26,31,23,24,21,25,26,28,27,24,24,28,19,28,23,20,18,20,24,24,21,20,21,18,17,39,33,27,34,32,31,26,25,24,30,36,44,32,28,32,29,28,31,37,29,35,29,26,32,20,17,16,21,25,23,21,21,23,27,35,25,27,44,31,24,32,37,24,24,23,20,21,16,26,21,31,24,23,20,31,24,21,28,24,28,28,30,42,24,29,26,44,30,24,28,28,54,65,55,41,35,33],"hk/港股汽车":[4,2,5,3,3,3,3,6,5,4,14,6,4,3,3,6,4,5,4,4,3,3,6,7,7,4,4,4,4,2,2,2,3,2,1,3,2,2,4,6,2,3,2,7,7,3,5,3,4,3,2,2,4,4,3,5,4,3,3,3,3,2,3,3,4,3,3,4,3,3,3,5,4,3,9,5,4,5,5,3,3,4,7,5,4,4,7,5,13,10,8,10,11,9,10,13,17,14,12,8,11,9,9,7,13,10,24,9,9,7,17,9,7,12,7,12,12,8,11,7,11,7,14,8,7,6,9,7,7,7,8,9,9,8,8,6,8,3,8,9,6,5,6,6,5,7,5,6,6,6,5,4,5,4,4,4,4,4,3,4,3,3,5,1,5,6,4,6,4,5,4,6,5,3,4,5,5,4,3,5,4,4,8,10,10,7,8,6,5,5,8,4,4,4,4,5,7,7,8,5,7,7,8,5,6,7,10,8,7,5,5,6,6,5,5,7,6,5,4,6,5,3,4,4,5,6,6,4,4,5,7,6,5,4,4,2,5,5,4,6,6,4,5,5,5,5,7,4,5,4],"hk/港股互联网":[190,147,219,129,143,193,229,174,219,167,180,126,152,199,201,192,194,181,244,263,246,175,185,181,234,228,192,205,177,153,197,205,227,201,168,189,197,163,171,168,150,139,158,170,214,226,197,195,143,167,151,152,226,222,195,241,201,176,190,207,180,200,166,203,231,205,188,236,276,239,253,225,227,182,193,293,232,293,244,276,272,274,230,252,241,247,232,249,219,191,214,232,160,220,230,253,218,189,289,203,189,182,194,151,132,146,130,207,180,155,157,173,165,208,158,224,198,208,175,192,203,164,190,160,208,213,201,157,170,250,316,219,237,212,183,204,203,210,209,167,229,183,210,297,226,166,179,186,194,158,183,177,166,192,176,143,146,139,167,156,168,177,165,76,173,135,137,227,271,234,162,195,164,167,217,207,202,190,183,166,172,194,236,233,230,275,309,293,237,203,142,157,186,203,142,191,146,215,179,122,174,186,122,92,92,193,153,177,146,115,195,182,134,179,159,191,138,202,144,171,140,140,248,174,150,167,132,117,183,187,170,175,260,141,149,153,131,169,209,184,168,140,136,165,181,148,163,163,286,232],"a/公用环保":[6,6,10,8,6,9,11,10,10,9,8,10,8,9,12,7,6,7,8,8,8,6,9,9,6,7,10,9,8,7,15,14,10,9,6,6,7,5,5,7,4,8,7,7,8,9,6,4,10,5,5,6,5,5,6,4,21,11,11,11,12,7,6,6,5,5,5,6,5,6,6,6,9,17,11,23,13,12,16,11,15,13,10,13,13,13,17,24,22,23,30,31,23,17,16,17,16,19,38,39,38,30,23,19,20,22,15,14,18,13,21,19,16,17,13,13,22,19,19,17,13,15,14,15,16,16,19,13,16,23,24,18,14,25,34,17,14,17,14,17,21,28,41,37,38,26,31,25,25,19,19,16,14,17,17,29,16,14,13,13,13,11,11,13,10,8,9,12,9,9,9,9,7,10,10,18,22,26,26,24,22,15,14,14,11,11,11,12,15,13,14,14,16,12,14,14,10,10,9,9,8,9,8,13,10,10,10,15,11,15,11,12,10,16,17,12,15,18,12,14,12,10,10,17,13,17,15,12,19,12,16,13,18,15,12,17,12,10,12,10,11,13,8,13,12,11,10,8,7,11],"x/巴西":[0,0,0,0,0,0,0,0,0,0,0,0,260,54,18,14,16,10,12,6,7,8,48,31,13,8,16,22,35,130,41,13,13,21,18,26,31,22,22,16,25,54,22,14,13,14,36,12,15,10,9,8,8,4,4,26,11,15,10,8,19,17,20,17,99,220,229,242,325,265,117,329,170,177,126,313,260,159,189,160,77,45,219,67,87,73,26,48,86,99,89,78,55,40,16,17,14,29,21,9,13,20,13,67,28,42,18,54,26,146,92,66,27,30,38,31,39,32,16,14,19,21,20,13,16,12,36,15,16,12,33,7,4,90,16,42,16,10,12,9,11,6,4,4,6,6,4,3,3,4,2,16,13,5,5,3,8,7,5,5,5,17,7,8,6,6,12,8,4,5,13,16,8,8,6,6,5,5,3,8,5,7,19,7,5,7,8,3,5,4,6,16,7,17,11,6,9,7,6,11,9,23,7,13,8,11,10,7,9,40,18,12,19,143,33,38,24,21,24,20,6,9,8,14,18,9,5,7,3,87,59,56,15,40,25,19,11,30,7,7,6,86,38,18,16,17,9,17,17,7],"a/电子":[11,7,8,8,9,11,7,9,7,5,5,8,6,8,5,5,5,5,6,5,7,9,9,8,13,20,9,12,11,7,9,8,6,8,7,9,11,7,6,6,5,9,8,9,6,5,12,9,8,6,6,4,5,5,5,5,7,9,6,5,4,4,4,4,4,3,5,4,3,4,4,4,5,3,4,5,4,5,6,8,5,6,4,4,4,4,6,6,6,4,3,5,5,4,4,5,4,3,7,5,4,4,4,4,4,4,4,6,10,8,8,6,6,6,6,12,7,10,9,7,11,8,7,7,9,6,5,7,7,8,9,22,14,12,18,15,19,27,18,17,14,16,17,17,17,16,19,16,17,13,13,13,17,17,20,22,22,18,23,22,24,24,19,17,16,20,17,16,17,18,14,13,15,14,13,15,12,14,12,12,11,16,9,12,11,9,9,10,11,11,11,14,11,10,10,10,13,15,12,13,11,14,15,12,15,14,13,17,16,17,12,15,15,11,13,12,11,16,13,15,16,13,13,16,13,15,17,10,12,14,12,14,16,12,11,11,12,12,11,12,12,10,9,10,11,11,11,9,7,7],"a/汽车":[8,8,9,11,9,8,11,7,12,10,8,7,15,10,9,8,9,9,12,9,8,8,9,12,10,9,10,10,9,7,8,9,9,11,12,10,11,13,16,15,12,11,12,17,13,12,11,10,10,11,12,9,6,9,9,9,9,8,8,9,9,11,9,8,8,5,6,6,6,8,8,9,7,7,7,8,10,8,9,9,7,6,6,6,6,6,7,7,9,7,7,9,7,7,7,8,15,9,8,10,14,13,11,8,11,10,10,11,10,13,12,19,11,13,12,11,14,10,16,12,15,13,15,13,11,11,11,13,11,13,11,13,9,9,8,9,11,13,11,10,10,9,9,8,8,22,9,7,9,8,8,6,6,8,6,7,6,6,6,6,5,5,6,5,5,7,7,5,7,6,4,5,5,5,5,5,6,4,4,6,4,7,5,6,5,5,5,4,6,4,4,5,6,5,6,5,5,5,5,5,5,5,5,5,5,4,5,5,6,5,5,4,4,5,5,4,6,5,9,7,6,6,6,6,5,5,8,5,6,8,6,6,7,6,7,4,5,6,6,5,7,5,6,7,6,5,6,5,5,5],"a/通信":[62,58,61,78,48,47,43,53,46,52,50,50,37,41,36,50,66,55,57,54,68,100,74,59,65,63,76,57,54,84,96,90,93,78,66,66,93,85,72,89,69,82,88,84,65,78,97,87,67,70,65,101,79,100,100,78,85,69,73,63,88,90,79,67,62,40,64,63,66,75,66,61,87,56,76,53,49,82,63,77,69,69,57,41,62,50,65,78,58,62,48,47,72,102,59,75,58,49,72,68,65,65,82,74,67,90,66,88,100,95,79,97,112,99,121,122,121,131,163,167,123,104,90,94,92,107,108,93,117,108,131,121,112,115,99,112,117,110,105,104,118,139,127,145,156,136,193,173,164,159,186,151,158,161,158,122,129,159,132,154,210,181,180,169,162,146,144,138,135,165,164,135,176,122,136,157,122,152,128,100,84,94,132,123,148,126,86,134,159,110,112,109,91,126,103,106,110,104,131,97,108,123,103,80,120,115,88,93,92,95,86,137,113,117,100,118,117,110,131,139,155,125,120,111,128,165,123,83,130,104,109,121,109,111,95,102,96,126,113,119,96,93,117,147,114,83,106,121,108,89],"hk/港股消费":[6,3,5,3,3,4,4,3,4,17,22,11,8,7,9,8,7,7,7,5,4,5,12,7,8,8,7,5,4,7,6,8,9,10,7,6,6,6,5,6,17,9,9,5,10,8,6,5,5,7,7,4,5,5,4,6,5,5,21,11,16,7,5,10,11,8,11,9,10,10,27,24,20,17,40,19,10,12,18,12,8,10,10,7,7,7,6,6,7,8,9,7,12,7,6,5,8,10,13,17,5,7,6,5,4,4,5,4,5,8,9,5,3,4,4,8,9,4,6,6,5,5,6,7,5,7,7,5,7,5,4,3,8,4,6,7,8,14,6,7,13,8,7,5,5,5,6,6,4,7,5,5,6,5,5,7,6,6,3,4,4,5,6,4,6,4,3,5,5,4,4,6,6,3,7,7,6,5,5,7,4,4,5,8,8,7,7,7,5,5,5,5,5,6,4,3,3,4,6,4,6,5,4,4,5,4,4,3,3,2,3,4,2,6,3,3,2,3,8,3,3,3,4,3,3,4,4,3,4,5,5,5,5,5,7,7,6,4,5,4,4,3,5,4,12,9,16,11,6,13],"a/半导体":[186,177,162,211,184,177,176,244,160,150,143,149,148,174,132,170,161,138,159,159,167,198,215,185,164,137,125,190,149,156,165,177,153,213,164,140,160,136,125,185,142,159,126,115,142,129,149,175,143,178,166,157,120,116,114,130,180,158,134,189,186,151,130,153,152,124,133,157,137,126,142,143,146,139,117,144,155,124,150,158,153,96,120,105,126,98,128,120,99,97,91,124,100,128,121,121,116,105,138,110,115,117,140,146,131,113,141,154,165,135,156,163,158,131,138,139,120,169,133,210,251,198,181,224,226,181,188,196,222,229,200,249,243,287,289,298,281,302,293,286,253,253,261,246,254,223,201,193,212,232,213,222,213,206,275,273,246,233,298,308,281,314,336,340,331,294,276,296,361,359,370,331,332,285,292,308,303,359,398,324,344,359,379,394,379,431,421,347,358,321,284,266,267,283,318,247,324,308,328,289,247,286,305,283,329,284,251,239,218,275,264,284,225,197,189,207,179,338,356,300,363,297,325,283,240,294,293,285,289,300,287,299,275,304,279,312,285,277,283,302,242,246,298,277,254,256,253,325,376,372],"x/沙特":[7,23,29,36,10,7,5,11,11,9,9,23,28,20,8,14,32,13,15,11,19,18,18,23,15,18,10,37,30,50,52,28,23,17,13,12,17,22,16,15,17,53,21,19,18,18,16,18,23,71,34,28,22,37,63,34,24,14,20,13,24,32,40,53,142,109,152,29,29,22,22,19,15,14,14,17,7,19,17,10,19,38,149,58,33,24,71,38,28,13,24,14,21,14,12,6,6,6,6,4,8,8,10,23,5,3,10,23,11,7,5,19,7,15,11,16,9,12,8,4,4,8,9,10,11,5,6,11,9,4,4,3,2,2,4,4,4,10,5,4,2,2,1,5,5,3,2,2,2,3,2,5,5,2,2,2,5,5,2,3,5,4,4,9,4,4,3,3,7,4,6,3,2,6,3,3,2,2,2,7,5,5,6,8,7,3,9,7,5,8,2,2,4,3,7,4,4,2,6,5,3,8,5,7,14,9,8,5,7,6,6,4,6,3,5,4,8,6,9,4,5,8,6,7,8,5,4,6,4,3,2,5,3,4,3,3,2,6,3,5,6,25,27,9,8,4,3,4,6,3],"x/美国":[862,682,786,765,651,667,744,795,814,829,806,804,567,807,777,811,811,841,857,858,834,836,765,832,863,901,867,739,776,694,781,874,870,840,872,895,851,849,818,836,832,762,887,832,829,874,840,819,796,784,791,792,689,759,726,817,762,791,746,813,804,797,765,765,641,577,529,471,465,567,699,525,588,514,486,221,257,524,476,464,376,563,479,720,727,725,692,696,673,772,747,750,821,686,847,924,867,884,876,940,909,863,865,746,883,880,887,695,832,631,784,732,831,779,811,793,847,808,900,888,848,875,861,886,842,846,813,852,829,834,838,901,923,854,907,885,874,849,893,618,817,761,705,686,710,836,783,883,650,835,744,680,740,546,546,600,711,701,678,673,781,734,635,590,628,688,753,762,808,783,734,823,839,829,811,811,879,723,805,850,859,776,796,764,781,662,697,711,753,792,789,773,845,740,727,708,735,786,801,788,812,843,875,780,785,768,816,842,848,768,825,786,728,682,760,796,759,784,802,819,787,839,881,857,834,854,831,849,868,827,887,846,877,851,869,897,887,884,920,895,896,810,861,878,856,878,904,846,852,812],"x/德国":[22,23,25,22,14,13,11,15,25,23,29,31,29,19,20,22,22,19,14,16,20,32,29,19,15,10,14,16,21,17,13,14,14,24,19,10,14,18,16,25,19,18,14,15,33,20,24,29,29,20,31,21,91,62,57,22,24,45,53,36,33,27,38,34,17,10,10,13,14,13,14,13,26,29,20,131,132,73,41,70,154,49,31,22,23,26,37,33,41,16,14,33,19,25,27,9,30,19,22,8,13,26,18,22,13,13,14,24,19,23,18,18,16,22,23,26,19,27,15,11,17,17,15,16,26,16,27,26,28,25,30,17,14,14,14,17,16,23,19,17,11,10,23,8,13,10,9,9,10,12,10,12,23,15,13,15,17,15,10,12,15,18,14,13,10,25,19,18,19,15,14,13,14,10,10,12,10,9,9,10,7,17,15,14,13,13,19,20,23,20,25,51,52,89,71,113,121,54,72,67,74,33,22,39,35,33,37,29,25,34,21,22,18,17,25,17,23,15,18,17,21,18,12,14,19,17,11,13,9,8,6,9,5,10,11,8,12,7,9,12,15,8,10,13,28,17,10,15,19,19],"a/光伏":[9,38,26,23,27,24,38,36,56,28,25,47,29,32,21,25,19,18,20,18,19,17,17,14,14,21,14,11,17,12,16,15,15,12,14,15,13,9,11,9,8,18,13,22,12,10,10,9,9,9,10,14,15,13,14,8,9,12,11,10,10,36,31,19,14,9,11,11,17,29,23,18,28,21,15,13,17,12,12,13,14,10,12,11,9,11,19,17,21,21,16,16,17,13,12,28,19,18,15,16,12,19,14,13,13,15,9,9,10,11,18,9,9,10,9,8,9,8,9,7,7,7,9,10,11,9,7,10,10,14,15,16,7,10,10,10,8,7,7,11,11,10,10,7,9,8,6,6,8,9,6,7,4,7,7,5,5,5,4,4,5,6,6,4,5,4,4,3,4,4,3,3,3,4,5,4,4,6,4,5,4,4,3,4,4,3,5,3,4,3,5,4,5,5,4,4,4,5,3,3,3,3,3,3,3,3,4,3,3,3,3,3,2,2,2,3,2,2,2,2,3,4,3,3,3,4,3,2,3,3,4,5,4,4,4,4,3,4,4,4,3,3,3,3,3,3,4,4,18,17],"a/地产基建":[7,12,8,7,9,7,9,7,7,7,8,6,7,10,12,9,10,27,12,25,12,13,15,11,11,12,9,8,10,9,13,23,14,8,10,8,9,8,11,8,6,7,11,9,8,4,8,10,6,7,9,7,5,5,6,7,6,6,10,10,13,16,10,9,10,21,15,10,13,18,17,13,15,12,11,10,8,10,23,20,11,11,9,9,7,11,12,10,11,10,10,11,12,11,11,11,9,8,14,8,6,16,10,8,20,8,11,7,7,5,17,16,7,11,11,7,10,7,7,6,8,6,8,8,11,13,8,13,12,8,8,7,10,9,7,5,7,7,6,6,5,8,7,7,6,5,6,5,6,5,5,7,5,5,10,6,7,5,6,6,5,4,4,5,4,4,5,4,4,4,5,4,4,6,5,5,4,5,4,5,5,4,7,6,5,4,5,4,4,5,6,8,5,10,8,6,5,4,4,8,6,5,6,8,5,6,14,9,7,10,11,8,9,7,7,6,7,9,5,5,11,20,15,25,11,11,35,47,21,15,12,8,10,10,12,9,6,9,7,5,10,8,6,7,6,6,6,7,6,5],"x/全球":[14,97,52,55,112,166,99,60,47,33,37,39,25,23,23,24,14,16,20,30,25,16,19,19,19,11,11,17,17,15,14,21,11,16,14,9,14,15,20,14,18,21,13,19,29,19,37,40,40,27,39,59,84,50,71,41,48,39,53,44,39,45,46,47,34,40,60,211,97,68,52,49,62,67,63,34,28,36,41,35,52,62,30,38,26,23,26,35,31,18,25,21,16,25,21,9,34,12,13,5,9,14,16,15,14,5,9,20,9,20,18,21,19,17,33,20,12,24,11,19,14,15,20,12,21,17,25,25,19,22,20,13,13,9,10,12,12,24,13,241,114,69,174,222,154,79,138,45,204,77,167,183,90,314,327,275,137,85,139,133,76,98,213,231,238,176,99,88,75,85,121,67,49,55,54,61,40,169,81,41,72,78,50,69,87,179,92,99,99,54,54,60,37,54,56,46,50,56,37,35,26,26,22,43,44,40,32,45,38,47,39,54,71,72,54,39,78,53,48,33,38,39,32,25,35,26,37,19,25,18,10,35,33,24,28,14,24,20,19,26,21,23,18,22,21,26,22,30,29,47],"a/传媒":[17,22,25,20,27,24,22,19,18,15,19,16,16,14,13,22,20,17,17,32,56,33,25,22,25,20,24,19,15,17,16,24,17,14,14,19,22,29,27,26,22,30,18,19,16,12,19,23,22,25,25,33,80,102,75,68,58,37,34,20,24,38,34,26,22,33,29,30,33,32,33,32,36,108,91,56,36,50,28,31,32,26,18,18,29,17,21,16,16,13,21,10,13,15,14,15,21,17,16,15,13,14,14,25,19,14,13,24,25,17,25,19,16,23,18,19,17,14,18,16,13,13,17,14,14,20,27,18,16,12,16,12,14,15,12,10,12,16,10,13,12,10,15,14,10,10,11,11,11,9,16,13,9,7,10,9,11,9,10,14,13,13,12,14,15,11,11,23,15,14,16,16,14,18,18,16,13,13,13,18,12,16,10,20,16,26,28,23,21,20,22,18,16,15,23,22,17,15,14,11,10,10,12,11,12,16,27,26,18,27,29,31,18,21,18,13,14,15,11,11,12,15,22,23,15,14,15,14,12,20,32,22,36,25,25,21,15,17,22,18,22,17,17,20,21,34,42,27,31,41],"x/日本":[75,148,88,99,195,134,126,103,88,88,91,64,64,49,136,94,91,78,55,61,73,63,88,51,56,38,66,149,94,69,80,35,56,64,48,36,59,57,92,74,67,61,34,90,53,36,33,63,74,59,55,62,73,69,64,46,114,65,68,51,52,43,62,57,50,24,14,25,58,54,75,48,117,177,271,145,173,109,147,109,113,163,62,71,81,112,115,113,113,66,84,80,51,166,65,28,37,31,39,23,35,57,66,100,49,32,49,161,86,151,64,123,83,118,69,92,61,74,40,46,87,48,56,48,68,86,75,51,80,83,61,52,35,25,44,32,69,66,44,52,33,61,72,57,92,54,53,49,117,59,68,91,102,98,73,91,106,170,148,163,107,114,117,130,100,85,99,102,73,96,97,68,71,81,106,99,58,86,92,72,40,101,100,116,95,121,156,138,98,105,107,81,45,64,104,109,65,81,66,78,65,57,58,96,99,112,80,56,66,89,76,94,142,71,92,92,95,102,85,92,118,70,50,67,73,73,104,98,78,48,30,44,59,65,48,50,57,46,36,48,49,41,41,53,61,48,39,78,60,101],"x/欧洲":[10,6,7,8,7,6,6,7,6,9,12,24,14,12,8,11,6,11,12,9,13,18,24,16,9,7,6,11,15,10,9,5,4,10,6,6,7,8,7,9,9,9,4,6,7,5,8,9,13,12,12,13,17,12,7,5,10,20,34,18,17,27,13,15,7,5,4,5,5,4,11,6,11,9,10,136,138,72,82,143,198,70,24,17,17,11,26,28,22,11,11,19,9,11,8,4,7,16,17,10,9,9,8,17,6,20,10,13,14,14,13,14,10,11,9,15,11,19,7,6,6,14,12,11,11,14,13,14,10,10,7,5,5,4,3,5,6,7,9,4,5,6,5,4,6,5,5,5,6,6,4,6,17,11,28,8,10,9,13,8,8,9,5,8,9,13,7,12,7,9,7,6,8,6,5,5,4,5,4,7,5,11,9,13,6,9,12,15,11,14,12,12,8,12,12,10,13,11,9,10,9,9,7,11,12,19,10,13,6,12,12,25,13,10,24,10,11,8,7,8,17,12,7,7,10,9,6,6,11,7,5,4,5,5,11,8,6,6,5,5,5,6,4,5,8,9,12,9,12,9],"x/中韩半导体":[959,621,703,844,921,725,672,742,564,494,495,541,303,284,404,521,377,345,641,604,621,714,947,975,408,277,305,518,538,1384,1322,556,455,691,390,325,668,534,562,840,943,992,628,810,1140,957,902,1163,2306,2447,1761,1233,830,439,633,1129,1189,856,945,1096,1030,885,513,2163,794,691,512,369,841,1440,1284,838,803,677,365,362,629,667,820,1479,2182,1134,613,773,686,1612,725,982,1032,572,1205,2217,1009,1676,897,326,483,553,468,191,589,529,506,599,308,338,584,740,1256,1116,746,1062,778,566,749,547,885,1856,757,1058,2245,2380,1324,1542,75,1754,2072,1426,5533,4581,1798,951,915,1988,710,1378,1557,855,1024,746,614,641,1139,1095,441,919,980,606,956,1193,549,1653,1442,1057,2066,1681,1599,1427,1937,2325,2059,2870,2177,2317,1878,2211,2537,2511,1851,2510,2612,1856,2745,1772,2006,1791,2519,2686,3192,4121,3094,3447,2378,5274,3923,2411,3631,4340,3906,5169,4149,2165,1747,2129,2014,1373,2232,2000,1551,1572,3331,1177,1805,2702,3067,1522,2745,2166,1283,2208,1867,3452,4386,1852,3115,1891,2227,3894,4674,2838,2765,1767,1722,1414,1027,1374,1721,1101,755,1265,607,1417,1109,1202,1420,1301,1363,1360,916,1730,1428,1185,2233,1970,2747,3469,2174,3575,2045,1352],"x/东南亚":[9,21,12,14,11,8,9,9,9,8,16,15,13,17,10,11,7,12,15,9,8,9,9,8,8,7,11,11,11,15,11,10,9,8,9,6,8,8,9,13,13,22,6,4,17,13,6,10,10,17,29,15,16,8,7,8,7,11,14,17,11,13,15,12,10,15,2,4,7,7,10,11,13,14,10,4,4,7,7,8,11,10,7,7,6,7,7,9,7,6,7,5,8,33,5,3,5,3,6,2,3,5,4,9,2,4,4,10,3,9,4,7,6,7,6,6,3,4,4,11,4,3,8,5,6,5,5,7,9,9,6,2,4,2,2,3,3,11,5,55,7,85,15,14,13,8,6,3,8,3,2,7,10,9,6,6,7,8,5,5,4,6,4,10,4,4,7,7,7,4,7,4,9,4,5,4,4,2,3,4,6,5,4,10,5,5,7,6,6,3,4,4,2,21,13,5,3,3,1,5,2,3,2,11,4,7,6,3,2,3,4,4,3,2,7,4,3,10,7,6,7,4,4,8,5,6,3,3,1,1,1,2,2,2,4,2,1,2,1,1,2,2,2,2,2,3,2,2,4,2]}};
var MKT_HIST = {"d":["2025-10-28","2025-10-29","2025-10-30","2025-10-31","2025-11-03","2025-11-04","2025-11-05","2025-11-06","2025-11-07","2025-11-10","2025-11-11","2025-11-12","2025-11-13","2025-11-14","2025-11-17","2025-11-18","2025-11-19","2025-11-20","2025-11-21","2025-11-24","2025-11-25","2025-11-26","2025-11-27","2025-11-28","2025-12-01","2025-12-02","2025-12-03","2025-12-04","2025-12-05","2025-12-08","2025-12-09","2025-12-10","2025-12-11","2025-12-12","2025-12-15","2025-12-16","2025-12-17","2025-12-18","2025-12-19","2025-12-22","2025-12-23","2025-12-24","2025-12-25","2025-12-26","2025-12-29","2025-12-30","2025-12-31","2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09","2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16","2026-01-19","2026-01-20","2026-01-21","2026-01-22","2026-01-23","2026-01-26","2026-01-27","2026-01-28","2026-01-29","2026-01-30","2026-02-02","2026-02-03","2026-02-04","2026-02-05","2026-02-06","2026-02-09","2026-02-10","2026-02-11","2026-02-12","2026-02-13","2026-02-24","2026-02-25","2026-02-26","2026-02-27","2026-03-02","2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-09","2026-03-10","2026-03-11","2026-03-12","2026-03-13","2026-03-16","2026-03-17","2026-03-18","2026-03-19","2026-03-20","2026-03-23","2026-03-24","2026-03-25","2026-03-26","2026-03-27","2026-03-30","2026-03-31","2026-04-01","2026-04-02","2026-04-03","2026-04-07","2026-04-08","2026-04-09","2026-04-10","2026-04-13","2026-04-14","2026-04-15","2026-04-16","2026-04-17","2026-04-20","2026-04-21","2026-04-22","2026-04-23","2026-04-24","2026-04-27","2026-04-28","2026-04-29","2026-04-30","2026-05-06","2026-05-07","2026-05-08","2026-05-11","2026-05-12","2026-05-13","2026-05-14","2026-05-15","2026-05-18","2026-05-19","2026-05-20","2026-05-21","2026-05-22","2026-05-25","2026-05-26","2026-05-27","2026-05-28","2026-05-29","2026-06-01","2026-06-02","2026-06-03","2026-06-04","2026-06-05","2026-06-08","2026-06-09","2026-06-10","2026-06-11","2026-06-12","2026-06-15","2026-06-16","2026-06-17","2026-06-18","2026-06-22","2026-06-23","2026-06-24","2026-06-25","2026-06-26","2026-06-29","2026-06-30","2026-07-01","2026-07-02","2026-07-03","2026-07-06","2026-07-07","2026-07-08","2026-07-09","2026-07-10","2026-07-13","2026-07-14","2026-07-15","2026-07-16","2026-07-17","2026-07-20","2026-07-21","2026-07-22","2026-07-23","2026-07-24","2026-07-27","2026-07-28","2026-07-29","2026-07-30","2026-07-31","2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07","2026-08-10","2026-08-11","2026-08-12","2026-08-13","2026-08-14","2026-08-17","2026-08-18","2026-08-19","2026-08-20","2026-08-21","2026-08-24","2026-08-25","2026-08-26","2026-08-27","2026-08-28","2026-08-31","2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-07","2026-09-08","2026-09-09","2026-09-10","2026-09-11","2026-09-14","2026-09-15","2026-09-16","2026-09-17","2026-09-18","2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-28","2026-09-29","2026-09-30","2026-10-08","2026-10-09","2026-10-12","2026-10-13","2026-10-14","2026-10-15","2026-10-16","2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-26","2026-10-27","2026-10-28","2026-10-29","2026-10-30","2026-11-02","2026-11-03","2026-11-04","2026-11-05","2026-11-06"],"c":[194,189,193,185,165,153,169,178,180,170,171,165,189,179,168,174,168,169,160,156,164,188,213,186,186,189,177,172,176,188,190,188,194,200,175,169,186,186,181,196,185,186,182,162,167,178,173,170,168,178,168,160,161,158,165,172,196,189,186,196,195,168,159,189,205,185,187,191,192,176,170,164,194,168,153,180,179,172,155,180,180,155,156,158,195,176,166,179,174,158,155,168,165,186,168,205,169,183,205,197,185,172,178,179,170,191,198,196,206,228,217,214,209,206,216,203,214,225,217,240,244,223,217,235,249,235,217,237,238,237,241,255,251,255,268,261,266,284,282,292,290,284,277,273,300,285,287,266,284,272,276,275,269,278,301,290,277,278,291,307,303,310,312,298,279,278,276,293,311,336,332,318,339,311,309,307,290,313,334,288,286,342,325,311,313,310,270,291,308,282,297,286,264,278,276,270,313,292,288,261,267,273,255,240,279,268,239,228,217,209,217,269,256,241,236,271,270,277,302,294,318,279,297,264,252,269,253,238,252,239,217,243,223,243,230,243,246,239,249,248,233,223,246,237,226,215,230,248,250,241],"b":[457,478,232,703,678,319,638,566,408,642,525,323,742,381,499,244,225,277,65,793,812,326,551,790,628,302,278,279,813,638,252,468,146,507,438,171,698,552,832,571,291,799,726,358,387,344,475,781,762,409,700,745,769,300,507,428,445,672,423,591,665,735,303,364,320,338,466,144,899,616,314,513,859,427,395,391,281,737,698,473,627,215,106,320,759,795,270,845,381,286,285,544,161,674,95,120,56,942,899,172,813,557,177,832,174,135,745,944,217,731,460,700,334,802,412,637,378,526,256,392,626,328,736,531,719,643,667,599,249,602,197,332,456,662,312,129,736,416,256,182,542,283,683,268,320,251,588,128,636,297,263,724,724,515,310,384,531,500,268,233,147,471,569,785,417,690,357,124,303,471,685,151,763,624,465,78,334,564,282,778,103,948,470,772,322,863,751,672,682,522,527,756,308,760,212,461,803,362,81,765,478,272,771,544,637,552,592,608,244,355,448,605,637,339,182,117,585,204,774,495,780,822,451,343,213,169,643,464,320,586,216,552,179,77,602,435,674,389,86,826,410,111,767,147,166,851,399,850,883,139],"n":[5153,5153,5152,5153,5154,5154,5154,5154,5155,5158,5158,5160,5159,5157,5156,5158,5160,5159,5161,5157,5155,5151,5150,5149,5148,5151,5157,5155,5153,5155,5156,5153,5156,5158,5157,5159,5160,5163,5162,5158,5163,5165,5167,5166,5168,5170,5171,5171,5173,5174,5173,5172,5172,5165,5167,5170,5172,5173,5179,5176,5176,5177,5173,5173,5173,5174,5171,5173,5174,5177,5177,5175,5174,5178,5178,5182,5180,5180,5177,5176,5176,5175,5177,5178,5179,5180,5183,5181,5184,5184,5183,5182,5180,5180,5180,5181,5183,5181,5182,5181,5177,5174,5179,5182,5182,5183,5181,5186,5187,5190,5188,5190,5188,5191,5190,5185,5190,5189,5187,5187,5185,5178,5152,5151,5180,5182,5180,5180,5179,5183,5183,5184,5187,5182,5186,5189,5191,5191,5191,5191,5191,5190,5192,5191,5195,5195,5197,5198,5198,5195,5193,5194,5189,5194,5190,5188,5191,5193,5192,5191,5193,5189,5186,5189,5194,5193,5194,5194,5194,5194,5194,5197,5197,5198,5197,5195,5197,5198,5198,5198,5197,5193,5194,5193,5197,5197,5197,5197,5199,5200,5202,5205,5205,5204,5205,5205,5203,5204,5204,5204,5205,5207,5208,5209,5209,5208,5206,5207,5208,5209,5207,5207,5207,5207,5206,5207,5207,5205,5206,5209,5209,5209,5209,5210,5210,5210,5211,5213,5209,5210,5212,5212,5214,5215,5216,5213,5217,5216,5218,5219,5217,5217,5217,5216,5217,5217,5216,5218,5217,5218],"u":[2283,2396,1176,3539,3432,1596,3197,2825,2033,3249,2630,1628,3722,1908,2510,1246,1148,1392,332,4008,4066,1629,2731,3982,3133,1508,1399,1410,4130,3184,1280,2339,750,2540,2191,872,3479,2748,4237,2835,1479,3988,3607,1785,1953,1732,2359,3959,3842,2076,3532,3717,3872,1520,2562,2167,2250,3409,2139,2961,3373,3706,1538,1856,1631,1718,2358,738,4583,3139,1587,2574,4371,2150,1977,1995,1430,3764,3537,2394,3163,1103,549,1627,3863,4068,1375,4302,1926,1457,1436,2746,822,3433,492,620,291,4866,4614,877,4155,2805,902,4228,894,698,3804,4878,1115,3709,2316,3516,1701,4065,2091,3197,1916,2654,1304,1992,3181,1661,3730,2671,3644,3246,3375,3029,1275,3036,1010,1692,2309,3356,1599,667,3737,2120,1314,935,2748,1446,3513,1372,1643,1294,2982,665,3215,1519,1348,3708,3668,2623,1596,1961,2691,2549,1382,1199,756,2393,2901,4043,2113,3527,1817,639,1533,2382,3512,780,3919,3198,2344,405,1709,2870,1432,3997,534,4885,2373,3968,1636,4395,3866,3406,3427,2639,2671,3878,1560,3860,1084,2322,4067,1841,421,3916,2407,1384,3967,2760,3191,2796,3000,3094,1247,1805,2249,3040,3257,1729,932,605,2939,1054,3887,2504,3937,4216,2284,1757,1084,862,3261,2346,1634,2989,1111,2791,918,400,3061,2202,3433,1941,448,4197,2082,576,3872,756,853,4382,2023,4331,4538,716],"w":[2712,2618,3886,1498,1629,3408,1811,2162,2953,1812,2380,3416,1292,3094,2519,3858,3945,3632,4812,1048,944,3374,2225,1059,1853,3493,3641,3641,949,1809,3800,2658,4374,2471,2810,4238,1502,2232,858,2132,3603,1003,1360,3208,3088,3305,2607,1111,1201,3003,1513,1271,1166,3546,2491,2898,2808,1663,2918,2046,1696,1334,3545,3237,3460,3363,2703,4395,514,1960,3462,2443,717,2884,3030,3109,3651,1344,1527,2668,1883,4026,4609,3464,1226,1051,3715,790,3126,3633,3606,2301,4289,1658,4669,4531,4886,299,521,4235,957,2228,4192,851,4236,4461,1302,292,4020,1362,2719,1505,3387,1004,2984,1822,3157,2390,3797,3085,1900,3409,1338,2360,1423,1800,1682,2024,3846,2008,4115,3404,2759,1714,3531,4489,1339,2976,3811,4213,2321,3672,1629,3742,3484,3855,2091,4513,1840,3602,3773,1413,1400,2468,3549,3142,2376,2548,3768,3940,4394,2689,2200,1110,2955,1584,3278,4534,3532,2674,1612,4377,1215,1930,2694,4758,3415,2219,3649,1143,4632,268,2673,1173,3447,695,1279,1664,1599,2416,2399,1253,3506,1217,4041,2720,1000,3240,4760,1204,2627,3705,1175,2310,1821,2270,2071,1995,3858,3274,2773,1987,1859,3369,4192,4567,2083,4102,1134,2558,1109,914,2782,3366,4001,4245,1810,2713,3466,2108,4036,2267,4213,4790,2023,2861,1661,3055,4739,887,2991,4601,1176,4400,4290,767,3045,764,603,4431],"t3":["半导体","通信设备","元件"],"t":[[37,113,13],[37,113,88],[37,113,88],[37,88,113],[37,88,113],[37,88,113],[37,89,88],[37,89,88],[37,88,89],[37,88,89],[37,88,113],[37,88,14],[88,37,14],[37,88,14],[88,37,113],[37,88,113],[37,88,113],[37,88,113],[37,88,113],[37,113,0],[37,113,88],[113,37,71],[37,113,88],[37,113,88],[37,113,88],[37,113,71],[113,37,71],[37,113,68],[37,113,114],[37,113,71],[37,113,13],[37,113,13],[113,37,71],[37,113,13],[37,113,114],[37,113,68],[37,113,68],[37,113,68],[37,113,68],[37,113,68],[37,113,88],[37,113,88],[37,113,68],[37,113,88],[37,113,68],[37,113,68],[37,113,68],[37,113,114],[37,113,68],[37,113,68],[37,113,20],[37,113,20],[37,111,113],[37,111,113],[37,111,0],[37,113,111],[37,113,89],[37,89,113],[37,89,113],[37,89,113],[37,113,68],[37,113,114],[37,48,113],[37,48,113],[37,48,113],[37,48,113],[37,113,48],[37,113,48],[37,113,48],[37,113,14],[37,113,14],[37,113,14],[37,113,14],[37,113,14],[113,37,0],[37,113,0],[37,113,0],[37,113,0],[37,113,114],[37,113,13],[37,113,0],[37,113,48],[37,113,114],[37,113,89],[37,113,89],[37,89,113],[37,89,113],[37,113,89],[37,113,88],[37,113,85],[37,113,85],[37,113,88],[37,113,13],[37,113,13],[37,113,85],[37,113,14],[37,113,14],[37,113,85],[37,113,85],[37,85,113],[37,113,85],[37,113,88],[37,113,88],[37,113,88],[37,113,30],[113,37,88],[37,113,88],[37,113,88],[113,37,88],[37,113,88],[37,113,88],[37,113,88],[37,113,88],[37,113,88],[37,113,88],[37,113,71],[37,113,88],[37,113,88],[37,113,13],[37,113,88],[37,113,88],[37,113,88],[37,88,113],[37,113,88],[37,113,88],[37,113,88],[37,113,88],[37,113,88],[37,113,13],[37,113,71],[37,113,71],[37,113,71],[37,113,71],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,13,113],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,13,113],[37,13,113],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,13,113],[37,13,113],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,13,113],[37,13,113],[37,13,113],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13],[37,113,13]],"ind":["IT服务Ⅱ","一般零售","专业工程","专业服务","专业连锁Ⅱ","专用设备","个护用品","中药Ⅱ","乘用车","互联网电商","休闲食品","体育Ⅱ","保险Ⅱ","元件","光伏设备","光学光电子","其他家电Ⅱ","其他电子Ⅱ","其他电源设备Ⅱ","养殖业","军工电子Ⅱ","农业综合Ⅱ","农产品加工","农化制品","冶钢原料","出版","动物保健Ⅱ","包装印刷","化妆品","化学制品","化学制药","化学原料","化学纤维","医疗器械","医疗服务","医疗美容","医药商业","半导体","厨卫电器","商用车","地面兵装Ⅱ","基础建设","塑料","多元金融","家居用品","家电零部件Ⅱ","小家电","小金属","工业金属","工程咨询服务Ⅱ","工程机械","广告营销","影视院线","房地产开发","房地产服务","房屋建设Ⅱ","摩托车及其他","教育","数字媒体","文娱用品","旅游及景区","旅游零售Ⅱ","普钢","服装家纺","林业Ⅱ","橡胶","水泥","汽车服务","汽车零部件","油服工程","油气开采Ⅱ","消费电子","渔业","游戏Ⅱ","炼化及贸易","焦炭Ⅱ","煤炭开采","照明设备Ⅱ","燃气Ⅱ","物流","特钢Ⅱ","环保设备Ⅱ","环境治理","玻璃玻纤","生物制品","电力","电子化学品Ⅱ","电机Ⅱ","电池","电网设备","电视广播Ⅱ","白色家电","白酒Ⅱ","种植业","纺织制造","综合Ⅱ","能源金属","自动化设备","航天装备Ⅱ","航海装备Ⅱ","航空机场","航空装备Ⅱ","航运港口","装修建材","装修装饰Ⅱ","计算机设备","证券Ⅱ","调味发酵品Ⅱ","贵金属","贸易Ⅱ","轨交设备Ⅱ","软件开发","通信服务","通信设备","通用设备","造纸","酒店餐饮","金属新材料","铁路公路","银行Ⅱ","非白酒","非金属材料Ⅱ","风电设备","食品加工","饮料乳品","饰品","饲料","黑色家电"],"inds":128,"p5":[441,447,448,430,405,404,404,423,411,419,400,402,409,388,390,409,401,417,388,413,418,438,440,413,411,414,417,417,427,441,449,432,441,443,430,416,437,434,409,428,441,431,422,431,431,443,448,439,432,435,426,419,398,408,405,415,417,403,404,411,421,405,394,411,433,434,421,428,456,441,421,417,424,422,429,429,425,413,417,423,425,406,400,414,428,407,411,421,423,415,410,417,413,428,420,439,394,412,434,430,419,408,422,421,407,419,426,427,439,459,450,456,446,441,447,446,444,453,455,470,450,427,438,444,448,446,437,440,444,447,449,451,438,442,445,441,457,468,477,486,480,476,476,483,509,485,494,469,489,478,483,487,478,488,503,509,499,510,509,523,528,519,513,505,497,491,485,492,508,534,526,504,532,507,498,489,482,501,533,511,499,534,520,502,509,506,474,491,517,496,506,496,482,477,486,474,496,480,483,465,472,478,449,444,473,469,447,423,425,427,425,461,449,439,434,450,450,460,475,481,477,438,456,425,420,431,422,420,427,418,410,418,410,425,407,411,423,440,438,424,426,406,425,422,403,402,433,427,442,435]};
var DEFAULT_WATCH = ['510300','159915','588000','513180','513120','513050','518880'];
var LS = 'etf_watch_v3';
var watch = loadWatch();

var DATA = [];                 // 全市场归一化数据
var STATS = null;
var LIVE = {};                 // 自选高频覆盖 {code: item}
var g = 'all', sortKey = 'amt', limit = 100, kw = '';
var DATA_SRC = '', DATA_TS = 0;
var lastP = {}, timerSlow = null, timerFast = null, timerSpd = null, timerT3 = null, retryTimer = null;

/* ---------- 分类（浏览器端，带缓存；Worker 端做会吃掉 10ms CPU 预算） ---------- */
var GROUP_CACHE = new Map();
var RULES = [
  ['cross', ['恒生','港股','中概','纳指','标普','日经','德国','法国','东南亚','亚太','海外',
             '全球','美国','QDII','越南','沙特','印度','日本','韩国','中韩']],
  ['commodity', ['黄金','白银','豆粕','有色','能源化工','商品','原油','饲料','铜']],
  ['bond', ['债','政金','信用','国开','短融','融资','城投']],
  ['money', ['货币','现金','保证金','日利','添益','快线','快钱','理财','财富宝','金管家']]
];
var BROAD = ['沪深300','中证300','中证500','中证1000','中证2000','中证100',
             '上证50','科创50','创业板','科创','上证','深证','中证','A50','A500','A100',
             '红利','价值','成长','超大盘','180','大盘','中小板','双创'];
/* 「科创」「创业板」「中证」这些是**板块前缀**，不是宽基。名字里带「科创」的
   588170 科创半导体ETF 有 117 亿成交额，被 BROAD 的 '科创' 抓成宽基后整块从
   板块地图里消失——半导体一格只剩 54 亿，比通信传媒还小，方向读反。
   所以先认行业主题词，再退到宽基前缀。主题词命中即算行业，不管带不带「科创」。 */
var THEME = ['半导体','芯片','集成电路','存储','光刻','晶圆',
             '医药','医疗','生物','创新药','疫苗','中药','器械','健康','制药',
             '人工智能','算力','云计算','数据中心','大数据',
             '软件','计算机','信息技术','信创','数字经济',
             '通信','5G','互联网','传媒','游戏','影视',
             '光伏','电池','储能','新能源','风电','锂','碳中和','氢',
             '军工','航天','航空','国防','卫星','兵器',
             '证券','银行','保险','金融','非银','券商',
             '食品','饮料','白酒','消费','家电','旅游','零售','美容','纺织',
             '农业','畜牧','养殖','粮食','种植','饲料',
             '化工','有色','钢铁','煤炭','石油','天然气','稀有金属','矿业','建材','水泥',
             '地产','基建','建筑','工程机械','机械','工业','制造','机器人','汽车','智能驾驶',
             '电力','公用','水务','环保','燃气'];
function calcGroup(n){
  /* 「自由现金流」「300现金流」是因子策略，名字里的「现金」不是现金管理，
     别被下面的 money 规则抓走（会被显示成「货币」，还会被速度榜排除）。 */
  if (n.indexOf('现金流') >= 0 || n.indexOf('自由现金') >= 0) return 'broad';
  for (var i=0;i<RULES.length;i++){
    var ws = RULES[i][1];
    for (var j=0;j<ws.length;j++) if (n.indexOf(ws[j]) >= 0) return RULES[i][0];
  }
  for (var t=0;t<THEME.length;t++) if (n.indexOf(THEME[t]) >= 0) return 'industry';
  for (var k=0;k<BROAD.length;k++) if (n.indexOf(BROAD[k]) >= 0) return 'broad';
  return 'industry';
}
function group(n){
  var v = GROUP_CACHE.get(n);
  if (v) return v;
  v = calcGroup(n);
  GROUP_CACHE.set(n, v);
  return v;
}

/* ---------- 工具 ---------- */
function loadWatch(){
  try{ var s = localStorage.getItem(LS); if(s){ var a = JSON.parse(s); if(a && a.length) return a; } }catch(e){}
  return DEFAULT_WATCH.slice();
}

/* ---------- 自选云端存储（Workers KV） ----------
   本地先写，云端异步推，800ms 防抖——用户连点几下删除不会打出 5 个请求。
   云端未配置（Deno 无 KV、或 wrangler.toml 没绑）时静默降级为纯本地。 */
var WATCH_CLOUD = false;
var pushTimer = null;

/* 自选分桶用的匿名编号。
   不同的人打开同一个网址，各自有一份，互不覆盖——共用一份的话，
   陌生人一按「+」就把别人的自选改掉了。
   跨设备不再走链接（「同步」按钮已删，那条 /?u= 链接谁拿到谁能写），
   改用标题行的「导入/导出」：文本没有写权限可外泄。 */
var WATCH_UID = (function(){
  var LSK = 'etfUid';
  var u = '';
  try { u = localStorage.getItem(LSK) || ''; } catch (e) {}
  // 不再认 URL 上的 ?u=。以前是「复制一条带编号的链接给另一台设备」，等于把这份
  // 自选的写权限发给任何拿到链接的人；现在跨设备走导入/导出文本，没有写权限可外泄。
  u = String(u).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (u.length < 6){
    u = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
  }
  try { localStorage.setItem(LSK, u); } catch (e) {}
  return u;
})();

function watchUrl(){
  return '/api/watch?u=' + encodeURIComponent(WATCH_UID);
}

function saveWatch(){
  try{ localStorage.setItem(LS, JSON.stringify(watch)); }catch(e){}
  pushWatch();
}

function pushWatch(){
  if (!WATCH_CLOUD) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function(){
    fetch(watchUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: watch })
    }).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok){ WATCH_CLOUD = false; refreshWatchUI(); }
    }).catch(function(){ WATCH_CLOUD = false; refreshWatchUI(); });
  }, 800);
}

/* 行情还没到就重绘自选表，会整表闪一下「未取到」——等 loadFull 之后再说 */
function refreshWatchUI(){
  if (DATA.length || Object.keys(LIVE).length) renderWatch();
}

function pullWatch(){
  if (!window.fetch) return Promise.resolve();
  return fetch(watchUrl()).then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok){ WATCH_CLOUD = false; refreshWatchUI(); return; }
    WATCH_CLOUD = true;

    if (!j.exists){
      // 云端从没写过：把本地列表作为初始值推上去
      if (watch.length) pushWatch();
      refreshWatchUI();
      return;
    }
    // 云端写过：完全以云端为准。不做并集——并集会让别处删掉的标的重生。
    var cloud = j.list || [];
    if (cloud.join() !== watch.join()){
      watch = cloud;
      try{ localStorage.setItem(LS, JSON.stringify(watch)); }catch(e){}
      LIVE = {};
      refreshWatchUI();
      loadTXQuotes();
    } else {
      refreshWatchUI();
    }
  }).catch(function(){ WATCH_CLOUD = false; refreshWatchUI(); });
}
function toast(m){ var e=document.getElementById('toast'); e.textContent=m; e.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(function(){ e.classList.remove('show'); },2000); }
function fp(v){ return (v==null||!isFinite(v))?'-':Number(v).toFixed(3); }
function fpc(v){ if(v==null||!isFinite(v)) return '-'; return (v>0?'+':'')+Number(v).toFixed(2)+'%'; }
function famt(v){ if(!v||!isFinite(v)) return '-'; if(v>=1e8) return (v/1e8).toFixed(2)+' 亿';
  if(v>=1e4) return (v/1e4).toFixed(0)+' 万'; return String(Math.round(v)); }
function cc(v){ return v>0?'up':(v<0?'down':'flat'); }
/* 因子公式里有 < > 这类符号，直接塞进 innerHTML 会被当成标签咬掉半截 */
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
  });
}
function pbadge(p){
  if(p==null||!isFinite(p)) return '<span class="pm na">-</span>';
  var a=Math.abs(p), c='lo';
  if(a>=2) c='hi'; else if(a>=1) c='mid';
  return '<span class="pm '+c+'">'+(p>0?'+':'')+p.toFixed(2)+'%</span>';
}
function isOpen(){
  var d=new Date(), w=d.getDay();
  if(w===0||w===6) return false;
  var m=d.getHours()*60+d.getMinutes();
  return (m>=555&&m<=690)||(m>=780&&m<=905)||(m>=570&&m<=720)||(m>=780&&m<=970);
}

/* ---------- 同指数去重 ----------
   背景：538 只 ETF 里，沪深300 有 29 只、中证A500 有 40 只、科创50 有 20 只。
   盯盘时看这 40 只 A500 没有意义——它们跟踪同一个指数，日内涨跌幅几乎一样，
   区别只在跟踪误差、费率和盘口厚度。按成交额留一只就够，剩下的不提供新信息。

   映射来源：天天基金基金档案"跟踪标的"，逐只抓取 + 归一化。
   只有 2 只以上的指数才参与去重（单只的没有重复可言）。 */
var IX_OF = {};                // code -> 指数名
var IX_N  = {};                // 指数名 -> 该指数下 ETF 只数
(function(){
  for (var k in IDX_GROUPS){
    var arr = IDX_GROUPS[k];
    IX_N[k] = arr.length;
    for (var i=0;i<arr.length;i++) IX_OF[arr[i]] = k;
  }
})();

var DEDUP = true;              // 默认开
var KEEP = {};                 // 指数名 -> 当前保留的 code
var IXF = null;                // 当前展开的指数（点 ×N 标签进入，看该指数全部成员）

function markKeep(items){
  // 选代表的顺序：
  //   1. 先只在"今天有成交"的里面挑，停牌/涨跌停封死的不该代表这个指数
  //   2. 有成交的按成交额挑；全组都没成交（盘前）才退到流通市值
  //   3. 带 15% 滞后：两只成交额差 2% 时不该每 60 秒换一次，看着像在闪
  var buckets = {}, i, x;
  for (i=0;i<items.length;i++){
    x = items[i];
    if (!x.ix) continue;
    (buckets[x.ix] || (buckets[x.ix] = [])).push(x);
  }
  var score = function(o){ return o.amt > 0 ? o.amt : (o.mc || 0); };

  for (var k in buckets){
    var list = buckets[k];
    var live = [];
    for (i=0;i<list.length;i++) if (list[i].amt > 0) live.push(list[i]);
    var pool = live.length ? live : list;

    var best = pool[0];
    for (i=1;i<pool.length;i++) if (score(pool[i]) > score(best)) best = pool[i];

    // 现任还在、也没停牌，且差距在 15% 以内 → 不换
    var cur = null;
    for (i=0;i<list.length;i++) if (list[i].c === KEEP[k]) cur = list[i];
    if (cur && cur.amt > 0 && score(cur) >= score(best) * 0.85) best = cur;

    KEEP[k] = best.c;
  }
}

/** 是不是这个跟踪指数的代表标的（成交额最大的那只）。
    没抓到跟踪标的的（ix 为空）判断不了重复，一律算代表——
    宁可多扫一只，也不要把一只没人跟的票静默藏掉。 */
function isRep(x){
  return !x.ix || !KEEP[x.ix] || KEEP[x.ix] === x.c;
}

function dedupCount(){
  // 参与去重、且不是代表标的的只数
  var n = 0;
  for (var i=0;i<DATA.length;i++) if (!isRep(DATA[i])) n++;
  return DATA.length - n;
}

/* ---------- 归一化：把两种源格式统一 ---------- */
/* 盘前（9:15 前）和停牌时，上游的当前价字段是 0.000，昨收字段还有值。
   早期版本直接判 p 为假就 continue，结果 9:30 之前打开页面只有 5 只——剩下 1712 只全被丢掉。
   现在用昨收兜底：价格显示昨收、涨跌 0，至少全市场结构看得见。 */
function normalize(src, raw){
  var out = [], i, x, p, pc, iopv;
  if (src === 'sina'){
    for (i=0;i<raw.length;i++){
      x = raw[i];
      if (!x.code) continue;
      pc = +x.settlement || 0;
      p = +x.trade || pc;
      if (!p) continue;
      out.push({ c:x.code, n:x.name, p:p, pc:pc, chg:+x.changepercent,
        amt:+x.amount, tr:+x.turnoverratio, hi:+x.high, lo:+x.low, op:+x.open,
        pre: !(+x.trade), mc: (+x.nmc || 0) * 1e4,
        iopv:null, pm:null, g:group(x.name), ix: IX_OF[x.code] || null });
    }
  } else {
    for (i=0;i<raw.length;i++){
      x = raw[i];
      if (!x.f12) continue;
      pc = +x.f18 || 0;
      p = +x.f2 || pc;
      if (!p) continue;
      iopv = +x.f441 || 0;
      out.push({ c:x.f12, n:x.f14, p:p, pc:pc, chg:+x.f3, amt:+x.f6, tr:+x.f8,
        hi:+x.f15, lo:+x.f16, op:+x.f17,
        pre: !(+x.f2), mc: 0,
        iopv: iopv>0?iopv:null,
        pm: iopv>0 ? +(((p-iopv)/iopv)*100).toFixed(2) : null,
        g:group(x.f14), ix: IX_OF[x.f12] || null });
    }
  }
  return out;
}

function computeStats(items){
  var up=0,down=0,flat=0,amt=0;
  for (var i=0;i<items.length;i++){
    var x=items[i];
    if (x.chg>0) up++; else if (x.chg<0) down++; else flat++;
    amt += x.amt;
  }
  return { up:up, down:down, flat:flat, amt:amt, count:items.length };
}

function groupCounts(){
  var c = {all:DATA.length, broad:0, cross:0, industry:0, bond:0, money:0, commodity:0};
  for (var i=0;i<DATA.length;i++){ var k=DATA[i].g; if(c[k]!=null) c[k]++; }
  return c;
}

/* ---------- 板块地图 ----------
   为什么按「跟踪指数」聚合而不是按 ETF 名：
   中证A500 有 40 只 ETF、沪深300 有 29 只、半导体主题下 6 个不同的指数。
   直接对 ETF 求平均，权重被「同指数发得多」的板块吃掉，看到的不是轮动而是发行数量。
   所以先把 ETF 归到指数（一个指数只出一票），再按指数归到板块。

   2026-11-07 第三次重划：分三组（A股 / 港股 / 跨境），各组独立分母。
   为什么必须拆——A 股和港股同用一个分母时，半导体 41.8% 会被港股 190 亿稀释成 30.3%，
   这个数既不表示 A 股内部分布，也不表示港股内部分布；跨市场涨跌幅同样不可比
   （汇率、交易时段、投资者结构都不同），混排出来的「最强/最弱」没有意义。

   A 股用申万一级做骨架，按 ETF 实际供给合并/拆分：
   1) 通信与传媒拆开。光模块/CPO 是通信设备，游戏影视才是传媒；
   2) 半导体从电子里单列。ETF 供给上半导体占电子类绝大多数，合起来等于只剩半导体；
   3) 上游与中游分开。资源＝有色/煤炭/石油石化（申万上游），
      材料＝化工/钢铁/建材（申万中游材料），机械＝机械设备/电网设备，
      地产基建＝地产/建筑。原来把钢铁、建材塞进「资源」，读起来像上游涨价，
      实际是地产链，方向会读反。
   港股按同一套行业口径分格（互联网/科技/医药/金融/消费/汽车/红利/地产）。
   跨境只按国家分（美国/日本/德国/欧洲/东南亚/印度/沙特/巴西/韩国/全球），不做行业。

   商品价格指数（黄金9999、上海金、原油、豆粕）三组都不进：那是金价油价，不是行业。
   宽基、风格（红利/价值/成长/现金流）、债券、货币同样不进——它们不回答「钱往哪条线走」。 */
var SEC_GROUPS = [
  { g:'A股', code:'a', defs:[
    ['半导体',   ['半导体','芯片','集成电路','存储','光刻','晶圆','封测']],
    ['电子',     ['消费电子','面板','PCB','元件','光学','安防','物联网','电子']],
    ['通信',     ['通信','5G','光模块','光通信','CPO','运营商','电信']],
    ['传媒',     ['传媒','游戏','影视','动漫','出版','广告','院线','文化']],
    ['计算机',   ['软件','计算机','信息技术','信创','云计算','大数据','网络安全',
                  '数字经济','金融科技','操作系统','数据库','工业互联网']],
    ['人工智能', ['人工智能','算力','数据中心','AI'], 1],
    ['医药',     ['医药','医疗','生物','创新药','疫苗','中药','器械','健康','制药']],
    ['汽车',     ['汽车','智能驾驶','汽零']],
    ['光伏',     ['光伏','太阳能']],
    ['电池储能', ['电池','储能','锂']],
    ['新能源',   ['新能源','风电','核电','氢','碳中和','低碳'], 1],
    ['军工',     ['军工','航天','航空','国防','卫星','兵器','船舶']],
    ['金融',     ['证券','银行','保险','金融','非银','券商']],
    ['消费',     ['食品','饮料','白酒','消费','家电','家用电器','旅游','零售','美容',
                  '纺织','酒店','免税','轻工','家居','酒']],
    ['农业',     ['农业','畜牧','养殖','粮食','种植','饲料','农牧渔','种业']],
    ['资源',     ['有色','煤炭','石油','天然气','石化','稀土','稀有金属','矿业',
                  '能源','黄金','油气']],
    ['材料',     ['化工','钢铁','建材','水泥','玻璃','新材料']],
    ['机械',     ['机械','工程机械','机床','机器人','工业','制造','装备','电网',
                  '电力设备','工业母机']],
    ['地产基建', ['地产','基建','建筑']],
    ['公用环保', ['电力','公用','水务','环保','燃气','运输','物流','港口','高速',
                  '交运','航运']]
  ]},
  { g:'港股', code:'hk', defs:[
    ['港股互联网', ['互联网','中国互联网','电商']],
    ['港股医药',   ['医药','医疗','生物','创新药','疫苗','中药','器械','健康']],
    ['港股科技',   ['科技','信息技术','半导体','芯片','软件','云计算','通信']],
    ['港股金融',   ['金融','银行','保险','证券','非银']],
    ['港股消费',   ['消费','食品','饮料','家电','旅游','零售','美容']],
    ['港股汽车',   ['汽车','汽零']],
    ['港股红利',   ['红利','高股息','股息','低波']],
    ['港股地产',   ['地产','建筑','基建']]
  ]},
  { g:'跨境', code:'x', defs:[
    // 中韩半导体 513310 一天 121 亿，占跨境一半以上。它一半仓位是 A 股半导体、
    // 一半是韩国，不是「配置韩国」，塞进韩国格会让韩国凭空变成跨境第一大市场。
    // 单列成跨境主题，和 A 股的 AI/新能源一样不进分母。
    ['中韩半导体', ['中韩'], 1],
    ['美国',   ['纳斯达克','纳指','标普500','标准普尔','标普油气','S&P','MSCIUSA',
                '美国','美股','道琼斯']],
    ['日本',   ['日经','东京','日本','东证']],
    ['德国',   ['德国','法兰克福','DAX']],
    ['欧洲',   ['法国','欧洲','英国','意大利','西班牙','荷兰']],
    ['东南亚', ['东南亚','越南','泰国','印尼','马来西亚','新加坡']],
    ['印度',   ['印度']],
    ['沙特',   ['沙特']],
    ['巴西',   ['巴西']],
    ['韩国',   ['韩国','中韩']],
    ['全球',   ['全球','海外','亚太','世界','亚洲','新兴市场']]
  ]}
];
/* 港股判定词。任一命中即进港股组，且不再进 A 股组——否则「中证港股通信息技术综合」
   会被「信息技术」抓进 A 股计算机，「中证港股通医药」会被「医药」抓进 A 股医药。
   「恒生A股XX」是恒生编的 A 股行业指数（恒生A股电网设备），判定前先摘掉品牌前缀。 */
var SEC_HK = ['恒生','港股通','港股','中概','中国互联网','香港','H股','港币'];
/* 商品价格指数：黄金9999 一天 37.8 亿，进「资源」会占 68%，把有色/化工全盖住。
   只挡纯商品指数名——「中证沪深港黄金产业股票」是黄金股，仍算资源。 */
var SEC_COMMOD = ['黄金9999','上海金','白银','原油','豆粕','商品'];
var SEC_CACHE = {};
function secClass(ix){
  var v = SEC_CACHE[ix];
  if (v !== undefined) return v;
  var probe = ix.indexOf('恒生A股') >= 0 ? ix.split('恒生A股').join('') : ix;
  var i, j;
  for (i=0;i<SEC_COMMOD.length;i++){
    if (probe.indexOf(SEC_COMMOD[i]) >= 0){ SEC_CACHE[ix] = null; return null; }
  }
  var isHK = false;
  for (i=0;i<SEC_HK.length;i++) if (probe.indexOf(SEC_HK[i]) >= 0){ isHK = true; break; }
  // 港股只跟港股组比；非港股先比跨境、再比 A 股——海外行业指数不能进 A 股同名格
  var order = isHK ? ['hk'] : ['x','a'];
  v = null;
  for (var m=0;m<order.length && !v;m++){
    var G = null;
    for (var gi=0;gi<SEC_GROUPS.length;gi++) if (SEC_GROUPS[gi].code === order[m]) G = SEC_GROUPS[gi];
    if (!G) continue;
    for (i=0;i<G.defs.length;i++){
      var ws = G.defs[i][1];
      for (j=0;j<ws.length;j++){
        if (probe.indexOf(ws[j]) >= 0){
          v = { g:G.g, code:G.code, k:G.defs[i][0], th:G.defs[i][2] ? 1 : 0 };
          break;
        }
      }
      if (v) break;
    }
  }
  SEC_CACHE[ix] = v;
  return v;
}

var SECS = [], SEC_OPEN = null;
/* 哪些格子是「主题」（跨行业）。占比分母要把它们剔出去，否则 AI 的成交额
   既算在自己头上、又通过成分股算在半导体/通信/计算机里，分母被撑大。 */
var THEME_KEYS = {};

/* 每日板块成交额日档：存下来的三十二个数字（A股 20 + 港股 7 + 跨境 5），
   用来回答「钱在进还是在出」。
   为什么比「占比」不比「绝对额」——盘中 10:30 的 3 亿和昨天全天的 8 亿不是一回事，
   直接比会得出「缩量」的错误结论。占比（板块 ÷ 行业合计）里分子分母同受时间进度
   影响，比值基本抵消。它衡量的是「钱有多集中在这条线」，不是「放了多大成交量」。
   这也是唯一能做的：没有历史分钟数据（新浪 minline 只给当天），「昨日同期」算不出来。 */
var SEC_BASE = null, SEC_SAVE_TS = 0, SEC_REQ = false;

function loadSecBase(){
  return fetch('/api/secdaily').then(function(r){ return r.json(); }).then(function(j){
    if (j && j.ok && Array.isArray(j.days)){
      SEC_BASE = j.days;
      SEC_EXTRA = null;                 // 日档换了，增量的缓存作废
      // 盘子已经画出来了（用户先看了页面、日档后到）：重画一次，让曲线尾巴接上
      if (SEC_OPEN) renderSectors();
      else renderSecMeta();             // 体检里的「板块日档」要等这份才完整
    }
    return SEC_BASE;
  }).catch(function(){ return null; });
}

/* 全 A 当天快照（集中度 / 宽度 / 涨跌行业数），给四象限卡片的「今天」那个点用。
   60 秒边缘缓存，盘中不必秒级——这个数是「市场今天什么状态」，
   不是「这一秒发生了什么」，一分钟的滞后不影响判断。
   失败就保持 null：卡片退回基线最后一天，标日期，不留空白。 */
var MKT_REQ = false, MKT_RETRY = null;

function loadMktSnap(){
  if (MKT_REQ) return;
  MKT_REQ = true;
  return fetch('/api/mkt').then(function(r){ return r.json(); }).then(function(j){
    if (!(j && j.ok && j.c > 0 && j.n >= 100)) throw new Error('empty');
    MKT_NOW = j;
    // 接口顺带带回 250 天历史（Actions 每天重写）。内联那份是部署时固化的，
    // 不覆盖的话，一个月不发布散点云就停在原地，而「今天」每天往里走。
    if (j.hist && j.hist.d && j.hist.d.length >= 60) MKT_HIST = j.hist;
    if (SECS.length) renderSectors();   // 盘子已经画出来了，补上今天这个点
    return MKT_NOW;
  }).catch(function(){
    // 失败时卡片显示的是基线最后一天（日期标签会写明是哪天），不会有错数。
    // 但用户多半是刚打开页面，20 秒后再试一次比让他手动刷新强。
    MKT_REQ = false;
    if (!MKT_RETRY){
      MKT_RETRY = setTimeout(function(){ MKT_RETRY = null; loadMktSnap(); }, 20000);
    }
    return null;
  });
}

/* ---------- 板块占比走势 ----------
   数据来自 worker/src/sec_hist.js：250 个交易日的「占本组行业格成交额」，
   按当前口径回算（每个指数只算成交额最大那只、主题不进分母、三组各算各的）。
   页面原本只有今天一个点，看不出这个占比是刚起来还是已经走了一半；
   一条曲线加一个分位，比再看十个涨跌幅有用。 */
function bjToday(){
  var bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}
function dayGap(a, b){
  var A = Date.parse(a + 'T00:00:00Z'), B = Date.parse(b + 'T00:00:00Z');
  if (!isFinite(A) || !isFinite(B)) return 999;
  return Math.round((B - A) / 86400000);
}

/* 静态基线只到生成那天（sec_hist.js 由日线回算）。不接增量的话，
   一周后曲线就永远停在那个日期——图上看着「没变化」，实际是没数据。
   这里用 secdaily 的日档（每天收盘存一份 36 格成交额）把尾巴接上：
   日档只存成交额，占比在这里按当天的组内行业合计现算，口径和基线一致。
   日档最多 64 条，约三个月，之后旧记录滑出——但基线覆盖更早的部分，接得上。 */
var SEC_EXTRA = null, SEC_EXTRA_TS = 0;
function secHistExtra(){
  if (SEC_EXTRA && Date.now() - SEC_EXTRA_TS < 60000) return SEC_EXTRA;
  var H = SEC_HIST, base = SEC_BASE || [];
  if (!H || !H.d || !H.d.length || !base.length){ SEC_EXTRA = {}; SEC_EXTRA_TS = Date.now(); return SEC_EXTRA; }
  var last = H.d[H.d.length-1], thMap = {}, i, k;
  for (i=0;i<SECS.length;i++) if (SECS[i].th) thMap[SECS[i].key] = 1;
  var out = {};
  for (i=0;i<base.length;i++){
    var r = base[i];
    if (!r || !r.d || r.d <= last || !r.s) continue;
    var den = {};
    for (k in r.s){
      if (thMap[k]) continue;
      var g = k.split('/')[0];
      den[g] = (den[g] || 0) + r.s[k];
    }
    for (k in r.s){
      var g2 = k.split('/')[0];
      if (!(den[g2] > 0)) continue;
      if (!out[k]) out[k] = [];
      out[k].push([r.d, Math.round(r.s[k] / den[g2] * 1000)]);
    }
  }
  SEC_EXTRA = out; SEC_EXTRA_TS = Date.now();
  return out;
}

/** 一格的完整占比序列：基线（跳掉上市前的 0）+ 日档增量。 */
function secHistArr(key){
  var H = SEC_HIST;
  if (!H || !H.s || !H.s[key]) return null;
  var raw = H.s[key], i, n = raw.length, started = false;
  var v = [], d = [];
  for (i=0;i<n;i++){
    if (raw[i] > 0) started = true;
    if (started){ v.push(raw[i]); d.push(H.d[i]); }
  }
  var ex = secHistExtra()[key] || [];
  for (i=0;i<ex.length;i++){
    if (!d.length || ex[i][0] > d[d.length-1]){ v.push(ex[i][1]); d.push(ex[i][0]); }
  }
  return { v:v, d:d };
}

/** 某格当前占比在过去一年里的分位。格子太多，不可能每格都点开看曲线，
    所以把分位塞进 tooltip——鼠标停一下就知道「这条线是不是已经走到高位」。 */
function secSharePct(key, share){
  var h = secHistArr(key);
  if (!h || h.v.length < 40) return null;
  var a = h.v, cur = Math.round(share * 1000), n = 0, i;
  for (i=0;i<a.length;i++) if (a[i] <= cur) n++;
  return n / a.length * 100;
}

/** 某个值在一条历史序列里的分位（0 最低、100 最高）。没有历史返回 null。 */
function mktPct(arr, v){
  if (!arr || arr.length < 40) return null;
  var n = 0;
  for (var i=0;i<arr.length;i++) if (arr[i] / 10 <= v) n++;
  return n / arr.length * 100;
}

/* 当天的全 A 快照，来自 /api/mkt。null 的时候卡片退回基线最后一天，
   并标注日期——宁可显示「截至 11-06」，也不要在页面上留一块空白。 */
var MKT_NOW = null;

/* 散点的点阵（secQuadCard 填充）。250 个点若各做一个 <circle>，DOM 多 500 个节点、
   HTML 多 25KB；这里只在 <g> 上接事件，点击坐标反算回 viewBox 再找最近点。 */
var SCQ_PTS = null;

/* 集中度 × 宽度 四象限。
   单看集中度会误判：半导体占到 40%，可以是「主线就在这儿」，也可以是「别的全塌了
   只剩它在成交」。单看宽度也会误判：18 个行业 15 个在涨，可能是普涨，也可能是
   每个都涨 0.1% 的假扩散。两个数放一张图，四种状态才分得开：
     高集中 + 窄  → 抱团（赚指数不赚面）
     高集中 + 宽  → 主线上攻（有主线也在扩散）
     低集中 + 宽  → 轮动扩散（追高容易挨打）
     低集中 + 窄  → 涣散（没有主线）
   灰色点＝近一年每个交易日的位置，蓝点＝今天。今天在哪个象限、这个象限过去
   一年出现过多少次，一眼可见——单个数字没有「常态」作参照，就只是数字。 */
var QUAD_INFO = {
  hl:{ n:'抱团',  c:'#a8541c' },
  hw:{ n:'主线上攻', c:'#b3383d' },
  lw:{ n:'轮动扩散', c:'#2563eb' },
  ll:{ n:'涣散无主线', c:'#5b6472' }
};
function secQuadCard(){
  var H = MKT_HIST;
  if (!H || !H.c || H.c.length < 60 || !H.b) return '';

  var last = H.c.length - 1;
  var now = MKT_NOW;
  var conc = now ? now.c : H.c[last] / 10;
  var brd = now ? now.b : (H.b[last] || 0) / 10;
  // 宽度是个股口径：上涨家数 ÷ (上涨+下跌)。行业数只用来做数据完整性校验
  // （MKT_INDS 匹配不全时 /api/mkt 会直接抛错，这里再兜一层）。
  var upN = now ? now.stockUp : (H.u ? H.u[last] : 0);
  var dnN = now ? now.stockDn : (H.w ? H.w[last] : 0);
  var nStk = now ? (now.stockN || (upN + dnN)) : (H.n ? H.n[last] : 0);
  var top3 = (now && now.top3 && now.top3.length) ? now.top3 : (H.t3 || []);
  if (!(conc > 0) || !(upN + dnN >= 1000)) return '';

  // 「今天」这个词只在真的是今天时才用。周六早上打开页面，行情还是周五收盘的，
  // 标成「今天」会让人以为周末在交易。
  var bjDay = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  var curDay = now ? now.d : H.d[last];
  var dayTag = curDay === bjDay ? '今天' : curDay.slice(5) + ' 收盘';

  var i, C = [], B = [], CI = [];
  for (i=0;i<H.c.length;i++){
    // CI 存回原始下标：点云跳过了 c=0 的天，不记映射就找不回那天是哪日。
    if (H.c[i] > 0){ C.push(H.c[i] / 10); B.push((H.b[i] || 0) / 10); CI.push(i); }
  }
  if (C.length < 60) return '';

  var sortedC = C.slice().sort(function(x,y){ return x - y; });
  var cMed = sortedC[Math.floor(sortedC.length / 2)];
  var hiC = conc >= cMed, wide = brd >= 50;
  var qKey = (hiC ? 'h' : 'l') + (wide ? 'w' : 'l');
  var q = QUAD_INFO[qKey];
  var cMax = Math.max.apply(null, C.concat([conc]));
  var cMin = Math.min.apply(null, C.concat([conc]));
  var pad = (cMax - cMin) * 0.13 || 2;
  var ylo = Math.max(0, cMin - pad), yhi = cMax + pad;

  // 历史里落在同一象限的比例——单点没有「常态」参照，这个数才是参照。
  var sameN = 0;
  for (i=0;i<C.length;i++) if ((C[i] >= cMed) === hiC && (B[i] >= 50) === wide) sameN++;
  var samePct = sameN / C.length * 100;

  // 同一张图出两套画布：桌面 620×210（渲染到约 1050px，字号≈15px），
  // 手机 360×190（渲染到 370px，几乎 1:1，字号 9.5px）。
  // SVG 是矢量的，宽度缩小所有字等比缩小——用一套 620 的画布塞进 370px 屏，
  // 9px 字会变成 5.4px，等于没有。两套各约 2KB，比自己算缩放便宜。
  var mkSvg = function (W, HT, ml, mr, mt, mb, fs, dot, cls) {
    var x0 = ml, x1 = W - mr, y0 = mt, y1 = HT - mb;
    var px = function(v){ return x0 + Math.max(0, Math.min(100, v)) / 100 * (x1 - x0); };
    var py = function(v){ return y1 - (v - ylo) / (yhi - ylo) * (y1 - y0); };

    // 250 个点不用 250 个 <circle>：一个 path 里串起来，描边圆头就是点。
    var pG = '', pA = '';
    for (i=0;i<C.length;i++){
      var seg = 'M' + px(B[i]).toFixed(1) + ' ' + py(C[i]).toFixed(1) + 'h0';
      if ((C[i] >= cMed) === hiC && (B[i] >= 50) === wide) pA += seg; else pG += seg;
    }
    var tX = px(brd), tY = py(conc);
    var txAnchor = tX > x1 - W * 0.08 ? 'end' : (tX < x0 + W * 0.08 ? 'start' : 'middle');
    var txDx = txAnchor === 'end' ? -7 : (txAnchor === 'start' ? 7 : 0);

    var yTick = [cMax, cMed, cMin];
    var tk = '';
    for (i=0;i<yTick.length;i++){
      tk += '<text x="' + (ml - 4) + '" y="' + (py(yTick[i]) + 3).toFixed(1)
        + '" text-anchor="end" font-size="' + fs + '" fill="#a7aeb9">'
        + yTick[i].toFixed(0) + '%</text>';
    }
    var xRow = '';
    var xs = [0, 50, 100];
    for (i=0;i<xs.length;i++){
      xRow += '<text x="' + px(xs[i]).toFixed(1) + '" y="' + (y1 + 15)
        + '" text-anchor="' + (i === 0 ? 'start' : (i === 2 ? 'end' : 'middle'))
        + '" font-size="' + fs + '" fill="#a7aeb9">' + xs[i] + '%</text>';
    }

    // 角标签垫一圈白：点云密的地方（左下、右上）纯灰字会被点淹没，
    // paint-order=stroke 让描边只画在字的外圈，不啃字形
    var lbl = function(t, x, y, anch){
      return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + anch
        + '" font-size="' + (fs * 1.05).toFixed(1) + '" fill="#b6bdc9" stroke="#fff"'
        + ' stroke-width="' + (fs * 0.3).toFixed(1) + '"'
        + ' paint-order="stroke" stroke-linejoin="round">' + t + '</text>';
    };

    // data-g 把绘图区几何带出去：点击时按同一组数反算每个点的位置，
    // 就不用在页面里重新实现一遍映射，也不会两处漂移。
    return '<svg class="' + cls + '" viewBox="0 0 ' + W + ' ' + HT + '"'
      + ' data-g="' + [x0, x1, y0, y1, ylo.toFixed(2), yhi.toFixed(2)].join(',') + '"'
      + ' role="img" aria-label="集中度与宽度四象限散点图">'
      + '<line x1="' + px(50).toFixed(1) + '" y1="' + y0 + '" x2="' + px(50).toFixed(1)
      + '" y2="' + y1 + '" stroke="#dde2ea" stroke-dasharray="3 3"/>'
      + '<line x1="' + x0 + '" y1="' + py(cMed).toFixed(1) + '" x2="' + x1 + '" y2="'
      + py(cMed).toFixed(1) + '" stroke="#dde2ea" stroke-dasharray="3 3"/>'
      + '<path d="' + pG + '" stroke="#c3cad6" stroke-width="' + dot + '" stroke-linecap="round" fill="none"/>'
      + '<path d="' + pA + '" stroke="' + q.c + '" stroke-width="' + (dot * 1.13).toFixed(2)
      + '" stroke-linecap="round" fill="none" stroke-opacity=".6"/>'
      + '<circle cx="' + tX.toFixed(1) + '" cy="' + tY.toFixed(1) + '" r="' + (dot * 3).toFixed(1)
      + '" fill="' + q.c + '" fill-opacity=".14"/>'
      + '<circle cx="' + tX.toFixed(1) + '" cy="' + tY.toFixed(1) + '" r="' + (dot * 1.47).toFixed(1)
      + '" fill="' + q.c + '" stroke="#fff" stroke-width="1.4"/>'
      + '<text x="' + (tX + txDx).toFixed(1) + '" y="' + (tY - dot * 2.7).toFixed(1)
      + '" text-anchor="' + txAnchor + '" font-size="' + (fs * 1.1).toFixed(1)
      + '" font-weight="700" fill="' + q.c + '">'
      + (curDay === bjDay ? '今天' : curDay.slice(5)) + '</text>'
      + lbl('抱团', x0 + 5, y0 + fs + 2, 'start')
      + lbl('主线上攻', x1 - 5, y0 + fs + 2, 'end')
      + lbl('涣散', x0 + 5, y1 - 5, 'start')
      + lbl('轮动扩散', x1 - 5, y1 - 5, 'end')
      + tk + xRow
      + '<g class="scqs"></g>'
      + '</svg>';
  };
  var svgD = mkSvg(620, 210, 42, 16, 14, 24, 9, 3, 'd');
  var svgM = mkSvg(360, 190, 36, 10, 12, 20, 9.5, 2.6, 'm');
  var svg = svgD + svgM;

  // 点阵挂到模块级，事件监听里直接查，不用把闭包层层传下去。
  // T/IND 是「那天的前三大行业」：只有 24% 这个数字回答不了「钱堆在哪条线」。
  SCQ_PTS = { C: C, B: B, I: CI, D: H.d, U: H.u || [], W: H.w || [],
              T: H.t || [], IND: H.ind || [], RC: H.c, RB: H.b,
              cur: C.length - 1, BRD: brd, CONC: conc };

  var c3 = mktPct(H.c, conc), b3 = mktPct(H.b, brd);
  // 个股口径集中度：成交额最大的 5% 个股 ÷ 全 A（margin-dashboard 借来的数）。
  // 行业口径抓行业抱团，这个抓个股抱团——单票吃下大份额时行业口径看不见它。
  var p5 = (now && now.p5 != null) ? now.p5 : (H.p5 ? H.p5[last] / 10 : null);
  var p53 = (p5 != null && H.p5) ? mktPct(H.p5, p5) : null;
  var names = top3.length ? top3.join('、') : '前三大行业';
  var upTxt = upN + '/' + (upN + dnN);
  // 描述里用「767 涨 4793 跌」而不是「767/5560 只在涨」——后者要读两遍才懂，
  // 而且分母到底是「全部股票」还是「涨+跌」在句子里看不清。
  var tally = upN + ' 涨 ' + dnN + ' 跌';
  var desc;
  if (hiC && !wide) desc = '钱压在 ' + names + ' 上（TOP3 占 ' + conc.toFixed(1) + '%），'
    + '全 A ' + tally + '——赚了指数不赚面。';
  else if (hiC && wide) desc = names + ' 领涨（TOP3 占 ' + conc.toFixed(1) + '%），'
    + tally + '——有主线，也在扩散。';
  else if (!hiC && wide) desc = tally + '，TOP3 只占 ' + conc.toFixed(1)
    + '%——钱在轮着走，追高容易挨打。';
  else desc = tally + '，TOP3 只占 ' + conc.toFixed(1)
    + '%——没有主线，别硬找。';

  // 成交额单列：宽度回答「多少票在涨」，成交额回答「这个市场今天有多热」，
  // 两个数放一起才看得出「缩量普涨」这类组合。
  var stockLine = ''
    + '<p class="scqstk">全 A 有成交 ' + nStk + ' 只'
    + ((now && now.amt > 0) ? ' · 成交 ' + now.amt + ' 亿' : '') + '</p>';

  // 四个象限各是什么、该不该动手。按图上的方位排（左上→右上→左下→右下），
  // 浮窗里的小矩阵和散点图对得上，不用再看第二遍。
  var QUAD_DOC = {
    hl: ['抱团', '钱压在少数行业，其余在跌', '只做主线，别抄底边缘'],
    hw: ['主线上攻', '主线领涨，而且在扩散', '跟随主线，可以加仓'],
    ll: ['涣散', '没主线，也没普涨', '降仓，等信号'],
    lw: ['轮动扩散', '钱在轮着走，谁都能涨一点', '别追高，等回落']
  };
  var cell = function (k) {
    var doc = QUAD_DOC[k];
    return '<div class="scqcell" style="border-left-color:' + QUAD_INFO[k].c + '">'
      + '<b>' + doc[0] + (k === qKey ? '<i>现在</i>' : '') + '</b>'
      + '<span>' + doc[1] + '</span>'
      + '<span class="act">→ ' + doc[2] + '</span></div>';
  };
  var pop = '<div class="scqpop">'
    + '<p class="scqaxs">纵轴 上高下低＝集中度 · 横轴 左低右高＝宽度</p>'
    + '<div class="scqgrid">' + cell('hl') + cell('hw') + cell('ll') + cell('lw') + '</div>'
    + '<p class="scqfoot">近一年有 ' + samePct.toFixed(0) + '% 的交易日站在你这一格（'
    + sameN + '/' + C.length + '）。同格天数越多，说明眼下越像常态；'
    + '越少，越可能是转折。</p></div>';

  return '<div class="scq">'
    + '<div class="scqhd"><span>全 A 集中度 × 宽度</span>'
    + '<em class="scqb" style="color:' + q.c + '">' + q.n + '</em>'
    + '<span class="scqtag" title="全 A 个股口径：5563 只 A 股逐只统计涨跌，当日有成交的 '
    + nStk + ' 只进样本。集中度按东财 128 个行业的个股成交额加总。'
    + '与下方 36 格（ETF 成交额，532 亿）不是同一套数据，差 30 倍是正常的。">'
    + nStk + ' 只 · ' + dayTag + '</span>'
    + '<i class="scqhelp" role="button" tabindex="0" title="四个象限是什么意思"'
    + ' onclick="var s=this.closest(&#39;.scq&#39;);s.classList.toggle(&#39;open&#39;);event.stopPropagation()"'
    + '>?</i></div>'
    + '<div class="scqbody"><div class="scqplot">' + svg
    + '<div class="scqtip"></div>'
    + '<div class="scqax"><span>灰点＝近一年每个交易日，点任意一点看当天</span>'
    + '<span>横轴 上涨个股占比</span></div></div>'
    + '<div class="scqfoot"><div class="scqstats">'
    // 个股块紧挨着集中块：两个都是集中度，行业口径 24% vs 个股口径 43.5%，
    // 放一起才读得出「行业抱团」和「个股抱团」是两件事。放最后会被当成凑数的。
    + '<div class="scqe" title="成交额最大的 3 个行业（东财 128 个行业口径）合计占全市场'
    + '成交额的比重——抓「钱压在几个行业里」。高于近一年中位算高集中，虚线就是那条中位线。'
    + '分位数＝今天这个数排在近一年第几：90 分位＝比一年里 90% 的日子都更集中。'
    + '单看会误判：40% 可以是主线就在这儿，也可以是别的全塌了只剩它在成交，'
    + '所以要配合右边「宽度」一起读。">'
    + '<span>集中</span><b>' + conc.toFixed(1) + '%</b>'
    + '<em>TOP3 行业 · ' + (c3 != null ? c3.toFixed(0) + ' 分位' : '—') + '</em></div>'
    + '<div class="scqe" title="成交额最大的 5% 个股占全市场成交额的比重——上一行的「集中」'
    + '按行业加总，抓的是行业抱团；这个数抓个股抱团：一只票单日吃下全市场百分之几的成交，'
    + '行业口径看不见它。两个口径一起看，才分得清钱压在一个行业还是压在几只票。">'
    + '<span>个股</span><b>' + (p5 != null ? p5.toFixed(1) + '%' : '—') + '</b>'
    + '<em>前 5% 成交 · ' + (p53 != null ? p53.toFixed(0) + ' 分位' : '—') + '</em></div>'
    + '<div class="scqe" title="全 A 个股口径：上涨家数 ÷（上涨＋下跌），50% 线以上算「宽」。'
    + '衡量涨的是不是普涨——15 个行业在涨也可能是每个都涨 0.1% 的假扩散，这个数能分辨。'
    + '分位数＝今天排在近一年第几。和「集中」配着读：高集中＋窄＝抱团，高集中＋宽＝主线上攻，'
    + '低集中＋宽＝轮动扩散，低集中＋窄＝涣散（点右上角 ? 看四格详解）。">'
    + '<span>宽度</span><b>' + brd.toFixed(0) + '%</b>'
    + '<em>' + upTxt + ' · ' + (b3 != null ? b3.toFixed(0) + ' 分位' : '—') + '</em></div>'
    + '<div class="scqe"><span>同象限</span><b>' + samePct.toFixed(0) + '%</b>'
    + '<em>' + sameN + ' / ' + C.length + ' 天</em></div>'
    + '</div>'
    + '<div class="scqdesc"><p class="scqd">' + desc + '</p>' + stockLine
    + '<p class="scqnote">虚线＝近一年中位（' + cMed.toFixed(1) + '% / 50%）。'
    + '轴向和四格含义点右上角 ? 看。</p></div>'
    + '</div></div>' + pop + '</div>';
}

/** 一格占比的走势卡。返回空串表示没有历史（新板块），不占位。 */
function secTrend(s){
  var h = secHistArr(s.key);
  if (!h || h.v.length < 20) return '';
  var a = h.v.slice(), dates = h.d.slice(), i;
  // 历史库只到上个交易日；差几天就把此刻的值接在后面。超过 5 天不接
  // （长假、数据管道没跑），否则会把周五的读数画成今天。
  var cur = Math.round(s.share * 1000);
  var appended = false;
  var lastD = dates[dates.length-1], today = bjToday();
  // 只在「值真的变了」时补。休市日快照等于上个交易日收盘，补上去会多一个平点，
  // 看起来像「最近几天没动」，实际是没数据。
  if (lastD !== today && dayGap(lastD, today) <= 5 && Math.abs(cur - a[a.length-1]) > 2){
    a.push(cur); dates.push(today); appended = true;
  }

  var mn = a[0], mx = a[0];
  for (i=1;i<a.length;i++){ if (a[i] < mn) mn = a[i]; if (a[i] > mx) mx = a[i]; }
  var pad = (mx - mn) * 0.14 || 1;
  var lo = Math.max(0, mn - pad), hi = mx + pad;
  var W = 640, H0 = 84, yOf = function(v){ return H0 - 6 - (v - lo) / (hi - lo) * (H0 - 12); };
  var xOf = function(k){ return k / (a.length - 1) * W; };

  // 最后一点如果是「补上来的此刻」，单独用虚线连——中间漏了几个交易日，
  // 画成实线等于假装这几天有数据。
  var joined = appended && a.length > 1 && dayGap(dates[a.length-2], dates[a.length-1]) > 1;
  var solidN = joined ? a.length - 1 : a.length;
  var d = '';
  for (i=0;i<solidN;i++){
    d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(a[i]).toFixed(1);
  }
  var tail = joined
    ? '<path d="M' + xOf(solidN-1).toFixed(1) + ' ' + yOf(a[solidN-1]).toFixed(1)
      + 'L' + xOf(a.length-1).toFixed(1) + ' ' + yOf(a[a.length-1]).toFixed(1)
      + '" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-dasharray="4 4"'
      + ' vector-effect="non-scaling-stroke"/>'
    : '';
  var sorted = a.slice().sort(function(u,v){ return u - v; });
  var med = sorted[Math.floor(sorted.length / 2)];
  var yMed = yOf(med).toFixed(1);

  var below = 0;
  for (i=0;i<a.length;i++) if (a[i] <= a[a.length-1]) below++;
  var pct = below / a.length * 100;

  // 分位只说事实，不替人下结论。颜色分开只是为了扫一眼能找到。
  var tagCls = pct >= 85 ? ' hi' : (pct <= 15 ? ' lo' : '');

  var head = s.th ? '占本组行业合计（与行业格重叠）'
    : (s.code === 'x' ? '占跨境地区成交额' : '占' + s.g + '行业成交额');
  return '<div class="strend">'
    + '<div class="sthd"><span>' + head + '</span>'
    + '<b>' + (a[a.length-1] / 10).toFixed(1) + '%</b>'
    + '<span class="sttag' + tagCls + '">近一年 ' + pct.toFixed(0) + ' 分位</span>'
    + '<span style="margin-left:auto">区间 ' + (mn/10).toFixed(1) + '–' + (mx/10).toFixed(1)
    + '% · 中位 ' + (med/10).toFixed(1) + '%</span></div>'
    + '<svg viewBox="0 0 ' + W + ' ' + H0 + '" preserveAspectRatio="none">'
    + '<line x1="0" y1="' + yMed + '" x2="' + W + '" y2="' + yMed
    + '" stroke="#aeb6c4" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>'
    + '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1.7"'
    + ' stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
    + tail
    + '<line x1="' + W + '" y1="' + (yOf(a[a.length-1]) - 5).toFixed(1) + '" x2="' + W
    + '" y2="' + (yOf(a[a.length-1]) + 5).toFixed(1)
    + '" stroke="var(--accent)" stroke-opacity=".45" vector-effect="non-scaling-stroke"/>'
    + '</svg>'
    + '<div class="stax"><span>' + dates[0].slice(0, 7) + '</span>'
    + '<span>虚线＝一年中位</span>'
    + '<span>' + dates[dates.length-1].slice(0, 7) + '</span></div>'
    + '</div>';
}

/** 今日各板块占比相对「上一交易日收盘」的变化（百分点）。没有基准返回 null。
    为什么只跟一个日终比、不取近 5 日均值：均值口径要攒够几天才出数，而且「比一周
    平均高」读不出「今天钱在往哪挪」。有一条日档就该出箭头，盘中也能读——分子分母
    同受时间进度影响（10:30 的 3 亿 ÷ 同时点的行业合计），比值基本抵消，所以箭头
    不必等收盘。它衡量的是「钱有多集中在这条线」，不是「放了多大成交量」。
    分母按「组」分别算：A股占比在 A股内、港股占比在港股内，不混。
    key 形如 "a/半导体"，组码就是斜杠前那段。 */
function secShareDelta(cur){
  var recs = SEC_BASE || [];
  if (!recs.length) return null;
  var nCur = 0, totCur = {};
  for (var k in cur){
    nCur++;
    var c0 = k.slice(0, k.indexOf('/'));
    if (!THEME_KEYS[k]) totCur[c0] = (totCur[c0] || 0) + cur[k];
  }
  if (nCur < 6) return null;

  // 从最近一天往前找第一条「与当前不一样」的日档。一样就说明现在看到的正是那天的
  // 收盘值（休市、或刚收完盘写进去），拿它当基准会恒等于 0，必须跳过。
  var base = null;
  for (var i=recs.length-1;i>=0;i--){
    var r = recs[i];
    if (!r || !r.s) continue;
    var keys = 0, same = 0;
    for (var k2 in cur){
      if (r.s[k2] == null) continue;
      keys++;
      if (Math.abs(cur[k2] - r.s[k2]) <= Math.max(1, r.s[k2] * 0.003)) same++;
    }
    if (keys >= 6 && same === keys) continue;
    base = r; break;
  }
  if (!base) return null;

  var totB = {};
  for (var kb in base.s){
    if (THEME_KEYS[kb]) continue;                 // 主题格不进分母
    var c1 = kb.slice(0, kb.indexOf('/'));
    totB[c1] = (totB[c1] || 0) + base.s[kb];
  }

  var out = {};
  for (var name in cur){
    var code = name.slice(0, name.indexOf('/'));
    if (!(totCur[code] > 0) || !(totB[code] > 0)) continue;
    if (base.s[name] == null) continue;
    var now = cur[name] / totCur[code];
    var was = base.s[name] / totB[code];
    out[name] = { share: now, prev: was, ds: (now - was) * 100, d: base.d };
  }
  return out;
}

/* 收盘后把当天板块成交额存一份。三个约束：
   1) 盘中不存——存进去的是半天的量，会污染基准；
   2) 同一天 30 分钟节流——收盘后成交额不再变，没必要反复写；
   3) 值几乎不变就不存——长假打开页面时行情还是节前那天的，会多出一条错位记录。

   日期取「行情对应的交易日」，不是「今天」。原先是「15:00 前直接 return、周末直接
   return」，等于基准只在「收盘后恰好有人打开页面」那天才记得下来；漏一天，箭头就
   跨两天比，漏几天就彻底没基准。现在非交易时段打开会补记最近一个工作日（行情正是
   那天的收盘值），盘中只读不写。 */
function maybeSaveSecDaily(){
  if (!SECS.length) return;
  if (SEC_SAVE_TS && Date.now() - SEC_SAVE_TS < 30 * 60000) return;

  var bj = new Date(Date.now() + 8 * 3600 * 1000);
  var hh = bj.getUTCHours(), mm = bj.getUTCMinutes(), wd = bj.getUTCDay();
  var mins = hh * 60 + mm;
  if (wd >= 1 && wd <= 5 && mins >= 9 * 60 && mins < 15 * 60) return;   // 盘中不写

  var dObj = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  var closed = wd >= 1 && wd <= 5 && mins >= 15 * 60;
  if (!closed){
    // 退到最近一个工作日：周末退到周五，开盘前退到昨天
    do { dObj.setUTCDate(dObj.getUTCDate() - 1); }
    while (dObj.getUTCDay() === 0 || dObj.getUTCDay() === 6);
  }
  var d = dObj.toISOString().slice(0, 10);

  var s = {};
  // 键必须和 secShareDelta 里读的一致（"a/半导体"），早先这里写的是 SECS[i].k，
  // 存进去是「半导体」、读的是「a/半导体」，永远对不上——基准攒了一年也画不出箭头。
  for (var i=0;i<SECS.length;i++) s[SECS[i].key] = Math.round(SECS[i].amt);

  var recs = SEC_BASE || [];
  var last = recs.length ? recs[recs.length-1] : null;
  // 同一天已经记过、而且带上了集中度/宽度就停。只判日期的话，早期写的那些
  // 没有 c/b 的旧记录会永远补不上，四象限的云就少一截。
  if (last && last.d === d && last.c > 0 && last.b > 0) return;
  if (last && last.s){
    var keys = 0, same = 0;
    for (var k in s){
      if (last.s[k] == null) continue;
      keys++;
      if (Math.abs(s[k] - last.s[k]) <= Math.max(1, last.s[k] * 0.003)) same++;
    }
    // 一格都没动，说明行情没换日（长假、临时休市），不能记成新的一天
    if (keys >= 6 && same === keys) return;
  }
  SEC_SAVE_TS = Date.now();
  var pad = function(v){ return (v < 10 ? '0' : '') + v; };
  // 这里只是兜底：主来源是 Actions 每天回算的 sec_daily.json（不依赖有人打开页面）。
  // 以前还顺带记集中度/宽度，现在四象限改用全 A 口径、由 gen_mkt_hist 回算，
  // 这两个字段已经没人读，再写进去只会让两套口径的数据混在同一个文件里。
  var body = { d: d, t: pad(hh) + ':' + pad(mm), s: s };
  fetch('/api/secdaily', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(j){
    if (j && j.ok) loadSecBase();
  }).catch(function(){});
}

/* 一个指数只出一票：成交额和涨跌幅都取「代表标的」（KEEP = 同指数里成交额最大那只）。
   为什么不把同指数所有 ETF 的成交额相加：一个指数发 14 只，14 只全进分子，
   等于把「发行数量」混进「资金关注度」——2026-11-07 收盘实测克隆倍数 1.1×~2.3×，
   人工智能因此被抬到 5.7%（只算代表是 2.9%），通信传媒被压到 10.8%（14.6%）。
   与涨跌幅的「一指数一票」对齐之后，占比才是「钱落在哪条线」，不是「哪条线发得多」。 */
var SEC_GROUPS_OUT = [];
function buildGroups(){
  var byIx = {};
  THEME_KEYS = {};
  for (var i=0;i<DATA.length;i++){
    var x = DATA[i];
    // 不再用「行业/宽基/跨境」那一层筛：那是按 ETF 简称判的，简称里没写「港股」的
    // 「互联网ETF」会被当成 A 股行业。板块归属一律看跟踪指数名。
    if (x.g === 'bond' || x.g === 'money') continue;   // 债/货币没有行业可言
    if (!isFinite(x.chg) || !isFinite(x.amt)) continue;
    // 新发/冷门 ETF 天天基金还没录「跟踪标的」（index_map 缺失 27 只，全是货币）
    // 或字段为空。这类不能直接丢——159516 半导体设备一天 37 亿，丢了半导体就少一块。
    // 用简称当临时指数名，自己去当一票。
    var kix = x.ix || ('~' + x.n);
    var o = byIx[kix];
    if (!o) o = byIx[kix] = { ix:x.ix || x.n, c:x.c, n:x.n, chg:x.chg, amt:0, cnt:0, rep:null, best:null };
    o.cnt++;
    if (KEEP[kix] === x.c) o.rep = x;
    if (!o.best || x.amt > o.best.amt) o.best = x;
  }
  // 代表标的今天没成交（停牌/新发）就退到组内成交额最大的那只，
  // 否则这个指数会带着 0 成交额混进板块，把涨幅加权拉向 0
  for (var k0 in byIx){
    var q0 = byIx[k0];
    var pick = (q0.rep && q0.rep.amt > 0) ? q0.rep : q0.best;
    q0.c = pick.c; q0.n = pick.n; q0.chg = pick.chg; q0.amt = pick.amt;
  }

  // 先归组、再归格。key 用「组码/板块名」——A股与港股都有「医药」「消费」「汽车」，
  // 只用板块名当日档 key 会互相覆盖。
  var gmap = {};
  for (var k in byIx){
    var cls = secClass(k);
    if (!cls) continue;
    var G = gmap[cls.code];
    if (!G) G = gmap[cls.code] = { g:cls.g, code:cls.code, amt:0, core:0, nth:0, cells:{} };
    var c = G.cells[cls.k];
    if (!c) c = G.cells[cls.k] = { k:cls.k, key:cls.code + '/' + cls.k, g:cls.g,
                                   code:cls.code, th:cls.th, ix:[], amt:0 };
    c.ix.push(byIx[k]);
    c.amt += byIx[k].amt;
    G.amt += byIx[k].amt;
    // nth 数的是「格子」，不是指数——一个主题格里可能躺着 8 个 AI 指数，
    // 累加指数个数会写成「2 个行业 · 14 个主题」。格数在下面 cells 拼好后数。
    if (cls.th) THEME_KEYS[cls.code + '/' + cls.k] = 1; else G.core += byIx[k].amt;
  }

  var out = [];
  for (var gi=0; gi<SEC_GROUPS.length; gi++){
    var def = SEC_GROUPS[gi], GG = gmap[def.code];
    if (!GG) continue;
    var cells = [];
    for (var kk in GG.cells){
      var t = GG.cells[kk], wsum = 0, vsum = 0, up = 0;
      if (!(t.amt > 0)) continue;    // 全天没成交的格子不显示
      for (var j=0;j<t.ix.length;j++){
        var q = t.ix[j];
        // 成交额为 0 的（停牌/新发）不参与加权，否则会把板块涨幅拉向 0
        if (q.amt > 0){ wsum += q.amt; vsum += q.chg * q.amt; }
        if (q.chg > 0) up++;
      }
      cells.push({ k:t.k, key:t.key, g:t.g, code:t.code, amt:t.amt, th:t.th,
                   ret: wsum > 0 ? vsum / wsum : 0, n:t.ix.length, up:up,
                   share: GG.core > 0 ? t.amt / GG.core : 0,
                   ix: t.ix.slice().sort(function(a,b){ return b.chg - a.chg; }) });
    }
    if (!cells.length) continue;
    // 行业格在前、主题格在后，各自按涨幅排。主题（AI / 新能源）是跨行业的，
    // 与上面几格的成交额重叠，混在一张榜里排「最强」会把同一笔钱数两遍。
    cells.sort(function(a,b){ return (a.th - b.th) || (b.ret - a.ret); });
    var nth = 0;
    for (var cn=0;cn<cells.length;cn++) if (cells[cn].th) nth++;
    out.push({ g:def.g, code:def.code, cells:cells, amt:GG.amt, core:GG.core,
               n:cells.length, nth:nth });
  }
  return out;
}

/* 折叠状态存本地：三个组三十多个格子同屏太挤，默认只展开 A 股。
   用户的展开/收起选择记在 localStorage，下次打开还是他上次的样子。 */
var SEC_FOLD = null;
function secFoldState(){
  if (SEC_FOLD) return SEC_FOLD;
  var s = null;
  try { s = JSON.parse(localStorage.getItem('secFold') || 'null'); } catch(e){}
  var fresh = (!s || typeof s !== 'object');
  if (fresh) s = { a:false, hk:true, x:true };
  SEC_FOLD = s;
  if (fresh) saveSecFold();   // 第一次进来就把默认值落盘，别每次重新猜
  return s;
}
function saveSecFold(){
  try { localStorage.setItem('secFold', JSON.stringify(SEC_FOLD)); } catch(e){}
}

function fmtAmt(v){
  if (!(v > 0)) return '—';
  if (v >= 1e8) return (v/1e8).toFixed(v >= 1e9 ? 1 : 2) + '亿';
  return Math.round(v/1e4) + '万';
}

/* ================= 数据体检 =================
   这一行被「229 个单只指数整组丢掉、页面毫无异样」坑出来过：数字照样显示，
   只是悄悄小了一截。既然是防复发的仪表，就必须让人一眼看出「今天出事没有」——
   纯灰小字等于没有。灯取三项里最差的：无跟踪标的暴增（映射表又丢组）、
   两份 Actions 回算的历史停更（管道挂了，页面数字停在原地不动）。 */
var SEC_COV = null;

function renderSecMeta(){
  var sm = document.getElementById('secMeta');
  if (!sm || !SEC_COV) return;
  var c = SEC_COV;
  var chk = secHealth();
  sm.innerHTML =
      '<span class="mt ' + chk.cls + '" role="button" tabindex="0"'
    + ' onclick="secMetaToggle()" title="点开看数据管道体检：两份历史停更、映射覆盖率"> '
    + '<i></i>数据体检' + (chk.cls !== 'ok' ? ' · 有异常' : '') + '</span>'
    + '<span>' + SECS.length + ' 格 · <b>' + c.nIx + '</b> 个指数有成交</span>'
    + '<span class="opt">每个指数只算成交额最大的一只</span>'
    + '<span>报价 <b>' + c.nQ + '</b>' + (c.nSt ? ' · 停牌 ' + c.nSt : '') + '</span>'
    + (c.nNoIx ? '<span title="这些 ETF 查不到跟踪标的（新发未收录、或数据源没给），进不了任何一格；'
        + '括号里是它们今天的成交额合计">无跟踪标的 <b>' + c.nNoIx + '</b> 只'
        + (c.noIxAmt > 0 ? '（' + fmtAmt(c.noIxAmt) + '）' : '') + '</span>' : '')
    + '<span class="opt" title="宽基、债券、货币、商品、风格（红利/价值）都不进板块地图——'
      + '它们不回答钱往哪条线走">宽基/债/货币/商品 不在表内</span>'
    + '<span class="mtdet" id="secMetaDet"></span>';
}
function secHealth(){
  var today = bjToday();
  var cls = 'ok', msgs = [];
  var worse = function (c) {
    if (c === 'bad') cls = 'bad';
    else if (c === 'warn' && cls === 'ok') cls = 'warn';
  };
  // 全 A 散点（250 天）：Actions 每天回算，停 3 个工作日以上就是挂了。
  // 上次 etf.db 停在 11-03 三天没人发现，就是这种形状——页面全正常，只是不动。
  var m = MKT_HIST && MKT_HIST.d && MKT_HIST.d.length ? MKT_HIST.d[MKT_HIST.d.length - 1] : null;
  var gM = m ? dayGap(m, today) : 99;
  if (!m || gM > 3 || MKT_HIST.d.length < 200){
    worse(gM > 6 || !m ? 'bad' : 'warn');
    msgs.push('全 A 散点历史停在 ' + (m ? m.slice(5) : '—') + (m ? '（' + gM + ' 天前）' : '')
      + '，Actions 可能没跑');
  }
  var sd = SEC_BASE && SEC_BASE.length ? SEC_BASE[SEC_BASE.length - 1].d : null;
  if (sd){
    var gS = dayGap(sd, today);
    if (gS > 3){
      worse(gS > 6 ? 'bad' : 'warn');
      msgs.push('板块日档停在 ' + sd.slice(5) + '（' + gS + ' 天前）');
    }
  }
  if (SEC_COV && SEC_COV.nNoIx > 20){
    worse('warn');
    msgs.push('无跟踪标的 ' + SEC_COV.nNoIx + ' 只，映射表可能又丢组了');
  }
  return { cls: cls, msgs: msgs };
}
function secMetaToggle(){
  var sm = document.getElementById('secMeta');
  if (!sm) return;
  var on = sm.classList.toggle('open');
  var det = document.getElementById('secMetaDet');
  if (!on || !det) return;
  var today = bjToday();
  var m = MKT_HIST && MKT_HIST.d && MKT_HIST.d.length ? MKT_HIST.d[MKT_HIST.d.length - 1] : null;
  var sd = SEC_BASE && SEC_BASE.length ? SEC_BASE[SEC_BASE.length - 1].d : null;
  var gM = m ? dayGap(m, today) : 99;
  var gS = sd ? dayGap(sd, today) : 99;
  var it = function (ok, label, val) {
    return '<span class="' + (ok ? 'ok' : 'warn') + '">' + (ok ? '✓' : '⚠') + ' ' + label
      + ' <b>' + val + '</b></span>';
  };
  det.innerHTML =
      it(m && gM <= 3, '全 A 散点', (MKT_HIST && MKT_HIST.d ? MKT_HIST.d.length : 0)
        + ' 天 · 最新 ' + (m ? m.slice(5) : '—'))
    + it(sd && gS <= 3, '板块日档', (SEC_BASE ? SEC_BASE.length : 0)
        + ' 天 · 最新 ' + (sd ? sd.slice(5) : '—'))
    + '<span class="note">两份历史由 Actions 每天收盘后回算；停更＝管道挂了，页面数字不会自己动</span>'
    + (secHealth().msgs.length ? '<span class="warnmsg">⚠ ' + secHealth().msgs.join('；') + '</span>' : '');
}

function renderSectors(){
  SEC_GROUPS_OUT = buildGroups();
  SECS = [];
  for (var a=0;a<SEC_GROUPS_OUT.length;a++){
    for (var b=0;b<SEC_GROUPS_OUT[a].cells.length;b++) SECS.push(SEC_GROUPS_OUT[a].cells[b]);
  }
  var body = document.getElementById('secBody');
  var hd = document.getElementById('secHead');
  if (!SECS.length){
    body.innerHTML = '<div class="empty">暂无行业主题数据（非交易时段或行情源未就绪）</div>';
    hd.innerHTML = '<span>—</span>';
    return;
  }
  var curAmt = {};
  for (var ci=0;ci<SECS.length;ci++) curAmt[SECS[ci].key] = SECS[ci].amt;
  var sdel = secShareDelta(curAmt);

  // 顶部只放三组总量。不做跨组「最强/最弱」——港股和 A 股的涨跌幅不可比，
  // 混排出来的第一名没有交易含义。组内对比放在各自组头。
  var hh = '';
  for (var hi=0;hi<SEC_GROUPS_OUT.length;hi++){
    var GH = SEC_GROUPS_OUT[hi];
    var hu = GH.code === 'x' ? ' 个地区' : ' 个板块';
    var hn = GH.nth
      ? (GH.n - GH.nth) + (GH.code === 'x' ? ' 地区 · ' : ' 行业 · ') + GH.nth + ' 主题'
      : GH.n + hu;
    hh += '<span>' + GH.g + ' <b>' + fmtAmt(GH.amt) + '</b> · ' + hn + '</span>';
  }
  hd.innerHTML = hh;

  // 这一行只回答「地图漏了什么」。被「229 个单只指数整组丢掉」坑过一次，
  // 覆盖率得写在明面上：多少格、多少个指数、多少只有报价、多少只进不来。
  var nQ = 0, nSt = 0, nNoIx = 0, noIxAmt = 0, nIx = 0, i0;
  for (i0=0;i0<DATA.length;i0++){
    var x0 = DATA[i0];
    if (x0.p > 0) nQ++; else nSt++;
    // 只数「本该进图却进不来」的：行业/主题、跨境。宽基、债券、货币、商品
    // 本来就不进板块地图，把它们算成「漏掉」会把 592 亿的债券货基写得像事故。
    if (!x0.ix && (x0.g === 'industry' || x0.g === 'cross')){
      nNoIx++; noIxAmt += (x0.amt || 0);
    }
  }
  for (i0=0;i0<SECS.length;i0++) nIx += SECS[i0].n;
  SEC_COV = { nIx: nIx, nQ: nQ, nSt: nSt, nNoIx: nNoIx, noIxAmt: noIxAmt };
  renderSecMeta();

  var h = '';
  var cellHtml = function(G2, cs, mxAmt, sdel){
    var o = '';
    for (var j2=0;j2<cs.length;j2++){
      var s = cs[j2];
      var cls = s.ret > 0 ? 'up' : (s.ret < 0 ? 'down' : 'flat');
      var sh = Math.min(1, Math.abs(s.ret) / 2);
      var rgb = s.ret > 0 ? '217,58,58' : '14,154,97';
      var share = s.share * 100;
      // 条长用开方：半导体 175 亿、公用环保 5.6 亿，线性比例下后者只有 3%、肉眼是空的。
      // 开方后 3% 变 18%，量级差还在，但不至于看不出有没有量。
      var barW = mxAmt > 0 ? Math.sqrt(s.amt / mxAmt) * 100 : 0;
      var dl = sdel && sdel[s.key];
      // 0.5 个百分点的门槛：再小就是噪声。三十几个格子里大半写着「0.1pt」，
      // 读数的人两天就学会无视这一列——那这个指标等于没做。
      var dsCls = !dl ? 'na' : (dl.ds > 0.5 ? 'up' : (dl.ds < -0.5 ? 'down' : 'na'));
      var dsTxt = (!dl || Math.abs(dl.ds) <= 0.5) ? ''
        : (dl.ds > 0 ? '↑' : '↓') + Math.abs(dl.ds).toFixed(1) + 'pt';
      // 主题格的分子不计入分母，占比会算出 135% 这种数——不是错，是「重叠」的定义。
      // 不报这个数，只报「与行业格重叠」，否则读者会以为分母算错了。
      var shPct = secSharePct(s.key, s.share);
      var shNote = s.th ? '（主题：与行业格重叠，不计入分母）'
        : '（占' + s.g + '板块 ' + share.toFixed(1) + '%）'
          + (shPct != null ? '，近一年 ' + shPct.toFixed(0) + ' 分位' : '');
      o += '<div class="scell' + (SEC_OPEN === s.key ? ' on' : '') + (s.th ? ' th' : '') + '" data-sec="' + s.key + '"'
        + ' title="' + s.k + '：' + s.n + ' 个跟踪指数（每个指数只算成交额最大那只），成交额 '
        + fmtAmt(s.amt) + shNote + '，'
        + s.up + '/' + s.n + ' 个指数上涨'
        + (s.th ? '。主题指数成分横跨多个行业，与上方行业格是同一批股票，不能再加一遍。' : '')
        + (dl ? '　·　资金占比' + (s.th ? '' : ' ' + (dl.share*100).toFixed(1) + '%') + '，较 '
          + (dl.d ? dl.d.slice(5) + ' 收盘' : '上一交易日') + ' '
          + (dl.ds >= 0 ? '+' : '') + dl.ds.toFixed(1) + ' 个百分点'
          : '　·　还没有收盘基准（收盘后自动记一条）') + '">'
        + '<i class="sz" style="background:rgba(' + rgb + ',' + (0.15 + 0.85*sh).toFixed(2) + ')"></i>'
        + '<div class="sn"><span class="nm">' + s.k + '</span>'
        + '<span class="sd ' + dsCls + '">' + dsTxt + '</span></div>'
        + '<div class="sv ' + cls + '">' + fpc(s.ret) + '</div>'
        + '<div class="ss"><span class="si">' + s.up + '/' + s.n + '</span>'
        + '<span class="sa">' + fmtAmt(s.amt) + '</span></div>'
        + '<div class="sbar" title="成交额' + shNote + '"><i style="width:'
        + barW.toFixed(1) + '%;background:rgba(' + rgb + ',.55)"></i></div>'
        + '</div>';
    }
    return o;
  };
  for (var g2=0;g2<SEC_GROUPS_OUT.length;g2++){
    var G2 = SEC_GROUPS_OUT[g2], cs = G2.cells;
    var core = [], ths = [];
    for (var c9=0;c9<cs.length;c9++) (cs[c9].th ? ths : core).push(cs[c9]);
    if (!core.length) continue;
    // 「最强/最弱/分化」只在行业格里选。主题格与行业格是同一批股票，
    // 让 AI 参与排名会出现「AI 最强、半导体也最强」的同义反复。
    var mxAmt = 0, nUp = 0;
    for (var m2=0;m2<core.length;m2++){ mxAmt = Math.max(mxAmt, core[m2].amt); if (core[m2].ret > 0) nUp++; }
    var top = core[0], bot = core[core.length-1];
    var spread = top.ret - bot.ret;
    // 组内资金占比上升最多的那一格（不到 0.5pt 不报，噪声）
    var bk = null, bv = 0;
    if (sdel){
      for (var m3=0;m3<core.length;m3++){
        var dl0 = sdel[core[m3].key];
        if (dl0 && dl0.ds > bv){ bv = dl0.ds; bk = core[m3].k; }
      }
    }
    h += '<div class="sgrp' + (secFoldState()[G2.code] ? ' fold' : '') + '" data-g="' + G2.code + '">'
      + '<div class="sghd" data-fold="' + G2.code + '">'
      + '<i class="sgc"></i><span class="sgk">' + G2.g + '</span>'
      + '<span class="sgt">' + core.length + (G2.code === 'x' ? ' 个地区' : ' 个行业')
      + (ths.length ? ' · ' + ths.length + ' 个主题' : '')
      + ' · ' + fmtAmt(G2.amt) + '</span>'
      + '<span class="sgm">强 <b class="' + (top.ret >= 0 ? 'up' : 'down') + '">'
      + top.k + ' ' + fpc(top.ret) + '</b></span>'
      + '<span class="sgm">弱 <b class="down">' + bot.k + ' ' + fpc(bot.ret) + '</b></span>'
      + '<span class="sgm">分化 <b>' + spread.toFixed(2) + '</b></span>'
      + (bk ? '<span class="sgm">资金 <b class="up">' + bk + ' +' + bv.toFixed(1) + 'pt</b></span>' : '')
      + '<span class="sgm t3">' + nUp + ' 涨 ' + (core.length - nUp) + ' 跌</span>'
      + '</div>'
      + (G2.code === 'a' ? secQuadCard() : '')
      + '<div class="smgrid">'
      + cellHtml(G2, core, mxAmt, sdel)
      + (ths.length
        ? '<div class="sth">主题 · 跨行业需求，成分落在上面几格里，<b>不计入占比分母</b></div>'
          + cellHtml(G2, ths, mxAmt, sdel)
        : '')
      + '</div><div class="sdet" id="secDet_' + G2.code + '"></div></div>';
  }
  body.innerHTML = h;
  maybeSaveSecDaily();

  // 明细：只显示当前点开的那一格，放在它所属组的格子里。
  // 全部指数都列出来（原先截前 8 个，新能源这种十几条线的板块，
  // 光伏就被挤出列表了——看不看得见取决于它今天涨没涨，那是错的）。
  var cur = null;
  for (var q=0;q<SECS.length;q++) if (SECS[q].key === SEC_OPEN) cur = SECS[q];
  if (!cur){ SEC_OPEN = null; return; }
  if (secFoldState()[cur.code]){ secFoldState()[cur.code] = false; saveSecFold(); }
  var det = document.getElementById('secDet_' + cur.code);
  if (!det) return;
  var grp = document.querySelector('.sgrp[data-g="' + cur.code + '"]');
  if (grp) grp.className = 'sgrp';
  var rows = cur.ix, dh = secTrend(cur) + '<div class="sdhd">' + cur.k + ' · 按涨幅排序 · '
    + cur.n + ' 个跟踪指数（每个指数只算成交额最大那只，点一行看 K 线）</div>'
    + '<div class="sdrwrap">';
  for (var r=0;r<rows.length;r++){
    var o = rows[r];
    var c2 = o.chg > 0 ? 'up' : (o.chg < 0 ? 'down' : 'flat');
    dh += '<div class="sr" data-code="' + esc(o.c) + '">'
      + '<span class="nm2">' + esc(o.ix) + '</span>'
      + '<span class="cd2">' + esc(o.c) + '</span>'
      + '<span class="v2 ' + c2 + '">' + fpc(o.chg) + '</span>'
      + '<span class="a2">' + fmtAmt(o.amt) + '</span></div>';
  }
  dh += '</div>';
  det.innerHTML = dh;
  det.className = 'sdet show';
}


/* ---------- 渲染 ---------- */
function ixBadge(x){
  if (!x.ix || !(IX_N[x.ix] > 1)) return '';
  var n = IX_N[x.ix], mx = KEEP[x.ix] === x.c;
  return '<span class="ixb'+(mx?' mx':'')+'" data-ix="'+x.ix+'" title="跟踪 '+x.ix+' · 同指数 '+n+' 只'
    + (mx ? '，本只成交额最大' : '，本只成交额不是最大')
    + '。点击查看该指数全部 '+n+' 只' + '">×'+n+'</span>';
}

function rowHtml(x, withDel){
  var lp = lastP[x.c], fl = '';
  if (lp!=null && x.p!==lp) fl = x.p>lp?'fu':'fd';
  lastP[x.c] = x.p;
  var amp = (x.hi>0 && x.lo>0 && x.pc>0) ? ((x.hi-x.lo)/x.pc*100) : null;
  var act = withDel
    ? '<span class="act del" data-del="'+x.c+'" title="移除">×</span>'
    : '<span class="act" data-add="'+x.c+'" title="加自选">+</span>';
  return '<td class="l code">'+x.c+'</td>'
    + '<td class="l nm">'+x.n+ixBadge(x)+'</td>'
    + '<td class="'+cc(x.chg)+' '+fl+'">'+fp(x.p)+'</td>'
    + '<td class="'+cc(x.chg)+'">'+fpc(x.chg)+'</td>'
    + (withDel ? '<td class="hide-md t3cell" data-t3="'+x.c+'">'+top3Html(x.c)+'</td>' : '')
    + (withDel ? '<td class="'+cc(x.chg)+'">'+(x.pc?(x.p-x.pc>0?'+':'')+(x.p-x.pc).toFixed(3):'-')+'</td>' : '')
    + '<td class="ctr">'+pbadge(x.pm)+'</td>'
    + (withDel ? '<td style="color:var(--txt2)">'+(x.iopv?x.iopv.toFixed(4):'-')+'</td>' : '')
    + '<td>'+famt(x.amt)+'</td>'
    + '<td style="color:var(--txt2)">'+(x.tr?x.tr.toFixed(2)+'%':'-')+'</td>'
    + '<td class="hide-sm" style="color:var(--txt2)">'+(amp?amp.toFixed(2)+'%':'-')+'</td>'
    + '<td class="hide-sm">'+(x.hi?fp(x.hi):'-')+'</td>'
    + '<td class="hide-sm">'+(x.lo?fp(x.lo):'-')+'</td>'
    + '<td class="ctr">'+act+'</td>';
}

function renderCards(){
  var gc = groupCounts();
  var dc = dedupCount();
  document.getElementById('cTotal').textContent = DATA.length || '-';
  document.getElementById('cUni').textContent = (DATA.length && DEDUP && dc < DATA.length)
    ? ('去重后 ' + dc + ' 只 · 合并 ' + Object.keys(IX_N).length + ' 组重复')
    : (DATA.length ? ('宽基'+gc.broad+' 跨境'+gc.cross+' 行业'+gc.industry) : '-');
  var nd = document.getElementById('n-dedup');
  if (nd) nd.textContent = (DATA.length && DEDUP) ? (' ' + dc) : '';
  if (STATS){
    document.getElementById('cUD').innerHTML =
      '<span class="up">'+STATS.up+'</span> / <span class="down">'+STATS.down+'</span>';
    document.getElementById('cUDs').textContent = '平 ' + STATS.flat;
    document.getElementById('cAmt').textContent = famt(STATS.amt);
  }
  // 分类标签上的数量
  ['all','broad','cross','industry','bond','money','commodity'].forEach(function(k){
    var el = document.getElementById('n-'+k);
    if (el) el.textContent = gc[k] || '';
  });
}

/* ================= 自选「主要贡献」 =================
   一行一只 ETF，看得到「涨了 0.8%」，看不到是谁拉的。这一栏补上贡献最大的三只
   成分股——涨的时候看谁在拉，跌的时候看谁在砸。

   按 |贡献| 排、不是只取正贡献：一只跌 1% 的 ETF，列三只红的对它毫无解释力。

   成本：/api/top3 一次最多 10 只，这里按 10 只一批**串行**发。并发发三批会让
   上游同时抓二三十只 PCF，上交所那边会空回复（实测并发 6 只就有失败）。
   自选超过 30 只只算前 30：再往后是长尾，等一屏滚下去时这一列早就不在视野里了。
*/
var TOP3 = {};          // code -> {ok, day, n, ctr, items:[{n,c,w,chg,ctr}]}
var TOP3_SIG = '';      // 上一次请求的自选指纹：列表没变就不重复请求
var TOP3_BUSY = false;

function t3short(n){
  // 超过 6 个字截断：「华夏中证新能源汽车」这种全名会把三只挤成两行
  return (n && n.length > 6) ? n.slice(0, 6) + '…' : (n || '');
}

function top3Html(c){
  var r = TOP3[c];
  if (!r) return '<span class="t3ph">·</span>';
  if (!r.ok || !r.items || !r.items.length) return '<span class="t3ph">-</span>';
  var buf = [];
  for (var i = 0; i < r.items.length; i++){
    var x = r.items[i];
    var v = (Math.abs(x.ctr) < 0.005) ? 0 : x.ctr;
    buf.push('<span class="t3 ' + cc(v) + '" title="' + esc(x.n) + ' ' + esc(x.c)
      + '\\u3000权重 ' + x.w.toFixed(2) + '%，今日 ' + (x.chg == null ? '-' : fpc(x.chg))
      + '，贡献 ' + fpt(x.ctr) + ' 个百分点">'
      + esc(t3short(x.n)) + '<em>' + fpt(x.ctr) + '</em></span>');
  }
  return buf.join('');
}

function paintTop3(){
  var cells = document.querySelectorAll('#watchBody td[data-t3]');
  for (var i = 0; i < cells.length; i++){
    var h = top3Html(cells[i].getAttribute('data-t3'));
    if (cells[i].innerHTML !== h) cells[i].innerHTML = h;
  }
}

function runTop3(list){
  if (TOP3_BUSY || !list.length) return;
  TOP3_BUSY = true;
  var i = 0;
  function next(){
    if (i >= list.length){ TOP3_BUSY = false; return; }
    var part = list.slice(i, i + 10);
    i += 10;
    fetch('/api/top3?codes=' + part.join(',')).then(function(r){ return r.json(); })
      .then(function(j){
        if (j && j.rows) for (var c in j.rows) TOP3[c] = j.rows[c];
        paintTop3();
        next();
      })['catch'](function(){ next(); });
  }
  next();
}

function ensureTop3(){
  if (!watch.length) return;
  var list = watch.slice(0, 30);
  var sig = list.join(',');
  if (sig === TOP3_SIG) return;
  TOP3_SIG = sig;
  // 列表变了就整批丢掉：留着旧的会让删掉的代码一直显示、新加的顶着上一只的名字
  TOP3 = {};
  paintTop3();
  runTop3(list);
}

function renderWatch(){
  var body = document.getElementById('watchBody');
  if (!watch.length){
    body.innerHTML = '<tr><td colspan="14" class="empty">还没有自选，点下方清单的 + 添加</td></tr>';
    document.getElementById('watchN').innerHTML = WATCH_CLOUD
      ? '<span class="syn">云端</span>' : '';
    return;
  }
  var map = new Map();
  for (var i=0;i<DATA.length;i++) map.set(DATA[i].c, DATA[i]);
  var html = '', miss = 0;
  for (var k=0;k<watch.length;k++){
    var c = watch[k];
    var x = LIVE[c] || map.get(c);      // 东财高频数据优先
    if (!x){
      miss++;
      html += '<tr class="hr" data-c="'+c+'"><td class="l code">'+c+'</td>'
        + '<td class="l" colspan="12" style="color:var(--txt3)">未取到（可能已退市或非场内 ETF）</td>'
        + '<td class="ctr"><span class="act del" data-del="'+c+'">×</span></td></tr>';
      continue;
    }
    html += '<tr class="hr" data-c="' + x.c + '">' + rowHtml(x, true) + '</tr>';
  }
  body.innerHTML = html;
  document.getElementById('watchN').innerHTML = watch.length + ' 只'
    + (miss ? ('，' + miss + ' 只未取到') : '')
    // 贡献列只算前 30 只（后端硬上限 + 上游并发限制），超了要说一声，
    // 否则第 31 行起一直是「-」，看着像坏了
    + (watch.length > 30 ? '<span class="syn" title="「主要贡献」列只算自选的前 30 只（按自选顺序），'
      + '再往后是长尾，滚到那里时这一列早就不在视野里了">贡献列前 30</span>' : '')
    + (WATCH_CLOUD ? '<span class="syn" title="已存到云端（按本机匿名编号分桶）。换设备请用「导入/导出」搬清单">云端</span>' : '');
  ensureTop3();
  paintTop3();     // tbody 刚被整块重写，单元格是新的，得重画一遍
  diagSync();
}

/* ================= 位置诊断 =================
   整页唯一不看「今天涨跌」的东西。行情软件告诉你涨了多少，这里回答两个
   行情软件不回答的问题：它现在站在近一年区间的哪个位置、这次上涨是走出来的
   还是震出来的。两个指标都不是现编的，是研究页里穿过样本外检验的那两个：

     RANGE_POS  现价在近 250 日高低区间的百分位（0 = 一年新低，100 = 一年新高）
     PE         20 日净涨幅 ÷ 20 日路径长度。接近 1 是单边拉上去的，接近 0 是
                来回震荡堆出来的——后者量能一旦跟不上，涨幅还回去的速度更快

   量能倍数 = 今日成交量 ÷ 前 20 日均量，判断这个位置有没有人接。
   三者交叉给一个动作标签，标签只是把数字翻成人话，不预测涨跌。
*/
var DIAG = {};        // code -> {ok,pos,pe,r20,evr,d60,vol20,cls,tag,rk,why}
var DIAG_Q = [];      // 待取历史的代码队列
var DIAG_BUSY = 0;
var DIAG_HTML = '';   // 上一次渲染的 HTML：一样就不重写，避免整块闪
var DIAG_MAX = 3;     // 并发上限：一次拉太多会把 /api/hist 打出 429

/* 交易日进度：9:30–11:30 + 13:00–15:00 共 240 分钟。
   盘中拿到的「今日成交额」是半截的，直接和 20 日均额比会系统性偏低，
   早盘十点能显示成「缩量一半」，所以按已交易分钟折算。 */
function dayProgress(){
  var d = new Date(), t = d.getHours() * 60 + d.getMinutes();
  if (t < 570) return 0;
  if (t <= 690) return (t - 570) / 240;
  if (t < 780) return 0.5;
  if (t <= 900) return (120 + (t - 780)) / 240;
  return 1;
}

/* 位置一律以「昨天」为锚：
   区间取到昨天那根为止，今天只用实时价去比。这样昨天位置和今天位置是同一个
   坐标系里的两个点，能直接相减做「今天变了什么」；否则区间跟着今天一起变，
   位置永远在自己的区间里，看不出变化。 */
function diagFrom(raw, it){
  if (!raw || !raw.col || !raw.col.close) return null;
  var cl = raw.col.close, hi = raw.col.high, lo = raw.col.low;
  // 量能用成交额而不是成交量：同一指数换一只 ETF，份额和净值都不同，成交量没法比
  var vo = raw.col.amount || raw.col.volume;
  var n = raw.n, i;
  if (!n || n < 80) return null;

  var td = (function(){ var d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
  // 收盘后 Actions 会把今天写进 .bin，此时最后一根就是今天，锚点要往前挪一根
  var e = (raw.dates && raw.dates[n - 1] === td) ? n - 2 : n - 1;
  if (e < 60) return null;

  var s = Math.max(0, e - 249);
  var hh = -1e18, ll = 1e18;
  for (i = s; i <= e; i++){
    if (hi && hi[i] > hh) hh = hi[i];
    if (lo && lo[i] > 0 && lo[i] < ll) ll = lo[i];
  }
  var cur = (it && it.p > 0) ? it.p : cl[e];
  if (cur > hh) hh = cur;
  if (cur < ll) ll = cur;
  if (!(hh > ll)) return null;
  var pos = (cur - ll) / (hh - ll) * 100;
  var posPrev = (cl[e] - ll) / (hh - ll) * 100;

  var m = Math.min(21, e + 1), path = 0, sq = 0, cnt = 0;
  for (i = e - m + 2; i <= e; i++){
    if (cl[i - 1] > 0){
      var rr = cl[i] / cl[i - 1] - 1;
      path += Math.abs(rr); sq += rr * rr; cnt++;
    }
  }
  if (cl[e] > 0) path += Math.abs(cur / cl[e] - 1);
  var r20 = cl[e - 20] > 0 ? cur / cl[e - 20] - 1 : 0;
  var pe = path > 1e-6 ? Math.max(-1, Math.min(1, r20 / path)) : 0;

  // 20 日均额（到昨天为止），以及昨天的量能倍数
  var sum = 0, k = 0;
  for (i = Math.max(0, e - 19); i <= e; i++){ if (vo && vo[i] > 0){ sum += vo[i]; k++; } }
  var ma = k ? sum / k : 0;
  var evrPrev = (ma > 0 && vo && vo[e] > 0) ? vo[e] / ma : null;
  var evr = evrPrev;
  var pr = dayProgress();
  var liveAmt = (it && it.amt > 0) ? it.amt : null;
  if (liveAmt && pr >= 0.12 && ma > 0) evr = (liveAmt / pr) / ma;

  // 20 日年化波动，只给「震出来的」提供个量化注脚
  var vol20 = cnt > 1 ? Math.sqrt(sq / cnt) * Math.sqrt(252) * 100 : null;

  return { pos:pos, posPrev:posPrev, pe:pe, r20:r20, evr:evr, evrPrev:evrPrev,
           dHi:hh > 0 ? cur / hh - 1 : null, dLo:ll > 0 ? cur / ll - 1 : null,
           vol20:vol20, bars:n, anchor:e, hi:hh, lo:ll };
}

function diagTag(d){
  var pos = d.pos, evr = d.evr;
  if (pos < 20){
    return evr != null && evr >= 1.6
      ? ['低位放量','d2',1,'底部位置突然放量：可能是破位，也可能是启动，先看能不能站住']
      : ['低位缩量','d1',3,'一年来的低位，量能也萎缩：无人问津的位置适合分批，不适合追'];
  }
  if (pos > 80){
    return evr != null && evr >= 1.6
      ? ['高位放量','d4',0,'位置和量能同时到高位：有人在交货，别在这里加']
      : ['高位缩量','d3',2,'位置很高但没量：涨得没人接，追进去容易接最后一棒'];
  }
  return ['中位','d0',4,'位置中性：上下都留得住，等突破或破位再动手'];
}

/* ================= 今日变化 =================
   行情软件的默认视图是「现在是什么样」。真正稀缺的是「相比昨天变了什么」——
   只有变化才对应动作。这里把每只自选今天发生的事抽成一条条事件：
   创一年新高/新低、穿过 80/20 分位、量能突变、贴到新高 1% 以内、溢价异常。
   没事件的标的不出现，页面短下来本身就是信息。 */
function buildEvents(){
  var out = [];
  for (var c in DIAG){
    var d = DIAG[c];
    if (!d || !d.ok) continue;
    var nm = d.n || c, ev = d.evr, ep = d.evrPrev;
    var evs = ev == null ? '-' : ev.toFixed(2);
    var mine = [];
    function add(lv, t, txt){ mine.push({ lv:lv, t:t, s:txt }); }

    if (d.pos >= 99.5 && d.posPrev < 99.5){
      add(3, '创一年新高', '位置 ' + d.pos.toFixed(0) + '%，量能 ×' + evs
        + '。不放量的新高是常态，放量新高反而要防冲高回落');
    } else if (d.posPrev < 80 && d.pos >= 80){
      add(2, '升破 80 分位', '位置从 ' + d.posPrev.toFixed(0) + ' 抬到 ' + d.pos.toFixed(0)
        + '，量能 ×' + evs + '，进入高位区');
    }
    if (d.pos <= 0.5 && d.posPrev > 0.5){
      add(3, '创一年新低', '位置归零，量能 ×' + evs
        + '。新低之后的第一根放量阳线才是信号，别在阴线里接');
    } else if (d.posPrev > 20 && d.pos <= 20){
      add(2, '跌破 20 分位', '位置从 ' + d.posPrev.toFixed(0) + ' 掉到 ' + d.pos.toFixed(0)
        + '，量能 ×' + evs + '，进入低位区');
    }
    if (ev != null && ev >= 2 && (ep == null || ep < 1.4)){
      add(2, '量能 2 倍', '今天成交额是 20 日均额的 ' + ev.toFixed(1) + ' 倍，昨天只有 '
        + (ep == null ? '-' : ep.toFixed(2)) + ' 倍');
    }
    if (ev != null && ev <= 0.55 && ep != null && ep >= 1){
      add(1, '量能腰斩', '量能从 ×' + ep.toFixed(2) + ' 掉到 ×' + ev.toFixed(2) + '，关注度退潮');
    }
    if (d.dHi != null && d.dHi > -0.012 && d.dHi < 0 && d.pos < 99){
      add(1, '贴新高', '还差 ' + Math.abs(d.dHi * 100).toFixed(1) + '% 到一年高点，突破与否是分水岭');
    }
    var it = findItem(c);
    if (it && it.pm != null && Math.abs(it.pm) >= 0.8){
      add(it.pm > 0 ? 2 : 1, (it.pm > 0 ? '溢价 ' : '折价 ') + Math.abs(it.pm).toFixed(2) + '%',
        '价格偏离 IOPV ' + it.pm.toFixed(2) + '%，超过 0.8% 通常是流动性或情绪问题，别当便宜捡');
    }
    if (!mine.length) continue;
    var top = mine[0];
    for (var q = 1; q < mine.length; q++) if (mine[q].lv > top.lv) top = mine[q];
    // 事件多的排前面：同一只身上同时出现两件事，比单件事更值得看
    out.push({ c:c, nm:nm, lv:top.lv, tags:mine.map(function(x){ return x.t; }),
               s:top.s, k:mine.length * 10 + top.lv });
  }
  out.sort(function(a, b){ return b.k - a.k; });
  return out;
}

function renderEvents(){
  var box = document.getElementById('evtList');
  if (!box) return;
  var nEl = document.getElementById('evtN');
  var done = 0;
  for (var c in DIAG) if (DIAG[c] && DIAG[c].ok) done++;
  if (!watch.length){
    box.innerHTML = '<div class="empty">加自选后这里显示每天的变化</div>';
    if (nEl) nEl.textContent = '';
    return;
  }
  if (!done){
    var busy = DIAG_Q.length + DIAG_BUSY;
    box.innerHTML = '<div class="empty">'
      + (busy ? '正在读取历史…' : '历史还没准备好，点右上角「重算」再试一次') + '</div>';
    return;
  }
  var ev = buildEvents();
  if (nEl) nEl.textContent = ev.length ? (ev.length + ' 只有动作') : '无';
  var elSig = document.getElementById('cSig'), elSigs = document.getElementById('cSigs');
  if (elSig){
    elSig.innerHTML = ev.length + '<small>只</small>';
    var tags = {};
    for (var t = 0; t < ev.length; t++){
      for (var u = 0; u < ev[t].tags.length; u++) tags[ev[t].tags[u]] = 1;
    }
    var ks = [];
    for (var kk in tags) ks.push(kk);
    elSigs.textContent = ks.length ? ('今日：' + ks.slice(0, 3).join(' · ')) : '自选里没有值得动手的变化';
  }
  if (!ev.length){
    box.innerHTML = '<div class="eempty">自选里今天没有值得动手的变化。<br>'
      + '<span>' + done + ' 只都在原来位置附近震荡，量能没有突变，也没贴到新高低。</span></div>';
    return;
  }
  var h = '', cap = 6;
  for (var i = 0; i < ev.length && i < cap; i++){
    var e = ev[i], tg = '';
    for (var j = 0; j < e.tags.length; j++) tg += '<span class="ek">' + esc(e.tags[j]) + '</span>';
    h += '<div class="evt lv' + e.lv + '" data-c="' + e.c + '"><i></i><div class="eb">'
      + '<b>' + esc(e.nm) + '</b>' + tg
      + '<div class="es">' + esc(e.s) + '</div></div></div>';
  }
  if (ev.length > cap){
    h += '<div class="es" style="padding:6px 0 0;color:var(--txt3)">还有 ' + (ev.length - cap)
      + ' 只变化更小，没列出来</div>';
  }
  box.innerHTML = h;
}

/* ================= 组合体检 =================
   自选列表看起来是 N 个仓位，实际承担的风险由相关性决定。
   用最近 60 个共同交易日的日收益算两两相关，再用
   n_eff = n / (1 + (n-1)·ρ̄) 折算成「有效独立仓位数」。
   这是全页最不像行情软件的一块：行情软件永远只盯着单只标的。 */
function corrOf(a, b){
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++){ ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var sa = 0, sb = 0, sab = 0, x, y;
  for (i = 0; i < n; i++){
    x = a[i] - ma; y = b[i] - mb;
    sa += x * x; sb += y * y; sab += x * y;
  }
  return (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : 0;
}

function portStats(){
  var codes = [], c;
  for (c in DIAG){ var d = DIAG[c]; if (d && d.ok && d.raw) codes.push(c); }
  if (codes.length < 2) return null;
  var maps = [], common = null, i, j;
  for (i = 0; i < codes.length; i++){
    var raw = DIAG[codes[i]].raw, m = {};
    for (j = 1; j < raw.n; j++){
      var p0 = raw.col.close[j - 1], p1 = raw.col.close[j];
      if (p0 > 0 && p1 > 0) m[raw.dates[j]] = p1 / p0 - 1;
    }
    maps.push(m);
    var ds = [];
    for (var k in m) ds.push(k);
    common = common ? common.filter(function(x){ return m[x] != null; }) : ds;
  }
  common.sort();
  var use = common.slice(-60);
  if (use.length < 20) return null;
  var R = [];
  for (i = 0; i < codes.length; i++){
    var arr = [];
    for (j = 0; j < use.length; j++) arr.push(maps[i][use[j]]);
    R.push(arr);
  }
  var sum = 0, cnt = 0, best = { r:-2, a:'', b:'' }, worst = { r:2, a:'', b:'' };
  for (i = 0; i < codes.length; i++){
    for (j = i + 1; j < codes.length; j++){
      var r = corrOf(R[i], R[j]);
      sum += r; cnt++;
      if (r > best.r) best = { r:r, a:codes[i], b:codes[j] };
      if (r < worst.r) worst = { r:r, a:codes[i], b:codes[j] };
    }
  }
  var avg = cnt ? sum / cnt : 0;
  var neff = codes.length / (1 + (codes.length - 1) * Math.max(0, avg));
  return { n:codes.length, avg:avg, neff:neff, best:best, worst:worst, days:use.length };
}

function renderPort(){
  var box = document.getElementById('portBox');
  if (!box) return;
  var p = portStats();
  if (!p){
    box.innerHTML = '<div class="empty">组合体检需要至少 2 只自选</div>';
    return;
  }
  var an = (findItem(p.best.a) || {}).n || p.best.a;
  var bn = (findItem(p.best.b) || {}).n || p.best.b;
  var wn = (findItem(p.worst.a) || {}).n || p.worst.a;
  var wb = (findItem(p.worst.b) || {}).n || p.worst.b;
  var tone = p.avg >= 0.75 ? '基本在赌同一个方向' : (p.avg >= 0.5 ? '同涨同跌的成分不小' : '分散度还可以');
  var h = '<div class="prow">'
    + '<div><div class="pk">有效独立仓位</div><div class="pv">' + p.neff.toFixed(1)
    + '<small>/ ' + p.n + ' 只</small></div></div>'
    + '<div><div class="pk">平均相关</div><div class="pv">' + p.avg.toFixed(2) + '</div></div>'
    + '</div>'
    + '<div class="pnote">看着是 <b>' + p.n + ' 个仓位</b>，按最近 ' + p.days
    + ' 个交易日的相关性折算，实际只承担了 <b>' + p.neff.toFixed(1) + ' 个</b>仓位的风险，' + tone + '。'
    + '<br>最像的两只：<b>' + esc(an) + '</b> × <b>' + esc(bn) + '</b>，相关 ' + p.best.r.toFixed(2)
    + '；最不像的：<b>' + esc(wn) + '</b> × <b>' + esc(wb) + '</b>，' + p.worst.r.toFixed(2)
    + '，想加分散度往这对的方向找。</div>';
  box.innerHTML = h;
}

/* ================= 全市场异动 =================
   自选是「我关心的」，这一栏是「市场发生了什么」。两者的区别不在于数量，
   而在于**发现**：只看自选，永远只能在自己已经知道的池子里找机会。

   数据来自收盘后算好的快照（alpha/events.py → /api/events），26KB，
   一个指数只留流动性最好的那只 ETF。位置和量能的口径与自选里的诊断完全一致，
   所以两块的数字可以直接横向比较。

   盘中打开时用实时价就地重算位置——快照里带着一年高低点（已换算到原始价格
   尺度），拿实时价一减就得到当下的位置，不用重新拉历史。
*/
var MKT = null, MKT_ERR = '', MKT_TAB = 'all';

/* 顺序即重要性：突破和破位排在量能前面，因为前者有价格确认 */
var MKT_TYPES = [
  ['hi', '创新高'], ['up80', '上穿80'], ['near', '贴新高'],
  ['lo', '创新低'], ['dn20', '跌破20'], ['vol', '放量'], ['dry', '缩量']
];

/* 「全部」把各类型按上面的优先级合并。同一只标的同时创新高又放量时只留一次，
   留的是优先级更高的那条（突破比放量更值得先看）。 */
var MKT_LABEL = {
  hi:['新高', 't-up'], up80:['上穿', 't-up'], near:['贴高', 't-warn'],
  lo:['新低', 't-down'], dn20:['跌破', 't-down'],
  vol:['放量', 't-info'], dry:['缩量', 't-mute']
};

function mktRows(){
  if (!MKT || !MKT.ev) return [];
  if (MKT_TAB !== 'all'){
    var one = MKT.ev[MKT_TAB] || [];
    return one.map(function(r){ return { t:MKT_TAB, r:r }; });
  }
  var seen = {}, out = [];
  for (var i = 0; i < MKT_TYPES.length; i++){
    var k = MKT_TYPES[i][0], arr = MKT.ev[k] || [];
    for (var j = 0; j < arr.length; j++){
      if (seen[arr[j][0]]) continue;
      seen[arr[j][0]] = 1;
      out.push({ t:k, r:arr[j] });
    }
  }
  return out;
}

function mktPos(r){
  /* r = [code,name,idx,pos,posPrev,evr,r20,r1,hh,ll,amt] */
  var hh = r[8], ll = r[9];
  var it = findItem(r[0]);
  var p = it && it.p > 0 ? it.p : null;
  if (p && hh > ll && ll > 0){
    return Math.max(0, Math.min(100, (p - ll) / (hh - ll) * 100));
  }
  return r[3];
}

function mktEvr(r){
  // 盘中用实时成交额重算：快照里的量能是「昨天收盘时」的读数，今天已经变了。
  // 分母（20 日均额）用快照成交额反推，不用再拉数据。
  var it = findItem(r[0]);
  if (it && it.amt > 0 && r[10] > 0 && r[5] > 0){
    var pr = dayProgress();
    if (pr > 0.12 && pr < 1){
      var base = r[10] / r[5];
      if (base > 0) return (it.amt / 1e8) / pr / base;
    }
  }
  return r[5];
}

function mktBar(){
  var b = MKT.breadth, n = b.n || 1;
  var hiPct = b.p80 / n * 100, loPct = b.p20 / n * 100;
  var midPct = Math.max(0, 100 - hiPct - loPct);
  document.getElementById('mktBar').innerHTML =
    '<i style="width:' + hiPct.toFixed(1) + '%;background:#e8a0a0"></i>'
    + '<i style="width:' + midPct.toFixed(1) + '%;background:#dfe4ec"></i>'
    + '<i style="width:' + loPct.toFixed(1) + '%;background:#8fc9ae"></i>';

  /* 位置是 0–100 的百分位刻度，取整显示：小数点后那位（15.8）在这个尺度上
     没有意义，只会让人以为是价格或倍数。和左右两边的「只数」并列时，
     必须把单位写出来才对得上——「中位位置 16%」。
     口径写进 title：不是涨幅、不是价格，是收盘价落在近一年高低区间的第几成。 */
  var w1 = document.getElementById('mktWidth');
  var med = (b.medPos == null || !isFinite(b.medPos)) ? '-' : Math.round(b.medPos) + '%';
  w1.innerHTML = '<span>一年高位 <b>' + b.p80 + '</b> 只</span>'
    + '<span title="全部 ETF 的位置中位数：位置 = (现价 − 近一年最低) ÷ (近一年最高 − 近一年最低)。'
    + '越接近 0% 越贴一年低位，越接近 100% 越贴一年高位">中位位置 <b>'
    + med + '</b></span>'
    + '<span>一年低位 <b>' + b.p20 + '</b> 只</span>';

  var w2 = document.getElementById('mktWidth2');
  w2.innerHTML = '<span>上涨 <b>' + b.up + '</b> · 下跌 <b>' + b.dn + '</b>'
    + (b.flat ? ' · 平 ' + b.flat : '') + '</span>'
    + '<span>合计成交 <b>' + b.amt.toFixed(0) + '</b> 亿</span>';
}


function mktList(){
  var box = document.getElementById('mktList');
  var rows = mktRows();
  if (!rows.length){
    box.innerHTML = '<div class="eempty">今天没有这一类事件。<br>'
      + '<span>不是数据没加载，是真的没有——这种日子不用动手。</span></div>';
    return;
  }
  var head = '<div class="mhead"><span>名称 / 跟踪指数</span><span>类型</span>'
    + '<span>位置</span><span>量能</span><span>今日</span></div>';
  var cap = 14;
  var shown = Math.min(rows.length, cap);
  // 6 行以内单栏就够，分两栏会出现「左 3 右 3」而右边那半截没内容支撑
  var two = shown > 6;
  var half = two ? Math.ceil(shown / 2) : shown;
  var colHtml = ['', ''];
  for (var i = 0; i < shown; i++){
    var r = rows[i].r, tg = MKT_LABEL[rows[i].t] || ['', ''];
    var pos = mktPos(r), ev = mktEvr(r);
    // 最后一列放今日涨幅而不是 20 日：这一栏回答的是「今天发生了什么」，
    // 20 日累计放进标题提示，鼠标停上去能看到。
    var tip = r[1] + ' · 20日 ' + fpc(r[6]) + ' · 成交 ' + r[10].toFixed(1) + ' 亿';
    var row = '<div class="mrow" data-c="' + r[0] + '" title="' + esc(tip) + '">'
      + '<span class="mn">' + esc(r[1])
      + (r[2] ? '<em>' + esc(r[2]) + '</em>' : '') + '</span>'
      + '<span class="mtag ' + tg[1] + '">' + tg[0] + '</span>'
      + '<span class="mnum">' + pos.toFixed(0) + '</span>'
      + '<span class="mnum">' + (ev == null ? '-' : ev.toFixed(1)) + '</span>'
      + '<span class="mnum ' + cc(r[7]) + '">' + fpc(r[7]) + '</span>'
      + '</div>';
    colHtml[i < half ? 0 : 1] += row;
  }
  var h = two
    ? '<div class="mcols"><div class="mcol">' + head + colHtml[0] + '</div>'
      + '<div class="mcol">' + head + colHtml[1] + '</div></div>'
    : head + colHtml[0];
  if (rows.length > cap){
    h += '<div class="mfoot">另有 ' + (rows.length - cap) + ' 只变化更小，没列出来</div>';
  }
  box.innerHTML = h;
}

function mktTabs(){
  var h = '<span class="mtab' + (MKT_TAB === 'all' ? ' on' : '')
    + '" data-t="all">全部<u>' + (MKT ? mktRows().length : 0) + '</u></span>';
  for (var i = 0; i < MKT_TYPES.length; i++){
    var k = MKT_TYPES[i][0];
    var n = (MKT.ev && MKT.ev[k]) ? MKT.ev[k].length : 0;
    h += '<span class="mtab' + (k === MKT_TAB ? ' on' : '') + '" data-t="' + k + '">'
      + MKT_TYPES[i][1] + '<u>' + n + '</u></span>';
  }
  document.getElementById('mktTabs').innerHTML = h;
}

function renderMkt(){
  var nEl = document.getElementById('mktN');
  if (!MKT){
    document.getElementById('mktList').innerHTML =
      '<div class="empty">' + esc(MKT_ERR || '还没有收盘快照，等今晚数据管道跑完') + '</div>';
    document.getElementById('mktTabs').innerHTML = '';
    if (nEl) nEl.textContent = '';
    return;
  }
  mktBar(); mktTabs(); mktList();
  if (nEl){
    nEl.textContent = MKT.n + ' 个指数 · ' + MKT.date + ' 收盘';
  }
}

function loadMkt(){
  fetch('/api/events').then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.ok === false) throw new Error((j && j.error) || '没有数据');
    MKT = j; MKT_ERR = '';
    renderMkt();
  }).catch(function(e){
    MKT = null; MKT_ERR = (e && e.message) || '读取失败';
    renderMkt();
  });
}

function mktInit(){
  var t = document.getElementById('mktTabs');
  if (t){
    t.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== t && !el.getAttribute('data-t')) el = el.parentNode;
      if (!el || el === t) return;
      MKT_TAB = el.getAttribute('data-t');
      mktTabs(); mktList();
    });
  }
  var l = document.getElementById('mktList');
  if (l){
    l.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== l && !el.getAttribute('data-c')) el = el.parentNode;
      if (!el || el === l) return;
      var c = el.getAttribute('data-c');
      var nm = '', rs = mktRows();
      for (var i = 0; i < rs.length; i++){
        if (rs[i].r[0] === c){ nm = rs[i].r[1]; break; }
      }
      openHist(c, nm || c);
    });
  }
  var b = document.getElementById('btnMkt');
  if (b) b.addEventListener('click', function(){ toast('正在重读快照…'); loadMkt(); });
  loadMkt();
}

function diagCard(code){
  var d = DIAG[code], it = findItem(code);
  var nm = esc((it && it.n) || (d && d.n) || code);
  if (!d || !d.ok){
    return '<div class="dcard pend" data-c="' + code + '">'
      + '<div class="dtop"><span class="dn">' + nm + '</span><span class="dc">' + code + '</span>'
      + '<span class="dtag d0">' + (d && d.err ? '无数据' : '计算中') + '</span></div>'
      + '<div class="posbar"></div><div class="poslb"><span>'
      + esc((d && d.err) || '读取历史…') + '</span></div></div>';
  }
  var w = Math.max(0, Math.min(100, d.pos));
  var peTxt = d.pe >= 0.45 ? '单边拉上来的' : (d.pe <= 0.15 ? '来回震出来的' : '涨跌交错堆的');
  return '<div class="dcard" data-c="' + code + '">'
    + '<div class="dtop"><span class="dn">' + nm + '</span><span class="dc">' + code + '</span>'
    + '<span class="dtag ' + d.cls + '">' + d.tag + '</span></div>'
    + '<div class="posbar"><u style="width:' + w.toFixed(1) + '%"></u>'
    + '<i style="left:' + w.toFixed(1) + '%"></i></div>'
    + '<div class="poslb"><span>低</span><span class="pz">' + d.pos.toFixed(0)
    + '<em>位置</em></span><span>高</span></div>'
    + '<div class="dchips">'
    + '<span class="dchip">量能 <b>' + (d.evr == null ? '-' : '×' + d.evr.toFixed(2)) + '</b></span>'
    + '<span class="dchip">20日 <b class="' + cc(d.r20) + '">' + fpc(d.r20 * 100) + '</b></span>'
    + '<span class="dchip">距高点<b>' + (d.dHi == null ? '-' : fpc(d.dHi * 100)) + '</b></span>'
    + '<span class="dchip">距低点<b>' + (d.dLo == null ? '-' : fpc(d.dLo * 100)) + '</b></span>'
    + '</div>'
    + '<div class="dwhy">' + d.why + '；' + peTxt + '（路径效率 ' + d.pe.toFixed(2) + '）。</div>'
    + '</div>';
}

function renderDiag(){
  var g = document.getElementById('diagGrid');
  if (!g) return;
  var nEl = document.getElementById('diagN');
  if (!watch.length){
    g.innerHTML = '<div class="empty">还没有自选，加了之后这里自动诊断</div>';
    if (nEl) nEl.textContent = '';
    return;
  }
  var cnt = {d0:0,d1:0,d2:0,d3:0,d4:0}, have = 0, list = [], i;
  for (i = 0; i < watch.length; i++){
    var d = DIAG[watch[i]];
    if (d && d.ok){ have++; if (cnt[d.cls] != null) cnt[d.cls]++; }
    list.push(watch[i]);
  }
  list.sort(function(a, b){
    var A = DIAG[a], B = DIAG[b];
    var ra = A && A.ok ? A.rk : 9, rb = B && B.ok ? B.rk : 9;
    if (ra !== rb) return ra - rb;
    return (B && B.ok ? B.pos : 0) - (A && A.ok ? A.pos : 0);
  });
  var html = '';
  for (i = 0; i < list.length; i++) html += diagCard(list[i]);
  if (html !== DIAG_HTML){ DIAG_HTML = html; g.innerHTML = html; }
  renderEvents();
  renderPort();
  if (nEl){
    var p = [];
    if (cnt.d4) p.push(cnt.d4 + ' 只高位放量');
    if (cnt.d3) p.push(cnt.d3 + ' 只高位缩量');
    if (cnt.d2) p.push(cnt.d2 + ' 只低位放量');
    if (cnt.d1) p.push(cnt.d1 + ' 只低位缩量');
    nEl.textContent = have + '/' + watch.length + ' 只已诊断'
      + (p.length ? ' · ' + p.join(' · ') : '');
  }
}

function diagFetch(code){
  DIAG_BUSY++;
  DIAG[code] = { ok:false };
  fetch('/api/hist?code=' + code).then(function(r){
    var ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('json') >= 0){
      return r.json().then(function(j){ throw new Error(j.error || '没有历史'); });
    }
    return r.arrayBuffer();
  }).then(function(buf){
    var raw = parseHist(buf);
    var it = findItem(code);
    var d = diagFrom(raw, it);
    if (!d) throw new Error('历史不足 60 根');
    var tg = diagTag(d);
    d.ok = true; d.c = code; d.n = (it && it.n) || raw.code || code;
    d.cls = tg[1]; d.tag = tg[0]; d.rk = tg[2]; d.why = tg[3];
    d.raw = raw;                       // 存原始序列：下一次行情刷新就地重算，不再请求
    DIAG[code] = d;
  }).catch(function(e){
    DIAG[code] = { ok:false, c:code, err:(e && e.message) || '读取失败' };
  }).then(function(){
    DIAG_BUSY--; renderDiag(); diagPump();
  });
}

function diagPump(){
  while (DIAG_BUSY < DIAG_MAX && DIAG_Q.length) diagFetch(DIAG_Q.shift());
}

/* 行情每 60 秒刷一次，位置要跟着走。历史已经在手上，重算只是几次浮点运算 */
function diagReprice(){
  for (var c in DIAG){
    var d = DIAG[c];
    if (!d || !d.ok || !d.raw) continue;
    var it = findItem(c);
    var nd = diagFrom(d.raw, it);
    if (!nd) continue;
    var tg = diagTag(nd);
    nd.ok = true; nd.c = c; nd.n = d.n; nd.raw = d.raw;
    nd.cls = tg[1]; nd.tag = tg[0]; nd.rk = tg[2]; nd.why = tg[3];
    DIAG[c] = nd;
  }
}

/* 自选变化时补算：已经在 DIAG 里的不重复拉，历史走边缘缓存，第二次几乎瞬时 */
function diagSync(){
  diagReprice();
  for (var i = 0; i < watch.length; i++){
    var c = watch[i];
    if (!DIAG[c] && DIAG_Q.indexOf(c) < 0) DIAG_Q.push(c);
  }
  renderDiag();
  diagPump();
}

function diagInit(){
  var g = document.getElementById('diagGrid');
  if (g){
    g.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== g && !el.getAttribute('data-c')) el = el.parentNode;
      if (!el || el === g) return;
      var c = el.getAttribute('data-c');
      var it = findItem(c);
      openHist(c, (it && it.n) || c);
    });
  }
  var ev = document.getElementById('evtList');
  if (ev){
    ev.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== ev && !el.getAttribute('data-c')) el = el.parentNode;
      if (!el || el === ev || !el.getAttribute('data-c')) return;
      var c = el.getAttribute('data-c');
      var it = findItem(c);
      openHist(c, (it && it.n) || c);
    });
  }
  var b = document.getElementById('btnDiag');
  if (b){
    b.addEventListener('click', function(){
      DIAG = {}; DIAG_Q = []; DIAG_HTML = '';
      renderDiag(); diagSync();
      toast('已清缓存，重新读历史');
    });
  }
  diagSync();
}

function renderList(){
  var arr = DATA;
  if (IXF){
    // 展开单个指数：显示该指数全部成员，按成交额排序，标出哪只是代表
    arr = arr.filter(function(x){ return x.ix === IXF; });
    arr = arr.slice().sort(function(a,b){ return (b.amt||0) - (a.amt||0); });
    var body0 = document.getElementById('listBody');
    body0.innerHTML = arr.length
      ? arr.map(function(x){ return '<tr class="hr" data-c="'+x.c+'">'+rowHtml(x, false)+'</tr>'; }).join('')
      : '<tr><td colspan="11" class="empty">该指数暂无行情</td></tr>';
    document.getElementById('listN').textContent =
      '跟踪「' + IXF + '」的 ' + arr.length + ' 只 · 按成交额排序 · 再点一次标签返回全部';
    return;
  }
  if (g !== 'all') arr = arr.filter(function(x){ return x.g === g; });
  if (kw){
    var k2 = kw.toLowerCase();
    arr = arr.filter(function(x){
      return x.c.indexOf(k2) >= 0 || x.n.toLowerCase().indexOf(k2) >= 0;
    });
  }
  var beforeDedup = arr.length;
  // 搜索时不去重：用户搜"300"就是想看所有 300ETF，藏掉 28 只反而碍事
  if (DEDUP && !kw){
    arr = arr.filter(function(x){
      return !x.ix || !KEEP[x.ix] || KEEP[x.ix] === x.c;
    });
  }
  var key = sortKey === 'chgA' ? 'chg' : sortKey;
  var dir = sortKey === 'chgA' ? 1 : -1;
  arr = arr.slice().sort(function(a,b){
    var va = a[key]==null ? -Infinity : a[key];
    var vb = b[key]==null ? -Infinity : b[key];
    return (va - vb) * dir;
  });
  var matched = arr.length;
  arr = arr.slice(0, limit);

  var body = document.getElementById('listBody');
  if (!arr.length){
    body.innerHTML = '<tr><td colspan="11" class="empty">没有匹配结果</td></tr>';
  } else {
    var buf = [];
    for (var i=0;i<arr.length;i++)
      buf.push('<tr class="hr" data-c="'+arr[i].c+'">'+rowHtml(arr[i], false)+'</tr>');
    body.innerHTML = buf.join('');
  }
  var note = '';
  if (DEDUP && !kw && beforeDedup > matched) note = '（同指数去重前 ' + beforeDedup + ' 只）';
  else if (kw && DEDUP) note = '（搜索时显示全部，未去重）';
  document.getElementById('listN').textContent =
    '显示 ' + arr.length + ' / 可用 ' + matched + ' 只' + note;
}

/* ================= 急涨急跌 =================
   为什么自己算，不用现成的涨速字段：
   - 东财 f22 就是涨速，但 push2 / push2his 这条线在沙箱和 Worker 两侧都是
     TLS 握手完成后空响应，整条链路不可用（见 README 的分时一节）；
   - 新浪排行接口 sort=speed 不生效——传 changepercent 能正确排序，传 speed
     返回的还是代码序，说明它根本不认这个字段。
   所以回到最原始的口径：拿分钟线，自己回溯。

   为什么池子只有 40 只：
   涨速要逐只拉分时，一只一个子请求。Cloudflare 免费计划每请求上限 50 个，
   服务端截到 48，前端主动取 40 留余量。按成交额取，是因为涨速榜的意义是
   「有机会下手的标的在动」——成交额小的票就算 3 分钟拉 3%，也成交不了。
   同指数去重照旧：三只 A500 一起涨，占三个坑没有任何信息量。
*/

var SPD = { rows: [], w: 3, volOnly: false, ts: 0, ms: 0, ask: 0, err: '', loading: false };
var SPD_POOL_MAX = 40;
var SPD_VOL_HOT = 1.5;         // 量比到这个倍数算「放量」
var SPD_SHOW = 5;              // 每边显示几只
/* 现金管理类日内振幅常年 0.0x%，挤进榜只会稀释信号。group() 已经把它们
   归到 money/bond，这里再按名称兜一道——有些短融 ETF 名称不带「货币」二字，
   被分到了 industry，漏进池子就会一直霸占榜首（实测 551550、511150 都这样）。
   「现金」要排除「现金流」：那是因子策略，日内波动正常，不该被挡。 */
var SPD_SKIP = /短融|货币|日利|添益|现金(?!流)|理财|保证金|快线/;

function spdPool(){
  if (!DATA.length) return [];
  var out = [], seen = {}, i, c, it;
  function push(code){
    if (seen[code] || out.length >= SPD_POOL_MAX) return;
    seen[code] = 1; out.push(code);
  }
  function usable(x){
    return x && x.amt > 0 && x.g !== 'bond' && x.g !== 'money' && !SPD_SKIP.test(x.n);
  }

  /* 自选优先。盯盘时最先想知道的是自己手里那几只有没有突然动起来，
     而它们大半不在成交额前 40（比如一只 8 亿的行业 ETF）。
     用户主动加的债券/货币类仍然剔掉——那类涨速恒为 0.00%，占位没意义。 */
  for (i = 0; i < watch.length; i++){
    c = watch[i];
    it = findItem(c);
    // 快照里查不到（新上市、停牌）也照样试一次，服务端拿不到会滤掉
    if (it ? usable(it) : true) push(c);
  }

  var arr = [];
  for (i = 0; i < DATA.length; i++) if (usable(DATA[i])) arr.push(DATA[i]);
  // KEEP 表要等指数映射加载完才有；没加载时 !KEEP[ix] 为真，等于不去重，
  // 比「把同指数的票全藏掉」安全
  if (DEDUP){
    arr = arr.filter(function(x){ return !x.ix || !KEEP[x.ix] || KEEP[x.ix] === x.c; });
  }
  arr.sort(function(a, b){ return b.amt - a.amt; });
  for (i = 0; i < arr.length; i++) push(arr[i].c);
  return out;
}

function spdFetch(force){
  var pool = spdPool();
  if (!pool.length){
    // 池子是从全市场快照里挑的。快照没到（或挂了）就一直「读取中」，
    // 那块地方看起来像卡死，得说清楚卡在哪一步
    if (!DATA.length && !SPD.err){
      SPD.err = '全市场快照还没到，涨速榜要等它先选出活跃池';
      renderSpeed();
    }
    return;
  }
  if (SPD.loading) return;
  SPD.loading = true;
  var url = '/api/speed?codes=' + pool.join(',') + (force ? '&f=' + Date.now() : '');
  fetch(url).then(function(r){ return r.json(); }).then(function(j){
    SPD.loading = false;
    if (!j || !j.ok){ SPD.err = (j && j.error) || '读取失败'; renderSpeed(); return; }
    SPD.rows = j.rows || [];
    SPD.err = '';
    SPD.ts = Date.now();
    SPD.ms = j.ms || 0;
    SPD.ask = j.ask || 0;
    renderSpeed();
  }).catch(function(e){
    SPD.loading = false;
    SPD.err = '网络错误：' + (e.message || e);
    renderSpeed();
  });
}

/* 最后一根停在 15:00 就是收完了。盘中 14:59:xx 时最后一根还是 14:59，
   所以这个判据不会提前把运行中的行情判成收盘。 */
function spdClosed(){
  return !!(SPD.rows.length && SPD.rows[0].t >= '15:00');
}

function spdPct(v){
  if (v == null || !isFinite(v)) return '-';
  // 一律两位：混着 0.15% 和 0.082% 排一列，眼睛没法比大小
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

/* 服务端给的 pv 是相对**今开**的百分比（0 = 今开）。但行情软件的 0 轴是**昨收**，
   两者在跳空日会彻底背离：588000 低开 4.6%，全天都在昨收下方运行，按今开算却是
   一路上扬 +2.2%——迷你线画出来像在涨，左边数字却是绿的，和分时图对照就是「对不上」。

   这里换算到昨收基准，让迷你线、涨跌幅、分时图三者同向。不需要额外请求：服务端
   给的最后一点 pv_last 对应现价 price，于是今开 = price / (1 + pv_last/100)，
   再套一遍就得到相对昨收的百分比。用快照的 price/prev 而不是 chg 字段，
   因为 chg 只有两位小数，低价品种会带来 0.01% 级别的抖动。 */
function toPrevBase(pv, price, prev){
  if (!pv || pv.length < 3 || !(price > 0) || !(prev > 0)) return pv;
  var lastPct = pv[pv.length - 1];
  if (!isFinite(lastPct)) return pv;
  var open = price / (1 + lastPct / 100);
  if (!(open > 0)) return pv;
  var k = open / prev, out = [], i;
  for (i = 0; i < pv.length; i++) out.push(+((k * (1 + pv[i] / 100) - 1) * 100).toFixed(2));
  return out;
}

/* 迷你线：横轴是当日 9:30 至今的完整分时，与「涨速」的窗口不是一回事，所以颜色
   按全天方向给、形状按全天给——「上午冲高、午后一路阴跌、最后两分钟拉起来」这种
   形态，只有拉长到全天才看得见。颜色硬编码是因为 SVG 的 stroke 属性不吃 CSS 变量
   （--up/--down 改主题时这里要跟着改）。

   纵向尺度是这一栏最容易画错的地方。原先每行按自己的 min/max 拉满，结果
   0.18% 的横盘和 0.45% 的急拉画出来一样高、一样陡——一列全是同形状的锯齿，
   看起来「比例很怪」，而且丢掉了「动得多不多」这个信息。
   现在：
   - 中线 = 昨收，虚线画出来当基准，和分时图的 0 轴是同一根线；
   - 全池共用一把尺子（spdScale），幅度按同一比例换算，行与行之间可比；
   - 超尺的顶到边，短的自然就矮——10 只里谁走得最远一眼能排出来。 */
function spdSpark(vals, up, sc){
  // vals 是相对昨收的百分比：0 就是昨收，中线画在那儿
  if (!vals || vals.length < 3) return '<span class="spk"></span>';
  var w = 88, h = 24, pad = 3, i;
  // sc 是全池统一幅度（百分比），缺省 0.8% 不至于把线画成一条直杠
  var rng = sc > 0 ? sc : 0.8;
  var mid = h / 2, half = mid - pad, d = '';
  for (i = 0; i < vals.length; i++){
    var x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    var y = mid - (vals[i] / rng) * half;
    if (y < pad) y = pad;
    if (y > h - pad) y = h - pad;
    d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  // 2px 虚线基准线：没有它，「线偏上还是偏下」就没有参照，读起来还是怪
  return '<svg class="spk" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<line x1="' + pad + '" y1="' + mid + '" x2="' + (w - pad) + '" y2="' + mid
    + '" stroke="#bfc8d4" stroke-width="1" stroke-dasharray="2.5 2.5"/>'
    + '<path d="' + d + '" fill="none" stroke="' + (up ? '#d93a3a' : '#0e9a61')
    + '" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

/* 全池共用一把纵向尺子：取每只「当日相对昨收最大偏离（%）」的 65 分位。
   0.15% 是下限（那种一根直线的心电图没必要占满），5% 是上限（有一只暴涨
   时不至于把其余 39 只全压成直线）。分位从 75 降到 65 是配合全天窗口调的：
   20 分钟窗口里大家的振幅都在 0.3%~0.5%，75 分位正好把线铺满；拉到全天之后
   振幅差得远（题材 ETF 3%、宽基 0.8%），75 分位会把大半的线压成矮墩墩一条，
   降到 65 让多数线用掉六七成高度，代价是四分之一的线会顶到框边——顶边本身
   也是信息（「这只今天动得比同类猛」）。

   上限从 3% 放到 5%：基准换成昨收之后，跳空日的幅度不再被今开吃掉，
   低开高走的那几只 max|pv| 能到 5%~7%，卡在 3% 会让一整列全顶边。 */
function spdScale(rows){
  var a = [], i, j, pv, m, dv;
  for (i = 0; i < rows.length; i++){
    pv = rows[i].pvn || rows[i].pv;
    if (!pv || pv.length < 3) continue;
    m = 0;
    for (j = 0; j < pv.length; j++){
      dv = Math.abs(pv[j]);
      if (dv > m) m = dv;
    }
    if (m > 0) a.push(m);
  }
  if (!a.length) return 0.8;
  a.sort(function(x, y){ return x - y; });
  var q = a[Math.min(a.length - 1, Math.floor(a.length * 0.65))];
  return Math.min(5, Math.max(0.3, q));
}

function renderSpeed(){
  var box = document.getElementById('spdGrid');
  var note = document.getElementById('spdNote');
  var nEl = document.getElementById('spdN');
  if (!box) return;

  if (SPD.err){
    box.innerHTML = '<div class="empty">' + SPD.err + '</div>';
    if (note) note.textContent = '';
    if (nEl) nEl.textContent = '';
    return;
  }
  if (!SPD.rows.length){
    box.innerHTML = '<div class="empty">还没有数据</div>';
    return;
  }

  var kR = SPD.w === 5 ? 'r5' : 'r3';
  var kQ = SPD.w === 5 ? 'q5' : 'q3';
  var up = [], dn = [], i, r, v, q;
  for (i = 0; i < SPD.rows.length; i++){
    r = SPD.rows[i];
    v = r[kR];
    if (v == null || !isFinite(v)) continue;
    q = r[kQ];
    if (SPD.volOnly && !(q >= SPD_VOL_HOT)) continue;
    (v >= 0 ? up : dn).push({ r: r, v: v, q: q });
  }
  up.sort(function(a, b){ return b.v - a.v; });
  dn.sort(function(a, b){ return a.v - b.v; });

  /* 先把 pv 从「相对今开」换算到「相对昨收」——迷你线和分时图的 0 轴必须是同一根，
     否则跳空日会出现「线在涨、数字在跌」。换算要用快照里的现价和昨收，缺任一只
     就退回今开基准（线照样能画，只是那一行的 0 轴和别的行不是一个意思）。 */
  var it0;
  for (i = 0; i < SPD.rows.length; i++){
    it0 = findItem(SPD.rows[i].c);
    SPD.rows[i].pvn = (it0 && it0.p > 0 && it0.pc > 0)
      ? toPrevBase(SPD.rows[i].pv, it0.p, it0.pc)
      : SPD.rows[i].pv;
  }

  // 尺子按整个池子算，不按这两栏算：左右两栏、切换 3/5 分钟都得同一把尺，
  // 否则「急涨第一名」和「急跌第一名」的波形幅度没法放在一起看
  var SC = spdScale(SPD.rows);

  function rowHtmlOf(o){
    var x = o.r, it = findItem(x.c);
    var nm = it ? it.n : x.c;
    var hot = o.q >= SPD_VOL_HOT;
    /* 线的颜色跟全天方向走（相对昨收），不跟 3 分钟涨速走：否则跳空低开的日子
       会出现「绿线一路向上」这种自相矛盾的图形。左边数字仍是涨速、仍按涨速
       配色——那才是这一栏排序的依据，「急跌但今天还涨着」本身就是有用的信息。 */
    var pvx = x.pvn || x.pv;
    var dayUp = pvx && pvx.length ? pvx[pvx.length - 1] >= 0 : true;
    // sp 和标称窗口差得多就标 ~：可能是数据缺口把基准推远了（尾盘 14:56
    // 直接跳 15:00，3 分钟实际跨了 4 分钟），也可能是午后刚开盘窗口还没走满
    var far = Math.abs(x.sp - SPD.w) >= 2;
    return '<div class="spdrow" data-c="' + x.c + '">'
      + '<div class="spdnm" title="' + nm + '  ' + x.c + '">'
        + '<span class="nmx">' + nm + '</span><em>' + x.c + '</em></div>'
      + spdSpark(pvx, dayUp, SC)
      + '<div class="spdv" style="color:' + (o.v >= 0 ? 'var(--up)' : 'var(--down)') + '">'
        + (far ? '~' : '') + spdPct(o.v) + '</div>'
      + '<div class="spdq' + (hot ? ' hot' : '') + '" title="量比：最近 ' + SPD.w
        + ' 分钟每分钟成交量 ÷ 此前 30 分钟每分钟成交量">'
        + (o.q > 0 ? o.q.toFixed(1) + '×' : '-') + '</div>'
      + '</div>';
  }

  function colHtmlOf(list, dir){
    var buf = [], n = Math.min(list.length, SPD_SHOW);
    for (var j = 0; j < n; j++) buf.push(rowHtmlOf(list[j]));
    if (!n) buf.push('<div class="spdnone">'
      + (SPD.volOnly ? '没有量比 ≥ ' + SPD_VOL_HOT + ' 倍的标的' : '暂无数据') + '</div>');
    return '<div class="spdcol">'
      + '<div class="spdch"><b class="' + (dir > 0 ? 'up' : 'dn') + '">'
      + (dir > 0 ? '急涨 ↑' : '急跌 ↓') + '</b><span>'
      + list.length + ' 只' + (list.length > n ? '，显示前 ' + n : '') + '</span></div>'
      + buf.join('') + '</div>';
  }

  box.innerHTML = colHtmlOf(up, 1) + colHtmlOf(dn, -1);

  // 数据时点用分时最后一根的时间，不用本地时钟：一个显示「刚刚」，另一个
  // 显示「15:00」，用户才知道这是不是实时的
  var t = SPD.rows[0].t || '';
  var when = SPD.ts ? new Date(SPD.ts) : null;
  var hhmm = when ? ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2) + ':'
    + ('0' + when.getSeconds()).slice(-2) : '-';
  if (nEl){
    // 手机上这一行会把「急涨急跌」标题挤到第二行，所以只留最要紧的两个数
    nEl.innerHTML = '有效 ' + SPD.rows.length + ' 只 · 数据时点 ' + t
      + '<span class="hide-sm"> · 扫描 ' + SPD.ask + ' 只 · 算于 ' + hhmm
      + (SPD.ms ? '（' + SPD.ms + 'ms）' : '') + '</span>';
  }
  if (note){
    // 「收盘了没有」按分时最后一根判断，不能复用 isOpen()——那个函数为了
    // 让收盘后的快照继续刷新，一直算到 16:10，拿它当收盘标志会晚一个多小时
    note.innerHTML = '池子 = 自选 + 当日成交额靠前的 ETF，同指数只留一只。'
      + '量比 = 最近 ' + SPD.w + ' 分钟每分钟量 ÷ 此前 30 分钟每分钟量，'
      + '到 <b>' + SPD_VOL_HOT + '×</b> 标黄。收盘集合竞价那根按 4 分钟折算，'
      + '否则尾盘会凭空多出十倍放量。'
      + '小走势线是<b>当日 9:30 至今</b>的分时，虚线是<b>昨收</b>，和分时图同一根 0 轴——'
      + '线在虚线上方就是全天还在涨，颜色也按这条线的方向给（数字仍是 ' + SPD.w + ' 分钟涨速，两者可以不同向）。'
      + (spdClosed() ? '<br>已收盘：这里是<b>今天最后几分钟</b>的涨速，明天 9:30 才重新走动。' : '');
  }
}

Array.prototype.forEach.call(document.querySelectorAll('#spdTabs .mtab[data-w]'), function(t){
  t.onclick = function(){
    var w = +t.getAttribute('data-w');
    if (w === SPD.w) return;
    SPD.w = w;
    Array.prototype.forEach.call(document.querySelectorAll('#spdTabs .mtab[data-w]'), function(x){
      x.classList.toggle('on', x === t);
    });
    renderSpeed();
  };
});
(function(){
  var vol = document.getElementById('spdVol');
  if (!vol) return;
  vol.onclick = function(){
    SPD.volOnly = !SPD.volOnly;
    vol.classList.toggle('on', SPD.volOnly);
    renderSpeed();
  };
})();
(function(){
  var b = document.getElementById('btnSpd');
  if (b) b.onclick = function(){ spdFetch(true); };
  var g = document.getElementById('spdGrid');
  if (g) g.addEventListener('click', function(e){
    var row = e.target.closest ? e.target.closest('.spdrow[data-c]') : null;
    if (!row) return;
    var c = row.getAttribute('data-c');
    var it = findItem(c);
    openHist(c, it ? it.n : c);
  });
})();

/* ================= 历史 K 线面板 =================
   数据来自 R2 上的精简二进制（近 500 天 × 17 字段），Worker 只做透传。
   为什么不在 Worker 里解 Parquet：单只 2.27MB / 165 列，光 zstd 解压
   就要几百毫秒，免费版只有 10ms CPU。所以解析全部放在这里。

   画图用原生 canvas，不引图表库——一个 K 线面板带 3 个子图，
   引库要多 100KB+，还得跟着库的版本走。 */

var HC = {
  up:'#d93a3a', dn:'#0e9a61', ma20:'#d68910', ma60:'#4c8dff',
  grid:'#e9ecf1', axis:'#939aa7', cross:'#8b93a1', vol:'#dfe4ec', rsi:'#7c5cd6',
  boll:'#98a3b5'
};

var H = {
  code:'', name:'', d:null, range:250, hover:-1, ok:false,
  sub:'rsi', ov:{ ma:true, boll:false },
  cv:null, ctx:null, off:null, octx:null,
  W:0, Ht:0, dpr:1, geo:null,
  mode:'min', m:null, mgeo:null, holdAll:false, hj:null
};
/* 默认分时：点开一只标的，第一反应是「今天怎么了」，而不是「过去一年怎么样」。
   用户手动切过就记住——K 线是深度分析时才会进的门。 */
try {
  var _hmode = localStorage.getItem('etf_hmode');
  if (_hmode === 'k' || _hmode === 'min' || _hmode === 'hold') H.mode = _hmode;
} catch (e) { /* 隐私模式下 localStorage 会抛 */ }

/* TypedArray 要求 byteOffset 是元素大小的整数倍，而 JSON header 长度不固定。
   新版本写入时补过 4 字节对齐，旧文件没有——这里两条路都走。
   未对齐时 slice 一段出来：slice 返回的 ArrayBuffer 从 0 起，偏移归零。 */
function hView(buf, base, n, Type){
  if (base % 4 === 0) return new Type(buf, base, n);
  return new Type(buf.slice(base, base + n * 4), 0, n);
}

function parseHist(buf){
  var v = new DataView(buf);
  if (v.getUint32(0, false) !== 0x45544831) throw new Error('不是 ETH1 格式');
  var hl = v.getUint32(4, true);
  var hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  var n = hdr.n, cols = hdr.cols, base = 8 + hl;
  var dates = hView(buf, base, n, Int32Array);
  base += 4 * n;
  var col = {};
  for (var i = 0; i < cols.length; i++){
    col[cols[i]] = hView(buf, base, n, Float32Array);
    base += 4 * n;
  }
  return { code:hdr.code, n:n, dates:dates, col:col };
}

function fnum(v, d){
  if (v == null || !isFinite(v)) return '-';
  return Number(v).toFixed(d == null ? 3 : d);
}

/* ================= 当日补丁：把今天接成最后一根 K 线 =================
   .bin 由 Actions 每天 16:35 生成，盘中打开时最后一根永远是昨天——
   盯盘最需要看的「今天」反而没有，副图指标也停在昨天。
   这里把实时快照接成最后一根，指标从完整序列重算到该点。

   算法必须与 alpha/indicators.py 严格对齐，否则接出来的今天会和
   明天 Actions 跑完的值对不上，图上看起来就是最后一根莫名跳一下：
     · EMA：pandas ewm(adjust=False)，alpha = 2/(n+1)，首个有效值即起点
     · RSI / ATR：Wilder 平滑，alpha = 1/n
     · 布林带：样本标准差（ddof=1），与 pandas rolling.std() 默认一致
     · 均线/量比/波动率：rolling 窗口，min_periods = 窗口长度
*/

function hMeanEnd(a, end, n){
  var from = end - n + 1;
  if (from < 0) return NaN;
  var s = 0;
  for (var i = from; i <= end; i++){
    if (!isFinite(a[i])) return NaN;   // min_periods=n：窗口内有一个 NaN 就整体 NaN
    s += a[i];
  }
  return s / n;
}

function hStdEnd(a, end, n){
  var m = hMeanEnd(a, end, n);
  if (!isFinite(m)) return NaN;
  var s = 0, from = end - n + 1;
  for (var i = from; i <= end; i++){ var d = a[i] - m; s += d * d; }
  return Math.sqrt(s / (n - 1));
}

/* adjust=False 的 EMA 全序列。NaN 位置沿用前值，与 pandas 行为一致。 */
function hEmaArr(a, n){
  var al = 2 / (n + 1), e = NaN, out = new Float64Array(a.length);
  for (var i = 0; i < a.length; i++){
    var v = a[i];
    if (isFinite(v)) e = isFinite(e) ? al * v + (1 - al) * e : v;
    out[i] = e;
  }
  return out;
}

/* Wilder 平滑的末值（alpha = 1/n）。RSI 的 up/dn 两路、ATR 的 TR 都用它。 */
function hWilderLast(a, n){
  var al = 1 / n, e = NaN;
  for (var i = 0; i < a.length; i++){
    var v = a[i];
    if (!isFinite(v)) continue;
    e = isFinite(e) ? al * v + (1 - al) * e : v;
  }
  return e;
}

function hCalcLast(d, it){
  var n = d.n, N = n + 1, i, p = it.p;
  var C = new Float64Array(N), Hh = new Float64Array(N),
      Ll = new Float64Array(N), V = new Float64Array(N);
  for (i = 0; i < n; i++){
    C[i] = d.col.close[i]; Hh[i] = d.col.high[i];
    Ll[i] = d.col.low[i];  V[i] = d.col.volume[i];
  }
  C[n] = p;
  Hh[n] = (it.hi > 0) ? it.hi : p;
  Ll[n] = (it.lo > 0) ? it.lo : p;

  /* 成交额/均价近似成交量。东财的 f5 是「手」、新浪的 volume 是「份」，
     两个源单位不一致，直接用会让柱子差 100 倍；成交额两边都是元，
     除一个当日均价就统一到「份」，误差 0.2% 以内。 */
  var vwap = (it.hi > 0 && it.lo > 0) ? (it.hi + it.lo + p) / 3 : p;
  V[n] = (it.amt > 0 && vwap > 0) ? it.amt / vwap : NaN;

  var row = {
    open: (it.op > 0) ? it.op : p, high: Hh[n], low: Ll[n], close: p,
    volume: V[n], amount: it.amt, adj_ratio: 1,
  };

  row.ma20 = hMeanEnd(C, n, 20);
  row.ma60 = hMeanEnd(C, n, 60);

  var sd = hStdEnd(C, n, 20);
  row.boll_up = isFinite(sd) ? row.ma20 + 2 * sd : NaN;
  row.boll_low = isFinite(sd) ? row.ma20 - 2 * sd : NaN;

  // RSI14：pandas 的 diff 首行是 NaN，所以从 1 开始
  var up = new Float64Array(N), dn = new Float64Array(N);
  for (i = 1; i < N; i++){
    var df = C[i] - C[i - 1];
    up[i] = df > 0 ? df : 0;
    dn[i] = df < 0 ? -df : 0;
  }
  var au = hWilderLast(up, 14), ad = hWilderLast(dn, 14);
  row.rsi14 = (au + ad > 0) ? 100 * au / (au + ad) : NaN;

  // MACD：DIF = EMA12 − EMA26，DEA = EMA9(DIF)，柱 = 2×(DIF−DEA)（国内惯例）
  var e12 = hEmaArr(C, 12), e26 = hEmaArr(C, 26);
  var dif = new Float64Array(N);
  for (i = 0; i < N; i++) dif[i] = e12[i] - e26[i];
  var dea = hEmaArr(dif, 9);
  row.macd_dif = dif[n];
  row.macd_dea = dea[n];

  // ATR14
  var tr = new Float64Array(N);
  for (i = 0; i < N; i++){
    tr[i] = Hh[i] - Ll[i];
    if (i > 0 && isFinite(C[i - 1])){
      var d1 = Math.abs(Hh[i] - C[i - 1]), d2 = Math.abs(Ll[i] - C[i - 1]);
      if (d1 > tr[i]) tr[i] = d1;
      if (d2 > tr[i]) tr[i] = d2;
    }
  }
  row.atr14 = hWilderLast(tr, 14);

  // 年化历史波动率（%）
  var r = new Float64Array(N);
  for (i = 1; i < N; i++) r[i] = (C[i - 1] > 0) ? C[i] / C[i - 1] - 1 : NaN;
  var rsd = hStdEnd(r, n, 20);
  row.hvol20 = isFinite(rsd) ? 100 * rsd * Math.sqrt(244) : NaN;

  var vm = hMeanEnd(V, n, 5);
  row.vol_ratio5 = (isFinite(vm) && vm > 0) ? V[n] / vm : NaN;

  return row;
}

function hYmd(dt){
  return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
}

function hDayDiff(a, b){
  var da = Date.UTC(Math.floor(a / 10000), Math.floor(a / 100) % 100 - 1, a % 100);
  var db = Date.UTC(Math.floor(b / 10000), Math.floor(b / 100) % 100 - 1, b % 100);
  return Math.round((db - da) / 86400000);
}

function hPatchToday(d, it){
  if (!d || !d.n) return null;
  var dt = new Date(), today = hYmd(dt);
  var last = d.dates[d.n - 1];
  if (today <= last) return null;                     // 历史里已经有今天
  if (!it || !(it.p > 0) || !(it.amt > 0)) return null; // 未开盘 / 停牌 / 休市
  var dow = dt.getDay();
  if (dow === 0 || dow === 6) return null;            // 周末兜底（休市时成交额为 0 已挡住）
  if (hDayDiff(last, today) > 10) return null;        // 数据太久没更新，硬接会留下大段空洞

  var row = hCalcLast(d, it);
  var n = d.n + 1, k;
  var dates = new Int32Array(n);
  dates.set(d.dates, 0);
  dates[n - 1] = today;

  var col = {};
  for (k in d.col){
    var src = d.col[k], a = new Float32Array(n);
    a.set(src, 0);
    var v = row[k];
    a[n - 1] = (v != null && isFinite(v)) ? v : NaN;
    col[k] = a;
  }
  return { code: d.code, n: n, dates: dates, col: col, ext: 1 };
}

/* 今日那根的说明文案。刷新节奏写进文案里，免得看的人猜它到底会不会动。 */
function hExtNote(){
  return '最后一根为今日行情（交易时段每 60 秒跟随最新快照重算），'
    + '技术指标已按今日价格重算。';
}

/* 弹窗打开期间跟随行情刷新
   ---------------------------------------------------------------
   原来只在 openHist 里补一次今天，页面每 60 秒刷的是列表和卡片，
   弹窗里那根 K 线就停在打开那一刻——文案却写着「会随实时价跳动」。
   这里基于 H.raw（打开时取到的原始历史）重算，所以刷多少次都只有一根今天：
   每次都是从同一份 500 根重来，不会累积成 502、503 根。

   快照暂时补不上时（东财限流导致缺成交额、或停牌）保持原图不动——
   宁可显示上一次的值，也不要让已经画上的今天忽隐忽现。 */
function hRefresh(){
  var mask = document.getElementById('histMask');
  if (!mask || !mask.classList.contains('on')) return;   // 弹窗没开，白算
  if (!H.raw || !H.code || !H.ok) return;

  var it = findItem(H.code);
  if (!it || !(it.p > 0)) return;

  var ext = hPatchToday(H.raw, it);
  if (!ext && H.ext) return;          // 这一轮补不上，保留上一轮的今日 K 线
  H.d = ext || H.raw;
  H.ext = !!ext;

  var px = document.getElementById('hPx');
  if (px) px.textContent = fnum(it.p, 3);
  var ch = document.getElementById('hChg');
  if (ch){ ch.textContent = fpc(it.chg); ch.className = 'ch ' + cc(it.chg); }

  hDraw();
  hLegend(H.hover);
  var note = hAdjNote();
  if (ext) note = (note ? note + ' ' : '') + hExtNote();
  document.getElementById('hNote').textContent = note;
}

/* 分时 / K线 / 成分 切换。force=true 表示「模式没变也要重新加载」——
   新点开一只标的时必须走这条路，否则会因为模式相同而什么都不做，图停在上一只。 */
var holdTimer = null;
function setHMode(m, force){
  m = (m === 'k' || m === 'hold') ? m : 'min';
  if (!force && H.mode === m) return;
  H.mode = m;
  try { localStorage.setItem('etf_hmode', m); } catch (e) {}
  Array.prototype.forEach.call(document.querySelectorAll('#hMode b'), function(b){
    b.classList.toggle('on', b.getAttribute('data-m') === m);
  });
  var isK = m === 'k', isMin = m === 'min', isHold = m === 'hold';
  // 副图/叠加/周期条只对 K 线有意义，分时和成分都没有它们
  document.getElementById('hSbar').style.display = isK ? '' : 'none';
  document.getElementById('hTabs').style.display = isK ? '' : 'none';
  // 画布与它下面那几块（图例/指标卡/备注）在成分档整体让位给表格
  document.getElementById('histCv').style.display = isHold ? 'none' : '';
  document.getElementById('hLeg').style.display = isHold ? 'none' : '';
  document.getElementById('hInd').style.display = isHold ? 'none' : '';
  document.getElementById('hNote').style.display = isHold ? 'none' : '';
  document.getElementById('hHold').classList.toggle('on', isHold);
  clearInterval(minTimer); minTimer = null;
  clearInterval(holdTimer); holdTimer = null;
  H.hover = -1;
  if (!H.code) return;
  if (isHold){
    loadHold(H.code, false);
    // 30 秒一轮：上游行情按 30 秒分桶缓存，更密的轮询只会反复命中同一个桶
    holdTimer = setInterval(function(){
      if (H.code && H.mode === 'hold'
          && document.getElementById('histMask').classList.contains('on')) {
        loadHold(H.code, true);
      }
    }, 30000);
    return;
  }
  if (isMin){
    loadMin(H.code);
    // 35 秒一轮：接口按 30 秒分桶缓存，更密的轮询只会反复命中同一个桶
    minTimer = setInterval(function(){
      if (H.code && H.mode === 'min'
          && document.getElementById('histMask').classList.contains('on')) {
        fetchMinOnce(H.code, false);
      }
    }, 35000);
  } else {
    loadK(H.code);
  }
}

/* ================= 成分穿透 =================
   「ETF 涨了 0.4%，是哪几只票拉的？」——只有涨跌幅回答不了，得拆到底层。

   /api/hold 给的是季报口径的前 N 大（宽基 40 只上下、行业 20 只、跨境 10 只），
   带权重和实时涨跌。这里只做三件事：按贡献排序、画双向条、把「前 N 大能解释
   多少 / 剩下的怎么解释」分开写清。不画图：这一栏的价值在排序，不在形态。

   权重 × 涨跌 = 贡献（百分点）。ETF 的涨跌幅近似等于所有成分贡献之和，
   差额来自没披露的仓位、现金、折溢价——所以「其余仓位」那是一个残差，
   不是算错。
*/
function fpt(v){
  if (v == null || !isFinite(v)) return '-';
  // |v| < 0.005 会被 toFixed(2) 写成 -0.00，正负号在这儿没有意义，按 0 处理
  var x = Math.abs(v) < 0.005 ? 0 : v;
  return (x > 0 ? '+' : '') + x.toFixed(2);
}

function loadHold(code, silent){
  var box = document.getElementById('hHoldBody');
  if (!box) return;
  var slow = null;
  if (!silent){
    document.getElementById('hHoldHd').innerHTML = '';
    box.innerHTML = '<div class="hempty">读取成分…</div>';
    /* 盘前只预热了每个指数里成交额最大的那只，其余要现场抓交易所清单（3–6 秒）。
       超过两秒还没回来就换个说法，免得看着像卡死。 */
    slow = setTimeout(function(){
      if (H.code !== code || H.mode !== 'hold') return;
      var e = box.querySelector('.hempty');
      if (e) e.textContent = '这只不是同指数的龙头，成分要现场抓取，约 3–6 秒…';
    }, 2000);
  }
  fetch('/api/hold?code=' + code).then(function(r){ return r.json(); }).then(function(j){
    clearTimeout(slow);
    if (H.code !== code || H.mode !== 'hold') return;   // 用户已经切走了
    if (!j || !j.ok){
      box.innerHTML = '<div class="hempty">' + esc((j && j.error) || '读取失败') + '</div>';
      return;
    }
    H.hj = j;
    renderHold(j);
  }).catch(function(e){
    clearTimeout(slow);
    if (H.code !== code || H.mode !== 'hold') return;
    box.innerHTML = '<div class="hempty">网络错误：' + esc(e.message || String(e)) + '</div>';
  });
}

function renderHold(j){
  var hd = document.getElementById('hHoldHd');
  var box = document.getElementById('hHoldBody');
  /* 两个口径的持仓不是一回事，界面必须分开写：
       src=pcf    → 交易所当日申购赎回清单，**全部**成分，权重合计 100%；
       src=report → 基金季报只披露前十大，权重合计二十几个点，剩下全是「其余」。
     混着写会出现「前 20 大 26%」这种在 PCF 下永远不可能的数字，用户会以为算错。 */
  var isPcf = j.src === 'pcf';

  /* 一律按权重从大到小。权重 0.00% 的条目不进表——贡献恒为 0，只占行高。

     行数分两档：默认只列权重前 20，脚注写清还剩多少只、占多少权重，想看全量
     就点一下「展开全部」。PCF 是全量清单，中证500 那只有 500 个成分，一上来就
     铺 500 行等于把「这只 ETF 押在哪」埋进几十屏的滚动里——20 行刚好一屏，
     权重排序下前几只就是这只 ETF 的仓位骨架。展开后仍然是同一份数据，不重新请求。 */
  var all = (j.rows || []).filter(function(x){ return x.w >= 0.005; })
    .sort(function(a, b){ return b.w - a.w; });
  var lim = Math.min(H.holdAll ? all.length : 20, all.length);
  var rows = all.slice(0, lim);
  var cut = all.length - rows.length;
  var cutW = 0;
  for (var q0 = rows.length; q0 < all.length; q0++) cutW += all[q0].w;
  var it = findItem(H.code);
  var ec = (it && isFinite(it.chg)) ? it.chg : null;

  /* 按权重从大到小：这一栏回答的是「持仓长什么样」，先看谁占得重。
     原来按贡献（权重×涨跌）排，涨得多的中小权重会挤到茅台前面，翻半天找不到
     「这只 ETF 到底押在哪」；贡献有颜色条和数值，谁在拉谁在砸扫一眼就看得到，
     不需要靠排序来回答。 */
  rows.sort(function(a, b){ return b.w - a.w; });

  var sum = 0, got = 0, mx = 0, wsum = 0, i, r;
  for (i = 0; i < rows.length; i++){
    r = rows[i];
    wsum += r.w;
    if (r.ctr == null) continue;
    sum += r.ctr; got++;
    if (Math.abs(r.ctr) > mx) mx = Math.abs(r.ctr);
  }

  // 注意这里是模板字符串：正则里的反斜杠要写两个，写成 \\d 会被当成 d
  var dayTxt = (j.asof || '-').replace(/^(\\\\d{4})(\\\\d{2})(\\\\d{2})$/, '$2-$3');
  if (isPcf){
    /* miss = 清单里有、但行情没取到的只数（退市、停牌无昨收、代码换过）。
       这些不进行，权重就按剩下的归一化到 100%——数字看着正常，其实分母缩了。
       所以「全部 N 只 · 权重合计 100%」这句话只在 miss=0 时成立，有缺就把缺的
       只数写出来，别让人拿一张静默缩过水的表当全量。 */
    var missN = j.miss || 0;
    hd.innerHTML = '<span>清单 <b>' + (j.total || all.length + missN) + '</b> 只'
      + (missN > 0 ? ' · <b>' + missN + '</b> 只无行情（权重按其余归一化）' : '')
      + ' · 权重合计 <b>100%</b>'
      + ' · 交易所 PCF <b>' + esc(dayTxt) + '</b>'
      + (cut > 0 ? ' · 列出权重前 <b>' + rows.length + '</b>（可展开）' : '')
      // 展开后表头给一个「收起」：几百行滚到底才能收，太远了
      + (H.holdAll ? ' · <i class="hcollapse" data-holdm="0">收起</i>' : '')
      + '</span><span>权重 = 股数 × 昨收归一化 · 贡献 = 权重 × 今日涨跌（百分点）</span>';
  } else {
    hd.innerHTML = '<span>前 <b>' + rows.length + '</b> 大 · 权重合计 <b>'
      + wsum.toFixed(1) + '%</b> · 季报 <b>' + esc(dayTxt) + '</b>'
      + (got < rows.length ? ' · <b>' + (rows.length - got) + '</b> 只无行情' : '')
      + '</span><span>贡献 = 权重 × 今日涨跌，单位百分点</span>';
  }

  var buf = [];
  for (i = 0; i < rows.length; i++){
    r = rows[i];
    var wpc = (r.ctr == null || !mx || Math.abs(r.ctr) < 0.005) ? 0 : Math.abs(r.ctr) / mx * 50;
    var bar = '';
    if (wpc > 0){
      bar = r.ctr > 0
        ? '<u style="left:50%;width:' + wpc.toFixed(1) + '%;background:#d93a3a"></u>'
        : '<u style="right:50%;width:' + wpc.toFixed(1) + '%;background:#0e9a61"></u>';
    }
    buf.push('<div class="hhrow" data-s="' + esc(r.c) + '" title="' + esc(r.n) + ' ' + r.c
      + '　权重 ' + r.w.toFixed(2) + '%，今日 ' + (r.chg == null ? '-' : fpc(r.chg))
      + '，贡献 ' + fpt(r.ctr) + ' 个百分点">'
      + '<span class="hhnm">' + esc(r.n) + '<em>' + esc(r.c) + '</em></span>'
      + '<span class="hhw">' + r.w.toFixed(2) + '%</span>'
      + '<span class="hhc ' + cc(r.chg) + '">' + (r.chg == null ? '-' : fpc(r.chg)) + '</span>'
      + '<span class="hhbar">' + bar + '</span>'
      + '<span class="hhctr ' + cc(Math.abs(r.ctr || 0) < 0.005 ? 0 : r.ctr) + '">'
      + fpt(r.ctr) + '</span>'
      + '</div>');
  }

  var foot = '';
  if (!got){
    // 持仓拿到了、行情一条都没回来：说清是上游的问题，别让人以为持仓是空的
    foot = '<div class="hhfoot"><span class="k">成分行情暂时没拿到（上游偶发空响应），'
      + '30 秒后自动重试</span></div>';
  }
  // 「合计贡献」只统计列出来的行，所以标签跟着行数走：展开前是「前 20 只」，
  // 展开后是「全部 N 只」——同一个数字配上两种口径的标签，才会被读成算错
  foot += '<div class="hhfoot"><span class="k">'
    + (H.holdAll ? '全部 ' + got + ' 只合计贡献'
      : (cut > 0 ? '列出 ' + got + ' 只合计贡献' : '前 ' + got + ' 只合计贡献')) + '</span>'
    + '<span><b class="' + cc(sum) + '">' + (got ? fpt(sum) : '-') + '</b></span>';
  // 一条行情都没有时不谈残差：那时 sum=0，「其余仓位 +3.50%」等于把 ETF 涨幅
  // 整个算到未披露仓位上，纯属瞎猜
  if (ec != null && got){
    foot += '<span class="k">ETF 今日</span><span><b class="' + cc(ec) + '">' + fpc(ec) + '</b></span>';
    if (!isPcf || cut > 0){
      foot += '<span class="k">' + (isPcf
        ? '其余 ' + cut + ' 只（权重 ' + cutW.toFixed(1) + '%）约'
        : '其余 ' + Math.max(0, 100 - wsum).toFixed(1) + '% 仓位（未披露持仓 / 现金 / 折溢价）约')
        + '</span>'
        + '<span><b class="' + cc(ec - sum) + '">' + fpt(ec - sum) + '</b></span>';
    }
  }
  foot += '</div>';

  var note;
  if (isPcf){
    note = '<div class="hhnote">权重由交易所申购赎回清单（PCF）的股数 × 昨收归一化算得，'
      + '每日开盘前更新，覆盖全部成分——所以「前 N 大合计贡献」加上「其余部分」'
      + '就约等于 ETF 今日涨跌，差额来自现金差额和折溢价（折溢价收敛几个 bp 很正常）。'
      + '跨境 ETF 的成分是当地市场的涨跌（港币 / 美元计价），与 A 股不同步，'
      + '白天看纳指 ETF 时成分股涨跌反映的是昨夜美股。'
      + (cut > 0 ? '另有 ' + cut + ' 只权重最小的没列出来，合计占 ' + cutW.toFixed(1) + '%。' : '')
      + '</div>';
  } else {
    note = '<div class="hhnote">权重取自基金季报（持仓截止 ' + esc(dayTxt)
      + '），只披露前十大，所以「其余仓位」是一个残差——'
      + '里面既有没披露的持仓，也有现金拖累和折溢价，不要当成某一只票的涨跌。'
      + (j.pcfErr ? '（交易所 PCF 本次取不到：' + esc(j.pcfErr) + '）' : '')
      + (cut > 0 ? '另有 ' + cut + ' 只权重不足 0.1%，没列出来。' : '') + '</div>';
  }

  /* 展开/收起按钮。渲染完 20 行之后还剩多少只、占多少权重都写在按钮上——
     「展开」两个字不说清代价，点下去才发现在一屏几百行里找不着北。 */
  var more = '';
  if (cut > 0){
    more = '<div class="hhmore"><b data-holdm="1">展开全部 ' + all.length + ' 只'
      + '（还有 ' + cut + ' 只 · 合计权重 ' + cutW.toFixed(1) + '%）</b></div>';
  } else if (H.holdAll && all.length > 20){
    more = '<div class="hhmore"><b data-holdm="0">收起，只看权重前 20</b></div>';
  }

  // 脚注排在合计行之前：合计是 sticky 吸底的，放在最后才不会被脚注顶开
  box.innerHTML = buf.join('') + more + note + foot;
}

function openHist(code, name){
  H.code = code; H.name = name || code;
  H.d = null; H.m = null; H.hover = -1; H.ok = false; H.ext = false;
  // 展开状态跟着标的走：换一只就回到 20 行，否则上一只的「展开」会让人以为
  // 这一只的权重结构也是几百行
  H.holdAll = false;
  document.getElementById('hName').textContent = H.name;
  document.getElementById('hCode').textContent = code;
  document.getElementById('hPx').textContent = '-';
  document.getElementById('hChg').textContent = '';
  document.getElementById('hLeg').innerHTML = '';
  document.getElementById('hInd').innerHTML = '';
  document.getElementById('hNote').textContent = '';
  // 上一只的成分表先清掉：不清的话切到分时的瞬间还能看到它
  document.getElementById('hHoldBody').innerHTML = '';
  document.getElementById('hHoldHd').innerHTML = '';
  document.getElementById('histMask').classList.add('on');

  var x = findItem(code);
  if (x){
    document.getElementById('hPx').textContent = fnum(x.p, 3);
    var ch = document.getElementById('hChg');
    ch.textContent = fpc(x.chg);
    ch.className = 'ch ' + cc(x.chg);
  }
  hSize();
  setHMode(H.mode, true);
}

function loadK(code){
  document.getElementById('hLeg').innerHTML = '<span>加载中…</span>';
  document.getElementById('hInd').innerHTML = '';
  document.getElementById('hNote').textContent = '';

  fetch('/api/hist?code=' + code).then(function(r){
    var ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('json') >= 0) return r.json().then(function(j){ throw new Error(j.error || '读取失败'); });
    return r.arrayBuffer();
  }).then(function(buf){
    if (H.code !== code) return;          // 加载期间用户已经换了标的
    var raw = parseHist(buf);

    function finish(it){
      if (H.code !== code) return;
      // 存下原始历史：定时刷新要基于这同一份重算，否则每刷一次就多接一根今天
      H.raw = raw;
      // 历史里没有今天就把实时快照接上去，盘中也能看到当天走势
      var ext = hPatchToday(raw, it);
      H.d = ext || raw;
      H.ext = !!ext;
      H.ok = true;
      hDraw();
      hLegend(-1);
      var note = hAdjNote();
      if (ext){
        note = (note ? note + ' ' : '') + hExtNote();
      }
      document.getElementById('hNote').textContent = note;
    }

    /* 全市场快照里找不到这只、或者拿到的快照没有高低价/成交额（东财限流时
       会只回一半标的），就单独问一次 /api/quote——单只接口走的是另一条通道，
       命中率高得多。拿不到就按原样画，不因为一个补丁把整张图卡住。 */
    var it = findItem(code);
    if (it && it.amt > 0 && it.hi > 0){ finish(it); return; }

    fetch('/api/quote?codes=' + encodeURIComponent(code))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (H.code !== code) return;
        var x = (j && j.ok && j.raw && j.raw[0]) ? j.raw[0] : null;
        var p = x ? +x.f2 : 0;
        finish(p > 0 ? {
          p: p, hi: +x.f15 || 0, lo: +x.f16 || 0, op: +x.f17 || 0, amt: +x.f6 || 0,
        } : it);
      })
      .catch(function(){ finish(it); });
  }).catch(function(e){
    if (H.code !== code) return;
    var msg = e.message || String(e);
    var hint = /NO_HIST|未配置/.test(msg)
      ? '历史数据未启用：Worker 没有绑定 R2，也没有设置 <code>HIST_BASE</code>。'
      : /NOT_FOUND|无此标的/.test(msg)
        ? '历史数据还没生成。去 GitHub Actions 手动跑一次「更新 ETF 数据」，'
          + '跑完会自动推到 <code>data</code> 分支。'
        : msg;
    document.getElementById('hLeg').innerHTML = '';
    document.getElementById('hNote').innerHTML = hint;
    var g = H.cv.getContext('2d');
    g.setTransform(1,0,0,1,0,0);
    g.clearRect(0, 0, H.cv.width, H.cv.height);
  });
}

function closeHist(){
  document.getElementById('histMask').classList.remove('on');
  clearInterval(minTimer); minTimer = null;
  clearInterval(holdTimer); holdTimer = null;
  H.code = ''; H.d = null; H.m = null;
}

function findItem(code){
  for (var i = 0; i < DATA.length; i++) if (DATA[i].c === code) return DATA[i];
  return LIVE[code] || null;
}

function hSize(){
  var cv = document.getElementById('histCv');
  if (!cv) return;
  var dpr = window.devicePixelRatio || 1;
  var W = cv.clientWidth || 900, Ht = cv.clientHeight || 460;
  H.cv = cv; H.dpr = dpr; H.W = W; H.Ht = Ht;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(Ht * dpr)){
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(Ht * dpr);
  }
  H.ctx = cv.getContext('2d');
  H.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!H.off){ H.off = document.createElement('canvas'); }
  if (H.off.width !== cv.width || H.off.height !== cv.height){
    H.off.width = cv.width; H.off.height = cv.height;
  }
  H.octx = H.off.getContext('2d');
  H.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* 折线：遇 NaN 必须断线，否则停牌日的缺口会被连成一条直穿过去的线 */
function hLine(ctx, arr, i0, n, xOf, yFn, color, lw){
  ctx.strokeStyle = color; ctx.lineWidth = lw || 1.3; ctx.beginPath();
  var started = false;
  for (var j = i0; j < n; j++){
    if (!isFinite(arr[j])){ started = false; continue; }
    var X = xOf(j), Y = yFn(arr[j]);
    if (!started){ ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
  }
  ctx.stroke();
}

/* 副图定义表。有的指标必须固定量程才读得出来（RSI 的 30/70、%B 的 0~100），
   有的必须跟着数据自适应（ATR 的绝对值在 0.02~2 之间都有，固定量程等于没画）。 */
var SUB_DEF = {
  rsi:  { nm:'RSI14',  col:'#7c5cd6', fixed:[0,100], refs:[30,70],
          arr:function(c){ return c.rsi14; }, fmt:function(v){ return v.toFixed(0); } },
  vr:   { nm:'量比5',  col:'#d68910', refs:[1],
          arr:function(c){ return c.vol_ratio5; }, fmt:function(v){ return v.toFixed(2); } },
  hvol: { nm:'波动率', col:'#4c8dff',
          arr:function(c){ return c.hvol20; }, fmt:function(v){ return v.toFixed(1) + '%'; } },
  atr:  { nm:'ATR14',  col:'#0e9a61',
          arr:function(c){ return c.atr14; }, fmt:function(v){ return v.toFixed(3); } },
  pb:   { nm:'BOLL%B', col:'#d68910', fixed:[0,100], refs:[0,50,100], arr:null,
          fmt:function(v){ return v.toFixed(0); } }
};

/* %B 不在二进制里，用 (收盘-下轨)/(上轨-下轨) 现算，比单独存一列省 4 字节/天 */
function pbArr(c){
  var n = c.close.length, a = new Float32Array(n);
  var bu = c.boll_up, bl = c.boll_low, cl = c.close;
  for (var i = 0; i < n; i++){
    a[i] = (isFinite(bu[i]) && isFinite(bl[i]) && bu[i] > bl[i])
      ? (cl[i] - bl[i]) / (bu[i] - bl[i]) * 100 : NaN;
  }
  return a;
}

function drawSub(ctx, c, i0, n, xOf, padL, plotW, yR, hR){
  var kind = H.sub || 'rsi';
  ctx.font = '9px ui-monospace,Menlo,monospace';
  ctx.lineWidth = 1;

  /* MACD 是双线加柱，量程必须以 0 为轴左右对称，否则金叉死叉看着像在同一个位置 */
  if (kind === 'macd'){
    var dif = c.macd_dif, dea = c.macd_dea, i, mx = 1e-9;
    for (i = i0; i < n; i++){
      if (isFinite(dif[i]) && Math.abs(dif[i]) > mx) mx = Math.abs(dif[i]);
      if (isFinite(dea[i]) && Math.abs(dea[i]) > mx) mx = Math.abs(dea[i]);
      if (isFinite(dif[i]) && isFinite(dea[i]) && Math.abs(dif[i] - dea[i]) > mx) mx = Math.abs(dif[i] - dea[i]);
    }
    mx *= 1.12;
    var y0 = yR + hR / 2;
    var yM = function(v){ return y0 - (v / mx) * (hR / 2); };

    ctx.strokeStyle = '#c9d2e0'; ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y0) + 0.5);
    ctx.lineTo(padL + plotW, Math.round(y0) + 0.5); ctx.stroke();
    ctx.setLineDash([]);

    var bw = Math.max(1, plotW / (n - i0) * 0.6);
    for (i = i0; i < n; i++){
      if (!isFinite(dif[i]) || !isFinite(dea[i])) continue;
      var hv = dif[i] - dea[i], X = xOf(i);
      ctx.fillStyle = hv >= 0 ? 'rgba(217,58,58,.6)' : 'rgba(14,154,97,.6)';
      ctx.fillRect(X - bw / 2, Math.min(yM(hv), y0), bw, Math.max(1, Math.abs(yM(hv) - y0)));
    }
    hLine(ctx, dif, i0, n, xOf, yM, '#d68910', 1.1);
    hLine(ctx, dea, i0, n, xOf, yM, '#4c8dff', 1.1);

    ctx.fillStyle = HC.axis; ctx.textAlign = 'left';
    ctx.textBaseline = 'top'; ctx.fillText(mx.toFixed(2), padL + plotW + 5, yR + 1);
    ctx.textBaseline = 'bottom'; ctx.fillText('-' + mx.toFixed(2), padL + plotW + 5, yR + hR);
    subName(ctx, 'MACD', padL, yR, '#6b7380');
    return;
  }

  var def = SUB_DEF[kind] || SUB_DEF.rsi;
  var arr = (kind === 'pb') ? pbArr(c) : def.arr(c);
  var lo, hi, i, v;
  if (def.fixed){
    lo = def.fixed[0]; hi = def.fixed[1];
  } else {
    lo = Infinity; hi = -Infinity;
    for (i = i0; i < n; i++){
      v = arr[i];
      if (isFinite(v)){ if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!isFinite(lo)){ lo = 0; hi = 1; }
    // 量比、ATR 这类正数指标从 0 起画才看得出「放大了几倍」
    if (lo > 0) lo = 0;
    if (hi <= lo) hi = lo + 1;
    hi += (hi - lo) * 0.12;
  }
  var yS = function(v){ return yR + hR * (hi - v) / (hi - lo); };

  if (def.refs){
    ctx.strokeStyle = '#c9d2e0'; ctx.setLineDash([3,4]);
    for (i = 0; i < def.refs.length; i++){
      var lv = def.refs[i];
      if (lv < lo || lv > hi) continue;
      var yy = Math.round(yS(lv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      if (kind === 'rsi' && hR >= 74){
        ctx.fillStyle = '#8b93a1'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(String(lv), padL + plotW + 5, yy);
      }
    }
    ctx.setLineDash([]);
  }
  hLine(ctx, arr, i0, n, xOf, yS, def.col, 1.2);

  ctx.fillStyle = HC.axis; ctx.textAlign = 'left';
  ctx.textBaseline = 'top'; ctx.fillText(def.fmt(hi), padL + plotW + 5, yR + 1);
  ctx.textBaseline = 'bottom'; ctx.fillText(def.fmt(lo), padL + plotW + 5, yR + hR);
  subName(ctx, def.nm, padL, yR, def.col);
}

/* 指标名画在图内左上角。放右侧会和上下两个刻度值抢位置——
   副图只有 60px 高时三行标签会叠成一团。 */
function subName(ctx, name, padL, yR, col){
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = '9px ui-monospace,Menlo,monospace';
  ctx.fillStyle = col; ctx.globalAlpha = 0.75;
  ctx.fillText(name, padL + 3, yR + 1);
  ctx.restore();
}

/* ================= 日内分时 =================
   数据来自 /api/min（Worker 代理新浪 minline），每个交易日 240 个点，
   含价格、当日成交额加权均价、分钟量。

   横轴不用「有几个点画几格」：固定 240 格，午休那 90 分钟不占位，
   盘中只画已经走过的部分。这样早盘打开图不会是一条被拉伸的怪线，
   而且 10:30 永远在图的正中间——位置本身就是信息。

   价格范围以昨收为中心上下对称。K 线那套「跟着最高最低自适应」在分时上
   是错的：昨收会跑到图边角，一眼看不出此刻是涨是跌。 */

var MC = {
  line:'#2563eb', avg:'#d68910', base:'#b9c0cc', cross:'#8b93a1',
  fillUp:'rgba(217,58,58,.06)', fillDn:'rgba(14,154,97,.06)',
  volUp:'rgba(217,58,58,.42)', volDn:'rgba(14,154,97,.42)'
};
var MIN_SLOTS = 240;                 // 槽位 0..240
var minTimer = null;

/* 09:30→0，11:30→120，13:00 也→120（两段接起来），15:00→240 */
function minSlot(t){
  var v = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  if (v <= 690) return Math.max(0, v - 570);
  return 120 + Math.min(120, v - 780);
}

function loadMin(code){
  var it = findItem(code);
  H.m = { code:code, pre:(it && it.pc > 0 ? it.pc : 0), pts:[] };
  document.getElementById('hLeg').innerHTML = '<span>加载中…</span>';
  document.getElementById('hInd').innerHTML = '';
  document.getElementById('hNote').textContent = '';
  document.getElementById('hTabs').style.display = 'none';
  document.getElementById('hSbar').style.display = 'none';
  fetchMinOnce(code, true);
}

function fetchMinOnce(code, first){
  fetch('/api/min?code=' + code).then(function(r){ return r.json(); }).then(function(j){
    if (H.code !== code || H.mode !== 'min') return;   // 期间换了标的或切了模式
    if (!j || !j.ok || !j.pts || !j.pts.length) throw new Error((j && j.error) || '分时无数据');
    var it = findItem(code);
    // 昨收优先取全市场快照（新浪 settlement，全天不变）；
    // 拿不到才退回用当天第一个价格当基准，并在备注里说清楚
    var pre = (it && it.pc > 0) ? it.pc : 0;
    var guess = !pre;
    if (!pre) pre = j.pts[0][1];
    H.m = { code:code, pre:pre, pts:j.pts, guess:guess, src:j.src };
    H.hover = -1;
    // 面板顶部那个现价是打开时的快照，分时每 35 秒会重拉，顺手把它带上——
    // 否则盘中会出现「图走到 4.21 了，顶栏还写着 4.19」的错位
    if (it && it.p > 0){
      document.getElementById('hPx').textContent = fnum(it.p, 3);
      var chEl = document.getElementById('hChg');
      chEl.textContent = fpc(it.chg);
      chEl.className = 'ch ' + cc(it.chg);
    }
    hDraw();
    hLegend(-1);
    document.getElementById('hNote').textContent = minNote();
  }).catch(function(e){
    if (H.code !== code || H.mode !== 'min' || !first) return;
    document.getElementById('hLeg').innerHTML = '';
    document.getElementById('hNote').textContent =
      '分时取不到：' + (e.message || e) + '。这条链路走新浪分时接口，'
      + '上游偶发空回；切到「K线」不受影响，过一会儿再点回来即可。';
    if (H.cv){
      var g = H.cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, H.cv.width, H.cv.height);
    }
  });
}

function minNote(){
  var m = H.m;
  if (!m) return '';
  var s = '共 ' + m.pts.length + ' 个分钟点，均价线是当日成交额加权（VWAP）；';
  if (m.guess) s += '昨收未取到，基准用当日首个价格代替，涨跌幅仅供参考；';
  s += '盘中未走到的时段留白，横轴刻度固定，方便和昨天同一时刻对比。';
  return s;
}

function hDrawMin(){
  hSize();
  var W = H.W, Ht = H.Ht, ctx = H.octx, m = H.m;
  if (!W) return;
  ctx.clearRect(0, 0, W, Ht);
  if (!m || !m.pts || !m.pts.length){
    H.ctx.setTransform(1, 0, 0, 1, 0, 0);
    H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
    return;
  }

  var pts = m.pts, pre = m.pre, n = pts.length, i;
  var padL = 46, padR = 58, padT = 10, padB = 16;
  var plotW = Math.max(40, W - padL - padR);
  var bodyH = Ht - padT - padB;
  var hV = Math.round(bodyH * 0.22);
  var hP = bodyH - hV - 10;
  var yP = padT, yV = padT + hP + 10;

  var dmax = 0, hi = -Infinity, lo = Infinity, vs = [];
  for (i = 0; i < n; i++){
    var p = pts[i][1], a = pts[i][2], vv = pts[i][3];
    if (p > hi) hi = p;
    if (p < lo) lo = p;
    if (Math.abs(p - pre) > dmax) dmax = Math.abs(p - pre);
    if (a > 0 && Math.abs(a - pre) > dmax) dmax = Math.abs(a - pre);
    if (vv > 0) vs.push(vv);
  }
  if (!(dmax > 0)) dmax = pre * 0.005 || 0.01;
  dmax *= 1.1;
  var pmin = pre - dmax, pmax = pre + dmax;

  /* 量柱刻度取 95 分位而不是最大值：开盘第一分钟含集合竞价，量常是平时的
     4~10 倍，用最大值当上限会让其余 239 根全部贴地，等于没画量。超出刻度
     的柱截断到顶部并描一道白边，表示这根已经出界。 */
  vs.sort(function(x, y){ return x - y; });
  var vmax = vs.length ? vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.95))] : 1;
  if (!(vmax > 0)) vmax = 1;

  function xOf(sl){ return padL + (sl / MIN_SLOTS) * plotW; }
  function yOf(q){ return yP + hP * (pmax - q) / (pmax - pmin); }
  function yVol(v){ return yV + hV * (1 - Math.min(v, vmax) / vmax); }

  /* --- 网格按涨跌幅整档画（±0.5% / ±1% …），而不是把价格区间等分：
     等分出来是 4.132 / 4.154 / 4.196 这种数，既不好读也对不上盘口整数位 --- */
  var spanPct = pre > 0 ? dmax / pre * 100 : 1;
  var stepPct = spanPct > 8 ? 5 : spanPct > 4 ? 2 : spanPct > 2 ? 1 : 0.5;
  var kMax = pre > 0 ? Math.floor(spanPct / stepPct) : 1;
  if (kMax < 1) kMax = 1;

  ctx.font = '10px ui-monospace,Menlo,monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (var j = -kMax; j <= kMax; j++){
    var pv = pre * (1 + j * stepPct / 100);
    if (pv < pmin || pv > pmax) continue;
    var yy = Math.round(yOf(pv)) + 0.5;
    if (j !== 0){                       // 0 档由昨收虚线代表，不重复画
      ctx.strokeStyle = HC.grid;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    }
    var upC = j > 0, dnC = j < 0;
    ctx.textAlign = 'right';
    ctx.fillStyle = upC ? 'rgba(217,58,58,.85)' : dnC ? 'rgba(14,154,97,.85)' : HC.axis;
    ctx.fillText((j > 0 ? '+' : '') + (j * stepPct).toFixed(2) + '%', padL - 6, yy);
    ctx.textAlign = 'left';
    ctx.fillStyle = upC ? HC.up : dnC ? HC.dn : HC.axis;
    ctx.fillText(pv.toFixed(pre < 10 ? 3 : 2), padL + plotW + 8, yy);
  }

  /* --- 昨收基准线 --- */
  var yb = Math.round(yOf(pre)) + 0.5;
  ctx.strokeStyle = MC.base; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yb); ctx.lineTo(padL + plotW, yb); ctx.stroke();
  ctx.setLineDash([]);

  /* --- 分钟量 --- */
  var bw = Math.max(1, (plotW / (MIN_SLOTS + 1)) * 0.7);
  for (i = 0; i < n; i++){
    var v = pts[i][3];
    if (!(v > 0)) continue;
    var rise = i === 0 ? pts[i][1] >= pre : pts[i][1] >= pts[i - 1][1];
    ctx.fillStyle = rise ? MC.volUp : MC.volDn;
    var y0 = yVol(v), x0 = xOf(minSlot(pts[i][0])) - bw / 2;
    ctx.fillRect(x0, y0, bw, Math.max(1, yV + hV - y0));
    if (v > vmax){
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillRect(x0, y0, bw, 1);
    }
  }

  /* --- 涨跌两色填充：昨收以上红、以下绿。
     和「现价涨了所以整块涂红」不同——分时图要看的是此刻在基准的哪一侧，
     而不是收盘那一瞬间的方向。 --- */
  function fillSide(yTop, yBot, color){
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, yTop, plotW, Math.max(0, yBot - yTop)); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(xOf(minSlot(pts[0][0])), yb);
    for (var q = 0; q < n; q++) ctx.lineTo(xOf(minSlot(pts[q][0])), yOf(pts[q][1]));
    ctx.lineTo(xOf(minSlot(pts[n - 1][0])), yb);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  fillSide(yP, yb, MC.fillUp);
  fillSide(yb, yV + hV, MC.fillDn);

  /* --- 均价线（VWAP） --- */
  var started = false;
  ctx.strokeStyle = MC.avg; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (i = 0; i < n; i++){
    if (!(pts[i][2] > 0)) continue;
    var ax = xOf(minSlot(pts[i][0])), ay = yOf(pts[i][2]);
    if (!started){ ctx.moveTo(ax, ay); started = true; } else ctx.lineTo(ax, ay);
  }
  ctx.stroke();

  /* --- 价格线 --- */
  ctx.strokeStyle = MC.line; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (i = 0; i < n; i++){
    var lx = xOf(minSlot(pts[i][0])), ly = yOf(pts[i][1]);
    if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
  }
  ctx.stroke();

  /* --- 最新点：收盘后也保留，方便看收在哪 --- */
  var lastP = pts[n - 1][1];
  var up = lastP >= pre;
  // 末端点往左收一格：15:00 那一点正好落在绘图区右边界，
  // 光晕会压到右侧的价格刻度上，看起来像刻度被涂花了
  var xe = Math.min(xOf(minSlot(pts[n - 1][0])), padL + plotW - 2), ye = yOf(lastP);
  ctx.beginPath(); ctx.arc(xe, ye, 5, 0, Math.PI * 2);
  ctx.fillStyle = up ? 'rgba(217,58,58,.16)' : 'rgba(14,154,97,.16)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(xe, ye, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = up ? HC.up : HC.dn;
  ctx.fill();

  /* --- 时间轴 --- */
  ctx.fillStyle = HC.axis; ctx.textBaseline = 'top';
  ctx.font = '10px ui-monospace,Menlo,monospace';
  var marks = plotW < 560
    ? [[0, '09:30'], [120, '11:30'], [240, '15:00']]
    : [[0, '09:30'], [60, '10:30'], [120, '11:30/13:00'], [180, '14:00'], [240, '15:00']];
  for (var t = 0; t < marks.length; t++){
    ctx.textAlign = t === 0 ? 'left' : (t === marks.length - 1 ? 'right' : 'center');
    ctx.fillText(marks[t][1], xOf(marks[t][0]), yV + hV + 4);
  }

  H.mgeo = { padL:padL, plotW:plotW, yP:yP, hP:hP, yV:yV, hV:hV,
             pmin:pmin, pmax:pmax, vmax:vmax, pre:pre, pts:pts };

  H.ctx.setTransform(1, 0, 0, 1, 0, 0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, W, Ht);
  if (H.hover >= 0) hCrossMin(H.hover);
}

/* 鼠标 x → 最近的分时点索引。点数 ≤ 240，直接扫比二分更快也更不容易写错 */
function minIdxAt(x){
  var g = H.mgeo;
  if (!g) return -1;
  var s = (x - g.padL) / g.plotW * MIN_SLOTS;
  var pts = g.pts, best = -1, bd = 1e9;
  for (var i = 0; i < pts.length; i++){
    var d = Math.abs(minSlot(pts[i][0]) - s);
    if (d < bd){ bd = d; best = i; }
  }
  return best;
}

function hCrossMin(idx){
  var g = H.mgeo, ctx = H.ctx, m = H.m;
  if (!g || !m || !m.pts) return;
  var pts = g.pts;
  if (idx < 0 || idx >= pts.length) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  ctx.drawImage(H.off, 0, 0, H.W, H.Ht);

  var pt = pts[idx];
  var slot = minSlot(pt[0]);
  var x = Math.round(g.padL + (slot / MIN_SLOTS) * g.plotW) + 0.5;
  var yTop = g.yP, yBot = g.yV + g.hV;

  ctx.strokeStyle = MC.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();

  var py = Math.round(g.yP + g.hP * (g.pmax - pt[1]) / (g.pmax - g.pmin)) + 0.5;
  ctx.beginPath(); ctx.moveTo(g.padL, py); ctx.lineTo(g.padL + g.plotW, py); ctx.stroke();
  ctx.setLineDash([]);

  // 右侧价格牌
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(g.padL + g.plotW + 2, py - 7, 54, 14);
  ctx.fillStyle = '#15181d';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '10px ui-monospace,Menlo,monospace';
  ctx.fillText(fnum(pt[1], 3), g.padL + g.plotW + 5, py);

  // 该点的圆点
  ctx.beginPath(); ctx.arc(x, py, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = MC.line; ctx.fill();

  hLegendMin(idx);
}

function hLegendMin(idx){
  var m = H.m, g = H.mgeo;
  var leg = document.getElementById('hLeg');
  var ind = document.getElementById('hInd');
  if (!m || !m.pts || !m.pts.length){ leg.innerHTML = ''; ind.innerHTML = ''; return; }
  var pts = m.pts, pre = m.pre, n = pts.length, i;

  var hi = -Infinity, lo = Infinity, sumV = 0, last = pts[n - 1][1];
  for (i = 0; i < n; i++){
    if (pts[i][1] > hi) hi = pts[i][1];
    if (pts[i][1] < lo) lo = pts[i][1];
    if (pts[i][3] > 0) sumV += pts[i][3];
  }
  var pctOf = function(q){ return pre > 0 ? (q / pre - 1) * 100 : NaN; };
  var volTxt = function(v){
    if (!(v > 0)) return '-';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿股';
    if (v >= 1e4) return (v / 1e4).toFixed(0) + ' 万股';
    return v + ' 股';
  };
  var posIn = (hi > lo) ? (last - lo) / (hi - lo) * 100 : 50;

  if (idx >= 0 && idx < n){
    var pt = pts[idx];
    var dev = pt[2] > 0 ? (pt[1] / pt[2] - 1) * 100 : NaN;
    leg.innerHTML =
      '<span>时刻 <b>' + pt[0] + '</b></span>'
      + '<span>价 <b class="' + cc(pctOf(pt[1])) + '">' + fnum(pt[1], 3) + '</b>'
      + ' <b class="' + cc(pctOf(pt[1])) + '">' + fpc(pctOf(pt[1])) + '</b></span>'
      + '<span>均价 <b>' + (pt[2] > 0 ? fnum(pt[2], 3) : '-') + '</b></span>'
      + '<span>偏离 <b class="' + cc(dev) + '">' + (isFinite(dev) ? fpc(dev) : '-') + '</b></span>'
      + '<span>分钟量 <b>' + volTxt(pt[3]) + '</b></span>';
  } else {
    leg.innerHTML =
      '<span>现价 <b class="' + cc(pctOf(last)) + '">' + fnum(last, 3) + '</b>'
      + ' <b class="' + cc(pctOf(last)) + '">' + fpc(pctOf(last)) + '</b></span>'
      + '<span>日内高 <b>' + fnum(hi, 3) + '</b> <b class="up">' + fpc(pctOf(hi)) + '</b></span>'
      + '<span>日内低 <b>' + fnum(lo, 3) + '</b> <b class="dn">' + fpc(pctOf(lo)) + '</b></span>'
      + '<span>昨收 <b>' + fnum(pre, 3) + '</b></span>'
      + '<span>振幅 <b>' + (pre > 0 ? fpc((hi - lo) / pre * 100) : '-') + '</b></span>';
  }

  // 小卡：把分时里真正能用的几个数摊开，凑不出 7 个就不凑
  var vwap = 0;
  for (i = 0; i < n; i++) if (pts[i][2] > 0) vwap = pts[i][2];
  var devNow = vwap > 0 ? (last / vwap - 1) * 100 : NaN;
  var card = function(k, v, s, cls){
    return '<div class="i"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">'
      + v + '</div><div class="s">' + (s || '') + '</div></div>';
  };
  var posTxt = posIn >= 70 ? '贴近日内高位' : posIn <= 30 ? '贴近日内低位' : '日内中枢';
  ind.innerHTML =
    card('日内位置', posIn.toFixed(0) + '%', posTxt)
    + card('均价偏离', isFinite(devNow) ? fpc(devNow) : '-',
        devNow > 0.15 ? '价在均价上' : devNow < -0.15 ? '价在均价下' : '贴着均价走', cc(devNow))
    + card('振幅', pre > 0 ? fpc((hi - lo) / pre * 100) : '-', fnum(hi, 3) + ' / ' + fnum(lo, 3))
    + card('分钟点数', String(n), n >= 240 ? '已走完整日' : '盘中 ' + Math.round(n / 240 * 100) + '%')
    + card('成交额', (function(){
        var it = findItem(H.code);
        return it && it.amt > 0 ? famt(it.amt) : '-';
      })(), '全市场快照口径');
}

function hDraw(){
  if (H.mode === 'min') return hDrawMin();
  // 成分档下画布是 display:none，再画只会白烧 CPU，还会把隐藏画布上的旧图刷新
  if (H.mode === 'hold') return;
  var d = H.d;
  if (!d || !H.W) return;
  hSize();

  var W = H.W, Ht = H.Ht, ctx = H.octx;
  var n = d.n, rng = H.range || n;
  var i0 = Math.max(0, n - rng), cnt = n - i0;

  ctx.clearRect(0, 0, W, Ht);
  if (cnt < 2){
    H.ctx.clearRect(0, 0, W, Ht);
    document.getElementById('hNote').textContent = '历史数据不足 2 个交易日，无法绘图';
    return;
  }

  var padL = 2, padR = 56, padT = 8, padB = 15;
  var plotW = W - padL - padR;
  var bodyH = Ht - padT - padB;
  var hP = Math.round(bodyH * 0.58);
  var hV = Math.round(bodyH * 0.14);
  var hR = bodyH - hP - hV - 14;
  var yP = padT, yV = padT + hP + 6, yR = yV + hV + 8;

  var c = d.col;
  var o = c.open, hi = c.high, lo = c.low, cl = c.close, vol = c.volume;
  var m20 = c.ma20, m60 = c.ma60, bu = c.boll_up, bl = c.boll_low;

  var pmin = Infinity, pmax = -Infinity, vmax = 0, i, vv;
  for (i = i0; i < n; i++){
    if (isFinite(lo[i]) && lo[i] < pmin) pmin = lo[i];
    if (isFinite(hi[i]) && hi[i] > pmax) pmax = hi[i];
    if (isFinite(m20[i])){ if (m20[i] < pmin) pmin = m20[i]; if (m20[i] > pmax) pmax = m20[i]; }
    if (isFinite(m60[i])){ if (m60[i] < pmin) pmin = m60[i]; if (m60[i] > pmax) pmax = m60[i]; }
    if (H.ov.boll && isFinite(bu[i]) && isFinite(bl[i])){
      if (bu[i] < pmin) pmin = bu[i];
      if (bl[i] > pmax) pmax = bl[i];
    }
    if (isFinite(vol[i]) && vol[i] > vmax) vmax = vol[i];
  }
  if (!isFinite(pmin) || !isFinite(pmax) || pmax <= pmin){ pmin = 0; pmax = 1; }
  var pad = (pmax - pmin) * 0.04;
  pmin -= pad; pmax += pad;
  if (vmax <= 0) vmax = 1;

  var bw = plotW / cnt;
  var ew = Math.max(1, Math.min(bw * 0.68, 12));
  function xOf(i){ return padL + (i - i0 + 0.5) * bw; }
  function yPx(p){ return yP + hP * (pmax - p) / (pmax - pmin); }
  function yVx(v){ return yV + hV * (1 - v / vmax); }

  /* --- 网格与价格刻度 --- */
  ctx.strokeStyle = HC.grid; ctx.lineWidth = 1;
  ctx.font = '10px ' + 'ui-monospace,Menlo,monospace';
  ctx.textBaseline = 'middle';
  for (var k = 0; k <= 4; k++){
    var pv = pmin + (pmax - pmin) * k / 4;
    var yy = Math.round(yPx(pv)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = HC.axis;
    ctx.textAlign = 'left';
    ctx.fillText(pv.toFixed(pv < 10 ? 3 : 2), padL + plotW + 5, yy);
  }

  /* --- 成交量 --- */
  for (i = i0; i < n; i++){
    if (!isFinite(vol[i]) || vol[i] <= 0) continue;
    var cUp = cl[i] >= o[i];
    ctx.fillStyle = cUp ? 'rgba(217,58,58,.55)' : 'rgba(14,154,97,.55)';
    var x0 = xOf(i) - ew / 2, hgt = yV + hV - yVx(vol[i]);
    ctx.fillRect(x0, yVx(vol[i]), ew, Math.max(1, hgt));
  }
  ctx.fillStyle = HC.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(famt(vmax), padL + plotW + 5, yV + hV - 3);

  /* --- K 线 --- */
  for (i = i0; i < n; i++){
    if (!isFinite(o[i]) || !isFinite(cl[i])) continue;
    var up = cl[i] >= o[i];
    var col = up ? HC.up : HC.dn;
    var xc = xOf(i);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(xc) + 0.5, yPx(hi[i]));
    ctx.lineTo(Math.round(xc) + 0.5, yPx(lo[i]));
    ctx.stroke();
    var y1 = yPx(Math.max(o[i], cl[i])), y2 = yPx(Math.min(o[i], cl[i]));
    var bh = Math.max(1, y2 - y1);
    ctx.fillRect(xc - ew / 2, y1, ew, bh);
  }

  /* --- 均线 / 布林带 ---
     必须传入各自的纵轴映射：早期版本把 RSI 也用 yPx 画，结果
     28~65 的数值被映射到价格刻度之外，整条线飞到画布上方看不见。 */
  if (H.ov.ma){
    hLine(ctx, m60, i0, n, xOf, yPx, HC.ma60, 1.3);
    hLine(ctx, m20, i0, n, xOf, yPx, HC.ma20, 1.3);
  }
  if (H.ov.boll){
    hLine(ctx, bu, i0, n, xOf, yPx, HC.boll, 1);
    hLine(ctx, bl, i0, n, xOf, yPx, HC.boll, 1);
  }

  /* --- 副图：可切换，映射与主图完全独立 --- */
  drawSub(ctx, c, i0, n, xOf, padL, plotW, yR, hR);

  /* --- 时间轴 --- */
  ctx.fillStyle = HC.axis; ctx.textBaseline = 'top';
  // 窄屏放 5 个日期会叠在一起，按绘图宽度降级
  var ticks = Math.min(plotW < 300 ? 3 : (plotW < 520 ? 4 : 5), cnt);
  for (var t = 0; t < ticks; t++){
    var idx = i0 + Math.round((cnt - 1) * t / Math.max(1, ticks - 1));
    var ds = String(d.dates[idx]);
    var label = ds.slice(0, 4) + '-' + ds.slice(4, 6);
    ctx.textAlign = t === 0 ? 'left' : (t === ticks - 1 ? 'right' : 'center');
    var tx = Math.max(padL, Math.min(padL + plotW, xOf(idx)));
    ctx.fillText(label, tx, Ht - padB + 2);
  }

  H.geo = { i0:i0, cnt:cnt, padL:padL, plotW:plotW, bw:bw, yP:yP, hP:hP,
            yV:yV, hV:hV, yR:yR, hR:hR, pmin:pmin, pmax:pmax };

  H.ctx.setTransform(1,0,0,1,0,0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, W, Ht);
  if (H.hover >= 0) hCross(H.hover);
}

function hCross(idx){
  if (H.mode === 'min') return hCrossMin(idx);
  var d = H.d, g = H.geo, ctx = H.ctx;
  if (!d || !g) return;
  var i0 = g.i0, i1 = g.i0 + g.cnt;
  if (idx < i0 || idx >= i1) return;

  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  ctx.drawImage(H.off, 0, 0, H.W, H.Ht);

  var x = g.padL + (idx - i0 + 0.5) * g.bw;
  var c = d.col;
  var yTop = g.yP, yBot = g.yR + g.hR;
  ctx.strokeStyle = HC.cross; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, yTop); ctx.lineTo(Math.round(x) + 0.5, yBot);
  ctx.stroke();
  ctx.setLineDash([]);

  // 收盘价横线
  if (isFinite(c.close[idx])){
    var yy = Math.round(g.yP + g.hP * (g.pmax - c.close[idx]) / (g.pmax - g.pmin)) + 0.5;
    ctx.beginPath(); ctx.moveTo(g.padL, yy); ctx.lineTo(g.padL + g.plotW, yy); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    var lab = fnum(c.close[idx], 3);
    ctx.fillRect(g.padL + g.plotW + 2, yy - 7, 50, 14);
    ctx.fillStyle = '#15181d'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '10px ui-monospace,Menlo,monospace';
    ctx.fillText(lab, g.padL + g.plotW + 6, yy);
  }
  hLegend(idx);
}

function hLegend(idx){
  if (H.mode === 'min') return hLegendMin(idx);
  var d = H.d;
  if (!d){ document.getElementById('hInd').innerHTML = ''; return; }
  hInd(idx);
  var leg = document.getElementById('hLeg');
  var c = d.col, n = d.n;

  if (idx < 0){
    // 区间概览
    var rng = H.range || n, i0 = Math.max(0, n - rng);
    var first = c.close[i0], last = c.close[n - 1];
    var hi = -Infinity, lo = Infinity;
    for (var i = i0; i < n; i++){
      if (c.high[i] > hi) hi = c.high[i];
      if (c.low[i] < lo) lo = c.low[i];
    }
    var ret = (isFinite(first) && first > 0) ? (last / first - 1) * 100 : NaN;
    /* 有分红/折算时，原始价的「累计涨跌」会把折算算成暴跌——159922 曾因此
       显示 -56%，实际复权后是正收益。所以这里同时给复权口径。 */
    var ar = c.adj_ratio, r0 = ar ? ar[i0] : 1, r1 = ar ? ar[n - 1] : 1;
    var retAdj = (isFinite(r0) && r0 > 0 && isFinite(r1) && isFinite(ret))
      ? ((1 + ret / 100) * r1 / r0 - 1) * 100 : NaN;
    var adjSpan = (isFinite(r0) && r0 > 0 && isFinite(r1)) ? Math.abs(r0 / r1 - 1) * 100 : 0;
    var retHtml = adjSpan >= 0.5
      ? '<span>累计 <b class="' + cc(retAdj) + '">' + fpc(retAdj) + '</b> 复权'
        + '<span style="color:var(--txt3)"> / ' + fpc(ret) + ' 原始</span></span>'
      : '<span>累计 <b class="' + cc(ret) + '">' + fpc(ret) + '</b></span>';
    leg.innerHTML =
      '<span>区间 <b>' + (n - i0) + '</b> 个交易日</span>'
      + retHtml
      + '<span>最高 <b>' + fnum(hi,3) + '</b></span>'
      + '<span>最低 <b>' + fnum(lo,3) + '</b></span>'
      + '<span><i style="background:' + HC.ma20 + '"></i>MA20 <b>' + fnum(c.ma20[n-1],3) + '</b></span>'
      + '<span><i style="background:' + HC.ma60 + '"></i>MA60 <b>' + fnum(c.ma60[n-1],3) + '</b></span>'
      + '<span>RSI14 <b>' + fnum(c.rsi14[n-1],1) + '</b></span>';
    return;
  }

  var ds = String(d.dates[idx]);
  var dt = ds.slice(0,4) + '-' + ds.slice(4,6) + '-' + ds.slice(6,8);
  var chg = (isFinite(c.close[idx]) && isFinite(c.open[idx]) && c.open[idx] > 0)
    ? (c.close[idx] / c.open[idx] - 1) * 100 : NaN;
  var hc = HC.up;
  leg.innerHTML =
    '<span style="color:var(--txt)"><b>' + dt + '</b></span>'
    + '<span>开 <b>' + fnum(c.open[idx],3) + '</b></span>'
    + '<span>高 <b>' + fnum(c.high[idx],3) + '</b></span>'
    + '<span>低 <b>' + fnum(c.low[idx],3) + '</b></span>'
    + '<span>收 <b class="' + cc(chg) + '">' + fnum(c.close[idx],3) + '</b></span>'
    + '<span>涨跌 <b class="' + cc(chg) + '">' + fpc(chg) + '</b></span>'
    + '<span>量 <b>' + famt(c.volume[idx]) + '</b></span>'
    + '<span>额 <b>' + famt(c.amount[idx]) + '</b></span>'
    + '<span>RSI <b>' + fnum(c.rsi14[idx],1) + '</b></span>';
}

/* 指标明细：把 17 个字段里最能看的那几个摊开成小卡。
   hover 时跟着游标走，不 hover 就是最后一根。 */
function hInd(idx){
  var el = document.getElementById('hInd');
  var d = H.d;
  if (!d){ el.innerHTML = ''; return; }
  var c = d.col, n = d.n;
  var i = (idx >= 0 && idx < n) ? idx : n - 1;
  var px = c.close[i];

  /* key 用来标记「当前副图画的就是这张卡」，切换副图时跟着高亮 */
  function cell(k, v, s, cls, key){
    var on = key && (key === H.sub || (H.sub === 'macd' && key === 'dea'));
    return '<div class="i' + (on ? ' on' : '') + '"><div class="k">' + k + '</div>'
      + '<div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div>'
      + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
  }
  var out = '';

  // 均线：值 + 当前价相对均线的偏离
  var m20 = c.ma20 ? c.ma20[i] : NaN, m60 = c.ma60 ? c.ma60[i] : NaN;
  out += cell('MA20', fnum(m20, 3),
    isFinite(m20) && m20 > 0 ? fpc((px / m20 - 1) * 100) : '-',
    isFinite(m20) && m20 > 0 ? cc(px - m20) : '', 'ma20');
  out += cell('MA60', fnum(m60, 3),
    isFinite(m60) && m60 > 0 ? fpc((px / m60 - 1) * 100) : '-',
    isFinite(m60) && m60 > 0 ? cc(px - m60) : '', 'ma60');

  // RSI：70 以上超买、30 以下超卖，中间给中性描述
  var r = c.rsi14 ? c.rsi14[i] : NaN;
  var rTag = '-';
  if (isFinite(r)) rTag = r >= 70 ? '超买' : (r <= 30 ? '超卖' : (r >= 55 ? '偏强' : (r <= 45 ? '偏弱' : '中性')));
  out += cell('RSI14', fnum(r, 1), rTag,
    isFinite(r) ? (r >= 70 ? 'up' : (r <= 30 ? 'down' : '')) : '', 'rsi');

  // MACD：DIF 与 DEA 的差决定金叉/死叉（这里用的是已算好的两条线）
  var dif = c.macd_dif ? c.macd_dif[i] : NaN;
  var dea = c.macd_dea ? c.macd_dea[i] : NaN;
  var cross = '-';
  if (isFinite(dif) && isFinite(dea)) cross = dif > dea ? '金叉之上' : '死叉之下';
  out += cell('MACD DIF', fnum(dif, 4), isFinite(dif) ? (dif >= 0 ? '零轴上' : '零轴下') : '-',
    isFinite(dif) ? cc(dif) : '', 'macd');
  out += cell('MACD DEA', fnum(dea, 4), cross,
    isFinite(dif) && isFinite(dea) ? (dif > dea ? 'up' : 'down') : '', 'dea');

  // 布林带：直接给 %B（当前价在上下轨之间的位置），比给两个价格好读
  var bu = c.boll_up ? c.boll_up[i] : NaN;
  var bl = c.boll_low ? c.boll_low[i] : NaN;
  var pb = (isFinite(bu) && isFinite(bl) && bu > bl) ? (px - bl) / (bu - bl) * 100 : NaN;
  out += cell('BOLL %B', isFinite(pb) ? pb.toFixed(0) + '%' : '-',
    isFinite(bu) && isFinite(bl) ? fnum(bl, 3) + ' ~ ' + fnum(bu, 3) : '-',
    isFinite(pb) ? (pb >= 100 ? 'up' : (pb <= 0 ? 'down' : '')) : '', 'pb');

  // ATR 与历史波动率：都换成占比/百分比，绝对值没意义
  var atr = c.atr14 ? c.atr14[i] : NaN;
  out += cell('ATR14', fnum(atr, 4),
    isFinite(atr) && px > 0 ? '占价 ' + (atr / px * 100).toFixed(2) + '%' : '-', '', 'atr');
  var hv = c.hvol20 ? c.hvol20[i] : NaN;
  // hvol20 在 alpha/indicators.py 里已经乘过 100 变成百分数，这里不能再乘
  out += cell('HVOL20', isFinite(hv) ? hv.toFixed(1) + '%' : '-', '年化波动', '', 'hvol');

  var vr = c.vol_ratio5 ? c.vol_ratio5[i] : NaN;
  out += cell('量比5', isFinite(vr) ? vr.toFixed(2) : '-', '5 日均量对比',
    isFinite(vr) ? (vr >= 1.5 ? 'up' : (vr <= 0.6 ? 'down' : '')) : '', 'vr');

  el.innerHTML = out;
}

/* 分红/折算会让原始价出现跳空。adj_ratio 是「相对最新日的复权比率」，
   首尾变化就是区间内的累计调整幅度——超过 0.5% 才提示，免得噪声吓人。 */
function hAdjNote(){
  var d = H.d; if (!d) return '';
  var c = d.col, n = d.n, rng = H.range || n;
  var i0 = Math.max(0, n - rng);
  var a = c.adj_ratio, p = 1;
  if (!a) return '';
  for (var i = i0; i < n; i++) if (isFinite(a[i]) && a[i] > 0){ p = a[i]; break; }
  var r0 = a[i0], r1 = a[n - 1];
  if (!isFinite(r0) || !isFinite(r1) || r0 <= 0) return '';
  var adj = (r0 / r1 - 1) * 100;
  if (Math.abs(adj) < 0.5) return '';
  return '本区间内有分红或份额折算，原始价存在跳空；按复权口径计算的累计调整约 '
    + (adj > 0 ? '+' : '') + adj.toFixed(2) + '%。';
}

/* ---------- 因子研究面板 ----------
   数据在构建时固化成 research_data.js（5KB），随 HTML 一起下发，
   点开就是 0ms，不需要额外请求，也不占 Worker 请求额度。 */
function rsCard(k, v, s, cls){
  return '<div class="i"><div class="k">' + k + '</div>'
    + '<div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div>'
    + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
}
function rsPct(v, d){
  if (v == null || !isFinite(v)) return '-';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%';
}
/* ---------- 第二批因子：指数去重池 ----------
   上面那一套是 1617 只 ETF 的「个股口径」：同一指数常有 3~4 只 ETF，
   在横截面里各占一行，等于同一件事投了 3~4 票，IC 被同质化噪声稀释。
   这一批先按指数去重（每天留 20 日均额最大的那只，收益累乘拼接），
   再跑 100 个新因子 + 101 个 Alpha101，口径完全一致。
   数据由 factor_lab/export_lab.py 生成，构建时固化成 lab_data.js。 */

function labSvg(nav){
  if (!nav || nav.length < 2) return '';
  var W = 1000, H = 300, PL = 10, PR = 10, PT = 12, PB = 24;
  var lo = Infinity, hi = -Infinity, i;
  for (i = 0; i < nav.length; i++){
    lo = Math.min(lo, nav[i][1], nav[i][2]);
    hi = Math.max(hi, nav[i][1], nav[i][2]);
  }
  var pad = (hi - lo) * 0.08 || 0.1;
  lo -= pad; hi += pad;
  function X(k){ return PL + k / (nav.length - 1) * (W - PL - PR); }
  function Y(v){ return PT + (hi - v) / (hi - lo) * (H - PT - PB); }
  function d(col){
    var s = '';
    for (var k = 0; k < nav.length; k++){
      s += (k ? 'L' : 'M') + X(k).toFixed(1) + ' ' + Y(nav[k][col]).toFixed(1);
    }
    return s;
  }
  var g = '';
  // 年份分隔线 + 年份标签：90 个月末点不标年份就看不出横轴是什么
  var lastY = '';
  for (i = 0; i < nav.length; i++){
    var y = nav[i][0].slice(0, 4);
    if (y !== lastY){
      lastY = y;
      g += '<line x1="' + X(i).toFixed(1) + '" y1="' + PT + '" x2="' + X(i).toFixed(1)
        + '" y2="' + (H - PB) + '" stroke="#e3e6eb" stroke-width="1"/>'
        + '<text x="' + (X(i) + 3).toFixed(1) + '" y="' + (H - 7)
        + '" fill="#939aa7" font-size="11">' + y + '</text>';
    }
  }
  // 三条水平参考线（净值刻度）
  for (var q = 0; q <= 2; q++){
    var vv = lo + (hi - lo) * q / 2;
    g += '<line x1="' + PL + '" y1="' + Y(vv).toFixed(1) + '" x2="' + (W - PR)
      + '" y2="' + Y(vv).toFixed(1) + '" stroke="#e3e6eb" stroke-width="1" stroke-dasharray="3 4"/>'
      + '<text x="' + PL + '" y="' + (Y(vv) - 4).toFixed(1)
      + '" fill="#4a5260" font-size="10">' + vv.toFixed(2) + '</text>';
  }
  var last = nav[nav.length - 1];
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">'
    + g
    + '<path d="' + d(2) + '" fill="none" stroke="#5b6472" stroke-width="1.6" opacity=".85"/>'
    + '<path d="' + d(1) + '" fill="none" stroke="#d93a3a" stroke-width="2.2"/>'
    + '<circle cx="' + X(nav.length - 1).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1)
    + '" r="3.5" fill="#d93a3a"/>'
    + '</svg>';
}

/* 超额热力格：正红负绿（A 股习惯），透明度按幅度缩放，上限 0.45 免得糊成一片 */
function labHeat(v){
  if (v == null || !isFinite(v)) return '<td class="n">-</td>';
  var a = Math.min(0.45, 0.08 + Math.abs(v) * 1.9);
  var bg = v >= 0 ? 'rgba(217,58,58,' + a.toFixed(2) + ')'
                  : 'rgba(14,154,97,' + a.toFixed(2) + ')';
  return '<td style="background:' + bg + '">' + (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '</td>';
}

function renderLab(){
  var L = LAB;
  if (!L) return '';
  var E = L.pe.all, C = L.counts, U = L.universe;
  var newAlive = C.alive - (C.fam_alive['Alpha101'] || 0);
  var h = '';

  h += '<div class="rssec"><h4>第二批 · 指数去重后的 ' + C.n_new + ' 个新因子</h4>';

  h += '<div class="rsnote">'
    + '上面那套是 <b>' + U.n_etf + ' 只 ETF 的个股口径</b>——同一指数常有 3~4 只 ETF，'
    + '在横截面里各占一行，等于同一件事投了 3~4 票，算出来的 IC 被同质化噪声稀释。'
    + '这一批先按指数去重：<b>' + U.n_etf + ' 只 → ' + U.n_idx + ' 个指数</b>'
    + '（股票 + 商品，剔除债券与货币），每天在指数内留 20 日均成交额最大的一只，'
    + '收益按累乘拼接，不是直接取价格——否则换券那天会出现假跳空。'
    + '<br>然后在这 ' + U.n_idx + ' 个指数上，用同一套分段（' + L.window[0] + ' ~ ' + L.window[1]
    + '，2023 年底切分）跑 ' + C.n_new + ' 个新因子和 ' + C.n_alpha + ' 个 Alpha101。'
    + '</div>';

  h += '<div class="rsk" style="margin-top:10px">'
    + rsCard('标的池', U.n_idx, U.n_etf + ' 只 ETF 去重')
    + rsCard('因子数', C.n_new + C.n_alpha, '新 ' + C.n_new + ' + Alpha ' + C.n_alpha)
    + rsCard('两期都显著', C.alive, '新 ' + newAlive + ' + Alpha ' + (C.fam_alive['Alpha101'] || 0), 'down')
    + rsCard('PE 策略年化', rsPct(E.ann), '基准 ' + rsPct(E.b_ann), E.ann > 0 ? 'up' : 'down')
    + rsCard('夏普', E.sharpe.toFixed(2), '基准 ' + E.b_sharpe.toFixed(2))
    + rsCard('最大回撤', rsPct(E.mdd, 1), '基准 ' + rsPct(E.b_mdd, 1))
    + '</div>';

  // ---- 净值 ----
  h += '<div class="labchart">'
    + '<div class="lablg">'
    + '<span><i style="background:#d93a3a"></i>PE 单因子（做多前 20%）</span>'
    + '<span><i style="background:#5b6472"></i>' + U.n_idx + ' 个指数等权</span>'
    + '<span style="margin-left:auto;color:var(--txt3)">持有 20 日 · 双边各 5bp</span></div>'
    + labSvg(L.pe.nav)
    + '<div class="cap">净值 ' + L.pe.nav[0][0] + ' 起算，末值策略 '
    + L.pe.nav[L.pe.nav.length - 1][1].toFixed(2) + ' / 基准 '
    + L.pe.nav[L.pe.nav.length - 1][2].toFixed(2)
    + '。平均持仓 ' + Math.round(E.holding) + ' 只，年换手 ' + E.to.toFixed(1) + ' 倍。</div>'
    + '</div>';

  // ---- 分年度 ----
  // ytbl：只有 4 列，窄屏下别跟着 480px 的下限一起横滚
  h += '<div class="rstwrap" style="margin-top:10px"><table class="rstbl ytbl">'
    + '<thead><tr><th>年度</th><th>PE 策略</th><th>指数等权</th><th>超额</th></tr></thead><tbody>';
  for (var i = 0; i < L.pe.yearly.length; i++){
    var r = L.pe.yearly[i];
    var tag = (i === 0 ? '2019*' : (i === L.pe.yearly.length - 1 ? r[0] + '*' : String(r[0])));
    h += '<tr><td>' + tag + '</td>'
      + '<td class="' + cc(r[1]) + '">' + rsPct(r[1]) + '</td>'
      + '<td>' + rsPct(r[2]) + '</td>'
      + '<td class="' + cc(r[3]) + '"><b>' + rsPct(r[3]) + '</b></td></tr>';
  }
  h += '</tbody></table></div>'
    + '<div class="cap" style="font-size:10.5px;color:var(--txt3);margin-top:5px">'
    + '* 2019 从 6 月起、2026 到 11 月止，都不是完整年度。'
    + '超额全在下跌年：2022 赢 28 个点、2026 赢 22 个点，2020 输 13 个点。</div>';

  // ---- 敏感性 ----
  var HOLDS = [10, 20, 30], WINS = [10, 20, 40, 60, 120];
  function grid(field){
    var s = '<table><thead><tr><th>窗口\\\\持有</th>';
    for (var j = 0; j < HOLDS.length; j++) s += '<th>' + HOLDS[j] + ' 日</th>';
    s += '</tr></thead><tbody>';
    for (var a = 0; a < WINS.length; a++){
      s += '<tr><td class="n">' + WINS[a] + ' 日</td>';
      for (var b = 0; b < HOLDS.length; b++){
        var val = null;
        for (var k = 0; k < L.sens.length; k++){
          var t = L.sens[k];
          if (t[0] === WINS[a] && t[1] === HOLDS[b] && Math.abs(t[2] - 0.2) < 1e-6){
            val = field === 'a' ? t[3] : t[4];
            break;
          }
        }
        s += labHeat(val);
      }
      s += '</tr>';
    }
    return s + '</tbody></table>';
  }
  h += '<div class="labgrid" style="margin-top:12px">'
    + '<div class="box"><h5>样本内 2021–2023 超额（%）· 持仓前 20%</h5>' + grid('a') + '</div>'
    + '<div class="box"><h5>样本外 2024–2026 超额（%）· 持仓前 20%</h5>' + grid('b') + '</div>'
    + '</div>'
    + '<div class="cap" style="font-size:10.5px;color:var(--txt3);margin-top:6px">'
    + '45 组参数里 33 组样本外超额为正，但只有 <b>10~20 日窗口</b>有效，40 日以上衰减到零。'
    + '它抓的是月度尺度的路径质量，拉到季度就不成立——这不是一个「万能」因子。</div>';

  h += '</div>';   // rssec

  // ---- 201 个因子 ----
  var rows = L.cross.slice();
  rows.sort(function(x, y){
    var a1 = x[7] == null ? -9 : x[7], b1 = y[7] == null ? -9 : y[7];
    return b1 - a1;
  });
  var LIMIT = 25;
  h += '<div class="rssec"><h4>' + C.n_new + ' 个新因子 vs ' + C.n_alpha + ' 个 Alpha101 · 按样本外超额排序</h4>';
  h += '<div class="labtabs" id="labTabs">'
    + '<button data-m="all" class="on">全部 ' + rows.length + '</button>'
    + '<button data-m="sig">两期都显著 ' + C.alive + '</button>'
    + '<button data-m="new">只看新因子 ' + C.n_new + '</button>'
    + '<button data-m="alp">只看 Alpha101 ' + C.n_alpha + '</button>'
    + '</div>';
  h += '<div class="rstwrap"><table class="rstbl labtbl" id="labTbl"><thead><tr>'
    + '<th>因子</th><th style="text-align:left">含义 / 家族</th>'
    + '<th>内 IC</th><th>t</th><th>内超额</th>'
    + '<th>外 IC</th><th>t</th><th>外超额</th></tr></thead><tbody>';
  for (var m = 0; m < rows.length; m++){
    var x = rows[m];
    var isNew = x[1] !== 'Alpha101';
    var sigOk = (x[3] != null && x[3] > 2 && x[4] != null && x[4] > 0
                 && x[6] != null && x[6] > 1.5 && x[7] != null && x[7] > 0) ? 1 : 0;
    var nm = x[8] || (ALPHA_META[x[0]] && ALPHA_META[x[0]].nm) || '';
    h += '<tr data-s="' + sigOk + '" data-n="' + (isNew ? 1 : 0) + '"'
      + (m >= LIMIT ? ' class="labx" style="display:none"' : '') + '>'
      + '<td><b' + (sigOk ? ' style="color:#c2410c"' : '') + '>' + esc(x[0]) + '</b></td>'
      + '<td class="nm">' + esc(nm) + '<br><span class="fam">' + esc(x[1]) + '</span></td>'
      + '<td class="' + cc(x[2]) + '">' + (x[2] == null ? '-' : x[2].toFixed(4)) + '</td>'
      + '<td>' + (x[3] == null ? '-' : x[3].toFixed(2)) + '</td>'
      + '<td class="' + cc(x[4]) + '">' + rsPct(x[4]) + '</td>'
      + '<td class="' + cc(x[5]) + '">' + (x[5] == null ? '-' : x[5].toFixed(4)) + '</td>'
      + '<td>' + (x[6] == null ? '-' : x[6].toFixed(2)) + '</td>'
      + '<td class="' + cc(x[7]) + '"><b>' + rsPct(x[7]) + '</b></td></tr>';
  }
  h += '</tbody></table></div>';
  if (rows.length > LIMIT){
    h += '<div class="rsmore"><button id="labMore" data-open="0">展开全部 '
      + rows.length + ' 个</button></div>';
  }
  h += '<div class="rsnote" style="margin-top:8px">'
    + '<b>样本内筛不出样本外。</b>这 ' + rows.length + ' 个因子里，样本内显著的有 ' + C.sig_in
    + ' 个，但其中只有 ' + C.alive + ' 个在样本外还站得住；反过来，样本外有效的 '
    + (C.alive + C.only_out) + ' 个里有 ' + C.only_out + ' 个样本内根本看不出（t&lt;2 或超额为负）。'
    + '样本内最显著的 <b>MOM_12_1</b>（t=4.5）样本外超额 <b>−4.1%</b>——'
    + 'IC 靠空头端撑起来，而 ETF 融不到券，多头拿不到。<br>'
    + '<b>所以这张表要倒过来读：</b>看样本外那一列，别用样本内排序去挑。'
    + '</div></div>';

  return h;
}

function labBind(){
  var tabs = document.getElementById('labTabs');
  var tbl = document.getElementById('labTbl');
  if (!tabs || !tbl) return;
  var body = tbl.tBodies[0];
  function apply(mode){
    var shown = 0;
    for (var i = 0; i < body.rows.length; i++){
      var r = body.rows[i];
      var ok = mode === 'all' ? true
        : (mode === 'sig' ? r.getAttribute('data-s') === '1'
        : (mode === 'new' ? r.getAttribute('data-n') === '1'
        : r.getAttribute('data-n') === '0'));
      // 筛选后全部展开；回到「全部」时恢复前 25 行
      var vis = ok && (mode !== 'all' || i < 25);
      r.style.display = vis ? '' : 'none';
      if (vis) shown++;
    }
    var more = document.getElementById('labMore');
    if (more) more.style.display = mode === 'all' ? '' : 'none';
    var btns = tabs.getElementsByTagName('button');
    for (var j = 0; j < btns.length; j++){
      btns[j].className = btns[j].getAttribute('data-m') === mode ? 'on' : '';
    }
    return shown;
  }
  tabs.onclick = function(e){
    var b = e.target;
    if (b.tagName !== 'BUTTON') return;
    apply(b.getAttribute('data-m'));
  };
  var more = document.getElementById('labMore');
  if (more){
    more.onclick = function(){
      for (var i = 0; i < body.rows.length; i++) body.rows[i].style.display = '';
      more.style.display = 'none';
    };
  }
}

function renderRs(){
  var R = RESEARCH;
  if (!R) return;
  document.getElementById('rsSub').textContent =
    R.window[0] + ' ~ ' + R.window[1] + ' · Alpha101 ' + R.ic.n
    + (LAB ? ' + 新因子 ' + LAB.counts.n_new : '')
    + ' · 生成 ' + String(R.generated_at || '').replace('T', ' ').slice(0, 16);

  var h = '';

  // ---- 关键数字 ----
  var multi = null, eqLong = null;
  for (var i = 0; i < R.bt.length; i++){
    if (R.bt[i][0].indexOf('101因子等权') === 0 && R.bt[i][0].indexOf('多空') > 0) multi = R.bt[i];
    if (R.bt[i][0].indexOf('全市场等权') === 0) eqLong = R.bt[i];
  }
  h += '<div class="rssec"><h4>关键结论</h4><div class="rsk">'
    + rsCard('因子数', R.ic.n, 'Alpha101 全集')
    + rsCard('IC 为负', R.ic.neg + ' / ' + R.ic.n,
      (R.ic.neg / R.ic.n * 100).toFixed(0) + '% 方向是反的', 'down')
    + rsCard('相关性均值', R.corr.mean.toFixed(3),
      '中位 ' + R.corr.median.toFixed(3) + ' · |ρ|>0.6 占 ' + (R.corr.gt06 * 100).toFixed(1) + '%')
    + rsCard('相关性簇', R.clusters, '阈值 ' + R.cluster_thresh)
    + rsCard('样本外夏普', multi ? multi[4].toFixed(2) : '-',
      '101 因子等权多空 · ' + (multi ? multi[1] : '-') + ' 天', 'down')
    + rsCard('基准（全市场等权）', eqLong ? eqLong[4].toFixed(2) : '-',
      '同期多头 · 年化 ' + (eqLong ? rsPct(eqLong[2]) : '-'))
    + '</div></div>';

  // ---- 样本外回测 ----
  h += '<div class="rssec"><h4>样本外回测 · ' + R.test[0] + ' ~ ' + R.test[1]
    + '（' + R.test_days + ' 个交易日，持有 ' + R.horizon + ' 日）</h4>';
  h += '<div class="rstwrap"><table class="rstbl btbl"><thead><tr><th>策略</th><th>天数</th><th>年化</th>'
    + '<th>年化波动</th><th>夏普</th><th>最大回撤</th><th>胜率</th>'
    + '<th>IC 均值</th><th>IR</th></tr></thead><tbody>';
  for (var k = 0; k < R.bt.length; k++){
    var r = R.bt[k];
    var isBase = r[0].indexOf('全市场等权') === 0;
    h += '<tr' + (isBase ? ' style="color:var(--txt3)"' : '') + '>'
      + '<td>' + r[0] + '</td><td>' + (r[1] == null ? '-' : r[1]) + '</td>'
      + '<td class="' + cc(r[2]) + '">' + rsPct(r[2]) + '</td>'
      + '<td>' + rsPct(r[3]) + '</td>'
      + '<td class="' + cc(r[4]) + '">' + (r[4] == null ? '-' : r[4].toFixed(2)) + '</td>'
      + '<td class="down">' + rsPct(r[5]) + '</td>'
      + '<td>' + (r[6] == null ? '-' : (r[6] * 100).toFixed(1) + '%') + '</td>'
      + '<td>' + (r[7] == null ? '-' : r[7].toFixed(4)) + '</td>'
      + '<td>' + (r[8] == null ? '-' : r[8].toFixed(3)) + '</td></tr>';
  }
  h += '</tbody></table></div></div>';

  // ---- 全部因子 ----
  // 原来只列 IC 最大的 12 个，看着像「就算出这么几个」。实际算了 101 个，
  // 全部摊开、每行都能点开看构造方式，才回答得了「这因子到底在算什么」。
  var rows = R.ic.rows.slice().sort(function(a, b){
    return Math.abs(b[1] || 0) - Math.abs(a[1] || 0);
  });
  var LIMIT = 20;
  h += '<div class="rssec"><h4>全部 ' + rows.length + ' 个因子 · 点任一行看它怎么算'
    + '（按 |IC| 排序）</h4>';
  h += '<div class="rstwrap"><table class="rstbl fxtbl" id="rsAll"><thead><tr><th>因子</th><th>含义</th>'
    + '<th>IC 均值</th><th>IR</th><th>t 值</th><th>胜率</th><th>有效天数</th></tr></thead><tbody>';
  for (var m = 0; m < rows.length; m++){
    var x = rows[m], mi = ALPHA_META[x[0]] || {};
    h += '<tr class="fxr' + (m >= LIMIT ? ' fxx' : '') + '" data-f="' + x[0] + '">'
      + '<td><b>' + x[0] + '</b></td>'
      + '<td class="fxnm">' + esc(mi.nm || '—') + '</td>'
      + '<td class="' + cc(x[1]) + '">' + (x[1] == null ? '-' : x[1].toFixed(4)) + '</td>'
      + '<td>' + (x[2] == null ? '-' : x[2].toFixed(3)) + '</td>'
      + '<td>' + (x[3] == null ? '-' : x[3].toFixed(2)) + '</td>'
      + '<td>' + (x[4] == null ? '-' : (x[4] * 100).toFixed(1) + '%') + '</td>'
      + '<td>' + (x[5] == null ? '-' : x[5]) + '</td></tr>';
  }
  h += '</tbody></table></div>';
  if (rows.length > LIMIT){
    h += '<div class="rsmore"><button id="rsMore" data-open="0" data-n="'
      + rows.length + '">展开全部 ' + rows.length + ' 个</button></div>';
  }
  h += '<div class="rsnote" style="margin-top:8px">IC 均值到 0.03 就算「强」了，'
    + '这里最大的只有 ' + (rows[0] ? Math.abs(rows[0][1]).toFixed(3) : '-')
    + '；而 t 值超过 2 只能说明「不是零」，不代表能赚钱——'
    + '2671 天的样本下，t=2 的因子随手就能找到一堆。'
    + 'IC 为负说明因子和收益方向相反，反着用才有意义。</div></div>';

  // ---- 入选组合 ----
  h += '<div class="rssec"><h4>相关性去重后入选的 ' + R.picks.length + ' 个因子</h4>';
  h += '<div class="rstwrap"><table class="rstbl"><thead><tr><th>因子</th><th>IC 均值</th><th>IR</th>'
    + '<th>t 值</th><th>胜率</th><th>所属簇</th></tr></thead><tbody>';
  for (var p = 0; p < R.picks.length; p++){
    var q = R.picks[p];
    h += '<tr><td>' + q[0] + '</td>'
      + '<td class="' + cc(q[1]) + '">' + q[1].toFixed(4) + '</td>'
      + '<td>' + q[2].toFixed(3) + '</td>'
      + '<td>' + q[3].toFixed(2) + '</td>'
      + '<td>' + (q[4] * 100).toFixed(1) + '%</td>'
      + '<td>' + q[5] + '</td></tr>';
  }
  h += '</tbody></table></div></div>';

  // ---- 第二批：指数去重池（201 个因子的两期对照 + PE 策略） ----
  h += renderLab();

  // ---- 指标说明 ----
  var IND = [
    ['MA20', '20 日移动平均', '价格在均线上方偏强；偏离超过 ±5% 容易回归'],
    ['MA60', '60 日移动平均', '中期趋势线，跌破后反弹常在此受阻'],
    ['RSI14', '14 日相对强弱', '>70 超买、<30 超卖；低波动标的（债券 ETF）在 30~90 间摆动，参考价值有限'],
    ['MACD DIF', '快慢均线差', '在零轴上方说明中期动能偏多'],
    ['MACD DEA', 'DIF 的均线', 'DIF 上穿 DEA 为金叉，下穿为死叉'],
    ['BOLL %B', '价格在布林带中的位置', '0% 贴下轨、100% 贴上轨；突破上下轨说明波动放大'],
    ['ATR14', '14 日平均真实波幅', '换成占价百分比，就是这只标的的「日常抖动幅度」'],
    ['HVOL20', '20 日年化波动率', '股票型 ETF 通常 15~30%，债券型 2~5%'],
    ['量比5', '当日成交量 / 5 日均量', '>1.5 放量，>3 异动，<0.6 缩量']
  ];
  h += '<div class="rssec"><h4>K 线里那 9 个指标怎么看</h4>'
    + '<div class="rstwrap"><table class="rstbl indtbl"><thead><tr><th>指标</th><th style="text-align:left">含义</th>'
    + '<th style="text-align:left">怎么读</th></tr></thead><tbody>';
  for (var n2 = 0; n2 < IND.length; n2++){
    h += '<tr><td>' + IND[n2][0] + '</td>'
      + '<td style="text-align:left;font-family:inherit">' + IND[n2][1] + '</td>'
      + '<td style="text-align:left;font-family:inherit;color:var(--txt2)">' + IND[n2][2] + '</td></tr>';
  }
  h += '</tbody></table></div>'
    + '<div class="rsnote" style="margin-top:8px">'
    + '这 9 个是盯盘时真正看得上眼的。完整算了 <b>56 个指标 + 101 个 Alpha 因子</b>，'
    + '全量存在 Parquet 里给回测用，页面上摊开反而干扰判断。'
    + '每个指标的公式、参数、失效场景见仓库 <b>docs/FACTORS.md</b>。</div></div>';

  // ---- 结论 ----
  h += '<div class="rssec"><h4>怎么读这些数</h4>'
    + '<div class="rsnote">'
    + '<b>结论是「不要用」。</b>训练段（' + R.train[0] + ' ~ ' + R.train[1] + '，'
    + R.train_days + ' 天）夏普 1.21 / 1.61，同几个因子到测试段（'
    + R.test_days + ' 天）变成 −0.67 / −0.71，IC 持续性只有 0.184、同号率 53%——'
    + '和抛硬币分不开。<br><br>'
    + '<b>不是因为因子互相重复。</b>两两相关性均值 ' + R.corr.mean.toFixed(3)
    + '、中位 ' + R.corr.median.toFixed(3) + '，|ρ|>0.6 只有 ' + (R.corr.gt06 * 100).toFixed(1)
    + '%，' + R.ic.n + ' 个因子聚成 ' + R.clusters + ' 簇、其中 60 个是单因子簇——'
    + '它们确实各不相同，只是每个都很弱。弱信号被噪声主导，这叫衰减偏差。'
    + '<br><br>'
    + '<b>ETF 上尤其弱的原因：</b>Alpha101 是给个股设计的，衡量的是「这只股票会跑赢同行多少」。'
    + 'ETF 是一篮子股票，成分股的 alpha 互相抵消，剩下的主要是风格暴露（大小盘、成长价值），'
    + '而风格暴露靠资产配置就能拿到，不需要 101 个因子。<br><br>'
    + '<b>但换个池子，结论变了一半。</b>上面这套是 ' + '1717 只 ETF 的个股口径，'
    + '压到 468 个指数后（同指数只留流动性最好的那只），Alpha101 有 6 个、'
    + '新因子有 3 个在两期里都站得住。其中 PE 单独做多前 20%，2019-06 以来年化 12.68%、'
    + '等权基准 5.44%——代价是 2020 年跑输 13 个点、2025 年只赢 1.6 个点，超额全在下跌年。'
    + '详见下面「第二批」那一节。<br><br>'
    + '<b>所以这个页面的价值在盯盘和 K 线，选股信号只是副产物。</b>'
    + '因子部分留两个记录：个股口径的 101 个跑过了、结论是负的；'
    + '指数口径的换了池子才有信号，而且只活在特定年份。'
    + '</div><div class="rssrc">完整推导见仓库 docs/FACTORS.md（620 行）</div></div>';

  document.getElementById('rsBody').innerHTML = h;
  rsBind();
  labBind();
}

/* 因子详情行。数据来自 ALPHA_META——构建时由 tools/gen_alpha_meta.py
   从 alpha101.py 的 AST 生成，所以这里显示的就是代码里真正在跑的那条式子，
   不是另写一份文档等着过期。 */
function rsDetailRow(id){
  var m = ALPHA_META[id];
  var body = m
    ? '<div class="fxdn"><b>' + esc(id) + '</b>' + esc(m.nm) + '</div>'
      + '<div class="fxds">' + esc(m.ds) + '</div>'
      + '<pre class="fxf">' + esc(m.f) + '</pre>'
    : '<div class="fxdn"><b>' + esc(id) + '</b></div>'
      + '<div class="fxds">这个因子没有录入说明。</div>';
  return '<tr class="fxdet"><td colspan="7"><div class="fxd">' + body + '</div></td></tr>';
}

function rsBind(){
  var tbl = document.getElementById('rsAll');
  if (tbl){
    tbl.onclick = function(e){
      var tr = e.target;
      while (tr && tr.tagName !== 'TR') tr = tr.parentNode;
      if (!tr || !tr.className || tr.className.indexOf('fxdet') >= 0) return;
      var id = tr.getAttribute('data-f');
      if (!id) return;
      var nx = tr.nextElementSibling;
      if (nx && nx.className.indexOf('fxdet') >= 0){   // 再点一次收起
        nx.parentNode.removeChild(nx);
        tr.classList.remove('on');
        return;
      }
      tr.insertAdjacentHTML('afterend', rsDetailRow(id));
      tr.classList.add('on');
    };
  }
  var more = document.getElementById('rsMore');
  if (more){
    more.onclick = function(){
      var open = this.getAttribute('data-open') === '1';
      var next = !open;
      var all = tbl.getElementsByTagName('tr');
      for (var i = 0; i < all.length; i++){
        if (all[i].className.indexOf('fxx') >= 0){
          all[i].style.display = next ? 'table-row' : 'none';
        }
      }
      // 展开时把详情行一起露出，否则点开的构造方式还藏在 display:none 里
      for (var j = 0; j < all.length; j++){
        if (all[j].className.indexOf('fxdet') >= 0) all[j].style.display = next ? 'table-row' : '';
      }
      this.setAttribute('data-open', next ? '1' : '0');
      this.textContent = next ? '收起，只看前 20 个'
        : ('展开全部 ' + (this.getAttribute('data-n') || '全部') + ' 个');
    };
  }
}

/* 内嵌的那份是部署时的快照，先画出来（0ms，断网也有）；再向服务端要当天的。
   远端拿不到就保持现状，不弹错——这个页面不该因为一次请求失败变成空白。 */
function pullResearch(){
  fetch('/api/research').then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.ok === false || !j.ic || !j.bt) return;
    RESEARCH = j;
    var body = document.getElementById('rsBody');
    var top = body.scrollTop;
    renderRs();
    body.scrollTop = top;
  }).catch(function(){});
}

function openRs(){
  if (!document.getElementById('rsBody').innerHTML) renderRs();
  document.getElementById('rsMask').classList.add('on');
}
function closeRs(){
  document.getElementById('rsMask').classList.remove('on');
}
document.getElementById('rsClose').onclick = closeRs;
document.getElementById('rsMask').onclick = function(e){
  if (e.target === this) closeRs();
};

document.getElementById('hSubs').onclick = function(e){
  var b = e.target;
  if (!b || b.tagName !== 'B') return;
  var k = b.getAttribute('data-s');
  if (!k || k === H.sub) return;
  H.sub = k;
  var kids = this.getElementsByTagName('b');
  for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('on', kids[i] === b);
  if (H.d){ hDraw(); hLegend(H.hover); }
};
document.getElementById('hOv').onclick = function(e){
  var b = e.target;
  if (!b || b.tagName !== 'B') return;
  var k = b.getAttribute('data-o');
  if (!k) return;
  H.ov[k] = !H.ov[k];
  b.classList.toggle('on', !!H.ov[k]);
  if (H.d){ hDraw(); hLegend(H.hover); }
};

document.getElementById('hClose').onclick = closeHist;document.getElementById('histMask').onclick = function(e){
  if (e.target === this) closeHist();
};
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  if (document.getElementById('ioMask').classList.contains('on')) { ioClose(); return; }
  if (document.getElementById('trigMask').classList.contains('on')) { trigClose(); return; }
  if (document.getElementById('ovMask').classList.contains('on')) { ovClose(); return; }
  if (document.getElementById('rsMask').classList.contains('on')) { closeRs(); return; }
  if (document.getElementById('histMask').classList.contains('on')) closeHist();
});

document.getElementById('histCv').addEventListener('mousemove', function(e){
  var rect = this.getBoundingClientRect();
  var x = e.clientX - rect.left;
  if (H.mode === 'min'){
    if (!H.mgeo) return;
    var mi = minIdxAt(x);
    if (mi < 0 || mi === H.hover) return;
    H.hover = mi;
    hCrossMin(mi);
    return;
  }
  var g = H.geo; if (!g || !H.d) return;
  var idx = g.i0 + Math.floor((x - g.padL) / g.bw);
  var rng = H.range || H.d.n;
  idx = Math.max(g.i0, Math.min(H.d.n - 1, idx));
  if (idx === H.hover) return;
  H.hover = idx;
  hCross(idx);
});
document.getElementById('histCv').addEventListener('mouseleave', function(){
  if (!H.geo && !H.mgeo) return;
  H.hover = -1;
  H.ctx.setTransform(1,0,0,1,0,0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, H.W, H.Ht);
  hLegend(-1);
});

Array.prototype.forEach.call(document.querySelectorAll('#hMode b'), function(b){
  b.onclick = function(){ setHMode(b.getAttribute('data-m'), false); };
});

/* 展开/收起：用上一次的响应重画，不重新请求——PCF 盘中也变不了，
   为了一次折叠去等 300ms 甚至撞一次上游超时都不值得。
   监听挂在整块 #hHold 上：表头和底部按钮用的是同一个 data-holdm。 */
document.getElementById('hHold').addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('[data-holdm]') : null;
  if (!b) return;
  H.holdAll = b.getAttribute('data-holdm') === '1';
  if (H.hj){
    renderHold(H.hj);
    // 收起时滚回顶部：不然停在 300 行处的滚动位置会落到一段空白上
    if (!H.holdAll) document.getElementById('hHold').scrollTop = 0;
  }
});

Array.prototype.forEach.call(document.querySelectorAll('#hTabs span'), function(t){
  t.onclick = function(){
    Array.prototype.forEach.call(document.querySelectorAll('#hTabs span'), function(x){
      x.classList.remove('on');
    });
    t.classList.add('on');
    H.range = parseInt(t.getAttribute('data-r'), 10);
    H.hover = -1;
    if (H.d){
      hDraw();
      hLegend(-1);
      var note = hAdjNote();
      document.getElementById('hNote').textContent = note;
    }
  };
});

var hResizeTimer = null;
window.addEventListener('resize', function(){
  if (!document.getElementById('histMask').classList.contains('on')) return;
  clearTimeout(hResizeTimer);
  hResizeTimer = setTimeout(function(){
    // 分时用 H.m 而不是 H.d，两个都要认，否则改窗口大小后图会被拉变形
    var ready = (H.mode === 'min') ? !!H.m : !!H.d;
    if (ready){ H.hover = -1; hDraw(); hLegend(-1); }
  }, 140);
});

/* ---------- 数据加载 ---------- */
function setStale(msg, bad){
  var el = document.getElementById('staleBar');
  if (!msg){ el.style.display = 'none'; el.textContent = ''; el.className = 'stalebar'; return; }
  el.style.display = 'block';
  el.className = 'stalebar' + (bad ? ' bad' : '');
  el.textContent = msg;
}

function loadFull(){
  return fetch('/api/all').then(function(r){ return r.json(); }).then(function(j){
    if (!j.raw){ throw new Error(j.error || '无数据'); }
    DATA_SRC = j.src;
    var items = normalize(j.src, j.raw);
    markKeep(items);                 // 先定每组的代表标的，渲染和统计都依赖它
    // 价格变动闪烁依赖前后对比，保留 lastP
    DATA = items;
    STATS = computeStats(items);
    renderOvernight();               // 隔夜卡里映射的 ETF 涨跌跟着快照走
    // 时间以服务端为准：这是「数据本身」的时刻，不是「浏览器收到」的时刻。
    // 上游挂了的时候后端会把旧快照原样发回来并打上 stale，这里必须照实标出来，
    // 而不是盖一个「更新 17:52」让人以为是最新的。
    DATA_TS = j.ts || Date.now();
    if (retryTimer){ clearTimeout(retryTimer); retryTimer = null; }

    var nPre = 0;
    for (var z=0;z<items.length;z++) if (items[z].pre) nPre++;
    var preNote = nPre > items.length * 0.5 ? ' · 非交易时段，现价取昨收' : '';

    var dst = document.getElementById('d-src');
    dst.classList.remove('up','down'); dst.classList.add('up');
    document.getElementById('srcName').textContent = j.src === 'eastmoney' ? '东财' : '新浪';
    document.getElementById('fSrc').textContent = '数据源: '
      + (j.src === 'eastmoney' ? '东方财富（含 IOPV）' : '新浪财经')
      + ' · ' + items.length + ' 只' + preNote;
    document.getElementById('fTs').textContent = (j.stale ? '旧数据 ' : '更新 ')
      + new Date(DATA_TS).toLocaleTimeString('zh-CN');
    document.getElementById('fErr').textContent = '';
    // 横幅贴在卡片下面：表格很长，footer 里的提示根本看不见
    setStale(j.stale
      ? '行情源暂时不可用，正在显示 ' + Math.max(1, Math.round((Date.now() - DATA_TS) / 60000))
        + ' 分钟前的快照，后台自动重试中（自选行情不受影响，走腾讯直连）'
      : '', false);

    var hasPm = items.some(function(x){ return x.pm != null; });
    void hasPm;

    renderCards(); renderList(); renderWatch(); renderSectors();
    // 全市场提醒跟着全量快照走（60 秒一刷），不能挂在 5 秒的自选行情上——
    // 那个只有自选那几十只，扫出来的「全市场」是假的
    alertScanAll();
    // 板块基准和历史是两个来源：基准走 /api/secdaily（KV，60 秒边缘缓存），
    // 首屏不等它——先把涨跌画出来，基准回来再补一次，页面不会白等一个来回
    if (SEC_BASE === null && !SEC_REQ){
      SEC_REQ = true;
      loadSecBase().then(function(){ if (SECS.length) renderSectors(); });
    }
    loadMktSnap();
    hRefresh();                      // 弹窗开着就跟着这次快照重算最后一根
    // 涨速榜的池子是从这份快照里挑的，第一次拿到数据才有得挑
    if (!SPD.rows.length && !SPD.loading) spdFetch();
  }).catch(function(e){
    setStale('行情源暂时不可用（' + e.message + '），15 秒后自动重试；自选行情走腾讯直连，不受影响', true);
    document.getElementById('fErr').textContent = '';
    if (!DATA.length) document.getElementById('listBody').innerHTML =
      '<tr><td colspan="11" class="empty">行情源暂时不可用，正在自动重试…<br>'
      + '<span style="opacity:.55;font-size:12.5px">' + e.message + '</span></td></tr>';
    // 15 秒后自己再试一次，别干等下一个 60 秒周期
    if (!retryTimer) retryTimer = setTimeout(function(){ retryTimer = null; loadFull(); }, 15000);
  });
}

/* 自选高频：浏览器 <script> 直连腾讯
   ---------------------------------------------------------------
   腾讯 qt.gtimg.cn 返回 GBK，Cloudflare Worker 的 TextDecoder 不支持 gbk，
   但浏览器加载外部 <script> 时会按响应头 charset 自动用 GBK 解码，中文正常。
   且 <script> 不受 CORS 限制（返回的是 v_sh510300="..." 这种赋值语句）。
   结果：零后端成本、不消耗 Worker 请求额度、无 CPU 限制的高频通道。 */
function toTX(c){
  if (c.charAt(0) === '5' || c.charAt(0) === '6') return 'sh' + c;
  if (c.charAt(0) === '0' || c.charAt(0) === '1') return 'sz' + c;
  return 'sh' + c;
}

/* ---------- 盘中提醒 ----------
   两个范围，两种说法，因为信噪比差一个数量级：

   自选（默认 5 秒一刷）——逐只报。20 来只，一天越线三五次，报得起，
   而且「我关心的那只出事了」本身就是重点。

   全市场（60 秒一刷）——只报两类：极端个股（2 倍阈值）和每 5 分钟一条汇总。
   400 只按同一阈值逐只弹，一天几百条，弹到第二次就没人看了。全市场要回答的是
   「今天哪条线在动」，不是「第 37 只涨了 2.1%」。

   全市场这条不做 3 分钟急变：数据 60 秒一刷，3 分钟窗口只有 3 个采样点，
   算出来的「急变」是采样误差不是行情。急变只在自选范围有效，这点在提示里写明。

   所有触发都进「今日提醒」记录（浮层只停 9 秒，全市场模式下记录才是主出口）。

   能力边界写在明处：这是**页面内**提醒，标签页关掉就没了。真要做 7×24 推送得配
   Web Push（需要 VAPID 密钥和订阅端点持久化），或走企业微信机器人，那是另一套东西。
   这里不假装自己是推送。 */
var ALERT = { on:false, scope:'watch', chg:2.0, spd:0.8, pm:2.0 };
var ALERT_MUTE = {};          // key -> 上次提醒时间，不落盘
var ALERT_HIT = {};           // 当日已提醒过的 key（涨跌幅这类一天只提一次）
var ALERT_SPD = {};           // code -> [{t,p}]，用来算 3 分钟变化
var ALERT_DAY = new Date().toDateString();
var ALERT_LOG = [];           // 今日触发记录，最多留 200 条
var ALERT_ALL_TS = 0;         // 上次全市场汇总的时间
var ALERT_ALL_GAP = 5 * 60000;

try {
  var aj = localStorage.getItem('etf_alert');
  if (aj){ var ao = JSON.parse(aj);
    ALERT.chg = +ao.chg || 2.0; ALERT.spd = +ao.spd || 0.8; ALERT.pm = +ao.pm || 2.0;
    if (ao.scope === 'all') ALERT.scope = 'all'; }
} catch(e){}

function alertSave(){
  try { localStorage.setItem('etf_alert', JSON.stringify({
    chg:ALERT.chg, spd:ALERT.spd, pm:ALERT.pm, scope:ALERT.scope })); } catch(e){}
}

function alertPush(title, body, cls, key){
  var box = document.getElementById('alertBox');
  var lp = document.getElementById('alertLog');
  // 记录面板开着的时候不弹浮层：两者都在右上角，浮层会正好盖住列表，
  // 而且列表本来就是浮层的完整版——同一件事没必要说两遍。
  var panelOpen = lp && lp.className.indexOf('show') >= 0;
  if (box && !panelOpen){
    var d = document.createElement('div');
    d.className = 'aitem ' + (cls || '');
    d.innerHTML = '<b>' + esc(title) + '</b><small>' + esc(body) + '</small>';
    box.appendChild(d);
    setTimeout(function(){ if (d.parentNode) d.parentNode.removeChild(d); }, 9000);
    while (box.children.length > 4) box.removeChild(box.firstChild);
  }

  ALERT_LOG.push({ t:Date.now(), title:title, body:body, cls:cls || '' });
  if (ALERT_LOG.length > 200) ALERT_LOG = ALERT_LOG.slice(-200);
  var nb = document.getElementById('btnLog');
  if (nb){ nb.style.display = ''; nb.textContent = ALERT_LOG.length + ' 条'; }
  if (lp && lp.className.indexOf('show') >= 0) renderAlertLog();

  if (window.Notification && Notification.permission === 'granted'){
    try { new Notification(title, { body: body, tag: key, silent: false }); } catch(e){}
  }
  if (document.hidden){
    document.title = '● ' + title.replace(/^.*?·/, '') + ' · ETF 盯盘';
  }
}

function renderAlertLog(){
  var body = document.getElementById('logBody');
  var sub = document.getElementById('logSub');
  if (!body) return;
  if (sub) sub.textContent = ALERT.scope === 'all' ? '全市场' : '自选';
  if (!ALERT_LOG.length){
    body.innerHTML = '<div class="le">今天还没有触发过提醒<br>阈值在「提醒 开」右侧可以调</div>';
    return;
  }
  var h = '';
  for (var i=ALERT_LOG.length-1; i>=0; i--){
    var r = ALERT_LOG[i];
    var d = new Date(r.t);
    var hm = (d.getHours()<10?'0':'') + d.getHours() + ':' + (d.getMinutes()<10?'0':'') + d.getMinutes();
    h += '<div class="li ' + r.cls + '"><em>' + hm + '</em><i title="' + esc(r.body) + '">'
      + esc(r.title) + '</i></div>';
  }
  body.innerHTML = h;
}

/* 冷却：同一标的同一类型 10 分钟内只响一次。没有这个，一只票在阈值附近来回抖，
   5 秒一条，比不提醒更糟。 */
function alertCool(key, min){
  var now = Date.now(), last = ALERT_MUTE[key];
  if (last && now - last < (min || 10) * 60000) return false;
  ALERT_MUTE[key] = now;
  return true;
}

function alertScan(items){
  if (!ALERT.on || ALERT.scope !== 'watch' || !isOpen()) return;
  var today = new Date().toDateString();
  if (today !== ALERT_DAY){ ALERT_DAY = today; ALERT_HIT = {}; ALERT_SPD = {}; }

  var now = Date.now();
  for (var c in items){
    var x = items[c];
    if (!x || !isFinite(x.chg)) continue;

    // 1) 当日涨跌幅越线：一天只提一次，否则每 5 秒响一遍
    if (Math.abs(x.chg) >= ALERT.chg){
      var k1 = 'chg|' + c + '|' + ALERT_DAY;
      if (!ALERT_HIT[k1]){
        ALERT_HIT[k1] = 1;
        alertPush(x.n + ' ' + (x.chg > 0 ? '+' : '') + x.chg.toFixed(2) + '%',
          '自选当日涨跌幅越过 ' + ALERT.chg + '% 阈值 · 现价 ' + x.p.toFixed(3),
          x.chg > 0 ? 'up' : 'dn', k1);
      }
    }

    // 2) 3 分钟急变：滚动窗口，超出阈值再按冷却去重
    var arr = ALERT_SPD[c] || (ALERT_SPD[c] = []);
    arr.push({ t: now, p: x.p });
    while (arr.length && now - arr[0].t > 180000) arr.shift();
    if (arr.length >= 3){
      var base = arr[0].p, mv = base > 0 ? (x.p / base - 1) * 100 : 0;
      if (Math.abs(mv) >= ALERT.spd){
        var k2 = 'spd|' + c;
        if (alertCool(k2, 10)){
          alertPush(x.n + ' 3 分钟 ' + (mv > 0 ? '+' : '') + mv.toFixed(2) + '%',
            '从 ' + base.toFixed(3) + ' 到 ' + x.p.toFixed(3) + ' · 成交 ' + fmtAmt(x.amt),
            mv > 0 ? 'up' : 'dn', k2);
        }
      }
    }

    // 3) 溢价越线：跨境 ETF 最容易出事，折价反而是机会，两个方向都提
    if (x.pm != null && isFinite(x.pm) && Math.abs(x.pm) >= ALERT.pm){
      var k3 = 'pm|' + c + '|' + Math.round(x.pm);
      if (alertCool(k3, 30)){
        alertPush(x.n + ' 溢价 ' + (x.pm > 0 ? '+' : '') + x.pm.toFixed(2) + '%',
          (x.pm > 0 ? '场内比净值贵，追高要付溢价' : '场内比净值便宜，注意流动性和限购')
            + ' · IOPV ' + (x.iopv != null ? x.iopv.toFixed(3) : '—'),
          x.pm > 0 ? 'up' : 'dn', k3);
      }
    }
  }
}

/* 全市场：只在「极端」和「汇总」两个尺度上说话。
   单只越 1 倍阈值只是「今天它在动」，400 只里随时有几十只，不构成信息；
   越 2 倍阈值才是「这只出事了」。中间的交给每 5 分钟一条的汇总。 */
/* 全市场提醒扫的池子 = 同指数去重后的代表标的，不是 1719 只全量。
   1719 只里有 1202 只在跟别人跟踪同一个指数（2026-11-07 实测：247 组指数，
   另 270 只没抓到跟踪标的、判断不了重复），日内涨跌幅几乎一样。
   全量扫的直接后果是前 3 名被同一指数的克隆占满——20 只 A500 一起涨 3%，
   榜单等于没给信息。去重后 500 出头，一只一个指数，榜单才是「哪个方向在动」。 */
function alertPool(){
  var arr = [], i, x;
  for (i=0;i<DATA.length;i++){
    x = DATA[i];
    // 停牌、无成交、债券货币类不参与：那几类涨跌幅恒定，扫了也是白扫
    if (!x || !isFinite(x.chg) || !(x.amt > 0) || x.pre) continue;
    if (x.g === 'bond' || x.g === 'money') continue;
    if (!isRep(x)) continue;
    arr.push(x);
  }
  return arr;
}

function alertScanAll(){
  if (!ALERT.on || ALERT.scope !== 'all' || !isOpen()) return;
  if (!DATA.length) return;

  var pool = alertPool();
  var up = [], dn = [], pms = [];
  for (var i=0;i<pool.length;i++){
    var x = pool[i];
    if (x.chg >= ALERT.chg) up.push(x);
    else if (x.chg <= -ALERT.chg) dn.push(x);
    if (x.pm != null && isFinite(x.pm) && Math.abs(x.pm) >= ALERT.pm) pms.push(x);
  }
  up.sort(function(a,b){ return b.chg - a.chg; });
  dn.sort(function(a,b){ return a.chg - b.chg; });

  var ext = [];
  var shout = function(x){
    var k = 'allex|' + x.c + '|' + ALERT_DAY;
    if (ALERT_HIT[k]) return;                   // 同一只今天只报一次
    ALERT_HIT[k] = 1;
    ext.push(x);
    alertPush(x.n + ' ' + fpc(x.chg),
      (x.chg > 0 ? '涨幅' : '跌幅') + '是阈值的 ' + (Math.abs(x.chg)/ALERT.chg).toFixed(1) + ' 倍'
        + ' · 成交 ' + fmtAmt(x.amt) + (x.ix ? ' · 跟踪 ' + x.ix : ''),
      x.chg > 0 ? 'up' : 'dn', k);
  };
  /* 只认「当下最极端的前 3 名」，不是「所有超过 2 倍阈值的」。
     差别很大：极端的日子几十只同时超 4%。按「所有」报，每轮弹出前三名，
     下一轮它们被冷却挡住、就漏出第 4/5/6 名——一路漏到底，等于没上限。
     限定在前 3 名内，超出的只进记录，浮层才不会被淹。 */
  var cand = [];
  for (var a=0;a<up.length && a<3;a++) if (up[a].chg >= ALERT.chg*2) cand.push(up[a]);
  for (var b=0;b<dn.length && b<3;b++) if (dn[b].chg <= -ALERT.chg*2) cand.push(dn[b]);
  cand.sort(function(p,q){ return Math.abs(q.chg) - Math.abs(p.chg); });
  for (var e=0;e<cand.length && ext.length<2;e++) shout(cand[e]);

  // 2) 溢价：跨境最容易出事，全市场只报 1.5 倍以上的偏离，60 分钟冷却
  for (var c=0;c<pms.length && ext.length<3;c++){
    var p = pms[c];
    if (Math.abs(p.pm) < ALERT.pm * 1.5) continue;
    var kp = 'allpm|' + p.c;
    if (!alertCool(kp, 60)) continue;
    ext.push(p);
    alertPush(p.n + ' 溢价 ' + (p.pm>0?'+':'') + p.pm.toFixed(2) + '%',
      (p.pm > 0 ? '场内比净值贵，追高要付溢价' : '场内比净值便宜，注意流动性与限购')
        + (p.iopv != null ? ' · IOPV ' + p.iopv.toFixed(3) : ''),
      p.pm > 0 ? 'up' : 'dn', kp);
  }

  // 3) 汇总：每 5 分钟一条。说清「多少只在动、动得最狠的是哪几只」，
  //    而不是把 40 只逐个念一遍。越线比例过高时改口径——那时「750 只跌超 2%」
  //    已经不是「哪些在动」，是「全市场在跌」，措辞要跟着变。
  if (!up.length && !dn.length) return;
  var now = Date.now();
  if (ALERT_ALL_TS && now - ALERT_ALL_TS < ALERT_ALL_GAP) return;
  ALERT_ALL_TS = now;

  var nb = up.length + dn.length;
  var ratio = pool.length > 0 ? nb / pool.length : 0;
  var mood = ratio > 0.25 ? (dn.length > up.length ? '普跌' : '普涨') : '';
  // 带上去重后的池子大小：否则「12 涨 45 跌」会被读成「1719 只里只有 12 只在涨」，
  // 实际是 517 个指数代表里 12 个在涨——差着一个数量级。
  var head = (mood ? mood + ' · ' : '') + '全市场 ' + pool.length + ' 只中 '
    + up.length + ' 涨 ' + dn.length + ' 跌 越过 ' + ALERT.chg + '%';
  var parts = [];
  var top = up.slice(0, 3).map(function(x){ return x.n + ' ' + fpc(x.chg); });
  if (top.length) parts.push('领涨 ' + top.join('、'));
  var bot = dn.slice(0, 3).map(function(x){ return x.n + ' ' + fpc(x.chg); });
  if (bot.length) parts.push('领跌 ' + bot.join('、'));
  alertPush(head, parts.join(' · '), up.length >= dn.length ? 'up' : 'dn', 'allsum');
}

(function(){
  var btn = document.getElementById('btnAlert');
  var set = document.getElementById('alertSet');
  var scp = document.getElementById('btnScope');
  if (!btn) return;
  var paint = function(){
    btn.className = 'abtn' + (ALERT.on ? ' on' : '');
    btn.innerHTML = ALERT.on ? '<i></i>提醒 开' : '提醒 关';
    set.className = 'aset' + (ALERT.on ? ' show' : '');
    if (scp){
      scp.className = 'abtn' + (ALERT.scope === 'all' ? ' on' : '');
      scp.textContent = '范围 ' + (ALERT.scope === 'all' ? '全市场' : '自选');
    }
  };
  paint();
  var scopeNote = function(){
    return ALERT.scope === 'all'
      ? ' · 60 秒一刷，只报极端个股（2 倍阈值）与每 5 分钟汇总。'
        + '3 分钟急变在全市场不可用——数据 60 秒一刷，算出来的是采样误差不是行情'
      : ' · 5 秒一刷，逐只报';
  };
  btn.onclick = function(){
    ALERT.on = !ALERT.on;
    paint();
    if (ALERT.on){
      ALERT_MUTE = {}; ALERT_SPD = {}; ALERT_ALL_TS = 0;
      var n = ALERT.scope === 'all' ? alertPool().length : (Object.keys(LIVE).length || watch.length);
      alertPush('盯盘提醒已开启',
        '监控 ' + n + ' 只' + (ALERT.scope === 'all' ? '（全市场·同指数去重）' : '自选')
          + ' · 涨跌≥' + ALERT.chg + '% · 溢价≥' + ALERT.pm + '%' + scopeNote(), '', 'on');
      if (ALERT.scope === 'all') alertScanAll();
    }
    if (ALERT.on && window.Notification && Notification.permission === 'default'){
      try { Notification.requestPermission(); } catch(e){}
    }
  };
  if (scp) scp.onclick = function(){
    ALERT.scope = ALERT.scope === 'all' ? 'watch' : 'all';
    ALERT_MUTE = {}; ALERT_SPD = {}; ALERT_ALL_TS = 0; ALERT_HIT = {};
    alertSave(); paint();
    if (ALERT.scope === 'all'){
      toast('范围：全市场 ' + alertPool().length + ' 只（同指数去重）· 只报极端与 5 分钟汇总');
      if (ALERT.on) alertScanAll();      // 切过去立刻跑一轮，别等 60 秒
    } else {
      toast('范围：自选 ' + watch.length + ' 只 · 逐只提醒');
    }
  };
  var bind = function(id, key){
    var el = document.getElementById(id);
    if (!el) return;
    el.onchange = function(){
      var v = parseFloat(this.value);
      if (!isFinite(v) || v <= 0){ this.value = ALERT[key].toFixed(1); return; }
      ALERT[key] = v; alertSave();
      if (key === 'chg'){ ALERT_HIT = {}; ALERT_ALL_TS = 0; }
    };
  };
  bind('aChg','chg'); bind('aSpd','spd'); bind('aPm','pm');
  var pb = document.getElementById('btnPerm');
  if (pb) pb.onclick = function(){
    if (!window.Notification){ toast('这台设备的浏览器不支持桌面通知'); return; }
    Notification.requestPermission().then(function(r){
      toast(r === 'granted' ? '已允许桌面通知' : '通知被拒绝，只能看页面浮层');
    });
  };
  var lg = document.getElementById('btnLog');
  var lp = document.getElementById('alertLog');
  if (lg && lp){
    lg.onclick = function(e){
      e.stopPropagation();
      var on = lp.className.indexOf('show') >= 0;
      renderAlertLog();
      lp.className = on ? '' : 'show';
      // 打开时清掉残留浮层：面板就是浮层的完整版，留着只会遮住列表顶部
      if (!on){ var bx = document.getElementById('alertBox'); if (bx) bx.innerHTML = ''; }
    };
    lp.onclick = function(e){ e.stopPropagation(); };
    document.addEventListener('click', function(){
      if (lp.className.indexOf('show') >= 0) lp.className = '';
    });
    document.getElementById('logClr').onclick = function(){
      ALERT_LOG = []; lg.textContent = '0 条'; lg.style.display = 'none';
      renderAlertLog(); lp.className = '';
    };
  }
})();

document.addEventListener('visibilitychange', function(){
  if (!document.hidden) document.title = 'ETF 全市场盯盘';
});

// 四象限说明浮窗：点 ? 打开，点别处关掉。
// 按钮自己的 onclick 里 stopPropagation 了，所以这里冒泡上来的一定是「点了空白」。
document.addEventListener('click', function(){
  var o = document.querySelector('.scq.open');
  if (o) o.classList.remove('open');
});

/* ================= 散点的点击：每一天都能翻出来看 =================
   灰点不是装饰，250 个点各是一个交易日。原来只有「今天」那一个点有数字，
   想找「上一次宽度这么低是什么时候、那天钱在哪」只能干瞪眼。

   命中判定不用 250 个事件节点：把点击坐标按 data-g 反算回 viewBox，
   在点阵里取最近的一个，屏幕上 16px 内才算点到——避免远处误点跳出一个日子。 */
function scqGeo(svg){
  var g = (svg.getAttribute('data-g') || '').split(',');
  var vb = svg.viewBox && svg.viewBox.baseVal;
  var r = svg.getBoundingClientRect();
  if (g.length < 6 || !vb || !r.width) return null;
  return { x0: +g[0], x1: +g[1], y0: +g[2], y1: +g[3], ylo: +g[4], yhi: +g[5],
           vb: vb, r: r, kx: vb.width / r.width };
}
function scqXY(G, c, b){
  return [G.x0 + Math.max(0, Math.min(100, b)) / 100 * (G.x1 - G.x0),
          G.y1 - (c - G.ylo) / (G.yhi - G.ylo) * (G.y1 - G.y0)];
}
function scqHit(svg, cx, cy){
  var P = SCQ_PTS, G = scqGeo(svg);
  if (!P || !G) return -1;
  var mx = (cx - G.r.left) * G.kx;
  var my = (cy - G.r.top) * (G.vb.height / G.r.height);
  var best = -1, bd = 1e9, i, x, y, p, dx, dy, d2;
  for (i = 0; i < P.C.length; i++){
    p = scqXY(G, P.C[i], P.B[i]); x = p[0]; y = p[1];
    dx = x - mx; dy = y - my; d2 = dx * dx + dy * dy;
    if (d2 < bd){ bd = d2; best = i; }
  }
  return Math.sqrt(bd) <= 16 * G.kx ? best : -1;
}
function scqRing(svg, sel){
  var g = svg.querySelector('.scqs');
  if (!g) return;
  while (g.firstChild) g.removeChild(g.firstChild);
  var P = SCQ_PTS, G = scqGeo(svg);
  if (!P || !G || sel < 0) return;
  var p = scqXY(G, P.C[sel], P.B[sel]);
  var NS = 'http://www.w3.org/2000/svg';
  // 白圈描边 + 外圈灰：点云密的时候单环会跟邻居粘成一片
  [[10, 'none', '#fff', 3.2], [10, 'none', '#6b7280', 1.3]].forEach(function (a) {
    var c = svg.ownerDocument.createElementNS(NS, 'circle');
    c.setAttribute('cx', p[0].toFixed(1)); c.setAttribute('cy', p[1].toFixed(1));
    c.setAttribute('r', a[0]); c.setAttribute('fill', a[1]);
    c.setAttribute('stroke', a[2]); c.setAttribute('stroke-width', a[3]);
    g.appendChild(c);
  });
}
function scqShow(svg, sel){
  var P = SCQ_PTS;
  var card = svg.closest ? svg.closest('.scq') : null;
  if (!P || !card) return;
  var list = card.querySelectorAll('.scqplot svg'), i;
  for (i = 0; i < list.length; i++) scqRing(list[i], sel);
  var bar = card.querySelector('.scqtip');
  if (!bar) return;
  if (sel < 0){
    bar.className = 'scqtip'; bar.innerHTML = ''; card.removeAttribute('data-sel'); return;
  }
  var hi = P.I[sel], d = P.D[hi];
  var c = P.C[sel], b = P.B[sel], u = P.U[hi] || 0, w = P.W[hi] || 0;
  var nm = (P.T[sel] || []).map(function (k) { return P.IND[k] || ''; })
    .filter(function (x) { return !!x; });
  var cq = mktPct(P.RC, c), bq = mktPct(P.RB, b);
  var wd = '日一二三四五六'.charAt(new Date(d + 'T00:00:00+08:00').getUTCDay());
  // 跟今天比：单看「那天 15.5%」没有参照，加减量才读得出这次是不是更极端
  // 跟今天比用带符号的差值，不用「更集中／更分散」——两个词要配对读，
  // 而「集中度 +5.5pt」一眼就知道方向。
  var dc = P.CONC - c, db = P.BRD - b, dcs = [];
  if (Math.abs(dc) >= 0.5) dcs.push('集中度 ' + (dc > 0 ? '+' : '−') + Math.abs(dc).toFixed(1) + 'pt');
  if (Math.abs(db) >= 0.5) dcs.push('宽度 ' + (db > 0 ? '+' : '−') + Math.abs(db).toFixed(1) + 'pt');

  bar.innerHTML = '<b>' + d.slice(5) + '</b> 周' + wd
    + ' · 集中 <i>' + c.toFixed(1) + '%</i><em>（' + (cq != null ? cq.toFixed(0) + ' 分位' : '—') + '）</em>'
    + ' · 宽度 <i>' + b.toFixed(0) + '%</i><em>（' + u + ' 涨 ' + w + ' 跌'
    + (bq != null ? '，' + bq.toFixed(0) + ' 分位' : '') + '）</em>'
    + (nm.length ? '<br>领涨 <b>' + nm.join('、') + '</b>' : '')
    + (dcs.length ? ' <em>较今天 ' + dcs.join('、') + '</em>' : '')
    + ' <em class="esc">再点一次取消</em>';

  // 浮窗锚在被点的点上：坐标用 viewBox 百分比（两套画布同一容器，百分比通用），
  // 靠右翻到左边、靠下翻到上面，否则 390px 屏上会裁出去。
  var G = scqGeo(svg);
  if (G){
    var p = scqXY(G, c, b);
    var px = p[0] / G.vb.width * 100, py = p[1] / G.vb.height * 100;
    bar.style.left = px.toFixed(1) + '%';
    bar.style.top = py.toFixed(1) + '%';
    bar.className = 'scqtip on' + (px > 60 ? ' rx' : '') + (py > 52 ? ' ry' : '');
  } else bar.className = 'scqtip on';
  card.setAttribute('data-sel', sel);
}
document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t || !t.closest) return;
  var svg = t.closest('.scqplot svg');
  if (svg){
    var hit = scqHit(svg, e.clientX, e.clientY);
    var card = svg.closest('.scq');
    var cur = card.getAttribute('data-sel');
    scqShow(svg, (hit >= 0 && String(hit) === cur) ? -1 : hit);
    return;
  }
  if (!t.closest('.scq')){
    var o = document.querySelector('.scq[data-sel]');
    if (o){ var s0 = o.querySelector('.scqplot svg'); if (s0) scqShow(s0, -1); }
  }
});
document.addEventListener('mousemove', function (e) {
  var t = e.target;
  if (!t || !t.closest) return;
  var svg = t.closest('.scqplot svg');
  if (svg) svg.style.cursor = scqHit(svg, e.clientX, e.clientY) >= 0 ? 'pointer' : 'crosshair';
});

function loadTXQuotes(){
  if (!watch.length) return;
  var tx = [];
  for (var w=0; w<watch.length; w++) tx.push(toTX(watch[w]));
  var s = document.createElement('script');
  s.src = 'https://qt.gtimg.cn/q=' + tx.join(',') + '&_=' + Date.now();
  var done = false;
  var finish = function(){ if (!done){ done = true; try { s.remove(); } catch(e){} } };

  s.onload = function(){
    if (done) return;
    var out = {};
    for (var i=0;i<tx.length;i++){
      var tc = tx[i];
      var v = window['v_' + tc];
      if (!v) continue;
      var a = v.split('~');
      if (a.length < 40) continue;
      var p = +a[3];
      if (!p) continue;
      var code = tc.replace(/^(sh|sz)/, '');
      out[code] = { c:code, n:a[1], p:p, pc:+a[4], chg:+a[32],
        amt:(+a[37])*1e4, tr:+a[38], hi:+a[33], lo:+a[34], op:+a[5],
        iopv:null, pm:null, mc:0, g:group(a[1]), ix: IX_OF[code] || null };
    }
    if (Object.keys(out).length){
      LIVE = out;
      renderWatch();
      alertScan(out);
      trigScan(out);
      hRefresh();                    // 自选 5 秒一刷，弹窗里那只也一起动
      var tip = document.getElementById('quoteTip');
      if (tip) tip.textContent = '自选经浏览器直连腾讯 · ' + (isOpen()?'5 秒':'30 秒')
        + '刷新 · ' + new Date().toLocaleTimeString('zh-CN');
    }
    finish();
  };
  s.onerror = function(){
    if (done) return;
    var tip = document.getElementById('quoteTip');
    if (tip) tip.textContent = '腾讯直连失败，自选跟随全市场数据 · '
        + new Date().toLocaleTimeString('zh-CN');
    finish();
  };
  document.head.appendChild(s);
  setTimeout(finish, 6000);
}

function schedule(){
  clearInterval(timerSlow); clearInterval(timerFast); clearInterval(timerSpd);
  clearInterval(timerT3);
  var open = isOpen();
  // 全市场：交易时段 60 秒，非交易 300 秒（保护新浪上游，避免被风控）
  timerSlow = setInterval(loadFull, open ? 60000 : 300000);
  // 自选高频：浏览器直连腾讯，不经过 Worker，5 秒一次也不消耗任何配额
  timerFast = setInterval(loadTXQuotes, open ? 5000 : 30000);
  /* 涨速榜 30 秒一轮，和 /api/min 的 30 秒分桶对齐——再密也只是反复命中
     同一个缓存桶。服务端已经对同一批代码做 30 秒缓存，这里多刷一次不会
     多打一次上游；真正省的是「切到后台标签页时停掉」。 */
  timerSpd = setInterval(function(){
    if (isOpen() && !spdClosed() && document.visibilityState !== 'hidden') spdFetch();
  }, 30000);
  /* 「主要贡献」60 秒一轮，和 /api/top3 的 60 秒分桶对齐。带 force 走一遍：
     指纹没变时 ensureTop3 会直接返回，这里要的是「同一份自选重算一次」。
     切到后台标签页时跳过——它比行情重得多（每轮要拉上千只成分的行情）。 */
  clearInterval(timerT3);
  timerT3 = setInterval(function(){
    if (!watch.length || document.visibilityState === 'hidden') return;
    if (TOP3_BUSY) return;
    runTop3(watch.slice(0, 30));
  }, 60000);
}

/* ---------- 事件 ---------- */
document.getElementById('btnAdd').onclick = function(){
  var v = document.getElementById('addIn').value.trim();
  if (!v) return;
  var codes = v.split(/[\\\\s,，]+/).map(function(s){ return s.trim().replace(/^(sh|sz|hk)/i,''); }).filter(Boolean);
  var n = 0;
  codes.forEach(function(c){
    if (!/^\\\\d{5,6}$/.test(c)){ toast('代码格式不对: '+c); return; }
    if (watch.indexOf(c) >= 0){ toast(c+' 已在自选'); return; }
    watch.push(c); n++;
  });
  if (n){ saveWatch(); document.getElementById('addIn').value=''; toast('已添加 '+n+' 只');
    renderWatch(); loadTXQuotes(); }
};
document.getElementById('addIn').addEventListener('keydown', function(e){
  if (e.key === 'Enter') document.getElementById('btnAdd').click();
});
document.getElementById('btnClear').onclick = function(){
  watch = []; LIVE = {}; saveWatch(); renderWatch(); toast('已清空自选');
};

/* ---------- 自选导入 / 导出 ----------
   上一版这里是「同步」：复制一条 /?u=编号 的链接，换台设备打开就变成这份自选。
   问题在于那条链接本身就是写权限——本来发给自己的链接，顺手转给别人、贴到群里，
   对方加一只删一只都会写进你的桶。为了搬一次家留一个永久后门，不划算。
   换成纯文本：谁拿到这串代码都只能自己粘，改不动你的。 */
/* ================= 隔夜映射卡 =================
   盘前 8:30 打开页面，第一个问题是「隔夜发生了什么」。这条链路把美股收盘和
   外盘期货按「赛道」折算到 A 股 ETF：

   - 美股/期货行情来自 /api/overnight（Worker 代理，边缘缓存 10 分钟）；
   - 赛道 → ETF 的映射用的是 IDX_GROUPS（跟踪指数名 → 全部跟踪该指数的 ETF），
     和「同指数去重」同一份数据。每个赛道列几个候选指数，从每个指数里挑出
     展示标的：自选优先 → 代表标的 → 成交额最大。映射写死具体代码会漂
     （ETF 会换名、发新的），写指数名永远是有效引用。
   - A 股 ETF 的当日涨跌直接取 DATA：开盘前显示的是昨收涨跌（页面会标
     「非交易时段」），盘中就是实时值。它回答「映射的这只现在什么价」，
     不回答「开盘会怎么开」——后者没有人知道。

   颜色统一用 A 股习惯：涨红跌绿，美股数据进来也一样，页面迁就读者的眼睛。 */
var ON = null;               // /api/overnight 的响应 {us, fut, ts}
var ON_SEL = null;           // 展开详情的赛道 key
var ON_FOLD = false;
try { ON_FOLD = localStorage.getItem('etf_onfold') === '1'; } catch(e){}

var ON_TRACKS = [
  { k:'chip',  n:'算力芯片',    us:['NVDA','AMD','AVGO','TSM','MRVL'],
    ix:['中证全指半导体产品与设备','国证半导体芯片','中证芯片产业','中华交易服务半导体芯片行业'] },
  { k:'equip', n:'芯片设备',    us:['AMAT','LRCX','KLAC','ASML'],
    ix:['中证半导体材料设备主题','上证科创板半导体材料设备主题','中证半导体产业'] },
  { k:'opt',   n:'光通信',      us:['ANET','COHR','CIEN','LITE','FN'],
    ix:['中证全指通信设备','中证5G通信主题','国证通信','中证通信设备主题'] },
  { k:'cloud', n:'云平台',      us:['MSFT','GOOG','AMZN','META','ORCL','SNOW'],
    ix:['中证计算机主题','中证云计算与大数据主题','中证全指软件','中证大数据产业'] },
  { k:'app',   n:'AI 应用',     us:['ADBE','CRM','NOW','PLTR','APP'],
    ix:['中证人工智能主题','中证人工智能产业','创业板人工智能','上证科创板人工智能'] },
  { k:'pow',   n:'电力能源',    us:['VST','CEG','TLN','NRG','GEV'],
    ix:['中证全指电力公用事业','国证绿色电力','中证绿色电力'] },
  { k:'hw',    n:'消费电子',    us:['AAPL','DELL','SMCI'],
    ix:['国证消费电子主题','中证消费电子主题','中证电子','中证电子50'] },
  { k:'bot',   n:'机器人/智驾', us:['TSLA','UBER'],
    ix:['中证机器人','国证机器人产业','中证智能汽车主题','中证智能电动汽车'] },
  { k:'hk',    n:'中概/港股科技', us:['BABA','JD','PDD','BIDU','NTES'],
    ix:['恒生科技','中证海外中国互联网50','中证海外中国互联网30','恒生互联网科技业'] },
  { k:'ph',    n:'全球创新药',  us:['LLY','MRK','AZN','NVO','PFE'],
    ix:['中证香港创新药','国证港股通创新药','中证港股通创新药','中证创新药产业','恒生创新药'] }
];
var ON_HEAD = ['NDX', 'INX', 'DJI'];     // 美股三大指数，摆在前排不当赛道
var ON_FUT_ORDER = ['hf_NQ', 'hf_CHA50CFD', 'hf_GC', 'hf_CL'];
/* 点条目看分时：东财 trends2 的 secid。美股三大指数在腾讯叫 usNDX/usINX/usDJI，
   到东财那边是另一套代码（纳指综合 100.NDX、标普 100.SPX、道指 100.DJIA），
   形状一致、名字有差（综合 vs 100），图上以数据自身为准。 */
var ON_SECID = { NDX:'100.NDX', INX:'100.SPX', DJI:'100.DJIA',
  'hf_NQ':'103.NQ00Y', 'hf_CHA50CFD':'104.CN00Y', 'hf_GC':'101.GC00Y', 'hf_CL':'102.CL00Y' };

function onCls(v){ return v > 0.05 ? 'up' : (v < -0.05 ? 'down' : ''); }
function onTxt(v){ return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

/** 可点分时的条目：名字 + 涨跌 + data-ovsid */
function ovChip(n, chg, sid){
  return '<span class="ovclk" data-ovsid="' + sid + '" data-ovnm="' + esc(n) + '" title="点看分时">'
    + esc(n) + ' <b class="' + onCls(chg) + '">' + onTxt(chg) + '</b></span>';
}

/* 分时弹窗：东财 trends2 最近一个完整时段。美股/期货拿到的是昨晚那场，
   亚太是今天。y 轴全自适应 + 首点虚线做基准——基准用开盘价而不是昨收，
   因为这条线回答的是「这一场里怎么走」，不是「今天涨多少」（涨跌幅已在卡上）。 */
function ovOpen(sid, nm){
  var mask = document.getElementById('ovMask');
  var body = document.getElementById('ovBody');
  document.getElementById('ovTitle').textContent = nm + ' 分时';
  document.getElementById('ovSub').textContent = sid;
  body.innerHTML = '<div class="iotip">读取中…</div>';
  mask.classList.add('on');
  fetch('/api/ovmin?sid=' + encodeURIComponent(sid)).then(function(r){ return r.json(); })
    .then(function(j){
      if (!j.ok) throw new Error(j.error || '无数据');
      body.innerHTML = ovChartSvg(j.pts);
    })
    .catch(function(e){
      body.innerHTML = '<div class="iotip">分时读取失败：' + esc(e.message || e) + '</div>';
    });
}
function ovClose(){ document.getElementById('ovMask').classList.remove('on'); }
document.getElementById('ovClose').onclick = ovClose;
document.getElementById('ovMask').onclick = function(e){ if (e.target === this) ovClose(); };

function ovChartSvg(pts){
  var W = 680, H = 230, ml = 10, mr = 64, mt = 12, mb = 20;
  var step = Math.max(1, Math.ceil(pts.length / 240));
  var s = [], i;
  for (i = 0; i < pts.length; i += step) s.push(pts[i]);
  if (s[s.length - 1] !== pts[pts.length - 1]) s.push(pts[pts.length - 1]);

  var mn = s[0][1], mx = s[0][1];
  for (i = 1; i < s.length; i++){ if (s[i][1] < mn) mn = s[i][1]; if (s[i][1] > mx) mx = s[i][1]; }
  var pad = (mx - mn) * 0.1 || mx * 0.002;
  var lo = mn - pad, hi = mx + pad;
  var xOf = function(k){ return ml + k / (s.length - 1) * (W - ml - mr); };
  var yOf = function(v){ return mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb); };

  var up = s[s.length - 1][1] >= s[0][1];
  var col = up ? 'var(--up)' : 'var(--down)';
  var d = '';
  for (i = 0; i < s.length; i++) d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(s[i][1]).toFixed(1);
  var area = d + 'L' + xOf(s.length - 1).toFixed(1) + ' ' + (H - mb) + 'L' + ml + ' ' + (H - mb) + 'Z';
  var baseY = yOf(s[0][1]).toFixed(1);
  var fmt = function(v){ return v >= 1000 ? v.toFixed(0) : (v >= 10 ? v.toFixed(2) : v.toFixed(4)); };
  var chg = (s[s.length-1][1] / s[0][1] - 1) * 100;

  var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">'
    + '<line x1="' + ml + '" y1="' + baseY + '" x2="' + (W - mr) + '" y2="' + baseY
    + '" stroke="var(--txt3)" stroke-dasharray="3 3" stroke-width="0.8"/>'
    + '<path d="' + area + '" fill="' + col + '" opacity="0.08"/>'
    + '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.6"/>'
    + '<circle cx="' + xOf(s.length - 1).toFixed(1) + '" cy="' + yOf(s[s.length - 1][1]).toFixed(1)
    + '" r="2.6" fill="' + col + '"/>'
    + '<text x="' + ml + '" y="' + (H - 6) + '" font-size="10" fill="var(--txt3)">' + esc(s[0][0]) + '</text>'
    + '<text x="' + (W - mr) + '" y="' + (H - 6) + '" font-size="10" fill="var(--txt3)" text-anchor="end">' + esc(s[s.length - 1][0]) + '</text>'
    + '<text x="' + (W - mr + 4) + '" y="' + (yOf(mx) + 4).toFixed(1) + '" font-size="10.5" fill="var(--txt2)">' + fmt(mx) + '</text>'
    + '<text x="' + (W - mr + 4) + '" y="' + (yOf(lo) + 4).toFixed(1) + '" font-size="10.5" fill="var(--txt2)">' + fmt(lo) + '</text>'
    + '<text x="' + (W - mr + 4) + '" y="' + (yOf(s[s.length - 1][1]) + 4).toFixed(1) + '" font-size="11" font-weight="bold" fill="' + col + '">'
    + fmt(s[s.length - 1][1]) + '</text>'
    + '</svg>'
    + '<div class="ovmeta"><span>场内 <b class="' + (up ? 'up' : 'down') + '">' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '%</b></span>'
    + '<span>基准＝本时段开盘 ' + fmt(s[0][1]) + '</span>'
    + '<span>' + s.length + ' 个点 · ' + (s.length >= pts.length ? '' : '按 ' + step + ' 抽 1 显示') + '</span></div>';
  return h;
}

function loadOvernight(){
  fetch('/api/overnight').then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok) throw new Error(j.error || '无数据');
    ON = j;
    renderOvernight();
  }).catch(function(){ /* 隔夜卡拿不到就保持隐藏，不占位 */ });
}

/** 从一个跟踪指数里挑展示标的：自选优先，其次代表标的，最后成交额最大 */
function onPickIx(ixName){
  var codes = (typeof IDX_GROUPS !== 'undefined' && IDX_GROUPS[ixName]) || [];
  var best = null;
  for (var i=0;i<codes.length;i++){
    var it = findItem(codes[i]);
    if (!it || !isFinite(it.chg) || !(it.amt > 0)) continue;
    if (it.g === 'bond' || it.g === 'money') continue;
    var mine = watch.indexOf(codes[i]) >= 0;
    if (!best) best = { it:it, mine:mine, r:mine ? 3 : (isRep(it) ? 2 : 1) };
    else {
      var r = mine ? 3 : (isRep(it) ? 2 : 1);
      if (r > best.r || (r === best.r && it.amt > best.it.amt)) best = { it:it, mine:mine, r:r };
    }
  }
  return best;
}

/** 赛道 → 展示 ETF（跨指数去重，最多 3 只） */
function onEtfs(trk){
  var out = [], seen = {};
  for (var i=0;i<trk.ix.length && out.length<3;i++){
    var p = onPickIx(trk.ix[i]);
    if (p && !seen[p.it.c]){ seen[p.it.c] = 1; out.push({ c:p.it.c, n:p.it.n, chg:p.it.chg, mine:p.mine }); }
  }
  return out;
}

function onChgOf(trk){
  if (!ON || !ON.us) return null;
  var s = 0, n = 0;
  for (var i=0;i<trk.us.length;i++){
    var q = ON.us['us' + trk.us[i].toLowerCase()];
    if (q && isFinite(q.chg)){ s += q.chg; n++; }
  }
  return n ? s / n : null;
}

function renderOvernight(){
  var el = document.getElementById('onCard');
  if (!el) return;
  if (!ON || !ON.us){ el.style.display = 'none'; return; }

  // 美东日期取任意一条美股记录的（同一次响应里它们一致）
  var d = '';
  for (var k in ON.us){ d = (ON.us[k].d || '').slice(5, 10); break; }
  var h = '<div class="onhd"><b>隔夜</b>'
    + (d ? '<span class="n">美东 ' + esc(d) + ' 收盘 · 点赛道看映射</span>' : '<span class="n">点赛道看映射</span>')
    + '<span class="ofold" id="onFold">' + (ON_FOLD ? '展开' : '收起') + '</span></div>';

  var fut = '', i, q;
  for (i=0;i<ON_HEAD.length;i++){
    q = ON.us['us' + ON_HEAD[i].toLowerCase()];
    if (q) fut += ovChip(q.n, q.chg, ON_SECID[ON_HEAD[i]]);
  }
  if (ON.fut){
    for (i=0;i<ON_FUT_ORDER.length;i++){
      q = ON.fut[ON_FUT_ORDER[i]];
      if (q) fut += ovChip(q.n, q.chg, ON_SECID[ON_FUT_ORDER[i]]);
    }
  }
  h += '<div class="onfut">' + fut + '</div>';

  if (!ON_FOLD){
    h += '<div class="ontrks">';
    for (i=0;i<ON_TRACKS.length;i++){
      var t = ON_TRACKS[i], v = onChgOf(t);
      if (v == null) continue;
      h += '<span class="ontrk' + (ON_SEL === t.k ? ' sel' : '') + '" data-onk="' + t.k
        + '" title="' + esc(t.us.join(' · ')) + '（隔夜均涨跌）"><b>' + esc(t.n) + '</b>'
        + '<i class="' + onCls(v) + '">' + onTxt(v) + '</i></span>';
    }
    h += '</div>';
    var det = '';
    for (i=0;i<ON_TRACKS.length;i++){
      if (ON_SEL !== ON_TRACKS[i].k) continue;
      var t2 = ON_TRACKS[i];
      det += '<div class="ondet"><div class="ot">隔夜成分</div><div class="ous">';
      for (var j=0;j<t2.us.length;j++){
        var qq = ON.us['us' + t2.us[j].toLowerCase()];
        if (qq) det += '<span>' + esc(qq.n) + ' <b class="' + onCls(qq.chg) + '">' + onTxt(qq.chg) + '</b></span>';
      }
      det += '</div><div class="ot">映射到 A 股（自选优先' + (isOpen() ? '' : ' · 非交易时段显示昨收') + '）</div><div class="oetfs">';
      var ets = onEtfs(t2);
      if (!ets.length) det += '<span class="n" style="color:var(--txt3)">行情还没就绪，稍后自动补上</span>';
      for (j=0;j<ets.length;j++){
        var e2 = ets[j];
        det += '<span' + (e2.mine ? ' class="mine" title="在你的自选里"' : '')
          + '>' + esc(e2.n) + ' ' + e2.c
          + ' <b class="' + onCls(e2.chg) + '">' + onTxt(e2.chg) + '</b></span>';
      }
      det += '</div></div>';
    }
    h += det;
  }
  el.innerHTML = h;
  el.style.display = '';

  // 亚太卡：独立一块，排在隔夜下面。今天已经在交易（或刚收盘）的市场，
  // 和隔夜（昨晚美股）正好互补；点条目看最近一个完整时段的分时。
  var ac = document.getElementById('asiaCard');
  if (!ac) return;
  if (ON.asia && ON.asia.length){
    var ap = '';
    for (i=0;i<ON.asia.length;i++){
      q = ON.asia[i];
      ap += ovChip(q.n, q.chg, q.sid);
    }
    ac.innerHTML = '<div class="onhd"><b>亚太</b><span class="n">今日实时 · 点看分时</span></div>'
      + '<div class="onfut">' + ap + '</div>';
    ac.style.display = '';
  } else {
    ac.style.display = 'none';
  }
}

document.addEventListener('click', function(e){
  var ov = e.target && e.target.closest ? e.target.closest('[data-ovsid]') : null;
  if (ov){
    ovOpen(ov.getAttribute('data-ovsid'), ov.getAttribute('data-ovnm') || ov.getAttribute('data-ovsid'));
    return;
  }
  var trk = e.target && e.target.closest ? e.target.closest('.ontrk') : null;
  if (trk){
    var k = trk.getAttribute('data-onk');
    ON_SEL = (ON_SEL === k) ? null : k;
    renderOvernight();
    return;
  }
  if (e.target && e.target.id === 'onFold'){
    ON_FOLD = !ON_FOLD;
    try { localStorage.setItem('etf_onfold', ON_FOLD ? '1' : '0'); } catch(err){}
    renderOvernight();
  }
});

/* ================= 自定义组合触发器 =================
   固定阈值提醒回答「它动得够不够大」，触发器回答「我等的那个组合条件到了没」。
   条件之间是且的关系，全部满足才算命中；边沿触发——从「不满足」翻成「满足」
   那一刻响一次，持续满足不重复（否则距新高 <1% 这种条件会一直挂着一直响），
   加 30 分钟冷却兜底条件的抖动。规则存 localStorage：它和自选清单不同，
   是「本机盯盘习惯」，不值得进云端。

   数据面零新增：涨跌/溢价/成交额来自 5 秒一刷的实时快照，位置/量能/距高距低
   复用位置诊断的 DIAG（历史已在手上，重算是纯浮点运算）。带 ⏳ 的字段在
   DIAG 就绪前一律判 false，不猜。 */
var TRIG = [];
var TRIG_ST = {};            // '规则序号|code' -> 上次是否满足
try {
  var _tj = JSON.parse(localStorage.getItem('etf_trig') || '[]');
  if (Array.isArray(_tj)) TRIG = _tj;
} catch(e){}

var TRIG_FIELDS = {
  chg: { n:'当日涨跌幅', u:'%', g:1, hint:'当天涨跌 %，正=涨' },
  pm:  { n:'溢价率',     u:'%', g:1, hint:'现价对 IOPV 的溢价 %，跨境 ETF 出事故的都是这个字段' },
  amt: { n:'成交额',     u:'亿', g:1, hint:'当日成交额（亿元）' },
  evr: { n:'量能倍数',   u:'×', g:0, hint:'今日量 ÷ 前 20 日均量（按交易进度折算），2 = 放了一倍量' },
  pos: { n:'一年位置',   u:'分位', g:0, hint:'现价在近一年高低区间的百分位，0=一年新低 100=一年新高' },
  dhi: { n:'距一年新高', u:'%', g:0, hint:'现价距一年最高价的 %，永远 ≤0；≥-1 就是「贴新高 1% 以内」' },
  dlo: { n:'距一年新低', u:'%', g:0, hint:'现价距一年最低价的 %，永远 ≥0；≥10 就是「离开低点至少 10%」' },
  pe:  { n:'路径效率',   u:'',  g:0, hint:'20 日净涨幅 ÷ 20 日路径长度，-1~1；>0.6 是单边拉，<0.2 是震荡堆' },
  r20: { n:'20日涨幅',   u:'%', g:0, hint:'相对 20 个交易日前的累计涨跌 %' }
};
var TRIG_F_ORDER = ['chg','pm','amt','dhi','dlo','pos','evr','pe','r20'];

function trigSave(){
  try { localStorage.setItem('etf_trig', JSON.stringify(TRIG)); } catch(e){}
}
function trigCount(){ var n=0; for (var i=0;i<TRIG.length;i++) if (TRIG[i].on && TRIG[i].cs && TRIG[i].cs.length) n++; return n; }
function renderTrigCount(){
  var b = document.getElementById('btnTrig');
  if (b) b.textContent = '触发器 ' + trigCount();
}
function trigCondTxt(cd){
  var f = TRIG_FIELDS[cd[0]] || { n:'?', u:'' };
  return f.n + (cd[1] === '>=' ? ' ≥ ' : ' ≤ ') + cd[2] + f.u;
}

function trigScan(items){
  if (!ALERT.on || !TRIG.length || !isOpen()) return;
  for (var i=0;i<TRIG.length;i++){
    var r = TRIG[i];
    if (!r.on || !r.cs || !r.cs.length) continue;
    for (var c in items){
      var x = items[c];
      if (!x || !isFinite(x.chg)) continue;
      var d = DIAG[c], ok = true, parts = [];
      for (var j=0;j<r.cs.length;j++){
        var cd = r.cs[j], f = TRIG_FIELDS[cd[0]];
        if (!f){ ok = false; break; }
        var v = null;
        if (f.g === 1){
          if (cd[0] === 'chg') v = x.chg;
          else if (cd[0] === 'pm') v = x.pm;
          else if (cd[0] === 'amt') v = x.amt != null ? x.amt / 1e8 : null;
        } else if (d && d.ok){
          if (cd[0] === 'evr') v = d.evr;
          else if (cd[0] === 'pos') v = d.pos;
          else if (cd[0] === 'dhi') v = d.dHi != null ? d.dHi * 100 : null;
          else if (cd[0] === 'dlo') v = d.dLo != null ? d.dLo * 100 : null;
          else if (cd[0] === 'pe') v = d.pe;
          else if (cd[0] === 'r20') v = d.r20 != null ? d.r20 * 100 : null;
        }
        if (v == null || !isFinite(v)){ ok = false; break; }   // 数据没到位不猜
        if (cd[1] === '>=' ? !(v >= cd[2]) : !(v <= cd[2])){ ok = false; break; }
        parts.push(f.n + ' ' + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) + f.u);
      }
      var key = i + '|' + c;
      if (!ok){ TRIG_ST[key] = 0; continue; }
      if (TRIG_ST[key]) continue;                 // 持续满足只算一次
      TRIG_ST[key] = 1;
      if (!alertCool('trig|' + key, 30)) continue;
      alertPush(x.n + ' 命中触发器', '条件全满足：' + parts.join(' · '), 'up', 'trig|' + key);
    }
  }
}

function trigRender(){
  var box = document.getElementById('trigList');
  if (!box) return;
  if (!TRIG.length){
    box.innerHTML = '<div class="iotip">还没有规则。点「+ 新建规则」拼一组条件，'
      + '比如：距一年新高 ≥ -1 且 量能倍数 ≥ 2 —— 一贴新高就放量，典型的高位换手信号。</div>';
    renderTrigCount();
    return;
  }
  var h = '';
  for (var i=0;i<TRIG.length;i++){
    var r = TRIG[i];
    h += '<div class="trigrule' + (r.on ? '' : ' off') + '" data-ti="' + i + '">'
      + '<div class="trow"><span class="tname">规则 ' + (i+1) + '</span>'
      + '<label style="font-size:11.5px;cursor:pointer"><input type="checkbox" data-ton="' + i + '"'
      + (r.on ? ' checked' : '') + '> 启用</label>'
      + '<span class="tdel" data-tdel="' + i + '" title="删除这条规则">删除</span></div>';
    if (!r.cs || !r.cs.length) r.cs = [];
    for (var j=0;j<r.cs.length;j++){
      h += '<div class="trow">'
        + (j ? '<span class="tand">且</span>' : '<span class="tand" style="visibility:hidden">且</span>')
        + '<select data-tf="' + i + ',' + j + '">';
      for (var q=0;q<TRIG_F_ORDER.length;q++){
        var fk = TRIG_F_ORDER[q], f = TRIG_FIELDS[fk];
        h += '<option value="' + fk + '"' + (r.cs[j][0] === fk ? ' selected' : '') + '>'
          + f.n + (f.g ? '' : ' ⏳') + '</option>';
      }
      h += '</select><select data-top="' + i + ',' + j + '">'
        + '<option value=">="' + (r.cs[j][1] === '>=' ? ' selected' : '') + '>≥</option>'
        + '<option value="<="' + (r.cs[j][1] === '<=' ? ' selected' : '') + '>≤</option>'
        + '</select><input type="text" data-tv="' + i + ',' + j + '" value="' + esc(String(r.cs[j][2])) + '">'
        + '<span class="tcdel" data-tcdel="' + i + ',' + j + '" title="删掉这个条件">×</span></div>';
    }
    h += '<div class="trow"><span class="tadd" data-tadd="' + i + '">+ 加条件</span></div>'
      + '<div class="trigcnt">' + (r.cs.length ? r.cs.map(trigCondTxt).join(' 且 ') : '（空规则，不会触发）')
      + '</div></div>';
  }
  box.innerHTML = h;
  renderTrigCount();
}

function trigOpen(){
  trigRender();
  document.getElementById('trigMsg').textContent = '';
  document.getElementById('trigMask').classList.add('on');
}
function trigClose(){ document.getElementById('trigMask').classList.remove('on'); }

document.getElementById('btnTrig').onclick = trigOpen;
document.getElementById('trigClose').onclick = trigClose;
document.getElementById('trigMask').onclick = function(e){ if (e.target === this) trigClose(); };
document.getElementById('trigAdd').onclick = function(){
  TRIG.push({ on:true, cs:[['chg','>=',2]] });
  trigSave(); trigRender();
  document.getElementById('trigMsg').textContent = '已新建，记得把条件改成你要的';
};
document.getElementById('trigList').addEventListener('click', function(e){
  var t = e.target;
  if (!t.getAttribute) return;
  var ti, cj;
  if (t.getAttribute('data-tadd') != null){
    ti = +t.getAttribute('data-tadd');
    TRIG[ti].cs.push(['chg','>=',2]); trigSave(); trigRender();
  } else if (t.getAttribute('data-tcdel') != null){
    cj = t.getAttribute('data-tcdel').split(',');
    TRIG[+cj[0]].cs.splice(+cj[1], 1); trigSave(); trigRender();
  } else if (t.getAttribute('data-tdel') != null){
    ti = +t.getAttribute('data-tdel');
    TRIG.splice(ti, 1); TRIG_ST = {}; trigSave(); trigRender();
  }
});
document.getElementById('trigList').addEventListener('change', function(e){
  var t = e.target, v;
  if (t.getAttribute('data-ton') != null){
    TRIG[+t.getAttribute('data-ton')].on = t.checked; trigSave(); trigRender();
  } else if (t.getAttribute('data-tf') != null){
    v = t.getAttribute('data-tf').split(',');
    TRIG[+v[0]].cs[+v[1]][0] = t.value; trigSave(); trigRender();
  } else if (t.getAttribute('data-top') != null){
    v = t.getAttribute('data-top').split(',');
    TRIG[+v[0]].cs[+v[1]][1] = t.value; trigSave(); trigRender();
  } else if (t.getAttribute('data-tv') != null){
    v = t.getAttribute('data-tv').split(',');
    var nv = parseFloat(t.value);
    if (!isFinite(nv)){ document.getElementById('trigMsg').textContent = '数值要写数字'; trigRender(); return; }
    TRIG[+v[0]].cs[+v[1]][2] = nv; trigSave(); trigRender();
  }
});

function ioOpen(){
  var t = document.getElementById('ioTxt');
  t.value = watch.join(',');
  document.getElementById('ioMsg').textContent = '当前 ' + watch.length + ' 只';
  document.getElementById('ioMask').classList.add('on');
  setTimeout(function(){ t.focus(); t.select(); }, 30);
}
function ioClose(){ document.getElementById('ioMask').classList.remove('on'); }

document.getElementById('btnIO').onclick = ioOpen;
document.getElementById('ioClose').onclick = ioClose;
document.getElementById('ioMask').onclick = function(e){ if (e.target === this) ioClose(); };

document.getElementById('ioCopy').onclick = function(){
  var t = document.getElementById('ioTxt'), txt = t.value.trim();
  var msg = document.getElementById('ioMsg');
  if (!txt){ msg.textContent = '清单是空的'; return; }
  function done(){ msg.textContent = '已复制 ' + watch.length + ' 只'; toast('清单已复制'); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(function(){
      t.select();
      try{ document.execCommand('copy'); done(); }
      catch(e){ msg.textContent = '复制失败，请手动选中'; }
    });
  } else {
    t.select();
    try{ document.execCommand('copy'); done(); }
    catch(e){ msg.textContent = '复制失败，请手动选中'; }
  }
};

document.getElementById('ioImport').onclick = function(){
  var raw = document.getElementById('ioTxt').value || '';
  var msg = document.getElementById('ioMsg');
  // 只认 5~6 位数字，逗号、空格、换行、代码前缀、名称里的其他字都当分隔符
  var codes = raw.match(/\\\\d{6}|\\\\d{5}/g) || [];
  var seen = {}, add = [], dup = 0, bad = [];
  for (var i=0;i<codes.length;i++){
    var c = codes[i];
    if (seen[c]) continue;
    seen[c] = 1;
    if (watch.indexOf(c) >= 0){ dup++; continue; }
    // DATA 还没到就别校验——否则整份清单会被判成「不在全市场」
    if (DATA.length && !findItem(c)){ bad.push(c); continue; }
    add.push(c);
  }
  if (!add.length){
    var why = [];
    if (dup) why.push(dup + ' 只已在自选');
    if (bad.length) why.push(bad.length + ' 只不在全市场');
    msg.textContent = why.length ? '没有可导入的：' + why.join('，') : '没识别到代码';
    return;
  }
  watch = watch.concat(add);
  saveWatch(); renderWatch(); loadTXQuotes();
  var out = '新增 ' + add.length + ' 只';
  if (dup) out += '，跳过重复 ' + dup;
  if (bad.length) out += '，未收录 ' + bad.length;
  msg.textContent = out;
  toast(out);
};

document.body.addEventListener('click', function(e){
  // 组头折叠：只切 class，不重绘——重绘会把滚动位置弹回去
  var fg = e.target.closest('[data-fold]');
  if (fg){
    var fcode = fg.getAttribute('data-fold');
    var st = secFoldState();
    st[fcode] = !st[fcode];
    saveSecFold();
    var grpEl = document.querySelector('.sgrp[data-g="' + fcode + '"]');
    if (grpEl) grpEl.className = 'sgrp' + (st[fcode] ? ' fold' : '');
    return;
  }
  var sc = e.target.closest('[data-sec]');
  if (sc){
    var sk = sc.getAttribute('data-sec');
    SEC_OPEN = (SEC_OPEN === sk) ? null : sk;
    renderSectors();
    return;
  }
  var sr = e.target.closest('.sdet .sr[data-code]');
  if (sr){
    var scd = sr.getAttribute('data-code');
    openHist(scd, (findItem(scd) || {}).n || scd);
    return;
  }
  var ix = e.target.closest('[data-ix]');
  if (ix){
    var v = ix.getAttribute('data-ix');
    IXF = (IXF === v) ? null : v;
    renderList();
    return;
  }
  var a = e.target.closest('[data-add]');
  if (a){
    var c = a.getAttribute('data-add');
    if (watch.indexOf(c) >= 0){ toast(c+' 已在自选'); return; }
    watch.push(c); saveWatch(); renderWatch(); loadTXQuotes(); toast('已加入自选 '+c);
    return;
  }
  var d = e.target.closest('[data-del]');
  if (d){
    var c2 = d.getAttribute('data-del');
    watch = watch.filter(function(x){ return x !== c2; });
    delete LIVE[c2];
    saveWatch(); renderWatch(); toast('已移除 '+c2);
    return;
  }
  // 点行看历史 K 线。放在最后：上面的 ×N 标签和 +/- 按钮都自带 return
  var row = e.target.closest('tr[data-c]');
  if (row){
    var rc = row.getAttribute('data-c');
    var nmEl = row.querySelector('td.nm');
    var nm = (nmEl && nmEl.firstChild && nmEl.firstChild.nodeType === 3)
      ? nmEl.firstChild.nodeValue : '';
    openHist(rc, nm || (findItem(rc) || {}).n || rc);
  }
});

Array.prototype.forEach.call(document.querySelectorAll('.tag'), function(t){
  if (t.id === 'dedupTag') return;      // 去重开关有自己的处理
  t.onclick = function(){
    Array.prototype.forEach.call(document.querySelectorAll('.tag'), function(x){ x.classList.remove('on'); });
    t.classList.add('on');
    g = t.getAttribute('data-g');
    IXF = null;
    renderList();
  };
});
(function(){
  var b = document.getElementById('btnSec');
  if (b) b.onclick = function(){ SEC_CACHE = {}; renderSectors(); toast('已按最新快照重算板块'); };
})();
document.getElementById('sortSel').onchange = function(){ sortKey = this.value; renderList(); };
document.getElementById('limitSel').onchange = function(){ limit = parseInt(this.value,10); renderList(); };
(function(){
  var t = document.getElementById('dedupTag');
  if (!t) return;
  try{ if (localStorage.getItem('etf_dedup') === '0') DEDUP = false; }catch(e){}
  t.classList.toggle('on', DEDUP);
  t.onclick = function(){
    DEDUP = !DEDUP;
    IXF = null;
    t.classList.toggle('on', DEDUP);
    try{ localStorage.setItem('etf_dedup', DEDUP ? '1' : '0'); }catch(e){}
    renderCards(); renderList();
    toast(DEDUP ? '已按同指数去重，每组只留成交额最大的一只' : '已显示全部 ETF');
  };
})();
var qt = null;
document.getElementById('q').addEventListener('input', function(){
  var v = this.value;
  clearTimeout(qt);
  qt = setTimeout(function(){ kw = v.trim(); IXF = null; renderList(); }, 250);
});

document.getElementById('btnProbe').onclick = function(){
  toast('正在实测数据源…', 3000);
  fetch('/api/probe').then(function(r){ return r.json(); }).then(function(j){
    var em = j.eastmoney || {}, sn = j.sina || {};
    var fmt = function(o){ return o.ok > 0 ? ('可用 ' + o.ok + ' 只 / ' + o.ms + 'ms') : ('不可用 ' + (o.err || '')); };
    alert('数据源实测（当前部署环境）\\\\n\\\\n'
      + '东财: ' + fmt(em) + '\\\\n' + '新浪: ' + fmt(sn)
      + '\\\\n\\\\n东财可用时才有 IOPV / 溢价率，且自选可 5 秒高频刷新。');
    console.log('probe', j);
  }).catch(function(e){ toast('自检失败: ' + e.message); });
};

function clock(){ document.getElementById('clock').textContent = new Date().toLocaleTimeString('zh-CN'); }

/* 锚点导航：点击平滑滚动；滚动时把视口上缘以下 120px 处的区块点亮。
   量出来的 --navH 同时供区块 scroll-margin-top 和表格表头 sticky 用，
   窗口尺寸变化（转屏、缩放）时重算。 */
var NAV_SECS = ['onCard', 'spdSec', 'watchSec', 'secSec', 'rankSec'];
function navMeasure(){
  var nav = document.getElementById('secNav');
  if (nav) document.documentElement.style.setProperty('--navH', (nav.offsetHeight + 8) + 'px');
}
function navScrollTo(id){
  var el = document.getElementById(id);
  if (!el) return;
  var nav = document.getElementById('secNav');
  var navH = nav ? nav.offsetHeight + 8 : 42;
  var y = el.getBoundingClientRect().top + window.pageYOffset - navH;
  window.scrollTo({ top: y, behavior: 'smooth' });
  // 平滑滚动要半秒，途中「急涨急跌」几秒一刷、行数在变，目标位置会被推移——
  // 落点就偏了。滚完 900ms 内连续校正，把布局漂移吃掉。
  var n = 0;
  var tm = setInterval(function(){
    var dy = el.getBoundingClientRect().top - navH;
    if (Math.abs(dy) > 2) window.scrollTo({ top: window.pageYOffset + dy, behavior: 'auto' });
    if (++n >= 6) clearInterval(tm);
  }, 150);
}
function navActive(){
  var nav = document.getElementById('secNav');
  if (!nav) return;
  var cur = '';
  for (var i = 0; i < NAV_SECS.length; i++){
    var el = document.getElementById(NAV_SECS[i]);
    if (!el || !el.offsetHeight) continue;      // 隐藏的（如隔夜卡还没数据）跳过
    if (el.getBoundingClientRect().top <= 120) cur = NAV_SECS[i];
  }
  var as = nav.querySelectorAll('a');
  for (i = 0; i < as.length; i++) as[i].classList.toggle('on', as[i].getAttribute('data-t') === cur);
}
(function initNav(){
  var nav = document.getElementById('secNav');
  if (!nav) return;
  nav.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) navScrollTo(a.getAttribute('data-t'));
  });
  var tm;
  window.addEventListener('scroll', function(){
    if (tm) return;
    tm = setTimeout(function(){ tm = null; navActive(); }, 120);
  }, { passive: true });
  window.addEventListener('resize', navMeasure);
  navMeasure();
  setTimeout(navMeasure, 800);                  // 字体/卡片就位后再量一次
})();
clock(); setInterval(clock, 1000);

renderTrigCount();
loadOvernight();
setInterval(loadOvernight, 600000);   // 期货整夜在动，10 分钟跟一次够了

/* /research 走独立页面：同一个 HTML，只是把因子面板提到文档流里。
   URL 直接可分享，也不占一个弹窗的注意力。 */
var _pn = location.pathname;
var RS_MODE = (_pn === '/research' || _pn === '/research/' || _pn === '/r' || _pn === '/r/');

if (RS_MODE){
  document.body.classList.add('rsmode');
  document.title = '因子研究 · ETF 全市场';
  renderRs();
  document.getElementById('rsMask').classList.add('on');
  pullResearch();
} else {
  pullWatch();
  // 全 A 快照和全量行情并行：它只要 0.5 秒，等 loadFull 的三四秒跑完再发，
  // 首屏那张卡片就已经用基线最后一天画完了（会显示「11-06」而不是「今天」）
  loadMktSnap();
  loadFull().then(function(){
    renderCards();
    mktInit();
    diagInit();
    loadTXQuotes();
    schedule();
    deepLink();
  });
}

/* 深链：?panel=rs 直接打开因子研究，?panel=hist&code=510300 直接看某只 K 线。
   方便把结论发给别人，不用让对方自己找。 */
/* 取 query 参数。故意不用正则：这段代码整体在模板字符串里，
   源码里的 \\\\ 会被 Node 求值和 build.mjs 文本替换分别处理一次，
   两条路径结果不同（本地预览正常、线上报错）。用字符串切分绕开这个坑。 */
function qs(name){
  var parts = location.search.slice(1).split('&');
  for (var i = 0; i < parts.length; i++){
    var eq = parts[i].indexOf('=');
    if (eq > 0 && parts[i].slice(0, eq) === name) return parts[i].slice(eq + 1);
  }
  return '';
}

/* 副图选择支持深链：?sub=macd 直接打开就是 MACD，分享给别人不用再点一次 */
function applySub(k){
  if (!k) return;
  if (k !== 'macd' && !SUB_DEF[k]) return;
  H.sub = k;
  var kids = document.getElementById('hSubs').getElementsByTagName('b');
  for (var i = 0; i < kids.length; i++){
    kids[i].classList.toggle('on', kids[i].getAttribute('data-s') === k);
  }
}

/* 叠加层同理：?ov=boll 只看布林，?ov=ma,boll 两个都开 */
function applyOv(v){
  if (!v) return;
  var ks = v.split(',');
  H.ov.ma = false; H.ov.boll = false;
  for (var i = 0; i < ks.length; i++){
    if (ks[i] === 'ma' || ks[i] === 'boll') H.ov[ks[i]] = true;
  }
  var kids = document.getElementById('hOv').getElementsByTagName('b');
  for (var j = 0; j < kids.length; j++){
    kids[j].classList.toggle('on', !!H.ov[kids[j].getAttribute('data-o')]);
  }
}

function deepLink(){
  applySub(qs('sub'));
  applyOv(qs('ov'));
  var p = qs('panel');
  if (!p) return;
  if (p === 'rs') { location.replace('/research'); return; }
  if (p === 'hist'){
    var c = qs('code');
    if (c) setTimeout(function(){ openHist(c, c); }, 900);
  }
}
</script>
</body>
</html>`;
