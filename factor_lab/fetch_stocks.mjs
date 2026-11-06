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
import decode from '../data/sina_klc_decode.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' };
const CONC = 8;
const RETRY = 2;

/* 参数（每日增量备份用的，见 .github/workflows/backup-data.yml）
   --list=  股票池文件，默认 /tmp/stocks.txt（沙箱里的老路径，保持不变）
   --out=   NDJSON 输出路径
   --keep=  每只只保留最近 N 个交易日；0 = 全历史（研究用）

   注意 klc 接口**一次就返回整段历史**，所以 --keep 不减少请求数、也不加快
   抓取，它只是把输出从几百 MB 压到几百 KB —— 这是增量能每天跑的前提。
   复权因子按日期对齐，截断 bars 时必须同步截断 adj，否则会混进更早的因子。 */
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : d;
};
const LIST = arg('list', '/tmp/stocks.txt');
const OUT_FILE = arg('out', '/tmp/stocks.ndjson');
const KEEP = +arg('keep', '0') || 0;

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
  const list = fs.readFileSync(LIST, 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  console.log(`待抓 ${list.length} 只，并发 ${CONC}，每只保留 ${KEEP || '全部'} 天`);

  const out = fs.createWriteStream(OUT_FILE);
  let done = 0, ok = 0, fail = 0;
  const t0 = Date.now();

  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      const r = await one(sym);
      if (r && r.bars.length > 30) {
        if (KEEP > 0 && r.bars.length > KEEP) {
          /* 只截 bars，**绝不截 adj**。

             hfq.js 是稀疏的：茅台三年才 33 条（每年分红除权两次），中位数
             只有 6 条。截到最近 5 天就是空数组，下游 ffill 拿不到因子，
             close_adj 会退化成 close —— 茅台会差 8.88 倍，而且不会报错，
             因子结果全错却看起来正常。adj 一年添几条，留着不占地方。 */
          r.bars = r.bars.slice(-KEEP);
        }
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
