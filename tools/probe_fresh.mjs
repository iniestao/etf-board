#!/usr/bin/env node
/**
 * 兜底批次要不要跑？给 CI 的 probe job 用，输出 need=true/false。
 *
 * 判定顺序（任一不成立就 need=false，让整条流水线别白跑 39 分钟）：
 *   1. 今天开市了吗 —— 问东财快照的时间戳，比查节假日表可靠
 *   2. data 分支的 manifest.last_trade_date 到最新交易日了吗
 *   3. data 分支的 shares/last.json 的 d 到同一天了吗（份额断一天补不回来）
 */
import { appendFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const RAW = 'https://raw.githubusercontent.com/iniestao/etf-board/data';
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
if (stampDay !== TODAY) {
  done(false, `今天没开市（快照停在 ${stampDay}），非交易日不跑`);
}
if (NOW_MIN < 15 * 60 + 10) {
  done(false, '还没收盘，等主批次');
}

// 2) 行情到最新了吗
let manLast = null;
try {
  const m = await get(RAW + '/manifest.json');
  manLast = m.last_trade_date || (m.hist && m.hist.last) || null;
} catch (e) {
  done(true, `manifest 读不到（${e.message}），保守起见跑一轮`);
}
if (!manLast || manLast < TODAY) {
  done(true, `行情停在 ${manLast || '无'}，缺 ${TODAY}`);
}

// 3) 份额到同一天了吗
let shLast = null;
try {
  const s = await get(RAW + '/shares/last.json');
  shLast = s.d || null;
} catch (e) {
  // 份额读不到不算"缺"，但要在日志里说清楚：主批次可能还没发布份额
  log(`份额 last.json 读不到（${e.message}）`);
}
if (!shLast || shLast < TODAY) {
  done(true, `行情已到 ${manLast}，但份额停在 ${shLast || '无'}`);
}

done(false, `行情 ${manLast} / 份额 ${shLast} 都是 ${TODAY}，无需重跑`);
