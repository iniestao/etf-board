"""
时序单变量检验
==============
对每个市场状态变量，回答三个问题：
  1) 它与未来收益有没有关系（Spearman IC）
  2) 这个关系在每一年是不是同一个方向（稳定性 > 显著性）
  3) 按它分五组，未来收益是不是单调的（单调性 = 可用性）

为什么不用 t 值当主要判据：未来 20 日收益是重叠样本，相邻观测共享 19 天，
自相关极高，普通 t 值会被放大三四倍。所以主判据是「分年度同号比例」，
IC 只做参考。

样本从 2019-01 起：再早宽基 ETF 不到 20 只，等权组合没有代表性。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
STATE = HERE / 'state.parquet'
START = '2019-01-01'


def yearly_ic(s: pd.Series, f: pd.Series) -> pd.Series:
    out = {}
    for y, idx in f.groupby(f.index.year).groups.items():
        a, b = s.reindex(idx).dropna(), f.reindex(idx).dropna()
        j = a.index.intersection(b.index)
        if len(j) < 60:
            continue
        out[y] = a.reindex(j).corr(b.reindex(j), method='spearman')
    return pd.Series(out)


def main() -> None:
    S = pd.read_parquet(STATE)
    S = S[S.index >= START]
    vars_ = [c for c in S.columns if not c.startswith('fwd') and c != 'mkt']

    rows = []
    for c in vars_:
        s = S[c]
        r = {'var': c, 'n': int(s.notna().sum())}
        for h in (5, 20):
            f = S['fwd%d' % h]
            j = s.dropna().index.intersection(f.dropna().index)
            r['ic%d' % h] = s.reindex(j).corr(f.reindex(j), method='spearman')
        y = yearly_ic(s, S['fwd20'])
        r['yrs'] = len(y)
        r['same'] = float((np.sign(y) == np.sign(np.nanmedian(y))).mean()) if len(y) else np.nan
        r['ic_min'] = y.min() if len(y) else np.nan
        r['ic_max'] = y.max() if len(y) else np.nan
        rows.append(r)

    T = pd.DataFrame(rows).sort_values('ic20', key=abs, ascending=False)
    T['ic5'] = T['ic5'].round(3)
    T['ic20'] = T['ic20'].round(3)
    T['same'] = T['same'].round(2)
    T['ic_min'] = T['ic_min'].round(2)
    T['ic_max'] = T['ic_max'].round(2)
    print('=== 时序 IC（2019-01 起） ===')
    print(T.to_string(index=False))
    T.to_csv(HERE / 'out_timing_ic.csv', index=False)

    # ---------------- 分位分组 ----------------
    print()
    print('=== 五分位 → 未来 20 日平均收益（%） ===')
    hdr = '%-11s %7s %7s %7s %7s %7s  %6s' % ('变量', 'Q1(低)', 'Q2', 'Q3', 'Q4', 'Q5(高)', 'Q5-Q1')
    print(hdr)
    g_rows = []
    for c in vars_:
        s = S[c].dropna()
        f = S['fwd20'].reindex(s.index)
        j = f.dropna().index
        if len(j) < 400:
            continue
        a, b = s.reindex(j), f.reindex(j)
        q = pd.qcut(a.rank(method='first'), 5, labels=False)
        g = b.groupby(q).mean() * 100
        row = {'var': c}
        for k in range(5):
            row['Q%d' % (k + 1)] = g.get(k, np.nan)
        row['spread'] = g.get(4, np.nan) - g.get(0, np.nan)
        g_rows.append(row)
        print('%-11s %+7.2f %+7.2f %+7.2f %+7.2f %+7.2f  %+6.2f'
              % (c, g.get(0, np.nan), g.get(1, np.nan), g.get(2, np.nan),
                 g.get(3, np.nan), g.get(4, np.nan), row['spread']))
    pd.DataFrame(g_rows).to_csv(HERE / 'out_timing_q.csv', index=False)

    print()
    print('基准：全样本未来 20 日平均收益 %+.2f%%  年化 %+.1f%%'
          % (S['fwd20'].mean() * 100, ((1 + S['fwd20'].mean()) ** 12 - 1) * 100))


if __name__ == '__main__':
    main()
