"""诊断：每个因子单独做多的绝对收益，以及「组内 rank」与「全局 rank」的差异。

组合跑不动时，必须先分清是「没有信号」还是「信号被组合方式稀释了」。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
sys.path.insert(0, str(ROOT / 'alpha'))
sys.path.insert(0, str(ROOT / 'factor_lab'))

from panel import load_universe                          # noqa: E402
from factors import FACTORS, compute_all                 # noqa: E402
from alpha101 import Alpha101                            # noqa: E402
from evaluate import smooth, group_rank, mask_valid       # noqa: E402
from portfolio import backtest                           # noqa: E402

HL = 10
SEGS = [('21-23', '2021-01-01', '2023-12-31'), ('24-26', '2024-01-01', '2026-11-03')]

P = load_universe()
fs = dict(compute_all(P, verbose=False))
data = dict(open=P.open, high=P.high, low=P.low, close=P.close,
            volume=P.volume, amount=P.amount)
for k, v in Alpha101(data, P.group).compute_all().items():
    fs[k] = v.astype(np.float32)
print('因子', len(fs))

t0 = time.time()
ranks_g, ranks_i = {}, {}
for k, v in fs.items():
    f = mask_valid(smooth(v, HL), P)
    ranks_g[k] = f.rank(axis=1, pct=True)                 # 全局
    ranks_i[k] = group_rank(f, P.group, min_n=4)          # 组内
print(f'rank {time.time()-t0:.0f}s')

rows = []
for k in fs:
    r = dict(factor=k,
             fam=FACTORS[k]['family'] if k in FACTORS else 'Alpha101')
    for tag, s, e in SEGS:
        for mode, rk in (('g', ranks_g), ('i', ranks_i)):
            bt = backtest(rk[k], P, hold=20, top_pct=0.20, start=s, end=e)
            r[f'{tag}_{mode}'] = bt['stat']['ann']
            r[f'{tag}_b'] = bt['stat_bench']['ann']
    rows.append(r)

df = pd.DataFrame(rows)
df['ex21'] = df['21-23_g'] - df['21-23_b']
df['ex24'] = df['24-26_g'] - df['24-26_b']
df['ex21i'] = df['21-23_i'] - df['21-23_b']
df['ex24i'] = df['24-26_i'] - df['24-26_b']
df.to_csv('out_single_abs.csv', index=False)

print(f'\n基准：2021-2023 {df["21-23_b"].iloc[0]:+.2%}  2024-2026 {df["24-26_b"].iloc[0]:+.2%}')
for m, col in (('全局', 'ex24'), ('组内', 'ex24i')):
    sub = df.sort_values(col, ascending=False)
    print(f'\n[{m} rank] 2024-2026 超额 top10')
    print(sub.head(10)[['factor', 'fam', 'ex21i' if m == '组内' else 'ex21', col]].to_string(index=False))
    print(f'  两期都为正: {int(((df[col] > 0) & (df["ex21i" if m=="组内" else "ex21"] > 0)).sum())} / {len(df)}')

print(f'\n耗时 {time.time()-t0:.0f}s')
