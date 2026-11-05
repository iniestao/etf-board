/**
 * 个股历史日线抓取（复用项目已验证的新浪解码器）
 * =============================================
 * ETF 的成分是股票。现有 184 个因子全是 ETF 自身的价格变换，等于把所有
 * 成分股的信息压缩成了一个价格序列，丢掉了「成分股内部发生了什么」。
 *
 * 数据源：新浪 hisdata_klc2/klc_kl.js（加密 K 线）+ hfq.js（后复权因子）
 * 这套 data/import_etf.mjs 已经在用，510300 验证过能回溯到 2012-05。
 *
 * 为什么不用腾讯：web.ifzq.gtimg.cn 在沙箱直接跳 WAF 拦截页。
 * 为什么不用新浪 getKLineData：它返回不复权价，个股分红除权会造成假跳空，
 * 动量类因子会算错。
 *
 * 输出 /tmp/stocks.ndjson，每行一只：
 *   {code, bars:[[date,close,vol],...], adj:[[date,factor],...]}
 * 由 Python 侧导入并应用复权。
 */
import fs from 'node:fs';
import readline from 'node:readline';
import decode from '/workspace/etf_board/data/sina_klc_decode.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' };
const CONC = 8;
const RETRY = 2;

const d2s = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

async function get(url, tries = RETRY + 1) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) { /* 重试 */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return null;
}

async function one(sym) {
  const t = await get(`https://finance.sina.com.cn/realstock/company/${sym}/hisdata_klc2/klc_kl.js`);
  if (!t || !t.includes('=')) return null;
  const b64 = t.split('=').slice(1).join('=').split(';')[0].replace(/"/g, '').trim();
  let arr;
  try { arr = decode(b64); } catch (e) { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;

  const bars = arr
    .map((x) => [d2s(x.date), +(+(x.close || 0)).toFixed(3), Math.round(+(x.volume || 0))])
    .filter((b) => b[0] && b[1] > 0);

  // 后复权因子（个股是 f 字段；老 ETF 的 hfq.js 用 u 累计分红，这里不处理）
  let adj = [];
  const h = await get(`https://finance.sina.com.cn/realstock/company/${sym}/hfq.js`);
  if (h) {
    const i = h.indexOf('{'); const j = h.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        const o = JSON.parse(h.slice(i, j + 1));
        adj = (o.data || [])
          .filter((r) => r.d && r.f && isFinite(parseFloat(r.f)))
          .map((r) => [r.d, parseFloat(r.f)])
          .sort((a, b) => (a[0] < b[0] ? -1 : 1));
      } catch (e) { /* 没有复权因子就按原始价 */ }
    }
  }
  return { code: sym.slice(2), sym, bars, adj };
}

async function main() {
  const list = fs.readFileSync('/tmp/stocks.txt', 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  console.log(`待抓 ${list.length} 只，并发 ${CONC}`);

  const out = fs.createWriteStream('/tmp/stocks.ndjson');
  let done = 0, ok = 0, fail = 0;
  const t0 = Date.now();

  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      const r = await one(sym);
      if (r && r.bars.length > 30) {
        out.write(JSON.stringify(r) + '\n');
        ok++;
      } else {
        fail++;
      }
      done++;
      if (done % 200 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log(`  [${done}/${list.length}] ok=${ok} fail=${fail} ${el.toFixed(0)}s `
          + `(${(done / el).toFixed(1)}/s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  out.end();
  console.log(`完成：成功 ${ok}，失败 ${fail}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
