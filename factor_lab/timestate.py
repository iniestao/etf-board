"""
因子择时：市场状态能不能预测因子有效性
=====================================
背景
----
已有结论说「因子样本外不可用」：训练段多空夏普 1.2~1.6，测试段 −0.7，
IC 符号一致率 53%。但另一条结论同样重要：PE 因子 2022 年 +28%、2026 年 +22%，
2020 年跑输 13 个点。

这两条并不矛盾。它指向的不是「因子无效」，而是「因子是条件有效的」：
PE 是防守型（低路径效率 = 温和上涨），动量是进攻型。2020 年是普涨，
防守型必然跑输；2022 年是普跌，防守型必然跑赢。

所以正确的问法不是「哪个因子好」，而是「当下该用哪一族」。

方法
----
状态变量（全部 t 日可观测，不含未来）：
  disp   横截面日收益标准差 —— 离散度，越高说明分化越大、选择空间越大
  vol20  等权市场 20 日波动率（年化）
  trend  等权净值 / MA60 − 1 —— 趋势强度
  mret20 等权市场 20 日收益

目标：WF_IC（每日横截面 IC，5 日前瞻）。

重叠问题
--------
IC_t 的窗口是 t+1..t+6，相邻日高度重叠。直接对 2043 天做 t 检验会把有效
样本数虚增 5 倍。这里按 5 个交易日抽样，得到约 400 个近似独立的观测。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent


def build_states(P) -> pd.DataFrame:
    R = P.close.pct_change(fill_method=None)
    ew = R.mean(axis=1)
    nav = (1 + ew.fillna(0)).cumprod()
    s = pd.DataFrame({
        'disp': R.std(axis=1),
        'vol20': ew.rolling(20).std() * np.sqrt(252),
        'trend': nav / nav.rolling(60).mean() - 1,
        'mret20': nav.pct_change(20),
    })
    s['mkt'] = ew
    return s


def main():
    P = load_universe()
    print(f'面板 {P.close.shape}  {P.date[0].date()} → {P.date[-1].date()}')

    IC = pd.read_parquet(OUT / 'wf_ic.parquet')
    S = build_states(P)
    print(f'IC 矩阵 {IC.shape}')

    idx = IC.index.intersection(S.index)
    IC, S = IC.loc[idx], S.loc[idx]

    # 5 交易日抽样，去掉重叠
    sample = idx[::5]
    ICs, Ss = IC.loc[sample], S.loc[sample]
    print(f'抽样后 {len(sample)} 个观测（{sample[0].date()} → {sample[-1].date()}）')

    states = ['disp', 'vol20', 'trend', 'mret20']
    nq = 5
    rows = []
    for st in states:
        x = Ss[st]
        q = pd.qcut(x, nq, labels=False, duplicates='drop')
        grp_mean = ICs.groupby(q).mean()          # 因子 × 组
        grp_n = ICs.groupby(q).count()
        # 高状态组（Q4）减 低状态组（Q0）
        if 0 in grp_mean.index and (nq - 1) in grp_mean.index:
            spread = grp_mean.loc[nq - 1] - grp_mean.loc[0]
            # 用组内 IC 的时序标准差估 t 值
            hi = ICs[q == nq - 1]
            lo = ICs[q == 0]
            se = np.sqrt(hi.var(ddof=1) / len(hi) + lo.var(ddof=1) / len(lo))
            t = (spread / se.replace(0, np.nan))
            for f in IC.columns:
                rows.append(dict(state=st, factor=f,
                                 ic_low=grp_mean.loc[0, f], ic_high=grp_mean.loc[nq - 1, f],
                                 spread=spread[f], t=t.get(f, np.nan),
                                 n_high=int(grp_n.loc[nq - 1, f]),
                                 n_low=int(grp_n.loc[0, f])))
        print(f'  {st} 分组完成，各组样本 {dict(grp_n.iloc[:, 0])}')

    R = pd.DataFrame(rows)
    R.to_csv(OUT / 'out_state_spread.csv', index=False)

    print('\n===== 各状态变量下，因子 IC 差异最大的 12 个 =====')
    for st in states:
        sub = R[R.state == st].reindex(R[R.state == st].t.abs().sort_values(ascending=False).index)
        print(f'\n--- {st} （Q4 高位 − Q0 低位）---')
        print(sub.head(12)[['factor', 'ic_low', 'ic_high', 'spread', 't']]
              .to_string(index=False, float_format=lambda v: f'{v:+.4f}'))

    # ---------------------------------------------------------------- 状态平均水平
    print('\n===== 全因子平均 IC：各状态组 =====')
    for st in states:
        x = Ss[st]
        q = pd.qcut(x, nq, labels=False, duplicates='drop')
        m = ICs.mean(axis=1)
        g = m.groupby(q).agg(['mean', 'count'])
        print(f'\n{st}')
        print(g.to_string(float_format=lambda v: f'{v:+.4f}'))

    # 状态之间是否可区分：用全因子平均 IC 对状态回归
    print('\n===== 全因子平均 IC 对状态的相关性 =====')
    m = ICs.mean(axis=1)
    for st in states:
        c = m.corr(Ss[st])
        print(f'  {st:8s} corr={c:+.3f}')


if __name__ == '__main__':
    main()
