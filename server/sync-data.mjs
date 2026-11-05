/**
 * 数据同步：把 GitHub data 分支上的产物拉到本地 dist/
 * ====================================================
 * Cloudflare 版每天由 Actions 把 dist/hist 推到 data 分支，Worker 现场回源读；
 * 沙箱版没有边缘网络，只能读本地磁盘，所以需要一个「把远端产物落到本地」的动作。
 *
 * 三种跑法：
 *   node server/sync-data.mjs            检查并同步（data 分支 commit 没变就直接跳过）
 *   node server/sync-data.mjs --force    强制重下
 *   node server/sync-data.mjs --check    只看状态，不动文件
 *
 * 也可以被 app.mjs 调用（AUTO_SYNC=1 时后台检查），所以这里把主流程导出成函数。
 *
 * 为什么用 codeload 的 tarball 而不是 git：沙箱和 CI 都不保证有仓库凭据，
 * 而 data 分支是公开的，一次 tarball 就是完整快照，不用处理增量 merge。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDirs } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = () => path.join(resolveDirs().state, 'last_sync.json');

export function repoInfo() {
  // 允许覆盖：私有 fork 或换仓库时不用改代码
  const repo = process.env.DATA_REPO || 'iniestao/etf-board';
  const branch = process.env.DATA_BRANCH || 'data';
  return { repo, branch };
}

/**
 * 判断「远端数据有没有变」。
 *
 * 两条路，按可靠性递减：
 *   1. GitHub API 取 data 分支最新 commit —— 最准，但未认证只有 60 次/小时，
 *      沙箱出口 IP 常常是共享的，很容易 403（实测就撞上了）。有 token 才走这条。
 *   2. 直接读 raw 上的 manifest.json，用它自己的 generated_at 当指纹 ——
 *      不需要凭据、不会被限流，代价是 manifest 有几分钟 CDN 缓存（可接受，我们 6 小时才查一次）。
 */
async function latestMarker(repo, branch) {
  if (process.env.GITHUB_TOKEN) {
    try {
      const url = 'https://api.github.com/repos/' + repo + '/commits?sha=' + branch + '&per_page=1';
      const r = await fetch(url, {
        headers: {
          'user-agent': 'etf-board-sync',
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) {
          return {
            mark: 'sha:' + arr[0].sha,
            date: arr[0].commit && arr[0].commit.committer && arr[0].commit.committer.date,
          };
        }
      }
    } catch { /* 落到 raw 路径 */ }
  }

  const url = 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/manifest.json';
  const r = await fetch(url, {
    headers: { 'user-agent': 'etf-board-sync', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('读远端 manifest 失败 HTTP ' + r.status + '（配 GITHUB_TOKEN 可走 API）');
  const j = await r.json();
  const stamp = j.generated_at || j.last_trade_date || String(j.codes || '');
  return { mark: 'raw:' + stamp + ':' + (j.codes || 0), date: j.last_trade_date || stamp };
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')); } catch { return null; }
}

async function writeState(obj) {
  const f = STATE_FILE();
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(obj, null, 2));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' 退出码 ' + code + '：' + err.slice(0, 300)))));
  });
}

/**
 * @param {{force?:boolean, check?:boolean, log?:(s:string)=>void}} opts
 * @returns {Promise<{changed:boolean, mark?:string, date?:string, skipped?:string, files?:number}>}
 */
export async function syncData(opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const { dist, state } = resolveDirs();
  const { repo, branch } = repoInfo();

  const remote = await latestMarker(repo, branch);
  const local = await readState();
  const haveHist = fs.existsSync(path.join(dist, 'hist'));
  const label = (m) => String(m || '').replace(/^sha:/, '').replace(/^raw:/, '').slice(0, 24);

  if (!opts.force && haveHist && local && (local.mark === remote.mark || local.sha === remote.mark)) {
    log('已是最新：' + label(remote.mark) + '（' + (remote.date || '') + '），跳过');
    return { changed: false, mark: remote.mark, date: remote.date, skipped: 'up-to-date' };
  }
  if (opts.check) {
    log('远端 ' + label(remote.mark) + '（' + (remote.date || '') + '）'
      + ' / 本地 ' + (local ? label(local.mark || local.sha) : '无') + ' → 需要同步');
    return { changed: true, mark: remote.mark, date: remote.date, skipped: 'check-only' };
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'etf-sync-'));
  try {
    const url = 'https://codeload.github.com/' + repo + '/tar.gz/refs/heads/' + branch;
    log('下载 ' + url + ' …（hist 约 48MB，GitHub 在国内可能偏慢）');
    const tgz = path.join(tmp, 'data.tgz');
    await run('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '--max-time', '600', '-o', tgz, url]);
    const size = (await fsp.stat(tgz)).size;
    log('下载完成 ' + (size / 1048576).toFixed(1) + 'MB，解包中…');
    await run('tar', ['-xzf', tgz, '-C', tmp]);

    const top = (await fsp.readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory());
    if (!top) throw new Error('压缩包里没有顶层目录');
    const src = path.join(tmp, top.name);

    // hist 整目录替换：先落临时名再换，避免中途失败留下半个目录
    const histSrc = path.join(src, 'hist');
    const histDst = path.join(dist, 'hist');
    if (!fs.existsSync(histSrc)) throw new Error('压缩包里没有 hist/');
    await fsp.mkdir(dist, { recursive: true });
    const histNew = histDst + '.new';
    await fsp.rm(histNew, { recursive: true, force: true });
    await fsp.cp(histSrc, histNew, { recursive: true });
    await fsp.rm(histDst, { recursive: true, force: true });
    await fsp.rename(histNew, histDst);

    for (const f of ['manifest.json', 'research.json']) {
      const s = path.join(src, f);
      if (fs.existsSync(s)) await fsp.copyFile(s, path.join(dist, f));
    }

    const files = (await fsp.readdir(histDst)).length;
    await writeState({ mark: remote.mark, date: remote.date, synced_at: new Date().toISOString(), files, repo, branch });
    log('同步完成：' + files + ' 个 hist 文件（' + label(remote.mark) + '）');
    return { changed: true, mark: remote.mark, date: remote.date, files };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** app.mjs 用的后台静默版：绝不抛错，绝不阻塞请求 */
export function syncInBackground(log = () => {}) {
  const p = syncData({ log }).catch((e) => log('后台同步失败（不影响页面）：' + (e && e.message || e)));
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const flags = new Set(process.argv.slice(2));
  try {
    await syncData({ force: flags.has('--force'), check: flags.has('--check') });
  } catch (e) {
    console.error('同步失败：' + (e && e.message || e));
    process.exit(1);
  }
}
