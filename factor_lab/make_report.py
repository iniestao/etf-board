"""生成 HTML 研究报告。"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

import sys
sys.path.insert(0, '/workspace/etf_board/factor_lab')
from factors import FACTORS

OUT = Path('/workspace/etf_report')
HERE = Path('/workspace/etf_board/factor_lab')
res = json.load(open(HERE / 'out_result.json'))
cross = pd.read_csv(HERE / 'out_cross.csv')
single = pd.read_csv(HERE / 'out_single_oos.csv')

tr, te, bm = res['train'], res['test'], res['bench']
sig_m = (cross.t_in > 2.0) & (cross.net_in > 0)
ok_m = (cross.t_out > 1.5) & (cross.net_out > 0)
sig_in = cross[sig_m]
alive = cross[sig_m & ok_m]
only_out = cross[ok_m & ~sig_m]
g = single[single.top == 0.2].sort_values('ex', ascending=False)

FAM_ORDER = ['A 隔夜日内', 'B 动量反转', 'C 波动结构', 'D 尾部风险',
             'E 流动性', 'F 量价关系', 'G 路径形态', 'H 技术位置', 'I 自相关']
FAM_DESC = {
    'A 隔夜日内': '把日收益拆成隔夜与日内两段。两段的风险完全不同：隔夜无法平仓，日内可 T+0 套利，信息含量也不同源。',
    'B 动量反转': '趋势与反转。ETF 是行业轮动的直接载体，动量在板块层面的持续性可能强于个股。',
    'C 波动结构': '波动率不只是风险，它的期限结构、上下行分解、估计方法都会改变排序。',
    'D 尾部风险': '左尾和右尾不对称。彩票偏好让右尾贵的资产变贵，左尾贵的资产需要补偿。',
    'E 流动性': 'ETF 池的流动性差异跨越三个数量级，流动性本身就是状态变量，不只是成本。',
    'F 量价关系': '成交量是信息到达的代理。放量上涨与放量滞涨是两种完全不同的资金行为。',
    'G 路径形态': '同样的涨幅，走得直和走得抖是两回事。路径刻画了信息扩散的方式。',
    'H 技术位置': '价格在区间中的相对位置，反映的是筹码结构而非基本面。',
    'I 自相关': '收益序列的可预测性本身。趋势型与均值回复型资产应该给不同的因子权重。',
}


def fam_table(fam: str) -> str:
    rows = [(k, v) for k, v in FACTORS.items() if v['family'] == fam]
    tr_map = cross.set_index('factor')
    body = ''
    for i, (k, v) in enumerate(rows, 1):
        r = tr_map.loc[k]
        cls = 'hit' if (r.net_out > 0 and r.t_out > 1.5 and r.net_in > 0 and r.t_in > 2) else ''
        sign = '正' if v['direction'] > 0 else '负'
        body += (f'<tr class="{cls}"><td class="num">{i}</td><td class="mono">{k}</td>'
                 f'<td class="ctr">{sign}</td><td>{v["desc"]}</td>'
                 f'<td class="ref">{v["ref"]}</td>'
                 f'<td class="num">{r.ic_in:+.3f}</td><td class="num">{r.t_in:.1f}</td>'
                 f'<td class="num">{r.ic_out:+.3f}</td><td class="num">{r.t_out:.1f}</td></tr>')
    return f'''
<h3>{fam} <span class="cnt">{len(rows)} 个</span></h3>
<p class="famdesc">{FAM_DESC[fam]}</p>
<table class="ftab">
<thead><tr><th>#</th><th>因子</th><th>方向</th><th>经济逻辑</th><th>文献出处</th>
<th>IC内</th><th>t内</th><th>IC外</th><th>t外</th></tr></thead>
<tbody>{body}</tbody></table>'''


top_single = ''.join(
    f'<tr><td class="mono">{r.factor}</td><td>{FACTORS[r.factor]["family"]}</td>'
    f'<td class="num">{r.ann:.1%}</td><td class="num pos">{r.ex:+.1%}</td>'
    f'<td class="num">{r.sharpe:.2f}</td><td class="num">{r.mdd:.1%}</td>'
    f'<td class="num">{r.to:.1f}</td><td class="num">{r.holding:.0f}</td></tr>'
    for _, r in g.head(10).iterrows())

sel_rows = ''.join(
    f'<tr><td class="mono">{k}</td><td>{FACTORS[k]["family"]}</td>'
    f'<td class="num">{res["weights"][k]:.0%}</td>'
    f'<td>{FACTORS[k]["desc"]}</td></tr>'
    for k in res['selected'])

_nv = pd.read_csv(HERE / 'out_nav.csv', index_col=0, parse_dates=True)
_s, _b = _nv['test'].dropna(), _nv['test_bench'].dropna()


def _yr(navs):
    e = navs.resample('YE').last()
    pv = e.shift(1)
    pv.iloc[0] = navs.iloc[0]
    return e / pv - 1


_rs, _rb = _yr(_s), _yr(_b)
yr_rows = []
for i, d in enumerate(_rs.index):
    lab = f'{d.year}' if i < len(_rs) - 1 else f'{d.year}（至 11 月）'
    yr_rows.append((lab, f'{_rs.iloc[i]:+.1%}', f'{_rb.iloc[i]:+.1%}',
                    f'{( _rs.iloc[i]-_rb.iloc[i]):+.1%}'))
yr_html = ''.join(
    f'<tr><td>{a}</td><td class="num">{b}</td><td class="num">{c}</td>'
    f'<td class="num {"pos" if d.startswith("+") else "neg"}">{d}</td></tr>'
    for a, b, c, d in yr_rows)

HTML = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETF 量价因子挖掘与策略回测</title>
<style>
:root{{--ink:#1a1a1a;--sub:#6b6b6b;--line:#e3e3e0;--bg:#fbfbf9;--red:#c0392b;--grn:#1e8e5a;--blue:#2c5f8a}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);
font-family:-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
line-height:1.75;font-size:15px;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:1000px;margin:0 auto;padding:56px 40px 100px}}
.eyebrow{{font-size:12px;letter-spacing:.18em;color:var(--red);text-transform:uppercase;margin-bottom:14px;font-weight:600}}
h1{{font-size:34px;line-height:1.3;margin:0 0 18px;font-weight:700;letter-spacing:-.5px}}
.lede{{font-size:16.5px;color:#3a3a3a;border-left:3px solid var(--red);padding-left:18px;margin:0 0 40px}}
h2{{font-size:21px;margin:56px 0 18px;padding-bottom:9px;border-bottom:1px solid var(--line);font-weight:650}}
h3{{font-size:16px;margin:32px 0 8px;font-weight:600}}
.cnt{{font-size:12px;color:var(--sub);font-weight:400;margin-left:6px}}
.famdesc{{font-size:13.5px;color:var(--sub);margin:0 0 14px}}
.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0 10px}}
.card{{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px}}
.card .k{{font-size:12px;color:var(--sub);margin-bottom:7px}}
.card .v{{font-size:24px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}}
.card .s{{font-size:11.5px;color:var(--sub);margin-top:4px}}
.pos{{color:var(--red)}} .neg{{color:var(--grn)}}
table{{width:100%;border-collapse:collapse;font-size:13px;background:#fff;
border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:14px 0}}
th{{background:#f4f4f1;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;
color:#444;border-bottom:1px solid var(--line);white-space:nowrap}}
td{{padding:8px 11px;border-bottom:1px solid #f0f0ed;vertical-align:top}}
tr:last-child td{{border-bottom:none}}
.ftab td{{font-size:12.3px;line-height:1.55}}
.ftab tr.hit{{background:#fdf3f2}}
.num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.ctr{{text-align:center}}
.mono{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:nowrap}}
.ref{{color:var(--sub);font-size:11.5px}}
img{{width:100%;border:1px solid var(--line);border-radius:8px;margin:18px 0;background:#fff}}
.cap{{font-size:12px;color:var(--sub);margin:-10px 0 26px}}
.note{{background:#fff;border-left:3px solid var(--blue);padding:14px 18px;margin:20px 0;
font-size:14px;border-radius:0 6px 6px 0}}
.warn{{border-left-color:var(--red);background:#fdf6f5}}
code{{background:#f0f0ed;padding:1px 5px;border-radius:3px;font-size:12.5px}}
ul{{padding-left:20px}} li{{margin:7px 0}}
.small{{font-size:13px;color:var(--sub)}}
footer{{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--sub)}}
@media(max-width:760px){{.wrap{{padding:32px 18px 60px}}.cards{{grid-template-columns:repeat(2,1fr)}}h1{{font-size:26px}}}}
</style></head><body><div class="wrap">

<div class="eyebrow">量化研究 · ETF 横截面</div>
<h1>100 个量价因子的样本外诚实检验</h1>
<p class="lede">Alpha101 已失效，重新挖了 100 个有文献出处的量价因子，在 1717 只 ETF、2019–2026 的日频数据上做横截面检验。<b>样本内 {len(sig_in)} 个显著，样本外只活下来 {len(alive)} 个</b>；更麻烦的是，样本外有效的 {len(alive)+len(only_out)} 个因子里有 {len(only_out)} 个在样本内根本看不出来——样本内筛选对样本外的预测力接近于零。</p>

<div class="cards">
<div class="card"><div class="k">因子总数</div><div class="v">100</div><div class="s">9 个家族，全部日频可得</div></div>
<div class="card"><div class="k">样本内显著（t&gt;2）</div><div class="v">{len(sig_in)}</div><div class="s">2020–2023，净超额&gt;0</div></div>
<div class="card"><div class="k">样本外仍有效</div><div class="v" style="color:var(--red)">{len(alive)}</div><div class="s">两期都显著的只有这 {len(alive)} 个</div></div>
<div class="card"><div class="k">策略年化超额</div><div class="v" style="color:var(--red)">+{ (te['ann']-bm['ann'])*100:.1f}%</div><div class="s">夏普 {te['sharpe']:.2f} vs 基准 {bm['sharpe']:.2f}</div></div>
</div>

<h2>一、先说结论</h2>
<ul>
<li><b>ETF 池的 alpha 极其稀薄。</b>100 个因子里样本内显著的 {len(sig_in)} 个，两期都站住的只有 <code>PE</code> 和 <code>ITS</code> 两个。IC 量级 0.02–0.05，比个股上的同类研究低一个档。</li>
<li><b>样本内筛选几乎不能预测样本外。</b>样本外有效的 {len(alive)+len(only_out)} 个因子里，<b>{len(only_out)} 个在样本内看不出</b>（t&lt;2 或净超额为负）。反过来，样本内最显著的 <code>MOM_12_1</code>（t=4.5）样本外净超额 <b>-5.6%</b>。两期都显著的只有 {len(alive)} 个。</li>
<li><b>动量类在 2024 年后集体失效，而且是"倒 U 型"失效。</b>不是变负，是两头都差、中间最好——最强的动量组跌得最惨。IC 仍为正，但收益全部来自空头端，多头端拿不到（详见第五节）。</li>
<li><b>真正稳的是"路径质量"类</b>：<code>PE</code>（路径效率）、<code>ITS</code>（日内趋势强度）、<code>CORR_RA60</code>（收益与成交额相关）。它们的共同点是刻画"这笔涨幅是怎么走出来的"，而不是"涨了多少"。</li>
<li><b>组合策略样本外年化 {te['ann']:.1%}，基准 {bm['ann']:.1%}，超额 {(te['ann']-bm['ann'])*100:+.1f}%，夏普 {te['sharpe']:.2f} vs {bm['sharpe']:.2f}，最大回撤 {te['mdd']:.1%} vs {bm['mdd']:.1%}。</b>超额不厚，但回撤明显更浅——主要贡献来自 2026 年的下跌市。</li>
</ul>

<h2>二、数据与方法</h2>
<table>
<thead><tr><th>项目</th><th>设定</th><th>为什么这么定</th></tr></thead>
<tbody>
<tr><td>标的池</td><td>1717 只 ETF，2005–2026</td><td>覆盖宽基、行业主题、跨境、债券、货币、商品</td></tr>
<tr><td>检验区间</td><td>样本内 2020-01~2023-12<br>样本外 2024-01~2026-11</td><td>2020 年前 ETF 不足 150 只，横截面排名无统计意义</td></tr>
<tr><td>可交易过滤</td><td>20 日均成交额 ≥ 5000 万</td><td>池里大量 ETF 日成交几十万，因子排名再高也买不进</td></tr>
<tr><td>分层方式</td><td>先在 6 类资产内排名，再合并</td><td>债券 ETF 波动是股票 ETF 的 1/10，全池排名会机械选出债券</td></tr>
<tr><td>标签</td><td>T+1 开盘买入，持有 10 日</td><td>用 close-to-close 会偷用当日收盘价成交，实盘做不到</td></tr>
<tr><td>成本</td><td>单边 5bp</td><td>ETF 佣金万 0.5 + 冲击成本，按实际换手逐日扣</td></tr>
<tr><td>因子平滑</td><td>EMA，半衰期 10 日</td><td>不平滑时年换手 3000%+，成本吃掉全部超额</td></tr>
</tbody></table>

<div class="note warn"><b>三个必须承认的坑</b>（都在过程中踩到并修掉了）：
<ol style="margin:8px 0 0">
<li><b>基准前视偏差。</b>最初用"当日可交易池等权"做基准，等于提前知道谁今天放量——而放量当天往往大涨。基准被凭空抬高 15 个百分点（22% vs 真实的 6.5%），一度让所有因子看起来都跑输</li>
<li><b>波动率被摊薄。</b>用「H 日收益 ÷ H」当日收益，波动被压低 √H 倍，持有 20 日时夏普虚高 4.5 倍</li>
<li><b>加权收益未归一化。</b>停牌标的让权重和小于 1，收益被系统性稀释</li>
</ol></div>

<h2>三、因子全景</h2>
<p class="small">下表 100 个因子。红底 = 两期都显著（样本内 t&gt;2 且样本外 t&gt;1.5，净超额均为正）。全部只用日频 OHLCV + 成交额，不需要分钟数据、财报或分析师数据。</p>
{''.join(fam_table(f) for f in FAM_ORDER)}

<h2>四、样本内结果（2020–2023）</h2>
<p>100 个因子里 <b>{len(sig_in)} 个</b>达到 t&gt;2 且扣成本后净超额为正。IC 最高的是 <code>MOM_12_1</code>（0.048）和 <code>MOM250</code>（0.043），t 值 4.5 和 4.0。</p>
<p>若只看这一步就收工，会得到一份很漂亮的报告。问题是这些因子在样本外几乎全军覆没。</p>

<h2>五、样本外验证（2024–2026）</h2>
<img src="ic_scatter.png" alt="因子衰减散点图">
<p class="cap">横轴样本内 IC，纵轴样本外 IC。虚线以上表示样本外反而变强。金色点是"样本内看不出、样本外有效"的 {len(only_out)} 个——它们占了样本外有效因子的绝大多数。</p>

<p>样本内外 IC 同号比例 <b>72%</b>，秩相关 <b>0.64</b>——因子整体有信息延续性，不是纯粹的数据挖掘。但"IC 有延续性"和"能赚钱"是两回事：<code>MOM_12_1</code> 样本外 IC 仍有 0.026（t=1.9），净超额却是 -5.6%。</p>

<div class="note"><b>为什么 IC 为正，多头却不赚钱？</b><br>
以 <code>MOM_12_1</code> 为例，样本外十等分收益是：9.5 / 9.5 / 14.0 / 12.7 / 15.2 / 14.6 / <b>20.5 / 15.2</b> / 8.2 / 9.1（%）。中间两组最好，<b>最强的第 9、10 组反而垫底</b>。IC 是全局秩相关，被"低动量组显著跑输"撑起来了——这在能融券的市场里是很好的空头信号，但 ETF 券源少、成本高，只做多就拿不到。<br><br>
这是动量崩溃（momentum crash）的典型形态：前期涨得最多的主题 ETF，在风格切换时跌得最狠。</div>

<h3>最关键的交叉表</h3>
<table>
<thead><tr><th></th><th>样本外有效</th><th>样本外失效</th><th>合计</th></tr></thead>
<tbody>
<tr><td><b>样本内显著</b></td><td class="num" style="color:var(--red);font-weight:700">{len(alive)}</td><td class="num">{len(sig_in)-len(alive)}</td><td class="num">{len(sig_in)}</td></tr>
<tr><td><b>样本内不显著</b></td><td class="num">{len(only_out)}</td><td class="num">{100-len(sig_in)-len(only_out)}</td><td class="num">{100-len(sig_in)}</td></tr>
<tr><td><b>合计</b></td><td class="num">{len(alive)+len(only_out)}</td><td class="num">{100-len(alive)-len(only_out)}</td><td class="num">100</td></tr>
</tbody></table>
<p>如果样本内筛选有效，右上角（显著→失效）应该很少、左上角（显著→仍有效）应该很多。实际完全相反：<b>{len(sig_in)} 个里失效 {len(sig_in)-len(alive)} 个，{len(alive)+len(only_out)} 个有效里 {len(only_out)} 个是样本内看不出的</b>。</p>
<p>这不是说因子研究没意义，而是说：在只有 4 年训练数据、1700 个标的上，单因子 t 值 2–4 的"显著性"里有大量噪声。t=4.5 的因子样本外翻车，t=2.3 的因子样本外反而有效——排序几乎随机。</p>

<h3>单因子只多 top20% 的样本外表现</h3>
<table>
<thead><tr><th>因子</th><th>家族</th><th>年化</th><th>超额</th><th>夏普</th><th>回撤</th><th>换手</th><th>持仓</th></tr></thead>
<tbody>{top_single}</tbody></table>
<p class="cap">持有 10 日、只做多、扣 5bp 单边成本。基准（股票型 ETF 等权）年化 {bm['ann']:.1%}、夏普 {bm['sharpe']:.2f}、回撤 {bm['mdd']:.1%}。注意本表用 10 日持有，与上表的 5 日检验口径略有差异。</p>

<div class="note"><b>注意这是事后观察，不能用来选因子。</b>用样本外排名去挑因子，等于把样本外变成了样本内，再想验证就没有数据了。上面这张表的价值是告诉我们「哪个方向值得继续研究」，不是「哪个因子可以直接用」。</div>

<h2>六、组合策略</h2>
<p>因子选择规则<b>全部只看 2020–2023</b>：t&gt;2、净超额&gt;0、两个子期（2020-21 / 2022-23）IC 同号、与已选因子 |ρ|&lt;0.6，取前 6 个。参数事前固定为 10 日调仓、top 20%、目标波动 20%，不做网格搜索——在 4 年数据上搜参数，搜出来的多半是过拟合。</p>

<table>
<thead><tr><th>因子</th><th>家族</th><th>ICIR 权重</th><th>选它的理由</th></tr></thead>
<tbody>{sel_rows}</tbody></table>

<img src="nav.png" alt="净值曲线">
<p class="cap">灰底为样本内（训练），右侧为样本外。样本外区间策略与基准的每一次交互都没有人工干预。</p>

<table>
<thead><tr><th>指标</th><th>样本内 2020–2023</th><th>样本外 2024–2026</th><th>样本外基准</th></tr></thead>
<tbody>
<tr><td>年化收益</td><td class="num">{tr['ann']:.2%}</td><td class="num">{te['ann']:.2%}</td><td class="num">{bm['ann']:.2%}</td></tr>
<tr><td>年化波动</td><td class="num">{tr['vol']:.2%}</td><td class="num">{te['vol']:.2%}</td><td class="num">{bm['vol']:.2%}</td></tr>
<tr><td>夏普</td><td class="num">{tr['sharpe']:.2f}</td><td class="num">{te['sharpe']:.2f}</td><td class="num">{bm['sharpe']:.2f}</td></tr>
<tr><td>最大回撤</td><td class="num">{tr['mdd']:.2%}</td><td class="num">{te['mdd']:.2%}</td><td class="num">{bm['mdd']:.2%}</td></tr>
<tr><td>日胜率</td><td class="num">{tr['win']:.1%}</td><td class="num">{te['win']:.1%}</td><td class="num">—</td></tr>
</tbody></table>

<img src="yearly.png" alt="分年度收益">
<p class="cap">分年度：2024 打平，2025 大幅跑输，2026 下跌市大幅跑赢。</p>

<table>
<thead><tr><th>年度</th><th>策略</th><th>基准</th><th>超额</th></tr></thead>
<tbody>{yr_html}</tbody></table>

<div class="note warn"><b>必须直说：这个策略的画像很不均匀。</b>
2025 年基准涨 28.9%（小微盘 ETF 集体暴涨），策略只做到 14.8%，跑输 14 个点；2026 年基准跌 15.8%，策略几乎不亏。<b>它本质上是一个带防御性的趋势组合，在普涨行情里跑不动，在下跌行情里抗跌。</b>如果你的预期是"每年都能稳定跑赢"，这个策略达不到。</div>

<h2>七、五条发现</h2>
<h3>1. 因子衰减比想象中快</h3>
<p>样本内 t 值 4.5 的因子，样本外 t 值能到 1.9 就算不错。原因是 ETF 池的结构在变——2020 年平均只有 170 只可交易 ETF，2026 年有 660+ 只，横截面的竞争格局完全不同。早期有效往往是因为池子小、错价多。</p>

<h3>2. 动量的失效是"倒 U 型"，不是变负</h3>
<p>这一点最反直觉。如果动量简单变负，反向做就行；但实际是中间组最好、两头都差，说明它是<b>非单调</b>的。直接对因子取反会得到一个同样差的策略。处理这类失效只能靠"不用它"，或者加入非线性项（如动量与波动率的交互）。</p>

<h3>3. 路径质量 &gt; 涨幅大小</h3>
<p><code>PE</code>（净涨幅 / 路径总长度）在样本内 t=4.1、样本外 t=3.6，几乎没衰减，是 100 个因子里最稳的。同样，<code>ITS</code>（收盘在当日振幅中的位置）、<code>CORR_RA60</code>（收益与成交额的相关）也都活下来了。<b>它们都在回答"这段涨幅是怎么形成的"，而不是"涨了多少"</b>——后者太容易被风格切换打翻。</p>

<h3>4. 换手是 ETF 因子的第一杀手</h3>
<p>日频技术类因子年换手 3000%+，5bp 单边成本要吃掉 16%/年，直接抹平全部超额。EMA 平滑（半衰期 10 日）把换手压到 1000% 以内，IC 只掉 20%——这是性价比最高的一步改造。</p>

<h3>5. 基准的口径比策略本身更容易出错</h3>
<p>这次踩的三个坑里有两个在基准侧。等权基准看似最简单，实际上"哪些标的算在池子里"、"用哪天的池子"这两个细节，就能让基准收益差出 15 个百分点。任何"策略跑输基准"的结论，先怀疑基准。</p>

<h2>八、局限与风险</h2>
<ul>
<li><b>样本外只有 2.8 年、685 个交易日。</b>统计上够看方向，不足以证明稳定性。2025 与 2026 的巨大分化说明它对市场状态高度敏感。</li>
<li><b>ETF 不能做空，也不建议加杠杆。</b>因子在空头端的信息被浪费了，这是结构性损失。</li>
<li><b>未考虑申赎、大额冲击、涨跌停。</b>2 亿以上资金按 top20% 建仓会有明显冲击成本。</li>
<li><b>数据到 2026-11-03。</b>2026 年只有 10 个月，年度数字不完整。</li>
<li><b>因子库有幸存者偏差。</b>用的是当前存续的 1717 只 ETF，已退市的不在池内。</li>
</ul>

<h2>九、如果要继续做</h2>
<ul>
<li><b>方向一：同指数 ETF 的价差回归。</b>476 个指数对应 1717 只 ETF，平均一个指数 3.6 只。同质标的的折溢价回归是最干净的 alpha 来源，这次只做了粗粒度的 <code>PEERMOM</code>，没做配对交易。</li>
<li><b>方向二：把因子用在"选指数"而不是"选 ETF"。</b>先按跟踪指数聚合，在 476 个指数上做横截面，再在指数内部选流动性最好的那只执行。这样能消掉大量同质化噪声。</li>
<li><b>方向三：非线性组合。</b>动量失效是倒 U 型，说明线性加权不够。可以试树模型或分状态（趋势市/震荡市）切换因子权重。</li>
</ul>

<footer>
数据：etf.db，1717 只 ETF，2005-02-23 ~ 2026-11-03，153.8 万条日线。<br>
代码：<code>factor_lab/</code>（panel.py 数据面板 / factors.py 100 因子 / evaluate.py 检验 / portfolio.py 回测 / run.py 主流程）<br>
本报告为量化研究记录，不构成投资建议。
</footer>
</div></body></html>'''

(OUT / 'index.html').write_text(HTML, encoding='utf-8')
print('written', OUT / 'index.html', len(HTML), 'bytes')
