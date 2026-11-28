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

/** 顶层小文件（几 MB 以内）：每次同步都刷，和 hist 那 1719 个分开走
 *
 * 这张清单同时是「本地缺哪份就必须同步」的判据（见 syncData 里的 allTops）。
 * 以前这里是逐份手加的：期指日档漏过一次、ETF 期权历史又漏过一次，每漏一次的
 * 表现都一样——**沙箱版页面看着正常，只是某一块停在上次手动跑管线的那天**，
 * 因为沙箱的 readAsset 读的就是本地 dist（env.BUCKET = fileBucket(dist)）。
 *
 * 2026-11-18 又发现漏了 sentiment 那两份：senti_hist.json 停在 11-13，
 * 而 worker/src/senti_hist.js 已经到 11-17。页面走 readAsset 先读 json，
 * 读到了就用它——于是内联那份新、运行时那份旧，谁也没报错。
 *
 * 2026-11-28 补三份：stk_concept / etf_base / etfopt_eod。它们本地停在 11-26，
 * 而 data 分支上三份都已经是 11-27 —— 清单天天在刷、这三块一直冻在前一天，
 * 页面上表现为「涨停清单有 27 号、行业/概念列和期权隐含分红还是 26 号」。
 * 当时是手工重下覆盖的，根因就是这张表里没有它们，这次一并补齐。
 */
const TOP_FILES = [
  'manifest.json', 'research.json', 'hist/events.json',
  'sec_daily.json', 'mkt_hist.json',
  'senti_hist.json', 'senti_base.json',
  'fut_last.json', 'fut_daily.json', 'etfopt_hist.json',
  'stk_concept.json', 'etf_base.json', 'etfopt_eod.json',
  'shares/last.json', 'shares/ix.json',
];

async function pullTops(cdn, raw, dist) {
  for (const f of TOP_FILES) {
    const dst = path.join(dist, f);
    try {
      /* 单走 jsDelivr 不够：2026-11-28 实测 stk_concept.json / etf_base.json
         在 @sha 路径上直接 403（etfopt_eod 同路径 200），而 raw 上三份都是最新的。
         403 又被 try 静默吞掉，症状就是「同步说已是最新，本地这三份还停在昨天」。
         加 raw 兜底：CDN 拿不到就退回 raw.githubusercontent，两路都失败才保留旧文件。 */
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fetchOne([cdn + '/' + f, raw + '/' + f], dst);
    } catch { /* 两路都拿不到就保留旧的 */ }
  }
}

/**
 * 份额单只文件（~1700 个，每个 1.5KB）。
 *
 * 不能再用「本地有这个文件就跳过」当判据：份额是逐只发布的，那天哪只写晚了
 * 那个文件就一直不动，而 last.json 在 TOP_FILES 里天天刷到最新。结果就是清单
 * 那一列用 11-19 的 84.58，点开柱状图拿到 11-12 的 -6.08 —— 同一个页面两个
 * 日期，用户只能问「为什么不一样」。
 *
 * 改成按 last.json 的 d 打戳：日期一变整批重下（1700×1.5KB ≈ 2.5MB，几秒），
 * 日期没变才只补新上市的。失败不影响主流程：清单里那一列显示「-」而已。
 */
async function pullShares(cdn, raw, dist, codes, conc, log) {
  const dir = path.join(dist, 'shares');
  await fsp.mkdir(dir, { recursive: true });
  let day = '';
  try { day = JSON.parse(await fsp.readFile(path.join(dir, 'last.json'), 'utf8')).d || ''; } catch { /* 没拉下来 */ }
  const stampF = path.join(dir, '.stamp');
  let stamp = '';
  try { stamp = (await fsp.readFile(stampF, 'utf8')).trim(); } catch { /* 首次 */ }
  const full = !day || stamp !== day;
  const need = full ? codes : codes.filter((c) => !fs.existsSync(path.join(dir, c + '.json')));
  if (!need.length) return 0;
  log('  ' + (full ? '全量刷新' : '补') + ' ' + need.length + ' 个份额文件（截至 ' + (day || '?') + '）');
  const r = await pool(need, conc, (code) => fetchOne(
    [cdn + '/shares/' + code + '.json', raw + '/shares/' + code + '.json'],
    path.join(dir, code + '.json'),
  ), () => {});
  if (full && (r.fail.length === 0 || r.fail.length <= Math.max(8, Math.round(need.length * 0.02)))) {
    /* 戳不能要求「零失败」：511xxx 那 24 只货币/债券 ETF 上游本来就不发份额文件
       （raw 直接 404），只要有一只永久缺失，戳就永远写不下去 —— 于是每天全量重下
       1744 个，白跑三分钟，日志里也天天挂一行「24 个没拉到」。
       真正需要重来的是「大面积失败」（网络/CDN 抽风），那才不写戳。
       写戳后 full=false，need 只剩本地真缺的那几只，重试成本可以忽略。 */
    await fsp.writeFile(stampF, day).catch(() => {});
  }
  if (r.fail.length) log('  ! ' + r.fail.length + ' 个份额文件没拉到（保留本地旧的）');
  return need.length;
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
        if (!r.ok) {
          const e = new Error('HTTP ' + r.status);
          /* 4xx 是「这个文件本来就没有」，重试三次、退避两次纯属浪费：
             511xxx 那 24 只每天固定 404，按老逻辑每个走 2 路 × 3 次 + 退避，
             一次同步白等 90 秒。5xx / 超时才是真该重试的。 */
          if (r.status >= 400 && r.status < 500) e.fatal = true;
          throw e;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 32) throw new Error('内容过短(' + buf.length + 'B)');
        const tmp = dst + '.' + process.pid + '.tmp';
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, dst);
        return buf.length;
      } catch (e) {
        lastErr = e;
        if (e.fatal) break;                 /* 4xx：这路没有就是没有，换下个基址 */
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
  /* 顶层清单里任何一份本地没有，就必须走一遍——哪怕 mark 一模一样。
     这条以前是手写的两个特判（fut_last、etfopt_hist），每次新加产物都要记得
     再补一行，而「记得」正是这套东西最靠不住的地方：11-18 发现 senti_hist.json
     从没被同步过，沙箱的情绪卡片停在 11-13，内联的源码却已经是 11-17。
     现在统一从 TOP_FILES 推：往清单里加一份，存在性判断自动跟上。 */
  const missingTops = TOP_FILES.filter((f) => !fs.existsSync(path.join(dist, f)));

  const codes = (man.items || []).map((x) => x.code).filter(Boolean);
  if (!codes.length) throw new Error('远端 manifest 里没有 items，无法确定要拉哪些文件');

  const [cdn, raw] = bases(repo, branch, man.pin);

  if (!opts.force && haveHist && !missingTops.length && local
      && (local.mark === man.mark || local.sha === man.mark)) {
    /* mark 相同只说明「这一天没有新数据」，不等于「本地那几份顶层是对的」。
       senti_hist.json 就曾经**存在**、内容却停在 4 天前，而 state 里的 mark 一直是
       最新的——「已是最新，跳过」把这件事盖了整整四天：页面看着正常，只是情绪
       卡片比行情少几天，没有任何地方会报错。
       顶层 12 份一共几百 KB，无条件刷一遍最省心：判断写错一次就再也不会自愈，
       而重复下载是幂等的。hist 那 45MB 仍然按 mark 跳过。 */
    await pullTops(cdn, raw, dist);
    /* 顶层刷完还要看份额单只：mark 相同＝交易日没变，但那批文件可能从没跟上过
       （沙箱里曾经停在 11-12）。pullShares 自己按 last.json 的 d 判，不额外花时间。 */
    await pullShares(cdn, raw, dist, codes, 16, log).catch(() => 0);
    log('已是最新：' + label(man.mark) + '（' + (man.last_trade_date || '') + '），只刷顶层文件');
    return { changed: false, mark: man.mark, skipped: 'up-to-date' };
  }
  if (missingTops.length) log('本地缺 ' + missingTops.length + ' 份顶层文件，强制同步：' + missingTops.join(' '));

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

  const conc = Math.max(1, Math.min(32, Number(process.env.SYNC_CONCURRENCY || 16)));

  if (!opts.force && !opts.hist && haveHist && !missingTops.length && sameDay) {
    await pullTops(cdn, raw, dist);
    await pullShares(cdn, raw, dist, codes, conc, log).catch(() => 0);
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
  await pullTops(cdn, raw, dist);
  await pullShares(cdn, raw, dist, codes, conc, log).catch(() => 0);

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
