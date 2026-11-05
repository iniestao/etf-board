"""生成报告图表与 HTML。"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

import matplotlib.font_manager as fm
fm.fontManager.addfont('/tmp/NotoSansCJKsc-Regular.ttf')
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

OUT = Path('/workspace/etf_report')
OUT.mkdir(exist_ok=True)
HERE = Path(__file__).parent

C_RED, C_GRN, C_BLUE, C_GREY = '#c0392b', '#1e8e5a', '#2c5f8a', '#8a8a8a'

res = json.load(open(HERE / 'out_result.json'))
nav = pd.read_csv(HERE / 'out_nav.csv', index_col=0, parse_dates=True)
cross = pd.read_csv(HERE / 'out_cross.csv')
single = pd.read_csv(HERE / 'out_single_oos.csv')
train_tab = pd.read_csv(HERE / 'out_train.csv')

# 拼接连续净值
s_tr = nav['train'].dropna()
s_te = nav['test'].dropna()
b_tr = nav['train_bench'].dropna()
b_te = nav['test_bench'].dropna()
s_all = pd.concat([s_tr, s_te])
b_all = pd.concat([b_tr, b_te])
split = s_te.index[0]

# ---------------------------------------------------------------- 图1 净值
fig, ax = plt.subplots(figsize=(11, 4.6))
ax.plot(s_all.index, s_all.values, color=C_RED, lw=1.6, label='策略（样本外为实盘口径）')
ax.plot(b_all.index, b_all.values, color=C_GREY, lw=1.2, ls='--', label='股票型 ETF 等权基准')
ax.axvline(split, color=C_BLUE, lw=1, ls=':')
ax.axvspan(s_all.index[0], split, color='#f0f0f0', alpha=0.5, zorder=0)
lo, hi = ax.get_ylim()
ax.text(s_all.index[0], lo + (hi - lo) * 0.03, '  样本内（训练）', fontsize=9, color='#555')
ax.text(split, lo + (hi - lo) * 0.03, '  样本外（未参与任何选择）', fontsize=9, color=C_BLUE)
ax.set_ylabel('净值（起点=1）')
ax.legend(loc='upper left', frameon=False, fontsize=9)
ax.grid(alpha=0.25)
ax.spines[['top', 'right']].set_visible(False)
ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
plt.tight_layout()
plt.savefig(OUT / 'nav.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 图2 IC 散点
fig, ax = plt.subplots(figsize=(6.4, 5.4))
sig = (cross.t_in > 2) & (cross.net_in > 0)
okout = (cross.t_out > 1.5) & (cross.net_out > 0)
alive = sig & okout
ax.scatter(cross.loc[~(sig | okout), 'ic_in'], cross.loc[~(sig | okout), 'ic_out'], s=16,
           color='#c9c9c4', alpha=0.7, label=f'两期均不显著（{int((~(sig | okout)).sum())} 个）')
ax.scatter(cross.loc[sig & ~okout, 'ic_in'], cross.loc[sig & ~okout, 'ic_out'], s=26,
           color=C_GREY, alpha=0.85, label=f'样本内显著、样本外失效（{int((sig & ~okout).sum())} 个）')
ax.scatter(cross.loc[okout & ~sig, 'ic_in'], cross.loc[okout & ~sig, 'ic_out'], s=26,
           color='#d9a441', alpha=0.9, label=f'样本内看不出、样本外有效（{int((okout & ~sig).sum())} 个）')
ax.scatter(cross.loc[alive, 'ic_in'], cross.loc[alive, 'ic_out'], s=95,
           color=C_RED, alpha=0.95, edgecolor='#7b1f14', lw=0.8,
           label=f'两期都显著（{int(alive.sum())} 个）', zorder=4)
lim = [min(cross.ic_in.min(), cross.ic_out.min()) - 0.005,
       max(cross.ic_in.max(), cross.ic_out.max()) + 0.005]
ax.plot(lim, lim, color='#333', lw=0.8, ls='--', alpha=0.6)
ax.axhline(0, color='#bbb', lw=0.7)
ax.axvline(0, color='#bbb', lw=0.7)
mark = cross[alive].copy()
mark = pd.concat([mark, cross[sig & ~okout].nlargest(2, 't_in'),
                  cross[okout & ~sig].nlargest(2, 'net_out')])
for j, (_, r) in enumerate(mark.iterrows()):
    dy, dy2 = (6, 2) if j % 2 == 0 else (-11, 2)
    ax.annotate(r.factor, (r.ic_in, r.ic_out), fontsize=8,
                xytext=(dy, dy2), textcoords='offset points',
                color=C_RED if (r.t_in > 2 and r.net_in > 0 and r.t_out > 1.5 and r.net_out > 0) else '#444')
ax.set_xlabel('样本内 IC（2020–2023）')
ax.set_ylabel('样本外 IC（2024–2026）')
ax.legend(frameon=False, fontsize=8, loc='lower right')
ax.grid(alpha=0.2)
ax.spines[['top', 'right']].set_visible(False)
ax.set_title('样本内外是否重叠：虚线以上为样本外变强', fontsize=10)
plt.tight_layout()
plt.savefig(OUT / 'ic_scatter.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 图3 单因子样本外
g = single[single.top == 0.2].sort_values('ex', ascending=False)
top = pd.concat([g.head(12), g.tail(6)])
fig, ax = plt.subplots(figsize=(10, 4.8))
colors = [C_RED if v > 0 else C_GRN for v in top.ex]
ax.bar(range(len(top)), top.ex * 100, color=colors, alpha=0.85)
ax.set_xticks(range(len(top)))
ax.set_xticklabels(top.factor, rotation=45, ha='right', fontsize=7.5)
ax.axhline(0, color='#333', lw=0.8)
ax.set_ylabel('相对基准年化超额（%）')
ax.set_title('单因子只多 top20%：样本外 2024–2026（红=跑赢，绿=跑输）', fontsize=10)
ax.grid(axis='y', alpha=0.25)
ax.spines[['top', 'right']].set_visible(False)
plt.tight_layout()
plt.savefig(OUT / 'single_oos.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 图4 分年度
# nav 存的是净值（cumprod），年收益必须用「年末净值 / 年初净值 - 1」，
# 直接 (1+nav).prod() 会算出 1e86。
def year_ret(navs: pd.Series) -> pd.Series:
    e = navs.resample('YE').last()
    prev = e.shift(1)
    prev.iloc[0] = navs.iloc[0]
    return e / prev - 1

rs = year_ret(s_te)
rb = year_ret(b_te)
yrs = [d.year for d in rs.index]
x = np.arange(len(yrs))
w = 0.36
fig, ax = plt.subplots(figsize=(7.6, 4.2))
ax.bar(x - w / 2, rs.values * 100, w, color=C_RED, alpha=0.88, label='策略')
ax.bar(x + w / 2, rb.values * 100, w, color=C_GREY, alpha=0.72, label='基准')
for i in range(len(yrs)):
    ax.text(i - w / 2, rs.values[i] * 100, f'{rs.values[i]*100:+.1f}', ha='center',
            va='bottom' if rs.values[i] > 0 else 'top', fontsize=8.5, color=C_RED)
    ax.text(i + w / 2, rb.values[i] * 100, f'{rb.values[i]*100:+.1f}', ha='center',
            va='bottom' if rb.values[i] > 0 else 'top', fontsize=8.5, color='#555')
ax.set_xticks(x)
ax.set_xticklabels([f'{y}' if i < len(yrs) - 1 else f'{y}（至11月）' for i, y in enumerate(yrs)])
ax.axhline(0, color='#333', lw=0.8)
ax.set_ylabel('年度收益（%）')
ax.legend(frameon=False, fontsize=9)
ax.grid(axis='y', alpha=0.25)
ax.spines[['top', 'right']].set_visible(False)
ax.set_title('分年度：2026 下跌市体现防御性', fontsize=10)
plt.tight_layout()
plt.savefig(OUT / 'yearly.png', dpi=150)
plt.close()

print('图已生成', list(p.name for p in OUT.glob('*.png')))
json.dump(dict(nav=s_all.resample('ME').last().round(4).to_dict(),
               bench=b_all.resample('ME').last().round(4).to_dict()), open(OUT / 'nav_series.json', 'w'))
print('完成')
