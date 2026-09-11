// ============================================================
// /zj 行业资金流：排行 / 分时曲线 / 日级流入
// ============================================================
const { cacheGet, cacheSet, fmtAmountWan, fmtAmountYuan } = require('../utils');
const { emFetchJson } = require('../market');

// 数据源：腾讯板块行情 getRank（hy=申万一级 31 个、hy2=申万二级 124 个），字段 zljlr=主力净流入（万）
// 注意：腾讯 hy3 无数据（total=0 实测），申万三级资金流免费源暂缺，命令内做明确提示。
const ZJ_RANK = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=%s&sort_type=price&direct=down&offset=0&count=200';
const ZJ_LEVEL_BT = { '1': 'hy', '一级': 'hy', 'sw1': 'hy', '一': 'hy', '2': 'hy2', '二级': 'hy2', 'sw2': 'hy2', '二': 'hy2', '3': 'hy3', '三级': 'hy3', 'sw3': 'hy3', '三': 'hy3' };
const ZJ_LEVEL_LABEL = { hy: '申万一级', hy2: '申万二级', hy3: '申万三级' };

// ---------- 东财行业资金流曲线（分时波动 / 日级流入，2026-09-01 新增） ----------
// 说明：申万分类无免费时序资金流源（腾讯仅快照、同花顺反爬），曲线图用东财行业分类（86 个，粒度≈申万二级）。
// 分时：push2 fflow/kline klt=1（主力净流入累计，元）→ 差分得每分钟净流入（波动直观）；
// 日K：push2his fflow/daykline klt=101（120 日每日主力净流入，元）。
const EM_BOARD_LIST = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f62';
const EM_BOARD_FF_MIN = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=90.%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
const EM_BOARD_FF_DAY = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=120&klt=101&secid=90.%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
const ZJ_PALETTE = ['#f5222d', '#0aa869', '#409eff', '#f56c6c', '#9b59b6', '#e67e22', '#2ecc71', '#3498db', '#e74c3c', '#1abc9c', '#f39c12', '#8e44ad', '#2980b9', '#c0392b', '#27ae60', '#d35400', '#16a085', '#7f8c8d', '#d68910', '#34495e'];

async function fetchEmBoards() {
  const cached = cacheGet('emboards');
  if (cached) return cached;
  try {
    const j = await emFetchJson(EM_BOARD_LIST);
    if (!j) return null;
    const list = (j.data?.diff || []).map(x => ({ code: String(x.f12), name: String(x.f14 || ''), zljlr: Number(x.f62) || 0 }));
    if (list.length < 2) return null;
    list.sort((a, b) => b.zljlr - a.zljlr);
    cacheSet('emboards', list, 30000); // 板块列表 30s 缓存
    return list;
  } catch (_) { return null; }
}

async function fetchBoardFflow(code, mode) {
  const ckey = 'bff:' + code + ':' + mode;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  try {
    const j = await emFetchJson((mode === 't' ? EM_BOARD_FF_MIN : EM_BOARD_FF_DAY).replace('%s', code));
    if (!j) return null;
    const kl = j.data?.klines;
    if (!Array.isArray(kl) || kl.length < 2) return null;
    let prev = 0;
    const out = kl.map(k => {
      const p = String(k).split(',');
      const main = Number(p[1]) || 0;
      const v = mode === 't' ? main - prev : main; // 分时：差分得每分钟净流入；日K：当日净流入
      prev = main;
      return { t: p[0], v };
    });
    cacheSet(ckey, out, mode === 't' ? 15000 : 600000); // 分时 15s、日K 10min
    return out;
  } catch (_) { return null; }
}

function renderZjCurveCanvas(series, mode, levelLabel) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD_L = 84, PAD_R = 20, TITLE_H = 62;
  const n = series.length;
  const legendRows = Math.ceil(n / 2);
  const LEG_H = legendRows * 24 + 8;
  const plotH = 320;
  const H = TITLE_H + plotH + LEG_H + 26;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  const bg = '#ffffff', ink = '#2b2f36', sub = '#8a919e', grid = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 24px cjk';
  ctx.fillText(`${mode === 't' ? '行业资金分时波动' : '行业资金日级流入'}（${levelLabel}）`, PAD_L, 28);
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText(`${mode === 't' ? '每分钟主力净流入（差分）' : '每日主力净流入'} · 东财行业分类 · ${hhmm}`, PAD_L, 50);
  // 数值范围
  const plotW = W - PAD_L - PAD_R;
  let yMin = 0, yMax = 0;
  for (const s of series) for (const p of s.points) { if (p.v > yMax) yMax = p.v; if (p.v < yMin) yMin = p.v; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const padY = (yMax - yMin) * 0.06 || 1;
  yMin -= padY; yMax += padY;
  const dn = Math.max(...series.map(s => s.points.length));
  const Y = v => TITLE_H + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const X = i => PAD_L + (i + 0.5) * (plotW / dn);
  // 0 轴（资金流出流入分界）
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = grid; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, Y(0)); ctx.lineTo(W - PAD_R, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // 横向网格 + Y 轴标签
  const fmtYi = v => Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + '百亿' : (v / 1e8).toFixed(1) + '亿';
  ctx.font = '12px cjk';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * i / 4;
    const y = Y(v);
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
    ctx.fillStyle = sub; ctx.textAlign = 'right';
    ctx.fillText(fmtYi(v), PAD_L - 8, y);
  }
  // 曲线
  ctx.lineWidth = 2;
  series.forEach((s, si) => {
    ctx.strokeStyle = ZJ_PALETTE[si % ZJ_PALETTE.length];
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = X(i), y = Y(p.v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  // X 轴标签（分时：首/中/末时间；日K：首/中/末日期）
  const idxs = [0, Math.floor((dn - 1) / 2), dn - 1];
  ctx.fillStyle = sub; ctx.textAlign = 'center'; ctx.font = '12px cjk';
  idxs.forEach(i => {
    const t = String(series[0].points[Math.min(i, series[0].points.length - 1)].t);
    const lb = mode === 't' ? t.slice(11, 16) : t.slice(5);
    ctx.fillText(lb, X(i), TITLE_H + plotH + 14);
  });
  // 图例（每行 2 个：色块+名称+当前累计/最新净流入）
  const legTop = TITLE_H + plotH + 26;
  const legW = (plotW - 12) / 2;
  series.forEach((s, si) => {
    const row = Math.floor(si / 2), col = si % 2;
    const x0 = PAD_L + col * (legW + 12);
    const y0 = legTop + row * 24;
    const lastV = mode === 't' ? (s.zljlr || 0) : s.points[s.points.length - 1].v; // 分时=当日累计，日K=最新日
    const yi = lastV / 1e8;
    const colC = lastV >= 0 ? upC : downC;
    ctx.fillStyle = ZJ_PALETTE[si % ZJ_PALETTE.length];
    ctx.fillRect(x0, y0 - 7, 14, 14);
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '13px cjk';
    const nm = s.name.length > 6 ? s.name.slice(0, 6) : s.name;
    ctx.fillText(nm, x0 + 20, y0);
    ctx.fillStyle = colC; ctx.textAlign = 'right'; ctx.font = 'bold 13px cjk';
    ctx.fillText(`${yi >= 0 ? '+' : ''}${yi.toFixed(1)}亿`, x0 + legW - 8, y0);
  });
  // 底部说明
  ctx.fillStyle = sub; ctx.textAlign = 'left'; ctx.font = '11px cjk';
  ctx.fillText(`曲线为东财行业分类主力净流入；图例数值：分时=当日累计，日线=最新一日`, PAD_L, H - 10);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// 生成行业资金流曲线（bt='hy'|'hy2'；mode='t'|'d'）
async function renderZjCurve(bt, mode) {
  const isL1 = bt === 'hy';
  const n = isL1 ? 10 : 5; // 一级：流入10+流出10；二级：流入5+流出5
  const boards = await fetchEmBoards();
  if (!boards || boards.length < 2) return { ok: false, text: '⚠️ 获取行业列表失败，请稍后重试' };
  const picks = [...boards.slice(0, n), ...boards.slice(-n).reverse()];
  const series = (await Promise.all(picks.map(async b => {
    const points = await fetchBoardFflow(b.code, mode);
    return points ? { name: b.name, zljlr: b.zljlr, points } : null;
  }))).filter(Boolean);
  if (series.length < 2) return { ok: false, text: '⚠️ 资金流数据获取失败，请稍后重试' };
  const img = renderZjCurveCanvas(series, mode, isL1 ? '一级' : '二级');
  if (!img) return { ok: false, text: '⚠️ 图表渲染失败' };
  const label = mode === 't' ? '资金分时波动' : '资金日级流入';
  return { ok: true, text: `📊 东财行业${label}（${isL1 ? '一级：流入10+流出10' : '二级：流入5+流出5'}）`, img };
}

// 拉取指定级别行业资金流，返回 { inflow:[{name,zljlr亿}...], outflow:[...] }，失败返回 null
// 主力净流入盘中 15 秒内可视为一致 → 内存缓存 15s
async function fetchSwZj(bt) {
  const cached = cacheGet('zj:' + bt);
  if (cached) return cached;
  try {
    const resp = await fetch(ZJ_RANK.replace('%s', bt), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await resp.json();
    const list = j?.data?.rank_list;
    if (!Array.isArray(list) || list.length === 0) return null;
    const rows = list.map(r => ({ name: r.name, yiyi: (Number(r.zljlr) || 0) / 10000 })).filter(r => r.yiyi !== 0);
    rows.sort((a, b) => b.yiyi - a.yiyi);
    const result = { inflow: rows.slice(0, 10), outflow: rows.slice(-10).reverse() };
    cacheSet('zj:' + bt, result, 15000);
    return result;
  } catch (_) { return null; }
}

function renderZjPng(data, levelLabel) {
  try { return renderZjPngCanvas(data, levelLabel); }
  catch (e) { console.error('[zj] canvas 渲染失败，fallback resvg:', e.message); return renderZjPngSvg(data, levelLabel); }
}

function renderZjPngCanvas(data, levelLabel) {
  const W = 720, PAD = 22;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869'; // 流入红 / 流出绿（A股红涨绿跌）
  const now = new Date();
  const mmdd = `${now.getMonth() + 1}/${now.getDate()}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const H = 430;
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2)); // 1.2x 分辨率，兼顾清晰与生成速度
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  // 标题
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 26px cjk';
  ctx.fillText(`${levelLabel}行业资金流`, PAD, 40);
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText(`主力净流入 · ${mmdd} ${hhmm}`, PAD, 62);
  // 列头
  const yHead = 96;
  const halfW = (W - PAD * 2 - 12) / 2;
  ctx.fillStyle = upC; ctx.fillRect(PAD, yHead - 14, 14, 14);
  ctx.font = 'bold 15px cjk'; ctx.textAlign = 'left';
  ctx.fillText('流入 TOP10', PAD + 20, yHead);
  ctx.fillStyle = downC; ctx.fillRect(PAD + 12 + halfW + 12, yHead - 14, 14, 14);
  ctx.fillText('流出 TOP10', PAD + 12 + halfW + 12 + 20, yHead);
  // 分隔线
  ctx.strokeStyle = lineC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, yHead + 16); ctx.lineTo(W - PAD, yHead + 16); ctx.stroke();
  // 两列各 10 行
  for (let i = 0; i < 10; i++) {
    const ry = yHead + 34 + i * 28;
    const draw = (list, xBase, col, sign) => {
      const r = list[i];
      if (!r) return;
      const name = r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name;
      ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), xBase - 14, ry);
      ctx.fillStyle = ink; ctx.font = '14px cjk';
      ctx.fillText(name, xBase, ry);
      ctx.fillStyle = col; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'right';
      ctx.fillText(`${sign}${r.yiyi.toFixed(1)}亿`, xBase + halfW - 12, ry);
    };
    draw(data.inflow, PAD + 14 + 16, upC, '+');
    draw(data.outflow, PAD + 14 + halfW + 12 + 16, downC, '');
  }
  // 生成时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  ctx.fillText('生成 ' + hhmm, W - PAD, H - 14);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

function renderZjPngSvg(data, levelLabel) {
  const W = 720, PAD = 22;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869'; // 流入红 / 流出绿（A股红涨绿跌）
  const now = new Date();
  const mmdd = `${now.getMonth() + 1}/${now.getDate()}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const H = 430;
  let s = '';
  // 标题
  s += `<text x="${PAD}" y="40" font-family="PingFang SC,cjk" font-size="26" font-weight="bold" fill="${ink}">${levelLabel}行业资金流</text>`;
  s += `<text x="${PAD}" y="62" font-family="PingFang SC,cjk" font-size="14" fill="${sub}">主力净流入 · ${mmdd} ${hhmm}</text>`;
  // 列头
  const yHead = 96;
  const halfW = (W - PAD * 2 - 12) / 2;
  s += `<rect x="${PAD}" y="${yHead - 14}" width="14" height="14" rx="3" fill="${upC}"/><text x="${PAD + 20}" y="${yHead}" font-family="PingFang SC,cjk" font-size="15" font-weight="bold" fill="${upC}">流入 TOP10</text>`;
  s += `<rect x="${PAD + 12 + halfW + 12}" y="${yHead - 14}" width="14" height="14" rx="3" fill="${downC}"/><text x="${PAD + 12 + halfW + 12 + 20}" y="${yHead}" font-family="PingFang SC,cjk" font-size="15" font-weight="bold" fill="${downC}">流出 TOP10</text>`;
  // 两列各 10 行
  for (let i = 0; i < 10; i++) {
    const ry = yHead + 34 + i * 28;
    const draw = (list, xBase, col, sign) => {
      const r = list[i];
      if (!r) return;
      const name = r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name;
      s += `<text x="${xBase}" y="${ry}" font-family="PingFang SC,cjk" font-size="14" fill="${ink}">${esc(name)}</text>`;
      const amt = `${sign}${r.yiyi.toFixed(1)}亿`;
      s += `<text x="${xBase + halfW - 12}" y="${ry}" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${col}">${amt}</text>`;
      // 序号
      s += `<text x="${xBase - 14}" y="${ry}" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">${i + 1}</text>`;
    };
    draw(data.inflow, PAD + 14 + 16, upC, '+');
    draw(data.outflow, PAD + 14 + halfW + 12 + 16, downC, '');
  }
  // 分隔线
  s += `<line x1="${PAD}" y1="${yHead + 16}" x2="${W - PAD}" y2="${yHead + 16}" stroke="${lineC}" stroke-width="1"/>`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="${bg}"/>${s}<text x="${W - PAD}" y="${H - 14}" text-anchor="end" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">生成 ${hhmm}</text></svg>`;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { fontFiles: ['/app/fonts/cjk_sub.ttf'], loadSystemFonts: false, defaultFontFamily: 'PingFang SC' } });
    const png = r.render().asPng();
    return 'base64://' + png.toString('base64');
  } catch (e) {
    console.error('[zj] 渲染失败:', e.message);
    return '';
  }
}

async function cmdZj(args) {
  const parts = (args || []).map(a => String(a).trim()).filter(Boolean);
  const p = String(parts[0] || '').toLowerCase();
  const bt = ZJ_LEVEL_BT[p];
  if (!bt) return { ok: false, text: '⚠️ 请指定级别：/zj 1（一级） /zj 2（二级）\n第二参数可选：t/分时=分时波动曲线　d/日=日级流入曲线\n例：/zj 2（当前排行）　/zj 1 t（一级分时）　/zj 2 d（二级日线）' };
  const m = String(parts[1] || '').toLowerCase();
  if (m === 't' || m === '分时' || m === 'time') return renderZjCurve(bt, 't');
  if (m === 'd' || m === '日' || m === '日线' || m === 'day') return renderZjCurve(bt, 'd');
  if (m) return { ok: false, text: '⚠️ 第二参数：t/分时=分时曲线　d/日=日线曲线（留空=当前排行）\n例：/zj 2　/zj 1 t　/zj 2 d' };
  if (bt === 'hy3') return { ok: false, text: '⚠️ 申万三级资金流暂无公开免费数据源（腾讯仅提供一级/二级）。\n当前可用：/zj 1 申万一级、/zj 2 申万二级；如需三级可试试问财/付费终端。' };
  const data = await fetchSwZj(bt);
  if (!data) return { ok: false, text: `⚠️ ${ZJ_LEVEL_LABEL[bt]}行业资金流获取失败，请稍后重试` };
  const img = renderZjPng(data, ZJ_LEVEL_LABEL[bt]);
  if (img) return { ok: true, text: `🏦 ${ZJ_LEVEL_LABEL[bt]}行业资金流`, img };
  // 渲染失败 → 文本 fallback
  const fmt = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}亿`;
  return { ok: false, text: `🏦 ${ZJ_LEVEL_LABEL[bt]}行业资金流（主力净流入）\n🔴 流入 TOP10：${data.inflow.map(r => `${r.name} ${fmt(r.yiyi)}`).join('、')}\n🟢 流出 TOP10：${data.outflow.map(r => `${r.name} ${fmt(r.yiyi)}`).join('、')}` };
}

module.exports = { cmdZj };
