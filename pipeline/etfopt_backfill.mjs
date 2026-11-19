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
const overBudget = () => Date.now() - T0 > BUDGET_MS;

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
  const keepMth = new Set([...mthDte.entries()]
    .sort((a, b) => a[1] - b[1]).slice(0, 2).map((e) => e[0]));

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
  for (let pass = 1; pass <= 2; pass++) {
    const miss = uniq.filter((c) => !kls.has(c));
    if (!miss.length || overBudget()) break;
    console.log('    ' + tag + ' 补抓第 ' + pass + ' 轮：' + miss.length + ' 条');
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
    /* dte 用「当前在市合约的 dte」推到那一天：该合约今天 dte=X，则 d 那天是 X + (today−d)。
       同一个月内所有合约到期日相同，取该月任一条的 dte 即可。 */
    const dteOf = new Map();
    for (const x of ch) if (!dteOf.has(x.mth)) dteOf.set(x.mth, x.dte);
    for (const gr of groups) {
      const base = dteOf.get(gr.mth);
      gr.dte = base == null ? null : base + daysBetween(d, TODAY);
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

  /* 判「要补的那一格有没有值」。目标日分两种：
   *   收盘后 → 今天（正常跑的方式）
   *   盘中/盘前 → 老文件最后一天（那是手动补昨天，比如 11-19 早上补 11-18）
   * 只写「最后一天」会在收盘后永远跳过今天，只写「今天」在补昨天时永远不跳过。 */
  const targetDay = CLOSED ? TODAY : (lastOld || null);
  const iT = targetDay ? oldDays.indexOf(targetDay) : -1;
  const already = new Set();
  if (ONLY_MISSING && old && iT >= 0) {
    for (const [code, o] of Object.entries(old.s || {})) {
      if ((o.nb || [])[iT] != null) already.add(code);
    }
    console.log('  ' + targetDay + ' 已有 ' + already.size + ' 只，跳过它们');
  }

  const res = {};
  for (const [secid, code, tag] of LIST) {
    if (already.has(code)) { console.log('  ' + tag + ' ' + targetDay + ' 已有值，跳过'); continue; }
    if (overBudget()) {
      console.log('  ' + tag + ' 起（' + code + '）：时间预算已用完，剩余品种本轮跳过');
      break;
    }
    console.log('  ' + tag + ' (' + code + ')');
    try {
      const rows = await one(secid, code, tag);
      if (!rows || !rows.length) { console.log('    ' + tag + ' 无可还原日期'); continue; }
      res[code] = rows;
      console.log('    ' + tag + ' 还原 ' + rows.length + ' 天  ' + rows[0].d + ' ~ ' + rows[rows.length - 1].d);
    } catch (e) {
      console.log('    ' + tag + ' 失败：' + e.message);
    }
    await sleep(300);
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
  const allD = [...new Set([...oldDays, ...newDays])].sort();
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
}

main().catch((e) => { console.error(e); process.exit(1); });
