#!/usr/bin/env bash
# 本地预览服务（端口 3000）的拉起脚本。
#
# 为什么需要它：沙箱一轮休眠会把所有进程收走，而预览面板点开时只等 30 秒，
# 连不上就报 {"code":504,"msg":"service on port 3000 not ready after 30000ms"}——
# 这跟页面代码没关系，纯粹是「端口上没人听」。
#
# 用法（在项目根目录）：
#   bash tools/serve.sh          # 前台跑，Ctrl+C 停
#   bash tools/serve.sh --check  # 只问一句「活着没」，活着退出码 0
#
# 注意：不要 nohup / setsid / 尾随 &，那会让进程逃出任务管理，被沙箱清理时
# 变成端口被占但没人应答的僵尸状态，比不启动更难查。
set -uo pipefail

PORT="${PORT:-3000}"
cd "$(dirname "$0")/.." || exit 1

alive() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; }

if alive; then
  echo "已在运行：http://127.0.0.1:$PORT"
  exit 0
fi
if [ "${1:-}" = "--check" ]; then
  echo "端口 $PORT 没有响应"
  exit 1
fi

# 端口上如果有残留但不应答，先清掉：先按端口找 pid，再兜底按命令行匹配
if command -v ss >/dev/null 2>&1; then
  sed -n "s/.*:${PORT} .*pid=\([0-9]*\).*/\1/p" < <(ss -tlnp 2>/dev/null) |
    while read -r pid; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 0.5
fi

echo "启动 ETF 看板本地版：http://127.0.0.1:$PORT"
exec env PORT="$PORT" node server/app.mjs
