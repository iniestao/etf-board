"""
逐年拆解 + 变量相关性
====================
上一轮的分位表里，disp 和 amt_r 的 Q1 未来 20 日收益都在 +3.5% 以上（基准 +0.92%），
看起来像捡到宝。但 2019-2020 是单边牛市、2024-09 有一次暴力反弹，任何"低位买入"
型信号在那几年都会显得神准。所以必须逐年拆开看，尤其是 2022、2023、2026 这三个
下跌年份——择时策略的价值只在下跌年份体现，涨的时候少赚一点无所谓。

同时算变量两两相关：disp 和 amt_r 都跟"市场冷热"有关，很可能是一个东西，
如果是，那就不能当两个独立信号叠加。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
S = pd.read_parquet(HERE / 'state.parquet')
S = S[S.index >= '2019-01-01']

KEY = ['disp', 'amt_r', 'basis_avg', 'mom60', 'sect_ex', 'xb_mom5', 'breadth', 'vol20']

print('=== 变量相关性（全样本 Spearman） ===')
C = S[KEY].corr(method='spearman').round(2)
print(C.to_string())

print()
print('=== 逐年：Q1 / Q5 的未来 20 日收益（%）与 Q1-Q5 差 ===')
print('（Q1 = 变量最低五分位，Q5 = 最高）')
print()
for c in KEY:
    s = S[c].dropna()
    f = S['fwd20'].reindex(s.index)
    j = f.dropna().index
    if len(j) < 300:
        print('%-10s 样本不足' % c)
        continue
    a, b = s.reindex(j), f.reindex(j)
    print('--- %s' % c)
    print('  年份   n     Q1      Q5    差(Q1-Q5)')
    tot = []
    for y in sorted(b.index.year.unique()):
        m = b.index.year == y
        if m.sum() < 60:
            continue
        aa, bb = a[m], b[m]
        q = pd.qcut(aa.rank(method='first'), 5, labels=False)
        q1 = bb[q == 0].mean() * 100
        q5 = bb[q == 4].mean() * 100
        d = q1 - q5
        tot.append((y, q1, q5, d))
        flag = '  <<' if abs(d) > 2 else ''
        print('  %d  %4d  %+6.2f  %+6.2f   %+6.2f%s' % (y, m.sum(), q1, q5, d, flag))
    if tot:
        ds = [t[3] for t in tot]
        print('  同号年份: %d/%d   中位差 %+.2f%%'
              % (sum(1 for d in ds if np.sign(d) == np.sign(np.median(ds))), len(ds), np.median(ds)))
    print()

print('=== 衰退年份单独看（2022 / 2023 / 2026） ===')
print('%-10s %8s %8s %8s %8s' % ('变量', '2022', '2023', '2026', '全样本Q1-Q5'))
for c in KEY:
    s = S[c].dropna()
    f = S['fwd20'].reindex(s.index)
    j = f.dropna().index
    if len(j) < 300:
        continue
    a, b = s.reindex(j), f.reindex(j)
    row = []
    for y in (2022, 2023, 2026):
        m = b.index.year == y
        if m.sum() < 60:
            row.append(np.nan)
            continue
        aa, bb = a[m], b[m]
        q = pd.qcut(aa.rank(method='first'), 5, labels=False)
        row.append((bb[q == 0].mean() - bb[q == 4].mean()) * 100)
    q = pd.qcut(a.rank(method='first'), 5, labels=False)
    allsp = (b[q == 0].mean() - b[q == 4].mean()) * 100
    print('%-10s %+8.2f %+8.2f %+8.2f %+8.2f' % (c, row[0], row[1], row[2], allsp))
