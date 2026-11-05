"""样本外分层诊断：为什么有些因子 IC 为正但 top 组不赚钱。"""
import numpy as np
import pandas as pd

from panel import load_universe
from factors import FACTORS, compute_all
from evaluate import (forward_return, smooth, group_rank, mask_valid,
                      layered, perf_arith, ic_series)

P = load_universe()
fs = compute_all(P, verbose=False)
fwd = forward_return(P)
idx = P.date
m = (idx >= '2024-01-01') & (idx <= '2026-11-03')

CASES = ['MOM_12_1', 'MOM250', 'TURN_20_250', 'PE', 'ITS', 'BREAKOUT', 'RANGE_POS', 'TREND_R2']
for nm in CASES:
    sgn = FACTORS[nm]['direction']
    fr = group_rank(mask_valid(smooth(fs[nm] * sgn, 10), P), P.group).loc[m]
    fw = fwd.loc[m]
    lay = layered(fr, fw, nq=10)
    d = lay['layers']
    anns = [perf_arith(d[k])['ann'] for k in d.columns]
    allr = perf_arith(lay['allr'])['ann']
    ic = ic_series(fr, fw)
    print(f'\n{nm:12} IC={ic.mean():+.4f}  全池={allr:+.2%}  换手={None}')
    print('  ' + '  '.join(f'D{k}:{a:+.1%}' for k, a in zip(d.columns, anns)))
    top = np.mean(anns[8:]) - allr
    bot = np.mean(anns[:2]) - allr
    print(f'  top20% 超额 {top:+.2%}   bottom20% 超额 {bot:+.2%}   跨度 {top-bot:+.2%}')
