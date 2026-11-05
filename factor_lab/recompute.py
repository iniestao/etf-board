"""用统一（修正后）口径重算 100 个因子的样本内外统计。"""
import json

import pandas as pd

from panel import load_universe
from factors import FACTORS, compute_all
from evaluate import evaluate as ev

P = load_universe()
fs = compute_all(P, verbose=False)
dirs = {k: v['direction'] for k, v in FACTORS.items()}
fam = {k: v['family'] for k, v in FACTORS.items()}

print('样本内 2020-2023…', flush=True)
a = ev(fs, P, dirs, '2020-01-01', '2023-12-31', halflife=10)
print('样本外 2024-2026…', flush=True)
b = ev(fs, P, dirs, '2024-01-01', '2026-11-03', halflife=10)

m = a[['factor', 'ic', 'icir', 't', 'net', 'ex_ann', 'to']].merge(
    b[['factor', 'ic', 'icir', 't', 'net', 'ex_ann', 'to']], on='factor', suffixes=('_in', '_out'))
m['family'] = m.factor.map(fam)
m = m[['factor', 'family', 'ic_in', 'icir_in', 't_in', 'net_in', 'to_in',
       'ic_out', 'icir_out', 't_out', 'net_out', 'to_out']]
m.sort_values('t_in', ascending=False).to_csv('out_cross.csv', index=False)

sig = m[(m.t_in > 2) & (m.net_in > 0)]
alive = sig[(sig.t_out > 1.5) & (sig.net_out > 0)]
print(f'\n样本内显著 {len(sig)} 个，样本外存活 {len(alive)} 个（{len(alive)/len(sig):.0%}）')
print(alive[['factor', 'family', 'ic_in', 't_in', 'ic_out', 't_out', 'net_out']].to_string(index=False))
print(f'\nIC 同号 {(m.ic_in.gt(0)==m.ic_out.gt(0)).mean():.0%}，秩相关 {m[["ic_in","ic_out"]].corr(method="spearman").iloc[0,1]:.2f}')

json.dump(dict(sig_in=int(len(sig)), alive=int(len(alive)),
               alive_list=alive.factor.tolist()), open('out_counts.json', 'w'))
