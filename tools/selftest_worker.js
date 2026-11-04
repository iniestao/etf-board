/**
 * 临时自检 Worker —— 只在部署验证期间存在，验证完即删。
 *
 * 为什么需要它：沙箱到 workers.dev 的出站被完全阻断（DNS 污染 + anycast 超时），
 * 无法从外部访问刚部署的站点。
 *
 * 这里用 service binding 直接调 etf-board 的 fetch，不经过公网，也不依赖
 * workers.dev 域名解析——测的是 Worker 真实的路由、取数、缓存、KV 逻辑。
 *
 * 第一行就写一个时间戳进 KV：这样"没触发"和"触发了但中途失败"能区分开，
 * 不然只会看到一片空白，分不清是 cron 没跑还是代码炸了。
 */
const PATHS = [
  ['首页', '/'],
  ['状态', '/api/status'],
  ['历史K线', '/api/hist?code=510300'],
  ['自选', '/api/watch'],
  ['全市场', '/api/all'],
];

export default {
  async scheduled(evt, env, ctx) {
    await env.WATCH.put('__run_at', new Date().toISOString());
    const out = { at: new Date().toISOString(), steps: {} };

    for (const [name, path] of PATHS) {
      const t0 = Date.now();
      try {
        const r = await env.BOARD.fetch(new Request('https://board' + path));
        const ct = r.headers.get('content-type') || '';
        const info = { status: r.status, ms: Date.now() - t0, ct: ct.slice(0, 40) };
        if (ct.includes('json')) {
          info.json = await r.json();
        } else {
          const b = await r.arrayBuffer();
          const u8 = new Uint8Array(b);
          info.bytes = b.byteLength;
          info.magic = String.fromCharCode(u8[0] || 0, u8[1] || 0, u8[2] || 0, u8[3] || 0);
        }
        out.steps[name] = info;
      } catch (e) {
        out.steps[name] = { error: String((e && e.message) || e), ms: Date.now() - t0 };
      }
      await env.WATCH.put('__selftest', JSON.stringify(out));
    }
    await env.WATCH.put('__done_at', new Date().toISOString());
  },

  async fetch(req, env) {
    await this.scheduled({}, env, {});
    return new Response(await env.WATCH.get('__selftest') || 'no data', {
      headers: { 'content-type': 'application/json' },
    });
  },
};
