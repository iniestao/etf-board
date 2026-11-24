/* ETF 期权历史回补：不是「找历史合约」，而是「用还活着的合约倒推」。
 *
 * 背景（2026-11-10 逐个源验过，结论写在 gen_fut_daily.mjs 文件头）：
 * 已到期合约在上交所/深交所/东财/新浪全部即焚，secid 直接从索引里消失，
 * 扫 10010000~10012440 共 2441 个号命中的全是在市合约。所以「当时的当月合约
 * 价格」这条数据在免费源里根本不存在，补不回来。
 *
 * 只能反过来做：今天在市的合约里，某天它恰好是当月，那天就有真近月；否则不画。
 * 11 月合约 2026-10-29 起成为当月（10 月合约 10-28 到期），而它今天仍在市，
 * 所以能还原的就是这九个交易日；更早的日子只有当月合约消失后的下月/隔季，
 * **不拿来顶替**——隔季贴水天然更深，跟股指期权的「主力近月」不可比。
 *
 * 口径：只用真近月（当月合约），画基差率本身（bp），和 gen_fut_daily.mjs 里
 * 期权部分的 `l[0]`（dte 最小的那一档）完全一致，跨品种可以直接比。
 *
 * 为什么要和上一版合并：11 月合约 11-25 到期后连 kline 一起消失，它贡献的
 * 那九个点只有落盘的那份还留着。每天全量重算再覆盖 = 每天削一层，越跑越少。
 *
 * 用法：
 *   node pipeline/etfopt_backfill.mjs            # 全量重建，写 dist/etfopt_hist.json
 *   node pipeline/etfopt_backfill.mjs --dry      # 只打印统计，不写文件
 *   node pipeline/etfopt_backfill.mjs --recalc   # 强制用新值覆盖（正常不用）
 *
 * 兜底：某只的目标日抓不到（东财 push2his 按出口 IP 限流，队尾两只常年吃亏），
 * 自动改走「东财合约链 + 腾讯现货 + 新浪 CON_OP 快照」补这一天，见 sinaFill()。
 * 新浪只有当日快照，所以只能补最近已收盘的那个交易日，更早的洞仍靠下一轮重抓。
 */
import fs from 'fs';
import path from 'path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
/* 东财 kline 的 ut 令牌。2026-11-17 起不带它直接回 rc:100 / data:null（不是限流，
   是参数校验），带了才给 klines。硬编码不算优雅，但这个值十几年没变过，而且没有
   任何文档会告诉你它是必填的——先写死，坏了会在日志里立刻显形。 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'etfopt_hist.json');
/* 交易所当日快照（etfopt_eod.mjs 产出）。有它的日期不再向东财要价——
   那是交易所原值，比 push2his 的日线更可信，也不占东财那个按 IP 算的配额。 */
const EOD = (function () {
  const p = process.env.ETFOPT_EOD_OUT || path.join(ROOT, 'dist', 'etfopt_eod.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && j.v === 1 && j.days ? j.days : {};
  } catch (e) { return {}; }
})();
const DRY = process.argv.includes('--dry');
const CONC = 3;

/* 和 gen_fut_daily.mjs 的 ETF_OPT、page.js 的 ETF_HP 三处必须同一份清单。
   早先这里只有 4 个（另 5 个当时判断「实时表够用」），结果基差历史那一栏的标签
   比上面实时表少 5 个，点不到 500ETF / 创业板 / 深100 的历史——补齐。 */
const LIST = [
  ['1.510050', '510050', '50ETF'],
  ['1.510300', '510300', '300ETF'],
  ['1.510500', '510500', '500ETF'],
  ['1.588000', '588000', '科创50'],
  ['1.588080', '588080', '科创板50'],
  ['0.159919', '159919', '300ETF深'],
  ['0.159922', '159922', '500ETF深'],
  ['0.159915', '159915', '创业板'],
  ['0.159901', '159901', '深100'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 时间预算 ----------------
 * 2026-11-18 那一轮死在「重建 ETF 期权历史」上：东财对 300ETF 的 124 个合约
 * 集体超时（只回来 48 条），脚本按「失败就一条条补」往下走，76 条单线程 × 每条
 * 最多 5 次 × 20 秒超时，两轮下来 28 分钟没出过一行日志，最后撞上 job 的 60 分钟
 * 上限被取消——后面的「发布到 data 分支」全是 skipped，11-18 一整天数据全丢。
 *
 * 教训不是「重试要更多」，而是这个脚本没有给自己设上限。它只是个辅助产物，
 * 拖死整轮等于用一份期权历史换掉行情、期指、情绪、板块、份额五份。
 * 现在：整脚本 8 分钟内必须收尾，到点就把已经拿到的写出去（老值照旧保留），
 * 剩下的品种明天再来——合并规则本来就是每天只加不删，缺一轮不会变少。
 */
const BUDGET_MS = Number(process.env.ETFOPT_BUDGET_MS || 8 * 60e3);
const T0 = Date.now();
/* need：这一只**至少**要留多少毫秒。带 need 判断是为了别在只剩 40 秒时起动一个
 * 「20 档日线 + 撞限流 + 等 45 秒补抓两轮」的活——那一定做不完，还会把后面几只
 * 的兜底一起挤掉。 */
const overBudget = (need = 0) => Date.now() - T0 > BUDGET_MS - need;

/* 重试 3 次、10 秒超时。原来 5 次 × 20 秒：一次限流要花 100 秒才认输，
   而 100 个合约的失败叠起来就是半小时——重试次数买不到数据，只买到等待。 */
async function jget(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      await sleep(400 * (i + 1) + Math.random() * 400);
    }
  }
  throw last;
}

/** 当前在市合约清单。spt=9/10 是东财的两个分页段，要去重。 */
async function chain(secid) {
  const out = new Map();
  for (const spt of [9, 10]) {
    const u = 'https://push2.eastmoney.com/api/qt/slist/get?spt=' + spt
      + '&fltt=2&invt=2&fields=f12,f13,f14,f161,f162&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3';
    const j = await jget(u, 4).catch(() => null);
    const d = (j && j.data && j.data.diff) || {};
    const items = Array.isArray(d) ? d : Object.values(d);
    for (const x of items) {
      if (!x || !x.f12) continue;
      const m = /([购沽])(\d+)月(\d+)/.exec(x.f14 || '');
      if (!m) continue;
      const code = String(x.f12);
      if (out.has(code)) continue;
      out.set(code, {
        code,
        mk: x.f13 || 10,          // 沪市期权 f13=10，深市 f13=12，日线 secid 要用它
        side: m[1] === '购' ? 'C' : 'P',
        mth: +m[2],
        k: +m[3] / 1000,          // 东财行权价字段是「厘」，3300 → 3.300
        dte: +x.f162,
      });
    }
    await sleep(120);
  }
  return [...out.values()];
}

/** 日线收盘价 map：{'2026-11-10': 2.891} */
async function kline(secid) {
  const u = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=' + UT
    + '&secid=' + secid
    + '&klt=101&fqt=0&beg=0&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
  const j = await jget(u);
  const dd = j && j.data;
  if (!dd || !dd.klines) return null;
  const out = {};
  for (const ln of dd.klines) {
    const p = ln.split(',');
    out[p[0]] = +p[2];
  }
  return out;
}

/* ---------------- 现货日线：腾讯优先 ----------------
 * 2026-11-17 起东财 push2his 的 kline 不带 ut 就回 `rc:100 / data:null`，带上也
 * 时好时坏。11-16 那晚 9 只 ETF 的现货日线全灭，脚本逐只打「现货日线取不到」，
 * 合并规则「老值优先」把整份文件原样留下——日期轴停在 13 号，而流水线是 success。
 * 现货是基差的分母（S），缺它整只 ETF 就没有任何一天能算。
 *
 * 腾讯 newfqkline 是 gen_mkt_hist 已经在用的源（那份注释里写过同一件事）。这里要
 * 不复权：期权合约价本身不复权，ETF 分红除息日拿前复权价当 S，基差会凭空跳一格。
 */
const txSym = (code) => (/^[56]/.test(code) ? 'sh' : 'sz') + code;
async function txKline(code) {
  const sym = txSym(code);
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param='
    + sym + ',day,,,400,';
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const node = j && j.data && j.data[sym];
  const rows = (node && (node.qfqday || node.day)) || [];
  const out = {};
  for (const x of rows) if (x && x[0]) out[x[0]] = +x[2];
  return Object.keys(out).length ? out : null;
}

async function spotKline(secid, code) {
  for (let a = 0; a < 2; a++) {
    const s = await txKline(code).catch(() => null);
    if (s) return s;
    await sleep(400);
  }
  /* 腾讯也挂时退回东财。留这条不是因为还指望它，而是多一个源就多一次机会，
     失败路径上再没有别的东西可以兜了。 */
  for (let a = 0; a < 2; a++) {
    const s = await kline(secid).catch(() => null);
    if (s) return s;
    await sleep(600);
  }
  return null;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 和 gen_fut_daily.mjs 的 atmWindow 逐字一致：|K/S−1|≤3% 起，凑不满 3 档就一路放宽
 *  到 5%/8%/12%，还不行就取最近的 3 档。
 *
 *  不能写死 3%：科创50 的档距是 0.05，标的 1.36 时 0.05/1.36＝3.7%，±3% 里只装得下
 *  一档。2026-11-05 就是这样——S=1.358、窗口 [1.317,1.399]，只有 1.35 落在里面，
 *  1.40 差 0.001 被挡在外面，于是那天算不出合成价、图上直接缺一格。 */
function atmWindow(pairs, S) {
  const byDist = pairs.slice().sort((a, b) => Math.abs(a.k - S) - Math.abs(b.k - S));
  for (const w of [0.03, 0.05, 0.08, 0.12]) {
    const near = byDist.filter((x) => S > 0 && Math.abs(x.k / S - 1) <= w).slice(0, 5);
    if (near.length >= 3) return near;
  }
  return byDist.slice(0, Math.min(3, byDist.length));
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** 某月的第四个星期三——ETF 期权的到期日。遇节假日交易所会顺延，
 *  这里不查日历：顺延那一两天会被判成「已换月」而跳过，宁可缺着。 */
function fourthWed(y, m) {
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const firstWed = 1 + ((3 - dow + 7) % 7);
  return Date.UTC(y, m - 1, firstWed + 21);
}

/** d 那天、mth 这个到期月的剩余天数（含到期当天）。
 *
 *  以前是「东财 f162 + (今天−d)」，f162 不含当天，于是整条口径系统性少一天：
 *  2026-11-24 复核，162 个格子里 135 个比真值少 1，年化因此虚高 3.7%
 *  （365/27 对 365/28）。同一到期日还会出现沪市 3、深市 2 两个答案——沪市
 *  那格是 EOD 快照写的（走 fourthWed），深市那格是东财推的（走 f162）。
 *  现在两边都按「第四个星期三」算，跟 etfopt_eod.mjs 完全同一套。 */
function dteByExpiry(mth, dstr) {
  const y = +dstr.slice(0, 4), m = +dstr.slice(5, 7);
  const yy = mth < m ? y + 1 : y;      // 1 月合约在 12 月看，到期日在明年
  const exp = new Date(fourthWed(yy, mth)).toISOString().slice(0, 10);
  return daysBetween(dstr, exp) + 1;
}

/** d 那天的「当月合约」是哪个月份。ETF 期权每月都挂，所以这是个确定性判断：
 *  本月第四个星期三没过就是本月，过了就是下个月。 */
function frontMonth(dstr) {
  const t = Date.parse(dstr + 'T00:00:00Z');
  const dt = new Date(t);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
  if (t <= fourthWed(y, m)) return m;
  return m === 12 ? 1 : m + 1;
}

async function one(secid, code, tag) {
  const ch = await chain(secid);
  if (!ch.length) { console.log('  ' + tag + ' 期权链为空'); return null; }

  /* 现货日线是整只 ETF 的锚（S），取不到就当这只失败——那是分母，不能瞎补。
     腾讯优先、东财兜底（见 spotKline 上面的注释）。 */
  const spotK = await spotKline(secid, code);
  if (!spotK) { console.log('  ' + tag + ' 现货日线取不到（腾讯+东财都失败）'); return null; }

  /* 只抓最近的 2 个到期月（当月 + 次月）。
   *
   * 原来把在市合约全拉一遍：300ETF 124 档、科创50 178 档，而最终只用
   * `frontMonth(d)` 那一个月，剩下的（12 月、次年 3 月、6 月）拉回来就扔。
   * 18 号那轮就是死在这上面：48/124 之后剩下 76 条怎么补都补不完。
   *
   * 实测按到期月拆（2026-11-19）：300ETF = 11月30 + 12月38 + 3月34 + 6月22；
   * 只留 2 个月就砍掉一半请求。为什么不只留当月：11-26 是 11 月合约的最后
   * 交易日，那天之后当月变成 12 月，只抓一个月会在换月那天断掉。
   * 再多就没必要了——第 3 个月（次年 3 月）永远是「隔季」，`frontMonth` 直接否掉。 */
  const mthDte = new Map();
  for (const x of ch) {
    const v = mthDte.get(x.mth);
    if (v == null || x.dte < v) mthDte.set(x.mth, x.dte);
  }
  /* 只留 dte 最小的那一个月。
   *
   * 留两个是白抓：算基差只取 frontMonth(d) 那个月，而「今天仍在市」的合约里，
   * 只有当月能当历史的当月——次月在任何一天都不是「当月」，拉回来就扔。
   * 换月那天也不需要提前抓：dte 最小的月会自己从 11 月切成 12 月，
   * 已经到期消失的 11 月数据早在文件里（合并规则只加不删）。
   *
   * 实测 159915 从 48 档降到 24、159901 从 32 降到 16，9 只总量约 85 条，
   * 一轮内能打完——原来 170 条必撞东财那个 ~130 条/分钟的阈值。 */
  const keepMth = new Set([...mthDte.entries()]
    .sort((a, b) => a[1] - b[1]).slice(0, 1).map((e) => e[0]));

  /* 再按行权价砍一道：只留「近 20 个交易日里可能落在平值附近」的档位。
   *
   * 2026-11-19 那轮补 11-18 时印证了限流的粒度：510050、510300 拿到 18 号，
   * 之后 7 只一条都抓不到——不是随机失败，是累计请求数过了阈值（前两只共约
   * 166 条），后面全被拒。所以问题不是「重试不够」，是**总数太大**。
   * 2 个月仍要 68 档/只，9 只 600 多条，必然撞墙。
   *
   * 实际用到的只有平值上下几档（atmWindow 最宽放到 12%）。按近 20 日现货
   * 区间再放 4% 余量筛一遍，每只降到 20~30 档，9 只总量落在 200 出头。
   * 筛完为空（数据异常）就退回整月，宁可慢也不能算出空结果。 */
  const sDays = Object.keys(spotK).filter((d) => spotK[d] > 0).sort().slice(-20);
  const sVals = sDays.map((d) => spotK[d]);
  const kLo = Math.min(...sVals) * 0.96;
  const kHi = Math.max(...sVals) * 1.04;
  let nearCh = ch.filter((x) => keepMth.has(x.mth) && x.k >= kLo && x.k <= kHi);
  if (!nearCh.length) {
    console.log('    ' + tag + ' 平值窗口筛完为空，退回整月');
    nearCh = ch.filter((x) => keepMth.has(x.mth));
  }

  const mkOf = new Map(nearCh.map((x) => [x.code, x.mk]));
  const uniq = [...new Set(nearCh.map((x) => x.code))];
  const kls = new Map();
  let done = 0, streak = 0;
  for (let i = 0; i < uniq.length; i += CONC) {
    if (overBudget()) { console.log('    ' + tag + ' 时间预算到了，停在这里'); break; }
    const seg = uniq.slice(i, i + CONC);
    const res = await Promise.all(seg.map((c) => kline(mkOf.get(c) + '.' + c).catch(() => null)));
    seg.forEach((c, k) => {
      if (res[k]) { kls.set(c, res[k]); streak = 0; } else streak++;
    });
    /* 连着 10 条一条都没回来，就不是「偶发失败」了，是这个源在限流/断连。
       继续往下打只会把预算烧在同一处——2026-11-18 的 28 分钟无声等待就是这么来的。 */
    if (streak >= 10) {
      console.log('    ' + tag + ' 连续 10 条抓不到，判定被限流，停止剩余合约');
      break;
    }
    done += seg.length;
    if (done % 20 === 0) process.stdout.write('    ' + tag + ' ' + done + '/' + uniq.length + '\r');
    /* 批间隔 60ms 时 3 并发等于每秒 50 个请求，东财那边连续拒了 7 只。
       250ms 把速率压到每秒 12 个——慢 3 秒，换整只 ETF 的数据。 */
    await sleep(250);
  }
  console.log('    ' + tag + ' 日线 ' + kls.size + '/' + uniq.length + '   档');

  /* 抓失败的合约必须补回来，不能就这么算了。
     一条日线缺了，那个到期月在那几天就配不成 C/P，整段日期直接消失——2026-11-13
     就是这样丢的：文件里日期轴有 13 号，9 只里 8 只那天的值是 null。不是源上没有
     数据，是这一轮抓取被限流（116 条只回来 61 条），而失败被 .catch(()=>null) 吞了。
     现在补一轮、3 条并发、受预算约束：慢一分钟好过留一个静默空档，但不能慢到
     把整条流水线拖死——这两件事的优先级不一样。 */
  /* --only-missing 时只浅补一轮：这时「当天那一格」已经由上面的新浪快照兜底拿过，
     东财这一趟只是为了补历史洞，撞上限流就没必要再等 45 秒重打两轮——9 只 ×90 秒
     正好把 8 分钟预算吃光，而它换回来的往往是 0 条。 */
  const PASSES = ONLY_MISSING ? 1 : 2;
  for (let pass = 1; pass <= PASSES; pass++) {
    const miss = uniq.filter((c) => !kls.has(c));
    /* 补抓一轮 = 等 45 秒 + 重打；两轮就是 90 秒起。剩余预算不够 2 分钟时
       直接放弃补抓——留着预算给后面几只的「当天兜底」，那才是必保的那一格。 */
    if (!miss.length || overBudget(120e3)) break;
    /* 撞到限流后立刻补，等于继续打——2026-11-20 那轮 159922 从 00:05:56 一直
       被拒到 00:12:53，七分钟里补了两轮、一条没回来，因为窗口一直是满的。
       先停 45 秒把窗口放空，再补，才补得动。 */
    const wait = ONLY_MISSING ? 8000 : 45000;
    console.log('    ' + tag + ' 补抓第 ' + pass + ' 轮：' + miss.length + ' 条（先等 ' + (wait / 1000) + ' 秒让配额恢复）');
    await sleep(wait);
    for (let i = 0; i < miss.length; i += CONC) {
      if (overBudget()) { console.log('    ' + tag + ' 补抓超预算，先收尾'); break; }
      const seg = miss.slice(i, i + CONC);
      const res = await Promise.all(seg.map((c) => kline(mkOf.get(c) + '.' + c).catch(() => null)));
      seg.forEach((c, k) => { if (res[k]) kls.set(c, res[k]); });
      await sleep(150);
    }
  }
  if (kls.size < uniq.length) {
    console.log('    ' + tag + ' 仍有 ' + (uniq.length - kls.size) + ' 条日线没抓到（补抓后）');
  }

  /* 按「到期月 + 行权价」配对 C/P，再把每个合约的日线铺到日期轴上 */
  const byKey = new Map();      // mth|k -> {C:{}, P:{}}
  for (const x of ch) {
    const kk = x.mth + '|' + x.k;
    if (!byKey.has(kk)) byKey.set(kk, { mth: x.mth, k: x.k, dte: x.dte, C: null, P: null });
    const slot = byKey.get(kk);
    const s = kls.get(x.code);
    if (s) slot[x.side] = s;
  }

  /* 每天：多组（几个到期月）各算一个 bp，再挑 dte 最小 / 最大的那组 */
  const perDay = new Map();     // date -> [{mth, dte, bp, n}]
  for (const slot of byKey.values()) {
    if (!slot.C || !slot.P) continue;
    for (const d of Object.keys(slot.C)) {
      const p = slot.P[d];
      const S = spotK[d];
      if (p == null || !(S > 0)) continue;
      // 该合约在 d 那天的剩余天数：今天 dte 天到期 → 到期日 = 今天 + dte
      // 用「今天」做锚，避免每个合约各算一套
      if (!perDay.has(d)) perDay.set(d, []);
      perDay.get(d).push({ mth: slot.mth, k: slot.k, c: slot.C[d], p, S });
    }
  }

  const rows = [];
  for (const d of [...perDay.keys()].sort()) {
    const items = perDay.get(d);
    const S = items[0].S;
    // 按到期月分组 → 每组 ATM 中位数合成
    const g = new Map();
    for (const it of items) {
      if (!g.has(it.mth)) g.set(it.mth, []);
      g.get(it.mth).push(it);
    }
    const groups = [];
    for (const [mth, arr] of g) {
      const w = atmWindow(arr, S);
      // 放宽到 12% 还凑不出，说明这个月当天确实没有可配的档（停牌/新挂），
      // 那天就空着——和「宁可缺着」一致，不拿别的月份顶。
      if (!w.length) continue;
      const syn = median(w.map((x) => x.k + x.c - x.p));
      groups.push({ mth, n: w.length, syn, bp: (syn - S) / S * 100 });
    }
    if (!groups.length) continue;
    /* dte 按到期日推：该月合约在 d 那天还有几天到期（含当天）。
       以前用「东财 f162 + (今天−d)」，f162 不含当天，整条口径少一天。 */
    for (const gr of groups) {
      gr.dte = dteByExpiry(gr.mth, d);
    }
    groups.sort((a, b) => a.dte - b.dte);
    const near = groups[0];
    if (near.dte == null) continue;
    /* 只留真近月。判据不是「我手上最短的那组」（那可能是隔季），而是「按日历
       当月该是哪个月」：2026-09-24 那天最短可用是 11 月合约，可当时的当月是
       10 月（10-28 到期）、它的价格已经消失，11 月其实是下月。这种天宁可不画。 */
    if (near.mth !== frontMonth(d)) continue;
    /* 盘中跑（手动补数、调试）时今天的日线是「此刻」的价格，不是收盘价。
       写成收盘值之后，合并规则是「老值优先」，这个错值会被永久钉住。 */
    if (d === TODAY && !CLOSED) continue;
    rows.push({
      d,
      near: { mth: near.mth, dte: near.dte, n: near.n, bp: +near.bp.toFixed(3),
              ann: near.dte >= 3 ? +(near.bp * 365 / near.dte).toFixed(2) : null },
    });
  }
  return rows;
}

/* 一律按北京时间取日期。以前用 toISOString()（UTC），凌晨跑的时候「今天」会退回
   前一天，dte 跟着少一天——dte 是年化基差的分母，差一天就和实时表里的数对不上。 */
const bjNow = () => new Date(Date.now() + 8 * 3600e3);
const TODAY = bjNow().toISOString().slice(0, 10);
const CLOSED = (function () {
  const t = bjNow(), dow = t.getUTCDay();
  return dow !== 0 && dow !== 6 && (t.getUTCHours() * 100 + t.getUTCMinutes()) >= 1505;
})();

/* 最近一个「已经收盘」的交易日。过 15:05 就是今天，否则退到上一个工作日。
   节假日会推到没有行情的日子——那种天在旧文件里没有格子（iT<0），already 为空，
   正常跑一遍、抓不到新数据也不会写错，只是慢一点。 */
const lastClosedTradingDay = (function () {
  const t = bjNow();
  let d = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  if (t.getUTCHours() * 100 + t.getUTCMinutes() < 1505) d -= 86400e3;
  for (let i = 0; i < 10; i++) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    d -= 86400e3;
  }
  return new Date(d).toISOString().slice(0, 10);
})();

/* ---------------- 新浪快照兜底：日线被限流时的最后一条路 ----------------
 * 东财 push2his 的配额是按「出口 IP」算的，Actions 的 runner 落在 Azure 公共池里，
 * 同一时刻还有别人的抓取在打同一个池——所以每轮能过几只全看运气：
 * 2026-11-19 前 2 只成功、2026-11-20 前 7 只成功（106 秒 84 档，第 85 档起全拒），
 * 切点随机，但**队尾固定吃亏**。159901/159915 排在 LIST 最后，连着两天断在它们身上。
 *
 * 还有一条不共享那个配额的组合：
 *   合约链    push2.eastmoney.com/api/qt/slist   （另一个域，配额独立）
 *   现货收盘  腾讯 newfqkline                    （spotKline 本来就用它）
 *   期权收盘  hq.sinajs.cn/list=CON_OP_xxx       （一条请求拿全部档）
 * 新浪只给**当日快照**、没有历史，所以只补「最近已收盘的交易日」这一天；
 * 时间戳对不上目标日就整只放弃——宁可不补，也不能把今天的价写成昨天的。
 *
 * 口径与 one() 逐字一致（同一套 keepMth、平值窗口、median(K+C−P)）。
 * 2026-11-21 拿已经算好的三只回验：159919 -0.959 / 159922 -0.400 / 510050 -1.241，
 * 与东财日线版本逐位相同，确认窗口与合成法没有偏差。
 */
async function sinaQuotes(codes) {
  const url = 'https://hq.sinajs.cn/list=' + codes.map((c) => 'CON_OP_' + c).join(',');
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      /* 新浪是 GBK。Node 自带 full-icu 时 TextDecoder('gbk') 直接可用；
         万一哪天跑在裁剪过的运行时上，退回 utf8 也能解析——正文里的中文会变成
         替换字符，但我们要的数字、引号、日期都是 ASCII，一个都不受影响。 */
      let txt;
      try { txt = new TextDecoder('gbk').decode(buf); }
      catch (e) { txt = new TextDecoder('utf-8').decode(buf); }
      const out = new Map();
      for (const m of txt.matchAll(/CON_OP_(\d+)="([^"]*)"/g)) {
        const f = m[2].split(',');
        if (f.length < 33) continue;
        out.set(m[1], { last: +f[2], prev: +f[8], k: +f[7], oi: +f[5], ts: (f[32] || '').trim() });
      }
      return out;
    } catch (e) {
      if (i === 2) { console.log('    兜底 新浪报价取不到：' + e.message); return new Map(); }
      await sleep(1500 * (i + 1));
    }
  }
  return new Map();
}

async function sinaFill(secid, code, tag) {
  const target = lastClosedTradingDay;
  const ch = await chain(secid).catch(() => []);
  if (!ch.length) { console.log('    兜底 ' + tag + ' 合约链取不到，放弃'); return null; }

  const spotK = await spotKline(secid, code).catch(() => null);
  const S = spotK && spotK[target];
  if (!(S > 0)) { console.log('    兜底 ' + tag + ' 没有 ' + target + ' 的现货收盘，放弃'); return null; }

  /* 与 one() 同一套筛法：只留 dte 最小的月，再按近 20 日现货区间砍行权价 */
  const mthDte = new Map();
  for (const x of ch) {
    const v = mthDte.get(x.mth);
    if (v == null || x.dte < v) mthDte.set(x.mth, x.dte);
  }
  const mth = [...mthDte.entries()].sort((a, b) => a[1] - b[1])[0][0];
  /* 换月之后链上最短的月是新的当月，可 target 那天的当月还是旧的那个——
     旧合约已经到期消失，这条兜底补不了，老老实实留空。 */
  if (mth !== frontMonth(target)) {
    console.log('    兜底 ' + tag + ' ' + target + ' 的当月是 ' + frontMonth(target)
      + ' 月、链上最短是 ' + mth + ' 月，不补');
    return null;
  }

  const sDays = Object.keys(spotK).filter((d) => spotK[d] > 0).sort().slice(-20);
  const sVals = sDays.map((d) => spotK[d]);
  const kLo = Math.min(...sVals) * 0.96, kHi = Math.max(...sVals) * 1.04;

  const byK = new Map();
  for (const x of ch) {
    if (x.mth !== mth || x.k < kLo || x.k > kHi) continue;
    if (!byK.has(x.k)) byK.set(x.k, {});
    byK.get(x.k)[x.side] = x.code;
  }
  const pairs = [...byK.entries()]
    .filter(([, v]) => v.C && v.P)
    .map(([k, v]) => ({ k, C: v.C, P: v.P }));
  if (!pairs.length) { console.log('    兜底 ' + tag + ' 平值窗口里没有可配的 C/P 档'); return null; }

  const win = atmWindow(pairs, S);
  const sn = await sinaQuotes([...win.map((x) => x.C), ...win.map((x) => x.P)]);
  const syns = [];
  let stale = 0, empty = 0;
  for (const x of win) {
    const c = sn.get(x.C), p = sn.get(x.P);
    if (!c || !p || !(c.last > 0) || !(p.last > 0)) { empty++; continue; }
    if (!c.ts.startsWith(target) || !p.ts.startsWith(target)) { stale++; continue; }
    syns.push(x.k + c.last - p.last);
  }
  if (!syns.length) {
    console.log('    兜底 ' + tag + ' 新浪无可用价（日期不符 ' + stale + ' 档，缺价 ' + empty + ' 档）');
    return null;
  }
  const syn = median(syns);
  const bp = (syn - S) / S * 100;
  const dte = dteByExpiry(mth, target);
  console.log('    兜底 ' + tag + ' 新浪 ' + syns.length + '/' + win.length + ' 档'
    + '  S=' + S.toFixed(3) + '  syn=' + syn.toFixed(4) + '  bp=' + bp.toFixed(3) + '%');
  return [{
    d: target,
    near: {
      mth,
      dte,
      n: syns.length,
      bp: +bp.toFixed(3),
      ann: dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
    },
  }];
}

/* 只补缺的：最近那个交易日已经有值的品种直接跳过。
 *
 * 东财对同一 IP 是「跑到某个点开始全拒」，不是随机丢包（2026-11-19 两轮：
 * 一轮前 2 只成功、一轮前 3 只成功，之后 6 只一条都抓不到）。所以第二轮不能
 * 把已经拿到的再抓一遍——那正好把配额烧在不需要的地方，剩下的照样轮不到。 */
const ONLY_MISSING = process.argv.includes('--only-missing');

async function main() {
  console.log('ETF 期权历史重建  today=' + TODAY
    + '  预算 ' + Math.round(BUDGET_MS / 1000) + 's'
    + (ONLY_MISSING ? '  只补缺的' : ''));

  const raw = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return null; } })();
  const old = raw && raw.v === 2 ? raw : null;
  if (raw && !old) console.log('  旧文件口径是隔季（v≠2），整份丢弃，按真近月重新开始');
  const oldDays = (old && old.d) || [];
  const lastOld = oldDays[oldDays.length - 1];

  /* 判「要补的那一格有没有值」。目标日是**最近一个已收盘的交易日**，不是
   * 「老文件最后一天」。
   *
   * 原来写 CLOSED ? TODAY : lastOld，两个分支都踩过：
   *   - 凌晨跑（GitHub 把 16:35 的定时拖到次日 01:35）：CLOSED=false
   *     （01:35 < 15:05），于是拿 lastOld 当目标日 → 9 只全部「已有值，跳过」，
   *     11-19 一整天白跑，最后是时效体检把它红出来的。
   *   - 上一轮自己失败时，lastOld 就停在失败那天，下一轮继续拿它当目标日 →
   *     永远跳过同一格，"只补缺的" 退化成 "永不补"。
   * lastOld 只能说明「上次跑到哪」，不能说明「该跑到哪」。 */
  const targetDay = lastClosedTradingDay;
  /* 判「齐了没有」要看最近两个交易日，不只看目标日。
   * 只判目标日的话，一次限流留下的空档会永远留着：11-19 那天 159901/159915
   * 是 null，第二天目标日变成 11-20，两只都被判「已有值」跳过，11-19 的坑再也
   * 没人填。而 one() 本来每轮都返回整段 16 天，合并只补空——只要没被跳过，
   * 昨天的空档顺带就补上了。
   * 目标日还不在文件里（新的一天）时，needDays 为空，9 只都跑。 */
  const iTgt0 = oldDays.indexOf(targetDay);
  const needDays = iTgt0 >= 0 ? [targetDay, oldDays[iTgt0 - 1]].filter(Boolean) : [];
  const already = new Set();
  if (ONLY_MISSING && old && needDays.length) {
    for (const [code, o] of Object.entries(old.s || {})) {
      const arr = o.nb || [];
      const full = needDays.every((d) => {
        const i = oldDays.indexOf(d);
        return i >= 0 && arr[i] != null;
      });
      if (full) already.add(code);
    }
    console.log('  ' + needDays.join(' / ') + ' 都有值的 ' + already.size + ' 只，跳过它们');
  } else if (ONLY_MISSING) {
    console.log('  ' + targetDay + ' 还不在旧文件里（旧文件停在 '
      + (lastOld || '无') + '），全部重抓');
  }

  const res = {};
  /* 主路径连续几只用完都拿不到目标日 = 这一轮东财配额已经被挡死。继续试只是
   * 每只白等「撞 10 条 + 45 秒补抓 ×2」，而 11-23 的翻车正是这个顺序造成的：
   * 50ETF 花 2 分半、300ETF 又花 3 分，第三只起预算见底，剩下 7 只连兜底都没轮到。 */
  let deepFail = 0;
  for (const [secid, code, tag] of LIST) {
    if (already.has(code)) { console.log('  ' + tag + ' ' + targetDay + ' 已有值，跳过'); continue; }
    if (overBudget()) {
      console.log('  ' + tag + ' 起（' + code + '）：时间预算已用完，剩余品种本轮跳过');
      break;
    }

    /* 先补当天，再补历史。当天那一格只有新浪快照能给（约 5 秒），而东财那套
     * 「20 档日线 + 撞限流 + 等 45 秒补抓两轮」在配额用完时要两分半。把最要紧的
     * 那一格放在最后，等于把它的成败交给「前面几只碰巧够快」。 */
    /* 交易所快照已经落了今天，就别再要新浪那一份：省 5 秒是小事，
       更重要的是把「当天有没有数」的唯一责任交给交易所，而不是快照。 */
    const eodToday = EOD[targetDay] && EOD[targetDay][code] && !/intraday/.test(EOD[targetDay][code].src || '');
    if (eodToday) {
      console.log('  ' + tag + ' ' + targetDay + ' 已有交易所快照 ' + EOD[targetDay][code].bp
        + '%，不再取新浪');
    } else if (!overBudget(20e3)) {
      try {
        const fb = await sinaFill(secid, code, tag);
        if (fb && fb.length) {
          res[code] = (res[code] || []).concat(fb);
          console.log('  ' + tag + ' 兜底补上 ' + targetDay + '  ' + fb[0].near.bp
            + '%（' + fb[0].near.n + ' 档）');
        }
      } catch (e) {
        console.log('    兜底 ' + tag + ' 失败：' + e.message);
      }
    }

    /* 历史那十几天只有东财能给：还有配额就试，连续两只拿不到就认输，把剩下的
     * 预算全留给后面几只的当天兜底。 */
    if (deepFail < 2 && !overBudget(90e3)) {
      console.log('  ' + tag + ' (' + code + ')');
      try {
        const rows = await one(secid, code, tag);
        if (rows && rows.length) {
          res[code] = (res[code] || []).concat(rows);
          console.log('    ' + tag + ' 还原 ' + rows.length + ' 天  ' + rows[0].d + ' ~ ' + rows[rows.length - 1].d);
        } else {
          console.log('    ' + tag + ' 无可还原日期');
        }
      } catch (e) {
        console.log('    ' + tag + ' 失败：' + e.message);
      }
      const got = (res[code] || []).some((r) => r.d === targetDay);
      deepFail = got ? 0 : deepFail + 1;
      if (deepFail >= 2) {
        console.log('    东财日线暂停：连续两只拿不到 ' + targetDay
          + '，这一轮配额已被挡死，剩余品种只走当天兜底');
      }
      /* 每只间隔 12 秒是给东财配额留恢复时间；已经不指望它了就别再拖时间。 */
      await sleep(deepFail >= 2 ? 600 : 12000);
    } else {
      await sleep(400);
    }
  }

  /* ---------------- 和上一版合并 ----------------
   * 必须合并，不能覆盖。理由：今天还在市的合约，下个月就没了——11 月合约 2026-11-25
   * 到期后连 kline 都删掉，它贡献的那些近月点只有落盘的那份还留着。
   * 每天全量重算再整体覆盖，等于每天把历史削掉一层，越跑越少。
   *
   * 规则：老日期用老值，新日期用新值，两边都有时留老值。
   * 万一老值是错的，加 --recalc 可强制用新值重算。
   *
   * v:2 —— 2026-11-10 晚改过口径（隔季 → 真近月），旧文件里的 nb/na 装的其实是
   * 远月，不能混进来当老值。读到没有 v:2 的旧文件整份丢弃，从现在重新攒。
   * （raw / old / oldDays 在 main 开头读过了，这里直接用。） */
  const recalc = process.argv.includes('--recalc');

  const newDays = [...new Set(Object.values(res).flatMap((r) => r.map((x) => x.d)))];
  /* EOD 里的日期也要进轴：它可能比东财多出一天（东财全挂时，只有交易所快照
     留下了今天那一格）。调试用的 intraday 记录一律不算。 */
  const eodDays = Object.entries(EOD)
    .filter(([, m]) => Object.values(m).some((v) => v && v.bp != null && !/intraday/.test(v.src || '')))
    .map(([d]) => d);
  const allD = [...new Set([...oldDays, ...newDays, ...eodDays])].sort();
  const idx = new Map(allD.map((d, i) => [d, i]));

  const KEYS = ['nb', 'na', 'nd', 'nm'];
  const s = {};
  const codes = [...new Set([...Object.keys((old && old.s) || {}), ...Object.keys(res)])];
  for (const code of codes) {
    const n = allD.length;
    const o = {};
    for (const k of KEYS) o[k] = new Array(n).fill(null);

    // 1) 先把老值铺满
    const ov = (old && old.s && old.s[code]) || null;
    if (ov) {
      for (const k of KEYS) {
        const arr = ov[k] || [];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] == null) continue;
          const t = idx.get(oldDays[i]);
          if (t != null) o[k][t] = arr[i];
        }
      }
    }
    // 2) 新值补空（--recalc 时反过来，新值覆盖老值）
    for (const r of res[code] ? res[code] : []) {
      const i = idx.get(r.d);
      if (i == null) continue;
      const put = (k, v) => { if (recalc || o[k][i] == null) o[k][i] = v; };
      put('nb', r.near.bp); put('na', r.near.ann); put('nd', r.near.dte); put('nm', r.near.mth);
    }
    /* 3) 交易所快照最后盖一层。这里是无条件覆盖（老值也盖），因为：
          · 它只覆盖自己有的那几天，而它有的那几天本来就是「今天/最近几天」；
          · 价格直接来自交易所行情，比东财日线更可信；
          · 万一东财那天算出来是个错值（把盘中价当收盘），也该被它纠正。
        --recalc 反而跳过它：那是「按东财重算」的语义，不该被快照挡住。 */
    if (!recalc) {
      for (const [d, m] of Object.entries(EOD)) {
        const i = idx.get(d);
        if (i == null) continue;
        const e = m[code];
        if (!e || e.bp == null || /intraday/.test(e.src || '')) continue;
        o.nb[i] = e.bp; o.na[i] = e.ann; o.nd[i] = e.dte; o.nm[i] = e.mth;
      }
    }
    s[code] = o;
  }

  const out = {
    v: 2,
    ok: 1,
    gen: new Date().toISOString(),
    note: '只用真近月（当月合约）。历史上「当时那个当月合约」到期后全网无价格，那天就空着——'
      + '宁可缺，也不拿隔季顶替（隔季贴水天然更深，和股指期权近月不可比）。',
    d: allD,
    s,
  };

  if (DRY) {
    console.log('\n--dry：不写文件');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log('\n写入 ' + OUT + '  ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
  }
  console.log('日期轴 ' + allD.length + ' 天  ' + (allD[0] || '-') + ' ~ ' + (allD[allD.length - 1] || '-'));
  for (const [code, o] of Object.entries(s)) {
    const nf = o.nb.filter((x) => x != null).length;
    const dts = o.nd.filter((x) => x != null);
    console.log('  ' + code + '  近月 ' + nf + ' 天'
      + (dts.length ? '  dte ' + Math.min(...dts) + '~' + Math.max(...dts) : ''));
  }

  /* 收尾对一次账：目标日到底补上没有。
   * 上面任何一处「跳过」都可能让脚本 success 却没干活——11-19 就是这样，9 只全
   * 「已有值，跳过」，日志一片正常，数据停在 11-18，最后是时效体检红出来的。
   * 这里把差距直接写在日志末尾，不用再去翻日期轴。 */
  const iTgt = allD.indexOf(targetDay);
  if (iTgt < 0) {
    console.log('  ! ' + targetDay + ' 不在日期轴上（源上还没有这天的近月），最新仍是 '
      + (allD[allD.length - 1] || '-'));
  } else {
    const hole = Object.entries(s).filter(([, o]) => o.nb[iTgt] == null).map(([c]) => c);
    console.log(hole.length
      ? '  ! ' + targetDay + ' 缺 ' + hole.length + ' 只：' + hole.join(' ') + '（下一轮再补）'
      : '  ✓ ' + targetDay + ' 九只齐');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
