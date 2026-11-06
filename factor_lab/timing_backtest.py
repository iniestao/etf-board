"""
时序策略回测
============
前面的单变量检验给出的结论是：没有一个变量能稳定预测方向。mom60 反转在 2019-2021
胜率 80%~100%，到 2022/2023/2026 全部翻负——那不是择时，那是牛市抄底。

所以换个问法：**不预测涨跌，只预测波动**。波动聚集是市场里少数几个真正稳定的
事实（今天波动大，明天大概率还大），而收益方向几乎不可预测。目标波动策略不需要
判对方向，它只在市场发疯时把仓位压下来。

四个策略，同一个标的（宽基 ETF 等权），同一套成本：
  A 买入持有
  B 目标波动      仓位 = min(1, 目标波动 / 已实现波动)
  C 波动 + 趋势   在 B 之上，60 日动量为负时再砍半
  D 多信号合成    波动 × 量能/分化度（缩量、低分化时加仓）

前视控制：t 日收盘算出的信号，t+1 日才生效（weight.shift(1)）。
成本：每次调仓按 |Δw| × 5bp 扣。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
S = pd.read_parquet(HERE / 'state.parquet')
S = S.dropna(subset=['mkt'])

TGT = 0.15          # 目标年化波动 15%
COST = 0.0005       # 单边 5bp


def perf(r: pd.Series, w: pd.Series, name: str) -> dict:
    """按仓位序列算净值与指标。w 是「t 日收盘算出的、t+1 日才持有的仓位」。"""
    w_eff = w.shift(1).fillna(0.0)
    turn = (w - w_eff).abs()
    r_strat = w_eff * r - turn * COST
    nav = (1 + r_strat).cumprod()
    n = len(r_strat)
    yrs = n / 242
    ann = nav.iloc[-1] ** (1 / yrs) - 1
    vol = r_strat.std() * np.sqrt(242)
    sharpe = ann / vol if vol > 0 else np.nan
    dd = float((nav / nav.cummax() - 1).min())
    return {'策略': name, '年化': ann, '波动': vol, '夏普': sharpe,
            '最大回撤': dd, 'Calmar': ann / abs(dd) if dd < 0 else np.nan,
            '年换手': turn.sum() / yrs, '净值': nav}


def run(sub: pd.DataFrame, label: str) -> pd.DataFrame:
    r = sub['mkt']
    vol = sub['vol20']
    rows = []

    rows.append(perf(r, pd.Series(1.0, index=r.index), 'A 买入持有'))

    wb = (TGT / vol).clip(upper=1.0).fillna(0)
    rows.append(perf(r, wb, 'B 目标波动'))

    wc = wb.copy()
    wc = wc.where(sub['mom60'] >= 0, wc * 0.5)     # 趋势向下砍半
    rows.append(perf(r, wc.fillna(0), 'C 波动+趋势'))

    # D：在 B 之上乘一个「冷清度」系数。amt_r 和 disp 越低（缩量、低分化），
    # 说明市场没人抢，历史上这种时候未来 20 日收益更好。各自做 250 日 z，
    # 取负号后截断在 [-1, 1]，映射到 [0.6, 1.2] 的仓位乘数。
    za = -((sub['amt_r'] - sub['amt_r'].rolling(250, min_periods=120).mean())
           / sub['amt_r'].rolling(250, min_periods=120).std())
    zd = -((sub['disp'] - sub['disp'].rolling(250, min_periods=120).mean())
           / sub['disp'].rolling(250, min_periods=120).std())
    mix = ((za + zd) / 2).clip(-1, 1)
    mult = 1.0 + 0.2 * mix
    wd = (wb * mult).clip(upper=1.0).fillna(0)
    rows.append(perf(r, wd, 'D 波动×冷清度'))

    T = pd.DataFrame([{k: v for k, v in x.items() if k != '净值'} for x in rows])
    print('=== %s ===' % label)
    print(T.to_string(index=False, float_format=lambda v: '%.2f' % v
                      if abs(v) < 10 else '%.1f' % v))
    for c in ('年化', '波动', '最大回撤'):
        T[c] = (T[c] * 100).round(1)
    T.rename(columns={'年化': '年化%', '波动': '波动%', '最大回撤': '回撤%'}, inplace=True)
    print('（年化/波动/回撤为 %）')
    print()
    return pd.DataFrame({x['策略']: x['净值'] for x in rows})


def main() -> None:
    navs = {}
    print('样本:', S.index.min().date(), '->', S.index.max().date())
    print()
    for lab, a, b in (('全样本 2019-2026', '2019-01-01', '2026-12-31'),
                      ('训练 2019-2022', '2019-01-01', '2022-12-31'),
                      ('验证 2023-2026', '2023-01-01', '2026-12-31')):
        sub = S[(S.index >= a) & (S.index <= b)]
        navs[lab] = run(sub, lab)
    pd.concat(navs, axis=1).to_csv(HERE / 'out_timing_nav.csv')

    # 分年度看四个策略
    print('=== 分年度收益（%） ===')
    r = S['mkt']
    vol = S['vol20']
    wb = (TGT / vol).clip(upper=1.0).fillna(0)
    wc = wb.where(S['mom60'] >= 0, wb * 0.5).fillna(0)
    wb_e, wc_e = wb.shift(1).fillna(0), wc.shift(1).fillna(0)
    print('%-8s %10s %10s %10s' % ('年份', '买入持有', '目标波动', '波动+趋势'))
    for y in sorted(S.index.year.unique()):
        m = S.index.year == y
        if m.sum() < 100:
            continue
        a = (1 + r[m]).prod() - 1
        b = (1 + wb_e[m] * r[m]).prod() - 1
        c = (1 + wc_e[m] * r[m]).prod() - 1
        print('%d   %+9.1f%% %+9.1f%% %+9.1f%%' % (y, a * 100, b * 100, c * 100))


if __name__ == '__main__':
    main()
