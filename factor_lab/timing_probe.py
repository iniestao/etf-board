"""探查：ETF 池的时间跨度、分组构成、等权市场组合的基线表现。"""
import sys
sys.path.insert(0, '/workspace/etf_board/factor_lab')
import numpy as np
import pandas as pd
from panel import load_panel

P = load_panel()
print('日期范围:', P.date.min().date(), '->', P.date.max().date(), '共', len(P.date), '个交易日')
print('标的数:', P.close.shape[1])
print()
print('=== 分组构成（最新交易日） ===')
last = P.meta.index
g = P.meta['g'] if 'g' in P.meta.columns else P.group
print(g.value_counts().to_dict())
print()

# 宽基等权：每日对 group=='broad' 的标的取等权收益
rt = P.ret(1)
broad = [c for c in P.close.columns if P.group.get(c) == 'broad']
print('宽基标的数:', len(broad))

sub = rt[broad]
# 每日有效样本数
nvalid = sub.notna().sum(axis=1)
print('宽基每日有效数：min %d / median %d / max %d' % (nvalid.min(), nvalid.median(), nvalid.max()))
mkt = sub.mean(axis=1, skipna=True)

# 全池等权（剔除货币/债券）
keep = [c for c in P.close.columns if P.group.get(c) in ('broad', 'sector', 'cross_border', 'commodity')]
allm = rt[keep].mean(axis=1, skipna=True)
print('全池（非货债）标的数:', len(keep))

print()
print('=== 年度表现（宽基等权 vs 全池等权） ===')
for name, s in (('宽基等权', mkt), ('全池等权', allm)):
    print(name)
    yr = s.groupby(s.index.year)
    for y, x in yr:
        cum = (1 + x).prod() - 1
        vol = x.std() * np.sqrt(242)
        print('  %d  收益 %+7.1f%%  波动 %5.1f%%  日数 %d' % (y, cum * 100, vol * 100, len(x)))
    print()

print('=== 市场组合自相关（择时的前提） ===')
for lag in (1, 5, 20, 60):
    print('  收益 %2d 日自相关: %+.4f' % (lag, mkt.autocorr(lag)))
print('  波动聚集（|r| 的自相关，20 日）: %+.4f' % mkt.abs().autocorr(20))
