"""
1 日信号的交易成本核算
======================
hold_scan 发现 1 日持有期 IC 最高（均值 +0.0051，最强因子 a060 达 0.0298、t 5.7），
另有 8 个因子只在 1 日有效、2 日就腰斩。

但 1 日调仓意味着每天全换一遍。IC 0.03 听着能用，扣掉成本可能归零。所以先算
两个决定性的数：

  1. **日换手率**：每天 top20% 组合里有多少只被换掉
  2. **盈亏平衡成本**：日超额能容忍多少单边成本

成本口径（ETF，无印花税）：
  佣金      万分之一 ~ 万分之二
  冲击成本  0.02% ~ 0.05%（流动性好的宽基大额可以更低）
  单边合计  约 0.03% ~ 0.07%，这里取 0.05% 作为中性假设
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent
FACTORS = ['a060', 'a033', 'a049', 'a051', 'a056', 'a100', 'a025']
TOPPCT = 0.20


def main():
    P = load_universe()
    print(f'面板 {P.close.shape}')

    fwd1 = P.open.shift(-2) / P.open.shift(-1) - 1      # 次日收益
    fwd5 = P.open.shift(-6) / P.open.shift(-1) - 1

    rows = []
    for f in FACTORS:
        import pyarrow.parquet as pq
        allc = [c for c in pq.ParquetFile(OUT / 'alpha101_index.parquet').schema_arrow.names
                if c.startswith(f + '|')]
        sub = pd.read_parquet(OUT / 'alpha101_index.parquet', columns=allc)
        sub.columns = [c.partition('|')[2] for c in allc]
        keep = [c for c in P.close.columns if c in sub.columns]
        F = sub[keep].reindex(P.date)

        # 逐日 top20%
        rk = F.rank(axis=1, pct=True)
        sel = (rk >= 1 - TOPPCT).fillna(False).astype(bool)
        # 换手：今天持仓中不在昨天持仓里的比例
        prev = sel.shift(1).fillna(False).astype(bool)   # shift 会把 bool 变成 object
        turn = ((sel & ~prev).sum(axis=1) / sel.sum(axis=1).replace(0, np.nan)).dropna()
        turn = turn[turn.index >= '2019-01-01']

        # 日超额（top20% 平均 − 全池平均）
        ex1 = (fwd1[keep].where(sel).mean(axis=1) - fwd1[keep].mean(axis=1)).dropna()
        ex5 = (fwd5[keep].where(sel).mean(axis=1) - fwd5[keep].mean(axis=1)).dropna()
        ex1 = ex1[ex1.index >= '2019-01-01']

        gross = ex1.mean() * 244
        cost_mid = float(turn.mean()) * 2 * 0.0005 * 244   # 双边 0.05%
        rows.append(dict(factor=f, turn=float(turn.mean()),
                         ex_day=float(ex1.mean()), gross_ann=gross,
                         cost_ann=cost_mid, net_ann=gross - cost_mid,
                         breakeven_bp=(float(ex1.mean()) / float(turn.mean()) / 2 * 1e4)
                         if turn.mean() else np.nan,
                         ex5_ann=float(ex5.mean()) * 244 / 5))
        print(f'{f}: 日换手 {turn.mean():.1%}  日超额 {ex1.mean()*100:+.3f}%  '
              f'毛 {gross*100:+.1f}%/年  净 {rows[-1]["net_ann"]*100:+.1f}%/年')

    T = pd.DataFrame(rows)
    T.to_csv(OUT / 'out_cost.csv', index=False)

    print('\n===== 汇总 =====')
    print(T.to_string(index=False, float_format=lambda v: f'{v:+.4f}'))
    print('\n盈亏平衡单边成本 = 日超额 / (2 × 日换手)，单位 bp。'
          '\n实际单边成本约 3~7bp（佣金 1~2bp + 冲击 2~5bp）。')

    # ---------------------------------------------------------------- 5 日 vs 1 日
    print('\n===== 1 日 vs 5 日 的年化超额对比（毛，未扣费）=====')
    c = T[['factor', 'gross_ann', 'ex5_ann']].copy()
    c['diff'] = c.gross_ann - c.ex5_ann
    print(c.to_string(index=False, float_format=lambda v: f'{v:+.2%}'))


if __name__ == '__main__':
    main()
