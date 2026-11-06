"""
折溢价的事件化检验
==================
之前折溢价是以横截面因子的形式验的（5 日 IC -0.066 / t -4.64），是唯一活下来的信号。
这里换成事件口径再问一遍：**溢价到了极端位置时，接下来一个月会怎样**。

关键在于必须扣掉同日同类的平均收益。溢价高的那一期，很可能整段时间市场都在涨
（溢价本身就是情绪高涨的产物），不扣掉的话，看到的"溢价高→涨得多"其实是市场 beta。

样本来自深市 PCF：2019-01 起，191 只深市 ETF，月末+半月度，共 9997 条。
fwd 是到下一期的收益（间隔约一个月，不固定）。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
d = pd.read_csv(HERE / 'out_premium.csv')
d = d.dropna(subset=['prem', 'fwd'])
d['code'] = d['code'].astype(str)

XB = ('跨境ETF', '跨市场ETF')
d['grp'] = np.where(d['fund_type'].isin(XB), '跨境', '境内')


def bucket(x: float) -> str:
    if x < -0.01:
        return '1 折价>1%'
    if x < -0.003:
        return '2 折价0.3~1%'
    if x <= 0.003:
        return '3 平水±0.3%'
    if x <= 0.01:
        return '4 溢价0.3~1%'
    return '5 溢价>1%'


d['bk'] = d['prem'].map(bucket)

# 同日同组的截面中位数：扣掉这一天这类资产的平均表现，剩下的才是溢价的贡献
d['bench'] = d.groupby(['date', 'grp'])['fwd'].transform('median')
d['ex'] = d['fwd'] - d['bench']

print('样本: %d 条, %d 只, %s ~ %s' % (len(d), d['code'].nunique(),
                                    str(d['date'].min())[:6], str(d['date'].max())[:6]))
print()
print('=== 分档：下一期收益（%）与超额（%） ===')
for g in ('跨境', '境内'):
    sub = d[d.grp == g]
    if len(sub) < 100:
        continue
    print('--- %s  (n=%d)' % (g, len(sub)))
    print('%-14s %6s %9s %9s %9s %9s' % ('档位', 'n', '原始收益', '中位', '超额', '胜率'))
    for bk in sorted(sub.bk.unique()):
        x = sub[sub.bk == bk]
        if len(x) < 15:
            continue
        print('%-14s %6d %+9.2f %+9.2f %+9.2f %8.0f%%'
              % (bk, len(x), x.fwd.mean() * 100, x.fwd.median() * 100,
                 x.ex.mean() * 100, (x.ex > 0).mean() * 100))
    print()

print('=== 分层：只看溢价>1% 的观测，按年拆（跨境） ===')
sub = d[(d.grp == '跨境') & (d.prem > 0.01)]
sub = sub.assign(y=sub.date // 10000)
print('%-6s %5s %10s %10s' % ('年份', 'n', '超额均值', '胜率'))
for y, x in sub.groupby('y'):
    if len(x) < 5:
        continue
    print('%d %5d %+9.2f%% %9.0f%%' % (y, len(x), x.ex.mean() * 100, (x.ex > 0).mean() * 100))

print()
print('=== 对照：溢价>1% 在「跨境」里的占比，按年 ===')
allx = d[d.grp == '跨境'].assign(y=lambda z: z.date // 10000)
for y, x in allx.groupby('y'):
    n = int((x.prem > 0.01).sum())
    print('  %d: %3d/%3d = %4.1f%%' % (y, n, len(x), n / len(x) * 100))
