"""PE 的稳健性检验：参数与窗口敏感性。

一个因子只在某个特定参数下有效，等于没有。这里把所有组合都列出来，
不做挑选——报告里的结论必须建立在「一整片区域都为正」而不是「一个点最优」上。
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

sys.path.insert(0, '/workspace/etf_board/factor_lab')
from panel import load_universe                    # noqa: E402
from evaluate import smooth, mask_valid            # noqa: E402
from portfolio import backtest                     # noqa: E402

P = load_universe()
r = P.close.pct_change(fill_method=None)


def pe(n: int) -> pd.DataFrame:
    net = P.close.pct_change(n, fill_method=None).abs()
    path = r.abs().rolling(n, min_periods=max(5, int(n * 0.75))).sum()
    return net.div(path.replace(0, np.nan))


segs = [('21-23', '2021-01-01', '2023-12-31'), ('24-26', '2024-01-01', '2026-11-03')]
rows = []
for n in (10, 20, 40, 60, 120):
    f = mask_valid(smooth(pe(n), 10), P).rank(axis=1, pct=True)
    for hold in (10, 20, 30):
        for top in (0.10, 0.20, 0.30):
            d = dict(win=n, hold=hold, top=top)
            for tag, s, e in segs:
                bt = backtest(f, P, hold=hold, top_pct=top, start=s, end=e)
                d[f'ann_{tag}'] = bt['stat']['ann']
                d[f'sharpe_{tag}'] = bt['stat']['sharpe']
                d[f'ex_{tag}'] = bt['stat']['ann'] - bt['stat_bench']['ann']
            rows.append(d)

df = pd.DataFrame(rows)
df.to_csv('out_pe_sens.csv', index=False)
print('窗口 × 持有 × 持仓比例的样本外年化超额（2024-2026）')
piv = df.pivot_table(index='win', columns=['hold', 'top'], values='ex_24-26')
print((piv * 100).round(1).to_string())
print('\n样本内（2021-2023）')
piv2 = df.pivot_table(index='win', columns=['hold', 'top'], values='ex_21-23')
print((piv2 * 100).round(1).to_string())
print(f'\n45 格里 2024-2026 超额为正: {int((df["ex_24-26"] > 0).sum())}/45')
print(f'两期都为正: {int(((df["ex_24-26"] > 0) & (df["ex_21-23"] > 0)).sum())}/45')
print(f'超额中位数 {df["ex_24-26"].median():+.2%}，最差 {df["ex_24-26"].min():+.2%}')
