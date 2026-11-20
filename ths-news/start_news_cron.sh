#!/bin/sh
# 容器内启动脚本：运行 fetch_ths_news.js 推送同花顺重要资讯
# 注意：不要使用 set -e —— 一旦循环内某命令返回非 0，整个转发器会永久停摆。
# 实际的周期调度已改由 node 内部 setInterval 自调度（见 fetch_ths_news.js），
# 本脚本只负责启动 node；若 node 意外退出，while 循环会把它重新拉起。
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
[ -z "$SCRIPT_DIR" ] && SCRIPT_DIR="/app"
NODE_BIN="${NODE_BIN:-node}"
INTERVAL="${NEWS_INTERVAL:-600}"   # 默认 600 秒（10 分钟）

echo "[start_news_cron] 启动 | 脚本目录=${SCRIPT_DIR} | 间隔=${INTERVAL}s | NAPCAT_URL=${NAPCAT_URL:-http://127.0.0.1:3000}"

# 确保渲染依赖已安装（持久于 ths-news-modules 卷，首次启动联网安装一次，带重试以规避启动瞬间网络不稳）
# 2026-11-20：volume 同时被 qq-reply 以只读方式挂在 /app/node_modules 上用 —— 只装 resvg 会让
#   qq-reply 启动即崩（report-card.js 顶层 require('@napi-rs/canvas') 找不到模块），故两个都装。
if [ ! -d /app/node_modules/@resvg ] || [ ! -d /app/node_modules/@napi-rs ]; then
  echo "[start_news_cron] 首次启动：安装 @resvg/resvg-js + @napi-rs/canvas（图片渲染依赖）..."
  for i in 1 2 3 4 5; do
    if npm install @resvg/resvg-js @napi-rs/canvas >> "${SCRIPT_DIR}/ths_news.log" 2>&1; then
      echo "[start_news_cron] ✅ 渲染依赖安装成功"
      break
    fi
    echo "[start_news_cron] ⚠️ 第 $i 次安装失败，5 秒后重试..."
    sleep 5
  done
  [ -d /app/node_modules/@resvg ] || echo "[start_news_cron] ⚠️ @resvg 多次安装失败，将回退纯文字推送"
  [ -d /app/node_modules/@napi-rs ] || echo "[start_news_cron] ⚠️ @napi-rs/canvas 多次安装失败，qq-reply 可能无法启动"
fi

# 应用日志自裁剪：容器内自己管，不依赖宿主机 cron。
#   阈值 2MB，超过就只保留最后 2000 行（先写临时文件再覆盖，避免 tail 读自己写自己）。
trim_app_log() {
  [ -f "${SCRIPT_DIR}/ths_news.log" ] || return 0
  SZ=$(wc -c < "${SCRIPT_DIR}/ths_news.log" 2>/dev/null | tr -d ' ')
  [ "${SZ:-0}" -gt 2097152 ] || return 0
  tail -n 2000 "${SCRIPT_DIR}/ths_news.log" > "${SCRIPT_DIR}/ths_news.log.tmp" 2>/dev/null \
    && mv "${SCRIPT_DIR}/ths_news.log.tmp" "${SCRIPT_DIR}/ths_news.log" \
    && echo "[$(date '+%F %T')] [log] 应用日志超过 2MB（${SZ} 字节）→ 已裁剪至最后 2000 行"
}

while true; do
  trim_app_log
  echo "[$(date '+%F %T')] 运行 fetch_ths_news.js"
  ${NODE_BIN} "${SCRIPT_DIR}/fetch_ths_news.js" >> "${SCRIPT_DIR}/ths_news.log" 2>&1 || echo "[$(date '+%F %T')] 运行出错: $?"
  trim_app_log
  sleep "${INTERVAL}"
done
