-- ============================================================
-- ETF 历史数据 · 常用查询
-- 库：etf.db（SQLite，表结构见 README.md）
-- 用法：sqlite3 etf.db < queries.sql
--      或在 DB Browser for SQLite / DBeaver 里逐段执行
-- ============================================================

-- ------------------------------------------------------------
-- 一、数据概览
-- ------------------------------------------------------------
-- 每只 ETF 的起止与记录数（按时长排序）
SELECT m.code, m.name, m.bars, m.divs, m.first_date, m.last_date
FROM etf_meta m
ORDER BY m.bars DESC
LIMIT 20;

-- 全库规模
SELECT COUNT(DISTINCT code) AS 标的数, COUNT(*) AS 总记录,
       MIN(date) AS 最早, MAX(date) AS 最晚
FROM etf_daily;

-- 最近交易日有多少只有成交
SELECT date, COUNT(*) AS 有成交只数, ROUND(SUM(amount)/1e8, 1) AS 总成交额亿
FROM etf_daily
WHERE date = (SELECT MAX(date) FROM etf_daily) AND amount > 0
GROUP BY date;


-- ------------------------------------------------------------
-- 二、技术指标（能用 SQL 算的部分）
-- ------------------------------------------------------------

-- 1) 均线 + 偏离度：单只 ETF 最近 20 个交易日
--    注意用 close*adj_factor（后复权），否则分红除权日会出现假跌破
SELECT date, ROUND(px, 4) AS 后复权价,
       ROUND(AVG(px) OVER (ORDER BY date ROWS 19 PRECEDING), 4)  AS ma20,
       ROUND(AVG(px) OVER (ORDER BY date ROWS 59 PRECEDING), 4)  AS ma60,
       ROUND((px / AVG(px) OVER (ORDER BY date ROWS 19 PRECEDING) - 1) * 100, 2) AS 偏离20日线pct
FROM (SELECT date, close * adj_factor AS px FROM etf_daily WHERE code = '510300')
ORDER BY date DESC
LIMIT 20;

-- 2) 波动率：20 日年化标准差（先算日收益，再算 stddev）
WITH r AS (
  SELECT date, close * adj_factor AS px FROM etf_daily WHERE code = '510300'
),
rr AS (
  SELECT date, px / LAG(px) OVER (ORDER BY date) - 1 AS ret FROM r
)
SELECT date,
       ROUND(SQRT(AVG(ret*ret) OVER (ORDER BY date ROWS 19 PRECEDING)
                  - POWER(AVG(ret) OVER (ORDER BY date ROWS 19 PRECEDING), 2)) * SQRT(244) * 100, 2) AS vol20年化pct
FROM rr
ORDER BY date DESC
LIMIT 10;

-- 3) 最大回撤：单只 ETF 全历史（必须用复权价，否则每次分红都会算成回撤）
WITH x AS (
  SELECT date, close * adj_factor AS px FROM etf_daily WHERE code = '510300'
),
y AS (
  SELECT date, px, MAX(px) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) AS peak FROM x
)
SELECT ROUND(MIN(px / peak - 1) * 100, 2) AS 最大回撤pct
FROM y;

-- 4) 各区间涨幅排行（近 1 年，用后复权价）
WITH last AS (SELECT MAX(date) d FROM etf_daily),
adj AS (
  SELECT code, date, close * adj_factor AS px FROM etf_daily
  WHERE date >= date((SELECT d FROM last), '-1 year')
),
base AS (
  SELECT code, px AS c0 FROM adj a
  WHERE date = (SELECT MIN(date) FROM adj x WHERE x.code = a.code)
),
now AS (
  SELECT code, px AS c1 FROM adj WHERE date = (SELECT d FROM last)
)
SELECT m.name, b.code,
       ROUND((n.c1 / b.c0 - 1) * 100, 2) AS 近一年涨幅pct
FROM base b JOIN now n ON n.code = b.code JOIN etf_meta m ON m.code = b.code
WHERE b.c0 > 0
ORDER BY 近一年涨幅pct DESC
LIMIT 20;


-- ------------------------------------------------------------
-- 三、横截面筛选
-- ------------------------------------------------------------

-- 最近交易日：涨幅前 20（剔除成交额 < 500 万，避免僵尸 ETF）
SELECT d.code, m.name, d.close,
       ROUND((d.close * d.adj_factor / (SELECT p.close * p.adj_factor FROM etf_daily p
              WHERE p.code = d.code AND p.date < d.date
              ORDER BY p.date DESC LIMIT 1) - 1) * 100, 2) AS 涨幅pct,
       ROUND(d.amount / 1e8, 2) AS 成交额亿
FROM etf_daily d JOIN etf_meta m ON m.code = d.code
WHERE d.date = (SELECT MAX(date) FROM etf_daily) AND d.amount > 5e6
ORDER BY 涨幅pct DESC
LIMIT 20;

-- 流动性分布：最近交易日成交额分档
SELECT CASE
         WHEN amount >= 10e8 THEN '10亿以上'
         WHEN amount >= 1e8  THEN '1-10亿'
         WHEN amount >= 1e7  THEN '1000万-1亿'
         WHEN amount >  0    THEN '1000万以下'
         ELSE '无成交' END AS 档位,
       COUNT(*) AS 只数
FROM etf_daily
WHERE date = (SELECT MAX(date) FROM etf_daily)
GROUP BY 档位 ORDER BY 只数 DESC;


-- ------------------------------------------------------------
-- 四、双均线策略回测（20/60 日，收盘价成交，不计费用）
--     信号用「前一日」状态，避免未来函数
-- ------------------------------------------------------------
WITH src AS (
  SELECT date, close * adj_factor AS px FROM etf_daily WHERE code = '510300'
),
ma AS (
  SELECT date, px,
         AVG(px) OVER (ORDER BY date ROWS 19 PRECEDING) AS ma20,
         AVG(px) OVER (ORDER BY date ROWS 59 PRECEDING) AS ma60
  FROM src
),
sig AS (
  SELECT date, px,
         CASE WHEN ma20 > ma60 THEN 1 ELSE 0 END AS pos
  FROM ma WHERE ma60 IS NOT NULL
),
ret AS (
  SELECT date, pos,
         LAG(pos) OVER (ORDER BY date) AS pos_prev,
         px / LAG(px) OVER (ORDER BY date) - 1 AS r
  FROM sig
),
daily AS (
  SELECT date, COALESCE(pos_prev, 0) AS hold, r
  FROM ret WHERE r IS NOT NULL
)
SELECT ROUND((EXP(SUM(LN(1 + hold * r))) - 1) * 100, 2) AS 策略累计pct,
       ROUND((EXP(SUM(LN(1 + r))) - 1) * 100, 2)      AS 买入持有pct,
       COUNT(*) AS 交易日数,
       SUM(hold) AS 持仓天数
FROM daily;

-- 同上，但加上「单笔交易」视角：每次开平仓的收益
WITH src AS (
  SELECT date, close * adj_factor AS px FROM etf_daily WHERE code = '510300'
),
ma AS (
  SELECT date, px,
         AVG(px) OVER (ORDER BY date ROWS 19 PRECEDING) AS ma20,
         AVG(px) OVER (ORDER BY date ROWS 59 PRECEDING) AS ma60
  FROM src
),
sig AS (
  SELECT date, px, CASE WHEN ma20 > ma60 THEN 1 ELSE 0 END AS pos
  FROM ma WHERE ma60 IS NOT NULL
),
-- 只保留仓位发生变化的日期
chg AS (
  SELECT date, px, pos,
         LAG(pos) OVER (ORDER BY date) AS prev
  FROM sig
)
SELECT date AS 开仓日, ROUND(px, 4) AS 开仓价, pos AS 方向
FROM chg
WHERE prev IS NOT NULL AND pos <> prev
ORDER BY date;


-- ------------------------------------------------------------
-- 五、数据质量检查（导入后必跑）
-- ------------------------------------------------------------
-- 1) 明显错误的价格
SELECT code, date, open, high, low, close
FROM etf_daily
WHERE close <= 0 OR high < low OR open > high * 1.01 OR low < 0
LIMIT 20;

-- 2) 单日涨跌幅超过 20%（ETF 涨跌停一般 10%，跨境/商品可能更大）
--    注意：这里用的是「原始价」，所以份额折算日一定会被列出（如 510500 2015-04-15 的 +248%）。
--    若要看真实异动，用 close*adj_factor 再跑一次，届时应无异常。
WITH r AS (
  SELECT code, date, close, LAG(close) OVER (PARTITION BY code ORDER BY date) AS pc
  FROM etf_daily
)
SELECT code, date, ROUND((close/pc - 1) * 100, 2) AS chg
FROM r WHERE pc > 0 AND ABS(close/pc - 1) > 0.20
ORDER BY ABS(close/pc - 1) DESC
LIMIT 20;

-- 3) 重复记录（应始终为 0）
SELECT code, date, COUNT(*) c FROM etf_daily GROUP BY code, date HAVING c > 1 LIMIT 5;

-- 4) 复权因子合理性
--    前缀积口径：最早交易日 = 1，之后随分红递增、遇缩股递减（可以小于 1）
SELECT code, MIN(adj_factor) mn, MAX(adj_factor) mx,
       (SELECT adj_factor FROM etf_daily d2 WHERE d2.code = d1.code
        ORDER BY date ASC LIMIT 1) first_f,
       (SELECT adj_factor FROM etf_daily d2 WHERE d2.code = d1.code
        ORDER BY date DESC LIMIT 1) last_f
FROM etf_daily d1
GROUP BY code
HAVING first_f <> 1 OR mn <= 0
LIMIT 10;
