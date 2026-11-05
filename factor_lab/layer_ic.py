"""
分层重验：按资产类别分池算 IC
============================
现有全部研究都是把 468 个指数丢进一个池子算排名。问题是这个池子极不均匀：
股票宽基和行业 ETF 有 400 多只，商品只有十几只。

后果有两个方向：
  1. 商品 ETF 的强动量效应被 400 只股票 ETF 稀释，测不出来
  2. 股票内部的行业 ETF 分化远比宽基大，混在一起 rank 会把「行业轮动」
     和「宽基 beta」两种完全不同的东西压成一个数

所以按 broad / sector / cross_border / commodity 分开重算，看是不是有因子
的效力被混合池掩盖了。

类别判定直接复用 panel.py 的 refine_group——它已经处理过「黄金股 ETF 不是
商品 ETF」这个坑，不要再自己写一套。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent
HOLD = 5


def ic_one(f: pd.DataFrame, fwd: pd.DataFrame, min_n: int) -> pd.Series:
    rr = fwd.rank(axis=1, pct=True)
    fr = f.rank(axis=1, pct=True)
    both = fr.notna() & rr.notna()
    a = fr.where(both)
    b = rr.where(both)
    a = a.sub(a.mean(axis=1), axis=0)
    b = b.sub(b.mean(axis=1), axis=0)
    num = (a * b).sum(axis=1, min_count=1)
    den = np.sqrt((a ** 2).sum(axis=1, min_count=1) * (b ** 2).sum(axis=1, min_count=1))
    n = both.sum(axis=1)
    return (num / den.replace(0, np.nan)).where(n >= min_n)


def main():
    P = load_universe()
    print('类别分布：', P.group.value_counts().to_dict())

    fwd = P.open.shift(-(HOLD + 1)) / P.open.shift(-1) - 1

    groups = {g: [c for c in P.close.columns if P.group.get(c) == g]
              for g in P.group.dropna().unique()}
    for g, cs in groups.items():
        n_med = int(np.median([P.close[c].notna().sum() for c in cs]))
        print(f'  {g:14s} {len(cs):3d} 只  单只平均有效天数 {n_med}')

    # 类别内最小样本：商品只有十几只，min_n 取太大会全部变成 NaN
    min_n = {g: max(6, min(20, len(cs) // 2)) for g, cs in groups.items()}

    pf = pq.ParquetFile(OUT / 'alpha101_index.parquet')
    all_cols = pf.schema_arrow.names
    by_factor: dict[str, list[str]] = {}
    for c in all_cols:
        if '|' not in c:          # date 是普通列，不是 因子|指数
            continue
        f, _, ix = c.partition('|')
        by_factor.setdefault(f, []).append(c)

    rows = []
    for i, (f, cols) in enumerate(sorted(by_factor.items()), 1):
        # date 是 parquet 索引，用 pandas 接口读才会自动恢复（pyarrow.read 会丢掉）
        sub = pd.read_parquet(OUT / 'alpha101_index.parquet', columns=cols)
        sub.index = pd.to_datetime(sub.index)
        sub.columns = [c.partition('|')[2] for c in cols]
        sub = sub.reindex(P.date)
        keep = [c for c in sub.columns if c in P.close.columns]
        if not keep:
            continue
        sub = sub[keep]

        # 全池
        ic = ic_one(sub, fwd[keep], 20).dropna()
        if len(ic) > 100:
            rows.append(dict(factor=f, group='ALL', ic=ic.mean(),
                             t=ic.mean() / ic.std() * np.sqrt(len(ic)),
                             n=len(ic), n_assets=len(keep)))

        # 各类别
        for g, cs in groups.items():
            kk = [c for c in keep if c in cs]
            if len(kk) < 5:
                continue
            ic = ic_one(sub[kk], fwd[kk], min_n[g]).dropna()
            if len(ic) < 60:
                continue
            rows.append(dict(factor=f, group=g, ic=ic.mean(),
                             t=ic.mean() / ic.std() * np.sqrt(len(ic)),
                             n=len(ic), n_assets=len(kk)))
        if i % 15 == 0:
            print(f'  {i}/{len(by_factor)}', flush=True)

    T = pd.DataFrame(rows)
    T.to_csv(OUT / 'out_layer_ic.csv', index=False)
    print(f'\n{len(T)} 条')

    print('\n===== 各池子里显著的因子数（|t|>2）=====')
    print(T.groupby('group')['t'].apply(lambda s: int((s.abs() > 2).sum())).to_string())
    print('\n===== 各池子 IC 绝对值中位数 =====')
    print(T.groupby('group')['ic'].apply(lambda s: s.abs().median())
          .to_string(float_format=lambda v: f'{v:.4f}'))

    # 只在一类有效、在 ALL 里看不出来的因子
    print('\n===== 被混合池掩盖的因子：某类 |t|>2 但全池 |t|<1.5 =====')
    piv_t = T.pivot(index='factor', columns='group', values='t')
    piv_ic = T.pivot(index='factor', columns='group', values='ic')
    if 'ALL' in piv_t:
        mask = (piv_t.drop(columns='ALL').abs().max(axis=1) > 2) & (piv_t['ALL'].abs() < 1.5)
        hidden = piv_t[mask].drop(columns='ALL')
        if len(hidden):
            for f in hidden.index:
                best = hidden.loc[f].abs().idxmax()
                print(f'  {f:14s} 只在 {best:14s} 有效  '
                      f'IC {piv_ic.loc[f, best]:+.4f}  t {piv_t.loc[f, best]:+.2f}  '
                      f'（全池 IC {piv_ic.loc[f, "ALL"]:+.4f}）')
        else:
            print('  无')

    # 商品池单独看
    for g in ['commodity', 'cross_border', 'sector', 'broad']:
        s = T[T.group == g]
        if not len(s):
            continue
        s = s.reindex(s.t.abs().sort_values(ascending=False).index).head(10)
        print(f'\n===== {g} 池最强 10 个 =====')
        print(s[['factor', 'ic', 't', 'n', 'n_assets']].to_string(
            index=False, float_format=lambda v: f'{v:+.3f}'))


if __name__ == '__main__':
    main()
