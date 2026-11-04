/**
 * Deno Deploy 入口
 * ================
 * 与 Cloudflare Workers 版共用 src/index.js，只换入口。
 *
 * 相比 Workers 免费版的两个优势：
 *   1. 没有 10ms CPU/请求 的硬限制（免费档 15 CPU 小时/月，总量制）
 *   2. Deno 支持 new TextDecoder('gbk')，后端也能直接解腾讯的 GBK 响应
 *
 * 部署：
 *   打开 https://dash.deno.com → New Playground → 粘贴本文件与 src/ 下三个文件
 *   （index.js / page.js / idx_data.js）
 *   或：deno install -gArf jsr:@deno/deployctl && deployctl deploy deno/main.ts
 *
 * 【功能差异】Deno 没有 R2 / KV 绑定，所以：
 *   - 历史 K 线面板不可用（/api/hist 返回 NO_R2，页面显示"未启用"）
 *   - 自选只存 localStorage，不跨设备
 *   实时榜单、同指数去重、自选高频刷新全部正常。
 *   要完整功能请用 Cloudflare Workers + R2。
 */
import worker from '../src/index.js';

// 注意：Deno Deploy 没有 ctx.waitUntil，第三个参数必须传 undefined，
// 让 src/index.js 里的缓存写入走「当场 await」分支，否则缓存会静默不落盘。
Deno.serve((req: Request) => worker.fetch(req, {}, undefined));
