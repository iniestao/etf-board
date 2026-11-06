"""
跨市场：隔夜跳空与日内反转
==========================
日频择时被证伪了（见 timing_decomp 修正后的结果：所有组合夏普都回到 0.2~0.3，
和买入持有没区别）。跨市场是另一条路——它不问"该不该持仓"，而问"隔夜的信息
有没有被日内过度反应"。

三条线索，都是 A 股特有的结构：
  1) 隔夜-日内反转：A 股 9:30 的集合竞价把隔夜消息一次性打进去，日内再慢慢修。
     如果成立，跳空高开的日子日内应该偏弱，反之亦然。
  2) 跨境 ETF 的隔夜映射：纳指 ETF 在 A 股时段涨跌，反映的是 A 股投资者对
     前夜美股的解读（以及溢价情绪），它可能领先 A 股宽基。
  3) 港股与 A 股的日内错位：港股 15:00 还在交易，A 股已收盘，这半小时的信息
     会在次日 A 股开盘补上。

全部检验都用「t 日信息 → t+1 收益」，不做同日回归。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

DB = '/workspace/etf_board/data/etf.db'


def load(code):
    con = sqlite3.connect(DB)
    df = pd.read_sql('select date, open, close, adj_factor from etf_daily where code=? order by date',
                     con, params=(code,), parse_dates=['date'])
    con.close()
    if not len(df):
        return None
    # 复权只影响跨日比较，日内 open/close 同一天、同一因子，直接用原始价
    df = df.set_index('date')
    df['gap'] = df['open'] / df['close'].shift(1) - 1
    df['intra'] = df['close'] / df['open'] - 1
    df['cc'] = df['close'].pct_change()
    return df


def main() -> None:
    print('=== 1) 隔夜跳空 vs 当日日内（同一天，不是预测） ===')
    print('%-12s %8s %8s %8s %8s' % ('标的', '相关系数', 'n', '起始', '结束'))
    for code, nm in (('510300', '沪深300'), ('510500', '中证500'),
                     ('159915', '创业板'), ('510050', '上证50')):
        d = load(code)
        if d is None or len(d) < 500:
            continue
        x = d[['gap', 'intra']].dropna()
        # 剔除极端（涨跌停、除权日）
        x = x[(x.gap.abs() < 0.05) & (x.intra.abs() < 0.11)]
        c = x['gap'].corr(x['intra'], method='spearman')
        print('%-12s %8.3f %8d  %s  %s' % (nm, c, len(x), x.index.min().date(), x.index.max().date()))

    print()
    print('=== 2) 跳空分组 → 当日日内收益（%） ===')
    print('%-12s %10s %10s %10s %10s' % ('标的', 'Q1低开', 'Q2', 'Q3', 'Q4高开'))
    for code, nm in (('510300', '沪深300'), ('510500', '中证500')):
        d = load(code)
        x = d[['gap', 'intra']].dropna()
        x = x[(x.gap.abs() < 0.05) & (x.intra.abs() < 0.11)]
        q = pd.qcut(x['gap'].rank(method='first'), 4, labels=False)
        g = x['intra'].groupby(q).mean() * 100
        print('%-12s %+10.3f %+10.3f %+10.3f %+10.3f'
              % (nm, g.get(0, np.nan), g.get(1, np.nan), g.get(2, np.nan), g.get(3, np.nan)))

    print()
    print('=== 3) 跨境 ETF 当日涨跌 → A 股次日收益 ===')
    base = load('510300')
    print('%-14s %10s %10s %10s' % ('跨境标的', 'IC(t+1)', 'IC(t+1..t+5)', 'n'))
    for code, nm in (('513100', '纳指100'), ('513500', '标普500'),
                     ('159920', '恒生'), ('513180', '恒生科技')):
        d = load(code)
        if d is None or len(d) < 400:
            print('%-14s 数据不足' % nm)
            continue
        j = d['cc'].dropna().index.intersection(base['cc'].dropna().index)
        if len(j) < 400:
            continue
        a = d['cc'].reindex(j)
        b1 = base['cc'].shift(-1).reindex(j)
        b5 = (1 + base['cc']).rolling(5).apply(np.prod, raw=True).shift(-5).reindex(j) - 1
        ic1 = a.corr(b1, method='spearman')
        ic5 = a.corr(b5, method='spearman')
        print('%-14s %+10.3f %+10.3f %10d' % (nm, ic1, ic5, len(j)))

    print()
    print('=== 4) 港股尾盘（A 股收盘后半小时）→ 次日 A 股开盘 ===')
    # 用恒生 ETF 的日内收益近似港股 9:30-15:00 的表现，次日 A 股跳空作为承接
    hk = load('159920')
    if hk is not None:
        j = hk['intra'].dropna().index.intersection(base['gap'].dropna().index)
        a = hk['intra'].reindex(j)
        g1 = base['gap'].shift(-1).reindex(j)
        print('  恒生ETF日内 → 次日沪深300跳空: IC %+.3f  n=%d'
              % (a.corr(g1, method='spearman'), len(j)))
        q = pd.qcut(a.rank(method='first'), 4, labels=False)
        v = g1.groupby(q).mean() * 100
        print('  分组（%s）: Q1 %+.3f  Q2 %+.3f  Q3 %+.3f  Q4 %+.3f'
              % ('低→高', v.get(0, np.nan), v.get(1, np.nan), v.get(2, np.nan), v.get(3, np.nan)))
        # 再往前一步：次日全天收益
        g2 = base['cc'].shift(-1).reindex(j)
        print('  恒生ETF日内 → 次日沪深300全天: IC %+.3f' % a.corr(g2, method='spearman'))


if __name__ == '__main__':
    main()
