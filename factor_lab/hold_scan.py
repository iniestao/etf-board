"""
短持有期：信号衰减曲线
======================
已有研究全部固定在 HOLD=5（5 日前瞻收益）。但盯市界面是日内到几天的场景，
用户真正关心的是「这波能不能接力」。所以要把同一个因子在不同持有期上的
IC 摊开来比。

做法
----
对 hold ∈ {1,2,3,5,10,20}：
    fwd = open[t+hold+1] / open[t+1] - 1
    与每日横截面 rank 求相关 → IC 序列

**这里不做 EMA 平滑**（原研究用 halflife=10）。原因：平滑本质是对过去 10 天
加权平均，等于人为把信号滞后约 5 天。研究长持有期时这是降噪，研究 1 日持有期
时它直接把信号抹掉——用平滑后的因子去预测明天，测的是 5 天前的信息。
所以这一轮用原始因子值，口径统一，才能看出真实衰减速度。

数据：alpha101_index.parquet（101 因子 × 468 指数，列名 `因子|指数名`）
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent
HOLDS = [1, 2, 3, 5, 10, 20]
MIN_N = 20


def ic_one(f: pd.DataFrame, fwd: pd.DataFrame) -> pd.Series:
    """逐日横截面 Spearman IC。"""
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
    return (num / den.replace(0, np.nan)).where(n >= MIN_N)


def main():
    P = load_universe()
    print(f'指数面板 {P.close.shape}')

    pf = pq.ParquetFile(OUT / 'alpha101_index.parquet')
    all_cols = pf.schema_arrow.names
    print(f'因子宽表 {pf.metadata.num_rows} 行 × {len(all_cols)} 列')

    # 按因子分组列名
    by_factor: dict[str, list[str]] = {}
    for c in all_cols:
        if '|' not in c:          # date 是普通列，不是 因子|指数
            continue
        f, _, ix = c.partition('|')
        by_factor.setdefault(f, []).append(c)
    print(f'因子 {len(by_factor)} 个，映射到 {len({c.partition("|")[2] for c in all_cols})} 个指数名')

    # 预演各持有期的前瞻收益
    fwds = {h: P.open.shift(-(h + 1)) / P.open.shift(-1) - 1 for h in HOLDS}

    rows = []
    for i, (f, cols) in enumerate(sorted(by_factor.items()), 1):
        # date 是 parquet 索引，用 pandas 接口读才会自动恢复（pyarrow.read 会丢掉）
        sub = pd.read_parquet(OUT / 'alpha101_index.parquet', columns=cols)
        sub.index = pd.to_datetime(sub.index)
        sub.columns = [c.partition('|')[2] for c in cols]
        # 对齐到面板列（只保留池内指数）
        keep = [c for c in P.close.columns if c in sub.columns]
        if len(keep) < 50:
            continue
        sub = sub[keep].reindex(P.date).astype(np.float32)

        for h in HOLDS:
            fwd = fwds[h][keep]
            ic = ic_one(sub, fwd).dropna()
            if len(ic) < 100:
                continue
            mu, sd = ic.mean(), ic.std()
            rows.append(dict(factor=f, hold=h, ic=mu, ir=mu / sd if sd else np.nan,
                             t=mu / sd * np.sqrt(len(ic)) if sd else np.nan,
                             win=(ic > 0).mean(), n=len(ic)))
        if i % 20 == 0:
            print(f'  {i}/{len(by_factor)}', flush=True)

    T = pd.DataFrame(rows)
    T.to_csv(OUT / 'out_hold_ic.csv', index=False)
    print(f'\n共 {len(T)} 条（因子×持有期）')

    # ---------------------------------------------------------------- 总览
    print('\n===== 各持有期：全部因子的 IC 分布 =====')
    g = T.groupby('hold').agg(
        ic_mean=('ic', 'mean'), ic_med=('ic', 'median'),
        ic_abs_med=('ic', lambda s: s.abs().median()),
        t_gt2=('t', lambda s: int((s.abs() > 2).sum())),
        ic_max=('ic', 'max'), n_f=('ic', 'count'))
    print(g.to_string(float_format=lambda v: f'{v:+.4f}'))

    # ---------------------------------------------------------------- 衰减
    print('\n===== 单因子 IC 随持有期的变化（按 1 日 IC 绝对值排前 15）=====')
    top = T[T.hold == 1].reindex(T[T.hold == 1].ic.abs().sort_values(ascending=False).index)
    top20 = list(top.factor.head(15))
    piv = T[T.factor.isin(top20)].pivot(index='factor', columns='hold', values='ic')
    piv = piv.reindex(top20)
    print(piv.to_string(float_format=lambda v: f'{v:+.4f}'))

    print('\n===== 同上，t 值 =====')
    pivt = T[T.factor.isin(top20)].pivot(index='factor', columns='hold', values='t').reindex(top20)
    print(pivt.to_string(float_format=lambda v: f'{v:+.2f}'))

    # ---------------------------------------------------------------- 相对衰减
    print('\n===== 显著因子数量随持有期（|t|>2）=====')
    print(T.groupby('hold')['t'].apply(lambda s: int((s.abs() > 2).sum())).to_string())

    print('\n===== 每个持有期最强的 8 个因子 =====')
    for h in HOLDS:
        s = T[(T.hold == h) & (T.t.abs() > 1.5)].reindex(
            T[(T.hold == h)].t.abs().sort_values(ascending=False).index).head(8)
        print(f'\nhold={h}')
        print(s[['factor', 'ic', 'ir', 't', 'win']].to_string(index=False,
              float_format=lambda v: f'{v:+.4f}'))


if __name__ == '__main__':
    main()
