/**
 * 数据同步：把 GitHub data 分支上的 hist 拉到本地 dist/
 * =====================================================
 * Cloudflare 版每天由 Actions 把产物推到 data 分支，Worker 现场回源读；
 * 沙箱版没有边缘网络，只能读本地磁盘，所以要有人把远端产物落到本地。
 *
 * 为什么不用 tarball 整包（codeload.github.com/…/tar.gz/data）：
 * 实测沙箱出口到 codeload 只有 ~7KB/s，48MB 要接近两小时，没法用。
 * 改成按文件走 jsDelivr CDN（它回源 GitHub 但走自己的节点），单文件 36KB 约 2 秒，
 * 16 路并发把 1718 个文件压在几分钟内。CDN 不可用时自动退回 raw.githubusercontent。
 *
 * 用法：
 *   node server/sync-data.mjs            检查并同步（mark 没变就跳过）
 *   node server/sync-data.mjs --force    强制重下
 *   node server/sync-data.mjs --check    只看状态，不动文件
 * 环境变量：
 *   DATA_REPO / DATA_BRANCH   默认 iniestao/etf-board / data
 *   DATA_CDN                  覆盖 CDN 基址
 *   SYNC_CONCURRENCY          并发数，默认 16
 *   GITHUB_TOKEN              有就用 API 查 commit（更准），没有就用 manifest 当指纹
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDirs } from './env.mjs';

const STATE_FILE = () => path.join(resolveDirs().state, 'last_sync.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function repoInfo() {
  return {
    repo: process.env.DATA_REPO || 'iniestao/etf-board',
    branch: process.env.DATA_BRANCH || 'data',
  };
}

function bases(repo, branch) {
  const cdn = process.env.DATA_CDN || ('https://cdn.jsdelivr.net/gh/' + repo + '@' + branch);
  const raw = 'https://raw.githubusercontent.com/' + repo + '/' + branch;
  return [cdn, raw];
}

async function getJson(url, timeout = 25000) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'etf-board-sync', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' @ ' + url);
  return r.json();
}

/**
 * 判断「远端数据有没有变」。
 *   1. 有 token：API 取 data 分支最新 commit（最准）
 *   2. 没 token：读 manifest.json，用它自己的 generated_at 当指纹
 *      （未认证 API 只有 60 次/小时，沙箱出口是共享 IP，实测直接 403）
 */
async function remoteManifest(repo, branch) {
  const [cdn] = bases(repo, branch);
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
          const m = await getJson(cdn + '/manifest.json').catch(() => null);
          if (m) return { ...m, mark: 'sha:' + arr[0].sha };
        }
      }
    } catch { /* 落到 manifest 指纹 */ }
  }
  const m = await getJson(cdn + '/manifest.json');
  const stamp = m.generated_at || m.last_trade_date || String(m.codes || '');
  return { ...m, mark: 'raw:' + stamp + ':' + (m.codes || 0) };
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')); } catch { return null; }
}

async function writeState(obj) {
  const f = STATE_FILE();
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(obj, null, 2));
}

/** 单文件下载：按基址顺序试 + 退避重试，落盘走 tmp+rename（不留半个文件） */
async function fetchOne(urls, dst) {
  let lastErr;
  for (const url of urls) {
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(url, {
          headers: { 'user-agent': 'etf-board-sync' },
          signal: AbortSignal.timeout(40000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 32) throw new Error('内容过短(' + buf.length + 'B)');
        const tmp = dst + '.' + process.pid + '.tmp';
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, dst);
        return buf.length;
      } catch (e) {
        lastErr = e;
        if (t < 2) await sleep(400 * (t + 1));
      }
    }
  }
  throw lastErr || new Error('下载失败');
}

/** 固定 N 路并发的取任务池 */
async function pool(items, n, worker, onProgress) {
  let idx = 0;
  let done = 0;
  const results = { ok: 0, fail: [], bytes: 0 };
  const runners = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const it = items[idx++];
      try {
        const b = await worker(it);
        results.ok++;
        results.bytes += b || 0;
      } catch (e) {
        results.fail.push({ item: it, error: String((e && e.message) || e) });
      }
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, items.length, results);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * @param {{force?:boolean, check?:boolean, log?:(s:string)=>void}} opts
 */
export async function syncData(opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const { dist } = resolveDirs();
  const { repo, branch } = repoInfo();
  const label = (m) => String(m || '').replace(/^(sha|raw):/, '').slice(0, 24);

  const man = await remoteManifest(repo, branch);
  const local = await readState();
  const histDir = path.join(dist, 'hist');
  const haveHist = fs.existsSync(histDir);

  if (!opts.force && haveHist && local && (local.mark === man.mark || local.sha === man.mark)) {
    log('已是最新：' + label(man.mark) + '（' + (man.last_trade_date || '') + '），跳过');
    return { changed: false, mark: man.mark, skipped: 'up-to-date' };
  }
  if (opts.check) {
    log('远端 ' + label(man.mark) + '（' + (man.last_trade_date || '') + '）'
      + ' / 本地 ' + (local ? label(local.mark || local.sha) : '无') + ' → 需要同步');
    return { changed: true, mark: man.mark, skipped: 'check-only' };
  }

  const codes = (man.items || []).map((x) => x.code).filter(Boolean);
  if (!codes.length) throw new Error('远端 manifest 里没有 items，无法确定要拉哪些文件');

  await fsp.mkdir(histDir, { recursive: true });
  const [cdn, raw] = bases(repo, branch);
  const conc = Math.max(1, Math.min(32, Number(process.env.SYNC_CONCURRENCY || 16)));
  const t0 = Date.now();
  log('开始同步 ' + codes.length + ' 个 hist 文件（并发 ' + conc + '）');

  const res = await pool(codes, conc, (code) => fetchOne(
    [cdn + '/hist/' + code + '.bin', raw + '/hist/' + code + '.bin'],
    path.join(histDir, code + '.bin'),
  ), (done, total, r) => {
    log('  ' + done + '/' + total + '  ' + (r.bytes / 1048576).toFixed(1) + 'MB  '
      + ((Date.now() - t0) / 1000).toFixed(0) + 's  失败 ' + r.fail.length);
  });

  // 顶层文件 + 异动快照。原先这里只拉 manifest 和 research，注释却写着
  // 「events.json 已随上面一起拉下来」——上面循环拉的是 hist/{code}.bin，
  // events 不在 codes 里，从来没同步过。沙箱版因此一直显示部署那天的快照
  // （2026-11-07 实测：data 分支已是 11-06，页面还写着 11-04）。
  for (const f of ['manifest.json', 'research.json', 'hist/events.json']) {
    try {
      const r = await fetch(cdn + '/' + f, { signal: AbortSignal.timeout(40000) });
      if (r.ok) await fsp.writeFile(path.join(dist, f), Buffer.from(await r.arrayBuffer()));
    } catch { /* 拿不到就保留旧的 */ }
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const files = (await fsp.readdir(histDir)).length;
  if (res.fail.length) {
    log('完成但有 ' + res.fail.length + ' 个失败（' + sec + 's）：' + res.fail.slice(0, 5).map((x) => x.item).join(', '));
    log('失败的文件保留旧版本；mark 不更新，下次同步会重试');
    return { changed: true, mark: null, failed: res.fail.length, files };
  }

  await writeState({
    mark: man.mark,
    last_trade_date: man.last_trade_date,
    synced_at: new Date().toISOString(),
    files,
    repo,
    branch,
  });
  log('同步完成：' + files + ' 个文件 / ' + (res.bytes / 1048576).toFixed(1) + 'MB / ' + sec + 's（' + label(man.mark) + '）');
  return { changed: true, mark: man.mark, files };
}

/** app.mjs 用的后台版：绝不抛错，绝不阻塞请求 */
export function syncInBackground(log = () => {}) {
  return syncData({ log }).catch((e) => log('后台同步失败（页面继续用旧数据）：' + ((e && e.message) || e)));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const flags = new Set(process.argv.slice(2));
  try {
    const r = await syncData({ force: flags.has('--force'), check: flags.has('--check') });
    if (r && r.failed) process.exit(2);
  } catch (e) {
    console.error('同步失败：' + ((e && e.message) || e));
    process.exit(1);
  }
}
