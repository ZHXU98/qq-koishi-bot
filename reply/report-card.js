// ============================================================
// 手机文字长图：将完整命令报告排版为可阅读的中文 PNG
// ============================================================
const { createCanvas } = require('@napi-rs/canvas');

function cleanLine(line) {
  return String(line || '')
    .replace(/[📊📈📉🤖⚠️✅🚨🎯📍💡⏳🔔🔥🛡️🟢🔴🟡〰️↗️↘️🚀🔻ℹ️]/gu, '')
    .replace(/^[\s·→]+/, '')
    .trim();
}

function wrapLine(ctx, text, maxWidth) {
  const value = cleanLine(text);
  if (!value) return [''];
  const lines = [];
  let line = '';
  for (const char of value) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function reportRows(ctx, report, width, padding) {
  const rows = [];
  for (const raw of String(report || '').split('\n')) {
    const clean = cleanLine(raw);
    if (!clean) {
      rows.push({ type: 'gap' });
      continue;
    }
    if (/^━━━.*━━━$/.test(clean)) {
      rows.push({ type: 'section', text: clean.replace(/━/g, '').trim() });
      continue;
    }
    const indent = /^\s{2,}/.test(raw) || /^[·]/.test(raw) ? 22 : 0;
    const isHint = /^(注：|说明：|理由：|等待：|若 |如 |当 |仅 )/.test(clean);
    for (const text of wrapLine(ctx, raw, width - padding * 2 - indent)) {
      // 保留原始逻辑行的样式，避免“理由：...”自动换行后第二行变回正文黑色。
      rows.push({ type: 'text', text, indent, isHint });
    }
  }
  return rows;
}

function renderReportCard({ title, subtitle = '', report, footer = '非投资建议，请结合自身判断操作' }) {
  const W = 1080, PAD = 46, SCALE = 1.25;
  const probe = createCanvas(W, 100).getContext('2d');
  probe.font = '25px cjk';
  const rows = reportRows(probe, report, W, PAD);
  const rowH = 39, gapH = 16, sectionH = 56;
  const contentH = rows.reduce((sum, row) => sum + (row.type === 'gap' ? gapH : row.type === 'section' ? sectionH : rowH), 0);
  const H = Math.max(520, 138 + contentH + 70);
  const canvas = createCanvas(Math.round(W * SCALE), Math.round(H * SCALE));
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  const ink = '#252b36', sub = '#7b8798', panel = '#f6f7f9', blue = '#1677ff', red = '#f5222d';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = blue;
  ctx.fillRect(PAD, 32, 7, 66);
  ctx.fillStyle = ink;
  ctx.font = 'bold 32px cjk';
  ctx.fillText(title, PAD + 20, 56);
  ctx.fillStyle = sub;
  ctx.font = '17px cjk';
  ctx.fillText(subtitle, PAD + 20, 84);
  ctx.fillStyle = '#eef3ff';
  ctx.fillRect(PAD, 116, W - PAD * 2, 2);

  let y = 142;
  for (const row of rows) {
    if (row.type === 'gap') {
      y += gapH;
      continue;
    }
    if (row.type === 'section') {
      ctx.fillStyle = panel;
      ctx.beginPath();
      ctx.roundRect(PAD, y - 22, W - PAD * 2, 43, 10);
      ctx.fill();
      ctx.fillStyle = red;
      ctx.fillRect(PAD + 16, y - 12, 5, 23);
      ctx.fillStyle = ink;
      ctx.font = 'bold 24px cjk';
      ctx.fillText(row.text, PAD + 34, y);
      y += sectionH;
      continue;
    }
    const isHint = row.isHint;
    ctx.fillStyle = isHint ? sub : ink;
    ctx.font = isHint ? '22px cjk' : '25px cjk';
    ctx.fillText(row.text, PAD + row.indent, y);
    y += rowH;
  }
  ctx.fillStyle = sub;
  ctx.font = '15px cjk';
  ctx.textAlign = 'right';
  ctx.fillText(footer, W - PAD, H - 28);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

module.exports = { renderReportCard };
