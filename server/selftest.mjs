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

// 界面「同指数去重」和预热归并用的是同一份映射，自检里核对这一点
const { IDX_GROUPS } = await import(path.join(SRC, 'idx_data.js'));
const IX_OF = Object.create(null);
for (const k in IDX_GROUPS) for (const c of IDX_GROUPS[k]) IX_OF[c] = k;

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

/* ---------------------------------------------------------------- 1.5 内联快照
 * 四象限的散点云（MKT_HIST）和板块占比走势（SEC_HIST）不是运行时拉 json，
 * 是 build.mjs 拼进 worker.js 的常量。data 分支的 mkt_hist.json / sec_daily.json
 * 只喂同步脚本自身，页面根本不看——所以这两对文件必须同日。
 * 不同步的表现是「页面一切正常，只是散点云停在上周」，2026-11-11 就是这样：
 * 「全 A 散点停在 11-06」，Actions 天天跑，产物在 runner 上随 job 丢了。
 */
console.log('\n[内联快照] worker.js 里的常量与 data 分支 json 是否同日');
{
  const pairs = [
    ['dist/mkt_hist.json', 'worker/src/mkt_hist.js', '全 A 散点'],
    ['dist/sec_daily.json', 'worker/src/sec_hist.js', '板块占比'],
  ];
  for (const [jp, sp, label] of pairs) {
    const jf = path.join(ROOT, jp), sf = path.join(ROOT, sp);
    if (!fs.existsSync(jf)) { console.log('  – ' + label + '：没有 ' + jp + '（沙箱还没同步过），跳过'); continue; }
    let jd = null, sd = null;
    try { jd = JSON.parse(fs.readFileSync(jf, 'utf8')).last_trade_date || null; } catch { /* 下面报 */ }
    try {
      /* 不能拿「文件里最后一个日期」当快照日：payload 末尾还有 cAsOf（增量模式下
         集中度停在上一日），正则扫全文会取到它，于是天天报「不同日」。解析 JSON 取 d 末项。 */
      const txt = fs.readFileSync(sf, 'utf8');
      const mm = /export const \w+ = (\{[\s\S]*?\});/.exec(txt);
      if (mm) {
        const o = JSON.parse(mm[1]);
        sd = o.last_trade_date || (Array.isArray(o.d) && o.d.length ? o.d[o.d.length - 1] : null);
      } else {
        const ds = txt.match(/20\d\d-\d\d-\d\d/g) || [];
        sd = ds.length ? ds[ds.length - 1] : null;
      }
    } catch { /* 下面报 */ }
    if (!jd || !sd) { bad(label + '快照日期读不出来（json=' + jd + ' src=' + sd + '）'); continue; }
    jd === sd
      ? ok(label + '快照同日：' + sd)
      : bad(label + '快照不同日：源码内联 ' + sd + '，data 分支 json ' + jd
          + '——重跑 gen_* 或等 Actions 回写，否则页面停在前者那天');
  }
}

async function runContracts(base, pass) {
  console.log('\n[2/2] 接口契约（' + base + '）');

  /* 界面口径哨兵：K 线的「涨跌」（tooltip 数值、收价染色、柱体红绿、量柱）必须
     以**前一交易日收盘**为基准。以开盘价为基准算出来的是日内方向，会把
     「跳空低开、收回一半」判成上涨还画成红线，跟账户盈亏正好相反——
     159108 2026-11-06 实际 -3.13%，曾经显示 +1.88%。 */
  const pageSrc = fs.readFileSync(path.join(SRC, 'page.js'), 'utf8');
  if (!/function hChgPct\(/.test(pageSrc)) {
    bad('K 线涨跌没有统一的基准函数（hChgPct 丢了）');
  } else if (/c\.close\[[^\]]*\]\s*\/\s*c\.open\[[^\]]*\]/.test(pageSrc)) {
    bad('K 线涨跌又回到「收 ÷ 开」：那不是涨跌，是日内方向');
  } else {
    ok('K 线涨跌以前收为基准（hChgPct），不是收 ÷ 开');
  }

  /* ---- 国家队名单 ----
     这份数据是定期报告的半年快照，不是行情。它最容易出三种错，三种都只在
     用户点下去的那一刻才暴露：
       ① 名单空 / 代码写错 → 筛选出空表，看着像「今天国家队没持仓」；
       ② 同一只登记两次 → 表格里两行一模一样，看不出是脏数据还是真的买了两份；
       ③ 忘了写报告期 → 半年前的持仓被当成实时数据。
     报告期和「不做去重」这两件必须在源码里是显式的，不能靠渲染时兜。 */
  const stateSrc = fs.readFileSync(path.join(SRC, 'state_data.js'), 'utf8');
  const stCodes = [...stateSrc.matchAll(/\['(\d{6})',/g)].map((m) => m[1]);
  const stUniq = new Set(stCodes);
  if (stCodes.length < 10) {
    bad('国家队名单只有 ' + stCodes.length + ' 只，像是被截断了');
  } else if (stUniq.size !== stCodes.length) {
    bad('国家队名单有重复代码：' + stCodes.length + ' 条里只有 ' + stUniq.size + ' 个不同');
  } else if (!/asOf:\s*'\d{4}-\d{2}-\d{2}'/.test(stateSrc)) {
    bad('国家队名单没有 asOf：报告期不写到页面上，半年前的持仓会被当成实时');
  } else if (!pageSrc.includes('STATE_SET[x.c]')) {
    bad('国家队筛选没有走 STATE_SET，点下去会筛出空表');
  } else if (!pageSrc.includes("DEDUP && !kw && g !== 'state'")) {
    bad('国家队模式下仍会做同指数去重：四只沪深300ETF 只会剩一只');
  } else if (!pageSrc.includes('renderStateHint')) {
    bad('国家队模式没有报告期说明条');
  } else {
    ok('国家队名单 ' + stUniq.size + ' 只（含报告期、无重复），筛选独立于分组与去重');
  }
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

  // 清单第 12 列：份额（净申赎）。列头和单元格定位属性都在同一个 HTML 里，
  // 少一个就是「接口有数、页面不显示」，这种静默失败只能靠断言盯住。
  // 认 data-sk="sh" 这根定位柱，不认 title 文案——标题改过两次，每次都把
  // 断言带崩，而列其实一直在。
  const hasTh = r.text.includes('data-sk="sh"') && r.text.includes('>申赎<');
  const hasTd = r.text.includes("data-sh=')") || r.text.includes('data-sh="');
  (hasTh && hasTd) ? ok('清单含「申赎」列（表头 + data-sh 单元格）')
    : bad('清单缺申赎列：表头 ' + hasTh + ' / 单元格 ' + hasTd);

  // K 线
  r = await rawRequest(base, '/api/hist?code=510300', { cookie });
  (r.status === 200 && r.body.length > 1000) ? ok('/api/hist 510300 → ' + r.body.length + ' 字节') : bad('/api/hist 异常：' + r.status + ' ' + r.body.length);

  // 份额：清单第 12 列 + 点开的柱状图。没生成时只提示，不判红（本地没跑过 pipeline）
  r = await rawRequest(base, '/api/shares', { cookie });
  const jsh = r.json();
  if (jsh && jsh.code === 'NO_SHARES') {
    ok('/api/shares 还没生成（跳过明细）');
  } else if (!jsh || !jsh.ok) {
    bad('/api/shares 异常：' + r.status + ' ' + ((jsh && jsh.error) || r.body.slice(0, 60)));
  } else {
    const ax = jsh.ax || [];
    const nC = Object.keys(jsh.c || {}).length;
    (ax.length >= 60 && nC > 1000)
      ? ok('/api/shares 轴 ' + ax.length + ' 天 · ' + nC + ' 只 · 截至 ' + jsh.d)
      : bad('/api/shares 结构不对：轴 ' + ax.length + ' 天、' + nC + ' 只');
    const s5 = (jsh.c || {})['510300'];
    (s5 > 100 && s5 < 2000) ? ok('510300 份额 ' + s5 + ' 亿份') : bad('510300 份额异常：' + s5);

    r = await rawRequest(base, '/api/shares?code=510300', { cookie });
    const jone = r.json();
    (jone && jone.ok && Array.isArray(jone.v) && jone.v.length === ax.length)
      ? ok('单只份额 510300 → ' + jone.v.length + ' 天')
      : bad('/api/shares?code=510300 异常：' + r.status + ' ' + r.body.slice(0, 60));

    r = await rawRequest(base, '/api/shares?code=abc', { cookie });
    const jbad = r.json();
    (jbad && jbad.ok === false) ? ok('非法 code 被挡住') : bad('非法 code 没被挡住');
  }

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
  // 门槛只用来确认「不是一个空壳」，不能写死 30：开盘前半小时本来就只有二十来个点，
  // 写死 30 会让 9:30–10:00 之间每次自检都误报失败。
  if (jm && jm.ok && Array.isArray(jm.pts) && jm.pts.length >= 2) {
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

  // 成分穿透：持仓（季报）与行情（实时）是两条链路，边界最容易翻车
  let jh = null;
  for (let i = 0; i < 2 && !(jh && jh.ok); i++) {
    if (i) await new Promise((res) => setTimeout(res, 1200));
    r = await rawRequest(base, '/api/hold?code=510300', { cookie });
    jh = r.json();
  }
  if (jh && jh.ok && Array.isArray(jh.rows) && jh.rows.length) {
    ok('/api/hold 510300 → ' + jh.rows.length + ' 只 / 权重合计 ' + jh.wsum + '% / ' + jh.asof);
    if (!(jh.wsum > 0 && jh.wsum <= 100)) bad('/api/hold 权重合计越界：' + jh.wsum);
    const badH = jh.rows.find((x) => !x.c || !x.n || !(x.w > 0));
    badH ? bad('/api/hold 有异常行：' + JSON.stringify(badH).slice(0, 120))
      : ok('/api/hold 每行含代码 / 名称 / 权重');
    // 贡献必须等于 权重 × 涨跌。这两列会被拿来横向相加，差一点就会被当成算错
    const badC = jh.rows.find((x) => x.ctr != null && Math.abs(x.ctr - (x.w * x.chg) / 100) > 0.01);
    badC ? bad('/api/hold 贡献口径不一致：' + JSON.stringify(badC).slice(0, 120))
      : ok('/api/hold 贡献 = 权重 × 涨跌');
  } else {
    bad('/api/hold 失败：' + r.text.slice(0, 160));
  }

  r = await rawRequest(base, '/api/hold?code=__bad__', { cookie });
  const jhb = r.json();
  (jhb && jhb.ok === false) ? ok('/api/hold 非法 code 被拒') : bad('/api/hold 非法 code 没拒');

  /* 非龙头必须还能出成分：预热收窄只影响快慢，不影响有没有。
     510310 与 510300 同属沪深300，但成交额小得多，按新规则不进预热清单。 */
  r = await rawRequest(base, '/api/hold?code=510310', { cookie, timeout: 30000 });
  const j310 = r.json();
  if (j310 && j310.ok && Array.isArray(j310.rows) && j310.rows.length > 50) {
    ok('/api/hold 非龙头 510310 → ' + j310.rows.length + ' 只 / ' + (j310.src || '?')
      + ' / 权重 ' + j310.wsum + '%');
  } else {
    bad('/api/hold 非龙头 510310 拿不到成分：' + r.text.slice(0, 160));
  }

  // 交易所 PCF：口径变了就要能看出来，不然「前 20 大 26%」和「全部 279 只 100%」
  // 混在一起，看的人会以为某天算错了
  if (jh && jh.ok) {
    if (jh.src === 'pcf') {
      ok('/api/hold 走交易所 PCF（' + (jh.ex || '?') + ' · ' + jh.day + '）');
      Math.abs(jh.wsum - 100) < 0.5
        ? ok('/api/hold PCF 权重合计归一化到 100%')
        : bad('/api/hold PCF 权重合计 ' + jh.wsum + '，应为 100');
      // 归一化之后，各成分贡献相加就应当逼近 ETF 自己的涨跌幅
      const sumCtr = jh.rows.reduce((a, x) => a + (x.ctr || 0), 0);
      Math.abs(sumCtr) < 30
        ? ok('/api/hold 全部成分贡献合计 ' + sumCtr.toFixed(2) + ' 个百分点')
        : bad('/api/hold 贡献合计异常：' + sumCtr.toFixed(2));
    } else {
      bad('/api/hold 没走 PCF，退回 ' + (jh.src || '?') + '：' + (jh.pcfErr || '-'));
    }
  }

  // 自选「主要贡献」：批量、跨市场、按 |贡献| 取前三
  r = await rawRequest(base, '/api/top3?codes=510300,512480,159919,513180', { cookie });
  const jt = r.json();
  if (jt && jt.ok && jt.rows) {
    const ks = Object.keys(jt.rows);
    const okKs = ks.filter((k) => jt.rows[k].ok);
    (okKs.length === ks.length)
      ? ok('/api/top3 ' + ks.length + ' 只全部返回（沪 / 深 / 港）')
      : bad('/api/top3 失败：' + ks.filter((k) => !jt.rows[k].ok).join(','));
    const over = okKs.find((k) => (jt.rows[k].items || []).length > 3);
    over ? bad('/api/top3 ' + over + ' 超过 3 只') : ok('/api/top3 每只最多 3 条');
    const badIt = okKs.map((k) => (jt.rows[k].items || []).find((x) => !x.n || !x.c || typeof x.ctr !== 'number'))
      .find(Boolean);
    badIt ? bad('/api/top3 有异常条目：' + JSON.stringify(badIt).slice(0, 100))
      : ok('/api/top3 每条含名称 / 代码 / 贡献');
    // 排序必须是「绝对值降序」，否则跌的时候前三只全是涨的，等于没给信息
    const badSort = okKs.find((k) => {
      const a = (jt.rows[k].items || []).map((x) => Math.abs(x.ctr));
      for (let i = 1; i < a.length; i++) if (a[i] > a[i - 1] + 1e-9) return true;
      return false;
    });
    badSort ? bad('/api/top3 ' + badSort + ' 未按 |贡献| 降序') : ok('/api/top3 按 |贡献| 降序');
  } else {
    bad('/api/top3 失败：' + r.text.slice(0, 160));
  }

  r = await rawRequest(base, '/api/top3?codes=__bad__', { cookie });
  const jtb = r.json();
  (jtb && jtb.ok === false) ? ok('/api/top3 非法 codes 被拒') : bad('/api/top3 非法 codes 没拒');

  /* PCF 每日预热：这是「盘中不现场拉清单」的前提，所以至少得证明两件事——
     一轮跑得动（能取列表、能写分片），以及连跑两轮游标会往前推。 */
  let w1 = null, w2 = null;
  r = await rawRequest(base, '/api/pcfwarm', { cookie, timeout: 40000 });
  w1 = r.json();
  if (w1 && w1.ok) {
    ok('/api/pcfwarm 一轮：' + JSON.stringify({
      i: w1.i, n: w1.n, got: w1.got, wrote: w1.wrote,
      built: !!w1.built, done: !!w1.done, pday: w1.pday || '',
    }));
    /* 归并后的清单量级：全市场 1600+、按指数去重后 400~500 组。低于 300 说明
       映射错把一堆不同指数并成了一个（那比不归并更糟：并错的那只永远不预热）。 */
    if (!(w1.n > 300)) bad('/api/pcfwarm 的清单只有 ' + w1.n + ' 只，归并后应该还有四五百组');
    /* 同指数只留龙头：清单必须比市场总数明显少，且组数不超过清单长度。
       两个数只在建计划那一轮返回，命中已有计划的轮次就跳过这条。 */
    if (w1.all) {
      (w1.all > w1.n && w1.grp <= w1.n && w1.dropped === w1.all - w1.grp)
        ? ok('/api/pcfwarm 按跟踪指数归并：' + w1.all + ' 只 → ' + w1.grp + ' 组 → 预热 ' + w1.n
          + ' 只（' + w1.exact + ' 只落在同指数多只的组里）')
        : bad('/api/pcfwarm 归并数目对不上：' + JSON.stringify({ all: w1.all, grp: w1.grp, n: w1.n, dropped: w1.dropped }));
      if (!(w1.exact > w1.all * 0.6)) {
        bad('/api/pcfwarm 只有 ' + w1.exact + '/' + w1.all + ' 只走指数映射，各成一组的太多');
      }
    }
    await new Promise((res) => setTimeout(res, 1200));
    r = await rawRequest(base, '/api/pcfwarm', { cookie, timeout: 40000 });
    w2 = r.json();
    if (!(w2 && w2.ok)) bad('/api/pcfwarm 第二轮失败：' + r.text.slice(0, 160));
    else if (w2.done) ok('/api/pcfwarm 第二轮：当天已预热完（done）');
    else if (w2.i > w1.i) ok('/api/pcfwarm 游标前进 ' + w1.i + ' → ' + w2.i + '/' + w2.n);
    // 探测到今日清单刚发布时，游标会归零重抓，不算异常
    else if ((w2.refresh || 0) > (w1.refresh || 0)) {
      ok('/api/pcfwarm 探测到新清单，游标归零重抓：' + w1.i + ' → ' + w2.i + '（第 ' + w2.refresh + ' 次）');
    } else bad('/api/pcfwarm 连跑两轮游标没动：' + JSON.stringify(w2));
  } else {
    bad('/api/pcfwarm 失败：' + r.text.slice(0, 160));
  }

  // 隔夜行情：美股批量 + 外盘期货 + 亚太指数，赛道映射在前端做，这里只验行情本身
  r = await rawRequest(base, '/api/overnight', { cookie });
  const on = r.json();
  if (on && on.ok) {
    const nUs = Object.keys(on.us || {}).length;
    const nFut = Object.keys(on.fut || {}).length;
    const nAsia = (on.asia || []).length;
    ok('/api/overnight 美股 ' + nUs + ' 只 · 期货 ' + nFut + ' 个 · 亚太 ' + nAsia + ' 个');
    if (nUs < 40) bad('/api/overnight 美股少于 40 只，赛道均涨跌会失真');
    const nv = (on.us || {}).usnvda;
    if (!nv || !isFinite(nv.chg)) bad('/api/overnight 缺英伟达或涨跌幅非法');
    if (nFut === 0) bad('/api/overnight 期货全空（东财+新浪两条都挂了，只影响期货行不影响主数据）');
    /* 亚太 6 只里只有 KOSPI 是单源：腾讯对新浪那套外盘代码一律 pv_none_match，
       新浪 int_kospi 是空壳，能在东财之外给韩国指数报价的源没找到。所以判据拆开：
       5 只是底线（上证/科创50/创业板指/恒生科技/日经，都有换厂商的备源），
       第 6 只（KOSPI）缺失只记一行，不算失败。 */
    if (nAsia < 5) bad('/api/overnight 亚太不足 5 个（现 ' + nAsia + '）');
    else if (nAsia < 6) console.log('  · 亚太 5 只：韩国 KOSPI 只有东财一个源，这轮没取到');
  } else bad('/api/overnight 失败：' + r.text.slice(0, 160));

  // 分时代理：secid 白名单 + 最近一个完整时段
  //
  // 主用例用上证而不是日经：上证东财和腾讯都覆盖，能稳定回答「这条链路活着吗」。
  // 日经只有东财一个源（腾讯没有日经代码，新浪外盘分时接口 404），东财整段抽风
  // 时它会红，红得还不是代码的问题——降级成下面那条信息项。
  r = await rawRequest(base, '/api/ovmin?sid=1.000001', { cookie });
  const ovm = r.json();
  if (ovm && ovm.ok) {
    ok('/api/ovmin 上证分时 ' + (ovm.pts || []).length + ' 点（' + ((ovm.pts || [['']])[0][0] || '') + ' 起）· 昨收 ' + ovm.pre
      + (ovm.src ? ' · 源 ' + ovm.src : ''));
    // 阈值不能写死 50：早八点半跑自检时集合竞价刚结束，只有个位数点。
    // 10 点 = 已交易满 10 分钟，够区分「接口坏了」和「刚开盘」
    if (!ovm.pts || ovm.pts.length < 10) bad('/api/ovmin 分时点数过少');
    // 左轴涨跌幅要靠这个数当 0 轴，缺了就只能退回开盘价，和卡片上的涨跌幅对不上
    if (!(ovm.pre > 0)) bad('/api/ovmin 没带 pre（昨收），纵轴涨跌幅会退回「本时段开盘」口径');
    else {
      const fp = ovm.pts[0][1];
      if (Math.abs(ovm.pre / fp - 1) > 0.25) bad('/api/ovmin pre 与首点偏离超过 25%，像是拿错了字段');
    }
  } else bad('/api/ovmin 失败：' + r.text.slice(0, 160));
  // 信息项（不计入通过率）：日经只有一个源，挂了不代表接口有问题
  r = await rawRequest(base, '/api/ovmin?sid=100.N225', { cookie });
  {
    const jp = r.json();
    if (jp && jp.ok) console.log('  · 日经分时 ' + (jp.pts || []).length + ' 点');
    else console.log('  · 日经分时不可用（该市场只有东财一个源）');
  }
  // 白名单负例：A 股「个股」仍必须拒绝（指数已放行给亚太行，个股走 K 线面板）
  r = await rawRequest(base, '/api/ovmin?sid=1.600519', { cookie });
  if (r.status === 200 && r.json().ok) bad('/api/ovmin 白名单失效：A 股个股 secid 竟然放行了');

  /* 赛道成分股（美股个股）能不能点开，取决于两件事同时成立：
     ① 前端 ON_USID 把每只代码映射成了东财 secid（猜错前缀 = 上游 200 空体）；
     ② 后端白名单放行 105/106 这两个市场号。
     先做静态核对——45 只逐个打靶成本太高（且上游偶发 RST），映射表本身
     是探测出来的，用静态断言保证「新加标的没忘配 secid」就够了。 */
  {
    const pg = fs.readFileSync(path.join(SRC, 'page.js'), 'utf8');
    const m = pg.match(/var ON_TRACKS = \[([\s\S]*?)\n\];/);
    const u = pg.match(/var ON_USID = \{([\s\S]*?)\n\};/);
    if (!m || !u) bad('page.js 里找不到 ON_TRACKS 或 ON_USID，赛道成分股可能整块失效');
    else {
      const tracks = new Set();
      for (const g of m[1].matchAll(/us:\[([^\]]*)\]/g)) {
        for (const s of g[1].matchAll(/'([A-Z]{1,5})'/g)) tracks.add(s[1]);
      }
      const ids = {};
      for (const g of u[1].matchAll(/([A-Z]{1,5})\s*:\s*'(\d{3}\.[A-Z.]{1,8})'/g)) ids[g[1]] = g[2];
      const miss = [...tracks].filter((s) => !ids[s]);
      const wrongPfx = Object.entries(ids).filter(([, v]) => !/^(105|106|107)\./.test(v));
      ok('赛道成分股 ' + tracks.size + ' 只，已配 secid ' + Object.keys(ids).length + ' 只');
      if (miss.length) bad('这些赛道成分股没有 secid，点了会「读取失败」：' + miss.join(' '));
      if (wrongPfx.length) bad('secid 前缀不是美股市场号：' + wrongPfx.map((x) => x[0] + '=' + x[1]).join(' '));
    }
  }
  // 接口正例：挑一只 105、一只 106（市场号不同，别只测一边）
  for (const [sid, nm] of [['105.NVDA', '英伟达'], ['106.TSM', '台积电']]) {
    r = await rawRequest(base, '/api/ovmin?sid=' + sid, { cookie });
    const m1 = r.json();
    if (m1 && m1.ok) ok('/api/ovmin ' + nm + ' 分时 ' + (m1.pts || []).length + ' 点 · 昨收 ' + m1.pre);
    else { bad('/api/ovmin ' + nm + ' 失败：' + r.text.slice(0, 140)); continue; }
    if (!(m1.pre > 0)) bad('/api/ovmin ' + nm + ' 没带 pre');
    r = await rawRequest(base, '/api/ovk?sid=' + sid + '&n=160', { cookie });
    const k1 = r.json();
    if (k1 && k1.ok) {
      const bs = k1.bars || [];
      ok('/api/ovk ' + nm + ' 日线 ' + bs.length + ' 根 · ' + (bs[0] || [''])[0] + ' → ' + (bs[bs.length - 1] || [''])[0]);
      if (bs.length < 60) bad('/api/ovk ' + nm + ' 日线太短（' + bs.length + '）');
      // 美股最后一根必须是「最近一个已收盘交易日」，不能是空的或未来
      const lastD = (bs[bs.length - 1] || [''])[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastD)) bad('/api/ovk ' + nm + ' 末根日期格式不对：' + lastD);
    } else bad('/api/ovk ' + nm + ' 失败：' + r.text.slice(0, 140));
  }

  /* 日经/韩国日线只靠 CNBC 一家（腾讯没这两个代码、新浪外盘日线不认它们），
     回归时最容易静默失败——上一次就是分时补好了、日线漏着，点「K 线」直接
     报「上游取不到」。这里钉死「根数够 + 末根有收盘价」。 */
  for (const [sid, nm] of [['100.N225', '日经225'], ['100.KS11', '韩国KOSPI']]) {
    r = await rawRequest(base, '/api/ovk?sid=' + sid + '&n=160', { cookie });
    const kd = r.json();
    if (kd && kd.ok) {
      const bs = kd.bars || [];
      const lastB = bs[bs.length - 1] || [];
      ok('/api/ovk ' + nm + ' 日线 ' + bs.length + ' 根 · ' + (bs[0] || [''])[0] + ' → ' + (lastB[0] || ''));
      if (bs.length < 60) bad('/api/ovk ' + nm + ' 日线太短（' + bs.length + '）');
      if (!(lastB[4] > 0)) bad('/api/ovk ' + nm + ' 末根收盘价为空，像是聚合出错');
    } else bad('/api/ovk ' + nm + ' 失败：' + r.text.slice(0, 140));
  }

  // 期指基差：口径对不对，只能靠恒等式核对——基差 = 期货 − 现货，年化 = 基差率×365/天数
  r = await rawRequest(base, '/api/fut', { cookie });
  const fu = r.json();
  if (fu && fu.ok) {
    const fl = fu.fut || [], ol = fu.opt || [];
    ok('/api/fut ' + fu.td + ' 期货 ' + fl.length + ' 行 · 期权 ' + ol.length + ' 行 · src=' + fu.src + (fu.stale ? '（降级）' : ''));
    if (fl.length < 12) bad('/api/fut 期货合约过少（' + fl.length + '），至少应覆盖 4 品种 × 3 个月');
    if (ol.length < 9) bad('/api/fut 期权合成行过少（' + ol.length + '）');
    if (Object.keys(fu.spot || {}).length < 4) bad('/api/fut 现货指数不足 4 个');
    // 昨收基准是哪天，页面要把它印出来。丢了或格式不对，那行字会直接空掉，
    // 而「基准慢一天」恰恰是最难靠肉眼发现的那种错
    if (!fu.prevTd) ok('/api/fut 没有 prevTd（快照是旧格式，Δ基差率与增减仓会空着）');
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(fu.prevTd)) bad('/api/fut prevTd 格式不对：' + fu.prevTd);
    else if (fu.prevTd > fu.td) bad('/api/fut prevTd(' + fu.prevTd + ') 晚于 td(' + fu.td + ')');

    let basisBad = 0, annBad = 0, rangeBad = 0;
    for (const x of fl) {
      if (!(x.px > 0)) { basisBad++; continue; }
      const sp = (fu.spot || {})[x.u];
      if (sp && x.basis != null && Math.abs(x.basis - (x.px - sp.p)) > 0.05) basisBad++;
      if (sp && x.ann != null && x.bp != null && x.dte >= 3
          && Math.abs(x.ann - x.bp * 365 / x.dte) > 0.05) annBad++;
      if (x.bp != null && Math.abs(x.bp) > 15) rangeBad++;
    }
    if (basisBad) bad('/api/fut 有 ' + basisBad + ' 行「基差点数 ≠ 期货 − 现货」，口径串了');
    if (annBad) bad('/api/fut 有 ' + annBad + ' 行年化和基差率对不上（应为 bp×365/dte）');
    if (rangeBad) bad('/api/fut 有 ' + rangeBad + ' 行基差率超过 ±15%，多半拿错了现货');

    let optBad = 0;
    for (const o of ol) {
      if (!(o.syn > 0) || o.n < 2) optBad++;
      else if (o.fb != null && Math.abs(o.fb / o.syn) > 0.05) optBad++;
    }
    if (optBad) bad('/api/fut 有 ' + optBad + ' 行期权合成异常（档数不足或与期货差超 5%）');
  } else bad('/api/fut 失败：' + r.text.slice(0, 200));

  // ETF 期权：main / rest 两批，参数写错必须回落到 main，不能 500
  r = await rawRequest(base, '/api/futopt?g=main', { cookie });
  const fo = r.json();
  if (fo && fo.ok) {
    const it = fo.items || [];
    ok('/api/futopt?g=main ' + it.length + ' 个标的 · 近月档数 ' + it.map((x) => ((x.months || [])[0] || {}).n).join('/'));
    if (it.length < 3) bad('/api/futopt 主标的不足 3 个（' + it.length + '）');
    // 换源后应当走新浪且带回行情日期；退回东财时 src 是 'em'，那是降级不是常态，
    // 一旦常驻说明新浪又断了
    if (fo.src !== 'sina') bad('/api/futopt 没走新浪（src=' + fo.src + '），可能已降级');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fo.td || ''))) bad('/api/futopt 缺行情日期 td');
    for (const x of it) {
      const m = (x.months || [])[0];
      if (!m || !(m.n >= 2)) bad('/api/futopt ' + x.c + ' 近月配对档数不足');
      if (!(x.S > 0)) bad('/api/futopt ' + x.c + ' 缺标的现价');
      // 一档行权价在低价标的上就占 2~4%，配错档会算出这个量级的假贴水
      if (m && Math.abs(m.bp) > 5) bad('/api/futopt ' + x.c + ' 近月基差率 ' + m.bp + '% 离群');
    }
  } else bad('/api/futopt 失败：' + r.text.slice(0, 200));
  r = await rawRequest(base, '/api/futopt?g=%E4%B9%B1%E5%86%99', { cookie });
  const fo2 = r.json();
  if (!(fo2 && fo2.ok && fo2.g === 'main')) bad('/api/futopt 参数非法时没有回落到 main');

  // 250 天基线：数组必须和日期等长，否则前端按索引取会串到隔壁那天
  r = await rawRequest(base, '/api/futhist', { cookie });
  const fh = r.json();
  if (fh && fh.ok) {
    const n = (fh.d || []).length;
    ok('/api/futhist ' + n + ' 天（' + (fh.d || [''])[0] + ' ~ ' + (fh.d || [''])[n - 1] + '）');
    if (n < 60) bad('/api/futhist 历史只有 ' + n + ' 天，分位会失真');
    let mis = 0;
    for (const grp of ['fut', 'opt', 'pos']) {
      for (const p of Object.keys(fh[grp] || {})) {
        for (const k of Object.keys(fh[grp][p])) {
          if ((fh[grp][p][k] || []).length !== n) mis++;
        }
      }
    }
    if (mis) bad('/api/futhist 有 ' + mis + ' 条数组长度和日期对不上');
    const cur = ((fh.fut || {}).IF || {}).cmp || [];
    const last = cur[cur.length - 1];
    if (last == null) bad('/api/futhist IF 的 30 天恒定基差在最新一天是空的');
    else if (Math.abs(last) > 15) bad('/api/futhist IF 最新基差率 ' + last + '% 离群');
    /* ETF 期权那一组：只允许真近月，所以 dte 不该超过 40 天——一旦有人把「当天
       最短可用合约」改回去（历史上常常是隔季），这条会立刻炸。 */
    const eh = fh.eh || {};
    const etfCodes = Object.keys(eh.s || {});
    if (!etfCodes.length) bad('/api/futhist 没带 ETF 期权历史（eh.s 为空）');
    else {
      const daysOf = etfCodes.map((c) => (eh.s[c].nb || []).filter((x) => x != null).length);
      ok('/api/futhist ETF 期权近月 ' + etfCodes.length + ' 个标的 · 各 ' + daysOf.join('/') + ' 天');
      for (const c of etfCodes) {
        const dts = (eh.s[c].nd || []).filter((x) => x != null);
        if (dts.length && Math.max(...dts) > 40) bad(c + ' 的 dte 到 ' + Math.max(...dts) + ' 天，不像当月合约');
      }
    }
  } else bad('/api/futhist 失败：' + r.text.slice(0, 200));

  // 状态
  r = await rawRequest(base, '/api/status', { cookie });
  const js = r.json();
  if (js && js.ok) {
    const b = js.bindings || {};
    ok('/api/status bindings=' + JSON.stringify(b) + ' hist=' + (js.hist && js.hist.last_trade_date));
    if (!b.r2 && !b.gh) bad('/api/status 显示没有历史数据源');
    if (!b.kv) bad('/api/status 显示 KV 未绑定（自选不会持久）');
  } else bad('/api/status 失败：' + r.text.slice(0, 160));

  // 全 A 集中度 × 宽度：宽度必须是逐只个股，不是行业口径；
  // 集中度按 EM2016 三级行业（244 个）加总，不再是申万二级那 128 个。
  r = await rawRequest(base, '/api/mkt', { cookie });
  const mk = r.json();
  if (mk && mk.ok) {
    const su = mk.stockUp | 0, sd = mk.stockDn | 0;
    const bExpect = (su + sd) > 0 ? su / (su + sd) * 100 : 0;
    ok('/api/mkt ' + mk.d + ' 集中 ' + mk.c + '% · 宽度 ' + mk.b + '%（' + su + ' 涨 ' + sd + ' 跌）');

    /* 盘中这条路：mode 决定前端怎么标日期。
       live 必须是「今天 + 带时刻 + 历史里没有今天」——历史若也留着今天，
       散点会在同一个坐标叠两个点，看着像重影。 */
    const mode = mk.mode || 'close';
    if (!['live', 'snap', 'close'].includes(mode)) bad('/api/mkt mode 取值异常：' + mode);
    else ok('/api/mkt mode=' + mode + (mk.snapAt ? ' @' + mk.snapAt : '') + ' src=' + mk.src);
    if (mk.cVer !== 'em2016-l3') bad('/api/mkt 口径版本不对：' + mk.cVer);
    if (mode !== 'close') {
      if (!/^\d{2}:\d{2}$/.test(mk.snapAt || '')) bad('/api/mkt ' + mode + ' 模式缺时刻 snapAt');
      if (mk.hist && mk.hist.d && mk.hist.d[mk.hist.d.length - 1] === mk.d) {
        bad('/api/mkt 实时值那天也留在历史里了，散点会叠点');
      }
    }
    const inds = (mk.hist && mk.hist.ind) || [];
    if ((mk.top3 || []).length) {
      const miss = mk.top3.filter((x) => inds.indexOf(x) < 0);
      if (miss.length) bad('/api/mkt top3 不在行业名表里：' + miss.join('、'));
      else ok('/api/mkt TOP3 ' + mk.top3.join('、'));
      /* 名字必须带涨跌幅和成交额：只给名字的「成交额前三」会被读成「这三个在涨」。
         三个数组等长是前端并排渲染的前提，缺一个就少一列数字。
         三种模式都要求：close 读的是日档里的 t3p/t3a（管线落盘），
         live/snap 读的是 aggLive 现算的。哪一路缺了，界面上就是三个裸名字。 */
      if (!Array.isArray(mk.t3p) || mk.t3p.length !== mk.top3.length
        || !Array.isArray(mk.t3a) || mk.t3a.length !== mk.top3.length) {
        bad('/api/mkt ' + mk.mode + ' 模式 t3p/t3a 与 top3 不等长：'
          + JSON.stringify([mk.top3, mk.t3p, mk.t3a]));
      } else if (mk.t3p.some((v) => typeof v !== 'number' || Math.abs(v) > 25)) {
        bad('/api/mkt t3p 数值异常：' + JSON.stringify(mk.t3p));
      } else {
        ok('/api/mkt ' + mk.mode + ' TOP3 带涨幅 '
          + mk.t3p.map((v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%').join(' / ')
          + ' · 成交 ' + mk.t3a.join(' / ') + ' 亿');
      }
      // 日档也要能回答「那天钱压在哪条线」：没有 hist.t3p，历史点就只有名字。
      if (mk.hist && mk.hist.t3p && mk.top3.length) {
        const n3 = mk.hist.t3p.length;
        if (n3 !== (mk.hist.d || []).length) {
          bad('/api/mkt hist.t3p 天数与 hist.d 不一致：' + n3 + ' vs ' + (mk.hist.d || []).length);
        } else {
          ok('/api/mkt hist.t3p ' + n3 + ' 天 · 末条 '
            + JSON.stringify(mk.hist.t3p[n3 - 1]));
        }
      } else if (mk.mode === 'close' || (mk.hist && mk.hist.d)) {
        bad('/api/mkt 缺 hist.t3p：历史点会只剩行业名，没有涨跌');
      }
    }
    // 这一条是防回退的：上一版 b 用的是 upInd/n（行业口径），
    // 数字看着也像模像样，只是系统性偏低一半。
    if (Math.abs(mk.b - bExpect) > 0.05) {
      bad('/api/mkt 宽度不是个股口径：b=' + mk.b + '，按 stockUp/(stockUp+stockDn) 应为 '
        + bExpect.toFixed(2) + '（行业口径会明显偏低）');
    }
    if (su + sd < 3000) bad('/api/mkt 个股家数异常偏少 ' + (su + sd));
    if (!(mk.c > 5 && mk.c < 90)) bad('/api/mkt 集中度越界 ' + mk.c + '%');
    const h = mk.hist;
    if (h && h.d && h.u && h.w) {
      if (h.u.length === h.d.length && h.w.length === h.d.length) {
        const li = h.d.length - 1;
        ok('/api/mkt 历史 ' + h.d.length + ' 天，末点 ' + h.d[li] + ' '
          + h.u[li] + ' 涨 ' + h.w[li] + ' 跌');
        const hb = (h.u[li] + h.w[li]) > 0 ? h.u[li] / (h.u[li] + h.w[li]) * 1000 : 0;
        if (Math.abs(h.b[li] - hb) > 5) {
          bad('/api/mkt 历史宽度与家数对不上：b=' + h.b[li] + '‰，应为 ' + hb.toFixed(0) + '‰');
        }
        if (h.p5 && h.p5.length === h.d.length) {
          const v = h.p5[li] / 10;
          if (!(v > 5 && v < 90)) bad('/api/mkt 个股前5%占比越界 ' + v + '%');
          else ok('/api/mkt 个股前5%成交占比 ' + v.toFixed(1) + '%');
        } else bad('/api/mkt 缺 p5 数组或长度不齐（个股口径集中度）');
      } else bad('/api/mkt 历史 u/w 与日期长度不一致，前端按索引取会错位');
    } else bad('/api/mkt 历史缺少 u/w 家数数组，横轴无法显示个股口径');
  } else bad('/api/mkt 失败：' + r.text.slice(0, 160));

  /* 行业成分股：卡片上点那三个行业名弹出来的名单。
     查的是「反向表和正向表是不是同一份」——名单里的票加起来如果对不上
     行业成交额，说明两张表有一张过期了。 */
  r = await rawRequest(base, '/api/ind?n=' + encodeURIComponent('集成电路'), { cookie });
  const ind = r.json();
  if (ind && ind.ok) {
    const sum = (ind.mem || []).reduce((s, x) => s + x.a, 0);
    ok('/api/ind ' + ind.ind + ' ' + ind.n + ' 只 · 成交 ' + ind.amt + ' 亿 · 加权 '
      + ind.pct + '%（' + ind.up + ' 涨 ' + ind.dn + ' 跌）· 首位 ' + ind.mem[0].n
      + ' ' + ind.mem[0].a + ' 亿');
    if (ind.mem.length !== ind.n) bad('/api/ind 名单条数与 n 不一致：' + ind.mem.length + '/' + ind.n);
    if (Math.abs(sum - ind.amt) > Math.max(1, ind.amt * 0.02)) {
      bad('/api/ind 名单成交额合计 ' + sum.toFixed(1) + ' 亿，与行业 ' + ind.amt + ' 亿对不上');
    }
    if (ind.amt > 0 && !(ind.pct != null && Math.abs(ind.pct) < 30)) {
      bad('/api/ind 加权涨跌幅越界 ' + ind.pct);
    }
    if (ind.up + ind.dn + ind.flat + ind.halt !== ind.n) {
      bad('/api/ind 涨跌家数之和不等于成分股数：'
        + (ind.up + ind.dn + ind.flat + ind.halt) + '/' + ind.n);
    }
    for (let i = 1; i < Math.min(ind.mem.length, 40); i++) {
      if (ind.mem[i].a > ind.mem[i - 1].a) { bad('/api/ind 名单没按成交额降序'); break; }
    }
    const noName = ind.mem.filter((x) => !x.n).length;
    if (noName > 2) bad('/api/ind 有 ' + noName + ' 只没有简称，界面会显示一串代码');
  } else bad('/api/ind 失败：' + r.text.slice(0, 160));

  r = await rawRequest(base, '/api/ind?n=' + encodeURIComponent('这个行业不存在'), { cookie });
  const indBad = r.json();
  if (indBad && indBad.ok === false) ok('/api/ind 未知行业正确拒绝');
  else bad('/api/ind 未知行业应返回 ok:false');

  /* ---- 情绪面板 -----------------------------------------------------------
     这块的数字天生「看起来全都正常」：曾触板只数涨停池会少 35%、跌停拿下界
     去比历史会虚报 150%、0.3pt 的比例容差能把 -9.7% 算成跌停。所以光验接口
     活着没有意义，每条守恒关系都得钉死——错一条就是一张骗人的图。 */
  r = await rawRequest(base, '/api/senti', { cookie });
  const sn = r.json();
  if (sn && sn.ok) {
    ok('/api/senti ' + sn.mode + '：涨停 ' + sn.zt + ' 家、曾触板 ' + sn.touch
      + '、炸板 ' + sn.zb + '、跌停 ' + sn.dt + ' 家、封板率 '
      + (sn.seal == null ? '—' : Math.round(sn.seal * 100) + '%')
      + '、状态 ' + (sn.state || '—'));
    if (sn.mode !== 'live' && sn.mode !== 'close') bad('/api/senti mode 非法：' + sn.mode);
    if (!(sn.zt >= 0) || !(sn.touch >= 0) || !(sn.dt >= 0)) bad('/api/senti 家数出现负数或非数');
    if (sn.zt > sn.touch) bad('/api/senti 涨停 ' + sn.zt + ' > 曾触板 ' + sn.touch + '，口径倒挂');
    if (sn.zb !== sn.touch - sn.zt) {
      bad('/api/senti 炸板 ' + sn.zb + ' ≠ 曾触板 − 涨停 ' + (sn.touch - sn.zt));
    }
    if (sn.n != null && (sn.touch > sn.n || sn.dt > sn.n)) {
      bad('/api/senti 家数超过有效成交 ' + sn.n + ' 只（停牌没挡住？）');
    }

    if (sn.touch > 0) {
      const wantSeal = sn.zt / sn.touch;
      if (sn.seal == null) bad('/api/senti 有曾触板却没给封板率');
      else if (Math.abs(sn.seal - wantSeal) > 0.005) {
        bad('/api/senti 封板率 ' + sn.seal + ' 与 zt/touch ' + wantSeal.toFixed(3) + ' 对不上');
      }
    } else if (sn.seal != null) bad('/api/senti 曾触板为 0 却给了封板率 ' + sn.seal);

    const tiers = (sn.ladder && sn.ladder.t) || [];
    const tierSum = tiers.reduce((x, y) => x + (y || 0), 0);
    if (tierSum !== sn.zt) {
      bad('/api/senti 梯队各板合计 ' + tierSum + ' ≠ 涨停 ' + sn.zt + '（有票没进梯队）');
    }
    if (tiers.length && (sn.ladder.mx > 0) !== (sn.zt > 0)) {
      bad('/api/senti 最高板 ' + sn.ladder.mx + ' 与涨停家数 ' + sn.zt + ' 不自洽');
    }

    if (sn.prem) {
      const p = sn.prem;
      if (!(p.n > 0)) bad('/api/senti 昨日涨停池样本 n=' + p.n);
      if (!(p.red >= 0 && p.red <= 100)) bad('/api/senti 红盘率越界 ' + p.red);
      if (!(p.big >= 0 && p.big <= 100)) bad('/api/senti 大面率越界 ' + p.big);
      if (p.mid != null && Math.abs(p.mid) > 30) bad('/api/senti 中位涨幅越界 ' + p.mid);
      if (p.promo > p.n) bad('/api/senti 晋级 ' + p.promo + ' > 昨涨停池 ' + p.n);
      if (p.touchN > p.n || p.touchN < p.promo) {
        bad('/api/senti 昨涨停池曾触板 ' + p.touchN + ' 不在 [' + p.promo + ', ' + p.n + '] 内');
      }
    }
    if (sn.yprem && !(sn.yprem.red >= 0 && sn.yprem.red <= 100
      && sn.yprem.still >= 0 && sn.yprem.still <= 100)) {
      bad('/api/senti 昨跌停池比例越界 ' + JSON.stringify(sn.yprem));
    }

    const ST = ['冰点', '退潮', '分歧', '修复', '发酵', null];
    if (!ST.includes(sn.state)) bad('/api/senti 状态灯出现未知档位：' + sn.state);
    if (sn.state && !(Array.isArray(sn.why) && sn.why.length)) bad('/api/senti 有档位却没给理由');
    /* 这两条是修过的错，改回去会立刻在这里现形：跌停池只有 lbt 没有 fbt，
       拿下界当同刻基准会把常态说成恐慌（11-13 实测虚报 150%）。 */
    if ('refSealed' in sn || 'refDt' in sn) {
      bad('/api/senti 又出现 refSealed/refDt：跌停下来自池子的下界，不可作同刻基准');
    }
    if (sn.mode === 'close' && sn.ref) bad('/api/senti 收盘态不该有同刻基准');

    /* 一字 / T字 / 换手是按同一批涨停分的类，三者之和必须正好等于涨停家数。
       漏一只就说明判定分支有洞（f16/f17 缺失时没落到 else 是最常见的那个）。 */
    if (sn.form) {
      const fs2 = sn.form.yz + sn.form.tz + sn.form.hs;
      if (fs2 !== sn.zt) bad('/api/senti 一字+T字+换手 = ' + fs2 + '，与涨停 ' + sn.zt + ' 不符');
    } else if (sn.src === 'sina') {
      bad('/api/senti 现算路径没返回涨停形态（sina 的 f16/f17 没带上？）');
    }
    if (sn.zbHold != null && sn.zbHold > sn.zb) {
      bad('/api/senti 炸而未崩 ' + sn.zbHold + ' > 炸板 ' + sn.zb);
    }
    if (sn.ind) {
      if (sn.ind.length > 3) bad('/api/senti 涨停行业给了 ' + sn.ind.length + ' 个（应 ≤3）');
      for (let i = 1; i < sn.ind.length; i++) {
        if (sn.ind[i].c > sn.ind[i - 1].c) { bad('/api/senti 涨停行业没按家数降序'); break; }
      }
      if (sn.indTop3 > sn.zt) bad('/api/senti 前三行业合计 ' + sn.indTop3 + ' > 涨停 ' + sn.zt);
    } else if (sn.src === 'sina') {
      bad('/api/senti 现算路径没返回涨停行业分布');
    }
    /* 分层是「昨日涨停池」按板数切开，切开后不能多也不能少——多一只说明有些票
       被算进了两组，少一只说明 lbY 取到 0 的票被两边都漏掉了。 */
    if (sn.prem && sn.prem.lb) {
      const L2 = sn.prem.lb;
      if (L2.n1 + L2.n2 !== sn.prem.n) {
        bad('/api/senti 分层 ' + L2.n1 + '+' + L2.n2 + ' ≠ 昨涨停池 ' + sn.prem.n);
      }
      for (const k of ['red1', 'red2']) {
        if (L2[k] != null && !(L2[k] >= 0 && L2[k] <= 100)) bad('/api/senti 分层红盘率越界 ' + L2[k]);
      }
    } else if (sn.mode === 'live') {
      bad('/api/senti 盘中没返回板数分层（首板和高位板混在一起看，会把结论读反）');
    }
    if (sn.pct) {
      for (const k of ['red', 'big', 'promo']) {
        if (sn.pct[k] != null && !(sn.pct[k] >= 0 && sn.pct[k] <= 100)) {
          bad('/api/senti ' + k + ' 分位越界 ' + sn.pct[k]);
        }
      }
    }
    if (sn.trail) {
      if (!Array.isArray(sn.trail.red) || sn.trail.red.length !== sn.trail.d.length) {
        bad('/api/senti 轨迹的日期数与数值数不一致');
      }
      for (const v of sn.trail.red) {
        if (!(v >= 0 && v <= 100)) { bad('/api/senti 轨迹里有越界的红盘率 ' + v); break; }
      }
      /* 盘中最后一点必须是「此刻」，不是上一交易日收盘——接错了就会画出
         「今天已经跌到 12%」而实际此刻是 38%。 */
      if (sn.mode === 'live' && sn.prem) {
        const lastRed = sn.trail.red[sn.trail.red.length - 1];
        if (Math.abs(lastRed - sn.prem.red) > 0.2) {
          bad('/api/senti 轨迹最后一点 ' + lastRed + ' ≠ 今日红盘率 ' + sn.prem.red);
        }
      }
    } else bad('/api/senti 没返回近 20 日轨迹');

    /* 当日曲线。这张图错起来最隐蔽：线还是那条线，只是「今天在历史之上」变成了
       插值出来的错觉，或者末档被未来时点灌满。所以把结构关系钉死。 */
    if (sn.curve) {
      const cv = sn.curve;
      for (const k of ['at', 'today', 'med']) {
        if (!Array.isArray(cv[k]) || cv[k].length !== cv.at.length) {
          bad('/api/senti 曲线 ' + k + ' 与 at 不等长');
        }
      }
      if (cv.at.length < 5) bad('/api/senti 曲线只有 ' + cv.at.length + ' 个时点');
      for (let i = 1; i < cv.at.length; i++) {
        if (!(cv.at[i] > cv.at[i - 1])) { bad('/api/senti 曲线时点没有严格递增'); break; }
      }
      for (let i = 1; i < cv.today.length; i++) {
        if (cv.today[i] < cv.today[i - 1]) { bad('/api/senti 曾触板曲线出现回退（累积量不可能减少）'); break; }
      }
      if (cv.today[cv.today.length - 1] !== sn.touch) {
        bad('/api/senti 曲线末点 ' + cv.today[cv.today.length - 1] + ' ≠ 曾触板 ' + sn.touch);
      }
      if (!(cv.n >= 5)) bad('/api/senti 曲线基准只有 ' + cv.n + ' 天');
      if (!['pool', 'hist'].includes(cv.src)) bad('/api/senti 曲线来源不明 ' + cv.src);
      /* 「今日」不能给自己当基准：末点若与中位完全相等，多半是没把今天剔出去。 */
      const sameDay = cv.today.length === cv.med.length
        && cv.today.every((v, i) => v === cv.med[i]);
      if (sameDay) bad('/api/senti 历史中位与今日曲线逐点相同（基准里含了今天）');
    } else {
      bad('/api/senti 没返回当日曲线（senti_base 里没有这一天，或池子拿不到）');
    }

    /* 曲线那条链是单独的一个端点，慢（两次 push2ex，CF 出口实测 3.5 秒），
       所以必须验它自己站得住——主接口把 curve 置 null 之后，这是唯一来源。 */
    {
      const q = sn.touch > 0 ? '?touch=' + sn.touch : '';
      const cr = await rawRequest(base, '/api/senti/curve' + q, { cookie, timeout: 25000 });
      const cj = cr.json();
      if (cj && cj.ok && cj.curve) {
        const cv = cj.curve;
        if (cj.d !== sn.d) bad('/api/senti/curve 的日期 ' + cj.d + ' ≠ 主接口 ' + sn.d);
        if (cv.today[cv.today.length - 1] !== sn.touch) {
          bad('/api/senti/curve 末点 ' + cv.today[cv.today.length - 1]
            + ' ≠ 曾触板 ' + sn.touch + '（卡片和图会各说一个数）');
        }
        for (let i = 1; i < cv.today.length; i++) {
          if (cv.today[i] < cv.today[i - 1]) { bad('/api/senti/curve 累积量回退'); break; }
        }
        ok('/api/senti/curve 独立可取：' + cv.at.length + ' 档 · 末点 ' + cv.now
          + ' · 基准 ' + cv.n + ' 天 · 来源 ' + cv.src);
      } else {
        bad('/api/senti/curve 取不到：' + ((cj && cj.error) || '空响应'));
      }
    }
  } else bad('/api/senti 失败：' + r.text.slice(0, 160));

  // 三份名单：条数必须和卡片上的家数对得起来，否则「点开数不上」
  for (const kind of ['zt', 'zb', 'dt']) {
    r = await rawRequest(base, '/api/senti?list=' + kind, { cookie });
    const L = r.json();
    if (!L || !L.ok) { bad('/api/senti?list=' + kind + ' 失败：' + r.text.slice(0, 120)); continue; }
    const items = (L.list && L.list.items) || null;
    if (!items) { bad('/api/senti?list=' + kind + ' 没有返回名单'); continue; }
    const cardN = kind === 'zt' ? sn && sn.zt : kind === 'zb' ? sn && sn.zb : sn && sn.dt;
    /* 收盘态是两套数：卡片读历史表（当日收盘回算），名单是现拉一次行情回算。
       同一套规则、同一天，但上游价可能有分位差，容许 2 家以内的出入。 */
    const tol = (sn && sn.mode === 'live') ? 0 : Math.max(2, Math.round((cardN || 0) * 0.05));
    if (cardN != null && Math.abs(items.length - cardN) > tol) {
      bad('/api/senti?list=' + kind + ' 名单 ' + items.length + ' 条，卡片上是 '
        + cardN + ' 家（容差 ' + tol + '）');
    } else ok('/api/senti?list=' + kind + ' ' + items.length + ' 条，与卡片一致');
    const noPx = items.filter((x) => !x.c || !(x.px > 0)).length;
    if (noPx) bad('/api/senti?list=' + kind + ' 有 ' + noPx + ' 条缺代码或价格，点开是空卡');
    const sortKey = kind === 'zt' ? 'seal' : 'a';
    for (let i = 1; i < Math.min(items.length, 40); i++) {
      if ((items[i][sortKey] || 0) > (items[i - 1][sortKey] || 0) + 1e-9) {
        bad('/api/senti?list=' + kind + ' 没按 ' + sortKey + ' 降序（第 ' + i + ' 条）');
        break;
      }
    }
  }

  r = await rawRequest(base, '/', { cookie });
  (r.text.includes('id="sentiCard"') && r.text.includes('sentiOpen('))
    ? ok('首页已拼入情绪卡片与三份名单入口')
    : bad('首页缺情绪卡片：id="sentiCard" / sentiOpen 没拼进来');
  /* 情绪必须是独立区块且进了锚点导航。它挂回板块地图的 A 股分组里也能跑，
     但滚到那块才看得见、折叠 A 股就跟着消失——这属于功能性回退。 */
  (r.text.includes('id="sentiSec"') && r.text.includes('data-t="sentiSec"'))
    ? ok('情绪已独立成区，并排进锚点导航')
    : bad('情绪没有独立区块或没进导航（id="sentiSec" / data-t="sentiSec"）');
  if (!/data-t="onCard">[\s\S]{0,120}data-t="sentiSec"[\s\S]{0,120}data-t="secSec"/.test(r.text)) {
    bad('导航顺序不对：情绪应夹在隔夜与板块地图之间');
  }
  /* 曲线和采样是两段独立的路：曲线靠服务端回算（页面没打开也有），
     采样靠本地记录（补涨停家数，池子算不出「此刻是否封住」）。缺任一段
     卡片都还能看，但那条线会静默地少一层。 */
  (r.text.includes('function curveChart(') && r.text.includes('function sntRecord('))
    ? ok('首页已含当日曲线与本地采样两段')
    : bad('首页缺曲线渲染或采样记录函数');
  /* 横轴必须按交易时间定位。按数组索引排的话，盘中只有 4 档时第 4 档会被
     算在最右边——10:07 的图看起来像「全天走完了，最后一家封在 15:00」，
     而且这一种错在收盘态完全看不出来（收盘正好 17 档，铺满就是对的）。 */
  (r.text.includes('function curvePos(') && r.text.includes('120 + (m - 780)) / 240'))
    ? ok('曲线横轴按交易时间定位（午休不占宽度）')
    : bad('曲线横轴仍按索引排：盘中只画到一半时会铺满全天');
  /* 副图必须自带量纲说明和刻度。它跟上面的累积线同一条 x 轴、同一个红色，
     没有标题和刻度就会被读成「曲线下面的投影」——柱子高度读不出数值，
     参照线不知道是什么，这块图等于没画。这三样少一样，误读就会回来。 */
  (r.text.includes('新增（家 / 15 分钟）') && r.text.includes('灰阶＝历史同期中位')
    && r.text.includes('cvlb'))
    ? ok('曲线副图自带量纲标题、图例与独立刻度')
    : bad('曲线副图缺标题或刻度，柱子会被读成主图的投影');
  /* 午休不能把 x 拽回去。11:31–12:59 落在「下午」公式里会算出比 11:30 还小的
     位置，末点被画回上午——曲线横穿整张图，看着像下午崩了又拉回。 */
  (r.text.includes('if (mins < 780) return 0.5;') && r.text.includes('if (m < 780) return 0.5;'))
    ? ok('午休时段横轴停在 11:30，不往回退')
    : bad('午休时段横轴会倒退：盘中 11:35 打开时曲线横穿全图');
  /* 区间带撑满图幅的问题：hi 超出量程时 y 为负，clip 一裁就是半张灰纸。 */
  (!r.text.includes("fill=\"var(--txt3)\" opacity=\".12\"/>"))
    ? ok('曲线区不再铺 lo–hi 灰带（区间数值改由悬停气泡给）')
    : bad('灰带回来了：hi 超出量程时会把右半张图涂满');
  /* 纵轴定标必须排除首档（09:30–09:35 的集合竞价），否则后面十几根柱全被
     压成贴地的条。首档超量程要顶到边，真实家数由「开盘 +N 家」那句话给。 */
  (r.text.includes('if (i > 0){\n      if (v1 != null && v1 > mxi) mxi = v1;')
    && r.text.includes('开盘 <b>+'))
    ? ok('副图定标排除开盘首档，并在图例给出真实家数')
    : bad('副图定标把开盘首档算进满格：后面各档会被压平');
  /* 「此刻封住」必须是线不是散点。以前它是一串半透明圆点（涨停红点、跌停绿点），
     在这个尺寸上读不出趋势，而且没人知道那些点是什么——第一眼就是「这些点是啥」。
     换成阶梯线之后，它和主曲线同一个读法：两条线的缝就是当天炸掉的量。 */
  (r.text.includes('curvePos(sp[i][0])') && r.text.includes('此刻封住')
    && !r.text.includes('r="1.7" fill="var(--up)"'))
    ? ok('「此刻封住」画成阶梯线并带图例，不再是散点云')
    : bad('「此刻封住」还是散点，或者图例里没说明它是哪条线');
  /* 悬停必须挂在 document 上。挂 svg 上的话，卡片每 30 秒重建一次就断一次，
     而断掉的样子就是「悬停没反应」——和「本来没有这个功能」长得一模一样。 */
  (r.text.includes('function cvHovAt(') && r.text.includes("addEventListener('pointermove'")
    && r.text.includes('cvHovRestore()'))
    ? ok('曲线悬停读点已挂载，且重建后能把气泡接回来')
    : bad('曲线悬停没挂上，或重建后气泡会闪掉');
  /* 采样不能画到主图之外：曲线是几秒前取的那份，采样可能领先一格，
     画出去就是一条尾巴甩到图右边界外面。 */
  (r.text.includes('if (sp[i][0] > lastM) break;'))
    ? ok('本地采样不越出主图终点')
    : bad('采样可能画到主图终点之外');

  r = await rawRequest(base, '/api/mktprobe?t=senti', { cookie });
  const sp = r.json();
  if (sp && sp.ok && sp.got) {
    ok('/api/mktprobe ?t=senti 固定样本对上：涨停 ' + sp.got.zt + '、炸板 ' + sp.got.zb
      + '、跌停 ' + sp.got.dt + '、封板率 ' + sp.got.seal);
    /* diag 数的是「涨幅与涨停价换算值差 0.02pt 以内却没判成涨停」。这个数
       正常恒为 0；一旦 >0 说明 round 到分或 rate 判错，家数会系统性偏少。 */
    if (sp.got.diag !== 0) {
      bad('/api/mktprobe 有 ' + sp.got.diag + ' 只落在涨停容差内却没判封（round/rate 有错）');
    }
  } else bad('/api/mktprobe ?t=senti 失败：' + r.text.slice(0, 160));

  /* 两张基准表是离线生成的静态文件，结构坏了接口不会报错，只会默默降级
     （承接、梯队、状态灯一起变「—」）。所以这里直接读源码里的常量对数。 */
  try {
    const { SENTI_HIST: SH } = await import(path.join(SRC, 'senti_hist.js'));
    const { SENTI_BASE: SB } = await import(path.join(SRC, 'senti_base.js'));
    const nn = SH.d.length;
    ok('情绪基准 ' + nn + ' 天（' + SH.d[0] + ' → ' + SH.d[nn - 1] + '）· 同刻曾触板 '
      + SB.days.length + ' 天 × ' + SB.at.length + ' 档');
    if (nn < 60) bad('情绪历史只有 ' + nn + ' 天，算不出分位数');
    const badLen = ['zt', 'dt', 'touch', 'red', 'mid', 'big', 'promo', 'pn',
      'touchN', 'ydtRed', 'ydtStill', 'ydtN']
      .filter((k) => !Array.isArray(SH[k]) || SH[k].length !== nn);
    if (badLen.length) bad('情绪历史字段长度与 d 不一致：' + badLen.join('、'));
    if (SH.lastDay !== SH.d[nn - 1]) bad('情绪历史 lastDay ' + SH.lastDay + ' ≠ 最后一根 ' + SH.d[nn - 1]);
    const inv = SH.d.filter((_, i) => SH.zt[i] > SH.touch[i]).length;
    if (inv) bad(inv + ' 天的涨停家数大于曾触板家数');
    const npx = Object.keys(SH.zpx || {}).length;
    if (npx < 20) bad('情绪历史只有 ' + npx + ' 条探针价（应 ≥ 20），过期检测会失效');
    if (!SB.at.every((v, i) => i === 0 || v > SB.at[i - 1])) bad('senti_base 的时点没有严格递增');
    const rowBad = SB.touch.filter((row) => row.length !== SB.at.length).length;
    if (rowBad) bad('senti_base 有 ' + rowBad + ' 行长度不等于时点数');
    const mono = SB.touch.filter((row) => row.some((v, i) => i && v < row[i - 1])).length;
    if (mono) bad('senti_base 有 ' + mono + ' 行的曾触板数不是单调不降（累积值不可能变少）');
  } catch (e) {
    bad('情绪基准表读不出来：' + ((e && e.message) || e));
  }

  /* 聚合逻辑的离线自检：不碰上游，喂一段固定样本进去对数。
     5 条里 1 条停牌（f6=0、f3='-'）、1 条代码不在映射表里。
     有效 4 只、合计 150 亿、3 涨 1 跌 1 平 → b=2/3、p5=8e9/15e9。
     这些数错了说明「盘中现算」的结果不可信，比接口挂掉更难发现。 */
  r = await rawRequest(base, '/api/mktprobe?t=agg', { cookie });
  const pa = r.json();
  if (pa && pa.ok && pa.agg) {
    const a = pa.agg;
    ok('/api/mktprobe 聚合 c=' + a.c.toFixed(1) + '% b=' + a.b.toFixed(0)
      + '% n=' + a.n + ' amt=' + a.amt + '亿 p5=' + a.p5.toFixed(1) + '%');
    if (a.n !== 4) bad('/api/mktprobe 样本应剩 4 只有成交，实际 ' + a.n);
    if (Math.abs(a.amt - 150) > 1) bad('/api/mktprobe 样本成交额应为 150 亿，实际 ' + a.amt);
    if (Math.abs(a.b - 66.67) > 0.1) bad('/api/mktprobe 样本宽度应为 66.7%，实际 ' + a.b.toFixed(1));
    if (Math.abs(a.c - 13 / 15 * 100) > 0.2) bad('/api/mktprobe 样本集中度应为 86.7%，实际 ' + a.c.toFixed(1));
    if (Math.abs(a.p5 - 8 / 15 * 100) > 0.2) bad('/api/mktprobe 样本 p5 应为 53.3%，实际 ' + a.p5.toFixed(1));
    if (a.day.length !== 10) bad('/api/mktprobe 没算出数据归属日：' + a.day);
  } else bad('/api/mktprobe?t=agg 失败：' + r.text.slice(0, 160));

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
let localRef = null;
if (!BASE) {
  const local = await startLocal();
  localRef = local;
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
  // 预热的分片只有本地能翻（线上 KV 没有 list 接口），所以这条只在本地位面验
  if (localRef) {
    const dir = path.join(localRef.meta.state, 'kv');
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { /* 目录还没有 */ }
    const shardFiles = files.filter((f) => f.startsWith('pcfsh-v1_2F' + day));
    shardFiles.length
      ? ok('预热分片已落 KV：' + shardFiles.length + ' 片（' + day + '）')
      : bad('预热没有产生任何分片（pcfsh-v1/*' + day + '）');
    const planFile = 'pcfpool-v4_2F' + day + '.json';
    files.includes(planFile) ? ok('当天的预热顺序表已落 KV（' + planFile + '）')
      : bad('没有预热顺序表 ' + planFile);
    // 一致性：预热清单里不该有两只属于同一个跟踪指数（那说明归并漏了）。
    // 核对用的是界面同一份映射——预热和界面必须给同一个答案，否则会出现
    // 「界面上显示 A、预热的却是 B」，A 点开照样等五秒。
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(dir, planFile), 'utf8'));
      const seen = new Map();
      let dup = 0;
      for (const c of plan.codes) {
        const ix = IX_OF[c];
        if (!ix) continue;
        if (seen.has(ix)) dup++; else seen.set(ix, c);
      }
      dup === 0
        ? ok('预热清单无同指数重复：' + plan.codes.length + ' 只覆盖 ' + seen.size + ' 个指数')
        : bad('预热清单里同指数重复了 ' + dup + ' 次（归并漏了）');
    } catch (e) {
      bad('预热顺序表读不出来：' + (e && e.message));
    }
    // 分片里存的必须是能读回的结构，不能是一串字符串
    if (shardFiles.length) {
      try {
        const one = JSON.parse(fs.readFileSync(path.join(dir, shardFiles[0]), 'utf8'));
        const k = Object.keys(one)[0];
        (k && one[k] && Array.isArray(one[k].items) && one[k].items.length)
          ? ok('分片内容可读：' + shardFiles[0].slice(0, 28) + '… 含 ' + k + '（' + one[k].items.length + ' 只成分）')
          : bad('分片内容不可用：' + JSON.stringify(one).slice(0, 120));
      } catch (e) {
        bad('分片解析失败：' + (e && e.message));
      }
    }
  }
}
await close();

console.log('\n' + (fails ? '✗ ' + fails + '/' + checks + ' 项未通过' : '✓ 全部 ' + checks + ' 项通过'));
process.exit(fails ? 1 : 0);
