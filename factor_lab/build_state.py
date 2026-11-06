"""
市场级时序状态变量
==================
非横截面方向的第一步：不比较"哪只 ETF 更强"，只回答"现在该不该在场"。

每个变量都是**某一个交易日的单个标量**，在当天收盘后即可算出（不含未来信息），
用来预测市场组合接下来的收益。与之前的横截面因子是两套完全不同的东西：
横截面问"买哪只"，时序问"买不买"。

变量分四类：
  波动    vol20 / vol_r        已实现波动、短长波动比
  量能    amt_r / turn20      成交额放大倍数、换手中位数
  结构    breadth / disp      上涨占比、截面分化度
  情绪    basis_if / basis_ic 股指期货年化基差（贴水=悲观）
  动量    mom20 / mom60 / gap20

市场组合用「宽基 ETF 等权」而不是沪深300指数：ETF 池本身在扩张，等权能反映
普通投资者实际能买到的那些品种，且不受单只巨无霸的权重扭曲。
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_panel

OUT = Path(__file__).parent / 'state.parquet'
FUT_DB = Path(__file__).parent / 'futures.db'


def zs(s: pd.Series, win: int = 250) -> pd.Series:
    """滚动 z-score。择时变量必须做时序标准化——2020 年的 2% 波动和 2024 年的
    2% 波动不是一回事，绝对水平会漂移，不标准化就等于在比不同年代。"""
    m = s.rolling(win, min_periods=win // 2).mean()
    v = s.rolling(win, min_periods=win // 2).std()
    return (s - m) / v.replace(0, np.nan)


def main() -> None:
    P = load_panel()
    rt = P.ret(1)

    broad = [c for c in P.close.columns if P.group.get(c) == 'broad']
    sect = [c for c in P.close.columns if P.group.get(c) == 'sector']
    xb = [c for c in P.close.columns if P.group.get(c) == 'cross_border']
    pool = [c for c in P.close.columns if P.group.get(c) in ('broad', 'sector', 'cross_border', 'commodity')]

    mkt = rt[broad].mean(axis=1, skipna=True)
    # 有效样本太少的日子（早期宽基只有几只）不可信，置空
    nv = rt[broad].notna().sum(axis=1)
    mkt = mkt.where(nv >= 20)

    S = pd.DataFrame(index=P.date)

    # ---------------- 波动 ----------------
    S['vol20'] = mkt.rolling(20, min_periods=15).std() * np.sqrt(242)
    s5 = mkt.rolling(5, min_periods=4).std()
    s60 = mkt.rolling(60, min_periods=40).std()
    S['vol_r'] = s5 / s60.replace(0, np.nan)

    # ---------------- 量能 ----------------
    amt = P.amount[pool].sum(axis=1, skipna=True)
    S['amt_r'] = amt.rolling(20, min_periods=15).mean() / amt.rolling(120, min_periods=60).mean()
    S['amt_chg'] = amt.pct_change(5)

    # ---------------- 结构 ----------------
    up = (rt[pool] > 0).where(rt[pool].notna())
    S['breadth'] = up.mean(axis=1).rolling(20, min_periods=15).mean()
    S['disp'] = rt[pool].std(axis=1).rolling(20, min_periods=15).mean()

    # ---------------- 动量 ----------------
    S['mom20'] = (1 + mkt).rolling(20, min_periods=15).apply(np.prod, raw=True) - 1
    S['mom60'] = (1 + mkt).rolling(60, min_periods=40).apply(np.prod, raw=True) - 1
    # 隔夜跳空：开盘相对昨日收盘。用 ETF 的 open/close 会受申赎影响，
    # 但宽基 ETF 的折溢价很小，跳空幅度基本等于成分股集合竞价的合力
    gap = (P.open[broad] / P.close[broad].shift(1) - 1)
    S['gap20'] = gap.mean(axis=1, skipna=True).rolling(20, min_periods=15).mean()

    # 跨境 ETF 5 日动量：A 股收盘时美股还没开，跨境 ETF 的日内涨跌里含着
    # 前一晚外盘的映射，可以当"外部风险偏好"的代理
    S['xb_mom5'] = (1 + rt[xb].mean(axis=1, skipna=True)).rolling(5, min_periods=4).apply(np.prod, raw=True) - 1

    # 行业相对宽基的 20 日超额：题材行情 vs 普涨
    S['sect_ex'] = (1 + rt[sect].mean(axis=1, skipna=True)).rolling(20, min_periods=15).apply(np.prod, raw=True) - 1 - S['mom20']

    # ---------------- 基差 ----------------
    if FUT_DB.exists():
        con = sqlite3.connect(FUT_DB)
        fut = pd.read_sql('select date, sym, close from fut', con, parse_dates=['date'])
        spot = pd.read_sql('select date, sym, close from spot', con, parse_dates=['date'])
        con.close()
        m = {'IF': 'HS300', 'IC': 'ZZ500', 'IH': 'SZ50', 'IM': 'ZZ1000'}
        for fs, ss in m.items():
            f = fut[fut.sym == fs].set_index('date')['close']
            s = spot[spot.sym == ss].set_index('date')['close']
            b = (f / s - 1) * 100
            S['basis_' + fs.lower()] = b.reindex(S.index)
        # 四个合约的等权基差（IM 2022 年才有，前期只有三个）
        cols = [c for c in S.columns if c.startswith('basis_')]
        S['basis_avg'] = S[cols].mean(axis=1, skipna=True)

    # ---------------- 标签 ----------------
    for h in (1, 5, 20):
        S['fwd%d' % h] = (1 + mkt).rolling(h, min_periods=h).apply(np.prod, raw=True).shift(-h) - 1

    S['mkt'] = mkt
    S.to_parquet(OUT)
    print('写出', OUT, S.shape)

    cols = [c for c in S.columns if not c.startswith('fwd') and c != 'mkt']
    print('变量数:', len(cols))
    print()
    print('=== 覆盖率与分布 ===')
    for c in cols:
        s = S[c].dropna()
        if not len(s):
            print('  %-10s 全空' % c)
            continue
        print('  %-10s n=%4d  %s..%s  mean %+8.3f  p5 %+8.3f  p95 %+8.3f'
              % (c, len(s), s.index.min().date(), s.index.max().date(),
                 s.mean(), s.quantile(.05), s.quantile(.95)))


if __name__ == '__main__':
    main()
