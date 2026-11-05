"""Alpha101 在「指数级」标的池上重算。

Alpha101 原实现面向个股（1700 只），这里换成 468 个指数。差别不只是数量：
同一指数的 ETF 日收益相关 0.99，混在一起做横截面 rank 等于重复投票。
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

from panel import load_universe          # noqa: E402
from alpha101 import Alpha101            # noqa: E402

OUT = Path(__file__).parent / 'alpha101_index.parquet'


def compute(P) -> dict[str, pd.DataFrame]:
    data = dict(open=P.open, high=P.high, low=P.low, close=P.close,
                volume=P.volume, amount=P.amount)
    a = Alpha101(data, P.group)
    alphas = a.compute_all()
    if a.notes:
        print('降级说明:', a.notes)
    missing = [f'a{i:03d}' for i in range(1, 102) if f'a{i:03d}' not in alphas]
    if missing:
        print('未产出:', missing)
    return alphas


if __name__ == '__main__':
    t0 = time.time()
    P = load_universe()
    print(f'指数面板 {P.close.shape}')
    res = compute(P)
    print(f'成功 {len(res)}/101，{time.time()-t0:.0f}s')

    # 存成一张扁平的 parquet：行=日期，列=因子×指数
    big = pd.concat(res, axis=1)
    big.columns = [f'{a}|{c}' for a, c in big.columns]
    big.astype(np.float32).to_parquet(OUT, compression='zstd')
    print(f'{OUT.name} {OUT.stat().st_size/1e6:.0f}MB')
    cov = [(k, float(v.iloc[-1].notna().mean())) for k, v in res.items()]
    cov.sort(key=lambda x: x[1])
    print('末行覆盖率 最低5:', [(k, f'{r:.0%}') for k, r in cov[:5]])
    print('中位覆盖率 %.0f%%' % (np.median([x[1] for x in cov]) * 100))
