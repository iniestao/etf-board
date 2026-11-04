import { HTML } from './page.js';

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
 *   GET  /                    前端页面（带 ETag）
 *   GET  /api/all             全市场原始数据（透传）
 *   GET  /api/quote?codes=    自选批量（东财 ulist，失败返回 ok:false）
 *   GET  /api/probe           多源自检
 *   GET  /api/hist?code=      单只历史二进制（R2 透传，需绑定 BUCKET）
 *   GET  /api/watch           读云端自选（需绑定 KV）
 *   POST /api/watch           写云端自选，body {"list":["510300",...]}
 *   GET  /api/status          部署自检：R2/KV 绑定状态、历史数据日期
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TTL = 5;              // 边缘缓存秒数
const EM_TIMEOUT = 2800;    // 东财竞速超时
const SINA_PAGES = 20;      // 1717 只约需 18 页
const MIN_ROWS = 100;       // 认定某源有效的最少条数（防止半页空响应被当成成功）
const GOOD_ROWS = 1500;     // 超过这个数才算「完整快照」，先到可以直接采信
const WAIT_TOTAL = 6000;    // 先到者不完整时，等另一个源的上限

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
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
  });
  if (!r.ok) throw new Error('SINA HTTP ' + r.status);
  const t = (await r.text()).trim();
  if (!t || t === 'null' || t === '[]') return '';
  return t.slice(1, -1);   // 去掉外层 []
}

async function fetchSina() {
  const parts = await Promise.all(
    Array.from({ length: SINA_PAGES }, (_, i) => sinaPage(i + 1).catch(() => ''))
  );
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

// ---------------------------------------------------------------- 历史数据（R2）
/**
 * 取单只 ETF 的精简历史二进制。
 *
 * 为什么不在 Worker 里解 Parquet：单只 2.27MB / 165 列，zstd 解压这一步
 * 就会吃掉几百毫秒，而免费版只有 10ms CPU。所以 Actions 侧另导了一份
 * 定长二进制（近 500 天 × 17 字段，约 12KB），Worker 只做原样透传，
 * 解析交给浏览器——那边没有 CPU 配额。
 *
 * 缓存 6 小时：历史数据一天只变一次，没必要每次回源 R2。
 */
async function serveHist(code, env, ctx) {
  if (!env || !env.BUCKET) {
    return json({ ok: false, code: 'NO_R2', error: '未绑定 R2 存储，历史数据不可用' });
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
    obj = await env.BUCKET.get('hist/' + code + '.bin');
  } catch (e) {
    return json({ ok: false, code: 'R2_ERR', error: '读 R2 失败: ' + (e.message || e) });
  }
  if (!obj) return json({ ok: false, code: 'NOT_FOUND', error: '无此标的的历史数据' });

  // 透传 R2 的元信息（ETag / Last-Modified），浏览器二次访问可走 304
  const h = new Headers();
  obj.writeHttpMetadata(h);
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

async function serveWatch(request, env) {
  if (!env || !env.WATCH) {
    return json({ ok: false, code: 'NO_KV', error: '未绑定 KV，自选仅存本地' });
  }
  if (request.method === 'GET') {
    try {
      // 必须区分「没写过」和「写了空数组」：前者要用本地列表初始化云端，
      // 后者代表用户主动清空了自选，其他设备必须跟着清空。
      // 只返回 list 的话两者都是 []，清空操作会在另一台设备上被"复活"。
      const raw = await env.WATCH.get(WATCH_KEY);
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
    await env.WATCH.put(WATCH_KEY, JSON.stringify(list));
    return json({ ok: true, n: list.length });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) });
  }
}

// ---------------------------------------------------------------- 部署自检
/**
 * 部署完第一件事就是访问 /api/status：它把「R2 绑没绑、KV 绑没绑、
 * 历史数据是哪天的」一次说清，省得去翻日志猜。
 */
async function serveStatus(env) {
  const out = {
    ok: true,
    bindings: { r2: !!(env && env.BUCKET), kv: !!(env && env.WATCH) },
    hist: null,
    watch_n: null,
    quote: null,
  };
  if (env && env.BUCKET) {
    try {
      const m = await env.BUCKET.get('manifest.json');
      if (m) {
        const j = JSON.parse(await m.text());
        out.hist = {
          last_trade_date: j.last_trade_date,
          codes: j.codes,
          format: j.hist && j.hist.format,
          cols: j.hist && j.hist.cols ? j.hist.cols.length : null,
          bytes: j.hist && j.hist.bytes,
        };
      } else {
        out.hist = { error: 'R2 里没有 manifest.json，Actions 还没跑过？' };
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

    if (p === '/' || p === '/index.html') {
      const etag = htmlEtag();
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          ETag: etag,
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

    if (p === '/api/status') {
      return serveStatus(env);
    }

    if (p === '/api/all') {
      // 边缘缓存：跨 isolate/实例共享，把冷启动拉全量的 CPU 成本摊到一个 TTL 周期内
      const CACHE_KEY = 'https://etf.internal/all-v1';
      const cache = await getCache();
      if (cache) {
        try {
          const hit = await cache.match(CACHE_KEY);
          if (hit) return hit;
        } catch (e) { /* 缓存不可用时降级 */ }
      }
      try {
        const body = await loadAll();
        const resp = new Response(body, {
          headers: { ...CORS, 'Cache-Control': 'public, max-age=' + TTL },
        });
        if (cache) {
          try {
            const p = cache.put(CACHE_KEY, resp.clone());
            // Cloudflare 有 waitUntil（延长生命周期到响应之后）；
            // Deno Deploy 没有这个 API，必须当场 await，否则写入可能悬空丢失。
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
            else await p;
          } catch (e) { /* 缓存写入失败不影响主流程 */ }
        }
        return resp;
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) });
      }
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
