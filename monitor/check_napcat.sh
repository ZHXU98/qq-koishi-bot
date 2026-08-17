#!/bin/bash
# check_napcat.sh —— NapCat 掉线监控
# 每小时由 launchd 触发一次（也可手动运行做测试）：
#   1. 探测 NapCat 是否真正在线（online && good 同时成立，能识别"假在线"）
#   2. 掉线则自动重启容器尝试自愈（覆盖"连接断开但票据未过期"这类可自愈场景）
#   3. 自愈成功后向主号 1547450303 发 QQ 消息说明
#   4. 仍不可用（需重新扫码）则发 macOS 桌面通知 + 导出最新二维码到 monitor/latest_qr.png
#
# 设计要点：
#   - 只在状态变化时发 QQ（避免每小时刷屏）
#   - 离线告警有 30 分钟冷却，防止反复重启导致通知轰炸
#   - 用绝对路径，兼容 launchd 的精简环境

set +e
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

COMPOSE_DIR="/Users/zhangxu/Desktop/qq-koishi-bot"
DOCKER_BIN="$(command -v docker || echo /usr/local/bin/docker)"
NAP_URL="http://127.0.0.1:3000"
OWNER="1547450303"
EXPECTED_UID="2804223545"
LOG_DIR="$COMPOSE_DIR/monitor"
LOG="$LOG_DIR/monitor.log"
STATE="$LOG_DIR/state.json"
QR_OUT="$LOG_DIR/latest_qr.png"
mkdir -p "$LOG_DIR"

ts() { date '+%F %T'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# 读历史状态
last_status="unknown"
last_alert=0
if [ -f "$STATE" ]; then
  last_status=$(grep -o '"status":"[^"]*"' "$STATE" 2>/dev/null | head -1 | sed 's/"status":"//;s/"//')
  last_alert=$(grep -o '"last_alert":[0-9]*' "$STATE" 2>/dev/null | head -1 | sed 's/"last_alert"://')
  [ -z "$last_alert" ] && last_alert=0
fi

# 探测：online && good 同时为真，且账号为预期 bot 账号
probe() {
  local info st
  info=$(curl -s --noproxy '*' -m 5 -X POST "$NAP_URL/get_login_info" 2>/dev/null)
  st=$(curl -s --noproxy '*' -m 5 -X POST "$NAP_URL/get_status" 2>/dev/null)
  if [ -z "$st" ]; then return 1; fi
  # good 为 false 表示底层连接异常（假在线），按掉线处理
  echo "$st" | grep -q '"online":true' && echo "$st" | grep -q '"good":true' || return 1
  # 账号校验，避免连错账号也误报在线
  echo "$info" | grep -q "\"user_id\":$EXPECTED_UID" || return 1
  return 0
}

send_qq() {
  local msg="$1"
  curl -s --noproxy '*' -m 8 -X POST "$NAP_URL/send_private_msg" \
    -H 'Content-Type: application/json' \
    -d "{\"user_id\":$OWNER,\"message\":[{\"type\":\"text\",\"data\":{\"text\":\"$msg\"}}]}" >/dev/null 2>&1
}

notify_desktop() {
  local msg="$1"
  osascript -e "display notification \"$msg\" with title \"NapCat 监控\"" 2>/dev/null || true
}

write_state() {
  local s="$1" a="$2"
  echo "{\"status\":\"$s\",\"last_alert\":$a,\"updated\":$(date +%s)}" > "$STATE"
}

# 测试模式：强制发一条 QQ 验证链路；--force-offline 模拟掉线走告警分支
TEST_MODE=0
FORCE_OFFLINE=0
for a in "$@"; do
  case "$a" in
    --test) TEST_MODE=1 ;;
    --force-offline) FORCE_OFFLINE=1 ;;
  esac
done

now=$(date +%s)

if [ "$TEST_MODE" -eq 1 ]; then
  log "【测试】主动发送一条自检消息到主号 $OWNER"
  send_qq "🔧 监控自检：同花顺rssBOT 告警通道正常（$(ts)）。"
  write_state "$last_status" "$now"
  exit 0
fi

if [ "$FORCE_OFFLINE" -eq 1 ]; then
  log "【模拟掉线】走离线告警分支"
  probe() { return 1; }
fi

if probe; then
  if [ "$last_status" = "offline" ]; then
    log "状态恢复：在线 (user $EXPECTED_UID)"
    send_qq "✅ 同花顺rssBOT 已恢复在线（自动监控在 $(ts) 检测到并恢复）。"
  else
    log "在线（心跳正常）"
  fi
  write_state "online" "$last_alert"
else
  log "检测到掉线！尝试自动重启 NapCat…"
  notify_desktop "NapCat 掉线，正在尝试自动重启…"
  "$DOCKER_BIN" compose -f "$COMPOSE_DIR/docker-compose.yml" restart napcat >/dev/null 2>&1
  sleep 22
  if probe; then
    log "自动重启成功，已恢复在线"
    send_qq "⚠️ 同花顺rssBOT 在 $(ts) 检测到掉线，已自动重启恢复。如频繁掉线请关注票据是否过期。"
    write_state "online" "$now"
  else
    log "自动重启后仍无法连接（可能需重新扫码登录）"
    if [ $((now - last_alert)) -gt 1800 ]; then
      notify_desktop "NapCat 需重新扫码登录（票据可能已过期）。请在 Mac 上处理。"
      "$DOCKER_BIN" cp napcat:/app/napcat/cache/qrcode.png "$QR_OUT" 2>/dev/null || true
      log "已导出最新二维码到 $QR_OUT"
      write_state "offline" "$now"
    else
      log "离线告警冷却中（30 分钟内已提醒），跳过重复通知"
      write_state "offline" "$last_alert"
    fi
  fi
fi
