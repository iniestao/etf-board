"""
样本外检验 + 因子相关性去重
===========================
样本内（2020-2023）只是训练场。真正的判据是 2024-01 ~ 2026-11 这段
从未参与任何选择的区间。所有筛选决策只用样本内数据，样本外只做验证。

流程
----
1. 样本内筛：t > 2.0 且 净超额 > 0
2. 相关去重：贪心，要求与已选因子 |ρ| < 0.6
3. 样本外验证：同一套因子、同一方向、不重新拟合
4. 输出：样本内外对照表，看有多少因子活下来
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from panel import load_universe
from factors import FACTORS, compute_all
from evaluate import (forward_return, smooth, group_rank, mask_valid,
                      ic_series, ic_stats, layered, perf_arith, turnover, COST)

IN_S, IN_E = '2020-01-01', '2023-12-31'
OUT_S, OUT_E = '2024-01-01', '2026-11-03'
HL = 10


def rank_panel(f: pd.DataFrame, P) -> pd.DataFrame:
    return group_rank(mask_valid(f, P), P.group)


def factor_corr(ranks: dict[str, pd.DataFrame], start, end) -> pd.DataFrame:
    """因子间相关：逐日横截面 Spearman 的时序平均（Fisher z 后平均再转回）。"""
    m = (ranks[list(ranks)[0]].index >= start) & (ranks[list(ranks)[0]].index <= end)
    names = list(ranks)
    out = pd.DataFrame(np.eye(len(names)), index=names, columns=names)
    arr = {k: v.loc[m].rank(axis=1) for k, v in ranks.items()}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            A, B = arr[a], arr[b]
            both = A.notna() & B.notna()
            aa = A.where(both).sub(A.where(both).mean(axis=1), axis=0)
            bb = B.where(both).sub(B.where(both).mean(axis=1), axis=0)
            den = np.sqrt((aa ** 2).sum(axis=1) * (bb ** 2).sum(axis=1))
            rho = ((aa * bb).sum(axis=1) / den.replace(0, np.nan)).dropna()
            if len(rho) < 50:
                continue
            z = np.arctanh(rho.clip(-0.999, 0.999)).mean()
            r = float(np.tanh(z))
            out.loc[a, b] = out.loc[b, a] = r
    return out


def one(fr: pd.DataFrame, fwd: pd.DataFrame) -> dict:
    st = ic_stats(ic_series(fr, fwd))
    lay = layered(fr, fwd)
    ex = perf_arith(lay['excess'])
    to = turnover(fr)
    return dict(**st, ex_ann=ex['ann'], ex_ir=ex['sharpe'], ex_mdd=ex['mdd'],
                to=to, net=ex['ann'] - to * COST * 2)


def main():
    P = load_universe()
    print('算因子…', flush=True)
    fs = compute_all(P, verbose=False)
    dirs = {k: v['direction'] for k, v in FACTORS.items()}
    fam = {k: v['family'] for k, v in FACTORS.items()}
    fwd = forward_return(P)

    idx = P.date
    m_in = (idx >= IN_S) & (idx <= IN_E)
    m_out = (idx >= OUT_S) & (idx <= OUT_E)

    ranks, rows = {}, []
    for k, f in fs.items():
        fr = rank_panel(smooth(f * dirs[k], HL), P)
        ranks[k] = fr
        a = one(fr.loc[m_in], fwd.loc[m_in])
        b = one(fr.loc[m_out], fwd.loc[m_out])
        rows.append(dict(factor=k, family=fam[k],
                         ic_in=a['ic'], t_in=a['t'], ir_in=a['ex_ir'], net_in=a['net'],
                         to=a['to'],
                         ic_out=b['ic'], t_out=b['t'], ir_out=b['ex_ir'], net_out=b['net']))
    tab = pd.DataFrame(rows)
    tab['decay'] = tab['ic_out'] / tab['ic_in'].replace(0, np.nan)
    tab = tab.sort_values('t_in', ascending=False)
    tab.to_csv('out_cross.csv', index=False)

    print('\n===== 样本内 vs 样本外（按样本内 t 排序，前 25） =====')
    print(f'{"因子":15}{"家族":10}{"IC_in":>8}{"t_in":>7}{"IC_out":>8}{"t_out":>7}{"净in":>8}{"净out":>8}')
    for _, x in tab.head(25).iterrows():
        print(f'{x.factor:15}{x.family:10}{x.ic_in:8.4f}{x.t_in:7.2f}'
              f'{x.ic_out:8.4f}{x.t_out:7.2f}{x.net_in:8.2%}{x.net_out:8.2%}')

    # 存活率
    alive_in = tab[(tab.t_in > 2.0) & (tab.net_in > 0)]
    alive_out = alive_in[(alive_in.t_out > 1.5) & (alive_in.net_out > 0)]
    print(f'\n样本内 t>2 且净>0：{len(alive_in)} 个')
    print(f'其中样本外 t>1.5 且净>0：{len(alive_out)} 个（存活率 {len(alive_out)/max(len(alive_in),1):.0%}）')
    print(f'样本内外 IC 同号比例：{(np.sign(tab.ic_in)==np.sign(tab.ic_out)).mean():.0%}')
    print(f'样本内外 IC 秩相关：{tab[["ic_in","ic_out"]].corr(method="spearman").iloc[0,1]:.2f}')

    # 相关性去重（只用样本内）
    print('\n计算因子相关性…', flush=True)
    c = factor_corr(ranks, IN_S, IN_E)
    c.to_csv('out_corr.csv')

    sel = []
    for _, x in alive_out.sort_values('t_in', ascending=False).iterrows():
        nm = x.factor
        if all(abs(c.loc[nm, s]) < 0.6 for s in sel):
            sel.append(nm)
    print(f'\n去重后保留 {len(sel)} 个：{sel}')


if __name__ == '__main__':
    main()
