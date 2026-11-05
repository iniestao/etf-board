/**
 * 沙箱版 HTTP 入口（WorkBuddy 发布用）
 * ====================================
 * 做的事情只有一件：把 Node 的 http.IncomingMessage 翻译成标准 Request，
 * 交给 worker/src/index.js 里那个 fetch 处理，再把标准 Response 写回去。
 *
 * 刻意不引入 express / fastify —— 多一层框架就多一处和 Cloudflare 行为不一致的地方，
 * 而「两边表现一样」是这个项目现在最重要的约束。
 *
 * 用法：
 *   PORT=3000 node server/app.mjs
 * 环境变量：
 *   PORT        监听端口，默认 3000（发布时由平台注入）
 *   HOST        默认 0.0.0.0（容器里必须绑 0.0.0.0，绑 127.0.0.1 反代打不进来）
 *   DIST_DIR    数据目录，默认 <repo>/dist
 *   STATE_DIR   状态目录，默认 server/state
 *   ACCESS_PASS 访问口令，缺省时按 env.mjs 的优先级取
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { warmRound } from '../worker/src/index.js';
import { makeEnv } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 2 * 1024 * 1024; // 自选列表最多几十 KB，2MB 足够，防止被灌大包

function toHeaders(raw) {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    // node 对重复头（如 set-cookie 请求侧很少见）给数组
    h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  return h;
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { statusCode: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return undefined;
  return Buffer.concat(chunks);
}

/**
 * 建一个 http.Server（不 listen），方便 selftest 用随机端口直接拉起。
 */
export function createApp(env, ctxBucket) {
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
      const url = new URL(proto + '://' + host + (req.url || '/'));

      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        res.writeHead(e.statusCode || 400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(e.message || e));
        return;
      }

      const request = new Request(url, {
        method: req.method,
        headers: toHeaders(req.headers),
        body,
        // Node 的 fetch 在 GET/HEAD 带 body 时会抛错，这里必须显式放开
        duplex: body ? 'half' : undefined,
      });

      // waitUntil 等价物：进程常驻，promise 自己会跑完；只保证异常不会变成
      // unhandledRejection 把进程带走（那会让整个站点静默挂掉）。
      const pending = [];
      const ctx = {
        waitUntil(p) {
          if (p && typeof p.then === 'function') {
            const safe = p.catch(() => {});
            pending.push(safe);
            if (ctxBucket) ctxBucket.push(safe);
          }
        },
        passThroughOnException() {},
      };

      const r = await worker.fetch(request, env, ctx);

      const out = {};
      r.headers.forEach((v, k) => { out[k] = v; });
      // 多个 Set-Cookie 会被 forEach 合并，必须单独取
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : null;
      if (sc && sc.length) out['set-cookie'] = sc;

      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, out);
      res.end(req.method === 'HEAD' ? undefined : buf);

      if (process.env.LOG_REQ === '1') {
        const who = request.headers.get('x-forwarded-for') || req.socket.remoteAddress || '-';
        console.log(`${r.status} ${req.method} ${url.pathname}${url.search} ${Date.now() - t0}ms ${buf.length}B ${who}`);
      }
    } catch (e) {
      console.error('[app] 处理请求失败:', e && e.stack || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('internal error');
    }
  });
}

// ---------------------------------------------------------------- 直接运行
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { env, meta } = await makeEnv();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  // 启动自检：数据目录是不是空的，直接说清楚，别等用户打开首页看到一片「没有数据」
  let histN = 0;
  try {
    const { default: fsp } = await import('node:fs/promises');
    histN = (await fsp.readdir(path.join(meta.dist, 'hist'))).length;
  } catch { /* 目录不存在 */ }

  const server = createApp(env);
  server.listen(port, host, () => {
    console.log('ETF 看板（沙箱版）已启动');
    console.log('  监听      http://' + host + ':' + port);
    console.log('  数据目录  ' + meta.dist + '（hist 文件 ' + histN + ' 个）');
    console.log('  状态目录  ' + meta.state);
    console.log('  口令来源  ' + meta.passFrom + '（值不回显；换口令就改 .env 里的 ACCESS_PASS）');
    if (!histN) console.log('  ⚠ dist/hist 是空的，K 线与位置诊断会没数据：先跑 node server/sync-data.mjs');
  });

  // 数据保鲜：Cloudflare 版每次回源读 data 分支，天然是新的；沙箱版读本地磁盘，
  // 得自己追。这里不设「定点跑批」——沙箱休眠时定点任务根本不会执行，
  // 改成「进程活着就每 6 小时比一次 commit，变了才在后台拉」。
  // 拉取全程异步，不挡任何请求；失败只打日志，页面继续用旧数据。
  if (process.env.AUTO_SYNC !== '0') {
    const tick = () => import('./sync-data.mjs')
      .then((m) => m.syncInBackground((s) => console.log('[sync] ' + s)))
      .catch(() => {});
    setTimeout(tick, 15000).unref();
    setInterval(tick, 6 * 3600 * 1000).unref();
  }

  // PCF 预热：Cloudflare 版靠 Cron Trigger，沙箱版没有 Cron，用进程内的定时器
  // 顶替，调的是同一个 warmRound。只在工作日 07:00–16:00（北京时间）跑——早上
  // 那几轮抓到的还是昨天那份清单，先用着；等今天的清单上线，warmRound 会自己
  // 把游标归零重抓。抓完就空转（每轮只读一次进度就返回）。
  // 沙箱休眠期间不会执行——漏了就退回「打开时现场拉」，正确性不受影响。
  if (process.env.PCF_WARM !== '0') {
    const warmTick = async () => {
      const cst = new Date(Date.now() + 8 * 3600e3);
      const hh = cst.getUTCHours(), mm = cst.getUTCMinutes(), wd = cst.getUTCDay();
      if (wd === 0 || wd === 6) return;
      // 08:35 起：上交所 08:30 换清单、深交所 08:12 生成文件，再早就拿到昨天那份了
      if (hh < 8 || (hh === 8 && mm < 35) || hh >= 16) return;
      try {
        const r = await warmRound(env);
        if (r && (r.got || r.wrote || r.built)) console.log('[pcfwarm] ' + JSON.stringify(r));
      } catch (e) {
        console.log('[pcfwarm] ' + String((e && e.message) || e));
      }
    };
    setTimeout(warmTick, 25000).unref();
    setInterval(warmTick, 60000).unref();
  }

  const bye = () => server.close(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
