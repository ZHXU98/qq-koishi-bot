#!/bin/sh
# ============================================================
# 安装「每天 04:10 清理日志」的定时任务
#   macOS  → launchd（~/Library/LaunchAgents），无需 root，后台常驻
#   Linux  → crontab（当前用户）
#
# 用法：
#   sh scripts/install-log-cleanup.sh              # 安装 / 更新
#   sh scripts/install-log-cleanup.sh --uninstall  # 卸载
#   sh scripts/install-log-cleanup.sh --run-now    # 立即跑一次清理
# ============================================================
set -u

PROJECT_DIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
SCRIPT="$PROJECT_DIR/scripts/clean-logs.sh"
LOG_DIR="$PROJECT_DIR/logs"
LABEL="com.zhxu.qqbot-logcleanup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOUR=4
MINUTE=10

mkdir -p "$LOG_DIR"
chmod +x "$SCRIPT" 2>/dev/null

if [ ! -f "$SCRIPT" ]; then
  echo "❌ 找不到 $SCRIPT"
  exit 1
fi

ACTION="${1:-install}"

# ---------- Linux：crontab ----------
if [ "$(uname -s)" = "Linux" ]; then
  MARK="# qqbot-logcleanup"
  LINE="$MINUTE $HOUR * * * /bin/sh $SCRIPT >/dev/null 2>&1 $MARK"
  case "$ACTION" in
    --uninstall)
      ( crontab -l 2>/dev/null | grep -v "qqbot-logcleanup" ) | crontab -
      echo "✅ 已移除 crontab 任务"
      ;;
    --run-now)
      ( crontab -l 2>/dev/null | grep -v "qqbot-logcleanup"; echo "$LINE" ) | crontab -
      echo "✅ 已安装 crontab（每天 04:10）"
      sh "$SCRIPT"
      ;;
    install|*)
      ( crontab -l 2>/dev/null | grep -v "qqbot-logcleanup"; echo "$LINE" ) | crontab -
      echo "✅ 已安装 crontab：每天 04:10 执行 $SCRIPT"
      crontab -l 2>/dev/null | grep "qqbot-logcleanup"
      ;;
  esac
  exit 0
fi

# ---------- macOS：launchd ----------
case "$ACTION" in
  --uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ 已卸载定时任务 $LABEL"
    ;;
  install|--run-now|*)
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$SCRIPT</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/launchd.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLISTEOF
    mkdir -p "$HOME/Library/LaunchAgents"
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
      echo "✅ 已注册 launchd 任务：$LABEL（每天 04:10）"
    else
      launchctl load "$PLIST" 2>/dev/null && echo "✅ 已加载（旧版 launchctl）：$LABEL" || echo "⚠️ launchd 注册失败，请检查 $PLIST"
    fi
    launchctl list 2>/dev/null | grep -i qqbot-logcleanup || true
    echo "   脚本：$SCRIPT"
    echo "   日志：$LOG_DIR/cleanup.log"
    if [ "$ACTION" = "--run-now" ]; then
      echo "--- 立即执行一次 ---"
      sh "$SCRIPT"
    fi
    ;;
esac
