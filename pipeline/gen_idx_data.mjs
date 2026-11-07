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
   2026-11-07 恢复单只组。原先为省体积只留 2 只以上的组（约 230 个单只指数被砍），
   后果是这 229 只 ETF 的 ix 变 null，而板块地图第一行就是 `if (!x.ix) continue`——
   中概互联网 513050、港股创新药 513120、半导体 512480、通信 515880、中韩半导体
   513310 全被整块丢掉，跨境只剩 40 亿、通信只剩 10 亿。去重只需要组内成员，
   单只组一点都不多余，体积涨 11KB（gzip 约 4KB）远小于口径错误的代价。 */
const all = {};
for (const [code, v] of Object.entries(src.map)) {
  if (!v.idx) continue;
  (all[v.idx] ||= []).push(code);
}
const groups = {};
for (const [k, v] of Object.entries(all)) {
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
const single = Object.values(groups).filter((v) => v.length === 1).length;
console.log(`指数组 ${Object.keys(groups).length} 个 / 涉及 ${n} 只（其中单只指数 ${single} 个）`);
console.log(`无跟踪标的：${src.count - n} 只（货币 27 只 + 新发未收录）`);
