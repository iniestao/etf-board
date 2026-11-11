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
 *   node server/sync-data.mjs --hist     同一天也重下全部 hist（45MB）
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

function bases(repo, branch, pin) {
  // pin 是 data 分支当前的 commit sha。jsDelivr 对 @branch 这个地址按路径缓存
  // 12 小时，分支前进了它也不回源——2026-11-11 就吃到过：动作早就把 11-10 推上去了，
  // 这边还拿着 11-09 的 manifest 说「已是最新」，K 线永远少一天。
  // @sha 是全新 URL，缓存必然未命中，能立刻拿到新内容。
  const ref = pin || branch;
  const cdn = process.env.DATA_CDN || ('https://cdn.jsdelivr.net/gh/' + repo + '@' + ref);
  const raw = 'https://raw.githubusercontent.com/' + repo + '/' + ref;
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
function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // 沙箱里通常已经 gh auth login 过，但这个脚本不继承那个环境变量。
  // 就地读一次，省得为了「取一个 commit sha」再让人配 token。
  try {
    const p = path.join(process.env.HOME || '/root', '.config/gh/hosts.yml');
    const y = fs.readFileSync(p, 'utf8');
    const m = y.match(/oauth_token:\s*(\S+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function remoteManifest(repo, branch) {
  const [cdn] = bases(repo, branch);
  const tk = ghToken();
  if (tk) {
    try {
      const url = 'https://api.github.com/repos/' + repo + '/commits?sha=' + branch + '&per_page=1';
      const r = await fetch(url, {
        headers: {
          'user-agent': 'etf-board-sync',
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + tk,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) {
          // 有 sha 就按 sha 取 manifest：既避开 CDN 缓存，又能把 pin 带下去
          const pin = arr[0].sha;
          const [pinned] = bases(repo, branch, pin);
          const m = await getJson(pinned + '/manifest.json').catch(() => null);
          if (m) return { ...m, mark: 'sha:' + pin, pin };
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

/** 顶层小文件（几 MB 以内）：每次同步都刷，和 hist 那 1719 个分开走 */
async function pullTops(cdn, dist) {
  for (const f of ['manifest.json', 'research.json', 'hist/events.json',
                   'sec_daily.json', 'mkt_hist.json',
                   'fut_last.json', 'fut_daily.json', 'etfopt_hist.json']) {
    try {
      const r = await fetch(cdn + '/' + f, { signal: AbortSignal.timeout(40000) });
      if (r.ok) await fsp.writeFile(path.join(dist, f), Buffer.from(await r.arrayBuffer()));
    } catch { /* 拿不到就保留旧的 */ }
  }
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
  // 期指日档单独判一次存在性：它曾经不在下面那份清单里，沙箱就永远停在
  // 部署那天的快照上。缺文件时即便 mark 相同也要走一遍，否则补不回来。
  const haveFut = fs.existsSync(path.join(dist, 'fut_last.json'));
  // ETF 期权历史同样单独判：它是后加的，先部署过沙箱的话本地就没有这份文件，
  // 而当天 mark 又没变，不这么判就永远补不上。
  const haveEh = fs.existsSync(path.join(dist, 'etfopt_hist.json'));

  const codes = (man.items || []).map((x) => x.code).filter(Boolean);
  if (!codes.length) throw new Error('远端 manifest 里没有 items，无法确定要拉哪些文件');

  const [cdn, raw] = bases(repo, branch, man.pin);

  if (!opts.force && haveHist && haveFut && haveEh && local
      && (local.mark === man.mark || local.sha === man.mark)) {
    log('已是最新：' + label(man.mark) + '（' + (man.last_trade_date || '') + '），跳过');
    return { changed: false, mark: man.mark, skipped: 'up-to-date' };
  }

  /* 同一天重跑（手动触发、失败重试、cron 补跑）会拿到新 commit sha，但交易日没变。
     这时候把 1719 个 hist 再下一遍（45MB / 三分钟）纯属白费：hist 是「一天一根」，
     同一天重算只可能改末尾那一根，而真正会变的是顶层那几份（manifest / fut_daily /
     sec_daily / etfopt_hist）。文件数变了（新 ETF 上市）或换了交易日才必须全量。
     --hist 强制全量，--force 同理。 */
  /* 别拿 readdir 的数量比：hist 目录里还躺着 events.json，永远比标的数多 1，
     那样这个条件永远不成立，等于没写。逐只判文件在不在最实在——1719 次
     existsSync 是毫秒级，还能顺带发现「新 ETF 上市、本地缺它的 bin」。 */
  const allHaveHist = haveHist && codes.every((c) => fs.existsSync(path.join(histDir, c + '.bin')));
  const sameDay = !!(local && man.last_trade_date
    && local.last_trade_date === man.last_trade_date && allHaveHist);

  if (opts.check) {
    log('远端 ' + label(man.mark) + '（' + (man.last_trade_date || '') + '）'
      + ' / 本地 ' + (local ? label(local.mark || local.sha) : '无')
      + (sameDay ? ' → 同一交易日，只刷顶层文件' : ' → 需要全量同步'));
    return { changed: true, mark: man.mark, skipped: 'check-only' };
  }

  if (!opts.force && !opts.hist && haveHist && haveFut && haveEh && sameDay) {
    await pullTops(cdn, dist);
    const files = (await fsp.readdir(histDir)).length;
    await writeState({
      mark: man.mark, last_trade_date: man.last_trade_date,
      synced_at: new Date().toISOString(), files, repo, branch,
    });
    log('同一交易日（' + man.last_trade_date + '）重跑：只刷顶层文件，'
      + codes.length + ' 个 hist 跳过（要重下加 --hist）');
    return { changed: true, mark: man.mark, files, histSkipped: true };
  }

  await fsp.mkdir(histDir, { recursive: true });
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
  //
  // sec_daily.json / mkt_hist.json 是板块地图的两份历史（资金箭头的基准、
  // 四象限的散点云），由 Actions 每天回算后一起发布。漏同步的话，
  // 沙箱会一直用本地下次回算的那份，跟线上对不上。
  //
  // fut_last.json / fut_daily.json 同理，但后果更难看：Cloudflare 版读 data 分支，
  // 每天 16:35 自动换成新档；沙箱版只读本地磁盘，这两份不进清单就一直停在
  // 沙箱里最后一次手动跑 pipeline 的日期。表现是收盘后四象限的增减仓拿错了
  // 昨收——差一天，而且没人会怀疑到数据头上（页面看起来一切正常）。
  //
  // etfopt_hist.json 是 ETF 期权那段历史。它每天都在合并新一天，沙箱不跟着换
  // 就是「线上 131 天、本地还停在发布那天」，越差越远。
  await pullTops(cdn, dist);

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
    const r = await syncData({
      force: flags.has('--force'),
      hist: flags.has('--hist'),
      check: flags.has('--check'),
    });
    if (r && r.failed) process.exit(2);
  } catch (e) {
    console.error('同步失败：' + ((e && e.message) || e));
    process.exit(1);
  }
}
