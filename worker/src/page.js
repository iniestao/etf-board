import { IDX_GROUPS } from './idx_data.js';

// 注入到 HTML 里的紧凑映射：{ "沪深300": ["510300", ...], ... }
// 18KB 一次随页面下发，比再开一个 /api 接口划算——省一次 RTT，也省 Worker 的 CPU 配额。
// 注意 build.mjs 会把这个插值替换成实际 JSON 字面量，不能只靠模板字符串。
const IDX_JS = JSON.stringify(IDX_GROUPS);

export const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETF 全市场盯盘</title>
<style>
:root{--bg:#0f1115;--bg2:#161a21;--bg3:#1d222b;--line:#262c37;--txt:#e6e9ef;
--txt2:#8b93a3;--txt3:#5a6373;--up:#ff4d4f;--down:#00c48c;--accent:#4c8dff;
--mono:"SF Mono",Consolas,"Roboto Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
font-variant-numeric:tabular-nums;padding:14px 18px 40px}
.wrap{max-width:1560px;margin:0 auto}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:16px;font-weight:600;letter-spacing:.4px}
h1 em{color:var(--txt3);font-weight:400;font-size:11.5px;font-style:normal;margin-left:8px}
.sp{flex:1}
.dot{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;
background:var(--bg3);border:1px solid var(--line);font-size:11.5px;color:var(--txt2)}
.dot i{width:7px;height:7px;border-radius:50%;background:var(--txt3)}
.dot.up i{background:var(--down);box-shadow:0 0 7px var(--down)}
.dot.down i{background:var(--up);box-shadow:0 0 7px var(--up)}
.dot.down{color:var(--up)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(142px,1fr));gap:9px;margin-bottom:12px}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 13px}
.card .k{font-size:11px;color:var(--txt2);letter-spacing:.3px;margin-bottom:4px}
.card .v{font-size:18px;font-weight:600;font-family:var(--mono)}
.card .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
.bar{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input,select,button{background:var(--bg2);color:var(--txt);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font-size:12.5px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
input#q{width:180px}
button{cursor:pointer;transition:.15s}
button:hover{background:var(--bg3)}
button.pri{background:#1a3a6b;border-color:#2b5ba8;color:#cfe0ff}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:12px;
border:1px solid var(--line);background:var(--bg2);color:var(--txt2);transition:.15s;user-select:none}
.tag:hover{color:var(--txt)}
.tag.on{background:#1a3a6b;border-color:#2b5ba8;color:#cfe0ff}
.tag b{font-weight:400;opacity:.6;font-size:10.5px;margin-left:3px}
.sec{margin-bottom:16px}
.sechd{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12.5px;color:var(--txt2)}
.sechd b{color:var(--txt);font-size:13.5px;font-weight:600}
.sechd .n{color:var(--txt3);font-size:11.5px}
.tbl{background:var(--bg2);border:1px solid var(--line);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead th{background:var(--bg3);font-size:10.5px;font-weight:500;color:var(--txt2);
letter-spacing:.3px;padding:9px;text-align:right;white-space:nowrap;
border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
thead th:hover{color:var(--txt)}
thead th.l{text-align:left}
thead th.ctr{text-align:center}
thead th.on{color:var(--accent)}
tbody td{padding:8px 9px;text-align:right;border-bottom:1px solid #1c2028;
font-family:var(--mono);font-size:12.5px;white-space:nowrap}
tbody tr:hover{background:#1a1f28}
tbody tr:last-child td{border-bottom:none}
td.l{text-align:left;font-family:inherit}
td.ctr{text-align:center}
.code{color:var(--txt3);font-size:11px}
.nm{font-weight:500}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--txt3)}
.pm{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11.5px;font-weight:600;min-width:56px}
.pm.hi{background:#3d1418;color:#ff6b6b;border:1px solid #6b2126}
.pm.mid{background:#3a2d12;color:#ffb340;border:1px solid #6b5420}
.pm.lo{background:#0f3329;color:#28d09a;border:1px solid #1a5c48}
.pm.na{background:transparent;color:var(--txt3);border:1px dashed var(--line);font-weight:400}
.act{color:var(--txt3);cursor:pointer;font-size:15px;padding:1px 6px;border-radius:4px}
.act:hover{color:var(--accent);background:#17233a}
.act.del:hover{color:var(--up);background:#2a1518}
.ixb{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;font-size:10px;
font-weight:500;color:var(--txt3);background:#232833;border:1px solid var(--line);
vertical-align:1px;cursor:default}
.ixb.mx{color:#7fa8ff;background:#182545;border-color:#2b4171}
.syn{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:9.5px;
color:#7fa8ff;background:#182545;border:1px solid #2b4171;vertical-align:1px;font-weight:500}
tr.hr{cursor:pointer}
tr.hr:hover td{background:#1b212b}
@keyframes fu{0%{background:#3a1518}100%{background:transparent}}
@keyframes fd{0%{background:#0c2b23}100%{background:transparent}}
.fu{animation:fu .7s ease-out}.fd{animation:fd .7s ease-out}
footer{margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--txt3)}
.err{color:var(--up)}
.empty{padding:20px;text-align:center;color:var(--txt3);font-size:12.5px}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#22272f;
border:1px solid var(--line);padding:8px 16px;border-radius:6px;font-size:12.5px;opacity:0;
transition:.25s;pointer-events:none;z-index:9}
#toast.show{opacity:1}
@media(max-width:820px){.hide-sm{display:none}}

/* ---------- 历史 K 线面板 ---------- */
#histMask{position:fixed;inset:0;background:rgba(6,8,12,.72);z-index:60;display:none;
align-items:center;justify-content:center;padding:18px}
#histMask.on{display:flex}
.hpanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:1060px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 24px 64px rgba(0,0,0,.55)}
.hhd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.hhd .nm{font-size:14.5px;font-weight:600}
.hhd .cd{font-family:var(--mono);font-size:12px;color:var(--txt3)}
.hhd .px{font-family:var(--mono);font-size:16px;font-weight:600;margin-left:4px}
.hhd .ch{font-family:var(--mono);font-size:12.5px}
.htabs{display:flex;gap:3px;margin-left:auto}
.htabs span{padding:3px 9px;border-radius:5px;font-size:11.5px;color:var(--txt2);
cursor:pointer;border:1px solid transparent;user-select:none}
.htabs span:hover{color:var(--txt)}
.htabs span.on{background:var(--bg3);border-color:var(--line);color:var(--txt)}
.hx{width:26px;height:26px;border-radius:6px;border:1px solid var(--line);background:transparent;
color:var(--txt2);cursor:pointer;font-size:15px;line-height:1;padding:0}
.hx:hover{color:var(--txt);background:var(--bg3)}
#histCv{display:block;width:100%;height:460px;cursor:crosshair}
.hleg{display:flex;gap:16px;padding:7px 14px 0;font-size:11.5px;color:var(--txt2);flex-wrap:wrap}
.hleg i{display:inline-block;width:8px;height:2px;vertical-align:3px;margin-right:4px}
.hnote{padding:5px 14px 12px;font-size:10.5px;color:var(--txt3);line-height:1.7}
.hnote:empty{display:none}
.hload{padding:70px 0;text-align:center;color:var(--txt2);font-size:12.5px;line-height:2}
@media(max-width:700px){
  #histCv{height:300px}
  .hhd .nm{font-size:13px}
  .htabs span{padding:2px 7px}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>ETF 全市场盯盘 <em id="clock">--:--:--</em></h1>
  <div class="sp"></div>
  <span class="dot" id="d-src"><i></i><span id="srcName">连接中</span></span>
  <span class="dot" id="d-pm"><i></i>溢价率</span>
</header>

<div class="cards">
  <div class="card"><div class="k">全市场 ETF</div><div class="v" id="cTotal">-</div><div class="s" id="cUni">-</div></div>
  <div class="card"><div class="k">涨 / 跌</div><div class="v" id="cUD">-</div><div class="s" id="cUDs">-</div></div>
  <div class="card"><div class="k">全市场成交额</div><div class="v" id="cAmt">-</div><div class="s">合计</div></div>
  <div class="card"><div class="k">最高溢价</div><div class="v" id="cPm">-</div><div class="s" id="cPmN">-</div></div>
</div>

<div class="sec">
  <div class="sechd"><b>自选盯盘</b><span class="n" id="watchN"></span></div>
  <div class="bar">
    <input id="addIn" placeholder="添加代码，支持逗号批量：510300,513180" style="width:290px">
    <button class="pri" id="btnAdd">添加</button>
    <button id="btnClear">清空</button>
    <span class="n" id="quoteTip" style="font-size:11px;color:var(--txt3)"></span>
  </div>
  <div class="tbl"><table>
    <thead><tr>
      <th class="l">代码</th><th class="l">名称</th><th>现价</th><th>涨跌%</th><th>涨跌</th>
      <th class="ctr">溢价率</th><th>IOPV</th><th>成交额</th><th>换手</th>
      <th class="hide-sm">振幅</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th>
      <th class="ctr" style="width:36px"></th>
    </tr></thead>
    <tbody id="watchBody"><tr><td colspan="13" class="empty">加载中…</td></tr></tbody>
  </table></div>
</div>

<div class="sec">
  <div class="sechd"><b>全市场榜单</b><span class="n" id="listN"></span></div>
  <div class="bar">
    <span class="tag on" data-g="all">全部<b id="n-all"></b></span>
    <span class="tag" data-g="broad">宽基<b id="n-broad"></b></span>
    <span class="tag" data-g="cross">跨境<b id="n-cross"></b></span>
    <span class="tag" data-g="industry">行业主题<b id="n-industry"></b></span>
    <span class="tag" data-g="bond">债券<b id="n-bond"></b></span>
    <span class="tag" data-g="money">货币<b id="n-money"></b></span>
    <span class="tag" data-g="commodity">商品<b id="n-commodity"></b></span>
    <span class="tag on" id="dedupTag" title="同一跟踪指数的多只 ETF 只保留成交额最大的一只。点击切换">同指数去重<b id="n-dedup"></b></span>
    <input id="q" placeholder="搜索代码/名称">
    <select id="sortSel">
      <option value="amt">按成交额</option>
      <option value="chg">按涨幅</option>
      <option value="chgA">按跌幅</option>
      <option value="tr">按换手率</option>
      <option value="pm">按溢价率</option>
    </select>
    <select id="limitSel">
      <option value="50">前 50</option>
      <option value="100" selected>前 100</option>
      <option value="200">前 200</option>
      <option value="500">前 500</option>
      <option value="9999">全部</option>
    </select>
    <button id="btnProbe">源自检</button>
  </div>
  <div class="tbl"><table>
    <thead><tr>
      <th class="l">代码</th><th class="l">名称</th><th>现价</th><th>涨跌%</th>
      <th class="ctr">溢价率</th><th>成交额</th><th>换手</th>
      <th class="hide-sm">振幅</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th>
      <th class="ctr" style="width:36px"></th>
    </tr></thead>
    <tbody id="listBody"><tr><td colspan="11" class="empty">加载中…</td></tr></tbody>
  </table></div>
</div>

<footer>
  <span id="fTs">-</span><span id="fSrc">-</span><span id="fErr" class="err"></span>
</footer>
</div>
<div id="toast"></div>

<div id="histMask">
  <div class="hpanel">
    <div class="hhd">
      <span class="nm" id="hName">-</span>
      <span class="cd" id="hCode"></span>
      <span class="px" id="hPx">-</span>
      <span class="ch" id="hChg"></span>
      <div class="htabs" id="hTabs">
        <span data-r="63">3M</span>
        <span data-r="126">6M</span>
        <span data-r="250" class="on">1Y</span>
        <span data-r="0">全部</span>
      </div>
      <button class="hx" id="hClose" title="关闭 (Esc)">×</button>
    </div>
    <canvas id="histCv"></canvas>
    <div class="hleg" id="hLeg"></div>
    <div class="hnote" id="hNote"></div>
  </div>
</div>

<script>
'use strict';
var IDX_GROUPS = ${IDX_JS};
var DEFAULT_WATCH = ['510300','159915','588000','513180','513120','513050','518880'];
var LS = 'etf_watch_v3';
var watch = loadWatch();

var DATA = [];                 // 全市场归一化数据
var STATS = null;
var LIVE = {};                 // 自选高频覆盖 {code: item}
var g = 'all', sortKey = 'amt', limit = 100, kw = '';
var DATA_SRC = '', DATA_TS = 0;
var lastP = {}, timerSlow = null, timerFast = null;

/* ---------- 分类（浏览器端，带缓存；Worker 端做会吃掉 10ms CPU 预算） ---------- */
var GROUP_CACHE = new Map();
var RULES = [
  ['cross', ['恒生','港股','中概','纳指','标普','日经','德国','法国','东南亚','亚太','海外',
             '全球','美国','QDII','越南','沙特','印度','日本','韩国','中韩']],
  ['commodity', ['黄金','白银','豆粕','有色','能源化工','商品','原油','饲料','铜']],
  ['bond', ['债','政金','信用','国开','短融','融资','城投']],
  ['money', ['货币','现金','保证金','日利','添益','快线','快钱','理财','财富宝','金管家']]
];
var BROAD = ['沪深300','中证300','中证500','中证1000','中证2000','中证100',
             '上证50','科创50','创业板','科创','上证','深证','中证','A50','A500','A100',
             '红利','价值','成长','超大盘','180','大盘','中小板','双创'];
function calcGroup(n){
  for (var i=0;i<RULES.length;i++){
    var ws = RULES[i][1];
    for (var j=0;j<ws.length;j++) if (n.indexOf(ws[j]) >= 0) return RULES[i][0];
  }
  for (var k=0;k<BROAD.length;k++) if (n.indexOf(BROAD[k]) >= 0) return 'broad';
  return 'industry';
}
function group(n){
  var v = GROUP_CACHE.get(n);
  if (v) return v;
  v = calcGroup(n);
  GROUP_CACHE.set(n, v);
  return v;
}

/* ---------- 工具 ---------- */
function loadWatch(){
  try{ var s = localStorage.getItem(LS); if(s){ var a = JSON.parse(s); if(a && a.length) return a; } }catch(e){}
  return DEFAULT_WATCH.slice();
}

/* ---------- 自选同步（Workers KV） ----------
   本地先写，云端异步推，800ms 防抖——用户连点几下删除不会打出 5 个请求。
   云端未配置（Deno 无 KV、或 wrangler.toml 没绑）时静默降级为纯本地。 */
var WATCH_CLOUD = false;
var pushTimer = null;

function saveWatch(){
  try{ localStorage.setItem(LS, JSON.stringify(watch)); }catch(e){}
  pushWatch();
}

function pushWatch(){
  if (!WATCH_CLOUD) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function(){
    fetch('/api/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: watch })
    }).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok){ WATCH_CLOUD = false; refreshWatchUI(); }
    }).catch(function(){ WATCH_CLOUD = false; refreshWatchUI(); });
  }, 800);
}

/* 行情还没到就重绘自选表，会整表闪一下「未取到」——等 loadFull 之后再说 */
function refreshWatchUI(){
  if (DATA.length || Object.keys(LIVE).length) renderWatch();
}

function pullWatch(){
  if (!window.fetch) return Promise.resolve();
  return fetch('/api/watch').then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok){ WATCH_CLOUD = false; refreshWatchUI(); return; }
    WATCH_CLOUD = true;

    if (!j.exists){
      // 云端从没写过：把本地列表作为初始值推上去
      if (watch.length) pushWatch();
      refreshWatchUI();
      return;
    }
    // 云端写过：完全以云端为准。不做并集——并集会让别处删掉的标的重生。
    var cloud = j.list || [];
    if (cloud.join() !== watch.join()){
      watch = cloud;
      try{ localStorage.setItem(LS, JSON.stringify(watch)); }catch(e){}
      LIVE = {};
      refreshWatchUI();
      loadTXQuotes();
    } else {
      refreshWatchUI();
    }
  }).catch(function(){ WATCH_CLOUD = false; refreshWatchUI(); });
}
function toast(m){ var e=document.getElementById('toast'); e.textContent=m; e.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(function(){ e.classList.remove('show'); },2000); }
function fp(v){ return (v==null||!isFinite(v))?'-':Number(v).toFixed(3); }
function fpc(v){ if(v==null||!isFinite(v)) return '-'; return (v>0?'+':'')+Number(v).toFixed(2)+'%'; }
function famt(v){ if(!v||!isFinite(v)) return '-'; if(v>=1e8) return (v/1e8).toFixed(2)+' 亿';
  if(v>=1e4) return (v/1e4).toFixed(0)+' 万'; return String(Math.round(v)); }
function cc(v){ return v>0?'up':(v<0?'down':'flat'); }
function pbadge(p){
  if(p==null||!isFinite(p)) return '<span class="pm na">-</span>';
  var a=Math.abs(p), c='lo';
  if(a>=2) c='hi'; else if(a>=1) c='mid';
  return '<span class="pm '+c+'">'+(p>0?'+':'')+p.toFixed(2)+'%</span>';
}
function isOpen(){
  var d=new Date(), w=d.getDay();
  if(w===0||w===6) return false;
  var m=d.getHours()*60+d.getMinutes();
  return (m>=555&&m<=690)||(m>=780&&m<=905)||(m>=570&&m<=720)||(m>=780&&m<=970);
}

/* ---------- 同指数去重 ----------
   背景：538 只 ETF 里，沪深300 有 29 只、中证A500 有 40 只、科创50 有 20 只。
   盯盘时看这 40 只 A500 没有意义——它们跟踪同一个指数，日内涨跌幅几乎一样，
   区别只在跟踪误差、费率和盘口厚度。按成交额留一只就够，剩下的不提供新信息。

   映射来源：天天基金基金档案"跟踪标的"，逐只抓取 + 归一化。
   只有 2 只以上的指数才参与去重（单只的没有重复可言）。 */
var IX_OF = {};                // code -> 指数名
var IX_N  = {};                // 指数名 -> 该指数下 ETF 只数
(function(){
  for (var k in IDX_GROUPS){
    var arr = IDX_GROUPS[k];
    IX_N[k] = arr.length;
    for (var i=0;i<arr.length;i++) IX_OF[arr[i]] = k;
  }
})();

var DEDUP = true;              // 默认开
var KEEP = {};                 // 指数名 -> 当前保留的 code
var IXF = null;                // 当前展开的指数（点 ×N 标签进入，看该指数全部成员）

function markKeep(items){
  // 选代表的顺序：
  //   1. 先只在"今天有成交"的里面挑，停牌/涨跌停封死的不该代表这个指数
  //   2. 有成交的按成交额挑；全组都没成交（盘前）才退到流通市值
  //   3. 带 15% 滞后：两只成交额差 2% 时不该每 60 秒换一次，看着像在闪
  var buckets = {}, i, x;
  for (i=0;i<items.length;i++){
    x = items[i];
    if (!x.ix) continue;
    (buckets[x.ix] || (buckets[x.ix] = [])).push(x);
  }
  var score = function(o){ return o.amt > 0 ? o.amt : (o.mc || 0); };

  for (var k in buckets){
    var list = buckets[k];
    var live = [];
    for (i=0;i<list.length;i++) if (list[i].amt > 0) live.push(list[i]);
    var pool = live.length ? live : list;

    var best = pool[0];
    for (i=1;i<pool.length;i++) if (score(pool[i]) > score(best)) best = pool[i];

    // 现任还在、也没停牌，且差距在 15% 以内 → 不换
    var cur = null;
    for (i=0;i<list.length;i++) if (list[i].c === KEEP[k]) cur = list[i];
    if (cur && cur.amt > 0 && score(cur) >= score(best) * 0.85) best = cur;

    KEEP[k] = best.c;
  }
}

function dedupCount(){
  // 参与去重、且不是代表标的的只数
  var n = 0;
  for (var i=0;i<DATA.length;i++){
    var x = DATA[i];
    if (x.ix && KEEP[x.ix] && KEEP[x.ix] !== x.c) n++;
  }
  return DATA.length - n;
}

/* ---------- 归一化：把两种源格式统一 ---------- */
/* 盘前（9:15 前）和停牌时，上游的当前价字段是 0.000，昨收字段还有值。
   早期版本直接判 p 为假就 continue，结果 9:30 之前打开页面只有 5 只——剩下 1712 只全被丢掉。
   现在用昨收兜底：价格显示昨收、涨跌 0，至少全市场结构看得见。 */
function normalize(src, raw){
  var out = [], i, x, p, pc, iopv;
  if (src === 'sina'){
    for (i=0;i<raw.length;i++){
      x = raw[i];
      if (!x.code) continue;
      pc = +x.settlement || 0;
      p = +x.trade || pc;
      if (!p) continue;
      out.push({ c:x.code, n:x.name, p:p, pc:pc, chg:+x.changepercent,
        amt:+x.amount, tr:+x.turnoverratio, hi:+x.high, lo:+x.low, op:+x.open,
        pre: !(+x.trade), mc: (+x.nmc || 0) * 1e4,
        iopv:null, pm:null, g:group(x.name), ix: IX_OF[x.code] || null });
    }
  } else {
    for (i=0;i<raw.length;i++){
      x = raw[i];
      if (!x.f12) continue;
      pc = +x.f18 || 0;
      p = +x.f2 || pc;
      if (!p) continue;
      iopv = +x.f441 || 0;
      out.push({ c:x.f12, n:x.f14, p:p, pc:pc, chg:+x.f3, amt:+x.f6, tr:+x.f8,
        hi:+x.f15, lo:+x.f16, op:+x.f17,
        pre: !(+x.f2), mc: 0,
        iopv: iopv>0?iopv:null,
        pm: iopv>0 ? +(((p-iopv)/iopv)*100).toFixed(2) : null,
        g:group(x.f14), ix: IX_OF[x.f12] || null });
    }
  }
  return out;
}

function computeStats(items){
  var up=0,down=0,flat=0,amt=0;
  for (var i=0;i<items.length;i++){
    var x=items[i];
    if (x.chg>0) up++; else if (x.chg<0) down++; else flat++;
    amt += x.amt;
  }
  return { up:up, down:down, flat:flat, amt:amt, count:items.length };
}

function groupCounts(){
  var c = {all:DATA.length, broad:0, cross:0, industry:0, bond:0, money:0, commodity:0};
  for (var i=0;i<DATA.length;i++){ var k=DATA[i].g; if(c[k]!=null) c[k]++; }
  return c;
}

/* ---------- 渲染 ---------- */
function ixBadge(x){
  if (!x.ix || !(IX_N[x.ix] > 1)) return '';
  var n = IX_N[x.ix], mx = KEEP[x.ix] === x.c;
  return '<span class="ixb'+(mx?' mx':'')+'" data-ix="'+x.ix+'" title="跟踪 '+x.ix+' · 同指数 '+n+' 只'
    + (mx ? '，本只成交额最大' : '，本只成交额不是最大')
    + '。点击查看该指数全部 '+n+' 只' + '">×'+n+'</span>';
}

function rowHtml(x, withDel){
  var lp = lastP[x.c], fl = '';
  if (lp!=null && x.p!==lp) fl = x.p>lp?'fu':'fd';
  lastP[x.c] = x.p;
  var amp = (x.hi>0 && x.lo>0 && x.pc>0) ? ((x.hi-x.lo)/x.pc*100) : null;
  var act = withDel
    ? '<span class="act del" data-del="'+x.c+'" title="移除">×</span>'
    : '<span class="act" data-add="'+x.c+'" title="加自选">+</span>';
  return '<td class="l code">'+x.c+'</td>'
    + '<td class="l nm">'+x.n+ixBadge(x)+'</td>'
    + '<td class="'+cc(x.chg)+' '+fl+'">'+fp(x.p)+'</td>'
    + '<td class="'+cc(x.chg)+'">'+fpc(x.chg)+'</td>'
    + (withDel ? '<td class="'+cc(x.chg)+'">'+(x.pc?(x.p-x.pc>0?'+':'')+(x.p-x.pc).toFixed(3):'-')+'</td>' : '')
    + '<td class="ctr">'+pbadge(x.pm)+'</td>'
    + (withDel ? '<td style="color:var(--txt2)">'+(x.iopv?x.iopv.toFixed(4):'-')+'</td>' : '')
    + '<td>'+famt(x.amt)+'</td>'
    + '<td style="color:var(--txt2)">'+(x.tr?x.tr.toFixed(2)+'%':'-')+'</td>'
    + '<td class="hide-sm" style="color:var(--txt2)">'+(amp?amp.toFixed(2)+'%':'-')+'</td>'
    + '<td class="hide-sm">'+(x.hi?fp(x.hi):'-')+'</td>'
    + '<td class="hide-sm">'+(x.lo?fp(x.lo):'-')+'</td>'
    + '<td class="ctr">'+act+'</td>';
}

function renderCards(){
  var gc = groupCounts();
  var dc = dedupCount();
  document.getElementById('cTotal').textContent = DATA.length || '-';
  document.getElementById('cUni').textContent = (DATA.length && DEDUP && dc < DATA.length)
    ? ('去重后 ' + dc + ' 只 · 合并 ' + Object.keys(IX_N).length + ' 组重复')
    : (DATA.length ? ('宽基'+gc.broad+' 跨境'+gc.cross+' 行业'+gc.industry) : '-');
  var nd = document.getElementById('n-dedup');
  if (nd) nd.textContent = (DATA.length && DEDUP) ? (' ' + dc) : '';
  if (STATS){
    document.getElementById('cUD').innerHTML =
      '<span class="up">'+STATS.up+'</span> / <span class="down">'+STATS.down+'</span>';
    document.getElementById('cUDs').textContent = '平 ' + STATS.flat;
    document.getElementById('cAmt').textContent = famt(STATS.amt);
  }
  var mp=null, mn='-';
  for (var i=0;i<DATA.length;i++){
    var x=DATA[i];
    if (x.pm!=null && (mp===null || x.pm>mp)){ mp=x.pm; mn=x.n; }
  }
  document.getElementById('cPm').innerHTML = mp==null ? '-' :
    '<span class="'+(mp>=2?'up':'')+'">'+(mp>0?'+':'')+mp.toFixed(2)+'%</span>';
  document.getElementById('cPmN').textContent = mn;
  // 分类标签上的数量
  ['all','broad','cross','industry','bond','money','commodity'].forEach(function(k){
    var el = document.getElementById('n-'+k);
    if (el) el.textContent = gc[k] || '';
  });
}

function renderWatch(){
  var body = document.getElementById('watchBody');
  if (!watch.length){
    body.innerHTML = '<tr><td colspan="13" class="empty">还没有自选，点下方榜单的 + 添加</td></tr>';
    document.getElementById('watchN').innerHTML = WATCH_CLOUD
      ? '<span class="syn">云端</span>' : '';
    return;
  }
  var map = new Map();
  for (var i=0;i<DATA.length;i++) map.set(DATA[i].c, DATA[i]);
  var html = '', miss = 0;
  for (var k=0;k<watch.length;k++){
    var c = watch[k];
    var x = LIVE[c] || map.get(c);      // 东财高频数据优先
    if (!x){
      miss++;
      html += '<tr class="hr" data-c="'+c+'"><td class="l code">'+c+'</td>'
        + '<td class="l" colspan="11" style="color:var(--txt3)">未取到（可能已退市或非场内 ETF）</td>'
        + '<td class="ctr"><span class="act del" data-del="'+c+'">×</span></td></tr>';
      continue;
    }
    html += '<tr class="hr" data-c="' + x.c + '">' + rowHtml(x, true) + '</tr>';
  }
  body.innerHTML = html;
  document.getElementById('watchN').innerHTML = watch.length + ' 只'
    + (miss ? ('，' + miss + ' 只未取到') : '')
    + (WATCH_CLOUD ? '<span class="syn" title="已与云端同步，换设备也是这份列表">云端</span>' : '');
}

function renderList(){
  var arr = DATA;
  if (IXF){
    // 展开单个指数：显示该指数全部成员，按成交额排序，标出哪只是代表
    arr = arr.filter(function(x){ return x.ix === IXF; });
    arr = arr.slice().sort(function(a,b){ return (b.amt||0) - (a.amt||0); });
    var body0 = document.getElementById('listBody');
    body0.innerHTML = arr.length
      ? arr.map(function(x){ return '<tr class="hr" data-c="'+x.c+'">'+rowHtml(x, false)+'</tr>'; }).join('')
      : '<tr><td colspan="11" class="empty">该指数暂无行情</td></tr>';
    document.getElementById('listN').textContent =
      '跟踪「' + IXF + '」的 ' + arr.length + ' 只 · 按成交额排序 · 再点一次标签返回全部';
    return;
  }
  if (g !== 'all') arr = arr.filter(function(x){ return x.g === g; });
  if (kw){
    var k2 = kw.toLowerCase();
    arr = arr.filter(function(x){
      return x.c.indexOf(k2) >= 0 || x.n.toLowerCase().indexOf(k2) >= 0;
    });
  }
  var beforeDedup = arr.length;
  // 搜索时不去重：用户搜"300"就是想看所有 300ETF，藏掉 28 只反而碍事
  if (DEDUP && !kw){
    arr = arr.filter(function(x){
      return !x.ix || !KEEP[x.ix] || KEEP[x.ix] === x.c;
    });
  }
  var key = sortKey === 'chgA' ? 'chg' : sortKey;
  var dir = sortKey === 'chgA' ? 1 : -1;
  arr = arr.slice().sort(function(a,b){
    var va = a[key]==null ? -Infinity : a[key];
    var vb = b[key]==null ? -Infinity : b[key];
    return (va - vb) * dir;
  });
  var matched = arr.length;
  arr = arr.slice(0, limit);

  var body = document.getElementById('listBody');
  if (!arr.length){
    body.innerHTML = '<tr><td colspan="11" class="empty">没有匹配结果</td></tr>';
  } else {
    var buf = [];
    for (var i=0;i<arr.length;i++)
      buf.push('<tr class="hr" data-c="'+arr[i].c+'">'+rowHtml(arr[i], false)+'</tr>');
    body.innerHTML = buf.join('');
  }
  var note = '';
  if (DEDUP && !kw && beforeDedup > matched) note = '（同指数去重前 ' + beforeDedup + ' 只）';
  else if (kw && DEDUP) note = '（搜索时显示全部，未去重）';
  document.getElementById('listN').textContent =
    '显示 ' + arr.length + ' / 可用 ' + matched + ' 只' + note;
}

/* ================= 历史 K 线面板 =================
   数据来自 R2 上的精简二进制（近 500 天 × 17 字段），Worker 只做透传。
   为什么不在 Worker 里解 Parquet：单只 2.27MB / 165 列，光 zstd 解压
   就要几百毫秒，免费版只有 10ms CPU。所以解析全部放在这里。

   画图用原生 canvas，不引图表库——一个 K 线面板带 3 个子图，
   引库要多 100KB+，还得跟着库的版本走。 */

var HC = {
  up:'#ff4d4f', dn:'#00c48c', ma20:'#e8a33d', ma60:'#4c8dff',
  grid:'#202632', axis:'#5a6373', cross:'#7a8699', vol:'#2c3444', rsi:'#b07cff'
};

var H = {
  code:'', name:'', d:null, range:250, hover:-1, ok:false,
  cv:null, ctx:null, off:null, octx:null,
  W:0, Ht:0, dpr:1, geo:null
};

/* TypedArray 要求 byteOffset 是元素大小的整数倍，而 JSON header 长度不固定。
   新版本写入时补过 4 字节对齐，旧文件没有——这里两条路都走。
   未对齐时 slice 一段出来：slice 返回的 ArrayBuffer 从 0 起，偏移归零。 */
function hView(buf, base, n, Type){
  if (base % 4 === 0) return new Type(buf, base, n);
  return new Type(buf.slice(base, base + n * 4), 0, n);
}

function parseHist(buf){
  var v = new DataView(buf);
  if (v.getUint32(0, false) !== 0x45544831) throw new Error('不是 ETH1 格式');
  var hl = v.getUint32(4, true);
  var hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  var n = hdr.n, cols = hdr.cols, base = 8 + hl;
  var dates = hView(buf, base, n, Int32Array);
  base += 4 * n;
  var col = {};
  for (var i = 0; i < cols.length; i++){
    col[cols[i]] = hView(buf, base, n, Float32Array);
    base += 4 * n;
  }
  return { code:hdr.code, n:n, dates:dates, col:col };
}

function fnum(v, d){
  if (v == null || !isFinite(v)) return '-';
  return Number(v).toFixed(d == null ? 3 : d);
}

function openHist(code, name){
  H.code = code; H.name = name || code; H.d = null; H.hover = -1; H.ok = false;
  document.getElementById('hName').textContent = H.name;
  document.getElementById('hCode').textContent = code;
  document.getElementById('hPx').textContent = '-';
  document.getElementById('hChg').textContent = '';
  document.getElementById('hLeg').innerHTML = '<span>加载中…</span>';
  document.getElementById('hNote').textContent = '';
  document.getElementById('histMask').classList.add('on');

  var x = findItem(code);
  if (x){
    document.getElementById('hPx').textContent = fnum(x.p, 3);
    var ch = document.getElementById('hChg');
    ch.textContent = fpc(x.chg);
    ch.className = 'ch ' + cc(x.chg);
  }
  hSize();

  fetch('/api/hist?code=' + code).then(function(r){
    var ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('json') >= 0) return r.json().then(function(j){ throw new Error(j.error || '读取失败'); });
    return r.arrayBuffer();
  }).then(function(buf){
    if (H.code !== code) return;          // 加载期间用户已经换了标的
    H.d = parseHist(buf);
    H.ok = true;
    hDraw();
    hLegend(-1);
    document.getElementById('hNote').textContent = hAdjNote();
  }).catch(function(e){
    if (H.code !== code) return;
    var msg = e.message || String(e);
    var hint = /NO_HIST|未配置/.test(msg)
      ? '历史数据未启用：Worker 没有绑定 R2，也没有设置 <code>HIST_BASE</code>。'
      : /NOT_FOUND|无此标的/.test(msg)
        ? '历史数据还没生成。去 GitHub Actions 手动跑一次「更新 ETF 数据」，'
          + '跑完会自动推到 <code>data</code> 分支。'
        : msg;
    document.getElementById('hLeg').innerHTML = '';
    document.getElementById('hNote').innerHTML = hint;
    var g = H.cv.getContext('2d');
    g.setTransform(1,0,0,1,0,0);
    g.clearRect(0, 0, H.cv.width, H.cv.height);
  });
}

function closeHist(){
  document.getElementById('histMask').classList.remove('on');
  H.code = ''; H.d = null;
}

function findItem(code){
  for (var i = 0; i < DATA.length; i++) if (DATA[i].c === code) return DATA[i];
  return LIVE[code] || null;
}

function hSize(){
  var cv = document.getElementById('histCv');
  if (!cv) return;
  var dpr = window.devicePixelRatio || 1;
  var W = cv.clientWidth || 900, Ht = cv.clientHeight || 460;
  H.cv = cv; H.dpr = dpr; H.W = W; H.Ht = Ht;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(Ht * dpr)){
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(Ht * dpr);
  }
  H.ctx = cv.getContext('2d');
  H.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!H.off){ H.off = document.createElement('canvas'); }
  if (H.off.width !== cv.width || H.off.height !== cv.height){
    H.off.width = cv.width; H.off.height = cv.height;
  }
  H.octx = H.off.getContext('2d');
  H.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function hDraw(){
  var d = H.d;
  if (!d || !H.W) return;
  hSize();

  var W = H.W, Ht = H.Ht, ctx = H.octx;
  var n = d.n, rng = H.range || n;
  var i0 = Math.max(0, n - rng), cnt = n - i0;

  ctx.clearRect(0, 0, W, Ht);
  if (cnt < 2){
    H.ctx.clearRect(0, 0, W, Ht);
    document.getElementById('hNote').textContent = '历史数据不足 2 个交易日，无法绘图';
    return;
  }

  var padL = 2, padR = 56, padT = 8, padB = 15;
  var plotW = W - padL - padR;
  var bodyH = Ht - padT - padB;
  var hP = Math.round(bodyH * 0.60);
  var hV = Math.round(bodyH * 0.17);
  var hR = bodyH - hP - hV - 12;
  var yP = padT, yV = padT + hP + 6, yR = yV + hV + 6;

  var c = d.col;
  var o = c.open, hi = c.high, lo = c.low, cl = c.close, vol = c.volume;
  var m20 = c.ma20, m60 = c.ma60, rsi = c.rsi14;

  var pmin = Infinity, pmax = -Infinity, vmax = 0, i, vv;
  for (i = i0; i < n; i++){
    if (isFinite(lo[i]) && lo[i] < pmin) pmin = lo[i];
    if (isFinite(hi[i]) && hi[i] > pmax) pmax = hi[i];
    if (isFinite(m20[i])){ if (m20[i] < pmin) pmin = m20[i]; if (m20[i] > pmax) pmax = m20[i]; }
    if (isFinite(m60[i])){ if (m60[i] < pmin) pmin = m60[i]; if (m60[i] > pmax) pmax = m60[i]; }
    if (isFinite(vol[i]) && vol[i] > vmax) vmax = vol[i];
  }
  if (!isFinite(pmin) || !isFinite(pmax) || pmax <= pmin){ pmin = 0; pmax = 1; }
  var pad = (pmax - pmin) * 0.04;
  pmin -= pad; pmax += pad;
  if (vmax <= 0) vmax = 1;

  var bw = plotW / cnt;
  var ew = Math.max(1, Math.min(bw * 0.68, 12));
  function xOf(i){ return padL + (i - i0 + 0.5) * bw; }
  function yPx(p){ return yP + hP * (pmax - p) / (pmax - pmin); }
  function yVx(v){ return yV + hV * (1 - v / vmax); }
  function yRx(v){ return yR + hR * (1 - Math.max(0, Math.min(100, v)) / 100); }

  /* --- 网格与价格刻度 --- */
  ctx.strokeStyle = HC.grid; ctx.lineWidth = 1;
  ctx.font = '10px ' + 'ui-monospace,Menlo,monospace';
  ctx.textBaseline = 'middle';
  for (var k = 0; k <= 4; k++){
    var pv = pmin + (pmax - pmin) * k / 4;
    var yy = Math.round(yPx(pv)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = HC.axis;
    ctx.textAlign = 'left';
    ctx.fillText(pv.toFixed(pv < 10 ? 3 : 2), padL + plotW + 5, yy);
  }

  /* --- 成交量 --- */
  for (i = i0; i < n; i++){
    if (!isFinite(vol[i]) || vol[i] <= 0) continue;
    var cUp = cl[i] >= o[i];
    ctx.fillStyle = cUp ? 'rgba(255,77,79,.55)' : 'rgba(0,196,140,.55)';
    var x0 = xOf(i) - ew / 2, hgt = yV + hV - yVx(vol[i]);
    ctx.fillRect(x0, yVx(vol[i]), ew, Math.max(1, hgt));
  }
  ctx.fillStyle = HC.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(famt(vmax), padL + plotW + 5, yV + hV - 3);

  /* --- K 线 --- */
  for (i = i0; i < n; i++){
    if (!isFinite(o[i]) || !isFinite(cl[i])) continue;
    var up = cl[i] >= o[i];
    var col = up ? HC.up : HC.dn;
    var xc = xOf(i);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(xc) + 0.5, yPx(hi[i]));
    ctx.lineTo(Math.round(xc) + 0.5, yPx(lo[i]));
    ctx.stroke();
    var y1 = yPx(Math.max(o[i], cl[i])), y2 = yPx(Math.min(o[i], cl[i]));
    var bh = Math.max(1, y2 - y1);
    ctx.fillRect(xc - ew / 2, y1, ew, bh);
  }

  /* --- 均线 / RSI 折线 ---
     必须传入各自的纵轴映射：早期版本把 RSI 也用 yPx 画，结果
     28~65 的数值被映射到价格刻度之外，整条线飞到画布上方看不见。 */
  function line(arr, color, yFn, lw){
    ctx.strokeStyle = color; ctx.lineWidth = lw || 1.3; ctx.beginPath();
    var started = false;
    for (var j = i0; j < n; j++){
      if (!isFinite(arr[j])){ started = false; continue; }
      var X = xOf(j), Y = yFn(arr[j]);
      if (!started){ ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    }
    ctx.stroke();
  }
  line(m60, HC.ma60, yPx);
  line(m20, HC.ma20, yPx);

  /* --- RSI 副图 --- */
  ctx.strokeStyle = '#39435460'; ctx.lineWidth = 1; ctx.setLineDash([3,4]);
  [30, 70].forEach(function(lv){
    var yy = Math.round(yRx(lv)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = '#4a5464'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '9px ui-monospace,Menlo,monospace';
    ctx.fillText(String(lv), padL + plotW + 5, yy);
  });
  ctx.setLineDash([]);
  line(rsi, HC.rsi, yRx, 1.2);
  ctx.fillStyle = HC.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('RSI', padL + plotW + 5, yR + 1);

  /* --- 时间轴 --- */
  ctx.fillStyle = HC.axis; ctx.textBaseline = 'top';
  // 窄屏放 5 个日期会叠在一起，按绘图宽度降级
  var ticks = Math.min(plotW < 300 ? 3 : (plotW < 520 ? 4 : 5), cnt);
  for (var t = 0; t < ticks; t++){
    var idx = i0 + Math.round((cnt - 1) * t / Math.max(1, ticks - 1));
    var ds = String(d.dates[idx]);
    var label = ds.slice(0, 4) + '-' + ds.slice(4, 6);
    ctx.textAlign = t === 0 ? 'left' : (t === ticks - 1 ? 'right' : 'center');
    var tx = Math.max(padL, Math.min(padL + plotW, xOf(idx)));
    ctx.fillText(label, tx, Ht - padB + 2);
  }

  H.geo = { i0:i0, cnt:cnt, padL:padL, plotW:plotW, bw:bw, yP:yP, hP:hP,
            yV:yV, hV:hV, yR:yR, hR:hR, pmin:pmin, pmax:pmax };

  H.ctx.setTransform(1,0,0,1,0,0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, W, Ht);
  if (H.hover >= 0) hCross(H.hover);
}

function hCross(idx){
  var d = H.d, g = H.geo, ctx = H.ctx;
  if (!d || !g) return;
  var i0 = g.i0, i1 = g.i0 + g.cnt;
  if (idx < i0 || idx >= i1) return;

  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  ctx.drawImage(H.off, 0, 0, H.W, H.Ht);

  var x = g.padL + (idx - i0 + 0.5) * g.bw;
  var c = d.col;
  var yTop = g.yP, yBot = g.yR + g.hR;
  ctx.strokeStyle = HC.cross; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, yTop); ctx.lineTo(Math.round(x) + 0.5, yBot);
  ctx.stroke();
  ctx.setLineDash([]);

  // 收盘价横线
  if (isFinite(c.close[idx])){
    var yy = Math.round(g.yP + g.hP * (g.pmax - c.close[idx]) / (g.pmax - g.pmin)) + 0.5;
    ctx.beginPath(); ctx.moveTo(g.padL, yy); ctx.lineTo(g.padL + g.plotW, yy); ctx.stroke();
    ctx.fillStyle = '#1b2330';
    var lab = fnum(c.close[idx], 3);
    ctx.fillRect(g.padL + g.plotW + 2, yy - 7, 50, 14);
    ctx.fillStyle = '#cfd6e2'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '10px ui-monospace,Menlo,monospace';
    ctx.fillText(lab, g.padL + g.plotW + 6, yy);
  }
  hLegend(idx);
}

function hLegend(idx){
  var d = H.d; if (!d) return;
  var leg = document.getElementById('hLeg');
  var c = d.col, n = d.n;

  if (idx < 0){
    // 区间概览
    var rng = H.range || n, i0 = Math.max(0, n - rng);
    var first = c.close[i0], last = c.close[n - 1];
    var hi = -Infinity, lo = Infinity;
    for (var i = i0; i < n; i++){
      if (c.high[i] > hi) hi = c.high[i];
      if (c.low[i] < lo) lo = c.low[i];
    }
    var ret = (isFinite(first) && first > 0) ? (last / first - 1) * 100 : NaN;
    /* 有分红/折算时，原始价的「累计涨跌」会把折算算成暴跌——159922 曾因此
       显示 -56%，实际复权后是正收益。所以这里同时给复权口径。 */
    var ar = c.adj_ratio, r0 = ar ? ar[i0] : 1, r1 = ar ? ar[n - 1] : 1;
    var retAdj = (isFinite(r0) && r0 > 0 && isFinite(r1) && isFinite(ret))
      ? ((1 + ret / 100) * r1 / r0 - 1) * 100 : NaN;
    var adjSpan = (isFinite(r0) && r0 > 0 && isFinite(r1)) ? Math.abs(r0 / r1 - 1) * 100 : 0;
    var retHtml = adjSpan >= 0.5
      ? '<span>累计 <b class="' + cc(retAdj) + '">' + fpc(retAdj) + '</b> 复权'
        + '<span style="color:var(--txt3)"> / ' + fpc(ret) + ' 原始</span></span>'
      : '<span>累计 <b class="' + cc(ret) + '">' + fpc(ret) + '</b></span>';
    leg.innerHTML =
      '<span>区间 <b>' + (n - i0) + '</b> 个交易日</span>'
      + retHtml
      + '<span>最高 <b>' + fnum(hi,3) + '</b></span>'
      + '<span>最低 <b>' + fnum(lo,3) + '</b></span>'
      + '<span><i style="background:' + HC.ma20 + '"></i>MA20 <b>' + fnum(c.ma20[n-1],3) + '</b></span>'
      + '<span><i style="background:' + HC.ma60 + '"></i>MA60 <b>' + fnum(c.ma60[n-1],3) + '</b></span>'
      + '<span>RSI14 <b>' + fnum(c.rsi14[n-1],1) + '</b></span>';
    return;
  }

  var ds = String(d.dates[idx]);
  var dt = ds.slice(0,4) + '-' + ds.slice(4,6) + '-' + ds.slice(6,8);
  var chg = (isFinite(c.close[idx]) && isFinite(c.open[idx]) && c.open[idx] > 0)
    ? (c.close[idx] / c.open[idx] - 1) * 100 : NaN;
  var hc = HC.up;
  leg.innerHTML =
    '<span style="color:var(--txt)"><b>' + dt + '</b></span>'
    + '<span>开 <b>' + fnum(c.open[idx],3) + '</b></span>'
    + '<span>高 <b>' + fnum(c.high[idx],3) + '</b></span>'
    + '<span>低 <b>' + fnum(c.low[idx],3) + '</b></span>'
    + '<span>收 <b class="' + cc(chg) + '">' + fnum(c.close[idx],3) + '</b></span>'
    + '<span>涨跌 <b class="' + cc(chg) + '">' + fpc(chg) + '</b></span>'
    + '<span>量 <b>' + famt(c.volume[idx]) + '</b></span>'
    + '<span>额 <b>' + famt(c.amount[idx]) + '</b></span>'
    + '<span>RSI <b>' + fnum(c.rsi14[idx],1) + '</b></span>';
}

/* 分红/折算会让原始价出现跳空。adj_ratio 是「相对最新日的复权比率」，
   首尾变化就是区间内的累计调整幅度——超过 0.5% 才提示，免得噪声吓人。 */
function hAdjNote(){
  var d = H.d; if (!d) return '';
  var c = d.col, n = d.n, rng = H.range || n;
  var i0 = Math.max(0, n - rng);
  var a = c.adj_ratio, p = 1;
  if (!a) return '';
  for (var i = i0; i < n; i++) if (isFinite(a[i]) && a[i] > 0){ p = a[i]; break; }
  var r0 = a[i0], r1 = a[n - 1];
  if (!isFinite(r0) || !isFinite(r1) || r0 <= 0) return '';
  var adj = (r0 / r1 - 1) * 100;
  if (Math.abs(adj) < 0.5) return '';
  return '本区间内有分红或份额折算，原始价存在跳空；按复权口径计算的累计调整约 '
    + (adj > 0 ? '+' : '') + adj.toFixed(2) + '%。';
}

document.getElementById('hClose').onclick = closeHist;
document.getElementById('histMask').onclick = function(e){
  if (e.target === this) closeHist();
};
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape' && document.getElementById('histMask').classList.contains('on')) closeHist();
});

document.getElementById('histCv').addEventListener('mousemove', function(e){
  var g = H.geo; if (!g || !H.d) return;
  var rect = this.getBoundingClientRect();
  var x = e.clientX - rect.left;
  var idx = g.i0 + Math.floor((x - g.padL) / g.bw);
  var rng = H.range || H.d.n;
  idx = Math.max(g.i0, Math.min(H.d.n - 1, idx));
  if (idx === H.hover) return;
  H.hover = idx;
  hCross(idx);
});
document.getElementById('histCv').addEventListener('mouseleave', function(){
  if (!H.geo) return;
  H.hover = -1;
  H.ctx.setTransform(1,0,0,1,0,0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, H.W, H.Ht);
  hLegend(-1);
});

Array.prototype.forEach.call(document.querySelectorAll('#hTabs span'), function(t){
  t.onclick = function(){
    Array.prototype.forEach.call(document.querySelectorAll('#hTabs span'), function(x){
      x.classList.remove('on');
    });
    t.classList.add('on');
    H.range = parseInt(t.getAttribute('data-r'), 10);
    H.hover = -1;
    if (H.d){
      hDraw();
      hLegend(-1);
      var note = hAdjNote();
      document.getElementById('hNote').textContent = note;
    }
  };
});

var hResizeTimer = null;
window.addEventListener('resize', function(){
  if (!document.getElementById('histMask').classList.contains('on')) return;
  clearTimeout(hResizeTimer);
  hResizeTimer = setTimeout(function(){
    if (H.d){ H.hover = -1; hDraw(); hLegend(-1); }
  }, 140);
});

/* ---------- 数据加载 ---------- */
function loadFull(){
  return fetch('/api/all').then(function(r){ return r.json(); }).then(function(j){
    if (!j.raw){ throw new Error(j.error || '无数据'); }
    DATA_SRC = j.src;
    var items = normalize(j.src, j.raw);
    markKeep(items);                 // 先定每组的代表标的，渲染和统计都依赖它
    // 价格变动闪烁依赖前后对比，保留 lastP
    DATA = items;
    STATS = computeStats(items);
    DATA_TS = Date.now();

    var nPre = 0;
    for (var z=0;z<items.length;z++) if (items[z].pre) nPre++;
    var preNote = nPre > items.length * 0.5 ? ' · 非交易时段，现价取昨收' : '';

    var dst = document.getElementById('d-src');
    dst.classList.remove('up','down'); dst.classList.add('up');
    document.getElementById('srcName').textContent = j.src === 'eastmoney' ? '东财' : '新浪';
    document.getElementById('fSrc').textContent = '数据源: '
      + (j.src === 'eastmoney' ? '东方财富（含 IOPV）' : '新浪财经')
      + ' · ' + items.length + ' 只' + preNote;
    document.getElementById('fTs').textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN');
    document.getElementById('fErr').textContent = '';

    var hasPm = items.some(function(x){ return x.pm != null; });
    var dpm = document.getElementById('d-pm');
    dpm.classList.remove('up','down'); dpm.classList.add(hasPm ? 'up' : 'down');
    dpm.title = hasPm ? '溢价率可用（东财源）' : '当前源无 IOPV，溢价率不可得';

    renderCards(); renderList(); renderWatch();
  }).catch(function(e){
    document.getElementById('fErr').textContent = '行情失败: ' + e.message;
    if (!DATA.length) document.getElementById('listBody').innerHTML =
      '<tr><td colspan="11" class="empty">加载失败：' + e.message + '</td></tr>';
  });
}

/* 自选高频：浏览器 <script> 直连腾讯
   ---------------------------------------------------------------
   腾讯 qt.gtimg.cn 返回 GBK，Cloudflare Worker 的 TextDecoder 不支持 gbk，
   但浏览器加载外部 <script> 时会按响应头 charset 自动用 GBK 解码，中文正常。
   且 <script> 不受 CORS 限制（返回的是 v_sh510300="..." 这种赋值语句）。
   结果：零后端成本、不消耗 Worker 请求额度、无 CPU 限制的高频通道。 */
function toTX(c){
  if (c.charAt(0) === '5' || c.charAt(0) === '6') return 'sh' + c;
  if (c.charAt(0) === '0' || c.charAt(0) === '1') return 'sz' + c;
  return 'sh' + c;
}
function loadTXQuotes(){
  if (!watch.length) return;
  var tx = [];
  for (var w=0; w<watch.length; w++) tx.push(toTX(watch[w]));
  var s = document.createElement('script');
  s.src = 'https://qt.gtimg.cn/q=' + tx.join(',') + '&_=' + Date.now();
  var done = false;
  var finish = function(){ if (!done){ done = true; try { s.remove(); } catch(e){} } };

  s.onload = function(){
    if (done) return;
    var out = {};
    for (var i=0;i<tx.length;i++){
      var tc = tx[i];
      var v = window['v_' + tc];
      if (!v) continue;
      var a = v.split('~');
      if (a.length < 40) continue;
      var p = +a[3];
      if (!p) continue;
      var code = tc.replace(/^(sh|sz)/, '');
      out[code] = { c:code, n:a[1], p:p, pc:+a[4], chg:+a[32],
        amt:(+a[37])*1e4, tr:+a[38], hi:+a[33], lo:+a[34], op:+a[5],
        iopv:null, pm:null, mc:0, g:group(a[1]), ix: IX_OF[code] || null };
    }
    if (Object.keys(out).length){
      LIVE = out;
      renderWatch();
      var tip = document.getElementById('quoteTip');
      if (tip) tip.textContent = '自选经浏览器直连腾讯 · ' + (isOpen()?'5 秒':'30 秒') + '刷新';
    }
    finish();
  };
  s.onerror = function(){
    if (done) return;
    var tip = document.getElementById('quoteTip');
    if (tip) tip.textContent = '腾讯直连失败，自选跟随全市场数据';
    finish();
  };
  document.head.appendChild(s);
  setTimeout(finish, 6000);
}

function schedule(){
  clearInterval(timerSlow); clearInterval(timerFast);
  var open = isOpen();
  // 全市场：交易时段 60 秒，非交易 300 秒（保护新浪上游，避免被风控）
  timerSlow = setInterval(loadFull, open ? 60000 : 300000);
  // 自选高频：浏览器直连腾讯，不经过 Worker，5 秒一次也不消耗任何配额
  timerFast = setInterval(loadTXQuotes, open ? 5000 : 30000);
}

/* ---------- 事件 ---------- */
document.getElementById('btnAdd').onclick = function(){
  var v = document.getElementById('addIn').value.trim();
  if (!v) return;
  var codes = v.split(/[\\s,，]+/).map(function(s){ return s.trim().replace(/^(sh|sz|hk)/i,''); }).filter(Boolean);
  var n = 0;
  codes.forEach(function(c){
    if (!/^\\d{5,6}$/.test(c)){ toast('代码格式不对: '+c); return; }
    if (watch.indexOf(c) >= 0){ toast(c+' 已在自选'); return; }
    watch.push(c); n++;
  });
  if (n){ saveWatch(); document.getElementById('addIn').value=''; toast('已添加 '+n+' 只');
    renderWatch(); loadTXQuotes(); }
};
document.getElementById('addIn').addEventListener('keydown', function(e){
  if (e.key === 'Enter') document.getElementById('btnAdd').click();
});
document.getElementById('btnClear').onclick = function(){
  watch = []; LIVE = {}; saveWatch(); renderWatch(); toast('已清空自选');
};

document.body.addEventListener('click', function(e){
  var ix = e.target.closest('[data-ix]');
  if (ix){
    var v = ix.getAttribute('data-ix');
    IXF = (IXF === v) ? null : v;
    renderList();
    return;
  }
  var a = e.target.closest('[data-add]');
  if (a){
    var c = a.getAttribute('data-add');
    if (watch.indexOf(c) >= 0){ toast(c+' 已在自选'); return; }
    watch.push(c); saveWatch(); renderWatch(); loadTXQuotes(); toast('已加入自选 '+c);
    return;
  }
  var d = e.target.closest('[data-del]');
  if (d){
    var c2 = d.getAttribute('data-del');
    watch = watch.filter(function(x){ return x !== c2; });
    delete LIVE[c2];
    saveWatch(); renderWatch(); toast('已移除 '+c2);
    return;
  }
  // 点行看历史 K 线。放在最后：上面的 ×N 标签和 +/- 按钮都自带 return
  var row = e.target.closest('tr[data-c]');
  if (row){
    var rc = row.getAttribute('data-c');
    var nmEl = row.querySelector('td.nm');
    var nm = (nmEl && nmEl.firstChild && nmEl.firstChild.nodeType === 3)
      ? nmEl.firstChild.nodeValue : '';
    openHist(rc, nm || (findItem(rc) || {}).n || rc);
  }
});

Array.prototype.forEach.call(document.querySelectorAll('.tag'), function(t){
  if (t.id === 'dedupTag') return;      // 去重开关有自己的处理
  t.onclick = function(){
    Array.prototype.forEach.call(document.querySelectorAll('.tag'), function(x){ x.classList.remove('on'); });
    t.classList.add('on');
    g = t.getAttribute('data-g');
    IXF = null;
    renderList();
  };
});
document.getElementById('sortSel').onchange = function(){ sortKey = this.value; renderList(); };
document.getElementById('limitSel').onchange = function(){ limit = parseInt(this.value,10); renderList(); };
(function(){
  var t = document.getElementById('dedupTag');
  if (!t) return;
  try{ if (localStorage.getItem('etf_dedup') === '0') DEDUP = false; }catch(e){}
  t.classList.toggle('on', DEDUP);
  t.onclick = function(){
    DEDUP = !DEDUP;
    IXF = null;
    t.classList.toggle('on', DEDUP);
    try{ localStorage.setItem('etf_dedup', DEDUP ? '1' : '0'); }catch(e){}
    renderCards(); renderList();
    toast(DEDUP ? '已按同指数去重，每组只留成交额最大的一只' : '已显示全部 ETF');
  };
})();
var qt = null;
document.getElementById('q').addEventListener('input', function(){
  var v = this.value;
  clearTimeout(qt);
  qt = setTimeout(function(){ kw = v.trim(); IXF = null; renderList(); }, 250);
});

document.getElementById('btnProbe').onclick = function(){
  toast('正在实测数据源…', 3000);
  fetch('/api/probe').then(function(r){ return r.json(); }).then(function(j){
    var em = j.eastmoney || {}, sn = j.sina || {};
    var fmt = function(o){ return o.ok > 0 ? ('可用 ' + o.ok + ' 只 / ' + o.ms + 'ms') : ('不可用 ' + (o.err || '')); };
    alert('数据源实测（当前部署环境）\\n\\n'
      + '东财: ' + fmt(em) + '\\n' + '新浪: ' + fmt(sn)
      + '\\n\\n东财可用时才有 IOPV / 溢价率，且自选可 5 秒高频刷新。');
    console.log('probe', j);
  }).catch(function(e){ toast('自检失败: ' + e.message); });
};

function clock(){ document.getElementById('clock').textContent = new Date().toLocaleTimeString('zh-CN'); }
clock(); setInterval(clock, 1000);

pullWatch();
loadFull().then(function(){
  renderCards();
  loadTXQuotes();
  schedule();
});
</script>
</body>
</html>`;
