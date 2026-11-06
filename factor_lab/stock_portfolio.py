"""
个股层面的可执行回测：月频调仓，等权持有，扣交易成本。
对照组 = 同样因子在 ETF 上做（证明载体差异）。
证伪项 = 规模中性化后还剩多少（排除小盘马甲）。
"""
import sqlite3
import numpy as np
import pandas as pd
import stock_factor as sf

COST = 0.0015      # 单边，含佣金+印花税+冲击，保守取 15bp
TOPN = 0.10


def month_ends(idx):
    s = pd.Series(idx, index=idx)
    v = s.groupby([idx.year, idx.month]).max().values
    return pd.DatetimeIndex(v)


def backtest(score, fwd1m, tradable, label):
    """score/fwd1m/tradable 都是 (date × code) 的月末面板"""
    dates = score.index
    rets, turns, nhold = [], [], []
    prev = set()
    for i, t in enumerate(dates[:-1]):
        s = score.loc[t].where(tradable.loc[t]).dropna()
        if len(s) < 100:
            continue
        k = max(30, int(len(s) * TOPN))
        pick = set(s.nlargest(k).index)
        r = fwd1m.loc[t].reindex(list(pick)).dropna()
        gross = r.mean() if len(r) else np.nan
        turn = 1 - len(pick & prev) / len(pick) if prev else 1.0
        cost = turn * COST * 2
        rets.append((dates[i + 1], gross - cost, gross))
        turns.append(turn)
        nhold.append(len(pick))
        prev = pick
    df = pd.DataFrame(rets, columns=['date', 'net', 'gross']).set_index('date')
    nav = (1 + df.net).cumprod()
    yrs = (df.index[-1] - df.index[0]).days / 365.25
    ann = nav.iloc[-1]**(1 / yrs) - 1
    vol = df.net.std() * np.sqrt(12)
    dd = (nav / nav.cummax() - 1).min()
    print(f'{label:22s} 年化 {ann:6.2%}  波动 {vol:5.1%}  夏普 {ann/vol:5.2f}  '
          f'回撤 {dd:6.1%}  月胜率 {(df.net>0).mean():5.1%}  换手 {np.mean(turns):5.1%}  持有 {int(np.mean(nhold)):4d}')
    return df, nav


if __name__ == '__main__':
    px, raw, vol = sf.load()
    f, ret, amt = sf.build(px, raw, vol)
    ok = (raw >= 2) & (amt >= 1e7)
    for k in f:
        f[k] = f[k].where(ok)

    tds = px.index
    me = month_ends(tds)
    me = [t for t in me if t <= tds[-25]]

    def snap(df):
        return df.reindex(index=me)

    def fwd_month():
        """从本月末到下月末的收益"""
        sub = px.reindex(index=me)
        return sub.shift(-1) / sub - 1

    S = {k: snap(v) for k, v in f.items()}
    S['OK'] = snap(ok)
    F = fwd_month()

    # 定向：越大越好（用分位，0~1）
    R = lambda x: x.rank(axis=1, pct=True)
    lowvol = -R(S['VOL20'])
    lowmax = -R(S['MAX20'])
    lowamt = -R(S['AMT20'])
    rev = R(S['REV20'])
    combo = (lowvol + lowmax) / 2

    print(f'样本 {me[0].date()} ~ {me[-1].date()}  {len(me)} 个月，成本 {COST:.2%} 单边\n')
    res = {}
    for name, sc in [('低波 VOL20', lowvol), ('低MAX20', lowmax),
                     ('低成交额 AMT20', lowamt), ('反转 REV20', rev),
                     ('低波+低MAX', combo)]:
        res[name] = backtest(sc, F, S['OK'], name)[0]

    # 基准：全市场等权
    bench = (F.where(S['OK'])).mean(axis=1).dropna()
    navb = (1 + bench).cumprod()
    yrs = (bench.index[-1] - bench.index[0]).days / 365.25
    print(f'{"全A等权基准":22s} 年化 {navb.iloc[-1]**(1/yrs)-1:6.2%}  波动 {bench.std()*np.sqrt(12):5.1%}  '
          f'夏普 {(navb.iloc[-1]**(1/yrs)-1)/(bench.std()*np.sqrt(12)):5.2f}  ')

    # 分年超额
    print('\n分年净收益 vs 全A等权：')
    tab = {}
    for name, df in res.items():
        tab[name] = df.net
    tab['基准'] = bench
    T = pd.DataFrame(tab)
    print((T.groupby(T.index.year).apply(lambda g: (1 + g).prod() - 1) * 100).round(1).to_string())
    T.to_csv('out_stock_nav.csv')
