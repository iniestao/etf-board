#!/usr/bin/env node
/**
 * 抓 ETF → 跟踪标的 映射，用于盯盘时"同指数只留成交额最大的一只"。
 *
 * 为什么不用交易所接口：
 *   深交所 ETF 列表（CATALOGID=1945）确实带 `nhzs` 字段（"399365 国证粮食"），
 *   但上交所对应的 sqlId 全部返回 "SOA service is null"，拿不到沪市 1000+ 只。
 *   天天基金基金档案页的"跟踪标的"字段沪深都覆盖，且一次一页 52KB，够用。
 *
 * 用法：
 *   node pipeline/fetch_index_map.mjs                     # 增量，只抓缺的
 *   node pipeline/fetch_index_map.mjs --full              # 全量重抓
 *   node pipeline/fetch_index_map.mjs --concurrency 16
 *
 * 增量模式已接进 .github/workflows/update-data.yml，每个交易日收盘后自动跑一次，
 * 只抓当天新上市、映射表里还没有的代码（通常 5~15 只，十几秒）。内容没变化时
 * 不写盘，所以不会每天产生一次空提交。
 *
 * 输出：pipeline/index_map.json（183KB，属于源数据，随仓库走）
 *   { generated_at, count, indexes: { "沪深300": 42, ... },
 *     map: { "510300": { idx: "沪深300", raw: "沪深300指数" }, ... } }
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'pipeline', 'index_map.json');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const FULL = flag('--full');
const CONC = parseInt(opt('--concurrency', '12'), 10);

/* ---------- 指数名归一化 ----------
   目标不是还原"官方全称"，而是让同一指数的不同写法落到同一个 key。
   基金公司写法差异主要来自：括号注释、末尾"指数"、全收益/价格 后缀。 */
const ALIAS = new Map(Object.entries({
  // 宽基：简称 ↔ 官方名
  '科创50': '上证科创板50', '科创板50': '上证科创板50', '上证科创板50成份': '上证科创板50',
  '科创100': '上证科创板100', '上证科创板100成份': '上证科创板100',
  '沪深300': '沪深300', '中证300': '沪深300',
  '中证500': '中证500', '中证1000': '中证1000', '中证2000': '中证2000',
  '中证100': '中证100', '中证A500': '中证A500', 'A500': '中证A500',
  '中证A100': '中证A100', 'A100': '中证A100', '中证A50': '中证A50', 'A50': '中证A50',
  '上证50': '上证50', '上证180': '上证180', '上证380': '上证380',
  '创业板': '创业板指', '创业板指': '创业板指', '创业板50': '创业板50',
  '深证100': '深证100', '深证成指': '深证成指', '中小板': '中小板指', '中小板指': '中小板指',
  '北证50': '北证50', '双创50': '双创50', '中证双创50': '双创50',
  // 港股（跨境）
  '恒生': '恒生指数', '恒生指数': '恒生指数',
  '恒生科技': '恒生科技', '恒生科技指数': '恒生科技',
  '恒生中国企业': '恒生中国企业', '国企指数': '恒生中国企业',
  '中概互联': '中概互联网50', '中概互联网50': '中概互联网50',
  '中国互联网50': '中概互联网50',
  // 美股
  '纳斯达克100': '纳斯达克100', '纳指100': '纳斯达克100',
  '标普500': '标普500', '标普500指数': '标普500',
  // 商品
  '黄金9999': '黄金9999', '上海金': '上海金', '黄金': '黄金9999',
  '豆粕': '豆粕', '原油': '原油',
  // 同一指数的不同书面写法（基金合同 vs 交易所简称），已逐条核对官方指数全称
  '中证畜牧养殖产业': '中证畜牧养殖',
  '中证基建': '中证基建工程',
  '上证科创板综合价格': '上证科创板综合',
}));

/* 只在确认是同一指数时才改这里。判断标准是官方指数全称一致，
   不是"名字看起来像"——错合并会把一只好标的从盯盘表里挤掉，
   少合并只是多显示一行，代价不对等。 */

function normIndex(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (!t) return null;
  // 货币基金 / 部分债券 ETF 明确写"无跟踪标的"
  if (/无跟踪标的|无标的|暂无|不适用|^-+$/.test(t)) return null;

  t = t.replace(/[（(][^）)]*[）)]/g, '');          // 去括号注释：(价格) (全收益) (QDII)
  t = t.replace(/[\s\u3000]/g, '');
  t = t.replace(/[（）()]/g, '');
  t = t.replace(/(全收益|净价|价格|人民币|美元|港币|USD|CNY)$/i, '');
  // 顺序很关键：先剥"指数"，再剥"价格/全收益"，再剥一次"指数"。
  // 反过来的话"上证科创板综合价格指数"会先被当成普通名，
  // 留下"…综合价格"，于是同一只指数被拆成两组。
  t = t.replace(/指数$|指$/, '');
  t = t.replace(/(全收益|净价|价格|人民币|美元|港币|USD|CNY)$/i, '');
  t = t.replace(/指数$|指$/, '');
  t = t.replace(/成份$|成分$/, '');
  if (!t) return null;

  return ALIAS.get(t) || t;
}

/* ---------- 抓单只 ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchOne(code, retry = 2) {
  const url = `https://fundf10.eastmoney.com/jbgk_${code}.html`;
  for (let a = 0; a <= retry; a++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://fundf10.eastmoney.com/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      // <th>跟踪标的</th><td>沪深300指数</td>
      const m = html.match(/<th>跟踪标的<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
      if (!m) return { code, raw: null, idx: null, err: 'no-field' };
      const raw = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      return { code, raw, idx: normIndex(raw), err: null };
    } catch (e) {
      if (a === retry) return { code, raw: null, idx: null, err: String(e.message || e).slice(0, 60) };
      await new Promise((res) => setTimeout(res, 400 * (a + 1)));
    }
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'dist', 'manifest.json'), 'utf8'));
  const codes = manifest.items.map((x) => x.code);
  const nameOf = new Map(manifest.items.map((x) => [x.code, x.name]));
  console.log(`标的 ${codes.length} 只`);

  let prev = {};
  if (!FULL) {
    try {
      prev = JSON.parse(await fs.readFile(OUT, 'utf8')).map || {};
    } catch { /* 首次运行没有缓存，正常 */ }
  }

  // --renorm：不联网，只用已抓到的 raw 重算归一化（改 ALIAS / 正则后快速验证）
  if (flag('--renorm')) {
    let n = 0;
    for (const [code, v] of Object.entries(prev)) {
      if (v.raw !== undefined) { v.idx = normIndex(v.raw); n++; }
    }
    console.log(`重新归一化 ${n} 条（未联网）`);
    await writeOut(prev, codes);
    return;
  }

  const todo = codes.filter((c) => !prev[c] || prev[c].idx === undefined);
  console.log(`需抓取 ${todo.length} 只（缓存命中 ${codes.length - todo.length}）`);

  const map = { ...prev };
  let done = 0, fail = 0;
  const t0 = Date.now();

  // 简单的并发池：不用库，避免给 Actions 增加依赖
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const code = todo[cursor++];
      const r = await fetchOne(code);
      if (r.err) {
        fail++;
        // 抓取失败不写空值，下次运行会重试；只有"明确无标的"才写 null
        if (r.err === 'no-field') map[code] = { idx: null, raw: null, nm: nameOf.get(code) };
      } else {
        map[code] = { idx: r.idx, raw: r.raw, nm: nameOf.get(code) };
      }
      done++;
      if (done % 200 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log(`  ${done}/${todo.length}  ${el.toFixed(0)}s  失败 ${fail}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length || 1) }, worker));

  console.log(`\n完成 ${((Date.now() - t0) / 1000).toFixed(0)}s  失败 ${fail} 只（下次重试）`);
  await writeOut(map, codes);
}

async function writeOut(map, codes) {
  const indexes = {};
  for (const v of Object.values(map)) if (v.idx) indexes[v.idx] = (indexes[v.idx] || 0) + 1;

  const missing = codes.filter((c) => !map[c]).length;
  const body = {
    count: Object.keys(map).length,
    with_index: Object.values(map).filter((v) => v.idx).length,
    index_count: Object.keys(indexes).length,
    indexes: Object.fromEntries(Object.entries(indexes).sort((a, b) => b[1] - a[1])),
    map,
  };
  const out = { generated_at: new Date().toISOString().slice(0, 19), ...body };

  /* 幂等写盘：内容没变就不碰文件。
     这条脚本现在挂在每日 update-data 里跑，而 generated_at 每天都在变——
     无条件写盘会让流水线每天产出一个「只改了时间戳」的提交，连带触发一次
     Worker 重建部署。文件时间戳留成「上次真正变化的时间」，含义反而更准。 */
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* 首次运行 */ }
  const prevBody = prev && {
    count: prev.count,
    with_index: prev.with_index,
    index_count: prev.index_count,
    indexes: prev.indexes,
    map: prev.map,
  };
  if (prevBody && JSON.stringify(prevBody) === JSON.stringify(body)) {
    console.log('映射无变化，跳过写盘（保留原 generated_at）');
  } else {
    await fs.writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');
    console.log(`已写入 ${path.relative(ROOT, OUT)}（generated_at ${out.generated_at}）`);
  }

  const dedup = out.index_count + (out.count - out.with_index) + missing;
  console.log(`有跟踪标的 ${out.with_index} 只 / 无标的 ${out.count - out.with_index} 只 / 未抓 ${missing} 只`);
  console.log(`不同指数 ${out.index_count} 个 → 同指数去重后 ${dedup} 只（${codes.length} → ${dedup}）`);
  console.log('\n成员最多的 12 个指数：');
  for (const [k, v] of Object.entries(out.indexes).slice(0, 12)) {
    const sample = Object.entries(map).filter(([, x]) => x.idx === k).slice(0, 4)
      .map(([c, x]) => `${c}${x.nm || ''}`).join(' ');
    console.log(`  ${String(v).padStart(3)}  ${k.padEnd(20, '　')} ${sample}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
