#!/usr/bin/env node
/**
 * 期指期权日档：中金所 XML → dist/fut_daily.json（250 天历史）+ dist/fut_last.json（最新一天）
 *
 * 为什么放在 Actions 而不是 Worker 里算：
 *   中金所的单日全品种文件 539KB / 788 个合约，Worker 免费版只有 10ms CPU，
 *   解析它必然超时。这里一天跑一次，慢一点无所谓。
 *
 * 用法：
 *   node pipeline/gen_fut_daily.mjs                 # 补最近 5 个工作日（幂等，已有的跳过）
 *   node pipeline/gen_fut_daily.mjs --backfill 250  # 首次建库
 *   node pipeline/gen_fut_daily.mjs --force         # 忽略已有数据重算
 *
 * 产物由 update-data.yml 的 cp 白名单带进 data 分支，Worker 用 readAsset 读。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import decodeKlc from '../data/sina_klc_decode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const BACKFILL = (() => {
  const i = args.indexOf('--backfill');
  return i >= 0 ? Math.max(1, parseInt(args[i + 1], 10) || 250) : 5;
})();
const FORCE = args.includes('--force');
const POS_DAYS = 60;          // 会员持仓只补最近 60 天：再往前没人看，且一天 4 个 90KB 文件
const KEEP = 250;

const FUT_PRODS = ['IF', 'IC', 'IH', 'IM'];
const OPT_PRODS = ['IO', 'MO', 'HO'];
const FUT_MAP = { IF: '000300', IH: '000016', IC: '000905', IM: '000852' };
const OPT_MAP = { IO: 'IF', HO: 'IH', MO: 'IM' };
const SPOT_SECID = { '000300': '1.000300', '000905': '1.000905', '000016': '1.000016', '000852': '1.000852' };

/* ETF 期权（上交所 510xxx / 深交所 159xxx）不在中金所那份 XML 里，也没有能回溯的历史源。
   和中金所的根本差别不是「有没有数据」，是「能不能按日期取」：中金所是
   sj/hqsj/rtj/YYYYMM/DD/index.xml 一天一个静态文件、永久可访问；交易所这边全是
   「当前状态」接口，过期即焚。

   2026-11-10 逐个试过，结论按源记：
   - 新浪：只有 hq.sinajs.cn 的实时快照。OptionService / StockOptionService 下没有日线
     方法，getOptionDayline / getKLine / getMinLine 一律 Service not found；
     quotes.html 本身也只调 getRemainderDay 和 getStockName。连在市合约都没有 K 线。
   - 东财 push2his：在市合约能取上市以来完整日线（12 月合约 2026-04-23 起 134 天），
     但代码一到期就从列表里清掉。扫 10010000~10012440 共 2441 个号，命中的全是在市合约。
     没有代码清单就定位不到历史 —— 不是数据被删，是入口被删。
   - 深交所 ShowReport：txtDate 参数被忽略，subname 永远返回当天。
   - 上交所 commonQuery：试了三个 sqlId 段，total 恒为 0；改版后也没找到可用入口。

   所以这 4 个品种只能从上线那天起逐日记录，之前的日子一律推 null 占位——
   图上前半段会是空的，那是真的没有，不是抓失败了。 */
const ETF_OPT = [
  ['1.510050', '510050', 'sh510050', '50ETF'],
  ['1.510300', '510300', 'sh510300', '300ETF'],
  ['0.159919', '159919', 'sz159919', '300ETF深'],
  ['1.588000', '588000', 'sh588000', '科创50'],
];
const ETF_CODES = ETF_OPT.map((x) => x[1]);

function log(...a) { console.log(...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3, timeout = 20000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'http://www.cffex.com.cn/' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

/** 第三个周五。中金所股指期货/期权交割日，遇法定假日顺延一天（这里不查表）。 */
function thirdFriday(ym) {
  const y = 2000 + parseInt(ym.slice(0, 2), 10);
  const m = parseInt(ym.slice(2, 4), 10);
  const wd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const day = 1 + ((5 - wd + 7) % 7) + 14;
  return Date.UTC(y, m - 1, day);
}

function dteOn(dateStr, ym) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round((thirdFriday(ym) - Date.UTC(y, m - 1, d)) / 86400e3);
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function atmWindow(pairs, S) {
  const byDist = pairs.slice().sort((a, b) => Math.abs(a.k - S) - Math.abs(b.k - S));
  for (const w of [0.03, 0.05, 0.08, 0.12]) {
    const near = byDist.filter((x) => Math.abs(x.k / S - 1) <= w).slice(0, 5);
    if (near.length >= 3) return near;
  }
  return byDist.slice(0, Math.min(3, byDist.length));
}

function cmValue(list) {
  const a = list.filter((x) => x.ann != null && x.dte > 0).sort((x, y) => x.dte - y.dte);
  if (!a.length) return null;
  if (a.length < 2 || a[0].dte > 30) return +a[0].bp.toFixed(3);
  for (let i = 0; i < a.length - 1; i++) {
    const x = a[i], y = a[i + 1];
    if (x.dte <= 30 && y.dte >= 30) {
      const w = (30 - x.dte) / (y.dte - x.dte);
      return +(x.bp + (y.bp - x.bp) * w).toFixed(3);
    }
  }
  return +a[a.length - 1].bp.toFixed(3);
}

/** 单日全品种行情：一次 539KB，期货 + 期权都在里面 */
function parseDailyXml(xml) {
  const out = [];
  const re = /<dailydata>([\s\S]*?)<\/dailydata>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const g = (tag) => {
      const x = b.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
      return x ? x[1] : '';
    };
    const id = g('instrumentid');
    if (!id) continue;
    out.push({
      id,
      td: g('tradingday'),
      close: +g('closeprice') || 0,
      settle: +g('settlementprice') || 0,
      preSettle: +g('presettlementprice') || 0,
      preOi: +g('preopeninterest') || 0,
      oi: +g('openinterest') || 0,
      vol: +g('volume') || 0,
      prod: g('productid') || id.replace(/\d.*$/, ''),
    });
  }
  return out;
}

/** 会员持仓排名：datatypeid 1=持买单量 2=持卖单量，varvolume 是较前一日的增减 */
function parsePosXml(xml, prod, date) {
  const rows = [];
  // <data Value="1" Text="IF2611"> 带属性，不能只匹配 <data>
  const re = /<data[^>]*>([\s\S]*?)<\/data>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const g = (tag) => {
      const x = b.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
      return x ? x[1] : '';
    };
    const inst = g('instrumentid');
    const dt = g('datatypeid');
    if (!inst || (dt !== '1' && dt !== '2')) continue;
    rows.push({
      c: inst, type: dt,
      v: +g('volume') || 0,
      dv: +g('varvolume') || 0,
    });
  }
  // 按合约汇总
  const byC = new Map();
  for (const r of rows) {
    let x = byC.get(r.c);
    if (!x) { x = { c: r.c, lv: 0, lvD: 0, sv: 0, svD: 0 }; byC.set(r.c, x); }
    if (r.type === '1') { x.lv += r.v; x.lvD += r.dv; } else { x.sv += r.v; x.svD += r.dv; }
  }
  const list = [...byC.values()].map((x) => ({ ...x, p: prod, netS: x.sv - x.lv, netSD: x.svD - x.lvD }));
  list.sort((a, b) => (a.c < b.c ? -1 : 1));
  return { d: date, rows: list };
}

// ---------------------------------------------------------------- 现货收盘
// 主源新浪、备源东财。2026-11-10 教训：GitHub Runner（Azure 海外 IP）打
// push2his.eastmoney.com 直接 502 / fetch failed，同一份工作流里 gen_mkt_hist
// 也挂在这里；而 data/import_etf.mjs 走新浪一直很稳。基差全依赖现货收盘，
// 单一源挂了就是「250 天全部跳过」，所以两个源都得在。
const SPOT_SINA = { '000300': 'sh000300', '000905': 'sh000905', '000016': 'sh000016', '000852': 'sh000852' };
// ETF 期权合成基差要用 ETF 自己的收盘价，顺手挂在同一份日线 map 里（同一源、同一口径）
for (const [, code, sym] of ETF_OPT) SPOT_SINA[code] = sym;

async function fetchSinaSpot() {
  const out = {};
  for (const [code, sym] of Object.entries(SPOT_SINA)) {
    const u = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
      + '?symbol=' + sym + '&scale=240&ma=no&datalen=400';
    let map = null;
    for (let k = 0; k < 3 && !map; k++) {
      try {
        const r = await fetch(u, {
          headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const m = {};
        for (const x of (Array.isArray(j) ? j : [])) {
          // 新浪给三位小数（4056.108），中金所/东财口径是两位，先统一掉，
          // 免得同一个点位在两条链路间差出 0.008 让基差看着像抖动
          if (x && x.day && +x.close > 0) m[x.day] = +(+x.close).toFixed(2);
        }
        if (Object.keys(m).length) map = m;
        else throw new Error('空数据');
      } catch (e) {
        if (k === 2) log('  现货 ' + code + ' 新浪 getKLineData 失败：' + e.message);
        else await sleep(600 * (k + 1));
      }
    }
    // 同在新浪、换个子域再试一次：money.* 和 finance.* 的解析路径不同，
    // 海外出口经常一个通一个不通，多这一跳比多等一天强
    if (!map) {
      try {
        const t = await fetchText('https://finance.sina.com.cn/realstock/company/' + sym + '/hisdata_klc2/klc_kl.js', 2, 20000);
        const b64 = t.split('=').slice(1).join('=').split(';')[0].replace(/"/g, '').trim();
        const m = {};
        for (const x of decodeKlc(b64) || []) {
          const d = String(x.date instanceof Date ? x.date.toISOString().slice(0, 10) : x.date).slice(0, 10);
          if (d && +x.close > 0) m[d] = +(+x.close).toFixed(2);
        }
        if (Object.keys(m).length) map = m;
      } catch (e) {
        log('  现货 ' + code + ' 新浪 hisdata 失败：' + e.message);
      }
    }
    if (map) out[code] = map;
    await sleep(120);
  }
  return out;
}

async function fetchEmSpot(code, secid) {
  const u = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid
    + '&klt=101&fqt=1&lmt=320&end=20500101'
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53';
  // 少一个现货指数，对应品种（IF/IH/IC/IM）当天的基差全成 null，而且
  // 期权合成基差也会跟着整块消失——一次抖动不值得毁掉一天的数据，重试三次
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const kl = (j && j.data && j.data.klines) || [];
      const m = {};
      for (const s of kl) {
        const a = s.split(',');
        if (a[0] && +a[1] > 0) m[a[0]] = +(+a[1]).toFixed(2);
      }
      if (Object.keys(m).length) return m;
      throw new Error('空数据');
    } catch (e) {
      if (k === 2) log('  现货 ' + code + ' 东财拉取失败（重试 3 次）：' + e.message);
      else await sleep(800 * (k + 1));
    }
  }
  return {};
}

async function fetchSpotClose() {
  const out = await fetchSinaSpot();
  const miss = Object.keys(SPOT_SECID).filter((c) => !out[c]);
  if (miss.length) log('  新浪缺 ' + miss.join(',') + '，转东财补');
  for (const code of miss) {
    out[code] = await fetchEmSpot(code, SPOT_SECID[code]);
    await sleep(150);
  }
  return out;
}

// ---------------------------------------------------------------- ETF 期权（只有当天抓得到）
async function fetchJson(url, tries = 3, timeout = 15000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

/** 合约清单只问东财要代码。行权价、剩余天数、认购/认沽一律取新浪那份——
 *  两个源混着用会算出 1.5% 的假贴水（东财对部分出口只给昨收，另一半是实时）。 */
async function fetchEtfOptCodes(secid) {
  const codes = [];
  for (const spt of [9, 10]) {
    const u = 'https://push2.eastmoney.com/api/qt/slist/get?spt=' + spt
      + '&fltt=2&invt=2&fields=f12&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3';
    const j = await fetchJson(u, 2);
    const d = (j && j.data && j.data.diff) || [];
    for (const x of (Array.isArray(d) ? d : Object.values(d))) {
      if (x && x.f12) codes.push(String(x.f12));
    }
    await sleep(120);
  }
  return [...new Set(codes)];
}

async function fetchSinaOpts(codes) {
  const out = new Map();
  if (!codes.length) return out;
  for (let i = 0; i < codes.length; i += 100) {
    const seg = codes.slice(i, i + 100);
    const u = 'https://hq.sinajs.cn/list=' + seg.map((c) => 'CON_OP_' + c).join(',');
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'https://stock.finance.sina.com.cn/' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    for (const line of txt.split('\n')) {
      const m = line.match(/hq_str_CON_OP_(\d+)="([^"]*)"/);
      if (!m || !m[2]) continue;
      const f = m[2].split(',');
      const px = +f[1], k = +f[7], dte = +f[47];
      if (!(px > 0) || !(k > 0) || !(dte >= 0)) continue;
      out.set(m[1], { px, k, dte, side: f[45] === 'P' ? 'P' : 'C', vol: +f[5] || 0, oi: +f[41] || 0 });
    }
    await sleep(150);
  }
  return out;
}

/** 和 buildDay 里股指期权那段同一套口径：按到期日分组 → 同行权价配对 →
 *  ATM±3% 取最多 5 档 → 中位数。ETF 期权没有对应期货，所以 futC/fb 一律 null。 */
async function buildEtfOptDay(spotMap) {
  const rows = [];
  for (const [secid, code] of ETF_OPT.map((x) => [x[0], x[1]])) {
    const S = spotMap[code];
    if (!(S > 0)) { log('  ' + code + ' 现货收盘缺，跳过 ETF 期权'); continue; }
    let px;
    try {
      px = await fetchSinaOpts(await fetchEtfOptCodes(secid));
    } catch (e) {
      log('  ' + code + ' 期权链抓取失败：' + e.message);
      continue;
    }
    if (!px.size) { log('  ' + code + ' 期权链为空'); continue; }
    const byDte = new Map();
    for (const r of px.values()) {
      let g = byDte.get(r.dte);
      if (!g) { g = { c: [], p: [] }; byDte.set(r.dte, g); }
      (r.side === 'C' ? g.c : g.p).push(r);
    }
    for (const [dte, g] of byDte) {
      const pm = new Map();
      for (const x of g.p) pm.set(x.k, x);
      const pairs = [];
      for (const x of g.c) {
        const p = pm.get(x.k);
        if (p) pairs.push({ k: x.k, c: x.px, p: p.px });
      }
      const near = atmWindow(pairs, S);
      if (!near.length) continue;
      const syn = median(near.map((x) => x.k + x.c - x.p));
      const basis = syn - S;
      const bp = basis / S * 100;
      const volC = g.c.reduce((a, x) => a + x.vol, 0);
      const volP = g.p.reduce((a, x) => a + x.vol, 0);
      const oiC = g.c.reduce((a, x) => a + x.oi, 0);
      const oiP = g.p.reduce((a, x) => a + x.oi, 0);
      rows.push({
        p: code, u: code, m: 'D' + dte, dte,
        syn: +syn.toFixed(3), basis: +basis.toFixed(3), bp: +bp.toFixed(3),
        ann: dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
        atm: near[0].k, n: near.length,
        pcr: volC > 0 ? +(volP / volC).toFixed(2) : (oiC > 0 ? +(oiP / oiC).toFixed(2) : null),
        futC: null, fb: null,
      });
    }
    await sleep(200);
  }
  rows.sort((a, b) => (a.p === b.p ? a.dte - b.dte : (a.p < b.p ? -1 : 1)));
  return rows;
}

// ---------------------------------------------------------------- 单日计算
function buildDay(rows, spotMap, posObj) {
  const S = {};   // 品种现货收盘
  for (const p of FUT_PRODS) {
    const code = FUT_MAP[p];
    S[p] = spotMap[code] || 0;
  }

  const futs = rows.filter((r) => FUT_PRODS.includes(r.prod) && /\d{4}$/.test(r.id));
  const opts = rows.filter((r) => OPT_PRODS.includes(r.prod) && /-[CP]-/.test(r.id));

  const futRows = [];
  const futPx = {};      // prod -> {ym: close}
  for (const r of futs) {
    const ym = r.id.slice(2, 6);
    const px = r.close > 0 ? r.close : r.settle;
    if (!(px > 0)) continue;
    (futPx[r.prod] = futPx[r.prod] || {})[ym] = px;
    const s = S[r.prod];
    const basis = s ? px - s : null;
    const bp = s ? basis / s * 100 : null;
    const dte = dteOn(currentDate, ym);
    futRows.push({
      c: r.id, p: r.prod, ym, px,
      chg: r.preSettle > 0 ? +((px - r.preSettle) / r.preSettle * 100).toFixed(2) : 0,
      oi: r.oi, oiD: r.preOi ? r.oi - r.preOi : null, vol: r.vol,
      dte, basis: s ? +basis.toFixed(2) : null, bp: s ? +bp.toFixed(3) : null,
      ann: s && dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
    });
  }
  futRows.sort((a, b) => (a.c < b.c ? -1 : 1));

  // 期权合成期货：按品种分月，ATM±3% 中位数
  const optRows = [];
  const byProd = new Map();
  for (const r of opts) {
    const m = r.id.match(/^([A-Z]+)(\d{4})-([CP])-(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const px = r.close > 0 ? r.close : r.settle;
    if (!(px > 0)) continue;
    const key = m[1] + m[2];
    let g = byProd.get(key);
    if (!g) { g = { prod: m[1], ym: m[2], c: [], p: [] }; byProd.set(key, g); }
    (m[3] === 'C' ? g.c : g.p).push({ k: +m[4], px, vol: r.vol, oi: r.oi });
  }
  for (const g of byProd.values()) {
    const fp = OPT_MAP[g.prod];
    const s = fp ? S[fp] : 0;
    if (!s) continue;
    const pm = new Map();
    for (const x of g.p) pm.set(x.k, x);
    const pairs = [];
    for (const x of g.c) {
      const p = pm.get(x.k);
      if (p) pairs.push({ k: x.k, c: x.px, p: p.px });
    }
    if (!pairs.length) continue;
    const near = atmWindow(pairs, s);
    if (!near.length) continue;
    const syn = median(near.map((x) => x.k + x.c - x.p));
    const volC = g.c.reduce((a, x) => a + x.vol, 0);
    const volP = g.p.reduce((a, x) => a + x.vol, 0);
    const oiC = g.c.reduce((a, x) => a + x.oi, 0);
    const oiP = g.p.reduce((a, x) => a + x.oi, 0);
    const dte = dteOn(currentDate, g.ym);
    const basis = syn - s;
    const bp = basis / s * 100;
    const f = (futPx[fp] || {})[g.ym];
    optRows.push({
      p: g.prod, u: FUT_MAP[fp], m: g.ym, dte,
      syn: +syn.toFixed(2), basis: +basis.toFixed(2), bp: +bp.toFixed(3),
      ann: dte >= 3 ? +(bp * 365 / dte).toFixed(2) : null,
      atm: near[0].k, n: near.length,
      pcr: volC > 0 ? +(volP / volC).toFixed(2) : (oiC > 0 ? +(oiP / oiC).toFixed(2) : null),
      futC: f != null ? fp + g.ym : null,
      fb: f != null ? +(syn - f).toFixed(2) : null,
    });
  }
  optRows.sort((a, b) => (a.p === b.p ? (a.m < b.m ? -1 : 1) : (a.p < b.p ? -1 : 1)));

  return { fut: futRows, opt: optRows, spot: S, pos: posObj };
}

// ---------------------------------------------------------------- 单日快照
// Worker 冷启动只读这一小块（~6KB），不必 parse 79KB 历史
function mkSnap(date, day, posObj, spotMap) {
  return {
    ok: true, td: date, ts: Date.now(),
    spot: Object.fromEntries(Object.entries(spotMap).map(([k, v]) => [k, { p: v }])),
    fut: day.fut.map((x) => ({ c: x.c, p: x.p, u: FUT_MAP[x.p], px: x.px, chg: x.chg,
      vol: x.vol, oi: x.oi, oiD: x.oiD, dte: x.dte, basis: x.basis, bp: x.bp, ann: x.ann })),
    opt: day.opt,
    pos: posObj,
  };
}

async function fetchPosFor(date, ymDir) {
  const parts = [];
  for (const p of FUT_PRODS) {
    try {
      const px = await fetchText('http://www.cffex.com.cn/sj/ccpm/' + ymDir + '/' + p + '.xml', 2);
      parts.push(...parsePosXml(px, p, date).rows);
    } catch (e) { /* 单个品种失败不影响其他 */ }
    await sleep(120);
  }
  return parts.length ? { d: date, rows: parts } : null;
}

// ---------------------------------------------------------------- 日期
function shToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function prevWeekdays(from, n) {
  const out = [];
  const t = new Date(from + 'T00:00:00Z');
  while (out.length < n) {
    t.setUTCDate(t.getUTCDate() - 1);
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t.toISOString().slice(0, 10));
  }
  return out.reverse();
}

let currentDate = '';

// ---------------------------------------------------------------- 主流程
async function main() {
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

  const dailyPath = join(DIST, 'fut_daily.json');
  let hist = { ok: true, d: [], spot: {}, fut: {}, opt: {}, pos: {} };
  // --force 是「重算」不是「追加」：从空表开始，否则同一批日期会被写两遍，
  // 数组长度翻倍、和日期对不上，前端按索引取会串到隔壁那天
  if (!FORCE && existsSync(dailyPath)) {
    try { hist = JSON.parse(readFileSync(dailyPath, 'utf8')); } catch (e) { log('旧日档读不出来，重建：' + e.message); }
  }
  const have = new Set(hist.d || []);

  const today = shToday();
  // 升序、以今天收尾：fut_last.json 要的是「最新一天」，所以今天必须最后处理；
  // 反过来的话 _last 会停在中间某天，oiD 基准和 pos 都跟着错位
  const prev = prevWeekdays(today, BACKFILL);
  const dates = prev.concat([today]).slice(-BACKFILL);
  const todo = dates.filter((d) => FORCE || !have.has(d));
  log(`目标 ${dates.length} 天（${dates[dates.length - 1]} ~ ${dates[0]}），已有 ${dates.length - todo.length} 天，本次补 ${todo.length} 天`);

  const spotHist = await fetchSpotClose();
  log('现货收盘拿到 ' + Object.entries(spotHist).map(([k, v]) => k + ':' + Object.keys(v).length).join(' '));

  let added = 0;
  for (let i = 0; i < todo.length; i++) {
    const date = todo[i];
    currentDate = date;
    const ymd = date.replace(/-/g, '');
    const ymDir = ymd.slice(0, 6) + '/' + ymd.slice(6, 8);

    let xml;
    try {
      xml = await fetchText('http://www.cffex.com.cn/sj/hqsj/rtj/' + ymDir + '/index.xml');
    } catch (e) {
      log(`  ${date} 日行情拿不到（${e.message}）——非交易日就跳过`);
      continue;
    }
    const rows = parseDailyXml(xml);
    if (!rows.length) { log(`  ${date} 解析出 0 行，跳过`); continue; }

    // 会员持仓只补最近 POS_DAYS 天（dates 是升序，所以看的是「离末尾多远」）
    let posObj = null;
    if (dates.length - 1 - dates.indexOf(date) < POS_DAYS) posObj = await fetchPosFor(date, ymDir);

    const spotMap = {};
    for (const code of Object.keys(SPOT_SECID)) {
      const v = (spotHist[code] || {})[date];
      if (v) spotMap[code] = v;
    }
    if (Object.keys(spotMap).length < 3) { log(`  ${date} 现货收盘缺，跳过`); continue; }

    // 逐日写进历史
    for (const [code, v] of Object.entries(spotMap)) {
      (hist.spot[code] = hist.spot[code] || []).push(v);
    }
    const day = buildDay(rows, spotMap, posObj);

    // ETF 期权只有「今天」抓得到（历史源见文件头注释），补最近几天时老日期不碰它
    if (date === today) {
      try {
        const etfRows = await buildEtfOptDay(spotMap);
        if (etfRows.length){
          day.opt = day.opt.concat(etfRows);
          const agg = {};
          for (const x of etfRows) (agg[x.p] = agg[x.p] || []).push(x.dte);
          log('  ETF 期权 ' + Object.entries(agg).map(([k, v]) => k + '×' + v.length).join(' '));
        }
      } catch (e) {
        log('  ETF 期权整块失败：' + e.message);
      }
    }

    const front = {};   // 每个品种的主力（最近月）
    for (const p of FUT_PRODS) {
      const l = day.fut.filter((x) => x.p === p && x.dte >= 0).sort((a, b) => a.dte - b.dte);
      if (l.length) front[p] = l[0];
    }

    for (const p of FUT_PRODS) {
      const f = hist.fut[p] = hist.fut[p] || { b: [], bp: [], ann: [], cmp: [], oi: [] };
      const x = front[p] || {};
      f.b.push(x.basis == null ? null : x.basis);
      f.bp.push(x.bp == null ? null : x.bp);
      f.ann.push(x.ann == null ? null : x.ann);
      f.cmp.push(cmValue(day.fut.filter((y) => y.p === p)));
      f.oi.push(x.oi == null ? null : x.oi);
    }
    // ETF 期权老日期没有数据，接口按同一批键推 null 占位，数组长度才和 hist.d 对得上
    for (const p of OPT_PRODS.concat(ETF_CODES)) {
      const o = hist.opt[p] = hist.opt[p] || { b: [], bp: [], ann: [], cmp: [], pcr: [] };
      const l = day.opt.filter((x) => x.p === p && x.dte >= 0).sort((a, b) => a.dte - b.dte);
      const x = l[0] || {};
      o.b.push(x.basis == null ? null : x.basis);
      o.bp.push(x.bp == null ? null : x.bp);
      o.ann.push(x.ann == null ? null : x.ann);
      o.cmp.push(cmValue(day.opt.filter((y) => y.p === p)));
      o.pcr.push(x.pcr == null ? null : x.pcr);
    }
    // 会员持仓：前 20 名合计。老于 POS_DAYS 的天推 null 占位，保证数组和日期等长
    for (const p of FUT_PRODS) {
      const g = hist.pos[p] = hist.pos[p] || { lvD: [], svD: [], netSD: [], netS: [] };
      const rs = posObj ? posObj.rows.filter((x) => x.p === p) : [];
      if (rs.length) {
        const lvD = rs.reduce((s, x) => s + x.lvD, 0);
        const svD = rs.reduce((s, x) => s + x.svD, 0);
        const lv = rs.reduce((s, x) => s + x.lv, 0);
        const sv = rs.reduce((s, x) => s + x.sv, 0);
        g.lvD.push(lvD); g.svD.push(svD); g.netSD.push(svD - lvD); g.netS.push(sv - lv);
      } else {
        g.lvD.push(null); g.svD.push(null); g.netSD.push(null); g.netS.push(null);
      }
    }
    hist.d.push(date);

    // 最新那份快照单独存：Worker 冷启动时只读 6KB，不必 parse 79KB 历史
    if (!hist._last || date >= hist._last.td) hist._last = mkSnap(date, day, posObj, spotMap);
    added++;
    log(`  ${date} 期货 ${day.fut.length} 行 / 期权 ${day.opt.length} 行` + (posObj ? ` / 持仓 ${posObj.rows.length} 行` : ''));
    await sleep(150);
  }

  // 收尾：按日期排序、截断到 KEEP 天
  const idx = hist.d.map((d, i) => i).sort((a, b) => (hist.d[a] < hist.d[b] ? -1 : 1));
  hist.d = idx.map((i) => hist.d[i]);
  for (const grp of ['fut', 'opt', 'pos']) {
    for (const p of Object.keys(hist[grp])) {
      for (const k of Object.keys(hist[grp][p])) hist[grp][p][k] = idx.map((i) => hist[grp][p][k][i] ?? null);
    }
  }
  for (const c of Object.keys(hist.spot)) hist.spot[c] = idx.map((i) => hist.spot[c][i] ?? null);

  const cut = Math.max(0, hist.d.length - KEEP);
  if (cut > 0) {
    hist.d = hist.d.slice(cut);
    for (const grp of ['fut', 'opt', 'pos']) for (const p of Object.keys(hist[grp])) {
      for (const k of Object.keys(hist[grp][p])) hist[grp][p][k] = hist[grp][p][k].slice(cut);
    }
    for (const c of Object.keys(hist.spot)) hist.spot[c] = hist.spot[c].slice(cut);
  }

  // 一天都没落地就别写盘：宁可让这条链报错，也不要拿空表覆盖掉 data 分支上
  // 已经攒好的 200 多天——一次上游全挂（2026-11-10 东财从 Runner 全 502）
  // 就会把历史清零，而历史分位是这个模块的全部价值
  if (!hist.d.length) {
    console.error('没有任何一天落地（现货源和日行情都拿不到），不写盘，退出');
    process.exit(2);
  }

  // 兜底：存量日档里没有 _last（早期版本把它删掉了），或快照落后于历史最后一天，
  // 而本次又没补到新数据（凌晨跑、当天行情还没出，todo 全命中 have → 循环一次都没进），
  // 就直接按历史里最后一天重抓一次重建快照。只重建快照，不动 hist 数组，
  // 免得同一天被写两遍、数组和日期串位
  if ((!hist._last || hist._last.td < hist.d[hist.d.length - 1]) && hist.d.length) {
    const date = hist.d[hist.d.length - 1];
    const ymd = date.replace(/-/g, '');
    const ymDir = ymd.slice(0, 6) + '/' + ymd.slice(6, 8);
    const at = hist.d.indexOf(date);
    const spotMap = {};
    for (const code of Object.keys(SPOT_SECID)) {
      const v = (hist.spot[code] || [])[at];
      if (v) spotMap[code] = v;
    }
    try {
      currentDate = date;
      const rows = parseDailyXml(await fetchText('http://www.cffex.com.cn/sj/hqsj/rtj/' + ymDir + '/index.xml'));
      if (rows.length && Object.keys(spotMap).length >= 3) {
        const posObj = await fetchPosFor(date, ymDir);
        hist._last = mkSnap(date, buildDay(rows, spotMap, posObj), posObj, spotMap);
        log(`快照缺失，按 ${date} 重建了一份（期货 ${hist._last.fut.length} 行 / 期权 ${hist._last.opt.length} 行）`);
      } else {
        log(`快照重建跳过：${date} 日行情 ${rows.length} 行、现货 ${Object.keys(spotMap).length} 只`);
      }
    } catch (e) {
      log('快照重建失败（不影响历史）：' + e.message);
    }
  }

  hist.generated_at = new Date().toISOString();
  hist.last_trade_date = hist.d[hist.d.length - 1] || null;
  hist.ok = true;

  const last = hist._last || null;
  // _last 留在 fut_daily.json 里：data 分支每次 force push，下次开工只能取回
  // 上一次发布的那两个文件；如果快照只写在 fut_last.json、而某天没有新数据
  // （比如凌晨跑，当天行情还没出），取回来就只剩历史、快照丢了
  writeFileSync(dailyPath, JSON.stringify(hist));
  if (last) writeFileSync(join(DIST, 'fut_last.json'), JSON.stringify(last));

  const size = (o) => (JSON.stringify(o).length / 1024).toFixed(0) + 'KB';
  log(`写入 fut_daily.json ${hist.d.length} 天 / ${size(hist)}，fut_last.json ${last ? size(last) : '无'}`);
  log(`本次新增 ${added} 天`);

  if (hist.d.length < 60) {
    log('::warning::历史不足 60 天，前端的「历史分位」会显示样本不足');
  }
}

main().catch((e) => {
  console.error('失败：' + (e && e.stack || e));
  process.exit(1);
});
