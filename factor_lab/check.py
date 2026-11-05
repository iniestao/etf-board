"""
基准体检
========
所有因子都跑输等权，先别急着下结论——先证明基准本身没有偏差。

可能的偏差源：
1. 新上市 ETF 在上市初期暴涨，等权池吃到红利，而任何需要历史窗口的因子
   策略都吃不到（因子要 60-250 天才有值）。
2. 等权被超小规模 ETF 主导（一只 5000 万规模的 ETF 翻倍，等权收益就上去了）。
3. 复权或数据本身的异常值。

做法：随机选股 30 次，看平均是否等于基准。若随机也显著跑输，说明是选择行为
本身（换手成本 + 错过新 ETF）造成的，而不是因子无效。
"""
import numpy as np
import pandas as pd

from panel import load_universe
from factors import FACTORS, compute_all
from evaluate import smooth, group_rank, mask_valid
from portfolio import backtest

P = load_universe()
fs = compute_all(P, verbose=False)
TEST = ('2024-01-01', '2026-11-03')

# 1. 随机对照
rng = np.random.default_rng(42)
res = []
for i in range(15):
    rnd = pd.DataFrame(rng.random(P.close.shape), index=P.close.index, columns=P.close.columns)
    bt = backtest(rnd, P, hold=10, top_pct=0.2, start=TEST[0], end=TEST[1])
    res.append(bt['stat']['ann'])
rnd_ann = np.mean(res)
b = backtest(pd.DataFrame(1.0, index=P.close.index, columns=P.close.columns),
             P, hold=10, top_pct=0.2, start=TEST[0], end=TEST[1])
bs = b['stat_bench']
print(f'随机选股 15 次平均年化 {rnd_ann:+.2%}（标准差 {np.std(res):.2%}）')
print(f'池等权基准 {bs["ann"]:+.2%}')
print(f'随机 vs 基准 差 {rnd_ann - bs["ann"]:+.2%}  ← 若接近 0，基准无偏\n')

# 2. 新 ETF 的贡献
idx = P.date
m = (idx >= TEST[0]) & (idx <= TEST[1])
close = P.close.loc[m]
amount = P.amount.loc[m]
first = close.apply(lambda s: s.first_valid_index())
ret_all = close.pct_change()
valid = close.notna() & (amount > 5e7)

age = pd.DataFrame({c: (close.index - first[c]).days.values for c in close.columns},
                   index=close.index)
new = age < 250
old = age >= 250

for tag, msk in [('上市<1年', new & valid), ('上市>=1年', old & valid)]:
    r = ret_all.where(msk).mean(axis=1)
    nav = (1 + r.fillna(0)).cumprod()
    print(f'{tag:10} 平均标的数 {msk.sum(axis=1).mean():6.0f}  '
          f'累计 {nav.iloc[-1]-1:+.1%}  年化 {(nav.iloc[-1])**(244/len(r))-1:+.1%}')

# 3. 池子规模分布
print(f'\n可交易池规模（日均）：{valid.sum(axis=1).mean():.0f} 只')
print(f'成交额中位数 {amount.where(valid).median().median()/1e8:.2f} 亿')

# 4. 因子有效子集的平均上市天数
fr = group_rank(mask_valid(smooth(fs['PE'], 10), P), P.group).loc[m]
sel = fr.rank(axis=1, pct=True) >= 0.8
sel = sel & valid
print(f'\nPE top20% 组合平均上市天数 {age.where(sel).median(axis=1).median():.0f} 天')
print(f'全池平均上市天数 {age.where(valid).median(axis=1).median():.0f} 天')
