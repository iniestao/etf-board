"""
涨停反转：个股层面的发现 → 聚合到 ETF。
一只 ETF 的成分股里有多少刚涨停过，是价格序列里完全看不到的信息。
"""
import sqlite3
import numpy as np
import pandas as pd
import stock_factor as sf
from aggregate import trading_days, map_to_td

if __name__ == '__main__':
    tds = trading_days()
    con = sqlite3.connect('pcf.db')
    pcf_dates = [r[0] for r in con.execute('select distinct date from pcf_hold order by date')]
    con.close()
    dmap = map_to_td(pcf_dates, tds)
    need = sorted(set(dmap.values()))

    px, raw, vol = sf.load()
    ret = px.pct_change(fill_method=None)
    amt = raw * vol
    ok = (raw >= 2) & (amt >= 1e7)
    LIM = (ret > 0.095).rolling(20, min_periods=15).sum().where(ok)
    # 个股层面基准：分位化
    limp = LIM.rank(axis=1, pct=True)

    s = limp.reindex(index=need).stack()
    s.index.names = ['td', 'stock']

    con = sqlite3.connect('pcf.db')
    h = pd.read_sql("select code,date,stock,qty,market from pcf_hold "
                    "where market in ('SH','SZ','BJ','OT') and qty>0", con)
    con.close()
    h = h[h.date.isin(list(dmap))].copy()
    h['td'] = h.date.map(dmap)

    pl = px.stack().rename('px').reset_index()
    pl.columns = ['td', 'stock', 'px']
    h = h.merge(pl, on=['td', 'stock'], how='left').dropna(subset=['px'])
    h['mv'] = h.qty * h.px
    h['w'] = h.mv / h.groupby(['date', 'code']).mv.transform('sum')

    x = h.merge(s.rename('v'), on=['td', 'stock'], how='left')
    x['wv'] = x.w * x.v
    g = x.groupby(['td', 'code']).agg(score=('wv', 'sum'), ws=('w', 'sum')).reset_index()
    g['score'] = g.score / g.ws
    prof = g.pivot(index='td', columns='code', values='score')

    # ETF 未来 20 日收益
    con = sqlite3.connect('../data/etf.db')
    e = pd.read_sql("select code,date,close,adj_factor from etf_daily", con)
    con.close()
    e['date'] = pd.to_datetime(e.date)
    ep = e.pivot_table(index='date', columns='code', values='close') * \
         e.pivot_table(index='date', columns='code', values='adj_factor')
    fwd = ep.shift(-20) / ep - 1

    a = prof.reindex(index=fwd.index)
    r = fwd.reindex(columns=a.columns)
    base = r.mean(axis=1)
    q = a.rank(axis=1, pct=True)

    print(f'ETF 成分股涨停占比画像：{a.shape[1]} 只 × {a.shape[0]} 期\n')
    print('=== 按成分股涨停占比分 5 组，未来 20 日超额（%，相对全体 ETF 等权）===')
    line, ics = [], []
    for i in range(5):
        m = (q > i / 5) & (q <= (i + 1) / 5)
        ex = (r - base.values[:, None]).where(m).mean(axis=1)
        line.append(ex.mean() * 100)
        if len(ex.dropna()):
            pass
    print(''.join(f'Q{i+1}:{v:+.3f}  ' for i, v in enumerate(line)))
    print(f'   Q1-Q5 = {line[0]-line[-1]:+.3f}%/月，年化约 {(1+line[0]/100)**12-(1+line[-1]/100)**12:+.1%}')

    # IC 序列
    for t in a.index:
        v = a.loc[t].dropna()
        u = r.loc[t].reindex(v.index).dropna()
        v = v.reindex(u.index)
        if len(u) >= 30:
            ics.append(v.rank().corr(u.rank()))
    ics = pd.Series(ics).dropna()
    print(f'\nRank IC {ics.mean():+.4f}  t {ics.mean()/ics.std()*np.sqrt(len(ics)):+.2f}  '
          f'胜率 {(ics<0).mean():.1%}（负向）  期数 {len(ics)}')
    print('\n分年 Q1-Q5 差（%）：')
    ann = {}
    for i, lab in [(0, 'Q1低涨停'), (4, 'Q5高涨停')]:
        m = (q > i / 5) & (q <= (i + 1) / 5)
        ex = (r - base.values[:, None]).where(m).mean(axis=1)
        ann[lab] = ex * 100
    T = pd.DataFrame(ann).dropna()
    print((T.groupby(T.index.year).mean()).round(2).to_string())
    prof.to_csv('out_etf_limit.csv')
