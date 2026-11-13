/**
 * 拉全 A 的行业归属（东财 EM2016）→ pipeline/ind_em2016.json
 * ============================================================
 * 为什么单独做一份映射表：
 *   以前行业归属是从 push2 的 clist 里取 f100 字段，clist 一被拦（2026-11-11 起
 *   对数据中心出口直接断连），整条回算链就断在第一步。而行业归属是**慢变量**——
 *   一只股票一年也未必换一次行业，没必要每天重拉 5000 多次。
 *
 *   所以拆成两件事：这张表按周/按月刷一次，日线回算只读本地文件。
 *   好处不只是快：回算从此不依赖任何东财 push2 接口，Actions 上也能跑。
 *
 * 数据源：emweb F10 公司概况。同一个响应里有两个字段
 *   EM2016          = 东方财富自建行业分类，三级，形如「家电-白色家电-白色家电」
 *   INDUSTRYCSRC1   = 证监会《上市公司行业分类指引》，门类-大类
 *   两者并列返回，互不隶属——EM2016 不是证监会标准，也不是申万/中信/中证。
 *
 * 用法：node pipeline/gen_ind_map.mjs [--out pipeline/ind_em2016.json] [--refresh]
 *   默认表存在且不足 7 天就不重拉，只补「表里没有的新代码」（新股）。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = argOf('--out', 'pipeline/ind_em2016.json');
const FORCE = argv.includes('--refresh');
const CH = +argOf('--concurrency', 16);

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const UA_SINA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36', Referer: 'https://finance.sina.com.cn/' };
const UA_EM = { 'User-Agent': UA_SINA['User-Agent'], Referer: 'https://emweb.securities.eastmoney.com/' };

/* ---------------- 全 A 清单（新浪 hs_a） ---------------- */
const SINA_LIST = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php'
  + '/Market_Center.getHQNodeData';

async function sinaList() {
  const seen = new Set();
  const out = [];
  for (let p = 1; p <= 70; p++) {
    let arr;
    try {
      const r = await fetch(`${SINA_LIST}?page=${p}&num=100&sort=symbol&asc=1&node=hs_a`,
        { headers: UA_SINA, signal: AbortSignal.timeout(12000) });
      if (!r.ok) break;
      arr = JSON.parse(await r.text());
    } catch (e) { break; }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const x of arr) {
      const s = String(x.symbol || '');
      // 北交所（bj）不进：流动性与涨跌幅规则都不同，口径同 FS_STOCK
      if (!/^(sh|sz)\d{6}$/.test(s) || seen.has(s)) continue;
      seen.add(s);
      out.push({ sym: s, code: s.slice(2), name: x.name || '' });
    }
  }
  return out.sort((a, b) => (a.sym < b.sym ? -1 : 1));
}

/* ---------------- 单只行业 ---------------- */
async function oneEm(x, tries = 3) {
  const sec = (x.code[0] === '6' ? 'SH' : 'SZ') + x.code;
  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=' + sec;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA_EM, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const b = (j.jbzl || [])[0] || {};
      const em = b.EM2016 && b.EM2016 !== '-' ? String(b.EM2016).trim() : null;
      return { sym: x.sym, name: b.SECURITY_NAME_ABBR || x.name, em, csrc: b.INDUSTRYCSRC1 || null };
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(200 * (i + 1));
    }
  }
  throw last;
}

/* ---------------- 主流程 ---------------- */
const list = await sinaList();
if (list.length < 4000) throw new Error(`新浪清单只有 ${list.length} 只，上游不正常`);
console.log(`清单 ${list.length} 只（hs_a，已剔北交所）`);

let prev = null;
if (existsSync(OUT)) {
  try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) { prev = null; }
}
const prevAge = prev && prev.generated_at
  ? (Date.now() - Date.parse(prev.generated_at)) / 86400e3 : 1e9;
const prevItems = (prev && prev.items) || {};

// 表新鲜就只补新代码：新股上市、老表里没有的
let todo = list;
if (!FORCE && prevAge < 7 && Object.keys(prevItems).length > 3000) {
  todo = list.filter((x) => !prevItems[x.code]);
  console.log(`  本地表 ${prevAge.toFixed(1)} 天前生成，只补漏的 ${todo.length} 只`);
}
if (!todo.length) {
  console.log('  无需更新');
  process.exit(0);
}

const t0 = Date.now();
const got = [];
const bad = [];
for (let i = 0; i < todo.length; i += CH) {
  const res = await Promise.all(todo.slice(i, i + CH).map((x) => oneEm(x).catch(() => null)));
  for (let k = 0; k < res.length; k++) {
    if (res[k]) got.push(res[k]); else bad.push(todo[i + k]);
  }
  const n = Math.min(i + CH, todo.length);
  if (n % 800 < CH || n === todo.length) {
    process.stdout.write(`  ${n}/${todo.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\r`);
  }
}
console.log('');

// 补拉：单轮失败率通常在 1% 以内，降并发重试
for (let round = 1; round <= 2 && bad.length; round++) {
  const retry = bad.splice(0, bad.length);
  console.log(`  补拉第 ${round} 轮：${retry.length} 只`);
  await sleep(800 * round);
  for (let i = 0; i < retry.length; i += 4) {
    const res = await Promise.all(retry.slice(i, i + 4).map((x) => oneEm(x).catch(() => null)));
    for (let k = 0; k < res.length; k++) {
      if (res[k]) got.push(res[k]); else bad.push(retry[i + k]);
    }
  }
}
if (bad.length) console.log(`  ${bad.length} 只仍失败，保留旧值`);

const items = { ...prevItems };
for (const g of got) items[g.sym.slice(2)] = { n: g.name, em: g.em, csrc: g.csrc };

const codes = Object.keys(items);
const ems = codes.map((c) => items[c].em).filter(Boolean);
const lv = [0, 1, 2].map((k) => new Set(ems.map((v) => v.split('-')[k]).filter(Boolean)).size);
const pathU = new Set(ems).size;
const noEm = codes.length - ems.length;

const payload = {
  generated_at: new Date().toISOString(),
  count: codes.length,
  levels: { l1: lv[0], l2: lv[1], l3: lv[2], path: pathU },
  noEm,
  items,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));

console.log(`  ${codes.length} 只 · 一级 ${lv[0]} / 二级 ${lv[1]} / 三级 ${lv[2]} · 全路径 ${pathU}`);
console.log(`  ${noEm} 只无 EM2016（多为退市/停牌新股）`);
console.log(`  写出 ${OUT} ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB`);

// 抽样打几条，方便人工核对层级是否合理
for (const c of ['000651', '600519', '300750', '601318', '002594'].filter((c) => items[c])) {
  console.log(`    ${c} ${items[c].n} → ${items[c].em}`);
}
