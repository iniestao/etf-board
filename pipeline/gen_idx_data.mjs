#!/usr/bin/env node
/**
 * pipeline/index_map.json → worker/src/idx_data.js
 *
 * 为什么内嵌而不用 /api/idx 或 R2：
 *   数据只有 28KB（gzip 8.5KB），一次性随页面下发，零额外请求、零 Worker CPU。
 *   映射变化极慢（新 ETF 上市才变），没必要为它维护一条动态链路。
 *   代价是更新映射要重新部署 Worker——半年一次的事。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const src = JSON.parse(await fs.readFile(path.join(ROOT, 'pipeline', 'index_map.json'), 'utf8'));

/* 按指数分组：{ "沪深300": ["510300", ...], ... }
   只保留 2 只及以上的组——单只的组去重时没有意义，还白占体积。
   单只指数占比不小（约 230 个），砍掉后体积能少三成。 */
const all = {};
for (const [code, v] of Object.entries(src.map)) {
  if (!v.idx) continue;
  (all[v.idx] ||= []).push(code);
}
const groups = {};
let dropped = 0;
for (const [k, v] of Object.entries(all)) {
  if (v.length < 2) { dropped++; continue; }
  groups[k] = v.sort();
}

const json = JSON.stringify(groups);
const out = `// 由 pipeline/gen_idx_data.mjs 生成，勿手改
// 来源：天天基金基金档案"跟踪标的"字段，逐只抓取后归一化
// ${new Date().toISOString().slice(0, 10)} · ${Object.keys(groups).length} 组 / ${
  Object.values(groups).reduce((a, b) => a + b.length, 0)} 只
export const IDX_GROUPS = ${json};
`;

await fs.writeFile(path.join(ROOT, 'worker', 'src', 'idx_data.js'), out, 'utf8');

const n = Object.values(groups).reduce((a, b) => a + b.length, 0);
console.log(`idx_data.js  ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB`);
console.log(`多只同指数 ${Object.keys(groups).length} 组 / 涉及 ${n} 只`);
console.log(`单只指数 ${dropped} 个（不参与去重，已省略）`);
console.log(`去重后全市场：${src.count} → 约 ${Object.keys(groups).length + (src.count - n)} 只`);
