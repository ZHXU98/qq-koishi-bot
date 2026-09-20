// ============================================================
// /an 多周期股票分析：日线/周线/月线 + MA/BOLL/MACD + 量价 + 关键价位
// ============================================================
const { normStockName, isFundCode } = require('../utils');
const { resolveStockCode, normalizeCode, fetchStockKline, fetchStockQuote } = require('../market');
const { renderReportCard } = require('../report-card');

const MA_PERIODS = [5, 10, 20, 60];
const PERIOD_LABEL = { day: '日线', week: '周线', month: '月线' };
const CROSS_MAX_AGE = { day: 8, week: 4, month: 3 };

const fpBy = (v, prec = 2) => isFinite(v) && v !== null ? Number(v).toFixed(prec) : '-';
const pct = v => (isFinite(v) ? (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%' : '-');
const bollRangeText = (a, prec) => {
  const low = Number(a?.bollLow), up = Number(a?.bollUp), close = Number(a?.close);
  // 极端历史波动会让 BOLL 下轨被数学截到接近 0；这时不应伪装成可交易参考价。
  if (!(up > 0) || !(low > 0) || (close > 0 && low < close * 0.1)) return 'BOLL -';
  return `BOLL ${fpBy(low, prec)} ~ ${fpBy(up, prec)}`;
};

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

function calcRsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0); }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function calcAtrDmi(ks, period = 14) {
  const n = ks.length, atr = new Array(n).fill(null), plusDi = new Array(n).fill(null), minusDi = new Array(n).fill(null), adx = new Array(n).fill(null);
  if (n <= period * 2) return { atr, plusDi, minusDi, adx };
  const tr = new Array(n).fill(0), plus = new Array(n).fill(0), minus = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const hi = Number(ks[i].high) || 0, lo = Number(ks[i].low) || 0, prevClose = Number(ks[i - 1].close) || 0;
    tr[i] = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
    const up = hi - (Number(ks[i - 1].high) || hi), down = (Number(ks[i - 1].low) || lo) - lo;
    plus[i] = up > down && up > 0 ? up : 0; minus[i] = down > up && down > 0 ? down : 0;
  }
  let smTr = tr.slice(1, period + 1).reduce((a, v) => a + v, 0), smPlus = plus.slice(1, period + 1).reduce((a, v) => a + v, 0), smMinus = minus.slice(1, period + 1).reduce((a, v) => a + v, 0);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) { smTr = smTr - smTr / period + tr[i]; smPlus = smPlus - smPlus / period + plus[i]; smMinus = smMinus - smMinus / period + minus[i]; }
    atr[i] = smTr / period; plusDi[i] = smTr ? smPlus / smTr * 100 : 0; minusDi[i] = smTr ? smMinus / smTr * 100 : 0;
    const sum = plusDi[i] + minusDi[i]; dx[i] = sum ? Math.abs(plusDi[i] - minusDi[i]) / sum * 100 : 0;
  }
  let seed = dx.slice(period, period * 2).filter(Number.isFinite);
  if (seed.length === period) {
    let value = seed.reduce((a, v) => a + v, 0) / period; adx[period * 2 - 1] = value;
    for (let i = period * 2; i < n; i++) { value = (value * (period - 1) + dx[i]) / period; adx[i] = value; }
  }
  return { atr, plusDi, minusDi, adx };
}
function calcVolumeTrend(vols) {
  const ma5 = lastVal(smaValues(vols, 5)) || 0, ma20 = lastVal(smaValues(vols, 20)) || 0;
  const ratio = ma20 > 0 ? ma5 / ma20 : 1;
  const state = ratio >= 1.25 ? '参与度回升' : ratio <= 0.75 ? '参与度下降' : '参与度平稳';
  return { ma5, ma20, ratio, state };
}
function detectPriceAction(ks, atrValue = 0) {
  const last = ks.at(-1) || {}, prev = ks.at(-2) || {};
  const o = Number(last.open) || 0, c = Number(last.close) || 0, h = Number(last.high) || c, l = Number(last.low) || c;
  const po = Number(prev.open) || 0, pc = Number(prev.close) || 0;
  const range = Math.max(h - l, 1e-9), body = Math.abs(c - o), closePos = (c - l) / range;
  const recentRanges = ks.slice(-6, -1).map(k => Math.max(0, Number(k.high) - Number(k.low))).filter(Boolean);
  const avgRange = recentRanges.length ? recentRanges.reduce((a, v) => a + v, 0) / recentRanges.length : 0;
  if (c > o && pc < po && c >= po && o <= pc) return { type: 'bull_engulf', text: '阳包阴，短线转强尝试' };
  if (c < o && pc > po && c <= po && o >= pc) return { type: 'bear_engulf', text: '阴包阳，短线转弱警报' };
  if (avgRange > 0 && range <= avgRange * 0.55) return { type: 'narrow', text: '窄幅整理，等待方向选择' };
  if (body / range >= 0.62 && closePos >= 0.75) return { type: 'strong_close', text: '强势收盘，买方占优' };
  if (body / range >= 0.62 && closePos <= 0.25) return { type: 'weak_close', text: '弱势收盘，卖方占优' };
  return { type: 'neutral', text: 'K线形态中性' };
}
function detectBreakoutState(a) {
  const { close, levels, vRatio, ma20, ks } = a;
  const recentHigh = levels.prevHigh20, recentLow = levels.prevLow20;
  if (recentHigh && close > recentHigh * 1.005) {
    if (vRatio >= 1.2) return { state: '有效突破待回踩', text: `站上前高，量能配合；回踩 ${fpBy(recentHigh, a.prec)} 不破再确认` };
    return { state: '初步突破未确认', text: `站上前高但量能不足，需放量确认 ${fpBy(recentHigh, a.prec)}` };
  }
  // codeflicker-fix: LOGIC-Issue-004/qg6iar3gcajrzkxv7klg - 假突破基准排除突破K与当前K，避免用包含自身最高价的窗口做不可达比较。
  const breakoutBase = ks.slice(-22, -2);
  const breakoutBaseHigh = breakoutBase.length
    ? Math.max(...breakoutBase.map(k => Number(k.high) || Number(k.close) || 0))
    : null;
  const previousClose = Number(ks.at(-2)?.close) || 0;
  if (breakoutBaseHigh && previousClose > breakoutBaseHigh * 1.005 && close < breakoutBaseHigh) {
    return { state: '假突破风险', text: `前期突破后跌回历史前高 ${fpBy(breakoutBaseHigh, a.prec)} 下方` };
  }
  if (breakoutBaseHigh && previousClose > breakoutBaseHigh * 1.005 && close >= breakoutBaseHigh) {
    return { state: '突破后维持', text: `突破后仍守在历史前高 ${fpBy(breakoutBaseHigh, a.prec)} 上方` };
  }
  if (recentLow && close < recentLow * 0.995) return { state: '破位', text: `跌破前低 ${fpBy(recentLow, a.prec)}，结构转弱` };
  if (ma20 && Math.abs(close - ma20) / ma20 < 0.015) return { state: '关键位博弈', text: '价格靠近 MA20，等待收盘方向确认' };
  return { state: '区间内', text: '尚未触发有效突破或破位' };
}
function alignExcess(stockKs, benchKs, days) {
  const stock = new Map((stockKs || []).map(k => [String(k.t).slice(0, 10), Number(k.close)]));
  const bench = new Map((benchKs || []).map(k => [String(k.t).slice(0, 10), Number(k.close)]));
  const shared = [...stock.keys()].filter(t => bench.has(t)).sort();
  if (shared.length <= days) return null;
  const end = shared.at(-1), start = shared.at(-1 - days);
  const sr = stock.get(end) / stock.get(start) - 1, br = bench.get(end) / bench.get(start) - 1;
  return Number.isFinite(sr) && Number.isFinite(br) ? (sr - br) * 100 : null;
}
function buildRelativeStrength(dayK, hs300K) {
  const horizons = [5, 20, 60];
  const vs300 = Object.fromEntries(horizons.map(d => [d, alignExcess(dayK, hs300K, d)]));
  const recent20 = vs300[20];
  const state = recent20 === null ? '基准数据不足' : recent20 >= 5 ? '显著跑赢沪深300' : recent20 >= 0 ? '相对沪深300偏强' : recent20 <= -5 ? '显著跑输沪深300' : '相对沪深300偏弱';
  // codeflicker-fix: API-Issue-001/qg6iar3gcajrzkxv7klg - 移除高请求量且层级不稳定的行业对比，仅保留沪深300基准。
  return { vs300, state };
}
function lastVal(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
function prevVal(arr) { return arr && arr.length > 1 ? arr[arr.length - 2] : null; }

function findLastCross(macd, maxAge = Infinity) {
  const d = macd.dif, e = macd.dea;
  for (let i = d.length - 1; i >= 1; i--) {
    let type = null;
    if (d[i - 1] < e[i - 1] && d[i] >= e[i]) type = 'gold';
    else if (d[i - 1] >= e[i - 1] && d[i] < e[i]) type = 'dead';
    if (type) {
      const age = d.length - 1 - i;
      // codeflicker-fix: LOGIC-Issue-003/qg6iar3gcajrzkxv7klg - 超龄交叉不再冒充近期信号或参与日线修复判断。
      return age <= maxAge ? { type, index: i, age } : null;
    }
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
function calcPriceSignal({ last, prev, close, chgPct, vRatio, ma20, bollUp, bollLow, levels, allowConstructivePullback = false }) {
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
  if (levels.prevLow20 && close < levels.prevLow20 * 0.995) {
    // codeflicker-fix: LOGIC-Issue-001/jvslwtka15th3ern74uz - 价格跌破结构位即视为破位，放量只影响可信度。
    return vRatio >= 1.2
      ? { type: 'breakdown', text: '放量跌破前低', score: -1 }
      : { type: 'breakdown', text: '缩量跌破前低，结构仍然转弱', score: -1 };
  }
  if (chgPct > 0 && vRatio >= 1.5 && bodyPct < 0.8 && upperShadowPct > bodyPct * 0.8) return { type: 'stall', text: '放量滞涨/上影压力', score: -0.5 };
  if (chgPct < 0 && vRatio >= 1.5 && lowerShadowPct > bodyPct * 0.8) return { type: 'support', text: '放量下探有承接', score: 0.4 };
  if ((nearMa20 || nearBoxLow) && vRatio < 0.85 && Math.abs(chgPct) < 1.2) {
    // codeflicker-fix: TA-Issue-001/s8jm34fg6nv8n9a7y13u - 弱势趋势的缩量不能直接当成低吸型回踩。
    return allowConstructivePullback
      ? { type: 'pullback', text: '缩量回踩参考区', score: 0.5 }
      : { type: 'weak_pullback', text: '弱势缩量整理，承接未确认', score: 0 };
  }
  if (bollUp && close > bollUp && vRatio >= 1.2) return { type: 'boll_break', text: '放量突破BOLL上轨', score: 0.7 };
  if (bollLow && close < bollLow && vRatio >= 1.2) return { type: 'boll_down', text: '放量跌破BOLL下轨', score: -0.7 };
  return { type: 'neutral', text: '暂无明确量价结构信号', score: 0 };
}

function isBarComplete(period, barTime, now = new Date()) {
  const m = String(barTime || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  const barKey = `${m[1]}-${m[2]}-${m[3]}`;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';
  const todayKey = `${get('year')}-${get('month')}-${get('day')}`;
  if (period === 'day') {
    if (barKey < todayKey) return true;
    return barKey === todayKey && Number(get('hour')) * 60 + Number(get('minute')) >= 15 * 60;
  }
  const year = Number(get('year')), month = Number(get('month')), day = Number(get('day'));
  const barDate = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  const today = new Date(Date.UTC(year, month - 1, day, 12));
  if (period === 'week') {
    const monday = new Date(today);
    const weekday = today.getUTCDay() || 7;
    monday.setUTCDate(today.getUTCDate() - weekday + 1);
    if (barDate < monday) return true;
    const todayWeekday = today.getUTCDay();
    return todayWeekday === 0 || todayWeekday === 6
      || (todayWeekday === 5 && Number(get('hour')) * 60 + Number(get('minute')) >= 15 * 60);
  }
  if (period === 'month') {
    const barMonth = barKey.slice(0, 7), currentMonth = todayKey.slice(0, 7);
    if (barMonth < currentMonth) return true;
    // 找自然日之后的下一个工作日；若已跨月，则当前工作日是本月最后可交易日。
    const nextWeekday = new Date(today);
    do { nextWeekday.setUTCDate(nextWeekday.getUTCDate() + 1); }
    while (nextWeekday.getUTCDay() === 0 || nextWeekday.getUTCDay() === 6);
    const afterClose = Number(get('hour')) * 60 + Number(get('minute')) >= 15 * 60;
    const todayWeekday = today.getUTCDay();
    if (barMonth !== currentMonth) return false;
    if (todayWeekday === 0 || todayWeekday === 6) {
      const previousWeekday = new Date(today);
      do { previousWeekday.setUTCDate(previousWeekday.getUTCDate() - 1); }
      while (previousWeekday.getUTCDay() === 0 || previousWeekday.getUTCDay() === 6);
      return previousWeekday.getUTCMonth() !== nextWeekday.getUTCMonth();
    }
    return afterClose && nextWeekday.getUTCMonth() !== today.getUTCMonth();
  }
  return false;
}

function clusterPriceLevels(values, close, atr, side, prec) {
  const sorted = values.filter(v => isFinite(v) && v > 0).sort((a, b) => side === 'support' ? b - a : a - b);
  const minTick = 10 ** -prec;
  const tolerance = Math.max((atr || 0) * 0.3, close * 0.005, minTick);
  const groups = [];
  for (const value of sorted) {
    const group = groups.find(g => Math.abs(g.anchor - value) <= tolerance);
    if (group) {
      group.values.push(value);
      group.low = Math.min(group.low, value);
      group.high = Math.max(group.high, value);
      group.anchor = group.values.reduce((sum, v) => sum + v, 0) / group.values.length;
    } else {
      groups.push({ anchor: value, low: value, high: value, values: [value] });
    }
  }
  return groups.slice(0, 4).map(g => ({
    price: side === 'support' ? g.high : g.low,
    low: g.low,
    high: g.high,
    count: g.values.length,
  }));
}

function levelPrice(level) {
  return typeof level === 'number' ? level : Number(level?.price);
}

function formatPriceZone(level, prec) {
  if (typeof level === 'number') return fpBy(level, prec);
  if (!level || !(level.price > 0)) return '-';
  return fpBy(level.low, prec) === fpBy(level.high, prec)
    ? fpBy(level.price, prec)
    : `${fpBy(level.low, prec)}~${fpBy(level.high, prec)}`;
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
  const rsi = calcRsi(closes);
  const dmi = calcAtrDmi(ks);
  const last = ks[n - 1] || {};
  const prev = ks[n - 2] || {};
  // codeflicker-fix: LOGIC-Issue-001/qg6iar3gcajrzkxv7klg - 按最后K线日期与上海时区识别是否收线，不再按周期名称写死。
  const volumeUsable = isBarComplete(period, last.t);
  // codeflicker-fix: LOGIC-Issue-010/pul6rafwcpgs05omrehu - 未收线时排除当前周期的部分量，保持5/20期参与度只比较完整周期。
  const volumeTrend = calcVolumeTrend(volumeUsable ? vols : vols.slice(0, -1));
  const close = Number(last.close) || 0;
  const prevClose = Number(prev.close) || close;
  const chgPct = prevClose > 0 ? (close - prevClose) / prevClose * 100 : 0;
  const ma5 = lastVal(ma[5]), ma10 = lastVal(ma[10]), ma20 = lastVal(ma[20]), ma60 = lastVal(ma[60]);
  const ma20Prev = prevVal(ma[20]);
  const bollUp = lastVal(boll.up), bollMid = lastVal(boll.mid), bollLow = lastVal(boll.low);
  const bollWidth = bollMid ? (bollUp - bollLow) / bollMid * 100 : 0;
  const prior5Vols = vols.slice(Math.max(0, n - 6), n - 1);
  const prior5Avg = prior5Vols.length
    ? prior5Vols.reduce((sum, value) => sum + value, 0) / prior5Vols.length
    : 0;
  const rawVRatio = prior5Avg > 0 ? (Number(last.vol) || 0) / prior5Avg : 1;
  // codeflicker-fix: LOGIC-Issue-006/qg6iar3gcajrzkxv7klg - 当前量改与此前5个完整周期均量比较，避免分母包含自身压缩异常程度。
  const vRatio = volumeUsable ? rawVRatio : null;
  const volState = volumeUsable
    ? (vRatio >= 1.5 ? '放量' : vRatio >= 1.2 ? '温和放量' : vRatio < 0.5 ? '极缩量' : vRatio < 0.8 ? '缩量' : '正常量')
    : '量能待收线';
  const volumeNote = volumeUsable ? '' : `${PERIOD_LABEL[period]}未收线，量能不参与方向判断`;
  const cross = findLastCross(macd, CROSS_MAX_AGE[period] || 3);
  const divergence = detectDivergence(closes, macd);
  const levels = calcRecentLevels(period, ks, close);
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
  // MACD 金叉、死叉与背离只用于动能确认/预警，不参与主趋势结论评分。
  const allowConstructivePullback = period === 'day' && !trend.includes('下降') && close >= (ma20 || 0);
  const priceSignal = calcPriceSignal({ last, prev, close, chgPct, vRatio: volumeUsable ? vRatio : 1, ma20, bollUp, bollLow, levels, allowConstructivePullback });
  // 保留 period.score 仅供内部兼容；最终结论不再叠加量价、背离或单根 K 线分数。

  const recent = ks.slice(-31, -1); // 排除当前 K，避免把现价自己当作支撑/压力
  const recentHigh = Math.max(...recent.map(k => Number(k.high) || Number(k.close) || 0));
  const recentLow = Math.min(...recent.map(k => Number(k.low) || Number(k.close) || Infinity));
  const atr = lastVal(dmi.atr);
  // codeflicker-fix: MAINT-Issue-001/qg6iar3gcajrzkxv7klg - 相邻价位按 ATR/价格容差聚合为区域，避免重复单点伪装成多重支撑压力。
  const supportCandidates = [recentLow, levels.prevLow20, levels.prevLow60, ma20, ma60, bollLow, levels.boxLow]
    .filter(v => isFinite(v) && v > 0 && v < close * 0.998);
  const pressureCandidates = [recentHigh, levels.prevHigh20, levels.prevHigh60, ma20, ma60, bollUp, levels.boxHigh]
    .filter(v => isFinite(v) && v > close * 1.002);
  const supportZones = clusterPriceLevels(supportCandidates, close, atr, 'support', prec);
  const pressureZones = clusterPriceLevels(pressureCandidates, close, atr, 'pressure', prec);
  const supports = supportZones.map(z => z.price);
  const pressures = pressureZones.map(z => z.price);
  // 当前失效位用于未来风控；是否已经破位则必须用排除当前K后的上一期结构判断。
  const structureFloor = period === 'week' ? levels.minorLow : levels.boxLow;
  const structuralLows = [levels.prevLow20, structureFloor].filter(v => isFinite(v) && v > 0 && v < close * 0.998);
  const structuralInvalid = structuralLows.length ? Math.min(...structuralLows) : null;
  // codeflicker-fix: LOGIC-Issue-005/qg6iar3gcajrzkxv7klg - 拆分未来失效位与当前破位判断，消除 close < 一个已限定低于 close 的死条件。
  const priorKs = ks.slice(0, -1);
  const priorLevels = priorKs.length >= 8 ? calcRecentLevels(period, priorKs, prevClose) : null;
  const priorFloor = priorLevels ? (period === 'week' ? priorLevels.minorLow : priorLevels.boxLow) : null;
  const priorStructuralLows = priorLevels
    ? [priorLevels.prevLow20, priorFloor].filter(v => isFinite(v) && v > 0)
    : [];
  const priorStructuralInvalid = priorStructuralLows.length ? Math.min(...priorStructuralLows) : null;
  const structuralBroken = priorStructuralInvalid > 0 && close < priorStructuralInvalid * 0.995;
  const atrPct = atr && close > 0 ? atr / close * 100 : null;
  const adx = lastVal(dmi.adx), plusDi = lastVal(dmi.plusDi), minusDi = lastVal(dmi.minusDi);
  const trendQuality = !isFinite(adx) ? '趋势强度待计算'
    : adx < 18 ? '无趋势震荡'
    : adx < 25 ? '趋势形成中'
    : adx < 40 ? '趋势明确'
    : '趋势强化';
  const dmiDirection = !isFinite(plusDi) || !isFinite(minusDi) ? '方向待确认' : plusDi >= minusDi ? '多头占优' : '空头占优';
  const rsiValue = lastVal(rsi);
  const rsiState = !isFinite(rsiValue) ? '' : rsiValue >= 75 ? '短线过热' : rsiValue <= 25 ? '短线超卖' : '';
  const rawTrend = trend;
  const evidence = { atr, atrPct, adx, plusDi, minusDi, trendQuality, dmiDirection, rsi: rsiValue, rsiState, volumeTrend, priceAction: detectPriceAction(ks, atr) };
  const breakout = detectBreakoutState({ close, levels, vRatio: volumeUsable ? vRatio : 1, ma20, ks, prec });
  const line = buildPeriodLine(period, { close, chgPct, trend, volState, vRatio: vRatio || 0, volumeNote, ma5, ma10, ma20, ma60, bollUp, bollMid, bollLow, cross, divergence, macdTxt, levels, priceSignal }, prec);
  return { period, label: PERIOD_LABEL[period], ks, closes, vols, ma, boll, macd, rsi, dmi, close, prevClose, chgPct, ma5, ma10, ma20, ma60, bollUp, bollMid, bollLow, bollWidth, vRatio, rawVRatio, volState, volumeUsable, volumeNote, cross, divergence, levels, priceSignal, macdTxt, trend, rawTrend, score, supports, pressures, supportZones, pressureZones, structuralInvalid, priorStructuralInvalid, structuralBroken, evidence, breakout, line, prec };
}

function buildPeriodLine(period, a, prec) {
  const crossTxt = a.cross ? (a.cross.type === 'gold' ? '近现金叉' : '近期死叉') : '无近交叉';
  const divTxt = a.divergence ? (a.divergence.type === 'top' ? `${a.divergence.strength || ''}顶背离` : `${a.divergence.strength || ''}底背离`) : '无背离';
  const pos = a.bollUp && a.bollLow !== null ? (a.close > a.bollUp * 0.98 ? '靠近BOLL上轨' : a.close < a.bollLow * 1.02 ? '靠近BOLL下轨' : 'BOLL中部') : 'BOLL不足';
  const boxTxt = period === 'month' ? '' : `，${a.levels.minorState || a.levels.boxState}，${a.levels.centerState || '中枢不明'}`;
  const volumeTxt = a.volumeNote || `${a.volState}(${a.vRatio.toFixed(1)}倍)`;
  return `${PERIOD_LABEL[period]}：${a.trend}，${volumeTxt}，${a.macdTxt}，${crossTxt}，${divTxt}，${pos}${boxTxt}，${a.priceSignal.text}`;
}

function overallConclusion(day, week, month) {
  // codeflicker-fix: TA-Issue-004/s8jm34fg6nv8n9a7y13u - 用“月线许可→周线阶段→日线执行→风险否决”替代线性加权评分。
  const monthlyWeak = month.trend.includes('下降') || (month.ma20 && month.close < month.ma20);
  const monthlyStrong = month.trend.includes('上升') || (month.ma20 && month.close > month.ma20);
  const weeklyWeak = week.trend.includes('下降') || (week.ma20 && week.close < week.ma20);
  // codeflicker-fix: LOGIC-Issue-003/jvslwtka15th3ern74uz - 站上 MA20 仅代表修复，明确上升排列才算周线趋势支持。
  const weeklyStrong = week.trend === '上升趋势' && week.ma20 && week.close > week.ma20;
  const dailyBroken = day.priceSignal.type === 'breakdown' || day.breakout.state === '破位' || day.structuralBroken;
  // codeflicker-fix: LOGIC-Issue-002/jvslwtka15th3ern74uz - 周线价格破位不再依赖未收线量能，量能仅用于确认度。
  const weeklyBroken = week.priceSignal.type === 'breakdown' || week.breakout.state === '破位';
  const dailyStrong = day.trend.includes('上升') && day.close > (day.ma20 || 0);
  const dailyRepair = day.cross?.type === 'gold' || day.divergence?.type === 'bottom' || day.macdTxt.includes('红柱');

  let state, action, stars, reason;
  if (dailyBroken || weeklyBroken) {
    state = '结构转弱'; action = '先控风险，等待重新站回关键位'; stars = '★☆☆☆☆';
    reason = dailyBroken ? '日线结构破坏' : '周线出现破位信号';
  } else if (weeklyStrong && !monthlyWeak && (dailyStrong || day.priceSignal.type === 'pullback')) {
    state = dailyStrong ? '趋势可持有' : '上升趋势中的回踩';
    action = dailyStrong ? '持有为主，回踩确认再看加仓' : '不追高，等止跌转强确认';
    stars = '★★★★☆'; reason = '月线许可、周线阶段支持，日线未破结构';
  } else if (weeklyStrong && !monthlyWeak) {
    // codeflicker-fix: LOGIC-Issue-002/qg6iar3gcajrzkxv7klg - 日线整理不再抹掉已成立的周线趋势。
    state = '趋势中的日线整理'; action = '中期结构仍在，等待日线止跌转强'; stars = '★★★☆☆';
    reason = '月线许可、周线趋势仍在，但日线尚未恢复强势';
  } else if (weeklyWeak) {
    state = '弱势反弹'; action = '不追反弹，压力位观察，确认后再升级判断'; stars = '★★☆☆☆';
    reason = `${monthlyWeak ? '月线与' : ''}周线仍受压，${dailyRepair ? '日线仅有修复信号' : '日线尚未完成修复'}`;
  } else {
    state = '区间震荡'; action = '按区间处理，等待突破或跌破确认'; stars = '★★★☆☆';
    reason = `${monthlyStrong ? '月线尚可' : '月线中性'}，周线未形成单边阶段，日线不宜单独定方向`;
  }
  return { state, action, stars, reason, monthlyWeak, weeklyWeak, weeklyStrong, weeklyBroken, dailyBroken };
}
function buildReport(name, code, quote, all, prec, relative = null) {
  const { day, week, month } = all;
  const oc = overallConclusion(day, week, month);
  const price = quote && quote.price ? Number(quote.price) : day.close;
  const chgPct = quote && isFinite(Number(quote.chgPct)) ? Number(quote.chgPct) : day.chgPct;
  const pressureValues = [...(day.pressureZones || []), ...(week.pressureZones || [])]
    .flatMap(z => [z.low, z.high])
    .filter(v => v >= price && v <= price * 1.35);
  const supportValues = [...(day.supportZones || []), ...(week.supportZones || [])]
    .flatMap(z => [z.low, z.high])
    .filter(v => v <= price && v >= price * 0.75);
  const pressureZones = clusterPriceLevels(pressureValues, price, day.evidence?.atr, 'pressure', prec);
  const supportZones = clusterPriceLevels(supportValues, price, day.evidence?.atr, 'support', prec);
  const confirm = levelPrice(pressureZones[0]) || null;
  const shortInvalid = day.structuralInvalid || day.supports[day.supports.length - 1] || null;
  const swingInvalid = week.structuralInvalid || week.supports[week.supports.length - 1] || null;
  const L = [];
  L.push(`📊 ${name}（${code.toUpperCase()}）多周期技术分析`);
  L.push(`现价 ${fpBy(price, prec)}（${pct(chgPct)}）`);
  L.push('');
  L.push('━━━ 结论 ━━━');
  L.push(`市场状态：${oc.state}`);
  L.push(`结构完整度：${oc.stars}（仅表示多周期条件完整度）`);
  L.push(`当前动作：${oc.action}`);
  L.push(`主要限制：${oc.reason}`);
  L.push(`一句话：${buildOneLine(oc, day, week, month)}`);
  L.push('');
  L.push('━━━ 多周期结构 ━━━');
  L.push(`· 月线（长期许可）：${month.line}`);
  L.push(`  MA20 ${fpBy(month.ma20, prec)} / ${bollRangeText(month, prec)}`);
  L.push(`  ${periodConclusion('month', month)}`);
  L.push(`· 周线（当前阶段）：${week.line}`);
  L.push(`  MA20 ${fpBy(week.ma20, prec)} / ${bollRangeText(week, prec)}`);
  L.push(`  ${periodConclusion('week', week)}`);
  L.push(`· 日线（执行条件）：${day.line}`);
  L.push(`  MA5/10/20/60：${fpBy(day.ma5, prec)} / ${fpBy(day.ma10, prec)} / ${fpBy(day.ma20, prec)} / ${fpBy(day.ma60, prec)}`);
  L.push(`  ${periodConclusion('day', day)}`);
  L.push('');
  L.push('━━━ 关键条件 ━━━');
  L.push(`向上确认：${confirm ? `放量站回 ${fpBy(confirm, prec)}，且后续不跌回` : '等待放量突破近期压力'}`);
  L.push(`短线失效：${shortInvalid ? `跌破 ${fpBy(shortInvalid, prec)}，日线结构转弱` : '跌破最近确认低点'}`);
  L.push(`波段失效：${swingInvalid ? `跌破 ${fpBy(swingInvalid, prec)}，周线阶段转弱` : '跌破周线关键低点'}`);
  L.push(`参考压力：${pressureZones.length ? pressureZones.map(z => formatPriceZone(z, prec)).join(' / ') : '暂无明显压力'}`);
  L.push(`参考支撑：${supportZones.length ? supportZones.map(z => formatPriceZone(z, prec)).join(' / ') : '暂无明显支撑'}`);
  L.push('');
  L.push('━━━ 信号说明 ━━━');
  L.push(`· 日线结构区：${structureExplain(day, prec)}`);
  L.push(`· 周线结构区：${structureExplain(week, prec)}`);
  L.push(`· 量价：日线${stripPeriod(volumeExplain(day))}；周线${stripPeriod(volumeExplain(week))}`);
  L.push(`· 动能：日线${day.macdTxt}${day.divergence ? `，${day.divergence.strength || ''}${day.divergence.type === 'top' ? '顶' : '底'}背离仅作预警` : ''}`);
  L.push('');
  L.push('━━━ 趋势与风险质量 ━━━');
  L.push(`· 趋势质量：${trendQualityExplain(day)}；DMI ${day.evidence.dmiDirection}（ADX ${fpBy(day.evidence.adx, 1)}，+DI ${fpBy(day.evidence.plusDi, 1)} / -DI ${fpBy(day.evidence.minusDi, 1)}）`);
  L.push(`· 波动风险：${atrExplain(day, price, shortInvalid, prec)}`);
  L.push(`· 量能趋势：${volumeTrendExplain(day)}`);
  L.push(`· 价格行为：${day.evidence.priceAction.text}；突破状态：${day.breakout.state}（${day.breakout.text}）`);
  if (day.evidence.rsiState) L.push(`· RSI14 ${fpBy(day.evidence.rsi, 1)}：${day.evidence.rsiState}，只作极端提醒，不改变主结论。`);
  L.push('');
  L.push('━━━ 相对强弱 ━━━');
  relativeStrengthLines(relative).forEach(line => L.push(line));
  L.push('');
  L.push('━━━ 操作参考 ━━━');
  L.push(`已持仓：${holderAdvice(oc, day, week, prec)}`);
  L.push(`空仓：${emptyAdvice(oc, day, week, prec)}`);
  L.push(`做T：靠近参考压力减，回踩参考支撑接；周线受压时只做小仓位节奏。`);
  L.push('');
  L.push('📈 下一张为多周期技术图，请结合图中结构核对');
  L.push('⚠️ 非投资建议，仅供参考');
  return L.join('\n');
}
function trendQualityExplain(day) {
  const e = day.evidence || {};
  if (e.trendQuality === '无趋势震荡') return 'ADX偏低，均线信号容易反复，优先按区间处理';
  if (e.trendQuality === '趋势形成中') return `${e.trendQuality}，方向需靠关键位确认`;
  return `${e.trendQuality}，${e.dmiDirection}`;
}
function atrExplain(day, price, invalid, prec) {
  const e = day.evidence || {};
  if (!(e.atr > 0) || !(price > 0)) return 'ATR 数据不足';
  const dist = invalid > 0 ? (price - invalid) / e.atr : null;
  const risk = dist === null ? '' : dist <= 1 ? '，离短线失效不足 1 ATR，容错较小' : dist <= 2 ? `，距短线失效约 ${dist.toFixed(1)} ATR` : `，距短线失效约 ${dist.toFixed(1)} ATR`;
  return `ATR14 ${fpBy(e.atr, prec)}（约 ${fpBy(e.atrPct, 2)}%）${risk}`;
}
function volumeTrendExplain(day) {
  const t = day.evidence?.volumeTrend;
  if (!t) return '数据不足';
  const ratio = t.ma20 > 0 ? t.ratio.toFixed(2) : '-';
  return `${t.state}（5日均量 / 20日均量 ${ratio}）${day.volumeUsable ? '' : '；当前周期量能待收线'}`;
}
function relativeStrengthLines(relative) {
  const fmt = v => v === null || v === undefined || !isFinite(v) ? '-' : pct(v);
  if (!relative) return ['· 相对沪深300：基准数据暂不可用。'];
  const rs = relative.vs300 || {};
  return [`· 相对沪深300：${relative.state}；5/20/60日超额 ${fmt(rs[5])} / ${fmt(rs[20])} / ${fmt(rs[60])}`];
}
function buildOneLine(oc, day, week, month) {
  if (oc.state === '结构转弱') return `日线/周线存在结构破坏风险，先按控风险处理，重新站回关键位后再评估。`;
  if (oc.state === '弱势反弹') return `月线${month.trend}、周线${week.trend}，日线${day.trend}；短线信号只能按修复看，不视为趋势反转。`;
  if (oc.state === '趋势中的日线整理') return `月线许可、周线趋势仍在，日线处于整理阶段；等待止跌转强，不因短线走弱否定中期结构。`;
  if (oc.state === '趋势可持有') return `月线许可、周线阶段与日线结构大体一致，回踩不破关键位可继续观察。`;
  if (oc.state === '上升趋势中的回踩') return `大结构未坏，日线正在回踩；等缩量止跌或重新转强，不在回踩中提前加仓。`;
  return `月线${month.trend}、周线${week.trend}、日线${day.trend}；多周期未共振，先按区间等待方向确认。`;
}
function periodConclusion(period, a) {
  if (a.priceSignal.type === 'breakout') return `出现放量突破前高，仍需回踩不破再确认有效。`;
  if (a.priceSignal.type === 'breakdown') return a.priceSignal.text.includes('缩量')
    ? `缩量跌破前低，结构仍然转弱，优先控风险。`
    : `出现放量跌破前低，优先控风险，等待重新站回关键位。`;
  if (a.priceSignal.type === 'stall') return `放量滞涨并有上影，冲高回落风险增加。`;
  if (a.priceSignal.type === 'pullback') return `缩量回踩参考区，需等待次级别转强确认。`;
  if (a.priceSignal.type === 'weak_pullback') return `缩量靠近参考区，但趋势仍弱，尚不能视为有效承接。`;
  if (a.trend.includes('上升')) return `结构偏强，回踩均线或中轨不破才继续按强势整理看。`;
  if (a.trend.includes('下降')) return `结构偏弱，反弹先按修复看，站回 MA20 前不算反转。`;
  if (a.divergence) return `出现${a.divergence.strength || ''}${a.divergence.type === 'top' ? '顶' : '底'}背离，仅作动能预警，仍需结构确认。`;
  return `结构偏震荡，等待关键位突破或跌破确认。`;
}
function structureExplain(a, prec) {
  const l = a.levels || {};
  if (a.period === 'month') return '月线不画箱体，只作为长期均线、BOLL 与动能参考。';
  const primary = a.period === 'week'
    ? `阶段参考区${fpBy(l.majorLow, prec)}~${fpBy(l.majorHigh, prec)}`
    : `短线参考区${fpBy(l.minorLow, prec)}~${fpBy(l.minorHigh, prec)}`;
  const core = `核心价格带${fpBy(l.centerLow, prec)}~${fpBy(l.centerHigh, prec)}`;
  return `${primary}（${a.period === 'week' ? l.majorState : l.minorState || l.boxState}），${core}（${l.centerState || '中枢不明'}）；近20期压力${fpBy(l.prevHigh20, prec)}，支撑${fpBy(l.prevLow20, prec)}`;
}
function stripPeriod(s) { return String(s || '').replace(/[。；;\s]+$/g, ''); }
function volumeExplain(a) {
  if (!a.volumeUsable) return `${a.volumeNote}，不据此判断资金强弱。`;
  const up = a.chgPct >= 0;
  if (up && a.vRatio >= 1.2) return `上涨配合${a.volState}，突破可信度有所提升。`;
  if (up && a.vRatio < 0.8) return `上涨但缩量，偏修复，持续性仍待确认。`;
  if (!up && a.vRatio >= 1.2) return `下跌伴随${a.volState}，抛压较重，不急着接。`;
  if (!up && a.vRatio < 0.8) return `下跌缩量，不能单独视为承接，仍需看结构低点。`;
  return `量价中性，暂无强方向信号。`;
}
function holderAdvice(oc, day, week, prec) {
  const p = day.pressures[0] ? fpBy(day.pressures[0], prec) : '近期压力';
  const s = day.structuralInvalid ? fpBy(day.structuralInvalid, prec) : '日线结构低点';
  if (oc.state === '结构转弱') return `优先控制风险；重新站回 ${p} 前不急于加仓，跌破 ${s} 严格执行风控。`;
  if (oc.state === '弱势反弹') return `反弹到 ${p} 附近观察量能，缩量冲高可减；跌破 ${s} 不宜硬扛。`;
  if (oc.state.includes('趋势')) return `趋势未破可持有，回踩 ${s} 上方企稳再观察；放量跌破则减仓。`;
  return `按区间管理，靠近 ${p} 谨慎，回踩 ${s} 附近只观察承接，不提前加仓。`;
}
function emptyAdvice(oc, day, week, prec) {
  const s = day.supports[0] ? fpBy(day.supports[0], prec) : '参考支撑';
  const p = day.pressures[0] ? fpBy(day.pressures[0], prec) : '确认位';
  if (oc.state === '结构转弱') return `不接破位，至少等重新站回 ${p} 且结构稳定后再评估。`;
  if (oc.state === '弱势反弹') return `不追反弹；等放量站回 ${p}，或在 ${s} 附近出现明确止跌再评估。`;
  if (oc.state.includes('趋势')) return `等回踩 ${s} 后缩量企稳或重新转强，不追高。`;
  return `等靠近 ${s} 的止跌确认，或放量突破 ${p} 后再决定。`;
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
  const chartState = { '趋势可持有': 'TREND', '上升趋势中的回踩': 'PULLBACK', '趋势中的日线整理': 'TREND PAUSE', '区间震荡': 'RANGE', '弱势反弹': 'REBOUND', '结构转弱': 'RISK' }[oc.state] || 'WATCH';
  ctx.fillStyle = sub; ctx.font = '14px cjk'; ctx.fillText(`${code.toUpperCase()} · ${chartState}`, PAD + 16, 60);
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
  const volumeLabel = a.volumeUsable ? a.volState : 'VOL PENDING';
  const weeklyZoneTooWide = title === '周线' && a.levels && a.levels.majorWidthPct > 45;
  const zoneLabel = title === '日线'
    ? 'ZONE-D + BAND'
    : title === '周线'
      ? (weeklyZoneTooWide ? 'BAND ONLY' : 'ZONE-W + BAND')
      : 'NO ZONE';
  ctx.fillText(`MA20 ${fpBy(a.ma20, prec)}  ${bollRangeText(a, prec)}  ${volumeLabel}  ${zoneLabel}`, x0 + 130, y0 + 18);
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
      ctx.strokeStyle = stroke; ctx.lineWidth = label === 'ZONE-D' ? 1.6 : 1.2; ctx.setLineDash(dash || []);
      ctx.strokeRect(x1, by, x2 - x1, bh);
      ctx.setLineDash([]);
    }
    const font = label === 'BAND' ? '11px cjk' : label === 'ZONE-D' ? 'bold 11px cjk' : '11px cjk';
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
    // codeflicker-fix: TA-Issue-005/s8jm34fg6nv8n9a7y13u - 每周期只强调一个主参考区，核心带低干扰显示，避免三层箱体重叠遮挡 K 线。
    const primaryIsWeekly = title === '周线';
    const primaryLow = primaryIsWeekly ? lv.majorLow : lv.minorLow;
    const primaryHigh = primaryIsWeekly ? lv.majorHigh : lv.minorHigh;
    const primaryWin = primaryIsWeekly ? (lv.majorWin || 30) : (lv.minorWin || 20);
    const primaryLabel = primaryIsWeekly ? 'ZONE-W' : 'ZONE-D';
    const primaryColor = primaryIsWeekly ? '#b37b00' : '#d48806';
    const primaryWidthPct = primaryLow > 0 ? (primaryHigh - primaryLow) / primaryLow * 100 : Infinity;
    // codeflicker-fix: TA-Issue-006/s8jm34fg6nv8n9a7y13u - 超宽区间只是历史波动背景，不是当前可交易箱体，隐藏以避免误导。
    const maxZoneWidth = primaryIsWeekly ? 45 : 35;
    if (primaryWidthPct <= maxZoneWidth) {
      drawBoxArea(primaryLow, primaryHigh, n - primaryWin - 1, primaryWin, primaryLabel, primaryColor, 'rgba(250, 173, 20, 0.055)', [5, 4], { noRightText: true, railsOnly: true, dropFillIfTall: 0.35, minH: 3 });
    }
    // 核心带只保留半透明横带与简短标签，不再形成第二个重框。
    drawBoxArea(lv.centerLow, lv.centerHigh, n - (lv.coreWin || 20) - 1, lv.coreWin || 20, 'BAND', '#1677ff', 'rgba(22, 119, 255, 0.12)', [], { noRightText: true, railsOnly: true, minH: 2, noRange: true });
  }
  // 上限从 8 放宽到 20：周线只显示 30 根、月线 24 根时，每根间距 50~60px，
  // 若仍按 8px 画会变成"牙签"，K 线实体几乎看不见。
  const cw = Math.max(2, Math.min(20, w / n * 0.58));
  for (let i = 0; i < n; i++) {
    const k = ks[i], isUp = k.close >= k.open, col = isUp ? upC : downC;
    const xx = X(i), yo = Y(k.open), yc = Y(k.close), yh = Y(k.high), yl = Y(k.low);
    const top = Math.min(yo, yc), bodyH = Math.max(1, Math.abs(yo - yc));
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xx, yh); ctx.lineTo(xx, yl); ctx.stroke();
    // codeflicker-fix: UX-Issue-001/kym2we78i4conjtmrmzp
    // A股常用K线语义：上涨红色空心、下跌绿色实心；成交量和MACD仍按原红绿实体色绘制。
    if (isUp) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(xx - cw / 2, top, cw, bodyH);
      ctx.strokeStyle = upC; ctx.lineWidth = 1.35; ctx.strokeRect(xx - cw / 2, top, cw, bodyH);
    } else {
      ctx.fillStyle = downC; ctx.fillRect(xx - cw / 2, top, cw, bodyH);
    }
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
  const [dayK, weekK, monthK, quote, hs300K] = await Promise.all([
    fetchStockKline(code, 'day').catch(() => null),
    fetchStockKline(code, 'week').catch(() => null),
    fetchStockKline(code, 'month').catch(() => null),
    fetchStockQuote(code).catch(() => null),
    fetchStockKline('sh000300', 'day').catch(() => null),
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
  let relative = null;
  if (hs300K && hs300K.length >= 70) {
    relative = buildRelativeStrength(dayK, hs300K);
  }
  const detailText = resolveNotice + buildReport(name, code, quote, all, prec, relative);
  // codeflicker-fix: UX-Issue-001/3eskueweih7vfxxuhb7r
  // 手机端不截断完整分析：所有文字报告排版成第一张长图，技术图作为第二张证据图。
  let img = null, reportImg = null;
  try { reportImg = renderReportCard({ title: `${name} · 多周期分析`, subtitle: `${code.toUpperCase()} · 完整文字报告`, report: detailText }); } catch (e) { console.error('[an] 文字长图生成失败:', e.message); }
  try { img = renderAnPng(code, name, quote, all, prec); }
  catch (e) { console.error('[an] 图表生成失败:', e.message); }
  return { ok: true, text: '', detailText, reportImg, img };
}

module.exports = { cmdAn, analyzePeriod, renderAnPng };
