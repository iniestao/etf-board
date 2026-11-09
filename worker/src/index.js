import { HTML } from './page.js';
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
/* 「多久算新鲜」只该用来判断**兜底快照**还能不能直接端出去，不能拿来当主数据源。
   曾经设成 12 分钟（想跟 10 分钟的写盘间隔对齐），结果 09:49 写过快照之后，
   直到 10:01 每次缓存 miss 都把这份 12 分钟前的数据当新鲜货返回——盘中看到的是
   十几分钟前的价格，这是致命的。
   现在 90 秒：只要快照超过一个边缘缓存周期（60 秒），就一定会去抢一次上游。 */
const ALL_FRESH_MS = 90 * 1000;
// 为什么是 3 分钟而不是 60 秒：16:00 那次线上自检，新浪 20 页 6 秒内就回来了；
// 17:50 再测要 43 秒。中间唯一的变量就是新加的 60 秒轮询把请求量放大了一个量级，
// 撞上游限流。既然自选已经走腾讯 5 秒实时，全市场 3 分钟够用，先把压力降下来。
const ALL_BUDGET = 22000;           // 冷启动时同步等上游的硬上限
const ALL_KV = 'all-last-v1';       // KV 里最近一次成功快照
const ALL_KV_GAP = 10 * 60 * 1000;  // KV 最少间隔 10 分钟写一次。
// 原来 2 分钟 → 一天 720 次写，单它一项就吃掉免费额度（1000 写/天）的七成。
// 这份快照只是「边缘缓存 miss 时的兜底」，常规访问走 60 秒的边缘缓存，10 分钟足够。
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
    if (env && env.WATCH && kvWriteAllowed('all-snap')) await env.WATCH.put(ALL_KV, body);
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

/* KV 免费额度是 1000 次写/天，而上面这份快照原来是「每次算完就写一份」。
   页面 60 秒一刷、边缘缓存 TTL 也是 60 秒，等于每次都错过缓存、每次都写——
   单个标签页开着 24 小时就是 1440 次写，一个人就把额度吃光。额度满了之后
   KV 全线 429：自选存不上、PCF 预热停摆、失败兜底也读不到，页面看着就像挂了。
   现在按「值变了 + 距上次写满 10 分钟」才落盘。这份快照的唯一用途是上游抽风时
   退回上一次成功的结果，10 分钟的粒度远远够用（同一天里集中度不会十分钟就变个样）。
   变量放模块级：同一个 isolate 内共享，isolate 被回收后最多多写一次，无妨。 */
const MKT_SNAP_GAP = 30 * 60 * 1000;   // 30 分钟一次：一天 48 次，纯粹是兜底，不必更勤
let mktSnapAt = 0;
let mktSnapSig = '';

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
  // v2：响应多了 pre（昨收），旧缓存里没有，换个 key 免得前端拿到老格式
  const key = new Request('https://etf.internal/ovmin/v2/' + sid, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 降级直连 */ }
  }
  /* 上游偶发直接 RST（沙箱实测一分钟内可能连着失败两次，隔几秒又正常）。
     一次就放弃的话，点开弹窗看到的是「读取失败」，比慢 400ms 差得多。
     失败也返回 JSON：抛出去会被外层兜成 500 纯文本，前端 JSON.parse 报
     「Unexpected token 'I'」，真正的原因（上游 HTTP 502 / 超时）全丢了。 */
  let j;
  try {
    j = await emRetry(() => fetch('https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + sid
      + '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53&iscr=0&ndays=1', {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(8000),
    }).then((r) => {
      if (!r.ok) throw new Error('分时上游 HTTP ' + r.status);
      return r.json();
    }));
  } catch (e) {
    return json({ ok: false, error: '分时上游取不到：' + String((e && e.message) || e) });
  }
  const trends = j && j.data && j.data.trends;
  if (!trends || !trends.length) return json({ ok: false, error: '没有分时数据' });
  const pts = trends.map((s) => {
    const a = s.split(',');
    return [a[0].slice(5, 16), +a[1]];      // '11-06 22:30', 24602.48
  });
  /* 昨收一起带回去：前端左轴要画涨跌幅刻度，基准必须是昨收，
     不能拿本时段第一个点凑——那画出来的「+0.00%」不是涨跌，
     和卡片上的 +2.10% 对不上，看图的人反而更糊涂。
     期货只有 preSettlement（昨结），指数/个股才有 preClose，依次退。 */
  const d = j.data || {};
  const pre = +d.preClose > 0 ? +d.preClose : (+d.preSettlement > 0 ? +d.preSettlement : 0);
  const res = json({ ok: true, sid, pre, pts, ts: Date.now() }, 120);
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
    // 但写要有节制，见 MKT_SNAP_GAP 那段：十分钟一次、且数值真变了才写。
    const sig = [out.c, out.b, out.u, out.w, out.t, out.p5].join('|');
    const nowMs = Date.now();
    if (env && env.WATCH && sig !== mktSnapSig && nowMs - mktSnapAt >= MKT_SNAP_GAP && kvWriteAllowed('mkt-snap')) {
      mktSnapAt = nowMs;
      mktSnapSig = sig;
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

/* ---------------- KV 写保险丝 ----------------
   免费额度 1000 写/天，而且是**账户级**的：超了不是某次 put 返回 429，而是接下来
   24 小时所有 KV 操作一起挂——自选存不上、预热停摆、/api/all 读不到兜底快照，
   页面退回现场拉上游，慢到看起来像「清单空了」。2026-11-09 凌晨就是这么被 block 的。

   病根是 cron 每分钟一轮预热、每轮写 1 次进度 + 3~4 个分片，一天一千多次。
   频率已经按 5 分钟一轮重算过（约 540 次/天），这里再压一道闸：常量哪天被改错，
   宁可少写几次缓存，也别让整个账户被 block。只挡缓存类写入，自选那种用户数据不挡。 */
const KV_WRITE_CAP = 700;
let kvw = { day: '', n: 0 };
function kvWriteAllowed(tag) {
  const d = cstDay();
  if (kvw.day !== d) kvw = { day: d, n: 0 };
  if (kvw.n >= KV_WRITE_CAP) {
    if (kvw.n === KV_WRITE_CAP) console.log('[kvcap] 今日写次数到顶，跳过 ' + tag);
    return false;
  }
  kvw.n++;
  return true;
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
const WARM_PER_RUN = 24;          // 每轮至少这么多只（按整片取，允许超出）
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
  // 今日写额度见顶就整轮别跑：跑了也写不进去，只会重复抓同一批、白烧上游请求
  if (kvw.day === day && kvw.n >= KV_WRITE_CAP) return { ok: true, budget: true, day };

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
    /* 收工之后再每个 cron 都写一次进度，纯粹是白烧额度：一天 96 次写，只为记一句
       「还是做完了」。只在第一次完成时落一个标记，之后读到的 st 自己就带 done。 */
    if (!st.done) {
      st.done = 1;
      try { await env.WATCH.put(PCFW_KV + day, JSON.stringify(st), { expirationTtl: PCFS_TTL }); } catch (e) { /* 忽略 */ }
    }
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
    if (!kvWriteAllowed('pcf-shard')) break;   // 额度见顶就停手，剩下的走现场拉
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

// ---------------------------------------------------------------- 期指探针
/**
 * 中金所只吃 http 明文（https 实测无响应），而 Worker 跑在 Cloudflare 出口上。
 * 沙箱里 curl 得通，不代表线上 Worker 也得通——这两件事之间隔着一层出口策略。
 * 所以先只上这一个端点：逐个打一遍，把状态码 / 耗时 / 字节数 / 首行原样吐出来。
 * 它通了，后面的解析和计算才值得写；它不通，整个实时链路降级成「收盘日档」。
 *
 * 只给人工排障用，不做缓存（每次都是真打上游），也不进前端。
 */
const CFFEX_QUOTE = ['IF', 'IC', 'IH', 'IM', 'IO', 'MO', 'HO'];

function shDate(offsetDay = 0) {
  // 北京时间；cffex 的日行情目录用 YYYYMM/DD 两级
  const t = new Date(Date.now() + 8 * 3600e3 + offsetDay * 86400e3);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

async function probeOne(name, u) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'http://www.cffex.com.cn/' },
      signal: AbortSignal.timeout(6000),
    });
    // 只解前 400 字节：日行情 index.xml 有 500 多 KB，为了看一行字把整份
    // 文本 decode 一遍不值，先量字节数再切一小片解码
    const ab = await r.arrayBuffer();
    const head = new TextDecoder('utf-8').decode(ab.slice(0, 400)).replace(/\s+/g, ' ').trim();
    return { n: name, u, s: r.status, ms: Date.now() - t0, bytes: ab.byteLength, head };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { n: name, u, s: 0, ms: Date.now() - t0, bytes: 0, err: msg.slice(0, 120) };
  }
}

async function serveFutProbe(url) {
  // ?d=20261109 指定日行情日期；缺省用今天（非交易日会 404，属正常，看 quote_*.txt 就行）
  const d = (url.searchParams.get('d') || shDate()).replace(/\D/g, '');
  if (!/^\d{8}$/.test(d)) return json({ ok: false, error: 'd 需为 YYYYMMDD' });
  const ymd = d.slice(0, 6) + '/' + d.slice(6, 8);

  const jobs = CFFEX_QUOTE.map((p) => [p, 'http://www.cffex.com.cn/quote_' + p + '.txt']);
  jobs.push(['daily', 'http://www.cffex.com.cn/sj/hqsj/rtj/' + ymd + '/index.xml']);
  jobs.push(['ccpm_IF', 'http://www.cffex.com.cn/sj/ccpm/' + ymd + '/IF.xml']);
  jobs.push(['https_IF', 'https://www.cffex.com.cn/quote_IF.txt']);           // 顺带确认 https 是否真的不通
  jobs.push(['spot', 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
    + '&secids=1.000300,1.000905,1.000016,1.000852&fields=f2,f3,f12,f14']);  // 对照组：已知能通的源

  const list = await Promise.all(jobs.map(([n, u]) => probeOne(n, u)));
  const ok = list.filter((x) => x.s === 200 && x.bytes > 0).length;
  return json({
    ok: true, d, at: Date.now(), pass: ok, total: list.length,
    // 首行是不是 CSV 表头，肉眼一看就知道有没有被运营商的拦截页替换掉
    hint: ok >= 9 ? 'cffex 可达，实时链路成立' : 'cffex 有源不可达，实时链路需降级',
    list,
  });
}

// ---------------------------------------------------------------- 股指期货 / 期权
/**
 * 口径（写死在这里，前端只负责显示，不重算）：
 *   basis = F − S            点数，负数=贴水
 *   bp    = basis / S × 100   %
 *   ann   = bp × 365 / dte    自然日；dte < 3 不给，不然只剩一天时年化能到几千 %
 * F 用实时 lastprice，S 用东财现货指数。两个源不同、报价时点也差几十毫秒，
 * 所以基差天然带 ±0.02% 的噪音——判断贴水深浅时别把这个当信号。
 *
 * 期权合成期货 syn = K + C − P（忽略利率，一个月内误差 <0.1%）：
 * 取 ATM 附近 |K/S−1| ≤ 3% 的最多 5 档、至少 3 档，取中位数。
 * 用中位数不是均值：某一条腿挂单稀薄时报个离谱价，均值会被它拽跑。
 */
const FUT_PRODS = ['IF', 'IC', 'IH', 'IM'];
const OPT_PRODS = ['IO', 'MO', 'HO'];
const FUT_SPOT_ID = '1.000300,1.000905,1.000016,1.000852';
const FUT_SPOT_NAME = { '000300': '沪深300', '000905': '中证500', '000016': '上证50', '000852': '中证1000' };
const FUT_MAP = { IF: '000300', IH: '000016', IC: '000905', IM: '000852' };
const OPT_MAP = { IO: 'IF', HO: 'IH', MO: 'IM' };     // 期权品种 → 同标的期货品种
const FUT_TTL = 55;
let FUT_L1 = { ts: 0, body: null };

/** 中金所股指期货/期权都在「到期月第三个周五」交割。遇到法定假日交易所会顺延，
 *  这里不查节假日表——它只用来算剩余天数和年化，差一天对 bp 的影响在 1/11 以内，
 *  真要紧的是别把「剩 1 天」当成「剩 30 天」，那一步差不了。 */
function thirdFriday(ym) {
  const y = 2000 + parseInt(ym.slice(0, 2), 10);
  const m = parseInt(ym.slice(2, 4), 10);
  const wd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();   // 0=周日
  const day = 1 + ((5 - wd + 7) % 7) + 14;
  return Date.UTC(y, m - 1, day);
}

function shTodayStr() {
  const s = shDate();
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

/** 实时 quote 文件里那份数据到底是哪个交易日的。
 *
 *  CFFEX 的 quote_*.txt 不带时间戳，收盘后就一直停着：09:15 开盘前、整个周末，
 *  文件里还是上一交易日的收盘值。这时候如果把 td 当成今天，卡片会写
 *  「收盘 11-10」而数字其实是 11-09 的——每天早八点和周末都会错一天。
 *  既然能确定「此刻不可能有新数据」，就直接用日档的交易日当 td；
 *  没有日档就退回今天（宁可不显示日期，也不要假装知道）。
 */
function futDataDate(last) {
  const today = shTodayStr();
  if (!last || !last.td || last.td >= today) return today;
  const d = new Date(Date.now() + 8 * 3600e3);
  const wd = d.getUTCDay();
  const preOpen = d.getUTCHours() * 60 + d.getUTCMinutes() < 9 * 60 + 15;
  if (preOpen || wd === 0 || wd === 6) return last.td;
  return today;
}

function dteOf(ym) {
  const t = shDate();
  const today = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
  return Math.round((thirdFriday(ym) - today) / 86400e3);
}

function expOf(ym) {
  const d = new Date(thirdFriday(ym));
  return d.toISOString().slice(0, 10);
}

/** 中金所实时文件：http 明文、没有 key、每 3 秒刷一次。单文件 400B~16KB。
 *  不重试：它偶尔会限流，重试反而把一个 700ms 的失败拖成 1.5 秒。 */
async function fetchCffex(path) {
  const r = await fetch('http://www.cffex.com.cn/' + path, {
    headers: { 'User-Agent': UA, Referer: 'http://www.cffex.com.cn/' },
    signal: AbortSignal.timeout(4500),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function fetchSpotIdx() {
  const u = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids='
    + FUT_SPOT_ID + '&fields=f2,f3,f12,f14';
  const j = await emRetry(() => fetch(u, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(3500),
  }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }));
  const out = {};
  const diff = (j && j.data && j.data.diff) || [];
  for (const x of diff) {
    const c = String(x.f12 || '');
    const p = +x.f2;
    if (c && p > 0) out[c] = { p, chg: +(+x.f3 || 0).toFixed(2) };
  }
  return out;
}

function parseFutCsv(txt, prod) {
  const out = [];
  const lines = String(txt).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.slice(0, 2) !== prod) continue;
    const a = s.split(',');
    if (a[0].slice(0, 2) !== prod) continue;
    const px = +a[4];
    if (!(px > 0)) continue;
    const ud = +a[5] || 0;
    const pc = px - ud;
    out.push({
      c: a[0], ym: a[0].slice(2, 6), px,
      chg: pc > 0 ? +(ud / pc * 100).toFixed(2) : 0,
      vol: +a[10] || 0, oi: +a[11] || 0,
    });
  }
  return out;
}

function parseOptCsv(txt, prod) {
  const out = [];
  const lines = String(txt).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.slice(0, 2) !== prod) continue;
    const a = s.split(',');
    const m = a[0].match(/^[A-Z]+(\d{4})-([CP])-(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    let px = +a[3];
    // 深度虚值那几条尾巴常年没成交，lastprice 是 0；用买卖中间价补，
    // 不然整档被丢掉，ATM 窗口就少一档
    if (!(px > 0)) {
      const b = +a[5], sp = +a[7];
      if (b > 0 && sp > 0) px = (b + sp) / 2;
    }
    if (!(px > 0)) continue;
    out.push({ ym: m[1], cp: m[2], k: +m[3], px, vol: +a[2] || 0, oi: +a[1] || 0 });
  }
  return out;
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** ATM 附近的配对标的一撮。行权价间距各品种不同：IF 系 50 点一档、
 *  科创 50ETF 是 0.05 一档（占价格 3.8%），固定 ±3% 会只剩一档。
 *  所以窗口逐级放宽，够 3 档就停；实在凑不到就取最近的 2~3 档。 */
function atmWindow(pairs, S) {
  const byDist = pairs.slice().sort((a, b) => Math.abs(a.k - S) - Math.abs(b.k - S));
  for (const w of [0.03, 0.05, 0.08, 0.12]) {
    const near = byDist.filter((x) => Math.abs(x.k / S - 1) <= w).slice(0, 5);
    if (near.length >= 3) return near;
  }
  return byDist.slice(0, Math.min(3, byDist.length));
}

/** 一个期权品种 → 每个月一条合成期货基差 */
function calcOptMonths(rows, S, futPx, prod) {
  const byYm = new Map();
  for (const r of rows) {
    let g = byYm.get(r.ym);
    if (!g) { g = { c: [], p: [] }; byYm.set(r.ym, g); }
    (r.cp === 'C' ? g.c : g.p).push(r);
  }
  const res = [];
  for (const [ym, g] of byYm) {
    const pm = new Map();
    for (const x of g.p) pm.set(x.k, x);
    const pairs = [];
    for (const x of g.c) {
      const p = pm.get(x.k);
      if (p) pairs.push({ k: x.k, c: x.px, p: p.px });
    }
    if (!pairs.length) continue;
    const near = atmWindow(pairs, S);
    if (!near.length) continue;

    const syn = median(near.map((x) => x.k + x.c - x.p));
    const volC = g.c.reduce((s, x) => s + x.vol, 0);
    const volP = g.p.reduce((s, x) => s + x.vol, 0);
    const dte = dteOf(ym);
    const basis = syn - S;
    const bp = basis / S * 100;
    const f = futPx[ym];
    res.push({
      m: ym, dte, exp: expOf(ym),
      syn: +syn.toFixed(2), basis: +basis.toFixed(2), bp: +bp.toFixed(3),
      ann: dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
      atm: near[0].k, n: near.length,
      pcr: volC > 0 ? +(volP / volC).toFixed(2) : null,
      futC: f != null ? prod + ym : null,
      fb: f != null ? +(syn - f).toFixed(2) : null,
    });
  }
  res.sort((a, b) => (a.m < b.m ? -1 : 1));
  return res;
}

/** 30 天恒定到期基差率：在两个相邻合约之间线性插值。
 *  历史分位必须用它——主力合约每月换月，换月那天 bp 会跳 0.3%，直接拿主力
 *  序列算分位，每个月都会凭空造出一个极值。 */
function cmValue(list) {
  const a = list.filter((x) => x.ann != null).sort((x, y) => x.dte - y.dte);
  if (a.length < 2) return null;
  if (a[0].dte > 30) return +a[0].bp.toFixed(3);
  for (let i = 0; i < a.length - 1; i++) {
    const x = a[i], y = a[i + 1];
    if (x.dte <= 30 && y.dte >= 30) {
      const w = (30 - x.dte) / (y.dte - x.dte);
      return +(x.bp + (y.bp - x.bp) * w).toFixed(3);
    }
  }
  return +a[a.length - 1].bp.toFixed(3);
}

async function loadFutLast(env) {
  try {
    const a = await readAsset(env, 'fut_last.json');
    if (!a) return null;
    const j = JSON.parse(await a.text());
    return j && j.ok !== false ? j : null;
  } catch (e) { return null; }
}

/** 盘中实时：期货 + 现货 + 股指期权，55 秒边缘缓存。
 *  期货全挂时才退到 fut_last.json（收盘日档），并把 stale 标出来——宁可显示
 *  「昨天收盘 + 日期」，也不要让整块卡片消失。 */
async function serveFut(env, ctx) {
  const now = Date.now();
  if (FUT_L1.body && now - FUT_L1.ts < FUT_TTL * 1000) return json(FUT_L1.body, 45);

  const cache = await getCache();
  const key = new Request('https://etf.internal/fut/v2/live', { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const b = await hit.json();
        FUT_L1 = { ts: now, body: b };
        return json(b, 45);
      }
    } catch (e) { /* 缓存读失败就当没有 */ }
  }

  const partial = [];
  // 三路并发：现货是东财、期货和期权都是中金所。串起来等会多一个 RTT，
  // 而这三者互不依赖。
  const spotP = fetchSpotIdx().catch(() => null);
  const futP = Promise.all(FUT_PRODS.map((p) => fetchCffex('quote_' + p + '.txt')
    .then((t) => ({ p, rows: parseFutCsv(t, p) }))
    .catch(() => ({ p, rows: null }))));
  const optP = Promise.all(OPT_PRODS.map((p) => fetchCffex('quote_' + p + '.txt')
    .then((t) => ({ p, rows: parseOptCsv(t, p) }))
    .catch(() => ({ p, rows: null }))));

  const [spot, futRes, optRes] = await Promise.all([spotP, futP, optP]);
  const spotOk = spot && Object.keys(spot).length >= 3;

  const futList = futRes.filter((x) => x.rows && x.rows.length);
  if (!futList.length) {
    // 期货一条都没拿到 → 收盘日档兜底
    const last = await loadFutLast(env);
    if (last) {
      const out = { ...last, ok: true, src: 'daily', stale: 1, ts: now, asof: last.ts || now,
        age: Math.round((now - (last.ts || now)) / 1000), partial: ['fut'] };
      FUT_L1 = { ts: now, body: out };
      return json(out, 15);
    }
    return json({ ok: false, error: 'cffex_unreachable', ts: now, partial: ['fut'] }, 15);
  }

  // 昨收持仓：只有「昨天那份快照」才有意义，今天的不算
  const last = await loadFutLast(env);
  const td = futDataDate(last);
  const oiPrev = {};
  if (last && last.td && last.td !== td && Array.isArray(last.fut)) {
    for (const f of last.fut) oiPrev[f.c] = f.oi;
  }
  // 昨收持仓只对「昨天那份」有意义；但会员多空是收盘结算值，当天那份就是最新的，
  // 不该因为「td 相同」而丢掉——否则收盘后整张多空表永远是空的
  const posPrev = last && last.pos ? last.pos : null;

  const futOut = [];
  const futPxByProd = {};
  for (const { p, rows } of futRes) {
    if (!rows) { partial.push(p); continue; }
    const S = FUT_MAP[p];
    const sp = spotOk ? spot[S] : null;
    futPxByProd[p] = {};
    const tmp = [];
    for (const r of rows) {
      futPxByProd[p][r.ym] = r.px;
      const basis = sp ? r.px - sp.p : null;
      const bp = sp ? basis / sp.p * 100 : null;
      const dte = dteOf(r.ym);
      const oiD = oiPrev[r.c] != null ? r.oi - oiPrev[r.c] : null;
      tmp.push({
        c: r.c, p, u: S, px: r.px, chg: r.chg, vol: r.vol, oi: r.oi, oiD,
        dte, exp: expOf(r.ym),
        basis: sp ? +basis.toFixed(2) : null,
        bp: sp ? +bp.toFixed(3) : null,
        ann: sp && dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
        q: quadOf(oiD, r.chg, r.oi),
      });
    }
    for (const x of tmp) futOut.push(x);
  }

  const optOut = [];
  for (const { p, rows } of optRes) {
    if (!rows) { partial.push(p); continue; }
    const fp = OPT_MAP[p];
    const S = FUT_MAP[fp];
    const sp = spotOk ? spot[S] : null;
    if (!sp) { partial.push(p); continue; }
    for (const o of calcOptMonths(rows, sp.p, futPxByProd[fp] || {}, fp)) {
      optOut.push({ p, u: S, ...o });
    }
  }

  const cm = {};
  for (const p of FUT_PRODS) {
    const l = futOut.filter((x) => x.p === p && x.bp != null);
    const v = cmValue(l);
    if (v != null) cm[p] = { v, dte: 30 };
  }
  if (!spotOk) partial.push('spot');
  if (spotOk) for (const k of Object.keys(spot)) spot[k].n = FUT_SPOT_NAME[k] || k;

  const out = {
    ok: true, ts: now, td, src: 'cffex', stale: 0,
    asof: now, age: 0, partial,
    spot: spotOk ? spot : {},
    fut: futOut,
    opt: optOut,
    cm,
    pos: posPrev || null,
  };
  FUT_L1 = { ts: now, body: out };
  const res = json(out, 45);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  return res;
}

/** 盘中四象限：持仓量增减 × 价格方向。
 *  这是**推断**，不是交易所口径——中金所的持仓量是双边合计，看不出谁在开谁在平。
 *  真正的多空只在收盘后的前 20 会员排名里（pos），前端两处标签分得很清楚。 */
function quadOf(oiD, chg, oi) {
  if (oiD == null) return null;
  const eps = Math.max(50, (oi || 0) * 0.002);
  if (oiD > eps) return chg > 0 ? 'up-open' : 'dn-open';     // 增仓上涨 / 增仓下跌
  if (oiD < -eps) return chg > 0 ? 'up-close' : 'dn-close';  // 减仓上涨 / 减仓下跌
  return 'flat';
}

// ---------------------------------------------------------------- ETF 期权
/**
 * 沪深 ETF 期权走东财的期权链接口（spt=9 认购 / spt=10 认沽），比中金所那边
 * 多一层好处：直接带 f161 行权价和 f162 剩余自然日，不用自己推到期日。
 *
 * 合成期货同样是 K + C − P。标的现价必须另取——期权链里没有 underlying 报价，
 * 少了它就只剩一堆绝对价，算不出基差。
 *
 * 分两批：第一批 4 个主标的（成交占比九成以上），第二批 4 个冷门的。
 * 一批 9 个上游子请求，两批分开是为了首屏那一批能先回来。
 */
const ETF_OPT = {
  main: [
    ['1.510050', '510050', '50ETF'],
    ['1.510300', '510300', '300ETF'],
    ['0.159919', '159919', '300ETF深'],
    ['1.588000', '588000', '科创50ETF'],
  ],
  rest: [
    ['0.159915', '159915', '创业板ETF'],
    ['1.510500', '510500', '500ETF'],
    ['0.159922', '159922', '500ETF深'],
    ['1.588080', '588080', '科创板50ETF'],
  ],
};

async function emJson(u, ms) {
  return emRetry(() => fetch(u, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(ms || 3500),
  }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }));
}

/** 一条期权链（单边）。spt 9=购 10=沽，字段：f2 最新价 f5 成交量
 *  f12 代码 f14 名称 f108 持仓量 f152 购沽标记 f161 行权价 f162 剩余自然日 */
async function fetchOptChain(secid, spt) {
  const u = 'https://push2.eastmoney.com/api/qt/slist/get?spt=' + spt
    + '&fltt=2&invt=2&fields=f2,f5,f12,f14,f108,f152,f161,f162'
    + '&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3';
  const j = await emJson(u);
  const diff = (j && j.data && j.data.diff) || [];
  const out = [];
  for (const x of diff) {
    const px = +x.f2;
    const k = +x.f161;
    const dte = +x.f162;
    if (!(k > 0) || !(px > 0) || !(dte >= 0)) continue;
    out.push({ k, px, dte, vol: +x.f5 || 0, oi: +x.f108 || 0 });
  }
  return out;
}

async function fetchEtfSpot(secids) {
  const u = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids='
    + secids.join(',') + '&fields=f2,f3,f12,f14';
  const j = await emJson(u);
  const out = {};
  for (const x of ((j && j.data && j.data.diff) || [])) {
    const p = +x.f2;
    if (p > 0) out[String(x.f12)] = { p, chg: +(+x.f3 || 0).toFixed(2) };
  }
  return out;
}

function calcEtfMonths(rows, S) {
  const byDte = new Map();
  for (const r of rows) {
    let g = byDte.get(r.dte);
    if (!g) { g = { c: [], p: [] }; byDte.set(r.dte, g); }
    (r.side === 'C' ? g.c : g.p).push(r);
  }
  const res = [];
  for (const [dte, g] of byDte) {
    const pm = new Map();
    for (const x of g.p) pm.set(x.k, x);
    const pairs = [];
    for (const x of g.c) {
      const p = pm.get(x.k);
      if (p) pairs.push({ k: x.k, c: x.px, p: p.px });
    }
    if (!pairs.length) continue;
    const near = atmWindow(pairs, S);
    if (!near.length) continue;
    const syn = median(near.map((x) => x.k + x.c - x.p));
    const volC = g.c.reduce((s, x) => s + x.vol, 0);
    const volP = g.p.reduce((s, x) => s + x.vol, 0);
    const basis = syn - S;
    const bp = basis / S * 100;
    const exp = new Date(Date.now() + 8 * 3600e3 + dte * 86400e3).toISOString().slice(0, 10);
    // 远月的成交量常年个位数，量比会算出 0.07 这种没意义的数；没量就退回持仓量比
    const oiC = g.c.reduce((s, x) => s + x.oi, 0);
    const oiP = g.p.reduce((s, x) => s + x.oi, 0);
    res.push({
      dte, exp,
      syn: +syn.toFixed(4), basis: +basis.toFixed(4), bp: +bp.toFixed(3),
      ann: dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
      atm: near[0].k, n: near.length,
      pcr: volC > 0 ? +(volP / volC).toFixed(2) : (oiC > 0 ? +(oiP / oiC).toFixed(2) : null),
    });
  }
  res.sort((a, b) => a.dte - b.dte);
  return res;
}

async function serveFutOpt(url, env, ctx) {
  const g = url.searchParams.get('g') === 'rest' ? 'rest' : 'main';
  const ttl = g === 'rest' ? 300 : 120;
  const cache = await getCache();
  const key = new Request('https://etf.internal/futopt/v1/' + g, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败回源 */ }
  }

  const list = ETF_OPT[g];
  const spotP = fetchEtfSpot(list.map((x) => x[0])).catch(() => null);
  // 每个标的 2 个请求（购/沽），4 个标的 8 个，加上现货 1 个 = 9 个
  const chainP = Promise.all(list.map(([sid, code]) => Promise.all([
    fetchOptChain(sid, 9).catch(() => null),
    fetchOptChain(sid, 10).catch(() => null),
  ]).then(([c, p]) => ({ code, c, p }))));

  const [spot, chains] = await Promise.all([spotP, chainP]);
  const partial = [];
  if (!spot) partial.push('spot');

  const items = [];
  for (const { code, c, p } of chains) {
    const s = spot && spot[code];
    if (!c || !p || !s) { partial.push(code); continue; }
    const rows = [];
    for (const x of c) rows.push({ ...x, side: 'C' });
    for (const x of p) rows.push({ ...x, side: 'P' });
    const months = calcEtfMonths(rows, s.p);
    if (!months.length) { partial.push(code); continue; }
    const name = (list.find((x) => x[1] === code) || [])[2] || code;
    items.push({ c: code, n: name, S: s.p, chg: s.chg, months });
  }

  const out = { ok: true, g, ts: Date.now(), items, partial };
  const res = json(out, ttl);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  return res;
}

/** 250 天基线：原样透传 Actions 生成的 fut_daily.json。
 *  Worker 这边一个字段都不重算——历史序列一旦两边各算一遍，迟早会不一致。 */
async function serveFutHist(env) {
  const cache = await getCache();
  const key = new Request('https://etf.internal/futhist/v1', { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败回源 */ }
  }
  let out;
  try {
    const a = await readAsset(env, 'fut_daily.json');
    if (!a) out = { ok: false, error: 'hist_not_ready', ts: Date.now() };
    else {
      const j = JSON.parse(await a.text());
      out = { ...j, ok: true, ts: Date.now() };
    }
  } catch (e) {
    out = { ok: false, error: 'hist_read_failed', msg: String((e && e.message) || e), ts: Date.now() };
  }
  const res = json(out, out.ok ? 1800 : 60);
  if (cache && out.ok) {
    try { await cache.put(key, res.clone()); } catch (e) { /* 写缓存失败不影响返回 */ }
  }
  return res;
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

    if (p === '/api/futprobe') {
      // 第 1 步：确认 Cloudflare 出口能不能连中金所（只有 http 明文源）
      return serveFutProbe(url);
    }

    if (p === '/api/fut') {
      // 期指基差 + 期权合成期货基差 + 前 20 会员多空（后者来自收盘日档）
      return serveFut(env, ctx);
    }

    if (p === '/api/futopt') {
      // 沪深 ETF 期权合成期货基差：g=main 4 个主标的 / g=rest 4 个冷门的
      return serveFutOpt(url, env, ctx);
    }

    if (p === '/api/futhist') {
      // 250 天基差基线（Actions 每天收盘后生成，data 分支静态文件）
      return serveFutHist(env);
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
