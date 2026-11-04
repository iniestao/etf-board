/**
 * 把 dist/ 下的因子研究产物压成前端可直接用的小体积 JSON。
 *
 * 为什么内嵌进 Worker 而不是让页面去请求：
 *   101 个因子的 IC 明细大约 6KB，加上回测表和聚类信息总共 12KB 左右。
 *   走一次 HTTP 请求要 100ms 以上，内嵌进 HTML 是 0ms——而且不占请求额度，
 *   也和 idx_data.js 保持同一套「构建时固化」的风格。
 *
 * 输入：dist/ic_report.csv、dist/factor_combo.json、dist/combo_backtest.csv
 * 输出：worker/src/research_data.js
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIST = 'dist';

function readCsv(p) {
  const txt = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  const lines = txt.split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((ln) => {
    const cells = ln.split(',');
    const o = {};
    head.forEach((h, i) => { o[h.trim()] = cells[i]; });
    return o;
  });
}

const num = (v, d = 4) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? +x.toFixed(d) : null;
};

// ---- IC 报告：101 个因子在全样本上的表现 ----
const icRows = readCsv(`${DIST}/ic_report.csv`)
  .filter((r) => r.alpha && r.ic_mean !== '')
  .map((r) => [r.alpha, num(r.ic_mean, 5), num(r.ir, 3), num(r.t_stat, 2), num(r.win_rate, 4), num(r.n_days, 0)]);

const negCount = icRows.filter((r) => r[1] != null && r[1] < 0).length;

// ---- 组合选择与相关性 ----
const combo = JSON.parse(readFileSync(`${DIST}/factor_combo.json`, 'utf8'));

// ---- 样本外回测 ----
const bt = readCsv(`${DIST}/combo_backtest.csv`).map((r) => [
  r.strategy,
  num(r.days, 0),
  num(r.ann_ret, 4),
  num(r.ann_vol, 4),
  num(r.sharpe, 3),
  num(r.max_dd, 4),
  num(r.win_rate, 4),
  num(r.ic_mean, 5),
  num(r.ir, 4),
]);

const RESEARCH = {
  generated_at: combo.generated_at,
  window: combo.window,
  train: combo.train,
  test: combo.test,
  train_days: combo.train_days,
  test_days: combo.test_days,
  horizon: combo.horizon,
  clusters: combo.clusters,
  cluster_thresh: combo.cluster_thresh,
  corr: {
    mean: combo.corr_stats.mean_abs,
    median: combo.corr_stats.median_abs,
    p95: combo.corr_stats.p95_abs,
    gt06: combo.corr_stats['share_gt_0.6'],
  },
  picks: combo.picks.map((p) => [p.alpha, num(p.ic_mean, 5), num(p.ir, 3),
    num(p.t_stat, 2), num(p.win_rate, 4), p.cluster]),
  ic: { n: icRows.length, neg: negCount, rows: icRows },
  bt,
};

const body = '// 由 tools/gen_research.mjs 生成，勿手改\n'
  + 'export const RESEARCH = ' + JSON.stringify(RESEARCH) + ';\n';

writeFileSync('worker/src/research_data.js', body, 'utf8');

/* 同一份数据再落一个 json，供 Actions 推到 data 分支。
   内嵌那份是「构建时的快照」，页面先拿它渲染（0ms、离线可看），
   再向 /api/research 要当天的新数据覆盖——两全。 */
writeFileSync(`${DIST}/research.json`, JSON.stringify(RESEARCH), 'utf8');

console.log('已生成 worker/src/research_data.js  ' + (body.length / 1024).toFixed(1) + ' KB'
  + '（' + icRows.length + ' 个因子 / ' + bt.length + ' 条回测 / ' + combo.picks.length + ' 个入选组合）');
console.log('已生成 dist/research.json  ' + (JSON.stringify(RESEARCH).length / 1024).toFixed(1) + ' KB');
