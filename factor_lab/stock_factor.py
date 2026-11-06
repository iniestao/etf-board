"""
个股层面的量价因子 IC 检验。
前提：ETF 是成分股的加权和，横截面自由度在个股（4300 只）而不在 ETF（有效 3.4 只）。
本脚本先回答最基本的问题：这些因子在个股上到底有没有横截面预测力。
"""
import sqlite3, sys
import numpy as np
import pandas as pd

DB = 'stocks.db'
START = sys.argv[1] if len(sys.argv) > 1 else '2016-01-01'
HOLD = int(sys.argv[2]) if len(sys.argv) > 2 else 20


def load():
    con = sqlite3.connect(DB)
    d = pd.read_sql(
        f"select code,date,close,close_adj,volume from daily where date>='{START}'", con)
    con.close()
    d['date'] = pd.to_datetime(d['date'])
    px = d.pivot_table(index='date', columns='code', values='close_adj').astype('float32')
    raw = d.pivot_table(index='date', columns='code', values='close').astype('float32')
    vol = d.pivot_table(index='date', columns='code', values='volume').astype('float32')
    return px, raw, vol


def build(px, raw, vol):
    ret = px.pct_change(fill_method=None)
    amt = raw * vol                      # 成交额近似（不复权价 × 股数）
    f = {}
    f['REV20'] = -px.pct_change(20, fill_method=None)
    f['REV5'] = -px.pct_change(5, fill_method=None)
    f['MOM120'] = -px.shift(5).pct_change(120, fill_method=None) * -1   # 跳最近5日
    f['VOL20'] = -ret.rolling(20, min_periods=15).std()
    f['MAX20'] = -ret.rolling(20, min_periods=15).max()
    f['SKEW20'] = -ret.rolling(20, min_periods=15).skew()
    f['AMT20'] = np.log1p(amt.rolling(20, min_periods=15).mean())
    f['VRATIO'] = vol.rolling(5, min_periods=4).mean() / vol.rolling(60, min_periods=40).mean()
    f['AMIHUD'] = -(ret.abs() / amt.replace(0, np.nan)).rolling(20, min_periods=15).mean() * 1e9
    f['PRICE'] = np.log(raw)
    return f, ret, amt


def ic_series(fac, fwd, min_n=300):
    fr = fac.rank(axis=1)
    rr = fwd.rank(axis=1)
    both = fr.notna() & rr.notna()
    n = both.sum(axis=1)
    fr = fr.where(both)
    rr = rr.where(both)
    # 行内去均值后求相关
    fm = fr.sub(fr.mean(axis=1), axis=0)
    rm = rr.sub(rr.mean(axis=1), axis=0)
    num = (fm * rm).sum(axis=1)
    den = np.sqrt((fm**2).sum(axis=1) * (rm**2).sum(axis=1))
    ic = num / den.replace(0, np.nan)
    return ic.where(n >= min_n)


def report(name, ic):
    ic = ic.dropna()
    if len(ic) < 50:
        print(f'{name:8s} 样本不足 ({len(ic)})')
        return
    mean, sd, n = ic.mean(), ic.std(), len(ic)
    t = mean / sd * np.sqrt(n)
    ir = mean / sd
    win = (ic > 0).mean()
    print(f'{name:8s} IC {mean:+.4f}  t {t:+6.2f}  IR {ir:+.3f}  胜率 {win:.1%}  期数 {n}')


if __name__ == '__main__':
    px, raw, vol = load()
    print(f'面板 {px.shape[1]} 只 × {len(px)} 天  {px.index[0].date()} ~ {px.index[-1].date()}  持有 {HOLD} 日')
    f, ret, amt = build(px, raw, vol)
    # 可交易过滤：价格>=2、成交额>=1000万、非涨跌停
    ok = (raw >= 2) & (amt >= 1e7) & (ret.abs() < 0.098)
    fwd = (px.shift(-HOLD) / px - 1)
    fwd = fwd.where(ok)
    print('\n--- Rank IC（横截面，%d 日收益）---' % HOLD)
    res = {}
    for k, v in f.items():
        ic = ic_series(v.where(ok), fwd)
        res[k] = ic
        report(k, ic)
    pd.DataFrame(res).to_csv(f'out_stock_ic_{HOLD}.csv')
    print('\n年度 IC 均值：')
    yr = pd.DataFrame(res)
    print(yr.groupby(yr.index.year).mean().round(4).to_string())
