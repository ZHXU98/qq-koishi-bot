#!/bin/sh
# ============================================================
# QQ 机器人日志清理（每天定时跑一次，见 scripts/install-log-cleanup.sh）
#
# 清理对象：
#   1. Docker 容器 stdout 日志（json-file 驱动时才有宿主机文件可截断）
#   2. 容器内应用日志 /app/ths_news.log（保留最后 N 行）
#   3. 宿主机上的 *.log（ths-news / a-share-report，保留最后 N 行）
#   4. Docker 悬空镜像 / 24h 前的构建缓存 / 本项目的已停止容器
#
# 用法：
#   sh scripts/clean-logs.sh              # 正常清理
#   sh scripts/clean-logs.sh --dry-run    # 只报告不删
#   sh scripts/clean-logs.sh --keep 500   # 保留最后 500 行（默认 2000）
# ============================================================
set -u

KEEP_LINES=2000
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --keep) KEEP_LINES="${2:-2000}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

PROJECT_DIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/cleanup.log"

# 自身日志超过 512KB 先自清一半，避免清理脚本自己变成新负担
if [ -f "$LOG_FILE" ]; then
  SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
  if [ "${SIZE:-0}" -gt 524288 ]; then
    tail -n 500 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi

say() {
  LINE="[$(date '+%F %T')] $*"
  echo "$LINE"
  echo "$LINE" >> "$LOG_FILE"
}

# ---------- 定位 docker（Docker Desktop 的 CLI 常在 ~/.docker/bin，不在默认 PATH）----------
DOCKER_BIN=""
for c in "$(command -v docker 2>/dev/null)" "$HOME/.docker/bin/docker" /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do
  [ -n "$c" ] && [ -x "$c" ] && DOCKER_BIN="$c" && break
done

DOCKER_OK=0
if [ -n "$DOCKER_BIN" ] && "$DOCKER_BIN" info >/dev/null 2>&1; then
  DOCKER_OK=1
fi

say "===== 开始清理（keep=${KEEP_LINES} 行，dry-run=${DRY}）====="
[ "$DOCKER_OK" = 1 ] || say "⚠️ docker 不可用或守护进程未运行，跳过容器相关清理"

# ---------- 1. 容器 stdout 日志 ----------
if [ "$DOCKER_OK" = 1 ]; then
  DRIVER=$("$DOCKER_BIN" info --format '{{.LoggingDriver}}' 2>/dev/null)
  say "docker logging driver = ${DRIVER:-unknown}"
  for C in official-bot-gateway qq-reply ths-news; do
    "$DOCKER_BIN" inspect "${C}" >/dev/null 2>&1 || { say "${C}：容器不存在，跳过"; continue; }
    LP=$("$DOCKER_BIN" inspect --format '{{.LogPath}}' "${C}" 2>/dev/null)
    if [ -z "${LP}" ]; then
      # local 驱动把日志放在 VM 内部，宿主机无路径；该驱动自带轮转（默认 20MB×5）
      say "${C}：日志由 ${DRIVER:-local} 驱动托管，无宿主机路径可截断（该驱动自带轮转，通常无需处理）"
      continue
    fi
    [ -f "${LP}" ] || { say "${C}：日志文件不存在 ${LP}"; continue; }
    SZ=$(du -h "${LP}" 2>/dev/null | awk '{print $1}')
    if [ "$DRY" = 1 ]; then
      say "${C}：将截断 ${LP}（当前 ${SZ}）"
      continue
    fi
    if truncate -s 0 "${LP}" 2>/dev/null || sudo -n truncate -s 0 "${LP}" 2>/dev/null; then
      say "${C}：已截断 stdout 日志（原 ${SZ}）"
    else
      say "⚠️ ${C}：无权限截断 ${LP}（需要 root，请用 sudo 跑本脚本）"
    fi
  done

  # ---------- 2. 容器内应用日志 ----------
  if "$DOCKER_BIN" ps --format '{{.Names}}' 2>/dev/null | grep -qx "ths-news"; then
    if [ "$DRY" = 1 ]; then
      SZ=$("$DOCKER_BIN" exec ths-news sh -c "du -h /app/ths_news.log 2>/dev/null | awk '{print $1}'" 2>/dev/null)
      say "ths-news：将裁剪 /app/ths_news.log 至最后 ${KEEP_LINES} 行（当前 ${SZ:-不存在}）"
    else
      "$DOCKER_BIN" exec ths-news sh -c "if [ -f /app/ths_news.log ]; then tail -n ${KEEP_LINES} /app/ths_news.log > /tmp/.thslog.tmp && cat /tmp/.thslog.tmp > /app/ths_news.log && rm -f /tmp/.thslog.tmp; fi" >/dev/null 2>&1 \
        && say "ths-news：已裁剪 /app/ths_news.log 至最后 ${KEEP_LINES} 行" \
        || say "⚠️ ths-news：应用日志裁剪失败"
    fi
  fi
fi

# ---------- 3. 宿主机 *.log ----------
for F in "$PROJECT_DIR"/ths-news/*.log "$PROJECT_DIR"/a-share-report/*.log; do
  [ -f "${F}" ] || continue
  SZ=$(du -h "${F}" 2>/dev/null | awk '{print $1}')
  if [ "$DRY" = 1 ]; then
    say "将裁剪 ${F} 至最后 ${KEEP_LINES} 行（当前 ${SZ}）"
    continue
  fi
  if tail -n "$KEEP_LINES" "${F}" > "${F}.tmp" 2>/dev/null && mv "${F}.tmp" "${F}"; then
    say "已裁剪 ${F} 至最后 ${KEEP_LINES} 行（原 ${SZ}）"
  else
    rm -f "${F}.tmp" 2>/dev/null
    say "⚠️ 裁剪失败 ${F}"
  fi
done

# ---------- 4. Docker 资源回收（不动数据卷、不动运行中容器）----------
if [ "$DOCKER_OK" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    say "将执行：image prune（悬空）/ builder prune（24h 前）/ container prune（本项目已停止容器）"
  else
    BEFORE=$("$DOCKER_BIN" system df --format '{{.Size}}' 2>/dev/null | head -1)
    "$DOCKER_BIN" image prune -f >/dev/null 2>&1 && say "已清理悬空镜像"
    "$DOCKER_BIN" builder prune -f --filter until=24h >/dev/null 2>&1 && say "已清理 24h 前的构建缓存"
    "$DOCKER_BIN" container prune -f --filter "label=com.docker.compose.project=qq-koishi-bot" >/dev/null 2>&1 \
      && say "已清理本项目已停止的容器"
    AFTER=$("$DOCKER_BIN" system df --format '{{.Size}}' 2>/dev/null | head -1)
    say "docker 镜像占用：${BEFORE:-?} → ${AFTER:-?}"
  fi
fi

say "===== 清理结束 ====="
