"""
分层检验：IC 是秩相关，组合吃的是两端。两者背离时必须看分位收益的单调性。
另外做规模中性化：低成交额/低波到底是真 alpha，还是小盘马甲的另一种说法。
"""
import pandas as pd
import numpy as np
import stock_factor as sf
from stock_portfolio import month_ends

if __name__ == '__main__':
    px, raw, vol = sf.load()
    f, ret, amt = sf.build(px, raw, vol)
    ok = (raw >= 2) & (amt >= 1e7)
    for k in f:
        f[k] = f[k].where(ok)
    tds = px.index
    me = pd.DatetimeIndex([t for t in month_ends(tds) if t <= tds[-25]])
    S = {k: v.reindex(index=me) for k, v in f.items()}
    S['OK'] = ok.reindex(index=me)
    sub = px.reindex(index=me)
    F = (sub.shift(-1) / sub - 1).where(S['OK'])
    B = F.mean(axis=1)          # 全A等权，作为每组超额基准

    print('=== 十分位月均超额收益（相对全A等权，%）===\n')
    print(f'{"因子":9s}' + ''.join(f'{"D%d"%(i+1):>7s}' for i in range(10)) + '   顶-底')
    for k in ['VOL20', 'MAX20', 'AMT20', 'REV20', 'VRATIO', 'PRICE']:
        x = S[k]
        q = x.rank(axis=1, pct=True)
        line = []
        for i in range(10):
            lo, hi = i / 10, (i + 1) / 10
            m = (q > lo) & (q <= hi)
            ex = (F - B.values[:, None]).where(m).mean(axis=1)
            line.append(ex.mean() * 100)
        spread = line[9] - line[0]
        print(f'{k:9s}' + ''.join(f'{v:+7.2f}' for v in line) + f'  {spread:+6.2f}')

    # ---- 规模中性化：先按成交额分5层，层内按因子分5组 ----
    print('\n=== 规模中性化（先按 AMT20 分 5 层，层内再按因子分 5 组，月均超额 %）===')
    size = S['AMT20'].rank(axis=1, pct=True)
    for k in ['VOL20', 'MAX20', 'REV20']:
        fac = S[k].rank(axis=1, pct=True)
        print(f'\n--- {k} ---')
        print('      ' + ''.join(f'{"小盘" if i==0 else "":>0s}' for i in range(1)) + '  '.join([f'Q{i+1}' for i in range(5)]))
        for j in range(5):
            slo, shi = j / 5, (j + 1) / 5
            sm = (size > slo) & (size <= shi)
            row = []
            for i in range(5):
                flo, fhi = i / 5, (i + 1) / 5
                m = sm & (fac > flo) & (fac <= fhi)
                ex = (F - B.values[:, None]).where(m).mean(axis=1)
                row.append(ex.mean() * 100)
            tag = ['最小盘', 'Q2', 'Q3', 'Q4', '最大盘'][j]
            print(f'{tag:6s}' + ''.join(f'{v:+7.2f}' for v in row) + f'   | 底-顶 {row[0]-row[4]:+6.2f}')
