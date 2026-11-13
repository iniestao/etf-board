import { HTML } from './page.js';
import { IDX_GROUPS } from './idx_data.js';
import { MKT_HIST } from './mkt_hist.js';
import { MKT_IND_NAMES, MKT_IND_OF, MKT_IND_MEM, MKT_STK_NAME } from './mkt_ind.js';

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
    /* 单页失败以前是 .catch(()=>[]) 静默吞掉：那份快照少 100 只，但条数仍在
       GOOD_ROWS 之上，于是被当成「完整」端出去——用户看到的就是「同指数写着
       10 只，点开只有 5 只」。先给每页两次重试，还失败就整份丢弃：
       半份快照比旧快照更坑，旧快照至少是自洽的。 */
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        emPageRetry(i + 2).then((x) => x.diff).catch(() => null))
    );
    const holes = rest.filter((r) => r === null).length;
    if (holes) throw new Error('EM ' + holes + '/' + pages + ' 页失败，整份丢弃');
    for (const rs of rest) all = all.concat(rs);
  }
  // 透传格式：{src, ts, n, raw}，raw 为东财原始 diff 数组
  return JSON.stringify({ src: 'eastmoney', n: all.length, raw: all });
}

/** 单页带退避重试。东财限流是「偶发 502/空响应」，原地重试一次多半就回来了 */
async function emPageRetry(pn) {
  let last;
  for (let k = 0; k < 3; k++) {
    try {
      return await emPage(pn);
    } catch (e) {
      last = e;
      if (k < 2) await new Promise((r) => setTimeout(r, 150 + k * 350));
    }
  }
  throw last;
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
  /* 末尾的空页是正常的（页数给多了），**中间**的空页说明那 100 只没拿到。
     以前这种空洞被静默接受，快照条数只掉 100、仍过 GOOD_ROWS 闸门，
     页面就少了一百只而且看不出来。有洞就整份丢弃，让上层用旧快照。 */
  let last = -1;
  for (let i = 0; i < parts.length; i++) if (parts[i]) last = i;
  const holes = parts.slice(0, Math.max(last, 0)).filter((t) => !t).length;
  if (holes) throw new Error('SINA ' + holes + ' 页空洞，整份丢弃');
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
const SEC_DAILY_KEEP = 12;

/* /api/mkt 的 KV 快照从这一版起又回来了，但换了个用途：不再是「板块接口抽风」的
   兜底（那时上游是东财板块列表），而是「盘中逐只聚合断了」的兜底——给 5 分钟内
   算出来的那个数，比退回上一交易日收盘强。键叫 mkt-live-v1，见 serveMkt。 */

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

/** 亚太指数：和期货同一个 ulist 批量接口，一组 secid 一次拿完
 *  ms 由调用方按剩余预算给：这条链路最坏要走主源+备源+兜底，各自 8 秒加起来
 *  能把隔夜卡拖到十几秒，卡着不动比少几只更难受。 */
async function fetchAsia(ms) {
  const qs = ON_ASIA_SECIDS.map((x) => x[0]).join(',');
  const r = await fetch('https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
    + '&secids=' + qs + '&fields=f2,f3,f12,f14', {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(ms || 9000),
  });
  if (!r.ok) throw new Error('ASIA HTTP ' + r.status);
  const j = await r.json();
  const rows = j && j.data && j.data.diff;
  if (!rows) throw new Error('ASIA empty');
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : Object.values(rows))) {
    const hit = ON_ASIA_SECIDS.find((x) => x[0].split('.')[1] === row.f12);
    // 名称固定用配置里的写法：东财对同一个指数会给出「恒生科技指数」「恒生科技」
    // 两种叫法，换源时名字一跳，看着像换了标的
    if (hit && isFinite(+row.f3)) out.push({ sid: hit[0], n: hit[1], p: +row.f2, chg: +row.f3 });
  }
  // 按配置顺序输出，不给上游排序自由
  out.sort((a, b) => ON_ASIA_SECIDS.findIndex((x) => x[0] === a.sid) - ON_ASIA_SECIDS.findIndex((x) => x[0] === b.sid));
  return out;
}

/* 亚太备源。
   主源是东财 ulist，一次请求拿 6 个 secid，好处是一致性好，坏处是**全有或全无**：
   同出口短时间连打会被直接断连（实测同一 IP 连打 20 次只成功 1 次），一次失败
   整批为空，前端那张卡就整块消失——这就是「亚太偶尔丢掉」的表现。
   备源刻意换厂商，避免跟主源同生共死：
     上证/科创50/创业板/恒生科技 → 腾讯 qt.gtimg（和美股那条链路同一个源）
     日经225                      → 新浪 int_nikkei（int_ 系列里唯一稳定给值的）
     韩国KOSPI                    → 东财单只 stock/get（ulist 挂了它通常还活着）
   涨跌幅一律用「现价 ÷ 昨收」自算，不赌上游的字段下标——腾讯 A 股 88 项、
   港股 78 项，靠下标取涨幅会搞错。 */
async function fetchAsiaBackup(sids, ms) {
  const want = new Set(sids);
  const to = Math.max(500, ms || 8000);
  const out = [];

  /* KOSPI/日经的第三档：CNBC 报价。KOSPI 前面只有东财单只一条路，
     东财一抽就整只消失（亚太行少一个格子），而 CNBC 的 .KS11 一直活着。
     这个接口实测 2 秒才回（比前面几档慢一个数量级），所以**在函数开头就发出**，
     末尾再收——挂在后面串行等的话，前面四只已经好了还要再多等两秒。 */
  const cnbcP = fetchCnbcAsia(want, 4500).catch(() => []);

  const TX = [
    ['sh000001', '1.000001'], ['sh000688', '1.000688'],
    ['sz399006', '0.399006'], ['hkHSTECH', '124.HSTECH'],
  ];
  const txq = TX.filter((x) => want.has(x[1])).map((x) => x[0]);
  if (txq.length) {
    try {
      const r = await fetch('https://qt.gtimg.cn/q=' + txq.join(','), {
        headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(to),
      });
      if (r.ok) {
        const t = new TextDecoder('gbk').decode(await r.arrayBuffer());
        const re = /v_(\S+?)="([^"]*)"/g;
        let m;
        while ((m = re.exec(t))) {
          const f = m[2].split('~');
          const hit = TX.find((x) => x[0].toLowerCase() === m[1].toLowerCase());
          if (!hit || f.length < 6) continue;
          const p = +f[3], prev = +f[4];
          if (!(p > 0) || !(prev > 0)) continue;
          // 名字取配置里的写法，不用上游的：腾讯叫「恒生科技指数」、东财叫「恒生科技」，
          // 源一换名字就跳，看着像换了标的
          const nm = (ON_ASIA_SECIDS.find((x) => x[0] === hit[1]) || [])[1] || f[1] || hit[1];
          out.push({ sid: hit[1], n: nm, p, chg: (p / prev - 1) * 100 });
        }
      }
    } catch (e) { /* 腾讯也挂了就走下面两个 */ }
  }

  /* 开头那笔 CNBC 请求到这里收。日经/KOSPI 优先用 CNBC：分时图也是它给的，
     报价和图的基准同源，卡片写 -0.70%、图上也是 -0.70%，不会出现「图上写着
     -0.70%、卡片写着 -0.90%」这种让人怀疑数据坏了的画面。
     （新浪 int_nikkei 与 CNBC 在这两只上差 0.2 个百分点，价格差 35%——
     哪个对先不论，同一张卡上不能同时出现两套数。） */
  for (const x of await cnbcP) {
    if (!out.some((o) => o.sid === x.sid)) out.push(x);
  }

  if (want.has('100.N225') && !out.some((x) => x.sid === '100.N225')) {
    try {
      const r = await fetch('https://hq.sinajs.cn/list=int_nikkei', {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(to),
      });
      if (r.ok) {
        const t = new TextDecoder('gbk').decode(await r.arrayBuffer());
        const m = /"([^"]*)"/.exec(t);
        const f = m ? m[1].split(',') : [];
        const p = +f[1], chg = +f[3];
        // 名字用配置里的固定写法：新浪叫「日经指数」、东财叫「日经225」，
        // 不统一的话源一换名字就跳，看着像换了标的
        if (p > 0 && isFinite(chg)) out.push({ sid: '100.N225', n: '日经225', p, chg });
      }
    } catch (e) { /* 日经缺了就先不显示这一只 */ }
  }

  if (want.has('100.KS11')) {
    /* KOSPI 没有腾讯/新浪的可用代码（腾讯 pv_none_match、新浪 int_kospi 空壳），
       只能留在东财。但 ulist 挂的时候单只 stock/get 往往还活着——两个域名都试，
       单只接口比批量接口轻得多，限流阈值不在一个档上。
       紧跟主源失败之后再打同一域名容易被连坐，所以给一轮 350ms 的退避重试。 */
    for (let round = 0; round < 2 && !out.some((x) => x.sid === '100.KS11'); round++) {
      if (round) await new Promise((r) => setTimeout(r, 350));
      for (const host of ['push2delay', 'push2']) {
        if (out.some((x) => x.sid === '100.KS11')) break;
        try {
          const r = await fetch('https://' + host + '.eastmoney.com/api/qt/stock/get?secid=100.KS11'
            + '&fields=f43,f58,f169,f170', {
            headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
            signal: AbortSignal.timeout(Math.max(400, Math.round(to / 2))),
          });
          if (!r.ok) continue;
          const j = await r.json();
          const d = j && j.data;
          // 单只接口不传 fltt 时给的是放大 100 倍的整数
          const p = d ? +d.f43 / 100 : 0;
          const chg = d ? +d.f170 / 100 : NaN;
          if (p > 0 && isFinite(chg)) out.push({ sid: '100.KS11', n: '韩国KOSPI', p, chg });
        } catch (e) { /* 换下一个域名 */ }
      }
    }
  }

  /* 开头那笔 CNBC 请求到这里收：前面几档没补上的才用它。
     逐个 symbol 请求——多 symbol 拼在一个 URL 里返回的是嵌套结构，
     解析要按两种形状分支，不如多打一次省掉这层判断。 */

  return out;
}

/* CNBC 亚太报价：.N225 / .KS11。last/prev 都带千分位逗号（"44,946.64"），
   parseFloat 直接吃会得到 44——这一条差点把日经报价写成两位数。 */
async function fetchCnbcAsia(want, ms) {
  const LIST = [['.KS11', '100.KS11', '韩国KOSPI'], ['.N225', '100.N225', '日经225']]
    .filter((x) => want.has(x[1]));
  const rows = await Promise.all(LIST.map(async ([sym, sid, nm]) => {
    try {
      const r = await fetch('https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
        + '?symbols=' + encodeURIComponent(sym) + '&requestMethod=itv&noform=1&partnerId=2'
        + '&fund=1&exthrs=1&output=json&events=1', {
        headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
        signal: AbortSignal.timeout(ms || 4500),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const q0 = j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote;
      const row = Array.isArray(q0) ? q0[0] : (q0 && q0.FormattedQuote);
      const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, ''));
      const p = num(row && row.last);
      const prev = num(row && row.previous_day_closing);
      const chg = num(row && row.change_pct);
      if (!(p > 0)) return null;
      return { sid, n: nm, p, chg: isFinite(chg) ? chg : (prev > 0 ? (p / prev - 1) * 100 : NaN) };
    } catch (e) { return null; }
  }));
  return rows.filter(Boolean);
}

/* 把主源已有的和备源补上的拼一起，按 ON_ASIA_SECIDS 的顺序输出，主源优先。 */
function mergeAsia(primary, backup) {
  const map = new Map();
  for (const x of backup || []) map.set(x.sid, x);
  for (const x of primary || []) map.set(x.sid, x);
  const out = [];
  for (const [sid] of ON_ASIA_SECIDS) if (map.has(sid)) out.push(map.get(sid));
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

/* 期货第三档：用外盘期货分钟线的最后一点当现价。
   `hq.sinajs.cn/list=hf_*` 挂了的时候，`stock2` 这条（同一家的另一套接口）
   往往还活着——分时的最后一根就是此刻的价，配日线昨收算涨跌幅。
   四个品种各两次请求（分时 + 日线），只在前两档全空时才走到这里。 */
async function fetchFutSinaMinQuote() {
  const out = {};
  await Promise.all(ON_FUT_SECIDS.map(async ([sid, key, nm]) => {
    try {
      const m = await fetchSinaFutMin(sid);
      if (!m || !m.pts.length || !(m.pre > 0)) return;
      const p = m.pts[m.pts.length - 1][1];
      if (!(p > 0)) return;
      out[key] = { n: nm, p, chg: (p / m.pre - 1) * 100 };
    } catch (e) { /* 这一只缺就先不显示 */ }
  }));
  return out;
}

/* 亚太最近一次成功的快照，主备源都挂时拿出来顶着。
   和板块地图那份一个思路：宁给几分钟前的数，也不让整块内容凭空消失。
   KV 键只存 6 个指数的数，几百字节，写也要节流（写额度是共享的）。 */
const ASIA_KV = 'on-asia-v1';
const ASIA_SNAP_GAP = 5 * 60 * 1000;   // 至少 5 分钟写一次
let asiaSnapAt = 0;
let asiaSnapSig = '';

async function asiaSnapFromKV(env) {
  if (!env || !env.WATCH) return null;
  try {
    const raw = await env.WATCH.get(ASIA_KV);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.a) || !j.a.length) return null;
    return j;
  } catch (e) { return null; }
}

async function serveOvernight(env, ctx) {
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
    /* 第三档：新浪的两个接口是分开挂的。`hq.sinajs.cn/list=hf_*` 对数据中心出口
       常常直接 403，而同一家的 `stock2.finance.sina.com.cn` 外盘期货接口一直活着
       ——它给的是分钟线，最后一个点就是现价，配上日线昨收就能算出涨跌幅。
       多花 8 个子请求，换的是「东财一抽，隔夜卡上四个期货全消失」不再发生。 */
    .then((r) => (r && Object.keys(r).length ? r : fetchFutSinaMinQuote()))
    .catch(() => ({}));   // 期货整体失败允许：返回空对象，前端隐藏该行

  /* 亚太三档：主源 → 备源（换厂商）→ 上次成功的那份（KV）。
     主源一次失败就是整批空，而这张卡只有「有数组」和「整块隐藏」两种状态，
     空着等于凭空少一块信息，所以不能像期货那样允许它空。 */
  const asiaP = (async () => {
    const t0 = Date.now();
    /* 整条链路给 3.6 秒总预算：最坏情况主源超时 + 备源三个源再各超时，能把隔夜卡
       拖到十几秒，卡着不动比少几只难受得多。超预算就用手上的 + KV 补。 */
    const left = (cap) => Math.max(400, Math.min(cap, 3600 - (Date.now() - t0)));
    let rows = [];
    /* 主源只给 1.8 秒且不重试：同一个接口连打两次的命中率提升有限，却会把预算吃光，
       让「换厂商的备源」根本轮不上——而备源才是真正能救命的那档。 */
    try { rows = await fetchAsia(left(1800)); } catch (e) { rows = []; }
    // 预算判断必须用「纯剩余量」。之前写成 left(0) > 600，而 left 有个 400 的保底，
    // 结果恒等 400，备源一次都没跑过——主源一挂就直接掉到 KV。
    if (rows.length < ON_ASIA_SECIDS.length && 3600 - (Date.now() - t0) > 600) {
      const have = new Set(rows.map((x) => x.sid));
      const miss = ON_ASIA_SECIDS.map((x) => x[0]).filter((sid) => !have.has(sid));
      try {
        const more = await fetchAsiaBackup(miss, left(1600));
        if (more.length) rows = mergeAsia(rows, more);
      } catch (e) { /* 备源也挂，往下看 KV */ }
    }
    /* 还缺个别项（KOSPI 只有一个源，它挂了就缺这一只）时，用 KV 里这一只最近的
       值补上，标 old——整行标红说「源端无响应」太重，5 只新的陪 1 只旧的，
       只要把那只标出来就够了。超过 30 分钟的不补：那时候它已经不是「刚才的价」。 */
    if (rows.length && rows.length < ON_ASIA_SECIDS.length) {
      const snap0 = await asiaSnapFromKV(env);
      const fresh = Date.now() - 30 * 60 * 1000;
      if (snap0) {
        const have0 = new Set(rows.map((x) => x.sid));
        const fill = snap0.a
          .filter((x) => !have0.has(x.sid) && (x.t || snap0.t || 0) >= fresh)
          .map((x) => ({ sid: x.sid, n: x.n, p: x.p, chg: x.chg, old: true, t: x.t || snap0.t }));
        if (fill.length) rows = mergeAsia(rows, fill);
      }
    }
    if (rows.length >= 4) {
      const sig = rows.map((x) => x.sid + ':' + x.p.toFixed(2)).join('|');
      const nowMs = Date.now();
      if (env && env.WATCH && sig !== asiaSnapSig && nowMs - asiaSnapAt >= ASIA_SNAP_GAP
          && kvWriteAllowed('on-asia')) {
        asiaSnapAt = nowMs;
        asiaSnapSig = sig;
        // 每条带上自己的时间：补进来的旧值保留原时间，否则下一次会被当成刚抓的
        const keep = { a: rows.map((x) => ({ sid: x.sid, n: x.n, p: x.p, chg: x.chg,
          t: x.old ? (x.t || nowMs) : nowMs })), t: nowMs };
        const put = env.WATCH.put(ASIA_KV, JSON.stringify(keep), { expirationTtl: 259200 });
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.resolve(put).catch(() => {}));
        else await Promise.resolve(put).catch(() => {});
      }
      return { a: rows, stale: false, ts: nowMs };
    }
    const snap = await asiaSnapFromKV(env);
    if (snap) return { a: snap.a, stale: true, ts: snap.t };
    return { a: rows, stale: false, ts: Date.now() };
  })();

  const [us, fut, asiaR] = await Promise.all([usP, futP, asiaP]);
  /* 55 秒，不是 600。原先按「美股收盘后一整天都不动」设的 10 分钟，可亚太那张卡
     和它共用这份响应：日经、KOSPI、恒生在盘中每分钟都在动，10 分钟才换一次，
     跟旁边 60 秒一刷的板块地图差着两个数量级，看着就像卡死了。
     55 秒和全站其余接口同一档（比前端的 60 秒轮询短 5 秒，保证每轮都命中新的）。 */
  return json({
    ok: true, us, fut,
    asia: asiaR.a, asiaStale: asiaR.stale, asiaTs: asiaR.ts,
    ts: Date.now(),
  }, 55);
}

/* ------------------------------------------------------------ 十年美债收益率
   隔夜卡的最后一块拼图：美股为什么涨、成长股为什么杀估值，那个早上最直接的
   解释变量就是它。两个口径上的讲究：
     - 数值用收益率本身（4.99%），不是债券价格——价格涨=收益率跌，混着看必错；
     - 变动用 bp（1bp = 0.01 个百分点）。「从 4.99 涨到 5.02」说「涨 0.6%」
       在债券里没人这么讲，说「+3bp」才是行话。
   源：CNBC 的 US10Y（Tradeweb 行情，带前收和变动两个字段，不用自己减）。
   东财也有这只（100.UST10Y），但 100 号段最近连分时都不给，先只挂验证过的源；
   300 秒缓存：收益率日内动得慢，没必要跟着 55 秒的隔夜卡一起刷。 */
async function serveBond() {
  const cache = await getCache();
  const key = new Request('https://etf.internal/bond/v1', { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 降级直连 */ }
  }
  let out = null;
  try {
    const r = await fetch('https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
      + '?symbols=US10Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1', {
      headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('美债 HTTP ' + r.status);
    const j = await r.json();
    const q0 = j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote;
    const q = Array.isArray(q0) ? q0[0] : (q0 && q0.FormattedQuote);
    const p = parseFloat(String((q && q.last) || '').replace('%', ''));
    const prev = parseFloat(String((q && q.previous_day_closing) || '').replace('%', ''));
    const d = parseFloat(q && q.change);
    if (p > 0.2 && p < 20) {
      out = {
        p, prev: isFinite(prev) ? prev : 0,
        // change 是百分点（+0.003），乘 100 换成 bp，前端只负责加单位
        bp: isFinite(d) ? d * 100 : (isFinite(prev) ? (p - prev) * 100 : 0),
        t: String((q && q.last_time) || ''),
        src: 'cnbc',
      };
    }
  } catch (e) {
    return json({ ok: false, error: '美债上游取不到：' + String((e && e.message) || e) });
  }
  if (!out) return json({ ok: false, error: '美债解析为空' });
  const res = json({ ok: true, ...out, ts: Date.now() }, 300);
  if (cache) {
    try { await cache.put(key, res.clone()); } catch (e) { /* 忽略 */ }
  }
  return res;
}

/* 分时代理：隔夜/亚太条目点开画的线。东财 trends2，ndays=1 取最近一个
   完整交易时段——美股指数/期货拿到的是昨晚那场，亚太拿到的是今天（或最近
   半场）。secid 白名单限定全球/港股指数 + A 股指数 + 外盘期货市场号，
   不给任意转发。 */
/* A 股指数精确白名单：只放行亚太行用到的几个（直接对齐 ON_ASIA_SECIDS，
   防止 6 位数字规则把个股也放进来——个股走 K 线面板，不给任意转发）。
   105/106/107 是美股三个市场号：105=NASDAQ、106=NYSE、107=AMEX。隔夜卡的
   赛道成分股（英伟达、台积电这些）点开看分时/日线走的是这一档，前缀本身就是
   白名单粒度——和上面 100~104 放行「任一代码」是同一个口径，域固定为东财
   行情接口，不存在任意转发。市场号不能靠规则猜：45 只实测 25 只在 105、
   20 只在 106，同名代码换个前缀就查不到，所以前端带的是逐只探测过的全码。 */
const OV_SID_RE = /^(100|101|102|103|104|105|106|107|124)\.[A-Za-z0-9]{1,12}$/;
function isOvSid(sid) {
  return OV_SID_RE.test(sid) || ON_ASIA_SECIDS.some((x) => x[0] === sid);
}

/** 东财 secid → 腾讯代码。腾讯这套分钟接口对 A 股（sh/sz）、港股（hk）、
 *  美股（us，不带 .OQ 后缀也认）都通；日经、韩国和中金所期货没有对应代码，
 *  那几类只能留在东财。市场号 105/106/107 都是美股，实测统一用 us 即可。 */
function txCodeOf(sid) {
  const m = /^(\d+)\.([A-Za-z0-9.]+)$/.exec(String(sid || ''));
  if (!m) return null;
  const mkt = m[1], code = m[2];
  /* 100 号段（东财全球指数）在腾讯是另一套代码，一只只对出来的：
     NDX100=纳指100（28374，和卡片同值）、SPX=标普500、DJIA=道指、
     NDX=纳斯达克综合。别拿「NDX」去顶「纳斯达克100」——那是综合指，
     价格差 10%，图上涨跌幅和旁边卡片对不上，这种错最难发现。 */
  if (mkt === '100') return OV_TX_ALIAS[code] || null;
  if (mkt === '1') return 'sh' + code;
  if (mkt === '0') return 'sz' + code;
  if (mkt === '124') return 'hk' + code;
  if (mkt === '105' || mkt === '106' || mkt === '107') return 'us' + code;
  return null;
}
/* 东财全球指数代码 → 腾讯代码。日经、韩国、A50、外盘期货不在表里：
   腾讯对它们要么 pv_none_match，要么返回空体，写了也是白写。 */
const OV_TX_ALIAS = { NDX100: 'usNDX', SPX: 'usINX', DJIA: 'usDJI', NDX: 'usIXIC' };

/* ------------------------------------------------------------ 东财域名分流
   东财把行情拆在几个域上，同一个路径换个域就是另一套服务：
     push2his   实时历史（A 股、港股、美股、大部分指数）——K 线、分时的正主
     push2delay 延迟行情（全球指数、外盘期货、外汇、债券收益率）15 分钟延迟
     push2      实时快照（ulist 那类批量接口）
   2026-11-12 实测：secid 用错域不会回空 JSON，而是 TLS 握手后被直接断连，
   Worker 侧只看到 `fetch failed`——和「整个东财挂了」长得一模一样，
   于是隔夜卡上的纳指/标普/道指/四个期货点开全是「分时上游取不到」，
   而同一时刻 105.NDX、1.000001、124.HSTECH 都正常出图。
   前缀就是域的路由依据：100~104 是延迟行情（全球指数 100、黄金 101、
   原油 102、期货 103、外汇/CFD 104），其余走实时域。两边都留作兜底：
   延迟版好过空白，但只能排在首选之后。 */
const EM_DELAY_RE = /^(100|101|102|103|104)\./;
function emHostOrder(sid) {
  return EM_DELAY_RE.test(sid)
    ? ['push2delay', 'push2his', 'push2']
    : ['push2his', 'push2delay', 'push2'];
}

/** 按 emHostOrder 逐个域尝试，第一个「有内容」的就返回。
 *  pick(j) 返回 falsy 表示这个域回了 200 但没数据（空壳），继续试下一个——
 *  对 100.* 这类 secid，空壳和断连都出现过，不能只按 HTTP 状态判断。
 *  budget：整条链的总墙钟上限。三个域各等 7 秒最坏 21 秒，点开弹窗等到
 *  用户关页面都出不来，所以按剩余时间递减，见底就收手报错。 */
async function emTryHosts(sid, path, pick, budget) {
  const t0 = Date.now();
  const tried = [];
  for (const h of emHostOrder(sid)) {
    const left = (budget || 9000) - (Date.now() - t0);
    if (left < 800) { tried.push(h + ':预算耗尽'); break; }
    try {
      const r = await fetch('https://' + h + '.eastmoney.com' + path, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(Math.min(left, 7000)),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = pick(await r.json());
      if (v) return { v, host: h, tried };
      tried.push(h + ':空');
    } catch (e) {
      tried.push(h + ':' + String((e && e.message) || e).slice(0, 40));
    }
  }
  const err = new Error(tried.join(' / ') || '东财不可达');
  err.tried = tried;
  throw err;
}

/* 新浪外盘期货分时：（东财对 101/102/103/104 号段不提供 trends2，
   push2his/push2delay/push2 三个域全是握手后被断连，实测 2026-11-12 多次复现。）
   新浪这套 symbol 和东财的 secid 是两套命名，一只只对出来的：
     NQ   纳指期货     GC   COMEX 黄金
     CL   NYMEX 原油   CHA50CFD  富时 A50（新加坡）
   返回的 minLine_1d 有两种行长：首条带日期/交易所/开盘（10 字段），
   之后是 6 字段的 [时间, 价格, 量, 量, 均价, '完整日期时间']。
   统一只认**最后一个字段的完整日期时间**和**第二个字段的价格**——
   按位置数下标会在首条和后续两种行长之间错位，画出来就是首点乱飞。 */
const SINA_FUT = {
  '103.NQ00Y': 'NQ', '101.GC00Y': 'GC', '102.CL00Y': 'CL', '104.CN00Y': 'CHA50CFD',
};

async function fetchSinaFutMin(sid) {
  const sym = SINA_FUT[sid];
  if (!sym) return null;
  const r = await fetch('https://stock2.finance.sina.com.cn/futures/api/openapi.php/'
    + 'GlobalFuturesService.getGlobalFuturesMinLine?symbol=' + sym, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error('新浪期货分时 HTTP ' + r.status);
  const j = await r.json();
  const rows = j && j.result && j.result.data && j.result.data.minLine_1d;
  if (!Array.isArray(rows) || !rows.length) throw new Error('新浪期货分时为空');

  const pts = [];
  const seen = new Set();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(row[row.length - 1] || ''));
    const px = +row[1];
    if (!m || !(px > 0)) continue;
    const t = m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    if (seen.has(t)) continue;      // 首条和后续可能给同一个分钟
    seen.add(t);
    pts.push([t, px]);
  }
  if (pts.length < 2) throw new Error('新浪期货分时解析为空');

  /* 昨收：分时首点是「电子盘开盘价」，不等于昨收（隔夜跳空全在这一点上），
     拿它当 0 轴画出来，涨跌幅永远从 0 开始，和卡片上的 -0.91% 对不上。
     日线接口的收盘价才是昨收；只读尾部 800 字节，不为两个数解析 340KB。 */
  let pre = 0;
  try {
    const rd = await fetch('https://stock2.finance.sina.com.cn/futures/api/openapi.php/'
      + 'GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=' + sym, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(7000),
    });
    if (rd.ok) {
      const tail = (await rd.text()).slice(-1200);
      const all = tail.match(/"date":"[^"]+","open":"[^"]+","high":"[^"]+","low":"[^"]+","close":"[^"]+"/g) || [];
      // 倒数第二根就是「上一个完整交易日」，最后一根是今天（可能还没收）
      for (let i = all.length - 1; i >= 0 && !pre; i--) {
        const mm = /"date":"(\d{4}-\d{2}-\d{2})".*?"close":"([\d.]+)"/.exec(all[i]);
        if (!mm) continue;
        const today = pts[0][0].slice(0, 5);
        if (mm[1].slice(5) === today && i === all.length - 1) continue;
        if (+mm[2] > 0) pre = +mm[2];
      }
    }
  } catch (e) { /* 拿不到就交给前端退回「较本时段开盘」的口径 */ }
  return { pre, pts };
}

/* 分时快照兜底：所有源都挂时，回放这只标的最近一次成功的那份，标明时间。
   断网五分钟和断网五小时，对读图的人来说是两件事，所以超过 3 天的直接不用。 */
const OV_SNAP_KV = 'ovmin-snap/v1/';
const ovSnapDay = {};      // sid → 已写入的交易日，省掉每 35 秒一次的重复写

async function ovSnapPut(env, sid, pre, pts) {
  if (!env || !env.WATCH || !pts.length) return;
  const day = String(pts[0][0] || '').slice(0, 5);
  if (ovSnapDay[sid] === day) return;
  ovSnapDay[sid] = day;
  try {
    await env.WATCH.put(OV_SNAP_KV + sid, JSON.stringify({ pre, pts, ts: Date.now() }));
  } catch (e) { ovSnapDay[sid] = ''; }
}

async function ovSnapGet(env, sid) {
  if (!env || !env.WATCH) return null;
  try {
    const raw = await env.WATCH.get(OV_SNAP_KV + sid);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.pts) || !o.pts.length) return null;
    if (Date.now() - (o.ts || 0) > 3 * 86400e3) return null;
    return o;
  } catch (e) { return null; }
}

/* 日经 225 / 韩国 KOSPI 的分时：CNBC 的图表接口。
   这两只是整张隔夜卡上最难的——东财对 100 号段（全球指数）连 trends2 都不给，
   腾讯 pv_none_match，新浪的全球指数分时接口（GlobalService.getMinLine）
   已经下线（线上实测返回 Service not found），Yahoo 在这个出口上稳定 429。
   CNBC 的 ts-api 一次给 1 个交易日窗口的分钟 bar，实测覆盖 .N225 / .KS11，
   顺带也覆盖 .NDX / .SPX / .DJI / @GC.1 / @CL.1 / US10Y。
   两个坑：
     1) tradeTime 是「美东时区表达的绝对时刻」——日经 09:00（东京）标成 19:00，
        所以必须按美东→北京换算（+13h 冬令时），直接当时钟用会把横轴错 14 小时；
     2) 1D 窗口是最近 24 小时，日经/韩股这种带午休的市场会带回前一个交易日的尾巴，
        所以从最后一根往前回溯，遇到大于 3 小时的间隔就停，切出「当前这一场」。 */
const CNBC_MIN = { '100.N225': '.N225', '100.KS11': '.KS11' };

function cnbcMs(ts) {
  const s = String(ts || '');
  if (!/^\d{14}$/.test(s)) return 0;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}

async function fetchCnbcMin(sid) {
  const sym = CNBC_MIN[sid];
  if (!sym) return null;
  const r = await fetch('https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol='
    + encodeURIComponent(sym), {
    headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('CNBC 分时 HTTP ' + r.status);
  const j = await r.json();
  const bars = j && j.barData && j.barData.priceBars;
  if (!Array.isArray(bars) || bars.length < 10) throw new Error('CNBC 分时为空');

  let i = bars.length - 1;
  while (i > 0 && cnbcMs(bars[i].tradeTime) - cnbcMs(bars[i - 1].tradeTime) <= 180 * 60000) i--;
  const pts = [];
  for (let k = i; k < bars.length; k++) {
    const s = String(bars[k].tradeTime || '');
    const px = +bars[k].close;
    if (!/^\d{14}$/.test(s) || !(px > 0)) continue;
    pts.push([etClockToBj(s.slice(0, 8), +s.slice(8, 10), +s.slice(10, 12)), px]);
  }
  if (pts.length < 10) throw new Error('CNBC 分时解析为空');

  // 昨收：CNBC 报价接口里的 previous_day_closing，和分时同一套数据源
  let pre = 0;
  try {
    const rq = await fetch('https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
      + '?symbols=' + encodeURIComponent(sym) + '&requestMethod=itv&noform=1&partnerId=2'
      + '&fund=1&exthrs=1&output=json&events=1', {
      headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
      signal: AbortSignal.timeout(6000),
    });
    if (rq.ok) {
      const q = await rq.json();
      const q0 = q && q.FormattedQuoteResult && q.FormattedQuoteResult.FormattedQuote;
      const row = Array.isArray(q0) ? q0[0] : (q0 && q0.FormattedQuote);
      const v = parseFloat(String((row && row.previous_day_closing) || '').replace(/,/g, ''));
      if (v > 0) pre = v;
    }
  } catch (e) { /* 拿不到就用本时段首点当基准，前端会标注 */ }
  return { pre, pts };
}

/* 北京日期（YYYY-MM-DD）。CNBC 的 tradeTime 一律是「美东时区表达的绝对时刻」，
   分钟 bar 的日期要按北京算才不会在 23:00 之后串到前一天。 */
function bjYmd(ts) {
  const s = String(ts || '');
  if (!/^\d{14}$/.test(s)) return '';
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), da = +s.slice(6, 8);
  const t = new Date(Date.UTC(y, mo - 1, da, +s.slice(8, 10), +s.slice(10, 12))
    + (usDst(y, mo, da) ? 12 : 13) * 3600e3);
  return t.toISOString().slice(0, 10);
}

function bjToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

/** CNBC 日线：日经 225 与韩国 KOSPI 用。
 *
 *  这两只在腾讯那边没有代码（`pv_none_match`），新浪的外盘日线也不认它们，
 *  分时补了 CNBC，日线就同源同家地补——两处数字必须一套，否则图上收在
 *  A、卡片写着 B。
 *
 *  range 用 `3M`：名字和实际窗口不一致（实测 485 根、约两年），但 1M 只有
 *  240 根，而 /api/ovk 最多要 300 根，不够。按根数取尾部，不信 range 名字。
 *
 *  tradeTime 在日粒度上是 `YYYYMMDD000000`，日期部分就是本地交易日，不做时区
 *  换算——换算（+13h）虽然也落在同一天，但没必要绕。
 *
 *  当天这根日线要等收盘后几小时才进序列，盘中打开日线会缺今天、和分时末点
 *  对不上。所以末根不是今天就再拉一次 5D 分钟 bar，把今天聚成一根接上。 */
async function fetchCnbcDaily(sid, lim) {
  const sym = CNBC_MIN[sid];
  if (!sym) return null;
  const r = await fetch('https://ts-api.cnbc.com/harmony/app/charts/3M.json?symbol='
    + encodeURIComponent(sym), {
    headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('CNBC 日线 HTTP ' + r.status);
  const j = await r.json();
  const rows = j && j.barData && j.barData.priceBars;
  if (!Array.isArray(rows) || rows.length < 20) throw new Error('CNBC 日线为空');

  const bars = [];
  for (const b of rows) {
    const s = String((b && b.tradeTime) || '');
    if (!/^\d{8}000000$/.test(s)) continue;      // 只要日粒度；5D 那档是分钟 bar
    const o = +b.open, h = +b.high, l = +b.low, c = +b.close;
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    bars.push([s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8),
      o, h, l, c, +(b.volume || 0)]);
  }
  if (bars.length < 20) throw new Error('CNBC 日线解析为空');

  const today = bjToday();
  if (bars[bars.length - 1][0] !== today) {
    /* 先试报价接口：open/high/low/last/volume 一次给全，比把分钟 bar 聚成
       一根省一次 RTT。只用 last_time 就是今天的——休市日（周末、当地假期）
       报价里是上一个交易日的数，照补就会多出一根假蜡烛。 */
    let added = false;
    try {
      const rq = await fetch('https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
        + '?symbols=' + encodeURIComponent(sym) + '&requestMethod=itv&noform=1&partnerId=2'
        + '&fund=1&exthrs=1&output=json&events=1', {
        headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
        signal: AbortSignal.timeout(6000),
      });
      if (rq.ok) {
        const jq = await rq.json();
        const q0 = jq && jq.FormattedQuoteResult && jq.FormattedQuoteResult.FormattedQuote;
        const row = Array.isArray(q0) ? q0[0] : (q0 && q0.FormattedQuote);
        const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, ''));
        const qt = String((row && row.last_time) || '').slice(0, 10);   // '2026-11-12'
        const o = num(row && row.open), h = num(row && row.high);
        const l = num(row && row.low), c = num(row && row.last);
        if (qt === today && o > 0 && c > 0) {
          /* volume 要 ×1000：报价接口给的是「千股」（KOSPI 实测 233,733，
             同一交易日的日线是 233,733,000，正好差一千倍），直接写进去
             图上今天那根量柱会矮到看不见，像当天没成交。 */
          bars.push([today, o, h > 0 ? h : Math.max(o, c), l > 0 ? l : Math.min(o, c),
            c, (num(row && row.volume) || 0) * 1000]);
          added = true;
        }
      }
    } catch (e) { /* 退到分钟聚合 */ }

    if (!added) {
      try {
        const rd = await fetch('https://ts-api.cnbc.com/harmony/app/charts/5D.json?symbol='
          + encodeURIComponent(sym), {
          headers: { 'User-Agent': UA, Referer: 'https://www.cnbc.com/' },
          signal: AbortSignal.timeout(7000),
        });
        if (rd.ok) {
          const jd = await rd.json();
          const mins = (jd && jd.barData && jd.barData.priceBars) || [];
          let o = 0, h = 0, l = 0, c = 0, v = 0;
          for (const b of mins) {
            const s = String((b && b.tradeTime) || '');
            if (/^\d{8}000000$/.test(s) || bjYmd(s) !== today) continue;
            const px = +b.close;
            if (!(px > 0)) continue;
            if (!o) o = +b.open > 0 ? +b.open : px;
            h = Math.max(h, +b.high > 0 ? +b.high : px);
            l = l ? Math.min(l, +b.low > 0 ? +b.low : px) : (+b.low > 0 ? +b.low : px);
            c = px;
            v += +(b.volume || 0);
          }
          if (o > 0 && c > 0) bars.push([today, o, h, l, c, v]);
        }
      } catch (e) { /* 补不上今天就先只到昨天，不至于整条链失败 */ }
    }
  }

  if (bars.length > lim) bars.splice(0, bars.length - lim);
  return bars;
}

/** 腾讯分时兜底：东财几个域都不可达时用。 *
 *  A 股/港股走 minute/query，美股走 usMinute/query，返回都是
 *  "0930 4.145 42868 …" 这种以空格分隔的行——第三列是累计成交量，不是
 *  分钟量，所以只取前两列（价格），别照东财 trends2 的列序去理解。
 *
 *  域名必须是 proxy.finance.qq.com：同一套路径放在 web.ifzq.gtimg.cn 上
 *  会被腾讯 WAF 拦成 501 拦截页（实测冷却后仍然拦），换域名就正常。
 *
 *  这个接口只在东财失败后才走，且外层有 120 秒缓存，打不到腾讯限流的频率。 */
async function fetchTxMin(sid) {
  const code = txCodeOf(sid);
  if (!code) return null;
  const us = code.slice(0, 2) === 'us';
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/'
    + (us ? 'usMinute' : 'minute') + '/query?code=' + code;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error('腾讯分时 HTTP ' + r.status);
  const j = await r.json();
  const node = j && j.data && j.data[code];
  const rows = node && node.data && node.data.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('腾讯分时为空');

  // 日期用响应里带的（美股是美东日期，和本地日期不是一回事）
  const dd = String((node.data && node.data.date) || '');
  const md = dd.length === 8 ? dd.slice(4, 6) + '-' + dd.slice(6, 8) : '';
  const pts = [];
  for (const s of rows) {
    const a = String(s).split(' ');
    const hm = a[0];
    const p = +a[1];
    if (!/^\d{4}$/.test(hm) || !(p > 0)) continue;
    let t = (md ? md + ' ' : '') + hm.slice(0, 2) + ':' + hm.slice(2);
    /* 腾讯给美股打的是**美东**钟点（09:31~16:00），东财给同一只打的是北京时间
       （22:31~05:00）。两个源共用一个弹窗、一根横轴，不换算的话切一次源
       整张图的时间就平移 13 小时——形状全对、时间全错，比空图更容易误读。 */
    if (us && /^\d{8}$/.test(dd)) t = etClockToBj(dd, +hm.slice(0, 2), +hm.slice(2));
    pts.push([t, p]);
  }
  if (!pts.length) throw new Error('腾讯分时解析为空');

  // 昨收：qt 节点里是「~」分隔的快照，第 5 个字段是昨收。拿不到就交给前端
  // 退回「较本时段开盘」的口径，不硬编一个假的 0 轴。
  let pre = 0;
  const qt = node && node.qt && node.qt[code];
  if (Array.isArray(qt) && +qt[4] > 0) pre = +qt[4];
  return { pre, pts };
}

/* 美东钟点 → 北京「MM-DD HH:MM」。
   美东 09:30 = 北京 22:30（冬令时）/ 21:30（夏令时），美股一个交易日的分时
   在横轴上正好跨过零点，所以日期必须跟着一起进位，不能只加小时。 */
function etClockToBj(dd, hh, mm) {
  const y = +dd.slice(0, 4), mo = +dd.slice(4, 6), da = +dd.slice(6, 8);
  // 当作纯钟表时刻算（Date.UTC），再加时差；夏令时 +12h、冬令时 +13h
  const t = new Date(Date.UTC(y, mo - 1, da, hh, mm) + (usDst(y, mo, da) ? 12 : 13) * 3600e3);
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  return p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()) + ' '
    + p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes());
}

/* 美东是否在夏令时：3 月第二个周日 02:00 起，11 月第一个周日 02:00 止。
   只按日期算，不精确到小时——分时横轴上差一小时只在换时令那两天出现，
   而那两天本来就没有分时数据。 */
function usDst(y, mo, da) {
  if (mo < 3 || mo > 11) return false;
  if (mo > 3 && mo < 11) return true;
  const nthSun = (m, n) => {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  return mo === 3 ? da >= nthSun(3, 2) : da < nthSun(11, 1);
}

/* 美股代码的交易所后缀（AAPL.OQ 这种）。腾讯的日线接口不认裸代码：
   给 usAAPL 只会回「上市首日 + 最新」两条，加后缀才是完整序列。
   后缀从 qt 快照的第 3 个字段取，一只只查过一次就记下来。 */
const TX_US_SUFFIX = {};
async function txUsSuffix(code) {
  if (TX_US_SUFFIX[code]) return TX_US_SUFFIX[code];
  try {
    const r = await fetch('https://qt.gtimg.cn/q=us' + code, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const t = new TextDecoder('gbk').decode(await r.arrayBuffer());
    const m = /="([^"]*)"/.exec(t);
    const f = m ? m[1].split('~') : [];
    const full = f[2] || '';
    if (full.indexOf('.') > 0) { TX_US_SUFFIX[code] = full; return full; }
  } catch (e) { /* 下一轮再试 */ }
  return null;
}

/** 腾讯日线兜底。A 股/港股走 newfqkline 的 qfqday，美股走 day（无复权）。
 *  两边列序一致：日期,开,收,高,低,量 —— 和东财那边重排后的 o/h/l/c 正好对得上。 */
async function fetchTxKline(sid, lim) {
  let sym = txCodeOf(sid);
  if (!sym) return null;
  const isUs = sym.slice(0, 2) === 'us';
  if (isUs) {
    /* 个股必须带交易所后缀（AAPL.OQ），裸代码只回「上市首日 + 最新」两条；
       指数反过来——usNDX/usINX/usDJI 裸代码就是完整序列，而快照里给的后缀是
       「.NDX」这种点开头的串，拼成 us.NDX 多一层不确定性，不要。 */
    const suf = await txUsSuffix(sym.slice(2));
    if (suf) sym = 'us' + suf;
  }
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
    + '?param=' + sym + ',day,,,' + lim + ',qfq';
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('腾讯 K 线 HTTP ' + r.status);
  const j = await r.json();
  const node = j && j.data && (j.data[sym] || j.data[Object.keys(j.data)[0]]);
  const rows = node && (node.qfqday || node.day);
  if (!Array.isArray(rows) || !rows.length) throw new Error('腾讯 K 线为空');
  const bars = rows.map((a) => [a[0], +a[1], +a[3], +a[4], +a[2], +a[5]])
    .filter((b) => b[1] > 0 && b[4] > 0);
  // 裸代码的历史接口只给两条（首日 + 最新），那不是 K 线，别拿它充数
  if (!bars.length || (isUs && bars.length < 10)) throw new Error('腾讯 K 线解析为空');
  return bars;
}

/* 新浪外盘期货日线：四个期货标的的 K 线兜底。接口一次吐全历史（340KB），
   只要最后 lim 根，所以按尾部字符串切，不做整份 JSON.parse——
   Worker 免费版 10ms 的 CPU 预算，解析 340KB 会把它吃光。 */
async function fetchSinaFutKline(sid, lim) {
  const sym = SINA_FUT[sid];
  if (!sym) return null;
  const r = await fetch('https://stock2.finance.sina.com.cn/futures/api/openapi.php/'
    + 'GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=' + sym, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('新浪期货日线 HTTP ' + r.status);
  const txt = await r.text();
  const rows = txt.match(/"date":"\d{4}-\d{2}-\d{2}","open":"[\d.]+","high":"[\d.]+","low":"[\d.]+","close":"[\d.]+"/g) || [];
  const bars = [];
  for (const s of rows.slice(-lim)) {
    const m = /"date":"([\d-]+)","open":"([\d.]+)","high":"([\d.]+)","low":"([\d.]+)","close":"([\d.]+)"/.exec(s);
    if (!m) continue;
    bars.push([m[1], +m[2], +m[3], +m[4], +m[5], 0]);
  }
  if (!bars.length) throw new Error('新浪期货日线解析为空');
  return bars;
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
     「Unexpected token 'I'」，真正的原因（上游 HTTP 502 / 超时）全丢了。
     域按 secid 前缀选，见 emHostOrder。 */
  let out = null;
  let emErr = null;
  try {
    out = await emTryHosts(sid, '/api/qt/stock/trends2/get?secid=' + sid
      + '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53&iscr=0&ndays=1', (j) => {
      const tr = j && j.data && j.data.trends;
      if (!tr || !tr.length) return null;
      /* 昨收一起带回去：前端左轴要画涨跌幅刻度，基准必须是昨收，
         不能拿本时段第一个点凑——那画出来的「+0.00%」不是涨跌，
         和卡片上的 +2.10% 对不上，看图的人反而更糊涂。
         期货只有 preSettlement（昨结），指数/个股才有 preClose，依次退。 */
      const d = j.data || {};
      const pre = +d.preClose > 0 ? +d.preClose : (+d.preSettlement > 0 ? +d.preSettlement : 0);
      return { trends: tr, pre };
    }, 9000);
  } catch (e) {
    emErr = e;
  }
  const trends = out && out.v.trends;
  if (!trends || !trends.length) {
    /* 东财对 100~104 号段不给分时（三个域全断连），换厂商，按覆盖范围排：
       腾讯 → A 股/港股/美股个股 + 美股三大指数（100.NDX100/SPX/DJIA）
       新浪 → 四个外盘期货（NQ/GC/CL/CHA50CFD）
       日经、韩国两边都没有可用代码，只能靠 KV 里上一次成功的那份。 */
    const errs = ['东财 ' + String((emErr && emErr.message) || '无数据').slice(0, 60)];
    try {
      const tb = await fetchTxMin(sid);
      if (tb) {
        await ovSnapPut(env, sid, tb.pre, tb.pts);
        const res2 = json({ ok: true, sid, pre: tb.pre, pts: tb.pts, ts: Date.now(), src: 'tencent' }, 120);
        if (cache) {
          try { await cache.put(key, res2.clone()); } catch (e) { /* 忽略 */ }
        }
        return res2;
      }
      errs.push('腾讯无此代码');
    } catch (e) {
      errs.push('腾讯 ' + String((e && e.message) || e).slice(0, 40));
    }
    try {
      const sb = await fetchSinaFutMin(sid);
      if (sb) {
        await ovSnapPut(env, sid, sb.pre, sb.pts);
        const res2 = json({ ok: true, sid, pre: sb.pre, pts: sb.pts, ts: Date.now(), src: 'sina-fut' }, 120);
        if (cache) {
          try { await cache.put(key, res2.clone()); } catch (e) { /* 忽略 */ }
        }
        return res2;
      }
      errs.push('新浪无此代码');
    } catch (e) {
      errs.push('新浪 ' + String((e && e.message) || e).slice(0, 40));
    }
    try {
      const cb = await fetchCnbcMin(sid);
      if (cb) {
        await ovSnapPut(env, sid, cb.pre, cb.pts);
        const res2 = json({ ok: true, sid, pre: cb.pre, pts: cb.pts, ts: Date.now(), src: 'cnbc' }, 120);
        if (cache) {
          try { await cache.put(key, res2.clone()); } catch (e) { /* 忽略 */ }
        }
        return res2;
      }
      errs.push('CNBC 无此代码');
    } catch (e) {
      errs.push('CNBC ' + String((e && e.message) || e).slice(0, 40));
    }
    const snap = await ovSnapGet(env, sid);
    if (snap) {
      /* stale 一定要标出来：图是能看的，但横轴上的时间可能已经是几小时前，
         不标的话这段走势会被当成「今天怎么走的」。前端只压一行灰字，不弹窗。 */
      return json({ ok: true, sid, pre: snap.pre, pts: snap.pts, ts: snap.ts,
        stale: true, src: 'snapshot' }, 30);
    }
    // 三档各记一行：只报「取不到」等于把排障成本推给人，哪一档挂了一目了然
    return json({ ok: false, error: '分时上游取不到：' + errs.join(' / ') });
  }
  const pts = trends.map((s) => {
    const a = s.split(',');
    return [a[0].slice(5, 16), +a[1]];      // '11-06 22:30', 24602.48
  });
  await ovSnapPut(env, sid, out.v.pre, pts);
  const res = json({ ok: true, sid, pre: out.v.pre, pts, ts: Date.now(),
    src: 'em:' + out.host }, 120);
  if (cache) {
    try { await cache.put(key, res.clone()); } catch (e) { /* 忽略 */ }
  }
  return res;
}

/* 行情源探针——只给排障用，不做缓存、不进前端。
   GET /api/ovprobe?sids=100.NDX100,100.N225,103.NQ00Y
       把每个 secid 在东财三个域上的 trends2 全打一遍：HTTP 码、点数、耗时。
       「取不到分时」到底是域用错了、还是这只真没分时，一屏看完。
   GET /api/ovprobe?snap=100.UST10Y,100.US10Y
       用 ulist 批量打现价/涨跌，专门用来「找代码」：全球指数、外盘期货、
       债券收益率这些 secid 是逐只试出来的，没有可推导的规则
       （100.NDX 是纳斯达克综合、100.NDX100 才是纳指 100）。 */
async function serveOvProbe(url) {
  /* ?trial=1：日经/KOSPI 的分时源试打。这两只没有腾讯/新浪期货的对应代码，
     唯一可能是新浪的全球指数接口——但它在当前出口上到底通不通、返回什么结构，
     在部署环境里打一发比猜快。只放白名单 URL，不做通用转发。 */
  if (url.searchParams.get('trial') === '1') {
    const LIST = [
      ['sina_json_v2', 'https://quotes.sina.cn/global/api/json_v2.php/GlobalService.getMinLine?symbol=int_nikkei'],
      ['sina_openapi', 'https://quotes.sina.cn/global/api/openapi.php/GlobalService.getMinLine?symbol=int_nikkei'],
      ['sina_jsonp', 'https://quotes.sina.cn/global/api/jsonp_v2.php/var%20t=/GlobalService.getMinLine?symbol=int_nikkei'],
      ['sina_kline', 'https://quotes.sina.cn/global/api/openapi.php/GlobalService.getKLine?symbol=int_nikkei&day=1'],
      ['sina_hq', 'https://hq.sinajs.cn/list=int_nikkei'],
      ['sina_kospi', 'https://hq.sinajs.cn/list=int_kospi'],
      /* Yahoo 是唯一一个同时覆盖日经、KOSPI、外盘期货、美债的免费源。
         沙箱出口实测 429（Edge: Too Many Requests），线上出口未必同样待遇，
         所以放到部署环境里打一发——通了就能一次性替掉四五个单点。 */
      ['yahoo_n225', 'https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?interval=1m&range=1d'],
      ['yahoo_ks11', 'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1m&range=1d'],
      ['yahoo_nq', 'https://query2.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=1m&range=1d'],
      ['yahoo_tnx', 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1m&range=1d'],
    ];
    const rows = await Promise.all(LIST.map(async ([k, u]) => {
      const t0 = Date.now();
      try {
        const r = await fetch(u, {
          headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
          signal: AbortSignal.timeout(7000),
        });
        const t = await r.text();
        return { k, s: r.status, ms: Date.now() - t0, bytes: t.length, head: t.slice(0, 260) };
      } catch (e) {
        return { k, s: 0, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 60) };
      }
    }));
    return json({ ok: true, mode: 'trial', rows });
  }
  const snap = String(url.searchParams.get('snap') || '').trim();
  if (snap) {
    const sids = snap.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!sids.length) return json({ ok: false, error: 'snap 为空' });
    const out = [];
    for (const host of ['push2delay', 'push2']) {
      const t0 = Date.now();
      try {
        const r = await fetch('https://' + host + '.eastmoney.com/api/qt/ulist.np/get'
          + '?fltt=2&invt=2&secids=' + sids.join(',')
          + '&fields=f2,f3,f4,f12,f13,f14', {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          signal: AbortSignal.timeout(7000),
        });
        const j = await r.json().catch(() => null);
        const diff = (j && j.data && j.data.diff) || [];
        out.push({
          host, s: r.status, ms: Date.now() - t0,
          rows: (Array.isArray(diff) ? diff : Object.values(diff))
            .map((x) => ({ secid: (x.f13 != null ? x.f13 + '.' : '') + x.f12, n: x.f14, p: x.f2, chg: x.f3, d: x.f4 })),
        });
      } catch (e) {
        out.push({ host, s: 0, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 80) });
      }
    }
    return json({ ok: true, mode: 'snap', out });
  }

  const sids = String(url.searchParams.get('sids') || '').split(',')
    .map((s) => s.trim()).filter((s) => isOvSid(s)).slice(0, 6);
  if (!sids.length) return json({ ok: false, error: 'sids 需为逗号分隔的 secid（最多 6 个）' });
  const hosts = String(url.searchParams.get('hosts') || 'push2his,push2delay,push2')
    .split(',').map((s) => s.trim()).filter((h) => /^push2[a-z]*$/.test(h)).slice(0, 3);
  const vs = String(url.searchParams.get('v') || '1,3')
    .split(',').map((s) => +s).filter((n) => n >= 1 && n <= 4).slice(0, 4);

  /* 变体：
     1 trends2 原样（A 股/美股这条一直通）
     2 trends2 + ut（缺 token 被拒时会回 200 空体，不报错，所以要和大写一起看）
     3 kline klt=1 分钟线——分时拿不到时的替代路径，前端按点画折线即可
     4 kline klt=101 日线（K 线弹窗同源） */
  const PATHS = {
    1: (s) => '/api/qt/stock/trends2/get?secid=' + s
      + '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53&iscr=0&ndays=1',
    2: (s) => '/api/qt/stock/trends2/get?secid=' + s
      + '&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6,f7,f8'
      + '&fields2=f51,f53&iscr=0&iscca=0&ndays=1',
    3: (s) => '/api/qt/stock/kline/get?secid=' + s + '&klt=1&fqt=1&lmt=400'
      + '&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57',
    4: (s) => '/api/qt/stock/kline/get?secid=' + s + '&klt=101&fqt=1&lmt=60'
      + '&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57',
  };

  const jobs = [];
  for (const sid of sids) {
    for (const host of hosts) {
      for (const v of vs) {
        jobs.push((async () => {
          const t0 = Date.now();
          try {
            const r = await fetch('https://' + host + '.eastmoney.com' + PATHS[v](sid), {
              headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
              signal: AbortSignal.timeout(6000),
            });
            const j = await r.json().catch(() => null);
            const arr = (j && j.data && (j.data.trends || j.data.klines)) || null;
            const ref = v === 3 ? j && j.data && j.data.preClose : null;
            return {
              sid, host, v, s: r.status, ms: Date.now() - t0,
              n: Array.isArray(arr) ? arr.length : 0,
              pre: ref || (j && j.data && (j.data.preClose || j.data.preSettlement)) || 0,
              head: Array.isArray(arr) && arr.length ? String(arr[arr.length - 1]).slice(0, 24) : '',
            };
          } catch (e) {
            return { sid, host, v, s: 0, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 50) };
          }
        })());
      }
    }
  }
  const rows = await Promise.all(jobs);
  // 汇总成「每只一行、域×变体一列」的矩阵，比按请求顺序滚一遍好读
  const bySid = {};
  for (const r of rows) {
    const k = r.host.replace('push2', 'p') + '/v' + r.v;
    (bySid[r.sid] = bySid[r.sid] || []).push(
      r.n ? k + '=' + r.n : (r.err ? k + '=✗' : k + '=[s' + r.s + ']'));
  }
  return json({ ok: true, mode: 'trends', rows, summary: bySid });
}

/* 隔夜/亚太条目的 K 线：同一个 secid，换成东财的日线接口。
   分时回答「今天怎么走」，K 线回答「现在这个位置算高还是低」——
   隔夜卡上那几个指数（纳指、金价、A50）价格在什么区间里，光看一根分时看不出来。
   前复权（fqt=1）：指数无所谓，但期货连续合约换月会跳空，不复权就是一根假缺口。
   缓存 5 分钟：日线一天只变一次，点开时才请求，不值得为它做秒级。 */
async function serveOvK(sid, n, env, ctx) {
  const cache = await getCache();
  const lim = Math.max(30, Math.min(300, n | 0));
  /* v2：日经/韩国改走 CNBC 后，v1 里存的是「失败」和「今天量柱为 0」的旧结果，
     边缘缓存 600 秒，不换键的话这段时间点开还是旧的。 */
  const key = new Request('https://etf.internal/ovk/v2/' + sid + '/' + lim, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 降级直连 */ }
  }
  let out = null;
  let emErrK = null;
  try {
    out = await emTryHosts(sid, '/api/qt/stock/kline/get'
      + '?secid=' + sid + '&klt=101&fqt=1&lmt=' + lim
      + '&end=20500101&fields1=f1,f2,f3,f4,f5,f6'
      + '&fields2=f51,f52,f53,f54,f55,f56,f57', (j) => {
      const k = j && j.data && j.data.klines;
      return k && k.length ? k : null;
    }, 9000);
  } catch (e) {
    emErrK = e;
  }
  const ks = out && out.v;
  if (!ks || !ks.length) {
    /* 和分时同一条链路，一起挂。换腾讯：A 股/港股/美股都能取到日线，
       中金所期货和日经/韩国没有对应代码，仍然只能报错。 */
    try {
      const tb = await fetchTxKline(sid, lim);
      if (tb) {
        const res2 = json({ ok: true, sid, bars: tb, ts: Date.now(), src: 'tencent' }, 300);
        if (cache) {
          try { await cache.put(key, res2.clone()); } catch (e) { /* 忽略 */ }
        }
        return res2;
      }
    } catch (e) { /* 下一档 */ }
    try {
      const sb = await fetchSinaFutKline(sid, lim);
      if (sb) {
        const res2 = json({ ok: true, sid, bars: sb, ts: Date.now(), src: 'sina-fut' }, 1800);
        if (cache) {
          try { await cache.put(key, res2.clone()); } catch (e) { /* 忽略 */ }
        }
        return res2;
      }
    } catch (e) { /* 下一档 */ }
    /* 日经/韩国：腾讯没有代码、新浪外盘日线不认，只有 CNBC 这一条。
       放在最后是因为它只对这两个 secid 生效，前面几档能覆盖的不必多打一次。 */
    try {
      const cb = await fetchCnbcDaily(sid, lim);
      if (cb) {
        const res2 = json({ ok: true, sid, bars: cb, ts: Date.now(), src: 'cnbc' }, 600);
        if (cache) {
          try { await cache.put(key, res2.clone()); } catch (e) { /* 忽略 */ }
        }
        return res2;
      }
    } catch (e) { /* 四家都挂 */ }
    return json({ ok: false, error: 'K 线上游取不到：'
      + String((emErrK && emErrK.message) || '无数据') });
  }
  /* 字段顺序：日期,开,收,高,低,量,额。这里重排成 o/h/l/c 的顺序，
     前端画蜡烛不用再记一遍源头的列序（记错了就是高低画反，肉眼极难发现）。 */
  const bars = ks.map((s) => {
    const a = s.split(',');
    return [a[0], +a[1], +a[3], +a[4], +a[2], +a[5]];
  }).filter((b) => b[1] > 0 && b[4] > 0);
  if (!bars.length) return json({ ok: false, error: 'K 线解析为空' });
  const res = json({ ok: true, sid, bars, ts: Date.now(), src: 'em:' + out.host }, 300);
  if (cache) {
    try { await cache.put(key, res.clone()); } catch (e) { /* 忽略 */ }
  }
  return res;
}

/* 全 A 市场结构的说明见 serveMkt（下面）。这里原本还有一段「板块地图用 ETF
   成交额算四象限是错的」的注释，结论仍然成立，只是算法已经换成个股口径，
   注释里的 496 板块 / f100 / 128 行业那套已经作废了。 */
// ---------------------------------------------------------------- 份额日档
/**
 * 份额变化（清单里那一列 + 点开后的每日柱状图）。
 *
 *   GET /api/shares              → shares/last.json     整表：份额、当日净流入、指数归属
 *   GET /api/shares?ix=1         → shares/ix.json       同指数汇总的每日序列
 *   GET /api/shares?code=510300  → shares/510300.json   单只 250 天净流入 + 折算标记
 *
 * 为什么不并进 /api/all：那个响应 600KB，再 JSON.parse 一遍份额会吃掉免费版
 * 10ms 的 CPU 预算。这里只做字节透传，一个字段都不解。
 *
 * 也不写 KV：份额每天只变一次，边缘缓存 5 分钟足够，没必要占 KV 的写额度。
 */
async function serveShares(url, env, ctx) {
  const code = String(url.searchParams.get('code') || '').trim();
  const isIx = url.searchParams.get('ix') === '1';
  if (code && !/^\d{6}$/.test(code)) return json({ ok: false, error: 'code 非法' }, 60);
  const key = code ? 'shares/' + code + '.json' : (isIx ? 'shares/ix.json' : 'shares/last.json');
  const ttl = code || isIx ? 1800 : 300;

  const cache = await getCache();
  const ck = new Request('https://etf-board.internal/' + key, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败继续回源 */ }
  }

  let obj;
  try {
    obj = await readAsset(env, key);
  } catch (e) {
    // 失败只缓存 60 秒：pipeline 一旦补上数据，页面不用再等半小时
    return json({ ok: false, code: 'SHARES_ERR', error: '读取份额数据失败: ' + (e.message || e) }, 60);
  }
  if (!obj) return json({ ok: false, code: 'NO_SHARES', error: '份额数据还没生成' }, 60);

  const h = new Headers();
  if (obj.etag) h.set('ETag', obj.etag);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'public, max-age=' + ttl);
  h.set('Access-Control-Allow-Origin', '*');
  const resp = new Response(obj.body, { headers: h });
  if (cache) {
    try {
      const p = cache.put(ck, resp.clone());
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
      else await p;
    } catch (e) { /* 忽略 */ }
  }
  return resp;
}

/* ================================================================
 * 全 A 市场结构：集中度 × 宽度
 * ================================================================
 * 口径：TOP3 三级行业成交额 ÷ 全 A 个股成交额，行业取 EM2016（244 个三级）。
 * 一只股票只归一个三级行业，互不重叠；没有三级归属的（极少数）只进分母。
 *
 * 两条取数路，同一个口径：
 *   盘中 —— 拉一次全 A 列表（f12/f3/f6），按 MKT_IND_OF 归行业现算
 *   其余 —— 读 mkt_hist.json（管线每天 16:35 回算的 250 天）
 *
 * 为什么不用东财板块接口现算了：那张表是申万口径（名字带 Ⅱ/Ⅲ），和 EM2016
 * 的 244 个三级名只重合 89 个，筛不全就抛错，整块卡片跟着挂。
 */
const MKT_CVER = 'em2016-l3';
const MKT_LIVE_KEY = 'mkt-live-v1';    // 最近一次成功的盘中快照
const MKT_LIVE_GAP = 5 * 60 * 1000;    // 5 分钟写一次：一天 60 来次，够“最近”，也不吃 KV 额度

/* 沪深主板 + 创业板 + 科创板。北交所在历史回算里就剔了，这里保持一致，
   否则盘中 c 的分母比历史大 1% 左右，点会整体往下飘。
   分四段是为了 pz 被限流时能逐段重试——比按页翻 53 次省得多。 */
const MKT_FS = ['m:1+t:2', 'm:1+t:23', 'm:0+t:6', 'm:0+t:80'];
const MKT_FS_ALL = MKT_FS.join(',');

/* 北京时间的「现在是哪一段」。
 *   live   09:15–15:05  每 30 秒重算
 *   settle 15:05–20:00  收盘值已成定局，但静态文件要等管线 16:35 才更新，
 *                       这段仍然现算，缓存放宽到 120 秒
 *   closed 其余         直接读静态
 * 不判节假日：休市日 clist 回来的是上一交易日的数据，由 f124 验日拦掉，
 * 自然落到静态。集合竞价（09:15–09:25）成交额还没起来，也会被 n>=1500 拦掉。 */
function mktClock() {
  const bj = new Date(Date.now() + 8 * 3600e3);
  const wd = bj.getUTCDay();
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const day = bj.toISOString().slice(0, 10);
  const hhmm = String(bj.getUTCHours()).padStart(2, '0') + ':'
    + String(bj.getUTCMinutes()).padStart(2, '0');
  const workday = wd >= 1 && wd <= 5;
  const phase = !workday ? 'closed'
    : (mins >= 555 && mins < 905) ? 'live'
      : (mins >= 905 && mins < 1200) ? 'settle'
        : 'closed';
  return { phase, day, mins, hhmm, workday };
}

/* 250 天历史。isolate 内缓存 60 秒：盘中的 live 路径每次都要借它当 hist，
   不缓存就变成每分钟读一遍 30KB 的 JSON。 */
let _mktBase = { at: 0, h: null };
async function mktBase(env) {
  if (_mktBase.h && Date.now() - _mktBase.at < 60000) return _mktBase.h;
  let h = null;
  try {
    if (histSource(env)) {
      const a = await readAsset(env, 'mkt_hist.json');
      if (a) {
        const j = JSON.parse(await a.text());
        /* 只认自家口径。data 分支上那份是上一次发布留下的，换口径的当天它还是旧的，
           不校验就会拿旧口径的 c 配新口径的点云，当天的点直接被甩到云最顶上。 */
        if (j && Array.isArray(j.d) && j.d.length >= 60 && j.cVer === MKT_CVER) h = j;
      }
    }
  } catch (e) { /* 读不到就走内联那份，卡片不能因此空掉 */ }
  // 内联那份是部署时固化的，只作兜底：它的「最新一天」会随着不重新部署越来越旧
  if (!h && MKT_HIST && Array.isArray(MKT_HIST.d) && MKT_HIST.d.length >= 60) h = MKT_HIST;
  if (h) _mktBase = { at: Date.now(), h };
  return h;
}

/** 把一份 250 天的历史压成「最新一天 + 全量历史」。c/b 存的是千分位整数，
 *  出口统一换成百分数，页面直接显示。 */
function mktPack(h, src) {
  const i = h.d.length - 1;
  const u = h.u[i] || 0, w = h.w[i] || 0;
  return {
    ok: true, mode: 'close', d: h.d[i], asOf: h.d[i], snapAt: '',
    cVer: h.cVer || MKT_CVER,
    c: h.c[i] / 10, b: h.b[i] / 10,
    // 页面历史上用 stockUp/stockDn/stockN 这三个名字，保持兼容
    stockUp: u, stockDn: w, stockN: (u + w) || h.n[i] || 0,
    n: h.n[i] || 0, p5: (h.p5 && h.p5[i] / 10) || 0,
    amt: (h.a && h.a[i]) || 0,
    top3: h.t3 || [], inds: h.inds || (h.ind || []).length,
    src,
    // 点散点时要用 t/ind 回答「那天钱压在哪条线」，光两个数字不够
    hist: { d: h.d, c: h.c, b: h.b, n: h.n, u: h.u, w: h.w, a: h.a,
      t3: h.t3 || [], t: h.t, ind: h.ind, p5: h.p5, cVer: h.cVer || '' },
  };
}

async function serveMktStatic(env, ctx, note) {
  const cache = await getCache();
  const key = new Request('https://etf-board.internal/mkt/static/v3', { method: 'GET' });
  // 带 note 的是诊断请求：不吃缓存，否则永远看不到这次失败的原因
  if (!note && cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
  }
  const h = await mktBase(env);
  if (!h) return json({ ok: false, code: 'NO_MKT', error: '市场结构数据还没有生成' }, 60);
  const out = mktPack(h, h === MKT_HIST ? 'inline' : 'file');
  // note 只在盘中现算失败时出现，页面不显示，留给 /api/mktprobe?t=kv 和排查用
  if (note) out.note = String(note).slice(0, 200);
  const res = json(out, 120);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  return res;
}

/** 一次 clist：pn=1 + 大 pz。字段只要代码/涨跌幅/成交额/时间戳，别的一律不带——
 *  5200 只 × 4 个字段约 250KB，多带 f14（名字）这份就要 600KB，白烧 CPU。 */
async function mktClist(host, fs, pz) {
  const qs = new URLSearchParams({
    pn: '1', pz: String(pz), po: '0', np: '1', fltt: '2', invt: '2',
    ut: 'bd1d9ddb04089700cf9c27f6f7426281', fid: 'f12',
    fs, fields: 'f12,f3,f6,f124',
  });
  const r = await fetch('https://' + host + '.eastmoney.com/api/qt/clist/get?' + qs, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const d = j && j.data;
  if (!d || !d.diff) throw new Error('空壳');
  return { rows: Array.isArray(d.diff) ? d.diff : Object.values(d.diff), total: d.total || 0 };
}

/* 一批 700 只。线上探针实测（?t=sina）：700 只 169KB / 1.4 秒正常，
   900 只 URL 顶到 8.1KB 直接被新浪回 431，所以 700 是稳的上界。
   8 批 3 并发，约 4~5 秒。 */
const MKT_BATCH = 700;
const MKT_CONC = 3;

/** 一次批量报价。返回 {rows, day}，rows 的形状与东财 clist 对齐（f12/f3/f6/f124），
 *  下游 aggLive 不用区分来源。
 *
 *  为什么用新浪 hq：东财 ulist 连打 11 批会被限流（第 1 组就 502，快速失败不是超时）；
 *  新浪这个是老接口，全网行情软件在用，限流宽得多，而且一次能带 700 只。
 *  返回 GBK，按 utf-8 解出来中文是乱码——不管它：只需要 昨收/现价/成交额/日期
 *  四个位置，GBK 双字节不会落在 0x2C（逗号）和 0x22（引号）上，分隔符安全。 */
async function mktSinaBatch(codes) {
  const q = codes.map((c) => (c[0] === '6' ? 'sh' : 'sz') + c).join(',');
  const r = await fetch('https://hq.sinajs.cn/list=' + q, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const txt = new TextDecoder('utf-8').decode(await r.arrayBuffer());
  const re = /hq_str_(?:sh|sz)(\d{6})="([^"]*)"/g;
  const rows = [];
  let day = '', m;
  while ((m = re.exec(txt))) {
    const f = m[2].split(',');
    if (f.length < 32) continue;
    if (!day && /^\d{4}-\d{2}-\d{2}$/.test(f[30])) day = f[30];
    const prev = +f[2], last = +f[3];
    rows.push({
      f12: m[1],
      // 停牌时现价为 0：算成平盘，成交额也是 0，aggLive 会把它排除在 n 之外
      f3: (prev > 0 && last > 0) ? (last - prev) / prev * 100 : 0,
      f2: last,     // 现价。全 A 聚合用不上，行业成分股那张表要显示，顺手带着
      f6: +f[9] || 0,
      f124: 0,      // 下面按批统一填，见 dsec
    });
  }
  const dsec = day ? Date.parse(day + 'T00:00:00+08:00') / 1000 : 0;
  for (const x of rows) x.f124 = dsec;
  return { rows, day };
}

/** 拿全 A 的当日快照。
 *
 * 为什么不是 clist：它的 pz 被硬卡在 100（要 6000 只也只回 100 条，而且直接 502），
 * 5564 只按 100 翻页要 56 个子请求，免费版 50 就爆了。
 * 新浪批量 700 只一次，5223 只分 8 批。
 *
 * 已知偏差：表是每周刷新的，当期新上市的几只不在里面，不进分母（占比影响 <0.1pt）。
 * 北交所本来就不在表里，历史回算也剔了它，口径一致。
 *
 * 任一批失败就整份丢弃——半份列表会让集中度凭空偏低，比拿不到更糟。 */
async function fetchAAll() {
  const codes = Object.keys(MKT_IND_OF);
  const batches = [];
  for (let i = 0; i < codes.length; i += MKT_BATCH) batches.push(codes.slice(i, i + MKT_BATCH));

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < batches.length; i += MKT_CONC) {
    const part = await Promise.all(batches.slice(i, i + MKT_CONC).map((b) =>
      mktSinaBatch(b).catch(() => mktSinaBatch(b).catch(() => null))));
    const bad = part.findIndex((x) => !x || !x.rows.length);
    if (bad >= 0) {
      const err = new Error('批量报价缺第 ' + (i + bad + 1) + '/' + batches.length + ' 组'
        + '（已取 ' + rows.length + ' 只）');
      err.tried = ['sina ' + batches.length + ' 批'];
      throw err;
    }
    for (const x of part) rows.push(...x.rows);
  }
  return { rows, tried: ['sina ' + batches.length + ' 批 / ' + rows.length + ' 只 / ' + (Date.now() - t0) + 'ms'] };
}

/** 纯聚合：一次遍历出 c / b / n / amt，再排一次出 p5。
 *  不建中间对象、不 split、不写正则——5200 只要压在几毫秒里。
 *  返回 day 是这批数据归属的交易日（按 f124 取众数），调用方拿它跟今天比对。 */
function aggLive(rows) {
  const NI = MKT_IND_NAMES.length;
  const indAmt = new Float64Array(NI);
  const amts = new Float64Array(rows.length);
  // f124 只会落在少数几天里（活跃股今天、停牌股停牌前），用 8 格线性表数众数
  const dayKey = [], dayCnt = [];
  let n = 0, up = 0, dn = 0, amt = 0, k = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const t = r.f124;
    if (t > 0) {
      const dk = Math.floor((t + 8 * 3600) / 86400);
      const at = dayKey.indexOf(dk);
      if (at >= 0) dayCnt[at]++;
      else if (dayKey.length < 8) { dayKey.push(dk); dayCnt.push(1); }
    }
    const a = +r.f6;
    // 停牌、未上市、当日无成交：不进 n、不进成交额、不进 p5 分母
    if (!(a > 0)) continue;
    n++; amt += a; amts[k++] = a;
    const p = +r.f3;                       // fltt=2 时停牌给 '-'，转成 NaN，两边都不计
    if (p > 0) up++; else if (p < 0) dn++;
    const ix = MKT_IND_OF[r.f12];          // 没有三级归属的只进分母，与历史口径一致
    if (ix != null) indAmt[ix] += a;
  }
  if (!n) return null;

  // 众数日：取计数最大的那格
  let best = -1, bc = 0;
  for (let i = 0; i < dayKey.length; i++) if (dayCnt[i] > bc) { bc = dayCnt[i]; best = dayKey[i]; }
  const day = best < 0 ? '' : new Date(best * 86400e3).toISOString().slice(0, 10);

  // TOP3 一次遍历：不排序 244 个数，只维护三个槽
  let i0 = -1, i1 = -1, i2 = -1, v0 = 0, v1 = 0, v2 = 0;
  for (let i = 0; i < NI; i++) {
    const v = indAmt[i];
    if (v <= 0) continue;
    if (v > v0) { v2 = v1; i2 = i1; v1 = v0; i1 = i0; v0 = v; i0 = i; }
    else if (v > v1) { v2 = v1; i2 = i1; v1 = v; i1 = i; }
    else if (v > v2) { v2 = v; i2 = i; }
  }
  const top3 = [i0, i1, i2].filter((x) => x >= 0).map((x) => MKT_IND_NAMES[x]);

  // 前 5% 个股成交额占比。typed array 的 sort 是纯数值排序，比普通数组快一个量级
  const sub = amts.subarray(0, k).sort();
  let cut = Math.max(1, Math.round(k * 0.05)), tail = 0;
  for (let i = k - cut; i < k; i++) tail += sub[i];

  return {
    day,
    c: amt > 0 ? (v0 + v1 + v2) / amt * 100 : 0,
    b: (up + dn) > 0 ? up / (up + dn) * 100 : 0,
    u: up, w: dn, n,
    amt: Math.round(amt / 1e8),
    p5: amt > 0 ? tail / amt * 100 : 0,
    top3,
  };
}

/** live 值 + 历史序列。历史里若已经有今天（管线提前跑过），切掉尾巴，
 *  否则散点会在同一个位置叠两层点。 */
function mktLiveOut(live, base) {
  let hist = null;
  if (base && Array.isArray(base.d) && base.d.length >= 60) {
    hist = { d: base.d, c: base.c, b: base.b, n: base.n, u: base.u, w: base.w, a: base.a,
      t3: base.t3 || [], t: base.t, ind: base.ind, p5: base.p5, cVer: base.cVer || '' };
    if (hist.d.length && hist.d[hist.d.length - 1] === live.day) {
      for (const k of ['d', 'c', 'b', 'n', 'u', 'w', 'a', 'p5', 't']) {
        if (Array.isArray(hist[k])) hist[k] = hist[k].slice(0, -1);
      }
      hist.t3 = live.top3;
    }
  }
  return {
    ok: true, mode: 'live', d: live.day, asOf: live.day, snapAt: live.hhmm,
    // 保留两位：JSON 里挂一串 21.212649572002377 既难看又白占字节
    cVer: MKT_CVER, c: +live.c.toFixed(2), b: +live.b.toFixed(2),
    stockUp: live.u, stockDn: live.w, stockN: live.u + live.w,
    n: live.n, p5: +live.p5.toFixed(2), amt: live.amt, top3: live.top3,
    inds: MKT_IND_NAMES.length, src: 'em', hist,
  };
}

/* ---------------------------------------------------------------- 行业成分股
   卡片上「钱压在集成电路、电子元件、通信传输设备上」只是三个名字，回答不了
   「这 21% 是哪几只票堆出来的」。点开就要看到名单，而且要带当日涨跌和成交额——
   只给代码和简称，等于让人自己去一只只查。

   一个行业最多 224 只（汽车零部件），中位只有 11 只，一次新浪批量就拉完
   （实测 700 只 1.4 秒），不必走全 A 那条 8 批的路。所以这里是「按需现拉」，
   而不是从 /api/mkt 的快照里切：好处是点哪个行业都只要一次子请求，
   不受「刚才有没有人刷过全 A」的时序影响。

   30 秒桶缓存，与 /api/mkt 同频：两张界面上的数字是同一时刻的。
*/
async function serveInd(q, ctx) {
  const NI = MKT_IND_NAMES.length;
  // 行业名里带「其他」「Ⅱ」这类字符，前端必须 encodeURIComponent 后再传
  let i = -1;
  if (/^[0-9]+$/.test(q)) i = +q;
  else i = MKT_IND_NAMES.indexOf(q);
  if (!(i >= 0 && i < NI)) return json({ ok: false, code: 'NO_IND', error: '没有这个行业：' + q });

  const codes = MKT_IND_MEM[i] || [];
  if (!codes.length) return json({ ok: false, code: 'EMPTY_IND', error: '这个行业没有成分股' });

  const bucket = Math.floor(Date.now() / 30000);
  const key = new Request('https://etf-board.internal/ind/v1/' + i + '/' + bucket, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
  }

  // 一次批量就够了，但仍重试一次：新浪偶发空回，重试比让用户再点一次便宜
  let got = null;
  for (let k = 0; k < 2 && !got; k++) {
    got = await mktSinaBatch(codes).catch(() => null);
    if (got && !got.rows.length) got = null;
  }
  if (!got) return json({ ok: false, code: 'UPSTREAM', error: '上游没返回，稍后再点一次' });

  let amt = 0, wsum = 0, up = 0, dn = 0, flat = 0, halt = 0;
  const mem = [];
  for (const r of got.rows) {
    const a = +r.f6 || 0;                 // 元
    const p = +r.f3;
    // 停牌 / 当日没成交：不给涨跌幅（0.00% 会被读成「平盘」，那是另一件事）
    if (!(a > 0) || !isFinite(p)) {
      halt++;
      mem.push({ c: r.f12, n: MKT_STK_NAME[r.f12] || '', p: null, px: 0, a: 0 });
      continue;
    }
    amt += a;
    if (p > 0) up++; else if (p < 0) dn++; else flat++;
    wsum += p * a;                        // 成交额加权：小票拉不动指数，也不该拉动这个数
    mem.push({ c: r.f12, n: MKT_STK_NAME[r.f12] || '', p: +p.toFixed(2), px: +r.f2 || 0, a });
  }
  // 成交额降序：看「这个行业的钱集中在谁身上」时，第一屏就该是答案
  mem.sort((x, y) => y.a - x.a);
  for (const m of mem) m.a = +(m.a / 1e8).toFixed(2);

  const out = {
    ok: true,
    ind: MKT_IND_NAMES[i], i, n: codes.length, day: got.day,
    amt: +(amt / 1e8).toFixed(1),
    pct: amt > 0 ? +(wsum / amt).toFixed(2) : null,
    up, dn, flat, halt,
    mem,
  };
  const res = json(out, 30);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(cache.put(key, res.clone())); } catch (e) { /* 写缓存失败不影响响应 */ }
  }
  return res;
}

let _mktLiveAt = 0;
let _mktLiveSig = '';

async function serveMkt(env, ctx) {
  const clock = mktClock();
  const base = await mktBase(env);

  // 静态已经是最新（管线跑完之后），不必再打上游
  const baseDay = base && base.d.length ? base.d[base.d.length - 1] : '';
  if (!base || baseDay === clock.day) return serveMktStatic(env, ctx);
  if (clock.phase === 'closed') return serveMktStatic(env, ctx);

  const ttl = clock.phase === 'live' ? 30 : 120;
  const cache = await getCache();
  // 日期进键：跨日不会读到昨天那份
  const key = new Request('https://etf-board.internal/mkt/live/v3/' + clock.day, { method: 'GET' });
  const failKey = new Request('https://etf-board.internal/mkt/fail/v3/' + clock.day, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败不影响主流程 */ }
    /* 刚断过就 20 秒内别再打。两个域名各等 6 秒，一轮 12 秒——不记这一笔，
       盘中页面每个请求都要白等 12 秒才拿到昨天的数，比不实时更难受。 */
    try {
      if (await cache.match(failKey)) return serveMktStatic(env, ctx, '刚刚失败过');
    } catch (e) { /* 忽略 */ }
  }
  const noteFail = () => {
    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(failKey,
        new Response('1', { headers: { 'Cache-Control': 'max-age=20' } })).catch(() => {}));
    }
  };

  let live = null, err = '';
  try {
    const got = await fetchAAll();
    const agg = aggLive(got.rows);
    if (!agg) err = '无有效成交';
    else if (agg.day !== clock.day) err = '数据归属 ' + agg.day + '，不是今天（休市？）';
    else if (agg.n < 1500) err = '有效成交只有 ' + agg.n + ' 只（集合竞价？）';
    else { agg.hhmm = clock.hhmm; live = agg; }
  } catch (e) {
    err = String((e && e.message) || e);
  }

  if (live) {
    const out = mktLiveOut(live, base);
    const res = json(out, ttl);
    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    }
    /* 留一份盘中快照。断连时给「几分钟前的盘中值」，比退回昨天收盘强——
       但写入要节制：5 分钟一次、值真变了才写。 */
    const sig = [live.day, live.c, live.b, live.amt].join('|');
    if (env && env.WATCH && sig !== _mktLiveSig
      && Date.now() - _mktLiveAt >= MKT_LIVE_GAP && kvWriteAllowed('mkt-live')) {
      _mktLiveAt = Date.now();
      _mktLiveSig = sig;
      const keep = { ...out };
      delete keep.hist;                    // 快照只要数字，30KB 的历史没必要跟着写
      const put = env.WATCH.put(MKT_LIVE_KEY, JSON.stringify(keep), { expirationTtl: 259200 });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.resolve(put).catch(() => {}));
      else await put.catch(() => {});
    }
    return res;
  }

  // 上游不给：先给最近一次盘中快照，再给静态
  noteFail();
  try {
    if (env && env.WATCH) {
      const raw = await env.WATCH.get(MKT_LIVE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.d === clock.day && s.c > 0) {
          return json({ ...s, ok: true, mode: 'snap', src: 'kv', note: err }, 20);
        }
      }
    }
  } catch (e) { /* KV 也读不到，往下走静态 */ }
  return serveMktStatic(env, ctx, err);
}

/** 盘中这条链唯一的诊断口。上线后先打 ?t=raw：它会顺带跑一遍聚合并计时，
 *  一次就能回答三个问题——CF 出口能不能连 push2delay、pz=6000 是否被接受、
 *  5200 只的聚合吃多少 CPU。 */
async function serveMktProbe(url, env) {
  const t = url.searchParams.get('t') || 'raw';
  const clock = mktClock();

  if (t === 'kv') {
    let snap = null;
    try {
      if (env && env.WATCH) snap = JSON.parse((await env.WATCH.get(MKT_LIVE_KEY)) || 'null');
    } catch (e) { /* 忽略 */ }
    return json({ ok: true, t, clock, snap });
  }

  /* 摸清 clist 到底能一次要多少：线上两个域都回 502，得知道是 pz 太大还是
     这个 fs（全市场四段）本身被拒。单板块 + 递增 pz 是最小成本的切分。 */
  if (t === 'matrix') {
    const one = async (host, fs, pz) => {
      const t0 = Date.now();
      try {
        const a = await mktClist(host, fs, pz);
        return { host, fs: fs.length > 20 ? 'ALL' : fs, pz, rows: a.rows.length,
          total: a.total, ms: Date.now() - t0 };
      } catch (e) {
        return { host, fs: fs.length > 20 ? 'ALL' : fs, pz, error: String((e && e.message) || e).slice(0, 60),
          ms: Date.now() - t0 };
      }
    };
    const out = [];
    for (const pz of [100, 500, 1000, 3000, 6000]) out.push(await one('push2delay', 'm:1+t:2', pz));
    out.push(await one('push2delay', MKT_FS_ALL, 100));
    out.push(await one('push2', 'm:1+t:2', 1000));
    return json({ ok: true, t, clock, list: out });
  }

  /* clist 的 pz 被硬卡在 100（matrix 实测 pz=6000 也只回 100，而且直接 502）。
     5564 只按 100 翻页要 56 个子请求，免费版 50 就爆了。ulist 一次能带一批
     secid，代码表本来就在 MKT_IND_OF 里——看一批能塞多少只。 */
  if (t === 'ulist') {
    const n = +(url.searchParams.get('n') || 500);
    const codes = Object.keys(MKT_IND_OF).slice(0, n);
    const secids = codes.map((c) => (c[0] === '6' ? '1.' : '0.') + c);
    const t0 = Date.now();
    try {
      const rows = await emUlist(secids, 'f12,f3,f6,f124', 9000);
      const t1 = Date.now();
      const agg = aggLive(rows);
      return json({ ok: true, t, n, got: rows.length, ms: t1 - t0,
        urlLen: secids.join(',').length, dayMatch: !!(agg && agg.day === clock.day),
        agg: agg && { day: agg.day, c: +agg.c.toFixed(2), b: +agg.b.toFixed(2),
          n: agg.n, amt: agg.amt, top3: agg.top3 } });
    } catch (e) {
      return json({ ok: false, t, n, error: String((e && e.message) || e).slice(0, 120),
        ms: Date.now() - t0 });
    }
  }

  /* 只打 push2delay、不重试、单次计时：上面那次 500 只要 11.6 秒，
     得知道是上游本身慢，还是 emUlist 先试 push2 白等了两轮 8 秒超时。 */
  if (t === 'ulist2') {
    const out = [];
    for (const n of [300, 500, 600, 800]) {
      const codes = Object.keys(MKT_IND_OF).slice(0, n);
      const q = codes.map((c) => (c[0] === '6' ? '1.' : '0.') + c).join(',');
      const t0 = Date.now();
      try {
        const r = await fetch('https://push2delay.eastmoney.com/api/qt/ulist.np/get'
          + '?fltt=2&invt=2&fields=f12,f3,f6,f124&secids=' + q, {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          signal: AbortSignal.timeout(9000),
        });
        const j = await r.json();
        const d = (j && j.data && j.data.diff) || [];
        const arr = Array.isArray(d) ? d : Object.values(d);
        out.push({ n, urlLen: q.length, status: r.status, got: arr.length, ms: Date.now() - t0 });
      } catch (e) {
        out.push({ n, urlLen: q.length, error: String((e && e.message) || e).slice(0, 60), ms: Date.now() - t0 });
      }
    }
    return json({ ok: true, t, clock, list: out });
  }

  /* 把 serveMkt 的前半段拆开逐步计时：线上 /api/mkt 一直落 close，
     而 raw 探针同样的 fetchAAll 是通的，差别只在前面多读了一次 mktBase。 */
  if (t === 'live') {
    const out = {};
    const t0 = Date.now();
    const base = await mktBase(env);
    out.baseMs = Date.now() - t0;
    out.baseDay = base && base.d.length ? base.d[base.d.length - 1] : '';
    const t1 = Date.now();
    try {
      const got = await fetchAAll();
      out.fetchMs = Date.now() - t1;
      out.rows = got.rows.length;
      const agg = aggLive(got.rows);
      out.agg = agg && { day: agg.day, c: +agg.c.toFixed(2), b: +agg.b.toFixed(2),
        n: agg.n, amt: agg.amt };
      out.dayMatch = !!(agg && agg.day === clock.day);
      out.live = !!(agg && agg.day === clock.day && agg.n >= 1500);
    } catch (e) {
      out.fetchMs = Date.now() - t1;
      out.error = String((e && e.message) || e);
      out.tried = e.tried || null;
    }
    return json({ ok: true, t, clock, ...out });
  }

  /* 东财 ulist 连打会被限流（第 1 组三次全 502）。新浪 hq 批量是老接口，
     一次能带七八百只、返回纯文本，全网行情软件都在用，限流宽得多。
     只需 昨收/现价/成交额/日期 四个位置，中文名乱码无所谓（GBK 双字节
     不会落在 0x2C 逗号和 0x22 引号上，分隔符安全）。 */
  if (t === 'sina') {
    const n = +(url.searchParams.get('n') || 700);
    const codes = Object.keys(MKT_IND_OF).slice(0, n);
    const q = codes.map((c) => (c[0] === '6' ? 'sh' : 'sz') + c).join(',');
    const t0 = Date.now();
    try {
      const r = await fetch('https://hq.sinajs.cn/list=' + q, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
        signal: AbortSignal.timeout(8000),
      });
      const buf = await r.arrayBuffer();
      const t1 = Date.now();
      const txt = new TextDecoder('utf-8').decode(buf);
      let cnt = 0, amt = 0, first = '';
      const re = /hq_str_(?:sh|sz)(\d{6})="([^"]*)"/g;
      let m;
      while ((m = re.exec(txt))) {
        const f = m[2].split(',');
        if (f.length < 32) continue;
        if (!first && /^\d{4}-\d{2}-\d{2}$/.test(f[30])) first = f[30];
        cnt++;
        amt += +f[9] || 0;
      }
      return json({ ok: true, t, n, urlLen: ('https://hq.sinajs.cn/list=' + q).length,
        status: r.status, bytes: buf.byteLength, lines: cnt, day: first,
        amt: Math.round(amt / 1e8), fetchMs: t1 - t0, parseMs: Date.now() - t1 });
    } catch (e) {
      return json({ ok: false, t, n, error: String((e && e.message) || e).slice(0, 100),
        ms: Date.now() - t0 });
    }
  }

  if (t === 'clist') {
    const fs = url.searchParams.get('fs') || MKT_FS_ALL;
    const pz = +(url.searchParams.get('pz') || 6000);
    const host = url.searchParams.get('host') || 'push2delay';
    const t0 = Date.now();
    try {
      const a = await mktClist(host, fs, pz);
      const t1 = Date.now();
      const agg = aggLive(a.rows);
      return json({ ok: true, t, host, fs, pz, rows: a.rows.length, total: a.total,
        fetchMs: t1 - t0, aggMs: Date.now() - t1,
        dayMatch: !!(agg && agg.day === clock.day),
        agg: agg && { day: agg.day, c: +agg.c.toFixed(2), b: +agg.b.toFixed(2),
          n: agg.n, amt: agg.amt, top3: agg.top3 } });
    } catch (e) {
      return json({ ok: false, t, host, fs, pz, error: String((e && e.message) || e).slice(0, 120),
        ms: Date.now() - t0 });
    }
  }

  if (t === 'agg') {
    const now = Math.floor(Date.now() / 1000);
    const fixture = [
      { f12: '600519', f3: 1.2, f6: 8.0e9, f124: now },
      { f12: '300750', f3: -2.5, f6: 4.0e9, f124: now },
      { f12: '000001', f3: 0, f6: 1.0e9, f124: now },
      { f12: '601318', f3: '-', f6: 0, f124: now - 86400 * 30 },   // 停牌样本
      { f12: '999999', f3: 3.0, f6: 2.0e9, f124: now },            // 映射里没有的代码
    ];
    const agg = aggLive(fixture);
    return json({ ok: true, t, clock, fixture: fixture.length, agg });
  }

  const t0 = Date.now();
  try {
    const got = await fetchAAll();
    const t1 = Date.now();
    const agg = aggLive(got.rows);
    return json({ ok: true, t, clock, ver: MKT_CVER, rows: got.rows.length, tried: got.tried,
      fetchMs: t1 - t0, aggMs: Date.now() - t1,
      dayMatch: !!(agg && agg.day === clock.day),
      agg: agg && { day: agg.day, c: +agg.c.toFixed(2), b: +agg.b.toFixed(2),
        n: agg.n, amt: agg.amt, top3: agg.top3 } });
  } catch (e) {
    return json({ ok: false, t, clock, ver: MKT_CVER, error: String((e && e.message) || e),
      tried: e.tried || null, ms: Date.now() - t0 });
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
/** 中金所只有 http 明文源。超时给到 8 秒、失败重试一次：从 Cloudflare 出口
 *  打国内 http 站点时快时慢，4.5 秒卡掉一个 quote 文件就是整个品种消失
 *  （2026-11-10 线上就出现 16 个合约只剩 12 个，缺的正是某一个品种）。 */
async function fetchCffex(path) {
  const u = 'http://www.cffex.com.cn/' + path;
  let lastErr = null;
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, Referer: 'http://www.cffex.com.cn/' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (k === 0) await new Promise((res) => setTimeout(res, 700));
    }
  }
  throw lastErr;
}

/* 中金所那七个 quote_*.txt 有个脾气：**并发打就挂**。
   2026-11-12 实测，futprobe 串行跑 IO/MO/HO 全 200（各 55~62ms），
   而 serveFut 里 4 个期货 + 3 个期权一起 Promise.all 发出去，三个期权全超时，
   页面就只剩「期权链没读到」。所以在这里排一条队：一次只发一个，间隔 90ms。
   七个文件串起来约 1 秒，相对 55 秒的缓存不算什么。 */
let _cffexChain = Promise.resolve();
function fetchCffexQueued(path) {
  const run = () => fetchCffex(path);
  const p = _cffexChain.then(run, run);
  _cffexChain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 90)));
  return p;
}

/** 新浪股指期货报价：秒级快照，一次请求拿全部合约。
 *
 *  为什么要它当地主源：中金所的 quote_*.txt 是分钟级才刷一次的。
 *  2026-11-10 盘中实测 —— 14:35:40 之后四个品种的 Last-Modified 一起停住，
 *  到 14:39 都没再动；而同一时刻新浪的 IF2611 已经走到 4055.60、成交量比
 *  中金所文件里的多 1000 多手。期货价停着、现货价（东财）一直在动，两者相减
 *  出来的基差率就会「自己漂」——看着像贴水在修复，其实只是沪深 300 在走，
 *  期货那半截根本没跟上。Δ基差率要能读，这一头必须是秒级的。
 *
 *  字段（nf_ 前缀，GBK 编码，但我们只用 ASCII 数字）按 0 基取：
 *    3 最新价 · 4 成交量 · 6 持仓量 · 13 昨收盘 · 14 昨结算
 *  涨跌基准取昨结算，和中金所 CSV 里 updown 的口径一致，换源前后「涨跌」
 *  这一列可直接对比。校验办法：涨停价 ÷ 1.1 = 昨结算
 *  （IF2612 4432.6 / 1.1 = 4029.8，正好是 a[14]；a[13] 的 4023.6 是昨收盘）。
 *
 *  持仓量同为中金所原值（双边合计），所以四象限的阈值不用改。
 */
async function fetchSinaFut(codes) {
  if (!codes || !codes.length) return {};
  const r = await fetch('https://hq.sinajs.cn/list=' + codes.map((x) => 'nf_' + x).join(','), {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('sina HTTP ' + r.status);
  const text = new TextDecoder('gbk').decode(await r.arrayBuffer());
  const out = {};
  const re = /var hq_str_nf_([A-Z]{2}\d{4})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const a = m[2].split(',');
    if (a.length < 16) continue;                      // 空串 = 该合约没在交易
    const px = +a[3];
    if (!(px > 0)) continue;
    const pc = +a[14];                                // 昨结算
    out[m[1]] = {
      px,
      chg: pc > 0 ? +((px - pc) / pc * 100).toFixed(2) : 0,
      vol: +a[4] || 0,
      oi: +a[6] || 0,
      t: a[37] || '',                                 // 报价时间 HH:MM:SS
    };
  }
  return out;
}

/** 东财 ulist.np 批量报价。主域偶发 502（2026-11-10 线上撞了两次，一次把指数
 *  现货整批打空、期指四张表的基差全成 null），所以主域/延迟子域各试两次再放弃。 */
async function emUlist(secids, fields, toMs) {
  const qs = secids.join(',');
  const ms = toMs || 8000;
  const hosts = ['push2.eastmoney.com', 'push2delay.eastmoney.com'];
  let lastErr = null;
  for (const h of hosts) {
    const u = 'https://' + h + '/api/qt/ulist.np/get?fltt=2&invt=2&secids=' + qs
      + '&fields=' + fields;
    for (let k = 0; k < 2; k++) {
      try {
        const r = await fetch(u, {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          signal: AbortSignal.timeout(ms),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const diff = (j && j.data && j.data.diff) || [];
        const arr = Array.isArray(diff) ? diff : Object.values(diff);
        if (arr.length) return arr;
        throw new Error('空数据');
      } catch (e) {
        lastErr = e;
        if (k === 0) await new Promise((res) => setTimeout(res, 350));
      }
    }
  }
  throw new Error(String((lastErr && lastErr.message) || lastErr) + '（两个域名都试过）');
}

/** 四个现货指数（沪深300/中证500/上证50/中证1000）。
 *
 *  东财 ulist 作主源，但它对同一出口的短时连打会整批断连（实测两个域名都
 *  fetch failed，重试无效）。基差是「期货 − 现货」，现货整批缺失就等于四张
 *  期指表的基差、基差率、年化同时变 null，而期货价照常显示——看着像算不出来。
 *  所以换厂商兜两级：腾讯 qt.gtimg 与新浪 s_ 简版，两者都不依赖东财。
 *  涨跌幅一律「现价 ÷ 昨收」自算，不赌上游字段下标。 */
async function fetchSpotIdx() {
  const out = {};
  const take = (code, p, chg) => {
    if (code && p > 0 && !out[code]) out[code] = { p, chg: +(+chg || 0).toFixed(2) };
  };

  /* 东财这一档只给 2.8 秒总预算：它内部是「两域名 × 两次重试」，遇 502 挂起时
     全跑完要十几秒，而备源才是能出数的那一档。超时就走腾讯，不等它。 */
  try {
    const emP = emUlist(FUT_SPOT_ID.split(','), 'f2,f3,f12,f14', 2200).catch(() => null);
    const arr = await Promise.race([
      emP,
      new Promise((res) => setTimeout(() => res(null), 2800)),
    ]);
    if (arr) for (const x of arr) take(String(x.f12 || ''), +x.f2, +x.f3);
  } catch (e) { /* 换厂商 */ }
  if (Object.keys(out).length >= 4) return out;

  const codes = FUT_SPOT_ID.split(',').map((s) => s.split('.')[1]).filter(Boolean);

  // 腾讯：88 字段版本，f[3] 现价、f[4] 昨收
  try {
    const r = await fetch('https://qt.gtimg.cn/q=' + codes.map((c) => 'sh' + c).join(','), {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
      for (const line of txt.split('\n')) {
        const m = /v_sh(\d{6})="([^"]*)"/.exec(line.trim());
        if (!m) continue;
        const f = m[2].split('~');
        const p = +f[3], pc = +f[4];
        if (p > 0 && pc > 0) take(m[1], p, (p / pc - 1) * 100);
      }
    }
  } catch (e) { /* 再换新浪 */ }
  if (Object.keys(out).length >= 4) return out;

  // 新浪简版：名称,现价,涨跌额,涨跌幅,成交量,成交额
  try {
    const r = await fetch('https://hq.sinajs.cn/list=' + codes.map((c) => 's_sh' + c).join(','), {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
      for (const line of txt.split('\n')) {
        const m = /hq_str_s_sh(\d{6})="([^"]*)"/.exec(line.trim());
        if (!m) continue;
        const a = m[2].split(',');
        if (a.length < 4) continue;
        take(m[1], +a[1], +a[3]);
      }
    }
  } catch (e) { /* 三档都挂，交给调用方退日档 */ }

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

/** 期权 Δ 的基准表：上一交易日的合成基差率。
 *
 *  两种取法，取决于日档停在哪天：
 *   - 日档停在昨天（盘中）→ last.opt 就是那份，直接按「品种|月份」建索引；
 *   - 日档已追平今天（16:35 之后）→ last.opt 是今天自己，减出来恒等于 0，
 *     改读 pipeline 存下的 optPrev（前一交易日映射）。
 *  两样都没有就返回空表，调用方据此撤掉 Δ 那一列——空着好过摆一排 0。
 *
 *  byCode 是给 ETF 期权用的「第几档」序列：它的档位按剩余天数排，今天 8 天、
 *  昨天 9 天，键对不上但合约没变，只能按顺序对。 */
function optBaseFromLast(last, td) {
  const byKey = {};
  const byCode = {};
  let baseTd = null;
  if (!last) return { byKey, byCode, baseTd };

  if (last.td !== td && Array.isArray(last.opt)) {
    baseTd = last.td;
    for (const o of last.opt) {
      if (o.bp == null) continue;
      byKey[o.p + '|' + o.m] = o.bp;
      (byCode[o.p] = byCode[o.p] || []).push(o.bp);
    }
    // day.opt 是排好序写的（同品种按 dte 升序），push 顺序即档位顺序
  } else if (last.optPrev && typeof last.optPrev === 'object') {
    baseTd = last.optPrevTd || null;
    for (const p of Object.keys(last.optPrev)) {
      const g = last.optPrev[p];
      if (!g || typeof g !== 'object') continue;
      byCode[p] = [];
      for (const m of Object.keys(g)) {
        if (g[m] == null) continue;
        byKey[p + '|' + m] = g[m];
        byCode[p].push(g[m]);
      }
    }
  }
  return { byKey, byCode, baseTd };
}

/** 盘中实时：期货 + 现货 + 股指期权，55 秒边缘缓存。
 *  期货全挂时才退到 fut_last.json（收盘日档），并把 stale 标出来——宁可显示
 *  「昨天收盘 + 日期」，也不要让整块卡片消失。 */
async function serveFut(env, ctx) {
  const now = Date.now();
  if (FUT_L1.body && now - FUT_L1.ts < FUT_TTL * 1000) return json(FUT_L1.body, 45);

  const cache = await getCache();
  // v3：期货价从中金所换到新浪，旧缓存里的 px 是中金所那份分钟级的，别让它再活一次
  const key = new Request('https://etf.internal/fut/v3/live', { method: 'GET' });
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
  // 三路并发：现货是东财，期货是中金所清单 + 新浪价，期权仍是中金所。
  // 串起来等会多一个 RTT，而这三者互不依赖。
  const spotP = fetchSpotIdx().catch(() => null);
  const futP = Promise.all(FUT_PRODS.map((p) => fetchCffexQueued('quote_' + p + '.txt')
    .then((t) => ({ p, rows: parseFutCsv(t, p) }))
    .catch(() => ({ p, rows: null }))));
  const optP = Promise.all(OPT_PRODS.map((p) => fetchCffexQueued('quote_' + p + '.txt')
    .then((t) => ({ p, rows: parseOptCsv(t, p) }))
    .catch(() => ({ p, rows: null }))));

  const [spot, futRes, optRes] = await Promise.all([spotP, futP, optP]);
  const spotOk = spot && Object.keys(spot).length >= 3;

  /* 中金所的四个 quote 文件降级成「合约清单 + 兜底价」，价格一律改用新浪。
     理由见 fetchSinaFut 上面那段：中金所那份 txt 分钟级才刷一次，拿它配实时的
     现货指数，基差率会自己漂。中金所四个文件全挂时也不慌——用收盘日档里的
     合约清单去问新浪，照样出得了秒级价。 */
  const last = await loadFutLast(env);
  const slim = [];
  for (const { p, rows } of futRes) {
    if (rows) for (const r of rows) slim.push({ p, ...r });
  }
  // 单个品种挂掉（中金所偶尔只丢一个文件）时，用日档里该品种的合约清单补上，
  // 价格等会儿由新浪给。只有清单也补不出来才整块退回日档。
  const miss = FUT_PRODS.filter((p) => !slim.some((r) => r.p === p));
  if (miss.length && last && Array.isArray(last.fut)) {
    for (const f of last.fut) {
      if (miss.indexOf(f.p) < 0 || !f.c) continue;
      slim.push({ p: f.p, c: f.c, ym: String(f.c).slice(2, 6),
        px: f.px, chg: f.chg, vol: f.vol, oi: f.oi, fromDaily: 1 });
    }
  }
  if (!slim.length) {
    // 连清单都没有 → 整块退回收盘日档，标 stale 和日期，别装作是实时的
    if (last) {
      const out = { ...last, ok: true, src: 'daily', stale: 1, ts: now, asof: last.ts || now,
        age: Math.round((now - (last.ts || now)) / 1000), partial: ['fut'] };
      FUT_L1 = { ts: now, body: out };
      return json(out, 15);
    }
    return json({ ok: false, error: 'cffex_unreachable', ts: now, partial: ['fut'] }, 15);
  }

  let sina = {};
  try { sina = await fetchSinaFut(slim.map((r) => r.c)); } catch (e) { sina = {}; }
  let nSina = 0;
  const fresh = {};
  for (const r of slim) {
    const s = sina[r.c];
    if (!s) continue;
    r.px = s.px; r.chg = s.chg; r.vol = s.vol; r.oi = s.oi;
    fresh[r.c] = 1;
    nSina++;
  }
  const src = nSina ? 'sina' : 'cffex';

  /* 昨收基准：持仓量变化要它、基差率变化也要它。
     原先只在 last.td !== td 时用 last.fut，于是日档一追平今天（16:35 之后）
     就整表没有增减仓——恰恰是收盘后最该看完整一天变化的时候。
     现在快照里多带一份 prev（上一交易日的 code→{oi,bp}），两种情况都能接上。 */
  const td = futDataDate(last);
  const prev = {};
  let prevTd = null;
  if (last && last.td) {
    if (last.td !== td && Array.isArray(last.fut)) {
      for (const f of last.fut) prev[f.c] = { oi: f.oi, bp: f.bp };
      prevTd = last.td;
    } else if (last.prev && typeof last.prev === 'object') {
      Object.assign(prev, last.prev);
      // 老快照没这个字段，拿不到就不显示——总比瞎猜一个日期强
      prevTd = last.prevTd || null;
    }
  }
  // 昨收持仓只对「昨天那份」有意义；但会员多空是收盘结算值，当天那份就是最新的，
  // 不该因为「td 相同」而丢掉——否则收盘后整张多空表永远是空的
  const posPrev = last && last.pos ? last.pos : null;

  /* 期权合成基差的 Δ 基准：同品种同月份、上一交易日的合成基差率。
     盘中日档停在昨天，last.opt 正好是那份；收盘后（16:35 之后）日档追平今天，
     last.opt 就变成今天自己，减出来恒等于 0——这时改读 pipeline 存下的 optPrev。
     两样都没有就不给，宁可这一列撤掉，也不摆一排 0。 */
  const optB = optBaseFromLast(last, td);
  const optBase = optB.byKey;
  const optBaseTd = optB.baseTd;

  const futOut = [];
  const futPxByProd = {};
  for (const p of FUT_PRODS) {
    const rows = slim.filter((r) => r.p === p);
    if (!rows.length) { partial.push(p); continue; }
    const S = FUT_MAP[p];
    const sp = spotOk ? spot[S] : null;
    futPxByProd[p] = {};
    const tmp = [];
    for (const r of rows) {
      // 从日档补进来的合约，如果新浪也没报价，宁可这一行不显示——把昨天的价
      // 当今天的盘中价摆上去，比缺一行难查得多
      if (r.fromDaily && !fresh[r.c]) continue;
      futPxByProd[p][r.ym] = r.px;
      const basis = sp ? r.px - sp.p : null;
      const bp = sp ? basis / sp.p * 100 : null;
      const dte = dteOf(r.ym);
      const pv = prev[r.c] || {};
      const oiD = pv.oi != null ? r.oi - pv.oi : null;
      // 基差率变化：单位是百分点，和 bp 同量纲。盘中每分钟刷一次，
      // 盯着这列能看出贴水是在扩大还是修复，比看绝对值直接。
      const bpc = (pv.bp != null && bp != null) ? +(bp - pv.bp).toFixed(3) : null;
      tmp.push({
        c: r.c, p, u: S, px: r.px, chg: r.chg, vol: r.vol, oi: r.oi, oiD, bpc,
        dte, exp: expOf(r.ym),
        basis: sp ? +basis.toFixed(2) : null,
        bp: sp ? +bp.toFixed(3) : null,
        ann: sp && dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
        q: quadOf(oiD, r.chg, r.oi),
      });
    }
    if (!tmp.length) { partial.push(p); continue; }
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
      const base = optBase[p + '|' + o.m];
      optOut.push({ p, u: S, ...o,
        bpc: (base != null && o.bp != null) ? +(o.bp - base).toFixed(3) : null });
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

  /* 中金所那三份 quote_*.txt 在盘前和盘中偶发整段超时（8 秒 ×2 次重试也会挂），
     期权一空，前端就只剩「期权链没读到」四个字。期货有新浪做秒级兜底，期权链没有
     第二源（东财对云 IP 只回昨收，见 gen_etfopt 那段），所以退到日档里上一交易日
     收盘算好的合成基差——旧的比空白强，optDaily 带上日期，前端会标出来。 */
  let optFinal = optOut;
  let optDaily = 0;
  if (!optOut.length && last && Array.isArray(last.opt) && last.opt.length) {
    optFinal = last.opt;
    optDaily = optFinal.length;
    if (partial.indexOf('opt') < 0) partial.push('opt');
  }

  const out = {
    ok: true, ts: now, td, src, stale: 0,
    asof: now, age: 0, partial,
    // 昨收基准到底是哪天的。td 是「当前交易日」，prevTd 是「拿来做 Δ 的那天的收盘」。
    // 两者之间隔了几个交易日，就等于 Δ基差率跨了几天——任务被排到次日凌晨、
    // 日档慢一天时，这里会自己显示成两天，不用等用户觉得数字不对再回头查。
    prevTd,
    // 期权那条 Δ 用哪天的收盘当基准。和 prevTd 通常同一天，但日档只到昨天、
    // 期货那边可能已经用上 prev 里的存值，两个日期不一定同步，各标各的。
    optBaseTd,
    lastTd: (last && last.td) || null,
    spot: spotOk ? spot : {},
    fut: futOut,
    opt: optFinal,
    optDaily,
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
    // 深交所 2022-09-19 那批三个（创业板 / 中证500 / 深100）里漏了一个，补上
    ['0.159901', '159901', '深100ETF'],
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

/** 新浪批量期权快照。一批 100 个代码（再长 URL 会超），返回 Map<code, 行>。
 *  新浪这一条是 GBK，而 Workers 的 TextDecoder 只有 utf-8——中文字节会解成替换字符，
 *  但价格/行权价/到期日全是 ASCII，按逗号切分的下标不受影响，名称本来也不用（用东财的）。
 *  字段位：1 最新价 5 成交量 7 行权价 10 IV 41 持仓量 45 购沽 46 到期日 47 剩余自然日 */
async function fetchSinaOpts(codes) {
  const out = new Map();
  if (!codes.length) return out;
  const BATCH = 100;
  const jobs = [];
  for (let i = 0; i < codes.length; i += BATCH) jobs.push(codes.slice(i, i + BATCH));
  await Promise.all(jobs.map(async (seg) => {
    const u = 'https://hq.sinajs.cn/list=' + seg.map((c) => 'CON_OP_' + c).join(',');
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'https://stock.finance.sina.com.cn/' },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    for (const line of txt.split('\n')) {
      const m = line.match(/hq_str_CON_OP_(\d+)="([^"]*)"/);
      if (!m || !m[2]) continue;
      const f = m[2].split(',');
      const px = +f[1];
      const k = +f[7];
      const dte = +f[47];
      if (!(px > 0) || !(k > 0) || !(dte >= 0)) continue;
      out.set(m[1], {
        px, k, dte,
        side: f[45] === 'P' ? 'P' : 'C',
        exp: f[46] || '',
        vol: +f[5] || 0,
        oi: +f[41] || 0,
        iv: +f[10] || 0,
      });
    }
  }));
  return out;
}

/** 新浪现货快照。完整版格式：名称,今开,昨收,最新,最高,最低,…,日期,时间
 *  不用 s_ 简版：简版只有最新价和涨跌幅，没有行情日期，判不出这份价是哪天的 */
async function fetchSinaSpot(secids) {
  const syms = secids.map((s) => (s.slice(0, 1) === '1' ? 'sh' : 'sz') + s.slice(2));
  const r = await fetch('https://hq.sinajs.cn/list=' + syms.join(','), {
    headers: { 'User-Agent': UA, Referer: 'https://stock.finance.sina.com.cn/' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const txt = await r.text();
  const out = {};
  for (let i = 0; i < syms.length; i++) {
    const m = txt.match(new RegExp('hq_str_' + syms[i] + '="([^"]*)"'));
    if (!m || !m[1]) continue;
    const f = m[1].split(',');
    const p = +f[3];
    const p0 = +f[2];
    if (!(p > 0)) continue;
    out[secids[i].slice(2)] = {
      p, p0: p0 > 0 ? p0 : p,
      chg: p0 > 0 ? +(((p / p0) - 1) * 100).toFixed(2) : 0,
      d: f[30] || '',
    };
  }
  return out;
}

/** 腾讯 A 股/ETF 快照，字段位置是「1~名称~代码~现价~昨收~今开…」那一套。
 *  f[30] 是 YYYYMMDDHHMMSS，这里截成 YYYY-MM-DD，和下面新浪的 d 对齐——
 *  前端用它标「行情日期」，两种格式混着会显示成一串数字。 */
async function fetchTxSpot(secids) {
  const syms = secids.map((s) => (s.slice(0, 1) === '1' ? 'sh' : 'sz') + s.slice(2));
  const r = await fetch('https://qt.gtimg.cn/q=' + syms.join(','), {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error('腾讯现货 HTTP ' + r.status);
  const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
  const out = {};
  for (const line of txt.split('\n')) {
    const m = /v_(?:sh|sz)(\d{6})="([^"]*)"/.exec(line.trim());
    if (!m) continue;
    const f = m[2].split('~');
    const p = +f[3], p0 = +f[4];
    if (!(p > 0)) continue;
    const d = String(f[30] || '');
    out[m[1]] = {
      p, p0: p0 > 0 ? p0 : p,
      chg: p0 > 0 ? +(((p / p0) - 1) * 100).toFixed(2) : 0,
      d: d.length >= 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : '',
    };
  }
  return out;
}

/** ETF 期权标的的现价：新浪优先，缺的用腾讯补。
 *
 *  这张表以前只认新浪。新浪对数据中心出口会整段 403（本机实测全站 Forbidden），
 *  一挂就是「现货缺失」→ 九个标的全部跳过，整张表变「期权链取不到」。
 *  腾讯这条和美股同一个域名，稳定性好得多，缺多少补多少。 */
async function fetchEtfSpot(secids) {
  let out = {};
  try { out = await fetchSinaSpot(secids); } catch (e) { out = {}; }
  const miss = secids.filter((s) => !out[s.slice(2)]);
  if (miss.length) {
    try {
      const more = await fetchTxSpot(miss);
      for (const k of Object.keys(more)) if (!out[k]) out[k] = more[k];
    } catch (e) { /* 两家都挂，上层按「现货缺」处理 */ }
  }
  return Object.keys(out).length ? out : null;
}

/** 合约清单（代码/行权价/剩余日）。只有东财给这份东西，但它的价不用。
 *  合约一天只变一次（新挂/摘牌/换月），缓存 6 小时——稳态下每次请求就只剩新浪那几批。 */
async function fetchOptList(secid) {
  const ck = new Request('https://etf.internal/optlist/v1/' + secid, { method: 'GET' });
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) {
        const a = await hit.json();
        if (Array.isArray(a) && a.length) return a;
      }
    } catch (e) { /* 缓存读失败就回源 */ }
  }
  const out = [];
  for (const spt of [9, 10]) {
    const u = 'https://push2.eastmoney.com/api/qt/slist/get?spt=' + spt
      + '&fltt=2&invt=2&fields=f12,f161,f162'
      + '&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3';
    const j = await emJson(u, 8000);
    const d = (j && j.data && j.data.diff) || [];
    for (const x of (Array.isArray(d) ? d : Object.values(d))) {
      const code = String(x.f12 || '');
      const k = +x.f161;
      const dte = +x.f162;
      if (!code || !(k > 0) || !(dte >= 0)) continue;
      out.push({ code, k, dte });
    }
  }
  if (cache && out.length) {
    try {
      await cache.put(ck, new Response(JSON.stringify(out), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=21600' },
      }));
    } catch (e) { /* 写缓存失败不影响本次 */ }
  }
  return out;
}

/** 一条期权链（单边）。spt 9=购 10=沽，字段：f2 最新价 f5 成交量
 *  f12 代码 f14 名称 f108 持仓量 f152 购沽标记 f161 行权价 f162 剩余自然日
 *
 *  超时给到 8 秒：/api/optprobe 实测，同样这几个 URL 从 Cloudflare 出口要
 *  1.5~5.6 秒才回（延迟子域最快 1.5s，push2 主域 2.7~3.0s，82 子域 5.6s）。
 *  原先 3.5 秒，赶上慢的那次就整批 abort，八条链全 null，卡片一片空白——
 *  而接口本身是 200、diff 有 49 条，看起来像「东财不给数据」，其实是自己掐断的。 */
async function fetchOptChain(secid, spt) {
  const u = 'https://push2.eastmoney.com/api/qt/slist/get?spt=' + spt
    + '&fltt=2&invt=2&fields=f2,f5,f12,f14,f18,f108,f152,f161,f162'
    + '&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3';
  const j = await emJson(u, 8000);
  const diff = (j && j.data && j.data.diff) || [];
  const arr = Array.isArray(diff) ? diff : Object.values(diff);
  const out = [];
  // f2 是最新价、f18 是昨收。2026-11-10 实测：从 Cloudflare 出口拉这条链，
  // 49 条里最新价一条都不是数字（全是 '-'），昨收却有值——东财对海外出口只给昨收。
  // 两个价都留着，由调用方决定整只用哪一套：混着用会把合成期货算出 1.5% 的假贴水。
  for (const x of arr) {
    const k = +x.f161;
    const dte = +x.f162;
    if (!(k > 0) || !(dte >= 0)) continue;
    const p2 = +x.f2;
    const p18 = +x.f18;
    if (!(p2 > 0) && !(p18 > 0)) continue;
    out.push({ k, dte, p2: p2 > 0 ? p2 : 0, p18: p18 > 0 ? p18 : 0,
      vol: +x.f5 || 0, oi: +x.f108 || 0 });
  }
  return out;
}

/** 东财版的标的现价（ulist 一次批量）。只在 serveFutOptEm 那条老链路里用——
 *  那条链路本身就是「新浪一个价都没拿到」时的退路，拿东财的滞后价兜底。 */
async function fetchEtfSpotEm(secids) {
  const arr = await emUlist(secids, 'f2,f3,f12,f14,f18');
  const out = {};
  for (const x of arr) {
    const p = +x.f2;
    const p0 = +x.f18;
    if (p > 0 || p0 > 0) out[String(x.f12)] = { p, p0, chg: +(+x.f3 || 0).toFixed(2) };
  }
  return out;
}

/** 东财 + 腾讯混着取：东财能给就东财（带昨收），缺的补腾讯。
 *  serveFutOptEm 那条链路在新浪整站 403 时被调用，若东财也挂，上一版会「现货缺失」
 *  → 九个标的全跳过 → 整张表变「期权链取不到」，其实期权价那半截还好好的。 */
async function fetchEtfSpotAny(secids) {
  let out = {};
  try { out = await fetchEtfSpotEm(secids); } catch (e) { out = {}; }
  const miss = secids.filter((s) => !out[s.slice(2)]);
  if (miss.length) {
    try {
      const more = await fetchTxSpot(miss);
      for (const k of Object.keys(more)) if (!out[k]) out[k] = more[k];
    } catch (e) { /* 两家都挂，上层按「现货缺」处理 */ }
  }
  return Object.keys(out).length ? out : null;
}

/** ETF 期权按「第几档」对齐 Δ 基准：档位按剩余天数排，今天 8 天、昨天 9 天，
 *  键对不上但合约没变，所以只能按顺序对。档数不一致就不给——某一档今天没配出来
 *  时按索引对会整体错位，宁可空着。 */
function applyEtfBpc(months, code, optB) {
  const base = optB && optB.byCode && optB.byCode[code];
  if (!base || base.length !== months.length) return;
  for (let k = 0; k < months.length; k++) {
    months[k].bpc = (base[k] != null && months[k].bp != null)
      ? +(months[k].bp - base[k]).toFixed(3) : null;
  }
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
      if (!p) continue;
      // 看涨看跌平价：C − P ≈ S − K（远期要加上折现项，所以容差随 dte 放大）。
      // 买卖价差最多千分之几，超出这个范围的偏差只有一个解释——两边不是同一
      // 口径/同一天的价，或者行权价错配了一档。实测：东财只给滞后价时，
      // 510500 会算出 −4% 的近月基差（一档 0.25 元 ≈ 3.8%），一眼假。
      const tol = x.k * (0.004 + 0.08 * x.dte / 365);
      if (Math.abs((x.px - p.px) - (S - x.k)) > tol) continue;
      pairs.push({ k: x.k, c: x.px, p: p.px });
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

/** ETF 期权合成基差：清单走东财（缓存 6 小时），价格走新浪。
 *
 *  为什么换源（2026-11-10）：东财对 Cloudflare 出口的期权链只回 f18（昨收），
 *  f2（最新价）49 条全是 '-'，现货接口的 f2 却正常——于是整张卡只能按昨收算，
 *  凌晨拿到的 f18 还会比最新交易日早一天。新浪 CON_OP 快照同一出口实测 200、
 *  有最新价、一批能带 100 个合约，还直接给到期日和剩余自然日（省得自己推第三个周五）。
 *  新浪整批不通时退回老链路（serveFutOptEm），那边只有昨收但至少自洽。 */
async function serveFutOpt(url, env, ctx) {
  const g = url.searchParams.get('g') === 'rest' ? 'rest' : 'main';
  const ttl = g === 'rest' ? 300 : 120;
  const DBG = url.searchParams.get('dbg') === '1';
  const cache = DBG ? null : await getCache();
  const key = new Request('https://etf.internal/futopt/v2/' + g, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败回源 */ }
  }

  const list = ETF_OPT[g];
  const diag = {};
  const partial = [];

  const spotP = fetchEtfSpot(list.map((x) => x[0])).catch((e) => {
    diag.spot = String((e && e.message) || e);
    return null;
  });
  const listP = Promise.all(list.map(([sid, code]) => fetchOptList(sid).catch((e) => {
    (diag[code] = diag[code] || []).push('清单 ' + String((e && e.message) || e));
    return null;
  })));
  const lastP = loadFutLast(env).catch(() => null);
  const [spot, lists, lastSnap] = await Promise.all([spotP, listP, lastP]);
  // Δ 基准（上一交易日各标的的合成基差率），三处共用同一份取法
  const optB = optBaseFromLast(lastSnap, futDataDate(lastSnap));

  const codes = [];
  for (const l of lists) if (l) for (const x of l) codes.push(x.code);
  let quotes = new Map();
  if (codes.length) {
    try {
      quotes = await fetchSinaOpts(codes);
    } catch (e) {
      diag.quotes = String((e && e.message) || e);
    }
  }

  // 新浪那边一个价都没拿到（整批 4xx/超时），退老链路；东财好歹给昨收
  if (!quotes.size) return serveFutOptEm(url, env, ctx);

  if (!spot) partial.push('spot');
  const items = [];
  let td = '';
  for (let i = 0; i < list.length; i++) {
    const [, code, name] = list[i];
    const l = lists[i];
    const s = spot && spot[code];
    if (!l || !l.length || !s) {
      partial.push(code);
      if (!diag[code]) diag[code] = [l ? l.length + ' 个合约' : '清单失败', s ? '现货 ok' : '现货缺'];
      continue;
    }
    const rows = [];
    for (const x of l) {
      const q = quotes.get(x.code);
      if (!q || !(q.px > 0)) continue;
      rows.push({ k: q.k, px: q.px, dte: q.dte, vol: q.vol, oi: q.oi, side: q.side });
    }
    const months = calcEtfMonths(rows, s.p);
    if (!months.length) {
      partial.push(code);
      diag[code] = ['报价 ' + rows.length + '/' + l.length + '，配不出月份'];
      continue;
    }
    /* Δ基差率：拿「第 i 档」对「上一交易日第 i 档」。 */
    applyEtfBpc(months, code, optB);
    if (!td && s.d) td = s.d;
    items.push({ c: code, n: name, S: s.p, chg: s.chg, months, on: 'live' });
  }

  const out = { ok: true, g, ts: Date.now(), items, partial, td, src: 'sina' };
  out.optBaseTd = optB.baseTd;
  out.mode = !items.length ? 'none' : 'live';
  if (DBG || partial.length) out.diag = diag;
  const res = json(out, ttl);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  return res;
}

async function serveFutOptEm(url, env, ctx) {
  const g = url.searchParams.get('g') === 'rest' ? 'rest' : 'main';
  const ttl = g === 'rest' ? 300 : 120;
  // ?dbg=1：把每条期权链的失败原因带回来。东财对 Cloudflare 出口和家宽出口
  // 的态度可能不一样，沙箱里复现不了线上，只能让接口自己说哪里断了
  const DBG = url.searchParams.get('dbg') === '1';
  const cache = DBG ? null : await getCache();
  const key = new Request('https://etf.internal/futopt/v1/' + g, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败回源 */ }
  }

  const list = ETF_OPT[g];
  const diag = {};
  const grab = (sid, code, spt) => fetchOptChain(sid, spt).catch((e) => {
    (diag[code] = diag[code] || []).push('spt' + spt + ' ' + String((e && e.message) || e));
    return null;
  });
  // 分两批发：4 个标的的购 + 现货 = 5 个并发，回完再发 4 个沽。
  // 9 个一起发会撞 Cloudflare 对同 host 的连接数上限，后面的排队，
  // 单个请求的墙钟时间被顶到 5 秒以上（探针里 8 个并发最快那条也要 2.7s）
  const spotP = fetchEtfSpotAny(list.map((x) => x[0])).catch((e) => {
    diag.spot = String((e && e.message) || e);
    return null;
  });
  const [spot, calls, emLastSnap] = await Promise.all([
    spotP,
    Promise.all(list.map(([sid, code]) => grab(sid, code, 9))),
    loadFutLast(env).catch(() => null),
  ]);
  const puts = await Promise.all(list.map(([sid, code]) => grab(sid, code, 10)));
  const optBEm = optBaseFromLast(emLastSnap, futDataDate(emLastSnap));
  const chains = list.map(([, code], i) => ({ code, c: calls[i], p: puts[i] }));

  const partial = [];
  if (!spot) partial.push('spot');

  const items = [];
  for (const { code, c, p } of chains) {
    const s = spot && spot[code];
    if (!c || !p || !s) {
      partial.push(code);
      if (!diag[code]) diag[code] = [c ? 'call ' + c.length + ' 行' : 'call 失败',
        p ? 'put ' + p.length + ' 行' : 'put 失败', s ? 'spot ok' : 'spot missing'];
      continue;
    }
    // 整只用哪一套价：购和沽都过半有最新价才用最新价，否则（典型情况是东财对
    // 境外出口只给昨收）两册一起退到昨收。一边实时一边昨收，合成期货会凭空
    // 低/高出一个当日涨跌幅，看着像深度贴水，其实是数据错位。
    const n2c = c.filter((x) => x.p2 > 0).length;
    const n2p = p.filter((x) => x.p2 > 0).length;
    const useLive = n2c >= c.length * 0.5 && n2p >= p.length * 0.5;
    const S = useLive ? s.p : s.p0;
    if (!(S > 0)) { partial.push(code); diag[code] = ['现价与昨收都缺']; continue; }
    const rows = [];
    for (const x of c) {
      const px = useLive ? (x.p2 || x.p18) : x.p18;
      if (px > 0) rows.push({ k: x.k, px, dte: x.dte, vol: x.vol, oi: x.oi, side: 'C' });
    }
    for (const x of p) {
      const px = useLive ? (x.p2 || x.p18) : x.p18;
      if (px > 0) rows.push({ k: x.k, px, dte: x.dte, vol: x.vol, oi: x.oi, side: 'P' });
    }
    const months = calcEtfMonths(rows, S);
    if (!months.length) {
      partial.push(code);
      diag[code] = ['rows ' + rows.length + ' 配不出月份'];
      continue;
    }
    applyEtfBpc(months, code, optBEm);
    const name = (list.find((x) => x[1] === code) || [])[2] || code;
    items.push({ c: code, n: name, S, chg: useLive ? s.chg : 0, months, on: useLive ? 'live' : 'prev' });
  }

  const out = { ok: true, g, ts: Date.now(), items, partial, src: 'em' };
  out.optBaseTd = optBEm.baseTd;
  // live = 期权用当日最新价；prev = 只能拿到昨收，整块按昨收算；
  // none = 连昨收都不自洽（平价校验全挂），这时候不显示比显示错数好
  out.mode = !items.length ? 'none' : (items.some((x) => x.on === 'live') ? 'live' : 'prev');
  // 有标的没配对出来时把原因一并带上：这种时候最需要知道是「东财不通」还是
  // 「配不出月份」，而线上又没法 attach 调试器
  if (DBG || partial.length) out.diag = diag;
  const res = json(out, ttl);
  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  return res;
}

/** 东财期权链探针：一次性把几种地址/参数都试一遍，回状态码、耗时、字节数、
 *  以及 data.diff 的长度。2026-11-10 线上 g=main/g=rest 全空、现货接口却正常，
 *  沙箱里又复现不了（本地同样的 URL 能拿到 200 多档），只能让 Worker 自己逐个试。
 *  /api/optprobe?secid=1.510050 */
const EM_UT = 'bd1d9ddb04089700cf9c27f6f7426281';
const EM_FIELDS = 'f2,f5,f12,f14,f18,f108,f152,f161,f162';

async function serveOptProbe(url) {
  const secid = (url.searchParams.get('secid') || '1.510050').replace(/[^\d.]/g, '');
  const q = (host, extra) => 'https://' + host + '/api/qt/slist/get?spt=9&fltt=2&invt=2'
    + '&fields=' + EM_FIELDS + '&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3' + (extra || '');
  const cases = [
    ['slist', q('push2.eastmoney.com')],
    ['slist+ts', q('push2.eastmoney.com', '&_=' + Date.now())],
    ['no-np', q('push2.eastmoney.com').replace('&np=1', '')],
    ['delay', q('push2delay.eastmoney.com', '&ut=' + EM_UT)],
    ['ut', q('push2.eastmoney.com', '&ut=' + EM_UT)],
    ['ulist-spot', 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=' + secid + '&fields=f2,f3,f12,f14'],
    // 备选源：新浪的期权快照。东财对境外出口只给昨收，新浪如果给最新价就直接换
    ['sina-batch', 'https://hq.sinajs.cn/list=CON_OP_10012442,CON_OP_10012444,CON_OP_10011430', 'sina'],
    ['sina-etf', 'https://hq.sinajs.cn/list=s_sh510050', 'sina'],
  ];
  const one = async ([n, u, kind]) => {
    const t0 = Date.now();
    try {
      const r = await fetch(u, {
        headers: {
          'User-Agent': UA,
          Referer: kind === 'sina' ? 'https://stock.finance.sina.com.cn/' : 'https://quote.eastmoney.com/',
        },
        signal: AbortSignal.timeout(9000),
      });
      // 新浪是 GBK，Workers 的 TextDecoder 只有 utf-8。中文字节会变成替换字符，
      // 但我们只取价格/行权价/到期日这些 ASCII 字段，按逗号切分的下标不变
      const txt = await r.text();
      if (kind === 'sina') {
        const lines = txt.split('\n').filter((x) => x.indexOf('hq_str_') >= 0);
        const nonEmpty = lines.filter((x) => !/=""\s*;?\s*$/.test(x.trim()));
        const f = nonEmpty.length ? nonEmpty[0].split('"')[1].split(',') : [];
        return {
          n, s: r.status, ms: Date.now() - t0, bytes: txt.length,
          lines: lines.length, nonEmpty: nonEmpty.length,
          sample: f.length ? { px: f[1], k: f[7], side: f[45], exp: f[46], dte: f[47], oi: f[41], flds: f.length } : null,
        };
      }
      let diff = null, rc = null, sample = null, numF2 = 0, numF18 = 0;
      try {
        const j = JSON.parse(txt);
        rc = j && j.rc;
        const d = j && j.data;
        const arr = d && (Array.isArray(d.diff) ? d.diff
          : (d.diff && typeof d.diff === 'object' ? Object.values(d.diff) : []));
        if (arr.length) {
          diff = arr.length;
          // 关键统计：最新价有几个能当数字用、昨收有几个能当数字用。
          // 全是 '-' 的话就是「接口给了结构但不给价」，得换字段兜底
          for (const x of arr) {
            if (+x.f2 > 0) numF2++;
            if (+x.f18 > 0) numF18++;
          }
          const f = arr[0] || {};
          sample = { f12: f.f12, f2: f.f2, f18: f.f18, f161: f.f161, f162: f.f162 };
        }
      } catch (e) { /* 不是 JSON */ }
      return { n, s: r.status, ms: Date.now() - t0, bytes: txt.length, rc, diff, numF2, numF18, sample };
    } catch (e) {
      return { n, s: 0, ms: Date.now() - t0, err: String((e && e.message) || e) };
    }
  };
  const list = await Promise.all(cases.map(one));
  const best = list.reduce((a, x) => Math.max(a, x.numF2 || 0, x.numF18 || 0, x.nonEmpty || 0), 0);
  return json({
    ok: true, secid, best, total: list.length,
    hint: best ? '有 ' + best + ' 条能拿到价' : '所有变体都只有结构没有价，得换数据源',
    list,
  }, 15);
}

/** 250 天基线：原样透传 Actions 生成的 fut_daily.json。
 *  Worker 这边一个字段都不重算——历史序列一旦两边各算一遍，迟早会不一致。
 *
 *  eh 是 ETF 期权那段单独的历史（etfopt_hist.json），一起捎回去：前端只有在
 *  切到 ETF 组时才用它，多 1KB 换掉一次额外往返。它是「用今天仍在市的合约
 *  倒推」出来的，和中金所那份 XML 不是一回事，所以单独放一个字段，不混进 opt。
 *  口径从「隔季」改成「真近月」时（v:2）缓存键必须跟着升，否则 30 分钟内
 *  还会把旧口径那份发给新前端——旧文件里的 near 装的是远月。 */
async function serveFutHist(env) {
  const cache = await getCache();
  const key = new Request('https://etf.internal/futhist/v3', { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存读失败回源 */ }
  }
  let out;
  try {
    const [a, b] = await Promise.all([
      readAsset(env, 'fut_daily.json'),
      readAsset(env, 'etfopt_hist.json').catch(() => null),
    ]);
    if (!a) out = { ok: false, error: 'hist_not_ready', ts: Date.now() };
    else {
      const j = JSON.parse(await a.text());
      let eh = null;
      if (b) { try { eh = JSON.parse(await b.text()); } catch (e) { eh = null; } }
      out = { ...j, ok: true, eh, ts: Date.now() };
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
        || p === '/research' || p === '/research/' || p === '/r' || p === '/r/'
        || p === '/help' || p === '/help/' || p === '/h' || p === '/h/') {
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

    if (p === '/api/optprobe') {
      // 东财期权链逐个变体试探：线上拿不到 diff 时的定位工具
      return serveOptProbe(url);
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
      return serveOvernight(env, ctx);
    }

    if (p === '/api/ovmin') {
      // 隔夜/亚太条目的日内分时（东财 trends2 代理，secid 白名单）
      const sid = (url.searchParams.get('sid') || '').trim().toUpperCase();
      if (!isOvSid(sid)) return json({ ok: false, error: 'sid 非法' });
      return serveOvMin(sid, env, ctx);
    }

    if (p === '/api/bond') {
      // 十年美债收益率（隔夜卡用；单位 %，变动 bp）
      return serveBond(env, ctx);
    }

    if (p === '/api/ovprobe') {
      // 分时/K 线源排障：哪个域能出图、哪只真没分时、代码到底叫什么
      return serveOvProbe(url);
    }

    if (p === '/api/ovk') {
      // 同一个条目切到日线看位置（东财 kline 代理，同一份 secid 白名单）
      const sid = (url.searchParams.get('sid') || '').trim().toUpperCase();
      if (!isOvSid(sid)) return json({ ok: false, error: 'sid 非法' });
      return serveOvK(sid, +url.searchParams.get('n') || 120, env, ctx);
    }

    if (p === '/api/shares') {
      // 份额变化：last / ix / 单只三档，纯透传
      return serveShares(url, env, ctx);
    }

    if (p === '/api/mkt') {
      // 全 A 个股口径的集中度 / 宽度：盘中现算，收盘后读回算好的日档
      return serveMkt(env, ctx);
    }

    if (p === '/api/ind') {
      // 某个三级行业的成分股 + 当日涨跌成交额（卡片上点行业名时用）
      const q = (url.searchParams.get('n') || url.searchParams.get('i') || '').trim();
      if (!q) return json({ ok: false, code: 'NO_ARG', error: '缺少 n（行业名）或 i（下标）' });
      return serveInd(q, ctx);
    }

    if (p === '/api/mktprobe') {
      // 盘中那条链的诊断口：?t=raw 打上游并计时，?t=agg 用内置样本验算，?t=kv 看快照
      return serveMktProbe(url, env);
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
