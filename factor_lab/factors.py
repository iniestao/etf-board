"""
100 个量价因子
=============
设计原则
--------
1. **全部日频可得**：只用 OHLCV + 成交额，不碰分钟数据、财报、分析师。
2. **与 Alpha101 不重叠**：101 个公式化 alpha 已确认失效，这里换成
   「有经济学机制、有文献出处」的构造，而不是符号回归式的随机组合。
3. **每个因子都能讲一句话为什么**：讲不出来的不进池子。纯数据挖掘
   在 1700 只 ETF 上很容易刷出 IC 0.03，样本外必然归零。

九个家族
--------
A 隔夜/日内分解   B 动量与反转      C 波动率结构
D 尾部风险        E 流动性          F 量价关系
G 路径形态        H 技术位置        I 自相关与趋势质量

记号：r 日收益；on 隔夜(open/close_{-1})；id 日内(close/open)；
      vwap = amount/volume（成交额/成交量，即当日均价）。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from panel import Panel, load_universe

FACTORS: dict[str, dict] = {}

DIR = 1   # 因子值越大 → 未来收益越高
NEG = -1  # 因子值越大 → 未来收益越低（评估时会统一翻正）


def reg(name, family, direction, desc, ref=''):
    def deco(fn):
        FACTORS[name] = dict(fn=fn, family=family, direction=direction, desc=desc, ref=ref)
        return fn
    return deco


# ------------------------------------------------------------------ 工具
def _roll_mean(df, n):
    return df.rolling(n, min_periods=n).mean()


def _roll_std(df, n):
    return df.rolling(n, min_periods=n).std()


def _roll(x, n):
    return x.rolling(n, min_periods=n)


def _corr(a, b, n):
    return a.rolling(n, min_periods=n).corr(b)


def _roll_reg(Y: np.ndarray, n: int, chunk: int = 160):
    """滚动线性回归：返回斜率与 R²，Y 为 (T, N) 的 ndarray。

    用 stride 视图 + einsum，比 rolling().apply() 快两个数量级。
    """
    T, N = Y.shape
    slope = np.full((T, N), np.nan, dtype=np.float32)
    r2 = np.full((T, N), np.nan, dtype=np.float32)
    x = np.arange(n, dtype=np.float64)
    xm = x - x.mean()
    sxx = float((xm ** 2).sum())
    for c0 in range(0, N, chunk):
        c1 = min(c0 + chunk, N)
        Yc = Y[:, c0:c1].astype(np.float64)
        W = sliding_window_view(Yc, n, axis=0)          # (T-n+1, cols, n)
        ym = np.nanmean(W, axis=2)
        dev = W - ym[..., None]
        sxy = np.einsum('...k,k->...', dev, xm)
        b = sxy / sxx
        sst = np.einsum('...k,...k->...', dev, dev)
        ssr = b ** 2 * sxx
        with np.errstate(divide='ignore', invalid='ignore'):
            rr = np.where(sst > 0, ssr / sst, np.nan)
        slope[n - 1:, c0:c1] = b
        r2[n - 1:, c0:c1] = rr
    return slope, r2


def _roll_skew(df, n):
    return df.rolling(n, min_periods=n).skew()


def _roll_kurt(df, n):
    return df.rolling(n, min_periods=n).kurt()


def _mkt(P: Panel) -> pd.DataFrame:
    """市场收益代理：当日在池内的 ETF 等权收益。"""
    r = P.close.pct_change(fill_method=None)
    m = r.mean(axis=1)
    return pd.DataFrame(np.repeat(m.values[:, None], r.shape[1], axis=1),
                        index=r.index, columns=r.columns)


def _group_mean(x: pd.DataFrame, group: pd.Series) -> pd.DataFrame:
    """按资产类别求横截面均值，广播回原形状。"""
    g = group.reindex(x.columns)
    out = x.T.groupby(g).transform('mean').T
    return out.reindex(index=x.index, columns=x.columns)


def _beta(x: pd.DataFrame, y: pd.DataFrame, n: int) -> pd.DataFrame:
    """滚动 beta = cov(x,y)/var(y)，y 为市场。"""
    cov = x.rolling(n, min_periods=n).cov(y)
    var = y.rolling(n, min_periods=n).var()
    return cov.div(var.replace(0, np.nan))


def _resid_ret(P: Panel, n: int) -> pd.DataFrame:
    """对市场做滚动回归的残差收益。"""
    r = P.close.pct_change(fill_method=None)
    m = r.mean(axis=1)
    M = pd.DataFrame(np.repeat(m.values[:, None], r.shape[1], axis=1),
                     index=r.index, columns=r.columns)
    b = _beta(r, M, n)
    return r - b * M


# ================================================================== A 隔夜/日内
def _on(P):
    return P.open / P.close.shift(1) - 1


def _id(P):
    return P.close / P.open - 1


@reg('ON_MOM20', 'A 隔夜日内', DIR, '隔夜收益 20 日均值：机构主导时段的信息持续性', 'Lou-Polk-Skouras 2019 JFE')
def f(P):
    return _roll_mean(_on(P), 20)


@reg('ON_MOM60', 'A 隔夜日内', DIR, '隔夜收益 60 日均值（更慢的隔夜动量）', 'Lou-Polk-Skouras 2019 JFE')
def f(P):
    return _roll_mean(_on(P), 60)


@reg('ID_REV5', 'A 隔夜日内', NEG, '日内收益 5 日均值：做市补偿，后续回吐', 'Bogousslavsky 2021 JFE')
def f(P):
    return _roll_mean(_id(P), 5)


@reg('ID_REV20', 'A 隔夜日内', NEG, '日内收益 20 日均值', 'Lou-Polk-Skouras 2019 JFE')
def f(P):
    return _roll_mean(_id(P), 20)


@reg('TUG20', 'A 隔夜日内', DIR, '隔夜减日内（拉锯）：隔夜越强越像信息驱动', 'Lou-Polk-Skouras 2019 JFE')
def f(P):
    on, idr = _on(P), _id(P)
    return _roll_mean(on, 20) - _roll_mean(idr, 20)


@reg('TUG60', 'A 隔夜日内', DIR, '隔夜减日内 60 日', 'Lou-Polk-Skouras 2019 JFE')
def f(P):
    on, idr = _on(P), _id(P)
    return _roll_mean(on, 60) - _roll_mean(idr, 60)


@reg('ON_VSHARE', 'A 隔夜日内', NEG, '隔夜波动占总波动的比例：定价发生在流动性最差的时点', 'Hendershott-Livdan-Rösch 2020 JFE')
def f(P):
    so, si = _roll_std(_on(P), 20), _roll_std(_id(P), 20)
    return so / (so + si).replace(0, np.nan)


@reg('ON_WIN', 'A 隔夜日内', DIR, '隔夜上涨天数占比', '公开资料/常见做法')
def f(P):
    return (_on(P) > 0).rolling(20, min_periods=15).mean()


@reg('ID_WIN', 'A 隔夜日内', NEG, '日内上涨天数占比', '公开资料/常见做法')
def f(P):
    return (_id(P) > 0).rolling(20, min_periods=15).mean()


@reg('ON_ID_CORR', 'A 隔夜日内', NEG, '隔夜与日内的 60 日相关：负相关说明隔夜是流动性冲击', '公开资料/常见做法')
def f(P):
    return _corr(_on(P), _id(P), 60)


# ================================================================== B 动量与反转
def _mom(P, n):
    return P.close.pct_change(n, fill_method=None)


@reg('MOM20', 'B 动量反转', DIR, '1 个月动量', 'Jegadeesh-Titman 1993 JF')
def f(P):
    return _mom(P, 20)


@reg('MOM60', 'B 动量反转', DIR, '3 个月动量', 'Jegadeesh-Titman 1993 JF')
def f(P):
    return _mom(P, 60)


@reg('MOM120', 'B 动量反转', DIR, '6 个月动量', 'Jegadeesh-Titman 1993 JF')
def f(P):
    return _mom(P, 120)


@reg('MOM250', 'B 动量反转', DIR, '12 个月动量', 'Jegadeesh-Titman 1993 JF')
def f(P):
    return _mom(P, 250)


@reg('MOM_12_1', 'B 动量反转', DIR, '跳过最近 1 个月的 12 月动量：避开短期反转污染', 'Jegadeesh-Titman 1993 JF')
def f(P):
    return P.close.shift(20) / P.close.shift(250) - 1


@reg('REV5', 'B 动量反转', NEG, '5 日反转', 'Jegadeesh 1990 JF')
def f(P):
    return P.close.pct_change(5, fill_method=None)


@reg('REV10', 'B 动量反转', NEG, '10 日反转', 'Jegadeesh 1990 JF')
def f(P):
    return P.close.pct_change(10, fill_method=None)


@reg('RESMOM60', 'B 动量反转', DIR, '残差动量（60 日）：剔除市场 beta 后的特质趋势', 'Blitz-Huij-Martens 2011 JEF')
def f(P):
    e = _resid_ret(P, 60)
    return e.rolling(60, min_periods=40).sum()


@reg('RESMOM120', 'B 动量反转', DIR, '残差动量（120 日）', 'Blitz-Huij-Martens 2011 JEF')
def f(P):
    e = _resid_ret(P, 120)
    return e.rolling(120, min_periods=80).sum()


@reg('VMOM', 'B 动量反转', DIR, '波动率调整动量：单位风险的 120 日趋势', 'Barroso-Santa-Clara 2015 JFE')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return _roll_mean(r, 120).div(_roll_std(r, 20).replace(0, np.nan))


@reg('W52', 'B 动量反转', DIR, '距 52 周高点的接近度：锚定效应下的动量', 'George-Hwang 2004 JF')
def f(P):
    return P.close / P.close.rolling(250, min_periods=200).max()


@reg('W52LOW', 'B 动量反转', NEG, '距 52 周低点的距离：越远越弱', 'George-Hwang 2004 JF')
def f(P):
    return P.close / P.close.rolling(250, min_periods=200).min()


@reg('FROG', 'B 动量反转', DIR, '动量生命周期：涨得越平滑（阴线越少）惯性越强', 'Da-Gurun-Warachka 2014 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    n_pos = (r > 0).rolling(120, min_periods=100).sum()
    n_neg = (r < 0).rolling(120, min_periods=100).sum()
    sgn = np.sign(P.close.pct_change(120, fill_method=None))
    return sgn * (n_neg - n_pos) / 120


@reg('PEERMOM', 'B 动量反转', DIR, '同类相对动量：剥离板块 beta 后的组内强弱', 'Moskowitz-Grinblatt 1999 JF')
def f(P):
    m60 = _mom(P, 60)
    return m60 - _group_mean(m60, P.group)


# ================================================================== C 波动率结构
@reg('IVOL60', 'C 波动结构', NEG, '特质波动率：对市场回归残差的 60 日标准差', 'Ang-Hodrick-Xing-Zhang 2006 JF')
def f(P):
    return _roll_std(_resid_ret(P, 60), 60)


@reg('IVOL120', 'C 波动结构', NEG, '特质波动率 120 日', 'Ang et al. 2006 JF')
def f(P):
    return _roll_std(_resid_ret(P, 120), 120)


@reg('RV_RATIO', 'C 波动结构', NEG, '短期/长期波动比：波动率冲击后收益走弱', 'Corsi 2009 JFEc')
def f(P):
    r = P.close.pct_change(fill_method=None)
    s5, s60 = _roll_std(r, 5), _roll_std(r, 60)
    return np.log(s5.div(s60.replace(0, np.nan)))


@reg('VOV', 'C 波动结构', NEG, '波动率的波动：风险本身的不确定性', 'Baltussen-van Bekkum-van der Grient 2018 JFQA')
def f(P):
    r = P.close.pct_change(fill_method=None)
    lv = np.log(_roll_std(r, 5).replace(0, np.nan))
    return _roll_std(lv, 60)


@reg('RUV', 'C 波动结构', DIR, '下行方差占比：真实左尾风险暴露', 'Patton-Sheppard 2015 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    down = (r.where(r < 0) ** 2).rolling(20, min_periods=15).sum()
    tot = (r ** 2).rolling(20, min_periods=15).sum()
    return down.div(tot.replace(0, np.nan))


@reg('RSJ', 'C 波动结构', NEG, '已实现偏度：右偏吸引彩票偏好', 'Amaya et al. 2015 JFE')
def f(P):
    r = P.close.pct_change(fill_method=None)
    m2 = (r ** 2).rolling(20, min_periods=15).mean()
    m3 = (r ** 3).rolling(20, min_periods=15).mean()
    return m3.div(m2.pow(1.5).replace(0, np.nan))


@reg('RKURT', 'C 波动结构', NEG, '已实现峰度：跳跃频发', 'Amaya et al. 2015 JFE')
def f(P):
    r = P.close.pct_change(fill_method=None)
    m2 = (r ** 2).rolling(20, min_periods=15).mean()
    m4 = (r ** 4).rolling(20, min_periods=15).mean()
    return m4.div(m2 ** 2).replace(0, np.nan)


@reg('GKVOL', 'C 波动结构', NEG, 'Garman-Klass 波动率：用高低开收估计，比收盘价法高效', 'Garman-Klass 1980 JBF')
def f(P):
    hl = np.log(P.high.div(P.low.replace(0, np.nan)))
    co = np.log(P.close.div(P.open.replace(0, np.nan)))
    v = (0.5 * hl ** 2 - (2 * np.log(2) - 1) * co ** 2)
    return np.sqrt(v.clip(lower=0).rolling(20, min_periods=15).mean())


@reg('RSVOL', 'C 波动结构', NEG, 'Rogers-Satchell 波动率：允许漂移的估计量', 'Rogers-Satchell 1991 AAP')
def f(P):
    hc = np.log(P.high.div(P.close.replace(0, np.nan)))
    ho = np.log(P.high.div(P.open.replace(0, np.nan)))
    lc = np.log(P.low.div(P.close.replace(0, np.nan)))
    lo = np.log(P.low.div(P.open.replace(0, np.nan)))
    v = hc * ho + lc * lo
    return np.sqrt(v.clip(lower=0).rolling(20, min_periods=15).mean())


@reg('YZVOL', 'C 波动结构', NEG, 'Yang-Zhang 波动率：同时处理隔夜跳空与日内漂移', 'Yang-Zhang 2000 JBF')
def f(P):
    n = 20
    on = np.log(P.open.div(P.close.shift(1).replace(0, np.nan)))
    oc = np.log(P.close.div(P.open.replace(0, np.nan)))
    hc = np.log(P.high.div(P.close.replace(0, np.nan)))
    ho = np.log(P.high.div(P.open.replace(0, np.nan)))
    lc = np.log(P.low.div(P.close.replace(0, np.nan)))
    lo = np.log(P.low.div(P.open.replace(0, np.nan)))
    v_rs = (hc * ho + lc * lo).clip(lower=0)
    v_on = on.rolling(n, min_periods=15).var()
    v_oc = oc.rolling(n, min_periods=15).var()
    v_rsm = v_rs.rolling(n, min_periods=15).mean()
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    return np.sqrt(v_on + k * v_oc + (1 - k) * v_rsm)


@reg('VOL_SKEW', 'C 波动结构', NEG, '波动率序列本身的偏度：波动放大得越突兀越差', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return _roll_skew(_roll_std(r, 5), 60)


@reg('VOL_PERSIST', 'C 波动结构', NEG, '波动率自相关：持续性越强说明风险越难消散', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    v = _roll_std(r, 5)
    return _corr(v, v.shift(1), 60)


# ================================================================== D 尾部风险
@reg('MAX5', 'D 尾部风险', NEG, '前 5 大单日收益均值：彩票偏好', 'Bali-Cakici-Whitelaw 2011 JFE')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return r.rolling(20, min_periods=15).apply(lambda x: np.sort(x)[-5:].mean(), raw=True)


@reg('MAX20', 'D 尾部风险', NEG, '单日最大涨幅：最强彩票信号', 'Bali et al. 2011 JFE')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return r.rolling(20, min_periods=15).max()


@reg('MIN20', 'D 尾部风险', DIR, '单日最大跌幅（取绝对值前先保留符号）：超跌反弹', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return -r.rolling(20, min_periods=15).min()   # 值大 = 跌得少


@reg('CRASHP', 'D 尾部风险', DIR, '暴跌频率：超过 2 倍标准差的下跌日占比', 'Nartea-Kong-Wu 2017 JBF')
def f(P):
    r = P.close.pct_change(fill_method=None)
    thr = -2 * _roll_std(r, 60)
    return (r < thr).rolling(60, min_periods=40).mean()


@reg('CVAR5', 'D 尾部风险', NEG, '5% 条件在险价值（左尾期望损失，取负号使大=安全）', 'Rockafellar-Uryasev 2000')
def f(P):
    r = P.close.pct_change(fill_method=None)
    q = r.rolling(120, min_periods=80).quantile(0.05)
    # 120 天窗口里只有约 6 个点落在 5% 分位以下，min_periods 必须放到 4
    return -r.where(r <= q).rolling(120, min_periods=4).mean()


@reg('TAIL_ASYM', 'D 尾部风险', NEG, '最大涨幅/最大跌幅：不对称的彩票属性', 'Bali et al. 2011 思路扩展')
def f(P):
    r = P.close.pct_change(fill_method=None)
    up = r.rolling(60, min_periods=40).max()
    dn = (-r.rolling(60, min_periods=40).min()).replace(0, np.nan)
    return up.div(dn)


@reg('SKEW60', 'D 尾部风险', NEG, '收益偏度 60 日', 'Harvey-Siddique 2000 JF')
def f(P):
    return _roll_skew(P.close.pct_change(fill_method=None), 60)


@reg('KURT60', 'D 尾部风险', NEG, '收益峰度 60 日', '公开资料/常见做法')
def f(P):
    return _roll_kurt(P.close.pct_change(fill_method=None), 60)


@reg('DBETA', 'D 尾部风险', DIR, '下行 beta：市场下跌时的放大系数', 'Ang-Chen-Xing 2006 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    m = r.mean(axis=1)
    M = pd.DataFrame(np.repeat(m.values[:, None], r.shape[1], axis=1), index=r.index, columns=r.columns)
    down = M < 0
    rd = r.where(down)
    md = M.where(down)
    n = 120
    cov = rd.rolling(n, min_periods=40).cov(md)
    var = md.rolling(n, min_periods=40).var()
    return cov.div(var.replace(0, np.nan))


@reg('UBETA', 'D 尾部风险', NEG, '上行 beta：跟涨能力弱说明弹性差', 'Ang-Chen-Xing 2006 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    m = r.mean(axis=1)
    M = pd.DataFrame(np.repeat(m.values[:, None], r.shape[1], axis=1), index=r.index, columns=r.columns)
    up = M > 0
    ru = r.where(up)
    mu = M.where(up)
    n = 120
    cov = ru.rolling(n, min_periods=40).cov(mu)
    var = mu.rolling(n, min_periods=40).var()
    return cov.div(var.replace(0, np.nan))


# ================================================================== E 流动性
@reg('ILLIQ20', 'E 流动性', DIR, 'Amihud 非流动性：单位成交额的价格冲击', 'Amihud 2002 JFM')
def f(P):
    r = P.close.pct_change(fill_method=None)
    ill = r.abs().div(P.amount.replace(0, np.nan))
    return _roll_mean(ill, 20) * 1e8


@reg('ILLIQ60', 'E 流动性', DIR, 'Amihud 非流动性 60 日', 'Amihud 2002 JFM')
def f(P):
    r = P.close.pct_change(fill_method=None)
    ill = r.abs().div(P.amount.replace(0, np.nan))
    return _roll_mean(ill, 60) * 1e8


@reg('CS_SPREAD', 'E 流动性', DIR, 'Corwin-Schultz 买卖价差：由高低价自协方差反推', 'Corwin-Schultz 2012 JF')
def f(P):
    h, l = P.high, P.low
    h1, l1 = h.shift(1), l.shift(1)
    beta = np.log(h.div(l.replace(0, np.nan))) ** 2 + np.log(h1.div(l1.replace(0, np.nan))) ** 2
    hi = pd.concat([h, h1]).groupby(level=0).max().reindex(h.index)
    lo = pd.concat([l, l1]).groupby(level=0).min().reindex(l.index)
    gamma = np.log(hi.div(lo.replace(0, np.nan))) ** 2
    k = 3 - 2 * np.sqrt(2)
    alpha = (np.sqrt(2 * beta.clip(lower=0)) - np.sqrt(beta.clip(lower=0))) / k - np.sqrt(gamma.clip(lower=0) / k)
    s = 2 * (np.exp(alpha) - 1) / (1 + np.exp(alpha))
    return _roll_mean(s.clip(lower=0), 20)


@reg('ROLL_SPREAD', 'E 流动性', DIR, 'Roll 隐含价差：收益负自相关的幅度', 'Roll 1984 JF')
def f(P):
    r = P.close.pct_change(fill_method=None)
    cov = r.rolling(60, min_periods=40).cov(r.shift(1))
    return 2 * np.sqrt((-cov).clip(lower=0))


@reg('ZERO_RET', 'E 流动性', DIR, '零收益天数占比：交易稀疏的流动性折价', 'Lesmond-Ogden-Trzcinka 1999 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return (r.abs() < 1e-4).rolling(60, min_periods=40).mean()


@reg('AMT_SURGE', 'E 流动性', NEG, '成交额脉冲：5 日相对 60 日的放大倍数', 'Gervais-Kaniel-Mingelgrin 2001 JF')
def f(P):
    a5, a60 = _roll_mean(P.amount, 5), _roll_mean(P.amount, 60)
    return np.log(a5.div(a60.replace(0, np.nan)))


@reg('AMT_TREND', 'E 流动性', DIR, '成交额趋势斜率：资金持续流入 vs 持续撤离', '公开资料/常见做法')
def f(P):
    la = np.log(P.amount.replace(0, np.nan))
    return la.diff(20)


@reg('TURN_20_250', 'E 流动性', NEG, '换手率（成交量/一年均值）：意见分歧与过度交易', 'Liu-Stambaugh-Yuan 2019 JFE')
def f(P):
    return _roll_mean(P.volume, 20).div(_roll_mean(P.volume, 250).replace(0, np.nan))


@reg('TURN_STAB', 'E 流动性', NEG, '换手稳定性：成交量变异系数的倒数，越不稳定越差', '公开资料/常见做法')
def f(P):
    m = _roll_mean(P.volume, 60)
    s = _roll_std(P.volume, 60)
    return m.div(s.replace(0, np.nan))


@reg('LIQ_BETA', 'E 流动性', NEG, '流动性风险 beta：收益对市场流动性冲击的敏感度', 'Pastor-Stambaugh 2003 JPE')
def f(P):
    r = P.close.pct_change(fill_method=None)
    # 市场流动性冲击代理：等权成交额的 20 日变化
    ma = P.amount.mean(axis=1)
    liq = np.log(ma.replace(0, np.nan)).diff()
    shock = np.sign(r.mean(axis=1).shift(1)) * liq.shift(1)
    S = pd.DataFrame(np.repeat(shock.values[:, None], r.shape[1], axis=1), index=r.index, columns=r.columns)
    return _beta(r, S, 60)


@reg('AMT_CV', 'E 流动性', NEG, '成交额变异系数：忽大忽小说明资金不稳定', '公开资料/常见做法')
def f(P):
    return _roll_std(P.amount, 60).div(_roll_mean(P.amount, 60).replace(0, np.nan))


@reg('IMPACT_ELAST', 'E 流动性', NEG, '冲击弹性：|收益| 对 ln(成交额) 的相关，越负越有深度', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None).abs()
    la = np.log(P.amount.replace(0, np.nan))
    return _corr(r, la, 60)


# ================================================================== F 量价关系
@reg('CORR_RV60', 'F 量价关系', DIR, '收益与成交量变化的相关：放量伴随信息流入', 'Llorente et al. 2002 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    lv = np.log(P.volume.replace(0, np.nan)).diff()
    return _corr(r, lv, 60)


@reg('CORR_RV20', 'F 量价关系', DIR, '收益与成交量变化的相关（20 日）', 'Llorente et al. 2002 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    lv = np.log(P.volume.replace(0, np.nan)).diff()
    return _corr(r, lv, 20)


@reg('CORR_RA60', 'F 量价关系', DIR, '收益与成交额的相关：大资金推动的方向', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    la = np.log(P.amount.replace(0, np.nan))
    return _corr(r, la, 60)


@reg('VWAPDEV20', 'F 量价关系', NEG, '收盘价相对当日均价（成交额/成交量）的乖离', 'Berkowitz-Logue-Noser 1988 JF')
def f(P):
    vwap = P.amount.div(P.volume.replace(0, np.nan))
    return _roll_mean(P.close.div(vwap.replace(0, np.nan)) - 1, 20)


@reg('VWAPDEV5', 'F 量价关系', NEG, 'VWAP 乖离 5 日：短期的尾盘拉抬', 'Berkowitz et al. 1988 JF')
def f(P):
    vwap = P.amount.div(P.volume.replace(0, np.nan))
    return _roll_mean(P.close.div(vwap.replace(0, np.nan)) - 1, 5)


@reg('VPS', 'F 量价关系', DIR, '放量日平均收益：增量资金是否真的推动价格', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    v = P.volume
    hot = v > 1.5 * _roll_mean(v, 60)
    return r.where(hot).rolling(60, min_periods=20).mean()


@reg('VDS', 'F 量价关系', NEG, '缩量日平均收益：缩量阴跌代表买盘缺失', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    v = P.volume
    cold = v < 0.7 * _roll_mean(v, 60)
    return r.where(cold).rolling(60, min_periods=20).mean()


@reg('AMTRET', 'F 量价关系', DIR, '成交额加权收益：大额成交日的方向更能代表知情资金', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    num = (r * P.amount).rolling(20, min_periods=15).sum()
    den = P.amount.rolling(20, min_periods=15).sum()
    return num.div(den.replace(0, np.nan))


@reg('VPDIV', 'F 量价关系', NEG, '量价背离：价格接近高点但成交额没有跟上', '公开资料/常见做法')
def f(P):
    p = P.close / P.close.rolling(60, min_periods=40).max() - 1
    a = _roll_mean(P.amount, 5).div(_roll_mean(P.amount, 60).replace(0, np.nan)) - 1
    return p - a


@reg('VELAST', 'F 量价关系', DIR, '量价弹性：收益对成交量变化的回归斜率', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    lv = np.log(P.volume.replace(0, np.nan)).diff()
    cov = r.rolling(60, min_periods=40).cov(lv)
    var = lv.rolling(60, min_periods=40).var()
    return cov.div(var.replace(0, np.nan))


@reg('VOL_ASYM', 'F 量价关系', DIR, '涨跌量比：上涨日成交量/下跌日成交量', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    up = P.volume.where(r > 0).rolling(60, min_periods=20).mean()
    dn = P.volume.where(r < 0).rolling(60, min_periods=20).mean()
    return np.log(up.div(dn.replace(0, np.nan)))


@reg('OBV_SLOPE', 'F 量价关系', DIR, 'OBV 斜率：能量潮的 20 日趋势', 'Granville 1963')
def f(P):
    r = P.close.pct_change(fill_method=None)
    obv = (np.sign(r) * P.volume).cumsum()
    obv = obv.div(P.volume.rolling(250, min_periods=100).mean())
    return obv.diff(20)


# ================================================================== G 路径形态
@reg('MDD60', 'G 路径形态', DIR, '60 日最大回撤：套牢盘出清后的修复空间', 'Chekhlov-Uryasev-Zabarankin 2005')
def f(P):
    roll_max = P.close.rolling(60, min_periods=40).max()
    return 1 - P.close.div(roll_max.replace(0, np.nan))


@reg('MDD120', 'G 路径形态', DIR, '120 日最大回撤', 'Chekhlov et al. 2005')
def f(P):
    roll_max = P.close.rolling(120, min_periods=80).max()
    return 1 - P.close.div(roll_max.replace(0, np.nan))


@reg('PE', 'G 路径形态', DIR, '路径效率：净涨幅/路径总长度，越高越像信息驱动', 'Kaufman 效率系数')
def f(P):
    r = P.close.pct_change(fill_method=None)
    net = P.close.pct_change(20, fill_method=None).abs()
    path = r.abs().rolling(20, min_periods=15).sum()
    return net.div(path.replace(0, np.nan))


@reg('NH60', 'G 路径形态', DIR, '创新高天数占比:信息缓慢扩散的标志', 'George-Hwang 2004 JF')
def f(P):
    hh = P.close.rolling(250, min_periods=200).max()
    return (P.close >= hh * 0.999).rolling(60, min_periods=40).mean()


@reg('NL60', 'G 路径形态', NEG, '创新低天数占比', 'George-Hwang 2004 JF')
def f(P):
    ll = P.close.rolling(250, min_periods=200).min()
    return (P.close <= ll * 1.001).rolling(60, min_periods=40).mean()


@reg('SHADOW', 'G 路径形态', NEG, '上下影线结构：上影线主导说明每次上攻遇抛压', '公开资料/常见做法')
def f(P):
    up = P.high - np.maximum(P.open, P.close)
    dn = np.minimum(P.open, P.close) - P.low
    return _roll_mean((up - dn).div(P.close.replace(0, np.nan)), 20)


@reg('ITS', 'G 路径形态', DIR, '日内趋势强度：收盘在当日振幅中的位置', '公开资料/常见做法')
def f(P):
    rng = (P.high - P.low).replace(0, np.nan)
    return _roll_mean((P.close - P.open).div(rng), 20)


@reg('GAPFILL', 'G 路径形态', DIR, '跳空回补率：低开高走的日子占比（下方有承接）', '公开资料/常见做法')
def f(P):
    gap = P.open.div(P.close.shift(1).replace(0, np.nan)) - 1
    fill = ((gap < 0) & (P.close > P.open)).astype(float)
    return fill.where(gap < 0).rolling(60, min_periods=20).mean()


@reg('UPDN_VOL', 'G 路径形态', DIR, '上行波动/下行波动：好波动多说明收益质量高', 'Patton-Sheppard 2015 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    up = (r.where(r > 0) ** 2).rolling(60, min_periods=30).mean()
    dn = (r.where(r < 0) ** 2).rolling(60, min_periods=30).mean()
    return np.log(up.div(dn.replace(0, np.nan)))


@reg('STREAK', 'G 路径形态', DIR, '连续涨跌强度：近 20 日最长连涨减最长连跌', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    s = np.sign(r)

    def max_streak(x):
        best = cur = 0
        for v in x:
            if v > 0:
                cur += 1
                best = max(best, cur)
            else:
                cur = 0
        return best

    up = s.rolling(20, min_periods=15).apply(max_streak, raw=True)
    dn = (-s).rolling(20, min_periods=15).apply(max_streak, raw=True)
    return up - dn


@reg('PATH_SKEW', 'G 路径形态', NEG, '路径偏度：日内收益分布的偏斜方向', '公开资料/常见做法')
def f(P):
    return _roll_skew(_id(P), 60)


@reg('RECOVERY', 'G 路径形态', DIR, '修复速度：从 20 日低点反弹的幅度', '公开资料/常见做法')
def f(P):
    ll = P.close.rolling(20, min_periods=15).min()
    return P.close.div(ll.replace(0, np.nan)) - 1


# ================================================================== H 技术位置
@reg('DIST_H20', 'H 技术位置', NEG, '距 20 日高点的距离：越近越强（取负使方向为正）', '公开资料/常见做法')
def f(P):
    hh = P.high.rolling(20, min_periods=15).max()
    return -(hh.div(P.close.replace(0, np.nan)) - 1)


@reg('DIST_L20', 'H 技术位置', DIR, '距 20 日低点的高度', '公开资料/常见做法')
def f(P):
    ll = P.low.rolling(20, min_periods=15).min()
    return P.close.div(ll.replace(0, np.nan)) - 1


@reg('DIST_H60', 'H 技术位置', NEG, '距 60 日高点距离', '公开资料/常见做法')
def f(P):
    hh = P.high.rolling(60, min_periods=40).max()
    return -(hh.div(P.close.replace(0, np.nan)) - 1)


@reg('DIST_L60', 'H 技术位置', DIR, '距 60 日低点高度', '公开资料/常见做法')
def f(P):
    ll = P.low.rolling(60, min_periods=40).min()
    return P.close.div(ll.replace(0, np.nan)) - 1


@reg('MA_SLOPE20', 'H 技术位置', DIR, '20 日均线斜率', '公开资料/常见做法')
def f(P):
    ma = _roll_mean(P.close, 20)
    return ma.div(ma.shift(5).replace(0, np.nan)) - 1


@reg('MA_SLOPE60', 'H 技术位置', DIR, '60 日均线斜率', '公开资料/常见做法')
def f(P):
    ma = _roll_mean(P.close, 60)
    return ma.div(ma.shift(10).replace(0, np.nan)) - 1


@reg('MA_ALIGN', 'H 技术位置', DIR, '均线多头排列强度：5>20>60 的标准化差值', '公开资料/常见做法')
def f(P):
    m5, m20, m60 = _roll_mean(P.close, 5), _roll_mean(P.close, 20), _roll_mean(P.close, 60)
    c = P.close.replace(0, np.nan)
    return (m5 - m20).div(c) + (m20 - m60).div(c)


@reg('BREAKOUT', 'H 技术位置', DIR, '突破强度：收盘突破 60 日高点的幅度', '公开资料/常见做法')
def f(P):
    hh = P.high.rolling(60, min_periods=40).max().shift(1)
    return P.close.div(hh.replace(0, np.nan)) - 1


@reg('RANGE_POS', 'H 技术位置', DIR, '区间位置：60 日高低区间中的相对位置', '公开资料/常见做法')
def f(P):
    hh = P.high.rolling(60, min_periods=40).max()
    ll = P.low.rolling(60, min_periods=40).min()
    return (P.close - ll).div((hh - ll).replace(0, np.nan))


@reg('SUPPORT', 'H 技术位置', DIR, '支撑强度：近 60 日触及低点后反弹的幅度均值', '公开资料/常见做法')
def f(P):
    ll = P.low.rolling(60, min_periods=40).min()
    touch = P.low <= ll * 1.01
    bounce = (P.close.div(P.low.replace(0, np.nan)) - 1)
    return bounce.where(touch).rolling(60, min_periods=10).mean()


# ================================================================== I 自相关与趋势质量
@reg('AR1_20', 'I 自相关', DIR, '一阶自相关 20 日：正相关代表趋势延续', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return _corr(r, r.shift(1), 20)


@reg('AR1_60', 'I 自相关', DIR, '一阶自相关 60 日', '公开资料/常见做法')
def f(P):
    r = P.close.pct_change(fill_method=None)
    return _corr(r, r.shift(1), 60)


@reg('VR5', 'I 自相关', DIR, '方差比 5：5 日收益方差/(5×日方差)，>1 趋势型', 'Lo-MacKinlay 1988 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    r5 = P.close.pct_change(5, fill_method=None)
    return r5.rolling(120, min_periods=80).var().div((5 * r.rolling(120, min_periods=80).var()).replace(0, np.nan))


@reg('VR20', 'I 自相关', DIR, '方差比 20', 'Lo-MacKinlay 1988 RFS')
def f(P):
    r = P.close.pct_change(fill_method=None)
    r20 = P.close.pct_change(20, fill_method=None)
    return r20.rolling(250, min_periods=150).var().div((20 * r.rolling(250, min_periods=150).var()).replace(0, np.nan))


@reg('HURST', 'I 自相关', DIR, 'Hurst 指数代理：log(σ5/σ1)/log(5)，>0.5 为持续', 'Hurst 1951')
def f(P):
    r = P.close.pct_change(fill_method=None)
    s1 = _roll_std(r, 60)
    s5 = _roll_std(P.close.pct_change(5, fill_method=None), 60)
    return np.log(s5.div(s1.replace(0, np.nan))) / np.log(5)


@reg('TREND_R2', 'I 自相关', DIR, '趋势拟合优度：60 日对数价格线性回归 R²', '公开资料/常见做法')
def f(P):
    lp = np.log(P.close.where(P.close > 0))
    _, r2 = _roll_reg(lp.values.astype(np.float64), 60)
    return pd.DataFrame(r2, index=P.close.index, columns=P.close.columns)


@reg('TREND_SLOPE', 'I 自相关', DIR, '趋势斜率：60 日对数价格回归斜率（年化）', '公开资料/常见做法')
def f(P):
    lp = np.log(P.close.where(P.close > 0))
    sl, _ = _roll_reg(lp.values.astype(np.float64), 60)
    return pd.DataFrame(sl * 244, index=P.close.index, columns=P.close.columns)


@reg('MR_SPEED', 'I 自相关', NEG, '均值回复速度：偏离 20 日均线的回归强度', '公开资料/常见做法')
def f(P):
    ma = _roll_mean(P.close, 20)
    dev = P.close.div(ma.replace(0, np.nan)) - 1
    return _corr(dev, dev.shift(1), 60)


# ------------------------------------------------------------------ 主入口
def compute_all(P: Panel, names: list[str] | None = None,
                verbose: bool = True) -> dict[str, pd.DataFrame]:
    out = {}
    todo = names or list(FACTORS)
    for i, nm in enumerate(todo, 1):
        spec = FACTORS[nm]
        try:
            v = spec['fn'](P)
            v = v.reindex(index=P.close.index, columns=P.close.columns)
            out[nm] = v.astype(np.float32)
            if verbose and i % 20 == 0:
                print(f'  {i}/{len(todo)} 完成', flush=True)
        except Exception as e:
            print(f'  [跳过] {nm}: {type(e).__name__} {e}', flush=True)
    return out


if __name__ == '__main__':
    import time
    t0 = time.time()
    P = load_universe()
    print(f'面板 {P.close.shape}，因子数 {len(FACTORS)}')
    fam = {}
    for k, v in FACTORS.items():
        fam[v['family']] = fam.get(v['family'], 0) + 1
    for k, v in fam.items():
        print(f'  {k}: {v}')
    res = compute_all(P)
    print(f'完成 {len(res)} 个，耗时 {time.time()-t0:.1f}s')
    # 覆盖率检查
    for nm in list(res)[:5]:
        print(nm, '有效占比', round(float(res[nm].notna().mean().mean()), 3))
