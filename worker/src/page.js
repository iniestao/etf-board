import { IDX_GROUPS } from './idx_data.js';
import { RESEARCH } from './research_data.js';
import { ALPHA_META } from './alpha_meta.js';
import { LAB } from './lab_data.js';

// 注入到 HTML 里的紧凑映射：{ "沪深300": ["510300", ...], ... }
// 18KB 一次随页面下发，比再开一个 /api 接口划算——省一次 RTT，也省 Worker 的 CPU 配额。
// 注意 build.mjs 会把这个插值替换成实际 JSON 字面量，不能只靠模板字符串。
const IDX_JS = JSON.stringify(IDX_GROUPS);

// 因子研究的全部数据（101 个 IC、7 条回测、8 个入选组合），约 5KB。
// 同样在构建时固化，点开面板不需要额外请求。
const RESEARCH_JS = JSON.stringify(RESEARCH);

// 101 个因子的中文名、一句话解读和公式，约 20KB。
// 公式由 tools/gen_alpha_meta.py 从 alpha101.py 的 AST 生成，
// 所以页面上写的和实际在算的永远是同一份。
const ALPHA_META_JS = JSON.stringify(ALPHA_META);

// 第二批因子：468 个指数（同指数只留流动性最好的一只）、100 个新因子 + Alpha101 同池，
// 约 20KB。比上面那套大，主要是 201 行的两期统计和 90 个月末净值点。
const LAB_JS = JSON.stringify(LAB);

export const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETF 全市场盯盘</title>
<style>
:root{--bg:#f5f6f8;--bg2:#ffffff;--bg3:#f0f2f5;--line:#e3e6eb;--txt:#15181d;
--txt2:#5b6472;--txt3:#939aa7;--up:#d93a3a;--down:#0e9a61;--accent:#2563eb;
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
.dot.up i{background:var(--down);box-shadow:0 0 0 3px rgba(14,154,97,.16)}
.dot.down i{background:var(--up);box-shadow:0 0 0 3px rgba(217,58,58,.16)}
.dot.down{color:var(--up)}
#btnRs{padding:3px 11px;border-radius:20px;font-size:11.5px;color:var(--txt2);display:inline-block;
text-decoration:none;
background:var(--bg3)}
#btnRs:hover{color:var(--txt);border-color:var(--accent)}
.cards{display:flex;gap:9px;margin-bottom:12px;flex-wrap:wrap}
.cards .card{width:186px;flex:0 0 auto}
@media(max-width:560px){.cards .card{width:calc(50% - 5px)}}
/* 上游故障时的横幅：贴在卡片下面，一进页面就能看见。
   放在 footer 里等于没有——100 行的表格把 footer 顶到 4600px 之外。 */
.stalebar{margin:-2px 0 12px;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.5;
  background:#fff8e8;border:1px solid #f0dcb0;color:#8a5a00}
.stalebar.bad{background:#fdeeee;border-color:#f3c7c7;color:#b02a2a}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 13px}
.card .k{font-size:11px;color:var(--txt2);letter-spacing:.3px;margin-bottom:4px}
.card .v{font-size:19px;font-weight:600;font-family:var(--mono);line-height:1.25}
.card .v small{font-size:11px;font-weight:400;color:var(--txt3);margin-left:3px}
.card .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
/* ---------- 全市场异动 ---------- */
.mktwrap{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:9px;align-items:start}
@media(max-width:880px){.mktwrap{grid-template-columns:1fr}}
.mkbox{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 13px}
.wbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:9px 0 7px;
  background:#eef1f5;box-shadow:inset 0 0 0 1px #e3e6eb}
.wbar i{display:block;height:8px}
.wstat{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;
  color:var(--txt3);font-family:var(--mono);flex-wrap:wrap}
.wstat b{color:var(--txt);font-weight:600}
.mtabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}
.mtab{font-size:11px;padding:2px 8px;border-radius:5px;border:1px solid var(--line);
  background:var(--bg3);color:var(--txt2);cursor:pointer;user-select:none;white-space:nowrap}
.mtab:hover{border-color:#c9d6ef}
.mtab.on{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8;font-weight:600}
.mtab u{text-decoration:none;margin-left:5px;font-family:var(--mono);font-size:10px;opacity:.7}
.mhead,.mrow{display:grid;grid-template-columns:minmax(0,1fr) 44px 48px 46px 58px;
  gap:8px;align-items:center}
@media(max-width:560px){
  /* 手机上一行放五列本来就紧，指数名让位给 ETF 名称，名称被截断更伤 */
  .mn em{display:none}
  .mhead,.mrow{grid-template-columns:minmax(0,1fr) 38px 34px 32px 50px;gap:5px}
}
.mhead{padding:0 0 5px;font-size:10px;color:var(--txt3);border-bottom:1px solid var(--line);
  font-family:var(--mono);letter-spacing:.3px}
.mhead span:not(:first-child){text-align:right}
.mrow{padding:5px 0;border-bottom:1px dashed var(--line);cursor:pointer;font-size:12px}
.mtag{font-size:10px;padding:1px 0;border-radius:4px;text-align:center;white-space:nowrap;
  font-weight:600;letter-spacing:.2px}
.mtag.t-up{background:#fdecee;color:#b02a2a;border:1px solid #f3c7c7}
.mtag.t-warn{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.mtag.t-down{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.mtag.t-info{background:#eaf1ff;color:#1d4ed8;border:1px solid #b9cdf7}
.mtag.t-mute{background:#f0f2f5;color:#6b7380;border:1px solid #e3e6eb}
.mrow:last-child{border-bottom:none}
.mrow:hover .mn{color:#1d4ed8}
.mn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.mn em{font-style:normal;font-size:10px;color:var(--txt3);margin-left:5px;font-family:var(--mono)}
.mnum{font-family:var(--mono);font-size:11.5px;text-align:right}
.mnum small{font-size:9.5px;color:var(--txt3);margin-right:2px}
/* ---- 急涨急跌 ---- */
.spdgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.spdcol{min-width:0}
.spdcol + .spdcol{border-left:1px solid var(--line);padding-left:14px}
.spdcol:first-child{padding-right:14px}
.spdnone{padding:9px 0;color:var(--txt3);font-size:11.5px}
.spdch{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--txt3);
  padding-bottom:5px;border-bottom:1px solid var(--line);margin-bottom:2px;letter-spacing:.3px}
.spdch b{font-weight:600;font-size:11px}
.spdch b.up{color:var(--up)}.spdch b.dn{color:var(--down)}
/* 用 flex 而不是 grid：名称 + 走势线是「左边一块信息」，涨速和量比是
   「右边两个数」。网格会把走势线顶到栏宽的中段，两边各留一片空白，
   看着像中间缺了内容。 */
.spdrow{display:flex;gap:8px;align-items:center;padding:5px 0;
  border-bottom:1px dashed var(--line);cursor:pointer;font-size:12px}
.spdrow:last-child{border-bottom:none}
.spdrow:hover{background:#f7f9fc}
.spdrow:hover .spdnm{color:#1d4ed8}
/* 给名字一个下限：不然「银行ETF华宝」和「沪深300ETF华泰柏瑞」两种长度
   会让走势线在每一行都往右挪一点，一列 spark 看着像锯齿。 */
/* 名字列给死宽度：名字长短不一时，走势线的左端会一行一行往右挪，
   一列 spark 参差错开，看着比数据本身还乱（这也是「比例怪」的一半原因）。
   死宽度 + 名字省略号，代码不缩——代码是拿来复制搜索的，比名字后半截有用。 */
.spdnm{flex:0 0 168px;display:flex;align-items:baseline;gap:4px;min-width:0;font-weight:500}
.spdnm .nmx{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spdnm em{flex:0 0 auto;font-style:normal;font-size:9.5px;color:var(--txt3);font-family:var(--mono)}
/* 走势线往右靠、紧贴两个数值：名字短的行中间留白，比「线飘在名字后面、
   数值孤零零在最右」稳。涨速/量比两个数成一组，才是「右块」。 */
.spk{display:block;flex:0 0 auto;margin-left:auto;overflow:visible}
.spdv{flex:0 0 56px;font-family:var(--mono);font-size:12px;
  text-align:right;font-weight:600}
.spdq{flex:0 0 40px;font-family:var(--mono);font-size:11px;text-align:right;color:var(--txt2)}
.spdq.hot{color:#a9660a;font-weight:600}
.spdnote{font-size:10.5px;color:var(--txt3);margin-top:7px;padding-top:6px;
  border-top:1px solid var(--line);line-height:1.5}
@media(max-width:760px){
  .spdgrid{grid-template-columns:1fr;gap:10px}
  .spdcol + .spdcol{border-left:none;border-top:1px solid var(--line);padding-left:0;padding-top:12px}
  .spdcol:first-child{padding-right:0}
  /* 手机上挤不下走势线，让位给名字——名字被截成两三个字更伤 */
  .spdrow{gap:6px}
  .spdrow .spk{display:none}
  .spdnm{flex:1 1 auto;min-width:0}
  .spdv{flex:0 0 52px;font-size:11.5px}
  .spdq{flex:0 0 36px;font-size:10.5px}
}
.styl{display:grid;grid-template-columns:62px minmax(0,1fr) 44px 40px;
  gap:8px;align-items:center;padding:3.5px 0;font-size:11.5px}
.styl .sk{color:var(--txt2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.styl .sbar{height:6px;background:#eef1f5;border-radius:3px;position:relative;overflow:hidden}
.styl .sbar u{position:absolute;left:0;top:0;height:6px;border-radius:3px;
  background:linear-gradient(90deg,#c9dbff,#5c92ec)}
.styl .sv{font-family:var(--mono);text-align:right;color:var(--txt);font-size:11px}
.styl .sr{font-family:var(--mono);text-align:right;font-size:10.5px}
.mfoot{margin-top:7px;padding-top:7px;border-top:1px dashed var(--line);
  font-size:10.5px;color:var(--txt3);line-height:1.6}

/* ---------- 今日变化 + 组合体检 ---------- */
.split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:9px;align-items:start}
@media(max-width:860px){.split{grid-template-columns:1fr}}
.evtbox,.portbox{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 13px}
.evt{display:flex;gap:9px;padding:7px 0;border-bottom:1px dashed var(--line)}
.evt:last-child{border-bottom:none;padding-bottom:1px}
.evt i{width:6px;height:6px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:#c3c9d4}
.evt.lv3 i{background:#d93a3a}
.evt.lv2 i{background:#e0a12a}
.evt.lv1 i{background:#9aa3b2}
.eb{min-width:0}
.eb b{font-size:12.5px;font-weight:600}
.eb .ek{margin-left:7px;font-size:10.5px;color:var(--txt2);background:var(--bg3);
  border:1px solid var(--line);border-radius:4px;padding:0 5px;white-space:nowrap}
.evt.lv3 .ek{color:#b02a2a;background:#fdecee;border-color:#f3c7c7}
.evt.lv2 .ek{color:#a9660a;background:#fff6e5;border-color:#f0dcb4}
.es{font-size:11px;color:var(--txt2);margin-top:3px;line-height:1.55}
.eempty{padding:14px 2px 10px;font-size:12.5px;color:var(--txt2);line-height:1.7}
.eempty span{color:var(--txt3);font-size:11px}
.prow{display:flex;gap:16px;margin-bottom:2px}
.pk{font-size:10.5px;color:var(--txt3);margin-bottom:2px}
.pv{font-size:21px;font-weight:600;font-family:var(--mono);line-height:1.25}
.pv small{font-size:10.5px;color:var(--txt3);font-weight:400;margin-left:2px}
.pnote{font-size:11px;color:var(--txt2);line-height:1.65;border-top:1px dashed var(--line);
  padding-top:8px;margin-top:9px}
.pnote b{color:var(--txt)}

/* ---------- 位置诊断 ---------- */
/* 这一栏是整页唯一「不是行情软件」的东西：行情软件给报价，这里给位置和量能。
   位置条用蓝色深浅而不是红绿——红绿在这页已经被涨跌占用，再用一次就乱了。 */
.dnote{font-size:11.5px;color:var(--txt3);margin:-1px 0 9px;line-height:1.6}
.dgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:9px}
@media(max-width:560px){.dgrid{grid-template-columns:1fr}}
.dcard{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 12px 11px;
  cursor:pointer;transition:border-color .15s,box-shadow .15s;display:flex;flex-direction:column}
.dcard:hover{border-color:#c9d6ef;box-shadow:0 3px 12px rgba(23,32,54,.07)}
.dcard.pend{opacity:.55}
.dtop{display:flex;align-items:baseline;gap:7px;margin-bottom:9px;min-width:0}
.dtop .dn{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtop .dc{font-family:var(--mono);font-size:11px;color:var(--txt3);flex:0 0 auto}
.dtag{margin-left:auto;font-size:11px;font-weight:600;padding:2px 7px;border-radius:5px;
  white-space:nowrap;flex:0 0 auto}
.dtag.d0{background:#f0f2f5;color:#5b6472;border:1px solid #e3e6eb}
.dtag.d1{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.dtag.d2{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.dtag.d3{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.dtag.d4{background:#fdecee;color:#b02a2a;border:1px solid #f3c7c7}
.posbar{position:relative;height:7px;border-radius:4px;background:#e7ebf1;overflow:visible}
.posbar u{position:absolute;left:0;top:0;height:7px;border-radius:4px;
  background:linear-gradient(90deg,#c9dbff,#5c92ec)}
.posbar i{position:absolute;top:-2.5px;width:4px;height:12px;border-radius:2px;background:#1d4ed8;
  box-shadow:0 0 0 2px #fff,0 1px 3px rgba(20,26,40,.25);transform:translateX(-2px)}
.poslb{display:flex;align-items:baseline;justify-content:space-between;font-size:9.5px;
  color:var(--txt3);font-family:var(--mono);margin-top:6px;letter-spacing:.2px}
.poslb .pz{font-size:15px;font-weight:600;color:var(--txt);font-family:var(--mono);line-height:1}
.poslb .pz em{font-style:normal;font-size:9.5px;color:var(--txt3);font-weight:400;margin-left:5px;
  letter-spacing:.2px}
.dchips{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px}
.dchip{font-size:10.5px;color:var(--txt3);background:var(--bg3);border:1px solid var(--line);
  border-radius:5px;padding:2px 7px;font-family:var(--mono);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dchip b{color:var(--txt);font-weight:600;margin-left:2px}
.dchip b.up{color:var(--up)}.dchip b.down{color:var(--down)}
.dwhy{margin-top:auto;padding-top:7px;font-size:11px;color:var(--txt2);line-height:1.55}

.bar{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input,select,button{background:var(--bg2);color:var(--txt);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font-size:12.5px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
input#q{width:180px}
button{cursor:pointer;transition:.15s}
button:hover{background:var(--bg3)}
button.pri{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:12px;
border:1px solid var(--line);background:var(--bg2);color:var(--txt2);transition:.15s;user-select:none}
.tag:hover{color:var(--txt)}
.tag.on{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8}
.tag b{font-weight:400;opacity:.6;font-size:10.5px;margin-left:3px}
.sec{margin-bottom:16px}
.sechd{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12.5px;color:var(--txt2)}
.sechd b{color:var(--txt);font-size:13.5px;font-weight:600;white-space:nowrap;flex:0 0 auto}
.sechd .n{color:var(--txt3);font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sechd .sync{margin-left:auto;font-size:10.5px;color:var(--txt3);border:1px solid var(--line);
border-radius:5px;padding:1px 7px;cursor:pointer;user-select:none;white-space:nowrap;flex:0 0 auto}
.sechd .sync:hover{color:var(--txt);border-color:var(--accent)}
.tbl{background:var(--bg2);border:1px solid var(--line);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead th{background:var(--bg3);font-size:10.5px;font-weight:500;color:var(--txt2);
letter-spacing:.3px;padding:9px;text-align:right;white-space:nowrap;
border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
thead th:hover{color:var(--txt)}
thead th.l{text-align:left}
thead th.ctr{text-align:center}
thead th.on{color:var(--accent)}
tbody td{padding:8px 9px;text-align:right;border-bottom:1px solid #e3e6eb;
font-family:var(--mono);font-size:12.5px;white-space:nowrap}
tbody tr:hover{background:#f7f9fd}
tbody tr:last-child td{border-bottom:none}
td.l{text-align:left;font-family:inherit}
td.ctr{text-align:center}
.code{color:var(--txt3);font-size:11px}
.nm{font-weight:500}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--txt3)}
.pm{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11.5px;font-weight:600;min-width:56px}
.pm.hi{background:#fdecec;color:#c62f34;border:1px solid #f5c9cb}
.pm.mid{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.pm.lo{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.pm.na{background:transparent;color:var(--txt3);border:none;font-weight:400}
.act{color:var(--txt3);cursor:pointer;font-size:15px;padding:1px 6px;border-radius:4px}
.act:hover{color:var(--accent);background:#eaf1ff}
.act.del:hover{color:var(--up);background:#fdeeee}
.ixb{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;font-size:10px;
font-weight:500;color:var(--txt3);background:#f0f2f5;border:1px solid var(--line);
vertical-align:1px;cursor:default}
.ixb.mx{color:#2563eb;background:#eaf1ff;border-color:#c9dbff}
.syn{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:9.5px;
color:#2563eb;background:#eaf1ff;border:1px solid #c9dbff;vertical-align:1px;font-weight:500}
tr.hr{cursor:pointer}
tr.hr:hover td{background:#f7f9fd}
@keyframes fu{0%{background:#ffe3e3}100%{background:transparent}}
@keyframes fd{0%{background:#d9f5ea}100%{background:transparent}}
.fu{animation:fu .7s ease-out}.fd{animation:fd .7s ease-out}
footer{margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--txt3)}
.err{color:var(--up)}
.empty{padding:20px;text-align:center;color:var(--txt3);font-size:12.5px}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#fff;box-shadow:0 8px 26px rgba(20,26,40,.16);
border:1px solid var(--line);padding:8px 16px;border-radius:6px;font-size:12.5px;opacity:0;
transition:.25s;pointer-events:none;z-index:9}
#toast.show{opacity:1}
@media(max-width:820px){.hide-sm{display:none}}
/* 「主要贡献」列到中等屏就收掉：自选表本来就有 14 列，1280 以下再加一列会把
   成交额和换手挤成一坨，反而更难读 */
@media(max-width:1280px){.hide-md{display:none}}
.t3cell{white-space:nowrap;text-align:left}
/* 三只成分压成一串小标签。用底色块而不是纯文字：三行名字连在一起时，
   靠颜色块才分得清哪一段是名称、哪一段是贡献数字 */
.t3{display:inline-block;padding:0 4px;margin-right:3px;border-radius:3px;
  background:#f3f6fb;font-size:10.5px;line-height:17px;color:var(--txt2);
  font-family:var(--sans);font-weight:500}
.t3 em{font-style:normal;font-family:var(--mono);margin-left:3px;font-weight:600}
.t3.up em{color:var(--up)}
.t3.dn em{color:var(--down)}
.t3ph{color:var(--txt3);font-size:11px;font-family:var(--mono)}

/* ---------- 历史 K 线面板 ---------- */
#histMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:60;display:none;
align-items:center;justify-content:center;padding:18px}
#histMask.on{display:flex}
.hpanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;min-width:0;
max-width:1060px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 18px 48px rgba(20,26,40,.16)}
.hhd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.hhd .nm{font-size:14.5px;font-weight:600}
.hhd .cd{font-family:var(--mono);font-size:12px;color:var(--txt3)}
.hhd .px{font-family:var(--mono);font-size:16px;font-weight:600;margin-left:4px}
.hhd .ch{font-family:var(--mono);font-size:12.5px}
.htabs{display:flex;gap:3px;margin-left:6px}
/* 分时 / K线 切换：做成独立分段控件，和右边周期条分开——
   两者语义不同（一个是「看什么」，一个是「看多长」），混在一排会读错 */
.hmodes{display:flex;gap:2px;background:var(--bg3);border:1px solid var(--line);
border-radius:6px;padding:2px;margin-left:auto}
.hmodes b{padding:2px 10px;border-radius:4px;font-size:11.5px;font-weight:400;
color:var(--txt2);cursor:pointer;user-select:none}
.hmodes b:hover{color:var(--txt)}
.hmodes b.on{background:#fff;color:var(--txt);font-weight:600;box-shadow:0 1px 2px rgba(20,26,40,.09)}
.hmodes b[data-m="min"].on{color:var(--accent)}
.htabs span{padding:3px 9px;border-radius:5px;font-size:11.5px;color:var(--txt2);
cursor:pointer;border:1px solid transparent;user-select:none}
.htabs span:hover{color:var(--txt)}
.htabs span.on{background:var(--bg3);border-color:var(--line);color:var(--txt)}
.hx{width:26px;height:26px;border-radius:6px;border:1px solid var(--line);background:transparent;
color:var(--txt2);cursor:pointer;font-size:15px;line-height:1;padding:0}
.hx:hover{color:var(--txt);background:var(--bg3)}
#histCv{display:block;width:100%;height:clamp(300px,62vh,430px);flex:0 0 auto;cursor:crosshair;min-width:0;max-width:100%}
/* 副图 / 叠加选择条：一行 chip，切换只重绘画布，不重新拉数据 */
.hsbar{display:flex;align-items:center;gap:4px;padding:8px 14px 2px;flex-wrap:wrap}
.hsbar .lb{font-size:10.5px;color:var(--txt3);margin-right:2px}
.hsbar .lb+.sg+.lb{margin-left:8px}
.hsbar .sg{display:flex;gap:3px;flex-wrap:wrap;min-width:0}
.hsbar b{padding:2px 7px;border:1px solid var(--line);border-radius:5px;font-size:11px;
font-family:var(--mono);font-weight:400;color:var(--txt2);cursor:pointer;user-select:none}
.hsbar b:hover{color:var(--txt)}
.hsbar b.on{background:var(--bg3);color:var(--txt);border-color:#c9d6ef}

/* ---- 成分穿透 ----
   一行 = 一只成分：权重、今日涨跌、贡献（权重×涨跌），中间一条以中线为 0 的
   双向条。条不是为了好看：0.02 个百分点的贡献和 0.4 个用数字看只差一个字，
   用长度看是一眼。条按当前表里最大 |贡献| 归一，所以每次打开尺度会变——
   换来的是小票也能看见，代价是不能跨股票比长度。 */
/* 高度必须自己封顶：flex-basis:0 在高度 auto 的父容器里算不出剩余空间，
   面板会塌成只剩标题栏；不封顶则 30 行把底部的合计挤出屏幕。 */
.hhold{display:none;flex:0 1 auto;max-height:calc(94vh - 132px);overflow-y:auto;padding:0 14px}
.hhold.on{display:block}
.hholdhd{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  font-size:10.5px;color:var(--txt3);padding:8px 0 7px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:var(--bg2);z-index:2}
.hholdhd b{color:var(--txt);font-weight:600}
.hcollapse{font-style:normal;cursor:pointer;color:#2f6fd0;border-bottom:1px dashed #9dbbeb}
.hhrow{display:grid;grid-template-columns:minmax(0,220px) 62px 66px minmax(70px,1fr) 62px;
  gap:10px;align-items:center;padding:5px 0;border-bottom:1px dashed var(--line);font-size:12px}
.hhrow:hover{background:#f7f9fc}
.hhrk{display:none}
.hhnm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.hhnm em{font-style:normal;font-size:9.5px;color:var(--txt3);margin-left:5px;font-family:var(--mono)}
.hhw,.hhc,.hhctr{font-family:var(--mono);text-align:right;font-size:11.5px}
.hhc.up{color:var(--up)}.hhc.dn{color:var(--down)}
/* 贡献列也要红涨绿跌：不写这条时负贡献会掉回默认的深灰，跟「-0.16 是坏事」
   这层意思对不上，整列看着像没上色 */
.hhctr{font-weight:600}
.hhctr.up{color:var(--up)}.hhctr.dn{color:var(--down)}
.hhbar{position:relative;height:7px;background:#eaeef4;border-radius:4px}
.hhbar:before{content:"";position:absolute;left:50%;top:0;width:1px;height:7px;background:#c9d2de}
.hhbar u{position:absolute;top:0;height:7px;border-radius:3px}
/* 合计行吸在底部：它是这一栏的结论（前 N 大解释了多少、剩下多少），
   被 30 行挤到屏幕外就等于没给。 */
.hhfoot{display:flex;flex-wrap:wrap;gap:14px;padding:9px 0 8px;font-size:11px;color:var(--txt2);
  position:sticky;bottom:0;background:var(--bg2);border-top:1px solid var(--line);z-index:1}
.hhfoot b{font-family:var(--mono);font-weight:600}
.hhfoot .k{color:var(--txt3)}
.hhnote{padding:8px 0 2px;font-size:10.5px;color:var(--txt3);line-height:1.75}
/* 展开按钮：整行居中，视觉上明显是「表格到此为止」的分界，不是又一条成分 */
.hhmore{display:flex;justify-content:center;padding:9px 0 4px}
.hhmore b{font-size:11px;font-weight:500;color:var(--acc,#2f6fd0);cursor:pointer;
  padding:5px 14px;border:1px solid #cfdcf0;border-radius:14px;background:var(--bg2)}
.hhmore b:hover{background:#eef4fe;border-color:#9dbbeb}
.hhmore b:active{transform:translateY(1px)}
.hempty{padding:28px 0;text-align:center;color:var(--txt3);font-size:12px;line-height:1.9}
@media(max-width:760px){
  .hhrow{grid-template-columns:minmax(0,1fr) 48px 54px 52px;gap:6px;font-size:11.5px}
  .hhbar{display:none}
  .hhw,.hhc,.hhctr{font-size:11px}
  .hhold{padding:0 12px 8px}
}
.hind .i.on{border-color:#c9d6ef;background:var(--bg3)}
.hleg{display:flex;gap:16px;padding:7px 14px 0;font-size:11.5px;color:var(--txt2);flex-wrap:wrap}
.hleg i{display:inline-block;width:8px;height:2px;vertical-align:3px;margin-right:4px}
.hnote{padding:5px 14px 12px;font-size:10.5px;color:var(--txt3);line-height:1.7}
.hnote:empty{display:none}
/* 指标明细：K 线下方一排小卡，把 17 个字段里最能看的那几个摊开 */
.hind{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;padding:6px 14px 2px;min-width:0}
.hind .i{background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:5px 8px;min-width:0}
.hind .i .k{font-size:10px;color:var(--txt3);letter-spacing:.2px;white-space:nowrap}
.hind .i .v{font-size:12.5px;font-family:var(--mono);font-weight:600;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hind .i .s{font-size:10px;color:var(--txt2);margin-top:1px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.hload{padding:70px 0;text-align:center;color:var(--txt2);font-size:12.5px;line-height:2}
@media(max-width:700px){
  /* 顶部一行装不下：名称/代码/价格/涨幅 + 4 个周期 + 关闭。
     不换行就会把面板撑得比屏幕还宽，连带右边价格轴一起被裁。 */
  /* 关闭按钮脱离 flex 流、钉在右上角。留在流里的话，它排在分段控件之后，
     一行剩不下 26px 就整颗掉到第二行，顶部凭空多出一行高度。 */
  .hhd{flex-wrap:wrap;gap:4px 6px;padding:9px 10px;padding-right:40px;position:relative}
  .hhd .cd{display:none}
  /* 名称不截断时，长名字（沪深300ETF华泰柏瑞）会把关闭按钮挤到第二行，
     面板顶部凭空多出一行，看着像渲染坏了 */
  .hhd .nm{font-size:13px;max-width:28vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .htabs{margin-left:0;order:9}
  .htabs span{padding:2px 7px}
  .hmodes{margin-left:auto;order:8;padding:2px}
  .hmodes b{padding:2px 5px;font-size:10px}
  .hx{position:absolute;right:8px;top:10px;margin:0}
  .hsbar{padding:7px 10px 2px;gap:3px;overflow:hidden}
  .hsbar .lb{font-size:10px}
  .hsbar .lb+.sg+.lb{margin-left:5px}
  .hsbar b{padding:2px 5px;font-size:10px}
  #histCv{height:300px}
  /* 小屏固定 3 列：auto-fit 在 400px 里会算出 4 列 96px，
     但 canvas 的固有宽度参与 flex 计算会把面板撑宽，导致第 4 列被裁掉 */
  .hind{grid-template-columns:repeat(3,minmax(0,1fr))}
}
/* ---- 因子研究面板 ---- */
#rsMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:70;display:none;
align-items:center;justify-content:center;padding:18px}
#rsMask.on{display:flex}
.rspanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:900px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 18px 48px rgba(20,26,40,.16)}
.rshd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line)}
/* 标题不许被压缩换行：以前「因子研究」在 390px 屏上会折成「因子/研究」两行，
   还把日期挤到旁边，看着像排版坏了。标题固定宽度，元信息自己换行。 */
.rshd b{font-size:14.5px;white-space:nowrap;flex:0 0 auto}
.rshd .sub{font-size:11px;color:var(--txt3);font-family:var(--mono);
min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsbody{overflow-y:auto;padding:14px}
.rssec{margin-bottom:18px}
.rssec h4{font-size:12px;color:var(--txt2);font-weight:600;margin-bottom:8px;
letter-spacing:.3px;display:flex;align-items:center;gap:7px}
.rssec h4::after{content:'';flex:1;height:1px;background:var(--line)}
.rsk{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.rsk .i{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.rsk .i .k{font-size:10.5px;color:var(--txt3);margin-bottom:3px}
.rsk .i .v{font-size:17px;font-family:var(--mono);font-weight:600}
.rsk .i .s{font-size:10px;color:var(--txt3);margin-top:2px}
.rstbl{width:100%;border-collapse:collapse;font-size:11.5px}
/* 这几张表列多，手机上宽度不够时**宁可横向滚动**也不能把数字裁掉。
   之前直接裁在容器里，"最大回撤"和后面几列在 390px 宽的屏上完全看不见，
   但页面不报错、也不溢出，属于最难发现的一类排版 bug。 */
.rstwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.rstwrap::-webkit-scrollbar{height:4px}
.rstwrap::-webkit-scrollbar-thumb{background:var(--line);border-radius:2px}
/* 指标说明表是整段说明文字，该换行而不是横向滚。
   权重必须写成 .rstbl.indtbl，否则会被下面 .rstbl td 的 nowrap 盖掉。 */
.rstbl.indtbl td{white-space:normal}
.rstbl th{text-align:right;font-weight:500;color:var(--txt3);padding:5px 7px;
border-bottom:1px solid var(--line);font-size:10.5px;white-space:nowrap}
.rstbl th:first-child,.rstbl td:first-child{text-align:left}
.rstbl td{padding:4px 7px;border-bottom:1px solid rgba(38,44,55,.5);
font-family:var(--mono);text-align:right;white-space:nowrap}
.rstbl tr:hover td{background:var(--bg3)}
.rsnote{font-size:11px;color:var(--txt2);line-height:1.85;background:var(--bg3);
border-left:2px solid var(--accent);border-radius:0 6px 6px 0;padding:9px 12px}
.rsnote b{color:var(--txt)}
.rsnote .warn{border-left-color:var(--up)}
/* ---- 第二批因子：净值图、敏感性网格 ---- */
.labchart{background:var(--bg3);border:1px solid var(--line);border-radius:8px;
padding:10px 12px 6px;margin-top:10px}
.labchart svg{display:block;width:100%;height:auto;overflow:visible}
.labchart .cap{font-size:10.5px;color:var(--txt3);line-height:1.6;margin-top:6px}
.lablg{display:flex;gap:14px;font-size:10.5px;color:var(--txt2);margin-bottom:4px;flex-wrap:wrap}
.lablg i{display:inline-block;width:15px;height:2.5px;vertical-align:middle;margin-right:5px;border-radius:2px}
/* 两期热力表并排，窄屏自动上下叠 */
.labgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}
.labgrid .box{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.labgrid .box h5{font-size:10.5px;color:var(--txt3);font-weight:500;margin-bottom:6px}
.labgrid table{width:100%;border-collapse:collapse;font-size:11px;font-family:var(--mono)}
.labgrid th{font-size:10px;color:var(--txt3);font-weight:400;text-align:center;padding:3px 2px}
.labgrid td{text-align:center;padding:4px 2px;border-radius:3px}
.labgrid td.n{color:var(--txt3)}
.labtabs{display:flex;gap:6px;margin:0 0 9px;flex-wrap:wrap}
.labtabs button{padding:4px 11px;font-size:11px;border-radius:14px;background:var(--bg3);
border:1px solid var(--line);color:var(--txt2);cursor:pointer;font-family:inherit}
.labtabs button.on{background:rgba(76,141,255,.15);border-color:var(--accent);color:var(--txt)}
.labtbl td.nm{text-align:left;font-family:inherit;color:var(--txt3);white-space:normal;
font-size:10.5px;line-height:1.5;max-width:270px}
.labtbl td.fam{text-align:left;font-family:inherit;color:var(--txt3);font-size:10px;white-space:nowrap}
/* ---- 因子明细：点一行展开构造方式 ---- */
.fxtbl tr.fxr{cursor:pointer}
.fxtbl tr.fxr.on td{background:rgba(59,130,246,.10)}
.fxtbl tr.fxx{display:none}
.fxtbl td.fxnm{text-align:left;color:var(--txt2);font-family:inherit;white-space:normal}
.fxdet td{padding:0 0 7px!important;border-bottom:1px solid var(--line)!important;
text-align:left!important;white-space:normal!important;font-family:inherit!important;background:transparent!important}
.fxd{background:var(--bg);border-left:2px solid var(--accent);border-radius:0 7px 7px 0;padding:10px 13px}
.fxdn{font-size:11.5px;color:var(--txt2);margin-bottom:5px}
.fxdn b{color:#0e7490;font-family:var(--mono);font-weight:600;margin-right:7px}
.fxds{font-size:11.5px;color:var(--txt2);line-height:1.7;margin-bottom:8px}
.fxf{font-family:var(--mono);font-size:10.8px;color:#2a2f38;background:var(--bg3);
border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;
white-space:pre-wrap;word-break:break-word;line-height:1.75}
.rsmore{margin-top:9px;text-align:center}
.rsmore button{font-size:11.5px;padding:5px 14px;border-radius:6px}
.rssrc{font-size:10px;color:var(--txt3);margin-top:10px;text-align:right}
/* /research 是独立页面：复用同一份 DOM，把遮罩层改成文档流里的整页布局。
   好处是因子面板只有一套 HTML 和一套渲染代码，不会出现「弹窗里对、页面上错」。 */
.rback{display:none;font-size:11.5px;color:var(--txt2);text-decoration:none;padding:2px 8px;
border:1px solid var(--line);border-radius:5px;white-space:nowrap}
.rback:hover{color:var(--txt)}
body.rsmode{overflow:auto}
body.rsmode .wrap{display:none}
body.rsmode #rsMask{position:static;inset:auto;display:block;background:none;padding:0;
max-width:1120px;margin:0 auto}
body.rsmode .rspanel{max-width:none;max-height:none;border:0;border-radius:0;
background:transparent;box-shadow:none;overflow:visible}
body.rsmode .rshd{position:sticky;top:0;z-index:5;background:var(--bg);
border-bottom:1px solid var(--line);padding:12px 20px}
body.rsmode .rshd b{font-size:15px}
body.rsmode .rback{display:inline-block;margin-right:2px}
body.rsmode .rshd .hx{display:none}
body.rsmode .rsbody{overflow:visible;padding:18px 20px 60px}
@media(max-width:700px){
  .rsbody{padding:10px}
  /* 窄屏：标题和返回按钮占一行，日期/样本区间整体降到第二行 */
  .rshd{flex-wrap:wrap;gap:4px 8px;padding:9px 12px}
  .rshd .sub{flex:1 1 100%;order:9;white-space:normal;line-height:1.5}
  .rstbl{font-size:10.5px}
  .rstbl th,.rstbl td{padding:3px 4px}
  /* 列多的表给个宽度下限：窄屏下让它横向滚动，而不是把数字挤成省略或直接裁掉。
     指标说明表是整段文字，折行更好读，所以单独放开。 */
  .rstwrap>.rstbl{min-width:480px}
  .rstwrap>.btbl{min-width:620px}
  .rstwrap>.fxtbl{min-width:540px}
  .rstwrap>.indtbl{min-width:0}
  .rstwrap>.ytbl{min-width:0}
  .rstwrap>.labtbl{min-width:680px}
  /* 表格右侧被裁一半的样子容易被当成本站坏了，标一句「能滑」。
     只对会横向滚动的那几张表显示，指标说明表换了行不需要。 */
  .rssec:has(.rstwrap>table:not(.indtbl)) > h4::after{
    content:'  ← 左右滑动看全部列';color:var(--txt3);font-weight:400;font-size:10px}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>ETF 全市场盯盘 <em id="clock">--:--:--</em></h1>
  <div class="sp"></div>
  <span class="dot" id="d-src"><i></i><span id="srcName">连接中</span></span>
  <a id="btnRs" href="/research" title="201 个因子的 IC 检验、样本外回测与 PE 策略">因子研究</a>
</header>

<div class="cards">
  <div class="card"><div class="k">全市场 ETF</div><div class="v" id="cTotal">-</div><div class="s" id="cUni">-</div></div>
  <div class="card"><div class="k">涨 / 跌</div><div class="v" id="cUD">-</div><div class="s" id="cUDs">-</div></div>
  <div class="card"><div class="k">全市场成交额</div><div class="v" id="cAmt">-</div><div class="s">合计</div></div>
  <div class="card"><div class="k">今日诊断信号</div><div class="v" id="cSig">-</div><div class="s" id="cSigs">按位置 × 量能给标签</div></div>
</div>

<div class="sec">
  <div class="sechd"><b>今日变化</b><span class="n" id="evtN"></span></div>
  <div class="dnote">只看「相比昨天变了什么」，没发生事的标的不会出现——空白本身是信息。</div>
  <div class="split">
    <div class="evtbox" id="evtList"><div class="empty">正在读取历史…</div></div>
    <div class="portbox" id="portBox"><div class="empty">组合体检需要至少 2 只自选</div></div>
  </div>
</div>

<div class="sec" id="diagSec">
  <div class="sechd"><b>位置诊断</b><span class="n" id="diagN">-</span>
    <span class="sync" id="btnDiag" title="丢掉缓存，重新读一遍历史">重算</span></div>
  <div class="dnote">行情软件告诉你今天涨了多少；这一栏告诉你它站在近一年区间的什么位置、量能配不配合。</div>
  <div class="dgrid" id="diagGrid"><div class="empty">正在读取历史…</div></div>
</div>

<div class="sec" id="mktSec">
  <div class="sechd"><b>全市场异动</b>
    <span class="n" id="mktN" title="剔除债券货币，一个指数只留流动性最好的一只 ETF；上市不满半年、当日无成交的不计入">-</span>
    <span class="sync" id="btnMkt" title="重新读一遍收盘快照">刷新</span></div>
  <div class="dnote">跳出自己的自选池：全部指数今天谁创新高、谁在放量、谁在破位。一个指数只留流动性最好的那只 ETF。</div>
  <div class="mkbox" style="margin-bottom:9px">
    <div class="wstat" id="mktWidth"><span>读取中…</span></div>
    <div class="wbar" id="mktBar"></div>
    <div class="wstat" id="mktWidth2"></div>
  </div>
  <div class="mktwrap">
    <div class="mkbox">
      <div class="mtabs" id="mktTabs"></div>
      <div id="mktList"><div class="empty">读取中…</div></div>
    </div>
    <div class="mkbox" id="mktStyle"><div class="empty">读取中…</div></div>
  </div>
</div>

<div class="sec" id="spdSec">
  <div class="sechd"><b>急涨急跌</b><span class="n" id="spdN">-</span>
    <span class="sync" id="btnSpd" title="立刻重算一次">刷新</span></div>
  <div class="dnote">上面那栏看「今天」，这一栏看「刚才」：过去几分钟谁在急拉、谁在急砸，量跟不跟得上。</div>
  <div class="mkbox">
    <div class="mtabs" id="spdTabs">
      <span class="mtab on" data-w="3">3 分钟</span>
      <span class="mtab" data-w="5">5 分钟</span>
      <span class="mtab" id="spdVol" title="量比低于 1.5 倍的不显示">只看放量</span>
    </div>
    <div class="spdgrid" id="spdGrid"><div class="empty">读取中…</div></div>
    <div class="spdnote" id="spdNote"></div>
  </div>
</div>

<div class="sec">
  <div id="staleBar" class="stalebar" style="display:none"></div>
  <div class="sechd"><b>自选盯盘</b><span class="n" id="watchN"></span>
    <span class="sync" id="btnSync" title="复制一条带同步码的链接，在别的设备打开就是这份自选">同步</span></div>
  <div class="bar">
    <input id="addIn" placeholder="添加代码，支持逗号批量：510300,513180" style="width:290px">
    <button class="pri" id="btnAdd">添加</button>
    <button id="btnClear">清空</button>
    <span class="n" id="quoteTip" style="font-size:11px;color:var(--txt3)"></span>
  </div>
  <div class="tbl"><table>
    <thead><tr>
      <th class="l">代码</th><th class="l">名称</th><th>现价</th><th>涨跌%</th>
      <th class="hide-md" title="贡献最大的三只成分股。贡献 = 权重 × 今日涨跌（百分点），
按绝对值排——涨的时候看谁在拉，跌的时候看谁在砸">主要贡献</th>
      <th>涨跌</th>
      <th class="ctr">溢价率</th><th>IOPV</th><th>成交额</th><th>换手</th>
      <th class="hide-sm">振幅</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th>
      <th class="ctr" style="width:36px"></th>
    </tr></thead>
    <tbody id="watchBody"><tr><td colspan="14" class="empty">加载中…</td></tr></tbody>
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
      <div class="hmodes" id="hMode">
        <b data-m="min">分时</b><b data-m="k">K线</b><b data-m="hold">成分</b>
      </div>
      <div class="htabs" id="hTabs">
        <span data-r="63">3M</span>
        <span data-r="126">6M</span>
        <span data-r="250" class="on">1Y</span>
        <span data-r="0">全部</span>
      </div>
      <button class="hx" id="hClose" title="关闭 (Esc)">×</button>
    </div>
    <div class="hsbar" id="hSbar">
      <span class="lb">副图</span>
      <span class="sg" id="hSubs">
        <b data-s="rsi" class="on">RSI</b><b data-s="macd">MACD</b><b data-s="vr">量比</b><b data-s="hvol">波动率</b><b data-s="atr">ATR</b><b data-s="pb">BOLL%B</b>
      </span>
      <span class="lb">叠加</span>
      <span class="sg" id="hOv">
        <b data-o="ma" class="on">均线</b><b data-o="boll">布林</b>
      </span>
    </div>
    <canvas id="histCv"></canvas>
    <div class="hhold" id="hHold">
      <div class="hholdhd" id="hHoldHd"></div>
      <div id="hHoldBody"></div>
    </div>
    <div class="hleg" id="hLeg"></div>
    <div class="hind" id="hInd"></div>
    <div class="hnote" id="hNote"></div>
  </div>
</div>

<div id="rsMask">
  <div class="rspanel">
    <div class="rshd">
      <a class="rback" href="/">← 盯盘</a>
      <b>因子研究</b>
      <span class="sub" id="rsSub"></span>
      <button class="hx" id="rsClose" title="关闭 (Esc)" style="margin-left:auto">×</button>
    </div>
    <div class="rsbody" id="rsBody"></div>
  </div>
</div>

<script>
'use strict';
var IDX_GROUPS = ${IDX_JS};
var RESEARCH = ${RESEARCH_JS};
var ALPHA_META = ${ALPHA_META_JS};
var LAB = ${LAB_JS};
var DEFAULT_WATCH = ['510300','159915','588000','513180','513120','513050','518880'];
var LS = 'etf_watch_v3';
var watch = loadWatch();

var DATA = [];                 // 全市场归一化数据
var STATS = null;
var LIVE = {};                 // 自选高频覆盖 {code: item}
var g = 'all', sortKey = 'amt', limit = 100, kw = '';
var DATA_SRC = '', DATA_TS = 0;
var lastP = {}, timerSlow = null, timerFast = null, timerSpd = null, timerT3 = null, retryTimer = null;

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
  /* 「自由现金流」「300现金流」是因子策略，名字里的「现金」不是现金管理，
     别被下面的 money 规则抓走（会被显示成「货币」，还会被速度榜排除）。 */
  if (n.indexOf('现金流') >= 0 || n.indexOf('自由现金') >= 0) return 'broad';
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

/* 自选分桶用的匿名编号。
   不同的人打开同一个网址，各自有一份，互不覆盖——共用一份的话，
   陌生人一按「+」就把别人的自选改掉了。
   想跨设备带过去：复制页面上「同步」给出的链接（带 ?u=）在另一台打开。 */
var WATCH_UID = (function(){
  var LSK = 'etfUid';
  var u = '';
  try { u = localStorage.getItem(LSK) || ''; } catch (e) {}
  var fromUrl = qs('u');
  if (fromUrl) u = fromUrl;
  u = String(u).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (u.length < 6){
    u = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
  }
  try { localStorage.setItem(LSK, u); } catch (e) {}
  return u;
})();

function watchUrl(){
  return '/api/watch?u=' + encodeURIComponent(WATCH_UID);
}

function saveWatch(){
  try{ localStorage.setItem(LS, JSON.stringify(watch)); }catch(e){}
  pushWatch();
}

function pushWatch(){
  if (!WATCH_CLOUD) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function(){
    fetch(watchUrl(), {
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
  return fetch(watchUrl()).then(function(r){ return r.json(); }).then(function(j){
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
/* 因子公式里有 < > 这类符号，直接塞进 innerHTML 会被当成标签咬掉半截 */
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
  });
}
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
    + (withDel ? '<td class="hide-md t3cell" data-t3="'+x.c+'">'+top3Html(x.c)+'</td>' : '')
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
  // 分类标签上的数量
  ['all','broad','cross','industry','bond','money','commodity'].forEach(function(k){
    var el = document.getElementById('n-'+k);
    if (el) el.textContent = gc[k] || '';
  });
}

/* ================= 自选「主要贡献」 =================
   一行一只 ETF，看得到「涨了 0.8%」，看不到是谁拉的。这一栏补上贡献最大的三只
   成分股——涨的时候看谁在拉，跌的时候看谁在砸。

   按 |贡献| 排、不是只取正贡献：一只跌 1% 的 ETF，列三只红的对它毫无解释力。

   成本：/api/top3 一次最多 10 只，这里按 10 只一批**串行**发。并发发三批会让
   上游同时抓二三十只 PCF，上交所那边会空回复（实测并发 6 只就有失败）。
   自选超过 30 只只算前 30：再往后是长尾，等一屏滚下去时这一列早就不在视野里了。
*/
var TOP3 = {};          // code -> {ok, day, n, ctr, items:[{n,c,w,chg,ctr}]}
var TOP3_SIG = '';      // 上一次请求的自选指纹：列表没变就不重复请求
var TOP3_BUSY = false;

function t3short(n){
  // 超过 6 个字截断：「华夏中证新能源汽车」这种全名会把三只挤成两行
  return (n && n.length > 6) ? n.slice(0, 6) + '…' : (n || '');
}

function top3Html(c){
  var r = TOP3[c];
  if (!r) return '<span class="t3ph">·</span>';
  if (!r.ok || !r.items || !r.items.length) return '<span class="t3ph">-</span>';
  var buf = [];
  for (var i = 0; i < r.items.length; i++){
    var x = r.items[i];
    var v = (Math.abs(x.ctr) < 0.005) ? 0 : x.ctr;
    buf.push('<span class="t3 ' + cc(v) + '" title="' + esc(x.n) + ' ' + esc(x.c)
      + '\u3000权重 ' + x.w.toFixed(2) + '%，今日 ' + (x.chg == null ? '-' : fpc(x.chg))
      + '，贡献 ' + fpt(x.ctr) + ' 个百分点">'
      + esc(t3short(x.n)) + '<em>' + fpt(x.ctr) + '</em></span>');
  }
  return buf.join('');
}

function paintTop3(){
  var cells = document.querySelectorAll('#watchBody td[data-t3]');
  for (var i = 0; i < cells.length; i++){
    var h = top3Html(cells[i].getAttribute('data-t3'));
    if (cells[i].innerHTML !== h) cells[i].innerHTML = h;
  }
}

function runTop3(list){
  if (TOP3_BUSY || !list.length) return;
  TOP3_BUSY = true;
  var i = 0;
  function next(){
    if (i >= list.length){ TOP3_BUSY = false; return; }
    var part = list.slice(i, i + 10);
    i += 10;
    fetch('/api/top3?codes=' + part.join(',')).then(function(r){ return r.json(); })
      .then(function(j){
        if (j && j.rows) for (var c in j.rows) TOP3[c] = j.rows[c];
        paintTop3();
        next();
      })['catch'](function(){ next(); });
  }
  next();
}

function ensureTop3(){
  if (!watch.length) return;
  var list = watch.slice(0, 30);
  var sig = list.join(',');
  if (sig === TOP3_SIG) return;
  TOP3_SIG = sig;
  // 列表变了就整批丢掉：留着旧的会让删掉的代码一直显示、新加的顶着上一只的名字
  TOP3 = {};
  paintTop3();
  runTop3(list);
}

function renderWatch(){
  var body = document.getElementById('watchBody');
  if (!watch.length){
    body.innerHTML = '<tr><td colspan="14" class="empty">还没有自选，点下方榜单的 + 添加</td></tr>';
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
        + '<td class="l" colspan="12" style="color:var(--txt3)">未取到（可能已退市或非场内 ETF）</td>'
        + '<td class="ctr"><span class="act del" data-del="'+c+'">×</span></td></tr>';
      continue;
    }
    html += '<tr class="hr" data-c="' + x.c + '">' + rowHtml(x, true) + '</tr>';
  }
  body.innerHTML = html;
  document.getElementById('watchN').innerHTML = watch.length + ' 只'
    + (miss ? ('，' + miss + ' 只未取到') : '')
    // 贡献列只算前 30 只（后端硬上限 + 上游并发限制），超了要说一声，
    // 否则第 31 行起一直是「-」，看着像坏了
    + (watch.length > 30 ? '<span class="syn" title="「主要贡献」列只算自选的前 30 只（按自选顺序），'
      + '再往后是长尾，滚到那里时这一列早就不在视野里了">贡献列前 30</span>' : '')
    + (WATCH_CLOUD ? '<span class="syn" title="已与云端同步，换设备也是这份列表">云端</span>' : '');
  ensureTop3();
  paintTop3();     // tbody 刚被整块重写，单元格是新的，得重画一遍
  diagSync();
}

/* ================= 位置诊断 =================
   整页唯一不看「今天涨跌」的东西。行情软件告诉你涨了多少，这里回答两个
   行情软件不回答的问题：它现在站在近一年区间的哪个位置、这次上涨是走出来的
   还是震出来的。两个指标都不是现编的，是研究页里穿过样本外检验的那两个：

     RANGE_POS  现价在近 250 日高低区间的百分位（0 = 一年新低，100 = 一年新高）
     PE         20 日净涨幅 ÷ 20 日路径长度。接近 1 是单边拉上去的，接近 0 是
                来回震荡堆出来的——后者量能一旦跟不上，涨幅还回去的速度更快

   量能倍数 = 今日成交量 ÷ 前 20 日均量，判断这个位置有没有人接。
   三者交叉给一个动作标签，标签只是把数字翻成人话，不预测涨跌。
*/
var DIAG = {};        // code -> {ok,pos,pe,r20,evr,d60,vol20,cls,tag,rk,why}
var DIAG_Q = [];      // 待取历史的代码队列
var DIAG_BUSY = 0;
var DIAG_HTML = '';   // 上一次渲染的 HTML：一样就不重写，避免整块闪
var DIAG_MAX = 3;     // 并发上限：一次拉太多会把 /api/hist 打出 429

/* 交易日进度：9:30–11:30 + 13:00–15:00 共 240 分钟。
   盘中拿到的「今日成交额」是半截的，直接和 20 日均额比会系统性偏低，
   早盘十点能显示成「缩量一半」，所以按已交易分钟折算。 */
function dayProgress(){
  var d = new Date(), t = d.getHours() * 60 + d.getMinutes();
  if (t < 570) return 0;
  if (t <= 690) return (t - 570) / 240;
  if (t < 780) return 0.5;
  if (t <= 900) return (120 + (t - 780)) / 240;
  return 1;
}

/* 位置一律以「昨天」为锚：
   区间取到昨天那根为止，今天只用实时价去比。这样昨天位置和今天位置是同一个
   坐标系里的两个点，能直接相减做「今天变了什么」；否则区间跟着今天一起变，
   位置永远在自己的区间里，看不出变化。 */
function diagFrom(raw, it){
  if (!raw || !raw.col || !raw.col.close) return null;
  var cl = raw.col.close, hi = raw.col.high, lo = raw.col.low;
  // 量能用成交额而不是成交量：同一指数换一只 ETF，份额和净值都不同，成交量没法比
  var vo = raw.col.amount || raw.col.volume;
  var n = raw.n, i;
  if (!n || n < 80) return null;

  var td = (function(){ var d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
  // 收盘后 Actions 会把今天写进 .bin，此时最后一根就是今天，锚点要往前挪一根
  var e = (raw.dates && raw.dates[n - 1] === td) ? n - 2 : n - 1;
  if (e < 60) return null;

  var s = Math.max(0, e - 249);
  var hh = -1e18, ll = 1e18;
  for (i = s; i <= e; i++){
    if (hi && hi[i] > hh) hh = hi[i];
    if (lo && lo[i] > 0 && lo[i] < ll) ll = lo[i];
  }
  var cur = (it && it.p > 0) ? it.p : cl[e];
  if (cur > hh) hh = cur;
  if (cur < ll) ll = cur;
  if (!(hh > ll)) return null;
  var pos = (cur - ll) / (hh - ll) * 100;
  var posPrev = (cl[e] - ll) / (hh - ll) * 100;

  var m = Math.min(21, e + 1), path = 0, sq = 0, cnt = 0;
  for (i = e - m + 2; i <= e; i++){
    if (cl[i - 1] > 0){
      var rr = cl[i] / cl[i - 1] - 1;
      path += Math.abs(rr); sq += rr * rr; cnt++;
    }
  }
  if (cl[e] > 0) path += Math.abs(cur / cl[e] - 1);
  var r20 = cl[e - 20] > 0 ? cur / cl[e - 20] - 1 : 0;
  var pe = path > 1e-6 ? Math.max(-1, Math.min(1, r20 / path)) : 0;

  // 20 日均额（到昨天为止），以及昨天的量能倍数
  var sum = 0, k = 0;
  for (i = Math.max(0, e - 19); i <= e; i++){ if (vo && vo[i] > 0){ sum += vo[i]; k++; } }
  var ma = k ? sum / k : 0;
  var evrPrev = (ma > 0 && vo && vo[e] > 0) ? vo[e] / ma : null;
  var evr = evrPrev;
  var pr = dayProgress();
  var liveAmt = (it && it.amt > 0) ? it.amt : null;
  if (liveAmt && pr >= 0.12 && ma > 0) evr = (liveAmt / pr) / ma;

  // 20 日年化波动，只给「震出来的」提供个量化注脚
  var vol20 = cnt > 1 ? Math.sqrt(sq / cnt) * Math.sqrt(252) * 100 : null;

  return { pos:pos, posPrev:posPrev, pe:pe, r20:r20, evr:evr, evrPrev:evrPrev,
           dHi:hh > 0 ? cur / hh - 1 : null, dLo:ll > 0 ? cur / ll - 1 : null,
           vol20:vol20, bars:n, anchor:e, hi:hh, lo:ll };
}

function diagTag(d){
  var pos = d.pos, evr = d.evr;
  if (pos < 20){
    return evr != null && evr >= 1.6
      ? ['低位放量','d2',1,'底部位置突然放量：可能是破位，也可能是启动，先看能不能站住']
      : ['低位缩量','d1',3,'一年来的低位，量能也萎缩：无人问津的位置适合分批，不适合追'];
  }
  if (pos > 80){
    return evr != null && evr >= 1.6
      ? ['高位放量','d4',0,'位置和量能同时到高位：有人在交货，别在这里加']
      : ['高位缩量','d3',2,'位置很高但没量：涨得没人接，追进去容易接最后一棒'];
  }
  return ['中位','d0',4,'位置中性：上下都留得住，等突破或破位再动手'];
}

/* ================= 今日变化 =================
   行情软件的默认视图是「现在是什么样」。真正稀缺的是「相比昨天变了什么」——
   只有变化才对应动作。这里把每只自选今天发生的事抽成一条条事件：
   创一年新高/新低、穿过 80/20 分位、量能突变、贴到新高 1% 以内、溢价异常。
   没事件的标的不出现，页面短下来本身就是信息。 */
function buildEvents(){
  var out = [];
  for (var c in DIAG){
    var d = DIAG[c];
    if (!d || !d.ok) continue;
    var nm = d.n || c, ev = d.evr, ep = d.evrPrev;
    var evs = ev == null ? '-' : ev.toFixed(2);
    var mine = [];
    function add(lv, t, txt){ mine.push({ lv:lv, t:t, s:txt }); }

    if (d.pos >= 99.5 && d.posPrev < 99.5){
      add(3, '创一年新高', '位置 ' + d.pos.toFixed(0) + '%，量能 ×' + evs
        + '。不放量的新高是常态，放量新高反而要防冲高回落');
    } else if (d.posPrev < 80 && d.pos >= 80){
      add(2, '升破 80 分位', '位置从 ' + d.posPrev.toFixed(0) + ' 抬到 ' + d.pos.toFixed(0)
        + '，量能 ×' + evs + '，进入高位区');
    }
    if (d.pos <= 0.5 && d.posPrev > 0.5){
      add(3, '创一年新低', '位置归零，量能 ×' + evs
        + '。新低之后的第一根放量阳线才是信号，别在阴线里接');
    } else if (d.posPrev > 20 && d.pos <= 20){
      add(2, '跌破 20 分位', '位置从 ' + d.posPrev.toFixed(0) + ' 掉到 ' + d.pos.toFixed(0)
        + '，量能 ×' + evs + '，进入低位区');
    }
    if (ev != null && ev >= 2 && (ep == null || ep < 1.4)){
      add(2, '量能 2 倍', '今天成交额是 20 日均额的 ' + ev.toFixed(1) + ' 倍，昨天只有 '
        + (ep == null ? '-' : ep.toFixed(2)) + ' 倍');
    }
    if (ev != null && ev <= 0.55 && ep != null && ep >= 1){
      add(1, '量能腰斩', '量能从 ×' + ep.toFixed(2) + ' 掉到 ×' + ev.toFixed(2) + '，关注度退潮');
    }
    if (d.dHi != null && d.dHi > -0.012 && d.dHi < 0 && d.pos < 99){
      add(1, '贴新高', '还差 ' + Math.abs(d.dHi * 100).toFixed(1) + '% 到一年高点，突破与否是分水岭');
    }
    var it = findItem(c);
    if (it && it.pm != null && Math.abs(it.pm) >= 0.8){
      add(it.pm > 0 ? 2 : 1, (it.pm > 0 ? '溢价 ' : '折价 ') + Math.abs(it.pm).toFixed(2) + '%',
        '价格偏离 IOPV ' + it.pm.toFixed(2) + '%，超过 0.8% 通常是流动性或情绪问题，别当便宜捡');
    }
    if (!mine.length) continue;
    var top = mine[0];
    for (var q = 1; q < mine.length; q++) if (mine[q].lv > top.lv) top = mine[q];
    // 事件多的排前面：同一只身上同时出现两件事，比单件事更值得看
    out.push({ c:c, nm:nm, lv:top.lv, tags:mine.map(function(x){ return x.t; }),
               s:top.s, k:mine.length * 10 + top.lv });
  }
  out.sort(function(a, b){ return b.k - a.k; });
  return out;
}

function renderEvents(){
  var box = document.getElementById('evtList');
  if (!box) return;
  var nEl = document.getElementById('evtN');
  var done = 0;
  for (var c in DIAG) if (DIAG[c] && DIAG[c].ok) done++;
  if (!watch.length){
    box.innerHTML = '<div class="empty">加自选后这里显示每天的变化</div>';
    if (nEl) nEl.textContent = '';
    return;
  }
  if (!done){
    var busy = DIAG_Q.length + DIAG_BUSY;
    box.innerHTML = '<div class="empty">'
      + (busy ? '正在读取历史…' : '历史还没准备好，点右上角「重算」再试一次') + '</div>';
    return;
  }
  var ev = buildEvents();
  if (nEl) nEl.textContent = ev.length ? (ev.length + ' 只有动作') : '无';
  var elSig = document.getElementById('cSig'), elSigs = document.getElementById('cSigs');
  if (elSig){
    elSig.innerHTML = ev.length + '<small>只</small>';
    var tags = {};
    for (var t = 0; t < ev.length; t++){
      for (var u = 0; u < ev[t].tags.length; u++) tags[ev[t].tags[u]] = 1;
    }
    var ks = [];
    for (var kk in tags) ks.push(kk);
    elSigs.textContent = ks.length ? ('今日：' + ks.slice(0, 3).join(' · ')) : '自选里没有值得动手的变化';
  }
  if (!ev.length){
    box.innerHTML = '<div class="eempty">自选里今天没有值得动手的变化。<br>'
      + '<span>' + done + ' 只都在原来位置附近震荡，量能没有突变，也没贴到新高低。</span></div>';
    return;
  }
  var h = '', cap = 6;
  for (var i = 0; i < ev.length && i < cap; i++){
    var e = ev[i], tg = '';
    for (var j = 0; j < e.tags.length; j++) tg += '<span class="ek">' + esc(e.tags[j]) + '</span>';
    h += '<div class="evt lv' + e.lv + '" data-c="' + e.c + '"><i></i><div class="eb">'
      + '<b>' + esc(e.nm) + '</b>' + tg
      + '<div class="es">' + esc(e.s) + '</div></div></div>';
  }
  if (ev.length > cap){
    h += '<div class="es" style="padding:6px 0 0;color:var(--txt3)">还有 ' + (ev.length - cap)
      + ' 只变化更小，没列出来</div>';
  }
  box.innerHTML = h;
}

/* ================= 组合体检 =================
   自选列表看起来是 N 个仓位，实际承担的风险由相关性决定。
   用最近 60 个共同交易日的日收益算两两相关，再用
   n_eff = n / (1 + (n-1)·ρ̄) 折算成「有效独立仓位数」。
   这是全页最不像行情软件的一块：行情软件永远只盯着单只标的。 */
function corrOf(a, b){
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++){ ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var sa = 0, sb = 0, sab = 0, x, y;
  for (i = 0; i < n; i++){
    x = a[i] - ma; y = b[i] - mb;
    sa += x * x; sb += y * y; sab += x * y;
  }
  return (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : 0;
}

function portStats(){
  var codes = [], c;
  for (c in DIAG){ var d = DIAG[c]; if (d && d.ok && d.raw) codes.push(c); }
  if (codes.length < 2) return null;
  var maps = [], common = null, i, j;
  for (i = 0; i < codes.length; i++){
    var raw = DIAG[codes[i]].raw, m = {};
    for (j = 1; j < raw.n; j++){
      var p0 = raw.col.close[j - 1], p1 = raw.col.close[j];
      if (p0 > 0 && p1 > 0) m[raw.dates[j]] = p1 / p0 - 1;
    }
    maps.push(m);
    var ds = [];
    for (var k in m) ds.push(k);
    common = common ? common.filter(function(x){ return m[x] != null; }) : ds;
  }
  common.sort();
  var use = common.slice(-60);
  if (use.length < 20) return null;
  var R = [];
  for (i = 0; i < codes.length; i++){
    var arr = [];
    for (j = 0; j < use.length; j++) arr.push(maps[i][use[j]]);
    R.push(arr);
  }
  var sum = 0, cnt = 0, best = { r:-2, a:'', b:'' }, worst = { r:2, a:'', b:'' };
  for (i = 0; i < codes.length; i++){
    for (j = i + 1; j < codes.length; j++){
      var r = corrOf(R[i], R[j]);
      sum += r; cnt++;
      if (r > best.r) best = { r:r, a:codes[i], b:codes[j] };
      if (r < worst.r) worst = { r:r, a:codes[i], b:codes[j] };
    }
  }
  var avg = cnt ? sum / cnt : 0;
  var neff = codes.length / (1 + (codes.length - 1) * Math.max(0, avg));
  return { n:codes.length, avg:avg, neff:neff, best:best, worst:worst, days:use.length };
}

function renderPort(){
  var box = document.getElementById('portBox');
  if (!box) return;
  var p = portStats();
  if (!p){
    box.innerHTML = '<div class="empty">组合体检需要至少 2 只自选</div>';
    return;
  }
  var an = (findItem(p.best.a) || {}).n || p.best.a;
  var bn = (findItem(p.best.b) || {}).n || p.best.b;
  var wn = (findItem(p.worst.a) || {}).n || p.worst.a;
  var wb = (findItem(p.worst.b) || {}).n || p.worst.b;
  var tone = p.avg >= 0.75 ? '基本在赌同一个方向' : (p.avg >= 0.5 ? '同涨同跌的成分不小' : '分散度还可以');
  var h = '<div class="prow">'
    + '<div><div class="pk">有效独立仓位</div><div class="pv">' + p.neff.toFixed(1)
    + '<small>/ ' + p.n + ' 只</small></div></div>'
    + '<div><div class="pk">平均相关</div><div class="pv">' + p.avg.toFixed(2) + '</div></div>'
    + '</div>'
    + '<div class="pnote">看着是 <b>' + p.n + ' 个仓位</b>，按最近 ' + p.days
    + ' 个交易日的相关性折算，实际只承担了 <b>' + p.neff.toFixed(1) + ' 个</b>仓位的风险，' + tone + '。'
    + '<br>最像的两只：<b>' + esc(an) + '</b> × <b>' + esc(bn) + '</b>，相关 ' + p.best.r.toFixed(2)
    + '；最不像的：<b>' + esc(wn) + '</b> × <b>' + esc(wb) + '</b>，' + p.worst.r.toFixed(2)
    + '，想加分散度往这对的方向找。</div>';
  box.innerHTML = h;
}

/* ================= 全市场异动 =================
   自选是「我关心的」，这一栏是「市场发生了什么」。两者的区别不在于数量，
   而在于**发现**：只看自选，永远只能在自己已经知道的池子里找机会。

   数据来自收盘后算好的快照（alpha/events.py → /api/events），26KB，
   一个指数只留流动性最好的那只 ETF。位置和量能的口径与自选里的诊断完全一致，
   所以两块的数字可以直接横向比较。

   盘中打开时用实时价就地重算位置——快照里带着一年高低点（已换算到原始价格
   尺度），拿实时价一减就得到当下的位置，不用重新拉历史。
*/
var MKT = null, MKT_ERR = '', MKT_TAB = 'all';

/* 顺序即重要性：突破和破位排在量能前面，因为前者有价格确认 */
var MKT_TYPES = [
  ['hi', '创新高'], ['up80', '上穿80'], ['near', '贴新高'],
  ['lo', '创新低'], ['dn20', '跌破20'], ['vol', '放量'], ['dry', '缩量']
];

/* 「全部」把各类型按上面的优先级合并。同一只标的同时创新高又放量时只留一次，
   留的是优先级更高的那条（突破比放量更值得先看）。 */
var MKT_LABEL = {
  hi:['新高', 't-up'], up80:['上穿', 't-up'], near:['贴高', 't-warn'],
  lo:['新低', 't-down'], dn20:['跌破', 't-down'],
  vol:['放量', 't-info'], dry:['缩量', 't-mute']
};

function mktRows(){
  if (!MKT || !MKT.ev) return [];
  if (MKT_TAB !== 'all'){
    var one = MKT.ev[MKT_TAB] || [];
    return one.map(function(r){ return { t:MKT_TAB, r:r }; });
  }
  var seen = {}, out = [];
  for (var i = 0; i < MKT_TYPES.length; i++){
    var k = MKT_TYPES[i][0], arr = MKT.ev[k] || [];
    for (var j = 0; j < arr.length; j++){
      if (seen[arr[j][0]]) continue;
      seen[arr[j][0]] = 1;
      out.push({ t:k, r:arr[j] });
    }
  }
  return out;
}

function mktPos(r){
  /* r = [code,name,idx,pos,posPrev,evr,r20,r1,hh,ll,amt] */
  var hh = r[8], ll = r[9];
  var it = findItem(r[0]);
  var p = it && it.p > 0 ? it.p : null;
  if (p && hh > ll && ll > 0){
    return Math.max(0, Math.min(100, (p - ll) / (hh - ll) * 100));
  }
  return r[3];
}

function mktEvr(r){
  // 盘中用实时成交额重算：快照里的量能是「昨天收盘时」的读数，今天已经变了。
  // 分母（20 日均额）用快照成交额反推，不用再拉数据。
  var it = findItem(r[0]);
  if (it && it.amt > 0 && r[10] > 0 && r[5] > 0){
    var pr = dayProgress();
    if (pr > 0.12 && pr < 1){
      var base = r[10] / r[5];
      if (base > 0) return (it.amt / 1e8) / pr / base;
    }
  }
  return r[5];
}

function mktBar(){
  var b = MKT.breadth, n = b.n || 1;
  var hiPct = b.p80 / n * 100, loPct = b.p20 / n * 100;
  var midPct = Math.max(0, 100 - hiPct - loPct);
  document.getElementById('mktBar').innerHTML =
    '<i style="width:' + hiPct.toFixed(1) + '%;background:#e8a0a0"></i>'
    + '<i style="width:' + midPct.toFixed(1) + '%;background:#dfe4ec"></i>'
    + '<i style="width:' + loPct.toFixed(1) + '%;background:#8fc9ae"></i>';

  /* 位置是 0–100 的百分位刻度，取整显示：小数点后那位（15.8）在这个尺度上
     没有意义，只会让人以为是价格或倍数。和左右两边的「只数」并列时，
     必须把单位写出来才对得上——「中位位置 16%」。
     口径写进 title：不是涨幅、不是价格，是收盘价落在近一年高低区间的第几成。 */
  var w1 = document.getElementById('mktWidth');
  var med = (b.medPos == null || !isFinite(b.medPos)) ? '-' : Math.round(b.medPos) + '%';
  w1.innerHTML = '<span>一年高位 <b>' + b.p80 + '</b> 只</span>'
    + '<span title="全部 ETF 的位置中位数：位置 = (现价 − 近一年最低) ÷ (近一年最高 − 近一年最低)。'
    + '越接近 0% 越贴一年低位，越接近 100% 越贴一年高位">中位位置 <b>'
    + med + '</b></span>'
    + '<span>一年低位 <b>' + b.p20 + '</b> 只</span>';

  var w2 = document.getElementById('mktWidth2');
  w2.innerHTML = '<span>上涨 <b>' + b.up + '</b> · 下跌 <b>' + b.dn + '</b>'
    + (b.flat ? ' · 平 ' + b.flat : '') + '</span>'
    + '<span>合计成交 <b>' + b.amt.toFixed(0) + '</b> 亿</span>';
}

function mktStyle(){
  var box = document.getElementById('mktStyle');
  if (!MKT.style || !MKT.style.length){
    box.innerHTML = '<div class="empty">没有风格数据</div>';
    return;
  }
  var h = '<div class="wstat" style="margin-bottom:6px"><span>风格地图</span>'
    + '<span>位置 / 今日</span></div>';
  for (var i = 0; i < MKT.style.length; i++){
    var g = MKT.style[i];
    h += '<div class="styl"><span class="sk" title="' + esc(g.k) + '">' + esc(g.k) + '</span>'
      + '<div class="sbar"><u style="width:' + Math.max(2, Math.min(100, g.pos)).toFixed(0) + '%"></u></div>'
      + '<span class="sv">' + g.pos.toFixed(0) + '</span>'
      + '<span class="sr ' + cc(g.r1) + '">' + fpc(g.r1) + '</span></div>';
  }
  h += '<div class="mfoot">条形是这一组所有指数的位置中位数。'
    + '一组 70 只全在低位、另一组 49 只在 35，说明钱在往哪儿去——'
    + '单看指数涨跌幅看不出来，因为涨跌幅只反映今天。</div>';
  box.innerHTML = h;
}

function mktList(){
  var box = document.getElementById('mktList');
  var rows = mktRows();
  if (!rows.length){
    box.innerHTML = '<div class="eempty">今天没有这一类事件。<br>'
      + '<span>不是数据没加载，是真的没有——这种日子不用动手。</span></div>';
    return;
  }
  var h = '<div class="mhead"><span>名称 / 跟踪指数</span><span>类型</span>'
    + '<span>位置</span><span>量能</span><span>今日</span></div>';
  var cap = 13;
  for (var i = 0; i < rows.length && i < cap; i++){
    var r = rows[i].r, tg = MKT_LABEL[rows[i].t] || ['', ''];
    var pos = mktPos(r), ev = mktEvr(r);
    // 最后一列放今日涨幅而不是 20 日：这一栏回答的是「今天发生了什么」，
    // 20 日累计放进标题提示，鼠标停上去能看到。
    var tip = r[1] + ' · 20日 ' + fpc(r[6]) + ' · 成交 ' + r[10].toFixed(1) + ' 亿';
    h += '<div class="mrow" data-c="' + r[0] + '" title="' + esc(tip) + '">'
      + '<span class="mn">' + esc(r[1])
      + (r[2] ? '<em>' + esc(r[2]) + '</em>' : '') + '</span>'
      + '<span class="mtag ' + tg[1] + '">' + tg[0] + '</span>'
      + '<span class="mnum">' + pos.toFixed(0) + '</span>'
      + '<span class="mnum">' + (ev == null ? '-' : ev.toFixed(1)) + '</span>'
      + '<span class="mnum ' + cc(r[7]) + '">' + fpc(r[7]) + '</span>'
      + '</div>';
  }
  if (rows.length > cap){
    h += '<div class="mfoot">另有 ' + (rows.length - cap) + ' 只变化更小，没列出来</div>';
  }
  box.innerHTML = h;
}

function mktTabs(){
  var h = '<span class="mtab' + (MKT_TAB === 'all' ? ' on' : '')
    + '" data-t="all">全部<u>' + (MKT ? mktRows().length : 0) + '</u></span>';
  for (var i = 0; i < MKT_TYPES.length; i++){
    var k = MKT_TYPES[i][0];
    var n = (MKT.ev && MKT.ev[k]) ? MKT.ev[k].length : 0;
    h += '<span class="mtab' + (k === MKT_TAB ? ' on' : '') + '" data-t="' + k + '">'
      + MKT_TYPES[i][1] + '<u>' + n + '</u></span>';
  }
  document.getElementById('mktTabs').innerHTML = h;
}

function renderMkt(){
  var nEl = document.getElementById('mktN');
  if (!MKT){
    document.getElementById('mktList').innerHTML =
      '<div class="empty">' + esc(MKT_ERR || '还没有收盘快照，等今晚数据管道跑完') + '</div>';
    document.getElementById('mktStyle').innerHTML =
      '<div class="empty">—</div>';
    document.getElementById('mktTabs').innerHTML = '';
    if (nEl) nEl.textContent = '';
    return;
  }
  mktBar(); mktStyle(); mktTabs(); mktList();
  if (nEl){
    nEl.textContent = MKT.n + ' 个指数 · ' + MKT.date + ' 收盘';
  }
}

function loadMkt(){
  fetch('/api/events').then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.ok === false) throw new Error((j && j.error) || '没有数据');
    MKT = j; MKT_ERR = '';
    renderMkt();
  }).catch(function(e){
    MKT = null; MKT_ERR = (e && e.message) || '读取失败';
    renderMkt();
  });
}

function mktInit(){
  var t = document.getElementById('mktTabs');
  if (t){
    t.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== t && !el.getAttribute('data-t')) el = el.parentNode;
      if (!el || el === t) return;
      MKT_TAB = el.getAttribute('data-t');
      mktTabs(); mktList();
    });
  }
  var l = document.getElementById('mktList');
  if (l){
    l.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== l && !el.getAttribute('data-c')) el = el.parentNode;
      if (!el || el === l) return;
      var c = el.getAttribute('data-c');
      var nm = '', rs = mktRows();
      for (var i = 0; i < rs.length; i++){
        if (rs[i].r[0] === c){ nm = rs[i].r[1]; break; }
      }
      openHist(c, nm || c);
    });
  }
  var b = document.getElementById('btnMkt');
  if (b) b.addEventListener('click', function(){ toast('正在重读快照…'); loadMkt(); });
  loadMkt();
}

function diagCard(code){
  var d = DIAG[code], it = findItem(code);
  var nm = esc((it && it.n) || (d && d.n) || code);
  if (!d || !d.ok){
    return '<div class="dcard pend" data-c="' + code + '">'
      + '<div class="dtop"><span class="dn">' + nm + '</span><span class="dc">' + code + '</span>'
      + '<span class="dtag d0">' + (d && d.err ? '无数据' : '计算中') + '</span></div>'
      + '<div class="posbar"></div><div class="poslb"><span>'
      + esc((d && d.err) || '读取历史…') + '</span></div></div>';
  }
  var w = Math.max(0, Math.min(100, d.pos));
  var peTxt = d.pe >= 0.45 ? '单边拉上来的' : (d.pe <= 0.15 ? '来回震出来的' : '涨跌交错堆的');
  return '<div class="dcard" data-c="' + code + '">'
    + '<div class="dtop"><span class="dn">' + nm + '</span><span class="dc">' + code + '</span>'
    + '<span class="dtag ' + d.cls + '">' + d.tag + '</span></div>'
    + '<div class="posbar"><u style="width:' + w.toFixed(1) + '%"></u>'
    + '<i style="left:' + w.toFixed(1) + '%"></i></div>'
    + '<div class="poslb"><span>低</span><span class="pz">' + d.pos.toFixed(0)
    + '<em>位置</em></span><span>高</span></div>'
    + '<div class="dchips">'
    + '<span class="dchip">量能 <b>' + (d.evr == null ? '-' : '×' + d.evr.toFixed(2)) + '</b></span>'
    + '<span class="dchip">20日 <b class="' + cc(d.r20) + '">' + fpc(d.r20 * 100) + '</b></span>'
    + '<span class="dchip">距高点<b>' + (d.dHi == null ? '-' : fpc(d.dHi * 100)) + '</b></span>'
    + '<span class="dchip">距低点<b>' + (d.dLo == null ? '-' : fpc(d.dLo * 100)) + '</b></span>'
    + '</div>'
    + '<div class="dwhy">' + d.why + '；' + peTxt + '（路径效率 ' + d.pe.toFixed(2) + '）。</div>'
    + '</div>';
}

function renderDiag(){
  var g = document.getElementById('diagGrid');
  if (!g) return;
  var nEl = document.getElementById('diagN');
  if (!watch.length){
    g.innerHTML = '<div class="empty">还没有自选，加了之后这里自动诊断</div>';
    if (nEl) nEl.textContent = '';
    return;
  }
  var cnt = {d0:0,d1:0,d2:0,d3:0,d4:0}, have = 0, list = [], i;
  for (i = 0; i < watch.length; i++){
    var d = DIAG[watch[i]];
    if (d && d.ok){ have++; if (cnt[d.cls] != null) cnt[d.cls]++; }
    list.push(watch[i]);
  }
  list.sort(function(a, b){
    var A = DIAG[a], B = DIAG[b];
    var ra = A && A.ok ? A.rk : 9, rb = B && B.ok ? B.rk : 9;
    if (ra !== rb) return ra - rb;
    return (B && B.ok ? B.pos : 0) - (A && A.ok ? A.pos : 0);
  });
  var html = '';
  for (i = 0; i < list.length; i++) html += diagCard(list[i]);
  if (html !== DIAG_HTML){ DIAG_HTML = html; g.innerHTML = html; }
  renderEvents();
  renderPort();
  if (nEl){
    var p = [];
    if (cnt.d4) p.push(cnt.d4 + ' 只高位放量');
    if (cnt.d3) p.push(cnt.d3 + ' 只高位缩量');
    if (cnt.d2) p.push(cnt.d2 + ' 只低位放量');
    if (cnt.d1) p.push(cnt.d1 + ' 只低位缩量');
    nEl.textContent = have + '/' + watch.length + ' 只已诊断'
      + (p.length ? ' · ' + p.join(' · ') : '');
  }
}

function diagFetch(code){
  DIAG_BUSY++;
  DIAG[code] = { ok:false };
  fetch('/api/hist?code=' + code).then(function(r){
    var ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('json') >= 0){
      return r.json().then(function(j){ throw new Error(j.error || '没有历史'); });
    }
    return r.arrayBuffer();
  }).then(function(buf){
    var raw = parseHist(buf);
    var it = findItem(code);
    var d = diagFrom(raw, it);
    if (!d) throw new Error('历史不足 60 根');
    var tg = diagTag(d);
    d.ok = true; d.c = code; d.n = (it && it.n) || raw.code || code;
    d.cls = tg[1]; d.tag = tg[0]; d.rk = tg[2]; d.why = tg[3];
    d.raw = raw;                       // 存原始序列：下一次行情刷新就地重算，不再请求
    DIAG[code] = d;
  }).catch(function(e){
    DIAG[code] = { ok:false, c:code, err:(e && e.message) || '读取失败' };
  }).then(function(){
    DIAG_BUSY--; renderDiag(); diagPump();
  });
}

function diagPump(){
  while (DIAG_BUSY < DIAG_MAX && DIAG_Q.length) diagFetch(DIAG_Q.shift());
}

/* 行情每 60 秒刷一次，位置要跟着走。历史已经在手上，重算只是几次浮点运算 */
function diagReprice(){
  for (var c in DIAG){
    var d = DIAG[c];
    if (!d || !d.ok || !d.raw) continue;
    var it = findItem(c);
    var nd = diagFrom(d.raw, it);
    if (!nd) continue;
    var tg = diagTag(nd);
    nd.ok = true; nd.c = c; nd.n = d.n; nd.raw = d.raw;
    nd.cls = tg[1]; nd.tag = tg[0]; nd.rk = tg[2]; nd.why = tg[3];
    DIAG[c] = nd;
  }
}

/* 自选变化时补算：已经在 DIAG 里的不重复拉，历史走边缘缓存，第二次几乎瞬时 */
function diagSync(){
  diagReprice();
  for (var i = 0; i < watch.length; i++){
    var c = watch[i];
    if (!DIAG[c] && DIAG_Q.indexOf(c) < 0) DIAG_Q.push(c);
  }
  renderDiag();
  diagPump();
}

function diagInit(){
  var g = document.getElementById('diagGrid');
  if (g){
    g.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== g && !el.getAttribute('data-c')) el = el.parentNode;
      if (!el || el === g) return;
      var c = el.getAttribute('data-c');
      var it = findItem(c);
      openHist(c, (it && it.n) || c);
    });
  }
  var ev = document.getElementById('evtList');
  if (ev){
    ev.addEventListener('click', function(e){
      var el = e.target;
      while (el && el !== ev && !el.getAttribute('data-c')) el = el.parentNode;
      if (!el || el === ev || !el.getAttribute('data-c')) return;
      var c = el.getAttribute('data-c');
      var it = findItem(c);
      openHist(c, (it && it.n) || c);
    });
  }
  var b = document.getElementById('btnDiag');
  if (b){
    b.addEventListener('click', function(){
      DIAG = {}; DIAG_Q = []; DIAG_HTML = '';
      renderDiag(); diagSync();
      toast('已清缓存，重新读历史');
    });
  }
  diagSync();
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

/* ================= 急涨急跌 =================
   为什么自己算，不用现成的涨速字段：
   - 东财 f22 就是涨速，但 push2 / push2his 这条线在沙箱和 Worker 两侧都是
     TLS 握手完成后空响应，整条链路不可用（见 README 的分时一节）；
   - 新浪排行接口 sort=speed 不生效——传 changepercent 能正确排序，传 speed
     返回的还是代码序，说明它根本不认这个字段。
   所以回到最原始的口径：拿分钟线，自己回溯。

   为什么池子只有 40 只：
   涨速要逐只拉分时，一只一个子请求。Cloudflare 免费计划每请求上限 50 个，
   服务端截到 48，前端主动取 40 留余量。按成交额取，是因为涨速榜的意义是
   「有机会下手的标的在动」——成交额小的票就算 3 分钟拉 3%，也成交不了。
   同指数去重照旧：三只 A500 一起涨，占三个坑没有任何信息量。
*/

var SPD = { rows: [], w: 3, volOnly: false, ts: 0, ms: 0, ask: 0, err: '', loading: false };
var SPD_POOL_MAX = 40;
var SPD_VOL_HOT = 1.5;         // 量比到这个倍数算「放量」
var SPD_SHOW = 5;              // 每边显示几只
/* 现金管理类日内振幅常年 0.0x%，挤进榜只会稀释信号。group() 已经把它们
   归到 money/bond，这里再按名称兜一道——有些短融 ETF 名称不带「货币」二字，
   被分到了 industry，漏进池子就会一直霸占榜首（实测 551550、511150 都这样）。
   「现金」要排除「现金流」：那是因子策略，日内波动正常，不该被挡。 */
var SPD_SKIP = /短融|货币|日利|添益|现金(?!流)|理财|保证金|快线/;

function spdPool(){
  if (!DATA.length) return [];
  var out = [], seen = {}, i, c, it;
  function push(code){
    if (seen[code] || out.length >= SPD_POOL_MAX) return;
    seen[code] = 1; out.push(code);
  }
  function usable(x){
    return x && x.amt > 0 && x.g !== 'bond' && x.g !== 'money' && !SPD_SKIP.test(x.n);
  }

  /* 自选优先。盯盘时最先想知道的是自己手里那几只有没有突然动起来，
     而它们大半不在成交额前 40（比如一只 8 亿的行业 ETF）。
     用户主动加的债券/货币类仍然剔掉——那类涨速恒为 0.00%，占位没意义。 */
  for (i = 0; i < watch.length; i++){
    c = watch[i];
    it = findItem(c);
    // 快照里查不到（新上市、停牌）也照样试一次，服务端拿不到会滤掉
    if (it ? usable(it) : true) push(c);
  }

  var arr = [];
  for (i = 0; i < DATA.length; i++) if (usable(DATA[i])) arr.push(DATA[i]);
  // KEEP 表要等指数映射加载完才有；没加载时 !KEEP[ix] 为真，等于不去重，
  // 比「把同指数的票全藏掉」安全
  if (DEDUP){
    arr = arr.filter(function(x){ return !x.ix || !KEEP[x.ix] || KEEP[x.ix] === x.c; });
  }
  arr.sort(function(a, b){ return b.amt - a.amt; });
  for (i = 0; i < arr.length; i++) push(arr[i].c);
  return out;
}

function spdFetch(force){
  var pool = spdPool();
  if (!pool.length){
    // 池子是从全市场快照里挑的。快照没到（或挂了）就一直「读取中」，
    // 那块地方看起来像卡死，得说清楚卡在哪一步
    if (!DATA.length && !SPD.err){
      SPD.err = '全市场快照还没到，涨速榜要等它先选出活跃池';
      renderSpeed();
    }
    return;
  }
  if (SPD.loading) return;
  SPD.loading = true;
  var url = '/api/speed?codes=' + pool.join(',') + (force ? '&f=' + Date.now() : '');
  fetch(url).then(function(r){ return r.json(); }).then(function(j){
    SPD.loading = false;
    if (!j || !j.ok){ SPD.err = (j && j.error) || '读取失败'; renderSpeed(); return; }
    SPD.rows = j.rows || [];
    SPD.err = '';
    SPD.ts = Date.now();
    SPD.ms = j.ms || 0;
    SPD.ask = j.ask || 0;
    renderSpeed();
  }).catch(function(e){
    SPD.loading = false;
    SPD.err = '网络错误：' + (e.message || e);
    renderSpeed();
  });
}

/* 最后一根停在 15:00 就是收完了。盘中 14:59:xx 时最后一根还是 14:59，
   所以这个判据不会提前把运行中的行情判成收盘。 */
function spdClosed(){
  return !!(SPD.rows.length && SPD.rows[0].t >= '15:00');
}

function spdPct(v){
  if (v == null || !isFinite(v)) return '-';
  // 一律两位：混着 0.15% 和 0.082% 排一列，眼睛没法比大小
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

/* 迷你线：横轴是当日 9:30 至今的完整分时，与「涨速」的窗口不是一回事，所以颜色
   按窗口方向给、形状按全天给——「上午冲高、午后一路阴跌、最后两分钟拉起来」这种
   形态，只有拉长到全天才看得见。颜色硬编码是因为 SVG 的 stroke 属性不吃 CSS 变量
   （--up/--down 改主题时这里要跟着改）。

   纵向尺度是这一栏最容易画错的地方。原先每行按自己的 min/max 拉满，结果
   0.18% 的横盘和 0.45% 的急拉画出来一样高、一样陡——一列全是同形状的锯齿，
   看起来「比例很怪」，而且丢掉了「动得多不多」这个信息。
   现在：
   - 中线 = 今开价，虚线画出来当基准，「贴着中线 = 全天就在开盘价附近磨」；
   - 全池共用一把尺子（spdScale），幅度按同一比例换算，行与行之间可比；
   - 超尺的顶到边，短的自然就矮——10 只里谁走得最远一眼能排出来。 */
function spdSpark(vals, up, sc){
  // vals 是相对今开的百分比：0 就是今开，中线画在那儿
  if (!vals || vals.length < 3) return '<span class="spk"></span>';
  var w = 88, h = 24, pad = 3, i;
  // sc 是全池统一幅度（百分比），缺省 0.8% 不至于把线画成一条直杠
  var rng = sc > 0 ? sc : 0.8;
  var mid = h / 2, half = mid - pad, d = '';
  for (i = 0; i < vals.length; i++){
    var x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    var y = mid - (vals[i] / rng) * half;
    if (y < pad) y = pad;
    if (y > h - pad) y = h - pad;
    d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  // 2px 虚线基准线：没有它，「线偏上还是偏下」就没有参照，读起来还是怪
  return '<svg class="spk" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<line x1="' + pad + '" y1="' + mid + '" x2="' + (w - pad) + '" y2="' + mid
    + '" stroke="#bfc8d4" stroke-width="1" stroke-dasharray="2.5 2.5"/>'
    + '<path d="' + d + '" fill="none" stroke="' + (up ? '#d93a3a' : '#0e9a61')
    + '" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

/* 全池共用一把纵向尺子：取每只「当日相对今开最大偏离（%）」的 65 分位。
   0.3% 是下限（那种一根直线的心电图没必要占满），3% 是上限（有一只暴涨
   时不至于把其余 39 只全压成直线）。分位从 75 降到 65 是配合全天窗口调的：
   20 分钟窗口里大家的振幅都在 0.3%~0.5%，75 分位正好把线铺满；拉到全天之后
   振幅差得远（题材 ETF 3%、宽基 0.8%），75 分位会把大半的线压成矮墩墩一条，
   降到 65 让多数线用掉六七成高度，代价是四分之一的线会顶到框边——顶边本身
   也是信息（「这只今天动得比同类猛」）。 */
function spdScale(rows){
  var a = [], i, j, pv, m, dv;
  for (i = 0; i < rows.length; i++){
    pv = rows[i].pv;
    if (!pv || pv.length < 3) continue;
    m = 0;
    for (j = 0; j < pv.length; j++){
      dv = Math.abs(pv[j]);
      if (dv > m) m = dv;
    }
    if (m > 0) a.push(m);
  }
  if (!a.length) return 0.8;
  a.sort(function(x, y){ return x - y; });
  var q = a[Math.min(a.length - 1, Math.floor(a.length * 0.65))];
  return Math.min(3, Math.max(0.3, q));
}

function renderSpeed(){
  var box = document.getElementById('spdGrid');
  var note = document.getElementById('spdNote');
  var nEl = document.getElementById('spdN');
  if (!box) return;

  if (SPD.err){
    box.innerHTML = '<div class="empty">' + SPD.err + '</div>';
    if (note) note.textContent = '';
    if (nEl) nEl.textContent = '';
    return;
  }
  if (!SPD.rows.length){
    box.innerHTML = '<div class="empty">还没有数据</div>';
    return;
  }

  var kR = SPD.w === 5 ? 'r5' : 'r3';
  var kQ = SPD.w === 5 ? 'q5' : 'q3';
  var up = [], dn = [], i, r, v, q;
  for (i = 0; i < SPD.rows.length; i++){
    r = SPD.rows[i];
    v = r[kR];
    if (v == null || !isFinite(v)) continue;
    q = r[kQ];
    if (SPD.volOnly && !(q >= SPD_VOL_HOT)) continue;
    (v >= 0 ? up : dn).push({ r: r, v: v, q: q });
  }
  up.sort(function(a, b){ return b.v - a.v; });
  dn.sort(function(a, b){ return a.v - b.v; });
  // 尺子按整个池子算，不按这两栏算：左右两栏、切换 3/5 分钟都得同一把尺，
  // 否则「急涨第一名」和「急跌第一名」的波形幅度没法放在一起看
  var SC = spdScale(SPD.rows);

  function rowHtmlOf(o){
    var x = o.r, it = findItem(x.c);
    var nm = it ? it.n : x.c;
    var hot = o.q >= SPD_VOL_HOT;
    // sp 和标称窗口差得多就标 ~：可能是数据缺口把基准推远了（尾盘 14:56
    // 直接跳 15:00，3 分钟实际跨了 4 分钟），也可能是午后刚开盘窗口还没走满
    var far = Math.abs(x.sp - SPD.w) >= 2;
    return '<div class="spdrow" data-c="' + x.c + '">'
      + '<div class="spdnm" title="' + nm + '  ' + x.c + '">'
        + '<span class="nmx">' + nm + '</span><em>' + x.c + '</em></div>'
      + spdSpark(x.pv, o.v >= 0, SC)
      + '<div class="spdv" style="color:' + (o.v >= 0 ? 'var(--up)' : 'var(--down)') + '">'
        + (far ? '~' : '') + spdPct(o.v) + '</div>'
      + '<div class="spdq' + (hot ? ' hot' : '') + '" title="量比：最近 ' + SPD.w
        + ' 分钟每分钟成交量 ÷ 此前 30 分钟每分钟成交量">'
        + (o.q > 0 ? o.q.toFixed(1) + '×' : '-') + '</div>'
      + '</div>';
  }

  function colHtmlOf(list, dir){
    var buf = [], n = Math.min(list.length, SPD_SHOW);
    for (var j = 0; j < n; j++) buf.push(rowHtmlOf(list[j]));
    if (!n) buf.push('<div class="spdnone">'
      + (SPD.volOnly ? '没有量比 ≥ ' + SPD_VOL_HOT + ' 倍的标的' : '暂无数据') + '</div>');
    return '<div class="spdcol">'
      + '<div class="spdch"><b class="' + (dir > 0 ? 'up' : 'dn') + '">'
      + (dir > 0 ? '急涨 ↑' : '急跌 ↓') + '</b><span>'
      + list.length + ' 只' + (list.length > n ? '，显示前 ' + n : '') + '</span></div>'
      + buf.join('') + '</div>';
  }

  box.innerHTML = colHtmlOf(up, 1) + colHtmlOf(dn, -1);

  // 数据时点用分时最后一根的时间，不用本地时钟：一个显示「刚刚」，另一个
  // 显示「15:00」，用户才知道这是不是实时的
  var t = SPD.rows[0].t || '';
  var when = SPD.ts ? new Date(SPD.ts) : null;
  var hhmm = when ? ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2) + ':'
    + ('0' + when.getSeconds()).slice(-2) : '-';
  if (nEl){
    // 手机上这一行会把「急涨急跌」标题挤到第二行，所以只留最要紧的两个数
    nEl.innerHTML = '有效 ' + SPD.rows.length + ' 只 · 数据时点 ' + t
      + '<span class="hide-sm"> · 扫描 ' + SPD.ask + ' 只 · 算于 ' + hhmm
      + (SPD.ms ? '（' + SPD.ms + 'ms）' : '') + '</span>';
  }
  if (note){
    // 「收盘了没有」按分时最后一根判断，不能复用 isOpen()——那个函数为了
    // 让收盘后的快照继续刷新，一直算到 16:10，拿它当收盘标志会晚一个多小时
    note.innerHTML = '池子 = 自选 + 当日成交额靠前的 ETF，同指数只留一只。'
      + '量比 = 最近 ' + SPD.w + ' 分钟每分钟量 ÷ 此前 30 分钟每分钟量，'
      + '到 <b>' + SPD_VOL_HOT + '×</b> 标黄。收盘集合竞价那根按 4 分钟折算，'
      + '否则尾盘会凭空多出十倍放量。'
      + '小走势线是<b>当日 9:30 至今</b>的分时，虚线是今开——'
      + '线在虚线上方就是全天在水面之上，最后那一下拉升也能看出是从哪儿起来的。'
      + (spdClosed() ? '<br>已收盘：这里是<b>今天最后几分钟</b>的涨速，明天 9:30 才重新走动。' : '');
  }
}

Array.prototype.forEach.call(document.querySelectorAll('#spdTabs .mtab[data-w]'), function(t){
  t.onclick = function(){
    var w = +t.getAttribute('data-w');
    if (w === SPD.w) return;
    SPD.w = w;
    Array.prototype.forEach.call(document.querySelectorAll('#spdTabs .mtab[data-w]'), function(x){
      x.classList.toggle('on', x === t);
    });
    renderSpeed();
  };
});
(function(){
  var vol = document.getElementById('spdVol');
  if (!vol) return;
  vol.onclick = function(){
    SPD.volOnly = !SPD.volOnly;
    vol.classList.toggle('on', SPD.volOnly);
    renderSpeed();
  };
})();
(function(){
  var b = document.getElementById('btnSpd');
  if (b) b.onclick = function(){ spdFetch(true); };
  var g = document.getElementById('spdGrid');
  if (g) g.addEventListener('click', function(e){
    var row = e.target.closest ? e.target.closest('.spdrow[data-c]') : null;
    if (!row) return;
    var c = row.getAttribute('data-c');
    var it = findItem(c);
    openHist(c, it ? it.n : c);
  });
})();

/* ================= 历史 K 线面板 =================
   数据来自 R2 上的精简二进制（近 500 天 × 17 字段），Worker 只做透传。
   为什么不在 Worker 里解 Parquet：单只 2.27MB / 165 列，光 zstd 解压
   就要几百毫秒，免费版只有 10ms CPU。所以解析全部放在这里。

   画图用原生 canvas，不引图表库——一个 K 线面板带 3 个子图，
   引库要多 100KB+，还得跟着库的版本走。 */

var HC = {
  up:'#d93a3a', dn:'#0e9a61', ma20:'#d68910', ma60:'#4c8dff',
  grid:'#e9ecf1', axis:'#939aa7', cross:'#8b93a1', vol:'#dfe4ec', rsi:'#7c5cd6',
  boll:'#98a3b5'
};

var H = {
  code:'', name:'', d:null, range:250, hover:-1, ok:false,
  sub:'rsi', ov:{ ma:true, boll:false },
  cv:null, ctx:null, off:null, octx:null,
  W:0, Ht:0, dpr:1, geo:null,
  mode:'min', m:null, mgeo:null, holdAll:false, hj:null
};
/* 默认分时：点开一只标的，第一反应是「今天怎么了」，而不是「过去一年怎么样」。
   用户手动切过就记住——K 线是深度分析时才会进的门。 */
try {
  var _hmode = localStorage.getItem('etf_hmode');
  if (_hmode === 'k' || _hmode === 'min' || _hmode === 'hold') H.mode = _hmode;
} catch (e) { /* 隐私模式下 localStorage 会抛 */ }

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

/* ================= 当日补丁：把今天接成最后一根 K 线 =================
   .bin 由 Actions 每天 16:35 生成，盘中打开时最后一根永远是昨天——
   盯盘最需要看的「今天」反而没有，副图指标也停在昨天。
   这里把实时快照接成最后一根，指标从完整序列重算到该点。

   算法必须与 alpha/indicators.py 严格对齐，否则接出来的今天会和
   明天 Actions 跑完的值对不上，图上看起来就是最后一根莫名跳一下：
     · EMA：pandas ewm(adjust=False)，alpha = 2/(n+1)，首个有效值即起点
     · RSI / ATR：Wilder 平滑，alpha = 1/n
     · 布林带：样本标准差（ddof=1），与 pandas rolling.std() 默认一致
     · 均线/量比/波动率：rolling 窗口，min_periods = 窗口长度
*/

function hMeanEnd(a, end, n){
  var from = end - n + 1;
  if (from < 0) return NaN;
  var s = 0;
  for (var i = from; i <= end; i++){
    if (!isFinite(a[i])) return NaN;   // min_periods=n：窗口内有一个 NaN 就整体 NaN
    s += a[i];
  }
  return s / n;
}

function hStdEnd(a, end, n){
  var m = hMeanEnd(a, end, n);
  if (!isFinite(m)) return NaN;
  var s = 0, from = end - n + 1;
  for (var i = from; i <= end; i++){ var d = a[i] - m; s += d * d; }
  return Math.sqrt(s / (n - 1));
}

/* adjust=False 的 EMA 全序列。NaN 位置沿用前值，与 pandas 行为一致。 */
function hEmaArr(a, n){
  var al = 2 / (n + 1), e = NaN, out = new Float64Array(a.length);
  for (var i = 0; i < a.length; i++){
    var v = a[i];
    if (isFinite(v)) e = isFinite(e) ? al * v + (1 - al) * e : v;
    out[i] = e;
  }
  return out;
}

/* Wilder 平滑的末值（alpha = 1/n）。RSI 的 up/dn 两路、ATR 的 TR 都用它。 */
function hWilderLast(a, n){
  var al = 1 / n, e = NaN;
  for (var i = 0; i < a.length; i++){
    var v = a[i];
    if (!isFinite(v)) continue;
    e = isFinite(e) ? al * v + (1 - al) * e : v;
  }
  return e;
}

function hCalcLast(d, it){
  var n = d.n, N = n + 1, i, p = it.p;
  var C = new Float64Array(N), Hh = new Float64Array(N),
      Ll = new Float64Array(N), V = new Float64Array(N);
  for (i = 0; i < n; i++){
    C[i] = d.col.close[i]; Hh[i] = d.col.high[i];
    Ll[i] = d.col.low[i];  V[i] = d.col.volume[i];
  }
  C[n] = p;
  Hh[n] = (it.hi > 0) ? it.hi : p;
  Ll[n] = (it.lo > 0) ? it.lo : p;

  /* 成交额/均价近似成交量。东财的 f5 是「手」、新浪的 volume 是「份」，
     两个源单位不一致，直接用会让柱子差 100 倍；成交额两边都是元，
     除一个当日均价就统一到「份」，误差 0.2% 以内。 */
  var vwap = (it.hi > 0 && it.lo > 0) ? (it.hi + it.lo + p) / 3 : p;
  V[n] = (it.amt > 0 && vwap > 0) ? it.amt / vwap : NaN;

  var row = {
    open: (it.op > 0) ? it.op : p, high: Hh[n], low: Ll[n], close: p,
    volume: V[n], amount: it.amt, adj_ratio: 1,
  };

  row.ma20 = hMeanEnd(C, n, 20);
  row.ma60 = hMeanEnd(C, n, 60);

  var sd = hStdEnd(C, n, 20);
  row.boll_up = isFinite(sd) ? row.ma20 + 2 * sd : NaN;
  row.boll_low = isFinite(sd) ? row.ma20 - 2 * sd : NaN;

  // RSI14：pandas 的 diff 首行是 NaN，所以从 1 开始
  var up = new Float64Array(N), dn = new Float64Array(N);
  for (i = 1; i < N; i++){
    var df = C[i] - C[i - 1];
    up[i] = df > 0 ? df : 0;
    dn[i] = df < 0 ? -df : 0;
  }
  var au = hWilderLast(up, 14), ad = hWilderLast(dn, 14);
  row.rsi14 = (au + ad > 0) ? 100 * au / (au + ad) : NaN;

  // MACD：DIF = EMA12 − EMA26，DEA = EMA9(DIF)，柱 = 2×(DIF−DEA)（国内惯例）
  var e12 = hEmaArr(C, 12), e26 = hEmaArr(C, 26);
  var dif = new Float64Array(N);
  for (i = 0; i < N; i++) dif[i] = e12[i] - e26[i];
  var dea = hEmaArr(dif, 9);
  row.macd_dif = dif[n];
  row.macd_dea = dea[n];

  // ATR14
  var tr = new Float64Array(N);
  for (i = 0; i < N; i++){
    tr[i] = Hh[i] - Ll[i];
    if (i > 0 && isFinite(C[i - 1])){
      var d1 = Math.abs(Hh[i] - C[i - 1]), d2 = Math.abs(Ll[i] - C[i - 1]);
      if (d1 > tr[i]) tr[i] = d1;
      if (d2 > tr[i]) tr[i] = d2;
    }
  }
  row.atr14 = hWilderLast(tr, 14);

  // 年化历史波动率（%）
  var r = new Float64Array(N);
  for (i = 1; i < N; i++) r[i] = (C[i - 1] > 0) ? C[i] / C[i - 1] - 1 : NaN;
  var rsd = hStdEnd(r, n, 20);
  row.hvol20 = isFinite(rsd) ? 100 * rsd * Math.sqrt(244) : NaN;

  var vm = hMeanEnd(V, n, 5);
  row.vol_ratio5 = (isFinite(vm) && vm > 0) ? V[n] / vm : NaN;

  return row;
}

function hYmd(dt){
  return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
}

function hDayDiff(a, b){
  var da = Date.UTC(Math.floor(a / 10000), Math.floor(a / 100) % 100 - 1, a % 100);
  var db = Date.UTC(Math.floor(b / 10000), Math.floor(b / 100) % 100 - 1, b % 100);
  return Math.round((db - da) / 86400000);
}

function hPatchToday(d, it){
  if (!d || !d.n) return null;
  var dt = new Date(), today = hYmd(dt);
  var last = d.dates[d.n - 1];
  if (today <= last) return null;                     // 历史里已经有今天
  if (!it || !(it.p > 0) || !(it.amt > 0)) return null; // 未开盘 / 停牌 / 休市
  var dow = dt.getDay();
  if (dow === 0 || dow === 6) return null;            // 周末兜底（休市时成交额为 0 已挡住）
  if (hDayDiff(last, today) > 10) return null;        // 数据太久没更新，硬接会留下大段空洞

  var row = hCalcLast(d, it);
  var n = d.n + 1, k;
  var dates = new Int32Array(n);
  dates.set(d.dates, 0);
  dates[n - 1] = today;

  var col = {};
  for (k in d.col){
    var src = d.col[k], a = new Float32Array(n);
    a.set(src, 0);
    var v = row[k];
    a[n - 1] = (v != null && isFinite(v)) ? v : NaN;
    col[k] = a;
  }
  return { code: d.code, n: n, dates: dates, col: col, ext: 1 };
}

/* 今日那根的说明文案。刷新节奏写进文案里，免得看的人猜它到底会不会动。 */
function hExtNote(){
  return '最后一根为今日行情（交易时段每 60 秒跟随最新快照重算），'
    + '技术指标已按今日价格重算。';
}

/* 弹窗打开期间跟随行情刷新
   ---------------------------------------------------------------
   原来只在 openHist 里补一次今天，页面每 60 秒刷的是列表和卡片，
   弹窗里那根 K 线就停在打开那一刻——文案却写着「会随实时价跳动」。
   这里基于 H.raw（打开时取到的原始历史）重算，所以刷多少次都只有一根今天：
   每次都是从同一份 500 根重来，不会累积成 502、503 根。

   快照暂时补不上时（东财限流导致缺成交额、或停牌）保持原图不动——
   宁可显示上一次的值，也不要让已经画上的今天忽隐忽现。 */
function hRefresh(){
  var mask = document.getElementById('histMask');
  if (!mask || !mask.classList.contains('on')) return;   // 弹窗没开，白算
  if (!H.raw || !H.code || !H.ok) return;

  var it = findItem(H.code);
  if (!it || !(it.p > 0)) return;

  var ext = hPatchToday(H.raw, it);
  if (!ext && H.ext) return;          // 这一轮补不上，保留上一轮的今日 K 线
  H.d = ext || H.raw;
  H.ext = !!ext;

  var px = document.getElementById('hPx');
  if (px) px.textContent = fnum(it.p, 3);
  var ch = document.getElementById('hChg');
  if (ch){ ch.textContent = fpc(it.chg); ch.className = 'ch ' + cc(it.chg); }

  hDraw();
  hLegend(H.hover);
  var note = hAdjNote();
  if (ext) note = (note ? note + ' ' : '') + hExtNote();
  document.getElementById('hNote').textContent = note;
}

/* 分时 / K线 / 成分 切换。force=true 表示「模式没变也要重新加载」——
   新点开一只标的时必须走这条路，否则会因为模式相同而什么都不做，图停在上一只。 */
var holdTimer = null;
function setHMode(m, force){
  m = (m === 'k' || m === 'hold') ? m : 'min';
  if (!force && H.mode === m) return;
  H.mode = m;
  try { localStorage.setItem('etf_hmode', m); } catch (e) {}
  Array.prototype.forEach.call(document.querySelectorAll('#hMode b'), function(b){
    b.classList.toggle('on', b.getAttribute('data-m') === m);
  });
  var isK = m === 'k', isMin = m === 'min', isHold = m === 'hold';
  // 副图/叠加/周期条只对 K 线有意义，分时和成分都没有它们
  document.getElementById('hSbar').style.display = isK ? '' : 'none';
  document.getElementById('hTabs').style.display = isK ? '' : 'none';
  // 画布与它下面那几块（图例/指标卡/备注）在成分档整体让位给表格
  document.getElementById('histCv').style.display = isHold ? 'none' : '';
  document.getElementById('hLeg').style.display = isHold ? 'none' : '';
  document.getElementById('hInd').style.display = isHold ? 'none' : '';
  document.getElementById('hNote').style.display = isHold ? 'none' : '';
  document.getElementById('hHold').classList.toggle('on', isHold);
  clearInterval(minTimer); minTimer = null;
  clearInterval(holdTimer); holdTimer = null;
  H.hover = -1;
  if (!H.code) return;
  if (isHold){
    loadHold(H.code, false);
    // 30 秒一轮：上游行情按 30 秒分桶缓存，更密的轮询只会反复命中同一个桶
    holdTimer = setInterval(function(){
      if (H.code && H.mode === 'hold'
          && document.getElementById('histMask').classList.contains('on')) {
        loadHold(H.code, true);
      }
    }, 30000);
    return;
  }
  if (isMin){
    loadMin(H.code);
    // 35 秒一轮：接口按 30 秒分桶缓存，更密的轮询只会反复命中同一个桶
    minTimer = setInterval(function(){
      if (H.code && H.mode === 'min'
          && document.getElementById('histMask').classList.contains('on')) {
        fetchMinOnce(H.code, false);
      }
    }, 35000);
  } else {
    loadK(H.code);
  }
}

/* ================= 成分穿透 =================
   「ETF 涨了 0.4%，是哪几只票拉的？」——只有涨跌幅回答不了，得拆到底层。

   /api/hold 给的是季报口径的前 N 大（宽基 40 只上下、行业 20 只、跨境 10 只），
   带权重和实时涨跌。这里只做三件事：按贡献排序、画双向条、把「前 N 大能解释
   多少 / 剩下的怎么解释」分开写清。不画图：这一栏的价值在排序，不在形态。

   权重 × 涨跌 = 贡献（百分点）。ETF 的涨跌幅近似等于所有成分贡献之和，
   差额来自没披露的仓位、现金、折溢价——所以「其余仓位」那是一个残差，
   不是算错。
*/
function fpt(v){
  if (v == null || !isFinite(v)) return '-';
  // |v| < 0.005 会被 toFixed(2) 写成 -0.00，正负号在这儿没有意义，按 0 处理
  var x = Math.abs(v) < 0.005 ? 0 : v;
  return (x > 0 ? '+' : '') + x.toFixed(2);
}

function loadHold(code, silent){
  var box = document.getElementById('hHoldBody');
  if (!box) return;
  var slow = null;
  if (!silent){
    document.getElementById('hHoldHd').innerHTML = '';
    box.innerHTML = '<div class="hempty">读取成分…</div>';
    /* 盘前只预热了每个指数里成交额最大的那只，其余要现场抓交易所清单（3–6 秒）。
       超过两秒还没回来就换个说法，免得看着像卡死。 */
    slow = setTimeout(function(){
      if (H.code !== code || H.mode !== 'hold') return;
      var e = box.querySelector('.hempty');
      if (e) e.textContent = '这只不是同指数的龙头，成分要现场抓取，约 3–6 秒…';
    }, 2000);
  }
  fetch('/api/hold?code=' + code).then(function(r){ return r.json(); }).then(function(j){
    clearTimeout(slow);
    if (H.code !== code || H.mode !== 'hold') return;   // 用户已经切走了
    if (!j || !j.ok){
      box.innerHTML = '<div class="hempty">' + esc((j && j.error) || '读取失败') + '</div>';
      return;
    }
    H.hj = j;
    renderHold(j);
  }).catch(function(e){
    clearTimeout(slow);
    if (H.code !== code || H.mode !== 'hold') return;
    box.innerHTML = '<div class="hempty">网络错误：' + esc(e.message || String(e)) + '</div>';
  });
}

function renderHold(j){
  var hd = document.getElementById('hHoldHd');
  var box = document.getElementById('hHoldBody');
  /* 两个口径的持仓不是一回事，界面必须分开写：
       src=pcf    → 交易所当日申购赎回清单，**全部**成分，权重合计 100%；
       src=report → 基金季报只披露前十大，权重合计二十几个点，剩下全是「其余」。
     混着写会出现「前 20 大 26%」这种在 PCF 下永远不可能的数字，用户会以为算错。 */
  var isPcf = j.src === 'pcf';

  /* 一律按权重从大到小。权重 0.00% 的条目不进表——贡献恒为 0，只占行高。

     行数分两档：默认只列权重前 20，脚注写清还剩多少只、占多少权重，想看全量
     就点一下「展开全部」。PCF 是全量清单，中证500 那只有 500 个成分，一上来就
     铺 500 行等于把「这只 ETF 押在哪」埋进几十屏的滚动里——20 行刚好一屏，
     权重排序下前几只就是这只 ETF 的仓位骨架。展开后仍然是同一份数据，不重新请求。 */
  var all = (j.rows || []).filter(function(x){ return x.w >= 0.005; })
    .sort(function(a, b){ return b.w - a.w; });
  var lim = Math.min(H.holdAll ? all.length : 20, all.length);
  var rows = all.slice(0, lim);
  var cut = all.length - rows.length;
  var cutW = 0;
  for (var q0 = rows.length; q0 < all.length; q0++) cutW += all[q0].w;
  var it = findItem(H.code);
  var ec = (it && isFinite(it.chg)) ? it.chg : null;

  /* 按权重从大到小：这一栏回答的是「持仓长什么样」，先看谁占得重。
     原来按贡献（权重×涨跌）排，涨得多的中小权重会挤到茅台前面，翻半天找不到
     「这只 ETF 到底押在哪」；贡献有颜色条和数值，谁在拉谁在砸扫一眼就看得到，
     不需要靠排序来回答。 */
  rows.sort(function(a, b){ return b.w - a.w; });

  var sum = 0, got = 0, mx = 0, wsum = 0, i, r;
  for (i = 0; i < rows.length; i++){
    r = rows[i];
    wsum += r.w;
    if (r.ctr == null) continue;
    sum += r.ctr; got++;
    if (Math.abs(r.ctr) > mx) mx = Math.abs(r.ctr);
  }

  // 注意这里是模板字符串：正则里的反斜杠要写两个，写成 \d 会被当成 d
  var dayTxt = (j.asof || '-').replace(/^(\\d{4})(\\d{2})(\\d{2})$/, '$2-$3');
  if (isPcf){
    /* miss = 清单里有、但行情没取到的只数（退市、停牌无昨收、代码换过）。
       这些不进行，权重就按剩下的归一化到 100%——数字看着正常，其实分母缩了。
       所以「全部 N 只 · 权重合计 100%」这句话只在 miss=0 时成立，有缺就把缺的
       只数写出来，别让人拿一张静默缩过水的表当全量。 */
    var missN = j.miss || 0;
    hd.innerHTML = '<span>清单 <b>' + (j.total || all.length + missN) + '</b> 只'
      + (missN > 0 ? ' · <b>' + missN + '</b> 只无行情（权重按其余归一化）' : '')
      + ' · 权重合计 <b>100%</b>'
      + ' · 交易所 PCF <b>' + esc(dayTxt) + '</b>'
      + (cut > 0 ? ' · 列出权重前 <b>' + rows.length + '</b>（可展开）' : '')
      // 展开后表头给一个「收起」：几百行滚到底才能收，太远了
      + (H.holdAll ? ' · <i class="hcollapse" data-holdm="0">收起</i>' : '')
      + '</span><span>权重 = 股数 × 昨收归一化 · 贡献 = 权重 × 今日涨跌（百分点）</span>';
  } else {
    hd.innerHTML = '<span>前 <b>' + rows.length + '</b> 大 · 权重合计 <b>'
      + wsum.toFixed(1) + '%</b> · 季报 <b>' + esc(dayTxt) + '</b>'
      + (got < rows.length ? ' · <b>' + (rows.length - got) + '</b> 只无行情' : '')
      + '</span><span>贡献 = 权重 × 今日涨跌，单位百分点</span>';
  }

  var buf = [];
  for (i = 0; i < rows.length; i++){
    r = rows[i];
    var wpc = (r.ctr == null || !mx || Math.abs(r.ctr) < 0.005) ? 0 : Math.abs(r.ctr) / mx * 50;
    var bar = '';
    if (wpc > 0){
      bar = r.ctr > 0
        ? '<u style="left:50%;width:' + wpc.toFixed(1) + '%;background:#d93a3a"></u>'
        : '<u style="right:50%;width:' + wpc.toFixed(1) + '%;background:#0e9a61"></u>';
    }
    buf.push('<div class="hhrow" data-s="' + esc(r.c) + '" title="' + esc(r.n) + ' ' + r.c
      + '　权重 ' + r.w.toFixed(2) + '%，今日 ' + (r.chg == null ? '-' : fpc(r.chg))
      + '，贡献 ' + fpt(r.ctr) + ' 个百分点">'
      + '<span class="hhnm">' + esc(r.n) + '<em>' + esc(r.c) + '</em></span>'
      + '<span class="hhw">' + r.w.toFixed(2) + '%</span>'
      + '<span class="hhc ' + cc(r.chg) + '">' + (r.chg == null ? '-' : fpc(r.chg)) + '</span>'
      + '<span class="hhbar">' + bar + '</span>'
      + '<span class="hhctr ' + cc(Math.abs(r.ctr || 0) < 0.005 ? 0 : r.ctr) + '">'
      + fpt(r.ctr) + '</span>'
      + '</div>');
  }

  var foot = '';
  if (!got){
    // 持仓拿到了、行情一条都没回来：说清是上游的问题，别让人以为持仓是空的
    foot = '<div class="hhfoot"><span class="k">成分行情暂时没拿到（上游偶发空响应），'
      + '30 秒后自动重试</span></div>';
  }
  // 「合计贡献」只统计列出来的行，所以标签跟着行数走：展开前是「前 20 只」，
  // 展开后是「全部 N 只」——同一个数字配上两种口径的标签，才会被读成算错
  foot += '<div class="hhfoot"><span class="k">'
    + (H.holdAll ? '全部 ' + got + ' 只合计贡献'
      : (cut > 0 ? '列出 ' + got + ' 只合计贡献' : '前 ' + got + ' 只合计贡献')) + '</span>'
    + '<span><b class="' + cc(sum) + '">' + (got ? fpt(sum) : '-') + '</b></span>';
  // 一条行情都没有时不谈残差：那时 sum=0，「其余仓位 +3.50%」等于把 ETF 涨幅
  // 整个算到未披露仓位上，纯属瞎猜
  if (ec != null && got){
    foot += '<span class="k">ETF 今日</span><span><b class="' + cc(ec) + '">' + fpc(ec) + '</b></span>';
    if (!isPcf || cut > 0){
      foot += '<span class="k">' + (isPcf
        ? '其余 ' + cut + ' 只（权重 ' + cutW.toFixed(1) + '%）约'
        : '其余 ' + Math.max(0, 100 - wsum).toFixed(1) + '% 仓位（未披露持仓 / 现金 / 折溢价）约')
        + '</span>'
        + '<span><b class="' + cc(ec - sum) + '">' + fpt(ec - sum) + '</b></span>';
    }
  }
  foot += '</div>';

  var note;
  if (isPcf){
    note = '<div class="hhnote">权重由交易所申购赎回清单（PCF）的股数 × 昨收归一化算得，'
      + '每日开盘前更新，覆盖全部成分——所以「前 N 大合计贡献」加上「其余部分」'
      + '就约等于 ETF 今日涨跌，差额来自现金差额和折溢价（折溢价收敛几个 bp 很正常）。'
      + '跨境 ETF 的成分是当地市场的涨跌（港币 / 美元计价），与 A 股不同步，'
      + '白天看纳指 ETF 时成分股涨跌反映的是昨夜美股。'
      + (cut > 0 ? '另有 ' + cut + ' 只权重最小的没列出来，合计占 ' + cutW.toFixed(1) + '%。' : '')
      + '</div>';
  } else {
    note = '<div class="hhnote">权重取自基金季报（持仓截止 ' + esc(dayTxt)
      + '），只披露前十大，所以「其余仓位」是一个残差——'
      + '里面既有没披露的持仓，也有现金拖累和折溢价，不要当成某一只票的涨跌。'
      + (j.pcfErr ? '（交易所 PCF 本次取不到：' + esc(j.pcfErr) + '）' : '')
      + (cut > 0 ? '另有 ' + cut + ' 只权重不足 0.1%，没列出来。' : '') + '</div>';
  }

  /* 展开/收起按钮。渲染完 20 行之后还剩多少只、占多少权重都写在按钮上——
     「展开」两个字不说清代价，点下去才发现在一屏几百行里找不着北。 */
  var more = '';
  if (cut > 0){
    more = '<div class="hhmore"><b data-holdm="1">展开全部 ' + all.length + ' 只'
      + '（还有 ' + cut + ' 只 · 合计权重 ' + cutW.toFixed(1) + '%）</b></div>';
  } else if (H.holdAll && all.length > 20){
    more = '<div class="hhmore"><b data-holdm="0">收起，只看权重前 20</b></div>';
  }

  // 脚注排在合计行之前：合计是 sticky 吸底的，放在最后才不会被脚注顶开
  box.innerHTML = buf.join('') + more + note + foot;
}

function openHist(code, name){
  H.code = code; H.name = name || code;
  H.d = null; H.m = null; H.hover = -1; H.ok = false; H.ext = false;
  // 展开状态跟着标的走：换一只就回到 20 行，否则上一只的「展开」会让人以为
  // 这一只的权重结构也是几百行
  H.holdAll = false;
  document.getElementById('hName').textContent = H.name;
  document.getElementById('hCode').textContent = code;
  document.getElementById('hPx').textContent = '-';
  document.getElementById('hChg').textContent = '';
  document.getElementById('hLeg').innerHTML = '';
  document.getElementById('hInd').innerHTML = '';
  document.getElementById('hNote').textContent = '';
  // 上一只的成分表先清掉：不清的话切到分时的瞬间还能看到它
  document.getElementById('hHoldBody').innerHTML = '';
  document.getElementById('hHoldHd').innerHTML = '';
  document.getElementById('histMask').classList.add('on');

  var x = findItem(code);
  if (x){
    document.getElementById('hPx').textContent = fnum(x.p, 3);
    var ch = document.getElementById('hChg');
    ch.textContent = fpc(x.chg);
    ch.className = 'ch ' + cc(x.chg);
  }
  hSize();
  setHMode(H.mode, true);
}

function loadK(code){
  document.getElementById('hLeg').innerHTML = '<span>加载中…</span>';
  document.getElementById('hInd').innerHTML = '';
  document.getElementById('hNote').textContent = '';

  fetch('/api/hist?code=' + code).then(function(r){
    var ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('json') >= 0) return r.json().then(function(j){ throw new Error(j.error || '读取失败'); });
    return r.arrayBuffer();
  }).then(function(buf){
    if (H.code !== code) return;          // 加载期间用户已经换了标的
    var raw = parseHist(buf);

    function finish(it){
      if (H.code !== code) return;
      // 存下原始历史：定时刷新要基于这同一份重算，否则每刷一次就多接一根今天
      H.raw = raw;
      // 历史里没有今天就把实时快照接上去，盘中也能看到当天走势
      var ext = hPatchToday(raw, it);
      H.d = ext || raw;
      H.ext = !!ext;
      H.ok = true;
      hDraw();
      hLegend(-1);
      var note = hAdjNote();
      if (ext){
        note = (note ? note + ' ' : '') + hExtNote();
      }
      document.getElementById('hNote').textContent = note;
    }

    /* 全市场快照里找不到这只、或者拿到的快照没有高低价/成交额（东财限流时
       会只回一半标的），就单独问一次 /api/quote——单只接口走的是另一条通道，
       命中率高得多。拿不到就按原样画，不因为一个补丁把整张图卡住。 */
    var it = findItem(code);
    if (it && it.amt > 0 && it.hi > 0){ finish(it); return; }

    fetch('/api/quote?codes=' + encodeURIComponent(code))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (H.code !== code) return;
        var x = (j && j.ok && j.raw && j.raw[0]) ? j.raw[0] : null;
        var p = x ? +x.f2 : 0;
        finish(p > 0 ? {
          p: p, hi: +x.f15 || 0, lo: +x.f16 || 0, op: +x.f17 || 0, amt: +x.f6 || 0,
        } : it);
      })
      .catch(function(){ finish(it); });
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
  clearInterval(minTimer); minTimer = null;
  clearInterval(holdTimer); holdTimer = null;
  H.code = ''; H.d = null; H.m = null;
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

/* 折线：遇 NaN 必须断线，否则停牌日的缺口会被连成一条直穿过去的线 */
function hLine(ctx, arr, i0, n, xOf, yFn, color, lw){
  ctx.strokeStyle = color; ctx.lineWidth = lw || 1.3; ctx.beginPath();
  var started = false;
  for (var j = i0; j < n; j++){
    if (!isFinite(arr[j])){ started = false; continue; }
    var X = xOf(j), Y = yFn(arr[j]);
    if (!started){ ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
  }
  ctx.stroke();
}

/* 副图定义表。有的指标必须固定量程才读得出来（RSI 的 30/70、%B 的 0~100），
   有的必须跟着数据自适应（ATR 的绝对值在 0.02~2 之间都有，固定量程等于没画）。 */
var SUB_DEF = {
  rsi:  { nm:'RSI14',  col:'#7c5cd6', fixed:[0,100], refs:[30,70],
          arr:function(c){ return c.rsi14; }, fmt:function(v){ return v.toFixed(0); } },
  vr:   { nm:'量比5',  col:'#d68910', refs:[1],
          arr:function(c){ return c.vol_ratio5; }, fmt:function(v){ return v.toFixed(2); } },
  hvol: { nm:'波动率', col:'#4c8dff',
          arr:function(c){ return c.hvol20; }, fmt:function(v){ return v.toFixed(1) + '%'; } },
  atr:  { nm:'ATR14',  col:'#0e9a61',
          arr:function(c){ return c.atr14; }, fmt:function(v){ return v.toFixed(3); } },
  pb:   { nm:'BOLL%B', col:'#d68910', fixed:[0,100], refs:[0,50,100], arr:null,
          fmt:function(v){ return v.toFixed(0); } }
};

/* %B 不在二进制里，用 (收盘-下轨)/(上轨-下轨) 现算，比单独存一列省 4 字节/天 */
function pbArr(c){
  var n = c.close.length, a = new Float32Array(n);
  var bu = c.boll_up, bl = c.boll_low, cl = c.close;
  for (var i = 0; i < n; i++){
    a[i] = (isFinite(bu[i]) && isFinite(bl[i]) && bu[i] > bl[i])
      ? (cl[i] - bl[i]) / (bu[i] - bl[i]) * 100 : NaN;
  }
  return a;
}

function drawSub(ctx, c, i0, n, xOf, padL, plotW, yR, hR){
  var kind = H.sub || 'rsi';
  ctx.font = '9px ui-monospace,Menlo,monospace';
  ctx.lineWidth = 1;

  /* MACD 是双线加柱，量程必须以 0 为轴左右对称，否则金叉死叉看着像在同一个位置 */
  if (kind === 'macd'){
    var dif = c.macd_dif, dea = c.macd_dea, i, mx = 1e-9;
    for (i = i0; i < n; i++){
      if (isFinite(dif[i]) && Math.abs(dif[i]) > mx) mx = Math.abs(dif[i]);
      if (isFinite(dea[i]) && Math.abs(dea[i]) > mx) mx = Math.abs(dea[i]);
      if (isFinite(dif[i]) && isFinite(dea[i]) && Math.abs(dif[i] - dea[i]) > mx) mx = Math.abs(dif[i] - dea[i]);
    }
    mx *= 1.12;
    var y0 = yR + hR / 2;
    var yM = function(v){ return y0 - (v / mx) * (hR / 2); };

    ctx.strokeStyle = '#c9d2e0'; ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y0) + 0.5);
    ctx.lineTo(padL + plotW, Math.round(y0) + 0.5); ctx.stroke();
    ctx.setLineDash([]);

    var bw = Math.max(1, plotW / (n - i0) * 0.6);
    for (i = i0; i < n; i++){
      if (!isFinite(dif[i]) || !isFinite(dea[i])) continue;
      var hv = dif[i] - dea[i], X = xOf(i);
      ctx.fillStyle = hv >= 0 ? 'rgba(217,58,58,.6)' : 'rgba(14,154,97,.6)';
      ctx.fillRect(X - bw / 2, Math.min(yM(hv), y0), bw, Math.max(1, Math.abs(yM(hv) - y0)));
    }
    hLine(ctx, dif, i0, n, xOf, yM, '#d68910', 1.1);
    hLine(ctx, dea, i0, n, xOf, yM, '#4c8dff', 1.1);

    ctx.fillStyle = HC.axis; ctx.textAlign = 'left';
    ctx.textBaseline = 'top'; ctx.fillText(mx.toFixed(2), padL + plotW + 5, yR + 1);
    ctx.textBaseline = 'bottom'; ctx.fillText('-' + mx.toFixed(2), padL + plotW + 5, yR + hR);
    subName(ctx, 'MACD', padL, yR, '#6b7380');
    return;
  }

  var def = SUB_DEF[kind] || SUB_DEF.rsi;
  var arr = (kind === 'pb') ? pbArr(c) : def.arr(c);
  var lo, hi, i, v;
  if (def.fixed){
    lo = def.fixed[0]; hi = def.fixed[1];
  } else {
    lo = Infinity; hi = -Infinity;
    for (i = i0; i < n; i++){
      v = arr[i];
      if (isFinite(v)){ if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!isFinite(lo)){ lo = 0; hi = 1; }
    // 量比、ATR 这类正数指标从 0 起画才看得出「放大了几倍」
    if (lo > 0) lo = 0;
    if (hi <= lo) hi = lo + 1;
    hi += (hi - lo) * 0.12;
  }
  var yS = function(v){ return yR + hR * (hi - v) / (hi - lo); };

  if (def.refs){
    ctx.strokeStyle = '#c9d2e0'; ctx.setLineDash([3,4]);
    for (i = 0; i < def.refs.length; i++){
      var lv = def.refs[i];
      if (lv < lo || lv > hi) continue;
      var yy = Math.round(yS(lv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      if (kind === 'rsi' && hR >= 74){
        ctx.fillStyle = '#8b93a1'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(String(lv), padL + plotW + 5, yy);
      }
    }
    ctx.setLineDash([]);
  }
  hLine(ctx, arr, i0, n, xOf, yS, def.col, 1.2);

  ctx.fillStyle = HC.axis; ctx.textAlign = 'left';
  ctx.textBaseline = 'top'; ctx.fillText(def.fmt(hi), padL + plotW + 5, yR + 1);
  ctx.textBaseline = 'bottom'; ctx.fillText(def.fmt(lo), padL + plotW + 5, yR + hR);
  subName(ctx, def.nm, padL, yR, def.col);
}

/* 指标名画在图内左上角。放右侧会和上下两个刻度值抢位置——
   副图只有 60px 高时三行标签会叠成一团。 */
function subName(ctx, name, padL, yR, col){
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = '9px ui-monospace,Menlo,monospace';
  ctx.fillStyle = col; ctx.globalAlpha = 0.75;
  ctx.fillText(name, padL + 3, yR + 1);
  ctx.restore();
}

/* ================= 日内分时 =================
   数据来自 /api/min（Worker 代理新浪 minline），每个交易日 240 个点，
   含价格、当日成交额加权均价、分钟量。

   横轴不用「有几个点画几格」：固定 240 格，午休那 90 分钟不占位，
   盘中只画已经走过的部分。这样早盘打开图不会是一条被拉伸的怪线，
   而且 10:30 永远在图的正中间——位置本身就是信息。

   价格范围以昨收为中心上下对称。K 线那套「跟着最高最低自适应」在分时上
   是错的：昨收会跑到图边角，一眼看不出此刻是涨是跌。 */

var MC = {
  line:'#2563eb', avg:'#d68910', base:'#b9c0cc', cross:'#8b93a1',
  fillUp:'rgba(217,58,58,.06)', fillDn:'rgba(14,154,97,.06)',
  volUp:'rgba(217,58,58,.42)', volDn:'rgba(14,154,97,.42)'
};
var MIN_SLOTS = 240;                 // 槽位 0..240
var minTimer = null;

/* 09:30→0，11:30→120，13:00 也→120（两段接起来），15:00→240 */
function minSlot(t){
  var v = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  if (v <= 690) return Math.max(0, v - 570);
  return 120 + Math.min(120, v - 780);
}

function loadMin(code){
  var it = findItem(code);
  H.m = { code:code, pre:(it && it.pc > 0 ? it.pc : 0), pts:[] };
  document.getElementById('hLeg').innerHTML = '<span>加载中…</span>';
  document.getElementById('hInd').innerHTML = '';
  document.getElementById('hNote').textContent = '';
  document.getElementById('hTabs').style.display = 'none';
  document.getElementById('hSbar').style.display = 'none';
  fetchMinOnce(code, true);
}

function fetchMinOnce(code, first){
  fetch('/api/min?code=' + code).then(function(r){ return r.json(); }).then(function(j){
    if (H.code !== code || H.mode !== 'min') return;   // 期间换了标的或切了模式
    if (!j || !j.ok || !j.pts || !j.pts.length) throw new Error((j && j.error) || '分时无数据');
    var it = findItem(code);
    // 昨收优先取全市场快照（新浪 settlement，全天不变）；
    // 拿不到才退回用当天第一个价格当基准，并在备注里说清楚
    var pre = (it && it.pc > 0) ? it.pc : 0;
    var guess = !pre;
    if (!pre) pre = j.pts[0][1];
    H.m = { code:code, pre:pre, pts:j.pts, guess:guess, src:j.src };
    H.hover = -1;
    // 面板顶部那个现价是打开时的快照，分时每 35 秒会重拉，顺手把它带上——
    // 否则盘中会出现「图走到 4.21 了，顶栏还写着 4.19」的错位
    if (it && it.p > 0){
      document.getElementById('hPx').textContent = fnum(it.p, 3);
      var chEl = document.getElementById('hChg');
      chEl.textContent = fpc(it.chg);
      chEl.className = 'ch ' + cc(it.chg);
    }
    hDraw();
    hLegend(-1);
    document.getElementById('hNote').textContent = minNote();
  }).catch(function(e){
    if (H.code !== code || H.mode !== 'min' || !first) return;
    document.getElementById('hLeg').innerHTML = '';
    document.getElementById('hNote').textContent =
      '分时取不到：' + (e.message || e) + '。这条链路走新浪分时接口，'
      + '上游偶发空回；切到「K线」不受影响，过一会儿再点回来即可。';
    if (H.cv){
      var g = H.cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, H.cv.width, H.cv.height);
    }
  });
}

function minNote(){
  var m = H.m;
  if (!m) return '';
  var s = '共 ' + m.pts.length + ' 个分钟点，均价线是当日成交额加权（VWAP）；';
  if (m.guess) s += '昨收未取到，基准用当日首个价格代替，涨跌幅仅供参考；';
  s += '盘中未走到的时段留白，横轴刻度固定，方便和昨天同一时刻对比。';
  return s;
}

function hDrawMin(){
  hSize();
  var W = H.W, Ht = H.Ht, ctx = H.octx, m = H.m;
  if (!W) return;
  ctx.clearRect(0, 0, W, Ht);
  if (!m || !m.pts || !m.pts.length){
    H.ctx.setTransform(1, 0, 0, 1, 0, 0);
    H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
    return;
  }

  var pts = m.pts, pre = m.pre, n = pts.length, i;
  var padL = 46, padR = 58, padT = 10, padB = 16;
  var plotW = Math.max(40, W - padL - padR);
  var bodyH = Ht - padT - padB;
  var hV = Math.round(bodyH * 0.22);
  var hP = bodyH - hV - 10;
  var yP = padT, yV = padT + hP + 10;

  var dmax = 0, hi = -Infinity, lo = Infinity, vs = [];
  for (i = 0; i < n; i++){
    var p = pts[i][1], a = pts[i][2], vv = pts[i][3];
    if (p > hi) hi = p;
    if (p < lo) lo = p;
    if (Math.abs(p - pre) > dmax) dmax = Math.abs(p - pre);
    if (a > 0 && Math.abs(a - pre) > dmax) dmax = Math.abs(a - pre);
    if (vv > 0) vs.push(vv);
  }
  if (!(dmax > 0)) dmax = pre * 0.005 || 0.01;
  dmax *= 1.1;
  var pmin = pre - dmax, pmax = pre + dmax;

  /* 量柱刻度取 95 分位而不是最大值：开盘第一分钟含集合竞价，量常是平时的
     4~10 倍，用最大值当上限会让其余 239 根全部贴地，等于没画量。超出刻度
     的柱截断到顶部并描一道白边，表示这根已经出界。 */
  vs.sort(function(x, y){ return x - y; });
  var vmax = vs.length ? vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.95))] : 1;
  if (!(vmax > 0)) vmax = 1;

  function xOf(sl){ return padL + (sl / MIN_SLOTS) * plotW; }
  function yOf(q){ return yP + hP * (pmax - q) / (pmax - pmin); }
  function yVol(v){ return yV + hV * (1 - Math.min(v, vmax) / vmax); }

  /* --- 网格按涨跌幅整档画（±0.5% / ±1% …），而不是把价格区间等分：
     等分出来是 4.132 / 4.154 / 4.196 这种数，既不好读也对不上盘口整数位 --- */
  var spanPct = pre > 0 ? dmax / pre * 100 : 1;
  var stepPct = spanPct > 8 ? 5 : spanPct > 4 ? 2 : spanPct > 2 ? 1 : 0.5;
  var kMax = pre > 0 ? Math.floor(spanPct / stepPct) : 1;
  if (kMax < 1) kMax = 1;

  ctx.font = '10px ui-monospace,Menlo,monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (var j = -kMax; j <= kMax; j++){
    var pv = pre * (1 + j * stepPct / 100);
    if (pv < pmin || pv > pmax) continue;
    var yy = Math.round(yOf(pv)) + 0.5;
    if (j !== 0){                       // 0 档由昨收虚线代表，不重复画
      ctx.strokeStyle = HC.grid;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    }
    var upC = j > 0, dnC = j < 0;
    ctx.textAlign = 'right';
    ctx.fillStyle = upC ? 'rgba(217,58,58,.85)' : dnC ? 'rgba(14,154,97,.85)' : HC.axis;
    ctx.fillText((j > 0 ? '+' : '') + (j * stepPct).toFixed(2) + '%', padL - 6, yy);
    ctx.textAlign = 'left';
    ctx.fillStyle = upC ? HC.up : dnC ? HC.dn : HC.axis;
    ctx.fillText(pv.toFixed(pre < 10 ? 3 : 2), padL + plotW + 8, yy);
  }

  /* --- 昨收基准线 --- */
  var yb = Math.round(yOf(pre)) + 0.5;
  ctx.strokeStyle = MC.base; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yb); ctx.lineTo(padL + plotW, yb); ctx.stroke();
  ctx.setLineDash([]);

  /* --- 分钟量 --- */
  var bw = Math.max(1, (plotW / (MIN_SLOTS + 1)) * 0.7);
  for (i = 0; i < n; i++){
    var v = pts[i][3];
    if (!(v > 0)) continue;
    var rise = i === 0 ? pts[i][1] >= pre : pts[i][1] >= pts[i - 1][1];
    ctx.fillStyle = rise ? MC.volUp : MC.volDn;
    var y0 = yVol(v), x0 = xOf(minSlot(pts[i][0])) - bw / 2;
    ctx.fillRect(x0, y0, bw, Math.max(1, yV + hV - y0));
    if (v > vmax){
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillRect(x0, y0, bw, 1);
    }
  }

  /* --- 涨跌两色填充：昨收以上红、以下绿。
     和「现价涨了所以整块涂红」不同——分时图要看的是此刻在基准的哪一侧，
     而不是收盘那一瞬间的方向。 --- */
  function fillSide(yTop, yBot, color){
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, yTop, plotW, Math.max(0, yBot - yTop)); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(xOf(minSlot(pts[0][0])), yb);
    for (var q = 0; q < n; q++) ctx.lineTo(xOf(minSlot(pts[q][0])), yOf(pts[q][1]));
    ctx.lineTo(xOf(minSlot(pts[n - 1][0])), yb);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  fillSide(yP, yb, MC.fillUp);
  fillSide(yb, yV + hV, MC.fillDn);

  /* --- 均价线（VWAP） --- */
  var started = false;
  ctx.strokeStyle = MC.avg; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (i = 0; i < n; i++){
    if (!(pts[i][2] > 0)) continue;
    var ax = xOf(minSlot(pts[i][0])), ay = yOf(pts[i][2]);
    if (!started){ ctx.moveTo(ax, ay); started = true; } else ctx.lineTo(ax, ay);
  }
  ctx.stroke();

  /* --- 价格线 --- */
  ctx.strokeStyle = MC.line; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (i = 0; i < n; i++){
    var lx = xOf(minSlot(pts[i][0])), ly = yOf(pts[i][1]);
    if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
  }
  ctx.stroke();

  /* --- 最新点：收盘后也保留，方便看收在哪 --- */
  var lastP = pts[n - 1][1];
  var up = lastP >= pre;
  // 末端点往左收一格：15:00 那一点正好落在绘图区右边界，
  // 光晕会压到右侧的价格刻度上，看起来像刻度被涂花了
  var xe = Math.min(xOf(minSlot(pts[n - 1][0])), padL + plotW - 2), ye = yOf(lastP);
  ctx.beginPath(); ctx.arc(xe, ye, 5, 0, Math.PI * 2);
  ctx.fillStyle = up ? 'rgba(217,58,58,.16)' : 'rgba(14,154,97,.16)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(xe, ye, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = up ? HC.up : HC.dn;
  ctx.fill();

  /* --- 时间轴 --- */
  ctx.fillStyle = HC.axis; ctx.textBaseline = 'top';
  ctx.font = '10px ui-monospace,Menlo,monospace';
  var marks = plotW < 560
    ? [[0, '09:30'], [120, '11:30'], [240, '15:00']]
    : [[0, '09:30'], [60, '10:30'], [120, '11:30/13:00'], [180, '14:00'], [240, '15:00']];
  for (var t = 0; t < marks.length; t++){
    ctx.textAlign = t === 0 ? 'left' : (t === marks.length - 1 ? 'right' : 'center');
    ctx.fillText(marks[t][1], xOf(marks[t][0]), yV + hV + 4);
  }

  H.mgeo = { padL:padL, plotW:plotW, yP:yP, hP:hP, yV:yV, hV:hV,
             pmin:pmin, pmax:pmax, vmax:vmax, pre:pre, pts:pts };

  H.ctx.setTransform(1, 0, 0, 1, 0, 0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, W, Ht);
  if (H.hover >= 0) hCrossMin(H.hover);
}

/* 鼠标 x → 最近的分时点索引。点数 ≤ 240，直接扫比二分更快也更不容易写错 */
function minIdxAt(x){
  var g = H.mgeo;
  if (!g) return -1;
  var s = (x - g.padL) / g.plotW * MIN_SLOTS;
  var pts = g.pts, best = -1, bd = 1e9;
  for (var i = 0; i < pts.length; i++){
    var d = Math.abs(minSlot(pts[i][0]) - s);
    if (d < bd){ bd = d; best = i; }
  }
  return best;
}

function hCrossMin(idx){
  var g = H.mgeo, ctx = H.ctx, m = H.m;
  if (!g || !m || !m.pts) return;
  var pts = g.pts;
  if (idx < 0 || idx >= pts.length) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  ctx.drawImage(H.off, 0, 0, H.W, H.Ht);

  var pt = pts[idx];
  var slot = minSlot(pt[0]);
  var x = Math.round(g.padL + (slot / MIN_SLOTS) * g.plotW) + 0.5;
  var yTop = g.yP, yBot = g.yV + g.hV;

  ctx.strokeStyle = MC.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();

  var py = Math.round(g.yP + g.hP * (g.pmax - pt[1]) / (g.pmax - g.pmin)) + 0.5;
  ctx.beginPath(); ctx.moveTo(g.padL, py); ctx.lineTo(g.padL + g.plotW, py); ctx.stroke();
  ctx.setLineDash([]);

  // 右侧价格牌
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(g.padL + g.plotW + 2, py - 7, 54, 14);
  ctx.fillStyle = '#15181d';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '10px ui-monospace,Menlo,monospace';
  ctx.fillText(fnum(pt[1], 3), g.padL + g.plotW + 5, py);

  // 该点的圆点
  ctx.beginPath(); ctx.arc(x, py, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = MC.line; ctx.fill();

  hLegendMin(idx);
}

function hLegendMin(idx){
  var m = H.m, g = H.mgeo;
  var leg = document.getElementById('hLeg');
  var ind = document.getElementById('hInd');
  if (!m || !m.pts || !m.pts.length){ leg.innerHTML = ''; ind.innerHTML = ''; return; }
  var pts = m.pts, pre = m.pre, n = pts.length, i;

  var hi = -Infinity, lo = Infinity, sumV = 0, last = pts[n - 1][1];
  for (i = 0; i < n; i++){
    if (pts[i][1] > hi) hi = pts[i][1];
    if (pts[i][1] < lo) lo = pts[i][1];
    if (pts[i][3] > 0) sumV += pts[i][3];
  }
  var pctOf = function(q){ return pre > 0 ? (q / pre - 1) * 100 : NaN; };
  var volTxt = function(v){
    if (!(v > 0)) return '-';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿股';
    if (v >= 1e4) return (v / 1e4).toFixed(0) + ' 万股';
    return v + ' 股';
  };
  var posIn = (hi > lo) ? (last - lo) / (hi - lo) * 100 : 50;

  if (idx >= 0 && idx < n){
    var pt = pts[idx];
    var dev = pt[2] > 0 ? (pt[1] / pt[2] - 1) * 100 : NaN;
    leg.innerHTML =
      '<span>时刻 <b>' + pt[0] + '</b></span>'
      + '<span>价 <b class="' + cc(pctOf(pt[1])) + '">' + fnum(pt[1], 3) + '</b>'
      + ' <b class="' + cc(pctOf(pt[1])) + '">' + fpc(pctOf(pt[1])) + '</b></span>'
      + '<span>均价 <b>' + (pt[2] > 0 ? fnum(pt[2], 3) : '-') + '</b></span>'
      + '<span>偏离 <b class="' + cc(dev) + '">' + (isFinite(dev) ? fpc(dev) : '-') + '</b></span>'
      + '<span>分钟量 <b>' + volTxt(pt[3]) + '</b></span>';
  } else {
    leg.innerHTML =
      '<span>现价 <b class="' + cc(pctOf(last)) + '">' + fnum(last, 3) + '</b>'
      + ' <b class="' + cc(pctOf(last)) + '">' + fpc(pctOf(last)) + '</b></span>'
      + '<span>日内高 <b>' + fnum(hi, 3) + '</b> <b class="up">' + fpc(pctOf(hi)) + '</b></span>'
      + '<span>日内低 <b>' + fnum(lo, 3) + '</b> <b class="dn">' + fpc(pctOf(lo)) + '</b></span>'
      + '<span>昨收 <b>' + fnum(pre, 3) + '</b></span>'
      + '<span>振幅 <b>' + (pre > 0 ? fpc((hi - lo) / pre * 100) : '-') + '</b></span>';
  }

  // 小卡：把分时里真正能用的几个数摊开，凑不出 7 个就不凑
  var vwap = 0;
  for (i = 0; i < n; i++) if (pts[i][2] > 0) vwap = pts[i][2];
  var devNow = vwap > 0 ? (last / vwap - 1) * 100 : NaN;
  var card = function(k, v, s, cls){
    return '<div class="i"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">'
      + v + '</div><div class="s">' + (s || '') + '</div></div>';
  };
  var posTxt = posIn >= 70 ? '贴近日内高位' : posIn <= 30 ? '贴近日内低位' : '日内中枢';
  ind.innerHTML =
    card('日内位置', posIn.toFixed(0) + '%', posTxt)
    + card('均价偏离', isFinite(devNow) ? fpc(devNow) : '-',
        devNow > 0.15 ? '价在均价上' : devNow < -0.15 ? '价在均价下' : '贴着均价走', cc(devNow))
    + card('振幅', pre > 0 ? fpc((hi - lo) / pre * 100) : '-', fnum(hi, 3) + ' / ' + fnum(lo, 3))
    + card('分钟点数', String(n), n >= 240 ? '已走完整日' : '盘中 ' + Math.round(n / 240 * 100) + '%')
    + card('成交额', (function(){
        var it = findItem(H.code);
        return it && it.amt > 0 ? famt(it.amt) : '-';
      })(), '全市场快照口径');
}

function hDraw(){
  if (H.mode === 'min') return hDrawMin();
  // 成分档下画布是 display:none，再画只会白烧 CPU，还会把隐藏画布上的旧图刷新
  if (H.mode === 'hold') return;
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
  var hP = Math.round(bodyH * 0.58);
  var hV = Math.round(bodyH * 0.14);
  var hR = bodyH - hP - hV - 14;
  var yP = padT, yV = padT + hP + 6, yR = yV + hV + 8;

  var c = d.col;
  var o = c.open, hi = c.high, lo = c.low, cl = c.close, vol = c.volume;
  var m20 = c.ma20, m60 = c.ma60, bu = c.boll_up, bl = c.boll_low;

  var pmin = Infinity, pmax = -Infinity, vmax = 0, i, vv;
  for (i = i0; i < n; i++){
    if (isFinite(lo[i]) && lo[i] < pmin) pmin = lo[i];
    if (isFinite(hi[i]) && hi[i] > pmax) pmax = hi[i];
    if (isFinite(m20[i])){ if (m20[i] < pmin) pmin = m20[i]; if (m20[i] > pmax) pmax = m20[i]; }
    if (isFinite(m60[i])){ if (m60[i] < pmin) pmin = m60[i]; if (m60[i] > pmax) pmax = m60[i]; }
    if (H.ov.boll && isFinite(bu[i]) && isFinite(bl[i])){
      if (bu[i] < pmin) pmin = bu[i];
      if (bl[i] > pmax) pmax = bl[i];
    }
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
    ctx.fillStyle = cUp ? 'rgba(217,58,58,.55)' : 'rgba(14,154,97,.55)';
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

  /* --- 均线 / 布林带 ---
     必须传入各自的纵轴映射：早期版本把 RSI 也用 yPx 画，结果
     28~65 的数值被映射到价格刻度之外，整条线飞到画布上方看不见。 */
  if (H.ov.ma){
    hLine(ctx, m60, i0, n, xOf, yPx, HC.ma60, 1.3);
    hLine(ctx, m20, i0, n, xOf, yPx, HC.ma20, 1.3);
  }
  if (H.ov.boll){
    hLine(ctx, bu, i0, n, xOf, yPx, HC.boll, 1);
    hLine(ctx, bl, i0, n, xOf, yPx, HC.boll, 1);
  }

  /* --- 副图：可切换，映射与主图完全独立 --- */
  drawSub(ctx, c, i0, n, xOf, padL, plotW, yR, hR);

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
  if (H.mode === 'min') return hCrossMin(idx);
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
    ctx.fillStyle = '#ffffff';
    var lab = fnum(c.close[idx], 3);
    ctx.fillRect(g.padL + g.plotW + 2, yy - 7, 50, 14);
    ctx.fillStyle = '#15181d'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '10px ui-monospace,Menlo,monospace';
    ctx.fillText(lab, g.padL + g.plotW + 6, yy);
  }
  hLegend(idx);
}

function hLegend(idx){
  if (H.mode === 'min') return hLegendMin(idx);
  var d = H.d;
  if (!d){ document.getElementById('hInd').innerHTML = ''; return; }
  hInd(idx);
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

/* 指标明细：把 17 个字段里最能看的那几个摊开成小卡。
   hover 时跟着游标走，不 hover 就是最后一根。 */
function hInd(idx){
  var el = document.getElementById('hInd');
  var d = H.d;
  if (!d){ el.innerHTML = ''; return; }
  var c = d.col, n = d.n;
  var i = (idx >= 0 && idx < n) ? idx : n - 1;
  var px = c.close[i];

  /* key 用来标记「当前副图画的就是这张卡」，切换副图时跟着高亮 */
  function cell(k, v, s, cls, key){
    var on = key && (key === H.sub || (H.sub === 'macd' && key === 'dea'));
    return '<div class="i' + (on ? ' on' : '') + '"><div class="k">' + k + '</div>'
      + '<div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div>'
      + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
  }
  var out = '';

  // 均线：值 + 当前价相对均线的偏离
  var m20 = c.ma20 ? c.ma20[i] : NaN, m60 = c.ma60 ? c.ma60[i] : NaN;
  out += cell('MA20', fnum(m20, 3),
    isFinite(m20) && m20 > 0 ? fpc((px / m20 - 1) * 100) : '-',
    isFinite(m20) && m20 > 0 ? cc(px - m20) : '', 'ma20');
  out += cell('MA60', fnum(m60, 3),
    isFinite(m60) && m60 > 0 ? fpc((px / m60 - 1) * 100) : '-',
    isFinite(m60) && m60 > 0 ? cc(px - m60) : '', 'ma60');

  // RSI：70 以上超买、30 以下超卖，中间给中性描述
  var r = c.rsi14 ? c.rsi14[i] : NaN;
  var rTag = '-';
  if (isFinite(r)) rTag = r >= 70 ? '超买' : (r <= 30 ? '超卖' : (r >= 55 ? '偏强' : (r <= 45 ? '偏弱' : '中性')));
  out += cell('RSI14', fnum(r, 1), rTag,
    isFinite(r) ? (r >= 70 ? 'up' : (r <= 30 ? 'down' : '')) : '', 'rsi');

  // MACD：DIF 与 DEA 的差决定金叉/死叉（这里用的是已算好的两条线）
  var dif = c.macd_dif ? c.macd_dif[i] : NaN;
  var dea = c.macd_dea ? c.macd_dea[i] : NaN;
  var cross = '-';
  if (isFinite(dif) && isFinite(dea)) cross = dif > dea ? '金叉之上' : '死叉之下';
  out += cell('MACD DIF', fnum(dif, 4), isFinite(dif) ? (dif >= 0 ? '零轴上' : '零轴下') : '-',
    isFinite(dif) ? cc(dif) : '', 'macd');
  out += cell('MACD DEA', fnum(dea, 4), cross,
    isFinite(dif) && isFinite(dea) ? (dif > dea ? 'up' : 'down') : '', 'dea');

  // 布林带：直接给 %B（当前价在上下轨之间的位置），比给两个价格好读
  var bu = c.boll_up ? c.boll_up[i] : NaN;
  var bl = c.boll_low ? c.boll_low[i] : NaN;
  var pb = (isFinite(bu) && isFinite(bl) && bu > bl) ? (px - bl) / (bu - bl) * 100 : NaN;
  out += cell('BOLL %B', isFinite(pb) ? pb.toFixed(0) + '%' : '-',
    isFinite(bu) && isFinite(bl) ? fnum(bl, 3) + ' ~ ' + fnum(bu, 3) : '-',
    isFinite(pb) ? (pb >= 100 ? 'up' : (pb <= 0 ? 'down' : '')) : '', 'pb');

  // ATR 与历史波动率：都换成占比/百分比，绝对值没意义
  var atr = c.atr14 ? c.atr14[i] : NaN;
  out += cell('ATR14', fnum(atr, 4),
    isFinite(atr) && px > 0 ? '占价 ' + (atr / px * 100).toFixed(2) + '%' : '-', '', 'atr');
  var hv = c.hvol20 ? c.hvol20[i] : NaN;
  // hvol20 在 alpha/indicators.py 里已经乘过 100 变成百分数，这里不能再乘
  out += cell('HVOL20', isFinite(hv) ? hv.toFixed(1) + '%' : '-', '年化波动', '', 'hvol');

  var vr = c.vol_ratio5 ? c.vol_ratio5[i] : NaN;
  out += cell('量比5', isFinite(vr) ? vr.toFixed(2) : '-', '5 日均量对比',
    isFinite(vr) ? (vr >= 1.5 ? 'up' : (vr <= 0.6 ? 'down' : '')) : '', 'vr');

  el.innerHTML = out;
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

/* ---------- 因子研究面板 ----------
   数据在构建时固化成 research_data.js（5KB），随 HTML 一起下发，
   点开就是 0ms，不需要额外请求，也不占 Worker 请求额度。 */
function rsCard(k, v, s, cls){
  return '<div class="i"><div class="k">' + k + '</div>'
    + '<div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div>'
    + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
}
function rsPct(v, d){
  if (v == null || !isFinite(v)) return '-';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%';
}
/* ---------- 第二批因子：指数去重池 ----------
   上面那一套是 1617 只 ETF 的「个股口径」：同一指数常有 3~4 只 ETF，
   在横截面里各占一行，等于同一件事投了 3~4 票，IC 被同质化噪声稀释。
   这一批先按指数去重（每天留 20 日均额最大的那只，收益累乘拼接），
   再跑 100 个新因子 + 101 个 Alpha101，口径完全一致。
   数据由 factor_lab/export_lab.py 生成，构建时固化成 lab_data.js。 */

function labSvg(nav){
  if (!nav || nav.length < 2) return '';
  var W = 1000, H = 300, PL = 10, PR = 10, PT = 12, PB = 24;
  var lo = Infinity, hi = -Infinity, i;
  for (i = 0; i < nav.length; i++){
    lo = Math.min(lo, nav[i][1], nav[i][2]);
    hi = Math.max(hi, nav[i][1], nav[i][2]);
  }
  var pad = (hi - lo) * 0.08 || 0.1;
  lo -= pad; hi += pad;
  function X(k){ return PL + k / (nav.length - 1) * (W - PL - PR); }
  function Y(v){ return PT + (hi - v) / (hi - lo) * (H - PT - PB); }
  function d(col){
    var s = '';
    for (var k = 0; k < nav.length; k++){
      s += (k ? 'L' : 'M') + X(k).toFixed(1) + ' ' + Y(nav[k][col]).toFixed(1);
    }
    return s;
  }
  var g = '';
  // 年份分隔线 + 年份标签：90 个月末点不标年份就看不出横轴是什么
  var lastY = '';
  for (i = 0; i < nav.length; i++){
    var y = nav[i][0].slice(0, 4);
    if (y !== lastY){
      lastY = y;
      g += '<line x1="' + X(i).toFixed(1) + '" y1="' + PT + '" x2="' + X(i).toFixed(1)
        + '" y2="' + (H - PB) + '" stroke="#e3e6eb" stroke-width="1"/>'
        + '<text x="' + (X(i) + 3).toFixed(1) + '" y="' + (H - 7)
        + '" fill="#939aa7" font-size="11">' + y + '</text>';
    }
  }
  // 三条水平参考线（净值刻度）
  for (var q = 0; q <= 2; q++){
    var vv = lo + (hi - lo) * q / 2;
    g += '<line x1="' + PL + '" y1="' + Y(vv).toFixed(1) + '" x2="' + (W - PR)
      + '" y2="' + Y(vv).toFixed(1) + '" stroke="#e3e6eb" stroke-width="1" stroke-dasharray="3 4"/>'
      + '<text x="' + PL + '" y="' + (Y(vv) - 4).toFixed(1)
      + '" fill="#4a5260" font-size="10">' + vv.toFixed(2) + '</text>';
  }
  var last = nav[nav.length - 1];
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">'
    + g
    + '<path d="' + d(2) + '" fill="none" stroke="#5b6472" stroke-width="1.6" opacity=".85"/>'
    + '<path d="' + d(1) + '" fill="none" stroke="#d93a3a" stroke-width="2.2"/>'
    + '<circle cx="' + X(nav.length - 1).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1)
    + '" r="3.5" fill="#d93a3a"/>'
    + '</svg>';
}

/* 超额热力格：正红负绿（A 股习惯），透明度按幅度缩放，上限 0.45 免得糊成一片 */
function labHeat(v){
  if (v == null || !isFinite(v)) return '<td class="n">-</td>';
  var a = Math.min(0.45, 0.08 + Math.abs(v) * 1.9);
  var bg = v >= 0 ? 'rgba(217,58,58,' + a.toFixed(2) + ')'
                  : 'rgba(14,154,97,' + a.toFixed(2) + ')';
  return '<td style="background:' + bg + '">' + (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '</td>';
}

function renderLab(){
  var L = LAB;
  if (!L) return '';
  var E = L.pe.all, C = L.counts, U = L.universe;
  var newAlive = C.alive - (C.fam_alive['Alpha101'] || 0);
  var h = '';

  h += '<div class="rssec"><h4>第二批 · 指数去重后的 ' + C.n_new + ' 个新因子</h4>';

  h += '<div class="rsnote">'
    + '上面那套是 <b>' + U.n_etf + ' 只 ETF 的个股口径</b>——同一指数常有 3~4 只 ETF，'
    + '在横截面里各占一行，等于同一件事投了 3~4 票，算出来的 IC 被同质化噪声稀释。'
    + '这一批先按指数去重：<b>' + U.n_etf + ' 只 → ' + U.n_idx + ' 个指数</b>'
    + '（股票 + 商品，剔除债券与货币），每天在指数内留 20 日均成交额最大的一只，'
    + '收益按累乘拼接，不是直接取价格——否则换券那天会出现假跳空。'
    + '<br>然后在这 ' + U.n_idx + ' 个指数上，用同一套分段（' + L.window[0] + ' ~ ' + L.window[1]
    + '，2023 年底切分）跑 ' + C.n_new + ' 个新因子和 ' + C.n_alpha + ' 个 Alpha101。'
    + '</div>';

  h += '<div class="rsk" style="margin-top:10px">'
    + rsCard('标的池', U.n_idx, U.n_etf + ' 只 ETF 去重')
    + rsCard('因子数', C.n_new + C.n_alpha, '新 ' + C.n_new + ' + Alpha ' + C.n_alpha)
    + rsCard('两期都显著', C.alive, '新 ' + newAlive + ' + Alpha ' + (C.fam_alive['Alpha101'] || 0), 'down')
    + rsCard('PE 策略年化', rsPct(E.ann), '基准 ' + rsPct(E.b_ann), E.ann > 0 ? 'up' : 'down')
    + rsCard('夏普', E.sharpe.toFixed(2), '基准 ' + E.b_sharpe.toFixed(2))
    + rsCard('最大回撤', rsPct(E.mdd, 1), '基准 ' + rsPct(E.b_mdd, 1))
    + '</div>';

  // ---- 净值 ----
  h += '<div class="labchart">'
    + '<div class="lablg">'
    + '<span><i style="background:#d93a3a"></i>PE 单因子（做多前 20%）</span>'
    + '<span><i style="background:#5b6472"></i>' + U.n_idx + ' 个指数等权</span>'
    + '<span style="margin-left:auto;color:var(--txt3)">持有 20 日 · 双边各 5bp</span></div>'
    + labSvg(L.pe.nav)
    + '<div class="cap">净值 ' + L.pe.nav[0][0] + ' 起算，末值策略 '
    + L.pe.nav[L.pe.nav.length - 1][1].toFixed(2) + ' / 基准 '
    + L.pe.nav[L.pe.nav.length - 1][2].toFixed(2)
    + '。平均持仓 ' + Math.round(E.holding) + ' 只，年换手 ' + E.to.toFixed(1) + ' 倍。</div>'
    + '</div>';

  // ---- 分年度 ----
  // ytbl：只有 4 列，窄屏下别跟着 480px 的下限一起横滚
  h += '<div class="rstwrap" style="margin-top:10px"><table class="rstbl ytbl">'
    + '<thead><tr><th>年度</th><th>PE 策略</th><th>指数等权</th><th>超额</th></tr></thead><tbody>';
  for (var i = 0; i < L.pe.yearly.length; i++){
    var r = L.pe.yearly[i];
    var tag = (i === 0 ? '2019*' : (i === L.pe.yearly.length - 1 ? r[0] + '*' : String(r[0])));
    h += '<tr><td>' + tag + '</td>'
      + '<td class="' + cc(r[1]) + '">' + rsPct(r[1]) + '</td>'
      + '<td>' + rsPct(r[2]) + '</td>'
      + '<td class="' + cc(r[3]) + '"><b>' + rsPct(r[3]) + '</b></td></tr>';
  }
  h += '</tbody></table></div>'
    + '<div class="cap" style="font-size:10.5px;color:var(--txt3);margin-top:5px">'
    + '* 2019 从 6 月起、2026 到 11 月止，都不是完整年度。'
    + '超额全在下跌年：2022 赢 28 个点、2026 赢 22 个点，2020 输 13 个点。</div>';

  // ---- 敏感性 ----
  var HOLDS = [10, 20, 30], WINS = [10, 20, 40, 60, 120];
  function grid(field){
    var s = '<table><thead><tr><th>窗口\\持有</th>';
    for (var j = 0; j < HOLDS.length; j++) s += '<th>' + HOLDS[j] + ' 日</th>';
    s += '</tr></thead><tbody>';
    for (var a = 0; a < WINS.length; a++){
      s += '<tr><td class="n">' + WINS[a] + ' 日</td>';
      for (var b = 0; b < HOLDS.length; b++){
        var val = null;
        for (var k = 0; k < L.sens.length; k++){
          var t = L.sens[k];
          if (t[0] === WINS[a] && t[1] === HOLDS[b] && Math.abs(t[2] - 0.2) < 1e-6){
            val = field === 'a' ? t[3] : t[4];
            break;
          }
        }
        s += labHeat(val);
      }
      s += '</tr>';
    }
    return s + '</tbody></table>';
  }
  h += '<div class="labgrid" style="margin-top:12px">'
    + '<div class="box"><h5>样本内 2021–2023 超额（%）· 持仓前 20%</h5>' + grid('a') + '</div>'
    + '<div class="box"><h5>样本外 2024–2026 超额（%）· 持仓前 20%</h5>' + grid('b') + '</div>'
    + '</div>'
    + '<div class="cap" style="font-size:10.5px;color:var(--txt3);margin-top:6px">'
    + '45 组参数里 33 组样本外超额为正，但只有 <b>10~20 日窗口</b>有效，40 日以上衰减到零。'
    + '它抓的是月度尺度的路径质量，拉到季度就不成立——这不是一个「万能」因子。</div>';

  h += '</div>';   // rssec

  // ---- 201 个因子 ----
  var rows = L.cross.slice();
  rows.sort(function(x, y){
    var a1 = x[7] == null ? -9 : x[7], b1 = y[7] == null ? -9 : y[7];
    return b1 - a1;
  });
  var LIMIT = 25;
  h += '<div class="rssec"><h4>' + C.n_new + ' 个新因子 vs ' + C.n_alpha + ' 个 Alpha101 · 按样本外超额排序</h4>';
  h += '<div class="labtabs" id="labTabs">'
    + '<button data-m="all" class="on">全部 ' + rows.length + '</button>'
    + '<button data-m="sig">两期都显著 ' + C.alive + '</button>'
    + '<button data-m="new">只看新因子 ' + C.n_new + '</button>'
    + '<button data-m="alp">只看 Alpha101 ' + C.n_alpha + '</button>'
    + '</div>';
  h += '<div class="rstwrap"><table class="rstbl labtbl" id="labTbl"><thead><tr>'
    + '<th>因子</th><th style="text-align:left">含义 / 家族</th>'
    + '<th>内 IC</th><th>t</th><th>内超额</th>'
    + '<th>外 IC</th><th>t</th><th>外超额</th></tr></thead><tbody>';
  for (var m = 0; m < rows.length; m++){
    var x = rows[m];
    var isNew = x[1] !== 'Alpha101';
    var sigOk = (x[3] != null && x[3] > 2 && x[4] != null && x[4] > 0
                 && x[6] != null && x[6] > 1.5 && x[7] != null && x[7] > 0) ? 1 : 0;
    var nm = x[8] || (ALPHA_META[x[0]] && ALPHA_META[x[0]].nm) || '';
    h += '<tr data-s="' + sigOk + '" data-n="' + (isNew ? 1 : 0) + '"'
      + (m >= LIMIT ? ' class="labx" style="display:none"' : '') + '>'
      + '<td><b' + (sigOk ? ' style="color:#c2410c"' : '') + '>' + esc(x[0]) + '</b></td>'
      + '<td class="nm">' + esc(nm) + '<br><span class="fam">' + esc(x[1]) + '</span></td>'
      + '<td class="' + cc(x[2]) + '">' + (x[2] == null ? '-' : x[2].toFixed(4)) + '</td>'
      + '<td>' + (x[3] == null ? '-' : x[3].toFixed(2)) + '</td>'
      + '<td class="' + cc(x[4]) + '">' + rsPct(x[4]) + '</td>'
      + '<td class="' + cc(x[5]) + '">' + (x[5] == null ? '-' : x[5].toFixed(4)) + '</td>'
      + '<td>' + (x[6] == null ? '-' : x[6].toFixed(2)) + '</td>'
      + '<td class="' + cc(x[7]) + '"><b>' + rsPct(x[7]) + '</b></td></tr>';
  }
  h += '</tbody></table></div>';
  if (rows.length > LIMIT){
    h += '<div class="rsmore"><button id="labMore" data-open="0">展开全部 '
      + rows.length + ' 个</button></div>';
  }
  h += '<div class="rsnote" style="margin-top:8px">'
    + '<b>样本内筛不出样本外。</b>这 ' + rows.length + ' 个因子里，样本内显著的有 ' + C.sig_in
    + ' 个，但其中只有 ' + C.alive + ' 个在样本外还站得住；反过来，样本外有效的 '
    + (C.alive + C.only_out) + ' 个里有 ' + C.only_out + ' 个样本内根本看不出（t&lt;2 或超额为负）。'
    + '样本内最显著的 <b>MOM_12_1</b>（t=4.5）样本外超额 <b>−4.1%</b>——'
    + 'IC 靠空头端撑起来，而 ETF 融不到券，多头拿不到。<br>'
    + '<b>所以这张表要倒过来读：</b>看样本外那一列，别用样本内排序去挑。'
    + '</div></div>';

  return h;
}

function labBind(){
  var tabs = document.getElementById('labTabs');
  var tbl = document.getElementById('labTbl');
  if (!tabs || !tbl) return;
  var body = tbl.tBodies[0];
  function apply(mode){
    var shown = 0;
    for (var i = 0; i < body.rows.length; i++){
      var r = body.rows[i];
      var ok = mode === 'all' ? true
        : (mode === 'sig' ? r.getAttribute('data-s') === '1'
        : (mode === 'new' ? r.getAttribute('data-n') === '1'
        : r.getAttribute('data-n') === '0'));
      // 筛选后全部展开；回到「全部」时恢复前 25 行
      var vis = ok && (mode !== 'all' || i < 25);
      r.style.display = vis ? '' : 'none';
      if (vis) shown++;
    }
    var more = document.getElementById('labMore');
    if (more) more.style.display = mode === 'all' ? '' : 'none';
    var btns = tabs.getElementsByTagName('button');
    for (var j = 0; j < btns.length; j++){
      btns[j].className = btns[j].getAttribute('data-m') === mode ? 'on' : '';
    }
    return shown;
  }
  tabs.onclick = function(e){
    var b = e.target;
    if (b.tagName !== 'BUTTON') return;
    apply(b.getAttribute('data-m'));
  };
  var more = document.getElementById('labMore');
  if (more){
    more.onclick = function(){
      for (var i = 0; i < body.rows.length; i++) body.rows[i].style.display = '';
      more.style.display = 'none';
    };
  }
}

function renderRs(){
  var R = RESEARCH;
  if (!R) return;
  document.getElementById('rsSub').textContent =
    R.window[0] + ' ~ ' + R.window[1] + ' · Alpha101 ' + R.ic.n
    + (LAB ? ' + 新因子 ' + LAB.counts.n_new : '')
    + ' · 生成 ' + String(R.generated_at || '').replace('T', ' ').slice(0, 16);

  var h = '';

  // ---- 关键数字 ----
  var multi = null, eqLong = null;
  for (var i = 0; i < R.bt.length; i++){
    if (R.bt[i][0].indexOf('101因子等权') === 0 && R.bt[i][0].indexOf('多空') > 0) multi = R.bt[i];
    if (R.bt[i][0].indexOf('全市场等权') === 0) eqLong = R.bt[i];
  }
  h += '<div class="rssec"><h4>关键结论</h4><div class="rsk">'
    + rsCard('因子数', R.ic.n, 'Alpha101 全集')
    + rsCard('IC 为负', R.ic.neg + ' / ' + R.ic.n,
      (R.ic.neg / R.ic.n * 100).toFixed(0) + '% 方向是反的', 'down')
    + rsCard('相关性均值', R.corr.mean.toFixed(3),
      '中位 ' + R.corr.median.toFixed(3) + ' · |ρ|>0.6 占 ' + (R.corr.gt06 * 100).toFixed(1) + '%')
    + rsCard('相关性簇', R.clusters, '阈值 ' + R.cluster_thresh)
    + rsCard('样本外夏普', multi ? multi[4].toFixed(2) : '-',
      '101 因子等权多空 · ' + (multi ? multi[1] : '-') + ' 天', 'down')
    + rsCard('基准（全市场等权）', eqLong ? eqLong[4].toFixed(2) : '-',
      '同期多头 · 年化 ' + (eqLong ? rsPct(eqLong[2]) : '-'))
    + '</div></div>';

  // ---- 样本外回测 ----
  h += '<div class="rssec"><h4>样本外回测 · ' + R.test[0] + ' ~ ' + R.test[1]
    + '（' + R.test_days + ' 个交易日，持有 ' + R.horizon + ' 日）</h4>';
  h += '<div class="rstwrap"><table class="rstbl btbl"><thead><tr><th>策略</th><th>天数</th><th>年化</th>'
    + '<th>年化波动</th><th>夏普</th><th>最大回撤</th><th>胜率</th>'
    + '<th>IC 均值</th><th>IR</th></tr></thead><tbody>';
  for (var k = 0; k < R.bt.length; k++){
    var r = R.bt[k];
    var isBase = r[0].indexOf('全市场等权') === 0;
    h += '<tr' + (isBase ? ' style="color:var(--txt3)"' : '') + '>'
      + '<td>' + r[0] + '</td><td>' + (r[1] == null ? '-' : r[1]) + '</td>'
      + '<td class="' + cc(r[2]) + '">' + rsPct(r[2]) + '</td>'
      + '<td>' + rsPct(r[3]) + '</td>'
      + '<td class="' + cc(r[4]) + '">' + (r[4] == null ? '-' : r[4].toFixed(2)) + '</td>'
      + '<td class="down">' + rsPct(r[5]) + '</td>'
      + '<td>' + (r[6] == null ? '-' : (r[6] * 100).toFixed(1) + '%') + '</td>'
      + '<td>' + (r[7] == null ? '-' : r[7].toFixed(4)) + '</td>'
      + '<td>' + (r[8] == null ? '-' : r[8].toFixed(3)) + '</td></tr>';
  }
  h += '</tbody></table></div></div>';

  // ---- 全部因子 ----
  // 原来只列 IC 最大的 12 个，看着像「就算出这么几个」。实际算了 101 个，
  // 全部摊开、每行都能点开看构造方式，才回答得了「这因子到底在算什么」。
  var rows = R.ic.rows.slice().sort(function(a, b){
    return Math.abs(b[1] || 0) - Math.abs(a[1] || 0);
  });
  var LIMIT = 20;
  h += '<div class="rssec"><h4>全部 ' + rows.length + ' 个因子 · 点任一行看它怎么算'
    + '（按 |IC| 排序）</h4>';
  h += '<div class="rstwrap"><table class="rstbl fxtbl" id="rsAll"><thead><tr><th>因子</th><th>含义</th>'
    + '<th>IC 均值</th><th>IR</th><th>t 值</th><th>胜率</th><th>有效天数</th></tr></thead><tbody>';
  for (var m = 0; m < rows.length; m++){
    var x = rows[m], mi = ALPHA_META[x[0]] || {};
    h += '<tr class="fxr' + (m >= LIMIT ? ' fxx' : '') + '" data-f="' + x[0] + '">'
      + '<td><b>' + x[0] + '</b></td>'
      + '<td class="fxnm">' + esc(mi.nm || '—') + '</td>'
      + '<td class="' + cc(x[1]) + '">' + (x[1] == null ? '-' : x[1].toFixed(4)) + '</td>'
      + '<td>' + (x[2] == null ? '-' : x[2].toFixed(3)) + '</td>'
      + '<td>' + (x[3] == null ? '-' : x[3].toFixed(2)) + '</td>'
      + '<td>' + (x[4] == null ? '-' : (x[4] * 100).toFixed(1) + '%') + '</td>'
      + '<td>' + (x[5] == null ? '-' : x[5]) + '</td></tr>';
  }
  h += '</tbody></table></div>';
  if (rows.length > LIMIT){
    h += '<div class="rsmore"><button id="rsMore" data-open="0" data-n="'
      + rows.length + '">展开全部 ' + rows.length + ' 个</button></div>';
  }
  h += '<div class="rsnote" style="margin-top:8px">IC 均值到 0.03 就算「强」了，'
    + '这里最大的只有 ' + (rows[0] ? Math.abs(rows[0][1]).toFixed(3) : '-')
    + '；而 t 值超过 2 只能说明「不是零」，不代表能赚钱——'
    + '2671 天的样本下，t=2 的因子随手就能找到一堆。'
    + 'IC 为负说明因子和收益方向相反，反着用才有意义。</div></div>';

  // ---- 入选组合 ----
  h += '<div class="rssec"><h4>相关性去重后入选的 ' + R.picks.length + ' 个因子</h4>';
  h += '<div class="rstwrap"><table class="rstbl"><thead><tr><th>因子</th><th>IC 均值</th><th>IR</th>'
    + '<th>t 值</th><th>胜率</th><th>所属簇</th></tr></thead><tbody>';
  for (var p = 0; p < R.picks.length; p++){
    var q = R.picks[p];
    h += '<tr><td>' + q[0] + '</td>'
      + '<td class="' + cc(q[1]) + '">' + q[1].toFixed(4) + '</td>'
      + '<td>' + q[2].toFixed(3) + '</td>'
      + '<td>' + q[3].toFixed(2) + '</td>'
      + '<td>' + (q[4] * 100).toFixed(1) + '%</td>'
      + '<td>' + q[5] + '</td></tr>';
  }
  h += '</tbody></table></div></div>';

  // ---- 第二批：指数去重池（201 个因子的两期对照 + PE 策略） ----
  h += renderLab();

  // ---- 指标说明 ----
  var IND = [
    ['MA20', '20 日移动平均', '价格在均线上方偏强；偏离超过 ±5% 容易回归'],
    ['MA60', '60 日移动平均', '中期趋势线，跌破后反弹常在此受阻'],
    ['RSI14', '14 日相对强弱', '>70 超买、<30 超卖；低波动标的（债券 ETF）在 30~90 间摆动，参考价值有限'],
    ['MACD DIF', '快慢均线差', '在零轴上方说明中期动能偏多'],
    ['MACD DEA', 'DIF 的均线', 'DIF 上穿 DEA 为金叉，下穿为死叉'],
    ['BOLL %B', '价格在布林带中的位置', '0% 贴下轨、100% 贴上轨；突破上下轨说明波动放大'],
    ['ATR14', '14 日平均真实波幅', '换成占价百分比，就是这只标的的「日常抖动幅度」'],
    ['HVOL20', '20 日年化波动率', '股票型 ETF 通常 15~30%，债券型 2~5%'],
    ['量比5', '当日成交量 / 5 日均量', '>1.5 放量，>3 异动，<0.6 缩量']
  ];
  h += '<div class="rssec"><h4>K 线里那 9 个指标怎么看</h4>'
    + '<div class="rstwrap"><table class="rstbl indtbl"><thead><tr><th>指标</th><th style="text-align:left">含义</th>'
    + '<th style="text-align:left">怎么读</th></tr></thead><tbody>';
  for (var n2 = 0; n2 < IND.length; n2++){
    h += '<tr><td>' + IND[n2][0] + '</td>'
      + '<td style="text-align:left;font-family:inherit">' + IND[n2][1] + '</td>'
      + '<td style="text-align:left;font-family:inherit;color:var(--txt2)">' + IND[n2][2] + '</td></tr>';
  }
  h += '</tbody></table></div>'
    + '<div class="rsnote" style="margin-top:8px">'
    + '这 9 个是盯盘时真正看得上眼的。完整算了 <b>56 个指标 + 101 个 Alpha 因子</b>，'
    + '全量存在 Parquet 里给回测用，页面上摊开反而干扰判断。'
    + '每个指标的公式、参数、失效场景见仓库 <b>docs/FACTORS.md</b>。</div></div>';

  // ---- 结论 ----
  h += '<div class="rssec"><h4>怎么读这些数</h4>'
    + '<div class="rsnote">'
    + '<b>结论是「不要用」。</b>训练段（' + R.train[0] + ' ~ ' + R.train[1] + '，'
    + R.train_days + ' 天）夏普 1.21 / 1.61，同几个因子到测试段（'
    + R.test_days + ' 天）变成 −0.67 / −0.71，IC 持续性只有 0.184、同号率 53%——'
    + '和抛硬币分不开。<br><br>'
    + '<b>不是因为因子互相重复。</b>两两相关性均值 ' + R.corr.mean.toFixed(3)
    + '、中位 ' + R.corr.median.toFixed(3) + '，|ρ|>0.6 只有 ' + (R.corr.gt06 * 100).toFixed(1)
    + '%，' + R.ic.n + ' 个因子聚成 ' + R.clusters + ' 簇、其中 60 个是单因子簇——'
    + '它们确实各不相同，只是每个都很弱。弱信号被噪声主导，这叫衰减偏差。'
    + '<br><br>'
    + '<b>ETF 上尤其弱的原因：</b>Alpha101 是给个股设计的，衡量的是「这只股票会跑赢同行多少」。'
    + 'ETF 是一篮子股票，成分股的 alpha 互相抵消，剩下的主要是风格暴露（大小盘、成长价值），'
    + '而风格暴露靠资产配置就能拿到，不需要 101 个因子。<br><br>'
    + '<b>但换个池子，结论变了一半。</b>上面这套是 ' + '1717 只 ETF 的个股口径，'
    + '压到 468 个指数后（同指数只留流动性最好的那只），Alpha101 有 6 个、'
    + '新因子有 3 个在两期里都站得住。其中 PE 单独做多前 20%，2019-06 以来年化 12.68%、'
    + '等权基准 5.44%——代价是 2020 年跑输 13 个点、2025 年只赢 1.6 个点，超额全在下跌年。'
    + '详见下面「第二批」那一节。<br><br>'
    + '<b>所以这个页面的价值在盯盘和 K 线，选股信号只是副产物。</b>'
    + '因子部分留两个记录：个股口径的 101 个跑过了、结论是负的；'
    + '指数口径的换了池子才有信号，而且只活在特定年份。'
    + '</div><div class="rssrc">完整推导见仓库 docs/FACTORS.md（620 行）</div></div>';

  document.getElementById('rsBody').innerHTML = h;
  rsBind();
  labBind();
}

/* 因子详情行。数据来自 ALPHA_META——构建时由 tools/gen_alpha_meta.py
   从 alpha101.py 的 AST 生成，所以这里显示的就是代码里真正在跑的那条式子，
   不是另写一份文档等着过期。 */
function rsDetailRow(id){
  var m = ALPHA_META[id];
  var body = m
    ? '<div class="fxdn"><b>' + esc(id) + '</b>' + esc(m.nm) + '</div>'
      + '<div class="fxds">' + esc(m.ds) + '</div>'
      + '<pre class="fxf">' + esc(m.f) + '</pre>'
    : '<div class="fxdn"><b>' + esc(id) + '</b></div>'
      + '<div class="fxds">这个因子没有录入说明。</div>';
  return '<tr class="fxdet"><td colspan="7"><div class="fxd">' + body + '</div></td></tr>';
}

function rsBind(){
  var tbl = document.getElementById('rsAll');
  if (tbl){
    tbl.onclick = function(e){
      var tr = e.target;
      while (tr && tr.tagName !== 'TR') tr = tr.parentNode;
      if (!tr || !tr.className || tr.className.indexOf('fxdet') >= 0) return;
      var id = tr.getAttribute('data-f');
      if (!id) return;
      var nx = tr.nextElementSibling;
      if (nx && nx.className.indexOf('fxdet') >= 0){   // 再点一次收起
        nx.parentNode.removeChild(nx);
        tr.classList.remove('on');
        return;
      }
      tr.insertAdjacentHTML('afterend', rsDetailRow(id));
      tr.classList.add('on');
    };
  }
  var more = document.getElementById('rsMore');
  if (more){
    more.onclick = function(){
      var open = this.getAttribute('data-open') === '1';
      var next = !open;
      var all = tbl.getElementsByTagName('tr');
      for (var i = 0; i < all.length; i++){
        if (all[i].className.indexOf('fxx') >= 0){
          all[i].style.display = next ? 'table-row' : 'none';
        }
      }
      // 展开时把详情行一起露出，否则点开的构造方式还藏在 display:none 里
      for (var j = 0; j < all.length; j++){
        if (all[j].className.indexOf('fxdet') >= 0) all[j].style.display = next ? 'table-row' : '';
      }
      this.setAttribute('data-open', next ? '1' : '0');
      this.textContent = next ? '收起，只看前 20 个'
        : ('展开全部 ' + (this.getAttribute('data-n') || '全部') + ' 个');
    };
  }
}

/* 内嵌的那份是部署时的快照，先画出来（0ms，断网也有）；再向服务端要当天的。
   远端拿不到就保持现状，不弹错——这个页面不该因为一次请求失败变成空白。 */
function pullResearch(){
  fetch('/api/research').then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.ok === false || !j.ic || !j.bt) return;
    RESEARCH = j;
    var body = document.getElementById('rsBody');
    var top = body.scrollTop;
    renderRs();
    body.scrollTop = top;
  }).catch(function(){});
}

function openRs(){
  if (!document.getElementById('rsBody').innerHTML) renderRs();
  document.getElementById('rsMask').classList.add('on');
}
function closeRs(){
  document.getElementById('rsMask').classList.remove('on');
}
document.getElementById('rsClose').onclick = closeRs;
document.getElementById('rsMask').onclick = function(e){
  if (e.target === this) closeRs();
};

document.getElementById('btnSync').onclick = function(){
  var link = location.origin + '/?u=' + encodeURIComponent(WATCH_UID);
  function fallback(){ window.prompt('在另一台设备打开这个链接，就是你现在的自选：', link); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(function(){
      toast('同步链接已复制，在另一台设备打开即可');
    }).catch(fallback);
  } else fallback();
};

document.getElementById('hSubs').onclick = function(e){
  var b = e.target;
  if (!b || b.tagName !== 'B') return;
  var k = b.getAttribute('data-s');
  if (!k || k === H.sub) return;
  H.sub = k;
  var kids = this.getElementsByTagName('b');
  for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('on', kids[i] === b);
  if (H.d){ hDraw(); hLegend(H.hover); }
};
document.getElementById('hOv').onclick = function(e){
  var b = e.target;
  if (!b || b.tagName !== 'B') return;
  var k = b.getAttribute('data-o');
  if (!k) return;
  H.ov[k] = !H.ov[k];
  b.classList.toggle('on', !!H.ov[k]);
  if (H.d){ hDraw(); hLegend(H.hover); }
};

document.getElementById('hClose').onclick = closeHist;document.getElementById('histMask').onclick = function(e){
  if (e.target === this) closeHist();
};
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  if (document.getElementById('rsMask').classList.contains('on')) { closeRs(); return; }
  if (document.getElementById('histMask').classList.contains('on')) closeHist();
});

document.getElementById('histCv').addEventListener('mousemove', function(e){
  var rect = this.getBoundingClientRect();
  var x = e.clientX - rect.left;
  if (H.mode === 'min'){
    if (!H.mgeo) return;
    var mi = minIdxAt(x);
    if (mi < 0 || mi === H.hover) return;
    H.hover = mi;
    hCrossMin(mi);
    return;
  }
  var g = H.geo; if (!g || !H.d) return;
  var idx = g.i0 + Math.floor((x - g.padL) / g.bw);
  var rng = H.range || H.d.n;
  idx = Math.max(g.i0, Math.min(H.d.n - 1, idx));
  if (idx === H.hover) return;
  H.hover = idx;
  hCross(idx);
});
document.getElementById('histCv').addEventListener('mouseleave', function(){
  if (!H.geo && !H.mgeo) return;
  H.hover = -1;
  H.ctx.setTransform(1,0,0,1,0,0);
  H.ctx.clearRect(0, 0, H.cv.width, H.cv.height);
  H.ctx.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
  H.ctx.drawImage(H.off, 0, 0, H.W, H.Ht);
  hLegend(-1);
});

Array.prototype.forEach.call(document.querySelectorAll('#hMode b'), function(b){
  b.onclick = function(){ setHMode(b.getAttribute('data-m'), false); };
});

/* 展开/收起：用上一次的响应重画，不重新请求——PCF 盘中也变不了，
   为了一次折叠去等 300ms 甚至撞一次上游超时都不值得。
   监听挂在整块 #hHold 上：表头和底部按钮用的是同一个 data-holdm。 */
document.getElementById('hHold').addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('[data-holdm]') : null;
  if (!b) return;
  H.holdAll = b.getAttribute('data-holdm') === '1';
  if (H.hj){
    renderHold(H.hj);
    // 收起时滚回顶部：不然停在 300 行处的滚动位置会落到一段空白上
    if (!H.holdAll) document.getElementById('hHold').scrollTop = 0;
  }
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
    // 分时用 H.m 而不是 H.d，两个都要认，否则改窗口大小后图会被拉变形
    var ready = (H.mode === 'min') ? !!H.m : !!H.d;
    if (ready){ H.hover = -1; hDraw(); hLegend(-1); }
  }, 140);
});

/* ---------- 数据加载 ---------- */
function setStale(msg, bad){
  var el = document.getElementById('staleBar');
  if (!msg){ el.style.display = 'none'; el.textContent = ''; el.className = 'stalebar'; return; }
  el.style.display = 'block';
  el.className = 'stalebar' + (bad ? ' bad' : '');
  el.textContent = msg;
}

function loadFull(){
  return fetch('/api/all').then(function(r){ return r.json(); }).then(function(j){
    if (!j.raw){ throw new Error(j.error || '无数据'); }
    DATA_SRC = j.src;
    var items = normalize(j.src, j.raw);
    markKeep(items);                 // 先定每组的代表标的，渲染和统计都依赖它
    // 价格变动闪烁依赖前后对比，保留 lastP
    DATA = items;
    STATS = computeStats(items);
    // 时间以服务端为准：这是「数据本身」的时刻，不是「浏览器收到」的时刻。
    // 上游挂了的时候后端会把旧快照原样发回来并打上 stale，这里必须照实标出来，
    // 而不是盖一个「更新 17:52」让人以为是最新的。
    DATA_TS = j.ts || Date.now();
    if (retryTimer){ clearTimeout(retryTimer); retryTimer = null; }

    var nPre = 0;
    for (var z=0;z<items.length;z++) if (items[z].pre) nPre++;
    var preNote = nPre > items.length * 0.5 ? ' · 非交易时段，现价取昨收' : '';

    var dst = document.getElementById('d-src');
    dst.classList.remove('up','down'); dst.classList.add('up');
    document.getElementById('srcName').textContent = j.src === 'eastmoney' ? '东财' : '新浪';
    document.getElementById('fSrc').textContent = '数据源: '
      + (j.src === 'eastmoney' ? '东方财富（含 IOPV）' : '新浪财经')
      + ' · ' + items.length + ' 只' + preNote;
    document.getElementById('fTs').textContent = (j.stale ? '旧数据 ' : '更新 ')
      + new Date(DATA_TS).toLocaleTimeString('zh-CN');
    document.getElementById('fErr').textContent = '';
    // 横幅贴在卡片下面：表格很长，footer 里的提示根本看不见
    setStale(j.stale
      ? '行情源暂时不可用，正在显示 ' + Math.max(1, Math.round((Date.now() - DATA_TS) / 60000))
        + ' 分钟前的快照，后台自动重试中（自选行情不受影响，走腾讯直连）'
      : '', false);

    var hasPm = items.some(function(x){ return x.pm != null; });
    void hasPm;

    renderCards(); renderList(); renderWatch();
    hRefresh();                      // 弹窗开着就跟着这次快照重算最后一根
    // 涨速榜的池子是从这份快照里挑的，第一次拿到数据才有得挑
    if (!SPD.rows.length && !SPD.loading) spdFetch();
  }).catch(function(e){
    setStale('行情源暂时不可用（' + e.message + '），15 秒后自动重试；自选行情走腾讯直连，不受影响', true);
    document.getElementById('fErr').textContent = '';
    if (!DATA.length) document.getElementById('listBody').innerHTML =
      '<tr><td colspan="11" class="empty">行情源暂时不可用，正在自动重试…<br>'
      + '<span style="opacity:.55;font-size:12px">' + e.message + '</span></td></tr>';
    // 15 秒后自己再试一次，别干等下一个 60 秒周期
    if (!retryTimer) retryTimer = setTimeout(function(){ retryTimer = null; loadFull(); }, 15000);
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
      hRefresh();                    // 自选 5 秒一刷，弹窗里那只也一起动
      var tip = document.getElementById('quoteTip');
      if (tip) tip.textContent = '自选经浏览器直连腾讯 · ' + (isOpen()?'5 秒':'30 秒')
        + '刷新 · ' + new Date().toLocaleTimeString('zh-CN');
    }
    finish();
  };
  s.onerror = function(){
    if (done) return;
    var tip = document.getElementById('quoteTip');
    if (tip) tip.textContent = '腾讯直连失败，自选跟随全市场数据 · '
        + new Date().toLocaleTimeString('zh-CN');
    finish();
  };
  document.head.appendChild(s);
  setTimeout(finish, 6000);
}

function schedule(){
  clearInterval(timerSlow); clearInterval(timerFast); clearInterval(timerSpd);
  clearInterval(timerT3);
  var open = isOpen();
  // 全市场：交易时段 60 秒，非交易 300 秒（保护新浪上游，避免被风控）
  timerSlow = setInterval(loadFull, open ? 60000 : 300000);
  // 自选高频：浏览器直连腾讯，不经过 Worker，5 秒一次也不消耗任何配额
  timerFast = setInterval(loadTXQuotes, open ? 5000 : 30000);
  /* 涨速榜 30 秒一轮，和 /api/min 的 30 秒分桶对齐——再密也只是反复命中
     同一个缓存桶。服务端已经对同一批代码做 30 秒缓存，这里多刷一次不会
     多打一次上游；真正省的是「切到后台标签页时停掉」。 */
  timerSpd = setInterval(function(){
    if (isOpen() && !spdClosed() && document.visibilityState !== 'hidden') spdFetch();
  }, 30000);
  /* 「主要贡献」60 秒一轮，和 /api/top3 的 60 秒分桶对齐。带 force 走一遍：
     指纹没变时 ensureTop3 会直接返回，这里要的是「同一份自选重算一次」。
     切到后台标签页时跳过——它比行情重得多（每轮要拉上千只成分的行情）。 */
  clearInterval(timerT3);
  timerT3 = setInterval(function(){
    if (!watch.length || document.visibilityState === 'hidden') return;
    if (TOP3_BUSY) return;
    runTop3(watch.slice(0, 30));
  }, 60000);
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

/* /research 走独立页面：同一个 HTML，只是把因子面板提到文档流里。
   URL 直接可分享，也不占一个弹窗的注意力。 */
var _pn = location.pathname;
var RS_MODE = (_pn === '/research' || _pn === '/research/' || _pn === '/r' || _pn === '/r/');

if (RS_MODE){
  document.body.classList.add('rsmode');
  document.title = '因子研究 · ETF 全市场';
  renderRs();
  document.getElementById('rsMask').classList.add('on');
  pullResearch();
} else {
  pullWatch();
  loadFull().then(function(){
    renderCards();
    mktInit();
    diagInit();
    loadTXQuotes();
    schedule();
    deepLink();
  });
}

/* 深链：?panel=rs 直接打开因子研究，?panel=hist&code=510300 直接看某只 K 线。
   方便把结论发给别人，不用让对方自己找。 */
/* 取 query 参数。故意不用正则：这段代码整体在模板字符串里，
   源码里的 \\ 会被 Node 求值和 build.mjs 文本替换分别处理一次，
   两条路径结果不同（本地预览正常、线上报错）。用字符串切分绕开这个坑。 */
function qs(name){
  var parts = location.search.slice(1).split('&');
  for (var i = 0; i < parts.length; i++){
    var eq = parts[i].indexOf('=');
    if (eq > 0 && parts[i].slice(0, eq) === name) return parts[i].slice(eq + 1);
  }
  return '';
}

/* 副图选择支持深链：?sub=macd 直接打开就是 MACD，分享给别人不用再点一次 */
function applySub(k){
  if (!k) return;
  if (k !== 'macd' && !SUB_DEF[k]) return;
  H.sub = k;
  var kids = document.getElementById('hSubs').getElementsByTagName('b');
  for (var i = 0; i < kids.length; i++){
    kids[i].classList.toggle('on', kids[i].getAttribute('data-s') === k);
  }
}

/* 叠加层同理：?ov=boll 只看布林，?ov=ma,boll 两个都开 */
function applyOv(v){
  if (!v) return;
  var ks = v.split(',');
  H.ov.ma = false; H.ov.boll = false;
  for (var i = 0; i < ks.length; i++){
    if (ks[i] === 'ma' || ks[i] === 'boll') H.ov[ks[i]] = true;
  }
  var kids = document.getElementById('hOv').getElementsByTagName('b');
  for (var j = 0; j < kids.length; j++){
    kids[j].classList.toggle('on', !!H.ov[kids[j].getAttribute('data-o')]);
  }
}

function deepLink(){
  applySub(qs('sub'));
  applyOv(qs('ov'));
  var p = qs('panel');
  if (!p) return;
  if (p === 'rs') { location.replace('/research'); return; }
  if (p === 'hist'){
    var c = qs('code');
    if (c) setTimeout(function(){ openHist(c, c); }, 900);
  }
}
</script>
</body>
</html>`;
