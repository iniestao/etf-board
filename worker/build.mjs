/**
 * 把 src/index.js + src/page.js 打成一个可直接粘贴到
 * Cloudflare Dashboard 的单文件 dist/worker.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { IDX_GROUPS } from './src/idx_data.js';
import { RESEARCH } from './src/research_data.js';
import { ALPHA_META } from './src/alpha_meta.js';
import { LAB } from './src/lab_data.js';
import { SEC_HIST } from './src/sec_hist.js';
import { MKT_HIST, MKT_INDS } from './src/mkt_hist.js';
import { MKT_IND_NAMES, MKT_IND_OF, MKT_IND_MEM, MKT_STK_NAME } from './src/mkt_ind.js';
import { SENTI_HIST } from './src/senti_hist.js';
import { SENTI_BASE } from './src/senti_base.js';
import { STATE_HOLD } from './src/state_data.js';

/* 两份文件各自生成，唯一会悄悄错位的地方就是行业名的顺序：mkt_hist 里存的是
   每天 TOP3 的**下标**，mkt_ind 里存的是「代码 → 下标」。顺序一错，盘中算出来的
   集中度就是拿 A 行业的钱除以 B 行业的名字，数字看着还挺正常。让它构建失败。 */
if (JSON.stringify(MKT_IND_NAMES) !== JSON.stringify(MKT_INDS)) {
  console.error('mkt_ind.js 的行业名顺序与 mkt_hist.js 不一致，'
    + '先跑 node pipeline/gen_mkt_hist.mjs 重新生成这一对');
  process.exit(1);
}

/* 反向表（行业 → 成分股）与正向表（代码 → 行业）必须互为逆映射。
   点行业名弹出的名单如果和集中度用的分组不是同一份，就会出现
   「这个行业成交 962 亿，但列表加起来只有 800 亿」这种谁也说不清的差。 */
if (MKT_IND_MEM.length !== MKT_IND_NAMES.length) {
  console.error('MKT_IND_MEM 的组数(' + MKT_IND_MEM.length + ')与行业数('
    + MKT_IND_NAMES.length + ')不一致');
  process.exit(1);
}
{
  let bad = 0, tot = 0;
  for (let k = 0; k < MKT_IND_MEM.length; k++) {
    for (const c of MKT_IND_MEM[k]) { tot++; if (MKT_IND_OF[c] !== k) bad++; }
  }
  if (bad || tot !== Object.keys(MKT_IND_OF).length) {
    console.error(`反向表与正向表不符：${tot} 条里 ${bad} 条下标错位；`
      + `正向表 ${Object.keys(MKT_IND_OF).length} 条`);
    process.exit(1);
  }
  if (Object.keys(MKT_STK_NAME).length < 4000) {
    console.error('MKT_STK_NAME 只有 ' + Object.keys(MKT_STK_NAME).length
      + ' 条，行业弹层会大面积显示代码而不是名字');
    process.exit(1);
  }
}

/* ---------------- 情绪基准：两份数据的咬合 ----------------
 * SENTI_HIST 来自 250 天腾讯日线回算，SENTI_BASE 来自东财 13 天池，是两个上游、
 * 两次独立运行。它们和 MKT_HIST 之间只要有一处对不齐，盘中「今天 vs 此刻历史」
 * 就是拿两个不同世界的数在比——而那种错在页面上看起来完全正常。
 * 这几条断言全部是「结构必须成立」，不写死具体数值（历史天天在长）。 */
if (JSON.stringify(SENTI_HIST.d) !== JSON.stringify(MKT_HIST.d)) {
  const a = SENTI_HIST.d, b = MKT_HIST.d;
  console.error(`senti_hist.js 的日期(${a.length} 天，末 ${a[a.length - 1]})`
    + `与 mkt_hist.js(${b.length} 天，末 ${b[b.length - 1]})不一致，`
    + '两个文件必须同一次 gen_mkt_hist.mjs 生成');
  process.exit(1);
}
{
  const H = SENTI_HIST, n = H.d.length;
  const KEYS = ['zt', 'dt', 'touch', 'red', 'mid', 'big', 'promo', 'pn',
    'touchN', 'ydtRed', 'ydtStill', 'ydtN'];
  for (const k of KEYS) {
    if (!Array.isArray(H[k]) || H[k].length !== n) {
      console.error(`SENTI_HIST.${k} 长度 ${Array.isArray(H[k]) ? H[k].length : '缺失'} != ${n}`);
      process.exit(1);
    }
  }
  /* 曾触板 >= 涨停，且都不超过当日有成交个股数。第一条挂了说明判定口径错，
     第二条挂了说明两个文件不是同一天的口径（比如 n 用了旧的一份）。 */
  for (let i = 0; i < n; i++) {
    if (H.zt[i] > H.touch[i]) {
      console.error(`${H.d[i]}：涨停 ${H.zt[i]} > 曾触板 ${H.touch[i]}，判定口径错了`);
      process.exit(1);
    }
    if (H.touch[i] > MKT_HIST.n[i]) {
      console.error(`${H.d[i]}：曾触板 ${H.touch[i]} > 当日有成交 ${MKT_HIST.n[i]}`);
      process.exit(1);
    }
  }
  /* 池内代码必须在行业映射里：盘中要点名单看简称和行业，查不到就只能显示裸代码。
     留 2% 余量——新股上市头几天行业表还没收录。 */
  const miss = [];
  for (const pool of [H.zpool, H.dpool]) {
    for (const day of Object.keys(pool)) {
      for (const it of pool[day]) {
        const c = Array.isArray(it) ? it[0] : it;
        if (MKT_IND_OF[c] === undefined) miss.push(c);
      }
    }
  }
  const tot = Object.values(H.zpool).reduce((s, a) => s + a.length, 0)
    + Object.values(H.dpool).reduce((s, a) => s + a.length, 0);
  if (miss.length > tot * 0.02) {
    console.error(`情绪池里 ${miss.length}/${tot} 只代码不在行业映射里（如 ${miss.slice(0, 5).join(',')}）`);
    process.exit(1);
  }
  /* 新鲜度探针：昨日池的收盘价。少于 20 条就没法判断历史表是不是过期，
     整块承接指标都得降级成「—」，那种情况应该先在管线里修好。 */
  const np = Object.keys(H.zpx).length, nd = Object.keys(H.dpx).length;
  if (np < 20) {
    console.error(`SENTI_HIST.zpx 只有 ${np} 条探针价（应 ≥ 20），历史过期检测会失效`);
    process.exit(1);
  }
  if (H.lastDay !== H.d[n - 1]) {
    console.error(`SENTI_HIST.lastDay(${H.lastDay}) != 最后一天(${H.d[n - 1]})`);
    process.exit(1);
  }
  if (nd === 0) console.warn('  提示：昨日跌停池为空（当天 0 家跌停），dpx 无探针属正常');
}

/* 同刻基准：东财涨停池 + 炸板池合并的 17 档曲线。只做结构校验——
   具体数值天天变，写死会天天误报。 */
{
  const B = SENTI_BASE;
  if (!Array.isArray(B.days) || B.days.length < 5) {
    console.error(`senti_base.js 只有 ${B.days ? B.days.length : 0} 天，东财回溯窗口至少要 5 天`);
    process.exit(1);
  }
  if (B.touch.length !== B.days.length) {
    console.error(`senti_base.js 曲线行数 ${B.touch.length} != 天数 ${B.days.length}`);
    process.exit(1);
  }
  for (let i = 1; i < B.at.length; i++) {
    if (B.at[i] <= B.at[i - 1]) { console.error(`senti_base.at 不是递增的：${B.at.slice(0, 5)}`); process.exit(1); }
  }
  for (let i = 0; i < B.touch.length; i++) {
    const row = B.touch[i];
    if (row.length !== B.at.length) {
      console.error(`senti_base.js 第 ${i} 行有 ${row.length} 档，应为 ${B.at.length}`);
      process.exit(1);
    }
    for (let j = 1; j < row.length; j++) {
      if (row[j] < row[j - 1]) {
        console.error(`${B.days[i]} 的曾触板在 ${B.at[j]} 回退（${row[j - 1]} → ${row[j]}），累计口径错了`);
        process.exit(1);
      }
    }
  }
}

const page = readFileSync('src/page.js', 'utf8');
const core = readFileSync('src/index.js', 'utf8');
const m = page.match(/export const HTML = `([\s\S]*)`;\s*$/);
if (!m) { console.error('未能在 page.js 中定位 HTML 模板'); process.exit(1); }

// 源码里写的是 ${IDX_JS}，由 JS 模板字符串在运行时求值；
// 但打包是纯文本提取，所以必须在这里落成字面量，
// 而且要在转义之前做——否则 ${ 会先被转义成 \${，浏览器拿到的是字面量。
if (!m[1].includes('${IDX_JS}')) {
  console.error('page.js 里找不到 ${IDX_JS} 占位符，指数映射注入会失效');
  process.exit(1);
}
if (!m[1].includes('${RESEARCH_JS}')) {
  console.error('page.js 里找不到 ${RESEARCH_JS} 占位符，因子研究面板会空白');
  process.exit(1);
}
if (!m[1].includes('${ALPHA_META_JS}')) {
  console.error('page.js 里找不到 ${ALPHA_META_JS} 占位符，因子构造说明点不开');
  process.exit(1);
}
if (!m[1].includes('${LAB_JS}')) {
  console.error('page.js 里找不到 ${LAB_JS} 占位符，第二批因子面板会空白');
  process.exit(1);
}
if (!m[1].includes('${SEC_HIST_JS}')) {
  console.error('page.js 里找不到 ${SEC_HIST_JS} 占位符，板块占比走势会空白');
  process.exit(1);
}
if (!m[1].includes('${MKT_HIST_JS}')) {
  console.error('page.js 里找不到 ${MKT_HIST_JS} 占位符，集中度宽度四象限会空白');
  process.exit(1);
}
if (!m[1].includes('${STATE_JSON}')) {
  console.error('page.js 里找不到 ${STATE_JSON} 占位符，国家队筛选会筛出空表');
  process.exit(1);
}
/* 名单里出现重复代码 = 同一只 ETF 被登记两次，筛选结果里会出现两行一模一样的
   东西。构建期拦住，不要等肉眼看表格才发现。 */
{
  const seen = new Set();
  for (const [c] of STATE_HOLD.list) {
    if (!/^\d{6}$/.test(c)) {
      console.error('state_data.js 里的代码不合法：' + c);
      process.exit(1);
    }
    if (seen.has(c)) {
      console.error('state_data.js 里代码重复：' + c);
      process.exit(1);
    }
    seen.add(c);
  }
}
const idxJson = JSON.stringify(IDX_GROUPS);
const rsJson = JSON.stringify(RESEARCH);
const amJson = JSON.stringify(ALPHA_META);
const labJson = JSON.stringify(LAB);
const shJson = JSON.stringify(SEC_HIST);
const mhJson = JSON.stringify(MKT_HIST);
const stJson = JSON.stringify(STATE_HOLD);
const filled = m[1]
  .replace(/\$\{IDX_JS\}/g, idxJson)
  .replace(/\$\{RESEARCH_JS\}/g, rsJson)
  .replace(/\$\{ALPHA_META_JS\}/g, amJson)
  .replace(/\$\{LAB_JS\}/g, labJson)
  .replace(/\$\{SEC_HIST_JS\}/g, shJson)
  .replace(/\$\{MKT_HIST_JS\}/g, mhJson)
  .replace(/\$\{STATE_JSON\}/g, stJson);

// 模板字符串再嵌套一层，需要转义 \ 、` 和 ${
const html = filled
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const out = core
  .replace(/^import \{ HTML \} from '\.\/page\.js';\n\n?/m, '')
  + '\n// ---- 内联的前端页面（由 build.mjs 生成，勿手改）----\n'
  + 'const HTML = `' + html + '`;\n';

mkdirSync('dist', { recursive: true });
writeFileSync('dist/worker.js', out, 'utf8');
console.log('已生成 dist/worker.js  ' + (out.length / 1024).toFixed(1) + ' KB'
  + '（内嵌指数映射 ' + (idxJson.length / 1024).toFixed(1) + ' KB'
  + ' / 因子研究 ' + (rsJson.length / 1024).toFixed(1) + ' KB'
  + ' / 因子说明 ' + (amJson.length / 1024).toFixed(1) + ' KB'
  + ' / 第二批因子 ' + (labJson.length / 1024).toFixed(1) + ' KB'
  + ' / 板块占比史 ' + (shJson.length / 1024).toFixed(1) + ' KB'
  + ' / 全A结构史 ' + (mhJson.length / 1024).toFixed(1) + ' KB'
  + ' / 国家队名单 ' + STATE_HOLD.list.length + ' 只）');
