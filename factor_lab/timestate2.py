"""
因子择时的策略级检验
====================
前一步（timestate.py）只证明了「状态分组下因子 IC 有差异」。那是描述性的，
样本内分位切组、736 次检验里挑出来，必然有噪声。

这一步做两件事把它变成可验证的东西：

1. **严格 walk-forward**：每个调仓日 T，只用 T 之前的数据估计「该状态下哪个
   因子好」，然后持有到下一个调仓日。2019 年起每一段都是真样本外。

2. **用多头超额而不是 IC**：ETF 不能做空。IC 为正可能完全来自空头端，
   实盘拿不到。wf_ex.parquet 存的就是「做多 top20% 相对全池的日超额」，
   已经是实盘口径。

对照三组：
  A 固定：历史上（全样本）夏普最高的 8 个因子，一直不动
  B 无状态：只用历史超额选因子，不看状态（尽量复现 wf.py 的思路）
  C 看状态：只用「与当前状态同类」的那部分历史日来选因子

如果 C 明显好于 B，说明状态确实携带增量信息；如果 C ≈ B，说明前面那些
t 值只是噪声。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent
ANN = 244
START = '2019-01-01'
TOPK = 8
LOOKBACK = 504          # 约两年历史
MIN_DAYS = 150


def build_states(P) -> pd.DataFrame:
    R = P.close.pct_change(fill_method=None)
    ew = R.mean(axis=1)
    nav = (1 + ew.fillna(0)).cumprod()
    return pd.DataFrame({
        'disp': R.std(axis=1),
        'vol20': ew.rolling(20).std() * np.sqrt(252),
        'trend': nav / nav.rolling(60).mean() - 1,
        'mret20': nav.pct_change(20),
    })


def rebal_dates(idx):
    s = pd.Series(idx, index=idx)
    return pd.DatetimeIndex(s.groupby([idx.year, idx.month]).last().values)


def stats(ex: pd.Series, label: str) -> dict:
    ex = ex.dropna()
    if len(ex) < 50:
        return dict(label=label, n=len(ex))
    nav = (1 + ex).cumprod()
    ann = nav.iloc[-1] ** (ANN / len(ex)) - 1
    vol = ex.std() * np.sqrt(ANN)
    return dict(label=label, n=len(ex), ann=ann, vol=vol,
                sharpe=ann / vol if vol else np.nan,
                mdd=(nav / nav.cummax() - 1).min(),
                win=(ex > 0).mean(), t=ex.mean() / ex.std() * np.sqrt(len(ex)))


def main():
    P = load_universe()
    S = build_states(P)
    EX = pd.read_parquet(OUT / 'wf_ex.parquet')
    idx = EX.index.intersection(S.index)
    EX, S = EX.loc[idx], S.loc[idx]
    print(f'超额矩阵 {EX.shape}，状态 {S.shape}')

    reb = rebal_dates(idx)
    reb = reb[(reb >= pd.Timestamp(START))]
    print(f'调仓日 {len(reb)}：{reb[0].date()} → {reb[-1].date()}')

    # ---------------------------------------------------------------- A 固定
    hist_all = EX.loc[:reb[0]].iloc[-LOOKBACK:]
    fixed = (hist_all.mean() / hist_all.std()).dropna().sort_values(ascending=False).head(TOPK).index
    print(f'\nA 固定 8 因子：{list(fixed)}')

    res = {'A': (EX[fixed].mean(axis=1), []),}
    for st in ['none', 'disp', 'vol20', 'trend', 'mret20']:
        picks_log = []
        held = pd.Series(np.nan, index=idx)
        for i, t in enumerate(reb):
            hist = EX.loc[:t].iloc[-LOOKBACK:]
            sd = S[st].loc[:t].iloc[-LOOKBACK:] if st != 'none' else None

            if sd is not None:
                cur = S[st].loc[:t].iloc[-20:].mean()      # 当前状态：近 20 日均值
                q = sd.quantile(0.5)
                # 只保留与当前状态同类（高低各半）的历史日
                same = sd >= q if cur >= q else sd < q
                hist = hist.loc[same[same].index]
                if len(hist) < MIN_DAYS:
                    hist = EX.loc[:t].iloc[-LOOKBACK:]

            n = hist.notna().sum()
            tv = (hist.mean() / hist.std()) * np.sqrt(n)
            ok = (n >= MIN_DAYS) & (tv > 0)
            cand = tv[ok].sort_values(ascending=False)
            sel = list(cand.index[:TOPK])
            if not sel:
                sel = list(fixed)
            picks_log.append((t, sel))

            nxt = reb[i + 1] if i + 1 < len(reb) else idx[-1]
            m = (idx >= t) & (idx < nxt)
            held.loc[m] = EX.loc[m, sel].mean(axis=1).values

        res[st.upper() if st == 'none' else st] = (held, picks_log)
        print(f'{st}: 选因子完成')

    # ---------------------------------------------------------------- 统计
    rows = []
    for k, (ex, _) in res.items():
        rows.append(stats(ex, k))
    T = pd.DataFrame(rows)
    print('\n===== 因子择时对照（多头超额，2019 起）=====')
    print(T.to_string(index=False, float_format=lambda v: f'{v:+.4f}'))

    # 分段
    print('\n===== 分年度年化超额 =====')
    seg = {}
    for k, (ex, _) in res.items():
        e = ex.dropna()
        seg[k] = e.groupby(e.index.year).apply(
            lambda s: (1 + s).prod() ** (ANN / len(s)) - 1 if len(s) > 20 else np.nan)
    print(pd.DataFrame(seg).to_string(float_format=lambda v: f'{v:+.2%}'))

    T.to_csv(OUT / 'out_timing_stat.csv', index=False)
    pd.DataFrame(seg).to_csv(OUT / 'out_timing_year.csv')

    # 各状态版本最近一期选了谁
    print('\n===== 最近一期各版本选中的因子 =====')
    for k, (ex, log) in res.items():
        if log:
            print(f'{k}: {log[-1][1]}')


if __name__ == '__main__':
    main()
