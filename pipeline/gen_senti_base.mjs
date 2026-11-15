/**
 * 回算「同刻曾触板」基准 → worker/src/senti_base.js
 * ==================================================
 * 盘中「今天涨停 20 家」这个数单独看没有任何意义：10:00 的涨停家数只占全天
 * 的 17%~58%（8 天实测，SD 13.9pt）。必须与「历史上同一时刻已经有多少家」
 * 并排看，否则每天都是「今天封板慢」。
 *
 * ---- 为什么必须合并涨停池与炸板池 ----
 * 东财的涨停池只收「收盘仍涨停」的票，炸板池只收「收盘炸板」的票，但**两个池
 * 的 fbt 都是首次封板时间**。所以「到 t 时刻曾触板数」必须两池合并才是精确值：
 *   曾触板(t) = ZT池(fbt<=t) + ZB池(fbt<=t)
 * 只用涨停池会漏掉当天冲高炸板的票。实测 11-13 的 10:00：
 *   合并 = 31 家，只用涨停池 = 20 家 —— 低估 35%。
 * 更麻烦的是这个低估幅度随盘中推进收窄（14:30 只差 1 家），也就是「今天 vs
 * 历史」的偏差会随时刻漂移，比一个固定偏移更容易被误读成趋势。所以合并是硬要求。
 *
 * ---- 为什么只算「曾触板」不算「当前封住」----
 * 炸板池没有 zbt（炸板时间），只有 zbc（炸板次数），所以「到 t 已炸板数」无法
 * 重建，「到 t 当前封住数」也就不可得。曾触板是唯一能精确重建的过程量。
 * 当前封住只报绝对值，它是否正常交给封板率（分子分母同为累积量，抗时间）。
 *
 * ---- 为什么跌停不进来 ----
 * 跌停池只有 lbt（最后封板时间），没有 fbt。lbt<=t 等价于「t 时刻跌停且此后
 * 再没开过板」，只覆盖收盘仍跌停的票，是「当前跌停数」的严格下界：11-13 收盘
 * 33 家里 26 家开过板，10:00 重建值只有 2。拿下界当基准会让盘中真实的 5 家
 * 显得比历史多 150%，方向恰好是最坏的假恐慌。跌停侧改用「昨日跌停池今日表现」
 * （见 gen_mkt_hist.mjs 的 ydtRed/ydtStill），样本固定、语义干净。
 *
 * 数据窗口：东财这三个池只回溯约 14 个交易日（更早返回 tc=0），所以这份基准
 * 天然只有十几天。它是参考，不是主判据；主力是 250 天日线口径的 A 类分布。
 *
 * 用法：node pipeline/gen_senti_base.mjs [--out worker/src/senti_base.js]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = argOf('--out', 'worker/src/senti_base.js');
const JSON_OUT = argOf('--json', 'dist/senti_base.json');
const LOOKBACK = +argOf('--days', 32);      // 自然日，够覆盖 14 个交易日

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const H = { ...UA, Referer: 'https://data.eastmoney.com/' };
const BASE = 'https://push2ex.eastmoney.com/';
const QS = 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=600';

/* 时点用的是 HHMMSS 整数（与 fbt / lbt 同格式），不是分钟数——
   比较时不用换算，也不会有「09:35 到底算 575 还是 575.0」这种边界问题。
   上午 9 档 + 午休 1 档 + 下午 9 档：11:30 之后到 13:05 之间取 11:30 那档，
   盘中 12:40 打开页面看到的就是午休时的样子，合理。 */
const AT = [
  93500, 95000, 100000, 101500, 103000, 104500, 110000, 111500, 113000,
  131500, 133000, 134500, 140000, 141500, 143000, 144500, 150000,
];

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function pool(kind, day) {
  const url = BASE + 'getTopic' + kind + 'Pool?' + QS
    + '&sort=' + (kind === 'DT' ? 'fund:asc' : 'fbt:asc') + '&date=' + day;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // 家数一律取 pool.length：tc 实测与它一致，但那是上游实现细节，
      // 一旦不一致，错误的会是「历史基准」而不是一个参数
      return (j && j.data && j.data.pool) || [];
    } catch (e) {
      if (k === 2) throw e;
      await sleep(800 * (k + 1));
    }
  }
  return [];
}

const bj = new Date(Date.now() + 8 * 3600e3);
const d0 = new Date(bj.getTime() - LOOKBACK * 86400e3);
const days = [];
for (let t = d0.getTime(); t <= bj.getTime(); t += 86400e3) {
  const d = new Date(t);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) continue;
  days.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
}
console.log(`扫 ${days.length} 个工作日（${days[0]} → ${days[days.length - 1]}）…`);

const rows = [];
for (const day of days) {
  const [zt, zb] = await Promise.all([pool('ZT', day), pool('ZB', day)]);
  if (!zt.length && !zb.length) { process.stdout.write(`  ${day} 无数据（超出回溯窗口）\n`); continue; }
  /* 合并去重：一只票不可能同时在两个池里（一个收盘封着、一个收盘炸了），
     但上游偶发重复投递，用 Set 兜一层，成本可忽略。 */
  const seen = new Set();
  const seq = [];
  for (const it of [...zt, ...zb]) {
    const c = it && it.c;
    if (!c || seen.has(c) || !it.fbt) continue;
    seen.add(c);
    seq.push(it.fbt);
  }
  seq.sort((a, b) => a - b);
  const touch = AT.map((t) => {
    // 二分找 <= t 的个数，13 天 × 19 档 × 平均 120 只，线性也够快，但二分更省心
    let lo = 0, hi = seq.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  });
  rows.push({ day, zt: zt.length, zb: zb.length, n: seq.length, touch });
  console.log(`  ${day} 涨停 ${String(zt.length).padStart(3)} + 炸板 ${String(zb.length).padStart(3)}`
    + ` = ${String(seq.length).padStart(3)}` + (seq.length !== zt.length + zb.length ? `（重 ${zt.length + zb.length - seq.length}）` : '')
    + ` · 10:00 曾触 ${touch[AT.indexOf(100000)] ?? '-'}`
    + ` · 收盘 ${touch[touch.length - 1]}`);
  await sleep(120);
}

if (rows.length < 5) throw new Error(`只有 ${rows.length} 天有数据，东财回溯窗口可能变了`);

/* 自检：曾触板必须单调不减（累积量），且任何时点都不超过收盘值。
   这两条挂了就是合并逻辑错了，不是上游问题。 */
for (const r of rows) {
  for (let i = 1; i < r.touch.length; i++) {
    if (r.touch[i] < r.touch[i - 1]) throw new Error(`${r.day} 曾触板在 ${AT[i]} 回退，累计逻辑错了`);
  }
  /* 收盘那一档必须等于「去重后的池成员数」。不能拿 zt+zb 比：11-04 实测两池
     有 2 个代码重叠（炸板后又回封的票，上游同时投进了两个池），去重是对的。 */
  if (r.touch[r.touch.length - 1] !== r.n) {
    throw new Error(`${r.day} 收盘曾触 ${r.touch[r.touch.length - 1]} != 去重后池成员 ${r.n}`);
  }
}

const payload = { days: rows.map((r) => r.day), at: AT, touch: rows.map((r) => r.touch), cVer: 'sb-v1' };
const head = '// 由 pipeline/gen_senti_base.mjs 生成，勿手改。\n'
  + '// 同刻「曾触板」基准：东财涨停池 + 炸板池合并，按 fbt（首次封板时间）累积。\n'
  + '//   touch[i][j] = days[i] 这天，到 at[j] 时刻（HHMMSS）为止曾封上涨停的只数\n'
  + '// 只算曾触板，不算当前封住：炸板池没有 zbt，封不住数无法重建（详见脚本头注释）。\n'
  + '// 跌停不在此文件内 —— 跌停池只有 lbt，重建出来是严格下界，不能当基准用。\n'
  + `// ${rows.length} 个交易日（${payload.days[0]} → ${payload.days[payload.days.length - 1]}）\n`;
const js = head + 'export const SENTI_BASE = ' + JSON.stringify(payload) + ';\n';
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, js);
mkdirSync(dirname(JSON_OUT), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify({ generated_at: new Date().toISOString(), ...payload }));
console.log(`\n${OUT}  ${(js.length / 1024).toFixed(1)} KB · ${rows.length} 天 × ${AT.length} 档`);
console.log(`  ${JSON_OUT}`);
