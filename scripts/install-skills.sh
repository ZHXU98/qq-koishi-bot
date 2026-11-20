#!/usr/bin/env bash
# 在「仓库内的 skill」和「WorkBuddy 运行时 skill 目录」之间同步。
#
#   bash scripts/install-skills.sh                 仓库 -> 运行时（重装/新克隆后用这个）
#   bash scripts/install-skills.sh --from-runtime  运行时 -> 仓库（在运行目录里改完，拉回仓库）
#   bash scripts/install-skills.sh --dry-run       只打印将要做什么
#
# 仓库是源，运行时是副本；两边不同步会导致「改了 skill 但自动化跑的还是旧版」。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_REPO="$REPO_ROOT/skills/a-share-daily-review"
RUNTIME_ROOT="${WORKBUDDY_SKILLS_DIR:-$HOME/.workbuddy/skills}"
DST_RUNTIME="$RUNTIME_ROOT/a-share-daily-review"

DIRECTION="to-runtime"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --from-runtime) DIRECTION="to-repo" ;;
    --dry-run)      DRY_RUN=1 ;;
    -h|--help)      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

if [ "$DIRECTION" = "to-runtime" ]; then
  SRC="$SRC_REPO"; DST="$DST_RUNTIME"
else
  SRC="$DST_RUNTIME"; DST="$SRC_REPO"
fi

[ -d "$SRC" ] || { echo "✗ 源目录不存在：$SRC" >&2; exit 1; }
[ -f "$SRC/SKILL.md" ] || { echo "✗ 源目录不像 skill（缺 SKILL.md）：$SRC" >&2; exit 1; }

echo "方向：$SRC  →  $DST"
command -v rsync >/dev/null || { echo "✗ 需要 rsync（macOS 自带；Linux: apt install rsync）" >&2; exit 1; }

RSYNC_ARGS=(-a --delete --exclude '.DS_Store' --exclude '_skillhub_meta.json')
if [ "$DRY_RUN" = "1" ]; then
  rsync "${RSYNC_ARGS[@]}" --dry-run --itemize-changes "$SRC/" "$DST/"
  echo "（dry-run，未改动任何文件）"
  exit 0
fi

# 备份要被覆盖的一方（保留最近 5 份）
if [ -d "$DST" ] && [ -n "$(ls -A "$DST" 2>/dev/null || true)" ]; then
  BACKUP_ROOT="$HOME/.workbuddy/skill-backups"
  mkdir -p "$BACKUP_ROOT"
  BACKUP="$BACKUP_ROOT/$(basename "$DST")-$(date +%Y%m%d-%H%M%S)"
  cp -R "$DST" "$BACKUP"
  echo "已备份：$BACKUP"
  ls -1dt "$BACKUP_ROOT"/a-share-daily-review-* 2>/dev/null | tail -n +6 | xargs -r rm -rf
fi

mkdir -p "$DST"
rsync "${RSYNC_ARGS[@]}" "$SRC/" "$DST/"

echo "✓ 完成。目标内容："
find "$DST" -maxdepth 1 -mindepth 1 | sed "s|$DST/|  |" | sort
echo
echo "提示：改完 skill 记得同步另一半并提交 ——"
echo "  git add skills/ && git commit -m 'chore(skill): ...' && git push"
