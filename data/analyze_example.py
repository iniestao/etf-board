#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ETF 历史数据分析示例
====================
演示拿到 etf.db 之后能做什么：读数据、算指标、跑回测、出绩效。

依赖：pandas, numpy（画图可选 matplotlib）

用法：
    python analyze_example.py 510300
    python analyze_example.py 513180 --start 2023-01-01
"""

import argparse
import sqlite3

import numpy as np
import pandas as pd


# ---------------------------------------------------------------- 读数据
def load(code, db="etf.db", start=None, adjust="hfq"):
    """读单只 ETF 日线，返回带复权价的 DataFrame。

    adjust: 'hfq' 后复权（算指标/回测用）| 'qfq' 前复权（画图用）| None 原始
    """
    con = sqlite3.connect(db)
    sql = ("SELECT date, open, high, low, close, volume, amount, adj_factor "
           "FROM etf_daily WHERE code = ? ORDER BY date")
    df = pd.read_sql(sql, con, params=(code,))
    con.close()
    if df.empty:
        raise SystemExit(f"库里没有 {code}，先跑 node import_etf.mjs --codes {code}")

    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")

    if adjust:
        # 后复权 = 原价 × 因子；前复权 = 后复权 / 最新因子
        div = 1.0 if adjust == "hfq" else df["adj_factor"].iloc[-1]
        for c in ("open", "high", "low", "close"):
            df[c + "_adj"] = df[c] * df["adj_factor"] / div
        # 成交量反向调整，保证成交额口径一致
        df["volume_adj"] = df["volume"] / df["adj_factor"] * div
    else:
        for c in ("open", "high", "low", "close"):
            df[c + "_adj"] = df[c]
        df["volume_adj"] = df["volume"]

    if start:
        df = df[df.index >= pd.Timestamp(start)]
    return df


# ---------------------------------------------------------------- 指标
def add_ma(df, windows=(5, 20, 60)):
    for n in windows:
        df[f"ma{n}"] = df["close_adj"].rolling(n).mean()
    return df


def add_rsi(df, n=14):
    """Wilder RSI。"""
    delta = df["close_adj"].diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    # Wilder 平滑等价于 alpha = 1/n 的 EMA
    au = up.ewm(alpha=1 / n, adjust=False).mean()
    ad = down.ewm(alpha=1 / n, adjust=False).mean()
    df[f"rsi{n}"] = 100 - 100 / (1 + au / ad.replace(0, np.nan))
    return df


def add_macd(df, fast=12, slow=26, signal=9):
    ef = df["close_adj"].ewm(span=fast, adjust=False).mean()
    es = df["close_adj"].ewm(span=slow, adjust=False).mean()
    df["dif"] = ef - es
    df["dea"] = df["dif"].ewm(span=signal, adjust=False).mean()
    df["macd"] = (df["dif"] - df["dea"]) * 2
    return df


def add_atr(df, n=14):
    h, l, pc = df["high_adj"], df["low_adj"], df["close_adj"].shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    df[f"atr{n}"] = tr.ewm(alpha=1 / n, adjust=False).mean()
    return df


# ---------------------------------------------------------------- 回测
def backtest(df, signal_col, price_col="close_adj", fee=0.0003):
    """按 signal（1 持仓 / 0 空仓）做多，次日生效，含单边费率。"""
    pos = df[signal_col].shift(1).fillna(0)          # 次日生效，避免未来函数
    ret = df[price_col].pct_change().fillna(0)
    # 换仓当天扣费
    turn = pos.diff().abs().fillna(0)
    strat = pos * ret - turn * fee
    return pd.DataFrame({"ret": ret, "pos": pos, "strat": strat}), \
        pd.DataFrame({"buy_hold": ret, "strategy": strat})


def perf(series, ann=244):
    """年化收益 / 年化波动 / 夏普 / 最大回撤 / 卡玛。"""
    eq = (1 + series).cumprod()
    n = len(series)
    if n == 0 or eq.iloc[-1] <= 0:
        return {}
    total = eq.iloc[-1] - 1
    years = n / ann
    cagr = (1 + total) ** (1 / years) - 1 if years > 0 else 0
    vol = series.std() * np.sqrt(ann)
    sharpe = (series.mean() * ann) / vol if vol > 0 else 0
    dd = (eq / eq.cummax() - 1).min()
    return {
        "累计收益": total,
        "年化收益": cagr,
        "年化波动": vol,
        "夏普": sharpe,
        "最大回撤": dd,
        "卡玛": cagr / abs(dd) if dd < 0 else np.nan,
        "交易日": n,
    }


# ---------------------------------------------------------------- 主程序
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("code", help="ETF 代码，如 510300")
    ap.add_argument("--db", default="etf.db")
    ap.add_argument("--start", default=None, help="起始日期 YYYY-MM-DD")
    args = ap.parse_args()

    df = load(args.code, args.db, args.start)
    df = add_ma(df)
    df = add_rsi(df)
    df = add_macd(df)
    df = add_atr(df)

    print(f"\n{'='*62}")
    print(f"  {args.code}   共 {len(df)} 个交易日   "
          f"{df.index[0].date()} ~ {df.index[-1].date()}")
    print(f"{'='*62}")

    last = df.iloc[-1]
    adj_label = {"hfq": "后复权", "qfq": "前复权", None: "原始"}[adjust]
    print(f"\n最新 {df.index[-1].date()}")
    print(f"  收盘({adj_label}) {last['close_adj']:.3f}   原始 {last['close']:.3f}")
    print(f"  MA5 {last['ma5']:.3f}  MA20 {last['ma20']:.3f}  MA60 {last['ma60']:.3f}")
    print(f"  RSI14 {last['rsi14']:.1f}   MACD {last['macd']:.4f}   ATR14 {last['atr14']:.4f}")
    print(f"  成交额 {last['amount']/1e8:.2f} 亿")

    # 双均线策略
    df["signal"] = (df["ma20"] > df["ma60"]).astype(int)
    trade, rets = backtest(df, "signal")
    px = rets.dropna()

    print(f"\n双均线策略 20/60（含 {0.03:.2f}% 单边费）")
    for label, s in (("策略", px["strategy"]), ("买入持有", px["buy_hold"])):
        m = perf(s)
        print(f"  {label:<6} 累计 {m['累计收益']*100:>7.1f}%   "
              f"年化 {m['年化收益']*100:>6.1f}%   夏普 {m['夏普']:>5.2f}   "
              f"最大回撤 {m['最大回撤']*100:>6.1f}%")
    print(f"  持仓天数 {int(trade['pos'].sum())} / {len(trade)}")

    # 分段年度收益
    annual = px["buy_hold"].groupby(px.index.year).apply(lambda s: (1 + s).prod() - 1)
    strat_a = px["strategy"].groupby(px.index.year).apply(lambda s: (1 + s).prod() - 1)
    print(f"\n年度收益        买入持有      策略")
    for y in annual.index:
        print(f"  {y}         {annual[y]*100:>7.1f}%   {strat_a[y]*100:>7.1f}%")


if __name__ == "__main__":
    main()
