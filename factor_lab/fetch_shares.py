"""
ETF 历史份额抓取
================
数据源：天天基金 F10「份额变动」表（季度披露）
  日期 / 期间申购(亿份) / 期间赎回(亿份) / 期末总份额(亿份) / 期末净资产(亿元) / 净资产变动率

为什么要这个数据
----------------
现有 257 个因子全是 OHLCV 的自变换。而 ETF 的成交量主要来自做市商和套利盘，
不是投资者的看多看空（README 里已记录这一点）。份额申购赎回才是真金白银的
配置需求，是个股没有、且与价格信息正交的维度。

按指数去重：一只指数有十几只 ETF 跟踪，份额几乎相同，只抓成交额最大的那只，
省 3/4 请求量。
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path('/workspace/etf_board')
DB_IN = ROOT / 'data' / 'etf.db'
DB_OUT = Path(__file__).parent / 'shares.db'
IDX_MAP = ROOT / 'pipeline' / 'index_map.json'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
BASE = 'http://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&code={code}&rt=0.1'

# 债券、货币类不参与：它们的份额变动由资金面和计息规则驱动，与量价因子同理无经济含义
SKIP = ('债', '国债', '政金', '金融债', '信用债', '城投', '货币', '现金', '理财', '保证金', '短融')


def pick_representatives() -> list[tuple[str, str]]:
    """每个指数选近 20 日成交额最大的一只 ETF。"""
    j = json.loads(IDX_MAP.read_text())
    m = j.get('map') or {}
    code2idx = {k: v['idx'] for k, v in m.items() if isinstance(v, dict) and v.get('idx')}

    con = sqlite3.connect(DB_IN)
    meta = {r[0]: r[1] for r in con.execute('SELECT code, name FROM etf_meta')}
    last = con.execute('SELECT MAX(date) FROM etf_daily').fetchone()[0]
    rows = con.execute(
        "SELECT code, AVG(amount) FROM etf_daily WHERE date >= date(?, '-40 day') "
        "GROUP BY code", (last,)).fetchall()
    con.close()
    amt = {c: a or 0 for c, a in rows}

    best: dict[str, tuple[float, str]] = {}
    for code, ix in code2idx.items():
        name = str(meta.get(code, ''))
        if any(k in name for k in SKIP):
            continue
        if code not in amt:
            continue
        if ix not in best or amt[code] > best[ix][0]:
            best[ix] = (amt[code], code)

    return sorted(((c, ix) for ix, (_, c) in best.items()), key=lambda x: -amt[x[0]])


def fetch(code: str, retries: int = 3) -> str | None:
    url = BASE.format(code=code)
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': f'https://fundf10.eastmoney.com/gmbd_{code}.html',
    })
    for k in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.read().decode('utf-8', 'ignore')
        except Exception:
            time.sleep(0.6 * (k + 1))
    return None


def parse(html: str) -> list[tuple]:
    out = []
    for tr in re.findall(r'<tr>(.*?)</tr>', html, re.S):
        cells = [re.sub(r'<[^>]+>', '', c).replace('&nbsp;', '').strip()
                 for c in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)]
        if len(cells) < 5:
            continue
        d = cells[0]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', d):
            continue

        def num(s):
            s = s.replace(',', '').replace('%', '')
            if s in ('---', '--', '', '-'):
                return None
            try:
                return float(s)
            except ValueError:
                return None

        out.append((d, num(cells[1]), num(cells[2]), num(cells[3]), num(cells[4]), num(cells[5])))
    return out


def main():
    reps = pick_representatives()
    print(f'代表标的口径：{len(reps)} 个指数', flush=True)

    con = sqlite3.connect(DB_OUT)
    con.execute('''CREATE TABLE IF NOT EXISTS shares(
        idx TEXT, code TEXT, date TEXT,
        sub REAL, red REAL, total_share REAL, net_asset REAL, chg_ratio REAL,
        PRIMARY KEY (code, date))''')
    con.execute('CREATE INDEX IF NOT EXISTS ix_shares_date ON shares(date)')
    con.commit()

    done = {r[0] for r in con.execute('SELECT DISTINCT code FROM shares')}
    todo = [(c, ix) for c, ix in reps if c not in done]
    print(f'已完成 {len(done)}，待抓 {len(todo)}', flush=True)

    ok = fail = rows = 0
    t0 = time.time()
    for i, (code, ix) in enumerate(todo, 1):
        html = fetch(code)
        if html is None:
            fail += 1
            print(f'  [{i}/{len(todo)}] {code} 失败', flush=True)
            continue
        recs = parse(html)
        if not recs:
            fail += 1
            continue
        con.executemany(
            'INSERT OR REPLACE INTO shares VALUES (?,?,?,?,?,?,?,?)',
            [(ix, code, *r) for r in recs])
        con.commit()
        ok += 1
        rows += len(recs)
        if i % 40 == 0:
            el = time.time() - t0
            print(f'  [{i}/{len(todo)}] ok={ok} fail={fail} rows={rows} '
                  f'{el:.0f}s', flush=True)
        time.sleep(0.12)

    print(f'完成：成功 {ok}，失败 {fail}，新增 {rows} 行，耗时 {time.time()-t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
