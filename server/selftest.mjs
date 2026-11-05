/**
 * 双运行时契约自检
 * ================
 * 「以后有变化两边一起改」不能靠记性，得靠一个能跑的东西。这个脚本干两件事：
 *
 *   1) 运行时合规扫描：worker/src/ 里不许出现只有 Cloudflare 才有的 API
 *      （process / Buffer / require / node: 模块 / 裸 caches.default）。
 *      出现就说明这份代码搬不到沙箱版，或者沙箱版会当场 500。
 *
 *   2) 接口契约回归：把门禁、首页、K 线、异动、状态、自选全打一遍。
 *      本地打：node server/selftest.mjs
 *      打线上：BASE=https://xxx.workers.dev ACCESS_PASS=xxx node server/selftest.mjs
 *      同一个脚本对两边都成立，才算「两边一致」。
 *
 * 退出码 0 = 全绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'worker', 'src');

let fails = 0;
let checks = 0;
const ok = (msg) => { checks++; console.log('  ✓ ' + msg); };
const bad = (msg, detail) => { checks++; fails++; console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); };

// ---------------------------------------------------------------- 1. 合规扫描
/**
 * 把注释替换成等长空白（保留换行，行号不变）。
 * 不这么做，源码里那些「说明 caches.default 是什么」的注释会全部被当成违规。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let st = 0; // 0=代码 1=行注释 2=块注释
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (st === 0) {
      if (c === '/' && d === '/') { st = 1; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { st = 2; out += '  '; i += 2; continue; }
      out += c; i++; continue;
    }
    if (st === 1) {
      if (c === '\n') { st = 0; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    if (c === '*' && d === '/') { st = 0; out += '  '; i += 2; continue; }
    out += (c === '\n' ? '\n' : ' ');
    i++;
  }
  return out;
}

/** getCache() 函数体是唯一允许摸 caches 的地方——它就是适配层本身 */
function maskGetCacheBody(src) {  const start = src.indexOf('function getCache(');
  if (start < 0) return src;
  let i = src.indexOf('{', start);
  if (i < 0) return src;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(0, start) + src.slice(start, j + 1).replace(/[^\n]/g, ' ') + src.slice(j + 1);
      }
    }
  }
  return src;
}

function scanRuntime() {
  console.log('\n[1/2] 运行时合规扫描（worker/src/**）');
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'page.js');
  if (!files.length) { bad('没找到服务端源码，路径不对？', SRC); return; }

  const RULES = [
    { re: /\bprocess\s*\./g, why: 'CF Worker 没有 process（Node 专属）' },
    { re: /\bBuffer\s*[.(]/g, why: 'CF Worker 没有 Buffer（用 ArrayBuffer/Uint8Array）' },
    { re: /\brequire\s*\(/g, why: 'CF Worker 不支持 CommonJS require' },
    { re: /from\s+['"]node:/g, why: 'CF Worker 不能 import node: 内置模块' },
    { re: /\bglobalThis\s*\.\s*(window|document)\b/g, why: '服务端不该碰 DOM' },
  ];

  for (const f of files) {
    const raw = fs.readFileSync(path.join(SRC, f), 'utf8');
    // 先剥注释、再遮住 getCache 函数体；行号始终以 raw 为准
    const src = maskGetCacheBody(stripComments(raw));
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;

    let hit = 0;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(src))) {
        hit++;
        bad(`${f}:${lineOf(m.index)} ${rule.why}`, raw.split('\n')[lineOf(m.index) - 1].trim().slice(0, 120));
      }
    }
    // 裸 caches.default / caches.open（getCache 之外）
    rule: {
      const re = /\bcaches\s*\.\s*(default|open)\b/g;
      let m;
      while ((m = re.exec(src))) {
        hit++;
        bad(`${f}:${lineOf(m.index)} 裸 caches.${m[1]}（沙箱版会 ReferenceError，走 getCache()）`,
          raw.split('\n')[lineOf(m.index) - 1].trim().slice(0, 120));
      }
      break rule;
    }
    if (!hit) ok(f + ' 干净');
  }
}

// ---------------------------------------------------------------- 2. 接口契约
// 发布平台在第一次请求通过 sharecode 校验后会下发 __wb_rsc 会话 cookie，
// 之后的请求要带着它，否则一律 403。这是平台层的，和我们自己的口令 cookie 分开存。
let PLAT_COOKIE = '';

function absorbPlatformCookie(res) {
  const sc = res.headers['set-cookie'] || [];
  for (const c of (Array.isArray(sc) ? sc : [sc])) {
    const kv = String(c).split(';')[0];
    if (kv.startsWith('__wb_rsc=')) PLAT_COOKIE = kv;
  }
}

function rawRequest(base, pathname, { method = 'GET', body, cookie, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    // 发布平台的访问控制：链接上的 sharecode 是每个请求都要带的凭据，
    // 少了它平台直接 403。之前这里用 http 模块打 443，被网关 302 掉，
    // 所有断言都看到 302（踩过一次）。所以按协议选模块，并带上平台 cookie。
    if (process.env.SHARECODE && !u.searchParams.get('sharecode')) {
      u.searchParams.set('sharecode', process.env.SHARECODE);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const jar = [cookie, PLAT_COOKIE].filter(Boolean).join('; ');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      timeout,
      headers: {
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
        ...(jar ? { cookie: jar } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        absorbPlatformCookie(res);
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf,
          text: buf.toString('utf8'),
          json() { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } },
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + timeout + 'ms')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieOf(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return '';
  const first = Array.isArray(sc) ? sc[0] : sc;
  return String(first).split(';')[0];
}

async function runContracts(base, pass) {
  console.log('\n[2/2] 接口契约（' + base + '）');
  let cookie = '';

  // 门禁：未登录
  let r = await rawRequest(base, '/');
  r.status === 401 ? ok('未登录访问首页 → 401') : bad('未登录访问首页应 401，实际 ' + r.status);

  r = await rawRequest(base, '/api/events');
  const j0 = r.json();
  (r.status === 401 || (j0 && j0.locked)) ? ok('未登录访问 /api/events → 打回') : bad('/api/events 未鉴权就出数据了，状态 ' + r.status);

  // 错口令
  r = await rawRequest(base, '/__auth', { method: 'POST', body: 'p=' + encodeURIComponent('____wrong____') + '&next=/' });
  r.status === 401 ? ok('错口令 → 401') : bad('错口令应 401，实际 ' + r.status);

  // 对口令
  r = await rawRequest(base, '/__auth', { method: 'POST', body: 'p=' + encodeURIComponent(pass) + '&next=/' });
  cookie = cookieOf(r);
  (r.status === 302 && cookie) ? ok('对口令 → 302 + Cookie') : bad('对口令应 302 且下发 Cookie，实际 ' + r.status + ' cookie=' + (cookie || '空'));
  if (!cookie) { bad('拿不到 Cookie，后面全部无法验证，中止'); return; }

  // 首页
  r = await rawRequest(base, '/', { cookie });
  (r.status === 200 && r.text.length > 50000) ? ok('首页 200，' + r.body.length + ' 字节') : bad('首页异常：' + r.status + ' ' + r.body.length + ' 字节');

  // K 线
  r = await rawRequest(base, '/api/hist?code=510300', { cookie });
  (r.status === 200 && r.body.length > 1000) ? ok('/api/hist 510300 → ' + r.body.length + ' 字节') : bad('/api/hist 异常：' + r.status + ' ' + r.body.length);

  // K 线：参数校验
  r = await rawRequest(base, '/api/hist?code=__bad__', { cookie });
  const jb = r.json();
  (jb && jb.ok === false) ? ok('/api/hist 非法 code 被拒') : bad('/api/hist 非法 code 没拒');

  // 异动快照（这条以前在 Node 下会 500）
  r = await rawRequest(base, '/api/events', { cookie });
  const je = r.json();
  (je && je.ok !== false) ? ok('/api/events ok，' + r.body.length + ' 字节') : bad('/api/events 失败：' + r.status + ' ' + r.text.slice(0, 160));

  // 日内分时：走新浪 minline，是全站唯一「每次打开面板都要实时拉」的接口，
  // 上游偶发空回。给它一次重试，免得一次抖动就把整轮自检判红。
  let jm = null;
  for (let i = 0; i < 2 && !(jm && jm.ok); i++) {
    if (i) await new Promise((res) => setTimeout(res, 1500));
    r = await rawRequest(base, '/api/min?code=510300', { cookie });
    jm = r.json();
  }
  if (jm && jm.ok && Array.isArray(jm.pts) && jm.pts.length > 30) {
    const p0 = jm.pts[0], pl = jm.pts[jm.pts.length - 1];
    ok('/api/min 510300 → ' + jm.pts.length + ' 点，' + p0[0] + '–' + pl[0] + '，' + r.body.length + ' 字节');
    const badPt = jm.pts.find((x) => !Array.isArray(x) || !/^\d\d:\d\d$/.test(x[0]) || !(x[1] > 0));
    badPt ? bad('/api/min 有异常点：' + JSON.stringify(badPt)) : ok('/api/min 每点时刻与价格都合法');
  } else {
    bad('/api/min 失败：' + r.text.slice(0, 160));
  }

  r = await rawRequest(base, '/api/min?code=__bad__', { cookie });
  const jmb = r.json();
  (jmb && jmb.ok === false) ? ok('/api/min 非法 code 被拒') : bad('/api/min 非法 code 没拒');

  // 涨速榜：一次拉十几只分时，最慢的一条链路，给两次机会
  let jsp = null;
  const spCodes = '510300,159915,588000,513180,513120,518880,512100,513050,510500,159516';
  for (let i = 0; i < 2 && !(jsp && jsp.ok && jsp.rows && jsp.rows.length); i++) {
    if (i) await new Promise((res) => setTimeout(res, 1500));
    r = await rawRequest(base, '/api/speed?codes=' + spCodes, { cookie });
    jsp = r.json();
  }
  if (jsp && jsp.ok && Array.isArray(jsp.rows) && jsp.rows.length >= 5) {
    ok('/api/speed → ' + jsp.rows.length + '/' + jsp.ask + ' 只有效，' + r.body.length + ' 字节');
    const badRow = jsp.rows.find((x) =>
      !x.c || !isFinite(x.r3) || !isFinite(x.q3) || !Array.isArray(x.pv) || x.pv.length < 2);
    badRow ? bad('/api/speed 有异常行：' + JSON.stringify(badRow).slice(0, 120))
      : ok('/api/speed 每行含 r3/q3/pv，字段齐全');
    // 量比是比值不是绝对量：出现 0 以外的负数或离谱的量级，说明口径算歪了
    const badQ = jsp.rows.find((x) => x.q3 < 0 || x.q3 > 200);
    badQ ? bad('/api/speed 量比越界：' + badQ.c + ' q3=' + badQ.q3)
      : ok('/api/speed 量比取值在 0–200 之间');
  } else {
    bad('/api/speed 失败：' + r.text.slice(0, 160));
  }

  r = await rawRequest(base, '/api/speed?codes=__bad__', { cookie });
  const jspb = r.json();
  (jspb && jspb.ok === false) ? ok('/api/speed 非法 codes 被拒') : bad('/api/speed 非法 codes 没拒');

  // 状态
  r = await rawRequest(base, '/api/status', { cookie });
  const js = r.json();
  if (js && js.ok) {
    const b = js.bindings || {};
    ok('/api/status bindings=' + JSON.stringify(b) + ' hist=' + (js.hist && js.hist.last_trade_date));
    if (!b.r2 && !b.gh) bad('/api/status 显示没有历史数据源');
    if (!b.kv) bad('/api/status 显示 KV 未绑定（自选不会持久）');
  } else bad('/api/status 失败：' + r.text.slice(0, 160));

  // 自选读写
  const wkey = 'watch:list:__selftest__';
  r = await rawRequest(base, '/api/watch?k=' + encodeURIComponent('__selftest__'), { cookie, method: 'POST', body: JSON.stringify({ list: ['510300'] }) });
  const jw = r.json();
  (jw && jw.ok !== false) ? ok('/api/watch 写入') : bad('/api/watch 写入失败：' + r.text.slice(0, 160));
  r = await rawRequest(base, '/api/watch?k=' + encodeURIComponent('__selftest__'), { cookie });
  const jr = r.json();
  (jr && jr.ok !== false) ? ok('/api/watch 读回') : bad('/api/watch 读回失败：' + r.text.slice(0, 160));

  // 未知路径
  r = await rawRequest(base, '/__nope', { cookie });
  (r.status === 404 || (r.json() && r.json().ok === false))
    ? ok('未知路径不伪装成 200（' + r.status + '）')
    : bad('未知路径返回了 ' + r.status + ' 且不是 ok:false');
}

async function startLocal() {
  const { makeEnv } = await import('./env.mjs');
  const { createApp } = await import('./app.mjs');
  const { env, meta } = await makeEnv();
  const server = createApp(env);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  return { server, base: 'http://127.0.0.1:' + port, pass: env.ACCESS_PASS, meta };
}

// ---------------------------------------------------------------- main
const BASE = process.env.BASE;
const PASS = process.env.ACCESS_PASS;

scanRuntime();

let close = async () => {};
let base = BASE;
let pass = PASS;
if (!BASE) {
  const local = await startLocal();
  close = () => new Promise((r) => local.server.close(r));
  base = local.base;
  pass = local.pass;
  console.log('\n本地起了一个临时实例：' + base);
  console.log('  dist = ' + local.meta.dist);
  console.log('  state= ' + local.meta.state);
}
if (!pass) {
  bad('没有 ACCESS_PASS，无法验证契约', '本地跑会自动从 .env / state 取；打线上请显式传 ACCESS_PASS');
} else {
  try {
    await runContracts(base, pass);
  } catch (e) {
    bad('契约测试异常中断', e && e.message || String(e));
  }
}
await close();

console.log('\n' + (fails ? '✗ ' + fails + '/' + checks + ' 项未通过' : '✓ 全部 ' + checks + ' 项通过'));
process.exit(fails ? 1 : 0);
