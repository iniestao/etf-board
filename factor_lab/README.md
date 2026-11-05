# 因子实验室

100 个新量价因子 + Alpha101 的指数级复检。产物供页面 `/research` 的「第二批」区块使用。

## 为什么单独一个目录

`alpha/` 那套是每日流水线跑的（1717 只 ETF、个股口径、101 个因子）。
这里是**离线研究**：换标的池（同指数只留流动性最好的一只）、换因子集（100 个有文献出处的构造），
跑完把结论固化成 `worker/src/lab_data.js`，页面不再需要拉接口。

## 跑的顺序

```bash
python3 panel.py       # 建面板：1617 只 ETF → 468 个指数，股票 + 商品
python3 factors.py     # 算 100 个因子，落 out_panel_*.parquet
python3 recompute.py   # 两期 IC / 多头超额统计 → out_cross.csv
python3 final.py       # 三策略对照（A 单因子 / B 组合 / 基准）→ out_final.json
python3 wf.py          # walk-forward，全程无前视
python3 sens.py        # PE 的参数敏感性 → out_pe_sens.csv
python3 export_lab.py  # 生成 worker/src/lab_data.js（前端内嵌）
```

`alpha_stats.py` 把 Alpha101 搬到同一池子上算统计，`alpha_on_index.py` 是它的计算部分（产物 161MB，
不进仓库）。`make_charts2.py` / `make_report2.py` 出报告，报告在 `../etf_report/`。

## 三条结论

1. **去重是必要的**：1617 只 ETF 压到 468 个指数，同指数多只 ETF 在横截面里等于重复投票。
2. **样本内筛不出样本外**：28 个样本内显著，只有 9 个两期都站得住；样本外有效的 34 个里 25 个样本内看不出。
3. **PE（净涨幅 ÷ 路径长度）是唯一经得住两期的多头因子**：2019-06 起年化 12.68% vs 基准 5.44%，
   但超额集中在下跌年（2022 +28%、2026 +22%），2020 跑输 13 个点。

## 注意

- `data/etf.db` 是流水线产出的，不在本仓库版本控制内。
- `*.parquet` 和 `out_*.csv` 都是可重算的中间产物，已 ignore。
