"""诊断 PE：单因子为什么比 8 因子组合好这么多。"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
sys.path.insert(0, str(ROOT / 'alpha'))
sys.path.insert(0, str(ROOT / 'factor_lab'))

from panel import load_universe                          # noqa: E402
from factors import FACTORS, compute_all                 # noqa: E402
from evaluate import smooth, group_rank, mask_valid      # noqa: E402
from portfolio import backtest, yearly                   # noqa: E402

P = load_universe()
fs = compute_all(P, verbose=False, names=['PE', 'ITS', 'RANGE_POS'])
ranks = {k: v.rank(axis=1, pct=True) for k, v in
         ((k, mask_valid(smooth(f, 10), P)) for k, f in fs.items())}

for k in ['PE', 'ITS', 'RANGE_POS']:
    bt = backtest(ranks[k], P, hold=20, top_pct=0.20, start='2021-01-01', end='2026-11-03',
                  target_vol=0.20)
    st = bt['stat']
    print(f'\n{k}: 年化 {st["ann"]:+.2%} 夏普 {st["sharpe"]:+.2f} 回撤 {st["mdd"]:+.1%} '
          f'换手 {bt["to"]:.1f} 持仓 {bt["holding"]:.0f}')
    yr = yearly(bt['net'], bt['bench'])
    print(yr.to_string(index=False))

# PE 的滚动 12 个月超额，看是否某一段贡献了全部
bt = backtest(ranks['PE'], P, hold=20, top_pct=0.20, start='2021-01-01', end='2026-11-03')
ex = (bt['net'] - bt['bench']).dropna()
roll = ex.rolling(244).mean() * 244
print('\nPE 滚动 12 月年化超额（季末抽样）')
print(roll.dropna().resample('QE').last().round(3).to_string())

# 绝对净值 vs 基准
print('\nPE 净值', round(float(bt['nav'].iloc[-1]), 3), '基准', round(float(bt['nav_bench'].iloc[-1]), 3))
print('年化', f'{bt["stat"]["ann"]:+.2%}', 'vs', f'{bt["stat_bench"]["ann"]:+.2%}')

# 换手成本
print('年换手 %.1f 倍，成本 %.2f%%/年' % (bt['to'], bt['to'] * 0.001 * 100))

# 持仓的组别分布
w = bt['w_avg']
last = w.iloc[-1].dropna()
print('\n末持仓组别', P.group.reindex(last.index).value_counts().to_dict())
