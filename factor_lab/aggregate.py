"""
从个股到 ETF：把个股因子按 PCF 持仓权重聚合成 ETF 的「成分股画像」，再检验它能不能预测 ETF 收益。
对照组：同样定义、但直接在 ETF 自己的价格序列上算的因子。
两者之差 = 成分股里被组合分散掉的那部分信息。
"""
import sqlite3
import numpy as np
import pandas as pd
import stock_factor as sf

HOLD = 20


def trading_days():
    con = sqlite3.connect('../data/etf.db')
    d = pd.read_sql("select distinct date from etf_daily where date>='2018-01-01'", con)
    con.close()
    return pd.to_datetime(d['date']).sort_values().reset_index(drop=True)


def map_to_td(dates, tds):
    """把 PCF 的月末日期映射到 <= 它的最近交易日"""
    out = {}
    for s in dates:
        d = pd.Timestamp(f'{s[:4]}-{s[4:6]}-{s[6:]}')
        i = tds.searchsorted(d, side='right') - 1
        if i >= 0:
            out[s] = tds[i]
    return out


def weights(pcf_dates, px):
    """每 (etf, date) 的成分股权重，按 qty × 收盘价市值归一（只含 A 股）"""
    con = sqlite3.connect('pcf.db')
    h = pd.read_sql("select code,date,stock,qty,market from pcf_hold "
                    "where market in ('SH','SZ','BJ','OT') and qty>0", con)
    tot = pd.read_sql("select code,date,count(*) n from pcf_hold group by code,date", con)
    con.close()
    h = h[h.date.isin(pcf_dates)]
    # 个股当日价
    pl = px.stack().rename('px').reset_index()
    pl.columns = ['td', 'stock', 'px']
    return h, tot, pl


if __name__ == '__main__':
    tds = trading_days()
    con = sqlite3.connect('pcf.db')
    pcf_dates = [r[0] for r in con.execute('select distinct date from pcf_hold order by date')]
    con.close()
    dmap = map_to_td(pcf_dates, tds)
    print(f'PCF 快照 {len(pcf_dates)} 个，映射到 {len(set(dmap.values()))} 个交易日')

    # ---------- 个股因子 ----------
    px, raw, vol = sf.load()
    print(f'个股面板 {px.shape[1]} 只 × {len(px)} 天')
    f, ret, amt = sf.build(px, raw, vol)
    ok = (raw >= 2) & (amt >= 1e7)
    for k in f:
        f[k] = f[k].where(ok).rank(axis=1, pct=True)   # 横截面分位，0~1

    need = sorted(set(dmap.values()))
    longs = {}
    for k in f:
        s = f[k].reindex(index=need).stack()
        s.index.names = ['td', 'stock']
        longs[k] = s

    # ---------- 持仓与权重 ----------
    con = sqlite3.connect('pcf.db')
    h = pd.read_sql("select code,date,stock,qty,market from pcf_hold "
                    "where market in ('SH','SZ','BJ','OT') and qty>0", con)
    n_all = pd.read_sql("select code,date,count(*) n_all from pcf_hold "
                        "where qty>0 group by code,date", con)
    con.close()
    h = h[h.date.isin(list(dmap))].copy()
    h['td'] = h.date.map(dmap)
    print(f'持仓明细 {len(h):,} 行，覆盖 {h.code.nunique()} 只 ETF')

    # 市值权重
    pl = px.stack().rename('px').reset_index()
    pl.columns = ['td', 'stock', 'px']
    h = h.merge(pl, on=['td', 'stock'], how='left')
    miss = h.px.isna().mean()
    print(f'成分股价格缺失率 {miss:.2%}')
    h = h.dropna(subset=['px'])
    h['mv'] = h.qty * h.px
    # A 股覆盖度（只数口径）
    h = h.merge(n_all, on=['code', 'date'], how='left')
    h['w'] = h.mv / h.groupby(['date', 'code']).mv.transform('sum')
    cov = h.groupby(['date', 'code']).agg(n_a=('stock', 'size'), n_all=('n_all', 'first')).reset_index()
    cov['cover'] = cov.n_a / cov.n_all
    print('A股只数覆盖度分布:', cov.cover.describe()[['25%', '50%', '75%']].round(2).to_dict())

    # ---------- 聚合 ----------
    agg = {}
    for k, s in longs.items():
        x = h.merge(s.rename('v'), on=['td', 'stock'], how='left')
        x['wv'] = x.w * x.v
        g = x.groupby(['td', 'code']).agg(score=('wv', 'sum'), wsum=('w', 'sum')).reset_index()
        g['score'] = g.score / g.wsum
        agg[k] = g.pivot(index='td', columns='code', values='score')
    print(f'聚合完成，{len(agg)} 个因子 × {agg["VOL20"].shape[1]} 只 ETF × {agg["VOL20"].shape[0]} 月')

    # ---------- ETF 自身因子（对照） ----------
    con = sqlite3.connect('../data/etf.db')
    e = pd.read_sql("select code,date,close,adj_factor,volume,amount from etf_daily", con)
    con.close()
    e['date'] = pd.to_datetime(e.date)
    ep = e.pivot_table(index='date', columns='code', values='close') * \
         e.pivot_table(index='date', columns='code', values='adj_factor')
    ea = e.pivot_table(index='date', columns='code', values='amount')
    er = ep.pct_change(fill_method=None)
    own = {
        'REV20': -ep.pct_change(20, fill_method=None),
        'VOL20': -er.rolling(20, min_periods=15).std(),
        'MAX20': -er.rolling(20, min_periods=15).max(),
        'AMT20': np.log1p(ea.rolling(20, min_periods=15).mean()),
        'VRATIO': e.pivot_table(index='date', columns='code', values='volume')
                    .rolling(5, min_periods=4).mean() /
                  e.pivot_table(index='date', columns='code', values='volume')
                    .rolling(60, min_periods=40).mean(),
        'PRICE': np.log(ep),
    }

    # ---------- 未来收益 ----------
    fwd = ep.shift(-HOLD) / ep - 1

    print('\n=== ETF 横截面 Rank IC（%d 日，96 个月截面）===' % HOLD)
    print(f'{"因子":10s} {"成分股聚合":>22s} {"ETF 自身":>22s}')
    print(f'{"":10s} {"IC":>7s}{"t":>7s}{"胜率":>8s} {"IC":>7s}{"t":>7s}{"胜率":>8s}')
    rows = []
    for k in ['REV20', 'VOL20', 'MAX20', 'AMT20', 'VRATIO', 'PRICE']:
        a = agg[k].copy()
        b = own[k].reindex(index=need).copy()
        line = []
        for src in (a, b):
            x = src.reindex(index=fwd.index)
            y = fwd.reindex(columns=x.columns)
            ics = []
            for t in x.index:
                if t not in y.index:
                    continue
                v = x.loc[t].dropna()
                u = y.loc[t].reindex(v.index).dropna()
                v = v.reindex(u.index)
                if len(u) < 30:
                    continue
                ics.append(v.rank().corr(u.rank()))
            ics = pd.Series(ics).dropna()
            line += [ics.mean(), ics.mean() / ics.std() * np.sqrt(len(ics)), (ics > 0).mean(), len(ics)]
        print(f'{k:10s} {line[0]:+7.4f}{line[1]:+7.2f}{line[2]:8.1%} '
              f'{line[4]:+7.4f}{line[5]:+7.2f}{line[6]:8.1%}')
        rows.append([k] + line)
    pd.DataFrame(rows, columns=['f', 'agg_ic', 'agg_t', 'agg_win', 'agg_n',
                                'own_ic', 'own_t', 'own_win', 'own_n']).to_csv('out_agg_ic.csv', index=False)

    # ========== 载体效率：ETF 能装进多少 ==========
    print('\n=== ETF 按成分股画像分 5 组，月均超额（相对全体 ETF 等权，%）===')
    print('（个股层面同一因子 D1-D10 的差距附在最后一行做对照）')
    stock_ref = {'AMT20': 1.82, 'VOL20': 1.15, 'MAX20': 0.96, 'REV20': 1.54, 'PRICE': 0.55, 'VRATIO': 1.14}
    for k in ['AMT20', 'VOL20', 'MAX20', 'REV20', 'PRICE']:
        a = agg[k].reindex(index=fwd.index)
        r = fwd.reindex(columns=a.columns)
        base = r.mean(axis=1)
        q = a.rank(axis=1, pct=True)
        line = []
        for i in range(5):
            m = (q > i / 5) & (q <= (i + 1) / 5)
            ex = (r - base.values[:, None]).where(m).mean(axis=1)
            line.append(ex.mean() * 100)
        print(f'{k:8s}' + ''.join(f'{v:+7.2f}' for v in line) +
              f'   | 组间差 {line[0]-line[-1]:+6.2f}  个股同向 {stock_ref[k]:5.2f}')

    # 最新一期的成分股画像（可操作产物）
    last = agg['AMT20'].index[-1]
    prof = pd.DataFrame({k: agg[k].loc[last] for k in ['AMT20', 'VOL20', 'MAX20', 'REV20', 'PRICE']})
    prof['n'] = 1
    prof.to_csv(f'out_etf_profile_{last.date()}.csv')
    print(f'\n最新一期画像已存 out_etf_profile_{last.date()}.csv  ({len(prof)} 只 ETF)')
