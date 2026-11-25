#!/usr/bin/env node
/* 情绪清单的「概念板块」映射表。
 *
 * 为什么要有这张表：涨停/炸板/跌停三张名单在 worker 里是拿全 A 快照（新浪）
 * 按涨幅判出来的，新浪那份报价只有价格和成交，没有概念归属；东财的概念接口
 * 又只能一只一只问。盘中 124 只 × 1 次请求，免费版 Worker 的子请求上限 50，
 * 当场查必然爆。所以收盘后批量算好，落成本文件，worker 只做一次 join。
 *
 * 只收「最近 5 个交易日上过榜」的票：龙头会反复上榜，覆盖面足够；一天 300 只
 * 左右，文件 10KB 出头。当天新上榜、表里没有的，worker 会现场补查（上限 6 只）。
 *
 * 概念筛法：东财给每只票 18~25 个板块，一半是「融资融券 / 沪股通 / 浙江板块 /
 * 2026中报预增 / 昨日触板」这类非题材标签。IS_PRECISE=1 正好把这类剔干净，
 * 剩下按接口顺序取前 3，实测就是驱动涨停的那几个（002122 → 拼多多概念、
 * 人工智能、大数据）。
 *
 *   node pipeline/gen_concept_map.mjs            # 最近 5 个交易日
 *   node pipeline/gen_concept_map.mjs --days 10  # 拉长覆盖
 *   node pipeline/gen_concept_map.mjs --dry      # 只统计不写盘
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UT = '7eea3edcaed734bea9cbfc24409ed989';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DAYS = (() => {
  const i = args.indexOf('--days');
  return i >= 0 ? Math.max(1, parseInt(args[i + 1], 10) || 5) : 5;
})();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function fetchJson(url, referer, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: referer },
        signal: AbortSignal.timeout(12000),
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

/** 最近 N 个交易日。直接读 senti_hist 的日期轴，比自己排节假日靠谱。 */
function recentDays(n) {
  const p = join(DIST, 'senti_hist.json');
  if (!existsSync(p)) throw new Error('dist/senti_hist.json 不存在，先跑 gen_senti_base');
  const H = JSON.parse(readFileSync(p, 'utf8'));
  return (H.d || []).slice(-n);
}

/** 某天的三张清单，只要代码。池接口的 pagesize 给足，避免翻页。 */
async function poolCodes(day) {
  const ymd = day.replace(/-/g, '');
  const out = new Set();
  const kinds = [
    ['getTopicZTPool', 'fbt:asc'],
    ['getTopicZBPool', 'fund:desc'],
    ['getTopicDTPool', 'fund:asc'],
  ];
  for (const [path, sort] of kinds) {
    const u = 'https://push2ex.eastmoney.com/' + path
      + '?ut=' + UT + '&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=' + encodeURIComponent(sort) + '&date=' + ymd;
    try {
      const j = await fetchJson(u, 'https://quote.eastmoney.com/');
      for (const it of (j && j.data && j.data.pool) || []) {
        if (it && it.c) out.add(String(it.c));
      }
    } catch (e) {
      log('  ' + day + ' ' + path + ' 取失败：' + e.message);
    }
    await sleep(150);
  }
  return [...out];
}

/** 单只票的概念。只留 IS_PRECISE=1，按接口顺序取前 3。 */
async function conceptsOf(code) {
  const u = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_F10_CORETHEME_BOARDTYPE'
    + '&columns=SECURITY_CODE,BOARD_NAME,IS_PRECISE'
    + '&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")')
    + '&pageNumber=1&pageSize=60&source=HSF10&client=PC';
  const j = await fetchJson(u, 'https://emweb.securities.eastmoney.com/');
  const rows = (j && j.result && j.result.data) || [];
  const out = [];
  for (const x of rows) {
    if (String(x.IS_PRECISE) !== '1') continue;
    const nm = String(x.BOARD_NAME || '').trim();
    if (nm && !out.includes(nm)) out.push(nm);
    if (out.length >= 3) break;
  }
  return out;
}

(async () => {
  const days = recentDays(DAYS);
  log('覆盖 ' + days.length + ' 个交易日：' + days[0] + ' ~ ' + days[days.length - 1]);

  const codes = new Set();
  for (const d of days) {
    const c = await poolCodes(d);
    log('  ' + d + ' 上榜 ' + c.length + ' 只');
    for (const x of c) codes.add(x);
  }
  const list = [...codes].sort();
  log('去重后 ' + list.length + ' 只，开始查概念');

  /* 上一版一起读进来：这次查失败的票保留旧概念，不要让它变成空标签——
     概念一周才换一次，旧值比空值有用得多。 */
  const outPath = join(DIST, 'stk_concept.json');
  let old = {};
  if (existsSync(outPath)) {
    try { old = (JSON.parse(readFileSync(outPath, 'utf8')).m) || {}; } catch (e) { old = {}; }
  }

  const m = {};
  let ok = 0, empty = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    try {
      const cn = await conceptsOf(c);
      if (cn.length) { m[c] = cn; ok++; }
      else {
        if (old[c] && old[c].length) { m[c] = old[c]; ok++; }
        else empty++;
      }
    } catch (e) {
      fail++;
      if (old[c] && old[c].length) m[c] = old[c];
    }
    if ((i + 1) % 40 === 0) log('  ' + (i + 1) + '/' + list.length + ' 已得 ' + ok);
    await sleep(120);
  }
  log('查完：有概念 ' + ok + '，空 ' + empty + '，失败 ' + fail);

  if (DRY) { log('--dry，不写盘'); return; }

  const body = {
    v: 1,
    d: days[days.length - 1],
    n: Object.keys(m).length,
    note: '情绪清单用：代码 → 东财 IS_PRECISE 概念前 3。由 gen_concept_map.mjs 生成，勿手改。',
    m,
  };
  writeFileSync(outPath, JSON.stringify(body, null, 0));
  log('已写 ' + outPath + '（' + Object.keys(m).length + ' 只，'
    + (JSON.stringify(body).length / 1024).toFixed(1) + ' KB）');
})().catch((e) => {
  console.error('生成失败：' + (e && e.stack || e));
  process.exit(1);
});
