"""
股指期货基差 + 现货指数
======================
基差是 ETF 之外的信息：它反映对冲盘的需求和市场的多空预期，与价格走势正交。
用户本来就在做 IC/IM 基差，这里把它接进因子体系。

数据
----
期货：新浪主连日线（IF0/IC0/IM0/IH0），IF/IC/IH 从 2017-01，IM 从 2022-07 上市起
现货：新浪指数日线（sh000300 / sh000905 / sh000852 / sh000016）

基差口径
--------
    basis = 期货收盘 / 现货收盘 - 1

主连在换月日会有跳空，会污染「基差变化」这类差分因子。但「基差水平」本身
仍然有意义（换月只是换了个更远的合约，基差结构延续）。所以：
  · basis 保留原值，供水平类因子用
  · 差分/动量类因子另外用 20 日均值再差分，压掉换月噪声
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

import pandas as pd

OUT = Path(__file__).parent
DB = OUT / 'futures.db'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

FUT = {'IF0': 'IF', 'IC0': 'IC', 'IM0': 'IM', 'IH0': 'IH'}
SPOT = {'sh000300': 'HS300', 'sh000905': 'ZZ500', 'sh000852': 'ZZ1000', 'sh000016': 'SZ50'}


def get(url: str, retries: int = 3) -> str | None:
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/'})
    for k in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read().decode('utf-8', 'ignore')
        except Exception:
            time.sleep(0.5 * (k + 1))
    return None


def main():
    con = sqlite3.connect(DB)
    con.executescript('''
    CREATE TABLE IF NOT EXISTS fut(date TEXT, sym TEXT,
        open REAL, high REAL, low REAL, close REAL, vol REAL, PRIMARY KEY(date,sym));
    CREATE TABLE IF NOT EXISTS spot(date TEXT, sym TEXT, close REAL, PRIMARY KEY(date,sym));
    ''')
    con.commit()

    for code, sym in FUT.items():
        txt = get('https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_'
                  + code + '=/InnerFuturesNewService.getDailyKLine?symbol=' + code)
        if not txt:
            print(f'{code} 取不到')
            continue
        m = re.search(r'\((\[.*\])\)', txt, re.S)
        if not m:
            print(f'{code} 解析失败')
            continue
        rows = []
        for x in json.loads(m.group(1)):
            try:
                rows.append((x['d'], sym, float(x['o']), float(x['h']), float(x['l']),
                             float(x['c']), float(x.get('v') or 0)))
            except (KeyError, ValueError):
                continue
        con.executemany('INSERT OR REPLACE INTO fut VALUES (?,?,?,?,?,?,?)', rows)
        con.commit()
        print(f'{code}: {len(rows)} 根  {rows[0][0]} → {rows[-1][0]}')

    for code, sym in SPOT.items():
        # datalen 上限约 1500：给 3000 会直接返回空的 []，不是报错，很容易误判成
        # 「这只指数没有数据」。1500 根约 6 年，基差研究从 2020-08 起算够用。
        txt = get('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
                  '?symbol=' + code + '&scale=240&ma=no&datalen=1500')
        if not txt:
            print(f'{code} 取不到')
            continue
        try:
            arr = json.loads(txt)
        except Exception:
            print(f'{code} 解析失败')
            continue
        rows = [(x['day'], sym, float(x['close'])) for x in arr if 'day' in x]
        con.executemany('INSERT OR REPLACE INTO spot VALUES (?,?,?)', rows)
        con.commit()
        print(f'{code}: {len(rows)} 根  {rows[0][0]} → {rows[-1][0]}')

    # ---------------------------------------------------------------- 基差
    f = pd.read_sql('SELECT * FROM fut', con)
    s = pd.read_sql('SELECT * FROM spot', con)
    con.close()
    fw = f.pivot(index='date', columns='sym', values='close')
    sw = s.pivot(index='date', columns='sym', values='close')

    pair = {'IF': 'HS300', 'IC': 'ZZ500', 'IM': 'ZZ1000', 'IH': 'SZ50'}
    B = pd.DataFrame(index=fw.index)
    for fu, sp in pair.items():
        if fu in fw and sp in sw:
            B[fu] = fw[fu] / sw[sp].reindex(fw.index) - 1
    B.index = pd.to_datetime(B.index)
    B = B.sort_index()
    B.to_csv(OUT / 'out_basis.csv')

    print('\n基差率（期货/现货−1）描述统计 %：')
    print((B * 100).describe().round(2).to_string())
    print('\n最近 5 日：')
    print((B.tail(5) * 100).round(2).to_string())
    print(f'\n覆盖 {B.index[0].date()} → {B.index[-1].date()}，{len(B)} 天')


if __name__ == '__main__':
    main()
