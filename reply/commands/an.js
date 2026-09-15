// ============================================================
// /an 多周期股票分析：日线/周线/月线 + MA/BOLL/MACD + 量价 + 关键价位
// ============================================================
const { normStockName, isFundCode } = require('../utils');
const { resolveStockCode, normalizeCode, fetchStockKline, fetchStockQuote } = require('../market');

const MA_PERIODS = [5, 10, 20, 60];
const PERIOD_LABEL = { day: '日线', week: '周线', month: '月线' };
const PERIOD_WEIGHT = { day: 0.3, week: 0.4, month: 0.3 };

const fpBy = (v, prec = 2) => isFinite(v) && v !== null ? Number(v).toFixed(prec) : '-';
const pct = v => (isFinite(v) ? (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%' : '-');

function smaValues(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function bollValues(closes, period = 20, k = 2) {
  const mid = smaValues(closes, period);
  const up = new Array(closes.length).fill(null);
  const low = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i];
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - m) ** 2;
    const sd = Math.sqrt(s / period);
    up[i] = m + k * sd; low[i] = Math.max(0, m - k * sd);
  }
  return { mid, up, low };
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macdValues(closes) {
  if (!closes.length) return { dif: [], dea: [], hist: [] };
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = new Array(closes.length).fill(null);
  const k = 2 / 10;
  let prev = 0; // DEA 起点从 0 开始，与同花顺口径一致
  for (let i = 0; i < dif.length; i++) {
    prev = dif[i] * k + prev * (1 - k);
    dea[i] = prev;
  }
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}

function lastVal(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
function prevVal(arr) { return arr && arr.length > 1 ? arr[arr.length - 2] : null; }

function findLastCross(macd) {
  const d = macd.dif, e = macd.dea;
  for (let i = d.length - 1; i >= 1; i--) {
    if (d[i - 1] < e[i - 1] && d[i] >= e[i]) return { type: 'gold', index: i };
    if (d[i - 1] >= e[i - 1] && d[i] < e[i]) return { type: 'dead', index: i };
  }
  return null;
}

function swingPoints(values, lookback = 2, span = 80) {
  const start = Math.max(lookback, values.length - span);
  const tops = [], bottoms = [];
  for (let i = start; i < values.length - lookback; i++) {
    let isTop = true, isBottom = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (values[i] < values[j]) isTop = false;
      if (values[i] > values[j]) isBottom = false;
    }
    if (isTop) tops.push(i);
    if (isBottom) bottoms.push(i);
  }
  return { tops, bottoms };
}

function detectDivergence(closes, macd) {
  const d = macd.dif;
  if (closes.length < 50 || d.length < 50) return null;
  const { tops, bottoms } = swingPoints(closes, 2, 70);
  const minMove = 0.012;
  if (tops.length >= 2) {
    const a = tops[tops.length - 2], b = tops[tops.length - 1];
    const priceMove = closes[a] > 0 ? (closes[b] - closes[a]) / closes[a] : 0;
    const macdMove = Math.abs(d[a]) > 0.02 ? (d[b] - d[a]) / Math.abs(d[a]) : d[b] - d[a]; // codeflicker-fix: 归一分母阈值提到 0.02，避免零轴附近被放大为伪强背离
    if (priceMove >= minMove && macdMove < -0.08) return { type: 'top', index: b, strength: priceMove >= 0.03 ? '强' : '普通' };
  }
  if (bottoms.length >= 2) {
    const a = bottoms[bottoms.length - 2], b = bottoms[bottoms.length - 1];
    const priceMove = closes[a] > 0 ? (closes[b] - closes[a]) / closes[a] : 0;
    const macdMove = Math.abs(d[a]) > 0.02 ? (d[b] - d[a]) / Math.abs(d[a]) : d[b] - d[a]; // codeflicker-fix: 归一分母阈值提到 0.02，避免零轴附近被放大为伪强背离
    if (priceMove <= -minMove && macdMove > 0.08) return { type: 'bottom', index: b, strength: priceMove <= -0.03 ? '强' : '普通' };
  }
  return null;
}

// 箱体计算窗口（根数，均不含当前K）
// 选取依据：箱体要框住"当下正在博弈的区间"，窗口过大必然跨越多轮涨跌，箱体退化成区间极值。
//   日线：大箱体 40 根（≈2个月，覆盖一轮完整波段）；实测 603986 日线 60 根箱体宽 97%、40 根仅 29%，60 根已跨过 6~7 月那波翻倍行情。
//   周线：大箱体 30 根（≈7个月）；60 周箱体宽 235%（113~846），完全没有"箱体"含义。
//   小箱体/中枢固定 20 根（≈1个月 / 5个月），对应一轮短期震荡。
const BOX_WIN = { day: { major: 40, minor: 20, core: 20 }, week: { major: 30, minor: 20, core: 20 }, month: { major: 0, minor: 0, core: 0 } };

function calcRecentLevels(period, ks, close) {
  const bw = BOX_WIN[period] || BOX_WIN.day;
  const recent20 = ks.slice(-21, -1);
  const recent60 = ks.slice(-61, -1);
  const seg = n => (n > 0 ? ks.slice(-(n + 1), -1) : []);
  const maxHigh = arr => arr.length ? Math.max(...arr.map(k => Number(k.high) || Number(k.close) || 0)) : null;
  const minLow = arr => arr.length ? Math.min(...arr.map(k => Number(k.low) || Number(k.close) || Infinity)) : null;
  const quantile = (arr, q) => {
    const vals = arr.map(v => Number(v)).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b);
    if (!vals.length) return null;
    const idx = Math.min(vals.length - 1, Math.max(0, Math.floor((vals.length - 1) * q)));
    return vals[idx];
  };
  const calcBox = (arr, lowQ, highQ) => {
    const closes = arr.map(k => Number(k.close) || 0).filter(v => v > 0);
    const rawHigh = maxHigh(arr) || close;
    const rawLow = minLow(arr) || close;
    const bodiesHigh = arr.map(k => Math.max(Number(k.open) || Number(k.close) || 0, Number(k.close) || 0)).filter(v => v > 0);
    const bodiesLow = arr.map(k => Math.min(Number(k.open) || Number(k.close) || 0, Number(k.close) || 0)).filter(v => v > 0);
    const bodyHigh = quantile(bodiesHigh, highQ) || quantile(closes, highQ) || rawHigh;
    const bodyLow = quantile(bodiesLow, lowQ) || quantile(closes, lowQ) || rawLow;
    const bodyMid = (bodyHigh + bodyLow) / 2;
    const ranges = arr.map(k => Math.max(0, (Number(k.high) || Number(k.close) || 0) - (Number(k.low) || Number(k.close) || 0)));
    const typicalRange = quantile(ranges, 0.55) || Math.max(bodyMid * 0.02, bodyHigh - bodyLow);
    const pad = Math.min(Math.max(typicalRange * 0.45, bodyMid * 0.006), Math.max(bodyHigh - bodyLow, bodyMid * 0.03));
    let high = Math.min(rawHigh, bodyHigh + pad);
    let low = Math.max(rawLow, bodyLow - pad);
    if (!(high > low)) { high = rawHigh; low = rawLow; }
    const widthPct = low > 0 ? (high - low) / low * 100 : 0;
    const pos = high > low ? (close - low) / (high - low) : 0.5;
    let state = '箱体震荡';
    if (close > high * 1.005) state = '突破箱体上沿';
    else if (close < low * 0.995) state = '跌破箱体下沿';
    else if (pos >= 0.75) state = '靠近箱体上沿';
    else if (pos <= 0.25) state = '靠近箱体下沿';
    return { high, low, rawHigh, rawLow, widthPct, pos, state };
  };

  const prevHigh20 = maxHigh(recent20);
  const prevLow20 = minLow(recent20);
  const prevHigh60 = maxHigh(recent60);
  const prevLow60 = minLow(recent60);
  const majorSeg = seg(bw.major);
  const minorSeg = seg(bw.minor);
  const coreSeg = seg(bw.core);
  // 大箱体一律走分位口径：不再用窗口极值（极值会被单根长影线/远月高低点污染，画出 113~846 这种没有意义的"箱体"）
  const major = calcBox(majorSeg.length >= 8 ? majorSeg : recent60, 0.15, 0.85);
  const minor = calcBox(minorSeg.length ? minorSeg : recent20, 0.20, 0.80);
  const closes20 = (coreSeg.length ? coreSeg : recent20).map(k => Number(k.close) || 0);
  const cLow = quantile(closes20, 0.38);
  const cHigh = quantile(closes20, 0.62);
  const minorMid = (minor.high + minor.low) / 2;
  const minorRange = Math.max(minor.high - minor.low, minor.high * 0.01);
  const centerLow = Math.max(minor.low, cLow || (minorMid - minorRange * 0.14));
  const centerHigh = Math.min(minor.high, cHigh || (minorMid + minorRange * 0.14));
  const centerMid = (centerLow + centerHigh) / 2;
  const centerWidthPct = centerLow > 0 ? (centerHigh - centerLow) / centerLow * 100 : 0;
  const centerState = close > centerHigh ? '中枢上方' : close < centerLow ? '中枢下方' : '中枢内部';

  return {
    majorWin: bw.major, minorWin: bw.minor, coreWin: bw.core,
    prevHigh20, prevLow20, prevHigh60, prevLow60,
    boxHigh: minor.high, boxLow: minor.low, boxWidthPct: minor.widthPct, boxPos: minor.pos, boxState: minor.state,
    majorHigh: major.high, majorLow: major.low, majorRawHigh: major.rawHigh, majorRawLow: major.rawLow, majorWidthPct: major.widthPct, majorPos: major.pos, majorState: major.state,
    minorHigh: minor.high, minorLow: minor.low, minorRawHigh: minor.rawHigh, minorRawLow: minor.rawLow, minorWidthPct: minor.widthPct, minorPos: minor.pos, minorState: minor.state,
    centerLow, centerHigh, centerMid, centerWidthPct, centerState,
  };
}
function calcPriceSignal({ last, prev, close, chgPct, vRatio, ma20, bollUp, bollLow, levels }) {
  const open = Number(last.open) || close;
  const high = Number(last.high) || close;
  const low = Number(last.low) || close;
  const prevClose = Number(prev.close) || close;
  const bodyPct = prevClose > 0 ? Math.abs(close - open) / prevClose * 100 : 0;
  const upperShadowPct = prevClose > 0 ? (high - Math.max(open, close)) / prevClose * 100 : 0;
  const lowerShadowPct = prevClose > 0 ? (Math.min(open, close) - low) / prevClose * 100 : 0;
  const nearMa20 = ma20 && Math.abs(close - ma20) / ma20 <= 0.015;
  const nearBoxLow = levels.boxLow && Math.abs(close - levels.boxLow) / levels.boxLow <= 0.018;
  if (levels.prevHigh20 && close > levels.prevHigh20 * 1.005 && vRatio >= 1.2) return { type: 'breakout', text: '放量突破前高', score: 1 };
  if (levels.prevLow20 && close < levels.prevLow20 * 0.995 && vRatio >= 1.2) return { type: 'breakdown', text: '放量跌破前低', score: -1 };
  if (chgPct > 0 && vRatio >= 1.5 && bodyPct < 0.8 && upperShadowPct > bodyPct * 0.8) return { type: 'stall', text: '放量滞涨/上影压力', score: -0.5 };
  if (chgPct < 0 && vRatio >= 1.5 && lowerShadowPct > bodyPct * 0.8) return { type: 'support', text: '放量下探有承接', score: 0.4 };
  if ((nearMa20 || nearBoxLow) && vRatio < 0.85 && Math.abs(chgPct) < 1.2) return { type: 'pullback', text: '缩量回踩关键位', score: 0.5 };
  if (bollUp && close > bollUp && vRatio >= 1.2) return { type: 'boll_break', text: '放量突破BOLL上轨', score: 0.7 };
  if (bollLow && close < bollLow && vRatio >= 1.2) return { type: 'boll_down', text: '放量跌破BOLL下轨', score: -0.7 };
  return { type: 'neutral', text: '暂无明确量价结构信号', score: 0 };
}

function analyzePeriod(period, klines, prec) {
  const ks = (klines || []).filter(k => isFinite(k.close) && k.close > 0);
  const closes = ks.map(k => Number(k.close));
  const vols = ks.map(k => Number(k.vol) || 0);
  const n = ks.length;
  const ma = {};
  MA_PERIODS.forEach(p => { ma[p] = smaValues(closes, p); });
  const boll = bollValues(closes);
  const macd = macdValues(closes);
  const last = ks[n - 1] || {};
  const prev = ks[n - 2] || {};
  const close = Number(last.close) || 0;
  const prevClose = Number(prev.close) || close;
  const chgPct = prevClose > 0 ? (close - prevClose) / prevClose * 100 : 0;
  const ma5 = lastVal(ma[5]), ma10 = lastVal(ma[10]), ma20 = lastVal(ma[20]), ma60 = lastVal(ma[60]);
  const ma20Prev = prevVal(ma[20]);
  const bollUp = lastVal(boll.up), bollMid = lastVal(boll.mid), bollLow = lastVal(boll.low);
  const bollWidth = bollMid ? (bollUp - bollLow) / bollMid * 100 : 0;
  const vma5 = lastVal(smaValues(vols, 5)) || 0;
  const vRatio = vma5 > 0 ? (Number(last.vol) || 0) / vma5 : 1;
  const volState = vRatio >= 1.5 ? '放量' : vRatio >= 1.2 ? '温和放量' : vRatio < 0.5 ? '极缩量' : vRatio < 0.8 ? '缩量' : '正常量';
  const cross = findLastCross(macd);
  const divergence = detectDivergence(closes, macd);
  const levels = calcRecentLevels(period, ks, close);
  const priceSignal = calcPriceSignal({ last, prev, close, chgPct, vRatio, ma20, bollUp, bollLow, levels });
  const hist = lastVal(macd.hist) || 0;
  const histPrev = prevVal(macd.hist) || 0;
  const macdTxt = `${lastVal(macd.dif) >= lastVal(macd.dea) ? '偏多' : '偏空'} / ${hist >= 0 ? '红柱' : '绿柱'}${Math.abs(hist) >= Math.abs(histPrev) ? '放大' : '收敛'}`;

  let trend = '震荡', score = 0;
  if (ma5 && ma10 && ma20 && close > ma5 && ma5 > ma10 && ma10 > ma20 && (!ma20Prev || ma20 >= ma20Prev)) {
    trend = '上升趋势'; score += 2;
  } else if (ma5 && ma10 && ma20 && close < ma5 && ma5 < ma10 && ma10 < ma20 && (!ma20Prev || ma20 <= ma20Prev)) {
    trend = '下降趋势'; score -= 2;
  } else if (ma20 && close > ma20) { trend = '中性偏强'; score += 1; }
  else if (ma20 && close < ma20) { trend = '中性偏弱'; score -= 1; }
  if (cross && cross.type === 'gold' && cross.index >= n - 8) score += 0.5;
  if (cross && cross.type === 'dead' && cross.index >= n - 8) score -= 0.5;
  if (divergence && divergence.type === 'bottom') score += 0.5;
  if (divergence && divergence.type === 'top') score -= 0.5;
  if (chgPct > 1 && vRatio >= 1.2) score += 0.5;
  if (chgPct < -1 && vRatio >= 1.2) score -= 0.5;
  score += priceSignal.score;
  if (period !== 'month' && levels.boxState === '突破箱体上沿') score += 0.4;
  if (period !== 'month' && levels.boxState === '跌破箱体下沿') score -= 0.4; // codeflicker-fix: 月线评分不再受箱体突破影响，与图上不画月线箱体保持一致

  const recent = ks.slice(-31, -1); // codeflicker-fix: 排除当前 K，避免把现价自己当作支撑/压力
  const recentHigh = Math.max(...recent.map(k => Number(k.high) || Number(k.close) || 0));
  const recentLow = Math.min(...recent.map(k => Number(k.low) || Number(k.close) || Infinity));
  const supports = [recentLow, levels.prevLow20, levels.prevLow60, ma20, ma60, bollLow, levels.boxLow].filter(v => isFinite(v) && v > 0 && v <= close).sort((a, b) => b - a).slice(0, 4);
  const pressures = [recentHigh, levels.prevHigh20, levels.prevHigh60, ma20, ma60, bollUp, levels.boxHigh].filter(v => isFinite(v) && v > 0 && v >= close).sort((a, b) => a - b).slice(0, 4);
  const rawTrend = trend;
  const line = buildPeriodLine(period, { close, chgPct, trend, volState, vRatio, ma5, ma10, ma20, ma60, bollUp, bollMid, bollLow, cross, divergence, macdTxt, levels, priceSignal }, prec);
  return { period, label: PERIOD_LABEL[period], ks, closes, vols, ma, boll, macd, close, prevClose, chgPct, ma5, ma10, ma20, ma60, bollUp, bollMid, bollLow, bollWidth, vRatio, volState, cross, divergence, levels, priceSignal, macdTxt, trend, rawTrend, score, supports, pressures, line, prec };
}

function buildPeriodLine(period, a, prec) {
  const crossTxt = a.cross ? (a.cross.type === 'gold' ? '近现金叉' : '近期死叉') : '无近交叉';
  const divTxt = a.divergence ? (a.divergence.type === 'top' ? `${a.divergence.strength || ''}顶背离` : `${a.divergence.strength || ''}底背离`) : '无背离';
  const pos = a.bollUp && a.bollLow !== null ? (a.close > a.bollUp * 0.98 ? '靠近BOLL上轨' : a.close < a.bollLow * 1.02 ? '靠近BOLL下轨' : 'BOLL中部') : 'BOLL不足';
  const boxTxt = period === 'month' ? '' : `，${a.levels.minorState || a.levels.boxState}，${a.levels.centerState || '中枢不明'}`;
  return `${PERIOD_LABEL[period]}：${a.trend}，${a.volState}(${a.vRatio.toFixed(1)}倍)，${a.macdTxt}，${crossTxt}，${divTxt}，${pos}${boxTxt}，${a.priceSignal.text}`;
}

function overallConclusion(day, week, month) {
  const weighted = day.score * PERIOD_WEIGHT.day + week.score * PERIOD_WEIGHT.week + month.score * PERIOD_WEIGHT.month;
  let rating, style, stars;
  if (weighted >= 1.2) { rating = '偏强'; style = '趋势持有 / 回踩低吸'; stars = '★★★★☆'; }
  else if (weighted >= 0.4) { rating = '中性偏强'; style = '回踩确认 / 不追高'; stars = '★★★☆☆'; }
  else if (weighted > -0.4) { rating = '震荡'; style = '高抛低吸 / 等方向'; stars = '★★★☆☆'; }
  else if (weighted > -1.2) { rating = '中性偏弱'; style = '反弹观察 / 压力减仓'; stars = '★★☆☆☆'; }
  else { rating = '偏弱'; style = '风险规避 / 反弹减仓'; stars = '★☆☆☆☆'; }
  const reason = [];
  if (month.score < 0) reason.push('月线偏弱'); else if (month.score > 0) reason.push('月线偏强');
  if (week.score < 0) reason.push('周线压制'); else if (week.score > 0) reason.push('周线改善');
  if (day.score < 0) reason.push('日线偏弱'); else if (day.score > 0) reason.push('日线修复');
  return { weighted, rating, style, stars, reason: reason.join('，') || '多周期分歧' };
}

function uniqPrices(arr, prec) {
  const seen = new Set(), out = [];
  for (const v of arr) {
    const s = fpBy(v, prec);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
    if (out.length >= 4) break;
  }
  return out;
}

function buildReport(name, code, quote, all, prec) {
  const { day, week, month } = all;
  const oc = overallConclusion(day, week, month);
  const price = quote && quote.price ? Number(quote.price) : day.close;
  const chgPct = quote && isFinite(Number(quote.chgPct)) ? Number(quote.chgPct) : day.chgPct;
  const pressures = uniqPrices([...day.pressures, ...week.pressures].filter(v => v >= price && v <= price * 1.35).sort((a, b) => a - b), prec);
  const supports = uniqPrices([...day.supports, ...week.supports].filter(v => v <= price && v >= price * 0.75).sort((a, b) => b - a), prec);
  const invalid = day.supports[0] ? fpBy(day.supports[0], prec) : (supports[0] || '-');
  const L = [];
  L.push(`📊 ${name}（${code.toUpperCase()}）多周期技术分析`);
  L.push(`现价 ${fpBy(price, prec)}（${pct(chgPct)}）`);
  L.push('');
  L.push('━━━ 综合结论 ━━━');
  L.push(`综合评级：${oc.rating}  ${oc.stars}`);
  L.push(`操作风格：${oc.style}`);
  L.push(`核心依据：${oc.reason}`);
  L.push(`一句话：${buildOneLine(oc, day, week, month)}`);
  L.push('');
  L.push('━━━ 月线：长期结构 ━━━');
  L.push(`· ${month.line}`);
  L.push(`· MA20 ${fpBy(month.ma20, prec)} / BOLL ${fpBy(month.bollLow, prec)} ~ ${fpBy(month.bollUp, prec)}`);
  L.push(`结论：${periodConclusion('month', month)}`);
  L.push('');
  L.push('━━━ 周线：中期阶段 ━━━');
  L.push(`· ${week.line}`);
  L.push(`· MA20 ${fpBy(week.ma20, prec)} / BOLL ${fpBy(week.bollLow, prec)} ~ ${fpBy(week.bollUp, prec)}`);
  L.push(`结论：${periodConclusion('week', week)}`);
  L.push('');
  L.push('━━━ 日线：短线节奏 ━━━');
  L.push(`· ${day.line}`);
  L.push(`· MA5/10/20/60：${fpBy(day.ma5, prec)} / ${fpBy(day.ma10, prec)} / ${fpBy(day.ma20, prec)} / ${fpBy(day.ma60, prec)}`);
  L.push(`结论：${periodConclusion('day', day)}`);
  L.push('');
  L.push('━━━ 结构与量价 ━━━');
  L.push(`· 日线：${structureExplain(day, prec)}`);
  L.push(`· 周线：${structureExplain(week, prec)}`);
  L.push(`· 量价：日线${stripPeriod(volumeExplain(day))}；周线${stripPeriod(volumeExplain(week))}`);
  L.push('');
  L.push('━━━ 关键价位 ━━━');
  L.push(`压力：${pressures.length ? pressures.join(' / ') : '暂无明显压力'}`);
  L.push(`支撑：${supports.length ? supports.join(' / ') : '暂无明显支撑'}`);
  L.push(`失效位：跌破 ${invalid}，当前短线判断转弱`);
  L.push('');
  L.push('━━━ 操作参考 ━━━');
  L.push(`已持仓：${holderAdvice(oc, day, week, prec)}`);
  L.push(`空仓：${emptyAdvice(oc, day, week, prec)}`);
  L.push(`做T：靠近压力减，回踩支撑接；若周线偏弱，T量要小`);
  L.push('');
  L.push('📈 多周期技术图正在生成...');
  L.push('⚠️ 非投资建议，仅供参考');
  return L.join('\n');
}

function buildOneLine(oc, day, week, month) {
  if (oc.rating.includes('弱')) return `月线${month.trend}，周线${week.trend}，日线${day.trend}；短线先按反弹修复看，站回关键均线前不追高。`;
  if (oc.rating.includes('强')) return `月线${month.trend}，周线${week.trend}，日线${day.trend}；趋势基础较好，回踩支撑不破可继续观察。`;
  return `月线${month.trend}、周线${week.trend}、日线${day.trend}，多周期分歧较大，先按区间震荡处理。`;
}
function periodConclusion(period, a) {
  if (a.priceSignal.type === 'breakout') return `${a.label}放量突破前高，若回踩不破前高/MA20，可按突破确认观察。`;
  if (a.priceSignal.type === 'breakdown') return `${a.label}放量跌破前低，优先控风险，等重新站回关键位。`;
  if (a.priceSignal.type === 'stall') return `${a.label}放量滞涨并有上影，冲高回落风险增加。`;
  if (a.priceSignal.type === 'pullback') return `${a.label}缩量回踩关键位，若次级别放量转强可作为低吸观察点。`;
  if (a.trend.includes('上升')) return `${a.label}结构偏强，回踩均线/中轨不破仍按强势整理看。`;
  if (a.trend.includes('下降')) return `${a.label}结构偏弱，反弹先按修复看，站回MA20前不算反转。`;
  if (a.divergence && a.divergence.type === 'top') return `${a.label}出现${a.divergence.strength || ''}顶背离，冲高回落风险增加。`;
  if (a.divergence && a.divergence.type === 'bottom') return `${a.label}出现${a.divergence.strength || ''}底背离，但需要放量阳线确认。`;
  return `${a.label}偏震荡，等待放量突破或缩量回踩确认。`;
}
function structureExplain(a, prec) {
  const l = a.levels || {};
  const parts = [];
  const minor = `小箱体${fpBy(l.minorLow, prec)}~${fpBy(l.minorHigh, prec)}（${l.minorState || l.boxState || '震荡'}）`;
  const center = `中枢${fpBy(l.centerLow, prec)}~${fpBy(l.centerHigh, prec)}（${l.centerState || '中枢不明'}）`;
  const major = `大箱体${fpBy(l.majorLow, prec)}~${fpBy(l.majorHigh, prec)}（宽${pct(l.majorWidthPct || 0)}）`;
  if (a.period === 'week') {
    parts.push(major);
    parts.push(minor);
    parts.push(center);
  } else if (a.period === 'day') {
    parts.push(minor);
    parts.push(center);
    parts.push(`大箱体背景${fpBy(l.majorLow, prec)}~${fpBy(l.majorHigh, prec)}`);
  } else {
    parts.push('月线不画箱体，仅看长期方向与均线/BOLL/MACD');
  }
  if (l.prevHigh20) parts.push(`近20期压力${fpBy(l.prevHigh20, prec)}`);
  if (l.prevLow20) parts.push(`近20期支撑${fpBy(l.prevLow20, prec)}`);
  parts.push(a.priceSignal.text);
  return parts.join('，');
}
function stripPeriod(s) { return String(s || '').replace(/[。；;\s]+$/g, ''); }
function volumeExplain(a) {
  const up = a.chgPct >= 0;
  if (up && a.vRatio >= 1.2) return `上涨配合${a.volState}，主动资金较积极，突破可信度提升。`;
  if (up && a.vRatio < 0.8) return `上涨但缩量，偏反弹，持续性需要继续确认。`;
  if (!up && a.vRatio >= 1.2) return `下跌伴随${a.volState}，抛压较重，不急着接。`;
  if (!up && a.vRatio < 0.8) return `下跌缩量，抛压有所减弱，但需看支撑是否守住。`;
  return `量价中性，暂无强方向信号。`;
}
function holderAdvice(oc, day, week, prec) {
  const p = day.pressures[0] ? fpBy(day.pressures[0], prec) : '上方压力';
  const s = day.supports[0] ? fpBy(day.supports[0], prec) : '关键支撑';
  if (day.priceSignal.type === 'breakdown') return `日线放量跌破前低，优先减风险；重新站回 ${p} 前少加仓。`;
  if (day.priceSignal.type === 'breakout' && week.score >= 0) return `突破有效时可留底仓，回踩 ${s} 不破再看加仓，跌回突破位则减。`;
  if (oc.weighted < -0.4) return `反弹到 ${p} 附近缩量可减仓，跌破 ${s} 需控制风险。`;
  if (oc.weighted > 0.4) return `趋势未破可持有，回踩 ${s} 不破可观察，放量跌破则减。`;
  return `区间内高抛低吸，靠近 ${p} 谨慎，回踩 ${s} 观察承接。`;
}
function emptyAdvice(oc, day, week, prec) {
  const s = day.supports[0] ? fpBy(day.supports[0], prec) : '支撑位';
  const p = day.pressures[0] ? fpBy(day.pressures[0], prec) : '压力位';
  if (day.priceSignal.type === 'breakout') return `不直接追高，等回踩 ${p} 附近不破、或盘中缩量回踩 ${s} 后再评估。`;
  if (day.priceSignal.type === 'pullback') return `可重点观察 ${s} 附近承接，但要等放量转强，不提前重仓。`;
  if (oc.weighted < -0.4) return `不追反弹，等站回 ${p} 并放量后再评估。`;
  if (oc.weighted > 0.4) return `等回踩 ${s} 缩量企稳，不追高。`;
  return `等靠近 ${s} 的缩量回踩，或放量突破 ${p} 后确认。`;
}

function renderAnPng(code, name, quote, all, prec) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1560, PAD = 56, TITLE_H = 88, ROW_H = 450, GAP = 14;
  const H = TITLE_H + ROW_H * 3 + GAP * 2 + 46;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  const upC = '#f5222d', downC = '#0aa869', ink = '#2b2f36', sub = '#8a919c', grid = '#e8eaed', panel = '#f7f8fa';
  const maCols = { 5: '#f0b90b', 10: '#7b61ff', 20: '#1677ff', 60: '#8a919c' };
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  const price = quote && quote.price ? Number(quote.price) : all.day.close;
  const chgPct = quote && isFinite(Number(quote.chgPct)) ? Number(quote.chgPct) : all.day.chgPct;
  const oc = overallConclusion(all.day, all.week, all.month);
  ctx.fillStyle = panel; ctx.fillRect(0, 0, W, TITLE_H);
  ctx.fillStyle = chgPct >= 0 ? upC : downC; ctx.fillRect(PAD, 18, 5, 46);
  ctx.fillStyle = ink; ctx.font = 'bold 26px cjk'; ctx.textAlign = 'left'; ctx.fillText(`${name} 多周期技术分析`, PAD + 16, 34);
  ctx.fillStyle = sub; ctx.font = '14px cjk'; ctx.fillText(`${code.toUpperCase()} · ${oc.rating} · ${oc.style}`, PAD + 16, 60);
  ctx.textAlign = 'right'; ctx.fillStyle = chgPct >= 0 ? upC : downC; ctx.font = 'bold 30px cjk'; ctx.fillText(fpBy(price, prec), W - PAD, 34);
  ctx.font = '15px cjk'; ctx.fillText(pct(chgPct), W - PAD, 60);
  let y = TITLE_H;
  drawPeriod(ctx, all.day, PAD, y, W - PAD * 2, ROW_H, '日线', prec, maCols); y += ROW_H + GAP;
  drawPeriod(ctx, all.week, PAD, y, W - PAD * 2, ROW_H, '周线', prec, maCols); y += ROW_H + GAP;
  drawPeriod(ctx, all.month, PAD, y, W - PAD * 2, ROW_H, '月线', prec, maCols);
  ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'right';
  ctx.fillText('生成 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), W - PAD, H - 18);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

function drawPeriod(ctx, a, x0, y0, w, h, title, prec, maCols) {
  const upC = '#f5222d', downC = '#0aa869', ink = '#2b2f36', sub = '#8a919c', grid = '#e8eaed', panel = '#f7f8fa';
  ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(x0 - 8, y0 + 2, w + 16, h - 4, 12); ctx.fill();
  // 显示窗口 = 大箱体计算窗口，一格不多：
  //   日线 40 根（≈2个月）· 周线 30 根（≈7个月）· 月线 24 根（2年，月线不画箱体）
  // 为什么必须收窄：603986 日线 90 根的 Y 跨度是 509（含 7 月那根 846 的尖顶），
  // 40 根只有 164 —— 同样的 220px 面板，K 线分辨率差 3 倍。窗口拉长 = 自己把图画糊。
  const ks = a.ks.slice(title === '日线' ? -40 : title === '周线' ? -30 : -24);
  const offset = a.ks.length - ks.length;
  const n = ks.length;
  const topH = 220, volH = 56, macdH = 92;
  const plotTop = y0 + 34;
  const volTop = plotTop + topH + 8;
  const macdTop = volTop + volH + 8;
  ctx.fillStyle = ink; ctx.font = 'bold 16px cjk'; ctx.textAlign = 'left'; ctx.fillText(`${title} · ${a.trend}`, x0, y0 + 18);
  ctx.fillStyle = sub; ctx.font = '12px cjk';
  ctx.fillText(title === '月线' ? `MA20 ${fpBy(a.ma20, prec)}  BOLL ${fpBy(a.bollLow, prec)}~${fpBy(a.bollUp, prec)}  ${a.volState}  月线不画箱体` : `MA20 ${fpBy(a.ma20, prec)}  BOLL ${fpBy(a.bollLow, prec)}~${fpBy(a.bollUp, prec)}  ${a.volState}  BOX-S小箱体 CORE中枢 BOX-L大箱体`, x0 + 130, y0 + 18);
  // 纵向定标：**以 K 线高低为准**，MA/BOLL 只在与 K 线范围相差 30% 以内时才参与。
  // 为什么必须这样：均线/布林是滞后指标，它们在窗口首根反映的是**窗口外**的旧数据。
  // 603986 日线 40 根如果不做这个过滤，窗口首根的 BOLL 上轨还是 871.32（20 天前那根 846 尖顶算出来的），
  // Y 跨度会被从 164 撑到 648，K 线直接压成一条线——这才是"图难看"的真正元凶，不是窗口长度。
  // 超出该带的均线/布林一律交给 panel clip 裁掉（它本来也不是这个窗口该看的参考）。
  const kLo = Math.min(...ks.map(k => Number(k.low) || Number(k.close) || Infinity));
  const kHi = Math.max(...ks.map(k => Number(k.high) || Number(k.close) || 0));
  const kRng = Math.max(kHi - kLo, kHi * 0.01);
  // 下界再叠一个"不可能低于区间最低价一半"的绝对地板，挡住 0 附近的脏值（月线实测出现过 BOLL 下轨 ≈ 0）
  const bandLo = Math.max(kLo * 0.5, kLo - kRng * 0.15);
  const bandHi = kHi + kRng * 0.15;
  const inBand = v => Number.isFinite(v) && v > 0 && v >= bandLo && v <= bandHi;
  const extraP = [];
  ks.forEach((k, i) => {
    const idx = offset + i;
    [5, 10, 20, 60].forEach(p => { if (inBand(a.ma[p][idx])) extraP.push(a.ma[p][idx]); });
    if (inBand(a.boll.up[idx])) extraP.push(a.boll.up[idx]);
    if (inBand(a.boll.low[idx])) extraP.push(a.boll.low[idx]);
  });
  const lo = Math.min(kLo, ...extraP), hi = Math.max(kHi, ...extraP), rng = hi - lo || 1;
  const yMin = lo - rng * 0.05, yMax = hi + rng * 0.05;
  const X = i => x0 + (i + 0.5) * (w / n);
  const barW = w / n;
  const Y = p => plotTop + topH - ((p - yMin) / (yMax - yMin)) * topH;
  ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  [0.25, 0.5, 0.75].forEach(f => { const yy = plotTop + topH * f; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + w, yy); ctx.stroke(); });
  ctx.setLineDash([]);
  const clampY = y => Math.max(plotTop, Math.min(plotTop + topH, y));
  const usedLabelYs = [];
  // 标签纵向避让：先试原位，冲突则按 18px 步长**上下交替**找空位
  // （只往下推会在面板底部撞墙被夹回来，反而又重叠）
  const LBL_GAP = 18;
  // maxShift：允许的最大避让位移。挪太远标签就指不准它标的价位了，宁可就地压一点。
  const placeY = (yy, maxShift = 54) => {
    const lo = plotTop + 12, hi = plotTop + topH - 10;
    let y = Math.max(lo, Math.min(hi, yy));
    const clash = v => usedLabelYs.some(u => Math.abs(u - v) < LBL_GAP);
    if (clash(y)) {
      let found = null;
      for (let d = LBL_GAP; d <= maxShift && found === null; d += LBL_GAP) {
        if (y + d <= hi && !clash(y + d)) found = y + d;
        else if (y - d >= lo && !clash(y - d)) found = y - d;
      }
      if (found !== null) y = found;
    }
    usedLabelYs.push(y);
    return y;
  };
  // 箱体文字先"占位"（登记到 usedLabelYs 参与避让），最后统一画在 K 线/压力线之上，
  // 否则压力支撑的虚线会把箱体标签横穿成"删除线"。
  const deferredLabels = [];
  const drawDeferred = () => {
    deferredLabels.forEach(o => {
      ctx.font = o.font; ctx.textAlign = 'left';
      const tw = ctx.measureText(o.text).width + 10;
      // 不透明底衬：半透明时下面的 BOLL/均线会透出来，看起来像给文字加了"删除线"
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(o.x - 5, o.y - 11, Math.min(tw, o.maxW), 16);
      ctx.fillStyle = o.color;
      ctx.fillText(o.text, o.x, o.y);
    });
  };
  // 箱体绘制：价格一律按真实比例映射，**不做 clamp**。
  // clamp 会把超出视图的上下沿压到面板边缘，形成两条贴边的"平行线"——那是假象，必须避免。
  // 超出视图时改为在面板边缘给出「上沿/下沿在视图外」的提示标签，并把线交给 panel clip 截断。
  // winStart/winLen：箱体的**计算窗口**（左闭右开，均不含当前K）。
  // 框必须只覆盖被统计的那几根 K 线——之前右边一律拉到 x0+w，等于把"今天"也框进去了，
  // 而今天的价格根本不在箱体区间里（603986 今天 356.88，小箱体 374.13~416.51），
  // 视觉上就变成"框住了今天的价格但价格不在框里"，自相矛盾。
  const drawBoxArea = (low, high, winStart, winLen, label, stroke, fill, dash, opts = {}) => {
    if (!(high > low)) return;
    const s = Math.max(0, Math.min(n, winStart));
    const e = Math.max(s, Math.min(n, winStart + winLen));
    if (e - s < 1) return;
    const x1 = x0 + s * barW;
    const x2 = x0 + e * barW;
    const yt = Y(high), yb = Y(low);
    // minH 只做亚像素保护，不再用来"撑大"窄箱体——撑大会让框覆盖到它实际不含的价位
    const bh = Math.max(opts.minH || 2, yb - yt);
    const by = Math.min(yt, plotTop + topH - bh);
    // 大箱体占满整个纵向时不再填色，否则整块色板会盖住 K 线，反而看不清
    const coverRatio = bh / topH;
    if (fill && !(opts.dropFillIfTall && coverRatio > opts.dropFillIfTall)) {
      ctx.fillStyle = fill; ctx.fillRect(x1, by, x2 - x1, bh);
    }
    if (opts.railsOnly) {
      // 只画上下两条水平线（通道），不画两侧竖线：与内层小箱体/中枢叠加时不会糊成一片
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.setLineDash(dash || []);
      [by, by + bh].forEach(yy => { ctx.beginPath(); ctx.moveTo(x1, yy); ctx.lineTo(x2, yy); ctx.stroke(); });
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = stroke; ctx.lineWidth = label === 'BOX-S' ? 2 : 1.3; ctx.setLineDash(dash || []);
      ctx.strokeRect(x1, by, x2 - x1, bh);
      ctx.setLineDash([]);
    }
    const font = label === 'CORE' ? 'bold 12px cjk' : label === 'BOX-S' ? 'bold 12px cjk' : '11px cjk';
    const text = opts.noRange ? label : `${label} ${fpBy(low, prec)}~${fpBy(high, prec)}`;
    // 标注贴框内上沿；框太窄时移到框上方。位置先登记避让，实际绘制延后到最上层。
    ctx.font = font;
    const labelY = placeY(bh >= 26 ? by + 15 : Math.max(plotTop + 12, by - 4));
    deferredLabels.push({ x: x1 + 6, y: labelY, text, color: stroke, font, maxW: Math.max(60, x2 - x1 - 6) });
    if (!opts.noRightText) {
      ctx.textAlign = 'right';
      ctx.fillText(`${fpBy(high, prec)}`, x2 - 4, by - 8);
      ctx.fillText(`${fpBy(low, prec)}`, x2 - 4, by + bh + 8);
    }
  };
  // 越界的箱体边：在面板上下缘提示"在视图外"，而不是画一条假线
  const outNote = (price, label, stroke) => {
    if (!isFinite(price)) return;
    const above = price > yMax, below = price < yMin;
    if (!above && !below) return;
    ctx.font = '11px cjk'; ctx.textAlign = 'left'; ctx.fillStyle = stroke;
    ctx.fillText(`${label} ${fpBy(price, prec)} ${above ? '↑在视图上方' : '↓在视图下方'}`, x0 + 6, above ? plotTop + 12 : plotTop + topH - 4);
  };
  const lv = a.levels || {};
  // 整个价格面板统一裁剪：箱体、K 线、均线、布林都可能超出视图（尤其是被 inBand 过滤掉的滞后值），
  // 一律裁在面板内，绝不越界压到成交量/MACD 面板上，也绝不做 clamp 贴边。
  ctx.save();
  ctx.beginPath(); ctx.rect(x0 - 2, plotTop - 1, w + 4, topH + 2); ctx.clip();
  if (a.levels && title !== '月线') {
    // 框宽 = 计算窗口（算多少根就框多少根，且**不含当前K**）：
    // 日线大箱体=近40根、周线=近30根、小箱体/中枢=近20根
    // 三层错开呈现：大箱体只画上下通道线；小箱体画矩形；中枢最窄（蓝）
    const mW = lv.majorWin || 40, sW = lv.minorWin || 20, cW = lv.coreWin || 20;
    drawBoxArea(lv.majorLow, lv.majorHigh, n - mW - 1, mW, 'BOX-L', '#b37b00', 'rgba(250, 173, 20, 0.04)', [5, 4], { noRightText: true, railsOnly: true, dropFillIfTall: 0.55, minH: 4 });
    drawBoxArea(lv.minorLow, lv.minorHigh, n - sW - 1, sW, 'BOX-S', '#d48806', 'rgba(250, 173, 20, 0.14)', [], { noRightText: true, minH: 5 });
    drawBoxArea(lv.centerLow, lv.centerHigh, n - cW - 1, cW, 'CORE', '#1677ff', 'rgba(22, 119, 255, 0.34)', [], { noRightText: true, minH: 5 });
  }
  // 上限从 8 放宽到 20：周线只显示 30 根、月线 24 根时，每根间距 50~60px，
  // 若仍按 8px 画会变成"牙签"，K 线实体几乎看不见。
  const cw = Math.max(2, Math.min(20, w / n * 0.58));
  for (let i = 0; i < n; i++) {
    const k = ks[i], col = k.close >= k.open ? upC : downC;
    const xx = X(i), yo = Y(k.open), yc = Y(k.close), yh = Y(k.high), yl = Y(k.low);
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xx, yh); ctx.lineTo(xx, yl); ctx.stroke();
    ctx.fillStyle = col; ctx.fillRect(xx - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yo - yc)));
  }
  // MA + BOLL
  const drawLine = (series, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash(dash || []); ctx.beginPath(); let started = false;
    for (let i = 0; i < n; i++) { const v = series[offset + i]; if (!v) continue; const xx = X(i), yy = Y(v); if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy); }
    ctx.stroke(); ctx.setLineDash([]);
  };
  [5, 10, 20, 60].forEach(p => drawLine(a.ma[p], maCols[p]));
  drawLine(a.boll.up, '#f0b90b', [4, 4]); drawLine(a.boll.mid, '#f0b90b', [2, 5]); drawLine(a.boll.low, '#f0b90b', [4, 4]);
  ctx.restore(); // 结束价格面板裁剪
  if (a.levels && title !== '月线') {
    outNote(lv.majorHigh, '大箱体上沿', '#b37b00');
    outNote(lv.majorLow, '大箱体下沿', '#b37b00');
  }
  // 支撑压力：找最近贴近该价位的高/低点，在点位附近做短标注，不再全图横穿
  const findAnchorX = (price, kind) => {
    let best = -1, bestScore = Infinity;
    const from = Math.max(0, n - 55);
    for (let i = from; i < n; i++) {
      const k = ks[i];
      const px = kind === 'pressure' ? (Number(k.high) || Number(k.close) || 0) : (Number(k.low) || Number(k.close) || 0);
      if (!(px > 0)) continue;
      const dist = Math.abs(px - price) / price;
      const recency = (n - 1 - i) / n * 0.018;
      const score = dist + recency;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best >= 0 ? X(best) : x0 + w * (kind === 'pressure' ? 0.82 : 0.72);
  };
  const markPrice = (price, label, color, kind) => {
    if (!(price > yMin && price < yMax)) return;
    const anchorX = findAnchorX(price, kind);
    const trueY = Y(price);
    // 关键：**虚线永远画在真实价位上**。之前虚线跟着避让后的标签一起挪，
    // 结果线画在了一个价格根本不在的位置（603986 支撑 337.10 的线跑到了 400 上方），等于给假信号。
    // 标签躲开碰撞时，用一条细引线连回真实价位。
    const yy = placeY(trueY, 36);
    const text = `${label} ${fpBy(price, prec)}`;
    ctx.font = '11px cjk';
    const tw = ctx.measureText(text).width + 10;
    let tx = kind === 'pressure' ? anchorX + 8 : anchorX - tw - 8;
    tx = Math.max(x0 + 4, Math.min(x0 + w - tw - 4, tx));
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(Math.max(x0, anchorX - 26), trueY); ctx.lineTo(Math.min(x0 + w, anchorX + 26), trueY); ctx.stroke(); ctx.setLineDash([]);
    if (Math.abs(yy - trueY) > 4) {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(tx + 6, yy + (yy > trueY ? -10 : 10)); ctx.lineTo(tx + 6, trueY); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(tx, yy - 10, tw, 20, 4); ctx.fill();
    ctx.fillStyle = color; ctx.font = '11px cjk'; ctx.textAlign = 'left'; ctx.fillText(text, tx + 5, yy);
  };
  if (a.pressures[0]) markPrice(a.pressures[0], '压力', upC, 'pressure');
  if (a.supports[0]) markPrice(a.supports[0], '支撑', downC, 'support');
  // 箱体标签最后画，压在 K 线 / 均线 / 压力线之上，避免被虚线横穿
  drawDeferred();
  if (a.priceSignal && a.priceSignal.type !== 'neutral') {
    const labelColor = a.priceSignal.score >= 0 ? upC : downC;
    ctx.fillStyle = labelColor; ctx.font = 'bold 12px cjk'; ctx.textAlign = 'left';
    ctx.fillText(a.priceSignal.text, x0 + 6, placeY(plotTop + 12));
  }
  // volume
  const maxVol = Math.max(...ks.map(k => k.vol || 0), 1);
  for (let i = 0; i < n; i++) { const k = ks[i], col = k.close >= k.open ? upC : downC; const bh = (k.vol || 0) / maxVol * volH; ctx.fillStyle = col + '99'; ctx.fillRect(X(i) - cw / 2, volTop + volH - bh, cw, bh); }
  // MACD
  const hist = a.macd.hist.slice(offset), dif = a.macd.dif.slice(offset), dea = a.macd.dea.slice(offset);
  // 定标：柱与线各自按 p96 分位定标 —— 剔除少数极端尖峰（DIF 尖峰常达常态 3~4 倍，
  // 用全局极值定标会把整段压成贴零轴的一条线），再对面板做 clip。
  // 超出尖峰被裁到面板外，而不是被压平贴边形成"平行线"（这是同花顺的视觉观感）。
  const pickMax = arr => {
    const v = arr.map(Math.abs).filter(x => Number.isFinite(x) && x > 1e-9).sort((p, q) => p - q);
    return v.length ? Math.max(v[Math.min(v.length - 1, Math.floor(v.length * 0.96))], 1e-6) : 0.0001;
  };
  const hMax = pickMax(hist), lMax = pickMax([...dif, ...dea]);
  const hK = (macdH / 2) * 0.86 / hMax, lK = (macdH / 2) * 0.86 / lMax;
  const zeroY = macdTop + macdH / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0 - 2, macdTop - 2, w + 4, macdH + 4); ctx.clip(); // 面板裁剪：尖峰冲出面板
  ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x0, zeroY); ctx.lineTo(x0 + w, zeroY); ctx.stroke();
  for (let i = 0; i < n; i++) {
    const v = hist[i]; if (!Number.isFinite(v)) continue;
    const bh = Math.abs(v) * hK;
    ctx.fillStyle = v >= 0 ? upC + 'aa' : downC + 'aa';
    ctx.fillRect(X(i) - cw / 2, v >= 0 ? zeroY - bh : zeroY, cw, bh);
  }
  const drawM = (arr, color) => {
    // 两遍描边：宽浅色描边 + 细彩线，压在红绿柱上也能看清两条线，且两条线互不粘连
    for (const [lw, col] of [[3.2, 'rgba(255,255,255,0.95)'], [1.5, color]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); let started = false;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        const yy = zeroY - v * lK;
        if (!started) { ctx.moveTo(X(i), yy); started = true; } else ctx.lineTo(X(i), yy);
      }
      ctx.stroke();
    }
  };
  drawM(dif, '#7b3fe4'); drawM(dea, '#d46b08');
  ctx.restore();
  // key labels
  const crossIdx = a.cross ? a.cross.index - offset : -1;
  if (crossIdx >= 0 && crossIdx < n) {
    let cx = X(crossIdx);
    let cy = zeroY - dif[crossIdx] * lK;
    if (crossIdx >= 1) {
      const prevGap = dif[crossIdx - 1] - dea[crossIdx - 1];
      const currGap = dif[crossIdx] - dea[crossIdx];
      const denom = Math.abs(prevGap) + Math.abs(currGap);
      const r = denom > 1e-9 ? Math.abs(prevGap) / denom : 1;
      cx = X(crossIdx - 1) + (X(crossIdx) - X(crossIdx - 1)) * r;
      const crossVal = dif[crossIdx - 1] + (dif[crossIdx] - dif[crossIdx - 1]) * r;
      cy = zeroY - crossVal * lK;
    }
    const yy = Math.max(macdTop + 8, Math.min(macdTop + macdH - 8, cy));
    const label = a.cross.type === 'gold' ? '金叉' : '死叉';
    const color = a.cross.type === 'gold' ? upC : downC;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cx, macdTop + 3); ctx.lineTo(cx, macdTop + macdH - 3); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, yy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, yy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = 'bold 11px cjk'; ctx.textAlign = 'center';
    const ly = a.cross.type === 'gold' ? Math.max(macdTop + 12, yy - 14) : Math.min(macdTop + macdH - 12, yy + 14);
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - tw / 2, ly - 8, tw, 16);
    ctx.fillStyle = color; ctx.fillText(label, cx, ly);
  }
  if (a.divergence) {
    ctx.fillStyle = a.divergence.type === 'top' ? upC : downC; ctx.font = '12px cjk'; ctx.textAlign = 'right';
    const divLabel = a.divergence.type === 'top' ? `${a.divergence.strength || ''}顶背离` : `${a.divergence.strength || ''}底背离`;
    ctx.fillText(divLabel, x0 + w - 6, macdTop + 12);
  }
  // legend
  ctx.textAlign = 'left'; ctx.font = '11px cjk'; let lx = x0;
  [[`MA5 ${fpBy(a.ma5, prec)}`, maCols[5]], [`MA10 ${fpBy(a.ma10, prec)}`, maCols[10]], [`MA20 ${fpBy(a.ma20, prec)}`, maCols[20]], [`MA60 ${fpBy(a.ma60, prec)}`, maCols[60]], [`MACD ${a.macdTxt}`, '#7b61ff']].forEach(it => { ctx.fillStyle = it[1]; ctx.fillText(it[0], lx, y0 + h - 12); lx += 150; });
}

async function cmdAn(args) {
  const parts = (args || []).filter(Boolean);
  const codeArg = parts[0];
  if (!codeArg) {
    return { ok: false, text: [
      '📋 用法：/an <代码或名称>',
      '例：/an 600519   /an 兆易创新   /an 红利低波',
      '',
      '功能：日线/周线/月线多周期分析，结合 MA/BOLL/MACD/量价，输出文字报告和综合技术图。',
    ].join('\n') };
  }
  let code = normalizeCode(codeArg);
  let name = codeArg;
  let resolveNotice = '';
  if (!code) {
    const resolved = await resolveStockCode(normStockName(codeArg), { details: true });
    code = resolved.code;
    if (!code) return { ok: false, text: `⚠️ 找不到「${codeArg}」，请检查代码或名称` };
    name = resolved.name || codeArg;
    if (!resolved.exact) resolveNotice = `🔎 已按「${name}」查询\n`;
  }
  const [dayK, weekK, monthK, quote] = await Promise.all([
    fetchStockKline(code, 'day').catch(() => null),
    fetchStockKline(code, 'week').catch(() => null),
    fetchStockKline(code, 'month').catch(() => null),
    fetchStockQuote(code).catch(() => null),
  ]);
  if (quote && quote.name) name = quote.name;
  if (!dayK || dayK.length < 60 || !weekK || weekK.length < 30 || !monthK || monthK.length < 20) {
    return { ok: false, text: `⚠️ ${name} K线数据不足，暂无法多周期分析` };
  }
  const prec = isFundCode(code) ? 3 : 2;
  const all = {
    day: analyzePeriod('day', dayK, prec),
    week: analyzePeriod('week', weekK, prec),
    month: analyzePeriod('month', monthK, prec),
  };
  const text = resolveNotice + buildReport(name, code, quote, all, prec);
  let img = null;
  try { img = renderAnPng(code, name, quote, all, prec); }
  catch (e) { console.error('[an] 图表生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdAn, analyzePeriod, renderAnPng };
