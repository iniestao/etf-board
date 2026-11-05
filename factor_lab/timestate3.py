"""
择时的稳健性网格
================
timestate2.py 发现「按波动率状态选因子」年化超额 +2.74%、t=3.19，另外四个
变体全负。5 个变体里挑 1 个显著，按 5% 显著性水平本来就该有 0.25 个纯噪声
撞上来——所以单看那个 t 值不能下结论。

这里换三个维度做网格，看结论是不是只在某一组参数下成立：

  TOPK     5 / 8 / 12      选几个因子
  LOOKBACK 252 / 504 / 756 用多长历史估状态-因子映射
  Q        0.3 / 0.5 / 0.7 状态高低的切分点

稳健的做法是：只要多数参数组合都为正，说明规律是真的；如果只有 (8,504,0.5)
这一格好看，那就是过拟合，应当丢掉。
"""
from __future__ import annotations

import itertools
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent
ANN = 244
START = '2019-01-01'
MIN_DAYS = 120


def build_states(P):
    R = P.close.pct_change(fill_method=None)
    ew = R.mean(axis=1)
    nav = (1 + ew.fillna(0)).cumprod()
    return pd.DataFrame({
        'vol20': ew.rolling(20).std() * np.sqrt(252),
        'mret20': nav.pct_change(20),
    })


def rebal_dates(idx):
    s = pd.Series(idx, index=idx)
    return pd.DatetimeIndex(s.groupby([idx.year, idx.month]).last().values)


def run(EX, S, reb, idx, state: str | None, topk: int, lookback: int, q: float):
    held = pd.Series(np.nan, index=idx)
    for i, t in enumerate(reb):
        hist = EX.loc[:t].iloc[-lookback:]
        if state is not None and len(hist) > MIN_DAYS:
            sd = S[state].loc[:t].iloc[-lookback:]
            cur = S[state].loc[:t].iloc[-20:].mean()
            thr = sd.quantile(q) if q != 0.5 else sd.median()
            same = sd >= thr if cur >= thr else sd < thr
            sub = hist.loc[same[same].index]
            if len(sub) >= MIN_DAYS:
                hist = sub
        n = hist.notna().sum()
        tv = (hist.mean() / hist.std()) * np.sqrt(n)
        cand = tv[(n >= MIN_DAYS) & (tv > 0)].sort_values(ascending=False)
        sel = list(cand.index[:topk])
        if not sel:
            continue
        nxt = reb[i + 1] if i + 1 < len(reb) else idx[-1]
        m = (idx >= t) & (idx < nxt)
        held.loc[m] = EX.loc[m, sel].mean(axis=1).values
    e = held.dropna()
    if len(e) < 50:
        return None
    nav = (1 + e).cumprod()
    ann = nav.iloc[-1] ** (ANN / len(e)) - 1
    vol = e.std() * np.sqrt(ANN)
    return dict(ann=ann, sharpe=ann / vol if vol else np.nan,
                t=e.mean() / e.std() * np.sqrt(len(e)),
                mdd=(nav / nav.cummax() - 1).min(), win=(e > 0).mean(), n=len(e))


def main():
    P = load_universe()
    S = build_states(P)
    EX = pd.read_parquet(OUT / 'wf_ex.parquet')
    idx = EX.index.intersection(S.index)
    EX, S = EX.loc[idx], S.loc[idx]
    reb = rebal_dates(idx)
    reb = reb[reb >= pd.Timestamp(START)]

    rows = []
    grid = list(itertools.product([5, 8, 12], [252, 504, 756], [0.3, 0.5, 0.7]))
    print(f'网格 {len(grid)} 组 × 3 个版本\n')
    for topk, lb, q in grid:
        for tag, st in [('none', None), ('vol20', 'vol20'), ('mret20', 'mret20')]:
            r = run(EX, S, reb, idx, st, topk, lb, q)
            if r:
                rows.append(dict(topk=topk, lookback=lb, q=q, ver=tag, **r))
        print(f'  topk={topk} lb={lb} q={q} 完成')

    T = pd.DataFrame(rows)
    T.to_csv(OUT / 'out_grid_timing.csv', index=False)

    print('\n===== 每个版本的总体表现（27 组网格）=====')
    print(T.groupby('ver')[['ann', 'sharpe', 't']]
          .agg(['mean', 'median', 'min', 'max', 'count'])
          .to_string(float_format=lambda v: f'{v:+.3f}'))

    print('\n===== 年化为正的比例 =====')
    for v in T.ver.unique():
        s = T[T.ver == v]
        print(f'  {v:8s} {int((s.ann > 0).sum())}/{len(s)} 组为正   '
              f't>2 的有 {int((s.t > 2).sum())} 组')

    print('\n===== vol20 明细（按 topk）=====')
    print(T[T.ver == 'vol20'].pivot_table(
        index=['lookback', 'q'], columns='topk', values='ann')
        .to_string(float_format=lambda v: f'{v:+.2%}'))


if __name__ == '__main__':
    main()
