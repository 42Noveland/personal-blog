#!/bin/bash
# start-blog.sh — 启动（或重启）博客服务
# 用法：APP_DIR=/opt/blog PORT=3081 bash start-blog.sh   （默认 /opt/blog + 3081）
set -e

APP_DIR=${APP_DIR:-/opt/blog}
PORT=${PORT:-3081}
LOG=${LOG:-/var/log/blog.log}
PIDFILE=$APP_DIR/blog.pid

cd "$APP_DIR"

# 已在运行则先停掉（按端口精确取 PID，避免 pkill -f 自匹配）
OLD=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1 || true)
if [ -n "$OLD" ]; then
  echo "停止旧进程 PID=$OLD"
  kill "$OLD" 2>/dev/null || true
  sleep 1
fi

# 完全脱离当前会话启动（setsid + nohup + stdin 重定向）
setsid nohup node server.js > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
echo "已启动，PID=$(cat $PIDFILE)，日志：$LOG"

# 等待就绪并自检
for i in $(seq 1 20); do
  sleep 1
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  if [ "$CODE" = "200" ]; then
    echo "健康检查通过：http://127.0.0.1:$PORT/ → 200"
    exit 0
  fi
done
echo "启动后健康检查未通过，最近日志："
tail -30 "$LOG"
exit 1
