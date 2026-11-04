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
  return request.headers.get('CF-Connecting-IP') || 'anon';
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

    if (p === '/api/status') {
      return serveStatus(env);
    }

    if (p === '/api/all') {
      // 三层：边缘缓存 → KV 最近一次成功 → 现场拉（只在前两者都没有时才等上游）
      return serveAll(env, ctx);
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

    return json({ ok: false, error: 'not found' }, 0);
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
:root{--bg:#0f1115;--bg2:#161a21;--bg3:#1d222b;--line:#262c37;--txt:#e6e9ef;
--txt2:#8b93a3;--txt3:#5a6373;--up:#ff4d4f;--down:#00c48c;--accent:#4c8dff;
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
.dot.up i{background:var(--down);box-shadow:0 0 7px var(--down)}
.dot.down i{background:var(--up);box-shadow:0 0 7px var(--up)}
.dot.down{color:var(--up)}
#btnRs{padding:3px 11px;border-radius:20px;font-size:11.5px;color:var(--txt2);display:inline-block;
text-decoration:none;
background:var(--bg3)}
#btnRs:hover{color:var(--txt);border-color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(142px,1fr));gap:9px;margin-bottom:12px}
/* 上游故障时的横幅：贴在卡片下面，一进页面就能看见。
   放在 footer 里等于没有——100 行的表格把 footer 顶到 4600px 之外。 */
.stalebar{margin:-2px 0 12px;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.5;
  background:rgba(255,176,32,.09);border:1px solid rgba(255,176,32,.32);color:#ffb020}
.stalebar.bad{background:rgba(255,77,79,.09);border-color:rgba(255,77,79,.32);color:#ff4d4f}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 13px}
.card .k{font-size:11px;color:var(--txt2);letter-spacing:.3px;margin-bottom:4px}
.card .v{font-size:18px;font-weight:600;font-family:var(--mono)}
.card .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
.bar{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input,select,button{background:var(--bg2);color:var(--txt);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font-size:12.5px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
input#q{width:180px}
button{cursor:pointer;transition:.15s}
button:hover{background:var(--bg3)}
button.pri{background:#1a3a6b;border-color:#2b5ba8;color:#cfe0ff}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:12px;
border:1px solid var(--line);background:var(--bg2);color:var(--txt2);transition:.15s;user-select:none}
.tag:hover{color:var(--txt)}
.tag.on{background:#1a3a6b;border-color:#2b5ba8;color:#cfe0ff}
.tag b{font-weight:400;opacity:.6;font-size:10.5px;margin-left:3px}
.sec{margin-bottom:16px}
.sechd{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12.5px;color:var(--txt2)}
.sechd b{color:var(--txt);font-size:13.5px;font-weight:600}
.sechd .n{color:var(--txt3);font-size:11.5px}
.sechd .sync{margin-left:auto;font-size:10.5px;color:var(--txt3);border:1px solid var(--line);
border-radius:5px;padding:1px 7px;cursor:pointer;user-select:none}
.sechd .sync:hover{color:var(--txt);border-color:var(--accent)}
.tbl{background:var(--bg2);border:1px solid var(--line);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead th{background:var(--bg3);font-size:10.5px;font-weight:500;color:var(--txt2);
letter-spacing:.3px;padding:9px;text-align:right;white-space:nowrap;
border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
thead th:hover{color:var(--txt)}
thead th.l{text-align:left}
thead th.ctr{text-align:center}
thead th.on{color:var(--accent)}
tbody td{padding:8px 9px;text-align:right;border-bottom:1px solid #1c2028;
font-family:var(--mono);font-size:12.5px;white-space:nowrap}
tbody tr:hover{background:#1a1f28}
tbody tr:last-child td{border-bottom:none}
td.l{text-align:left;font-family:inherit}
td.ctr{text-align:center}
.code{color:var(--txt3);font-size:11px}
.nm{font-weight:500}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--txt3)}
.pm{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11.5px;font-weight:600;min-width:56px}
.pm.hi{background:#3d1418;color:#ff6b6b;border:1px solid #6b2126}
.pm.mid{background:#3a2d12;color:#ffb340;border:1px solid #6b5420}
.pm.lo{background:#0f3329;color:#28d09a;border:1px solid #1a5c48}
.pm.na{background:transparent;color:var(--txt3);border:1px dashed var(--line);font-weight:400}
.act{color:var(--txt3);cursor:pointer;font-size:15px;padding:1px 6px;border-radius:4px}
.act:hover{color:var(--accent);background:#17233a}
.act.del:hover{color:var(--up);background:#2a1518}
.ixb{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;font-size:10px;
font-weight:500;color:var(--txt3);background:#232833;border:1px solid var(--line);
vertical-align:1px;cursor:default}
.ixb.mx{color:#7fa8ff;background:#182545;border-color:#2b4171}
.syn{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:9.5px;
color:#7fa8ff;background:#182545;border:1px solid #2b4171;vertical-align:1px;font-weight:500}
tr.hr{cursor:pointer}
tr.hr:hover td{background:#1b212b}
@keyframes fu{0%{background:#3a1518}100%{background:transparent}}
@keyframes fd{0%{background:#0c2b23}100%{background:transparent}}
.fu{animation:fu .7s ease-out}.fd{animation:fd .7s ease-out}
footer{margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--txt3)}
.err{color:var(--up)}
.empty{padding:20px;text-align:center;color:var(--txt3);font-size:12.5px}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#22272f;
border:1px solid var(--line);padding:8px 16px;border-radius:6px;font-size:12.5px;opacity:0;
transition:.25s;pointer-events:none;z-index:9}
#toast.show{opacity:1}
@media(max-width:820px){.hide-sm{display:none}}

/* ---------- 历史 K 线面板 ---------- */
#histMask{position:fixed;inset:0;background:rgba(6,8,12,.72);z-index:60;display:none;
align-items:center;justify-content:center;padding:18px}
#histMask.on{display:flex}
.hpanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;min-width:0;
max-width:1060px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 24px 64px rgba(0,0,0,.55)}
.hhd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.hhd .nm{font-size:14.5px;font-weight:600}
.hhd .cd{font-family:var(--mono);font-size:12px;color:var(--txt3)}
.hhd .px{font-family:var(--mono);font-size:16px;font-weight:600;margin-left:4px}
.hhd .ch{font-family:var(--mono);font-size:12.5px}
.htabs{display:flex;gap:3px;margin-left:auto}
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
.hsbar b{padding:2px 7px;border:1px solid var(--line);border-radius:5px;font-size:11px;
font-family:var(--mono);font-weight:400;color:var(--txt2);cursor:pointer;user-select:none}
.hsbar b:hover{color:var(--txt)}
.hsbar b.on{background:var(--bg3);color:var(--txt);border-color:#3a4a63}
.hind .i.on{border-color:#3a4a63;background:var(--bg3)}
.hleg{display:flex;gap:16px;padding:7px 14px 0;font-size:11.5px;color:var(--txt2);flex-wrap:wrap}
.hleg i{display:inline-block;width:8px;height:2px;vertical-align:3px;margin-right:4px}
.hnote{padding:5px 14px 12px;font-size:10.5px;color:var(--txt3);line-height:1.7}
.hnote:empty{display:none}
/* 指标明细：K 线下方一排小卡，把 17 个字段里最能看的那几个摊开 */
.hind{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;padding:6px 14px 2px;min-width:0}
.hind .i{background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:5px 8px;min-width:0}
.hind .i .k{font-size:10px;color:var(--txt3);letter-spacing:.2px;white-space:nowrap}
.hind .i .v{font-size:12.5px;font-family:var(--mono);font-weight:600;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hind .i .s{font-size:10px;color:var(--txt2);margin-top:1px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.hload{padding:70px 0;text-align:center;color:var(--txt2);font-size:12.5px;line-height:2}
@media(max-width:700px){
  /* 顶部一行装不下：名称/代码/价格/涨幅 + 4 个周期 + 关闭。
     不换行就会把面板撑得比屏幕还宽，连带右边价格轴一起被裁。 */
  .hhd{flex-wrap:wrap;gap:5px 8px;padding:9px 10px}
  .hhd .cd{display:none}
  .hhd .nm{font-size:13px}
  .htabs{margin-left:0;order:9}
  .htabs span{padding:2px 7px}
  .hx{margin-left:auto;order:10}
  .hsbar{padding:7px 10px 2px;gap:3px;overflow:hidden}
  .hsbar .lb{font-size:10px}
  .hsbar .lb+.sg+.lb{margin-left:5px}
  .hsbar b{padding:2px 5px;font-size:10px}
  #histCv{height:300px}
  /* 小屏固定 3 列：auto-fit 在 400px 里会算出 4 列 96px，
     但 canvas 的固有宽度参与 flex 计算会把面板撑宽，导致第 4 列被裁掉 */
  .hind{grid-template-columns:repeat(3,minmax(0,1fr))}
}
/* ---- 因子研究面板 ---- */
#rsMask{position:fixed;inset:0;background:rgba(6,8,12,.72);z-index:70;display:none;
align-items:center;justify-content:center;padding:18px}
#rsMask.on{display:flex}
.rspanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:900px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 24px 64px rgba(0,0,0,.55)}
.rshd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line)}
/* 标题不许被压缩换行：以前「因子研究」在 390px 屏上会折成「因子/研究」两行，
   还把日期挤到旁边，看着像排版坏了。标题固定宽度，元信息自己换行。 */
.rshd b{font-size:14.5px;white-space:nowrap;flex:0 0 auto}
.rshd .sub{font-size:11px;color:var(--txt3);font-family:var(--mono);
min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsbody{overflow-y:auto;padding:14px}
.rssec{margin-bottom:18px}
.rssec h4{font-size:12px;color:var(--txt2);font-weight:600;margin-bottom:8px;
letter-spacing:.3px;display:flex;align-items:center;gap:7px}
.rssec h4::after{content:'';flex:1;height:1px;background:var(--line)}
.rsk{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.rsk .i{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.rsk .i .k{font-size:10.5px;color:var(--txt3);margin-bottom:3px}
.rsk .i .v{font-size:17px;font-family:var(--mono);font-weight:600}
.rsk .i .s{font-size:10px;color:var(--txt3);margin-top:2px}
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
.rsnote{font-size:11px;color:var(--txt2);line-height:1.85;background:var(--bg3);
border-left:2px solid var(--accent);border-radius:0 6px 6px 0;padding:9px 12px}
.rsnote b{color:var(--txt)}
.rsnote .warn{border-left-color:var(--up)}
/* ---- 因子明细：点一行展开构造方式 ---- */
.fxtbl tr.fxr{cursor:pointer}
.fxtbl tr.fxr.on td{background:rgba(59,130,246,.10)}
.fxtbl tr.fxx{display:none}
.fxtbl td.fxnm{text-align:left;color:var(--txt2);font-family:inherit;white-space:normal}
.fxdet td{padding:0 0 7px!important;border-bottom:1px solid var(--line)!important;
text-align:left!important;white-space:normal!important;font-family:inherit!important;background:transparent!important}
.fxd{background:var(--bg);border-left:2px solid var(--accent);border-radius:0 7px 7px 0;padding:10px 13px}
.fxdn{font-size:11.5px;color:var(--txt2);margin-bottom:5px}
.fxdn b{color:#7dd3fc;font-family:var(--mono);font-weight:600;margin-right:7px}
.fxds{font-size:11.5px;color:var(--txt2);line-height:1.7;margin-bottom:8px}
.fxf{font-family:var(--mono);font-size:10.8px;color:#c3cfe0;background:var(--bg3);
border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;
white-space:pre-wrap;word-break:break-word;line-height:1.75}
.rsmore{margin-top:9px;text-align:center}
.rsmore button{font-size:11.5px;padding:5px 14px;border-radius:6px}
.rssrc{font-size:10px;color:var(--txt3);margin-top:10px;text-align:right}
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
  /* 表格右侧被裁一半的样子容易被当成本站坏了，标一句「能滑」。
     只对会横向滚动的那几张表显示，指标说明表换了行不需要。 */
  .rssec:has(.rstwrap>table:not(.indtbl)) > h4::after{
    content:'  ← 左右滑动看全部列';color:var(--txt3);font-weight:400;font-size:10px}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>ETF 全市场盯盘 <em id="clock">--:--:--</em></h1>
  <div class="sp"></div>
  <span class="dot" id="d-src"><i></i><span id="srcName">连接中</span></span>
  <a id="btnRs" href="/research" title="101 个 Alpha 因子的 IC 检验与样本外回测结果">因子研究</a>
</header>

<div class="cards">
  <div class="card"><div class="k">全市场 ETF</div><div class="v" id="cTotal">-</div><div class="s" id="cUni">-</div></div>
  <div class="card"><div class="k">涨 / 跌</div><div class="v" id="cUD">-</div><div class="s" id="cUDs">-</div></div>
  <div class="card"><div class="k">全市场成交额</div><div class="v" id="cAmt">-</div><div class="s">合计</div></div>
</div>

<div class="sec">
  <div id="staleBar" class="stalebar" style="display:none"></div>
  <div class="sechd"><b>自选盯盘</b><span class="n" id="watchN"></span>
    <span class="sync" id="btnSync" title="复制一条带同步码的链接，在别的设备打开就是这份自选">同步</span></div>
  <div class="bar">
    <input id="addIn" placeholder="添加代码，支持逗号批量：510300,513180" style="width:290px">
    <button class="pri" id="btnAdd">添加</button>
    <button id="btnClear">清空</button>
    <span class="n" id="quoteTip" style="font-size:11px;color:var(--txt3)"></span>
  </div>
  <div class="tbl"><table>
    <thead><tr>
      <th class="l">代码</th><th class="l">名称</th><th>现价</th><th>涨跌%</th><th>涨跌</th>
      <th class="ctr">溢价率</th><th>IOPV</th><th>成交额</th><th>换手</th>
      <th class="hide-sm">振幅</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th>
      <th class="ctr" style="width:36px"></th>
    </tr></thead>
    <tbody id="watchBody"><tr><td colspan="13" class="empty">加载中…</td></tr></tbody>
  </table></div>
</div>

<div class="sec">
  <div class="sechd"><b>全市场榜单</b><span class="n" id="listN"></span></div>
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

<div id="histMask">
  <div class="hpanel">
    <div class="hhd">
      <span class="nm" id="hName">-</span>
      <span class="cd" id="hCode"></span>
      <span class="px" id="hPx">-</span>
      <span class="ch" id="hChg"></span>
      <div class="htabs" id="hTabs">
        <span data-r="63">3M</span>
        <span data-r="126">6M</span>
        <span data-r="250" class="on">1Y</span>
        <span data-r="0">全部</span>
      </div>
      <button class="hx" id="hClose" title="关闭 (Esc)">×</button>
    </div>
    <div class="hsbar">
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
    <div class="hleg" id="hLeg"></div>
    <div class="hind" id="hInd"></div>
    <div class="hnote" id="hNote"></div>
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
var IDX_GROUPS = {"中证港股通内地金融港元":["158000","159091","513190","526090"],"国证价值100":["158001","158043","159037","159042","159079","159085","159096","159098","159263"],"中证港股通医疗主题":["158003","159137","159167","159366","513620","520510","520850","526010"],"中证工程机械主题":["158005","159065","159070","159138","159161","159177","159542","512420","515970","516250","516440","560280","560920","561030","561070"],"细分化工":["158006","158017","158032","159082","159087","159093","159129","159133","159870","516020","516120","516220","561620"],"国证储能电池":["158008","159052","159071","159193","159305","159566"],"国证航天航空行业":["158009","158013","158030","159208","159227","159241","159267"],"中证医疗":["158010","159828","159847","512170","560260"],"创业板软件":["158011","158072","159107","159256"],"中证云计算50":["158012","159095","159099","560660","562110"],"中证电池主题":["158019","159077","159147","159155","159160","159175","159796","512460","560410","560910","561160","561910","562880"],"创业板综合":["158022","159287","159288","159289","159290","159291","159292","159293","159295","159541","159563"],"中证800红利低波动":["158023","159355","563980"],"创业板成长":["158025","159597"],"国证大盘成长":["158026","159203"],"中证工业互联网主题":["158027","159013","159075","159778"],"中证稀有金属主题":["158028","159045","159053","159055","159062","159608","159671","561050","561250","561390","561800"],"创业板人工智能":["158031","159242","159243","159246","159279","159363","159382","159388"],"中证卫星产业":["158036","158046","159218","512630","562420","563230","563530","563790"],"中证机器人":["158037","159213","159258","159526","159551","159770","560630","560770","562360","562500"],"国证粮食产业":["158038","158047","158065","159030","159031","159033","159038","159060","159063","159072","159073","159587","159698"],"标普港股通低波红利":["158039","159117","159118","159220","513630","520610"],"中证科创创业人工智能":["158040","159022","159139","159140","159141","159142","588410","588420","588430","588470","588480","588510","588530"],"创业板算力基础设施":["158041","158049","158050","158053","158055","158056","158057","158059","158061","158063"],"恒生科技":["158042","159740","159741","159742","513010","513130","513180","513260","513380","513580","513890","520570","520590","520920"],"中证金融科技主题":["158051","159086","159103","159299","159851","515720","516100","516860","562400","563570","563670"],"创业板金融科技":["158052","158058","158062","158067"],"中证大数据产业":["158066","515400","516000","516700"],"创业板电池":["158078","158079","158082"],"中证畜牧养殖":["159007","159011","159020","159023","159027","159165","159172","159865","159867","512450","516670","516760","561400","561470"],"中证全指证券公司":["159008","159058","159260","159841","159842","159848","512000","512570","512880","512900","515010","515560","515850","516200","560090","560400","562870"],"创业板新能源":["159009","159069","159076","159122","159149","159187","159190","159261","159368","159387"],"恒生港股通科技主题":["159010","159015","159120","159135","159152","159262","520670","520840"],"中证科创创业50":["159012","159603","159780","159781","159782","159783","588300","588310","588320","588330","588350","588360","588380","588390","588400","588660"],"中证证券公司30":["159016","159692","516730"],"国证石油天然气":["159017","159018","159019","159026","159148","159181","159189","159195","159197","159199","159588","159697"],"国证大盘价值":["159021","159391"],"中证家电龙头":["159025","159192","159328"],"恒生港股通汽车主题":["159028","159121","159186","159239","520730"],"中证有色金属矿业主题":["159029","159049","159163","159690","512940","560290","561330","561830","562450"],"中证工业有色金属主题":["159032","159157","159162","159168","159171","512470","515040","515540","560490","560860","560870","560970"],"中证软件服务":["159035","159852","560360","560790","562930"],"中证全指软件开发":["159036","561010"],"国证机器人产业":["159039","159048","159050","159272","159278","159530","159559"],"中证港股通互联网":["159040","159179","159568","159792","513040","513720","513770","520630","520650","520740","520790","520910"],"中证农业主题":["159041","159825","159827","512620","516810"],"中证全指食品":["159043","159151","515840","560130","560160","560320","560420","561020","563850"],"国证绿色电力":["159046","159061","159625","159669"],"中证港股通信息技术综合港元":["159047","159131","159185","159196","159198","513240","520710","520750","526000","526030","526050","526060"],"中证全指医疗器械":["159051","159056","159057","159797","159883","159898","561810","562600"],"中证全指电力公用事业":["159059","159146","159158","159611","512140","516370","560270","560450","560460","560480","560580","560830","560930","561560","561700","562350"],"中证A股":["159066","159078","515440","561730","561890","563330"],"中证全指软件":["159068","159590","159899","515230"],"中证红利低波动100":["159083","159228","159307","159549","515100","515480","560520","560720"],"国证港股通互联网":["159089","159170","159280"],"巴西BOVESPA":["159100","520870"],"国证港股通科技":["159101","159125","159128","159191","159251","159636"],"恒生生物科技":["159102","159105","159132","159169","159615","159892","513280","513930","520760","520930"],"国证工业软件主题":["159108","159145","159180"],"恒生港股通50":["159109","520950"],"深证AAA科技创新公司债":["159110","159400"],"中证AAA科技创新公司债":["159111","159112","159113","159115","159116","159200","159600","159700","551500","551510","551520","551550","551560","551580","551800","551900"],"中证800自由现金流":["159119","159229","516460","563580","563680","563990"],"中证港股通50港元":["159126","159711","159712","513550"],"中证A50":["159136","159390","159591","159592","159593","159595","159596","512030","512240","512250","560350","560820","561230","561750","563080","563350"],"恒生港股通中国央企红利":["159143","513920"],"深证50":["159150","159350"],"国证消费电子主题":["159153","159178","159732"],"国证新能源车电池":["159156","159755","159757","159767","159775","159840"],"中证全指公用事业":["159159","159301","560190","560620"],"国证自由现金流":["159166","159201","159221","159222","159223","159225","159276"],"中证全指农牧渔":["159173","159275","560210"],"中证全指家用电器":["159176","159182","159996","515640","560880","561120"],"中证新能源汽车":["159183","159637","159806","159824","515030","516660"],"恒生互联网科技业":["159202","159688","513330"],"创业板指":["159205","159247","159675","159676","159808","159810","159821","159908","159915","159948","159952","159956","159957","159958","159964","159971","159977"],"中证全指红利质量":["159209","515460","560250","560370","561430","561490","561630","561650","562150","562200"],"中证港股通汽车产业主题":["159210","159237","159323","520600","520680","520720","520780"],"深证100":["159211","159212","159216","159219","159576","159706","159716","159721","159901","159961","159970","159975"],"中证A500":["159215","159226","159240","159249","159338","159339","159351","159352","159353","159356","159357","159358","159359","159360","159361","159362","159376","159379","159380","159386","512020","512050","512080","512370","560510","560530","560610","560750","561090","563220","563360","563500","563550","563600","563630","563650","563660","563800","563860","563880"],"国证港股通创新药":["159217","159286","159297","159567","159570"],"国证通用航空产业":["159230","159231","159255","159257","159378","159392"],"中证全指自由现金流":["159232","159233","159235","159236","512130","561080","561870","563390","563620","563760","563770","563780","563830"],"沪深300":["159238","159300","159330","159393","159673","159919","159925","510300","510310","510320","510330","510350","510360","510370","510380","510390","515130","515310","515330","515350","515360","515380","515390","515660","561000","561300","561930","562070","563520"],"国证港股通消费主题":["159245","159265","159268","159285"],"中证人工智能主题":["159248","159819","512930","515070","515470","561460"],"中证银行":["159253","512410","512700","512730","512800","512820","515020","515290","516210","516310","560670","561530"],"中证港股通央企红利":["159266","159281","159333","513910"],"中证港股通科技":["159269","159751","513020","513150","513560","513860","513980","520530","520860"],"创业板200":["159270","159571","159572","159573","159575"],"恒生指数":["159271","159920","513210","513600","513660"],"中证沪港深云计算产业":["159273","159738","517130","517230","517390"],"中证港股通高股息投资港元":["159277","159302","159331","513530","513820","513830","520810"],"中证通用航空主题":["159283","561660","563320","563870"],"中证A500红利低波动":["159296","560570","561680","562180","563510","563590"],"创业板50":["159298","159367","159369","159370","159371","159372","159373","159375","159383","159681","159682","159949"],"恒生医疗保健":["159303","159557","513060"],"中证汽车零部件主题":["159306","159565","512740","562700"],"中证油气资源":["159309","561760","563150"],"中证芯片产业":["159310","159560","159599","516350","516640","516920"],"中证数字经济主题":["159311","159658","560800"],"恒指港股通":["159312","159318","159365","520770","520820","520940","520960","526070"],"中证沪深港黄金产业股票":["159315","159321","159322","159562","517400","517520"],"恒生A股电网设备":["159320","515940","560390","561380"],"中证半导体材料设备主题":["159327","159558","560780","562590"],"富时沙特阿拉伯":["159329","520830"],"中证中央企业红利":["159332","561580"],"中证500":["159337","159500","159610","159678","159820","159922","159935","159968","159982","510500","510510","510530","510550","510560","510570","510580","510590","512500","512510","515190","515530","515550","560100","560950","561350","561550","561950","563030","563750"],"中证诚通国企数字经济":["159385","159389","561220"],"深证基准做市信用债":["159395","159396","159397","159398"],"纳斯达克100":["159501","159513","159632","159659","159660","159696","159941","513100","513110","513300","513390","513870"],"国证2000":["159505","159521","159543","159628","159907"],"国证通信":["159507","159695"],"国证生物医药":["159508","159839","159859"],"中证国有企业红利":["159515","561060","563890"],"中证800":["159517","159800","515800","515810"],"S&POil&GasExploration&ProductionSelectIndustry":["159518","513350"],"中证香港内地国有企业港元":["159519","513810"],"中证消费龙头":["159520","516130"],"中证红利低波动":["159525","159547","512890","560150","560730","563020","563690"],"中证云计算与大数据主题":["159527","159739","159890","516510","516630"],"中证2000":["159531","159532","159533","159535","159536","159552","159553","159555","159556","560220","561370","562660","563200","563300"],"国证信息技术创新主题":["159537","159538","159539","159540"],"恒生港股通红利低波动":["159545","513950","520550","520890"],"中证全指集成电路":["159546","562820"],"中证沪港深互联网":["159550","159729","159856","517050","517200"],"法兰克福DAX":["159561","513030"],"MSCIUSA50Index":["159577","513850"],"中证红利":["159581","159589","515080","515180","515890","560020"],"中证半导体产业":["159582","561980"],"MSCI中国A50互联互通":["159601","159602","560050","563000","563280"],"中证海外中国互联网30":["159605","159607"],"中证500质量成长":["159606","560500","562340"],"中证光伏产业":["159609","159618","159857","159863","159864","515370","515790","516180","516230","516290","516880","560230","560310","561410","562970"],"标准普尔500":["159612","159655","513500","513650"],"中证信息安全主题":["159613","562920"],"中证基建工程":["159619","159635","516950","516970"],"中证沪港深创新药产业":["159622","159748","517110","517120"],"中证A100":["159627","159630","159631","159661","159686","159923","512060","512910","560380","561180","561200","561770","561880","562000"],"中证1000":["159629","159633","159677","159679","159680","159685","159845","512100","516300","560010","560110","560590","561280","561590","561780"],"中证上海环交所碳中和":["159639","159640","159641","159642","560060","560550","561190","562990"],"国证疫苗与生物科技":["159643","159645","159657"],"中证中药":["159647","560080","561510","562390"],"中债-0-3年国开行债券全价":["159650","159651"],"细分有色":["159652","516650","560470"],"国证ESG300":["159653","159717"],"沪深300成长":["159656","562310"],"中证机床":["159663","159667"],"国证半导体芯片":["159665","159801","159813","159995"],"中证消费50":["159670","159798","515650"],"中证主要消费":["159672","159689","159928","512600","560680"],"恒生消费":["159699","513970","520520","520620"],"中证物联网主题":["159701","159895","159896","516260","516330"],"中证新材料主题":["159703","159761","159763","516360","516710","516890"],"深证红利":["159708","159905"],"中证稀土产业":["159713","159715","516150","516780"],"中证港股通医药卫生综合港元":["159718","159776","513200","513700"],"富时中国国企开放共赢":["159719","517090","517180"],"中证智能电动汽车":["159720","516380","516590"],"中证沪港深科技龙头":["159723","517350"],"中证石化产业":["159731","516570"],"中证港股通消费主题港元":["159735","513070","513230","513590"],"中证全指建筑材料":["159745","159787","516750"],"中证香港科技":["159747","159750"],"中证内地新能源主题":["159752","516270"],"中证旅游主题":["159766","562510"],"创业板科技":["159773","159777"],"中证消费电子主题":["159779","561100","561310","561600","562950"],"中证内地低碳经济主题":["159790","159885","516070","560560","562300"],"沪深300ESG基准":["159791","516830","560180","561900"],"中证智能汽车主题":["159795","159888","159889","515250","516520"],"中证传媒":["159805","512980"],"黄金9999":["159812","159934","159937","518660","518800","518850","518880"],"创业板大盘":["159814","159991"],"上海金":["159830","159831","159834","518600","518680","518860","518890"],"中证创新药产业":["159835","159858","159992","515120","516060","516080","560900"],"中证生物科技主题":["159837","159849","516500","516930"],"中证医药50":["159838","515950"],"恒生中国企业":["159850","159954","159960","510900"],"中证影视主题":["159855","516620"],"细分食品":["159862","515170","515710"],"东京日经225":["159866","513000","513520","513880"],"中证动漫游戏":["159869","516010","516770"],"中证有色金属":["159871","159876","159881"],"中证全指医疗保健设备与服务":["159873","159877","159891","516610","516790"],"中证新能源":["159875","516090","516160","516580","516850"],"细分机械":["159886","516960"],"深证":["159903","159943"],"中证金融地产":["159931","512640"],"中证全指可选消费":["159936","562580"],"中证全指信息技术":["159939","562560"],"中证央企结构调整":["159959","512950","512960"],"中证央企创新驱动":["159974","515600","515680","515900"],"中证5G通信主题":["159994","515050"],"中证计算机主题":["159998","512720"],"上证180":["510040","510180","510670","530080","530180","530280","530300","530580","530680","530800"],"上证50":["510050","510100","510190","510600","510680","510710","510800","510850","510950","530000","530050","563090"],"上证综合":["510140","510210","510760","510910","510980","530060","562810","563930"],"上证380":["510290","530380"],"上证国有企业红利":["510720","530880"],"上证基准做市公司债":["511070","511110","511190","511200"],"上证AAA科技创新公司债":["511120","511150","551000","551030","551060","551300"],"MSCI中国A股国际通":["512090","512160","512180","512520","512990","515160"],"富时中国A50":["512150","512550"],"中证全指房地产":["512200","515060"],"MSCI中国A股":["512380","515770"],"中证家居家电":["512430","515730"],"中证军工":["512560","512660","512680","512810"],"恒生港股通中国科技":["513160","520980"],"中证港股通创新药":["513780","520700","520970"],"中证科技龙头":["515000","516050"],"中证国企一带一路":["515110","515150","515990"],"中证电子50":["515260","515320"],"标普中国A股大盘红利低波50":["515450","561450"],"中证新能源汽车产业":["515700","516390"],"沪深300自由现金流":["516040","561420","562080","562170","563900"],"中证装备产业":["516320","562910"],"中证现代物流":["516530","516910"],"中证沪港深500":["517000","517010","517080","517100","517170"],"中证沪港深300":["517030","517300"],"中证长江保护主题":["517160","517330"],"中证国新港股通央企红利":["520660","520900","520990"],"恒生港股通创新药精选":["520690","520880"],"上证580":["530100","530530"],"中证国新央企股东回报":["560070","560700","561960"],"中证国新央企科技引领":["560170","562380","563050"],"中证电信主题":["560300","560690","563010"],"沪深300价值":["560330","562320"],"中证信息技术应用创新产业":["560850","562030","562570"],"中证绿色电力":["561170","561610","562550","562960"],"中证国新央企现代能源":["561260","561790","562850"],"中证油气产业":["561360","561570"],"沪深300质量":["561690","563960"],"上证科创板50":["588000","588040","588050","588060","588080","588090","588150","588180","588280","588370","588450","588460","588720","588840","588870","588940","588950","589150","589360","589850"],"上证科创板新材料":["588010","588160","589180","589510"],"上证科创板成长":["588020","588070","588110","589490","589700"],"上证科创板100":["588030","588120","588190","588210","588220","588500","588680","588800","588880","588900","588980","589270","589950","589980"],"上证科创板新一代信息技术":["588100","588260","588770"],"上证科创板生物医药":["588130","588250","588700","588860"],"上证科创板200":["588140","588230","588240","588270","588820","589200","589220","589320","589330","589460","589780","589820"],"上证科创板半导体材料设备主题":["588170","588710","589020"],"上证科创板芯片":["588200","588290","588750","588810","588890","588920","588990","589100","589130","589160","589190"],"上证科创板综合":["588520","588550","588670","588690","589000","589050","589060","589080","589280","589300","589500","589580","589600","589630","589660","589680","589770","589800","589860","589880","589890","589900","589990"],"上证科创板人工智能":["588730","588760","588790","588930","589010","589090","589110","589230","589310","589380","589410","589520","589560"],"上证科创板芯片设计主题":["588780","589030","589070","589170","589210","589250","589260","589290","589350","589390","589400","589420","589430","589480"],"上证科创板新能源主题":["588830","588960","589960"],"上证科创板创新药":["589120","589720"]};
var RESEARCH = {"generated_at":"2026-11-04T13:35:17","window":["2023-11-03","2026-11-03"],"train":["2023-11-03","2025-08-18"],"test":["2025-08-19","2026-11-03"],"train_days":435,"test_days":291,"horizon":5,"clusters":73,"cluster_thresh":0.5,"corr":{"mean":0.1013,"median":0.0556,"p95":0.3556,"gt06":0.0104},"picks":[["a040",0.03095,0.187,3.87,0.5814,17],["a054",0.02327,0.104,2.17,0.5163,63],["a024",0.02121,0.104,2.16,0.5186,46],["a095",0.01726,0.149,3.1,0.5721,7],["a036",0.01595,0.121,2.52,0.5628,40],["a076",0.01541,0.115,2.38,0.5326,5],["a063",0.01525,0.096,1.99,0.5442,42],["a059",0.01517,0.144,2.98,0.5651,9]],"ic":{"n":101,"neg":36,"rows":[["a018",-0.02611,-0.101,-5.24,0.5361,2671],["a032",0.02498,0.076,3.74,0.5207,2397],["a060",0.02298,0.079,4.08,0.5223,2673],["a044",0.02202,0.144,7.46,0.5499,2677],["a085",0.02059,0.114,5.8,0.531,2595],["a006",0.01877,0.096,4.96,0.5477,2673],["a039",-0.01865,-0.06,-2.94,0.5276,2369],["a040",0.01823,0.084,4.33,0.5481,2671],["a054",0.01811,0.063,3.29,0.5171,2696],["a014",0.01753,0.091,4.71,0.5357,2673],["a073",-0.017,-0.055,-2.83,0.519,2684],["a093",-0.01642,-0.092,-4.6,0.5361,2524],["a075",0.01607,0.119,6.16,0.5356,2696],["a098",0.01521,0.087,4.43,0.5379,2584],["a065",-0.01474,-0.071,-3.71,0.5256,2696],["a072",0.01443,0.083,4.21,0.5457,2562],["a052",-0.01399,-0.051,-2.49,0.5245,2387],["a043",0.01322,0.053,2.73,0.5326,2657],["a063",-0.01304,-0.056,-2.76,0.5165,2389],["a083",0.01289,0.055,2.84,0.5153,2680],["a019",-0.01278,-0.038,-1.84,0.512,2369],["a062",0.0122,0.069,3.58,0.5159,2696],["a079",0.01106,0.069,3.6,0.523,2696],["a087",-0.01098,-0.058,-3.02,0.5142,2684],["a070",-0.01078,-0.048,-2.42,0.5224,2588],["a026",0.01072,0.064,3.22,0.5319,2570],["a008",0.01056,0.032,1.65,0.5006,2663],["a016",0.01044,0.081,4.19,0.5432,2684],["a071",0.01003,0.065,3.36,0.5107,2663],["a036",0.00998,0.05,2.45,0.5297,2445],["a022",0.00987,0.055,2.84,0.5232,2655],["a057",0.00977,0.042,2.16,0.5032,2645],["a094",-0.0085,-0.05,-2.46,0.5151,2378],["a009",0.00846,0.026,1.36,0.5084,2693],["a064",-0.00826,-0.036,-1.89,0.5111,2696],["a030",0.00821,0.031,1.61,0.5021,2657],["a100",0.00792,0.03,1.52,0.5039,2584],["a055",0.00769,0.056,2.86,0.5177,2652],["a077",-0.00744,-0.043,-2.19,0.5243,2657],["a041",-0.00737,-0.04,-2.07,0.5219,2696],["a081",-0.00728,-0.048,-2.47,0.5082,2696],["a047",-0.00719,-0.023,-1.17,0.5175,2657],["a013",0.00715,0.054,2.79,0.5268,2684],["a046",0.00714,0.024,1.22,0.5072,2693],["a029",-0.00711,-0.023,-1.19,0.5024,2681],["a015",0.00675,0.054,2.68,0.5298,2482],["a049",0.00674,0.02,1.04,0.5009,2693],["a095",0.00668,0.042,2.18,0.507,2696],["a002",-0.00663,-0.042,-2.19,0.5172,2680],["a051",0.00642,0.019,1,0.5009,2693],["a012",0.00625,0.035,1.79,0.5113,2693],["a058",0.00609,0.041,2.12,0.5247,2668],["a003",0.00609,0.043,2.21,0.5318,2640],["a059",0.00607,0.04,2.06,0.5317,2654],["a033",0.00573,0.015,0.8,0.4937,2696],["a091",0.00558,0.038,1.94,0.5187,2626],["a086",-0.00529,-0.037,-1.86,0.5283,2548],["a061",0.00512,0.027,1.4,0.4874,2696],["a037",0.00509,0.018,0.9,0.4914,2444],["a067",0.00509,0.022,1.12,0.5096,2651],["a020",0.00506,0.019,0.99,0.5032,2693],["a053",0.00464,0.015,0.79,0.4964,2613],["a089",0.00462,0.02,1.02,0.5064,2654],["a034",0.00461,0.016,0.81,0.4987,2671],["a031",0.0046,0.022,1.14,0.5013,2645],["a088",0.00459,0.029,1.49,0.5194,2680],["a096",0.00455,0.036,1.83,0.5238,2518],["a010",0.00453,0.015,0.76,0.5058,2693],["a076",-0.0039,-0.025,-1.26,0.4979,2667],["a068",-0.00371,-0.032,-1.68,0.5006,2685],["a078",-0.00359,-0.021,-1.04,0.5025,2565],["a048",0.00355,0.018,0.85,0.5131,2368],["a025",0.00352,0.012,0.63,0.4994,2657],["a080",-0.00351,-0.02,-1.03,0.5103,2665],["a092",-0.00346,-0.021,-1.11,0.5056,2696],["a101",-0.00337,-0.011,-0.55,0.49,2696],["a004",0.00318,0.013,0.69,0.5119,2696],["a023",0.00311,0.011,0.58,0.507,2696],["a005",0.003,0.013,0.67,0.4961,2673],["a028",0.00297,0.015,0.78,0.5096,2653],["a038",-0.00284,-0.008,-0.43,0.5122,2696],["a084",-0.00275,-0.009,-0.44,0.4968,2522],["a027",0.00261,0.02,1.02,0.5148,2696],["a024",0.0026,0.01,0.51,0.4944,2686],["a017",-0.00246,-0.009,-0.45,0.5073,2657],["a082",-0.0022,-0.01,-0.5,0.4983,2663],["a050",0.00218,0.016,0.82,0.5155,2543],["a099",-0.0021,-0.013,-0.66,0.4933,2696],["a001",0.00193,0.007,0.35,0.5089,2653],["a035",0.00193,0.007,0.35,0.5087,2693],["a056",-0.00185,-0.007,-0.34,0.5081,2649],["a042",-0.00175,-0.007,-0.36,0.5122,2696],["a007",-0.00145,-0.006,-0.34,0.5101,2666],["a011",-0.00127,-0.007,-0.39,0.5045,2686],["a069",0.00116,0.006,0.3,0.5019,2654],["a021",0.00107,0.004,0.23,0.4844,2665],["a097",0.00105,0.006,0.23,0.4966,1325],["a066",-0.00101,-0.007,-0.35,0.5096,2345],["a090",0.00078,0.004,0.23,0.4958,2612],["a045",-0.00058,-0.004,-0.21,0.4957,2544],["a074",0.00039,0.003,0.13,0.5052,2696]]},"bt":[["8因子组合 多头",290,-0.1249,0.2096,-0.596,-0.2819,0.5,-0.00679,-0.0355],["8因子组合 多空",290,-0.0953,0.1421,-0.67,-0.1738,0.4724,null,null],["101因子等权 多头",290,-0.1243,0.2144,-0.58,-0.2653,0.5034,-0.01122,-0.0527],["101因子等权 多空",290,-0.1001,0.1404,-0.713,-0.1226,0.4931,null,null],["单因子a040 多头",290,-0.1392,0.2273,-0.612,-0.3144,0.5069,-0.02091,-0.123],["单因子a040 多空",290,-0.1622,0.1255,-1.293,-0.1927,0.4828,null,null],["全市场等权 多头",291,0.0162,0.1959,0.083,-0.1917,0.512,null,null]]};
var ALPHA_META = {"a001":{"nm":"恐慌位置","ds":"近 5 日里「恐慌度」最极端的是哪一天。下跌日用 20 日波动率、上涨日用收盘价，再平方放大差距，取期间位置——位置越靠后说明恐慌刚刚发生。","f":"inner = ((returns < 0) ? ts_stddev(returns, 20) : close)\\n→ rank(ts_argmax(signedpower(inner, 2), 5))"},"a002":{"nm":"量变背离","ds":"成交量两日变化与日内涨跌的负相关。放量却收阴、缩量却收阳时因子走高，赌的是量价不同步之后的回归。","f":"→ −1 × ts_corr(rank(delta(log(volume), 2)), rank((close − open) ÷ open), 6)"},"a003":{"nm":"开盘量与价","ds":"开盘价排名与成交量排名的 10 日负相关。开盘越贵成交越少的标的得分越高。","f":"→ −1 × ts_corr(rank(open), rank(volume), 10)"},"a004":{"nm":"低价时点","ds":"最低价排名在过去 9 日中的位置，取负。价格创近期新低时因子走高。","f":"→ −1 × ts_rank(rank(low), 9)"},"a005":{"nm":"开盘离均价","ds":"开盘价相对 10 日 VWAP 均值的偏离，乘以收盘价偏离 VWAP 的幅度。两个偏离同向时信号被放大。","f":"→ rank((open − (ts_sum(vwap, 10) ÷ 10))) × (−1 × abs(rank((close − vwap))))"},"a006":{"nm":"开盘量能","ds":"开盘价与成交量的 10 日相关性取负。开盘价推高但量跟不上时得分高。","f":"→ −1 × ts_corr(open, volume, 10)"},"a007":{"nm":"放量后的七天动量","ds":"仅当成交量高于 20 日均量时生效：7 日涨跌幅的绝对值在 60 日中的分位，再按涨跌方向定符号。放量上涨得分低、放量下跌得分高。","f":"adv20 = adv(amount, 20)\\nd7 = delta(close, 7)\\n→ ((adv20 < volume) ? ((−1 × ts_rank(abs(d7), 60)) × sign(d7)) : −1.0)"},"a008":{"nm":"五日量价合成","ds":"开盘价和与 5 日收益率和的乘积，与 10 日前的同值比较取负。衡量量价配合程度的边际变化。","f":"x = ts_sum(open, 5) × ts_sum(returns, 5)\\n→ −1 × rank((x − delay(x, 10)))"},"a009":{"nm":"价差连续性","ds":"单日价差连续 5 日在同向时顺势取值，方向反转时反号——本质是在判断短期趋势是否还在延续。","f":"d1 = delta(close, 1)\\n→ ((ts_min(d1, 5) > 0) ? d1 : ((ts_max(d1, 5) < 0) ? d1 : (−1 × d1)))"},"a010":{"nm":"价差连续性（4日）","ds":"同 a009，但只用 4 日窗口判断价差是否连续同向，节奏更快、换手更高。","f":"d1 = delta(close, 1)\\n→ rank(((ts_min(d1, 4) > 0) ? d1 : ((ts_max(d1, 4) < 0) ? d1 : (−1 × d1))))"},"a011":{"nm":"VWAP 偏离极值","ds":"近 3 日 VWAP 减收盘的最大值与最小值之和，再乘以成交量 3 日变化。偏离越大、放量越猛，信号越强。","f":"spread = vwap − close\\n→ (rank(ts_max(spread, 3)) + rank(ts_min(spread, 3))) × rank(delta(volume, 3))"},"a012":{"nm":"量价反向","ds":"成交量变化的方向乘以收盘价变化的反号。放量下跌得正分，放量上涨得负分。","f":"→ sign(delta(volume, 1)) × (−1 × delta(close, 1))"},"a013":{"nm":"收盘量协方差","ds":"收盘价排名与成交量排名的 5 日协方差取负。量价同向变动时因子走低。","f":"→ −1 × rank(ts_cov(rank(close), rank(volume), 5))"},"a014":{"nm":"收益变化 × 开盘量能","ds":"3 日收益率变化的排名，乘以开盘价与成交量的 10 日相关性。前半看动能拐点，后半看量价配合。","f":"→ (−1 × rank(delta(returns, 3))) × ts_corr(open, volume, 10)"},"a015":{"nm":"高价量相关累积","ds":"最高价与成交量排名的 3 日相关性，做排名后累加 3 日，取负。","f":"→ −1 × ts_sum(rank(ts_corr(rank(high), rank(volume), 3)), 3)"},"a016":{"nm":"高价量协方差","ds":"最高价排名与成交量排名的 5 日协方差取负。高位放量被视为负面信号。","f":"→ −1 × rank(ts_cov(rank(high), rank(volume), 5))"},"a017":{"nm":"三重压制","ds":"收盘价时序分位、二阶价格变化、相对成交量分位三项连乘取负。任一项弱则整体弱，是典型的多条件共振因子。","f":"adv20 = adv(amount, 20)\\n→ ((−1 × rank(ts_rank(close, 10))) × rank(delta(delta(close, 1), 1))) × rank(ts_rank(volume ÷ adv20, 5))"},"a018":{"nm":"日内振幅背离","ds":"5 日振幅的均值加上当日涨跌，再加收盘与开盘的 10 日相关性，整体取负排名。振幅大且量价背离时得分低。","f":"→ −1 × rank(((ts_stddev(abs(close − open), 5) + (close − open)) + ts_corr(close, open, 10)))"},"a019":{"nm":"长期收益斜率","ds":"7 日价格变化的方向，乘以 250 日收益率累积的排名。短期方向与长期强度同时为正才给出强信号。","f":"→ (−1 × sign(((close − delay(close, 7)) + delta(close, 7)))) × (1 + rank((1 + ts_sum(returns, 250))))"},"a020":{"nm":"开盘跳空三重","ds":"开盘价相对昨日高、收、低三个价位的缺口连乘取负。三个缺口同向时信号最强。","f":"→ ((−1 × rank((open − delay(high, 1)))) × rank((open − delay(close, 1)))) × rank((open − delay(low, 1)))"},"a021":{"nm":"多条件判定","ds":"由若干个价格、成交量、均价条件组合成 +1/−1 的离散信号，条件都不满足时默认 −1。","f":"adv20 = adv(amount, 20)\\nvr = volume ÷ adv20\\ncond1 = (((ts_sum(close, 8) ÷ 8) + ts_stddev(close, 8)) < (ts_sum(close, 2) ÷ 2))\\ncond2 = ((ts_sum(close, 2) ÷ 2) < ((ts_sum(close, 8) ÷ 8) − ts_stddev(close, 8)))\\ncond3 = (vr ≥ 1)\\n→ (cond1 ? −1.0 : (cond2 ? 1.0 : (cond3 ? 1.0 : −1.0)))"},"a022":{"nm":"量价相关变化 × 波动","ds":"高价与成交量 5 日相关性的 5 日变化，乘以 20 日收盘波动率的排名，取负。","f":"→ −1 × (delta(ts_corr(high, volume, 5), 5) × rank(ts_stddev(close, 20)))"},"a023":{"nm":"高价突破","ds":"收盘价站上 20 日均高价时，取 2 日高价变化的反向；否则记 0。只在高位突破时给信号。","f":"→ (((ts_sum(high, 20) ÷ 20) < high) ? (−1 × delta(high, 2)) : 0.0)"},"a024":{"nm":"长期弱势判定","ds":"100 日均价相对 100 日前的涨幅不超过 5% 时，看当前价离 100 日最低有多远；否则看 3 日价格变化。区分「长期横盘」与「仍在下跌」。","f":"x = delta((ts_sum(close, 100) ÷ 100), 100) ÷ delay(close, 100)\\n→ ((x ≤ 0.05) ? (−1 × (close − ts_min(close, 100))) : (−1 × delta(close, 3)))"},"a025":{"nm":"量价负向加权","ds":"收益率、20 日均成交额、VWAP、日内回落幅度四者连乘取负排名。成交量越大、日内回落越深，得分越低。","f":"→ rank(((((−1 × returns) × adv(amount, 20)) × vwap) × (high − close)))"},"a026":{"nm":"量价分位相关极值","ds":"成交量 5 日分位与高价 5 日分位的相关性，取 3 日最大值再取负。","f":"→ −1 × ts_max(ts_corr(ts_rank(volume, 5), ts_rank(high, 5), 5), 3)"},"a027":{"nm":"缩量判定","ds":"5 日成交量之和的 1/20 高于当日量时记 −1，否则 +1。极简的放量/缩量二值信号。","f":"cond = (rank((ts_sum(ts_corr(rank(volume), rank(vwap), 6), 2) ÷ 2.0)) > 0.5)\\n→ (cond ? −1.0 : 1.0)"},"a028":{"nm":"均价低位","ds":"20 日均成交额与最低价的 5 日相关性，加上日内中价与收盘的差，整体缩放。均价托底时得分高。","f":"→ scale(((ts_corr(adv(amount, 20), low, 5) + ((high + low) ÷ 2)) − close))"},"a029":{"nm":"分层动量叠加","ds":"把多层排名、对数、连乘嵌套后取 5 日最小值，再叠加 6 日前收益的反向分位。论文里结构最绕的因子之一，结果仍是动量类信号。","f":"x = rank(rank((−1 × rank(delta((close − 1), 5)))))\\npart = ts_product(rank(rank(scale(log(ts_sum(ts_min(x, 2), 1))))), 1)\\n→ min_(part, 5) + ts_rank(delay((−1 × returns), 6), 5)"},"a030":{"nm":"量能转移","ds":"(1 − 5日与20日价格变化方向的排名) 乘以 5 日量占 20 日量的比重。资金正在集中而非分散时得分高。","f":"sgn = (sign((close − delay(close, 1))) + sign((delay(close, 1) − delay(close, 2)))) + sign((delay(close, 2) − delay(close, 3)))\\n→ ((1.0 − rank(sgn)) × ts_sum(volume, 5)) ÷ ts_sum(volume, 20)"},"a031":{"nm":"加权量价合成","ds":"三段加权：量价衰减相关的排名、价格衰减变化、低量惩罚，线性合成后取反向。","f":"part1 = rank(rank(rank(decay_linear((−1 × rank(rank(delta(close, 10)))), 10))))\\npart2 = rank((−1 × delta(close, 3)))\\npart3 = sign(scale(ts_corr(adv(amount, 20), low, 12)))\\n→ (part1 + part2) + part3"},"a032":{"nm":"均线偏离 + 长周期量价","ds":"7 日均价与收盘的偏离，加上 20 倍 VWAP 与 5 日前收盘的 230 日相关性。后者捕捉「超长期」量价关系，是全集里窗口最长的因子。","f":"→ scale(((ts_sum(close, 7) ÷ 7) − close)) + (20 × scale(ts_corr(vwap, delay(close, 5), 230)))"},"a033":{"nm":"开盘折价","ds":"开盘价相对收盘价的比例取负排名。开盘低于收盘（低开高走）时得分高。","f":"→ rank((−1 × (1 − open ÷ close)))"},"a034":{"nm":"波动比与价格变化","ds":"2 日与 5 日波动率之比，加上价格日变化的排名，合成后排名。短期波动突然收缩时得分高。","f":"→ rank(((1 − rank(ts_stddev(returns, 2) ÷ ts_stddev(returns, 5))) + (1 − rank(delta(close, 1)))))"},"a035":{"nm":"量价分位三重","ds":"成交量 32 日分位 × (1 − 日内振幅 16 日分位) × (1 − 收益率 32 日分位)。三者都低时得分高，是「平静」信号。","f":"→ (ts_rank(volume, 32) × (1 − ts_rank(((close + high) − low), 16))) × (1 − ts_rank(returns, 32))"},"a036":{"nm":"四段加权动量","ds":"2.21×量价相关排名 + 0.7×日内回落排名 + 0.73×短期动量排名 + 成交量加权。论文给出的权重，偏向量价配合。","f":"adv20 = adv(amount, 20)\\n→ ((((2.21 × rank(ts_corr((close − open), delay(volume, 1), 15))) + (0.7 × rank((open − close)))) + (0.73 × rank(ts_rank(delay((−1 × returns), 6), 5)))) + rank(abs(ts_corr(vwap, adv20, 6)))) + (0.6 × rank((((ts_sum(close, 200) ÷ 200) − open) × (close − open))))"},"a037":{"nm":"日内回落与长期相关","ds":"前一日 (开盘−收盘) 与收盘价的 200 日相关性排名，加上当日日内回落排名。","f":"→ rank(ts_corr(delay((open − close), 1), close, 200)) + rank((open − close))"},"a038":{"nm":"收盘分位 × 开收比","ds":"收盘价 10 日分位的排名，乘以收盘/开盘比值的排名，取负。","f":"→ (−1 × rank(ts_rank(close, 10))) × rank(close ÷ open)"},"a039":{"nm":"长期趋势 × 量能衰减","ds":"7 日价格变化 × (1 − 相对成交量的衰减排名)，再乘以 250 日累计收益。长周期动量与资金流入同时成立才有强信号。","f":"adv20 = adv(amount, 20)\\n→ (−1 × rank((delta(close, 7) × (1 − rank(decay_linear(volume ÷ adv20, 9)))))) × (1 + rank(ts_sum(returns, 250)))"},"a040":{"nm":"高价波动 × 量价背离","ds":"最高价 10 日波动率的排名，乘以高低价与成交量的 10 日相关性，取负。","f":"→ (−1 × rank(ts_stddev(high, 10))) × ts_corr(high, volume, 10)"},"a041":{"nm":"几何均价偏离","ds":"最高价与最低价的几何平均减去 VWAP。价格中枢高于成交均价时为正。","f":"→ np.sqrt((high × low)) − vwap"},"a042":{"nm":"VWAP 相对位置","ds":"VWAP 减收盘与 VWAP 加收盘两个排名之比。收盘远低于 VWAP 时得分高。","f":"→ rank((vwap − close)) ÷ rank((vwap + close))"},"a043":{"nm":"量能分位 × 跌幅分位","ds":"相对成交量 20 日分位，乘以 7 日跌幅的 8 日分位。放量下跌时信号最强。","f":"→ ts_rank(volume ÷ adv(amount, 20), 20) × ts_rank((−1 × delta(close, 7)), 8)"},"a044":{"nm":"高价量相关","ds":"最高价与成交量排名的 5 日相关性取负。","f":"→ −1 × ts_corr(high, rank(volume), 5)"},"a045":{"nm":"三重量价结构","ds":"5 日前收盘的 20 日均价排名 × 收盘与成交量的 2 日相关 × 短期与长期均价的相关排名，取负。","f":"→ −1 × ((rank((ts_sum(delay(close, 5), 20) ÷ 20)) × ts_corr(close, volume, 2)) × rank(ts_corr(ts_sum(close, 5), ts_sum(close, 20), 2)))"},"a046":{"nm":"日内位置分档","ds":"用收盘价在日内区间的位置分三档：高位给负、低位给正、中间用当日价格变化取反。区间用 2 日数据算。","f":"x = ((delay(close, 20) − delay(close, 10)) ÷ 10) − ((delay(close, 10) − close) ÷ 10)\\n→ ((x > 0.25) ? −1.0 : ((x < 0) ? 1.0 : (−1 × (close − delay(close, 1)))))"},"a047":{"nm":"量能加权反转","ds":"收盘倒数 × 相对量 × 高价相对回落，再减去 VWAP 的 5 日变化。","f":"adv20 = adv(amount, 20)\\ninner = ((rank((1 ÷ close)) × volume) ÷ adv20) ÷ (ts_sum(high, 5) ÷ 5) × (high × rank((high − close)))\\n→ inner − rank((vwap − delay(vwap, 5)))"},"a048":{"nm":"行业中性量价","ds":"价格二阶变化与 250 日相关的乘积，先做行业中性化（这里用资产类别代理）再除以波动率。全集里唯一显式做中性化的因子。","f":"num = ts_corr(delta(close, 1), delta(delay(close, 1), 1), 250) × delta(close, 1)\\nnum = indneutralize(num ÷ close, asset_class)\\nden = ts_sum(((delta(close, 1) ÷ delay(close, 1)) ^ 2), 250)\\n→ num ÷ den"},"a049":{"nm":"跌破均线","ds":"5 日均价相对 5 日前跌破 10% 时记 +1，否则取当日价格变化的反向。赌超跌反弹。","f":"x = ((delay(close, 20) − delay(close, 10)) ÷ 10) − ((delay(close, 10) − close) ÷ 10)\\n→ ((x < −0.1) ? 1.0 : (−1 × (close − delay(close, 1))))"},"a050":{"nm":"量价相关峰值","ds":"成交量排名与 VWAP 排名 5 日相关性的排名，取 5 日最大值再取负。","f":"→ −1 × ts_max(rank(ts_corr(rank(volume), rank(vwap), 5)), 5)"},"a051":{"nm":"跌破均线（5%）","ds":"同 a049，但阈值放宽到 −5%，触发更频繁。","f":"x = ((delay(close, 20) − delay(close, 10)) ÷ 10) − ((delay(close, 10) − close) ÷ 10)\\n→ ((x < −0.05) ? 1.0 : (−1 × (close − delay(close, 1))))"},"a052":{"nm":"低位反抽 × 长期收益","ds":"5 日最低价的变化，乘以 220 日累计收益的排名，再乘成交量分位。低位放量反抽时得分高。","f":"→ (((−1 × ts_min(low, 5)) + delay(ts_min(low, 5), 5)) × rank(((ts_sum(returns, 240) − ts_sum(returns, 20)) ÷ 220))) × ts_rank(volume, 5)"},"a053":{"nm":"日内位置变化","ds":"收盘价在日内区间中的相对位置，取 9 日变化的反向。位置快速上移时得分低。","f":"→ −1 × delta(((close − low) − (high − close)) ÷ (close − low), 9)"},"a054":{"nm":"价格幂次比","ds":"(低−收)×开盘^5 ÷ ((低−高)×收盘^5)。用五次幂放大开收盘差异，是全集里唯一带高次幂的因子。","f":"→ ((−1 × (low − close)) × (open ^ 5)) ÷ ((low − high) × (close ^ 5))"},"a055":{"nm":"区间位置与量","ds":"收盘在 12 日高低区间中的位置排名，与成交量排名做 6 日相关取负。","f":"rng = ts_max(high, 12) − ts_min(low, 12)\\n→ −1 × ts_corr(rank((close − ts_min(low, 12)) ÷ rng), rank(volume), 6)"},"a056":{"nm":"短长收益比 × 量价","ds":"10 日收益与 6 日收益之比排名，乘以收益率×成交额的排名，取负。","f":"→ −1 × (rank(ts_sum(returns, 10) ÷ ts_sum(ts_sum(returns, 2), 3)) × rank((returns × amount)))"},"a057":{"nm":"收盘离 VWAP","ds":"收盘价减 VWAP，除以收盘 30 日极值位置的衰减排名，取负。","f":"→ −1 × (close − vwap) ÷ decay_linear(rank(ts_argmax(close, 30)), 2)"},"a058":{"nm":"中性化 VWAP 量能","ds":"VWAP 做行业中性化后与成交量的 4 日相关，衰减加权后取 6 日分位，再取负。","f":"→ −1 × ts_rank(decay_linear(ts_corr(indneutralize(vwap, asset_class), volume, 4), 8), 6)"},"a059":{"nm":"中性化 VWAP 量能（加权）","ds":"同 a058，但 VWAP 先按 0.728 的权重与自身混合一次，衰减窗口从 8 拉长到 16。","f":"k = 0.728317\\n→ −1 × ts_rank(decay_linear(ts_corr(indneutralize(((vwap × k) + (vwap × (1 − k))), asset_class), volume, 4), 16), 8)"},"a060":{"nm":"日内位置量能","ds":"日内位置乘成交量后的排名缩放，减去收盘 10 日极值位置的排名缩放，取负。","f":"inner = ((close − low) − (high − close)) ÷ (high − low) × volume\\n→ −1 × ((2 × scale(rank(inner))) − scale(rank(ts_argmax(close, 10))))"},"a061":{"nm":"VWAP 低位","ds":"VWAP 离 16 日最低的距离排名，低于 VWAP 与 180 日均额的相关排名时记 1。","f":"→ (rank((vwap − ts_min(vwap, 16))) < rank(ts_corr(vwap, adv(amount, 180), 18)))"},"a062":{"nm":"多重排名比较","ds":"把 VWAP、均价、成交量、开盘价的多组排名做大小比较，输出 0/1 信号取负。","f":"cond = (rank(ts_corr(vwap, ts_sum(adv(amount, 20), 22), 10)) < rank(((rank(open) + rank(open)) < (rank(((high + low) ÷ 2)) + rank(high)))))\\n→ −1.0 × cond"},"a063":{"nm":"中性化价格变化差","ds":"收盘做行业中性化后的 2 日变化衰减排名，减去开盘价中性化后的同项，取负。","f":"k = 0.318108\\np1 = rank(decay_linear(delta(indneutralize(close, asset_class), 2), 8))\\np2 = rank(decay_linear(ts_corr(((vwap × k) + (open × (1 − k))), ts_sum(adv(amount, 180), 37), 14), 12))\\n→ −1 × (p1 − p2)"},"a064":{"nm":"加权开低 vs 均额","ds":"开盘与最低价加权后与 120 日均额的相关排名，低于日内中价与 15 日均额的相关排名时记 1，取负。","f":"k = 0.178404\\np1 = rank(ts_corr(ts_sum(((open × k) + (low × (1 − k))), 13), ts_sum(adv(amount, 120), 13), 17))\\np2 = rank(delta(((((high + low) ÷ 2) × k) + (vwap × (1 − k))), 4))\\n→ −1.0 × (p1 < p2)"},"a065":{"nm":"开盘 VWAP 加权","ds":"开盘与 VWAP 加权后与 60 日均额求相关，与最低价 VWAP 加权版本比较，输出 0/1。","f":"k = 0.00817205\\np1 = rank(ts_corr(((open × k) + (vwap × (1 − k))), ts_sum(adv(amount, 60), 9), 6))\\np2 = rank((open − ts_min(open, 14)))\\n→ −1.0 × (p1 < p2)"},"a066":{"nm":"VWAP 变化 + 位置","ds":"VWAP 4 日变化的衰减排名，加上日内位置相对 VWAP 的分位，取负。","f":"p1 = rank(decay_linear(delta(vwap, 4), 7))\\np2 = ts_rank(decay_linear((low − vwap) ÷ (open − ((high + low) ÷ 2)), 11), 7)\\n→ −1 × (p1 + p2)"},"a067":{"nm":"高价抬升 × 中性化量能","ds":"最高价相对 2 日最低的抬升排名，与中性化 VWAP 和均额相关的排名做幂运算，取负。","f":"p1 = rank((high − ts_min(high, 2)))\\np2 = rank(ts_corr(indneutralize(vwap, asset_class), indneutralize(adv(amount, 20), asset_class), 6))\\n→ −1 × (p1 ^ p2)"},"a068":{"nm":"高价量相关 vs 加权价","ds":"高价与 15 日均额相关的时序分位，低于收盘与最低价加权价的衰减变化排名时记 1，取负。","f":"p1 = ts_rank(ts_corr(rank(high), rank(adv(amount, 15)), 9), 14)\\np2 = rank(delta(((close × 0.518371) + (low × (1 − 0.518371))), 1))\\n→ −1.0 × (p1 < p2)"},"a069":{"nm":"中性化 VWAP 极值","ds":"中性化 VWAP 的 3 日变化 5 日最大值排名，与收盘和最低价加权后的相关性排名做幂运算，取负。","f":"p1 = rank(ts_max(delta(indneutralize(vwap, asset_class), 3), 5))\\np2 = ts_rank(ts_corr(((close × 0.490655) + (vwap × (1 − 0.490655))), adv(amount, 20), 5), 9)\\n→ −1 × (p1 ^ p2)"},"a070":{"nm":"VWAP 变化 × 中性化相关","ds":"VWAP 日变化排名，与中性化收盘和 50 日均额相关的分位做幂运算，取负。","f":"p1 = rank(delta(vwap, 1))\\np2 = ts_rank(ts_corr(indneutralize(close, asset_class), adv(amount, 50), 18), 18)\\n→ −1 × (p1 ^ p2)"},"a071":{"nm":"双分量取大","ds":"收盘与均额相关的衰减分位，与收盘分位和最低价相关的衰减分位，取较大者。","f":"p1 = ts_rank(decay_linear(ts_corr(ts_rank(close, 3), ts_rank(adv(amount, 180), 12), 18), 4), 16)\\np2 = ts_rank(decay_linear((rank(((low + open) − (2 × vwap))) ^ 2), 16), 4)\\n→ max_(p1, p2)"},"a072":{"nm":"日内中价 vs 最低价","ds":"日内中价与 40 日均额相关，除以最低价与均额相关，比值型因子。","f":"p1 = rank(decay_linear(ts_corr(((high + low) ÷ 2), adv(amount, 40), 9), 10))\\np2 = rank(decay_linear(ts_corr(ts_rank(vwap, 4), ts_rank(volume, 19), 7), 3))\\n→ p1 ÷ p2"},"a073":{"nm":"VWAP 变化最值","ds":"VWAP 5 日变化的衰减排名，与开盘最低加权价的分位，取较大者再取负。","f":"p1 = rank(decay_linear(delta(vwap, 5), 3))\\nk = 0.147155\\nx = (open × k) + (low × (1 − k))\\np2 = ts_rank(decay_linear((delta(x, 2) ÷ x × −1), 3), 17)\\n→ −1 × max_(p1, p2)"},"a074":{"nm":"收盘 vs 加权高价","ds":"收盘与 30 日均额的相关排名，低于高价与 VWAP 加权后的相关排名时记 1，取负。","f":"p1 = rank(ts_corr(close, ts_sum(adv(amount, 30), 37), 15))\\np2 = rank(ts_corr(rank(((high × 0.0261661) + (vwap × (1 − 0.0261661)))), rank(volume), 11))\\n→ −1.0 × (p1 < p2)"},"a075":{"nm":"VWAP 量比 vs 低价量比","ds":"VWAP 与成交量的 4 日相关排名，低于低价与 50 日均额相关排名时记 1。","f":"→ (rank(ts_corr(vwap, volume, 4)) < rank(ts_corr(rank(low), rank(adv(amount, 50)), 12)))"},"a076":{"nm":"VWAP 变化（双版本）","ds":"VWAP 日变化衰减排名，与中性化低价和均额相关的分位，取较大者取负。","f":"p1 = rank(decay_linear(delta(vwap, 1), 12))\\np2 = ts_rank(decay_linear(ts_rank(ts_corr(indneutralize(low, asset_class), adv(amount, 81), 8), 20), 17), 19)\\n→ −1 × max_(p1, p2)"},"a077":{"nm":"双衰减取小","ds":"日内中价相关组合与低价 VWAP 组合的衰减排名，取较小者。","f":"p1 = rank(decay_linear(((((high + low) ÷ 2) + high) − (vwap + high)), 20))\\np2 = rank(decay_linear(ts_corr(((high + low) ÷ 2), adv(amount, 40), 3), 6))\\n→ min_(p1, p2)"},"a078":{"nm":"低价 VWAP 加权幂","ds":"低价与 VWAP 加权后与 40 日均额相关，与日内中价相关做幂运算。","f":"k = 0.352233\\np1 = rank(ts_corr(ts_sum(((low × k) + (vwap × (1 − k))), 20), ts_sum(adv(amount, 40), 20), 7))\\np2 = rank(ts_corr(rank(vwap), rank(volume), 6))\\n→ p1 ^ p2"},"a079":{"nm":"中性化价格分位","ds":"中性化收盘低价加权价的日变化排名，低于 VWAP 分位与均额相关的分位时记 1。","f":"p1 = rank(delta(indneutralize(((close × 0.60733) + (open × (1 − 0.60733))), asset_class), 1))\\np2 = rank(ts_corr(ts_rank(vwap, 4), ts_rank(adv(amount, 150), 9), 15))\\n→ 1.0 × (p1 < p2)"},"a080":{"nm":"量价一致性的分位","ds":"收盘与成交量 5 日相关，做 18 日分位后再按成交量分位调整，取负。","f":"k = 0.868128\\np1 = rank(sign(delta(indneutralize(((open × k) + (high × (1 − k))), asset_class), 4)))\\np2 = ts_rank(ts_corr(high, adv(amount, 10), 5), 6)\\n→ −1 × (p1 ^ p2)"},"a081":{"nm":"VWAP 与均额（8日）","ds":"VWAP 与 10 日均额 8 日相关的四次幂排名，低于 VWAP 与成交量相关排名时记 1，取负。","f":"p1 = rank(log(ts_product(rank((rank(ts_corr(vwap, ts_sum(adv(amount, 10), 50), 8)) ^ 4)), 15)))\\np2 = rank(ts_corr(rank(vwap), rank(volume), 5))\\n→ −1.0 × (p1 < p2)"},"a082":{"nm":"开盘变化 vs 量价","ds":"开盘价日变化衰减排名，与收盘量价相关的衰减排名，取较小者取负。","f":"p1 = rank(decay_linear(delta(open, 1), 15))\\np2 = ts_rank(decay_linear(ts_corr(indneutralize(volume, asset_class), open, 17), 7), 13)\\n→ −1 × min_(p1, p2)"},"a083":{"nm":"振幅比 × 量","ds":"日内振幅占 5 日均价比例的 2 日滞后排名，乘以成交量排名，再除以振幅与 VWAP 偏离之比。","f":"x = (high − low) ÷ (ts_sum(close, 5) ÷ 5)\\n→ (rank(delay(x, 2)) × rank(rank(volume))) ÷ x ÷ (vwap − close)"},"a084":{"nm":"VWAP 极值分位幂","ds":"VWAP 距 15 日最高的分位，以价格 5 日变化为指数做幂运算。符号随价格变化翻转，是全集里最敏感的一个。","f":"p1 = signedpower(ts_rank((vwap − ts_max(vwap, 15)), 21), delta(close, 5))\\n→ p1"},"a085":{"nm":"高价权重相关","ds":"高价与收盘加权后与 30 日均额相关，再以高价分位与成交量分位相关的分位为指数。","f":"p1 = rank(ts_corr(((high × 0.876703) + (close × (1 − 0.876703))), adv(amount, 30), 10))\\np2 = rank(ts_corr(ts_rank(((high + low) ÷ 2), 4), ts_rank(volume, 10), 7))\\n→ p1 ^ p2"},"a086":{"nm":"收盘均额相关分位","ds":"收盘与 15 日均额 6 日相关的 20 日分位，低于开盘收盘和与 VWAP 和之差的排名时记 1，取负。","f":"p1 = ts_rank(ts_corr(close, ts_sum(adv(amount, 20), 15), 6), 20)\\np2 = rank(((open + close) − (vwap + open)))\\n→ −1.0 × (p1 < p2)"},"a087":{"nm":"加权价衰减差","ds":"收盘 VWAP 加权价的衰减变化排名，减去中性化 VWAP 与均额相关的衰减分位，取较大者再取负。","f":"p1 = rank(decay_linear(delta(((close × 0.369701) + (vwap × (1 − 0.369701))), 2), 3))\\np2 = ts_rank(decay_linear(abs(ts_corr(indneutralize(adv(amount, 81), asset_class), close, 13)), 5), 14)\\n→ −1 × max_(p1, p2)"},"a088":{"nm":"开低高收组合","ds":"开盘与最低价排名之和，减去高价与收盘排名之和，衰减后与收盘分位比较，取较小者。","f":"p1 = rank(decay_linear((((rank(open) + rank(low)) − rank(high)) − rank(close)), 8))\\np2 = ts_rank(decay_linear(ts_corr(ts_rank(close, 8), ts_rank(adv(amount, 60), 21), 8), 7), 3)\\n→ min_(p1, p2)"},"a089":{"nm":"低价均额 vs 中性化 VWAP","ds":"低价与 10 日均额相关的衰减排名，减去中性化 VWAP 变化的衰减分位，取负。","f":"p1 = ts_rank(decay_linear(ts_corr(low, adv(amount, 10), 7), 6), 4)\\np2 = ts_rank(decay_linear(delta(indneutralize(vwap, asset_class), 3), 10), 15)\\n→ p1 − p2"},"a090":{"nm":"收盘极值 vs 低价相关","ds":"收盘距 5 日最高的排名，低于低价与 40 日均额相关排名时记 1，取负。","f":"p1 = rank((close − ts_max(close, 5)))\\np2 = ts_rank(ts_corr(indneutralize(adv(amount, 40), asset_class), low, 5), 3)\\n→ −1 × (p1 ^ p2)"},"a091":{"nm":"双重衰减比较","ds":"收盘成交量相关的双层衰减分位，低于 VWAP 与 30 日均额相关的衰减排名时记 1，取负。","f":"p1 = ts_rank(decay_linear(decay_linear(ts_corr(indneutralize(close, asset_class), volume, 10), 16), 4), 5)\\np2 = rank(decay_linear(ts_corr(vwap, adv(amount, 30), 4), 3))\\n→ −1 × (p1 − p2)"},"a092":{"nm":"日内中价条件取值","ds":"日内中价低于开盘低价组合时取最低价，否则取中价，衰减后与低价相关分位取较小者。","f":"p1 = ts_rank(decay_linear(((((high + low) ÷ 2) + close) < (low + open)), 15), 19)\\np2 = ts_rank(decay_linear(ts_corr(rank(low), rank(adv(amount, 30)), 8), 7), 7)\\n→ min_(p1, p2)"},"a093":{"nm":"中性化 VWAP 长窗口","ds":"中性化 VWAP 与 81 日均额 17 日相关，衰减 20 日后再取 8 日分位，取负。","f":"p1 = ts_rank(decay_linear(ts_corr(indneutralize(vwap, asset_class), adv(amount, 81), 17), 20), 8)\\np2 = rank(decay_linear(delta(((close × 0.524434) + (vwap × (1 − 0.524434))), 3), 16))\\n→ p1 ÷ p2"},"a094":{"nm":"VWAP 极值幂","ds":"VWAP 距 12 日最低的排名，以 VWAP 分位与均额相关的分位为指数做幂运算，取负。","f":"p1 = rank((vwap − ts_min(vwap, 12)))\\np2 = ts_rank(ts_corr(ts_rank(vwap, 20), ts_rank(adv(amount, 60), 4), 18), 3)\\n→ −1 × (p1 ^ p2)"},"a095":{"nm":"振幅比 vs 低价相关","ds":"日内振幅占 5 日均价的衰减分位，低于低价与 40 日均额相关的衰减分位时记 1，取负。","f":"p1 = rank((open − ts_min(open, 12)))\\np2 = ts_rank((rank(ts_corr(ts_sum(((high + low) ÷ 2), 19), ts_sum(adv(amount, 40), 19), 13)) ^ 5), 12)\\n→ 1.0 × (p1 < p2)"},"a096":{"nm":"量价与极值取大","ds":"VWAP 成交量相关的衰减分位，与收盘分位和均额相关的极值分位，取较大者取负。","f":"p1 = ts_rank(decay_linear(ts_corr(rank(vwap), rank(volume), 4), 4), 8)\\np2 = ts_rank(decay_linear(ts_argmax(ts_corr(ts_rank(close, 7), ts_rank(adv(amount, 60), 4), 4), 13), 14), 13)\\n→ −1 × max_(p1, p2)"},"a097":{"nm":"中性化低价衰减差","ds":"中性化低价 VWAP 加权价的衰减变化排名，减去低价分位与均额相关的极值分位，取负。","f":"p1 = rank(decay_linear(delta(indneutralize(((low × 0.721001) + (vwap × (1 − 0.721001))), asset_class), 3), 20))\\np2 = ts_rank(decay_linear(ts_rank(ts_corr(ts_rank(low, 8), ts_rank(adv(amount, 60), 17), 5), 19), 16), 7)\\n→ −1 × (p1 − p2)"},"a098":{"nm":"VWAP 均额 + 开盘极值","ds":"VWAP 与 5 日均额相关的衰减分位取负，再减去开盘价与 15 日均额相关极值的分位。","f":"p1 = rank(decay_linear(ts_corr(vwap, ts_sum(adv(amount, 5), 26), 5), 7))\\np2 = rank(decay_linear(ts_rank(ts_argmin(ts_corr(rank(open), rank(adv(amount, 15)), 21), 9), 7), 8))\\n→ p1 − p2"},"a099":{"nm":"中价 vs 低价量","ds":"日内中价的 20 日均值与 60 日均额相关的排名，低于低价与成交量相关排名时记 1，取负。","f":"p1 = rank(ts_corr(ts_sum(((high + low) ÷ 2), 20), ts_sum(adv(amount, 60), 20), 9))\\np2 = rank(ts_corr(low, volume, 6))\\n→ −1.0 × (p1 < p2)"},"a100":{"nm":"日内位置量能（放大）","ds":"日内位置乘成交量的排名缩放 ×1.5 取负，减去 VWAP 与 5 日均额相关的缩放。","f":"inner = ((close − low) − (high − close)) ÷ (high − low) × volume\\np1 = scale(indneutralize(indneutralize(rank(inner), asset_class), asset_class))\\np2 = scale(indneutralize((ts_corr(close, rank(adv(amount, 20)), 5) − rank(ts_argmin(close, 30))), asset_class))\\n→ (−1 × ((1.5 × p1) − p2)) × volume ÷ adv(amount, 20)"},"a101":{"nm":"日内涨跌幅度","ds":"收盘减开盘，除以日内振幅。最朴素的一个：当天从开盘到收盘走了整个区间的百分之多少。","f":"→ (close − open) ÷ ((high − low) + 0.001)"}};
var DEFAULT_WATCH = ['510300','159915','588000','513180','513120','513050','518880'];
var LS = 'etf_watch_v3';
var watch = loadWatch();

var DATA = [];                 // 全市场归一化数据
var STATS = null;
var LIVE = {};                 // 自选高频覆盖 {code: item}
var g = 'all', sortKey = 'amt', limit = 100, kw = '';
var DATA_SRC = '', DATA_TS = 0;
var lastP = {}, timerSlow = null, timerFast = null, retryTimer = null;

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
function calcGroup(n){
  for (var i=0;i<RULES.length;i++){
    var ws = RULES[i][1];
    for (var j=0;j<ws.length;j++) if (n.indexOf(ws[j]) >= 0) return RULES[i][0];
  }
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

/* ---------- 自选同步（Workers KV） ----------
   本地先写，云端异步推，800ms 防抖——用户连点几下删除不会打出 5 个请求。
   云端未配置（Deno 无 KV、或 wrangler.toml 没绑）时静默降级为纯本地。 */
var WATCH_CLOUD = false;
var pushTimer = null;

/* 自选分桶用的匿名编号。
   不同的人打开同一个网址，各自有一份，互不覆盖——共用一份的话，
   陌生人一按「+」就把别人的自选改掉了。
   想跨设备带过去：复制页面上「同步」给出的链接（带 ?u=）在另一台打开。 */
var WATCH_UID = (function(){
  var LSK = 'etfUid';
  var u = '';
  try { u = localStorage.getItem(LSK) || ''; } catch (e) {}
  var fromUrl = qs('u');
  if (fromUrl) u = fromUrl;
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

function dedupCount(){
  // 参与去重、且不是代表标的的只数
  var n = 0;
  for (var i=0;i<DATA.length;i++){
    var x = DATA[i];
    if (x.ix && KEEP[x.ix] && KEEP[x.ix] !== x.c) n++;
  }
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

function renderWatch(){
  var body = document.getElementById('watchBody');
  if (!watch.length){
    body.innerHTML = '<tr><td colspan="13" class="empty">还没有自选，点下方榜单的 + 添加</td></tr>';
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
        + '<td class="l" colspan="11" style="color:var(--txt3)">未取到（可能已退市或非场内 ETF）</td>'
        + '<td class="ctr"><span class="act del" data-del="'+c+'">×</span></td></tr>';
      continue;
    }
    html += '<tr class="hr" data-c="' + x.c + '">' + rowHtml(x, true) + '</tr>';
  }
  body.innerHTML = html;
  document.getElementById('watchN').innerHTML = watch.length + ' 只'
    + (miss ? ('，' + miss + ' 只未取到') : '')
    + (WATCH_CLOUD ? '<span class="syn" title="已与云端同步，换设备也是这份列表">云端</span>' : '');
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

/* ================= 历史 K 线面板 =================
   数据来自 R2 上的精简二进制（近 500 天 × 17 字段），Worker 只做透传。
   为什么不在 Worker 里解 Parquet：单只 2.27MB / 165 列，光 zstd 解压
   就要几百毫秒，免费版只有 10ms CPU。所以解析全部放在这里。

   画图用原生 canvas，不引图表库——一个 K 线面板带 3 个子图，
   引库要多 100KB+，还得跟着库的版本走。 */

var HC = {
  up:'#ff4d4f', dn:'#00c48c', ma20:'#e8a33d', ma60:'#4c8dff',
  grid:'#202632', axis:'#5a6373', cross:'#7a8699', vol:'#2c3444', rsi:'#b07cff',
  boll:'#5b6b82'
};

var H = {
  code:'', name:'', d:null, range:250, hover:-1, ok:false,
  sub:'rsi', ov:{ ma:true, boll:false },
  cv:null, ctx:null, off:null, octx:null,
  W:0, Ht:0, dpr:1, geo:null
};

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

function openHist(code, name){
  H.code = code; H.name = name || code; H.d = null; H.hover = -1; H.ok = false; H.ext = false;
  document.getElementById('hName').textContent = H.name;
  document.getElementById('hCode').textContent = code;
  document.getElementById('hPx').textContent = '-';
  document.getElementById('hChg').textContent = '';
  document.getElementById('hLeg').innerHTML = '<span>加载中…</span>';
  document.getElementById('hNote').textContent = '';
  document.getElementById('histMask').classList.add('on');

  var x = findItem(code);
  if (x){
    document.getElementById('hPx').textContent = fnum(x.p, 3);
    var ch = document.getElementById('hChg');
    ch.textContent = fpc(x.chg);
    ch.className = 'ch ' + cc(x.chg);
  }
  hSize();

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
  H.code = ''; H.d = null;
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
  rsi:  { nm:'RSI14',  col:'#b07cff', fixed:[0,100], refs:[30,70],
          arr:function(c){ return c.rsi14; }, fmt:function(v){ return v.toFixed(0); } },
  vr:   { nm:'量比5',  col:'#e8a33d', refs:[1],
          arr:function(c){ return c.vol_ratio5; }, fmt:function(v){ return v.toFixed(2); } },
  hvol: { nm:'波动率', col:'#4c8dff',
          arr:function(c){ return c.hvol20; }, fmt:function(v){ return v.toFixed(1) + '%'; } },
  atr:  { nm:'ATR14',  col:'#00c48c',
          arr:function(c){ return c.atr14; }, fmt:function(v){ return v.toFixed(3); } },
  pb:   { nm:'BOLL%B', col:'#e8a33d', fixed:[0,100], refs:[0,50,100], arr:null,
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

    ctx.strokeStyle = '#39435460'; ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y0) + 0.5);
    ctx.lineTo(padL + plotW, Math.round(y0) + 0.5); ctx.stroke();
    ctx.setLineDash([]);

    var bw = Math.max(1, plotW / (n - i0) * 0.6);
    for (i = i0; i < n; i++){
      if (!isFinite(dif[i]) || !isFinite(dea[i])) continue;
      var hv = dif[i] - dea[i], X = xOf(i);
      ctx.fillStyle = hv >= 0 ? 'rgba(255,77,79,.6)' : 'rgba(0,196,140,.6)';
      ctx.fillRect(X - bw / 2, Math.min(yM(hv), y0), bw, Math.max(1, Math.abs(yM(hv) - y0)));
    }
    hLine(ctx, dif, i0, n, xOf, yM, '#e8a33d', 1.1);
    hLine(ctx, dea, i0, n, xOf, yM, '#4c8dff', 1.1);

    ctx.fillStyle = HC.axis; ctx.textAlign = 'left';
    ctx.textBaseline = 'top'; ctx.fillText(mx.toFixed(2), padL + plotW + 5, yR + 1);
    ctx.textBaseline = 'bottom'; ctx.fillText('-' + mx.toFixed(2), padL + plotW + 5, yR + hR);
    subName(ctx, 'MACD', padL, yR, '#8a94a6');
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
    ctx.strokeStyle = '#39435460'; ctx.setLineDash([3,4]);
    for (i = 0; i < def.refs.length; i++){
      var lv = def.refs[i];
      if (lv < lo || lv > hi) continue;
      var yy = Math.round(yS(lv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      if (kind === 'rsi' && hR >= 74){
        ctx.fillStyle = '#4a5464'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
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

function hDraw(){
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
    ctx.fillStyle = cUp ? 'rgba(255,77,79,.55)' : 'rgba(0,196,140,.55)';
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
    ctx.fillStyle = '#1b2330';
    var lab = fnum(c.close[idx], 3);
    ctx.fillRect(g.padL + g.plotW + 2, yy - 7, 50, 14);
    ctx.fillStyle = '#cfd6e2'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '10px ui-monospace,Menlo,monospace';
    ctx.fillText(lab, g.padL + g.plotW + 6, yy);
  }
  hLegend(idx);
}

function hLegend(idx){
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
function renderRs(){
  var R = RESEARCH;
  if (!R) return;
  document.getElementById('rsSub').textContent =
    R.window[0] + ' ~ ' + R.window[1] + ' · 因子 ' + R.ic.n
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
    + '<b>所以这个页面的价值在盯盘和 K 线，不在选股信号。</b>'
    + '因子部分保留下来是为了留个记录：这些数跑过，结论是负的，别再重复试一遍。'
    + '</div><div class="rssrc">完整推导见仓库 docs/FACTORS.md（620 行）</div></div>';

  document.getElementById('rsBody').innerHTML = h;
  rsBind();
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

document.getElementById('btnSync').onclick = function(){
  var link = location.origin + '/?u=' + encodeURIComponent(WATCH_UID);
  function fallback(){ window.prompt('在另一台设备打开这个链接，就是你现在的自选：', link); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(function(){
      toast('同步链接已复制，在另一台设备打开即可');
    }).catch(fallback);
  } else fallback();
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
  if (document.getElementById('rsMask').classList.contains('on')) { closeRs(); return; }
  if (document.getElementById('histMask').classList.contains('on')) closeHist();
});

document.getElementById('histCv').addEventListener('mousemove', function(e){
  var g = H.geo; if (!g || !H.d) return;
  var rect = this.getBoundingClientRect();
  var x = e.clientX - rect.left;
  var idx = g.i0 + Math.floor((x - g.padL) / g.bw);
  var rng = H.range || H.d.n;
  idx = Math.max(g.i0, Math.min(H.d.n - 1, idx));
  if (idx === H.hover) return;
  H.hover = idx;
  hCross(idx);
});
document.getElementById('histCv').addEventListener('mouseleave', function(){
  if (!H.geo) return;
  H.hover = -1;
  H.ctx.setTransform(1,0,0,1,0,0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, H.W, H.Ht);
  hLegend(-1);
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
    if (H.d){ H.hover = -1; hDraw(); hLegend(-1); }
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

    renderCards(); renderList(); renderWatch();
    hRefresh();                      // 弹窗开着就跟着这次快照重算最后一根
  }).catch(function(e){
    setStale('行情源暂时不可用（' + e.message + '），15 秒后自动重试；自选行情走腾讯直连，不受影响', true);
    document.getElementById('fErr').textContent = '';
    if (!DATA.length) document.getElementById('listBody').innerHTML =
      '<tr><td colspan="11" class="empty">行情源暂时不可用，正在自动重试…<br>'
      + '<span style="opacity:.55;font-size:12px">' + e.message + '</span></td></tr>';
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
  clearInterval(timerSlow); clearInterval(timerFast);
  var open = isOpen();
  // 全市场：交易时段 60 秒，非交易 300 秒（保护新浪上游，避免被风控）
  timerSlow = setInterval(loadFull, open ? 60000 : 300000);
  // 自选高频：浏览器直连腾讯，不经过 Worker，5 秒一次也不消耗任何配额
  timerFast = setInterval(loadTXQuotes, open ? 5000 : 30000);
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

document.body.addEventListener('click', function(e){
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
clock(); setInterval(clock, 1000);

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
  loadFull().then(function(){
    renderCards();
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
