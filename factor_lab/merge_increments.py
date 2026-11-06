#!/usr/bin/env python3
"""把 factor-data 分支上的增量包合并进基线库。

恢复流程是两段式的：
  1. 从 Release 下载基线（stocks.db.gz / pcf.db.gz），这是 2026-11-06 的存量
  2. 从 factor-data 分支拿这之后每天的增量，用本脚本合进去

为什么不直接每天传全量：376 MB 里 99.97% 是历史数据，每天重传一年就是 94 GB。

用法：
  python merge_increments.py --baseline stocks.db --inc ./factor-data
  # 也可以只合 PCF
  python merge_increments.py --baseline-pcf pcf.db --inc ./factor-data
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from pathlib import Path

import pandas as pd

DAILY_COLS = ["code", "date", "close", "close_adj", "volume"]
META_COLS = ["code", "date", "idx_code", "nav", "unit_nav",
             "min_unit", "cash", "n_hold", "nav_date", "fund_type"]
HOLD_COLS = ["code", "date", "stock", "name", "qty", "market"]


def merge_daily(baseline: str, inc_dir: Path, out: str) -> int:
    files = sorted((inc_dir / "daily").glob("*.parquet"))
    if not files:
        print("  没有日线增量")
        return 0
    shutil.copyfile(baseline, out)
    con = sqlite3.connect(out)
    total = 0
    before = con.execute("SELECT COUNT(*) FROM daily").fetchone()[0]
    for f in files:
        df = pd.read_parquet(f)
        con.executemany(
            "INSERT OR REPLACE INTO daily(code,date,close,close_adj,volume) VALUES (?,?,?,?,?)",
            df[DAILY_COLS].itertuples(index=False, name=None),
        )
        total += len(df)
    # meta 的 last 是各股最后一根 K 的日期，合并后要跟着推进，否则下游按 last
    # 判断「数据到哪天」会看到旧日期，误以为没有新数据
    con.execute("UPDATE meta SET last = "
                "(SELECT MAX(date) FROM daily WHERE daily.code = meta.code)")
    con.commit()
    after = con.execute("SELECT COUNT(*) FROM daily").fetchone()[0]
    con.close()
    print(f"  日线：{len(files)} 个增量文件，写入 {total:,} 行，"
          f"{before:,} -> {after:,}（新增 {after-before:,}）")
    return total


def merge_pcf(baseline: str, inc_dir: Path, out: str) -> int:
    meta_files = sorted((inc_dir / "pcf_meta").glob("*.parquet"))
    if not meta_files:
        print("  没有 PCF 增量")
        return 0
    shutil.copyfile(baseline, out)
    con = sqlite3.connect(out)
    m0 = con.execute("SELECT COUNT(*) FROM pcf_meta").fetchone()[0]
    h0 = con.execute("SELECT COUNT(*) FROM pcf_hold").fetchone()[0]
    for f in meta_files:
        day = f.stem
        df = pd.read_parquet(f)
        con.executemany(
            "INSERT OR REPLACE INTO pcf_meta VALUES (?,?,?,?,?,?,?,?,?,?)",
            df[META_COLS].itertuples(index=False, name=None),
        )
        hf = inc_dir / "pcf_hold" / f"{day}.parquet"
        if hf.exists():
            hd = pd.read_parquet(hf)
            con.executemany(
                "INSERT OR REPLACE INTO pcf_hold VALUES (?,?,?,?,?,?)",
                hd[HOLD_COLS].itertuples(index=False, name=None),
            )
    con.commit()
    m1 = con.execute("SELECT COUNT(*) FROM pcf_meta").fetchone()[0]
    h1 = con.execute("SELECT COUNT(*) FROM pcf_hold").fetchone()[0]
    con.close()
    print(f"  PCF：{len(meta_files)} 天，清单 {m0:,} -> {m1:,}，持仓 {h0:,} -> {h1:,}")
    return len(meta_files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", help="基线 stocks.db")
    ap.add_argument("--baseline-pcf", help="基线 pcf.db")
    ap.add_argument("--inc", default=".", help="增量目录（含 daily/ pcf_meta/ pcf_hold/）")
    a = ap.parse_args()

    inc = Path(a.inc)
    if not inc.exists():
        raise SystemExit(f"增量目录不存在：{inc}")
    if not a.baseline and not a.baseline_pcf:
        raise SystemExit("至少给一个 --baseline 或 --baseline-pcf")

    if a.baseline:
        print("[日线]")
        merge_daily(a.baseline, inc, a.baseline.replace(".db", ".merged.db"))
    if a.baseline_pcf:
        print("[PCF]")
        merge_pcf(a.baseline_pcf, inc, a.baseline_pcf.replace(".db", ".merged.db"))
    print("完成")


if __name__ == "__main__":
    main()
