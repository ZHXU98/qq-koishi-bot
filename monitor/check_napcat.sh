#!/bin/bash
# check_napcat.sh —— NapCat 掉线监控
# 每小时由 WorkBuddy 自动化（automation-1786964342410）触发，也可手动运行做测试：
#   1. 探测 NapCat 是否真正可用：
#      - get_login_info + get_status 要求 online && good 同时为真，且账号=2804223545；
#      - 额外检测 NapCat 日志近 5 分钟是否刷 NT 内核报错（EventChecker Failed / 1006514 /
#        网络连接异常 / KickedOffLine）——这类「在线但内核已崩、发不出消息」的假活也判为掉线。
#   2. 掉线则自动 `docker compose restart napcat` 自愈（清 NT 内核崩坏 / 复用票据或密码回退）。
#   3. 自愈成功后向主号 1547450303 发 QQ 提醒。
#   4. 仍不可用：导出最新二维码到 monitor/latest_qr.png + macOS 桌面通知；
#      若日志命中「请在 WebUi 中继续完成验证」说明卡在安全验证，需在 WebUI/官方手机 QQ 完成验证。
#
# 设计要点：
#   - 只在状态变化时发 QQ（避免每小时刷屏）。
#   - 离线告警有 30 分钟冷却，防止反复重启导致通知轰炸。
#   - 用绝对路径，兼容精简环境（launchd / cron / 自动化）。

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

# 探测：online && good 同时为真 + 账号正确 + 近 5 分钟无 NT 内核报错
probe() {
  local info st
  info=$(curl -s --noproxy '*' -m 5 -X POST "$NAP_URL/get_login_info" 2>/dev/null)
  st=$(curl -s --noproxy '*' -m 5 -X POST "$NAP_URL/get_status" 2>/dev/null)
  if [ -z "$st" ]; then return 1; fi
  # good 为 false 表示底层连接异常（假在线）
  echo "$st" | grep -q '"online":true' && echo "$st" | grep -q '"good":true' || return 1
  # 账号校验，避免连错账号也误报在线
  echo "$info" | grep -q "\"user_id\":$EXPECTED_UID" || return 1
  # 在线但 NT 内核已崩（EventChecker Failed / 1006514）属假活，判为掉线
  local errs
  errs=$("$DOCKER_BIN" logs napcat --since 5m 2>/dev/null | grep -ciE "EventChecker Failed|1006514|网络连接异常|KickedOffLine" || true)
  [ "${errs:-0}" -gt 0 ] && return 1
  return 0
}

# 重启后复检：只看「重启完成后」产生的新错误（排除重启前的旧 EventChecker），
# 避免把历史报错算进来误判仍未恢复。
post_restart_ok() {
  local since_ts="$1"
  local info
  info=$(curl -s --noproxy '*' -m 5 -X POST "$NAP_URL/get_login_info" 2>/dev/null)
  [ -z "$info" ] && return 1
  local new_errs
  new_errs=$("$DOCKER_BIN" logs napcat --since "$since_ts" 2>/dev/null | grep -ciE "EventChecker Failed|1006514|网络连接异常|KickedOffLine" || true)
  [ "${new_errs:-0}" -gt 0 ] && return 1
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

# 重启并自愈；参数 $1 = 是否由「在线但内核崩」触发（用于日志措辞）
restart_and_recover() {
  local trigger="$1"
  if [ "$trigger" = "broken" ]; then
    log "在线但 NT 内核已崩（发不出消息），尝试自动重启 NapCat 清内核…"
  else
    log "检测到掉线！尝试自动重启 NapCat…"
  fi
  notify_desktop "NapCat 异常，正在尝试自动重启…"
  # 记录重启完成时刻（近似），用于重启后只看新错误
  "$DOCKER_BIN" compose -f "$COMPOSE_DIR/docker-compose.yml" restart napcat >/dev/null 2>&1
  local after
  after=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sleep 28
  # 等 NapCat 重新就绪（get_login_info 有返回）
  local i info
  for i in $(seq 1 15); do
    info=$(curl -s --noproxy '*' -m 5 -X POST "$NAP_URL/get_login_info" 2>/dev/null)
    [ -n "$info" ] && break
    sleep 2
  done
  if post_restart_ok "$after"; then
    log "自动重启成功，发送能力恢复"
    send_qq "⚠️ 同花顺rssBOT 在 $(ts) 检测到掉线，已自动重启恢复。如频繁掉线请关注票据/风控是否过期。"
    write_state "online" "$now"
  else
    log "自动重启后仍无法连接"
    if "$DOCKER_BIN" logs napcat --since "$after" 2>/dev/null | grep -q "请在 WebUi 中继续完成验证"; then
      log "卡在「新设备/安全验证」：需在 NapCat WebUI（http://127.0.0.1:6099/webui）或官方手机 QQ 完成安全验证后才能登录"
    fi
    # 每次都刷新最新二维码：容器重启会重新生成 QR，旧码已过期必须覆盖刷新。
    qr_ok=0
    for _ in $(seq 1 12); do
      if "$DOCKER_BIN" exec napcat test -s /app/napcat/cache/qrcode.png 2>/dev/null; then
        qr_ok=1; break
      fi
      sleep 2
    done
    if [ "$qr_ok" -eq 1 ]; then
      if "$DOCKER_BIN" cp napcat:/app/napcat/cache/qrcode.png "$QR_OUT" 2>/dev/null; then
        log "已导出最新二维码到 $QR_OUT"
      else
        log "二维码导出失败（docker cp 未成功覆盖 $QR_OUT）"
      fi
    else
      log "未找到容器内二维码（napcat 尚未生成，可能卡在验证而非扫码）"
    fi
    # 30 分钟冷却仅限制桌面通知频率，不影响二维码刷新
    if [ $((now - last_alert)) -gt 1800 ]; then
      notify_desktop "NapCat 仍不可用：如为安全验证请在 Mac 上完成验证；如为票据过期请扫码。详见 monitor/latest_qr.png。"
      write_state "offline" "$now"
    else
      log "离线告警冷却中（30 分钟内已提醒），跳过重复通知"
      write_state "offline" "$last_alert"
    fi
  fi
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
  # probe 失败：可能是「连接断/票据过期」或「在线但内核崩」。用日志区分措辞。
  if "$DOCKER_BIN" logs napcat --since 5m 2>/dev/null | grep -qiE "EventChecker Failed|1006514|网络连接异常"; then
    restart_and_recover "broken"
  else
    restart_and_recover "down"
  fi
fi
