// ============================================================
// /zj 行业资金流：排行 / 分时曲线 / 日级流入
// ============================================================
const { cacheGet, cacheSet, fmtAmountWan, fmtAmountYuan, esc } = require('../utils');
const { emFetchJson } = require('../market');

// 数据源：腾讯板块行情 getRank（hy=申万一级 31 个、hy2=申万二级 124 个），字段 zljlr=主力净流入（万）
// 注意：腾讯 hy3 无数据（total=0 实测），申万三级资金流免费源暂缺，命令内做明确提示。
const ZJ_RANK = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=%s&sort_type=price&direct=down&offset=0&count=200';
const ZJ_LEVEL_BT = { '1': 'hy', '一级': 'hy', 'sw1': 'hy', '一': 'hy', '2': 'hy2', '二级': 'hy2', 'sw2': 'hy2', '二': 'hy2', '3': 'hy3', '三级': 'hy3', 'sw3': 'hy3', '三': 'hy3' };
const ZJ_LEVEL_LABEL = { hy: '申万一级', hy2: '申万二级', hy3: '申万三级' };

// ---------- 东财行业资金流日线（多周期汇总） ----------
// 只使用日级历史接口，避免分时接口触发风控；一次拉 120 个交易日，本地汇总 3/5/10/15/20/30 日。
const EM_BOARD_LIST = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f62';
const EM_BOARD_FF_DAY = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=120&klt=101&secid=90.%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
const ZJ_FLOW_PERIODS = [3, 5, 10, 15, 20, 30, 60, 120];
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchBoardFflowOnce(code) {
  const ckey = 'bff:' + code + ':day';
  const cached = cacheGet(ckey);
  if (cached) return cached;
  try {
    const j = await emFetchJson(EM_BOARD_FF_DAY.replace('%s', code), 10000);
    if (!j) return null;
    const kl = j.data?.klines;
    if (!Array.isArray(kl) || kl.length < 2) return null;
    const out = kl.map(k => {
      const p = String(k).split(',');
      return { t: p[0], v: Number(p[1]) || 0 };
    });
    cacheSet(ckey, out, 600000);
    return out;
  } catch (_) { return null; }
}

async function fetchBoardFflow(code) {
  const first = await fetchBoardFflowOnce(code);
  if (first) return first;
  // 单个失败项间隔 2 秒后重试一次，避免同时重试再次触发上游风控。
  await sleep(2000);
  return fetchBoardFflowOnce(code);
}

function cumulativeFlow(points, days) {
  const rows = points.slice(-days);
  let total = 0;
  return rows.map(p => ({ t: p.t, v: total += p.v }));
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

function renderMultiPeriodZjCanvas(data) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD = 28, plotLeft = 84, plotRight = 20;
  const topH = 360, rankTop = 410, rowH = 26, rankRows = 10;
  const H = rankTop + 70 + rankRows * rowH + 28;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  const bg = '#fff', ink = '#2b2f36', sub = '#8a919e', grid = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 24px cjk';
  ctx.fillText(`${data.levelLabel}行业资金流（近${data.days}日）`, PAD, 28);
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText('当前流入/流出 TOP10 的近 N 日累计资金曲线（各侧仅展示 TOP3）', PAD, 52);

  const inflow = data.series.filter(s => s.side === 'inflow').sort((a, b) => b.currentValue - a.currentValue).slice(0, 3);
  const outflow = data.series.filter(s => s.side === 'outflow').sort((a, b) => a.currentValue - b.currentValue).slice(0, 3);
  const trendSeries = [...inflow, ...outflow];
  const plotW = W - plotLeft - plotRight, plotTop = 72, plotBottom = topH;
  let min = 0, max = 0;
  for (const s of trendSeries) for (const p of s.points) { min = Math.min(min, p.v); max = Math.max(max, p.v); }
  if (min === max) { min -= 1; max += 1; }
  const padY = (max - min) * 0.08; min -= padY; max += padY;
  const count = Math.max(...trendSeries.map(s => s.points.length), 1);
  const xAt = i => plotLeft + (i / Math.max(count - 1, 1)) * plotW;
  const yAt = v => plotBottom - ((v - min) / (max - min)) * (plotBottom - plotTop);
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, y = yAt(v);
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(plotLeft, y); ctx.lineTo(W - plotRight, y); ctx.stroke();
    ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '12px cjk';
    ctx.fillText(`${(v / 1e8).toFixed(1)}亿`, plotLeft - 8, y);
  }
  if (min < 0 && max > 0) {
    ctx.strokeStyle = '#cfd5dc'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(plotLeft, yAt(0)); ctx.lineTo(W - plotRight, yAt(0)); ctx.stroke(); ctx.setLineDash([]);
  }
  const colors = ['#f5222d', '#ff7875', '#cf1322', '#0aa869', '#36cfc9', '#087f5b'];
  trendSeries.forEach((s, si) => {
    ctx.strokeStyle = colors[si]; ctx.lineWidth = 2; ctx.beginPath();
    s.points.forEach((p, i) => i ? ctx.lineTo(xAt(i), yAt(p.v)) : ctx.moveTo(xAt(i), yAt(p.v)));
    ctx.stroke();
  });
  ctx.fillStyle = sub; ctx.font = '12px cjk'; ctx.textAlign = 'center';
  const ticks = [0, Math.floor((count - 1) / 2), count - 1];
  ticks.forEach(i => { const p = trendSeries[0]?.points[Math.min(i, (trendSeries[0]?.points.length || 1) - 1)]; if (p) ctx.fillText(String(p.t).slice(5), xAt(i), plotBottom + 16); });
  trendSeries.forEach((s, i) => {
    const x = PAD + (i % 3) * 320, y = plotBottom + 42 + Math.floor(i / 3) * 22;
    ctx.fillStyle = colors[i]; ctx.fillRect(x, y - 6, 12, 12);
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '12px cjk'; ctx.fillText(s.name, x + 18, y);
    ctx.fillStyle = s.value >= 0 ? upC : downC; ctx.textAlign = 'right'; ctx.font = 'bold 12px cjk'; ctx.fillText(`${s.value >= 0 ? '+' : ''}${(s.value / 1e8).toFixed(1)}亿`, x + 290, y);
  });

  const inflowRank = data.rows.filter(r => r.side === 'inflow').sort((a, b) => b.currentValue - a.currentValue).slice(0, rankRows);
  const outflowRank = data.rows.filter(r => r.side === 'outflow').sort((a, b) => a.currentValue - b.currentValue).slice(0, rankRows);
  const panelY = rankTop, panelH = 66 + rankRows * rowH;
  ctx.fillStyle = '#f7f8fa'; ctx.beginPath(); ctx.roundRect(PAD, panelY, W - PAD * 2, panelH, 14); ctx.fill();
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 16px cjk'; ctx.fillText(`${data.levelLabel}近${data.days}日主力净流入排行`, PAD + 18, panelY + 26);
  const half = (W - PAD * 2 - 36 - 12) / 2, divider = PAD + 18 + half + 6, maxIn = Math.max(...inflowRank.map(r => Math.abs(r.value)), 1), maxOut = Math.max(...outflowRank.map(r => Math.abs(r.value)), 1);
  ctx.strokeStyle = '#e8eaed'; ctx.beginPath(); ctx.moveTo(divider, panelY + 38); ctx.lineTo(divider, panelY + panelH - 10); ctx.stroke();
  ctx.fillStyle = upC; ctx.textAlign = 'left'; ctx.font = 'bold 14px cjk'; ctx.fillText(`流入 TOP${inflowRank.length}`, PAD + 18, panelY + 48);
  inflowRank.forEach((r, i) => {
    const y = panelY + 68 + i * rowH, bw = Math.max(2, Math.abs(r.value) / maxIn * (half - 16));
    ctx.fillStyle = 'rgba(245,34,45,0.18)'; ctx.beginPath(); ctx.roundRect(PAD + 18 + half - 6 - bw, y - 8, bw, 16, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '12px cjk'; ctx.fillText(name, PAD + 20, y);
    ctx.fillStyle = upC; ctx.textAlign = 'right'; ctx.font = 'bold 12px cjk'; ctx.fillText(`${r.value >= 0 ? '+' : ''}${(r.value / 1e8).toFixed(1)}亿`, PAD + 18 + half - 8, y);
  });
  const labelW = 164;
  const valueW = 82;
  ctx.fillStyle = downC; ctx.textAlign = 'left'; ctx.font = 'bold 14px cjk'; ctx.fillText(`流出 TOP${outflowRank.length}`, rx, panelY + 48);
  outflowRank.forEach((r, i) => {
    const y = panelY + 68 + i * rowH, bw = Math.max(2, Math.abs(r.value) / maxOut * (half - 16));
    ctx.fillStyle = 'rgba(10,168,105,0.18)'; ctx.beginPath(); ctx.roundRect(rx, y - 8, bw, 16, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '12px cjk'; ctx.fillText(name, rx + 2, y);
    ctx.fillStyle = downC; ctx.textAlign = 'right'; ctx.font = 'bold 12px cjk'; ctx.fillText(`${(r.value / 1e8).toFixed(1)}亿`, rx + half - 8, y);
  });
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

function renderMultiPeriodZjRankingCanvas(data) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD = 28, rowH = 32, maxRows = 10;
  const panelY = 24, panelTop = panelY + 54;
  const panelHeight = 104 + maxRows * rowH;
  const H = panelTop + panelHeight + 64;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  const bg = '#fff', ink = '#2b2f36', sub = '#8a919e';
  const upC = '#f5222d', downC = '#0aa869';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  const left = data.rows.slice(0, maxRows);
  const right = data.rows.slice(maxRows, maxRows * 2);
  const all = [...left, ...right];
  const leftValues = left.map(r => Number(r.value)).filter(Number.isFinite).map(Math.abs);
  const rightValues = right.map(r => Number(r.value)).filter(Number.isFinite).map(Math.abs);
  const maxLeft = Math.max(...leftValues, 1);
  const maxRight = Math.max(...rightValues, 1);

  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 24px cjk';
  ctx.fillText(`${data.levelLabel}行业资金流（近${data.days}日）`, PAD, 28);
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText('按 /zj 2 当前排序的前 10 / 后 10 分组；数值为近 N 日累计净额，不做正负过滤', PAD, 52);

  ctx.fillStyle = '#f7f8fa'; ctx.beginPath(); ctx.roundRect(PAD, panelTop, W - PAD * 2, panelHeight, 14); ctx.fill();
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 16px cjk';
  ctx.fillText(`近${data.days}日资金量排行（沿用 /zj 2 当前前10/后10顺序）`, PAD + 18, panelTop + 26);
  const half = (W - PAD * 2 - 36 - 12) / 2;
  const divider = PAD + 18 + half + 6;
  const rx = divider + 6;
  const labelW = 164;
  const valueW = 86;
  ctx.strokeStyle = '#e8eaed'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(divider, panelTop + 38); ctx.lineTo(divider, panelTop + panelHeight - 18); ctx.stroke();

  ctx.fillStyle = '#409eff'; ctx.textAlign = 'left'; ctx.font = 'bold 14px cjk';
  ctx.fillText('当日排序前 10', PAD + 18, panelTop + 48);
  left.forEach((r, i) => {
    const y = panelTop + 78 + i * rowH;
    const value = Number(r.value);
    const known = Number.isFinite(value);
    const name = String(r.name || '').length > 8 ? String(r.name).slice(0, 8) + '…' : String(r.name);
    const leftBarStart = PAD + 18 + labelW;
    const leftBarEnd = PAD + 18 + half - valueW;
    const bw = known ? Math.max(2, Math.abs(value) / maxLeft * Math.max(leftBarEnd - leftBarStart, 1)) : 0;
    if (bw) {
      ctx.fillStyle = 'rgba(64,158,255,0.18)';
      ctx.beginPath(); ctx.roundRect(leftBarStart, y - 9, bw, 18, 3); ctx.fill();
    }
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '12px cjk'; ctx.fillText(name, PAD + 20, y);
    ctx.fillStyle = '#409eff'; ctx.textAlign = 'right'; ctx.font = 'bold 12px cjk';
    ctx.fillText(known ? `${value >= 0 ? '+' : ''}${(value / 1e8).toFixed(2)}亿` : '数据暂缺', PAD + 18 + half - 18, y);
  });

  ctx.fillStyle = '#409eff'; ctx.textAlign = 'left'; ctx.font = 'bold 14px cjk';
  ctx.fillText('当日排序后 10', rx, panelTop + 48);
  right.forEach((r, i) => {
    const y = panelTop + 78 + i * rowH;
    const value = Number(r.value);
    const known = Number.isFinite(value);
    const name = String(r.name || '').length > 8 ? String(r.name).slice(0, 8) + '…' : String(r.name);
    const rightBarStart = rx + labelW;
    const rightBarEnd = rx + half - valueW;
    const bw = known ? Math.max(2, Math.abs(value) / maxRight * Math.max(rightBarEnd - rightBarStart, 1)) : 0;
    if (bw) { ctx.fillStyle = 'rgba(64,158,255,0.18)'; ctx.beginPath(); ctx.roundRect(rightBarStart, y - 9, bw, 18, 3); ctx.fill(); }
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '12px cjk'; ctx.fillText(name, rx + 2, y);
    ctx.fillStyle = '#409eff'; ctx.textAlign = 'right'; ctx.font = 'bold 12px cjk'; ctx.fillText(known ? `${value >= 0 ? '+' : ''}${(value / 1e8).toFixed(2)}亿` : '数据暂缺', rx + half - 18, y);
  });
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  ctx.fillText(`数据：东财行业资金流日线 · 候选${all.length}个`, W - PAD - 18, H - 18);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

async function fetchMultiPeriodZj(bt, days) {
  const isL1 = bt === 'hy';
  // 带天数参数时固定取当前净流入排行前10 + 后10，降低批量请求触发风控的概率。
  // 注意：这是「前10/后10」候选，不是全行业全量；日线接口本身返回候选行业近120个交易日。
  const n = 10;
  const boards = await fetchEmBoards();
  if (!boards || boards.length < 2) return null;
  const picks = [...boards.slice(0, n), ...boards.slice(-n).reverse()];
  const series = [];
  // 20 个历史接口拆成两批，每批最多 10 个，避免一次性并发过多触发风控。
  for (let start = 0; start < picks.length; start += 10) {
    const batch = picks.slice(start, start + 10);
    const results = await Promise.all(batch.map(async (b, batchIndex) => {
      const points = await fetchBoardFflow(b.code);
      const index = start + batchIndex;
      if (!points || points.length < days) {
        return { name: b.name, zljlr: b.zljlr, currentValue: b.zljlr, side: index < n ? 'inflow' : 'outflow', points: [], value: null };
      }
      const cumulative = cumulativeFlow(points, days);
      return {
        name: b.name,
        zljlr: b.zljlr,
        currentValue: b.zljlr,
        side: index < n ? 'inflow' : 'outflow',
        points: cumulative,
        value: cumulative[cumulative.length - 1].v,
      };
    }));
    series.push(...results.filter(Boolean));
  }
  return { levelLabel: isL1 ? '申万一级' : '申万二级', days, series, rows: series.map(s => ({ name: s.name, value: s.value, currentValue: s.currentValue, side: s.side })) };
}

function formatFlowText(data) {
  const left = data.rows.slice(0, 10);
  const right = data.rows.slice(10, 20);
  const fmt = r => Number.isFinite(Number(r.value)) ? `${Number(r.value) >= 0 ? '+' : ''}${(Number(r.value) / 1e8).toFixed(2)}亿` : '数据暂缺';
  return [
    `🏦 ${data.levelLabel}行业近${data.days}日资金量（沿用 /zj 2 当前前10/后10顺序，不过滤）`,
    `📊 当日排序前 10：${left.map(r => `${r.name} ${fmt(r)}`).join('、') || '暂无'}`,
    `📊 当日排序后 10：${right.map(r => `${r.name} ${fmt(r)}`).join('、') || '暂无'}`,
  ].join('\n');
}

async function renderMultiPeriodZj(bt, days) {
  const data = await fetchMultiPeriodZj(bt, days);
  if (!data || data.rows.length < 2) return { ok: false, text: '⚠️ 资金流日线数据获取失败，请稍后重试' };
  const img = renderMultiPeriodZjRankingCanvas(data);
  return { ok: true, text: formatFlowText(data), img };
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

// 排行图：沿用 /ss 内嵌「申万二级行业资金流」块的视觉——圆角面板 + 左右双列 + 占比横条
function renderZjPngCanvas(data, levelLabel) {
  const W = 720, PAD = 22;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869'; // 流入红 / 流出绿（A股红涨绿跌）
  const now = new Date();
  const mmdd = `${now.getMonth() + 1}/${now.getDate()}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const rows = Math.max(data.inflow.length, data.outflow.length);
  const ROW_H = 28;
  const x0 = PAD, cw = W - PAD * 2;
  const swH = 66 + rows * ROW_H;   // 面板高（标题+列头+rows 行）
  const H = 18 + swH + 30;         // 顶部留白 + 面板 + 底部生成时间
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2)); // 1.2x 分辨率
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  const y = 18;                    // 面板顶部
  const rrect = (x, yy, w, h, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, yy, w, h, r); ctx.fill(); };
  rrect(x0, y, cw, swH, 14, panel);
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 16px cjk';
  ctx.fillText(`${levelLabel}行业资金流 · 主力净流入`, x0 + 18, y + 26);
  const halfW = (cw - 36 - 12) / 2;
  const maxIn = Math.max(...data.inflow.map(r => r.yiyi), 1);
  const maxOut = Math.max(...data.outflow.map(r => Math.abs(r.yiyi)), 1);
  // 中间垂直分割线
  const divX = x0 + 18 + halfW + 6;
  ctx.strokeStyle = lineC; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(divX, y + 38); ctx.lineTo(divX, y + swH - 10); ctx.stroke();
  // 左：流入（横条右对齐、向左延伸）
  ctx.fillStyle = upC; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'left';
  ctx.fillText(`流入 TOP${data.inflow.length}`, x0 + 18, y + 48);
  data.inflow.forEach((r, i) => {
    const ry = y + 68 + i * ROW_H;
    const bw = Math.max(2, Math.round((r.yiyi / maxIn) * (halfW - 16)));
    ctx.fillStyle = 'rgba(245,34,45,0.18)';
    ctx.beginPath(); ctx.roundRect(x0 + 18 + halfW - 6 - bw, ry - 9, bw, 18, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.font = '13px cjk'; ctx.textAlign = 'left';
    ctx.fillText(r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name, x0 + 20, ry);
    ctx.fillStyle = upC; ctx.font = 'bold 13px cjk'; ctx.textAlign = 'right';
    ctx.fillText(`+${r.yiyi.toFixed(1)}亿`, x0 + 18 + halfW - 8, ry);
  });
  // 右：流出（横条左对齐、向右延伸）
  const rx2 = divX + 6;
  ctx.fillStyle = downC; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'left';
  ctx.fillText(`流出 TOP${data.outflow.length}`, rx2, y + 48);
  data.outflow.forEach((r, i) => {
    const ry = y + 68 + i * ROW_H;
    const bw = Math.max(2, Math.round((Math.abs(r.yiyi) / maxOut) * (halfW - 16)));
    ctx.fillStyle = 'rgba(10,168,105,0.18)';
    ctx.beginPath(); ctx.roundRect(rx2, ry - 9, bw, 18, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.font = '13px cjk'; ctx.textAlign = 'left';
    ctx.fillText(r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name, rx2 + 2, ry);
    ctx.fillStyle = downC; ctx.font = 'bold 13px cjk'; ctx.textAlign = 'right';
    ctx.fillText(`${r.yiyi.toFixed(1)}亿`, rx2 + halfW - 8, ry);
  });
  // 生成时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  ctx.fillText(`生成 ${mmdd} ${hhmm}`, W - PAD, H - 12);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

function renderZjPngSvg(data, levelLabel) {
  const W = 720, PAD = 22;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869'; // 流入红 / 流出绿（A股红涨绿跌）
  const now = new Date();
  const mmdd = `${now.getMonth() + 1}/${now.getDate()}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const rows = Math.max(data.inflow.length, data.outflow.length);
  const ROW_H = 28;
  const x0 = PAD, cw = W - PAD * 2;
  const swH = 66 + rows * ROW_H;   // 面板高
  const H = 18 + swH + 30;         // 顶部留白 + 面板 + 底部生成时间
  const y = 18;                    // 面板顶部
  const halfW = (cw - 36 - 12) / 2;
  const maxIn = Math.max(...data.inflow.map(r => r.yiyi), 1);
  const maxOut = Math.max(...data.outflow.map(r => Math.abs(r.yiyi)), 1);
  const divX = x0 + 18 + halfW + 6;
  const rx2 = divX + 6;
  const nm = n => esc(n.length > 8 ? n.slice(0, 8) + '…' : n);
  let s = '';
  s += `<rect x="${x0}" y="${y}" width="${cw}" height="${swH}" rx="14" fill="${panel}"/>`;
  s += `<text x="${x0 + 18}" y="${y + 26}" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="16" font-weight="bold" fill="${ink}">${esc(levelLabel)}行业资金流 · 主力净流入</text>`;
  s += `<line x1="${divX}" y1="${y + 38}" x2="${divX}" y2="${y + swH - 10}" stroke="${lineC}" stroke-width="1"/>`;
  // 左：流入（横条右对齐、向左延伸）
  s += `<text x="${x0 + 18}" y="${y + 48}" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${upC}">流入 TOP${data.inflow.length}</text>`;
  data.inflow.forEach((r, i) => {
    const ry = y + 68 + i * ROW_H;
    const bw = Math.max(2, Math.round((r.yiyi / maxIn) * (halfW - 16)));
    s += `<rect x="${x0 + 18 + halfW - 6 - bw}" y="${ry - 9}" width="${bw}" height="18" rx="3" fill="rgba(245,34,45,0.18)"/>`;
    s += `<text x="${x0 + 20}" y="${ry}" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="13" fill="${ink}">${nm(r.name)}</text>`;
    s += `<text x="${x0 + 18 + halfW - 8}" y="${ry}" text-anchor="end" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="13" font-weight="bold" fill="${upC}">+${r.yiyi.toFixed(1)}亿</text>`;
  });
  // 右：流出（横条左对齐、向右延伸）
  s += `<text x="${rx2}" y="${y + 48}" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${downC}">流出 TOP${data.outflow.length}</text>`;
  data.outflow.forEach((r, i) => {
    const ry = y + 68 + i * ROW_H;
    const bw = Math.max(2, Math.round((Math.abs(r.yiyi) / maxOut) * (halfW - 16)));
    s += `<rect x="${rx2}" y="${ry - 9}" width="${bw}" height="18" rx="3" fill="rgba(10,168,105,0.18)"/>`;
    s += `<text x="${rx2 + 2}" y="${ry}" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="13" fill="${ink}">${nm(r.name)}</text>`;
    s += `<text x="${rx2 + halfW - 8}" y="${ry}" text-anchor="end" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="13" font-weight="bold" fill="${downC}">${r.yiyi.toFixed(1)}亿</text>`;
  });
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="${bg}"/>${s}<text x="${W - PAD}" y="${H - 12}" text-anchor="end" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">生成 ${mmdd} ${hhmm}</text></svg>`;
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
  if (!bt) return { ok: false, text: '⚠️ 请指定级别：/zj 1（一级） /zj 2（二级）\n第二参数可选：3/5/10/15/20/30/60/120=近N日主力净流入汇总\n例：/zj 2（当前排行）　/zj 2 5（近5日）' };
  const m = String(parts[1] || '').toLowerCase();
  if (m === 't' || m === '分时' || m === 'time') return { ok: false, text: '⚠️ 分时资金流接口容易触发风控，已停用。请使用 /zj ' + (bt === 'hy' ? '1' : '2') + ' 3|5|10|15|20|30 查询日级汇总' };
  if (m === 'd' || m === '日' || m === '日线' || m === 'day') return renderMultiPeriodZj(bt, 5);
  if (/^\d+$/.test(m)) {
    const days = Number(m);
    if (ZJ_FLOW_PERIODS.includes(days)) return renderMultiPeriodZj(bt, days);
    return { ok: false, text: '⚠️ 周期仅支持：3、5、10、15、20、30、60、120（日）' };
  }
  if (m) return { ok: false, text: '⚠️ 第二参数：3/5/10/15/20/30/60/120=近N日汇总；d=近5日（兼容）；t=已停用' };
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
