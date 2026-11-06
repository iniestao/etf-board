"""
稳健性证伪
==========
逐年表里 mom60 反转在 8 年中有 7 年同号，看起来最稳。但 2024 年那 +10.11% 的价差
几乎肯定来自 9 月底那波暴涨——而那时候 mom60 必然是全样本最低（前面跌了整整两年）。
一个由单一事件主导的"规律"，换个样本就没了。

三把尺子：
  1) 中位数代替均值：均值会被少数极端月份拉高
  2) 剔除 2024-09~10：看剔除后还剩多少
  3) 按"信号触发次数"而不是"天数"统计：连续 20 天都满足条件，其实只算一次机会
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
S = pd.read_parquet(HERE / 'state.parquet')
S = S[S.index >= '2019-01-01']


def q_spread(s: pd.Series, f: pd.Series, stat: str = 'mean') -> float:
    j = s.dropna().index.intersection(f.dropna().index)
    if len(j) < 200:
        return np.nan
    a, b = s.reindex(j), f.reindex(j)
    q = pd.qcut(a.rank(method='first'), 5, labels=False)
    g = b.groupby(q)
    fn = g.mean if stat == 'mean' else g.median
    v = fn()
    return (v.get(0, np.nan) - v.get(4, np.nan)) * 100


KEY = ['mom60', 'amt_r', 'disp', 'vol20', 'basis_avg']

print('=== 三把尺子：Q1-Q5 价差（%，未来 20 日） ===')
print('%-11s %10s %10s %12s' % ('变量', '均值', '中位数', '剔2024Q4后'))
for c in KEY:
    s = S[c]
    f = S['fwd20']
    m1 = q_spread(s, f, 'mean')
    m2 = q_spread(s, f, 'median')
    # 2024-09-20 ~ 2024-10-31 之间到期的标签全部剔除：fwd20 的终点落在这段，
    # 说明这 20 天里含着那波暴涨，不让它进样本
    bad = (f.index >= '2024-09-20') & (f.index <= '2024-10-31')
    f2 = f.copy()
    f2[bad] = np.nan
    m3 = q_spread(s, f2, 'mean')
    print('%-11s %+10.2f %+10.2f %+12.2f' % (c, m1, m2, m3))

print()
print('=== mom60 逐年（中位数口径，抗极端） ===')
s, f = S['mom60'], S['fwd20']
j = s.dropna().index.intersection(f.dropna().index)
a, b = s.reindex(j), f.reindex(j)
print('  年份   Q1中位   Q5中位    差')
for y in sorted(b.index.year.unique()):
    m = b.index.year == y
    if m.sum() < 60:
        continue
    aa, bb = a[m], b[m]
    q = pd.qcut(aa.rank(method='first'), 5, labels=False)
    q1 = bb[q == 0].median() * 100
    q5 = bb[q == 4].median() * 100
    print('  %d   %+6.2f   %+6.2f   %+6.2f' % (y, q1, q5, q1 - q5))

print()
print('=== "事件"口径：mom60 跌破 20 分位后，未来 20 日的收益分布 ===')
# 只统计"新跌进低位"的那些天：前一日在 20 分位以上、今日跌破
pct = a.rank(pct=True)
entry = (pct < 0.2) & (pct.shift(1) >= 0.2)
print('  触发次数:', int(entry.sum()), '（占总天数 %.1f%%）' % (entry.mean() * 100))
r_in = b[entry].dropna() * 100
print('  样本内（触发后 20 日）: 均值 %+.2f%%  中位 %+.2f%%  胜率 %.0f%%  n=%d'
      % (r_in.mean(), r_in.median(), (r_in > 0).mean() * 100, len(r_in)))
base = b.dropna() * 100
print('  基准（任意一天）      : 均值 %+.2f%%  中位 %+.2f%%  胜率 %.0f%%  n=%d'
      % (base.mean(), base.median(), (base > 0).mean() * 100, len(base)))
print()
print('  按年拆：')
for y in sorted(r_in.index.year.unique()):
    x = r_in[r_in.index.year == y]
    if len(x) < 3:
        continue
    print('    %d  n=%2d  均值 %+6.2f%%  胜率 %3.0f%%' % (y, len(x), x.mean(), (x > 0).mean() * 100))
