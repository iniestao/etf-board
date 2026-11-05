"""Alpha101 在指数池上的单因子统计，与 100 个新因子同口径。

口径与 out_cross.csv 完全一致：2020-2023 训练、2024-2026 检验、EMA10 平滑、
5 日 forward、组内 rank、只多 top20% 的超额扣 5bp 双边成本。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
sys.path.insert(0, str(ROOT / 'alpha'))
sys.path.insert(0, str(ROOT / 'factor_lab'))

from panel import load_universe                    # noqa: E402
from alpha101 import Alpha101                      # noqa: E402
from evaluate import evaluate as ev                # noqa: E402

P = load_universe()
data = dict(open=P.open, high=P.high, low=P.low, close=P.close,
            volume=P.volume, amount=P.amount)
alphas = Alpha101(data, P.group).compute_all()
print('Alpha101 产出', len(alphas))

# 方向不预设：Alpha101 论文的因子方向依赖于市场，用训练期 IC 符号定方向
d0 = {k: 1 for k in alphas}
a0 = ev(alphas, P, d0, '2020-01-01', '2023-12-31', halflife=10)
dirs = {r.factor: (1 if r.ic >= 0 else -1) for _, r in a0.iterrows()}

a = ev(alphas, P, dirs, '2020-01-01', '2023-12-31', halflife=10)
b = ev(alphas, P, dirs, '2024-01-01', '2026-11-03', halflife=10)

m = a[['factor', 'ic', 'icir', 't', 'net', 'ex_ann', 'to']].merge(
    b[['factor', 'ic', 'icir', 't', 'net', 'ex_ann', 'to']], on='factor',
    suffixes=('_in', '_out'))
m['family'] = 'Alpha101'
m = m[['factor', 'family', 'ic_in', 'icir_in', 't_in', 'net_in', 'to_in',
       'ic_out', 'icir_out', 't_out', 'net_out', 'to_out']]
m.sort_values('t_in', ascending=False).to_csv('out_alpha_cross.csv', index=False)

sig = m[(m.t_in > 2) & (m.net_in > 0)]
alive = sig[(sig.t_out > 1.5) & (sig.net_out > 0)]
print(f'\nAlpha101：样本内显著 {len(sig)}/101，两期都显著 {len(alive)}')
print(sig[['factor', 'ic_in', 't_in', 'net_in', 'ic_out', 't_out', 'net_out']].to_string(index=False))
print(f'\nIC 同号 {(m.ic_in.gt(0) == m.ic_out.gt(0)).mean():.0%}，'
      f'秩相关 {m[["ic_in","ic_out"]].corr(method="spearman").iloc[0,1]:.2f}')
print(f'样本外多头超额为正: {int((m.net_out > 0).sum())}/101')
