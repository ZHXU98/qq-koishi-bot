// ============================================================
// 图表中文字体初始化：生产入口与离线预览入口各在进程启动时调用一次。
// ============================================================
const fs = require('fs');
const path = require('path');

let initialized = false;

function resolveCjkFont() {
  const candidates = [
    process.env.CJK_FONT_PATH,
    '/app/fonts/cjk_sub.ttf',
    '/app/fonts/cjk.ttc',
    path.resolve(__dirname, '../ths-news/fonts/cjk.ttc'),
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file)) || null;
}

function initChartFonts() {
  if (initialized) return;
  initialized = true;
  const font = resolveCjkFont();
  if (!font) return;
  try {
    const { GlobalFonts } = require('@napi-rs/canvas');
    GlobalFonts.registerFromPath(font, 'cjk');
  } catch (_) {
    // Canvas 不可用时，各图表会走 Resvg fallback。
  }
}

module.exports = { initChartFonts, resolveCjkFont };
