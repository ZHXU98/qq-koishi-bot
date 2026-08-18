#!/usr/bin/env bash
# 记录 NapCat 掉线事件到 monitor/disconnect_log.md
# 用法（由每小时监控自动化调用）：
#   bash monitor/record_disconnect.sh "<现象/处置简述>"
# 去重：距上次记录 < 2h 视为同一 episode，不重复记（避免一次长离线被每小时重复计）。
set -euo pipefail

DIR=/Users/zhangxu/Desktop/qq-koishi-bot/monitor
LOG="$DIR/disconnect_log.md"
STATE="$DIR/.disconnect_state"   # 内容: last_epoch<TAB>count<TAB>sum_intervals(秒)

NOW_EPOCH=$(date +%s)
NOW_HUMAN=$(date '+%m-%d %H:%M')
DEDUP=7200   # 2 小时

last_epoch=0; count=0; sum=0
if [ -f "$STATE" ]; then
  IFS=$'\t' read -r last_epoch count sum < "$STATE" 2>/dev/null || true
fi

interval_human="—"
if [ "${last_epoch:-0}" -gt 0 ]; then
  interval=$((NOW_EPOCH - last_epoch))
  if [ "$interval" -lt "$DEDUP" ]; then
    # 同一 episode，不重复记录
    exit 0
  fi
  interval_human=$(printf '%dh%02dm' $((interval/3600)) $((interval%3600/60)))
fi

#  sanitize note: 去掉 | 与换行，避免破坏表格
note=$(printf '%s' "$1" | tr -d '|\n')

count=$((count + 1))
if [ "${last_epoch:-0}" -gt 0 ]; then
  sum=$((sum + (NOW_EPOCH - last_epoch)))
fi

# 追加明细行
printf '| %s | %s | %s | %s |\n' "$count" "$NOW_HUMAN" "$interval_human" "$note" >> "$LOG"

# 更新汇总块
avg="—"
if [ "$count" -gt 1 ]; then
  avg=$(printf '%dh%02dm' $((sum/(count-1)/3600)) $((sum/(count-1)%3600/60)))
fi
TS=$(date '+%Y-%m-%d %H:%M')
sed -i '' "s|^- 累计掉线次数：.*|- 累计掉线次数：**$count**（截至 $TS）|" "$LOG"
sed -i '' "s|^- 平均间隔：.*|- 平均间隔：约 **$avg**|" "$LOG"

# 写回 state
printf '%s\t%s\t%s\n' "$NOW_EPOCH" "$count" "$sum" > "$STATE"
