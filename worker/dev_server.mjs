/**
 * 本地预览服务器
 * ==============
 * 直接把 src/index.js 的 fetch 挂在 node:http 上，不跑 wrangler。
 *
 * 但真实部署时有 R2 和 KV 绑定，本地没有——所以这里给 env 塞一套 mock：
 *   BUCKET → 读 ../dist 目录（和 Actions 推进 R2 的是同一份文件）
 *   WATCH  → 进程内存，重启即清空
 * 这样 /api/hist、/api/watch、/api/status 全都能在本地走通，
 * 不用为了看一眼 K 线就先部署。
 *
 * 用法：cd worker && node build.mjs && node dev_server.mjs
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import worker from './src/index.js';

const PORT = process.env.PORT || 8899;
const DIST = path.resolve(process.cwd(), '../dist');

const BUCKET = {
  async get(key) {
    const f = path.join(DIST, key);
    try {
      const buf = await fs.readFile(f);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return {
        body: ab,
        async arrayBuffer() { return ab; },
        async text() { return buf.toString('utf8'); },
        writeHttpMetadata(h) {
          h.set('ETag', '"' + buf.length.toString(16) + '-' + key.length + '"');
        },
      };
    } catch {
      return null;
    }
  },
};

const mem = new Map();
const WATCH = {
  async get(k, type) {
    const v = mem.get(k);
    if (v == null) return null;
    return type === 'json' ? JSON.parse(v) : v;
  },
  async put(k, v) { mem.set(k, v); },
};

const env = { BUCKET, WATCH };

// 线上口令来自 secret，本地没有；给个默认值，否则门禁会把整站锁死，
// 打开只有一张「未配置口令」说明页，看着像坏了。
const DEV_PASS = process.env.ACCESS_PASS || 'devtest';
env.ACCESS_PASS = DEV_PASS;

http.createServer(async (req, res) => {
  try {
    // 必须把请求体读出来传给 Request，否则 POST /api/watch 的 body 是空的，
    // worker 里 request.json() 会抛「body 不是合法 JSON」。
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);

    const r = await worker.fetch(new Request('https://local' + req.url, {
      method: req.method,
      headers: req.headers,
      body: (req.method === 'GET' || req.method === 'HEAD' || !raw.length) ? undefined : raw,
    }), env, {});
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e && e.stack || e));
  }
}).listen(PORT, () => {
  console.log('dev server on http://127.0.0.1:' + PORT);
  console.log('  R2 mock →', DIST);
  console.log('  KV mock → 内存');
  console.log('  口令    →', DEV_PASS, '(ACCESS_PASS 环境变量可覆盖)');
});
