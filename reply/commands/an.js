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
  let prev = dif[0] || 0;
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
    const macdMove = Math.abs(d[a]) > 1e-9 ? (d[b] - d[a]) / Math.abs(d[a]) : d[b] - d[a];
    if (priceMove >= minMove && macdMove < -0.08) return { type: 'top', index: b, strength: priceMove >= 0.03 ? '强' : '普通' };
  }
  if (bottoms.length >= 2) {
    const a = bottoms[bottoms.length - 2], b = bottoms[bottoms.length - 1];
    const priceMove = closes[a] > 0 ? (closes[b] - closes[a]) / closes[a] : 0;
    const macdMove = Math.abs(d[a]) > 1e-9 ? (d[b] - d[a]) / Math.abs(d[a]) : d[b] - d[a];
    if (priceMove <= -minMove && macdMove > 0.08) return { type: 'bottom', index: b, strength: priceMove <= -0.03 ? '强' : '普通' };
  }
  return null;
}

function calcRecentLevels(ks, close) {
  const recent20 = ks.slice(-21, -1);
  const recent60 = ks.slice(-61, -1);
  const maxHigh = arr => arr.length ? Math.max(...arr.map(k => Number(k.high) || Number(k.close) || 0)) : null;
  const minLow = arr => arr.length ? Math.min(...arr.map(k => Number(k.low) || Number(k.close) || Infinity)) : null;
  const prevHigh20 = maxHigh(recent20);
  const prevLow20 = minLow(recent20);
  const prevHigh60 = maxHigh(recent60);
  const prevLow60 = minLow(recent60);
  const boxHigh = prevHigh20 || prevHigh60 || close;
  const boxLow = prevLow20 || prevLow60 || close;
  const boxWidthPct = boxLow > 0 ? (boxHigh - boxLow) / boxLow * 100 : 0;
  const boxPos = boxHigh > boxLow ? (close - boxLow) / (boxHigh - boxLow) : 0.5;
  let boxState = '箱体震荡';
  if (close > boxHigh * 1.005) boxState = '突破箱体上沿';
  else if (close < boxLow * 0.995) boxState = '跌破箱体下沿';
  else if (boxPos >= 0.75) boxState = '靠近箱体上沿';
  else if (boxPos <= 0.25) boxState = '靠近箱体下沿';
  return { prevHigh20, prevLow20, prevHigh60, prevLow60, boxHigh, boxLow, boxWidthPct, boxPos, boxState };
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
  const levels = calcRecentLevels(ks, close);
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
  if (levels.boxState === '突破箱体上沿') score += 0.4;
  if (levels.boxState === '跌破箱体下沿') score -= 0.4;

  const recent = ks.slice(-30);
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
  return `${PERIOD_LABEL[period]}：${a.trend}，${a.volState}(${a.vRatio.toFixed(1)}倍)，${a.macdTxt}，${crossTxt}，${divTxt}，${pos}，${a.levels.boxState}，${a.priceSignal.text}`;
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
  parts.push(`${l.boxState || '箱体震荡'}（${fpBy(l.boxLow, prec)}~${fpBy(l.boxHigh, prec)}，宽${pct(l.boxWidthPct || 0)}）`);
  if (l.prevHigh20) parts.push(`20期前高${fpBy(l.prevHigh20, prec)}`);
  if (l.prevLow20) parts.push(`20期前低${fpBy(l.prevLow20, prec)}`);
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
  const W = 1120, PAD = 56, TITLE_H = 88, ROW_H = 320, GAP = 14;
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
  const ks = a.ks.slice(title === '日线' ? -60 : title === '周线' ? -80 : -60);
  const offset = a.ks.length - ks.length;
  const n = ks.length;
  const topH = 180, volH = 48, macdH = 58;
  const plotTop = y0 + 34;
  const volTop = plotTop + topH + 8;
  const macdTop = volTop + volH + 8;
  ctx.fillStyle = ink; ctx.font = 'bold 16px cjk'; ctx.textAlign = 'left'; ctx.fillText(`${title} · ${a.trend}`, x0, y0 + 18);
  ctx.fillStyle = sub; ctx.font = '12px cjk';
  ctx.fillText(`MA20 ${fpBy(a.ma20, prec)}  BOLL ${fpBy(a.bollLow, prec)}~${fpBy(a.bollUp, prec)}  ${a.volState}  ${a.priceSignal.text}`, x0 + 130, y0 + 18);
  const allP = [];
  ks.forEach((k, i) => { allP.push(k.high, k.low); const idx = offset + i; [5, 10, 20, 60].forEach(p => { if (a.ma[p][idx]) allP.push(a.ma[p][idx]); }); if (a.boll.up[idx]) allP.push(a.boll.up[idx], a.boll.low[idx]); });
  const lo = Math.min(...allP), hi = Math.max(...allP), rng = hi - lo || 1;
  const yMin = lo - rng * 0.05, yMax = hi + rng * 0.05;
  const X = i => x0 + (i + 0.5) * (w / n);
  const Y = p => plotTop + topH - ((p - yMin) / (yMax - yMin)) * topH;
  ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  [0.25, 0.5, 0.75].forEach(f => { const yy = plotTop + topH * f; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + w, yy); ctx.stroke(); });
  ctx.setLineDash([]);
  const cw = Math.max(2, Math.min(8, w / n * 0.58));
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
  // 支撑压力
  const markPrice = (price, label, color) => {
    if (!(price > yMin && price < yMax)) return;
    const yy = Y(price); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + w, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '11px cjk'; ctx.textAlign = 'right'; ctx.fillText(`${label} ${fpBy(price, prec)}`, x0 + w - 4, yy - 8);
  };
  if (a.levels && a.levels.boxHigh) markPrice(a.levels.boxHigh, '箱顶', '#d48806');
  if (a.levels && a.levels.boxLow) markPrice(a.levels.boxLow, '箱底', '#389e0d');
  if (a.pressures[0]) markPrice(a.pressures[0], '压力', upC);
  if (a.supports[0]) markPrice(a.supports[0], '支撑', downC);
  if (a.priceSignal && a.priceSignal.type !== 'neutral') {
    const labelColor = a.priceSignal.score >= 0 ? upC : downC;
    ctx.fillStyle = labelColor; ctx.font = 'bold 12px cjk'; ctx.textAlign = 'left';
    ctx.fillText(a.priceSignal.text, x0 + 6, plotTop + 12);
  }
  // volume
  const maxVol = Math.max(...ks.map(k => k.vol || 0), 1);
  for (let i = 0; i < n; i++) { const k = ks[i], col = k.close >= k.open ? upC : downC; const bh = (k.vol || 0) / maxVol * volH; ctx.fillStyle = col + '99'; ctx.fillRect(X(i) - cw / 2, volTop + volH - bh, cw, bh); }
  // MACD
  const hist = a.macd.hist.slice(offset), dif = a.macd.dif.slice(offset), dea = a.macd.dea.slice(offset);
  const maxM = Math.max(...hist.map(v => Math.abs(v)), ...dif.map(v => Math.abs(v)), ...dea.map(v => Math.abs(v)), 0.0001);
  const zeroY = macdTop + macdH / 2; ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x0, zeroY); ctx.lineTo(x0 + w, zeroY); ctx.stroke();
  for (let i = 0; i < n; i++) { const v = hist[i]; const bh = Math.abs(v) / maxM * macdH / 2; ctx.fillStyle = v >= 0 ? upC + 'aa' : downC + 'aa'; ctx.fillRect(X(i) - cw / 2, v >= 0 ? zeroY - bh : zeroY, cw, bh); }
  const drawM = (arr, color) => { ctx.strokeStyle = color; ctx.lineWidth = 1.1; ctx.beginPath(); for (let i = 0; i < n; i++) { const yy = zeroY - arr[i] / maxM * macdH / 2; i === 0 ? ctx.moveTo(X(i), yy) : ctx.lineTo(X(i), yy); } ctx.stroke(); };
  drawM(dif, '#7b61ff'); drawM(dea, '#f0b90b');
  // key labels
  const crossIdx = a.cross ? a.cross.index - offset : -1;
  if (crossIdx >= 0 && crossIdx < n) {
    const yy = zeroY - dif[crossIdx] / maxM * macdH / 2;
    ctx.fillStyle = a.cross.type === 'gold' ? upC : downC; ctx.beginPath(); ctx.arc(X(crossIdx), yy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = '11px cjk'; ctx.textAlign = 'center'; ctx.fillText(a.cross.type === 'gold' ? '金叉' : '死叉', X(crossIdx), yy - 12);
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
  if (!code) {
    code = await resolveStockCode(normStockName(codeArg));
    if (!code) return { ok: false, text: `⚠️ 找不到「${codeArg}」，请检查代码或名称` };
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
  const text = buildReport(name, code, quote, all, prec);
  let img = null;
  try { img = renderAnPng(code, name, quote, all, prec); }
  catch (e) { console.error('[an] 图表生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdAn, analyzePeriod, renderAnPng };
