import { IDX_GROUPS } from './idx_data.js';
import { RESEARCH } from './research_data.js';
import { ALPHA_META } from './alpha_meta.js';
import { LAB } from './lab_data.js';
import { SEC_HIST } from './sec_hist.js';
import { MKT_HIST } from './mkt_hist.js';

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

// 250 个交易日的板块占比（占本组行业格成交额），由 data/etf.db 的日线回算。
// 31KB：换一次「这条线在一年里走到什么位置」，值得。页面上只有今天，
// 而「今天 39%」和「今天 39%、一年 96 分位」是两个完全不同的判断。
const SEC_HIST_JS = JSON.stringify(SEC_HIST);

// 全 A 行业口径的 250 日集中度 / 宽度（东财 128 个行业），6KB。
// 四象限用这份，不用 SEC_HIST——后者是 ETF 成交额口径，分母只有 18 个行业格，
// TOP3 天然占一半以上（58.7%），测的是「ETF 资金分布」不是「市场结构」。
const MKT_HIST_JS = JSON.stringify(MKT_HIST);

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
/* 标题：左边一个迷你柱线标识（三根递增柱），右边「ETF 盯盘」两段式——
   ETF 用等宽小字压成标识词，盯盘是主语。比原来「ETF 全市场盯盘」一大串
   平铺好读：一眼分得清「是什么」和「干什么」。
   红：页面底色是跌绿/涨红双色系统，标题取涨色（--up）才对得上「盯盘」这件
   事本身——蓝是通用 SaaS 味，跟行情没关系。 */
h1{display:flex;align-items:center;gap:9px;font-size:17px;font-weight:600;letter-spacing:.2px}
h1 .mk{display:inline-flex;align-items:flex-end;gap:2px;width:24px;height:24px;padding:5px;
  box-sizing:border-box;background:#fbe4e4;border-radius:7px}
h1 .mk i{display:block;width:3px;border-radius:1px;background:var(--up)}
h1 .mk i:nth-child(1){height:5px;opacity:.4}
h1 .mk i:nth-child(2){height:9px;opacity:.7}
h1 .mk i:nth-child(3){height:14px}
/* 「盯盘」并进 ETF 这一格里，不再单独当大字号主词：两个词本来就是一个意思，
   拆成「小徽标 + 大字」会让人先读 ETF 再读盯盘，多一次停顿。 */
h1 .tag{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);
  font-size:10.5px;font-weight:600;letter-spacing:1px;
  color:var(--up);background:#fbe6e6;border-radius:6px;padding:3px 8px 3px 7px}
/* 中文小字在同样的红下会比拉丁字母"显得"淡一档（笔画细、抗锯齿占比高），
   所以字号压到跟 ETF 一档、颜色深半格，两段看起来才是同一种红。 */
h1 .tag b{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  font-size:11.5px;font-weight:700;letter-spacing:.5px;color:#cf2f2f}
h1 em{color:var(--txt3);font-weight:400;font-size:12.5px;font-style:normal;margin-left:2px;
  font-family:var(--mono);letter-spacing:.2px}
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
/* 吸顶锚点导航：页面 7000px+，没有跳转每次找自选都要滚半天。
   top:0 吸顶（主页面 header 不吸顶，滚过就让它走），毛玻璃压住下面的内容。
   --navH 由 JS 量出来，区块 scroll-margin-top 和表头 sticky 都引用它。 */
.secnav{position:sticky;top:0;z-index:6;display:flex;gap:2px;align-items:center;
  margin:-2px 0 10px;padding:4px 0;background:rgba(245,246,248,.9);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);
  /* 六项在 375px 上必然溢出，横滑比换行好：换行会把吸顶导航顶成两行，吃掉半屏 */
  overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.secnav::-webkit-scrollbar{display:none}
.secnav a{font-size:13px;color:var(--txt2);padding:4px 14px;border-radius:6px;cursor:pointer;
  user-select:none;white-space:nowrap}
.secnav a:hover{color:var(--txt)}
.secnav a.on{background:var(--bg2);color:var(--txt);border:1px solid var(--line);padding:3px 13px;font-weight:600}
.sec[id],.oncard[id]{scroll-margin-top:var(--navH,42px)}
.cards{display:flex;gap:9px;margin-bottom:12px;flex-wrap:wrap}
.cards .card{width:186px;flex:0 0 auto}
@media(max-width:560px){.cards .card{width:calc(50% - 5px)}}
/* 隔夜映射卡：美股收盘 + 外盘期货按「赛道」折算到 A 股 ETF。
   盘前打开页面第一眼要看的东西，所以放在统计卡上面。
   涨红跌绿是 A 股习惯，美股数据进来也按这个上色——
   页面要迁就读者的眼睛，不是迁就数据源的习惯。 */
.oncard{background:var(--bg2);border:1px solid var(--line);border-radius:8px;
  padding:8px 12px;margin-bottom:12px;font-size:12.5px}
.onhd{display:flex;align-items:baseline;gap:8px;color:var(--txt2)}
.onhd b{color:var(--txt1);font-size:12.5px}
.onhd .n{font-size:11.5px;color:var(--txt3)}
.onhd .ofold{margin-left:auto;cursor:pointer;color:var(--txt3);user-select:none}
.onfut{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.onfut span{background:var(--bg1);border:1px solid var(--line);border-radius:4px;
  padding:2px 7px;font-size:11.5px;color:var(--txt2)}
.ontrks{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.ontrk{cursor:pointer;border:1px solid var(--line);border-radius:5px;padding:3px 9px;
  background:var(--bg1);user-select:none;display:flex;gap:6px;align-items:baseline}
.ontrk b{font-weight:500;color:var(--txt1)}
.ontrk i{font-style:normal;font-size:11.5px}
.ontrk.sel{border-color:var(--txt3)}
.ondet{margin-top:7px;padding:7px 10px;border-top:1px dashed var(--line);line-height:1.8}
.ondet .ot{color:var(--txt2);font-size:11.5px;letter-spacing:.3px}
.ondet .ous{display:flex;gap:5px 12px;flex-wrap:wrap;margin:3px 0 5px}
.ondet .ous span{white-space:nowrap}
.ondet .oetfs{display:flex;gap:5px 12px;flex-wrap:wrap}
.ondet .oetfs span{white-space:nowrap}
.ondet .mine{outline:1px solid currentColor;border-radius:3px;padding:0 3px}
/* 上游故障时的横幅：贴在卡片下面，一进页面就能看见。
   放在 footer 里等于没有——100 行的表格把 footer 顶到 4600px 之外。 */
.stalebar{margin:-2px 0 12px;padding:7px 10px;border-radius:6px;font-size:12.5px;line-height:1.5;
  background:#fff8e8;border:1px solid #f0dcb0;color:#8a5a00}
.stalebar.bad{background:#fdeeee;border-color:#f3c7c7;color:#b02a2a}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 13px}
.card .k{font-size:11.5px;color:var(--txt2);letter-spacing:.3px;margin-bottom:4px}
.card .v{font-size:19px;font-weight:600;font-family:var(--mono);line-height:1.25}
.card .v small{font-size:11.5px;font-weight:400;color:var(--txt3);margin-left:3px}
.card .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
/* ---------- 全市场异动 ---------- */
.mktwrap{display:block}
.mkbox{background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:10px 13px}
.wbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:9px 0 7px;
  background:#eef1f5;box-shadow:inset 0 0 0 1px #e3e6eb}
.wbar i{display:block;height:8px}
.wstat{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;
  color:var(--txt3);font-family:var(--mono);flex-wrap:wrap}
.wstat b{color:var(--txt);font-weight:600}
.mtabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}
.mtab{font-size:11.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--line);
  background:var(--bg3);color:var(--txt2);cursor:pointer;user-select:none;white-space:nowrap}
.mtab:hover{border-color:#c9d6ef}
.mtab.on{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8;font-weight:600}
.mtab u{text-decoration:none;margin-left:5px;font-family:var(--mono);font-size:10.5px;opacity:.7}
/* 分组间距 + 窄屏强制断行：桌面靠 margin 分出「股指 / ETF期权 / 口径」三段，
   手机上 11 个标签挤成随机三行读不出分组，改用 mbrk 主动换行 */
.mtab.grp{margin-left:10px}
.mbrk{flex:0 0 0;height:0}
@media(max-width:820px){.mbrk{flex:0 0 100%}.mtab.grp{margin-left:0}}

/* 期指期权区块：五张卡，桌面两列、手机一列。
   「基差历史」占整行——曲线要横向空间，塞进半列会把 250 个点压成一团。 */
.futgrid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.futgrid .wide{grid-column:1 / -1}
@media(max-width:900px){.futgrid{grid-template-columns:1fr}.futgrid .wide{grid-column:auto}}
.futttl{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:7px}
.futttl b{font-size:12.5px;font-weight:600;color:var(--txt);white-space:nowrap}
.futttl span{font-size:10.5px;color:var(--txt3)}
.futgrp td{background:var(--bg3);font-size:11px;color:var(--txt2);font-weight:600;
padding:5px 9px!important;border-bottom:1px solid var(--line)}
.futgrp b{font-family:var(--mono);font-weight:600}
.futgh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;min-width:0}
.futgh>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fq{font-size:10px;padding:0 4px;border-radius:3px;background:#f4f6fa;border:1px solid var(--line);margin-left:4px}
.tbl .nm + .code{margin-left:6px}
/* 期指的表格列多（合约/价格/涨跌/基差/基差率/年化/持仓），375px 一定放不下。
   这里放开横滑而不是砍列：砍掉哪一列都会有人要，「剩 11 天」和基差率是连着看的。 */
@media(max-width:900px){
  /* grid 项默认 min-width:auto，会被里面 400px 的表格反向撑破卡片：
     卡片 418px 塞进 354px 的列，结果是整页能横向平移 76px（2026-11-10 实测
     scrollX=76）。必须先把这个 min-width 放开，overflow-x:auto 才真的生效。 */
  #futSec .futgrid>div{min-width:0}
  #futSec .tbl{overflow-x:auto;-webkit-overflow-scrolling:touch}
  /* 横向滚动容器里的表头 sticky 会跟内容叠出重影（表头粘在左上角，行从下面穿过去），
     这几张表统共十几行，不需要吸顶 */
  #futSec .tbl thead th{position:static}
  #futSec table{min-width:400px}
}
/* 390 屏一行要塞 5 列，400px 的保底会让「基差率」留在屏幕外要滑一下才看得到，
   而这列恰恰是这张表最该被一眼看到的。压到 11px + 3px 内边距后 354px 正好放下 */
@media(max-width:560px){
  #futSec table{min-width:0}
  #futSec .tbl th,#futSec .tbl td{padding-left:3px;padding-right:3px;font-size:11px}
  #futSec .tbl .nm{font-size:11px}
  #futSec .tbl .code{font-size:10px}
}
.futfoot{margin-top:7px;font-size:10.5px;color:var(--txt3);line-height:1.7}
/* 基差图悬停：十字线要压住折线但不挡命中，光标给个 crosshair 提示「这里能读点」。
   touch-action:pan-y 让手机竖着滑还能滚页面，横着划才交给读点。 */
#futHistChart svg.fh{cursor:crosshair;touch-action:pan-y}
#futHistChart .fh-hov line{shape-rendering:crispEdges}
.quad{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.qcell{border:1px solid var(--line);border-radius:7px;padding:8px 10px;background:var(--bg)}
.qcell b{display:block;font-size:11px;color:var(--txt2);font-weight:500;margin-bottom:3px}
.qcell u{text-decoration:none;font-family:var(--mono);font-size:15px;font-weight:600}
.qcell i{display:block;font-style:normal;font-size:10px;color:var(--txt3);margin-top:3px;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sechd .n.warn{color:#a9660a}
.mhead,.mrow{display:grid;grid-template-columns:minmax(0,1fr) 44px 48px 46px 58px;
  gap:8px;align-items:center}
/* 宽屏两栏：13 行铺满 1376px 时，第一列会被 1fr 撑到 1148px，
   名称只有 120px，中间一大条空白，看着像错行。分两栏后每行 ~660px，
   名称和数字挨得上，同样高度还能多放一倍。表头跟着每栏各出一份。 */
.mcols{display:grid;grid-template-columns:1fr 1fr;gap:0 34px;align-items:start}
@media(max-width:1100px){.mcols{grid-template-columns:1fr;gap:0}}
@media(max-width:560px){
  /* 手机上一行放五列本来就紧，指数名让位给 ETF 名称，名称被截断更伤 */
  .mn em{display:none}
  .mhead,.mrow{grid-template-columns:minmax(0,1fr) 38px 34px 32px 50px;gap:5px}
}
.mhead{padding:0 0 5px;font-size:10.5px;color:var(--txt3);border-bottom:1px solid var(--line);
  font-family:var(--mono);letter-spacing:.3px}
.mhead span:not(:first-child){text-align:right}
.mrow{padding:5px 0;border-bottom:1px dashed var(--line);cursor:pointer;font-size:12.5px}
.mtag{font-size:10.5px;padding:1px 0;border-radius:4px;text-align:center;white-space:nowrap;
  font-weight:600;letter-spacing:.2px}
.mtag.t-up{background:#fdecee;color:#b02a2a;border:1px solid #f3c7c7}
.mtag.t-warn{background:#fff6e5;color:#a9660a;border:1px solid #f0dcb4}
.mtag.t-down{background:#e9f8f1;color:#0b7d55;border:1px solid #c2e8d6}
.mtag.t-info{background:#eaf1ff;color:#1d4ed8;border:1px solid #b9cdf7}
.mtag.t-mute{background:#f0f2f5;color:#6b7380;border:1px solid #e3e6eb}
.mrow:last-child{border-bottom:none}
.mrow:hover .mn{color:#1d4ed8}
.mn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.mn em{font-style:normal;font-size:10.5px;color:var(--txt3);margin-left:5px;font-family:var(--mono)}
.mnum{font-family:var(--mono);font-size:11.5px;text-align:right}
.mnum small{font-size:10.5px;color:var(--txt3);margin-right:2px}
/* ---- 急涨急跌 ---- */
.spdgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.spdcol{min-width:0}
.spdcol + .spdcol{border-left:1px solid var(--line);padding-left:14px}
.spdcol:first-child{padding-right:14px}
.spdnone{padding:9px 0;color:var(--txt3);font-size:11.5px}
.spdch{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--txt3);
  padding-bottom:5px;border-bottom:1px solid var(--line);margin-bottom:2px;letter-spacing:.3px}
.spdch b{font-weight:600;font-size:11.5px}
.spdch b.up{color:var(--up)}.spdch b.dn{color:var(--down)}
/* 用 flex 而不是 grid：名称 + 走势线是「左边一块信息」，涨速和量比是
   「右边两个数」。网格会把走势线顶到栏宽的中段，两边各留一片空白，
   看着像中间缺了内容。 */
.spdrow{display:flex;gap:8px;align-items:center;padding:5px 0;
  border-bottom:1px dashed var(--line);cursor:pointer;font-size:12.5px}
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
.spdnm em{flex:0 0 auto;font-style:normal;font-size:10.5px;color:var(--txt3);font-family:var(--mono)}
/* 走势线往右靠、紧贴两个数值：名字短的行中间留白，比「线飘在名字后面、
   数值孤零零在最右」稳。涨速/量比两个数成一组，才是「右块」。 */
.spk{display:block;flex:0 0 auto;margin-left:auto;overflow:visible}
.spdv{flex:0 0 56px;font-family:var(--mono);font-size:12.5px;
  text-align:right;font-weight:600}
.spdq{flex:0 0 40px;font-family:var(--mono);font-size:11.5px;text-align:right;color:var(--txt2)}
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
.es{font-size:11.5px;color:var(--txt2);margin-top:3px;line-height:1.55}
.eempty{padding:14px 2px 10px;font-size:12.5px;color:var(--txt2);line-height:1.7}
.eempty span{color:var(--txt3);font-size:11.5px}
.prow{display:flex;gap:16px;margin-bottom:2px}
.pk{font-size:10.5px;color:var(--txt3);margin-bottom:2px}
.pv{font-size:21px;font-weight:600;font-family:var(--mono);line-height:1.25}
.pv small{font-size:10.5px;color:var(--txt3);font-weight:400;margin-left:2px}
.pnote{font-size:11.5px;color:var(--txt2);line-height:1.65;border-top:1px dashed var(--line);
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
.dcard:hover{border-color:#c9d6ef;box-shadow:0 3px 12px rgba(23,32,54,.1)}
.dcard.pend{opacity:.55}
.dtop{display:flex;align-items:baseline;gap:7px;margin-bottom:9px;min-width:0}
.dtop .dn{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtop .dc{font-family:var(--mono);font-size:11.5px;color:var(--txt3);flex:0 0 auto}
.dtag{margin-left:auto;font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:5px;
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
.poslb{display:flex;align-items:baseline;justify-content:space-between;font-size:10.5px;
  color:var(--txt3);font-family:var(--mono);margin-top:6px;letter-spacing:.2px}
.poslb .pz{font-size:15px;font-weight:600;color:var(--txt);font-family:var(--mono);line-height:1}
.poslb .pz em{font-style:normal;font-size:10.5px;color:var(--txt3);font-weight:400;margin-left:5px;
  letter-spacing:.2px}
.dchips{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px}
.dchip{font-size:10.5px;color:var(--txt3);background:var(--bg3);border:1px solid var(--line);
  border-radius:5px;padding:2px 7px;font-family:var(--mono);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dchip b{color:var(--txt);font-weight:600;margin-left:2px}
.dchip b.up{color:var(--up)}.dchip b.down{color:var(--down)}
.dwhy{margin-top:auto;padding-top:7px;font-size:11.5px;color:var(--txt2);line-height:1.55}

.bar{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input,select,button{background:var(--bg2);color:var(--txt);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font-size:12.5px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
input#q{width:180px}
button{cursor:pointer;transition:.15s}
button:hover{background:var(--bg3)}
button.pri{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:12.5px;
border:1px solid var(--line);background:var(--bg2);color:var(--txt2);transition:.15s;user-select:none}
.tag:hover{color:var(--txt)}
.tag.on{background:#eaf1ff;border-color:#b9cdf7;color:#1d4ed8}
.tag b{font-weight:400;opacity:.6;font-size:10.5px;margin-left:3px}
.sec{margin-bottom:16px}
.sechd{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12.5px;color:var(--txt2)}
.sechd b{color:var(--txt);font-size:13.5px;font-weight:600;white-space:nowrap;flex:0 0 auto}
.sechd .n{color:var(--txt3);font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis}
/* 模块时间标记：「数据时点」是数据本身的时刻，「算于」是本地算完的时刻，两者常差几十秒 */
.sechd .n .tsm{white-space:nowrap;font-variant-numeric:tabular-nums}
/* overflow 用 clip 不用 hidden：hidden 会把 .tbl 变成滚动容器，theadd 的
   sticky 就地失效（表头吸顶不出来）；clip 同样裁掉圆角外的内容但不建立滚动盒。 */
.tbl{background:var(--bg2);border:1px solid var(--line);border-radius:8px;overflow:clip}
table{width:100%;border-collapse:collapse}
thead th{background:var(--bg3);font-size:10.5px;font-weight:500;color:var(--txt2);
letter-spacing:.3px;padding:9px;text-align:right;white-space:nowrap;
border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
/* 表头吸顶：榜单 100 行、自选表滚过去之后列名还在。top 对齐锚点导航下缘，
   背景色要实（不能透），否则行文字会从表头底下透出来。 */
.tbl thead th{position:sticky;top:var(--navH,42px);z-index:3}
/* 窄屏横滑：自选表常显 10 列、清单 11 列，390px 屏上按比例压缩到每列 39px 会挤成
   一条竖线，所以此前是裁掉——溢价率/IOPV/成交额/换手直接看不见，也没提示还有内容。
   改成 overflow-x:auto 让整表左右滑动，信息一条不少。
   代价：容器一旦成为滚动盒，thead 的 sticky top 就相对这个盒子而非视口，吸顶永久失效
   （盒子高度等于内容高度，永远到不了触发位置）。所以这里顺手改回 static，别留无效声明。
   隐藏列同时恢复：它们不再挤压常显宽度，而是躺在滑动方向的后半段。 */
@media(max-width:820px){
  .tbl{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
  /* top 必须一起清掉：只改 position 的话，下面冻结列把 position 改回 sticky 的瞬间
     top:42px 会复活，整个表头被往下推一行——看起来像 thead 裂成了两行。 */
  .tbl thead th{position:static;top:auto}
  .tbl th.hide-sm,.tbl td.hide-sm{display:table-cell}
  /* 移动端系统滚动条默认不出现，给一条 4px 的细条提示「右边还有」 */
  .tbl::-webkit-scrollbar{height:4px}
  .tbl::-webkit-scrollbar-track{background:transparent}
  .tbl::-webkit-scrollbar-thumb{background:#c9ced8;border-radius:2px}
  /* 名称整块冻结太占地方（175px 差不多是半屏），窄屏给它一个上限、超出用省略号。
     包一层 span 才截得动：td 上的 max-width 在 table-layout:auto 下会被内容顶开。
     96px 大致是「沪深300ETF」六个字的量——认标的够用，又不至于把右边可视区
     压到只剩一列（冻结多宽，滑到底就有多宽的内容被自己挡住）。 */
  .tbl.hs .nmx{display:block;max-width:96px;overflow:hidden;text-overflow:ellipsis}
  /* 「×30 同指数」徽章让出位置：它挤在名称后面会被省略号吃掉，还白占 35px 冻结宽度。
     点它还开同指数列表，露一半更糟，干脆收掉——手机上认标的靠名称+代码够了。 */
  .tbl.hs .ixb{display:none}
  .tbl.hs td:nth-child(1),.tbl.hs th:nth-child(1){padding-left:8px;padding-right:3px}
  /* 滑到「成交额/换手」那一段，整屏都是裸数字，认不出是哪只。把「代码+名称」
     钉在左边当锚点。第二列的 left 必须是第一列实宽，「代码」和「合约」宽度不同，
     写死会错位，所以由 markHS() 逐表量。只对真溢出的表加 .hs——窄表不该平白
     多一条投影。 */
  .tbl.hs td:nth-child(1),.tbl.hs th:nth-child(1){position:sticky;left:0;z-index:2}
  .tbl.hs td:nth-child(2),.tbl.hs th:nth-child(2){position:sticky;left:var(--w1,80px);z-index:2}
  .tbl.hs td:nth-child(1),.tbl.hs td:nth-child(2){background:var(--bg2)}
  .tbl.hs th:nth-child(1),.tbl.hs th:nth-child(2){background:var(--bg3);z-index:4}
  .tbl.hs tr:hover td:nth-child(1),.tbl.hs tr:hover td:nth-child(2){background:#f7f9fd}
  /* 分隔线只在滑出去之后出现（.shr 由 scroll 事件加）。首屏没滑动时多一条竖线，
     整张表看着像多了个框，反而脏。有了它，被切一半的列名才读成「滚出去了」而不是
     「字被裁坏了」。 */
  .tbl.hs.shr td:nth-child(2),.tbl.hs.shr th:nth-child(2){border-right:1px solid var(--line);
    box-shadow:8px 0 10px -8px rgba(16,24,40,.32)}
  /* 提示条：没有它，横滑等于把「被裁掉」换成了「看不见还有」。只在真溢出时由 JS 插入 */
  .hstip{margin:6px 0 0;font-size:11px;color:var(--txt3);text-align:right}
}
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
.code{color:var(--txt3);font-size:11.5px}
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
.ixb{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;font-size:10.5px;
font-weight:500;color:var(--txt3);background:#f0f2f5;border:1px solid var(--line);
vertical-align:1px;cursor:default}
.ixb.mx{color:#2563eb;background:#eaf1ff;border-color:#c9dbff}
.syn{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:10.5px;
color:#2563eb;background:#eaf1ff;border:1px solid #c9dbff;vertical-align:1px;font-weight:500}
tr.hr{cursor:pointer}
tr.hr:hover td{background:#f7f9fd}
@keyframes fu{0%{background:#ffe3e3}100%{background:transparent}}
@keyframes fd{0%{background:#d9f5ea}100%{background:transparent}}
.fu{animation:fu .7s ease-out}.fd{animation:fd .7s ease-out}
footer{margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--txt3)}
.err{color:var(--up)}
.empty{padding:20px;text-align:center;color:var(--txt3);font-size:12.5px}
/* 清单的加载态与失败态。
   为什么单独做：清单是整页最后一块、也是最高的一块，首屏拉全市场要等上游
   （冷启动现场拉两个源要十几二十秒）。原来这里只有一行 12.5px 灰字「加载中…」，
   失败时也只有一行小字，视觉上跟「表格空了」没区别——看着像数据没了。
   现在给足占位：加载三个跳动的点，失败写明原因并给一个能点的重试。 */
.lskel,.lerr{padding:34px 20px;text-align:center;font-size:12.5px;color:var(--txt3);line-height:1.8}
.lskel i{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent);
  margin:0 3px;vertical-align:middle;animation:ldot 1.2s infinite}
.lskel i:nth-child(2){animation-delay:.15s}
.lskel i:nth-child(3){animation-delay:.3s}
.lskel span{display:block;margin-top:6px}
@keyframes ldot{0%,80%,100%{opacity:.18}40%{opacity:1}}
.lerr b{display:block;font-size:13.5px;font-weight:600;color:var(--txt);margin-bottom:4px}
.lerr span{display:block;font-size:12px;opacity:.72;margin-bottom:11px;word-break:break-all}
.lerr button{font:inherit;font-size:12.5px;padding:5px 15px;border-radius:7px;border:1px solid var(--line);
  background:var(--bg2);color:var(--txt);cursor:pointer}
.lerr button:hover{background:var(--bg3)}
/* 「今日变化」两格的空态不是错误也不是加载，只是一句话——按正文排版收紧行高，
   不再占一大块空白。 */
.evtbox .empty,.portbox .empty{padding:6px 2px;text-align:left;line-height:1.7}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#fff;box-shadow:0 8px 28px rgba(23,32,54,.16);
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
.t3ph{color:var(--txt3);font-size:11.5px;font-family:var(--mono)}

/* ---------- 历史 K 线面板 ---------- */
#histMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:60;display:none;
align-items:center;justify-content:center;padding:18px}
#histMask.on{display:flex}
.hpanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;min-width:0;
max-width:1060px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 8px 28px rgba(23,32,54,.16)}
.hhd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.hhd .nm{font-size:14.5px;font-weight:600}
.hhd .cd{font-family:var(--mono);font-size:12.5px;color:var(--txt3)}
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
.hmodes b.on{background:#fff;color:var(--txt);font-weight:600;box-shadow:0 3px 12px rgba(23,32,54,.1)}
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
.hsbar b{padding:2px 7px;border:1px solid var(--line);border-radius:5px;font-size:11.5px;
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
  gap:10px;align-items:center;padding:5px 0;border-bottom:1px dashed var(--line);font-size:12.5px}
.hhrow:hover{background:#f7f9fc}
.hhrk{display:none}
.hhnm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.hhnm em{font-style:normal;font-size:10.5px;color:var(--txt3);margin-left:5px;font-family:var(--mono)}
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
.hhfoot{display:flex;flex-wrap:wrap;gap:14px;padding:9px 0 8px;font-size:11.5px;color:var(--txt2);
  position:sticky;bottom:0;background:var(--bg2);border-top:1px solid var(--line);z-index:1}
.hhfoot b{font-family:var(--mono);font-weight:600}
.hhfoot .k{color:var(--txt3)}
.hhnote{padding:8px 0 2px;font-size:10.5px;color:var(--txt3);line-height:1.75}
/* 展开按钮：整行居中，视觉上明显是「表格到此为止」的分界，不是又一条成分 */
.hhmore{display:flex;justify-content:center;padding:9px 0 4px}
.hhmore b{font-size:11.5px;font-weight:500;color:var(--acc,#2f6fd0);cursor:pointer;
  padding:5px 14px;border:1px solid #cfdcf0;border-radius:14px;background:var(--bg2)}
.hhmore b:hover{background:#eef4fe;border-color:#9dbbeb}
.hhmore b:active{transform:translateY(1px)}
.hempty{padding:28px 0;text-align:center;color:var(--txt3);font-size:12.5px;line-height:1.9}
@media(max-width:760px){
  .hhrow{grid-template-columns:minmax(0,1fr) 48px 54px 52px;gap:6px;font-size:11.5px}
  .hhbar{display:none}
  .hhw,.hhc,.hhctr{font-size:11.5px}
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
.hind .i .k{font-size:10.5px;color:var(--txt3);letter-spacing:.2px;white-space:nowrap}
.hind .i .v{font-size:12.5px;font-family:var(--mono);font-weight:600;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hind .i .s{font-size:10.5px;color:var(--txt2);margin-top:1px;white-space:nowrap;
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
  .hhd .nm{font-size:13.5px;max-width:28vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .htabs{margin-left:0;order:9}
  .htabs span{padding:2px 7px}
  .hmodes{margin-left:auto;order:8;padding:2px}
  .hmodes b{padding:2px 5px;font-size:10.5px}
  .hx{position:absolute;right:8px;top:10px;margin:0}
  .hsbar{padding:7px 10px 2px;gap:3px;overflow:hidden}
  .hsbar .lb{font-size:10.5px}
  .hsbar .lb+.sg+.lb{margin-left:5px}
  .hsbar b{padding:2px 5px;font-size:10.5px}
  #histCv{height:300px}
  /* 小屏固定 3 列：auto-fit 在 400px 里会算出 4 列 96px，
     但 canvas 的固有宽度参与 flex 计算会把面板撑宽，导致第 4 列被裁掉 */
  .hind{grid-template-columns:repeat(3,minmax(0,1fr))}
}
/* 自选标题行右侧的小按钮：上一版这里是「同步」，复制一条带编号的链接，
   谁打开谁能写。换成纯文本导入导出后，只需要一个入口。 */
.sechd .io{margin-left:auto;font-size:11.5px;color:var(--txt);background:var(--bg3);
border:1px solid var(--line);border-radius:5px;padding:3px 9px;cursor:pointer;
user-select:none;white-space:nowrap}
.sechd .io:hover{border-color:#c3cad8}

/* 板块地图标题下的一行体检：多少格、多少指数、多少只有报价、多少只进不来。
   被「229 个单只指数整组丢掉」坑过一次，覆盖率要写在明面上，不靠人去猜。 */
.secmeta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10.5px;color:var(--txt3);
padding:0 2px 7px;line-height:1.5}
.secmeta b{color:var(--txt2);font-weight:600}
.secmeta span{white-space:nowrap}
/* 体检灯：一行灰字没人看，出事时必须先扎眼。绿=三项都过，
   黄/红=有异常且标签文字直接写出来，不用点开才知道。 */
.secmeta .mt{display:inline-flex;align-items:center;gap:5px;font-weight:600;
color:var(--txt2);cursor:pointer;user-select:none}
.secmeta .mt:hover{color:var(--txt)}
.secmeta .mt i{width:7px;height:7px;border-radius:50%;background:#2e9e5b;flex:none}
.secmeta .mt.warn i{background:#d9a013}
.secmeta .mt.bad i{background:#d64545}
.secmeta .mt.warn{color:#8a6a10}
.secmeta .mt.bad{color:#a03030}
/* 展开明细：flex-basis:100% 换到第二行，虚线隔开 */
.secmeta .mtdet{display:none;flex-basis:100%;align-items:center;flex-wrap:wrap;gap:3px 14px;
padding:3px 0 0;border-top:1px dashed var(--line);margin-top:2px;font-size:10.5px}
.secmeta.open .mtdet{display:flex}
.secmeta .mtdet .ok{color:#2e7d4f}
.secmeta .mtdet .warn{color:#a06a00}
.secmeta .mtdet .note{color:var(--txt3)}
.secmeta .mtdet .warnmsg{color:#a03030}
@media(max-width:560px){.secmeta .opt{display:none}}

/* 格子点开后的占比走势。存在的理由：页面只有「今天占比多少」，
   看不出这个数是刚起步还是已经走了一半。 */
.strend{margin:2px 0 10px;padding:9px 12px 7px;background:var(--bg2);
border:1px solid var(--line);border-radius:8px}
.sthd{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-size:11.5px;color:var(--txt3)}
.sthd b{font-size:15px;color:var(--txt);font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.sthd .sttag{font-size:10.5px;padding:1px 6px;border-radius:4px;background:var(--bg3);
color:var(--txt2);border:1px solid var(--line)}
.sthd .sttag.hi{color:#a8541c;border-color:#f0dcc8;background:#fdf6ef}
.sthd .sttag.lo{color:#1c6b8a;border-color:#cfe3ee;background:#f2f9fc}
.strend svg{display:block;width:100%;height:86px;margin-top:5px}
.stax{display:flex;justify-content:space-between;font-size:10.5px;color:var(--txt3);
margin-top:1px;font-variant-numeric:tabular-nums}

/* 集中度 × 宽度四象限。格子回答「钱在哪条线」，这张图回答
   「这种分布是常态还是异常」——只给一个 58.7% 没人知道算高算低。 */
.scq{margin:7px 0 8px;padding:8px 11px 6px;background:var(--bg2);
border:1px solid var(--line);border-radius:8px;position:relative}
.scqhd{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--txt3)}
.scqhd>span:first-child{color:var(--txt2);font-weight:600}
.scqhd .scqb{font-style:normal;font-weight:700;font-size:11.5px;padding:1px 7px;border-radius:4px;
background:var(--bg3);border:1px solid var(--line)}
.scqhd .scqtag{margin-left:auto;font-size:10.5px;color:var(--txt3);letter-spacing:.2px;cursor:help}
/* 四象限说明浮窗。四个角标签只有名字，不知道「抱团」和「涣散」差在哪，
   而且差的那一步正好决定该不该动手。浮窗用 2×2 小矩阵复刻图上的方位。 */
.scqhelp{flex:none;width:14px;height:14px;line-height:12px;text-align:center;border-radius:50%;
border:1px solid var(--line);background:var(--bg);color:var(--txt3);font-size:10.5px;cursor:pointer;
user-select:none;font-style:normal}
.scqhelp:hover{color:var(--txt2);border-color:var(--txt3)}
.scqpop{display:none;position:absolute;right:8px;top:26px;z-index:40;
width:min(424px,calc(100% - 16px));padding:10px 12px 9px;background:var(--bg);
border:1px solid var(--line);border-radius:9px;box-shadow:0 8px 28px rgba(23,32,54,.16)}
.scq.open .scqpop{display:block}
.scqaxs{font-size:10.5px;color:var(--txt3);margin:0 0 8px;letter-spacing:.2px}
.scqgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px}
.scqcell{border-left:3px solid var(--line);padding:1px 0 1px 8px;min-width:0}
.scqcell b{display:block;font-size:11.5px;color:var(--txt2);margin-bottom:2px}
.scqcell b i{font-style:normal;font-size:10.5px;color:#fff;background:var(--txt3);
border-radius:3px;padding:0 3px;margin-left:4px;vertical-align:1px}
.scqcell span{display:block;font-size:10.5px;color:var(--txt3);line-height:1.55}
.scqcell span.act{color:var(--txt2)}
.scqfoot{margin:8px 0 0;padding-top:6px;border-top:1px solid var(--line);
font-size:10.5px;color:var(--txt3);line-height:1.55}
.scqstk{margin:0;font-size:10.5px;color:var(--txt3);font-variant-numeric:tabular-nums}
/* 点中某一天的浮窗。锚在被点的点上（left/top 是点的百分比坐标），
   默认出现在点的右下方；靠右（px>60%）翻到左侧、靠下（py>52%）翻到上方。
   不跟随鼠标——移动端没有 hover，跟随毫无意义，固定锚点反而稳。 */
.scqplot{position:relative}
.scqtip{display:none;position:absolute;z-index:6;box-sizing:border-box;
min-width:230px;max-width:min(320px,calc(100% - 14px));
padding:7px 10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;
box-shadow:0 8px 28px rgba(23,32,54,.16);font-size:11.5px;color:var(--txt2);
line-height:1.65;font-variant-numeric:tabular-nums;pointer-events:none}
.scqtip.on{display:block}
.scqtip{transform:translate(10px,12px)}
.scqtip.rx{transform:translate(calc(-100% - 10px),12px)}
.scqtip.ry{transform:translate(10px,calc(-100% - 12px))}
.scqtip.rx.ry{transform:translate(calc(-100% - 10px),calc(-100% - 12px))}
.scqtip b{color:var(--txt);font-weight:600}
.scqtip i{font-style:normal;color:var(--txt);font-weight:700}
.scqtip em{font-style:normal;color:var(--txt3)}
.scqtip .esc{font-size:10.5px}
.scqplot svg{cursor:crosshair}
/* 电脑为主：图独占一行、放到 1000px，统计和描述缩到图下方一行。
   原来的三栏（360 图 + 190 统计 + 1fr 说明）在 1440 屏上图只有 360px，
   而右边 660px 全是小字——主次反了。 */
/* 图占满左侧，统计和一句话判断缩进右侧 292px。
   用 1000px 定宽会把卡片右边空出 400px，而散点图本来还能再宽。 */
.scqbody{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:18px;
  align-items:start;margin-top:4px}
.scqplot{max-width:none}
.scqplot svg{display:block;width:100%;height:auto}
.scqplot svg.m{display:none}
.scqax{display:flex;justify-content:flex-start;gap:16px;flex-wrap:wrap;
font-size:10.5px;color:var(--txt3);line-height:1.5;margin-top:1px}
/* 底部三块按图宽三等分：图 1000px，三项挤在左边 500px 会留下半屏空白，
   而且和上面的图对不齐。等分后每块一个竖排单元，读起来像一行表头。 */
.scqfoot{margin-top:0}
.scqstats{display:flex;flex-direction:column;gap:10px;
  padding:0 0 9px;border-bottom:1px solid var(--line)}
.scqe{display:flex;align-items:baseline;gap:6px;cursor:help}
.scqe>span{font-size:10.5px;color:var(--txt3);flex:none}
.scqe b{font-size:17px;color:var(--txt);font-variant-numeric:tabular-nums;letter-spacing:-.4px}
.scqe em{font-style:normal;font-size:10.5px;color:var(--txt3);line-height:1.45}
.scqdesc{display:flex;flex-direction:column;gap:5px;padding-top:0;min-width:260px;flex:1;max-width:680px}
.scqd{margin:0;font-size:12.5px;color:var(--txt2);line-height:1.7}
.scqnote{margin:0;font-size:10.5px;color:var(--txt3);line-height:1.75}
@media(max-width:820px){
  .scqbody{grid-template-columns:1fr;gap:4px}
  .scqplot{max-width:100%}
  /* 窄屏换成 360 画布，字号在原尺寸渲染，不再缩成 5px */
  .scqplot svg.d{display:none}
  .scqplot svg.m{display:block}
  .scqfoot{margin-top:4px}
  /* 三项等宽并排、各自竖排。横排 wrap 会在 390px 下折成 2+1，
     第三项孤零零占一整行，看着像漏了一块。 */
  .scqstats{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 8px;padding-top:6px}
  .scqe{flex-direction:column;align-items:flex-start;gap:0}
  .scqdesc{padding-top:6px;min-width:0}
}
@media(max-width:560px){.scq{padding:7px 9px 5px}.scqe b{font-size:15px}.scqnote{font-size:10.5px}}

/* ---- 自选导入导出 ---- */
#ioMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:80;display:none;
align-items:center;justify-content:center;padding:18px}
#trigMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:80;display:none;
align-items:center;justify-content:center;padding:18px}
#trigMask.on,#ioMask.on{display:flex}
.trigrule{border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin-bottom:9px;background:var(--bg)}
.trigrule.off{opacity:.55}
.trigrule .trow{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap}
.trigrule select,.trigrule input[type=text]{border:1px solid var(--line);border-radius:5px;
  background:var(--bg2);color:var(--txt);padding:4px 6px;font-size:12.5px;outline:none}
.trigrule input[type=text]{width:78px;font-family:var(--mono)}
.trigrule .tand{font-size:11.5px;color:var(--txt3);margin-left:2px}
.trigrule .tdel,.trigrule .tcdel{cursor:pointer;color:var(--txt3);font-size:13.5px;padding:0 4px;user-select:none}
.trigrule .tdel:hover,.trigrule .tcdel:hover{color:var(--down)}
.trigrule .tadd{cursor:pointer;color:var(--accent);font-size:11.5px;user-select:none}
.trigrule .tname{font-size:11.5px;color:var(--txt3)}
.trigcnt{font-size:11.5px;color:var(--txt3);line-height:1.65;margin-top:4px}
/* 隔夜/亚太条目点击看分时：可点的条目加指针和悬停反馈 */
.onfut span.ovclk{cursor:pointer}
.onfut span.ovclk:hover,.ontrk:hover{border-color:var(--txt3)}
#ovMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:80;display:none;
align-items:center;justify-content:center;padding:18px}
#ovMask.on{display:flex}
#ovBody svg{display:block;width:100%;height:auto}
.ovmeta{display:flex;gap:8px 16px;flex-wrap:wrap;font-size:11.5px;color:var(--txt2);
margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)}
#ovBody .ovretry{margin-top:2px;font-size:11.5px;padding:3px 11px;border:1px solid var(--line);
border-radius:6px;background:var(--bg2);color:var(--txt2);cursor:pointer;font-family:inherit}
#ovBody .ovretry:hover{border-color:var(--txt3);color:var(--txt)}
#ioMask.on{display:flex}
.iobox{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:470px;box-shadow:0 8px 28px rgba(23,32,54,.16);overflow:hidden}
.iohd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line);
font-size:13.5px}
.iobody{padding:13px 14px}
.iotip{font-size:11.5px;color:var(--txt3);line-height:1.65;margin-bottom:9px}
#ioTxt{width:100%;height:104px;resize:vertical;font-family:var(--mono);font-size:12.5px;
line-height:1.7;padding:9px 10px;border:1px solid var(--line);border-radius:7px;
background:var(--bg);color:var(--txt);outline:none;box-sizing:border-box}
#ioTxt:focus{border-color:var(--accent)}
.iobar{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.iobar .iom{font-size:11.5px;color:var(--txt3);margin-left:auto}

/* ---- 因子研究面板 ---- */
#rsMask{position:fixed;inset:0;background:rgba(23,28,38,.42);z-index:70;display:none;
align-items:center;justify-content:center;padding:18px}
#rsMask.on{display:flex}
.rspanel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;width:100%;
max-width:900px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 8px 28px rgba(23,32,54,.16)}
.rshd{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line)}
/* 标题不许被压缩换行：以前「因子研究」在 390px 屏上会折成「因子/研究」两行，
   还把日期挤到旁边，看着像排版坏了。标题固定宽度，元信息自己换行。 */
.rshd b{font-size:14.5px;white-space:nowrap;flex:0 0 auto}
.rshd .sub{font-size:11.5px;color:var(--txt3);font-family:var(--mono);
min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsbody{overflow-y:auto;padding:14px}
.rssec{margin-bottom:18px}
.rssec h4{font-size:12.5px;color:var(--txt2);font-weight:600;margin-bottom:8px;
letter-spacing:.3px;display:flex;align-items:center;gap:7px}
.rssec h4::after{content:'';flex:1;height:1px;background:var(--line)}
.rsk{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.rsk .i{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.rsk .i .k{font-size:10.5px;color:var(--txt3);margin-bottom:3px}
.rsk .i .v{font-size:17px;font-family:var(--mono);font-weight:600}
.rsk .i .s{font-size:10.5px;color:var(--txt3);margin-top:2px}
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
.rsnote{font-size:11.5px;color:var(--txt2);line-height:1.85;background:var(--bg3);
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
.labgrid table{width:100%;border-collapse:collapse;font-size:11.5px;font-family:var(--mono)}
.labgrid th{font-size:10.5px;color:var(--txt3);font-weight:400;text-align:center;padding:3px 2px}
.labgrid td{text-align:center;padding:4px 2px;border-radius:3px}
.labgrid td.n{color:var(--txt3)}
.labtabs{display:flex;gap:6px;margin:0 0 9px;flex-wrap:wrap}
.labtabs button{padding:4px 11px;font-size:11.5px;border-radius:14px;background:var(--bg3);
border:1px solid var(--line);color:var(--txt2);cursor:pointer;font-family:inherit}
.labtabs button.on{background:rgba(76,141,255,.15);border-color:var(--accent);color:var(--txt)}
.labtbl td.nm{text-align:left;font-family:inherit;color:var(--txt3);white-space:normal;
font-size:10.5px;line-height:1.5;max-width:270px}
.labtbl td.fam{text-align:left;font-family:inherit;color:var(--txt3);font-size:10.5px;white-space:nowrap}
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
.fxf{font-family:var(--mono);font-size:10.5px;color:#2a2f38;background:var(--bg3);
border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;
white-space:pre-wrap;word-break:break-word;line-height:1.75}
.rsmore{margin-top:9px;text-align:center}
.rsmore button{font-size:11.5px;padding:5px 14px;border-radius:6px}
.rssrc{font-size:10.5px;color:var(--txt3);margin-top:10px;text-align:right}
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
    content:'  ← 左右滑动看全部列';color:var(--txt3);font-weight:400;font-size:10.5px}
}

/* ---------- 板块地图 ---------- */
.smhead{display:flex;align-items:baseline;gap:6px 12px;flex-wrap:wrap;margin-bottom:8px;
  font-size:11.5px;color:var(--txt2)}
.smhead b{font-variant-numeric:tabular-nums}
/* 三组（A股/港股/跨境）各自可折起。组头一行放得下「几个板块/合计/最强/最弱/分化/涨跌」，
   收起后这行本身就是摘要，不用点开也能看个大概。 */
.sgrp{margin-top:9px}
.sgrp:first-child{margin-top:0}
.sghd{display:flex;align-items:center;gap:3px 10px;flex-wrap:wrap;cursor:pointer;
  padding:5px 9px;margin-bottom:6px;border:1px solid var(--line);border-radius:6px;
  background:var(--bg3);font-size:11.5px;color:var(--txt2);user-select:none}
.sghd:hover{border-color:#c3cad8}
.sghd .sgc{width:0;height:0;flex:none;margin-right:2px;
  border-left:4.5px solid var(--txt3);border-top:3.5px solid transparent;
  border-bottom:3.5px solid transparent;transform:rotate(90deg);transition:transform .12s}
.sgrp.fold .sghd .sgc{transform:rotate(0)}
.sghd .sgk{font-size:12.5px;font-weight:700;color:var(--txt);letter-spacing:.2px}
.sghd .sgt{color:var(--txt3)}
.sghd .sgm{white-space:nowrap}
.sghd .sgm b{font-variant-numeric:tabular-nums}
/* 集中度后面那个小数字是「近一年分位」，不是百分比，所以做得比正文轻一档，
   避免被读成「集中 53.0% 的 89%」。 */
.sghd .sgm em{font-style:normal;color:var(--txt3);font-size:10.5px;margin-left:2px}

@media(max-width:880px){.sghd .sgm.opt{display:none}}
.sgrp.fold .smgrid,.sgrp.fold .sdet,.sgrp.fold .scq{display:none}
.smgrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
@media(max-width:1180px){.smgrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:760px){
  .smgrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
  .scell{padding:6px 7px 5px}
  .scell .sn{font-size:10.5px}
  .scell .sv{font-size:14px}
  .scell .ss{font-size:10.5px;gap:2px}
  .scell .sbar{display:none}
}
.scell{border:1px solid var(--line);border-radius:7px;padding:7px 9px 6px;background:var(--bg2);
  cursor:pointer;position:relative;overflow:hidden}
.scell:hover{border-color:#c3cad8}
.scell.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
/* 主题分界：AI / 新能源是跨行业的，虚线上方是行业格、下方是主题格。
   边框也用虚线，一眼能看出「这两格不能和上面的加在一起」。 */
.sth{grid-column:1/-1;display:flex;align-items:center;gap:6px;margin:4px 0 0;
  padding-top:6px;border-top:1px dashed #d7dce5;font-size:10.5px;color:var(--txt3)}
.sth b{color:var(--txt2);font-weight:600}
.scell.th{border-style:dashed}
.scell .sn{font-size:11.5px;color:var(--txt);display:flex;align-items:baseline;gap:4px}
/* 箭头紧跟板块名，不推到格子右边：右对齐时它正好落在「-3.25%」上方，
   读起来像涨跌幅的一部分。 */
.scell .sn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.scell .sn .sd{flex:none;font-size:10.5px;font-weight:700;
  font-variant-numeric:tabular-nums;letter-spacing:-.2px}
.scell .sv{font-size:16px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;
  letter-spacing:-.2px}
.scell .ss{font-size:10.5px;color:var(--txt3);margin-top:1px;
  font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:3px}
.scell .ss .si{white-space:nowrap}
.scell .ss .sa{color:var(--txt3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scell .sn .sd.up{color:var(--up)}
.scell .sn .sd.down{color:var(--down)}
.scell .sn .sd.na{color:var(--txt3);font-weight:400;opacity:.55}
.scell .sbar{height:3px;border-radius:2px;background:var(--bg3);margin-top:7px;overflow:hidden}
.scell .sbar i{display:block;height:3px;border-radius:2px;background:var(--txt3);opacity:.55}
.scell .sz{position:absolute;left:0;top:0;bottom:0;width:2.5px}
.sdet{margin-top:9px;border-top:1px dashed var(--line);padding-top:7px;display:none}
.sdet.show{display:block}
.sdet .sdhd{font-size:11.5px;color:var(--txt3);margin-bottom:4px}
/* 明细两列：指数多的时候（新能源 6 条、计算机 19 条）单列会把面板拉得很长，
   两列在 1500px 下正好，窄屏退回单列。 */
/* 用多列而不是 grid：这一列是按涨幅排序的，要竖着读。grid 是行优先，
   第二行会跳到右边一列，读起来是横着串的。column-rule 顺带把两列分开。 */
.sdet .sdrwrap{column-count:3;column-gap:26px;column-rule:1px solid #d7dce5}
@media(max-width:1240px){.sdet .sdrwrap{column-count:2}}
@media(max-width:900px){.sdet .sdrwrap{column-count:1}}
.sdet .sr{display:flex;gap:9px;align-items:baseline;padding:3px 0;font-size:11.5px;
  border-bottom:1px dotted var(--line)}
.sdet .sr:last-child{border-bottom:0}
.sdet .sr .nm2{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdet .sr .cd2{font-family:var(--mono);color:var(--txt3);font-size:10.5px;width:52px;text-align:right}
.sdet .sr .v2{font-variant-numeric:tabular-nums;width:56px;text-align:right;font-weight:600}
.sdet .sr .a2{font-variant-numeric:tabular-nums;width:62px;text-align:right;color:var(--txt3)}
/* ---------- 盘中提醒 ---------- */
.alertbar{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.abtn{cursor:pointer;padding:2px 9px;border-radius:20px;border:1px solid var(--line);
  color:var(--txt2);background:var(--bg2);white-space:nowrap;font-size:11.5px;user-select:none}
.abtn:hover{border-color:#c3cad8}
.abtn.on{background:#fdeeee;border-color:#f3c7c7;color:#b02a2a}
.abtn.on i{display:inline-block;width:5px;height:5px;border-radius:50%;background:#d93a3a;
  margin-right:4px;vertical-align:1px}
.aset{display:none;align-items:center;gap:5px;color:var(--txt3);font-size:11.5px}
.aset.show{display:inline-flex}
.aset input{width:40px;padding:1px 3px;font-size:11.5px;border:1px solid var(--line);
  border-radius:4px;background:var(--bg2);color:var(--txt);text-align:center;
  font-variant-numeric:tabular-nums}
.aset input:focus{outline:none;border-color:var(--accent)}
#alertBox{position:fixed;right:14px;top:14px;z-index:999;display:flex;flex-direction:column;
  gap:6px;pointer-events:none}
.aitem{background:var(--bg2);border:1px solid var(--line);border-left:3px solid var(--txt3);
  border-radius:6px;padding:7px 11px;box-shadow:0 3px 12px rgba(23,32,54,.1);font-size:12.5px;
  min-width:220px;max-width:300px;animation:ain .18s ease-out}
@keyframes ain{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
.aitem.up{border-left-color:var(--up)}
.aitem.dn{border-left-color:var(--down)}
.aitem b{font-size:12.5px;font-variant-numeric:tabular-nums}
.aitem small{display:block;color:var(--txt2);font-size:11.5px;margin-top:2px;line-height:1.4}
/* 提醒记录：浮层只停 9 秒，全市场模式下这个列表才是主要出口 */
#alertLog{position:fixed;right:14px;top:52px;z-index:998;width:min(340px,calc(100vw - 24px));
  max-height:64vh;background:var(--bg2);border:1px solid var(--line);border-radius:8px;
  box-shadow:0 8px 28px rgba(23,32,54,.16);display:none;flex-direction:column;overflow:hidden}
#alertLog.show{display:flex}
#alertLog .lh{padding:8px 11px;border-bottom:1px solid var(--line);font-size:12.5px;
  color:var(--txt3);display:flex;align-items:center;gap:8px;flex:none}
#alertLog .lh b{color:var(--txt);font-size:12.5px}
#alertLog .lh u{margin-left:auto;cursor:pointer;text-decoration:none;color:var(--txt3)}
#alertLog .lh u:hover{color:var(--txt)}
#alertLog .lb{overflow-y:auto;padding:2px 0}
#alertLog .li{padding:5px 11px;font-size:11.5px;border-left:2px solid transparent;
  display:flex;gap:7px;align-items:baseline}
#alertLog .li.up{border-left-color:var(--up)}
#alertLog .li.dn{border-left-color:var(--down)}
#alertLog .li em{font-style:normal;color:var(--txt3);font-variant-numeric:tabular-nums;flex:none}
#alertLog .li i{font-style:normal;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#alertLog .le{padding:18px 11px;text-align:center;color:var(--txt3);font-size:12.5px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1><span class="mk"><i></i><i></i><i></i></span><span class="tag">ETF<b>盯盘</b></span><em id="clock">--:--:--</em></h1>
  <div class="sp"></div>
  <span class="dot" id="d-src"><i></i><span id="srcName">连接中</span></span>
  <a id="btnRs" href="/research" title="201 个因子的 IC 检验、样本外回测与 PE 策略">因子研究</a>
</header>

<nav class="secnav" id="secNav" aria-label="区块导航">
  <a data-t="onCard">隔夜</a>
  <a data-t="secSec">板块地图</a>
  <a data-t="watchSec">自选</a>
  <a data-t="spdSec">急涨急跌</a>
  <a data-t="futSec">期指期权</a>
  <a data-t="rankSec">清单</a>
</nav>

<div class="oncard" id="onCard" style="display:none"></div>
<div class="oncard" id="asiaCard" style="display:none"></div>

<div class="sec" id="secSec">
  <div class="sechd"><b>板块地图</b><span class="n" id="secN">-</span>
    <span class="sync" id="btnSec" title="丢掉缓存，按最新快照重算">重算</span></div>
  <div class="smhead" id="secHead"><span>读取中…</span></div>
  <div class="secmeta" id="secMeta"></div>
  <div id="secBody"><div class="empty">正在读取行情…</div></div>
</div>

<div class="sechd"><b>今日概况</b><span class="n" id="cardsN"></span></div>
<div class="cards">
  <div class="card"><div class="k">全市场 ETF</div><div class="v" id="cTotal">-</div><div class="s" id="cUni">-</div></div>
  <div class="card"><div class="k">涨 / 跌</div><div class="v" id="cUD">-</div><div class="s" id="cUDs">-</div></div>
  <div class="card"><div class="k">全市场成交额</div><div class="v" id="cAmt">-</div><div class="s">合计</div></div>
  <div class="card"><div class="k">今日诊断信号</div><div class="v" id="cSig">-</div><div class="s" id="cSigs">按位置 × 量能给标签</div></div>
</div>


<div class="sec" id="watchSec">
  <div id="staleBar" class="stalebar" style="display:none"></div>
  <div class="sechd"><b>自选盯盘</b><span class="n" id="watchN"></span>
    <span class="io" id="btnIO" title="导出一行代码清单，或粘贴清单导入（只追加，不覆盖）">导入/导出</span></div>
  <div class="bar">
    <input id="addIn" placeholder="添加代码，支持逗号批量：510300,513180" style="width:290px">
    <button class="pri" id="btnAdd">添加</button>
    <button id="btnClear">清空</button>
    <span class="alertbar">
      <span class="abtn" id="btnAlert" title="在页面开着的时候，出现异动就提醒你（浏览器通知 + 页面浮层）">提醒 关</span>
      <span class="abtn" id="btnScope" title="自选：逐只提醒，5 秒一刷。全市场：扫同指数去重后的代表标的（500 只上下，一只一个指数），只弹汇总和极端个股，60 秒一刷——一只不漏地逐只弹，一天几百条，弹到第二次就没人看了">范围 自选</span>
      <span class="aset" id="alertSet">
        涨跌≥<input id="aChg" value="2.0">%
        急变≥<input id="aSpd" value="0.8">%/3分
        溢价≥<input id="aPm" value="2.0">%
        <span class="abtn" id="btnPerm" title="允许后，页面在后台也能弹系统通知">桌面通知</span>
      </span>
      <span class="abtn" id="btnLog" style="display:none" title="今天触发过的全部提醒，浮层只停留 9 秒，点这里回看">0 条</span>
      <span class="abtn" id="btnTrig" title="自定义组合触发器：自己拼条件（距新高、量能、位置、溢价……），全部满足才提醒">触发器 0</span>
    </span>
    <span class="n" id="quoteTip" style="font-size:11.5px;color:var(--txt3)"></span>
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
  </div>
</div>

<div class="sec" id="futSec">
  <div class="sechd"><b>期指期权</b><span class="n" id="futN"></span>
    <span class="sync" id="btnFut" title="重新读一遍中金所实时行情">刷新</span></div>
  <div class="dnote">期指基差＝期货−现货，负数即贴水；期权用 <b>K＋购−沽</b> 合成一张期货，再和同月期货对照。年化按自然日折算，剩余不足 3 天不给——那时分母太小，算出来是噪音。</div>

  <div class="futgrid">
    <div class="mkbox">
      <div class="futttl"><b>期指基差</b><span id="futBasisSub">四象限是「持仓量变化 × 价格方向」的推断，不是交易所多空</span></div>
      <div class="tbl" id="futBasis"><div class="lskel"><i></i><i></i><i></i><span>读取中…</span></div></div>
    </div>

    <div class="mkbox">
      <div class="futttl"><b>股指期权合成基差</b><span id="futOptIdxSub">IO/MO/HO</span></div>
      <div class="tbl" id="futOptIdx"><div class="lskel"><i></i><i></i><i></i><span>读取中…</span></div></div>
    </div>

    <div class="mkbox">
      <div class="futttl"><b>ETF 期权合成基差</b><span id="futOptEtfSub">沪深 9 个标的</span></div>
      <div class="tbl" id="futOptEtf"><div class="lskel"><i></i><i></i><i></i><span>读取中…</span></div></div>
    </div>

    <div class="mkbox">
      <div class="futttl"><b>多空持仓</b><span id="futPosSub"></span></div>
      <div class="mtabs" id="futPosTabs">
        <span class="mtab on" data-p="live">盘中推断</span>
        <span class="mtab" data-p="settle">收盘结算</span>
      </div>
      <div class="tbl" id="futPos"><div class="empty">读取中…</div></div>
    </div>

    <div class="mkbox wide">
      <div class="futttl"><b>基差历史</b><span id="futHistSub"></span></div>
      <div class="mtabs" id="futHistTabs"></div>
      <div id="futHistChart"><div class="lskel"><i></i><i></i><i></i><span>读取中…</span></div></div>
    </div>
  </div>
</div>

<div class="sec" id="rankSec">
  <div class="sechd"><b>全市场清单</b><span class="n" id="listN"></span></div>
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
    <tbody id="listBody"><tr><td colspan="11" class="lskel"><i></i><i></i><i></i><span>正在取全市场行情…</span></td></tr></tbody>
  </table></div>
</div>

<footer>
  <span id="fTs">-</span><span id="fSrc">-</span><span id="fErr" class="err"></span>
</footer>
</div>
<div id="toast"></div>
<div id="alertBox"></div>
<div id="alertLog"><div class="lh"><b>今日提醒</b><span id="logSub"></span><u id="logClr">清空</u></div><div class="lb" id="logBody"></div></div>

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

<div id="ioMask">
  <div class="iobox">
    <div class="iohd"><b>自选清单</b>
      <button class="hx" id="ioClose" title="关闭 (Esc)" style="margin-left:auto">×</button></div>
    <div class="iobody">
      <div class="iotip">一行代码，逗号、空格或换行分隔，多余的字符会被忽略。
        导入<b>只追加</b>，不会删掉现有自选；重复的自动跳过。</div>
      <textarea id="ioTxt" spellcheck="false" placeholder="510300, 513180, 515880"></textarea>
      <div class="iobar">
        <button id="ioCopy">复制清单</button>
        <button class="pri" id="ioImport">导入清单</button>
        <span class="iom" id="ioMsg"></span>
      </div>
    </div>
  </div>
</div>

<div id="trigMask">
  <div class="iobox" style="max-width:680px">
    <div class="iohd"><b>自定义触发器</b>
      <button class="hx" id="trigClose" title="关闭 (Esc)" style="margin-left:auto">×</button></div>
    <div class="iobody">
      <div class="iotip">一条规则里的多个条件是<b>且</b>的关系，全部满足才算命中；从「不满足」
        变成「满足」的那一刻触发一次，同一条规则同一只 30 分钟内不重复响。
        触发器随顶部「提醒」开关一起工作，通知走同一条通道。
        带 ⏳ 的条件要等页面把该自选的历史拉完才生效（位置/量能类都从日线算）。</div>
      <div id="trigList"></div>
      <div class="iobar">
        <button class="pri" id="trigAdd">+ 新建规则</button>
        <span class="iom" id="trigMsg"></span>
      </div>
    </div>
  </div>
</div>

<div id="ovMask">
  <div class="iobox" style="max-width:760px">
    <div class="iohd"><b id="ovTitle">分时</b><span class="n" id="ovSub" style="font-size:11.5px;color:var(--txt3)"></span>
      <button class="hx" id="ovClose" title="关闭 (Esc)" style="margin-left:auto">×</button></div>
    <div class="iobody" id="ovBody"><div class="iotip">读取中…</div></div>
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
var SEC_HIST = ${SEC_HIST_JS};
var MKT_HIST = ${MKT_HIST_JS};
var DEFAULT_WATCH = ['510300','159915','588000','513180','513120','513050','518880'];
var LS = 'etf_watch_v3';
var watch = loadWatch();

var DATA = [];                 // 全市场归一化数据
var STATS = null;
var LIVE = {};                 // 自选高频覆盖 {code: item}
var LIVE_TS = 0;               // 自选行情最近一次到的时刻（腾讯直连）
var g = 'all', sortKey = 'amt', limit = 100, kw = '';
var DATA_SRC = '', DATA_TS = 0;
var lastP = {}, timerSlow = null, timerFast = null, timerSpd = null, timerT3 = null, retryTimer = null;
var timerFut = null;

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
/* 「科创」「创业板」「中证」这些是**板块前缀**，不是宽基。名字里带「科创」的
   588170 科创半导体ETF 有 117 亿成交额，被 BROAD 的 '科创' 抓成宽基后整块从
   板块地图里消失——半导体一格只剩 54 亿，比通信传媒还小，方向读反。
   所以先认行业主题词，再退到宽基前缀。主题词命中即算行业，不管带不带「科创」。 */
var THEME = ['半导体','芯片','集成电路','存储','光刻','晶圆',
             '医药','医疗','生物','创新药','疫苗','中药','器械','健康','制药',
             '人工智能','算力','云计算','数据中心','大数据',
             '软件','计算机','信息技术','信创','数字经济',
             '通信','5G','互联网','传媒','游戏','影视',
             '光伏','电池','储能','新能源','风电','锂','碳中和','氢',
             '军工','航天','航空','国防','卫星','兵器',
             '证券','银行','保险','金融','非银','券商',
             '食品','饮料','白酒','消费','家电','旅游','零售','美容','纺织',
             '农业','畜牧','养殖','粮食','种植','饲料',
             '化工','有色','钢铁','煤炭','石油','天然气','稀有金属','矿业','建材','水泥',
             '地产','基建','建筑','工程机械','机械','工业','制造','机器人','汽车','智能驾驶',
             '电力','公用','水务','环保','燃气'];
function calcGroup(n){
  /* 「自由现金流」「300现金流」是因子策略，名字里的「现金」不是现金管理，
     别被下面的 money 规则抓走（会被显示成「货币」，还会被速度榜排除）。 */
  if (n.indexOf('现金流') >= 0 || n.indexOf('自由现金') >= 0) return 'broad';
  for (var i=0;i<RULES.length;i++){
    var ws = RULES[i][1];
    for (var j=0;j<ws.length;j++) if (n.indexOf(ws[j]) >= 0) return RULES[i][0];
  }
  for (var t=0;t<THEME.length;t++) if (n.indexOf(THEME[t]) >= 0) return 'industry';
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

/* ---------- 自选云端存储（Workers KV） ----------
   本地先写，云端异步推，800ms 防抖——用户连点几下删除不会打出 5 个请求。
   云端未配置（Deno 无 KV、或 wrangler.toml 没绑）时静默降级为纯本地。 */
var WATCH_CLOUD = false;
var pushTimer = null;

/* 自选分桶用的匿名编号。
   不同的人打开同一个网址，各自有一份，互不覆盖——共用一份的话，
   陌生人一按「+」就把别人的自选改掉了。
   跨设备不再走链接（「同步」按钮已删，那条 /?u= 链接谁拿到谁能写），
   改用标题行的「导入/导出」：文本没有写权限可外泄。 */
var WATCH_UID = (function(){
  var LSK = 'etfUid';
  var u = '';
  try { u = localStorage.getItem(LSK) || ''; } catch (e) {}
  // 不再认 URL 上的 ?u=。以前是「复制一条带编号的链接给另一台设备」，等于把这份
  // 自选的写权限发给任何拿到链接的人；现在跨设备走导入/导出文本，没有写权限可外泄。
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

/** 是不是这个跟踪指数的代表标的（成交额最大的那只）。
    没抓到跟踪标的的（ix 为空）判断不了重复，一律算代表——
    宁可多扫一只，也不要把一只没人跟的票静默藏掉。 */
function isRep(x){
  return !x.ix || !KEEP[x.ix] || KEEP[x.ix] === x.c;
}

function dedupCount(){
  // 参与去重、且不是代表标的的只数
  var n = 0;
  for (var i=0;i<DATA.length;i++) if (!isRep(DATA[i])) n++;
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
      out.push({ c:x.code, n:x.name, p:p, pc:pc, chg:(+x.changepercent || 0),
        amt:(+x.amount || 0), tr:(+x.turnoverratio || 0), hi:+x.high, lo:+x.low, op:+x.open,
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
      out.push({ c:x.f12, n:x.f14, p:p, pc:pc, chg:(+x.f3 || 0), amt:(+x.f6 || 0), tr:(+x.f8 || 0),
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

/* ---------- 板块地图 ----------
   为什么按「跟踪指数」聚合而不是按 ETF 名：
   中证A500 有 40 只 ETF、沪深300 有 29 只、半导体主题下 6 个不同的指数。
   直接对 ETF 求平均，权重被「同指数发得多」的板块吃掉，看到的不是轮动而是发行数量。
   所以先把 ETF 归到指数（一个指数只出一票），再按指数归到板块。

   2026-11-07 第三次重划：分三组（A股 / 港股 / 跨境），各组独立分母。
   为什么必须拆——A 股和港股同用一个分母时，半导体 41.8% 会被港股 190 亿稀释成 30.3%，
   这个数既不表示 A 股内部分布，也不表示港股内部分布；跨市场涨跌幅同样不可比
   （汇率、交易时段、投资者结构都不同），混排出来的「最强/最弱」没有意义。

   A 股用申万一级做骨架，按 ETF 实际供给合并/拆分：
   1) 通信与传媒拆开。光模块/CPO 是通信设备，游戏影视才是传媒；
   2) 半导体从电子里单列。ETF 供给上半导体占电子类绝大多数，合起来等于只剩半导体；
   3) 上游与中游分开。资源＝有色/煤炭/石油石化（申万上游），
      材料＝化工/钢铁/建材（申万中游材料），机械＝机械设备/电网设备，
      地产基建＝地产/建筑。原来把钢铁、建材塞进「资源」，读起来像上游涨价，
      实际是地产链，方向会读反。
   港股按同一套行业口径分格（互联网/科技/医药/金融/消费/汽车/红利/地产）。
   跨境只按国家分（美国/日本/德国/欧洲/东南亚/印度/沙特/巴西/韩国/全球），不做行业。

   商品价格指数（黄金9999、上海金、原油、豆粕）三组都不进：那是金价油价，不是行业。
   宽基、风格（红利/价值/成长/现金流）、债券、货币同样不进——它们不回答「钱往哪条线走」。 */
var SEC_GROUPS = [
  { g:'A股', code:'a', defs:[
    ['半导体',   ['半导体','芯片','集成电路','存储','光刻','晶圆','封测']],
    ['电子',     ['消费电子','面板','PCB','元件','光学','安防','物联网','电子']],
    ['通信',     ['通信','5G','光模块','光通信','CPO','运营商','电信']],
    ['传媒',     ['传媒','游戏','影视','动漫','出版','广告','院线','文化']],
    ['计算机',   ['软件','计算机','信息技术','信创','云计算','大数据','网络安全',
                  '数字经济','金融科技','操作系统','数据库','工业互联网']],
    ['人工智能', ['人工智能','算力','数据中心','AI'], 1],
    ['医药',     ['医药','医疗','生物','创新药','疫苗','中药','器械','健康','制药']],
    ['汽车',     ['汽车','智能驾驶','汽零']],
    ['光伏',     ['光伏','太阳能']],
    ['电池储能', ['电池','储能','锂']],
    ['新能源',   ['新能源','风电','核电','氢','碳中和','低碳'], 1],
    ['军工',     ['军工','航天','航空','国防','卫星','兵器','船舶']],
    ['金融',     ['证券','银行','保险','金融','非银','券商']],
    ['消费',     ['食品','饮料','白酒','消费','家电','家用电器','旅游','零售','美容',
                  '纺织','酒店','免税','轻工','家居','酒']],
    ['农业',     ['农业','畜牧','养殖','粮食','种植','饲料','农牧渔','种业']],
    ['资源',     ['有色','煤炭','石油','天然气','石化','稀土','稀有金属','矿业',
                  '能源','黄金','油气']],
    ['材料',     ['化工','钢铁','建材','水泥','玻璃','新材料']],
    ['机械',     ['机械','工程机械','机床','机器人','工业','制造','装备','电网',
                  '电力设备','工业母机']],
    ['地产基建', ['地产','基建','建筑']],
    ['公用环保', ['电力','公用','水务','环保','燃气','运输','物流','港口','高速',
                  '交运','航运']]
  ]},
  { g:'港股', code:'hk', defs:[
    ['港股互联网', ['互联网','中国互联网','电商']],
    ['港股医药',   ['医药','医疗','生物','创新药','疫苗','中药','器械','健康']],
    ['港股科技',   ['科技','信息技术','半导体','芯片','软件','云计算','通信']],
    ['港股金融',   ['金融','银行','保险','证券','非银']],
    ['港股消费',   ['消费','食品','饮料','家电','旅游','零售','美容']],
    ['港股汽车',   ['汽车','汽零']],
    ['港股红利',   ['红利','高股息','股息','低波']],
    ['港股地产',   ['地产','建筑','基建']]
  ]},
  { g:'跨境', code:'x', defs:[
    // 中韩半导体 513310 一天 121 亿，占跨境一半以上。它一半仓位是 A 股半导体、
    // 一半是韩国，不是「配置韩国」，塞进韩国格会让韩国凭空变成跨境第一大市场。
    // 单列成跨境主题，和 A 股的 AI/新能源一样不进分母。
    ['中韩半导体', ['中韩'], 1],
    ['美国',   ['纳斯达克','纳指','标普500','标准普尔','标普油气','S&P','MSCIUSA',
                '美国','美股','道琼斯']],
    ['日本',   ['日经','东京','日本','东证']],
    ['德国',   ['德国','法兰克福','DAX']],
    ['欧洲',   ['法国','欧洲','英国','意大利','西班牙','荷兰']],
    ['东南亚', ['东南亚','越南','泰国','印尼','马来西亚','新加坡']],
    ['印度',   ['印度']],
    ['沙特',   ['沙特']],
    ['巴西',   ['巴西']],
    ['韩国',   ['韩国','中韩']],
    ['全球',   ['全球','海外','亚太','世界','亚洲','新兴市场']]
  ]}
];
/* 港股判定词。任一命中即进港股组，且不再进 A 股组——否则「中证港股通信息技术综合」
   会被「信息技术」抓进 A 股计算机，「中证港股通医药」会被「医药」抓进 A 股医药。
   「恒生A股XX」是恒生编的 A 股行业指数（恒生A股电网设备），判定前先摘掉品牌前缀。 */
var SEC_HK = ['恒生','港股通','港股','中概','中国互联网','香港','H股','港币'];
/* 商品价格指数：黄金9999 一天 37.8 亿，进「资源」会占 68%，把有色/化工全盖住。
   只挡纯商品指数名——「中证沪深港黄金产业股票」是黄金股，仍算资源。 */
var SEC_COMMOD = ['黄金9999','上海金','白银','原油','豆粕','商品'];
var SEC_CACHE = {};
function secClass(ix){
  var v = SEC_CACHE[ix];
  if (v !== undefined) return v;
  var probe = ix.indexOf('恒生A股') >= 0 ? ix.split('恒生A股').join('') : ix;
  var i, j;
  /* 名字里同时带两个行业的词时，defs 的顺序会替你做决定，而它常常做错。
     「国证商用卫星通信产业」先撞上「通信」（defs 第 3 位），可它装的是卫星制造、
     发射、地面站——跟光模块/CPO/运营商不是一条线。留在通信格里，卫星这条线
     +6% 会把通信整格抬上去，同时军工那边白丢一个当日最强的指数。
     「中证卫星产业」「中证全指航空航天」本来就走军工格，这里只是把同类补齐。
     写成函数内的局部数组（不是外面的 var）是因为 pipeline/gen_sec_hist.mjs
     用文本切片抽 secClass 整段去重算历史日档，写在外面会抽不到。 */
  var FIX = [['卫星', '军工'], ['商业航天', '军工']];
  for (i=0;i<SEC_COMMOD.length;i++){
    if (probe.indexOf(SEC_COMMOD[i]) >= 0){ SEC_CACHE[ix] = null; return null; }
  }
  var isHK = false;
  for (i=0;i<SEC_HK.length;i++) if (probe.indexOf(SEC_HK[i]) >= 0){ isHK = true; break; }
  // 港股只跟港股组比；非港股先比跨境、再比 A 股——海外行业指数不能进 A 股同名格
  var order = isHK ? ['hk'] : ['x','a'];
  v = null;
  for (var m=0;m<order.length && !v;m++){
    var G = null;
    for (var gi=0;gi<SEC_GROUPS.length;gi++) if (SEC_GROUPS[gi].code === order[m]) G = SEC_GROUPS[gi];
    if (!G) continue;
    // 先按纠偏表定夺，表里没有的才回到 defs 顺序
    for (i=0;i<FIX.length && !v;i++){
      if (probe.indexOf(FIX[i][0]) < 0) continue;
      for (j=0;j<G.defs.length;j++){
        if (G.defs[j][0] === FIX[i][1]){
          v = { g:G.g, code:G.code, k:G.defs[j][0], th:G.defs[j][2] ? 1 : 0 };
          break;
        }
      }
    }
    if (v) break;
    for (i=0;i<G.defs.length;i++){
      var ws = G.defs[i][1];
      for (j=0;j<ws.length;j++){
        if (probe.indexOf(ws[j]) >= 0){
          v = { g:G.g, code:G.code, k:G.defs[i][0], th:G.defs[i][2] ? 1 : 0 };
          break;
        }
      }
      if (v) break;
    }
  }
  SEC_CACHE[ix] = v;
  return v;
}

var SECS = [], SEC_OPEN = null;
/* 哪些格子是「主题」（跨行业）。占比分母要把它们剔出去，否则 AI 的成交额
   既算在自己头上、又通过成分股算在半导体/通信/计算机里，分母被撑大。 */
var THEME_KEYS = {};

/* 每日板块成交额日档：存下来的三十二个数字（A股 20 + 港股 7 + 跨境 5），
   用来回答「钱在进还是在出」。
   为什么比「占比」不比「绝对额」——盘中 10:30 的 3 亿和昨天全天的 8 亿不是一回事，
   直接比会得出「缩量」的错误结论。占比（板块 ÷ 行业合计）里分子分母同受时间进度
   影响，比值基本抵消。它衡量的是「钱有多集中在这条线」，不是「放了多大成交量」。
   这也是唯一能做的：没有历史分钟数据（新浪 minline 只给当天），「昨日同期」算不出来。 */
var SEC_BASE = null, SEC_SAVE_TS = 0, SEC_REQ = false;

function loadSecBase(){
  return fetch('/api/secdaily').then(function(r){ return r.json(); }).then(function(j){
    if (j && j.ok && Array.isArray(j.days)){
      SEC_BASE = j.days;
      SEC_EXTRA = null;                 // 日档换了，增量的缓存作废
      // 盘子已经画出来了（用户先看了页面、日档后到）：重画一次，让曲线尾巴接上
      if (SEC_OPEN) renderSectors();
      else renderSecMeta();             // 体检里的「板块日档」要等这份才完整
    }
    return SEC_BASE;
  }).catch(function(){ return null; });
}

/* 全 A 当天快照（集中度 / 宽度 / 涨跌行业数），给四象限卡片的「今天」那个点用。
   60 秒边缘缓存，盘中不必秒级——这个数是「市场今天什么状态」，
   不是「这一秒发生了什么」，一分钟的滞后不影响判断。
   失败就保持 null：卡片退回基线最后一天，标日期，不留空白。 */
var MKT_REQ = false, MKT_RETRY = null;

function loadMktSnap(){
  if (MKT_REQ) return;
  MKT_REQ = true;
  return fetch('/api/mkt').then(function(r){ return r.json(); }).then(function(j){
    if (!(j && j.ok && j.c > 0 && j.n >= 100)) throw new Error('empty');
    MKT_NOW = j;
    // 接口顺带带回 250 天历史（Actions 每天重写）。内联那份是部署时固化的，
    // 不覆盖的话，一个月不发布散点云就停在原地，而「今天」每天往里走。
    if (j.hist && j.hist.d && j.hist.d.length >= 60) MKT_HIST = j.hist;
    if (SECS.length) renderSectors();   // 盘子已经画出来了，补上今天这个点
    return MKT_NOW;
  }).catch(function(){
    // 失败时卡片显示的是基线最后一天（日期标签会写明是哪天），不会有错数。
    // 但用户多半是刚打开页面，20 秒后再试一次比让他手动刷新强。
    MKT_REQ = false;
    if (!MKT_RETRY){
      MKT_RETRY = setTimeout(function(){ MKT_RETRY = null; loadMktSnap(); }, 20000);
    }
    return null;
  });
}

/* ---------- 板块占比走势 ----------
   数据来自 worker/src/sec_hist.js：250 个交易日的「占本组行业格成交额」，
   按当前口径回算（每个指数只算成交额最大那只、主题不进分母、三组各算各的）。
   页面原本只有今天一个点，看不出这个占比是刚起来还是已经走了一半；
   一条曲线加一个分位，比再看十个涨跌幅有用。 */
function bjToday(){
  var bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}
function dayGap(a, b){
  var A = Date.parse(a + 'T00:00:00Z'), B = Date.parse(b + 'T00:00:00Z');
  if (!isFinite(A) || !isFinite(B)) return 999;
  return Math.round((B - A) / 86400000);
}

/* 静态基线只到生成那天（sec_hist.js 由日线回算）。不接增量的话，
   一周后曲线就永远停在那个日期——图上看着「没变化」，实际是没数据。
   这里用 secdaily 的日档（每天收盘存一份 36 格成交额）把尾巴接上：
   日档只存成交额，占比在这里按当天的组内行业合计现算，口径和基线一致。
   日档最多 64 条，约三个月，之后旧记录滑出——但基线覆盖更早的部分，接得上。 */
var SEC_EXTRA = null, SEC_EXTRA_TS = 0;
function secHistExtra(){
  if (SEC_EXTRA && Date.now() - SEC_EXTRA_TS < 60000) return SEC_EXTRA;
  var H = SEC_HIST, base = SEC_BASE || [];
  if (!H || !H.d || !H.d.length || !base.length){ SEC_EXTRA = {}; SEC_EXTRA_TS = Date.now(); return SEC_EXTRA; }
  var last = H.d[H.d.length-1], thMap = {}, i, k;
  for (i=0;i<SECS.length;i++) if (SECS[i].th) thMap[SECS[i].key] = 1;
  var out = {};
  for (i=0;i<base.length;i++){
    var r = base[i];
    if (!r || !r.d || r.d <= last || !r.s) continue;
    var den = {};
    for (k in r.s){
      if (thMap[k]) continue;
      var g = k.split('/')[0];
      den[g] = (den[g] || 0) + r.s[k];
    }
    for (k in r.s){
      var g2 = k.split('/')[0];
      if (!(den[g2] > 0)) continue;
      if (!out[k]) out[k] = [];
      out[k].push([r.d, Math.round(r.s[k] / den[g2] * 1000)]);
    }
  }
  SEC_EXTRA = out; SEC_EXTRA_TS = Date.now();
  return out;
}

/** 一格的完整占比序列：基线（跳掉上市前的 0）+ 日档增量。 */
function secHistArr(key){
  var H = SEC_HIST;
  if (!H || !H.s || !H.s[key]) return null;
  var raw = H.s[key], i, n = raw.length, started = false;
  var v = [], d = [];
  for (i=0;i<n;i++){
    if (raw[i] > 0) started = true;
    if (started){ v.push(raw[i]); d.push(H.d[i]); }
  }
  var ex = secHistExtra()[key] || [];
  for (i=0;i<ex.length;i++){
    if (!d.length || ex[i][0] > d[d.length-1]){ v.push(ex[i][1]); d.push(ex[i][0]); }
  }
  return { v:v, d:d };
}

/** 某格当前占比在过去一年里的分位。格子太多，不可能每格都点开看曲线，
    所以把分位塞进 tooltip——鼠标停一下就知道「这条线是不是已经走到高位」。 */
function secSharePct(key, share){
  var h = secHistArr(key);
  if (!h || h.v.length < 40) return null;
  var a = h.v, cur = Math.round(share * 1000), n = 0, i;
  for (i=0;i<a.length;i++) if (a[i] <= cur) n++;
  return n / a.length * 100;
}

/** 某个值在一条历史序列里的分位（0 最低、100 最高）。没有历史返回 null。 */
function mktPct(arr, v){
  if (!arr || arr.length < 40) return null;
  var n = 0;
  for (var i=0;i<arr.length;i++) if (arr[i] / 10 <= v) n++;
  return n / arr.length * 100;
}

/* 当天的全 A 快照，来自 /api/mkt。null 的时候卡片退回基线最后一天，
   并标注日期——宁可显示「截至 11-06」，也不要在页面上留一块空白。 */
var MKT_NOW = null;

/* 散点的点阵（secQuadCard 填充）。250 个点若各做一个 <circle>，DOM 多 500 个节点、
   HTML 多 25KB；这里只在 <g> 上接事件，点击坐标反算回 viewBox 再找最近点。 */
var SCQ_PTS = null;

/* 集中度 × 宽度 四象限。
   单看集中度会误判：半导体占到 40%，可以是「主线就在这儿」，也可以是「别的全塌了
   只剩它在成交」。单看宽度也会误判：18 个行业 15 个在涨，可能是普涨，也可能是
   每个都涨 0.1% 的假扩散。两个数放一张图，四种状态才分得开：
     高集中 + 窄  → 抱团（赚指数不赚面）
     高集中 + 宽  → 主线上攻（有主线也在扩散）
     低集中 + 宽  → 轮动扩散（追高容易挨打）
     低集中 + 窄  → 涣散（没有主线）
   灰色点＝近一年每个交易日的位置，蓝点＝今天。今天在哪个象限、这个象限过去
   一年出现过多少次，一眼可见——单个数字没有「常态」作参照，就只是数字。 */
var QUAD_INFO = {
  hl:{ n:'抱团',  c:'#a8541c' },
  hw:{ n:'主线上攻', c:'#b3383d' },
  lw:{ n:'轮动扩散', c:'#2563eb' },
  ll:{ n:'涣散无主线', c:'#5b6472' }
};
function secQuadCard(){
  var H = MKT_HIST;
  if (!H || !H.c || H.c.length < 60 || !H.b) return '';

  var last = H.c.length - 1;
  var now = MKT_NOW;
  var conc = now ? now.c : H.c[last] / 10;
  var brd = now ? now.b : (H.b[last] || 0) / 10;
  // 宽度是个股口径：上涨家数 ÷ (上涨+下跌)。行业数只用来做数据完整性校验
  // （MKT_INDS 匹配不全时 /api/mkt 会直接抛错，这里再兜一层）。
  var upN = now ? now.stockUp : (H.u ? H.u[last] : 0);
  var dnN = now ? now.stockDn : (H.w ? H.w[last] : 0);
  var nStk = now ? (now.stockN || (upN + dnN)) : (H.n ? H.n[last] : 0);
  var top3 = (now && now.top3 && now.top3.length) ? now.top3 : (H.t3 || []);
  if (!(conc > 0) || !(upN + dnN >= 1000)) return '';

  // 「今天」这个词只在真的是今天时才用。周六早上打开页面，行情还是周五收盘的，
  // 标成「今天」会让人以为周末在交易。
  var bjDay = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  var curDay = now ? now.d : H.d[last];
  var dayTag = curDay === bjDay ? '今天' : curDay.slice(5) + ' 收盘';

  var i, C = [], B = [], CI = [];
  for (i=0;i<H.c.length;i++){
    // CI 存回原始下标：点云跳过了 c=0 的天，不记映射就找不回那天是哪日。
    if (H.c[i] > 0){ C.push(H.c[i] / 10); B.push((H.b[i] || 0) / 10); CI.push(i); }
  }
  if (C.length < 60) return '';

  var sortedC = C.slice().sort(function(x,y){ return x - y; });
  var cMed = sortedC[Math.floor(sortedC.length / 2)];
  var hiC = conc >= cMed, wide = brd >= 50;
  var qKey = (hiC ? 'h' : 'l') + (wide ? 'w' : 'l');
  var q = QUAD_INFO[qKey];
  var cMax = Math.max.apply(null, C.concat([conc]));
  var cMin = Math.min.apply(null, C.concat([conc]));
  var pad = (cMax - cMin) * 0.13 || 2;
  var ylo = Math.max(0, cMin - pad), yhi = cMax + pad;

  // 历史里落在同一象限的比例——单点没有「常态」参照，这个数才是参照。
  var sameN = 0;
  for (i=0;i<C.length;i++) if ((C[i] >= cMed) === hiC && (B[i] >= 50) === wide) sameN++;
  var samePct = sameN / C.length * 100;

  // 同一张图出两套画布：桌面 620×210（渲染到约 1050px，字号≈15px），
  // 手机 360×190（渲染到 370px，几乎 1:1，字号 9.5px）。
  // SVG 是矢量的，宽度缩小所有字等比缩小——用一套 620 的画布塞进 370px 屏，
  // 9px 字会变成 5.4px，等于没有。两套各约 2KB，比自己算缩放便宜。
  var mkSvg = function (W, HT, ml, mr, mt, mb, fs, dot, cls) {
    var x0 = ml, x1 = W - mr, y0 = mt, y1 = HT - mb;
    var px = function(v){ return x0 + Math.max(0, Math.min(100, v)) / 100 * (x1 - x0); };
    var py = function(v){ return y1 - (v - ylo) / (yhi - ylo) * (y1 - y0); };

    // 250 个点不用 250 个 <circle>：一个 path 里串起来，描边圆头就是点。
    var pG = '', pA = '';
    for (i=0;i<C.length;i++){
      var seg = 'M' + px(B[i]).toFixed(1) + ' ' + py(C[i]).toFixed(1) + 'h0';
      if ((C[i] >= cMed) === hiC && (B[i] >= 50) === wide) pA += seg; else pG += seg;
    }
    var tX = px(brd), tY = py(conc);
    var txAnchor = tX > x1 - W * 0.08 ? 'end' : (tX < x0 + W * 0.08 ? 'start' : 'middle');
    var txDx = txAnchor === 'end' ? -7 : (txAnchor === 'start' ? 7 : 0);

    var yTick = [cMax, cMed, cMin];
    var tk = '';
    for (i=0;i<yTick.length;i++){
      tk += '<text x="' + (ml - 4) + '" y="' + (py(yTick[i]) + 3).toFixed(1)
        + '" text-anchor="end" font-size="' + fs + '" fill="#a7aeb9">'
        + yTick[i].toFixed(0) + '%</text>';
    }
    var xRow = '';
    var xs = [0, 50, 100];
    for (i=0;i<xs.length;i++){
      xRow += '<text x="' + px(xs[i]).toFixed(1) + '" y="' + (y1 + 15)
        + '" text-anchor="' + (i === 0 ? 'start' : (i === 2 ? 'end' : 'middle'))
        + '" font-size="' + fs + '" fill="#a7aeb9">' + xs[i] + '%</text>';
    }

    // 角标签垫一圈白：点云密的地方（左下、右上）纯灰字会被点淹没，
    // paint-order=stroke 让描边只画在字的外圈，不啃字形
    var lbl = function(t, x, y, anch){
      return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + anch
        + '" font-size="' + (fs * 1.05).toFixed(1) + '" fill="#b6bdc9" stroke="#fff"'
        + ' stroke-width="' + (fs * 0.3).toFixed(1) + '"'
        + ' paint-order="stroke" stroke-linejoin="round">' + t + '</text>';
    };

    // data-g 把绘图区几何带出去：点击时按同一组数反算每个点的位置，
    // 就不用在页面里重新实现一遍映射，也不会两处漂移。
    return '<svg class="' + cls + '" viewBox="0 0 ' + W + ' ' + HT + '"'
      + ' data-g="' + [x0, x1, y0, y1, ylo.toFixed(2), yhi.toFixed(2)].join(',') + '"'
      + ' role="img" aria-label="集中度与宽度四象限散点图">'
      + '<line x1="' + px(50).toFixed(1) + '" y1="' + y0 + '" x2="' + px(50).toFixed(1)
      + '" y2="' + y1 + '" stroke="#dde2ea" stroke-dasharray="3 3"/>'
      + '<line x1="' + x0 + '" y1="' + py(cMed).toFixed(1) + '" x2="' + x1 + '" y2="'
      + py(cMed).toFixed(1) + '" stroke="#dde2ea" stroke-dasharray="3 3"/>'
      + '<path d="' + pG + '" stroke="#c3cad6" stroke-width="' + dot + '" stroke-linecap="round" fill="none"/>'
      + '<path d="' + pA + '" stroke="' + q.c + '" stroke-width="' + (dot * 1.13).toFixed(2)
      + '" stroke-linecap="round" fill="none" stroke-opacity=".6"/>'
      + '<circle cx="' + tX.toFixed(1) + '" cy="' + tY.toFixed(1) + '" r="' + (dot * 3).toFixed(1)
      + '" fill="' + q.c + '" fill-opacity=".14"/>'
      + '<circle cx="' + tX.toFixed(1) + '" cy="' + tY.toFixed(1) + '" r="' + (dot * 1.47).toFixed(1)
      + '" fill="' + q.c + '" stroke="#fff" stroke-width="1.4"/>'
      + '<text x="' + (tX + txDx).toFixed(1) + '" y="' + (tY - dot * 2.7).toFixed(1)
      + '" text-anchor="' + txAnchor + '" font-size="' + (fs * 1.1).toFixed(1)
      + '" font-weight="700" fill="' + q.c + '">'
      + (curDay === bjDay ? '今天' : curDay.slice(5)) + '</text>'
      + lbl('抱团', x0 + 5, y0 + fs + 2, 'start')
      + lbl('主线上攻', x1 - 5, y0 + fs + 2, 'end')
      + lbl('涣散', x0 + 5, y1 - 5, 'start')
      + lbl('轮动扩散', x1 - 5, y1 - 5, 'end')
      + tk + xRow
      + '<g class="scqs"></g>'
      + '</svg>';
  };
  var svgD = mkSvg(620, 210, 42, 16, 14, 24, 9, 3, 'd');
  var svgM = mkSvg(360, 190, 36, 10, 12, 20, 9.5, 2.6, 'm');
  var svg = svgD + svgM;

  // 点阵挂到模块级，事件监听里直接查，不用把闭包层层传下去。
  // T/IND 是「那天的前三大行业」：只有 24% 这个数字回答不了「钱堆在哪条线」。
  SCQ_PTS = { C: C, B: B, I: CI, D: H.d, U: H.u || [], W: H.w || [],
              T: H.t || [], IND: H.ind || [], RC: H.c, RB: H.b,
              cur: C.length - 1, BRD: brd, CONC: conc };

  var c3 = mktPct(H.c, conc), b3 = mktPct(H.b, brd);
  // 个股口径集中度：成交额最大的 5% 个股 ÷ 全 A（margin-dashboard 借来的数）。
  // 行业口径抓行业抱团，这个抓个股抱团——单票吃下大份额时行业口径看不见它。
  var p5 = (now && now.p5 != null) ? now.p5 : (H.p5 ? H.p5[last] / 10 : null);
  var p53 = (p5 != null && H.p5) ? mktPct(H.p5, p5) : null;
  var names = top3.length ? top3.join('、') : '前三大行业';
  var upTxt = upN + '/' + (upN + dnN);
  // 描述里用「767 涨 4793 跌」而不是「767/5560 只在涨」——后者要读两遍才懂，
  // 而且分母到底是「全部股票」还是「涨+跌」在句子里看不清。
  var tally = upN + ' 涨 ' + dnN + ' 跌';
  var desc;
  if (hiC && !wide) desc = '钱压在 ' + names + ' 上（TOP3 占 ' + conc.toFixed(1) + '%），'
    + '全 A ' + tally + '——赚了指数不赚面。';
  else if (hiC && wide) desc = names + ' 领涨（TOP3 占 ' + conc.toFixed(1) + '%），'
    + tally + '——有主线，也在扩散。';
  else if (!hiC && wide) desc = tally + '，TOP3 只占 ' + conc.toFixed(1)
    + '%——钱在轮着走，追高容易挨打。';
  else desc = tally + '，TOP3 只占 ' + conc.toFixed(1)
    + '%——没有主线，别硬找。';

  // 成交额单列：宽度回答「多少票在涨」，成交额回答「这个市场今天有多热」，
  // 两个数放一起才看得出「缩量普涨」这类组合。
  var stockLine = ''
    + '<p class="scqstk">全 A 有成交 ' + nStk + ' 只'
    + ((now && now.amt > 0) ? ' · 成交 ' + now.amt + ' 亿' : '') + '</p>';

  // 四个象限各是什么、该不该动手。按图上的方位排（左上→右上→左下→右下），
  // 浮窗里的小矩阵和散点图对得上，不用再看第二遍。
  var QUAD_DOC = {
    hl: ['抱团', '钱压在少数行业，其余在跌', '只做主线，别抄底边缘'],
    hw: ['主线上攻', '主线领涨，而且在扩散', '跟随主线，可以加仓'],
    ll: ['涣散', '没主线，也没普涨', '降仓，等信号'],
    lw: ['轮动扩散', '钱在轮着走，谁都能涨一点', '别追高，等回落']
  };
  var cell = function (k) {
    var doc = QUAD_DOC[k];
    return '<div class="scqcell" style="border-left-color:' + QUAD_INFO[k].c + '">'
      + '<b>' + doc[0] + (k === qKey ? '<i>现在</i>' : '') + '</b>'
      + '<span>' + doc[1] + '</span>'
      + '<span class="act">→ ' + doc[2] + '</span></div>';
  };
  var pop = '<div class="scqpop">'
    + '<p class="scqaxs">纵轴 上高下低＝集中度 · 横轴 左低右高＝宽度</p>'
    + '<div class="scqgrid">' + cell('hl') + cell('hw') + cell('ll') + cell('lw') + '</div>'
    + '<p class="scqfoot">近一年有 ' + samePct.toFixed(0) + '% 的交易日站在你这一格（'
    + sameN + '/' + C.length + '）。同格天数越多，说明眼下越像常态；'
    + '越少，越可能是转折。</p></div>';

  return '<div class="scq">'
    + '<div class="scqhd"><span>全 A 集中度 × 宽度</span>'
    + '<em class="scqb" style="color:' + q.c + '">' + q.n + '</em>'
    + '<span class="scqtag" title="全 A 个股口径：5563 只 A 股逐只统计涨跌，当日有成交的 '
    + nStk + ' 只进样本。集中度按东财 128 个行业的个股成交额加总。'
    + '与下方 36 格（ETF 成交额，532 亿）不是同一套数据，差 30 倍是正常的。">'
    + nStk + ' 只 · ' + dayTag + '</span>'
    + '<i class="scqhelp" role="button" tabindex="0" title="四个象限是什么意思"'
    + ' onclick="var s=this.closest(&#39;.scq&#39;);s.classList.toggle(&#39;open&#39;);event.stopPropagation()"'
    + '>?</i></div>'
    + '<div class="scqbody"><div class="scqplot">' + svg
    + '<div class="scqtip"></div>'
    + '<div class="scqax"><span>灰点＝近一年每个交易日，点任意一点看当天</span>'
    + '<span>横轴 上涨个股占比</span></div></div>'
    + '<div class="scqfoot"><div class="scqstats">'
    // 个股块紧挨着集中块：两个都是集中度，行业口径 24% vs 个股口径 43.5%，
    // 放一起才读得出「行业抱团」和「个股抱团」是两件事。放最后会被当成凑数的。
    + '<div class="scqe" title="成交额最大的 3 个行业（东财 128 个行业口径）合计占全市场'
    + '成交额的比重——抓「钱压在几个行业里」。高于近一年中位算高集中，虚线就是那条中位线。'
    + '分位数＝今天这个数排在近一年第几：90 分位＝比一年里 90% 的日子都更集中。'
    + '单看会误判：40% 可以是主线就在这儿，也可以是别的全塌了只剩它在成交，'
    + '所以要配合右边「宽度」一起读。">'
    + '<span>集中</span><b>' + conc.toFixed(1) + '%</b>'
    + '<em>TOP3 行业 · ' + (c3 != null ? c3.toFixed(0) + ' 分位' : '—') + '</em></div>'
    + '<div class="scqe" title="成交额最大的 5% 个股占全市场成交额的比重——上一行的「集中」'
    + '按行业加总，抓的是行业抱团；这个数抓个股抱团：一只票单日吃下全市场百分之几的成交，'
    + '行业口径看不见它。两个口径一起看，才分得清钱压在一个行业还是压在几只票。">'
    + '<span>个股</span><b>' + (p5 != null ? p5.toFixed(1) + '%' : '—') + '</b>'
    + '<em>前 5% 成交 · ' + (p53 != null ? p53.toFixed(0) + ' 分位' : '—') + '</em></div>'
    + '<div class="scqe" title="全 A 个股口径：上涨家数 ÷（上涨＋下跌），50% 线以上算「宽」。'
    + '衡量涨的是不是普涨——15 个行业在涨也可能是每个都涨 0.1% 的假扩散，这个数能分辨。'
    + '分位数＝今天排在近一年第几。和「集中」配着读：高集中＋窄＝抱团，高集中＋宽＝主线上攻，'
    + '低集中＋宽＝轮动扩散，低集中＋窄＝涣散（点右上角 ? 看四格详解）。">'
    + '<span>宽度</span><b>' + brd.toFixed(0) + '%</b>'
    + '<em>' + upTxt + ' · ' + (b3 != null ? b3.toFixed(0) + ' 分位' : '—') + '</em></div>'
    + '<div class="scqe"><span>同象限</span><b>' + samePct.toFixed(0) + '%</b>'
    + '<em>' + sameN + ' / ' + C.length + ' 天</em></div>'
    + '</div>'
    + '<div class="scqdesc"><p class="scqd">' + desc + '</p>' + stockLine
    + '<p class="scqnote">虚线＝近一年中位（' + cMed.toFixed(1) + '% / 50%）。'
    + '轴向和四格含义点右上角 ? 看。</p></div>'
    + '</div></div>' + pop + '</div>';
}

/** 一格占比的走势卡。返回空串表示没有历史（新板块），不占位。 */
function secTrend(s){
  var h = secHistArr(s.key);
  if (!h || h.v.length < 20) return '';
  var a = h.v.slice(), dates = h.d.slice(), i;
  // 历史库只到上个交易日；差几天就把此刻的值接在后面。超过 5 天不接
  // （长假、数据管道没跑），否则会把周五的读数画成今天。
  var cur = Math.round(s.share * 1000);
  var appended = false;
  var lastD = dates[dates.length-1], today = bjToday();
  // 只在「值真的变了」时补。休市日快照等于上个交易日收盘，补上去会多一个平点，
  // 看起来像「最近几天没动」，实际是没数据。
  if (lastD !== today && dayGap(lastD, today) <= 5 && Math.abs(cur - a[a.length-1]) > 2){
    a.push(cur); dates.push(today); appended = true;
  }

  var mn = a[0], mx = a[0];
  for (i=1;i<a.length;i++){ if (a[i] < mn) mn = a[i]; if (a[i] > mx) mx = a[i]; }
  var pad = (mx - mn) * 0.14 || 1;
  var lo = Math.max(0, mn - pad), hi = mx + pad;
  var W = 640, H0 = 84, yOf = function(v){ return H0 - 6 - (v - lo) / (hi - lo) * (H0 - 12); };
  var xOf = function(k){ return k / (a.length - 1) * W; };

  // 最后一点如果是「补上来的此刻」，单独用虚线连——中间漏了几个交易日，
  // 画成实线等于假装这几天有数据。
  var joined = appended && a.length > 1 && dayGap(dates[a.length-2], dates[a.length-1]) > 1;
  var solidN = joined ? a.length - 1 : a.length;
  var d = '';
  for (i=0;i<solidN;i++){
    d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(a[i]).toFixed(1);
  }
  var tail = joined
    ? '<path d="M' + xOf(solidN-1).toFixed(1) + ' ' + yOf(a[solidN-1]).toFixed(1)
      + 'L' + xOf(a.length-1).toFixed(1) + ' ' + yOf(a[a.length-1]).toFixed(1)
      + '" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-dasharray="4 4"'
      + ' vector-effect="non-scaling-stroke"/>'
    : '';
  var sorted = a.slice().sort(function(u,v){ return u - v; });
  var med = sorted[Math.floor(sorted.length / 2)];
  var yMed = yOf(med).toFixed(1);

  var below = 0;
  for (i=0;i<a.length;i++) if (a[i] <= a[a.length-1]) below++;
  var pct = below / a.length * 100;

  // 分位只说事实，不替人下结论。颜色分开只是为了扫一眼能找到。
  var tagCls = pct >= 85 ? ' hi' : (pct <= 15 ? ' lo' : '');

  var head = s.th ? '占本组行业合计（与行业格重叠）'
    : (s.code === 'x' ? '占跨境地区成交额' : '占' + s.g + '行业成交额');
  return '<div class="strend">'
    + '<div class="sthd"><span>' + head + '</span>'
    + '<b>' + (a[a.length-1] / 10).toFixed(1) + '%</b>'
    + '<span class="sttag' + tagCls + '">近一年 ' + pct.toFixed(0) + ' 分位</span>'
    + '<span style="margin-left:auto">区间 ' + (mn/10).toFixed(1) + '–' + (mx/10).toFixed(1)
    + '% · 中位 ' + (med/10).toFixed(1) + '%</span></div>'
    + '<svg viewBox="0 0 ' + W + ' ' + H0 + '" preserveAspectRatio="none">'
    + '<line x1="0" y1="' + yMed + '" x2="' + W + '" y2="' + yMed
    + '" stroke="#aeb6c4" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>'
    + '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1.7"'
    + ' stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
    + tail
    + '<line x1="' + W + '" y1="' + (yOf(a[a.length-1]) - 5).toFixed(1) + '" x2="' + W
    + '" y2="' + (yOf(a[a.length-1]) + 5).toFixed(1)
    + '" stroke="var(--accent)" stroke-opacity=".45" vector-effect="non-scaling-stroke"/>'
    + '</svg>'
    + '<div class="stax"><span>' + dates[0].slice(0, 7) + '</span>'
    + '<span>虚线＝一年中位</span>'
    + '<span>' + dates[dates.length-1].slice(0, 7) + '</span></div>'
    + '</div>';
}

/** 今日各板块占比相对「上一交易日收盘」的变化（百分点）。没有基准返回 null。
    为什么只跟一个日终比、不取近 5 日均值：均值口径要攒够几天才出数，而且「比一周
    平均高」读不出「今天钱在往哪挪」。有一条日档就该出箭头，盘中也能读——分子分母
    同受时间进度影响（10:30 的 3 亿 ÷ 同时点的行业合计），比值基本抵消，所以箭头
    不必等收盘。它衡量的是「钱有多集中在这条线」，不是「放了多大成交量」。
    分母按「组」分别算：A股占比在 A股内、港股占比在港股内，不混。
    key 形如 "a/半导体"，组码就是斜杠前那段。 */
function secShareDelta(cur){
  var recs = SEC_BASE || [];
  if (!recs.length) return null;
  var nCur = 0, totCur = {};
  for (var k in cur){
    nCur++;
    var c0 = k.slice(0, k.indexOf('/'));
    if (!THEME_KEYS[k]) totCur[c0] = (totCur[c0] || 0) + cur[k];
  }
  if (nCur < 6) return null;

  // 从最近一天往前找第一条「与当前不一样」的日档。一样就说明现在看到的正是那天的
  // 收盘值（休市、或刚收完盘写进去），拿它当基准会恒等于 0，必须跳过。
  var base = null;
  for (var i=recs.length-1;i>=0;i--){
    var r = recs[i];
    if (!r || !r.s) continue;
    var keys = 0, same = 0;
    for (var k2 in cur){
      if (r.s[k2] == null) continue;
      keys++;
      if (Math.abs(cur[k2] - r.s[k2]) <= Math.max(1, r.s[k2] * 0.003)) same++;
    }
    if (keys >= 6 && same === keys) continue;
    base = r; break;
  }
  if (!base) return null;

  var totB = {};
  for (var kb in base.s){
    if (THEME_KEYS[kb]) continue;                 // 主题格不进分母
    var c1 = kb.slice(0, kb.indexOf('/'));
    totB[c1] = (totB[c1] || 0) + base.s[kb];
  }

  var out = {};
  for (var name in cur){
    var code = name.slice(0, name.indexOf('/'));
    if (!(totCur[code] > 0) || !(totB[code] > 0)) continue;
    if (base.s[name] == null) continue;
    var now = cur[name] / totCur[code];
    var was = base.s[name] / totB[code];
    out[name] = { share: now, prev: was, ds: (now - was) * 100, d: base.d };
  }
  return out;
}

/* 收盘后把当天板块成交额存一份。三个约束：
   1) 盘中不存——存进去的是半天的量，会污染基准；
   2) 同一天 30 分钟节流——收盘后成交额不再变，没必要反复写；
   3) 值几乎不变就不存——长假打开页面时行情还是节前那天的，会多出一条错位记录。

   日期取「行情对应的交易日」，不是「今天」。原先是「15:00 前直接 return、周末直接
   return」，等于基准只在「收盘后恰好有人打开页面」那天才记得下来；漏一天，箭头就
   跨两天比，漏几天就彻底没基准。现在非交易时段打开会补记最近一个工作日（行情正是
   那天的收盘值），盘中只读不写。 */
function maybeSaveSecDaily(){
  if (!SECS.length) return;
  if (SEC_SAVE_TS && Date.now() - SEC_SAVE_TS < 30 * 60000) return;

  var bj = new Date(Date.now() + 8 * 3600 * 1000);
  var hh = bj.getUTCHours(), mm = bj.getUTCMinutes(), wd = bj.getUTCDay();
  var mins = hh * 60 + mm;
  if (wd >= 1 && wd <= 5 && mins >= 9 * 60 && mins < 15 * 60) return;   // 盘中不写

  var dObj = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  var closed = wd >= 1 && wd <= 5 && mins >= 15 * 60;
  if (!closed){
    // 退到最近一个工作日：周末退到周五，开盘前退到昨天
    do { dObj.setUTCDate(dObj.getUTCDate() - 1); }
    while (dObj.getUTCDay() === 0 || dObj.getUTCDay() === 6);
  }
  var d = dObj.toISOString().slice(0, 10);

  var s = {};
  // 键必须和 secShareDelta 里读的一致（"a/半导体"），早先这里写的是 SECS[i].k，
  // 存进去是「半导体」、读的是「a/半导体」，永远对不上——基准攒了一年也画不出箭头。
  for (var i=0;i<SECS.length;i++) s[SECS[i].key] = Math.round(SECS[i].amt);

  var recs = SEC_BASE || [];
  var last = recs.length ? recs[recs.length-1] : null;
  // 同一天已经记过、而且带上了集中度/宽度就停。只判日期的话，早期写的那些
  // 没有 c/b 的旧记录会永远补不上，四象限的云就少一截。
  if (last && last.d === d && last.c > 0 && last.b > 0) return;
  if (last && last.s){
    var keys = 0, same = 0;
    for (var k in s){
      if (last.s[k] == null) continue;
      keys++;
      if (Math.abs(s[k] - last.s[k]) <= Math.max(1, last.s[k] * 0.003)) same++;
    }
    // 一格都没动，说明行情没换日（长假、临时休市），不能记成新的一天
    if (keys >= 6 && same === keys) return;
  }
  SEC_SAVE_TS = Date.now();
  var pad = function(v){ return (v < 10 ? '0' : '') + v; };
  // 这里只是兜底：主来源是 Actions 每天回算的 sec_daily.json（不依赖有人打开页面）。
  // 以前还顺带记集中度/宽度，现在四象限改用全 A 口径、由 gen_mkt_hist 回算，
  // 这两个字段已经没人读，再写进去只会让两套口径的数据混在同一个文件里。
  var body = { d: d, t: pad(hh) + ':' + pad(mm), s: s };
  fetch('/api/secdaily', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(j){
    if (j && j.ok) loadSecBase();
  }).catch(function(){});
}

/* 一个指数只出一票：成交额和涨跌幅都取「代表标的」（KEEP = 同指数里成交额最大那只）。
   为什么不把同指数所有 ETF 的成交额相加：一个指数发 14 只，14 只全进分子，
   等于把「发行数量」混进「资金关注度」——2026-11-07 收盘实测克隆倍数 1.1×~2.3×，
   人工智能因此被抬到 5.7%（只算代表是 2.9%），通信传媒被压到 10.8%（14.6%）。
   与涨跌幅的「一指数一票」对齐之后，占比才是「钱落在哪条线」，不是「哪条线发得多」。 */
var SEC_GROUPS_OUT = [];
function buildGroups(){
  var byIx = {};
  THEME_KEYS = {};
  for (var i=0;i<DATA.length;i++){
    var x = DATA[i];
    // 不再用「行业/宽基/跨境」那一层筛：那是按 ETF 简称判的，简称里没写「港股」的
    // 「互联网ETF」会被当成 A 股行业。板块归属一律看跟踪指数名。
    if (x.g === 'bond' || x.g === 'money') continue;   // 债/货币没有行业可言
    if (!isFinite(x.chg) || !isFinite(x.amt)) continue;
    // 新发/冷门 ETF 天天基金还没录「跟踪标的」（index_map 缺失 27 只，全是货币）
    // 或字段为空。这类不能直接丢——159516 半导体设备一天 37 亿，丢了半导体就少一块。
    // 用简称当临时指数名，自己去当一票。
    var kix = x.ix || ('~' + x.n);
    var o = byIx[kix];
    if (!o) o = byIx[kix] = { ix:x.ix || x.n, c:x.c, n:x.n, chg:x.chg, amt:0, cnt:0, rep:null, best:null };
    o.cnt++;
    if (KEEP[kix] === x.c) o.rep = x;
    if (!o.best || x.amt > o.best.amt) o.best = x;
  }
  // 代表标的今天没成交（停牌/新发）就退到组内成交额最大的那只，
  // 否则这个指数会带着 0 成交额混进板块，把涨幅加权拉向 0
  for (var k0 in byIx){
    var q0 = byIx[k0];
    var pick = (q0.rep && q0.rep.amt > 0) ? q0.rep : q0.best;
    q0.c = pick.c; q0.n = pick.n; q0.chg = pick.chg; q0.amt = pick.amt;
  }

  // 先归组、再归格。key 用「组码/板块名」——A股与港股都有「医药」「消费」「汽车」，
  // 只用板块名当日档 key 会互相覆盖。
  var gmap = {};
  for (var k in byIx){
    var cls = secClass(k);
    if (!cls) continue;
    var G = gmap[cls.code];
    if (!G) G = gmap[cls.code] = { g:cls.g, code:cls.code, amt:0, core:0, nth:0, cells:{} };
    var c = G.cells[cls.k];
    if (!c) c = G.cells[cls.k] = { k:cls.k, key:cls.code + '/' + cls.k, g:cls.g,
                                   code:cls.code, th:cls.th, ix:[], amt:0 };
    c.ix.push(byIx[k]);
    c.amt += byIx[k].amt;
    G.amt += byIx[k].amt;
    // nth 数的是「格子」，不是指数——一个主题格里可能躺着 8 个 AI 指数，
    // 累加指数个数会写成「2 个行业 · 14 个主题」。格数在下面 cells 拼好后数。
    if (cls.th) THEME_KEYS[cls.code + '/' + cls.k] = 1; else G.core += byIx[k].amt;
  }

  var out = [];
  for (var gi=0; gi<SEC_GROUPS.length; gi++){
    var def = SEC_GROUPS[gi], GG = gmap[def.code];
    if (!GG) continue;
    var cells = [];
    for (var kk in GG.cells){
      var t = GG.cells[kk], wsum = 0, vsum = 0, up = 0;
      if (!(t.amt > 0)) continue;    // 全天没成交的格子不显示
      for (var j=0;j<t.ix.length;j++){
        var q = t.ix[j];
        // 成交额为 0 的（停牌/新发）不参与加权，否则会把板块涨幅拉向 0
        if (q.amt > 0){ wsum += q.amt; vsum += q.chg * q.amt; }
        if (q.chg > 0) up++;
      }
      cells.push({ k:t.k, key:t.key, g:t.g, code:t.code, amt:t.amt, th:t.th,
                   ret: wsum > 0 ? vsum / wsum : 0, n:t.ix.length, up:up,
                   share: GG.core > 0 ? t.amt / GG.core : 0,
                   ix: t.ix.slice().sort(function(a,b){ return b.chg - a.chg; }) });
    }
    if (!cells.length) continue;
    // 行业格在前、主题格在后，各自按涨幅排。主题（AI / 新能源）是跨行业的，
    // 与上面几格的成交额重叠，混在一张榜里排「最强」会把同一笔钱数两遍。
    cells.sort(function(a,b){ return (a.th - b.th) || (b.ret - a.ret); });
    var nth = 0;
    for (var cn=0;cn<cells.length;cn++) if (cells[cn].th) nth++;
    out.push({ g:def.g, code:def.code, cells:cells, amt:GG.amt, core:GG.core,
               n:cells.length, nth:nth });
  }
  return out;
}

/* 折叠状态存本地：三个组三十多个格子同屏太挤，默认只展开 A 股。
   用户的展开/收起选择记在 localStorage，下次打开还是他上次的样子。 */
var SEC_FOLD = null;
function secFoldState(){
  if (SEC_FOLD) return SEC_FOLD;
  var s = null;
  try { s = JSON.parse(localStorage.getItem('secFold') || 'null'); } catch(e){}
  var fresh = (!s || typeof s !== 'object');
  if (fresh) s = { a:false, hk:true, x:true };
  SEC_FOLD = s;
  if (fresh) saveSecFold();   // 第一次进来就把默认值落盘，别每次重新猜
  return s;
}
function saveSecFold(){
  try { localStorage.setItem('secFold', JSON.stringify(SEC_FOLD)); } catch(e){}
}

function fmtAmt(v){
  if (!(v > 0)) return '—';
  if (v >= 1e8) return (v/1e8).toFixed(v >= 1e9 ? 1 : 2) + '亿';
  return Math.round(v/1e4) + '万';
}

/* ================= 数据体检 =================
   这一行被「229 个单只指数整组丢掉、页面毫无异样」坑出来过：数字照样显示，
   只是悄悄小了一截。既然是防复发的仪表，就必须让人一眼看出「今天出事没有」——
   纯灰小字等于没有。灯取三项里最差的：无跟踪标的暴增（映射表又丢组）、
   两份 Actions 回算的历史停更（管道挂了，页面数字停在原地不动）。 */
var SEC_COV = null;

function renderSecMeta(){
  var sm = document.getElementById('secMeta');
  if (!sm || !SEC_COV) return;
  var c = SEC_COV;
  var chk = secHealth();
  sm.innerHTML =
      '<span class="mt ' + chk.cls + '" role="button" tabindex="0"'
    + ' onclick="secMetaToggle()" title="点开看数据管道体检：两份历史停更、映射覆盖率"> '
    + '<i></i>数据体检' + (chk.cls !== 'ok' ? ' · 有异常' : '') + '</span>'
    + '<span>' + SECS.length + ' 格 · <b>' + c.nIx + '</b> 个指数有成交</span>'
    + '<span class="opt">每个指数只算成交额最大的一只</span>'
    + '<span>报价 <b>' + c.nQ + '</b>' + (c.nSt ? ' · 停牌 ' + c.nSt : '') + '</span>'
    + (c.nNoIx ? '<span title="这些 ETF 查不到跟踪标的（新发未收录、或数据源没给），进不了任何一格；'
        + '括号里是它们今天的成交额合计">无跟踪标的 <b>' + c.nNoIx + '</b> 只'
        + (c.noIxAmt > 0 ? '（' + fmtAmt(c.noIxAmt) + '）' : '') + '</span>' : '')
    + '<span class="opt" title="宽基、债券、货币、商品、风格（红利/价值）都不进板块地图——'
      + '它们不回答钱往哪条线走">宽基/债/货币/商品 不在表内</span>'
    + '<span class="mtdet" id="secMetaDet"></span>';
}
function secHealth(){
  var today = bjToday();
  var cls = 'ok', msgs = [];
  var worse = function (c) {
    if (c === 'bad') cls = 'bad';
    else if (c === 'warn' && cls === 'ok') cls = 'warn';
  };
  // 全 A 散点（250 天）：Actions 每天回算，停 3 个工作日以上就是挂了。
  // 上次 etf.db 停在 11-03 三天没人发现，就是这种形状——页面全正常，只是不动。
  var m = MKT_HIST && MKT_HIST.d && MKT_HIST.d.length ? MKT_HIST.d[MKT_HIST.d.length - 1] : null;
  var gM = m ? dayGap(m, today) : 99;
  if (!m || gM > 3 || MKT_HIST.d.length < 200){
    worse(gM > 6 || !m ? 'bad' : 'warn');
    msgs.push('全 A 散点历史停在 ' + (m ? m.slice(5) : '—') + (m ? '（' + gM + ' 天前）' : '')
      + '，Actions 可能没跑');
  }
  var sd = SEC_BASE && SEC_BASE.length ? SEC_BASE[SEC_BASE.length - 1].d : null;
  if (sd){
    var gS = dayGap(sd, today);
    if (gS > 3){
      worse(gS > 6 ? 'bad' : 'warn');
      msgs.push('板块日档停在 ' + sd.slice(5) + '（' + gS + ' 天前）');
    }
  }
  if (SEC_COV && SEC_COV.nNoIx > 20){
    worse('warn');
    msgs.push('无跟踪标的 ' + SEC_COV.nNoIx + ' 只，映射表可能又丢组了');
  }
  return { cls: cls, msgs: msgs };
}
function secMetaToggle(){
  var sm = document.getElementById('secMeta');
  if (!sm) return;
  var on = sm.classList.toggle('open');
  var det = document.getElementById('secMetaDet');
  if (!on || !det) return;
  var today = bjToday();
  var m = MKT_HIST && MKT_HIST.d && MKT_HIST.d.length ? MKT_HIST.d[MKT_HIST.d.length - 1] : null;
  var sd = SEC_BASE && SEC_BASE.length ? SEC_BASE[SEC_BASE.length - 1].d : null;
  var gM = m ? dayGap(m, today) : 99;
  var gS = sd ? dayGap(sd, today) : 99;
  var it = function (ok, label, val) {
    return '<span class="' + (ok ? 'ok' : 'warn') + '">' + (ok ? '✓' : '⚠') + ' ' + label
      + ' <b>' + val + '</b></span>';
  };
  det.innerHTML =
      it(m && gM <= 3, '全 A 散点', (MKT_HIST && MKT_HIST.d ? MKT_HIST.d.length : 0)
        + ' 天 · 最新 ' + (m ? m.slice(5) : '—'))
    + it(sd && gS <= 3, '板块日档', (SEC_BASE ? SEC_BASE.length : 0)
        + ' 天 · 最新 ' + (sd ? sd.slice(5) : '—'))
    + '<span class="note">两份历史由 Actions 每天收盘后回算；停更＝管道挂了，页面数字不会自己动</span>'
    + (secHealth().msgs.length ? '<span class="warnmsg">⚠ ' + secHealth().msgs.join('；') + '</span>' : '');
}

function renderSectors(){
  SEC_GROUPS_OUT = buildGroups();
  SECS = [];
  for (var a=0;a<SEC_GROUPS_OUT.length;a++){
    for (var b=0;b<SEC_GROUPS_OUT[a].cells.length;b++) SECS.push(SEC_GROUPS_OUT[a].cells[b]);
  }
  var body = document.getElementById('secBody');
  var hd = document.getElementById('secHead');
  if (!SECS.length){
    body.innerHTML = '<div class="empty">暂无行业主题数据（非交易时段或行情源未就绪）</div>';
    hd.innerHTML = '<span>—</span>';
    return;
  }
  var curAmt = {};
  for (var ci=0;ci<SECS.length;ci++) curAmt[SECS[ci].key] = SECS[ci].amt;
  var sdel = secShareDelta(curAmt);

  // 顶部只放三组总量。不做跨组「最强/最弱」——港股和 A 股的涨跌幅不可比，
  // 混排出来的第一名没有交易含义。组内对比放在各自组头。
  var hh = '';
  for (var hi=0;hi<SEC_GROUPS_OUT.length;hi++){
    var GH = SEC_GROUPS_OUT[hi];
    var hu = GH.code === 'x' ? ' 个地区' : ' 个板块';
    var hn = GH.nth
      ? (GH.n - GH.nth) + (GH.code === 'x' ? ' 地区 · ' : ' 行业 · ') + GH.nth + ' 主题'
      : GH.n + hu;
    hh += '<span>' + GH.g + ' <b>' + fmtAmt(GH.amt) + '</b> · ' + hn + '</span>';
  }
  hd.innerHTML = hh;

  // 这一行只回答「地图漏了什么」。被「229 个单只指数整组丢掉」坑过一次，
  // 覆盖率得写在明面上：多少格、多少个指数、多少只有报价、多少只进不来。
  var nQ = 0, nSt = 0, nNoIx = 0, noIxAmt = 0, nIx = 0, i0;
  for (i0=0;i0<DATA.length;i0++){
    var x0 = DATA[i0];
    if (x0.p > 0) nQ++; else nSt++;
    // 只数「本该进图却进不来」的：行业/主题、跨境。宽基、债券、货币、商品
    // 本来就不进板块地图，把它们算成「漏掉」会把 592 亿的债券货基写得像事故。
    if (!x0.ix && (x0.g === 'industry' || x0.g === 'cross')){
      nNoIx++; noIxAmt += (x0.amt || 0);
    }
  }
  for (i0=0;i0<SECS.length;i0++) nIx += SECS[i0].n;
  SEC_COV = { nIx: nIx, nQ: nQ, nSt: nSt, nNoIx: nNoIx, noIxAmt: noIxAmt };
  renderSecMeta();

  var h = '';
  var cellHtml = function(G2, cs, mxAmt, sdel){
    var o = '';
    for (var j2=0;j2<cs.length;j2++){
      var s = cs[j2];
      var cls = s.ret > 0 ? 'up' : (s.ret < 0 ? 'down' : 'flat');
      var sh = Math.min(1, Math.abs(s.ret) / 2);
      var rgb = s.ret > 0 ? '217,58,58' : '14,154,97';
      var share = s.share * 100;
      // 条长用开方：半导体 175 亿、公用环保 5.6 亿，线性比例下后者只有 3%、肉眼是空的。
      // 开方后 3% 变 18%，量级差还在，但不至于看不出有没有量。
      var barW = mxAmt > 0 ? Math.sqrt(s.amt / mxAmt) * 100 : 0;
      var dl = sdel && sdel[s.key];
      // 0.5 个百分点的门槛：再小就是噪声。三十几个格子里大半写着「0.1pt」，
      // 读数的人两天就学会无视这一列——那这个指标等于没做。
      var dsCls = !dl ? 'na' : (dl.ds > 0.5 ? 'up' : (dl.ds < -0.5 ? 'down' : 'na'));
      var dsTxt = (!dl || Math.abs(dl.ds) <= 0.5) ? ''
        : (dl.ds > 0 ? '↑' : '↓') + Math.abs(dl.ds).toFixed(1) + 'pt';
      // 主题格的分子不计入分母，占比会算出 135% 这种数——不是错，是「重叠」的定义。
      // 不报这个数，只报「与行业格重叠」，否则读者会以为分母算错了。
      var shPct = secSharePct(s.key, s.share);
      var shNote = s.th ? '（主题：与行业格重叠，不计入分母）'
        : '（占' + s.g + '板块 ' + share.toFixed(1) + '%）'
          + (shPct != null ? '，近一年 ' + shPct.toFixed(0) + ' 分位' : '');
      o += '<div class="scell' + (SEC_OPEN === s.key ? ' on' : '') + (s.th ? ' th' : '') + '" data-sec="' + s.key + '"'
        + ' title="' + s.k + '：' + s.n + ' 个跟踪指数（每个指数只算成交额最大那只），成交额 '
        + fmtAmt(s.amt) + shNote + '，'
        + s.up + '/' + s.n + ' 个指数上涨'
        + (s.th ? '。主题指数成分横跨多个行业，与上方行业格是同一批股票，不能再加一遍。' : '')
        + (dl ? '　·　资金占比' + (s.th ? '' : ' ' + (dl.share*100).toFixed(1) + '%') + '，较 '
          + (dl.d ? dl.d.slice(5) + ' 收盘' : '上一交易日') + ' '
          + (dl.ds >= 0 ? '+' : '') + dl.ds.toFixed(1) + ' 个百分点'
          : '　·　还没有收盘基准（收盘后自动记一条）') + '">'
        + '<i class="sz" style="background:rgba(' + rgb + ',' + (0.15 + 0.85*sh).toFixed(2) + ')"></i>'
        + '<div class="sn"><span class="nm">' + s.k + '</span>'
        + '<span class="sd ' + dsCls + '">' + dsTxt + '</span></div>'
        + '<div class="sv ' + cls + '">' + fpc(s.ret) + '</div>'
        + '<div class="ss"><span class="si">' + s.up + '/' + s.n + '</span>'
        + '<span class="sa">' + fmtAmt(s.amt) + '</span></div>'
        + '<div class="sbar" title="成交额' + shNote + '"><i style="width:'
        + barW.toFixed(1) + '%;background:rgba(' + rgb + ',.55)"></i></div>'
        + '</div>';
    }
    return o;
  };
  for (var g2=0;g2<SEC_GROUPS_OUT.length;g2++){
    var G2 = SEC_GROUPS_OUT[g2], cs = G2.cells;
    var core = [], ths = [];
    for (var c9=0;c9<cs.length;c9++) (cs[c9].th ? ths : core).push(cs[c9]);
    if (!core.length) continue;
    // 「最强/最弱/分化」只在行业格里选。主题格与行业格是同一批股票，
    // 让 AI 参与排名会出现「AI 最强、半导体也最强」的同义反复。
    var mxAmt = 0, nUp = 0;
    for (var m2=0;m2<core.length;m2++){ mxAmt = Math.max(mxAmt, core[m2].amt); if (core[m2].ret > 0) nUp++; }
    var top = core[0], bot = core[core.length-1];
    var spread = top.ret - bot.ret;
    // 组内资金占比上升最多的那一格（不到 0.5pt 不报，噪声）
    var bk = null, bv = 0;
    if (sdel){
      for (var m3=0;m3<core.length;m3++){
        var dl0 = sdel[core[m3].key];
        if (dl0 && dl0.ds > bv){ bv = dl0.ds; bk = core[m3].k; }
      }
    }
    h += '<div class="sgrp' + (secFoldState()[G2.code] ? ' fold' : '') + '" data-g="' + G2.code + '">'
      + '<div class="sghd" data-fold="' + G2.code + '">'
      + '<i class="sgc"></i><span class="sgk">' + G2.g + '</span>'
      + '<span class="sgt">' + core.length + (G2.code === 'x' ? ' 个地区' : ' 个行业')
      + (ths.length ? ' · ' + ths.length + ' 个主题' : '')
      + ' · ' + fmtAmt(G2.amt) + '</span>'
      + '<span class="sgm">强 <b class="' + (top.ret >= 0 ? 'up' : 'down') + '">'
      + top.k + ' ' + fpc(top.ret) + '</b></span>'
      + '<span class="sgm">弱 <b class="down">' + bot.k + ' ' + fpc(bot.ret) + '</b></span>'
      + '<span class="sgm">分化 <b>' + spread.toFixed(2) + '</b></span>'
      + (bk ? '<span class="sgm">资金 <b class="up">' + bk + ' +' + bv.toFixed(1) + 'pt</b></span>' : '')
      + '<span class="sgm t3">' + nUp + ' 涨 ' + (core.length - nUp) + ' 跌</span>'
      + '</div>'
      + (G2.code === 'a' ? secQuadCard() : '')
      + '<div class="smgrid">'
      + cellHtml(G2, core, mxAmt, sdel)
      + (ths.length
        ? '<div class="sth">主题 · 跨行业需求，成分落在上面几格里，<b>不计入占比分母</b></div>'
          + cellHtml(G2, ths, mxAmt, sdel)
        : '')
      + '</div><div class="sdet" id="secDet_' + G2.code + '"></div></div>';
  }
  body.innerHTML = h;
  maybeSaveSecDaily();
  stampN('secN', DATA_TS);

  // 明细：只显示当前点开的那一格，放在它所属组的格子里。
  // 全部指数都列出来（原先截前 8 个，新能源这种十几条线的板块，
  // 光伏就被挤出列表了——看不看得见取决于它今天涨没涨，那是错的）。
  var cur = null;
  for (var q=0;q<SECS.length;q++) if (SECS[q].key === SEC_OPEN) cur = SECS[q];
  if (!cur){ SEC_OPEN = null; return; }
  if (secFoldState()[cur.code]){ secFoldState()[cur.code] = false; saveSecFold(); }
  var det = document.getElementById('secDet_' + cur.code);
  if (!det) return;
  var grp = document.querySelector('.sgrp[data-g="' + cur.code + '"]');
  if (grp) grp.className = 'sgrp';
  var rows = cur.ix, dh = secTrend(cur) + '<div class="sdhd">' + cur.k + ' · 按涨幅排序 · '
    + cur.n + ' 个跟踪指数（每个指数只算成交额最大那只，点一行看 K 线）</div>'
    + '<div class="sdrwrap">';
  for (var r=0;r<rows.length;r++){
    var o = rows[r];
    var c2 = o.chg > 0 ? 'up' : (o.chg < 0 ? 'down' : 'flat');
    dh += '<div class="sr" data-code="' + esc(o.c) + '">'
      + '<span class="nm2">' + esc(o.ix) + '</span>'
      + '<span class="cd2">' + esc(o.c) + '</span>'
      + '<span class="v2 ' + c2 + '">' + fpc(o.chg) + '</span>'
      + '<span class="a2">' + fmtAmt(o.amt) + '</span></div>';
  }
  dh += '</div>';
  det.innerHTML = dh;
  det.className = 'sdet show';
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
    + '<td class="l nm"><span class="nmx">'+x.n+'</span>'+ixBadge(x)+'</td>'
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
  stampN('cardsN', DATA_TS);
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
    body.innerHTML = '<tr><td colspan="14" class="empty">还没有自选，点下方清单的 + 添加</td></tr>';
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
    + (WATCH_CLOUD ? '<span class="syn" title="已存到云端（按本机匿名编号分桶）。换设备请用「导入/导出」搬清单">云端</span>' : '');
  ensureTop3();
  paintTop3();     // tbody 刚被整块重写，单元格是新的，得重画一遍
  diagSync();
  // 自选走腾讯直连（5 秒/30 秒），比全市场快照新，时点要用它自己的
  stampN('watchN', LIVE_TS || DATA_TS);
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
  stampN('evtN', DATA_TS);
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


function mktList(){
  var box = document.getElementById('mktList');
  var rows = mktRows();
  if (!rows.length){
    box.innerHTML = '<div class="eempty">今天没有这一类事件。<br>'
      + '<span>不是数据没加载，是真的没有——这种日子不用动手。</span></div>';
    return;
  }
  var head = '<div class="mhead"><span>名称 / 跟踪指数</span><span>类型</span>'
    + '<span>位置</span><span>量能</span><span>今日</span></div>';
  var cap = 14;
  var shown = Math.min(rows.length, cap);
  // 6 行以内单栏就够，分两栏会出现「左 3 右 3」而右边那半截没内容支撑
  var two = shown > 6;
  var half = two ? Math.ceil(shown / 2) : shown;
  var colHtml = ['', ''];
  for (var i = 0; i < shown; i++){
    var r = rows[i].r, tg = MKT_LABEL[rows[i].t] || ['', ''];
    var pos = mktPos(r), ev = mktEvr(r);
    // 最后一列放今日涨幅而不是 20 日：这一栏回答的是「今天发生了什么」，
    // 20 日累计放进标题提示，鼠标停上去能看到。
    var tip = r[1] + ' · 20日 ' + fpc(r[6]) + ' · 成交 ' + r[10].toFixed(1) + ' 亿';
    var row = '<div class="mrow" data-c="' + r[0] + '" title="' + esc(tip) + '">'
      + '<span class="mn">' + esc(r[1])
      + (r[2] ? '<em>' + esc(r[2]) + '</em>' : '') + '</span>'
      + '<span class="mtag ' + tg[1] + '">' + tg[0] + '</span>'
      + '<span class="mnum">' + pos.toFixed(0) + '</span>'
      + '<span class="mnum">' + (ev == null ? '-' : ev.toFixed(1)) + '</span>'
      + '<span class="mnum ' + cc(r[7]) + '">' + fpc(r[7]) + '</span>'
      + '</div>';
    colHtml[i < half ? 0 : 1] += row;
  }
  var h = two
    ? '<div class="mcols"><div class="mcol">' + head + colHtml[0] + '</div>'
      + '<div class="mcol">' + head + colHtml[1] + '</div></div>'
    : head + colHtml[0];
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
    document.getElementById('mktTabs').innerHTML = '';
    if (nEl) nEl.textContent = '';
    return;
  }
  mktBar(); mktTabs(); mktList();
  if (nEl){
    nEl.textContent = MKT.n + ' 个指数 · ' + MKT.date + ' 收盘';
    stampN('mktN', null);
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
    // 诊断读的是日线历史（最后一天是上一交易日），行情部分是今天的快照
    stampN('diagN', DATA_TS);
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
    stampN('listN', DATA_TS);
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
  stampN('listN', DATA_TS);
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

/* 服务端给的 pv 是相对**今开**的百分比（0 = 今开）。但行情软件的 0 轴是**昨收**，
   两者在跳空日会彻底背离：588000 低开 4.6%，全天都在昨收下方运行，按今开算却是
   一路上扬 +2.2%——迷你线画出来像在涨，左边数字却是绿的，和分时图对照就是「对不上」。

   这里换算到昨收基准，让迷你线、涨跌幅、分时图三者同向。不需要额外请求：服务端
   给的最后一点 pv_last 对应现价 price，于是今开 = price / (1 + pv_last/100)，
   再套一遍就得到相对昨收的百分比。用快照的 price/prev 而不是 chg 字段，
   因为 chg 只有两位小数，低价品种会带来 0.01% 级别的抖动。 */
function toPrevBase(pv, price, prev){
  if (!pv || pv.length < 3 || !(price > 0) || !(prev > 0)) return pv;
  var lastPct = pv[pv.length - 1];
  if (!isFinite(lastPct)) return pv;
  var open = price / (1 + lastPct / 100);
  if (!(open > 0)) return pv;
  var k = open / prev, out = [], i;
  for (i = 0; i < pv.length; i++) out.push(+((k * (1 + pv[i] / 100) - 1) * 100).toFixed(2));
  return out;
}

/* 迷你线：横轴是当日 9:30 至今的完整分时，与「涨速」的窗口不是一回事，所以颜色
   按全天方向给、形状按全天给——「上午冲高、午后一路阴跌、最后两分钟拉起来」这种
   形态，只有拉长到全天才看得见。颜色硬编码是因为 SVG 的 stroke 属性不吃 CSS 变量
   （--up/--down 改主题时这里要跟着改）。

   纵向尺度是这一栏最容易画错的地方。原先每行按自己的 min/max 拉满，结果
   0.18% 的横盘和 0.45% 的急拉画出来一样高、一样陡——一列全是同形状的锯齿，
   看起来「比例很怪」，而且丢掉了「动得多不多」这个信息。
   现在：
   - 中线 = 昨收，虚线画出来当基准，和分时图的 0 轴是同一根线；
   - 全池共用一把尺子（spdScale），幅度按同一比例换算，行与行之间可比；
   - 超尺的顶到边，短的自然就矮——10 只里谁走得最远一眼能排出来。 */
function spdSpark(vals, up, sc){
  // vals 是相对昨收的百分比：0 就是昨收，中线画在那儿
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

/* 全池共用一把纵向尺子：取每只「当日相对昨收最大偏离（%）」的 65 分位。
   0.15% 是下限（那种一根直线的心电图没必要占满），5% 是上限（有一只暴涨
   时不至于把其余 39 只全压成直线）。分位从 75 降到 65 是配合全天窗口调的：
   20 分钟窗口里大家的振幅都在 0.3%~0.5%，75 分位正好把线铺满；拉到全天之后
   振幅差得远（题材 ETF 3%、宽基 0.8%），75 分位会把大半的线压成矮墩墩一条，
   降到 65 让多数线用掉六七成高度，代价是四分之一的线会顶到框边——顶边本身
   也是信息（「这只今天动得比同类猛」）。

   上限从 3% 放到 5%：基准换成昨收之后，跳空日的幅度不再被今开吃掉，
   低开高走的那几只 max|pv| 能到 5%~7%，卡在 3% 会让一整列全顶边。 */
function spdScale(rows){
  var a = [], i, j, pv, m, dv;
  for (i = 0; i < rows.length; i++){
    pv = rows[i].pvn || rows[i].pv;
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
  return Math.min(5, Math.max(0.3, q));
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

  /* 先把 pv 从「相对今开」换算到「相对昨收」——迷你线和分时图的 0 轴必须是同一根，
     否则跳空日会出现「线在涨、数字在跌」。换算要用快照里的现价和昨收，缺任一只
     就退回今开基准（线照样能画，只是那一行的 0 轴和别的行不是一个意思）。 */
  var it0;
  for (i = 0; i < SPD.rows.length; i++){
    it0 = findItem(SPD.rows[i].c);
    SPD.rows[i].pvn = (it0 && it0.p > 0 && it0.pc > 0)
      ? toPrevBase(SPD.rows[i].pv, it0.p, it0.pc)
      : SPD.rows[i].pv;
  }

  // 尺子按整个池子算，不按这两栏算：左右两栏、切换 3/5 分钟都得同一把尺，
  // 否则「急涨第一名」和「急跌第一名」的波形幅度没法放在一起看
  var SC = spdScale(SPD.rows);

  function rowHtmlOf(o){
    var x = o.r, it = findItem(x.c);
    var nm = it ? it.n : x.c;
    var hot = o.q >= SPD_VOL_HOT;
    /* 线的颜色跟全天方向走（相对昨收），不跟 3 分钟涨速走：否则跳空低开的日子
       会出现「绿线一路向上」这种自相矛盾的图形。左边数字仍是涨速、仍按涨速
       配色——那才是这一栏排序的依据，「急跌但今天还涨着」本身就是有用的信息。 */
    var pvx = x.pvn || x.pv;
    var dayUp = pvx && pvx.length ? pvx[pvx.length - 1] >= 0 : true;
    // sp 和标称窗口差得多就标 ~：可能是数据缺口把基准推远了（尾盘 14:56
    // 直接跳 15:00，3 分钟实际跨了 4 分钟），也可能是午后刚开盘窗口还没走满
    var far = Math.abs(x.sp - SPD.w) >= 2;
    return '<div class="spdrow" data-c="' + x.c + '">'
      + '<div class="spdnm" title="' + nm + '  ' + x.c + '">'
        + '<span class="nmx">' + nm + '</span><em>' + x.c + '</em></div>'
      + spdSpark(pvx, dayUp, SC)
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
      + '小走势线是<b>当日 9:30 至今</b>的分时，虚线是<b>昨收</b>，和分时图同一根 0 轴——'
      + '线在虚线上方就是全天还在涨，颜色也按这条线的方向给（数字仍是 ' + SPD.w + ' 分钟涨速，两者可以不同向）。'
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

/* 涨跌一律以「前一交易日收盘」为基准——这是行情软件的通行口径，也是「今天涨没涨」
   的语义。以开盘价为基准算出来的是「日内振幅方向」：跳空低开再收回一半，
   会显示成上涨、还标红，跟账户里的盈亏正好相反。
   159108 就是一个现成的例子：2026-11-06 前收 0.894、开 0.850、收 0.866，
   实际 -3.13%，按开盘算却成了 +1.88%。 */
function hChgPct(c, i){
  var cl = c.close, op = c.open;
  if (!isFinite(cl[i])) return NaN;
  if (i > 0 && isFinite(cl[i - 1]) && cl[i - 1] > 0) return (cl[i] / cl[i - 1] - 1) * 100;
  if (isFinite(op[i]) && op[i] > 0) return (cl[i] / op[i] - 1) * 100;   // 首根没有前收
  return NaN;
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
    // 量柱跟着 K 线染色，K 线跟涨跌（昨收基准）走，不跟「开 vs 收」走
    var cUp = (i > 0 && isFinite(cl[i - 1])) ? cl[i] >= cl[i - 1] : cl[i] >= o[i];
    ctx.fillStyle = cUp ? 'rgba(217,58,58,.55)' : 'rgba(14,154,97,.55)';
    var x0 = xOf(i) - ew / 2, hgt = yV + hV - yVx(vol[i]);
    ctx.fillRect(x0, yVx(vol[i]), ew, Math.max(1, hgt));
  }
  ctx.fillStyle = HC.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(famt(vmax), padL + plotW + 5, yV + hV - 3);

  /* --- K 线 --- */
  for (i = i0; i < n; i++){
    if (!isFinite(o[i]) || !isFinite(cl[i])) continue;
    // 红绿是「涨跌」不是「阴阳」：跳空低开但收回开盘上方，只要没回到昨收，
    // 这根仍然是跌的，必须画绿。首根没有前收才退回开盘价。
    var up = (i > 0 && isFinite(cl[i - 1])) ? cl[i] >= cl[i - 1] : cl[i] >= o[i];
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
  var chg = hChgPct(c, idx);
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
  if (document.getElementById('ioMask').classList.contains('on')) { ioClose(); return; }
  if (document.getElementById('trigMask').classList.contains('on')) { trigClose(); return; }
  if (document.getElementById('ovMask').classList.contains('on')) { ovClose(); return; }
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
/* ---------- 模块时间标记 ----------
   每个模块右上角标两个时刻：
     数据时点 = 这批数据本身是什么时候的（快照 ts / 美股收盘 / 分时最后一根）
     算于     = 浏览器把这批数据算完的时刻
   分开写是因为它们经常差几十秒：清单快照 09:52 到，位置诊断要串行读几十只历史，
   算完可能 09:52:40。只写「更新 09:52:40」会让人以为行情是 40 秒前的。
   重复渲染先删再插，刷一百次也只有一组。手机竖屏只留「数据时点」，其余 hide-sm。 */
function _p2(n){ return (n < 10 ? '0' : '') + n; }
function _hms(t){
  var d = new Date(t || Date.now());
  return _p2(d.getHours()) + ':' + _p2(d.getMinutes()) + ':' + _p2(d.getSeconds());
}
function _hm(t){
  var d = new Date(t || Date.now());
  return _p2(d.getHours()) + ':' + _p2(d.getMinutes());
}
function stampN(id, pointTs){
  var el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  var old = el.querySelector('.tsm');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var base = String(el.textContent || '').trim();
  if (base === '-' || base === '—') el.textContent = '';
  // 前面没有内容时不要留一个孤零零的「·」——板块地图/今日概况的 meta 本来就是空的
  var dot = String(el.textContent || '').trim() ? ' · ' : '';
  el.insertAdjacentHTML('beforeend',
    '<span class="tsm">' + dot + (pointTs ? '数据时点 ' + _hm(pointTs) : '')
    + '<span class="hide-sm">' + (pointTs ? ' · ' : '') + '算于 ' + _hms() + '</span></span>');
}

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
    renderOvernight();               // 隔夜卡里映射的 ETF 涨跌跟着快照走
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

    renderCards(); renderList(); renderWatch(); renderSectors();
    // 这几块共用同一份快照，数据时点一致；各模块自己也可能再打一次（重算按钮），幂等
    stampN('secN', DATA_TS);
    stampN('listN', DATA_TS);
    // 全市场提醒跟着全量快照走（60 秒一刷），不能挂在 5 秒的自选行情上——
    // 那个只有自选那几十只，扫出来的「全市场」是假的
    alertScanAll();
    // 板块基准和历史是两个来源：基准走 /api/secdaily（KV，60 秒边缘缓存），
    // 首屏不等它——先把涨跌画出来，基准回来再补一次，页面不会白等一个来回
    if (SEC_BASE === null && !SEC_REQ){
      SEC_REQ = true;
      loadSecBase().then(function(){ if (SECS.length) renderSectors(); });
    }
    loadMktSnap();
    hRefresh();                      // 弹窗开着就跟着这次快照重算最后一根
    // 涨速榜的池子是从这份快照里挑的，第一次拿到数据才有得挑
    if (!SPD.rows.length && !SPD.loading) spdFetch();
  }).catch(function(e){
    setStale('行情源暂时不可用（' + e.message + '），15 秒后自动重试；自选行情走腾讯直连，不受影响', true);
    document.getElementById('fErr').textContent = '';
    if (!DATA.length){
      var lbody = document.getElementById('listBody');
      lbody.innerHTML =
        '<tr><td colspan="11" class="lerr">'
        + '<b>行情源暂时不可用</b>'
        + '<span>' + esc(String(e.message || e)) + '</span>'
        + '<button type="button" id="btnListRetry">立即重试</button></td></tr>';
      // 自动重试是 15 秒后，但人不会盯着时钟等——给一个能点的
      var rb = document.getElementById('btnListRetry');
      if (rb) rb.addEventListener('click', function(){
        rb.disabled = true; rb.textContent = '重试中…';
        if (retryTimer){ clearTimeout(retryTimer); retryTimer = null; }
        loadFull();
      });
    }
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

/* ---------- 盘中提醒 ----------
   两个范围，两种说法，因为信噪比差一个数量级：

   自选（默认 5 秒一刷）——逐只报。20 来只，一天越线三五次，报得起，
   而且「我关心的那只出事了」本身就是重点。

   全市场（60 秒一刷）——只报两类：极端个股（2 倍阈值）和每 5 分钟一条汇总。
   400 只按同一阈值逐只弹，一天几百条，弹到第二次就没人看了。全市场要回答的是
   「今天哪条线在动」，不是「第 37 只涨了 2.1%」。

   全市场这条不做 3 分钟急变：数据 60 秒一刷，3 分钟窗口只有 3 个采样点，
   算出来的「急变」是采样误差不是行情。急变只在自选范围有效，这点在提示里写明。

   所有触发都进「今日提醒」记录（浮层只停 9 秒，全市场模式下记录才是主出口）。

   能力边界写在明处：这是**页面内**提醒，标签页关掉就没了。真要做 7×24 推送得配
   Web Push（需要 VAPID 密钥和订阅端点持久化），或走企业微信机器人，那是另一套东西。
   这里不假装自己是推送。 */
var ALERT = { on:false, scope:'watch', chg:2.0, spd:0.8, pm:2.0 };
var ALERT_MUTE = {};          // key -> 上次提醒时间，不落盘
var ALERT_HIT = {};           // 当日已提醒过的 key（涨跌幅这类一天只提一次）
var ALERT_SPD = {};           // code -> [{t,p}]，用来算 3 分钟变化
var ALERT_DAY = new Date().toDateString();
var ALERT_LOG = [];           // 今日触发记录，最多留 200 条
var ALERT_ALL_TS = 0;         // 上次全市场汇总的时间
var ALERT_ALL_GAP = 5 * 60000;

try {
  var aj = localStorage.getItem('etf_alert');
  if (aj){ var ao = JSON.parse(aj);
    ALERT.chg = +ao.chg || 2.0; ALERT.spd = +ao.spd || 0.8; ALERT.pm = +ao.pm || 2.0;
    if (ao.scope === 'all') ALERT.scope = 'all'; }
} catch(e){}

function alertSave(){
  try { localStorage.setItem('etf_alert', JSON.stringify({
    chg:ALERT.chg, spd:ALERT.spd, pm:ALERT.pm, scope:ALERT.scope })); } catch(e){}
}

function alertPush(title, body, cls, key){
  var box = document.getElementById('alertBox');
  var lp = document.getElementById('alertLog');
  // 记录面板开着的时候不弹浮层：两者都在右上角，浮层会正好盖住列表，
  // 而且列表本来就是浮层的完整版——同一件事没必要说两遍。
  var panelOpen = lp && lp.className.indexOf('show') >= 0;
  if (box && !panelOpen){
    var d = document.createElement('div');
    d.className = 'aitem ' + (cls || '');
    d.innerHTML = '<b>' + esc(title) + '</b><small>' + esc(body) + '</small>';
    box.appendChild(d);
    setTimeout(function(){ if (d.parentNode) d.parentNode.removeChild(d); }, 9000);
    while (box.children.length > 4) box.removeChild(box.firstChild);
  }

  ALERT_LOG.push({ t:Date.now(), title:title, body:body, cls:cls || '' });
  if (ALERT_LOG.length > 200) ALERT_LOG = ALERT_LOG.slice(-200);
  var nb = document.getElementById('btnLog');
  if (nb){ nb.style.display = ''; nb.textContent = ALERT_LOG.length + ' 条'; }
  if (lp && lp.className.indexOf('show') >= 0) renderAlertLog();

  if (window.Notification && Notification.permission === 'granted'){
    try { new Notification(title, { body: body, tag: key, silent: false }); } catch(e){}
  }
  if (document.hidden){
    document.title = '● ' + title.replace(/^.*?·/, '') + ' · ETF 盯盘';
  }
}

function renderAlertLog(){
  var body = document.getElementById('logBody');
  var sub = document.getElementById('logSub');
  if (!body) return;
  if (sub) sub.textContent = ALERT.scope === 'all' ? '全市场' : '自选';
  if (!ALERT_LOG.length){
    body.innerHTML = '<div class="le">今天还没有触发过提醒<br>阈值在「提醒 开」右侧可以调</div>';
    return;
  }
  var h = '';
  for (var i=ALERT_LOG.length-1; i>=0; i--){
    var r = ALERT_LOG[i];
    var d = new Date(r.t);
    var hm = (d.getHours()<10?'0':'') + d.getHours() + ':' + (d.getMinutes()<10?'0':'') + d.getMinutes();
    h += '<div class="li ' + r.cls + '"><em>' + hm + '</em><i title="' + esc(r.body) + '">'
      + esc(r.title) + '</i></div>';
  }
  body.innerHTML = h;
}

/* 冷却：同一标的同一类型 10 分钟内只响一次。没有这个，一只票在阈值附近来回抖，
   5 秒一条，比不提醒更糟。 */
function alertCool(key, min){
  var now = Date.now(), last = ALERT_MUTE[key];
  if (last && now - last < (min || 10) * 60000) return false;
  ALERT_MUTE[key] = now;
  return true;
}

function alertScan(items){
  if (!ALERT.on || ALERT.scope !== 'watch' || !isOpen()) return;
  var today = new Date().toDateString();
  if (today !== ALERT_DAY){ ALERT_DAY = today; ALERT_HIT = {}; ALERT_SPD = {}; }

  var now = Date.now();
  for (var c in items){
    var x = items[c];
    if (!x || !isFinite(x.chg)) continue;

    // 1) 当日涨跌幅越线：一天只提一次，否则每 5 秒响一遍
    if (Math.abs(x.chg) >= ALERT.chg){
      var k1 = 'chg|' + c + '|' + ALERT_DAY;
      if (!ALERT_HIT[k1]){
        ALERT_HIT[k1] = 1;
        alertPush(x.n + ' ' + (x.chg > 0 ? '+' : '') + x.chg.toFixed(2) + '%',
          '自选当日涨跌幅越过 ' + ALERT.chg + '% 阈值 · 现价 ' + x.p.toFixed(3),
          x.chg > 0 ? 'up' : 'dn', k1);
      }
    }

    // 2) 3 分钟急变：滚动窗口，超出阈值再按冷却去重
    var arr = ALERT_SPD[c] || (ALERT_SPD[c] = []);
    arr.push({ t: now, p: x.p });
    while (arr.length && now - arr[0].t > 180000) arr.shift();
    if (arr.length >= 3){
      var base = arr[0].p, mv = base > 0 ? (x.p / base - 1) * 100 : 0;
      if (Math.abs(mv) >= ALERT.spd){
        var k2 = 'spd|' + c;
        if (alertCool(k2, 10)){
          alertPush(x.n + ' 3 分钟 ' + (mv > 0 ? '+' : '') + mv.toFixed(2) + '%',
            '从 ' + base.toFixed(3) + ' 到 ' + x.p.toFixed(3) + ' · 成交 ' + fmtAmt(x.amt),
            mv > 0 ? 'up' : 'dn', k2);
        }
      }
    }

    // 3) 溢价越线：跨境 ETF 最容易出事，折价反而是机会，两个方向都提
    if (x.pm != null && isFinite(x.pm) && Math.abs(x.pm) >= ALERT.pm){
      var k3 = 'pm|' + c + '|' + Math.round(x.pm);
      if (alertCool(k3, 30)){
        alertPush(x.n + ' 溢价 ' + (x.pm > 0 ? '+' : '') + x.pm.toFixed(2) + '%',
          (x.pm > 0 ? '场内比净值贵，追高要付溢价' : '场内比净值便宜，注意流动性和限购')
            + ' · IOPV ' + (x.iopv != null ? x.iopv.toFixed(3) : '—'),
          x.pm > 0 ? 'up' : 'dn', k3);
      }
    }
  }
}

/* 全市场：只在「极端」和「汇总」两个尺度上说话。
   单只越 1 倍阈值只是「今天它在动」，400 只里随时有几十只，不构成信息；
   越 2 倍阈值才是「这只出事了」。中间的交给每 5 分钟一条的汇总。 */
/* 全市场提醒扫的池子 = 同指数去重后的代表标的，不是 1719 只全量。
   1719 只里有 1202 只在跟别人跟踪同一个指数（2026-11-07 实测：247 组指数，
   另 270 只没抓到跟踪标的、判断不了重复），日内涨跌幅几乎一样。
   全量扫的直接后果是前 3 名被同一指数的克隆占满——20 只 A500 一起涨 3%，
   榜单等于没给信息。去重后 500 出头，一只一个指数，榜单才是「哪个方向在动」。 */
function alertPool(){
  var arr = [], i, x;
  for (i=0;i<DATA.length;i++){
    x = DATA[i];
    // 停牌、无成交、债券货币类不参与：那几类涨跌幅恒定，扫了也是白扫
    if (!x || !isFinite(x.chg) || !(x.amt > 0) || x.pre) continue;
    if (x.g === 'bond' || x.g === 'money') continue;
    if (!isRep(x)) continue;
    arr.push(x);
  }
  return arr;
}

function alertScanAll(){
  if (!ALERT.on || ALERT.scope !== 'all' || !isOpen()) return;
  if (!DATA.length) return;

  var pool = alertPool();
  var up = [], dn = [], pms = [];
  for (var i=0;i<pool.length;i++){
    var x = pool[i];
    if (x.chg >= ALERT.chg) up.push(x);
    else if (x.chg <= -ALERT.chg) dn.push(x);
    if (x.pm != null && isFinite(x.pm) && Math.abs(x.pm) >= ALERT.pm) pms.push(x);
  }
  up.sort(function(a,b){ return b.chg - a.chg; });
  dn.sort(function(a,b){ return a.chg - b.chg; });

  var ext = [];
  var shout = function(x){
    var k = 'allex|' + x.c + '|' + ALERT_DAY;
    if (ALERT_HIT[k]) return;                   // 同一只今天只报一次
    ALERT_HIT[k] = 1;
    ext.push(x);
    alertPush(x.n + ' ' + fpc(x.chg),
      (x.chg > 0 ? '涨幅' : '跌幅') + '是阈值的 ' + (Math.abs(x.chg)/ALERT.chg).toFixed(1) + ' 倍'
        + ' · 成交 ' + fmtAmt(x.amt) + (x.ix ? ' · 跟踪 ' + x.ix : ''),
      x.chg > 0 ? 'up' : 'dn', k);
  };
  /* 只认「当下最极端的前 3 名」，不是「所有超过 2 倍阈值的」。
     差别很大：极端的日子几十只同时超 4%。按「所有」报，每轮弹出前三名，
     下一轮它们被冷却挡住、就漏出第 4/5/6 名——一路漏到底，等于没上限。
     限定在前 3 名内，超出的只进记录，浮层才不会被淹。 */
  var cand = [];
  for (var a=0;a<up.length && a<3;a++) if (up[a].chg >= ALERT.chg*2) cand.push(up[a]);
  for (var b=0;b<dn.length && b<3;b++) if (dn[b].chg <= -ALERT.chg*2) cand.push(dn[b]);
  cand.sort(function(p,q){ return Math.abs(q.chg) - Math.abs(p.chg); });
  for (var e=0;e<cand.length && ext.length<2;e++) shout(cand[e]);

  // 2) 溢价：跨境最容易出事，全市场只报 1.5 倍以上的偏离，60 分钟冷却
  for (var c=0;c<pms.length && ext.length<3;c++){
    var p = pms[c];
    if (Math.abs(p.pm) < ALERT.pm * 1.5) continue;
    var kp = 'allpm|' + p.c;
    if (!alertCool(kp, 60)) continue;
    ext.push(p);
    alertPush(p.n + ' 溢价 ' + (p.pm>0?'+':'') + p.pm.toFixed(2) + '%',
      (p.pm > 0 ? '场内比净值贵，追高要付溢价' : '场内比净值便宜，注意流动性与限购')
        + (p.iopv != null ? ' · IOPV ' + p.iopv.toFixed(3) : ''),
      p.pm > 0 ? 'up' : 'dn', kp);
  }

  // 3) 汇总：每 5 分钟一条。说清「多少只在动、动得最狠的是哪几只」，
  //    而不是把 40 只逐个念一遍。越线比例过高时改口径——那时「750 只跌超 2%」
  //    已经不是「哪些在动」，是「全市场在跌」，措辞要跟着变。
  if (!up.length && !dn.length) return;
  var now = Date.now();
  if (ALERT_ALL_TS && now - ALERT_ALL_TS < ALERT_ALL_GAP) return;
  ALERT_ALL_TS = now;

  var nb = up.length + dn.length;
  var ratio = pool.length > 0 ? nb / pool.length : 0;
  var mood = ratio > 0.25 ? (dn.length > up.length ? '普跌' : '普涨') : '';
  // 带上去重后的池子大小：否则「12 涨 45 跌」会被读成「1719 只里只有 12 只在涨」，
  // 实际是 517 个指数代表里 12 个在涨——差着一个数量级。
  var head = (mood ? mood + ' · ' : '') + '全市场 ' + pool.length + ' 只中 '
    + up.length + ' 涨 ' + dn.length + ' 跌 越过 ' + ALERT.chg + '%';
  var parts = [];
  var top = up.slice(0, 3).map(function(x){ return x.n + ' ' + fpc(x.chg); });
  if (top.length) parts.push('领涨 ' + top.join('、'));
  var bot = dn.slice(0, 3).map(function(x){ return x.n + ' ' + fpc(x.chg); });
  if (bot.length) parts.push('领跌 ' + bot.join('、'));
  alertPush(head, parts.join(' · '), up.length >= dn.length ? 'up' : 'dn', 'allsum');
}

(function(){
  var btn = document.getElementById('btnAlert');
  var set = document.getElementById('alertSet');
  var scp = document.getElementById('btnScope');
  if (!btn) return;
  var paint = function(){
    btn.className = 'abtn' + (ALERT.on ? ' on' : '');
    btn.innerHTML = ALERT.on ? '<i></i>提醒 开' : '提醒 关';
    set.className = 'aset' + (ALERT.on ? ' show' : '');
    if (scp){
      scp.className = 'abtn' + (ALERT.scope === 'all' ? ' on' : '');
      scp.textContent = '范围 ' + (ALERT.scope === 'all' ? '全市场' : '自选');
    }
  };
  paint();
  var scopeNote = function(){
    return ALERT.scope === 'all'
      ? ' · 60 秒一刷，只报极端个股（2 倍阈值）与每 5 分钟汇总。'
        + '3 分钟急变在全市场不可用——数据 60 秒一刷，算出来的是采样误差不是行情'
      : ' · 5 秒一刷，逐只报';
  };
  btn.onclick = function(){
    ALERT.on = !ALERT.on;
    paint();
    if (ALERT.on){
      ALERT_MUTE = {}; ALERT_SPD = {}; ALERT_ALL_TS = 0;
      var n = ALERT.scope === 'all' ? alertPool().length : (Object.keys(LIVE).length || watch.length);
      alertPush('盯盘提醒已开启',
        '监控 ' + n + ' 只' + (ALERT.scope === 'all' ? '（全市场·同指数去重）' : '自选')
          + ' · 涨跌≥' + ALERT.chg + '% · 溢价≥' + ALERT.pm + '%' + scopeNote(), '', 'on');
      if (ALERT.scope === 'all') alertScanAll();
    }
    if (ALERT.on && window.Notification && Notification.permission === 'default'){
      try { Notification.requestPermission(); } catch(e){}
    }
  };
  if (scp) scp.onclick = function(){
    ALERT.scope = ALERT.scope === 'all' ? 'watch' : 'all';
    ALERT_MUTE = {}; ALERT_SPD = {}; ALERT_ALL_TS = 0; ALERT_HIT = {};
    alertSave(); paint();
    if (ALERT.scope === 'all'){
      toast('范围：全市场 ' + alertPool().length + ' 只（同指数去重）· 只报极端与 5 分钟汇总');
      if (ALERT.on) alertScanAll();      // 切过去立刻跑一轮，别等 60 秒
    } else {
      toast('范围：自选 ' + watch.length + ' 只 · 逐只提醒');
    }
  };
  var bind = function(id, key){
    var el = document.getElementById(id);
    if (!el) return;
    el.onchange = function(){
      var v = parseFloat(this.value);
      if (!isFinite(v) || v <= 0){ this.value = ALERT[key].toFixed(1); return; }
      ALERT[key] = v; alertSave();
      if (key === 'chg'){ ALERT_HIT = {}; ALERT_ALL_TS = 0; }
    };
  };
  bind('aChg','chg'); bind('aSpd','spd'); bind('aPm','pm');
  var pb = document.getElementById('btnPerm');
  if (pb) pb.onclick = function(){
    if (!window.Notification){ toast('这台设备的浏览器不支持桌面通知'); return; }
    Notification.requestPermission().then(function(r){
      toast(r === 'granted' ? '已允许桌面通知' : '通知被拒绝，只能看页面浮层');
    });
  };
  var lg = document.getElementById('btnLog');
  var lp = document.getElementById('alertLog');
  if (lg && lp){
    lg.onclick = function(e){
      e.stopPropagation();
      var on = lp.className.indexOf('show') >= 0;
      renderAlertLog();
      lp.className = on ? '' : 'show';
      // 打开时清掉残留浮层：面板就是浮层的完整版，留着只会遮住列表顶部
      if (!on){ var bx = document.getElementById('alertBox'); if (bx) bx.innerHTML = ''; }
    };
    lp.onclick = function(e){ e.stopPropagation(); };
    document.addEventListener('click', function(){
      if (lp.className.indexOf('show') >= 0) lp.className = '';
    });
    document.getElementById('logClr').onclick = function(){
      ALERT_LOG = []; lg.textContent = '0 条'; lg.style.display = 'none';
      renderAlertLog(); lp.className = '';
    };
  }
})();

document.addEventListener('visibilitychange', function(){
  if (!document.hidden) document.title = 'ETF 全市场盯盘';
});

// 四象限说明浮窗：点 ? 打开，点别处关掉。
// 按钮自己的 onclick 里 stopPropagation 了，所以这里冒泡上来的一定是「点了空白」。
document.addEventListener('click', function(){
  var o = document.querySelector('.scq.open');
  if (o) o.classList.remove('open');
});

/* ================= 散点的点击：每一天都能翻出来看 =================
   灰点不是装饰，250 个点各是一个交易日。原来只有「今天」那一个点有数字，
   想找「上一次宽度这么低是什么时候、那天钱在哪」只能干瞪眼。

   命中判定不用 250 个事件节点：把点击坐标按 data-g 反算回 viewBox，
   在点阵里取最近的一个，屏幕上 16px 内才算点到——避免远处误点跳出一个日子。 */
function scqGeo(svg){
  var g = (svg.getAttribute('data-g') || '').split(',');
  var vb = svg.viewBox && svg.viewBox.baseVal;
  var r = svg.getBoundingClientRect();
  if (g.length < 6 || !vb || !r.width) return null;
  return { x0: +g[0], x1: +g[1], y0: +g[2], y1: +g[3], ylo: +g[4], yhi: +g[5],
           vb: vb, r: r, kx: vb.width / r.width };
}
function scqXY(G, c, b){
  return [G.x0 + Math.max(0, Math.min(100, b)) / 100 * (G.x1 - G.x0),
          G.y1 - (c - G.ylo) / (G.yhi - G.ylo) * (G.y1 - G.y0)];
}
function scqHit(svg, cx, cy){
  var P = SCQ_PTS, G = scqGeo(svg);
  if (!P || !G) return -1;
  var mx = (cx - G.r.left) * G.kx;
  var my = (cy - G.r.top) * (G.vb.height / G.r.height);
  var best = -1, bd = 1e9, i, x, y, p, dx, dy, d2;
  for (i = 0; i < P.C.length; i++){
    p = scqXY(G, P.C[i], P.B[i]); x = p[0]; y = p[1];
    dx = x - mx; dy = y - my; d2 = dx * dx + dy * dy;
    if (d2 < bd){ bd = d2; best = i; }
  }
  return Math.sqrt(bd) <= 16 * G.kx ? best : -1;
}
function scqRing(svg, sel){
  var g = svg.querySelector('.scqs');
  if (!g) return;
  while (g.firstChild) g.removeChild(g.firstChild);
  var P = SCQ_PTS, G = scqGeo(svg);
  if (!P || !G || sel < 0) return;
  var p = scqXY(G, P.C[sel], P.B[sel]);
  var NS = 'http://www.w3.org/2000/svg';
  // 白圈描边 + 外圈灰：点云密的时候单环会跟邻居粘成一片
  [[10, 'none', '#fff', 3.2], [10, 'none', '#6b7280', 1.3]].forEach(function (a) {
    var c = svg.ownerDocument.createElementNS(NS, 'circle');
    c.setAttribute('cx', p[0].toFixed(1)); c.setAttribute('cy', p[1].toFixed(1));
    c.setAttribute('r', a[0]); c.setAttribute('fill', a[1]);
    c.setAttribute('stroke', a[2]); c.setAttribute('stroke-width', a[3]);
    g.appendChild(c);
  });
}
function scqShow(svg, sel){
  var P = SCQ_PTS;
  var card = svg.closest ? svg.closest('.scq') : null;
  if (!P || !card) return;
  var list = card.querySelectorAll('.scqplot svg'), i;
  for (i = 0; i < list.length; i++) scqRing(list[i], sel);
  var bar = card.querySelector('.scqtip');
  if (!bar) return;
  if (sel < 0){
    bar.className = 'scqtip'; bar.innerHTML = ''; card.removeAttribute('data-sel'); return;
  }
  var hi = P.I[sel], d = P.D[hi];
  var c = P.C[sel], b = P.B[sel], u = P.U[hi] || 0, w = P.W[hi] || 0;
  var nm = (P.T[sel] || []).map(function (k) { return P.IND[k] || ''; })
    .filter(function (x) { return !!x; });
  var cq = mktPct(P.RC, c), bq = mktPct(P.RB, b);
  var wd = '日一二三四五六'.charAt(new Date(d + 'T00:00:00+08:00').getUTCDay());
  // 跟今天比：单看「那天 15.5%」没有参照，加减量才读得出这次是不是更极端
  // 跟今天比用带符号的差值，不用「更集中／更分散」——两个词要配对读，
  // 而「集中度 +5.5pt」一眼就知道方向。
  var dc = P.CONC - c, db = P.BRD - b, dcs = [];
  if (Math.abs(dc) >= 0.5) dcs.push('集中度 ' + (dc > 0 ? '+' : '−') + Math.abs(dc).toFixed(1) + 'pt');
  if (Math.abs(db) >= 0.5) dcs.push('宽度 ' + (db > 0 ? '+' : '−') + Math.abs(db).toFixed(1) + 'pt');

  bar.innerHTML = '<b>' + d.slice(5) + '</b> 周' + wd
    + ' · 集中 <i>' + c.toFixed(1) + '%</i><em>（' + (cq != null ? cq.toFixed(0) + ' 分位' : '—') + '）</em>'
    + ' · 宽度 <i>' + b.toFixed(0) + '%</i><em>（' + u + ' 涨 ' + w + ' 跌'
    + (bq != null ? '，' + bq.toFixed(0) + ' 分位' : '') + '）</em>'
    + (nm.length ? '<br>领涨 <b>' + nm.join('、') + '</b>' : '')
    + (dcs.length ? ' <em>较今天 ' + dcs.join('、') + '</em>' : '')
    + ' <em class="esc">再点一次取消</em>';

  // 浮窗锚在被点的点上：坐标用 viewBox 百分比（两套画布同一容器，百分比通用），
  // 靠右翻到左边、靠下翻到上面，否则 390px 屏上会裁出去。
  var G = scqGeo(svg);
  if (G){
    var p = scqXY(G, c, b);
    var px = p[0] / G.vb.width * 100, py = p[1] / G.vb.height * 100;
    bar.style.left = px.toFixed(1) + '%';
    bar.style.top = py.toFixed(1) + '%';
    bar.className = 'scqtip on' + (px > 60 ? ' rx' : '') + (py > 52 ? ' ry' : '');
  } else bar.className = 'scqtip on';
  card.setAttribute('data-sel', sel);
}
document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t || !t.closest) return;
  var svg = t.closest('.scqplot svg');
  if (svg){
    var hit = scqHit(svg, e.clientX, e.clientY);
    var card = svg.closest('.scq');
    var cur = card.getAttribute('data-sel');
    scqShow(svg, (hit >= 0 && String(hit) === cur) ? -1 : hit);
    return;
  }
  if (!t.closest('.scq')){
    var o = document.querySelector('.scq[data-sel]');
    if (o){ var s0 = o.querySelector('.scqplot svg'); if (s0) scqShow(s0, -1); }
  }
});
document.addEventListener('mousemove', function (e) {
  var t = e.target;
  if (!t || !t.closest) return;
  var svg = t.closest('.scqplot svg');
  if (svg) svg.style.cursor = scqHit(svg, e.clientX, e.clientY) >= 0 ? 'pointer' : 'crosshair';
});

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
      LIVE_TS = Date.now();
      renderWatch();
      alertScan(out);
      trigScan(out);
      hRefresh();                    // 自选 5 秒一刷，弹窗里那只也一起动
      var tip = document.getElementById('quoteTip');
      if (tip) tip.textContent = '自选经浏览器直连腾讯 · ' + (isOpen()?'5 秒':'30 秒') + '刷新';
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

  /* 期指期权：盘中 60 秒，盘后 5 分钟。收盘后 16:00~17:00 这段单独加一把劲——
     中金所的会员持仓和结算价要等它发出来，而这时段的页面如果一直显示昨天的
     多空表，比不显示更容易误导。查到当天那份出现就自然停止（pos.d === td）。 */
  clearInterval(timerFut);
  timerFut = setInterval(function(){
    if (document.visibilityState === 'hidden') return;
    loadFut();
    loadFutOpt('main');
    if (!isOpen()){
      var bj = new Date(Date.now() + 8 * 3600e3);
      var hh = bj.getUTCHours();
      var td = bj.toISOString().slice(0, 10);
      if (hh >= 16 && hh < 17 && FUT && FUT.pos && FUT.pos.d !== td){
        FUTHIST = null;           // 强制重读，Actions 可能刚把新的 fut_daily.json 推上去
        loadFutHist();
      }
    }
  }, isOpen() ? 60000 : 300000);
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

/* ---------- 自选导入 / 导出 ----------
   上一版这里是「同步」：复制一条 /?u=编号 的链接，换台设备打开就变成这份自选。
   问题在于那条链接本身就是写权限——本来发给自己的链接，顺手转给别人、贴到群里，
   对方加一只删一只都会写进你的桶。为了搬一次家留一个永久后门，不划算。
   换成纯文本：谁拿到这串代码都只能自己粘，改不动你的。 */
/* ================= 隔夜映射卡 =================
   盘前 8:30 打开页面，第一个问题是「隔夜发生了什么」。这条链路把美股收盘和
   外盘期货按「赛道」折算到 A 股 ETF：

   - 美股/期货行情来自 /api/overnight（Worker 代理，边缘缓存 10 分钟）；
   - 赛道 → ETF 的映射用的是 IDX_GROUPS（跟踪指数名 → 全部跟踪该指数的 ETF），
     和「同指数去重」同一份数据。每个赛道列几个候选指数，从每个指数里挑出
     展示标的：自选优先 → 代表标的 → 成交额最大。映射写死具体代码会漂
     （ETF 会换名、发新的），写指数名永远是有效引用。
   - A 股 ETF 的当日涨跌直接取 DATA：开盘前显示的是昨收涨跌（页面会标
     「非交易时段」），盘中就是实时值。它回答「映射的这只现在什么价」，
     不回答「开盘会怎么开」——后者没有人知道。

   颜色统一用 A 股习惯：涨红跌绿，美股数据进来也一样，页面迁就读者的眼睛。 */
var ON = null;               // /api/overnight 的响应 {us, fut, ts}
var ON_SEL = null;           // 展开详情的赛道 key
var ON_FOLD = false;
try { ON_FOLD = localStorage.getItem('etf_onfold') === '1'; } catch(e){}

var ON_TRACKS = [
  { k:'chip',  n:'算力芯片',    us:['NVDA','AMD','AVGO','TSM','MRVL'],
    ix:['中证全指半导体产品与设备','国证半导体芯片','中证芯片产业','中华交易服务半导体芯片行业'] },
  { k:'equip', n:'芯片设备',    us:['AMAT','LRCX','KLAC','ASML'],
    ix:['中证半导体材料设备主题','上证科创板半导体材料设备主题','中证半导体产业'] },
  { k:'opt',   n:'光通信',      us:['ANET','COHR','CIEN','LITE','FN'],
    ix:['中证全指通信设备','中证5G通信主题','国证通信','中证通信设备主题'] },
  { k:'cloud', n:'云平台',      us:['MSFT','GOOG','AMZN','META','ORCL','SNOW'],
    ix:['中证计算机主题','中证云计算与大数据主题','中证全指软件','中证大数据产业'] },
  { k:'app',   n:'AI 应用',     us:['ADBE','CRM','NOW','PLTR','APP'],
    ix:['中证人工智能主题','中证人工智能产业','创业板人工智能','上证科创板人工智能'] },
  { k:'pow',   n:'电力能源',    us:['VST','CEG','TLN','NRG','GEV'],
    ix:['中证全指电力公用事业','国证绿色电力','中证绿色电力'] },
  { k:'hw',    n:'消费电子',    us:['AAPL','DELL','SMCI'],
    ix:['国证消费电子主题','中证消费电子主题','中证电子','中证电子50'] },
  { k:'bot',   n:'机器人/智驾', us:['TSLA','UBER'],
    ix:['中证机器人','国证机器人产业','中证智能汽车主题','中证智能电动汽车'] },
  { k:'hk',    n:'中概/港股科技', us:['BABA','JD','PDD','BIDU','NTES'],
    ix:['恒生科技','中证海外中国互联网50','中证海外中国互联网30','恒生互联网科技业'] },
  { k:'ph',    n:'全球创新药',  us:['LLY','MRK','AZN','NVO','PFE'],
    ix:['中证香港创新药','国证港股通创新药','中证港股通创新药','中证创新药产业','恒生创新药'] }
];
var ON_HEAD = ['NDX', 'INX', 'DJI'];     // 美股三大指数，摆在前排不当赛道
var ON_FUT_ORDER = ['hf_NQ', 'hf_CHA50CFD', 'hf_GC', 'hf_CL'];
/* 点条目看分时：东财 trends2 的 secid。美股三大指数在腾讯叫 usNDX/usINX/usDJI，
   到东财那边是另一套代码：标普 100.SPX、道指 100.DJIA（报价与腾讯逐个对得上），
   但纳指要的是 100.NDX100——100.NDX 是「纳斯达克综合」（24579），不是
   纳斯达克100（26990），两者差 10%，点「纳斯达克100」弹出综合指的走势，
   图上的涨跌幅也就跟着对不上卡片。 */
var ON_SECID = { NDX:'100.NDX100', INX:'100.SPX', DJI:'100.DJIA',
  'hf_NQ':'103.NQ00Y', 'hf_CHA50CFD':'104.CN00Y', 'hf_GC':'101.GC00Y', 'hf_CL':'102.CL00Y' };

function onCls(v){ return v > 0.05 ? 'up' : (v < -0.05 ? 'down' : ''); }
function onTxt(v){ return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

/** 可点分时的条目：名字 + 涨跌 + data-ovsid */
function ovChip(n, chg, sid){
  return '<span class="ovclk" data-ovsid="' + sid + '" data-ovnm="' + esc(n) + '" title="点看分时">'
    + esc(n) + ' <b class="' + onCls(chg) + '">' + onTxt(chg) + '</b></span>';
}

/* 分时弹窗：东财 trends2 最近一个完整时段。美股/期货拿到的是昨晚那场，
   亚太是今天。图上有两套纵轴：左边涨跌幅（0 轴＝昨收，虚线），右边价格。
   只标价格的话，「涨了 2.1%」在图上占多少、是急拉还是缓抬，全得自己心算。 */
function ovOpen(sid, nm){
  var mask = document.getElementById('ovMask');
  var body = document.getElementById('ovBody');
  document.getElementById('ovTitle').textContent = nm + ' 分时';
  document.getElementById('ovSub').textContent = sid;
  body.innerHTML = '<div class="iotip">读取中…</div>';
  mask.classList.add('on');
  fetch('/api/ovmin?sid=' + encodeURIComponent(sid)).then(function(r){ return r.json(); })
    .then(function(j){
      if (!j.ok) throw new Error(j.error || '无数据');
      body.innerHTML = ovChartSvg(j.pts, j.pre);
    })
    .catch(function(e){
      /* 上游偶发空回，给一个能点的重试（按钮带 data-ovsid，走的是同一个
         点击委托，等于把这次打开重做一遍） */
      body.innerHTML = '<div class="iotip">分时读取失败：' + esc(e.message || e) + '</div>'
        + '<button class="ovretry" data-ovsid="' + esc(sid) + '" data-ovnm="' + esc(nm) + '">重试</button>';
    });
}
function ovClose(){ document.getElementById('ovMask').classList.remove('on'); }
document.getElementById('ovClose').onclick = ovClose;
document.getElementById('ovMask').onclick = function(e){ if (e.target === this) ovClose(); };

function ovChartSvg(pts, pre){
  /* viewBox 宽度跟着窗口走。svg 是 width:100% 缩放的，固定 680 在手机上
     按 0.48 缩，10px 的字到屏上只剩 5px，纵轴加了也读不出来。让「画布宽
     ≈ 容器宽」，屏幕上是 1:1，写多大就是多大。 */
  var vw = Math.max(320, Math.min(720, (window.innerWidth || 900) - 76));
  var W = vw, H = vw < 480 ? 200 : 236;
  var ml = vw < 480 ? 50 : 56, mr = vw < 480 ? 56 : 62, mt = 12, mb = 20;
  var plotW = W - ml - mr, plotH = H - mt - mb;
  var step = Math.max(1, Math.ceil(pts.length / 240));
  var s = [], i;
  for (i = 0; i < pts.length; i += step) s.push(pts[i]);
  if (s[s.length - 1] !== pts[pts.length - 1]) s.push(pts[pts.length - 1]);

  var mn = s[0][1], mx = s[0][1];
  for (i = 1; i < s.length; i++){ if (s[i][1] < mn) mn = s[i][1]; if (s[i][1] > mx) mx = s[i][1]; }

  /* 基准：优先用上游昨收，和卡片上那个涨跌幅同源；拿不到才退回本时段开盘
     并在 meta 里说明。基准用开盘价的话，左轴那个「0.00%」不是涨跌，
     和卡片上的 +2.10% 对不起来，加了刻度反而更容易看错。 */
  var usePre = pre > 0;
  var base = usePre ? pre : s[0][1];
  if (mn > base) mn = base;          // 全程在基准一侧时，把 0 轴留在图内
  if (mx < base) mx = base;

  /* 上下各自取整到整档（0.1/0.2/0.5/1/2/5%），左轴才是 +1.25% 这种能读的数。
     不做上下对称：黄金那种单边行情，对称会让下半张图全是空白，线被压在上沿。
     两侧共用一个档位宽，刻度仍是同一套整数百分比，只是档数上下各算各的。 */
  var upPct = Math.max(0, (mx / base - 1) * 100);
  var dnPct = Math.max(0, (1 - mn / base) * 100);
  var spanPct = Math.max(upPct, dnPct) * 1.15;
  if (!(spanPct > 0)) spanPct = 0.2;
  var sp = spanPct > 8 ? 5 : spanPct > 4 ? 2 : spanPct > 2 ? 1
         : spanPct > 1 ? 0.5 : spanPct > 0.4 ? 0.2 : 0.1;
  var kUp = Math.max(1, Math.min(4, Math.ceil(upPct * 1.15 / sp)));
  var kDn = Math.max(1, Math.min(4, Math.ceil(dnPct * 1.15 / sp)));
  var hi = base * (1 + kUp * sp / 100), lo = base * (1 - kDn * sp / 100);

  var xOf = function(k){ return ml + k / (s.length - 1) * plotW; };
  var yOf = function(v){ return mt + (1 - (v - lo) / (hi - lo)) * plotH; };
  var fmt = function(v){ return v >= 1000 ? v.toFixed(0) : (v >= 10 ? v.toFixed(2) : v.toFixed(4)); };
  var last = s[s.length - 1][1];
  var up = last >= base;
  var col = up ? 'var(--up)' : 'var(--down)';
  var chg = (last / base - 1) * 100;
  var yLast = Math.max(mt + 8, Math.min(mt + plotH - 8, yOf(last)));

  var d = '';
  for (i = 0; i < s.length; i++) d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(s[i][1]).toFixed(1);
  var area = d + 'L' + xOf(s.length - 1).toFixed(1) + ' ' + (mt + plotH) + 'L' + ml + ' ' + (mt + plotH) + 'Z';

  /* 网格 + 左轴涨跌幅 + 右轴价格。右侧先占住「最新价」牌的位置，
     刻度标签和它挨得太近就跳过——宁可少标一行，也别糊成一团。 */
  var g = '', usedY = [yLast], j, q, clash;
  for (j = -kDn; j <= kUp; j++){
    var pv = base * (1 + j * sp / 100), yy = yOf(pv);
    if (j !== 0){
      g += '<line x1="' + ml + '" y1="' + yy.toFixed(1) + '" x2="' + (ml + plotW)
         + '" y2="' + yy.toFixed(1) + '" stroke="var(--line)" stroke-width="0.8"/>';
    }
    g += '<text x="' + (ml - 5) + '" y="' + (yy + 3.5).toFixed(1) + '" font-size="10"'
       + ' text-anchor="end" fill="' + (j > 0 ? 'var(--up)' : j < 0 ? 'var(--down)' : 'var(--txt3)')
       + '" opacity="0.9">' + (j > 0 ? '+' : '') + (j * sp).toFixed(2) + '%</text>';
    clash = false;
    for (q = 0; q < usedY.length; q++) if (Math.abs(usedY[q] - yy) < 11) clash = true;
    if (!clash){
      usedY.push(yy);
      g += '<text x="' + (ml + plotW + 5) + '" y="' + (yy + 3.5).toFixed(1) + '" font-size="9.5"'
         + ' fill="var(--txt3)">' + fmt(pv) + '</text>';
    }
  }

  var badgeW = 50;
  var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">'
    + g
    + '<line x1="' + ml + '" y1="' + yOf(base).toFixed(1) + '" x2="' + (ml + plotW)
    + '" y2="' + yOf(base).toFixed(1) + '" stroke="var(--txt3)" stroke-dasharray="3 3" stroke-width="0.9"/>'
    + '<path d="' + area + '" fill="' + col + '" opacity="0.08"/>'
    + '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.6"/>'
    + '<circle cx="' + xOf(s.length - 1).toFixed(1) + '" cy="' + yLast.toFixed(1) + '" r="2.6" fill="' + col + '"/>'
    + '<rect x="' + (ml + plotW + 2) + '" y="' + (yLast - 7.5).toFixed(1) + '" width="' + badgeW
    + '" height="15" rx="3" fill="' + col + '"/>'
    + '<text x="' + (ml + plotW + 2 + badgeW / 2) + '" y="' + (yLast + 3.6).toFixed(1)
    + '" font-size="10" font-weight="bold" fill="#fff" text-anchor="middle">' + fmt(last) + '</text>'
    + '<text x="' + ml + '" y="' + (H - 6) + '" font-size="10" fill="var(--txt3)">' + esc(s[0][0]) + '</text>'
    + '<text x="' + (ml + plotW) + '" y="' + (H - 6) + '" font-size="10" fill="var(--txt3)" text-anchor="end">'
    + esc(s[s.length - 1][0]) + '</text>'
    + '</svg>'
    + '<div class="ovmeta"><span>' + (usePre ? '较昨收 ' : '较本时段开盘 ')
    + '<b class="' + (up ? 'up' : 'down') + '">' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '%</b></span>'
    + '<span>基准（0 轴）＝' + (usePre ? '昨收 ' : '开盘 ') + fmt(base) + '</span>'
    + '<span>' + s.length + ' 个点 · ' + (s.length >= pts.length ? '' : '按 ' + step + ' 抽 1 显示') + '</span></div>';
  return h;
}

function loadOvernight(){
  fetch('/api/overnight').then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok) throw new Error(j.error || '无数据');
    ON = j;
    renderOvernight();
  }).catch(function(){ /* 隔夜卡拿不到就保持隐藏，不占位 */ });
}

/** 从一个跟踪指数里挑展示标的：自选优先，其次代表标的，最后成交额最大 */
function onPickIx(ixName){
  var codes = (typeof IDX_GROUPS !== 'undefined' && IDX_GROUPS[ixName]) || [];
  var best = null;
  for (var i=0;i<codes.length;i++){
    var it = findItem(codes[i]);
    if (!it || !isFinite(it.chg) || !(it.amt > 0)) continue;
    if (it.g === 'bond' || it.g === 'money') continue;
    var mine = watch.indexOf(codes[i]) >= 0;
    if (!best) best = { it:it, mine:mine, r:mine ? 3 : (isRep(it) ? 2 : 1) };
    else {
      var r = mine ? 3 : (isRep(it) ? 2 : 1);
      if (r > best.r || (r === best.r && it.amt > best.it.amt)) best = { it:it, mine:mine, r:r };
    }
  }
  return best;
}

/** 赛道 → 展示 ETF（跨指数去重，最多 3 只） */
function onEtfs(trk){
  var out = [], seen = {};
  for (var i=0;i<trk.ix.length && out.length<3;i++){
    var p = onPickIx(trk.ix[i]);
    if (p && !seen[p.it.c]){ seen[p.it.c] = 1; out.push({ c:p.it.c, n:p.it.n, chg:p.it.chg, mine:p.mine }); }
  }
  return out;
}

function onChgOf(trk){
  if (!ON || !ON.us) return null;
  var s = 0, n = 0;
  for (var i=0;i<trk.us.length;i++){
    var q = ON.us['us' + trk.us[i].toLowerCase()];
    if (q && isFinite(q.chg)){ s += q.chg; n++; }
  }
  return n ? s / n : null;
}

function renderOvernight(){
  var el = document.getElementById('onCard');
  if (!el) return;
  if (!ON || !ON.us){ el.style.display = 'none'; return; }

  // 美东日期取任意一条美股记录的（同一次响应里它们一致）
  var d = '';
  for (var k in ON.us){ d = (ON.us[k].d || '').slice(5, 10); break; }
  var h = '<div class="onhd"><b>隔夜</b>'
    + (d ? '<span class="n" id="onN">美东 ' + esc(d) + ' 收盘 · 点赛道看映射</span>'
         : '<span class="n" id="onN">点赛道看映射</span>')
    + '<span class="ofold" id="onFold">' + (ON_FOLD ? '展开' : '收起') + '</span></div>';

  var fut = '', i, q;
  for (i=0;i<ON_HEAD.length;i++){
    q = ON.us['us' + ON_HEAD[i].toLowerCase()];
    if (q) fut += ovChip(q.n, q.chg, ON_SECID[ON_HEAD[i]]);
  }
  if (ON.fut){
    for (i=0;i<ON_FUT_ORDER.length;i++){
      q = ON.fut[ON_FUT_ORDER[i]];
      if (q) fut += ovChip(q.n, q.chg, ON_SECID[ON_FUT_ORDER[i]]);
    }
  }
  h += '<div class="onfut">' + fut + '</div>';

  if (!ON_FOLD){
    h += '<div class="ontrks">';
    for (i=0;i<ON_TRACKS.length;i++){
      var t = ON_TRACKS[i], v = onChgOf(t);
      if (v == null) continue;
      h += '<span class="ontrk' + (ON_SEL === t.k ? ' sel' : '') + '" data-onk="' + t.k
        + '" title="' + esc(t.us.join(' · ')) + '（隔夜均涨跌）"><b>' + esc(t.n) + '</b>'
        + '<i class="' + onCls(v) + '">' + onTxt(v) + '</i></span>';
    }
    h += '</div>';
    var det = '';
    for (i=0;i<ON_TRACKS.length;i++){
      if (ON_SEL !== ON_TRACKS[i].k) continue;
      var t2 = ON_TRACKS[i];
      det += '<div class="ondet"><div class="ot">隔夜成分</div><div class="ous">';
      for (var j=0;j<t2.us.length;j++){
        var qq = ON.us['us' + t2.us[j].toLowerCase()];
        if (qq) det += '<span>' + esc(qq.n) + ' <b class="' + onCls(qq.chg) + '">' + onTxt(qq.chg) + '</b></span>';
      }
      det += '</div><div class="ot">映射到 A 股（自选优先' + (isOpen() ? '' : ' · 非交易时段显示昨收') + '）</div><div class="oetfs">';
      var ets = onEtfs(t2);
      if (!ets.length) det += '<span class="n" style="color:var(--txt3)">行情还没就绪，稍后自动补上</span>';
      for (j=0;j<ets.length;j++){
        var e2 = ets[j];
        det += '<span' + (e2.mine ? ' class="mine" title="在你的自选里"' : '')
          + '>' + esc(e2.n) + ' ' + e2.c
          + ' <b class="' + onCls(e2.chg) + '">' + onTxt(e2.chg) + '</b></span>';
      }
      det += '</div></div>';
    }
    h += det;
  }
  el.innerHTML = h;
  el.style.display = '';
  // 美股是最近一个完整交易日，期货/亚太是实时——统一按「这次抓取的时刻」标，
  // 别再让人猜这张卡是五分钟前还是半小时前的
  stampN('onN', ON.ts);

  // 亚太卡：独立一块，排在隔夜下面。今天已经在交易（或刚收盘）的市场，
  // 和隔夜（昨晚美股）正好互补；点条目看最近一个完整时段的分时。
  var ac = document.getElementById('asiaCard');
  if (!ac) return;
  if (ON.asia && ON.asia.length){
    var ap = '';
    for (i=0;i<ON.asia.length;i++){
      q = ON.asia[i];
      ap += ovChip(q.n, q.chg, q.sid);
    }
    ac.innerHTML = '<div class="onhd"><b>亚太</b><span class="n" id="asN">今日实时 · 点看分时</span></div>'
      + '<div class="onfut">' + ap + '</div>';
    ac.style.display = '';
    stampN('asN', ON.ts);
  } else {
    ac.style.display = 'none';
  }
}

document.addEventListener('click', function(e){
  var ov = e.target && e.target.closest ? e.target.closest('[data-ovsid]') : null;
  if (ov){
    ovOpen(ov.getAttribute('data-ovsid'), ov.getAttribute('data-ovnm') || ov.getAttribute('data-ovsid'));
    return;
  }
  var trk = e.target && e.target.closest ? e.target.closest('.ontrk') : null;
  if (trk){
    var k = trk.getAttribute('data-onk');
    ON_SEL = (ON_SEL === k) ? null : k;
    renderOvernight();
    return;
  }
  if (e.target && e.target.id === 'onFold'){
    ON_FOLD = !ON_FOLD;
    try { localStorage.setItem('etf_onfold', ON_FOLD ? '1' : '0'); } catch(err){}
    renderOvernight();
  }
});

/* ================= 自定义组合触发器 =================
   固定阈值提醒回答「它动得够不够大」，触发器回答「我等的那个组合条件到了没」。
   条件之间是且的关系，全部满足才算命中；边沿触发——从「不满足」翻成「满足」
   那一刻响一次，持续满足不重复（否则距新高 <1% 这种条件会一直挂着一直响），
   加 30 分钟冷却兜底条件的抖动。规则存 localStorage：它和自选清单不同，
   是「本机盯盘习惯」，不值得进云端。

   数据面零新增：涨跌/溢价/成交额来自 5 秒一刷的实时快照，位置/量能/距高距低
   复用位置诊断的 DIAG（历史已在手上，重算是纯浮点运算）。带 ⏳ 的字段在
   DIAG 就绪前一律判 false，不猜。 */
var TRIG = [];
var TRIG_ST = {};            // '规则序号|code' -> 上次是否满足
try {
  var _tj = JSON.parse(localStorage.getItem('etf_trig') || '[]');
  if (Array.isArray(_tj)) TRIG = _tj;
} catch(e){}

var TRIG_FIELDS = {
  chg: { n:'当日涨跌幅', u:'%', g:1, hint:'当天涨跌 %，正=涨' },
  pm:  { n:'溢价率',     u:'%', g:1, hint:'现价对 IOPV 的溢价 %，跨境 ETF 出事故的都是这个字段' },
  amt: { n:'成交额',     u:'亿', g:1, hint:'当日成交额（亿元）' },
  evr: { n:'量能倍数',   u:'×', g:0, hint:'今日量 ÷ 前 20 日均量（按交易进度折算），2 = 放了一倍量' },
  pos: { n:'一年位置',   u:'分位', g:0, hint:'现价在近一年高低区间的百分位，0=一年新低 100=一年新高' },
  dhi: { n:'距一年新高', u:'%', g:0, hint:'现价距一年最高价的 %，永远 ≤0；≥-1 就是「贴新高 1% 以内」' },
  dlo: { n:'距一年新低', u:'%', g:0, hint:'现价距一年最低价的 %，永远 ≥0；≥10 就是「离开低点至少 10%」' },
  pe:  { n:'路径效率',   u:'',  g:0, hint:'20 日净涨幅 ÷ 20 日路径长度，-1~1；>0.6 是单边拉，<0.2 是震荡堆' },
  r20: { n:'20日涨幅',   u:'%', g:0, hint:'相对 20 个交易日前的累计涨跌 %' }
};
var TRIG_F_ORDER = ['chg','pm','amt','dhi','dlo','pos','evr','pe','r20'];

function trigSave(){
  try { localStorage.setItem('etf_trig', JSON.stringify(TRIG)); } catch(e){}
}
function trigCount(){ var n=0; for (var i=0;i<TRIG.length;i++) if (TRIG[i].on && TRIG[i].cs && TRIG[i].cs.length) n++; return n; }
function renderTrigCount(){
  var b = document.getElementById('btnTrig');
  if (b) b.textContent = '触发器 ' + trigCount();
}
function trigCondTxt(cd){
  var f = TRIG_FIELDS[cd[0]] || { n:'?', u:'' };
  return f.n + (cd[1] === '>=' ? ' ≥ ' : ' ≤ ') + cd[2] + f.u;
}

function trigScan(items){
  if (!ALERT.on || !TRIG.length || !isOpen()) return;
  for (var i=0;i<TRIG.length;i++){
    var r = TRIG[i];
    if (!r.on || !r.cs || !r.cs.length) continue;
    for (var c in items){
      var x = items[c];
      if (!x || !isFinite(x.chg)) continue;
      var d = DIAG[c], ok = true, parts = [];
      for (var j=0;j<r.cs.length;j++){
        var cd = r.cs[j], f = TRIG_FIELDS[cd[0]];
        if (!f){ ok = false; break; }
        var v = null;
        if (f.g === 1){
          if (cd[0] === 'chg') v = x.chg;
          else if (cd[0] === 'pm') v = x.pm;
          else if (cd[0] === 'amt') v = x.amt != null ? x.amt / 1e8 : null;
        } else if (d && d.ok){
          if (cd[0] === 'evr') v = d.evr;
          else if (cd[0] === 'pos') v = d.pos;
          else if (cd[0] === 'dhi') v = d.dHi != null ? d.dHi * 100 : null;
          else if (cd[0] === 'dlo') v = d.dLo != null ? d.dLo * 100 : null;
          else if (cd[0] === 'pe') v = d.pe;
          else if (cd[0] === 'r20') v = d.r20 != null ? d.r20 * 100 : null;
        }
        if (v == null || !isFinite(v)){ ok = false; break; }   // 数据没到位不猜
        if (cd[1] === '>=' ? !(v >= cd[2]) : !(v <= cd[2])){ ok = false; break; }
        parts.push(f.n + ' ' + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) + f.u);
      }
      var key = i + '|' + c;
      if (!ok){ TRIG_ST[key] = 0; continue; }
      if (TRIG_ST[key]) continue;                 // 持续满足只算一次
      TRIG_ST[key] = 1;
      if (!alertCool('trig|' + key, 30)) continue;
      alertPush(x.n + ' 命中触发器', '条件全满足：' + parts.join(' · '), 'up', 'trig|' + key);
    }
  }
}

function trigRender(){
  var box = document.getElementById('trigList');
  if (!box) return;
  if (!TRIG.length){
    box.innerHTML = '<div class="iotip">还没有规则。点「+ 新建规则」拼一组条件，'
      + '比如：距一年新高 ≥ -1 且 量能倍数 ≥ 2 —— 一贴新高就放量，典型的高位换手信号。</div>';
    renderTrigCount();
    return;
  }
  var h = '';
  for (var i=0;i<TRIG.length;i++){
    var r = TRIG[i];
    h += '<div class="trigrule' + (r.on ? '' : ' off') + '" data-ti="' + i + '">'
      + '<div class="trow"><span class="tname">规则 ' + (i+1) + '</span>'
      + '<label style="font-size:11.5px;cursor:pointer"><input type="checkbox" data-ton="' + i + '"'
      + (r.on ? ' checked' : '') + '> 启用</label>'
      + '<span class="tdel" data-tdel="' + i + '" title="删除这条规则">删除</span></div>';
    if (!r.cs || !r.cs.length) r.cs = [];
    for (var j=0;j<r.cs.length;j++){
      h += '<div class="trow">'
        + (j ? '<span class="tand">且</span>' : '<span class="tand" style="visibility:hidden">且</span>')
        + '<select data-tf="' + i + ',' + j + '">';
      for (var q=0;q<TRIG_F_ORDER.length;q++){
        var fk = TRIG_F_ORDER[q], f = TRIG_FIELDS[fk];
        h += '<option value="' + fk + '"' + (r.cs[j][0] === fk ? ' selected' : '') + '>'
          + f.n + (f.g ? '' : ' ⏳') + '</option>';
      }
      h += '</select><select data-top="' + i + ',' + j + '">'
        + '<option value=">="' + (r.cs[j][1] === '>=' ? ' selected' : '') + '>≥</option>'
        + '<option value="<="' + (r.cs[j][1] === '<=' ? ' selected' : '') + '>≤</option>'
        + '</select><input type="text" data-tv="' + i + ',' + j + '" value="' + esc(String(r.cs[j][2])) + '">'
        + '<span class="tcdel" data-tcdel="' + i + ',' + j + '" title="删掉这个条件">×</span></div>';
    }
    h += '<div class="trow"><span class="tadd" data-tadd="' + i + '">+ 加条件</span></div>'
      + '<div class="trigcnt">' + (r.cs.length ? r.cs.map(trigCondTxt).join(' 且 ') : '（空规则，不会触发）')
      + '</div></div>';
  }
  box.innerHTML = h;
  renderTrigCount();
}

function trigOpen(){
  trigRender();
  document.getElementById('trigMsg').textContent = '';
  document.getElementById('trigMask').classList.add('on');
}
function trigClose(){ document.getElementById('trigMask').classList.remove('on'); }

document.getElementById('btnTrig').onclick = trigOpen;
document.getElementById('trigClose').onclick = trigClose;
document.getElementById('trigMask').onclick = function(e){ if (e.target === this) trigClose(); };
document.getElementById('trigAdd').onclick = function(){
  TRIG.push({ on:true, cs:[['chg','>=',2]] });
  trigSave(); trigRender();
  document.getElementById('trigMsg').textContent = '已新建，记得把条件改成你要的';
};
document.getElementById('trigList').addEventListener('click', function(e){
  var t = e.target;
  if (!t.getAttribute) return;
  var ti, cj;
  if (t.getAttribute('data-tadd') != null){
    ti = +t.getAttribute('data-tadd');
    TRIG[ti].cs.push(['chg','>=',2]); trigSave(); trigRender();
  } else if (t.getAttribute('data-tcdel') != null){
    cj = t.getAttribute('data-tcdel').split(',');
    TRIG[+cj[0]].cs.splice(+cj[1], 1); trigSave(); trigRender();
  } else if (t.getAttribute('data-tdel') != null){
    ti = +t.getAttribute('data-tdel');
    TRIG.splice(ti, 1); TRIG_ST = {}; trigSave(); trigRender();
  }
});
document.getElementById('trigList').addEventListener('change', function(e){
  var t = e.target, v;
  if (t.getAttribute('data-ton') != null){
    TRIG[+t.getAttribute('data-ton')].on = t.checked; trigSave(); trigRender();
  } else if (t.getAttribute('data-tf') != null){
    v = t.getAttribute('data-tf').split(',');
    TRIG[+v[0]].cs[+v[1]][0] = t.value; trigSave(); trigRender();
  } else if (t.getAttribute('data-top') != null){
    v = t.getAttribute('data-top').split(',');
    TRIG[+v[0]].cs[+v[1]][1] = t.value; trigSave(); trigRender();
  } else if (t.getAttribute('data-tv') != null){
    v = t.getAttribute('data-tv').split(',');
    var nv = parseFloat(t.value);
    if (!isFinite(nv)){ document.getElementById('trigMsg').textContent = '数值要写数字'; trigRender(); return; }
    TRIG[+v[0]].cs[+v[1]][2] = nv; trigSave(); trigRender();
  }
});

function ioOpen(){
  var t = document.getElementById('ioTxt');
  t.value = watch.join(',');
  document.getElementById('ioMsg').textContent = '当前 ' + watch.length + ' 只';
  document.getElementById('ioMask').classList.add('on');
  setTimeout(function(){ t.focus(); t.select(); }, 30);
}
function ioClose(){ document.getElementById('ioMask').classList.remove('on'); }

document.getElementById('btnIO').onclick = ioOpen;
document.getElementById('ioClose').onclick = ioClose;
document.getElementById('ioMask').onclick = function(e){ if (e.target === this) ioClose(); };

document.getElementById('ioCopy').onclick = function(){
  var t = document.getElementById('ioTxt'), txt = t.value.trim();
  var msg = document.getElementById('ioMsg');
  if (!txt){ msg.textContent = '清单是空的'; return; }
  function done(){ msg.textContent = '已复制 ' + watch.length + ' 只'; toast('清单已复制'); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(function(){
      t.select();
      try{ document.execCommand('copy'); done(); }
      catch(e){ msg.textContent = '复制失败，请手动选中'; }
    });
  } else {
    t.select();
    try{ document.execCommand('copy'); done(); }
    catch(e){ msg.textContent = '复制失败，请手动选中'; }
  }
};

document.getElementById('ioImport').onclick = function(){
  var raw = document.getElementById('ioTxt').value || '';
  var msg = document.getElementById('ioMsg');
  // 只认 5~6 位数字，逗号、空格、换行、代码前缀、名称里的其他字都当分隔符
  var codes = raw.match(/\\d{6}|\\d{5}/g) || [];
  var seen = {}, add = [], dup = 0, bad = [];
  for (var i=0;i<codes.length;i++){
    var c = codes[i];
    if (seen[c]) continue;
    seen[c] = 1;
    if (watch.indexOf(c) >= 0){ dup++; continue; }
    // DATA 还没到就别校验——否则整份清单会被判成「不在全市场」
    if (DATA.length && !findItem(c)){ bad.push(c); continue; }
    add.push(c);
  }
  if (!add.length){
    var why = [];
    if (dup) why.push(dup + ' 只已在自选');
    if (bad.length) why.push(bad.length + ' 只不在全市场');
    msg.textContent = why.length ? '没有可导入的：' + why.join('，') : '没识别到代码';
    return;
  }
  watch = watch.concat(add);
  saveWatch(); renderWatch(); loadTXQuotes();
  var out = '新增 ' + add.length + ' 只';
  if (dup) out += '，跳过重复 ' + dup;
  if (bad.length) out += '，未收录 ' + bad.length;
  msg.textContent = out;
  toast(out);
};

document.body.addEventListener('click', function(e){
  // 组头折叠：只切 class，不重绘——重绘会把滚动位置弹回去
  var fg = e.target.closest('[data-fold]');
  if (fg){
    var fcode = fg.getAttribute('data-fold');
    var st = secFoldState();
    st[fcode] = !st[fcode];
    saveSecFold();
    var grpEl = document.querySelector('.sgrp[data-g="' + fcode + '"]');
    if (grpEl) grpEl.className = 'sgrp' + (st[fcode] ? ' fold' : '');
    return;
  }
  var sc = e.target.closest('[data-sec]');
  if (sc){
    var sk = sc.getAttribute('data-sec');
    SEC_OPEN = (SEC_OPEN === sk) ? null : sk;
    renderSectors();
    return;
  }
  var sr = e.target.closest('.sdet .sr[data-code]');
  if (sr){
    var scd = sr.getAttribute('data-code');
    openHist(scd, (findItem(scd) || {}).n || scd);
    return;
  }
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
    // 名称外面包了一层 .nmx（窄屏截断用），所以不能再直接取 firstChild 文本节点
    var nmSpan = nmEl && nmEl.querySelector('.nmx');
    var nm = nmSpan ? nmSpan.textContent
      : (nmEl && nmEl.firstChild && nmEl.firstChild.nodeType === 3) ? nmEl.firstChild.nodeValue : '';
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
(function(){
  var b = document.getElementById('btnSec');
  if (b) b.onclick = function(){ SEC_CACHE = {}; renderSectors(); toast('已按最新快照重算板块'); };
})();
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

/* ---------- 期指期权 ----------
   三块数据各走各的接口，互不阻塞：
     /api/fut      中金所实时（期货 + 股指期权 + 现货）+ 收盘日档里的会员持仓
     /api/futopt   东财 ETF 期权链，main / rest 两批
     /api/futhist  Actions 生成的 250 天基线
   任何一块挂了只影响自己那张卡，整块不消失——这是这个页面一贯的处理方式。 */
var FUT = null, FUTOPT = {}, FUTHIST = null;
var FUT_BUSY = false, FUT_OPT_BUSY = false;
var FUT_TAB = 'live', FUT_HP = 'IF', FUT_HM = 'cmp';
/* 基差历史的 ETF 期权组。历史上限受数据源限制（见 pipeline/gen_fut_daily.mjs 注释）：
   已到期合约没有可回查的行情，只能从上线那天起一天记一条，所以这组的曲线会短很多。 */
var ETF_HP = ['510050', '510300', '159919', '588000'];
var ETF_HP_NAME = { '510050': '50ETF', '510300': '300ETF', '159919': '300ETF深', '588000': '科创50' };

function fNum(v, d){
  if (v == null || v === '' || !isFinite(v)) return '—';
  return (+v).toFixed(d);
}
function fPct(v, d){
  if (v == null || v === '' || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + (+v).toFixed(d) + '%';
}
function fSign(v){ return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function fInt(v){
  if (v == null || v === '' || !isFinite(v)) return '—';
  var n = Math.round(v), neg = n < 0, s = String(Math.abs(n)), out = '';
  for (var i = 0; i < s.length; i++){
    if (i && (s.length - i) % 3 === 0) out += ',';
    out += s.charAt(i);
  }
  return (neg ? '-' : '') + out;
}
// 持仓量变化推出来的四种状态。名字已经说明它是推断：中金所的持仓量是双边合计，
// 看不出是哪个方向在开、哪个在平，只能从「仓增还是仓减」+「价涨还是价跌」倒推。
var FQ = {
  'up-open':  ['增仓上涨', '#c62f34'],
  'dn-open':  ['增仓下跌', '#0b7d55'],
  'up-close': ['减仓上涨', '#a9660a'],
  'dn-close': ['减仓下跌', '#2563eb'],
  'flat':     ['持仓持平', '#8b95a5'],
};

function futStatus(){
  if (!FUT) return '';
  if (FUT.stale || FUT.src === 'daily') return '降级 · 收盘值 ' + String(FUT.td || '').slice(5);
  return isOpen() ? '盘中' : '收盘 ' + String(FUT.td || '').slice(5);
}

function futFail(msg){
  var box = document.getElementById('futBasis');
  if (box){
    box.innerHTML = '<div class="lerr"><b>期指行情没读上来</b><span>' + esc(msg || '') + '</span>'
      + '<button id="futRetry">立即重试</button></div>';
    var b = document.getElementById('futRetry');
    if (b) b.onclick = function(){ loadFut(); loadFutOpt('main'); };
  }
  var n = document.getElementById('futN');
  if (n) n.textContent = '';
}

function loadFut(){
  if (FUT_BUSY) return;
  FUT_BUSY = true;
  fetch('/api/fut').then(function(r){ return r.json(); }).then(function(j){
    FUT_BUSY = false;
    if (!j || !j.ok){ futFail((j && j.error) || '返回为空'); return; }
    FUT = j;
    renderFutAll();
  }).catch(function(e){
    FUT_BUSY = false;
    futFail(e && e.message || String(e));
  });
}

function loadFutOpt(g){
  if (FUT_OPT_BUSY) return;
  FUT_OPT_BUSY = true;
  var want = g || 'main';
  fetch('/api/futopt?g=' + want).then(function(r){ return r.json(); }).then(function(j){
    FUT_OPT_BUSY = false;
    if (j && j.ok){ FUTOPT[want] = j; }
    renderFutOptEtf();
    // 主标的先回来先看，冷的四个紧接着补——分成两批就是为了这个
    if (want === 'main' && !FUTOPT.rest) loadFutOpt('rest');
  }).catch(function(){
    FUT_OPT_BUSY = false;
    renderFutOptEtf();
  });
}

function renderFutAll(){
  // 昨收持仓还没生成时，「盘中推断」必然空着——直接落到收盘结算，别让人看到一片空白
  var anyOi = false;
  for (var i = 0; i < (FUT.fut || []).length; i++) if (FUT.fut[i].oiD != null){ anyOi = true; break; }
  if (!anyOi && FUT.pos && FUT_TAB === 'live') FUT_TAB = 'settle';

  renderFutBasis();
  renderFutOptIdx();
  renderFutPos();
  var n = document.getElementById('futN');
  if (n){
    var bad = (FUT.partial || []).length;
    n.textContent = futStatus() + (bad ? ' · 缺 ' + (FUT.partial || []).join('/') : '');
    n.className = 'n' + (FUT.stale ? ' warn' : '');
  }
  stampN('futN', FUT.asof || FUT.ts);
}

function renderFutBasis(){
  var box = document.getElementById('futBasis');
  if (!box) return;
  var list = FUT.fut || [];
  if (!list.length){ box.innerHTML = '<div class="empty">没有合约数据</div>'; return; }

  var order = ['IF', 'IH', 'IC', 'IM'], byP = {};
  for (var i = 0; i < list.length; i++){
    var x = list[i];
    (byP[x.p] = byP[x.p] || []).push(x);
  }
  // 昨收持仓还没生成时（收盘日档还没跑），这一列只会是一排「—」，不如整列撤掉
  var hasOi = false;
  for (var z = 0; z < list.length; z++) if (list[z].oiD != null){ hasOi = true; break; }

  var h = '<table><thead><tr><th class="l">合约</th><th>价格</th><th>涨跌</th>'
    + '<th title="期货 − 现货，点数。负数=贴水">基差</th>'
    + '<th title="基差 ÷ 现货 × 100%">基差率</th>'
    + '<th class="hide-sm" title="基差率 × 365 ÷ 剩余自然日">年化</th>'
    + (hasOi ? '<th class="hide-sm" title="持仓量双边合计的当日变化，只能推断谁在动">持仓变化</th>' : '')
    + '</tr></thead><tbody>';

  for (var k = 0; k < order.length; k++){
    var p = order[k], rows = byP[p];
    if (!rows || !rows.length) continue;
    var sp = (FUT.spot || {})[rows[0].u];
    // 分组行整行只放一个格子，内部 flex 分开左右。
    // 之前拆成「colspan=4 + colspan=span-4」两格，右侧现货点位那串宽度会被摊到
    // 最后一列上（手机断点下基差率列被撑到 101px），表比容器宽 18px、最后一列被切掉；
    // 一格跨完所有列（99 会被浏览器按实际列数收拢），列宽就只由数据行决定。
    h += '<tr class="futgrp"><td colspan="99" class="l"><div class="futgh"><span>' + p
      + (sp ? ' · ' + esc(sp.n || '') : '') + '</span><span>'
      + (sp ? fNum(sp.p, 2) + ' <b class="' + fSign(sp.chg) + '">' + fPct(sp.chg, 2) + '</b>' : '现货缺失')
      + '</span></div></td></tr>';

    for (var j = 0; j < rows.length; j++){
      var r = rows[j];
      var q = FQ[r.q] || null;
      h += '<tr>'
        + '<td class="l"><span class="nm">' + r.c + '</span>'
        + '<span class="code">剩 ' + r.dte + ' 天</span></td>'
        + '<td>' + fNum(r.px, 2) + '</td>'
        + '<td class="' + fSign(r.chg) + '">' + fPct(r.chg, 2) + '</td>'
        + '<td class="' + fSign(r.basis) + '">' + fNum(r.basis, 2) + '</td>'
        + '<td class="' + fSign(r.bp) + '">' + fPct(r.bp, 3) + '</td>'
        + '<td class="hide-sm ' + fSign(r.ann) + '">' + fPct(r.ann, 2) + '</td>'
        + (hasOi ? '<td class="hide-sm">' + (r.oiD == null
            ? '<span class="code">—</span>'
            : '<span class="' + fSign(r.oiD) + '">' + (r.oiD > 0 ? '+' : '') + fInt(r.oiD) + '</span>'
              // 持仓没动就别挂徽章：16 行全写「持仓持平」比一排 0 还吵
              + (q && r.q !== 'flat' ? ' <span class="fq" style="color:' + q[1] + '">' + q[0] + '</span>' : ''))
          + '</td>' : '')
        + '</tr>';
    }
  }
  h += '</tbody></table>';
  box.innerHTML = h;
}

function renderFutOptIdx(){
  var box = document.getElementById('futOptIdx');
  if (!box) return;
  var list = FUT.opt || [];
  if (!list.length){ box.innerHTML = '<div class="empty">期权链没读到</div>'; return; }

  var h = '<table><thead><tr><th class="l">合约</th><th>合成期货</th>'
    + '<th title="合成期货 − 现货">基差率</th>'
    + '<th class="hide-sm">年化</th>'
    + '<th title="合成期货 − 同月期货。两个市场各算一遍，差得多就是套利空间">与期货差</th>'
    + '<th class="hide-sm" title="认沽成交量 ÷ 认购成交量">PCR</th>'
    + '</tr></thead><tbody>';
  var order = ['IO', 'HO', 'MO'], byP = {};
  for (var i = 0; i < list.length; i++) (byP[list[i].p] = byP[list[i].p] || []).push(list[i]);
  for (var k = 0; k < order.length; k++){
    var p = order[k], rows = byP[p];
    if (!rows || !rows.length) continue;
    h += '<tr class="futgrp"><td class="l" colspan="6">' + p + ' · ' + esc(rows[0].u === '000300' ? '沪深300' : rows[0].u === '000016' ? '上证50' : '中证1000') + '</td></tr>';
    for (var j = 0; j < rows.length; j++){
      var r = rows[j];
      h += '<tr>'
        + '<td class="l"><span class="nm">' + r.m + '</span><span class="code">剩 ' + r.dte + ' 天</span></td>'
        + '<td>' + fNum(r.syn, 2) + '</td>'
        + '<td class="' + fSign(r.bp) + '">' + fPct(r.bp, 3) + '</td>'
        + '<td class="hide-sm ' + fSign(r.ann) + '">' + fPct(r.ann, 2) + '</td>'
        + '<td class="' + fSign(r.fb) + '">' + (r.fb == null ? '—' : (r.fb > 0 ? '+' : '') + fNum(r.fb, 2)) + '</td>'
        + '<td class="hide-sm">' + fNum(r.pcr, 2) + '</td></tr>';
    }
  }
  h += '</tbody></table>';
  box.innerHTML = h;
}

function renderFutOptEtf(){
  var box = document.getElementById('futOptEtf');
  if (!box) return;
  var main = (FUTOPT.main && FUTOPT.main.items) || [];
  var rest = (FUTOPT.rest && FUTOPT.rest.items) || [];
  var all = main.concat(rest);
  if (!all.length){
    // 还没回来 ≠ 回来了但是空的。后者要说明原因，不然会一直转圈
    var loaded = !!FUTOPT.main || !!FUTOPT.rest;
    if (!loaded){
      box.innerHTML = '<div class="lskel"><i></i><i></i><i></i><span>读取中…</span></div>';
      return;
    }
    var none = (FUTOPT.main && FUTOPT.main.mode === 'none') || (FUTOPT.rest && FUTOPT.rest.mode === 'none');
    box.innerHTML = '<div class="empty">' + (none
      ? '期权链或标的现价暂时取不到，合成基差先不显示（下一轮自动重试）'
      : '没有可用的期权链') + '</div>';
    return;
  }
  var h = '<table><thead><tr><th class="l">标的</th><th>现价</th>'
    + '<th title="最近到期那一档的合成期货基差率">近月</th>'
    + '<th class="hide-sm">年化</th>'
    + '<th class="hide-sm" title="第二个到期月">次月</th>'
    + '<th class="hide-sm" title="认沽 ÷ 认购 成交量">PCR</th>'
    + '</tr></thead><tbody>';
  for (var i = 0; i < all.length; i++){
    var it = all[i], ms = it.months || [];
    var m0 = ms[0] || {}, m1 = ms[1] || {};
    h += '<tr>'
      + '<td class="l"><span class="nm">' + esc(it.n) + '</span><span class="code">' + it.c + '</span></td>'
      + '<td>' + fNum(it.S, 3) + '</td>'
      + '<td class="' + fSign(m0.bp) + '">' + fPct(m0.bp, 3) + '</td>'
      + '<td class="hide-sm ' + fSign(m0.ann) + '">' + fPct(m0.ann, 2) + '</td>'
      + '<td class="hide-sm ' + fSign(m1.bp) + '">' + fPct(m1.bp, 3) + '</td>'
      + '<td class="hide-sm">' + fNum(m0.pcr, 2) + '</td></tr>';
  }
  h += '</tbody></table>';
  if (rest.length < 4) h += '<div class="futfoot">另外 ' + (4 - rest.length) + ' 个标的还在读…</div>';
  // 东财对海外出口的期权链接口只回昨收（最新价全是「-」），这时整块按昨收算，
  // 现价那一列也是昨收——不说明的话会被当成盘中实时数字
  var onPrev = (FUTOPT.main && FUTOPT.main.mode === 'prev')
    || (FUTOPT.rest && FUTOPT.rest.mode === 'prev');
  var td = (FUTOPT.main && FUTOPT.main.td) || (FUTOPT.rest && FUTOPT.rest.td) || '';
  if (onPrev) {
    h += '<div class="futfoot">拿不到期权最新价，本表用的是东财的<b>滞后收盘价</b>（比最新交易日再早一天，现价列同理），只能看个大概；有最新价时自动切回实时</div>';
  } else if (td) {
    // 新浪给的是「最新一笔成交价」：盘中就是实时，盘前/收盘后就是那个交易日的收盘。
    // 标出来免得把上周五的收盘当成今天盘中的数
    h += '<div class="futfoot">行情日期 ' + td + ' 收盘（新浪期权快照），盘中自动跟随</div>';
  }
  box.innerHTML = h;
}

function renderFutPos(){
  var box = document.getElementById('futPos');
  if (!box) return;
  var sub = document.getElementById('futPosSub');
  var tabs = document.querySelectorAll('#futPosTabs .mtab');
  for (var t = 0; t < tabs.length; t++) tabs[t].classList.toggle('on', tabs[t].getAttribute('data-p') === FUT_TAB);

  if (FUT_TAB === 'live'){
    var list = (FUT.fut || []).filter(function(x){ return x.oiD != null; });
    if (!sub) ;
    if (sub) sub.textContent = '持仓量双边合计 → 只能推断，不是交易所多空';
    if (!list.length){
      box.innerHTML = '<div class="empty">今天还没有昨收持仓可比<br><span class="code">收盘日档生成后，下一次开盘就有四象限了</span></div>';
      return;
    }
    var cnt = { 'up-open': [], 'dn-open': [], 'up-close': [], 'dn-close': [], 'flat': [] };
    for (var i = 0; i < list.length; i++) (cnt[list[i].q] = cnt[list[i].q] || []).push(list[i]);
    var cells = [['up-open', '增仓 · 价涨'], ['dn-open', '增仓 · 价跌'], ['up-close', '减仓 · 价涨'], ['dn-close', '减仓 · 价跌']];
    var h = '<div class="quad">';
    for (var k = 0; k < cells.length; k++){
      var key = cells[k][0], arr = cnt[key] || [];
      h += '<div class="qcell"><b>' + cells[k][1] + '</b>'
        + '<u style="color:' + FQ[key][1] + '">' + arr.length + ' 个合约</u>'
        + '<i>' + (arr.length ? arr.slice(0, 4).map(function(x){ return x.c; }).join(' ') : '—') + '</i></div>';
    }
    h += '</div>';
    var flat = (cnt.flat || []).length;
    h += '<div class="futfoot">共 ' + list.length + ' 个合约有昨日持仓可比，其中 ' + flat + ' 个变化不足阈值（按昨仓 0.2%、最少 50 手）。</div>';
    box.innerHTML = h;
    return;
  }

  var pos = FUT.pos;
  if (!pos || !pos.rows || !pos.rows.length){
    if (sub) sub.textContent = '前 20 会员';
    box.innerHTML = '<div class="empty">收盘结算还没出来<br><span class="code">中金所每天收盘后发布前 20 会员持仓，约 16:00 前后</span></div>';
    return;
  }
  if (sub) sub.textContent = '前 20 会员 · ' + String(pos.d || '').slice(5) + ' 收盘';
  var h2 = '<table><thead><tr><th class="l">合约</th><th>多单</th><th class="hide-sm">增减</th>'
    + '<th>空单</th><th class="hide-sm">增减</th><th title="空单 − 多单，正数=净空">净空</th>'
    + '<th class="hide-sm">净空变化</th></tr></thead><tbody>';
  var ord = ['IF', 'IH', 'IC', 'IM'];
  var rows = pos.rows.slice().sort(function(a, b){
    var ia = ord.indexOf(a.p), ib = ord.indexOf(b.p);
    if (ia !== ib) return ia - ib;
    return a.c < b.c ? -1 : 1;
  });
  for (var j = 0; j < rows.length; j++){
    var r = rows[j];
    h2 += '<tr>'
      + '<td class="l"><span class="nm">' + r.c + '</span></td>'
      + '<td>' + fInt(r.lv) + '</td>'
      + '<td class="hide-sm ' + fSign(r.lvD) + '">' + (r.lvD > 0 ? '+' : '') + fInt(r.lvD) + '</td>'
      + '<td>' + fInt(r.sv) + '</td>'
      + '<td class="hide-sm ' + fSign(r.svD) + '">' + (r.svD > 0 ? '+' : '') + fInt(r.svD) + '</td>'
      + '<td class="' + fSign(r.netS) + '">' + (r.netS > 0 ? '+' : '') + fInt(r.netS) + '</td>'
      + '<td class="hide-sm ' + fSign(r.netSD) + '">' + (r.netSD > 0 ? '+' : '') + fInt(r.netSD) + '</td></tr>';
  }
  h2 += '</tbody></table>';
  box.innerHTML = h2;
}

function loadFutHist(){
  if (FUTHIST) { renderFutHist(); return; }
  fetch('/api/futhist').then(function(r){ return r.json(); }).then(function(j){
    FUTHIST = j || { ok: false };
    renderFutHist();
  }).catch(function(e){
    FUTHIST = { ok: false, error: e && e.message };
    renderFutHist();
  });
}

function fQuant(sorted, q){
  if (!sorted.length) return null;
  var i = (sorted.length - 1) * q;
  var lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function renderFutHist(){
  var box = document.getElementById('futHistChart');
  var tabs = document.getElementById('futHistTabs');
  if (!box || !tabs) return;

  // 品种 tab + 口径 tab 只建一次，之后只切 class
  if (!tabs.getAttribute('data-built')){
    var prods = ['IF', 'IH', 'IC', 'IM', 'IO', 'HO', 'MO'];
    var s = '';
    for (var i = 0; i < prods.length; i++){
      s += '<span class="mtab' + (prods[i] === FUT_HP ? ' on' : '') + '" data-h="' + prods[i] + '">' + prods[i] + '</span>';
    }
    // ETF 期权单独一组：它们的历史只有上线之后那几天，和股指那七个不是一回事。
    // mbrk 是个只占位不显示的断行符，窄屏把三组拆成三行，否则标签会挤成随机三行
    s += '<span class="mbrk"></span>';
    for (var e = 0; e < ETF_HP.length; e++){
      s += '<span class="mtab' + (e === 0 ? ' grp' : '') + (ETF_HP[e] === FUT_HP ? ' on' : '')
        + '" data-h="' + ETF_HP[e] + '">' + (ETF_HP_NAME[ETF_HP[e]] || ETF_HP[e]) + '</span>';
    }
    s += '<span class="mbrk"></span>'
      + '<span class="mtab grp' + (FUT_HM === 'cmp' ? ' on' : '') + '" data-m="cmp">30 天恒定</span>'
      + '<span class="mtab' + (FUT_HM === 'bp' ? ' on' : '') + '" data-m="bp">主力近月</span>';
    tabs.innerHTML = s;
    tabs.setAttribute('data-built', '1');
  }
  var ks = tabs.getElementsByTagName('span');
  for (var k = 0; k < ks.length; k++){
    if (ks[k].getAttribute('data-h')) ks[k].classList.toggle('on', ks[k].getAttribute('data-h') === FUT_HP);
    if (ks[k].getAttribute('data-m')) ks[k].classList.toggle('on', ks[k].getAttribute('data-m') === FUT_HM);
  }

  if (!FUTHIST){ box.innerHTML = '<div class="lskel"><i></i><i></i><i></i><span>读取中…</span></div>'; return; }
  if (!FUTHIST.ok || !FUTHIST.d || FUTHIST.d.length < 10){
    box.innerHTML = '<div class="empty">历史基线还没生成<br><span class="code">' +
      esc((FUTHIST && (FUTHIST.error || FUTHIST.msg)) || 'fut_daily.json 不存在') + '</span></div>';
    return;
  }

  var isOpt = FUT_HP !== 'IF' && FUT_HP !== 'IH' && FUT_HP !== 'IC' && FUT_HP !== 'IM';
  var src = ((isOpt ? FUTHIST.opt : FUTHIST.fut) || {})[FUT_HP] || {};
  var vals = src[FUT_HM] || [];
  var dates = FUTHIST.d || [];
  var isEtf = ETF_HP.indexOf(FUT_HP) >= 0;
  if (!vals.length){
    box.innerHTML = isEtf
      ? '<div class="empty">ETF 期权基差从上线那天起逐日记录<br><span class="code">已到期合约没有可回查的历史，前面补不出来</span></div>'
      : '<div class="empty">这个品种还没有历史</div>';
    return;
  }

  var clean = [];
  for (var t = 0; t < vals.length; t++) if (vals[t] != null && isFinite(vals[t])) clean.push(vals[t]);
  clean.sort(function(a, b){ return a - b; });
  /* 前面一长串 null 要裁掉。ETF 期权是从上线那天才开始记的，x 轴却还是 231 天，
     不裁的话曲线会挤在右边一小撮、左边一大片空白，看着像图坏了。 */
  var i0 = 0;
  while (i0 < vals.length && (vals[i0] == null || !isFinite(vals[i0]))) i0++;
  if (i0 > 0 && i0 < vals.length){
    vals = vals.slice(i0);
    dates = dates.slice(i0);
  }
  var cur = null;
  for (var t2 = vals.length - 1; t2 >= 0; t2--) if (vals[t2] != null){ cur = vals[t2]; break; }
  var p10 = fQuant(clean, 0.1), p50 = fQuant(clean, 0.5), p90 = fQuant(clean, 0.9);
  var rank = 0;
  for (var t3 = 0; t3 < clean.length; t3++) if (clean[t3] <= cur) rank++;
  var pctile = clean.length ? Math.round(rank / clean.length * 100) : 0;

  /* 只有一两天数据时画不出曲线，p10/p50/p90 还会退化成同一个数，图上是一条没有
     意义的横线。不如把当前值和「还要等几天」直接写出来——ETF 期权这一组上线头几天
     就是这个状态。 */
  if (clean.length < 3){
    var sub0 = document.getElementById('futHistSub');
    if (sub0){
      sub0.innerHTML = (FUT_HM === 'cmp' ? '30 天恒定到期' : '主力近月')
        + ' · 当前 <b class="' + fSign(cur) + '">' + fPct(cur, 3) + '</b>'
        + ' · 已记 ' + clean.length + ' 个交易日';
    }
    box.innerHTML = '<div class="empty">还画不出曲线：目前只记了 ' + clean.length + ' 个交易日'
      + '<br><span class="code">'
      + (isEtf ? 'ETF 期权基差从上线那天起逐日累积，满 3 天后这里自动出图' : '等数据补齐')
      + '</span></div>';
    return;
  }

  var sub = document.getElementById('futHistSub');
  if (sub){
    sub.innerHTML = (FUT_HM === 'cmp' ? '30 天恒定到期' : '主力近月')
      + ' · 当前 <b class="' + fSign(cur) + '">' + fPct(cur, 3) + '</b>'
      + ' · 分位 ' + pctile + '%（' + clean.length + ' 天样本）'
      + ' · p10 ' + fPct(p10, 2) + ' / 中位 ' + fPct(p50, 2) + ' / p90 ' + fPct(p90, 2);
  }
  box.innerHTML = futHistSvg(vals, dates, { p10: p10, p50: p50, p90: p90, cur: cur });

  if (clean.length < 60){
    box.insertAdjacentHTML('beforeend', '<div class="futfoot">样本只有 ' + clean.length + ' 天，分位会偏极端，先当参考。</div>');
  }
}

/* 基差率曲线的纵轴是百分比、0 就是平水。这里没有复用 ovChartSvg：
   那个函数的语义是「相对某个基准的涨跌幅」，标题文案、右侧价格标牌都不适用，
   硬套会把「较本时段开盘」这种话印在基差图上。 */
var FH_GEO = null;   // 当前这张图的几何与数据，hover 时按它反查下标

function futHistSvg(vals, dates, st){
  /* 宽度跟容器走。原来写死 880 再 width:100%，手机上（约 350px）会被等比缩到
     2/5，字和点糊成一团、图形只占中间一小块。现在按实际像素 1:1 出图，
     窄屏的区别只是点更密。 */
  var host = document.getElementById('futHistChart');
  var W = Math.max(300, Math.round((host && host.clientWidth) || 880));
  var H = 190, ml = 46, mr = 12, mt = 12, mb = 20;
  var n = vals.length;
  var mn = Infinity, mx = -Infinity, i;
  for (i = 0; i < n; i++){
    if (vals[i] == null || !isFinite(vals[i])) continue;
    if (vals[i] < mn) mn = vals[i];
    if (vals[i] > mx) mx = vals[i];
  }
  if (!isFinite(mn)) return '<div class="empty">没有有效数据</div>';
  if (st.p90 != null) mx = Math.max(mx, st.p90);
  if (st.p10 != null) mn = Math.min(mn, st.p10);
  var padV = (mx - mn) * 0.12 || 0.2;
  var lo = mn - padV, hi = mx + padV;
  var xOf = function(idx){ return ml + (n <= 1 ? 0 : idx / (n - 1)) * (W - ml - mr); };
  var yOf = function(v){ return mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb); };

  var d = '', open = false, lastX = 0, lastY = 0;
  for (i = 0; i < n; i++){
    var v = vals[i];
    if (v == null || !isFinite(v)){ open = false; continue; }
    var x = xOf(i), y = yOf(v);
    d += (open ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    open = true; lastX = x; lastY = y;
  }

  var y0 = yOf(0);
  var g = '<svg class="fh" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" xmlns="http://www.w3.org/2000/svg">';
  // 0 轴：基差率过 0 就是平水，这条线是整张图的分界
  if (y0 > mt && y0 < H - mb){
    g += '<line x1="' + ml + '" y1="' + y0.toFixed(1) + '" x2="' + (W - mr) + '" y2="' + y0.toFixed(1)
      + '" stroke="var(--line)" stroke-width="1"/>';
    g += '<text x="' + (ml - 6) + '" y="' + (y0 + 4).toFixed(1) + '" font-size="10" fill="var(--txt3)" text-anchor="end">0</text>';
  }
  // p10 / p90 虚线：贴水是不是极端，看的是「现在离这对线有多远」
  var bands = [[st.p90, '#f0b6b6'], [st.p10, '#b6dcc9']];
  for (i = 0; i < bands.length; i++){
    if (bands[i][0] == null) continue;
    var by = yOf(bands[i][0]);
    if (by < mt || by > H - mb) continue;
    g += '<line x1="' + ml + '" y1="' + by.toFixed(1) + '" x2="' + (W - mr) + '" y2="' + by.toFixed(1)
      + '" stroke="' + bands[i][1] + '" stroke-width="1" stroke-dasharray="4 4"/>';
    // 窄屏不印 p10/p90 的数字：350px 宽里这两串会把线盖住，副标题里本来就有
    if (W >= 520){
      g += '<text x="' + (W - mr - 2) + '" y="' + (by - 3).toFixed(1) + '" font-size="9.5" fill="var(--txt3)" text-anchor="end">'
        + (i === 0 ? 'p90 ' : 'p10 ') + (+bands[i][0]).toFixed(2) + '%</text>';
    }
  }
  g += '<path d="' + d + '" fill="none" stroke="#2563eb" stroke-width="1.4" stroke-linejoin="round"/>';
  g += '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="2.8" fill="#2563eb"/>';
  g += '<text x="' + ml + '" y="' + (H - 5) + '" font-size="10" fill="var(--txt3)">' + esc(String(dates[0] || '').slice(2)) + '</text>';
  g += '<text x="' + (W - mr) + '" y="' + (H - 5) + '" font-size="10" fill="var(--txt3)" text-anchor="end">' + esc(String(dates[n - 1] || '').slice(2)) + '</text>';
  g += '<text x="' + (ml - 6) + '" y="' + (yOf(hi) + 10).toFixed(1) + '" font-size="10" fill="var(--txt2)" text-anchor="end">' + hi.toFixed(2) + '%</text>';
  g += '<text x="' + (ml - 6) + '" y="' + (yOf(lo) - 2).toFixed(1) + '" font-size="10" fill="var(--txt2)" text-anchor="end">' + lo.toFixed(2) + '%</text>';
  /* 悬停层：250 个点铺在 880 宽的折线上，相邻两天只差 3.5px——折线只有形状，
     具体哪天多少必须能读出来。竖线 + 圆点 + 一个小气泡，全部走 SVG 坐标，
     由 pointermove 反算下标。pointer-events:none，别挡住命中区。 */
  g += '<g class="fh-hov" style="display:none;pointer-events:none">'
    + '<line class="fh-ln" y1="' + mt + '" y2="' + (H - mb) + '" stroke="#9aa4b2" stroke-width="1" stroke-dasharray="3 3"/>'
    + '<circle class="fh-dot" r="3.4" fill="#2563eb" stroke="#fff" stroke-width="1.5"/>'
    + '<g class="fh-tip"><rect class="fh-bg" rx="4" width="94" height="34" fill="#15181d" opacity="0.9"/>'
    + '<text class="fh-d" font-size="9.5" fill="#cbd5e1"></text>'
    + '<text class="fh-v" font-size="12" font-weight="600" fill="#fff"></text></g></g>';
  g += '</svg>';
  FH_GEO = { vals: vals, dates: dates, n: n, ml: ml, mr: mr, W: W, H: H, mt: mt, mb: mb, lo: lo, hi: hi };
  return g;
}

/* 把 client 坐标换成 viewBox 坐标：图宽是 100% 自适应，用像素算会随窗口漂。
   getScreenCTM 把缩放和 padding 一起吃掉，比手算比例稳。 */
function futHoverAt(e){
  var geo = FH_GEO;
  var box = document.getElementById('futHistChart');
  var svg = box && box.querySelector('svg.fh');
  if (!geo || !svg) return;
  var ctm = svg.getScreenCTM();
  if (!ctm) return;
  var pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  var vx = pt.matrixTransform(ctm.inverse()).x;
  var span = geo.W - geo.ml - geo.mr;
  var idx = Math.round((vx - geo.ml) / span * (geo.n - 1));
  if (idx < 0) idx = 0;
  if (idx > geo.n - 1) idx = geo.n - 1;
  // 缺口附近往两边各找 5 个点：停在没有数据的那天上时，提示不该整个消失
  var at = idx, step = 1;
  while ((geo.vals[at] == null || !isFinite(geo.vals[at])) && step <= 5){
    if (idx - step >= 0 && geo.vals[idx - step] != null && isFinite(geo.vals[idx - step])){ at = idx - step; break; }
    if (idx + step < geo.n && geo.vals[idx + step] != null && isFinite(geo.vals[idx + step])){ at = idx + step; break; }
    step++;
  }
  var val = geo.vals[at];
  if (val == null || !isFinite(val)){ futHoverOff(); return; }

  var px = geo.ml + (geo.n <= 1 ? 0 : at / (geo.n - 1)) * span;
  var py = geo.mt + (1 - (val - geo.lo) / (geo.hi - geo.lo)) * (geo.H - geo.mt - geo.mb);
  var ln = svg.querySelector('.fh-ln'), dot = svg.querySelector('.fh-dot');
  var layer = svg.querySelector('.fh-hov'), bg = svg.querySelector('.fh-bg');
  var td = svg.querySelector('.fh-d'), tv = svg.querySelector('.fh-v');
  ln.setAttribute('x1', px.toFixed(1)); ln.setAttribute('x2', px.toFixed(1));
  dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1));
  td.textContent = String(geo.dates[at] || '').slice(5);
  tv.textContent = fPct(val, 3);
  var tw = 94, th = 34;
  var tx = px + 10, ty = py - th - 8;
  if (tx + tw > geo.W - 2) tx = px - tw - 10;      // 贴右边就翻到左侧
  if (ty < 2) ty = py + 10;                        // 贴顶就翻到下方
  if (tx < 2) tx = 2;
  bg.setAttribute('x', tx.toFixed(1)); bg.setAttribute('y', ty.toFixed(1));
  td.setAttribute('x', (tx + 8).toFixed(1)); td.setAttribute('y', (ty + 13).toFixed(1));
  tv.setAttribute('x', (tx + 8).toFixed(1)); tv.setAttribute('y', (ty + 28).toFixed(1));
  // 气泡底色是深色，用浅一档的红/绿，别拿 --up/--down 那两个（深色在白底上才够）
  tv.setAttribute('fill', val > 0 ? '#fca5a5' : (val < 0 ? '#86efac' : '#ffffff'));
  layer.style.display = '';
}

function futHoverOff(){
  var box = document.getElementById('futHistChart');
  var layer = box && box.querySelector('svg.fh .fh-hov');
  if (layer) layer.style.display = 'none';
}

function futInit(){
  var btn = document.getElementById('btnFut');
  if (btn) btn.onclick = function(){ FUT = null; loadFut(); loadFutOpt('main'); if (FUTHIST) loadFutHist(); };
  var tabs = document.getElementById('futPosTabs');
  if (tabs) tabs.addEventListener('click', function(e){
    var t = e.target && e.target.closest ? e.target.closest('.mtab') : null;
    if (!t) return;
    FUT_TAB = t.getAttribute('data-p') || 'live';
    renderFutPos();
  });
  var ht = document.getElementById('futHistTabs');
  if (ht) ht.addEventListener('click', function(e){
    var t = e.target && e.target.closest ? e.target.closest('.mtab') : null;
    if (!t) return;
    var h = t.getAttribute('data-h'), m = t.getAttribute('data-m');
    if (h) FUT_HP = h;
    if (m) FUT_HM = m;
    renderFutHist();
  });
  // hover 绑在容器上而不是 svg 上：图表每次重绘都换一个 svg 节点，绑在图里会随 node 一起消失
  var hc = document.getElementById('futHistChart');
  if (hc && !hc.getAttribute('data-hover')){
    hc.setAttribute('data-hover', '1');
    hc.addEventListener('pointermove', futHoverAt);
    hc.addEventListener('pointerdown', futHoverAt);
    hc.addEventListener('pointerleave', futHoverOff);
    hc.addEventListener('pointercancel', futHoverOff);
    // 图宽是按容器像素算的，横竖屏切换/窗口拉伸后必须重画一次，否则点距和命中区错位
    var rz;
    window.addEventListener('resize', function(){
      if (!FUTHIST || !FUTHIST.ok) return;
      clearTimeout(rz);
      rz = setTimeout(renderFutHist, 180);
    });
  }
  loadFut();
  loadFutOpt('main');
  loadFutHist();
}

/* 锚点导航：点击平滑滚动；滚动时把视口上缘以下 120px 处的区块点亮。
   量出来的 --navH 同时供区块 scroll-margin-top 和表格表头 sticky 用，
   窗口尺寸变化（转屏、缩放）时重算。 */
var NAV_SECS = ['onCard', 'secSec', 'watchSec', 'spdSec', 'futSec', 'rankSec'];   // 按文档顺序
function navMeasure(){
  var nav = document.getElementById('secNav');
  if (nav) document.documentElement.style.setProperty('--navH', (nav.offsetHeight + 8) + 'px');
}
function navScrollTo(id){
  var el = document.getElementById(id);
  if (!el) return;
  var nav = document.getElementById('secNav');
  var navH = nav ? nav.offsetHeight + 8 : 42;
  var y = el.getBoundingClientRect().top + window.pageYOffset - navH;
  window.scrollTo({ top: y, behavior: 'smooth' });
  // 平滑滚动要半秒，途中「急涨急跌」几秒一刷、行数在变，目标位置会被推移——
  // 落点就偏了。滚完 900ms 内连续校正，把布局漂移吃掉。
  var n = 0;
  var tm = setInterval(function(){
    var dy = el.getBoundingClientRect().top - navH;
    if (Math.abs(dy) > 2) window.scrollTo({ top: window.pageYOffset + dy, behavior: 'auto' });
    if (++n >= 6) clearInterval(tm);
  }, 150);
}
function navActive(){
  var nav = document.getElementById('secNav');
  if (!nav) return;
  // 取「视口线以上、离它最近的区块」当前高亮——不能用数组顺序挑最后一个：
  // 数组顺序一旦和文档顺序不一致（区块挪过位置），上面两个区块同时越线时
  // 就会点亮错的那一个（实测：滚到急涨急跌，板块地图却亮着）。
  var cur = '', best = -Infinity;
  for (var i = 0; i < NAV_SECS.length; i++){
    var el = document.getElementById(NAV_SECS[i]);
    if (!el || !el.offsetHeight) continue;      // 隐藏的（如隔夜卡还没数据）跳过
    var t = el.getBoundingClientRect().top;
    if (t <= 120 && t > best){ best = t; cur = NAV_SECS[i]; }
  }
  var as = nav.querySelectorAll('a');
  for (i = 0; i < as.length; i++) as[i].classList.toggle('on', as[i].getAttribute('data-t') === cur);
}
/* 窄屏横滑表的收尾工作：标 .hs、量第一列宽度、插提示条。
   为什么要逐个量：冻结列的第二列 left 偏移得等于第一列实宽，而「代码」(510300)
   和「合约」(IF2611) 差着十几像素，写死一个值总有一边对不齐。
   触发的三种时机都要覆盖：首屏、表格内容重绘（数字每 5 秒在变、行数也会变）、
   窗口尺寸变化。前两者用 MutationObserver 盯每张表，比在每个渲染函数里塞一行
   可靠——渲染入口有七八个，漏一个就有一张表不带锚点。 */
function markHS(){
  var narrow = window.matchMedia('(max-width:820px)').matches;
  var ts = document.querySelectorAll('.tbl');
  for (var i = 0; i < ts.length; i++){
    var t = ts[i];
    var over = narrow && t.scrollWidth > t.clientWidth + 1;
    // 冻结只给长表（自选 14 列、清单 11 列）。期指/期权表只有 7 列、滑 60 来像素就到头，
    // 冻上「合约+现价」等于白占半屏——而且 #futSec 那条 thead{position:static} 带 ID，
    // 权重压过 .tbl.hs th:nth-child(1)，冻了也不生效，不如按列数控住。
    var ncol = t.querySelector('thead th') ? t.querySelectorAll('thead th').length : 0;
    if (over && ncol >= 9){
      var th = t.querySelector('thead th');
      if (th) t.style.setProperty('--w1', th.offsetWidth + 'px');
      t.classList.add('hs');
    } else {
      t.classList.remove('hs');
    }
    var next = t.nextElementSibling;
    var hasTip = !!(next && next.classList && next.classList.contains('hstip'));
    if (over && !hasTip){
      // 放表格下方而不是上方：吸顶导航 42px，滚到表格时上方的提示正好被它压住
      t.insertAdjacentHTML('afterend', '<div class="hstip">← 左右滑动看全部列 →</div>');
    } else if (!over && hasTip){
      next.parentNode.removeChild(next);
    }
  }
}
(function watchHS(){
  var tm = 0;
  function bump(){ if (tm) return; tm = setTimeout(function(){ tm = 0; markHS(); }, 80); }
  var ts = document.querySelectorAll('.tbl');
  for (var i = 0; i < ts.length; i++){
    if (window.MutationObserver) new MutationObserver(bump).observe(ts[i], { childList: true, subtree: true, characterData: true });
    (function(t){
      t.addEventListener('scroll', function(){
        if (t.scrollLeft > 2){ t.classList.add('shr'); }
        else t.classList.remove('shr');
      }, { passive: true });
    })(ts[i]);
  }
  window.addEventListener('resize', bump, { passive: true });
  window.addEventListener('orientationchange', bump, { passive: true });
  markHS();
})();

(function initNav(){
  var nav = document.getElementById('secNav');
  if (!nav) return;
  nav.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) navScrollTo(a.getAttribute('data-t'));
  });
  var tm;
  window.addEventListener('scroll', function(){
    if (tm) return;
    tm = setTimeout(function(){ tm = null; navActive(); }, 120);
  }, { passive: true });
  window.addEventListener('resize', navMeasure);
  navMeasure();
  setTimeout(navMeasure, 800);                  // 字体/卡片就位后再量一次
})();
clock(); setInterval(clock, 1000);

renderTrigCount();
loadOvernight();
setInterval(loadOvernight, 600000);   // 期货整夜在动，10 分钟跟一次够了

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
  // 全 A 快照和全量行情并行：它只要 0.5 秒，等 loadFull 的三四秒跑完再发，
  // 首屏那张卡片就已经用基线最后一天画完了（会显示「11-06」而不是「今天」）
  loadMktSnap();
  futInit();                    // 期指这块不依赖全市场行情，先发出去
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
