# 部署记录

**状态：已上线** · 2026-11-04

| 项 | 值 |
|---|---|
| 线上地址 | https://etf-board.171098509.workers.dev |
| GitHub 仓库 | https://github.com/iniestao/etf-board（公开） |
| Cloudflare 账号 | `d4661207d82c2945cc023c3cd208362c` |
| Worker 名 | `etf-board` |
| KV 命名空间 | `etf-board-WATCH` / `433b04a19510470ca9e54a778cd2b598` |
| 历史数据源 | GitHub `data` 分支（`raw.githubusercontent.com`，jsDelivr 兜底） |
| R2 | 未启用 |
| Actions 定时 | 每天 16:35（北京时间），`update-data.yml` |

## 上线时的端到端验证

沙箱到 `workers.dev` 的出站被完全阻断（DNS 污染 + anycast 超时），无法从外部访问。
所以临时部署了一个带 cron 的 Worker，用 **service binding** 直接调 `etf-board` 的
fetch handler，把每步结果写进同一个 KV，再通过 Cloudflare API 把结果读出来。

测的是真实 Worker 运行时，不是本地 mock：

```
首页         HTTP 200   72484 bytes  text/html     14ms
状态         HTTP 200   kv=true gh=true             117ms
             hist: 1717 只 / 2026-11-03 / ETH1 / 17 列 / 47.8MB
历史K线      HTTP 200   36228 bytes  magic=ETH1     7ms
自选         HTTP 200   exists=false list=[]        3ms
全市场       HTTP 200   n=1717  src=sina            3740ms（首次拉 18 页）
```

验证完自检 Worker 与测试 key 已全部删除，KV 为空。

## 部署踩过的坑

| 问题 | 原因 | 处理 |
|---|---|---|
| 私有仓库 K 线全挂 | `raw.githubusercontent.com` 对匿名请求读私有仓库返回 **404**，jsDelivr 也不服务私有仓库 | 仓库改为公开；同时给 Worker 加了 `GITHUB_TOKEN` 分支，将来要私有化时配一个只读令牌即可 |
| 手写 API 部署的 cron 不触发 | `PUT /workers/scripts/{name}` 带 `metadata.triggers` 未真正绑定调度器 | 改用 `wrangler deploy` 读 `wrangler.toml` 的 `[triggers]`，一行 `schedule: * * * * *` 确认生效 |
| `curl -F` 上传报 `No such module` | multipart 的 filename 取自本地文件名，与 `main_module` 不一致 | 加 `filename=xxx.js` 显式指定 |
| Actions 首次失败 | `setup-python` 配了 `cache: pip`，但仓库没有 `requirements.txt` 可算缓存 key | 补 `alpha/requirements.txt` |
| `git push` 偶发 TLS 中断 | 网络对大流量 HTTPS 的干扰 | `-c http.version=HTTP/1.1`，仍失败就走 Contents API 上传 |

## 日常运维

**数据更新**：Actions 每天 16:35 自动跑，约 25 分钟（runner 在境外，访问新浪慢）。
想手动更新：仓库 **Actions** → `update-data` → **Run workflow**。

**改代码后重新部署**：

```bash
cd worker
npx wrangler deploy          # 需先 export CLOUDFLARE_API_TOKEN
```

**看实时日志**：

```bash
npx wrangler tail etf-board --format pretty
```

**验证线上**：

```bash
node tools/verify.mjs https://etf-board.171098509.workers.dev
```

## 可选升级

| 想解决的问题 | 做法 |
|---|---|
| K 线回源慢（首次 ~200ms） | 开 R2（需绑卡），`wrangler r2 bucket create etf-data` 后取消 toml 里 `[[r2_buckets]]` 注释再 deploy。绑了 R2 自动优先用 R2 |
| 仓库想改回私有 | `wrangler secret put GITHUB_TOKEN`，填一个只读 `data` 分支的 fine-grained PAT；代码已支持 |
| 想用自定义域名 | Cloudflare Dashboard → Workers → etf-board → Settings → Domains & Routes |
