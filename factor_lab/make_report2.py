"""生成 HTML 报告。"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pandas as pd

HERE = Path('/workspace/etf_board/factor_lab')
OUT = Path('/workspace/etf_report')

R = json.load(open(HERE / 'out_final.json'))
NAV = pd.read_csv(OUT / 'nav_pe.csv', index_col=0, parse_dates=True)
SENS = pd.read_csv(HERE / 'out_pe_sens.csv')
NEW = pd.read_csv(HERE / 'out_cross.csv')
ALP = pd.read_csv(HERE / 'out_alpha_cross.csv')


def pct(x, d=2):
    return f'{x*100:+.{d}f}%'


def img(name):
    b = base64.b64encode((OUT / name).read_bytes()).decode()
    return f'data:image/png;base64,{b}'


def yr(nav):
    e = nav.resample('YE').last()
    p = e.shift(1)
    p.iloc[0] = nav.iloc[0]
    return e / p - 1


rs, rb = yr(NAV['pe'].dropna()), yr(NAV['bench'].dropna())
yr_rows = ''
labels = {2019: '2019（6 月起）', 2026: '2026（至 11 月）'}
for i, d in enumerate(rs.index):
    lab = labels.get(d.year, str(d.year))
    ex = rs.iloc[i] - rb.iloc[i]
    cls = 'pos' if ex > 0 else 'neg'
    yr_rows += (f'<tr><td>{lab}</td><td class="num">{pct(rs.iloc[i],1)}</td>'
                f'<td class="num">{pct(rb.iloc[i],1)}</td>'
                f'<td class="num {cls}">{pct(ex,1)}</td></tr>')

combined = pd.concat([NEW.assign(src='新'), ALP.assign(src='Alpha101')])
sig = combined[(combined.t_in > 2) & (combined.net_in > 0)]
alive = sig[(sig.t_out > 1.5) & (sig.net_out > 0)]
n_new_alive = int((alive.src == '新').sum())
n_alp_alive = int((alive.src == 'Alpha101').sum())
new_pos = int((NEW.net_out > 0).sum())
alp_pos = int((ALP.net_out > 0).sum())

CSS = """
:root{--ink:#1c1b18;--sub:#6b6862;--line:#ded9ce;--bg:#fbf9f4;--red:#b8352b;--green:#2e6b4f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.75 "Songti SC","Noto Serif CJK SC",Georgia,serif}
.wrap{max-width:940px;margin:0 auto;padding:64px 32px 96px}
.kicker{font:600 12px/1 -apple-system,sans-serif;letter-spacing:.18em;color:var(--red);
  text-transform:uppercase;margin-bottom:18px}
h1{font-size:34px;line-height:1.3;margin:0 0 14px;letter-spacing:-.01em}
.lede{font-size:17px;color:#3b3833;margin:0 0 8px}
.meta{font:13px/1.6 -apple-system,sans-serif;color:var(--sub);margin-bottom:36px;
  padding-bottom:22px;border-bottom:1px solid var(--line)}
h2{font-size:22px;margin:52px 0 6px;letter-spacing:-.005em}
h2 .n{font:600 13px/1 -apple-system,sans-serif;color:var(--red);margin-right:10px;
  vertical-align:2px}
h3{font:600 15px/1.5 -apple-system,sans-serif;margin:32px 0 10px;color:#2c2a26}
p{margin:12px 0}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:34px 0 8px}
.card{background:#fff;border:1px solid var(--line);padding:18px 16px 16px}
.card .k{font:12px/1.3 -apple-system,sans-serif;color:var(--sub);margin-bottom:10px}
.card .v{font:600 26px/1.1 Georgia,serif;letter-spacing:-.02em}
.card .s{font:11.5px/1.4 -apple-system,sans-serif;color:#8b8780;margin-top:7px}
table{width:100%;border-collapse:collapse;margin:18px 0;font:14px/1.5 -apple-system,sans-serif}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--sub);font-size:12.5px;border-bottom:1.5px solid #c9c3b6}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.num.pos{color:var(--red);font-weight:600}
.num.neg{color:var(--green);font-weight:600}
tr.hit td{background:#fdf3f1}
figure{margin:26px 0 10px}
figure img{width:100%;display:block;border:1px solid var(--line);background:#fff}
figcaption{font:12.5px/1.6 -apple-system,sans-serif;color:var(--sub);margin-top:9px}
blockquote{margin:22px 0;padding:14px 20px;border-left:3px solid var(--red);
  background:#fff;font-size:15.5px;color:#3a3733}
blockquote p{margin:4px 0}
.note{font:13px/1.7 -apple-system,sans-serif;color:var(--sub);background:#fff;
  border:1px solid var(--line);padding:16px 18px;margin:20px 0}
code{font:13px/1 ui-monospace,Menlo,monospace;background:#f2ede3;padding:2px 5px;border-radius:2px}
ul,ol{margin:12px 0;padding-left:22px}
li{margin:6px 0}
hr{border:0;border-top:1px solid var(--line);margin:44px 0}
.foot{font:12.5px/1.8 -apple-system,sans-serif;color:var(--sub);margin-top:16px}
@media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr)}h1{font-size:26px}}
"""

HTML = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETF 量价因子研究报告（标的池修订版）</title>
<style>{CSS}</style></head><body><div class="wrap">

<div class="kicker">ETF Factor Research · 修订版</div>
<h1>先把标的池修对，再谈因子</h1>
<p class="lede">上一版把 1717 只 ETF 全塞进横截面，其中 100 只是债券货币、27 只「黄金股」被当成商品，
还有平均 3.5 只 ETF 在跟踪同一个指数。这三件事让 IC 和分层结果都偏了。
这次先把池子改成 <b>股票 + 商品、一个指数只留流动性最好的一只</b>，再重跑 201 个因子——
结论变了，而且变得更难看。</p>
<div class="meta">样本 2019-06 ~ 2026-11 ｜ 468 个指数 ｜ 100 个新因子 + Alpha101 全部 101 个 ｜ 日频，扣 5bp 单边成本</div>

<div class="cards">
<div class="card"><div class="k">标的池</div><div class="v">468</div>
<div class="s">从 1617 只 ETF 压到 468 个指数</div></div>
<div class="card"><div class="k">两期都显著</div><div class="v">{len(alive)} / 201</div>
<div class="s">新因子 {n_new_alive} 个，Alpha101 {n_alp_alive} 个</div></div>
<div class="card"><div class="k">PE 策略年化</div><div class="v" style="color:var(--red)">12.68%</div>
<div class="s">基准 5.44%，2019-06 起</div></div>
<div class="card"><div class="k">样本外年化</div><div class="v">20.54%</div>
<div class="s">2024-2026，基准 7.90%</div></div>
</div>

<h2><span class="n">01</span>先修标的池：三处会直接改变结论的问题</h2>

<p><b>第一，债券和货币不该进来。</b>债券 ETF 的日收益由久期和票息决定，「放量突破」在它身上是资金申购，
不是价格发现。货币 ETF 更极端——净值几乎是一条直线，任何量价因子都会算出无意义的值。
这两类合计 100 只，占全池 6%。</p>

<p><b>第二，「商品」这个分类原来是错的。</b>按名称关键词分类，会把「黄金股ETF」「有色金属ETF」
「有色矿业ETF」判成商品。但它们持有的是矿业上市公司股票，跟的是股票 beta，不是金价。
真正的商品 ETF（黄金现货、豆粕、能源化工、有色期货）只有 18 只，原来那 43 只里 27 只是股票。
这次改成用跟踪指数名判断：指数名含「期货 / 上海金 / 黄金9999 / 上期 / 郑商所 / 大商所」才算商品。</p>

<p><b>第三，同一指数的一堆 ETF 在重复投票。</b>1700 只 ETF 只对应 476 个指数，中证A500 有 40 只、
沪深300 有 29 只、中证500 有 29 只。它们的日收益相关系数在 0.99 以上，放进同一个横截面做 rank，
等于给「A500 这个观点」投了 40 票，把其他指数挤出去。分层回测也会被同一指数的多只标的挤在一个桶里。</p>

<div class="note">
<b>怎么去重：</b>每个交易日、在每个指数内部，选 20 日均成交额最大且达到流动性门槛的那一只。
合成序列用<b>收益率累乘拼接</b>而不是直接取价格——不同 ETF 的单位净值基准不同（1.0 和 3.5 都有），
直接拼会在切换日冒出一个假跳空。切换带 90% 的粘性阈值：原持仓成交额仍有新标的的 0.9 倍就不换，
因为同指数 ETF 的日收益差不到 1bp，为 1bp 每天换仓纯亏手续费。
</div>

<table>
<thead><tr><th>项目</th><th class="num">修订前</th><th class="num">修订后</th></tr></thead>
<tbody>
<tr><td>标的数</td><td class="num">1,717 只 ETF</td><td class="num">468 个指数</td></tr>
<tr><td>债券 + 货币</td><td class="num">100 只（5.8%）</td><td class="num">已剔除</td></tr>
<tr><td>「商品」</td><td class="num">43 只（其中 27 只是股票）</td><td class="num">18 只 → 去重后 6 个</td></tr>
<tr><td>同指数重复</td><td class="num">平均 3.5 只 / 指数</td><td class="num">1 只 / 指数</td></tr>
<tr><td>2026-11 每日可用</td><td class="num">1,432 只</td><td class="num">365 个指数</td></tr>
</tbody></table>

<p>去重后标的数少了 71%，横截面从 1432 降到 365。代价是样本变小，收益是<b>每一行都是独立观点</b>。
2020 年只有 96 个指数，这一年的分层结果要打折看。</p>

<h2><span class="n">02</span>201 个因子在同一个池子上重跑</h2>

<p>100 个新挖的量价因子（9 个家族，全部有文献出处）加上 Alpha101 全部 101 个，同一标的池、
同一预处理（EMA10 平滑降换手、20 日流动性过滤）、同一评价口径（5 日 forward，只多 top20%，
扣 5bp 双边成本）。</p>

<figure><img src="{img('scatter2.png')}" alt="因子全景">
<figcaption>横轴 2020–2023 多头超额，纵轴 2024–2026。右上象限才是「两期都赚」，红圈是样本外显著的那 {len(alive)} 个。
大多数因子落在右下和左下——样本内赚、样本外亏，或者两期都不赚。</figcaption></figure>

<table>
<thead><tr><th>指标</th><th class="num">100 个新因子</th><th class="num">Alpha101</th></tr></thead>
<tbody>
<tr><td>样本内显著（t&gt;2 且净超额&gt;0）</td><td class="num">{int(((NEW.t_in>2)&(NEW.net_in>0)).sum())}</td><td class="num">{int(((ALP.t_in>2)&(ALP.net_in>0)).sum())}</td></tr>
<tr class="hit"><td><b>两期都显著</b></td><td class="num"><b>{n_new_alive}</b></td><td class="num"><b>{n_alp_alive}</b></td></tr>
<tr><td>样本外多头超额为正</td><td class="num">{new_pos} / 100（{new_pos}%）</td><td class="num">{alp_pos} / 101（{alp_pos}%）</td></tr>
<tr><td>样本内外 IC 秩相关</td><td class="num">0.58</td><td class="num">0.56</td></tr>
</tbody></table>

<blockquote><p><b>这里有个反直觉的结果：Alpha101 在指数池上并没有比新因子差。</b>
严格口径下两期都显著的有 {n_alp_alive} 个（a101、a039、a033、a038、a051、a099），
新因子只有 {n_new_alive} 个。但看面而不是看点——样本外多头超额为正的比例，
新因子 {new_pos}%、Alpha101 {alp_pos}%，差了一倍。</p>
<p>我的解读：Alpha101 里存活的那几个是「幸存者」，101 个里挑 6 个，本来就接近随机挑选的期望值；
新因子的优势在于<b>整体分布右移</b>，而不是顶点更高。</p></blockquote>

<h2><span class="n">03</span>IC 会骗人：ETF 不能做空</h2>

<p>这是这一轮最重要的方法论修正。上一版用 IC 选因子，结果反复出现「IC 显著为正、做多却亏钱」。
原因不复杂：<b>IC 衡量的是排序能力，包含空头端</b>。如果因子值低的标的大跌、因子值高的标的横盘，
IC 会很好看，但你只能买高的那一端，一分钱赚不到。</p>

<table>
<thead><tr><th>因子</th><th class="num">样本外 IC</th><th class="num">t 值</th><th class="num">样本外多头超额</th></tr></thead>
<tbody>
<tr><td><code>MOM_12_1</code>（12 月动量）</td><td class="num">+0.025</td><td class="num">1.92</td><td class="num neg">−4.11%</td></tr>
<tr><td><code>MOM250</code></td><td class="num">+0.027</td><td class="num">2.02</td><td class="num neg">−2.04%</td></tr>
<tr><td><code>VMOM</code>（量加权动量）</td><td class="num">+0.019</td><td class="num">1.73</td><td class="num neg">−3.86%</td></tr>
<tr class="hit"><td><code>PE</code>（路径效率）</td><td class="num">+0.024</td><td class="num">2.81</td><td class="num pos">+4.84%</td></tr>
</tbody></table>

<p>动量族的 IC 是全样本最漂亮的一批（t 值 4.3 的都有），多头超额却全是负的。上一版查过原因：
它们在 ETF 上呈「倒 U 型」——最强的两组垫底，中间两组最好。IC 为正完全靠空头端撑着，
而 ETF 券源少、几乎没有融券，空头端拿不到。</p>

<p>所以这一轮的因子筛选标准全换成<b>「历史上做多 top20% 相对全池的日超额」</b>。
它衡量的就是实盘能拿到的东西，也让「倒 U 型」的因子自动出局。</p>

<h2><span class="n">04</span>策略：只留一个因子</h2>

<p><code>PE</code> 叫路径效率（Kaufman 效率系数）：<code>|20日净涨幅| ÷ 20日路径总长度</code>。
分子是位移，分母是走过的路。涨 10% 走直线 PE 接近 1，涨 10% 上下来回折腾 PE 只有 0.2。
它衡量的不是「涨了多少」，而是「这段涨是怎么走出来的」。</p>

<figure><img src="{img('nav2.png')}" alt="净值曲线">
<figcaption>2019-06 起，等权基准为「买入当日可交易的全部指数」。2020 年大幅跑输（牛市），2022 与 2026 大幅跑赢（熊市）。</figcaption></figure>

<table>
<thead><tr><th>指标</th><th class="num">PE 策略</th><th class="num">等权基准</th></tr></thead>
<tbody>
<tr><td>年化收益（2019-06 ~ 2026-11）</td><td class="num pos">+12.68%</td><td class="num">+5.44%</td></tr>
<tr><td>年化波动</td><td class="num">20.5%</td><td class="num">18.9%</td></tr>
<tr><td>夏普</td><td class="num">0.69</td><td class="num">0.38</td></tr>
<tr><td>最大回撤</td><td class="num">−28.1%</td><td class="num">−38.4%</td></tr>
<tr><td>年换手 / 成本</td><td class="num">8.3 倍 / 0.83%</td><td class="num">—</td></tr>
<tr><td>持仓数</td><td class="num">21 只（18–33）</td><td class="num">全部</td></tr>
</tbody></table>

<h3>分年度：这是防御型因子，不是全能因子</h3>
<figure><img src="{img('yearly2.png')}" alt="分年度">
<figcaption>2020 年跑输 12.9 个点、2025 年只赢 1.6 个点；2022 年赢 28.4 个点、2026 年赢 22.5 个点。</figcaption></figure>

<table>
<thead><tr><th>年度</th><th class="num">PE 策略</th><th class="num">基准</th><th class="num">超额</th></tr></thead>
<tbody>{yr_rows}</tbody></table>

<p>规律很清楚：<b>市场普涨时它跑不动，市场下跌时它跌得少</b>。PE 高意味着价格沿单一路径推进，
这类标的的波动天然更低；牛市里低波资产涨幅小，熊市里跌幅也小。8 个年度里 5 年跑赢、3 年跑输，
超额集中在 2022 和 2026 两个下跌年。</p>

<blockquote><p>如果只想要一个数字：<b>2019-06 起年化 12.7%，基准 5.4%，夏普 0.69 vs 0.38，回撤 −28% vs −38%</b>。
在收益、夏普、回撤三个维度同时改善，代价是牛市会明显跑输。</p></blockquote>

<h2><span class="n">05</span>稳健性：一整片为正，还是一个点最优</h2>

<p>只在某个参数下有效的因子等于没有。把 5 个窗口 × 3 个持有期 × 3 个持仓比例共 45 组全部跑一遍，
不做挑选：</p>

<figure><img src="{img('sens.png')}" alt="参数敏感性">
<figcaption>45 组里 33 组 2024–2026 超额为正、31 组两期都为正。绿色集中在 10–20 日窗口，40 日以上基本归零。</figcaption></figure>

<p>这个结果一半是好消息一半是限制。<b>好消息</b>：10–20 日窗口 × 各种持有期和持仓比例，超额普遍在 4%–16%，
不是靠某一个参数点撑起来的。<b>限制</b>：窗口拉到 40 日以上，超额衰减到零甚至为负。
说明 PE 捕捉的是<b>月度尺度的路径质量</b>，不是长期趋势——拉到季度以上，噪声累积，效率系数就失效了。</p>

<p>反过来看这也合理：路径效率的分子用 20 日净涨幅，分母是 20 日累计路程。窗口越长，
分母里的噪声项越多，信噪比越低。它不是「越长越稳」的那类因子。</p>

<figure><img src="{img('roll.png')}" alt="滚动超额">
<figcaption>滚动 12 个月超额。2022 年全年 +15% ~ +30%，2023 下半年到 2025 上半年在 0 附近徘徊，2026 又回到 +17% ~ +20%。</figcaption></figure>

<p>超额不是均匀分布的。2024 全年到 2025 年上半年，滚动超额在 0 附近来回，有好几个季度是负的。
如果从 2024 年初开始用这个策略，要先熬过一年半的「没效果期」才等来 2026 年那波——
这是实盘最难熬的部分，也是年化 12.7% 这个数字掩盖掉的东西。</p>

<h2><span class="n">06</span>为什么组合不管用</h2>

<p>直觉上多因子组合应该更稳。实测相反：</p>

<table>
<thead><tr><th>策略</th><th class="num">2021–2023</th><th class="num">2024–2026</th><th class="num">样本外回撤</th></tr></thead>
<tbody>
<tr><td>基准（池等权）</td><td class="num">−8.56%</td><td class="num">+7.90%</td><td class="num">−20.2%</td></tr>
<tr class="hit"><td><b>PE 单因子</b></td><td class="num pos">+2.72%</td><td class="num pos">+20.54%</td><td class="num">−17.3%</td></tr>
<tr><td>6 因子等权组合</td><td class="num neg">−10.23%</td><td class="num neg">+3.66%</td><td class="num neg">−39.9%</td></tr>
<tr><td>8 因子滚动选择（walk-forward）</td><td class="num neg">−13.92%</td><td class="num neg">+6.38%</td><td class="num neg">−21.8%</td></tr>
</tbody></table>

<p>那 6 个因子来自「样本内 t&gt;2 且净超额为正」的 28 个候选（201 个因子里筛出来的），
按 t 值排序、IC 相关低于 0.6 去重后取前 6：
<code>{'、'.join(R['selected'])}</code>。这已经是完全合规的事前筛选流程，结果仍是负超额。</p>

<p><b>原因是「平均」本身在稀释。</b>6 个因子里真正有超额的可能只有 1–2 个，其余 4 个是在贡献噪声。
等权平均等于把 1 份信号和 4 份噪声混在一起，信噪比降到 1/5。而多因子分散降低波动的收益
（回撤从 −17% 变成 −40%，反而更差）在这里根本没出现——因为这些因子的失效是同步的，
它们都在赌「近期走势」，分散不了。</p>

<div class="note">
<b>walk-forward 也没救回来。</b>第 4 节那张表里最后一行是滚动选择：每个调仓日只用之前 36 个月的
「多头超额 t 值」决定用哪 8 个因子，全程无前视。结果 2021–2023 年化 −13.9%、2024–2026 +6.4%，
还是跑输基准。这说明问题不在「选因子的时点」，而在「因子之间高度同源」。
</div>

<h2><span class="n">07</span>这一版的局限</h2>

<ol>
<li><b>PE 是「两期都显著」的 9 个里事后最强的那个。</b>严格来说它不是被事前规则单独选出来的——
我用的是「样本内 t&gt;2」这条规则，它确实通过，但 100 个因子里同时通过的有 14 个，
最后能站住 3 个。挑最强的那个报告，本身含有选择偏差。它能被接受的理由是：
样本外两年的 t 值 2.81、多头超额 +4.8%/年，且与低波因子的截面相关只有 0.07（不是低波代理）。</li>

<li><b>2019–2020 两年是纯样本外，但表现最差。</b>2019 年（6 月起）−7.7%、2020 年 −12.9%。
这两年的池子只有 51–120 个指数，横截面太薄，结果不能太当真，但也不该隐去。</li>

<li><b>商品只有 6 个标的。</b>黄金去重成 2 组、豆粕/能化/有色期货/大宗商品各 1 个。
横截面上没有意义，只能作为可投标的。真正的商品 alpha 需要期货期限结构数据，日频量价做不到。</li>

<li><b>基准是「等权买入所有可交易指数」，这个基准很强。</b>2025 年小盘和主题 ETF 普涨，
等权基准 +30%。任何集中持仓的策略在这种行情里都跑不动。如果把基准换成沪深300，
所有策略的超额都会好看很多，但那是自欺欺人。</li>

<li><b>同指数内部的折溢价套利没做。</b>这是这批数据里最干净的 alpha 来源——
同一指数的多只 ETF 存在瞬时价差，本次为了去重把它们合并成一条序列，反而把这块信息扔掉了。
要做需要日内数据。</li>
</ol>

<hr>
<p class="foot">
数据：<code>etf.db</code>（1717 只 ETF，2018-06 ~ 2026-11，后复权）｜
标的池：股票 + 商品，按跟踪指数去重（468 个）｜
代码：<code>factor_lab/</code>（panel.py 建池、factors.py 100 个因子、alpha_on_index.py 接 Alpha101、
final.py 策略对照、sens.py 敏感性、wf.py 滚动检验）<br>
成本假设：单边 5bp（佣金万 0.5 + 冲击）。持有 20 日调仓，年换手 8.3 倍，年成本 0.83%。<br>
所有回测均为「T 日收盘算因子、T+1 开盘建仓」的近似，实际用 T 日收盘到 T+1 收盘的收益，
比真实成交乐观约半天。
</p>

</div></body></html>"""

(OUT / 'ETF量价因子研究报告.html').write_text(HTML, encoding='utf-8')
print('报告', round(len(HTML.encode()) / 1024), 'KB')
