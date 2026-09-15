#!/usr/bin/env node
// ============================================================
// 离线图表预览：复用生产 /ss 取数与渲染路径，只写 PNG，不发送 QQ 消息。
// 用法（由 docker compose 工具服务调用）：
//   node tools/render-preview.js ss /previews
// ============================================================
const fs = require('fs');
const path = require('path');

const { initChartFonts } = require('../chart-fonts');
initChartFonts();

const chart = String(process.argv[2] || 'ss').toLowerCase();
const outputDir = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data', 'previews'));

async function main() {
  if (chart !== 'ss') {
    throw new Error(`暂不支持图表：${chart}；当前支持：ss`);
  }

  // cmdSS 只拉取数据并渲染。QQ 网关发送由 index.js/gateway.js 上层负责，本脚本不会调用它们。
  const { cmdSS } = require('../commands/ss');
  const result = await cmdSS();
  if (!result.img || !result.img.startsWith('base64://')) {
    throw new Error(`未生成 PNG：${result.text || '未知渲染错误'}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })
    .replace(' ', '_').replaceAll(':', '-');
  const output = path.join(outputDir, `${chart}-${stamp}.png`);
  fs.writeFileSync(output, Buffer.from(result.img.slice('base64://'.length), 'base64'));
  console.log(`[preview] 已生成：${output}`);
  console.log(`[preview] 标题：${result.text}`);
}

main().catch(error => {
  console.error('[preview] 失败：', error.message);
  process.exitCode = 1;
});
