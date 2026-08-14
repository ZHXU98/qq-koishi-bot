#!/bin/sh
# 准备中文字体：从本机系统字体中复制一款 CJK 字体到 ths-news/fonts/cjk.ttc
# 目的：避免把 22MB 字体文件及字体授权提交到 Git / GitHub。
# 用法：bash setup_fonts.sh   （在 ths-news/ 目录下运行）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
DEST="${SCRIPT_DIR}/fonts/cjk.ttc"
mkdir -p "${SCRIPT_DIR}/fonts"

echo "[setup_fonts] 目标文件: ${DEST}"

# 候选字体（按优先级）：macOS 系统字体 + Linux 常见 CJK 字体
CANDIDATES="
/System/Library/Fonts/Hiragino Sans GB.ttc
/System/Library/Fonts/Supplemental/Songti.ttc
/System/Library/Fonts/Supplemental/PingFang.ttc
/System/Library/Fonts/STHeiti Light.ttc
/Library/Fonts/Arial Unicode.ttf
/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc
/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc
/usr/share/fonts/truetype/wqy/wqy-microhei.ttc
"

found=""
for f in $CANDIDATES; do
  if [ -f "$f" ]; then found="$f"; break; fi
done

if [ -n "$found" ]; then
  echo "[setup_fonts] 找到系统字体: $found"
  cp "$found" "$DEST"
  echo "[setup_fonts] ✅ 已复制为 cjk.ttc ($(du -h "$DEST" | cut -f1))"
  exit 0
fi

echo "[setup_fonts] ⚠️ 未自动找到 CJK 字体。"
echo "请手动复制任意一款中文字体（.ttc / .ttf / .otf）到以下路径："
echo "  ${DEST}"
echo "例如 macOS："
echo "  cp '/System/Library/Fonts/Hiragino Sans GB.ttc' '${DEST}'"
echo "Linux（Noto）："
echo "  cp /usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc '${DEST}'"
echo "放置完成后容器无需重启（bind mount 实时生效），下一轮循环即可渲染中文。"
exit 1
