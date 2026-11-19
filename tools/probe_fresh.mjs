#!/usr/bin/env node
/**
 * 兜底批次要不要跑？给 CI 的 probe job 用，输出 need=true/false。
 *
 * 判定顺序（任一不成立就 need=false，让整条流水线别白跑 39 分钟）：
 *   1. 今天开市了吗 —— 问东财快照的时间戳，比查节假日表可靠
 *   2. 8 份产物是不是都到最新交易日了（含行情、期指、期权、情绪、板块、份额…）
 *
 * 第 2 步为什么不能只看 manifest：这条流水线真正缺过的从来不是 ETF 行情。
 *   11-13 缺的是 ETF 期权近月（现货日线被东财整段挡掉）；
 *   11-06 缺的是板块散点云（回算失败后静默沿用旧文件）。
 * 只要 manifest 到了就不再重跑，等于把「补漏」这件事交给运气。
 * 现在统一走 tools/check_fresh.mjs 的那张总表，缺任何一项都重跑一遍——
 * 那几个回算脚本本来就是全量重算，跑一次顺带把漏掉的历史天一起补齐。
 */
import { appendFileSync } from 'node:fs';
import { collect } from './check_fresh.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const log = (m) => console.log(m);

function bjNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
const bjDateOf = (sec) => {
  const d = new Date(sec * 1000 + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

async function get(url, json = true, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((s) => setTimeout(s, 800));
    }
  }
  throw last;
}

function done(need, why) {
  log(`need=${need}  ${why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `need=${need}\n`);
  process.exit(0);
}

const { date: TODAY, min: NOW_MIN } = bjNow();

// 1) 今天到底开市没有。东财问不到就问新浪——两个都崩了才保守跑一轮
let stampDay = null;
try {
  const j = await get('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=1&np=1'
    + '&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent('b:MK0021,b:MK0022,b:MK0023,b:MK0024')
    + '&fields=f12,f124');
  const diff = (j.data && j.data.diff) || [];
  const days = diff.map((x) => (x.f124 ? bjDateOf(x.f124) : null)).filter(Boolean).sort();
  stampDay = days[days.length - 1] || null;
} catch (e) {
  // 东财对云 IP 会整段拒连，换新浪问一只就行（返回里第 31 个字段是日期）
  try {
    const r = await fetch('https://hq.sinajs.cn/list=sh510300', {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(15000),
    });
    const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
    const m = /"(.*)"/.exec(txt);
    const f = m ? m[1].split(',') : [];
    if (f.length >= 31) stampDay = f[30];
    log(`（东财不可用，改用新浪：快照日期 ${stampDay || '未知'}）`);
  } catch (e2) {
    // 两个源都崩了就判断不了"缺不缺"，宁可跑一遍：跑一次的成本远低于丢一天
    done(true, `东财和新浪都取不到（${e.message} / ${e2.message}），保守起见跑一轮`);
  }
}

log(`北京 ${TODAY} ${String(Math.floor(NOW_MIN / 60)).padStart(2, '0')}:${String(NOW_MIN % 60).padStart(2, '0')}`
  + ` · 东财快照日期 ${stampDay || '未知'}`);

if (!stampDay) {
  done(true, '两个源都没给出日期，保守起见跑一轮');
}

/* 目标日是「快照里最新那个交易日」，不是日历上的今天。
 *
 * 原来这里写的是 `stampDay !== TODAY → 今天没开市，不跑`。在 16:35 / 21:00 看着
 * 没问题，但兜底批次被 GitHub 排队拖到凌晨才起跑时（2026-11-18 那轮 04:56 才开），
 * 「今天」是 11-19，而 19 号还没开盘，快照当然停在 11-18 —— 于是每一次凌晨兜底
 * 都被判成「非交易日」，第 2 步（产物齐不齐）根本没机会执行。11-18 缺一整天、
 * 11-18 20:56 那轮 14 秒就 success，就是这么来的。
 *
 * 真正的判断是：最近这个已收盘的交易日，产物跟上没有。周末靠这一条自然免疫
 * （快照=周五、产物已齐 → 不跑），不需要单独查节假日。 */
if (stampDay === TODAY && NOW_MIN < 15 * 60 + 10) {
  done(false, '今天还没收盘，等主批次');
}
const TARGET = stampDay;

// 2) 8 份产物都到最新了吗。基准用快照日期（已经确认它已收盘）。
//    任何一项硬指标落后就重跑：回算脚本都是全量重算，一次能把漏掉的天一起补回。
//    份额是软指标（沪市报表常 18:00 后才出、深市 T+1），它落后也重跑，
//    因为份额断一天就再也补不回来，多跑一轮的代价远小于丢一天。
let r;
try {
  r = await collect({ ref: TARGET });
} catch (e) {
  done(true, `时效体检跑不起来（${e.message}），保守起见跑一轮`);
}
if (!r.ok || r.softBad.length) {
  const bad = [...r.hardBad, ...r.softBad];
  done(true, `产物落后：${bad.map((x) => `${x.name}=${x.last || '空'}`).join(' ')}（基准 ${TARGET}）`);
}
if (r.issues.length) {
  done(true, `产物之间对不齐：${r.issues.join('；')}`);
}

done(false, `${r.rows.length} 份产物都追到 ${TARGET}，无需重跑`);
