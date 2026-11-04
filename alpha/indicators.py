"""
技术指标库
==========
按用途分五类，全部接收宽表（index=date, columns=code），返回同形状 DataFrame。

价格类指标一律用「后复权价」计算，否则分红除权会造成假信号。
成交量类指标用原始 volume（复权不改变量）。

命名遵循国内看盘软件习惯（MA/EMA/MACD/KDJ/BOLL），便于与行情软件对照。
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# ---------------------------------------------------------------- 趋势类
def sma(close: pd.DataFrame, n: int) -> pd.DataFrame:
    """简单移动平均。"""
    return close.rolling(n, min_periods=n).mean()


def ema(close: pd.DataFrame, n: int) -> pd.DataFrame:
    """指数移动平均。alpha = 2/(n+1)。"""
    return close.ewm(span=n, adjust=False, min_periods=n).mean()


def wma(close: pd.DataFrame, n: int) -> pd.DataFrame:
    """加权移动平均，权重 1..n。"""
    w = np.arange(1, n + 1, dtype=float)
    w /= w.sum()
    return close.rolling(n, min_periods=n).apply(lambda x: float(np.dot(x, w)), raw=True)


def macd(close: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9):
    """MACD：返回 (DIF, DEA, MACD柱)。

    DIF = EMA12 − EMA26
    DEA = EMA9(DIF)
    柱  = 2 × (DIF − DEA)    ← 国内软件惯例乘 2
    """
    dif = ema(close, fast) - ema(close, slow)
    dea = dif.ewm(span=signal, adjust=False, min_periods=signal).mean()
    hist = 2 * (dif - dea)
    return dif, dea, hist


def dmi(high, low, close, n: int = 14):
    """DMI 趋向指标：返回 (PDI, MDI, ADX)。

    这是判断「趋势有没有」而非「方向」的指标，ADX>25 视为有趋势。
    """
    up = high.diff()
    dn = -low.diff()
    plus_dm = up.where((up > dn) & (up > 0), 0.0)
    minus_dm = dn.where((dn > up) & (dn > 0), 0.0)

    tr = _true_range(high, low, close)
    atr_n = tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()

    pdi = 100 * plus_dm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr_n
    mdi = 100 * minus_dm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr_n
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    adx = dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return pdi, mdi, adx


def aroon(high, low, n: int = 25):
    """Aroon：距离最近 n 日最高/最低点多少天。返回 (AroonUp, AroonDown)。"""
    up = high.rolling(n + 1, min_periods=n + 1).apply(lambda x: float(np.argmax(x)), raw=True)
    dn = low.rolling(n + 1, min_periods=n + 1).apply(lambda x: float(np.argmin(x)), raw=True)
    return 100 * up / n, 100 * dn / n


def trix(close: pd.DataFrame, n: int = 12) -> pd.DataFrame:
    """三重指数平滑均值的变化率（%）。"""
    e = ema(ema(ema(close, n), n), n)
    return 100 * e.pct_change(fill_method=None)


def bias(close: pd.DataFrame, n: int = 6) -> pd.DataFrame:
    """乖离率：(收盘 − MA) / MA × 100。"""
    ma = sma(close, n)
    return 100 * (close - ma) / ma


# ---------------------------------------------------------------- 动量类
def rsi(close: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    """RSI，Wilder 平滑。

    注意：国内软件用 SMA(X,N,1)（即 alpha=1/N 的 EMA），
    与 Wilder 原始定义一致，但与「简单平均涨跌幅」算法略有差异。
    """
    d = close.diff()
    up = d.clip(lower=0)
    dn = (-d).clip(lower=0)
    au = up.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 * au / (au + ad).replace(0, np.nan)


def kdj(high, low, close, n: int = 9, k_period: int = 3, d_period: int = 3):
    """KDJ：返回 (K, D, J)。"""
    ll = low.rolling(n, min_periods=n).min()
    hh = high.rolling(n, min_periods=n).max()
    rsv = 100 * (close - ll) / (hh - ll).replace(0, np.nan)
    k = rsv.ewm(alpha=1 / k_period, adjust=False, min_periods=1).mean()
    d = k.ewm(alpha=1 / d_period, adjust=False, min_periods=1).mean()
    return k, d, 3 * k - 2 * d


def williams_r(high, low, close, n: int = 14) -> pd.DataFrame:
    """Williams %R，取值 −100..0。"""
    hh = high.rolling(n, min_periods=n).max()
    ll = low.rolling(n, min_periods=n).min()
    return -100 * (hh - close) / (hh - ll).replace(0, np.nan)


def roc(close: pd.DataFrame, n: int = 12) -> pd.DataFrame:
    """变动率（%）。"""
    return 100 * close.pct_change(n, fill_method=None)


def mom(close: pd.DataFrame, n: int = 10) -> pd.DataFrame:
    """动量：close − close[n]。"""
    return close.diff(n)


def cmo(close: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    """钱德动量摆动指标，取值 −100..100。"""
    d = close.diff()
    up = d.clip(lower=0).rolling(n, min_periods=n).sum()
    dn = (-d).clip(lower=0).rolling(n, min_periods=n).sum()
    return 100 * (up - dn) / (up + dn).replace(0, np.nan)


def tsi(close: pd.DataFrame, long: int = 25, short: int = 13) -> pd.DataFrame:
    """真实强度指标，对价格变化做双重平滑。"""
    m = close.diff()
    num = ema(ema(m, long), short)
    den = ema(ema(m.abs(), long), short)
    return 100 * num / den.replace(0, np.nan)


def ultimate_oscillator(high, low, close, n1=7, n2=14, n3=28) -> pd.DataFrame:
    """终极摆动指标。"""
    prev_c = close.shift(1)
    bp = close - pd.concat([low, prev_c]).min()
    tr = pd.concat([high, prev_c]).max() - pd.concat([low, prev_c]).min()
    a1 = bp.rolling(n1, min_periods=n1).sum() / tr.rolling(n1, min_periods=n1).sum()
    a2 = bp.rolling(n2, min_periods=n2).sum() / tr.rolling(n2, min_periods=n2).sum()
    a3 = bp.rolling(n3, min_periods=n3).sum() / tr.rolling(n3, min_periods=n3).sum()
    return 100 * (4 * a1 + 2 * a2 + a3) / 7


def cci(high, low, close, n: int = 20) -> pd.DataFrame:
    """顺势指标。"""
    tp = (high + low + close) / 3
    ma = tp.rolling(n, min_periods=n).mean()
    md = (tp - ma).abs().rolling(n, min_periods=n).mean()
    return (tp - ma) / (0.015 * md.replace(0, np.nan))


def psy(close: pd.DataFrame, n: int = 12) -> pd.DataFrame:
    """心理线：n 日内上涨天数占比（%）。"""
    up = (close.diff() > 0).astype(float)
    return 100 * up.rolling(n, min_periods=n).mean()


# ---------------------------------------------------------------- 波动类
def _true_range(high, low, close) -> pd.DataFrame:
    prev_c = close.shift(1)
    return pd.concat([high - low,
                      (high - prev_c).abs(),
                      (low - prev_c).abs()]).groupby(level=0).max()


def atr(high, low, close, n: int = 14) -> pd.DataFrame:
    """平均真实波幅（Wilder 平滑）。"""
    tr = _true_range(high, low, close)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def natr(high, low, close, n: int = 14) -> pd.DataFrame:
    """归一化 ATR（%），便于跨标的比较。"""
    return 100 * atr(high, low, close, n) / close.replace(0, np.nan)


def boll(close: pd.DataFrame, n: int = 20, k: float = 2.0):
    """布林带：返回 (上轨, 中轨, 下轨, %B, 带宽)。"""
    mid = sma(close, n)
    sd = close.rolling(n, min_periods=n).std()
    up, lo = mid + k * sd, mid - k * sd
    pctb = (close - lo) / (up - lo).replace(0, np.nan)
    width = (up - lo) / mid.replace(0, np.nan)
    return up, mid, lo, pctb, width


def keltner(high, low, close, n: int = 20, k: float = 2.0):
    """肯特纳通道（用 ATR 而非标准差）。"""
    mid = ema(close, n)
    a = atr(high, low, close, n)
    return mid + k * a, mid, mid - k * a


def donchian(high, low, n: int = 20):
    """唐奇安通道：n 日最高/最低。"""
    return high.rolling(n, min_periods=n).max(), low.rolling(n, min_periods=n).min()


def hist_vol(close: pd.DataFrame, n: int = 20, ann: int = 244) -> pd.DataFrame:
    """历史波动率（年化，%）。"""
    r = close.pct_change(fill_method=None)
    return 100 * r.rolling(n, min_periods=n).std() * np.sqrt(ann)


def parkinson_vol(high, low, n: int = 20, ann: int = 244) -> pd.DataFrame:
    """Parkinson 波动率：只用户外高低价，比收盘价法更有效。

    公式：sqrt( mean(ln(H/L)^2) / (4 ln2) ) × sqrt(244)
    """
    hl = np.log(high / low.replace(0, np.nan))
    return 100 * np.sqrt((hl ** 2).rolling(n, min_periods=n).mean() / (4 * np.log(2)) * ann)


# ---------------------------------------------------------------- 量能类
def obv(close: pd.DataFrame, volume: pd.DataFrame) -> pd.DataFrame:
    """能量潮：涨日加量、跌日减量的累计。"""
    sgn = np.sign(close.diff().fillna(0))
    return (sgn * volume).cumsum()


def ad_line(high, low, close, volume) -> pd.DataFrame:
    """累积/派发线。"""
    rng = (high - low).replace(0, np.nan)
    clv = ((close - low) - (high - close)) / rng
    return (clv * volume).cumsum()


def cmf(high, low, close, volume, n: int = 20) -> pd.DataFrame:
    """蔡金资金流量。"""
    rng = (high - low).replace(0, np.nan)
    mfm = ((close - low) - (high - close)) / rng
    return (mfm * volume).rolling(n, min_periods=n).sum() / volume.rolling(n, min_periods=n).sum().replace(0, np.nan)


def mfi(high, low, close, volume, n: int = 14) -> pd.DataFrame:
    """资金流量指标（带量的 RSI）。"""
    tp = (high + low + close) / 3
    mf = tp * volume
    d = tp.diff()
    pos = mf.where(d > 0, 0.0).rolling(n, min_periods=n).sum()
    neg = mf.where(d < 0, 0.0).rolling(n, min_periods=n).sum()
    return 100 - 100 / (1 + pos / neg.replace(0, np.nan))


def vr(close, volume, n: int = 26) -> pd.DataFrame:
    """成交量比率 VR。"""
    d = close.diff()
    up = volume.where(d > 0, 0.0).rolling(n, min_periods=n).sum()
    dn = volume.where(d < 0, 0.0).rolling(n, min_periods=n).sum()
    flat = volume.where(d == 0, 0.0).rolling(n, min_periods=n).sum()
    return 100 * (up + flat / 2) / (dn + flat / 2).replace(0, np.nan)


def vol_ratio(volume: pd.DataFrame, n: int = 5) -> pd.DataFrame:
    """量比：当日量 / n 日均量。"""
    return volume / volume.rolling(n, min_periods=n).mean().replace(0, np.nan)


def turnover_proxy(amount: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    """成交额相对强度：当日额 / n 日均额。

    ETF 拿不到真实流通份额，用这个代替换手率。
    """
    return amount / amount.rolling(n, min_periods=n).mean().replace(0, np.nan)


def amihud(close: pd.DataFrame, amount: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    """Amihud 非流动性：|收益| / 成交额，再取 n 日均值。

    值越大越不流动。这是学界最常用的流动性代理变量。
    """
    r = close.pct_change(fill_method=None).abs()
    illiq = r / amount.replace(0, np.nan)
    return illiq.rolling(n, min_periods=n).mean() * 1e9
