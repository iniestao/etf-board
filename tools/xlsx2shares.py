#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「ETF 历史份额」Excel 解析成 pipeline 用的 shares JSON（原始层）。

Excel 通常是券商/Choice/iFinD 导出的转置表：首列是日期，表头两行分别是
基金名称和代码，数据单元格是每日份额。本脚本不假定固定行列位置，而是
先定位「代码行」「日期列」，再按表头映射取数。

用法：
  python3 tools/xlsx2shares.py <xlsx> -o data/shares/sz_hist.json
  python3 tools/xlsx2shares.py <xlsx> -o out.json --market SZ --stats
  python3 tools/xlsx2shares.py <xlsx> --csv /tmp/shares_long.csv   # 长表，便于抽查

输出格式（v1）：
  {
    "v": 1, "market": "SZ", "unit": "share",
    "src": "深市ETF历史份额.xlsx", "imported": "2026-11-11T15:05:00+08:00",
    "d": ["2025-10-09", ...],            # 日期轴，升序，全表共一份
    "n": {"158000": "港股通金融ETF鹏华", ...},
    "c": {"158000": [null, 27925835, ...]}   # 与 d 等长；null=上市前/未披露，不插值
  }

约定：
  - 份额统一换算成「份」（整数）。原始若是万份/亿份，按中位数量级判定并换算。
  - 缺失一律留 null，不前向填充——份额折算、停牌、未上市必须能从 null 里看出来。
  - 同一天重复出现时取最后一行的值（导出表偶尔有重复日）。
"""
import argparse
import datetime as dt
import json
import os
import re
import statistics
import sys

try:
    import openpyxl
except ImportError:
    sys.exit('需要 openpyxl：sudo pip3 install openpyxl')

CODE_RE = re.compile(r'^\s*(\d{6})(?:\.(SZ|SH|BJ))?\s*$')
DATE_RE = re.compile(r'^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})')

CODE_HEADER_WORDS = ('证券代码', '基金代码', '代码', 'code', 'Code', 'CODE')


def norm_date(v):
    """把单元格转成 'YYYY-MM-DD'；转不了返回 None。"""
    if isinstance(v, dt.datetime):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, dt.date):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, str):
        m = DATE_RE.match(v)
        if m:
            y, mo, d = (int(x) for x in m.groups())
            try:
                return dt.date(y, mo, d).strftime('%Y-%m-%d')
            except ValueError:
                return None
    return None


def parse_code(v):
    """'158000.SZ' / '158000' / 158000 → ('158000', 'SZ'|'SH'|None)。"""
    if v is None:
        return None, None
    if isinstance(v, (int, float)) and float(v).is_integer():
        s = str(int(v)).zfill(6)
        return (s, None) if len(s) == 6 else (None, None)
    m = CODE_RE.match(str(v))
    if not m:
        return None, None
    return m.group(1), m.group(2)


def guess_unit(values):
    """按中位数量级判定原始单位，返回 (除数, 单位名)。"""
    med = statistics.median(values)
    if med >= 1e7:
        return 1, '份'
    if med >= 1e3:
        return 1e4, '万份'
    return 1e8, '亿份'


def load_rows(path, sheet=None):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    wb.close()
    return rows, ws.title


def find_layout(rows):
    """返回 (code_row_idx, code_col_map, date_col_idx, first_data_row)。

    code_col_map: {列号: 代码}，只含能识别出 6 位数字的列。
    """
    best = (None, {}, 0, 0)
    for i, row in enumerate(rows[:15]):
        cmap = {}
        for j, v in enumerate(row):
            code, _ = parse_code(v)
            # 纯 6 位数字且落在 5/1/16/18/51/56/58 等基金常见段，避免把年份、数量当代码
            if code and code[0] in '15' and len(row) > 3:
                cmap[j] = code
        if len(cmap) >= 5 and len(cmap) > len(best[1]):
            best = (i, cmap, 0, i + 1)
    if best[0] is None:
        raise SystemExit('没找到代码行：前 15 行里没有一行能识别出 ≥5 个 6 位基金代码。\n'
                         '实际前几行：%s' % [[str(x)[:14] for x in r[:6]] for r in rows[:5]])
    code_row, cmap, _, _ = best

    # 日期列：code 行下方，含 datetime 最多的列（通常第 0 列）
    width = max(len(r) for r in rows)
    counts = [0] * width
    for row in rows[code_row + 1:]:
        for j, v in enumerate(row):
            if isinstance(v, (dt.datetime, dt.date)) or (isinstance(v, str) and DATE_RE.match(v)):
                counts[j] += 1
    date_col = max(range(width), key=lambda j: (counts[j], -j))
    if counts[date_col] == 0:
        raise SystemExit('没找到日期列：代码行下方没有任何日期单元格。')

    first = code_row + 1
    return code_row, cmap, date_col, first


def write_shares(obj, path):
    """按「每只一行」写盘。

    为什么不 json.dump 成一整行：这份文件在 main 分支上每天追加一格，单行 JSON
    会让每次 commit 都是一个 2 MB 的整 blob；每只一行时 git 的 delta 压缩只存
    每行末尾多出来的几个字节，一年下来仓库不会爆。
    """
    tmp = path + '.tmp'
    head = {k: v for k, v in obj.items() if k not in ('n', 'c')}
    codes = list(obj['c'].keys())
    lines = [json.dumps(head, ensure_ascii=False, separators=(',', ':'))[:-1] + ',"n":{']
    for i, code in enumerate(codes):
        lines.append('"%s":%s%s' % (code, json.dumps(obj['n'].get(code, ''), ensure_ascii=False),
                                    ',' if i < len(codes) - 1 else ''))
    lines.append('},"c":{')
    for i, code in enumerate(codes):
        lines.append('"%s":%s%s' % (code, json.dumps(obj['c'][code], separators=(',', ':')),
                                    ',' if i < len(codes) - 1 else ''))
    lines.append('}}')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('-o', '--out', help='输出 shares JSON 路径')
    ap.add_argument('--csv', help='另存长表 CSV（code,date,shares）')
    ap.add_argument('--sheet', help='指定 sheet 名，默认第一个')
    ap.add_argument('--market', default=None, help='SZ / SH，默认按代码首位推断')
    ap.add_argument('--stats', action='store_true', help='打印核对信息')
    a = ap.parse_args()

    rows, sheet = load_rows(a.xlsx, a.sheet)
    code_row, cmap, date_col, first = find_layout(rows)

    code_row_vals = rows[code_row]
    # 名称行：代码行上一行里、与代码列对应的文本（取不到就用代码本身）
    names = {}
    if code_row - 1 >= 0:
        for j in cmap:
            v = rows[code_row - 1][j] if j < len(rows[code_row - 1]) else None
            if isinstance(v, str) and v.strip():
                names[cmap[j]] = v.strip()

    # 逐行取数
    by_code = {c: {} for c in cmap.values()}
    all_dates = set()
    dup = 0
    for row in rows[first:]:
        if date_col >= len(row):
            continue
        d = norm_date(row[date_col])
        if not d:
            continue
        all_dates.add(d)
        for j, code in cmap.items():
            v = row[j] if j < len(row) else None
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                if d in by_code[code]:
                    dup += 1
                by_code[code][d] = float(v)

    dates = sorted(all_dates)
    if not dates:
        raise SystemExit('没有任何有效日期行。')

    # 单位判定（只用非零值，避免全 0 干扰）
    sample = [v for m in by_code.values() for v in m.values() if v > 0]
    if not sample:
        raise SystemExit('所有单元格都是空或 0，没有可用数据。')
    div, unit_name = guess_unit(sample)
    med = statistics.median(sample)

    # 市场判定
    firsts = {c[0] for c in by_code}
    market = a.market or ('SZ' if firsts <= {'1'} else 'SH' if firsts & {'5'} else '?')

    out = {
        'v': 1,
        'market': market,
        'unit': 'share',
        'src': os.path.basename(a.xlsx),
        'sheet': sheet,
        'imported': dt.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'),
        'd': dates,
        'n': {c: names.get(c, '') for c in by_code},
        'c': {},
    }
    for code, m in by_code.items():
        out['c'][code] = [
            (int(round(m[d] * div)) if d in m else None) for d in dates
        ]

    if a.stats:
        cnt = [sum(1 for x in v if x is not None) for v in out['c'].values()]
        gaps = 0
        for v in out['c'].values():
            idx = [i for i, x in enumerate(v) if x is not None]
            if idx:
                gaps += sum(1 for i in range(idx[0], idx[-1] + 1) if v[i] is None)
        print('sheet=%s 代码行=%d 日期列=%d 代码=%d 日期=%d (%s ~ %s)'
              % (sheet, code_row, date_col, len(out['c']), len(dates), dates[0], dates[-1]))
        print('单位判定：%s（中位数 %.4g）→ 统一换算成份' % (unit_name, med))
        print('有效值 %d 个，空 %d 个；每只有效天数 min/中位/max = %d / %.0f / %d'
              % (sum(cnt), len(out['c']) * len(dates) - sum(cnt),
                 min(cnt), statistics.median(cnt), max(cnt)))
        print('中途缺口（非上市前）= %d 个%s；重复日期覆盖 %d 次'
              % (gaps, '（干净）' if gaps == 0 else ' ← 注意', dup))
        top = sorted(out['c'].items(), key=lambda kv: -(kv[1][-1] or 0))[:3]
        print('最大 3 只（末日份额）：%s'
              % ', '.join('%s %.2f 亿份' % (k, (v[-1] or 0) / 1e8) for k, v in top))

    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        write_shares(out, a.out)
        print('已写 %s（%.2f MB）' % (a.out, os.path.getsize(a.out) / 1048576))

    if a.csv:
        with open(a.csv, 'w', encoding='utf-8') as f:
            f.write('code,name,date,shares\n')
            for code, v in out['c'].items():
                for d, s in zip(dates, v):
                    if s is not None:
                        f.write('%s,%s,%s,%d\n' % (code, out['n'][code].replace(',', ' '), d, s))
        print('已写 %s' % a.csv)


if __name__ == '__main__':
    main()
