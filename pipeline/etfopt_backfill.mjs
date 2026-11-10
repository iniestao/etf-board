/* ETF 期权历史回补：不是「找历史合约」，而是「用还活着的合约倒推」。
 *
 * 背景（2026-11-10 逐个源验过，结论写在 gen_fut_daily.mjs 文件头）：
 * 已到期合约在上交所/深交所/东财/新浪全部即焚，secid 直接从索引里消失，
 * 扫 10010000~10012440 共 2441 个号命中的全是在市合约。所以「当时的当月合约
 * 价格」这条数据在免费源里根本不存在，补不回来。
 *
 * 只能反过来做：今天在市的合约里，某天它恰好是当月，那天就有真近月；否则不画。
 * 11 月合约 2026-10-29 起成为当月（10 月合约 10-28 到期），而它今天仍在市，
 * 所以能还原的就是这九个交易日；更早的日子只有当月合约消失后的下月/隔季，
 * **不拿来顶替**——隔季贴水天然更深，跟股指期权的「主力近月」不可比。
 *
 * 口径：只用真近月（当月合约），画基差率本身（bp），和 gen_fut_daily.mjs 里
 * 期权部分的 `l[0]`（dte 最小的那一档）完全一致，跨品种可以直接比。
 *
 * 为什么要和上一版合并：11 月合约 11-25 到期后连 kline 一起消失，它贡献的
 * 那九个点只有落盘的那份还留着。每天全量重算再覆盖 = 每天削一层，越跑越少。
 *
 * 用法：
 *   node pipeline/etfopt_backfill.mjs            # 全量重建，写 dist/etfopt_hist.json
 *   node pipeline/etfopt_backfill.mjs --dry      # 只打印统计，不写文件
 *   node pipeline/etfopt_backfill.mjs --recalc   # 强制用新值覆盖（正常不用）
 */
import fs from 'fs';
import path from 'path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'etfopt_hist.json');
const DRY = process.argv.includes('--dry');
const CONC = 4;

/* 和 gen_fut_daily.mjs 的 ETF_OPT 保持一致，只取历史这 4 个（另 5 个是实时表才有的） */
const LIST = [
  ['1.510050', '510050', '50ETF'],
  ['1.510300', '510300', '300ETF'],
  ['0.159919', '159919', '300ETF深'],
  ['1.588000', '588000', '科创50'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

/** 当前在市合约清单。spt=9/10 是东财的两个分页段，要去重。 */
async function chain(secid) {
  const out = new Map();
  for (const spt of [9, 10]) {
    const u = 'https://push2.eastmoney.com/api/qt/slist/get?spt=' + spt
      + '&fltt=2&invt=2&fields=f12,f13,f14,f161,f162&secid=' + secid + '&pn=1&pz=200&np=1&fid=f3';
    const j = await jget(u, 2).catch(() => null);
    const d = (j && j.data && j.data.diff) || {};
    const items = Array.isArray(d) ? d : Object.values(d);
    for (const x of items) {
      if (!x || !x.f12) continue;
      const m = /([购沽])(\d+)月(\d+)/.exec(x.f14 || '');
      if (!m) continue;
      const code = String(x.f12);
      if (out.has(code)) continue;
      out.set(code, {
        code,
        mk: x.f13 || 10,          // 沪市期权 f13=10，深市 f13=12，日线 secid 要用它
        side: m[1] === '购' ? 'C' : 'P',
        mth: +m[2],
        k: +m[3] / 1000,          // 东财行权价字段是「厘」，3300 → 3.300
        dte: +x.f162,
      });
    }
    await sleep(120);
  }
  return [...out.values()];
}

/** 日线收盘价 map：{'2026-11-10': 2.891} */
async function kline(secid) {
  const u = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid
    + '&klt=101&fqt=0&beg=0&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
  const j = await jget(u);
  const dd = j && j.data;
  if (!dd || !dd.klines) return null;
  const out = {};
  for (const ln of dd.klines) {
    const p = ln.split(',');
    out[p[0]] = +p[2];
  }
  return out;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 和 buildEtfOptDay 同一套 ATM 口径：|K/S−1|≤3%，按距离取最多 5 档，中位数 */
function atmWindow(pairs, S, band = 0.03, cap = 5) {
  return pairs.filter((p) => S > 0 && Math.abs(p.k / S - 1) <= band)
    .sort((a, b) => Math.abs(a.k - S) - Math.abs(b.k - S))
    .slice(0, cap);
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** 某月的第四个星期三——ETF 期权的到期日。遇节假日交易所会顺延，
 *  这里不查日历：顺延那一两天会被判成「已换月」而跳过，宁可缺着。 */
function fourthWed(y, m) {
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const firstWed = 1 + ((3 - dow + 7) % 7);
  return Date.UTC(y, m - 1, firstWed + 21);
}

/** d 那天的「当月合约」是哪个月份。ETF 期权每月都挂，所以这是个确定性判断：
 *  本月第四个星期三没过就是本月，过了就是下个月。 */
function frontMonth(dstr) {
  const t = Date.parse(dstr + 'T00:00:00Z');
  const dt = new Date(t);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
  if (t <= fourthWed(y, m)) return m;
  return m === 12 ? 1 : m + 1;
}

async function one(secid, code, tag) {
  const ch = await chain(secid);
  if (!ch.length) { console.log('  ' + tag + ' 期权链为空'); return null; }

  const spotK = await kline(secid);
  if (!spotK) { console.log('  ' + tag + ' 现货日线取不到'); return null; }

  const mkOf = new Map(ch.map((x) => [x.code, x.mk]));
  const uniq = [...new Set(ch.map((x) => x.code))];
  const kls = new Map();
  let done = 0;
  for (let i = 0; i < uniq.length; i += CONC) {
    const seg = uniq.slice(i, i + CONC);
    const res = await Promise.all(seg.map((c) => kline(mkOf.get(c) + '.' + c).catch(() => null)));
    seg.forEach((c, k) => { if (res[k]) kls.set(c, res[k]); });
    done += seg.length;
    if (done % 20 === 0) process.stdout.write('    ' + tag + ' ' + done + '/' + uniq.length + '\r');
    await sleep(60);
  }
  console.log('    ' + tag + ' 日线 ' + kls.size + '/' + uniq.length + '   档');

  /* 按「到期月 + 行权价」配对 C/P，再把每个合约的日线铺到日期轴上 */
  const byKey = new Map();      // mth|k -> {C:{}, P:{}}
  for (const x of ch) {
    const kk = x.mth + '|' + x.k;
    if (!byKey.has(kk)) byKey.set(kk, { mth: x.mth, k: x.k, dte: x.dte, C: null, P: null });
    const slot = byKey.get(kk);
    const s = kls.get(x.code);
    if (s) slot[x.side] = s;
  }

  /* 每天：多组（几个到期月）各算一个 bp，再挑 dte 最小 / 最大的那组 */
  const perDay = new Map();     // date -> [{mth, dte, bp, n}]
  for (const slot of byKey.values()) {
    if (!slot.C || !slot.P) continue;
    for (const d of Object.keys(slot.C)) {
      const p = slot.P[d];
      const S = spotK[d];
      if (p == null || !(S > 0)) continue;
      // 该合约在 d 那天的剩余天数：今天 dte 天到期 → 到期日 = 今天 + dte
      // 用「今天」做锚，避免每个合约各算一套
      if (!perDay.has(d)) perDay.set(d, []);
      perDay.get(d).push({ mth: slot.mth, k: slot.k, c: slot.C[d], p, S });
    }
  }

  const rows = [];
  for (const d of [...perDay.keys()].sort()) {
    const items = perDay.get(d);
    const S = items[0].S;
    // 按到期月分组 → 每组 ATM 中位数合成
    const g = new Map();
    for (const it of items) {
      if (!g.has(it.mth)) g.set(it.mth, []);
      g.get(it.mth).push(it);
    }
    const groups = [];
    for (const [mth, arr] of g) {
      const w = atmWindow(arr, S);
      if (w.length < 2) continue;
      const syn = median(w.map((x) => x.k + x.c - x.p));
      groups.push({ mth, n: w.length, syn, bp: (syn - S) / S * 100 });
    }
    if (!groups.length) continue;
    /* dte 用「当前在市合约的 dte」推到那一天：该合约今天 dte=X，则 d 那天是 X + (today−d)。
       同一个月内所有合约到期日相同，取该月任一条的 dte 即可。 */
    const dteOf = new Map();
    for (const x of ch) if (!dteOf.has(x.mth)) dteOf.set(x.mth, x.dte);
    for (const gr of groups) {
      const base = dteOf.get(gr.mth);
      gr.dte = base == null ? null : base + daysBetween(d, TODAY);
    }
    groups.sort((a, b) => a.dte - b.dte);
    const near = groups[0];
    if (near.dte == null) continue;
    /* 只留真近月。判据不是「我手上最短的那组」（那可能是隔季），而是「按日历
       当月该是哪个月」：2026-09-24 那天最短可用是 11 月合约，可当时的当月是
       10 月（10-28 到期）、它的价格已经消失，11 月其实是下月。这种天宁可不画。 */
    if (near.mth !== frontMonth(d)) continue;
    rows.push({
      d,
      near: { mth: near.mth, dte: near.dte, n: near.n, bp: +near.bp.toFixed(3),
              ann: near.dte >= 3 ? +(near.bp * 365 / near.dte).toFixed(2) : null },
    });
  }
  return rows;
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('ETF 期权历史重建  today=' + TODAY);
  const res = {};
  for (const [secid, code, tag] of LIST) {
    console.log('  ' + tag + ' (' + code + ')');
    try {
      const rows = await one(secid, code, tag);
      if (!rows || !rows.length) { console.log('    ' + tag + ' 无可还原日期'); continue; }
      res[code] = rows;
      console.log('    ' + tag + ' 还原 ' + rows.length + ' 天  ' + rows[0].d + ' ~ ' + rows[rows.length - 1].d);
    } catch (e) {
      console.log('    ' + tag + ' 失败：' + e.message);
    }
    await sleep(300);
  }

  /* ---------------- 和上一版合并 ----------------
   * 必须合并，不能覆盖。理由：今天还在市的合约，下个月就没了——11 月合约 2026-11-25
   * 到期后连 kline 都删掉，它贡献的那些近月点只有落盘的那份还留着。
   * 每天全量重算再整体覆盖，等于每天把历史削掉一层，越跑越少。
   *
   * 规则：老日期用老值，新日期用新值，两边都有时留老值。
   * 万一老值是错的，加 --recalc 可强制用新值重算。
   *
   * v:2 —— 2026-11-10 晚改过口径（隔季 → 真近月），旧文件里的 nb/na 装的其实是
   * 远月，不能混进来当老值。读到没有 v:2 的旧文件整份丢弃，从现在重新攒。 */
  const raw = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return null; } })();
  const old = raw && raw.v === 2 ? raw : null;
  if (raw && !old) console.log('  旧文件口径是隔季（v≠2），整份丢弃，按真近月重新开始');
  const recalc = process.argv.includes('--recalc');

  const newDays = [...new Set(Object.values(res).flatMap((r) => r.map((x) => x.d)))];
  const oldDays = (old && old.d) || [];
  const allD = [...new Set([...oldDays, ...newDays])].sort();
  const idx = new Map(allD.map((d, i) => [d, i]));

  const KEYS = ['nb', 'na', 'nd', 'nm'];
  const s = {};
  const codes = [...new Set([...Object.keys((old && old.s) || {}), ...Object.keys(res)])];
  for (const code of codes) {
    const n = allD.length;
    const o = {};
    for (const k of KEYS) o[k] = new Array(n).fill(null);

    // 1) 先把老值铺满
    const ov = (old && old.s && old.s[code]) || null;
    if (ov) {
      for (const k of KEYS) {
        const arr = ov[k] || [];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] == null) continue;
          const t = idx.get(oldDays[i]);
          if (t != null) o[k][t] = arr[i];
        }
      }
    }
    // 2) 新值补空（--recalc 时反过来，新值覆盖老值）
    for (const r of res[code] ? res[code] : []) {
      const i = idx.get(r.d);
      if (i == null) continue;
      const put = (k, v) => { if (recalc || o[k][i] == null) o[k][i] = v; };
      put('nb', r.near.bp); put('na', r.near.ann); put('nd', r.near.dte); put('nm', r.near.mth);
    }
    s[code] = o;
  }

  const out = {
    v: 2,
    ok: 1,
    gen: new Date().toISOString(),
    note: '只用真近月（当月合约）。历史上「当时那个当月合约」到期后全网无价格，那天就空着——'
      + '宁可缺，也不拿隔季顶替（隔季贴水天然更深，和股指期权近月不可比）。',
    d: allD,
    s,
  };

  if (DRY) {
    console.log('\n--dry：不写文件');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log('\n写入 ' + OUT + '  ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
  }
  console.log('日期轴 ' + allD.length + ' 天  ' + (allD[0] || '-') + ' ~ ' + (allD[allD.length - 1] || '-'));
  for (const [code, o] of Object.entries(s)) {
    const nf = o.nb.filter((x) => x != null).length;
    const dts = o.nd.filter((x) => x != null);
    console.log('  ' + code + '  近月 ' + nf + ' 天'
      + (dts.length ? '  dte ' + Math.min(...dts) + '~' + Math.max(...dts) : ''));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
