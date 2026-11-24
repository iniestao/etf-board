/**
 * 数据时效体检 —— 所有产物的「最后一天」是不是都追到了最近交易日。
 *
 * 为什么要有这一份：
 * 这条流水线有 8 份产物、4 个上游、3 个生成脚本，各自失败时都只是「这一份
 * 留在昨天」，作业照样绿、页面照样能开。11-13 那天 ETF 期权近月停在 13 号，
 * 校验脚本其实喊了 ::error::，但那是 continue-on-error 的一步——红不了，就没人
 * 看见。11-06 那次更彻底：全 A 散点云停在一周前，因为「回算」失败后
 * 「回写内联快照」看到 git diff 是空的就静默退出，连一行 warning 都没有。
 *
 * 所以时效不能在各自的脚本里各查各的：必须有一张**同一时刻、同一基准**的总表，
 * 少哪一项、差几天，一眼看全。这里的每一项都是「当天收盘后必须齐」，唯一的
 * 例外是份额（上交所报表常 18:00 后才出，深市 T+1，另有补漏任务兜着）。
 *
 * 用法：
 *   node tools/check_fresh.mjs                 # 读 data 分支（线上真身）
 *   node tools/check_fresh.mjs --dir dist      # 读本地构建产物（CI 末尾用这个最准）
 *   node tools/check_fresh.mjs --ref 2026-11-17  # 手工指定基准日，跳过中金所探测
 *   node tools/check_fresh.mjs --json           # 机器可读，给 probe 用
 *
 * 退出码：硬失败项有任何一项落后 → 1；只有软告警落后 → 0。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const RAW = 'https://raw.githubusercontent.com/iniestao/etf-board/data';

/* ---------------- 一、基准日：最近一个已归档的交易日 ----------------
 * 不按日历推——那样不知道哪天放假，长假期间会天天算出一个不存在的日子。
 * 直接问中金所：那份 XML 是收盘后生成的静态文件，「文件在」就等于「那天开市
 * 且已定稿」。判据必须是内容里有没有 <dailydata>，不能看字节数：中金所对不存在
 * 的日期不回 404，而是 302 跳到 /error_page/error_404.html，那页 2KB、HTTP 200，
 * 「len > 500」对任何一天都成立。11-11 凌晨就是被这页骗过。
 *
 * 探测失败（网络）返回 null，由调用方决定降级到哪个日期——不能瞎猜成今天。
 */
async function cffexHasXml(d) {
  const p = (n) => String(n).padStart(2, '0');
  const u = `http://www.cffex.com.cn/sj/hqsj/rtj/${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/index.xml`;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.includes(Buffer.from('<dailydata>'));
  } catch {
    return null;      // 网络问题，不是「没有」
  }
}

export async function probeTradingDay(nowUtc = new Date()) {
  // 北京时间「今天」，往后取不能往前推
  const bj = new Date(nowUtc.getTime() + 8 * 3600e3);
  const day0 = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const tried = [];

  /* 从最近的工作日往前找，但别一天一天串着问：中金所那个 XML 一次要 5~10 秒，
     串行找「今天没有 → 昨天有」就是白等一轮。先并行问最近 5 个工作日，
     取其中最新的那个；5 天都空（长假）才继续往前串。 */
  const cands = [];
  for (let i = 0; cands.length < 5 && i < 20; i++) {
    const d = new Date(day0 - i * 86400e3);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    cands.push(d);
  }
  let res = await Promise.all(cands.map((d) => cffexHasXml(d)));
  for (let i = 0; i < cands.length; i++) {
    tried.push(`${cands[i].toISOString().slice(0, 10)}=${res[i] === null ? '?' : res[i] ? '有' : '无'}`);
  }
  if (res.some((x) => x === null)) return { day: null, tried, unknown: true };
  const hit = cands.find((d, i) => res[i]);
  if (hit) return { day: hit.toISOString().slice(0, 10), tried, unknown: false };

  // 连着 5 个工作日都没归档，只可能是长假——继续往前串着问，最多再看 10 天
  let d = new Date(cands[cands.length - 1].getTime() - 86400e3);
  for (let i = 0; i < 10; i++) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) { d = new Date(d.getTime() - 86400e3); continue; }
    const got = await cffexHasXml(d);
    tried.push(`${d.toISOString().slice(0, 10)}=${got === null ? '?' : got ? '有' : '无'}`);
    if (got === null) return { day: null, tried, unknown: true };
    if (got) return { day: d.toISOString().slice(0, 10), tried, unknown: false };
    d = new Date(d.getTime() - 86400e3);
  }
  return { day: null, tried, unknown: true };
}

/* ---------------- 二、取数：data 分支 or 本地目录 ---------------- */
function makeReader(dir) {
  if (dir) {
    return async (rel) => {
      const p = join(dir, rel);
      if (!existsSync(p)) throw new Error('本地不存在: ' + rel);
      return JSON.parse(readFileSync(p, 'utf8'));
    };
  }
  return async (rel) => {
    /* raw.githubusercontent 偶发连不上（实测同一批里 8 份文件，别的都 200，
       只有 258KB 的 manifest 报 fetch failed，隔几秒再问又正常）。单次失败就
       判「这份没数据」会让体检自己误报，所以重试两次；404 不重试——那是真的没有。 */
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        // 加时间戳绕过 5 分钟边缘缓存——否则刚推上去的那一版读回来还是上一版，
        // 「明明发了却说没发」。
        const r = await fetch(`${RAW}/${rel}?t=${Date.now()}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(25000),
        });
        if (r.status === 404) throw new Error(`HTTP 404 ${rel}`);
        if (!r.ok) throw new Error(`HTTP ${r.status} ${rel}`);
        return await r.json();
      } catch (e) {
        last = e;
        if (/HTTP 404/.test(e.message) || i === 2) break;
        await new Promise((s) => setTimeout(s, 600 * (i + 1)));
      }
    }
    throw last;
  };
}

/* ---------------- 三、清单 ----------------
 * level:
 *   hard  当天必须到，落后就让 CI 红
 *   soft  允许晚一天（有专门补漏任务），只告警
 * pick  从文件里取「最后一天」的字段路径；取不到记为 null，绝不拿今天顶替
 */
const ITEMS = [
  { key: 'etf',      name: 'ETF 行情',      file: 'manifest.json',   level: 'hard', pick: (o) => o.last_trade_date },
  { key: 'fut',      name: '期指日档',      file: 'fut_daily.json',  level: 'hard', pick: (o) => o.last_trade_date || (o._last && o._last.td) },
  { key: 'etfopt',   name: 'ETF 期权近月',  file: 'etfopt_hist.json', level: 'hard', pick: (o) => (o.d || []).at(-1) },
  /* 交易所当日快照。它是「当天那一格」的第一责任人：有它，期权基差就不必看
     东财的脸色。硬要求是因为它自己就是兜底——它都缺了，那天就真没了。 */
  { key: 'etfopteo', name: '期权收盘快照',  file: 'etfopt_eod.json', level: 'hard', pick: (o) => Object.keys(o.days || {}).sort().at(-1) },
  { key: 'senti',    name: '情绪历史',      file: 'senti_hist.json', level: 'hard', pick: (o) => o.lastDay || (o.d || []).at(-1) },
  { key: 'mkt',      name: '全 A 结构',     file: 'mkt_hist.json',   level: 'hard', pick: (o) => o.last_trade_date || (o.d || []).at(-1) },
  { key: 'sec',      name: '板块日档',      file: 'sec_daily.json',  level: 'hard', pick: (o) => o.last_trade_date },
  // 份额：上交所 ETF 份额报表常在 18:00 后才发布，深市 T+1 早间才给准数。
  // 硬要求它会天天误报，而「天天红」等于没有红。
  { key: 'shares',   name: '份额日档',      file: 'shares/last.json', level: 'soft', pick: (o) => o.d },
  // 同刻基准只回溯东财涨停池 14 个交易日，缺一天不影响任何正确性，只是盘中
  // 「此刻历史」少一条参照线。
  { key: 'sentibase', name: '同刻基准',     file: 'senti_base.json', level: 'soft', pick: (o) => {
    const x = (o.days || []).at(-1);
    return x && /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : x || null;
  } },
  // 盯市提醒的日线基线。落后一天的影响很轻：250 日高低、MA20、20 日均额
  // 都是慢变量，差一天只是「昨晚的均线」，不会报出错误的信号。
  // 所以给 soft：真断了要有人知道，但不该因为它让整条发布链红掉——
  // 红掉的后果是当天的 K 线和清单也发不出去，那是更严重的事。
  { key: 'etfbase', name: '盯市基线',       file: 'etf_base.json',   level: 'soft', pick: (o) => {
    const x = o.d;
    return x && /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : x || null;
  } },
];

export async function collect({ dir = null, ref = null, nowUtc = new Date() } = {}) {
  const read = makeReader(dir);
  let refDay = ref, tried = [], unknown = false;
  if (!refDay) {
    const p = await probeTradingDay(nowUtc);
    refDay = p.day; tried = p.tried; unknown = p.unknown;
  }

  const rows = [];
  /* 10 次回源，串行最坏要等 4 分钟（每次都有 3 次重试）。并发 3 够快，也不至于
     让 raw.githubusercontent 觉得在扫站。 */
  const queue = ITEMS.slice();
  const lane = async () => {
    while (queue.length) {
      const it = queue.shift();
      let last = null, err = null, extra = null;
      try {
        const o = await read(it.file);
        last = it.pick(o) || null;
        if (it.key === 'mkt') extra = { up: (o.u || []).at(-1), down: (o.w || []).at(-1) };
        if (it.key === 'senti') {
          const i = (o.d || []).length - 1;
          extra = { n: (o.d || []).length, zt: (o.zt || [])[i], touch: (o.touch || [])[i] };
        }
        if (it.key === 'etfopt') {
          /* 只看日期轴末端会漏东西：11-19 那轮日期轴到了 19 号，9 只里却有 3 只
             是 null（东财按 IP 限流，抓到第 6 只开始全拒）。体检显示「最新 16 天」
             但那条曲线实际上只有 6 只是新的。这里把缺的只数一起报出来。 */
          const i = (o.d || []).length - 1;
          const miss = Object.entries(o.s || {})
            .filter(([, v]) => (v.nb || [])[i] == null).map(([c]) => c);
          extra = { n: (o.d || []).length, miss };
        }
      } catch (e) {
        err = e.message;
      }
      rows.push({ ...it, pick: undefined, last, err, extra });
    }
  };
  await Promise.all([lane(), lane(), lane()]);
  // 并发跑完顺序是乱的，按清单原序排回来，输出才稳定（不然日志天天换顺序）
  const rank = new Map(ITEMS.map((x, i) => [x.key, i]));
  rows.sort((a, b) => rank.get(a.key) - rank.get(b.key));

  /* 一致性：两份情绪/结构表的日期必须逐项相同，否则盘中「今天」会跟历史的
   * 另一天对齐——那种错在页面上完全看不出来，数字还挺像回事。 */
  const issues = [];
  try {
    const s = await read('senti_hist.json');
    const m = await read('mkt_hist.json');
    if (JSON.stringify(s.d) !== JSON.stringify(m.d)) {
      issues.push(`情绪历史(${(s.d || []).length}天,末${(s.d || []).at(-1)}) 与 全A结构`
        + `(${(m.d || []).length}天,末${(m.d || []).at(-1)}) 的日期轴不一致`);
    }
  } catch (e) {
    issues.push('日期轴交叉校验取不到文件：' + e.message);
  }

  const hardBad = rows.filter((r) => r.level === 'hard' && (!r.last || (refDay && r.last < refDay)));
  const softBad = rows.filter((r) => r.level === 'soft' && (!r.last || (refDay && r.last < refDay)));
  return { refDay, tried, unknown, rows, issues, hardBad, softBad, ok: hardBad.length === 0 && issues.length === 0 };
}

/* ---------------- 四、CLI ---------------- */
function fmt(rows, refDay) {
  const w = Math.max(...rows.map((r) => r.name.length)) + 2;
  const lines = [];
  for (const r of rows) {
    const gap = r.last && refDay ? Math.round((Date.parse(refDay) - Date.parse(r.last)) / 86400e3) : null;
    let st = 'OK  ';
    if (r.err) st = 'ERR ';
    else if (!r.last) st = 'NULL';
    else if (refDay && r.last < refDay) st = r.level === 'hard' ? '缺  ' : '晚  ';
    const ex = r.extra
      ? '  ' + (r.key === 'mkt' ? `涨${r.extra.up}/跌${r.extra.down}`
        : r.key === 'senti' ? `涨停${r.extra.zt}/曾触${r.extra.touch}`
          : r.key === 'etfopt' ? `${r.extra.n}天`
            + (r.extra.miss && r.extra.miss.length
              ? `，缺 ${r.extra.miss.length} 只（${r.extra.miss.join(' ')}）` : '') : '')
      : '';
    lines.push(`  ${st}${r.name.padEnd(w)}${String(r.last || '—').padEnd(12)}`
      + `${gap === null ? '' : gap > 0 ? `落后 ${gap} 天` : '最新'}${ex}`
      + `${r.err ? '  ← ' + r.err : ''}`);
  }
  return lines.join('\n');
}

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const dir = arg('--dir');
  const ref = arg('--ref');
  const asJson = argv.includes('--json');
  const r = await collect({ dir, ref });
  if (asJson) {
    console.log(JSON.stringify({
      refDay: r.refDay, unknown: r.unknown, ok: r.ok,
      rows: r.rows.map(({ key, name, level, last, err }) => ({ key, name, level, last, err })),
      issues: r.issues,
    }, null, 1));
  } else {
    console.log(`基准：最近已归档交易日 ${r.refDay || '未知'}`
      + `${dir ? `（本地 ${dir}）` : '（data 分支）'}`);
    if (r.unknown) console.log('探测：' + r.tried.join('  ') + '  ← 中金所没应答，跳过落后判断');
    console.log(fmt(r.rows, r.refDay));
    for (const s of r.issues) console.log('  !! ' + s);
    if (r.hardBad.length) {
      console.log(`\n::error::${r.hardBad.length} 项当天数据没到：`
        + r.hardBad.map((x) => `${x.name}(${x.last || '空'})`).join('、'));
    }
    if (r.softBad.length) {
      console.log(`::warning::${r.softBad.length} 项比基准晚（有补漏任务，只告警）：`
        + r.softBad.map((x) => `${x.name}(${x.last || '空'})`).join('、'));
    }
    console.log(r.ok ? '\n时效体检通过' : '\n时效体检不通过');
  }
  process.exit(r.ok ? 0 : 1);
}
