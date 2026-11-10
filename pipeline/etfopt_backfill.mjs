/* ETF 期权历史回补：不是「找历史合约」，而是「用还活着的合约倒推」。
 *
 * 背景（2026-11-10 逐个源验过，结论写在 gen_fut_daily.mjs 文件头）：
 * 已到期合约在上交所/深交所/东财/新浪全部即焚，secid 直接从索引里消失，
 * 扫 10010000~10012440 共 2441 个号命中的全是在市合约。所以「当时的近月合约
 * 价格」这条数据在免费源里根本不存在，补不回来。
 *
 * 但换个方向就通了：今天在市的合约里，**上市早的那几个自己就活了很久**。
 * 510050 的 12 月合约从 2026-04-23 就有日线（134 个交易日），那时它是隔季；
 * 一路走到今天变成下月。只要按天把「当天还活着、且今天仍能取到」的合约
 * 挑出来算合成基差，就能把这段历史重建出来。
 *
 * 能重建什么、不能重建什么，必须说清楚：
 *   能：当天「最短可用合约」和「最长可用合约」的基差。前者在近期就是真近月
 *       （11 月合约 10-28 起转为当月）；后者是隔季，dte 225~244 稳定。
 *   不能：历史上的当月/下月合约（已到期，全网无价格）。所以 2026-04~09 这段
 *       拿不到当时的近月，只有隔季。
 *
 * 隔季合约的基差绝对值不能和近月直接比（远月贴水天然更深），所以主线用
 * **年化**（bp×365/dte）——这个量剔除了期限效应，跨 dte 可比。
 *
 * 用法：
 *   node pipeline/etfopt_backfill.mjs            # 全量重建，写 dist/etfopt_hist.json
 *   node pipeline/etfopt_backfill.mjs --dry      # 只打印统计，不写文件
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
    const near = groups[0], far = groups[groups.length - 1];
    rows.push({
      d, S: +S.toFixed(3),
      near: { mth: near.mth, dte: near.dte, n: near.n, bp: +near.bp.toFixed(3),
              ann: near.dte >= 3 ? +(near.bp * 365 / near.dte).toFixed(2) : null },
      far: { mth: far.mth, dte: far.dte, n: far.n, bp: +far.bp.toFixed(3),
             ann: far.dte >= 3 ? +(far.bp * 365 / far.dte).toFixed(2) : null },
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
   * 必须合并，不能覆盖。理由：某一天当时能取到的合约比今天多——今天只剩还在市的那几个。
   * 11 月合约 2026-11-25 到期后从东财消失，它贡献的 28 天近月数据只有已经落盘的那份还留着。
   * 每天全量重算再整体覆盖，等于每天把历史削掉一层，越跑越少。
   *
   * 规则：老日期用老值（更全），新日期用新值，两边都有时留老值。
   * 万一老值是错的，加 --recalc 可强制用新值重算（代价是丢掉已到期合约那部分）。 */
  const old = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return null; } })();
  const recalc = process.argv.includes('--recalc');

  const newDays = [...new Set(Object.values(res).flatMap((r) => r.map((x) => x.d)))];
  const oldDays = (old && old.d) || [];
  const allD = [...new Set([...oldDays, ...newDays])].sort();
  const idx = new Map(allD.map((d, i) => [d, i]));
  const oIdx = new Map(oldDays.map((d, i) => [d, i]));

  const KEYS = ['nb', 'na', 'nd', 'nm', 'fb', 'fa', 'fd', 'fm'];
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
      put('fb', r.far.bp); put('fa', r.far.ann); put('fd', r.far.dte); put('fm', r.far.mth);
    }
    s[code] = o;
    void oIdx;
  }

  const out = {
    ok: 1,
    gen: new Date().toISOString(),
    note: (old && old.note) ||
      '用「今天仍在市」的合约日线倒推。near=当天最短可用合约（近期即真近月），far=当天最长可用合约（隔季）。历史上的当月/下月已到期，全网无价格，取不到。',
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
    const nf = o.na.filter((x) => x != null).length;
    const ff = o.fa.filter((x) => x != null).length;
    console.log('  ' + code + '  近月年化 ' + nf + ' 天   隔季年化 ' + ff + ' 天');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
