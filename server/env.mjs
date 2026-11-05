/**
 * 运行时绑定适配层（Node 版）
 * ===========================
 * worker/src/index.js 是**唯一**的业务代码，Cloudflare Worker 和这个沙箱版
 * 共用同一份。两边唯一的差异是平台给的绑定对象，全部在这一层抹平：
 *
 *   Cloudflare                    这里
 *   ----------------------------  ------------------------------------------
 *   env.BUCKET（R2）         →    dist/ 目录（本地文件系统）
 *   env.WATCH（KV）          →    state/kv/*.json（原子写，进程重启不丢）
 *   env.ACCESS_PASS（secret）→    .env / state/access_pass.txt / 首次自动生成
 *   caches.default（边缘缓存）→    没有，index.js 已用 getCache() 降级
 *   ctx.waitUntil            →    收集 promise，进程常驻自然跑完
 *
 * 所以「以后有变化两边一起改」的规则是：**只改 worker/src/，不要在这里加业务逻辑**。
 * 这里只允许出现「平台能力 → Web 标准接口」的转换代码。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------- 路径
export function resolveDirs(env = process.env) {
  return {
    dist: path.resolve(env.DIST_DIR || path.join(REPO_ROOT, 'dist')),
    state: path.resolve(env.STATE_DIR || path.join(HERE, 'state')),
  };
}

/** 把相对 key 拼进 base，并拒绝任何越界路径（..%2f、绝对路径、符号链接） */
function safeJoin(base, key) {
  const rel = String(key == null ? '' : key).replace(/^\/+/, '');
  if (!rel) return null;
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

// ---------------------------------------------------------------- 极简 .env
/** 只为了不引依赖：KEY=VALUE，忽略 # 注释，不处理引号内换行 */
export async function readDotEnv(file) {
  const out = {};
  let txt = '';
  try {
    txt = await fsp.readFile(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---------------------------------------------------------------- R2 → 文件系统
/**
 * 只实现 index.js 实际用到的部分：get(key) → { body, text(), httpEtag }。
 * key 形如 'hist/510300.bin'、'manifest.json'、'research.json'。
 */
export function fileBucket(distDir) {
  return {
    kind: 'fs',
    async get(key) {
      const f = safeJoin(distDir, key);
      if (!f) return null;
      let buf;
      try {
        buf = await fsp.readFile(f);
      } catch {
        return null;
      }
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      let etag = '"' + buf.length.toString(16) + '"';
      try {
        const st = await fsp.stat(f);
        // 带上 mtime：每天重算后文件大小可能不变，只有时间戳能区分版本
        etag = '"' + buf.length.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
      } catch { /* 用长度兜底 */ }
      return {
        body: ab,
        etag,
        httpEtag: etag,
        async arrayBuffer() { return ab; },
        async text() { return buf.toString('utf8'); },
        writeHttpMetadata(h) { h.set('ETag', etag); },
      };
    },
    async head(key) {
      const f = safeJoin(distDir, key);
      if (!f) return null;
      try {
        const st = await fsp.stat(f);
        return { size: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------- KV → JSON 文件
/**
 * KV 在业务代码里只有三个动作：get(key[, 'json']) / put(key, value) / delete。
 * 落成 state/kv/<urlencoded>.json，写入走 tmp + rename，避免断电留下半个文件。
 *
 * 同一 key 的并发写用一个串行队列串起来——Node 单进程内不会出现两个 put
 * 同时 rename 同一个目标（Windows 上这会直接 EPERM）。
 */
export function fileKV(stateDir) {
  const dir = path.join(stateDir, 'kv');
  fs.mkdirSync(dir, { recursive: true });
  const queues = new Map();

  const fileOf = (key) => path.join(dir, encodeURIComponent(String(key)).replace(/%/g, '_') + '.json');

  const enqueue = (file, job) => {
    const prev = queues.get(file) || Promise.resolve();
    const next = prev.then(job, job);
    queues.set(file, next.catch(() => {}));
    return next;
  };

  return {
    kind: 'fs',
    async get(key, type) {
      let txt;
      try {
        txt = await fsp.readFile(fileOf(key), 'utf8');
      } catch {
        return null;
      }
      if (type === 'json') {
        try { return JSON.parse(txt); } catch { return null; }
      }
      return txt;
    },
    async put(key, value) {
      const file = fileOf(key);
      const txt = typeof value === 'string' ? value : JSON.stringify(value);
      return enqueue(file, async () => {
        const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
        await fsp.writeFile(tmp, txt, 'utf8');
        await fsp.rename(tmp, file);
      });
    },
    async delete(key) {
      const file = fileOf(key);
      return enqueue(file, async () => {
        try { await fsp.unlink(file); } catch { /* 本来就没有 */ }
      });
    },
  };
}

// ---------------------------------------------------------------- 口令
const PASS_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉 i/l/o/0/1，口头念得清

function genPass(bytes = 12) {
  const n = crypto.randomBytes(bytes);
  let s = '';
  for (const b of n) s += PASS_ALPHABET[b % PASS_ALPHABET.length];
  return s;
}

/**
 * 口令来源优先级：
 *   1. process.env.ACCESS_PASS       （容器/CI 注入）
 *   2. server/.env 里的 ACCESS_PASS  （本地长期使用，已 gitignore）
 *   3. state/access_pass.txt         （上一轮生成过就沿用，不因重启变口令）
 *   4. 都没有 → 现场生成一个，写进 3，权限 600
 *
 * 注意：**绝不**把口令写进任何会被提交的文件，也绝不写进日志正文。
 */
export async function resolveAccessPass(stateDir, env = process.env) {
  if (env.ACCESS_PASS) return { pass: env.ACCESS_PASS, from: 'env' };

  const dot = await readDotEnv(path.join(HERE, '.env'));
  if (dot.ACCESS_PASS) return { pass: dot.ACCESS_PASS, from: '.env' };

  const f = path.join(stateDir, 'access_pass.txt');
  try {
    const s = (await fsp.readFile(f, 'utf8')).trim();
    if (s) return { pass: s, from: 'state/access_pass.txt' };
  } catch { /* 首次运行 */ }

  const pass = genPass();
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(f, pass + '\n', { mode: 0o600 });
  return { pass, from: 'generated' };
}

// ---------------------------------------------------------------- 组装 env
export async function makeEnv(env = process.env) {
  const { dist, state } = resolveDirs(env);
  await fsp.mkdir(state, { recursive: true });
  const { pass, from } = await resolveAccessPass(state, env);

  return {
    env: {
      BUCKET: fileBucket(dist),   // 有 BUCKET 时 index.js 的 histSource 判为 'r2'，不再回源 GitHub
      WATCH: fileKV(state),
      ACCESS_PASS: pass,
      RUNTIME: 'node',            // 只用于 /api/status 显示，业务逻辑不依赖
    },
    meta: { dist, state, passFrom: from },
  };
}
