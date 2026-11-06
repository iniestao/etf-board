#!/usr/bin/env python3
"""把当天抓取结果导出成增量 parquet 包，供 factor-data 分支按日累积。

为什么要单独一步，而不是直接把 sqlite 传上去：376 MB 的库里有 99.97% 是
历史数据，每天重传等于白烧流量（一年 94 GB，GitHub 会来敲门）。增量只有
几百 KB，能无限期累积。

复权口径必须和 import_stocks.py 完全一致：hfq.js 给的是**稀疏**的除权日
因子（茅台三年才 33 条），要 ffill 到每个交易日再乘。这里直接照抄那套
逻辑，不做任何"简化"——两处算得不一样，合进基线后同一只股票会出现两个
口径的 close_adj，比缺数据更难发现。

用法：
  python export_increment.py --ndjson /tmp/stocks.ndjson --pcf /tmp/pcf.db \\
      --out /tmp/inc --keep 5
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import pandas as pd


def load_stocks(path: str, keep: int) -> pd.DataFrame:
    """NDJSON -> 长表。复权算法与 import_stocks.py 逐行对齐。"""
    rows = []
    bad = 0
    with open(path) as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                bad += 1
                continue
            bars = o.get("bars") or []
            if len(bars) < 2:
                bad += 1
                continue

            b = pd.DataFrame(bars, columns=["date", "close", "vol"])
            b["date"] = pd.to_datetime(b["date"])
            b = b.sort_values("date")

            adj = o.get("adj") or []
            if adj:
                a = pd.DataFrame(adj, columns=["date", "f"])
                a["date"] = pd.to_datetime(a["date"])
                a = a.drop_duplicates("date").set_index("date")["f"].sort_index()
                # ffill 到交易日；早于首个因子日的交易日按 1.0 处理（与导入侧一致）
                fa = a.reindex(a.index.union(b["date"])).ffill().reindex(b["date"])
                fa = fa.fillna(1.0)
                adjc = b["close"].values * fa.values
            else:
                adjc = b["close"].values

            for d, c, ca, v in zip(
                b["date"].dt.strftime("%Y-%m-%d"),
                b["close"].values, adjc, b["vol"].values,
            ):
                rows.append((o["code"], d, float(c), float(ca), float(v)))

    df = pd.DataFrame(rows, columns=["code", "date", "close", "close_adj", "volume"])
    if len(df) and keep > 0:
        days = sorted(df["date"].unique())[-keep:]
        df = df[df["date"].isin(days)].copy()
    print(f"  日线 {len(df):,} 行 / {df['code'].nunique() if len(df) else 0} 只"
          f" / {df['date'].nunique() if len(df) else 0} 个交易日（解析失败 {bad} 只）")
    return df


def load_pcf(db: str, day: str):
    """取某一天的清单。day 用 YYYYMMDD，和 pcf_meta.date 一致。"""
    con = sqlite3.connect(db)
    try:
        meta = pd.read_sql("SELECT * FROM pcf_meta WHERE date=?", con, params=(day,))
        hold = pd.read_sql("SELECT * FROM pcf_hold WHERE date=?", con, params=(day,))
    except Exception as e:
        con.close()
        raise SystemExit(f"读 {db} 失败：{e}")
    con.close()
    print(f"  PCF {day}: {len(meta)} 份清单 / {len(hold):,} 条持仓")
    return meta, hold


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ndjson", default="/tmp/stocks.ndjson")
    ap.add_argument("--pcf", default="/tmp/pcf.db")
    ap.add_argument("--out", default="/tmp/inc")
    ap.add_argument("--keep", type=int, default=5, help="日线保留最近 N 个交易日（容错补漏）")
    ap.add_argument("--day", help="PCF 日期 YYYYMMDD，默认今天")
    a = ap.parse_args()

    out = Path(a.out)
    (out / "daily").mkdir(parents=True, exist_ok=True)
    (out / "pcf_meta").mkdir(parents=True, exist_ok=True)
    (out / "pcf_hold").mkdir(parents=True, exist_ok=True)

    print("[1/2] 个股日线")
    df = load_stocks(a.ndjson, a.keep)
    if df.empty:
        raise SystemExit("日线为空，拒绝产出空增量（上游抓取大概率失败了）")
    last = sorted(df["date"].unique())[-1]
    p = out / "daily" / f"{last}.parquet"
    df.to_parquet(p, index=False, compression="zstd")
    print(f"  -> {p} ({p.stat().st_size/1024:.0f} KB)")

    print("[2/2] 申购赎回清单")
    day = a.day or last.replace("-", "")
    meta, hold = load_pcf(a.pcf, day)
    if meta.empty:
        # 非交易日、或交易所还没发布，不算错——记一笔就退出，别把流水线弄红
        print(f"  {day} 没有清单（非交易日或尚未发布），跳过")
    else:
        pm = out / "pcf_meta" / f"{day}.parquet"
        ph = out / "pcf_hold" / f"{day}.parquet"
        meta.to_parquet(pm, index=False, compression="zstd")
        hold.to_parquet(ph, index=False, compression="zstd")
        print(f"  -> {pm} ({pm.stat().st_size/1024:.0f} KB)")
        print(f"  -> {ph} ({ph.stat().st_size/1024:.0f} KB)")

    print("完成")


if __name__ == "__main__":
    main()
