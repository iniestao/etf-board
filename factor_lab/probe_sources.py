"""
数据源探测
==========
目标：在动手抓之前，把所有候选数据源的真实可得性摸清楚。

为什么必须先探测
----------------
中文金融站点的坑很密集：
  · 页面能打开，但数据是 JS 渲染，HTML 里没有
  · 接口地址改版，老路径返回 {"ErrCode":4,"ErrMsg":"404"}
  · 需要特定 Referer/UA，否则返回空 JSON
  · 有数据但只剩最近 3 个月，没有历史

今晚已经在天天基金份额接口上踩过一次（api.fund.eastmoney.com 404，
真正的地址是 fundf10.eastmoney.com/FundArchivesDatas.aspx）。
所以这里对每个源都同时检查：状态码、响应体大小、是否含预期关键词、
以及能看出历史深度的第一条/最后一条日期。

候选方向（按对 ETF 横截面选择的价值排序）
----------------------------------------
1. 日频份额      —— 把现有季度份额升级成日频，样本从 29 个截面变 2000 个
2. 指数估值      —— PE/PB/股息率，指数有官方数据，比个股聚合更干净
3. 成分股权重    —— 算「成分股动量/盈利」这类 ETF 无法直接表达的因子
4. 期权隐含波动率 —— 对 50/300/500/1000/创业板 有效，反映市场预期
5. 融资融券      —— ETF 可两融，余额变化是杠杆情绪
6. 北向资金      —— 跨境 ETF 的资金面
7. 宏观/汇率/利率 —— 影响债券、跨境、商品 ETF 的定价
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import re
import ssl
import urllib.parse
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

CANDIDATES = [
    # ---------------------------------------------------------------- 1. 日频份额
    ('SSE-ETF规模-查询接口',
     'http://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L'
     '&STAT_DATE=&pageHelp.pageSize=100',
     'http://www.sse.com.cn/market/funddata/volumn/etfvolumn/'),
    ('SSE-ETF规模-旧路径',
     'http://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_FUND_ETF_SCALE'
     '&pageHelp.pageSize=100', 'http://www.sse.com.cn/'),

    # ---------------------------------------------------------------- 2. 指数估值
    ('中证-指数详情',
     'https://www.csindex.com.cn/csindex-home/indexInfo/index-basic-info?indexCode=000300',
     'https://www.csindex.com.cn/'),
    ('中证-估值历史',
     'https://www.csindex.com.cn/csindex-home/index/index-valuation?indexCode=000300',
     'https://www.csindex.com.cn/'),
    ('中证-指数行情',
     'https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=000300',
     'https://www.csindex.com.cn/'),
    ('中证-估值曲线(备选)',
     'https://www.csindex.com.cn/csindex-home/valuation/index-valuation?indexCode=000300',
     'https://www.csindex.com.cn/'),
    ('国证-指数估值',
     'https://www.cnindex.com.cn/api/index/valuation?indexCode=399006',
     'https://www.cnindex.com.cn/'),

    # ---------------------------------------------------------------- 3. 成分股
    ('中证-成分股权重',
     'https://www.csindex.com.cn/csindex-home/index/weight/top10?indexCode=000300',
     'https://www.csindex.com.cn/'),
    ('东财-指数成分',
     'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1'
     '&fltt=2&invt=2&fid=f3&fs=b:BK0500&fields=f12,f14,f3',

     'https://quote.eastmoney.com/'),

    # ---------------------------------------------------------------- 4. 期权
    ('SSE-期权每日行情',
     'http://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_YSP_QQZL_L'
     '&TRADE_DATE=&pageHelp.pageSize=50', 'http://www.sse.com.cn/'),
    ('SSE-期权T型报价',
     'http://query.sse.com.cn/commonOptionQry.do?sqlId=COMMON_SSE_ZQPZ_YSP_QQZL_L'
     '&CONTRACT_TYPE=&pageHelp.pageSize=50', 'http://www.sse.com.cn/'),

    # ---------------------------------------------------------------- 5. 融资融券
    ('东财-两融汇总',
     'https://datacenter-web.eastmoney.com/api/data/v1/get?'
     'reportName=RPT_MARGIN_DAILY&columns=ALL&pageSize=20&sortColumns=TRADE_DATE'
     '&sortTypes=-1', 'https://data.eastmoney.com/rzrq/'),
    ('东财-两融ETF明细',
     'https://datacenter-web.eastmoney.com/api/data/v1/get?'
     'reportName=RPT_MARGIN_DETAIL_ETFFUND&columns=ALL&pageSize=20',
     'https://data.eastmoney.com/rzrq/'),

    # ---------------------------------------------------------------- 6. 北向
    ('东财-北向资金',
     'https://push2.eastmoney.com/api/qt/kamt.rtmin/get?'
     'fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54', 'https://data.eastmoney.com/'),
    ('东财-沪深港通持股',
     'https://datacenter-web.eastmoney.com/api/data/v1/get?'
     'reportName=RPT_MUTUAL_STOCK_NORTHBOUND&columns=ALL&pageSize=10',
     'https://data.eastmoney.com/'),

    # ---------------------------------------------------------------- 7. 宏观
    ('中债-国债收益率',
     'https://yield.chinabond.com.cn/cbweb-mn/yield_main?locale=zh_CN', 'https://www.chinabond.com.cn/'),
    ('外管局-汇率中间价',
     'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json',
     'https://www.chinamoney.com.cn/'),
    ('东财-汇率USDCNY',
     'https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH'
     '&fields=f43,f57,f58,f169,f170', 'https://quote.eastmoney.com/'),

    # ---------------------------------------------------------------- 8. 其他
    ('集思录-ETF列表',
     'https://www.jisilu.cn/data/etf/etf_list/?___jsl=LST___t=1', 'https://www.jisilu.cn/'),
    ('东财-ETF实时快照',
     'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2'
     '&invt=2&fid=f3&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024'
     '&fields=f2,f3,f12,f14,f20,f21', 'https://quote.eastmoney.com/'),
    ('新浪-ETF日线',
     'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
     '?symbol=sh510300&scale=240&ma=no&datalen=100', 'https://finance.sina.com.cn/'),
]


def probe(item):
    name, url, ref = item
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': ref,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=18, context=CTX) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        return name, f'HTTP {e.code}', 0, '', url
    except Exception as e:
        return name, f'ERR {type(e).__name__}', 0, '', url

    size = len(raw)
    try:
        txt = raw.decode('utf-8')
    except UnicodeDecodeError:
        try:
            txt = raw.decode('gbk')
        except UnicodeDecodeError:
            txt = raw.decode('utf-8', 'ignore')

    # 判断是不是「有内容」：JSON 里有数据，或 HTML 里有日期
    hint = ''
    dates = re.findall(r'(20\d{2}-\d{2}-\d{2})', txt)
    if dates:
        hint = f'日期 {min(dates)}~{max(dates)} ({len(dates)}个)'
    if txt.lstrip().startswith('{'):
        try:
            j = json.loads(txt)
            keys = list(j.keys())[:6]
            hint += f' JSON keys={keys}'
            body = json.dumps(j, ensure_ascii=False)
            hint += f' len={len(body)}'
        except Exception:
            hint += ' JSON解析失败'
    elif '<html' in txt[:2000].lower():
        hint += f' HTML {len(txt)}字符'
        if '很抱歉' in txt or '404' in txt[:500]:
            hint += ' [疑似错误页]'

    return name, f'HTTP {code}', size, hint, url


def main():
    print(f'探测 {len(CANDIDATES)} 个数据源\n' + '=' * 100)
    out = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for name, status, size, hint, url in ex.map(probe, CANDIDATES):
            out.append((name, status, size, hint))
            flag = 'OK ' if status == 'HTTP 200' and size > 200 else '..'
            print(f'{flag} {name:22s} {status:10s} {size:8d}B  {hint[:90]}')

    print('\n' + '=' * 100)
    ok = [o for o in out if o[1] == 'HTTP 200' and o[2] > 200]
    print(f'可用 {len(ok)}/{len(out)}')
    json.dump([{'name': n, 'status': s, 'size': z, 'hint': h} for n, s, z, h in out],
              open('/tmp/probe_out.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
