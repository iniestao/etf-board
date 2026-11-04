/**
 * 把 src/index.js + src/page.js 打成一个可直接粘贴到
 * Cloudflare Dashboard 的单文件 dist/worker.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { IDX_GROUPS } from './src/idx_data.js';

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
const idxJson = JSON.stringify(IDX_GROUPS);
const filled = m[1].replace(/\$\{IDX_JS\}/g, idxJson);

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
  + '（内嵌指数映射 ' + (idxJson.length / 1024).toFixed(1) + ' KB）');
