"""
基差因子：这是 ETF 之外的信息
============================
基差 = 期货/现货 − 1。它反映的是对冲盘的需求和市场的多空预期，与价格走势
本身正交。用户本来就在做 IC/IM 基差，这里把它接进因子体系，检验它对
未来收益有没有预测力。

三个候选信号：
  BASIS      基差水平（贴水多深）
  BASIS_CHG  20 日基差变化（贴水是在收窄还是扩大）
  BASIS_Z    基差相对自身一年历史的分位（剔除结构性漂移）

方法
----
时序检验而非横截面：基差是市场级变量，只能用来判断「整体该不该进」，
不能用来选哪只 ETF。所以算的是「基差处于 X 状态时，未来 N 日收益如何」。

样本 2020-08 起（现货指数接口限制 1500 根）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

OUT = Path(__file__).parent
PAIR = {'IF': 'HS300', 'IC': 'ZZ500', 'IM': 'ZZ1000', 'IH': 'SZ50'}


def main():
    B = pd.read_csv(OUT / 'out_basis.csv', index_col=0, parse_dates=True)
    print(f'基差 {B.shape}  {B.index[0].date()} → {B.index[-1].date()}')

    # 现货指数从 futures.db 取
    import sqlite3
    con = sqlite3.connect(OUT / 'futures.db')
    s = pd.read_sql('SELECT * FROM spot', con)
    con.close()
    sw = s.pivot(index='date', columns='sym', values='close')
    sw.index = pd.to_datetime(sw.index)
    sw = sw.sort_index()

    rows = []
    for fu, sp in PAIR.items():
        if fu not in B or sp not in sw:
            continue
        basis = B[fu].dropna()
        px = sw[sp].reindex(basis.index).ffill()
        ret20 = px.shift(-20) / px - 1
        ret60 = px.shift(-60) / px - 1

        sig = pd.DataFrame({
            'BASIS': basis,
            'BASIS_MA20': basis.rolling(20).mean(),
            'BASIS_CHG20': basis.rolling(20).mean().diff(20),
            'BASIS_Z': (basis - basis.rolling(250).mean()) / basis.rolling(250).std(),
        })

        for name in sig.columns:
            x = sig[name].dropna()
            for h, r in [('20', ret20), ('60', ret60)]:
                both = pd.concat([x, r], axis=1).dropna()
                if len(both) < 200:
                    continue
                a, b = both.iloc[:, 0], both.iloc[:, 1]
                ic = a.corr(b, method='spearman')
                # 分位分组
                q = pd.qcut(a.rank(method='first'), 5, labels=False)
                g = b.groupby(q).mean()
                rows.append(dict(fut=fu, signal=name, hold=h, ic=ic,
                                 n=len(both),
                                 q0=g.get(0, np.nan), q4=g.get(4, np.nan),
                                 long_short=g.get(4, np.nan) - g.get(0, np.nan)))

    T = pd.DataFrame(rows)
    T.to_csv(OUT / 'out_basis_ic.csv', index=False)

    print('\n===== 基差信号的时序预测力 =====')
    piv = T.pivot_table(index=['fut', 'signal'], columns='hold', values='ic')
    print(piv.to_string(float_format=lambda v: f'{v:+.3f}'))

    print('\n===== 分位分组收益（Q0 最低基差 → Q4 最高，20 日持有）=====')
    t20 = T[T.hold == '20']
    print(t20.to_string(index=False, float_format=lambda v: f'{v:+.3f}'))

    print('\n===== 最强组合（按 |IC| 排序）=====')
    top = T.reindex(T.ic.abs().sort_values(ascending=False).index).head(10)
    print(top.to_string(index=False, float_format=lambda v: f'{v:+.3f}'))

    # ---------------------------------------------------------------- 当前状态
    print('\n===== 当前基差状态 =====')
    for fu in B.columns:
        s = B[fu].dropna()
        if len(s) < 60:
            continue
        last = s.iloc[-1]
        z = (last - s.rolling(250).mean().iloc[-1]) / s.rolling(250).std().iloc[-1]
        pct = (s.iloc[-250:] < last).mean() if len(s) >= 250 else (s < last).mean()
        chg = s.rolling(20).mean().iloc[-1] - s.rolling(20).mean().iloc[-21]
        print(f'  {fu}: 基差 {last*100:+.2f}%  近一年分位 {pct:.0%}  z={z:+.2f}  '
              f'20日变化 {chg*100:+.2f}pp')


if __name__ == '__main__':
    main()
