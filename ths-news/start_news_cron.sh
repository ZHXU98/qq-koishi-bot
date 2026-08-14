#!/bin/sh
# 容器内启动脚本：周期性运行 fetch_ths_news.js 推送同花顺重要资讯
# 用法：作为容器 command / entrypoint，或手动执行
# 依赖：容器内仅需 node（无需 Chrome / puppeteer）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
[ -z "$SCRIPT_DIR" ] && SCRIPT_DIR="/app"
NODE_BIN="${NODE_BIN:-node}"
INTERVAL="${NEWS_INTERVAL:-600}"   # 默认 600 秒（10 分钟）

echo "[start_news_cron] 启动 | 脚本目录=${SCRIPT_DIR} | 间隔=${INTERVAL}s | NAPCAT_URL=${NAPCAT_URL:-http://127.0.0.1:3000}"

# 确保图片渲染依赖 @resvg/resvg-js 已安装（持久于 ths-news-modules 卷，首次启动联网安装一次，带重试以规避启动瞬间网络不稳）
if [ ! -d /app/node_modules/@resvg ]; then
  echo "[start_news_cron] 首次启动：安装 @resvg/resvg-js（图片卡片渲染依赖）..."
  for i in 1 2 3 4 5; do
    if npm install @resvg/resvg-js >> "${SCRIPT_DIR}/ths_news.log" 2>&1; then
      echo "[start_news_cron] ✅ @resvg 安装成功"
      break
    fi
    echo "[start_news_cron] ⚠️ 第 $i 次安装失败，5 秒后重试..."
    sleep 5
  done
  [ -d /app/node_modules/@resvg ] || echo "[start_news_cron] ⚠️ @resvg 多次安装失败，将回退纯文字推送"
fi

while true; do
  echo "[$(date '+%F %T')] 运行 fetch_ths_news.js"
  ${NODE_BIN} "${SCRIPT_DIR}/fetch_ths_news.js" >> "${SCRIPT_DIR}/ths_news.log" 2>&1 || echo "[$(date '+%F %T')] 运行出错: $?"
  sleep "${INTERVAL}"
done
