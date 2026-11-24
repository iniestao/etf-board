/* ETF 期权「当日收盘快照」：每天收盘后从交易所行情抓一份，落盘存着。
 *
 * 为什么要有这个文件
 * ------------------
 * 上交所、深交所都**不发**逐合约的历史日行情——这一点 2026-11-24 逐个验过：
 *   · 上交所 yunhq.sse.com.cn 只给实时（date 参数被忽略，永远回当前时刻）；
 *   · 上交所 query.sse.com.cn 的 commonQuery 只有「按标的汇总」的每日统计
 *     （COMMON_SSE_ZQPZ_YSP_QQ_SJTJ_MRTJ_CX，有历史日期），试过的 8 个逐合约
 *     sqlId 全部 total=0；
 *   · 深交所报表系统只有 option_jycchztj（交易持仓汇总，无价格），
 *     ysplbrb 是合约清单，8 个疑似 catalogs 全空，行情 API 不响应。
 * 也就是说，已到期合约的收盘价在所有免费源上都「即焚」，事后无从补。
 *
 * 结论：不要指望「历史接口」，改成**每天收盘时自己存一份**。从今天起，
 * 每一天都是永久可查的；缺口只可能出现在本脚本上线之前的日期。
 *
 * 取价路径（都不碰东财 push2his，那个按出口 IP 限流）
 * --------------------------------------------------
 *   沪市 5 只：yunhq（交易所直连）——合约清单、收盘价、标的收盘价全在里面
 *   深市 4 只：深交所 ysplbrb（官方合约清单，含行权价与到期日）
 *             + 新浪 CON_OP 快照（转发的交易所行情，一条请求拿一档）
 *
 * 口径与 etfopt_backfill.mjs 的 one() 逐字一致：只取当月合约、ATM 附近 ≤5 档、
 * median(K + C − P)。dte 用「到期日 − 今天 + 1」，和东财 f162 的算法对齐，
 * 这样新旧两条路的年化数能接上。
 *
 * 用法：
 *   node pipeline/etfopt_eod.mjs           # 收盘后跑，写 dist/etfopt_eod.json
 *   node pipeline/etfopt_eod.mjs --dry     # 只打印，不写
 *   node pipeline/etfopt_eod.mjs --force   # 盘中强制跑（标 src 时带 intraday，仅供调试）
 */
import fs from 'fs';
import path from 'path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.env.ETFOPT_EOD_OUT || path.join(ROOT, 'dist', 'etfopt_eod.json');
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const SSE = [
  ['510050', '50ETF'],
  ['510300', '300ETF'],
  ['510500', '500ETF'],
  ['588000', '科创50'],
  ['588080', '科创板50'],
];
const SZ = ['159901', '159915', '159919', '159922'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bjNow = () => new Date(Date.now() + 8 * 3600e3);
const TODAY = bjNow().toISOString().slice(0, 10);

/* ---- 与 backfill 同一套小工具 ---- */
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function atmWindow(pairs, S) {
  const byDist = pairs.slice().sort((a, b) => Math.abs(a.k - S) - Math.abs(b.k - S));
  for (const w of [0.03, 0.05, 0.08, 0.12]) {
    const near = byDist.filter((x) => S > 0 && Math.abs(x.k / S - 1) <= w).slice(0, 5);
    if (near.length >= 3) return near;
  }
  return byDist.slice(0, Math.min(3, byDist.length));
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function fourthWed(y, m) {
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const firstWed = 1 + ((3 - dow + 7) % 7);
  return Date.UTC(y, m - 1, firstWed + 21);
}
function frontMonth(dstr) {
  const t = Date.parse(dstr + 'T00:00:00Z');
  const dt = new Date(t);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
  if (t <= fourthWed(y, m)) return m;
  return m === 12 ? 1 : m + 1;
}

async function jget(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'http://www.sse.com.cn/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
  return null;
}

/* ---------------- 沪市：上交所 yunhq ---------------- */
const HQ = 'http://yunhq.sse.com.cn:32041';

async function sseOne(code, tag, wantMth, wantYm) {
  /* 合约清单按「标的_月份」拉，一条给全该月所有档位（含 C/P）。
     返回 [合约代码, 最新价, 前结价, 行权价]。 */
  const key = code + '_' + String(wantMth).padStart(2, '0');
  const j = await jget(HQ + '/v1/sho/list/tstyle/' + key
    + '?select=contractid,last,presetpx,exepx&order=contractid%2Case', 3).catch(() => null);
  const rows = (j && j.list) || [];
  if (!rows.length) return { err: '该月无合约（可能已到期或月份不对）' };

  /* 只认当月：yunhq 按「月」索引，跨年时 01 月会被 12 月的键混进来，
     用合约 ID 里嵌的年月再筛一道。 */
  const byK = new Map();
  for (const [id, last, , exepx] of rows) {
    const m = /^(\d{6})([CP])(\d{4})M/.exec(id);
    if (!m || +m[3] !== wantYm) continue;
    const k = +exepx, side = m[2];
    if (!(k > 0)) continue;
    if (!byK.has(k)) byK.set(k, {});
    byK.get(k)[side] = last;
  }

  const pj = await jget(HQ + '/v1/sh1/list/self/' + code
    + '?select=code,last,prev_close', 3).catch(() => null);
  const S = pj && pj.list && pj.list[0] ? +pj.list[0][1] : 0;
  if (!(S > 0)) return { err: '标的价取不到' };

  return { S, byK, rows, date: j.date };
}

/* ---------------- 深市：深交所清单 + 新浪快照 ---------------- */
async function szList() {
  /* ysplbrb：深交所股票期权合约清单。20 条/页（PAGESIZE 参数被忽略），
     36 页。这是官方清单，含行权价与到期日，不依赖任何第三方。 */
  const out = [];
  let pages = 1;
  for (let p = 1; p <= 40; p++) {
    const u = 'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON'
      + '&CATALOGID=ysplbrb&TABKEY=tab1&PAGENO=' + p + '&random=' + Math.random();
    let j = null;
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, Referer: 'https://www.szse.cn/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
    } catch (e) {
      if (p === 1) throw e;
      console.log('    深交所清单第 ' + p + ' 页失败：' + e.message);
      break;
    }
    const blk = j && j[0];
    if (!blk || !blk.data) break;
    pages = blk.metadata.pagecount || 1;
    out.push(...blk.data);
    if (p >= pages) break;
    await sleep(80);
  }
  return out;
}

async function sinaCodes(codes) {
  /* 一条请求最多带 50 个，太多会被截断。返回 code -> {last, k, ts, ul} */
  const out = new Map();
  for (let i = 0; i < codes.length; i += 50) {
    const seg = codes.slice(i, i + 50);
    const url = 'https://hq.sinajs.cn/list=' + seg.map((c) => 'CON_OP_' + c).join(',');
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        let txt;
        try { txt = new TextDecoder('gbk').decode(buf); }
        catch (e) { txt = new TextDecoder('utf-8').decode(buf); }
        for (const m of txt.matchAll(/CON_OP_(\d+)="([^"]*)"/g)) {
          const f = m[2].split(',');
          if (f.length < 37) continue;
          out.set(m[1], { last: +f[2], k: +f[7], ts: (f[32] || '').trim(), ul: (f[36] || '').trim() });
        }
        break;
      } catch (e) {
        if (t === 2) console.log('    新浪报价失败：' + e.message);
        await sleep(1200 * (t + 1));
      }
    }
    await sleep(200);
  }
  return out;
}

async function sinaSpot(code) {
  const url = 'https://hq.sinajs.cn/list=' + (code[0] === '1' ? 'sz' : 'sh') + code;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      let txt;
      try { txt = new TextDecoder('gbk').decode(buf); }
      catch (e) { txt = new TextDecoder('utf-8').decode(buf); }
      const m = /="([^"]*)"/.exec(txt);
      if (!m) return 0;
      const f = m[1].split(',');
      /* 沪市 sh 前缀：字段 3=当前价；深市 sz 前缀：字段 3=当前价、2=昨收 */
      return +f[3] > 0 ? +f[3] : +f[2];
    } catch (e) {
      if (t === 2) return 0;
      await sleep(1000 * (t + 1));
    }
  }
  return 0;
}

/* ---------------- 合成一条 ---------------- */
function synth(byK, S) {
  const pairs = [];
  for (const [k, v] of byK) {
    if (v.C > 0 && v.P > 0) pairs.push({ k, C: v.C, P: v.P });
  }
  if (!pairs.length) return { err: '当月没有可配的 C/P 档' };
  const w = atmWindow(pairs, S);
  const syn = median(w.map((x) => x.k + x.C - x.P));
  return { n: w.length, syn, bp: (syn - S) / S * 100 };
}

async function main() {
  const t = bjNow();
  const hm = t.getUTCHours() * 100 + t.getUTCMinutes();
  const dow = t.getUTCDay();
  const closed = dow !== 0 && dow !== 6 && hm >= 1505;
  console.log('ETF 期权当日快照  ' + TODAY + ' ' + String(t.getUTCHours()).padStart(2, '0')
    + ':' + String(t.getUTCMinutes()).padStart(2, '0') + (closed ? '  已收盘' : '  未收盘'));

  /* 不收盘就不写「今天」，但**不退出**。
   *
   * 那个 16:35 的批次经常被 GitHub 拖到次日凌晨（11-23 是拖到 04:28 的），那时
   * 「当前时刻」明明已收盘、日历却翻页了。反过来，07:00 那批跑在开盘前，此刻
   * yunhq 给的还是昨天的收盘价——那也是可以收的，而且正好补上昨天。
   * 所以判据不是「现在几点」，而是「这条数据的日期是不是已经收盘了」：
   * 非收盘时段只接受日期早于今天的快照，当天的盘中价一律不收。 */
  const days = {};

  const mth = frontMonth(TODAY);
  const y = +TODAY.slice(0, 4);
  const wantYm = (mth >= 10 ? (y % 100) : (mth === 1 ? (y + 1) % 100 : y % 100)) * 100 + mth;
  const exp = fourthWed(y, mth);
  const dte = daysBetween(TODAY, new Date(exp).toISOString().slice(0, 10)) + 1;
  console.log('  当月 ' + mth + ' 月  到期日 ' + new Date(exp).toISOString().slice(0, 10)
    + '  dte ' + dte);

  /* 非收盘时段（早盘、盘中、午休）只接受「日期早于今天」的快照：
     那是上一交易日的收盘价，可以收；当天的盘中价一律不收。 */
  const okToPut = (d) => closed || FORCE || d < TODAY;
  const put = (d, code, rec) => {
    if (!days[d]) days[d] = {};
    days[d][code] = rec;
  };

  /* ---- 沪市 ---- */
  for (const [code, tag] of SSE) {
    try {
      const r = await sseOne(code, tag, mth, wantYm);
      if (r.err) { console.log('  ' + tag + ' ' + r.err); continue; }
      const s = synth(r.byK, r.S);
      if (s.err) { console.log('  ' + tag + ' ' + s.err); continue; }
      const d = (function (n) {
        const x = String(n);
        return x.slice(0, 4) + '-' + x.slice(4, 6) + '-' + x.slice(6, 8);
      })(r.date);
      const ann = dte >= 3 ? +(s.bp * 365 / dte).toFixed(2) : null;
      const ok = okToPut(d);
      if (ok) {
        put(d, code, {
          S: +r.S.toFixed(4), mth, dte, n: s.n,
          bp: +s.bp.toFixed(3), ann, src: FORCE ? 'sse-intraday' : (closed ? 'sse' : 'sse-prev'),
        });
      }
      console.log('  ' + tag.padEnd(7) + ' S=' + r.S.toFixed(3) + '  ' + s.n + ' 档  bp='
        + s.bp.toFixed(3) + '%  ' + d + (ok ? '' : '  （盘中，不落盘）'));
    } catch (e) {
      console.log('  ' + tag + ' 失败：' + e.message);
    }
    await sleep(300);
  }

  /* ---- 深市 ---- */
  let list = [];
  try {
    list = await szList();
    console.log('  深交所合约清单 ' + list.length + ' 条');
  } catch (e) {
    console.log('  深交所清单取不到：' + e.message + '（深市本轮跳过）');
  }
  if (list.length) {
    /* 只留当月到期的（xqrq 的年月等于当月） */
    const want = list.filter((x) => {
      const d = String(x.xqrq || '');
      return d.slice(0, 4) === String(y) && +d.slice(5, 7) === mth;
    });
    /* 按标的代码分组：新浪回报里第 37 字段是标的代码，先用清单里的 bdmc 粗筛，
       真正落组时再用新浪回报的 ul 校正。 */
    const codes = want.map((x) => String(x.hydm));
    console.log('  深市当月合约 ' + codes.length + ' 条');
    const q = await sinaCodes(codes);
    const grp = new Map();      // 标的 -> Map(k -> {C,P})
    for (const x of want) {
      const c = String(x.hydm);
      const z = q.get(c);
      if (!z || !(z.last >= 0)) continue;
      const ul = z.ul || '';
      if (!SZ.includes(ul)) continue;
      const k = +x.xqj;
      const side = String(x.hylx).includes('购') ? 'C' : 'P';
      if (!(k > 0)) continue;
      if (!grp.has(ul)) grp.set(ul, new Map());
      const m = grp.get(ul);
      if (!m.has(k)) m.set(k, {});
      m.get(k)[side] = z.last;
    }
    for (const [ul, byK] of grp) {
      try {
        const S = await sinaSpot(ul);
        if (!(S > 0)) { console.log('  ' + ul + ' 标的价取不到'); continue; }
        const s = synth(byK, S);
        if (s.err) { console.log('  ' + ul + ' ' + s.err); continue; }
        const ann = dte >= 3 ? +(s.bp * 365 / dte).toFixed(2) : null;
        const ok = okToPut(TODAY);
        if (ok) {
          put(TODAY, ul, {
            S: +S.toFixed(4), mth, dte, n: s.n,
            bp: +s.bp.toFixed(3), ann, src: FORCE ? 'szse-intraday' : (closed ? 'szse' : 'szse-prev'),
          });
        }
        console.log('  ' + ul + '     S=' + S.toFixed(3) + '  ' + s.n + ' 档  bp='
          + s.bp.toFixed(3) + '%' + (ok ? '' : '  （盘中，不落盘）'));
      } catch (e) {
        console.log('  ' + ul + ' 失败：' + e.message);
      }
      await sleep(250);
    }
  }

  /* ---- 合并落盘：只加不改 ---- */
  const raw = (() => {
    try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return null; }
  })();
  const prev = raw && raw.v === 1 && raw.days ? raw.days : {};
  const merged = { ...prev };
  for (const [d, m] of Object.entries(days)) {
    merged[d] = merged[d] || {};
    for (const [code, rec] of Object.entries(m)) {
      /* 已有的不动——同一天同一只跑第二遍，第一遍更接近「刚收盘」那一刻 */
      if (!merged[d][code]) merged[d][code] = rec;
    }
  }
  const out = {
    v: 1,
    gen: new Date().toISOString(),
    note: '每交易日收盘后从交易所行情落盘，只加不改。沪市走上交所 yunhq，深市走深交所合约清单 + 新浪快照。'
      + '口径同 etfopt_backfill：只用当月合约、ATM ≤5 档、median(K+C−P)。',
    days: merged,
  };

  const dn = Object.keys(merged).sort();
  console.log('\n日期 ' + (dn[0] || '-') + ' ~ ' + (dn[dn.length - 1] || '-') + '  共 ' + dn.length + ' 天');
  for (const d of dn.slice(-3)) {
    console.log('  ' + d + '  ' + Object.keys(merged[d]).length + ' 只  '
      + Object.entries(merged[d]).map(([c, v]) => c + ':' + v.bp).join(' '));
  }

  if (!Object.keys(days).length) {
    console.log('\n本轮没有可落盘的数据，文件保持原样');
    return;
  }
  if (DRY) { console.log('\n--dry：不写文件'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('\n写入 ' + OUT + '  ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');

  const miss = [...SSE.map((x) => x[0]), ...SZ].filter((c) => !(merged[TODAY] && merged[TODAY][c]));
  console.log(miss.length ? '  ! 今天缺 ' + miss.length + ' 只：' + miss.join(' ')
    : '  ✓ 九只齐');
}

main().catch((e) => { console.error(e); process.exit(1); });
