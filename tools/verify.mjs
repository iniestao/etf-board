#!/usr/bin/env node
/**
 * 部署后自检
 * ===========
 * 一条命令验完线上 6 个关键点，避免「deploy 成功但存储没绑上」这种假上线。
 *
 *   node tools/verify.mjs https://etf-board.your-name.workers.dev
 *
 * 不带参数时按 worker/wrangler.toml 的 name 猜域名。
 * 环境变量 NO_COLOR=1 可关掉颜色（老版 Windows 控制台用）。
 */

const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const C = (n) => (s) => (NO_COLOR ? s : `\x1b[${n}m${s}\x1b[0m`);
const dim = C('2'), red = C('31'), green = C('32'), yellow = C('33'), bold = C('1');

const TIMEOUT = 20000;
let pass = 0, fail = 0, warn = 0;
const notes = [];

function ok(label, detail) {
  pass++;
  console.log(`  ${green('✓')} ${label.padEnd(22)} ${detail || ''}`);
}
function bad(label, detail, hint) {
  fail++;
  console.log(`  ${red('✗')} ${label.padEnd(22)} ${detail || ''}`);
  if (hint) notes.push(hint);
}
function soft(label, detail, hint) {
  warn++;
  console.log(`  ${yellow('!')} ${label.padEnd(22)} ${detail || ''}`);
  if (hint) notes.push(hint);
}

async function hit(base, path, init = {}) {
  const t0 = Date.now();
  const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  return { r, ms: Date.now() - t0 };
}

/** 解析 ETH1 定长二进制，只读 header，不解数据区 */
function readHistHeader(buf) {
  if (buf.length < 8) throw new Error('文件过短');
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== 'ETH1') throw new Error(`magic 不是 ETH1 而是 "${magic}"`);
  const hl = buf.readUInt32LE(4);
  if (hl <= 0 || 8 + hl > buf.length) throw new Error(`header 长度异常 ${hl}`);
  const hdr = JSON.parse(buf.toString('utf8', 8, 8 + hl));
  return hdr;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: node tools/verify.mjs https://<你的域名>.workers.dev');
    process.exit(2);
  }
  const base = arg.replace(/\/+$/, '');
  console.log(`\n${bold('线上自检')} ${dim(base)}\n`);

  // ---- 1. 首页 ----
  try {
    const { r, ms } = await hit(base, '/');
    const html = await r.text();
    const kb = (html.length / 1024).toFixed(1);
    const looksRight = html.includes('<!DOCTYPE') && html.length > 20000;
    if (r.ok && looksRight) ok('首页 HTML', `${r.status}  ${ms}ms  ${kb}KB`);
    else bad('首页 HTML', `${r.status}  ${ms}ms  ${kb}KB`, '首页不是完整页面，确认部署的是 worker/dist/worker.js 或 src/index.js');
  } catch (e) {
    bad('首页 HTML', e.name === 'TimeoutError' ? '超时' : e.message, '域名拼错了？或 Worker 还没部署成功（wrangler deploy 是否报错）');
  }

  // ---- 2. /api/status ----
  let status = null;
  try {
    const { r, ms } = await hit(base, '/api/status');
    status = await r.json();
    const b = status.bindings || {};
    if (b.r2 && b.kv) ok('/api/status', `${r.status}  ${ms}ms  r2=true kv=true`);
    else if (b.r2 && !b.kv) soft('/api/status', `${r.status}  r2=true kv=${b.kv}`, 'KV 没绑上：自选仍然是本地存储，换浏览器会丢。加 [[kv_namespaces]] 后重新 deploy');
    else if (!b.r2 && b.kv) soft('/api/status', `${r.status}  r2=${b.r2} kv=true`, 'R2 没绑上：K 线面板会提示「未启用」。加 [[r2_buckets]] 后重新 deploy');
    else bad('/api/status', `${r.status}  r2=${b.r2} kv=${b.kv}`, 'R2 和 KV 都没绑上：wrangler.toml 里两段还是注释状态，去掉注释再 deploy');
  } catch (e) {
    bad('/api/status', e.message, '/api/status 都打不开，说明部署的不是这个 Worker 版本');
  }

  // ---- 3. 历史数据是否已进 R2 ----
  const hist = status && status.hist;
  if (!hist) {
    if (status && status.bindings && status.bindings.r2) {
      soft('R2 历史数据', '空', 'R2 已绑定但还没有数据：去 GitHub Actions 点 Run workflow 跑一次全量');
    } else {
      soft('R2 历史数据', '未启用', '先解决上一条 R2 绑定');
    }
  } else {
    ok('R2 历史数据', `${hist.last_trade_date}  ${hist.codes} 只  ${hist.format}  ${hist.cols} 列`);
  }

  // ---- 4. /api/all 全市场行情 ----
  try {
    const { r, ms } = await hit(base, '/api/all');
    const j = await r.json();
    const n = j.n || (Array.isArray(j.raw) ? j.raw.length : 0);
    if (r.ok && n >= 1500) ok('/api/all 行情', `${r.status}  ${ms}ms  ${n} 只  src=${j.src || '?'}`);
    else if (r.ok && n > 0) soft('/api/all 行情', `${r.status}  ${n} 只`, `只拿到 ${n} 只，正常应 1700+。可能是盘中数据源限流，换个时间再试`);
    else bad('/api/all 行情', `${r.status}  n=${n}`, '行情源被拒：确认 Worker 走的是新浪 etf_hq_fund 通道，且 Referer 已伪造为 sina 域名');
  } catch (e) {
    bad('/api/all 行情', e.message, '行情源不可用。免费源没有 SLA，先看 /api/probe 哪个源还活着');
  }

  // ---- 5. /api/hist 单只历史（二进制透传）----
  try {
    const { r, ms } = await hit(base, '/api/hist?code=510300');
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const j = await r.json();
      bad('/api/hist 单只', `JSON: ${j.code || ''} ${j.error || ''}`, j.code === 'NO_R2'
        ? 'R2 未绑定'
        : j.code === 'NOT_FOUND' ? 'R2 里没有这个 key，Actions 是否跑成功？' : '读 R2 出错，检查 bucket 名与 binding 名');
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      const hdr = readHistHeader(buf);
      ok('/api/hist 单只', `${r.status}  ${ms}ms  ${hdr.code}  ${hdr.n} 行  ${buf.length} 字节  ${hdr.start}~${hdr.end}`);
      if (hdr.n < 400) soft('  数据深度', `${hdr.n} 行`, `不到 400 个交易日，历史可能没导全`);
    }
  } catch (e) {
    bad('/api/hist 单只', e.message, '二进制解析失败：前端同样会失败，检查 compute.py 导出格式');
  }

  // ---- 6. /api/watch 自选 ----
  try {
    const { r, ms } = await hit(base, '/api/watch');
    const j = await r.json();
    if (j.ok) ok('/api/watch 自选', `${r.status}  ${ms}ms  exists=${j.exists}  云端 ${(j.list || []).length} 只`);
    else bad('/api/watch 自选', `${r.status}  ${j.code || ''} ${j.error || ''}`, j.code === 'NO_KV' ? 'KV 未绑定' : '读写 KV 出错');
  } catch (e) {
    bad('/api/watch 自选', e.message, 'KV 未绑定或 key 不对');
  }

  // ---- 7. 首页 ETag 与 304（改版后应自动失效）----
  try {
    const a = await hit(base, '/');
    const etag = a.r.headers.get('etag');
    if (!etag) {
      soft('ETag / 304', '首页无 ETag', '每次访问都会重传 63KB 页面，功能不受影响');
    } else {
      const b = await hit(base, '/', { headers: { 'If-None-Match': etag } });
      if (b.r.status === 304) ok('ETag / 304', `${etag.slice(0, 18)}…  → 304`);
      else soft('ETag / 304', `带 If-None-Match 仍返回 ${b.r.status}`, '条件请求没生效，页面照常能打开，只是费流量');
    }
  } catch { /* 上一步已经报过 */ }

  // ---- 汇总 ----
  console.log('');
  const parts = [green(`${pass} 通过`)];
  if (warn) parts.push(yellow(`${warn} 提醒`));
  if (fail) parts.push(red(`${fail} 失败`));
  console.log(bold('结果 ') + parts.join('  '));

  if (notes.length) {
    console.log(`\n${bold('下一步')}`);
    for (const n of notes) console.log(`  · ${n}`);
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(red('自检脚本自身出错: ') + e.message);
  process.exit(2);
});
