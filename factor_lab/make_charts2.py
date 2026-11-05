"""报告图表。"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, '/workspace/etf_board/factor_lab')
from panel import load_universe                    # noqa: E402
from factors import compute_all, FACTORS           # noqa: E402
from evaluate import smooth, mask_valid            # noqa: E402
from portfolio import backtest                     # noqa: E402

fm.fontManager.addfont('/tmp/NotoSansCJKsc-Regular.ttf')
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

OUT = Path('/workspace/etf_report')
OUT.mkdir(exist_ok=True)
C_RED, C_GREY, C_BLUE, C_ORG = '#b8352b', '#8a8a84', '#2f5f8a', '#c8873a'

# ---------------------------------------------------------------- 净值
P = load_universe()
fs = compute_all(P, verbose=False, names=['PE'])
pe = mask_valid(smooth(fs['PE'], 10), P).rank(axis=1, pct=True)
bt = backtest(pe, P, hold=20, top_pct=0.20, start='2019-06-01', end='2026-11-03')
nav, bmk = bt['nav'], bt['nav_bench']
pd.DataFrame({'pe': nav, 'bench': bmk}).to_csv(OUT / 'nav_pe.csv')
print('PE 年化 %.2f%% 基准 %.2f%% 夏普 %.2f 回撤 %.1f%%' % (
    bt['stat']['ann'] * 100, bt['stat_bench']['ann'] * 100,
    bt['stat']['sharpe'], bt['stat']['mdd'] * 100))

fig, ax = plt.subplots(figsize=(8.6, 4.4))
ax.plot(nav.index, nav.values, color=C_RED, lw=1.7, label='PE 策略')
ax.plot(bmk.index, bmk.values, color=C_GREY, lw=1.4, label='标的池等权基准')
ax.fill_between(nav.index, bmk.values, nav.values,
                where=nav.values >= bmk.values, color=C_RED, alpha=0.10)
ax.fill_between(nav.index, bmk.values, nav.values,
                where=nav.values < bmk.values, color=C_GREY, alpha=0.12)
ax.set_ylabel('净值（2019-06 = 1）')
ax.legend(frameon=False, loc='upper left', fontsize=9.5)
ax.grid(alpha=0.22)
ax.spines[['top', 'right']].set_visible(False)
ax.set_title('PE 单因子策略 vs 等权基准', fontsize=11)
for y in (2020, 2022, 2025):
    ax.axvline(pd.Timestamp(f'{y}-01-01'), color='#d8d5cc', lw=0.7, zorder=0)
plt.tight_layout()
plt.savefig(OUT / 'nav2.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 分年度
def yr(n):
    e = n.resample('YE').last()
    p = e.shift(1)
    p.iloc[0] = n.iloc[0]
    return e / p - 1

rs, rb = yr(nav), yr(bmk)
yrs = [d.year for d in rs.index]
x = np.arange(len(yrs))
w = 0.37
fig, ax = plt.subplots(figsize=(8.2, 4.0))
ax.bar(x - w / 2, rs.values * 100, w, color=C_RED, alpha=0.9, label='PE 策略')
ax.bar(x + w / 2, rb.values * 100, w, color=C_GREY, alpha=0.7, label='基准')
for i in range(len(yrs)):
    for v, off, c in ((rs.values[i], -w / 2, C_RED), (rb.values[i], w / 2, '#555')):
        ax.text(i + off, v * 100, f'{v*100:+.0f}', ha='center', fontsize=8,
                va='bottom' if v > 0 else 'top', color=c)
ax.set_xticks(x)
ax.set_xticklabels([f'{y}*' if (i == 0 or i == len(yrs) - 1) else f'{y}'
                    for i, y in enumerate(yrs)])
ax.axhline(0, color='#333', lw=0.8)
ax.set_ylabel('年度收益（%）')
ax.legend(frameon=False, fontsize=9)
ax.grid(axis='y', alpha=0.22)
ax.spines[['top', 'right']].set_visible(False)
ax.set_title('牛市跑输、熊市跑赢（* 为不完整年份）', fontsize=10)
plt.tight_layout()
plt.savefig(OUT / 'yearly2.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 因子全景散点
new = pd.read_csv('/workspace/etf_board/factor_lab/out_cross.csv')
alp = pd.read_csv('/workspace/etf_board/factor_lab/out_alpha_cross.csv')
fig, ax = plt.subplots(figsize=(7.4, 5.0))
for df, c, lab, s in ((alp, C_BLUE, 'Alpha101（101 个）', 26),
                      (new, C_ORG, '新挖因子（100 个）', 30)):
    ax.scatter(df.net_in * 100, df.net_out * 100, s=s, color=c, alpha=0.55,
               edgecolor='none', label=lab)
both = pd.concat([new, alp])
good = both[(both.t_in > 2) & (both.net_in > 0) & (both.net_out > 0) & (both.t_out > 1.5)]
ax.scatter(good.net_in * 100, good.net_out * 100, s=70, facecolor='none',
           edgecolor=C_RED, lw=1.5, label=f'两期都显著（{len(good)} 个）')
ax.axhline(0, color='#333', lw=0.8)
ax.axvline(0, color='#333', lw=0.8)
ax.set_xlabel('2020–2023 多头超额（%/年）')
ax.set_ylabel('2024–2026 多头超额（%/年）')
ax.legend(frameon=False, fontsize=8.5, loc='upper left')
ax.grid(alpha=0.2)
ax.spines[['top', 'right']].set_visible(False)
mark = good.nlargest(3, 'net_out')
mark = pd.concat([mark, good[good.factor == 'PE']]).drop_duplicates('factor')
offs = [(9, 6), (9, -13), (9, 5), (-26, -14)]
for j, (_, r) in enumerate(mark.iterrows()):
    ax.annotate(r.factor, (r.net_in * 100, r.net_out * 100), fontsize=8.5,
                xytext=offs[j % len(offs)], textcoords='offset points', color=C_RED)
ax.set_title('两期一致才有意义：右上象限只有 9 个', fontsize=10.5)
plt.tight_layout()
plt.savefig(OUT / 'scatter2.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 敏感性热力图
s = pd.read_csv('/workspace/etf_board/factor_lab/out_pe_sens.csv')
piv = s.pivot_table(index='win', columns=['hold', 'top'], values='ex_24-26') * 100
fig, ax = plt.subplots(figsize=(7.2, 3.6))
im = ax.imshow(piv.values, cmap='RdYlGn', vmin=-10, vmax=18, aspect='auto')
ax.set_xticks(range(piv.shape[1]))
ax.set_xticklabels([f'{h}d / {int(t*100)}%' for h, t in piv.columns], fontsize=8)
ax.set_yticks(range(len(piv.index)))
ax.set_yticklabels([f'{w} 日' for w in piv.index], fontsize=9)
for i in range(piv.shape[0]):
    for j in range(piv.shape[1]):
        v = piv.values[i, j]
        ax.text(j, i, f'{v:.0f}', ha='center', va='center', fontsize=8,
                color='#222' if abs(v) < 12 else 'white')
ax.set_xlabel('持有期 / 持仓比例')
ax.set_title('样本外超额（%/年）：只有 10–20 日窗口为正，长窗口衰减到零', fontsize=10)
plt.colorbar(im, ax=ax, shrink=0.8, label='%')
plt.tight_layout()
plt.savefig(OUT / 'sens.png', dpi=150)
plt.close()

# ---------------------------------------------------------------- 滚动超额
ex = (bt['net'] - bt['bench']).dropna()
roll = (ex.rolling(244).mean() * 244).dropna()
fig, ax = plt.subplots(figsize=(8.2, 3.2))
ax.plot(roll.index, roll.values * 100, color=C_RED, lw=1.6)
ax.fill_between(roll.index, 0, roll.values * 100,
                where=roll.values > 0, color=C_RED, alpha=0.18)
ax.fill_between(roll.index, 0, roll.values * 100,
                where=roll.values <= 0, color=C_GREY, alpha=0.22)
ax.axhline(0, color='#333', lw=0.8)
ax.set_ylabel('滚动 12 月超额（%/年）')
ax.grid(alpha=0.2)
ax.spines[['top', 'right']].set_visible(False)
ax.set_title('超额不是均匀的：2022 与 2026 贡献了大部分，2023–2025 接近零', fontsize=10)
plt.tight_layout()
plt.savefig(OUT / 'roll.png', dpi=150)
plt.close()

print('图已生成')
