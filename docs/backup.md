# 数据备份与恢复

沙箱是临时环境，`/workspace` 下的东西不保证跨会话保留。代码在 git 里，数据不在。
这份文档说明数据放在哪、怎么拿回来。

## 为什么不直接提交进仓库

| 限制 | 数值 | 影响 |
|---|---|---|
| 单文件上限 | 100 MB | `stocks.db` 1120 MB，push 直接被拒 |
| 仓库软限 | 1 GB | 现有数据 1.5 GB，已越线 |
| 版本控制模型 | 每次提交存完整快照 | 日线每天更新，一个月就是 30 份 1.1 GB 副本 |
| 仓库可见性 | 必须公开 | Worker 通过 `raw.githubusercontent.com` 匿名读 data 分支，私有仓库一律 404 |

所以大文件走 **Release assets**：单文件 2 GB、不进 git 历史、仓库体积不膨胀。

## 数据在哪

Release tag：**`data-2026-11-06`**

https://github.com/iniestao/etf-board/releases/tag/data-2026-11-06

| 资产 | 压缩后 | 解压后 | 内容 | 可重建性 |
|---|---|---|---|---|
| `stocks.db.gz` | 375 MB | 1.1 GB | A 股日线 `daily` 1494 万行 / `meta` 4348 只 | 可重抓，数小时 |
| `pcf.db.gz` | 17.7 MB | 77 MB | 18145 个深市 PCF 历史文件（可回溯 2019） | **不可重建**，交易所会下架旧文件 |
| `out_pcf_daily.csv.gz` | 23.6 MB | 52 MB | 因子面板（折溢价、成分因子） | 从上面两个库重算，几十分钟 |

SHA256 与 GitHub 侧独立计算的 `digest` 逐一对齐过，三个文件均一致。

## 每日增量（自动）

存量基线是一次性快照，之后每天由 `.github/workflows/backup-data.yml` 自动累积：

| | |
|---|---|
| 触发 | 每个交易日北京时间 16:40（可手动 `workflow_dispatch` 补跑） |
| 抓取 | 个股日线 4348 只（约 2 分钟）、深市 PCF 191 只（11 秒）、沪市 PCF 241 只（约 4 分钟） |
| 产出 | `daily/YYYY-MM-DD.parquet`（最近 5 个交易日）、`pcf_meta/`、`pcf_hold/` |
| 落点 | `factor-data` 分支，**按日累积**（不像 `data` 分支那样 force push 覆盖） |
| 体积 | 每天约 777 KB，一年约 190 MB |

关键点：**跑在 GitHub Actions，不在沙箱**。沙箱正是要防的东西，让它自己守护自己的数据，休眠一次就断，而且断了没人知道。

为什么只存最近 5 个交易日而不是当天：哪天的流水线挂了，后一天还能把那天补上。合并按 `(code, date)` 主键去重，重复写入是幂等的。

抓取脚本对 CI 的适配都在文件头注释里，两个容易踩的坑：

- `hfq.js` 的复权因子是**稀疏**的（茅台三年才 33 条，只在分红除权日有记录）。截断 bars 时若跟着截 `adj`，ffill 会拿不到因子，`close_adj` 退化成 `close`——茅台差 8.88 倍且不报错。
- 名单不能从 `shares.db` 取（CI 里没有这个库），改用随仓库提交的 `universe.txt`、`pcf_universe.txt`、`pcf_universe_sse.txt`。

## 恢复

```bash
git clone git@github.com:iniestao/etf-board.git
cd etf-board
./scripts/restore-data.sh                    # 拉基线（Release）
git clone -b factor-data --depth 1 \
  git@github.com:iniestao/etf-board.git factor-data   # 拉增量
python factor_lab/merge_increments.py \
  --baseline factor_lab/stocks.db \
  --baseline-pcf factor_lab/pcf.db \
  --inc factor-data
```

产出 `stocks.merged.db` / `pcf.merged.db`（脚本用 `replace('.db', '.merged.db')`，注意文件名不是 `stocks.db.merged.db`）。

合并已验证：删掉基线里某一天再合，能准确补回 4229 行，`close_adj` 与原始逐位一致，零重复键。


### 关于下载速度

实测从当前沙箱拉 Release 资产约 **30 KB/s**，376 MB 要跑三个多小时；单连接限速，并发分片没有改善。
这是本机到 `objects.githubusercontent.com` 的链路问题，不是仓库问题——浏览器或家用宽带下通常几分钟。

真到了要恢复的时候，两条更快的路：

1. **本地下载再传**：在自己电脑上打开 Release 页面下载（家用宽带通常 5–20 MB/s），再用 `scp` 或对象存储中转进新沙箱。
2. **只拉必需的**：`pcf.db.gz` 只有 17.7 MB，是三者中唯一不可再生的；`stocks.db` 急了就重抓。

## 手动更新基线

基线只在需要「重置起点」时更新（比如增量分支被弄坏了，重新打一个全量快照）：

```bash
cd factor_lab
gzip -1 -c stocks.db > /tmp/stocks.db.gz
gzip -1 -c pcf.db    > /tmp/pcf.db.gz
gzip -1 -c out_pcf_daily.csv > /tmp/out_pcf_daily.csv.gz
sha256sum /tmp/*.gz
```

然后建一个新的 tag（把日期换掉）并上传三个资产。`-1` 已经能压到 23%–33%，
用 `-9` 只多压几个点、却慢十倍，不值得。

`pcf.db` 请优先更新——它是唯一「丢了就买不回来」的那份。
