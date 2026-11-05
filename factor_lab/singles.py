"""
单因子只多回测（样本外）
========================
组合失效不代表每个因子都失效。逐个测「只用这一个因子选 top 20%」，
用修正后的真实日频口径，看谁能在 2024-2026 跑赢同口径可交易池等权。
"""
import numpy as np
import pandas as pd

from panel import load_universe
from factors import FACTORS, compute_all
from evaluate import forward_return, smooth, group_rank, mask_valid, ic_series, ic_stats
from portfolio import backtest, yearly

TRAIN = ('2020-01-01', '2023-12-31')
TEST = ('2024-01-01', '2026-11-03')

P = load_universe()
fs = compute_all(P, verbose=False)
fwd = forward_return(P)

# 基准
b = backtest(pd.DataFrame(1.0, index=P.close.index, columns=P.close.columns),
             P, hold=5, top_pct=0.1, start=TEST[0], end=TEST[1])
bs = b['stat_bench']
print(f"可交易池等权（样本外）: 年化 {bs['ann']:+.2%} 夏普 {bs['sharpe']:.2f} "
      f"波动 {bs['vol']:.1%} 回撤 {bs['mdd']:.1%}")
print(f"平均可选标的数 {b['holding'] / 0.1:.0f}\n")

rows = []
for nm, sp in FACTORS.items():
    sgn = sp['direction']
    fr = group_rank(mask_valid(smooth(fs[nm] * sgn, 10), P), P.group)
    for tp in (0.1, 0.2):
        bt = backtest(fr, P, hold=10, top_pct=tp, start=TEST[0], end=TEST[1])
        st = bt['stat']
        rows.append(dict(factor=nm, family=sp['family'], top=tp,
                         ann=st['ann'], sharpe=st['sharpe'], mdd=st['mdd'],
                         vol=st['vol'], ex=st['ann'] - bs['ann'],
                         to=bt['to'], holding=bt['holding']))

df = pd.DataFrame(rows)
g = df[df.top == 0.2].sort_values('ann', ascending=False)
g.to_csv('out_single_oos.csv', index=False)
print('===== 样本外 单因子只多 top20%（hold=10） =====')
print(f'{"因子":15}{"家族":11}{"年化":>8}{"超额":>8}{"夏普":>7}{"回撤":>8}{"换手":>7}{"持仓":>6}')
for _, x in g.head(20).iterrows():
    print(f'{x.factor:15}{x.family:11}{x.ann:8.2%}{x.ex:8.2%}{x.sharpe:7.2f}{x.mdd:8.1%}{x.to:7.1f}{x.holding:6.0f}')
print('\n--- 垫底 5 个 ---')
for _, x in g.tail(5).iterrows():
    print(f'{x.factor:15}{x.family:11}{x.ann:8.2%}{x.ex:8.2%}{x.sharpe:7.2f}{x.mdd:8.1%}{x.to:7.1f}{x.holding:6.0f}')
