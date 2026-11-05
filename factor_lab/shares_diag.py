"""
份额因子诊断：是真信息还是价格动量的镜像
========================================
SH_CHG_YOY（份额同比增速）IC −0.043、t −2.00，方向为负。但负向有几种完全
不同的解释，必须分清楚，否则会把「动量因子的马甲」当成新 alpha：

  解释 A（真信息）：散户在暴跌后抄底、份额暴增，之后继续跌 → 份额增速是
                    「情绪反向指标」，独立于价格
  解释 B（马甲）：  份额暴增本身就发生在暴跌之后，而暴跌之后继续跌（动量），
                    所以份额因子只是「过去收益为负」的代理，没有增量信息

三件事区分它们：
  1. 按份额增速分组，看每组**上一季度**的收益。若最高组前期收益显著为负，
     支持 B
  2. 份额因子值与过去 60 日收益的截面相关。若 |相关| > 0.5，基本就是马甲
  3. 双重排序：先按过去收益分 3 层，层内再按份额分 3 组。若层内仍单调，
     说明份额有独立贡献（A）；若层内平坦，就是 B
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402
from shares_factor import load_quarterly  # noqa: E402

OUT = Path(__file__).parent
LAG = 45
FWD = 60


def main():
    P = load_universe()
    sh, nets, avail = load_quarterly()
    common = [c for c in sh.columns if c in P.close.columns]
    sh, avail = sh[common], avail[common]

    chg = sh.pct_change(4, fill_method=None)        # 同比，IC 最强的那个
    px_q = P.close.groupby(P.close.index.to_period('Q')).last()
    px_q.index = px_q.index.to_timestamp('Q').normalize()
    ret_q = px_q.pct_change(fill_method=None).reindex(chg.index)

    dates = P.close.index
    rows, diag = [], []
    for qe in chg.index:
        av = avail.loc[qe].max()
        if pd.isna(av):
            continue
        pos = dates.searchsorted(av)
        if pos >= len(dates) - FWD - 1:
            continue
        t0, t1 = dates[pos], dates[pos + FWD]

        sig = chg.loc[qe].dropna()
        prev = ret_q.loc[qe].dropna()
        fut = (P.close.loc[t1] / P.close.loc[t0] - 1).dropna()
        both = sig.index.intersection(prev.index).intersection(fut.index)
        if len(both) < 30:
            continue

        s, p, f = sig[both], prev[both], fut[both]
        # 与过去收益的截面相关
        c = s.corr(p, method='spearman')
        diag.append(dict(q=qe, corr_prev=c, n=len(both)))

        q = pd.qcut(s.rank(method='first'), 5, labels=False)
        g_prev = p.groupby(q).mean()
        g_fut = f.groupby(q).mean()
        rows.append(dict(q=qe, **{f'prev{i}': g_prev.get(i, np.nan) for i in range(5)},
                         **{f'fut{i}': g_fut.get(i, np.nan) for i in range(5)}))

    R = pd.DataFrame(rows)
    D = pd.DataFrame(diag)
    print(f'截面 {len(R)} 期，{R.q.iloc[0].date()} → {R.q.iloc[-1].date()}')

    print('\n===== 1. 按份额同比增速分 5 组：上一季度收益 =====')
    print((R[[f'prev{i}' for i in range(5)]].mean() * 100).round(2).to_string())
    print('（Q0=份额增速最低，Q4=最高）')

    print('\n===== 2. 同组：下一季度收益 =====')
    print((R[[f'fut{i}' for i in range(5)]].mean() * 100).round(2).to_string())

    print('\n===== 3. 份额增速 与 上一季度收益 的截面 Spearman =====')
    print(f'  均值 {D.corr_prev.mean():+.3f}  中位 {D.corr_prev.median():+.3f}  '
          f'|>0.5| 的期数 {int((D.corr_prev.abs() > 0.5).sum())}/{len(D)}')

    # ---------------------------------------------------------------- 双重排序
    print('\n===== 4. 双重排序：先按过去收益 3 层，层内按份额 3 组 =====')
    out = {}
    for qe in chg.index:
        av = avail.loc[qe].max()
        if pd.isna(av):
            continue
        pos = dates.searchsorted(av)
        if pos >= len(dates) - FWD - 1:
            continue
        t0, t1 = dates[pos], dates[pos + FWD]
        sig = chg.loc[qe].dropna()
        prev = ret_q.loc[qe].dropna()
        fut = (P.close.loc[t1] / P.close.loc[t0] - 1).dropna()
        both = sig.index.intersection(prev.index).intersection(fut.index)
        if len(both) < 45:
            continue
        s, p, f = sig[both], prev[both], fut[both]
        pr = pd.qcut(p.rank(method='first'), 3, labels=False)
        for layer in range(3):
            idx = p.index[pr == layer]
            if len(idx) < 12:
                continue
            sq = pd.qcut(s[idx].rank(method='first'), 3, labels=False)
            g = f[idx].groupby(sq).mean()
            for k in range(3):
                out.setdefault((layer, k), []).append(g.get(k, np.nan))

    if out:
        M = pd.DataFrame(
            [[np.nanmean(out.get((l, k), [np.nan])) * 100 for k in range(3)]
             for l in range(3)],
            index=[f'第{i+1}层' for i in range(3)],
            columns=['份额低', '份额中', '份额高'])
        print(M.round(2).to_string())
        print('\n每行内 高−低 的差（若都为负，说明份额在控制价格后仍有独立信息）')
        for layer in range(3):
            lo = np.nanmean(out.get((layer, 0), [np.nan]))
            hi = np.nanmean(out.get((layer, 2), [np.nan]))
            print(f'  第{layer+1}层：高−低 = {(hi - lo) * 100:+.2f}%')

    D.to_csv(OUT / 'out_share_diag.csv', index=False)


if __name__ == '__main__':
    main()
