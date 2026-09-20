// ============================================================
// /t 做T参谋：形态判断 + 分时黄线分析 + T位建议（原理见 T_GUIDE.md）
// ============================================================
const { cacheGet, cacheSet, normStockName, isFundCode } = require('../utils');
const { resolveStockCode, normalizeCode, fetchStockKline, fetchStockMinuteKline, fetchStockQuote, buildAvgLine, calcSMA, calcBOLL } = require('../market');
const { CONFIG } = require('../config');
const { renderReportCard } = require('../report-card');
const { renderStockPng } = require('./stock');

// ── 日线形态判断 ──
function analyzeTDayForm(dayKlines) {
  const closes = dayKlines.map(k => k.close);
  const n = closes.length;
  const sma = (period) => {
    if (n < period) return null;
    const s = closes.slice(-period);
    return s.reduce((a, b) => a + b, 0) / period;
  };
  const ma5 = sma(5), ma10 = sma(10), ma20 = sma(20);
  // BOLL 带宽（最近20根）
  let bollUp = null, bollLow = null, bollMid = ma20 || closes[n - 1], bollWidth = 0;
  if (n >= 20) {
    const slice = closes.slice(-20);
    const mean = slice.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - mean) ** 2, 0) / 20);
    bollMid = mean; bollUp = mean + 2 * sd; bollLow = mean - 2 * sd;
    bollWidth = mean > 0 ? (bollUp - bollLow) / mean * 100 : 0;
  }
  // 形态判断
  let form = 'unclear';
  if (ma5 && ma10 && ma20) {
    const diff = Math.abs(ma5 - ma20) / ma20 * 100;
    if (ma5 > ma10 && ma10 > ma20 && bollWidth > 5) form = 'uptrend';
    else if (ma5 < ma10 && ma10 < ma20 && bollWidth > 5) form = 'downtrend';
    else if (diff < 2.5 && bollWidth < 8) form = 'swing';
    else form = diff < 4 ? 'unclear' : (ma5 > ma20 ? 'uptrend' : 'downtrend');
  }
  const lastClose = closes[n - 1];
  const prevClose = n >= 2 ? closes[n - 2] : 0;
  const ma20Dev = ma20 ? (lastClose - ma20) / ma20 * 100 : 0;
  return { ma5, ma10, ma20, bollUp, bollLow, bollMid, bollWidth, form, ma20Dev, lastClose, prevClose };
}

// ── 分时MACD（同花顺日内口径）──
// 计算方式：只使用当天 1 分钟K线收盘价，参数 12/26/9（同花顺默认）。
// EMA 初始值使用当天第一根K线收盘价，避免跨日缺口污染日内 MACD。
// 返回最新值+完整日内序列；无分时数据时返回 null
function calcMACD(closes) {
  const arr = (closes || []).filter(v => isFinite(v) && v > 0);
  if (!arr.length) return null;
  // 种子：当天第一根 1min K 线收盘价（日内分时口径）
  const seed = arr[0];
  const calcEMA = (data, period) => {
    const k = 2 / (period + 1);
    const out = [];
    let prev = seed;
    for (let i = 0; i < data.length; i++) {
      prev = data[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };
  const emaFast = calcEMA(arr, 12);
  const emaSlow = calcEMA(arr, 26);
  const dif = arr.map((_, i) => emaFast[i] - emaSlow[i]);
  // DEA 信号线参数 9；第一根 DIF=0，因此初始 DEA=0
  const kSignal = 2 / (9 + 1);
  const dea = [];
  let prevDea = 0;
  for (let i = 0; i < dif.length; i++) {
    prevDea = dif[i] * kSignal + prevDea * (1 - kSignal);
    dea.push(prevDea);
  }
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  const last = arr.length - 1;
  return {
    dif: dif[last], dea: dea[last], hist: hist[last],
    prevHist: hist[last - 1] ?? 0,
    series: { dif, dea, hist },
  };
}

function minuteKey(value) {
  const s = String(value || '').replace(/\D/g, '');
  return s.length >= 12 ? s.slice(-4) : s.slice(0, 4);
}

function mergeTMinuteKlines(timeKlines, minuteKlines, quote) {
  const timeline = (timeKlines || []).filter(k => Number(k.close) > 0);
  if (!timeline.length) return [];
  const quoteStamp = String(quote?.time || '').replace(/\D/g, '');
  const targetDate = quoteStamp.length >= 8 ? quoteStamp.slice(0, 8) : String(minuteKlines?.at(-1)?.t || '').replace(/\D/g, '').slice(0, 8);
  const minuteMap = new Map((minuteKlines || []).filter(k => {
    const stamp = String(k.t || '').replace(/\D/g, '');
    return stamp.length < 8 || !targetDate || stamp.slice(0, 8) === targetDate;
  }).map(k => [minuteKey(k.t), k]));
  const quoteMinute = quoteStamp.length >= 12 ? quoteStamp.slice(8, 12) : '';
  return timeline.map(point => {
    const key = minuteKey(point.t);
    const bar = minuteMap.get(key);
    const complete = !quoteMinute || key < quoteMinute || quoteMinute >= '1501';
    // codeflicker-fix: API-Issue-001/ggcwpau782ju8vj8yxvg - OHLC取真实1分钟K，累计额/量与均价字段继续复用timeline。
    return {
      ...point,
      ...(bar ? { open: bar.open, close: bar.close, high: bar.high, low: bar.low, vol: bar.vol } : {}),
      avgPrice: point.avgPrice, cumVol: point.cumVol, cumAmt: point.cumAmt,
      complete,
    };
  });
}

function filterTDisplayKlines(code, timeKlines) {
  const arr = (timeKlines || []).filter(k => Number(k.close) > 0);
  if (code && code.startsWith('hf_')) return arr;
  return arr.filter(k => {
    const t = String(k.t).replace(':', '');
    return t >= '0930' && t <= '1500';
  });
}

// ── MACD状态解读：金叉/死叉 + 顶/底背离 + 柱体趋势 ──
function analyzeMACDState(macd, closes, tickSize = 0.01) {
  if (!macd) return null;
  const { series, dif, dea, hist } = macd;
  const d = series.dif, e = series.dea, h = series.hist;
  let cross = 'none', crossIndex = -1;
  for (let i = d.length - 1; i >= 1; i--) {
    if (d[i - 1] < e[i - 1] && d[i] >= e[i]) { cross = 'gold'; crossIndex = i; break; }
    if (d[i - 1] >= e[i - 1] && d[i] < e[i]) { cross = 'dead'; crossIndex = i; break; }
  }
  const crossAge = crossIndex >= 0 ? d.length - 1 - crossIndex : null;
  if (crossAge !== null && crossAge > 10) { cross = 'none'; crossIndex = -1; }
  // codeflicker-fix: LOGIC-Issue-006/ggcwpau782ju8vj8yxvg - 仅最近10个分钟保留“交叉”事件语义。
  // 背离检测：取最后30根的局部顶/底，对比价格与DIF
  // codeflicker-fix: LOGIC-Issue-007/ggcwpau782ju8vj8yxvg - 背离要求最小价差、DIF差与拐点间隔，过滤最小价位噪声。
  let divergence = null;
  const arr = (closes || []).filter(v => isFinite(v) && v > 0);
  if (arr.length >= 40 && d.length >= 40) {
    const start = arr.length - 30;
    const tops = [], bottoms = [];
    for (let i = start + 1; i < arr.length - 1; i++) {
      if (arr[i] > arr[i - 1] && arr[i] >= arr[i + 1]) tops.push(i);
      if (arr[i] < arr[i - 1] && arr[i] <= arr[i + 1]) bottoms.push(i);
    }
    if (tops.length >= 2) {
      const t1 = tops[tops.length - 2], t2 = tops[tops.length - 1];
      const minMove = Math.max((arr[t1] || 0) * 0.0015, tickSize * 2);
      if (t2 - t1 >= 3 && arr[t2] - arr[t1] >= minMove && d[t1] - d[t2] > Math.max(Math.abs(d[t1]) * 0.05, 1e-6)) divergence = 'top';
    }
    if (!divergence && bottoms.length >= 2) {
      const b1 = bottoms[bottoms.length - 2], b2 = bottoms[bottoms.length - 1];
      const minMove = Math.max((arr[b1] || 0) * 0.0015, tickSize * 2);
      if (b2 - b1 >= 3 && arr[b1] - arr[b2] >= minMove && d[b2] - d[b1] > Math.max(Math.abs(d[b1]) * 0.05, 1e-6)) divergence = 'bottom';
    }
  }
  const prevH = h[h.length - 2] ?? 0, currH = h[h.length - 1] ?? 0;
  // codeflicker-fix: LOGIC-Issue-003/ggcwpau782ju8vj8yxvg - 同色柱按绝对值比较，跨零轴单独标记。
  const histTrend = h.length <= 1 ? 'flat'
    : prevH * currH < 0 ? (currH >= 0 ? 'turn_red' : 'turn_green')
      : Math.abs(currH) >= Math.abs(prevH) ? 'expand' : 'shrink';
  const zeroAbove = dif > 0 && dea > 0;
  const crossLevel = crossIndex >= 0 ? (d[crossIndex] + e[crossIndex]) / 2 : (dif + dea) / 2;
  const crossZone = crossLevel >= 0 ? 'water_up' : 'water_down';
  const crossText = cross === 'gold'
    ? (crossZone === 'water_up' ? '水上金叉' : '水下金叉')
    : cross === 'dead'
      ? (crossZone === 'water_up' ? '水上死叉' : '水下死叉')
      : '无交叉';
  return { dif, dea, hist, cross, crossIndex, crossAge, crossZone, crossText, divergence, histTrend, zeroAbove };
}

// ── 开盘走势场景判断 ──
// 在有 5 分钟以上分时数据后（earlyOpen 阶段），根据缺口方向 × 开盘走向确定做T场景
// 场景定义：
//   gap_up_reversal  — 高开回落：冲高后价格低于今开，T卖出机会在反抽到今开附近
//   gap_up_momentum  — 高开续涨：动量延续，做T风险高，卖出位需大幅上移
//   gap_down_recovery — 低开企稳：恐慌低开后止跌回升，低位T买机会，卖出等反弹至今开附近
//   gap_down_panic   — 低开续跌：单边杀跌，优先减仓，做T极难
//   flat_rising      — 平开走强：无缺口但开盘偏强
//   flat_falling     — 平开走弱：无缺口但开盘偏弱
//   flat_neutral     — 平开震荡：方向未定，等5~10分钟进一步确认
// 参数说明（轨迹维度）：
//   hiFromOpen  — 今日高点相对今开冲高幅度（%）
//   loFromOpen  — 今日低点相对今开下探幅度（%）
//   pullbackPct — 现价从今日高点回落的幅度（%）
//   recoverPct  — 现价从今日低点回升的幅度（%）
//   confirmTh   — 振幅自适应确认阈值 max(0.8%, 振幅×25%)
function _openScenario({ gapPct, openDirPct, pullbackPct, recoverPct, confirmTh, hiFromOpen, loFromOpen }) {
  // ── 轨迹层（最优先，与缺口无关）：先高后走低 / 先低后走高 ──
  // 只要日内真正冲高过（≥1%）且从高点回落超阈值 → 就是"冲高回落"卖出信号
  if (hiFromOpen >= 1 && pullbackPct >= confirmTh) return 'gap_up_reversal';
  if (loFromOpen >= 1 && recoverPct >= confirmTh) return 'gap_down_recovery';
  // ── 缺口层：轨迹不满足时，按缺口方向 × 现价位置分类 ──
  const up = gapPct >= 1, dn = gapPct <= -1;
  const rising = openDirPct > 0.3, falling = openDirPct < -0.3;
  if (up) return falling ? 'gap_up_reversal' : 'gap_up_momentum';
  if (dn) return rising ? 'gap_down_recovery' : 'gap_down_panic';
  if (rising) return 'flat_rising';
  if (falling) return 'flat_falling';
  return 'flat_neutral';
}

// ── 开盘快讯：前 2~3 分钟只识别明确的竞价兑现或恐慌收回 ──
// 这是独立于盘中评分的微观结构；只给小仓建议，不生成完整T位，且不使用MACD。
function analyzeOpenFlash(klines, avgLine, open, gapPct, volRatio) {
  const rows = (klines || []).filter(k => Number(k.close) > 0);
  const n = rows.length;
  const empty = { signal: 'observe', reason: '分钟数据不足', highFromOpen: 0, lowFromOpen: 0, aboveOpen: false, aboveAvg: false, higherLows: false, lowerHighs: false };
  if (n < 2 || n > 3 || !(open > 0)) return empty;
  const last = rows[n - 1];
  const high = Math.max(...rows.map(k => Number(k.high) || 0));
  const low = Math.min(...rows.map(k => Number(k.low) || Infinity));
  const highFromOpen = (high - open) / open * 100;
  const lowFromOpen = (open - low) / open * 100;
  const avg = avgLine && avgLine.length === n ? avgLine[n - 1] : 0;
  const aboveOpen = Number(last.close) >= open;
  const aboveAvg = !(avg > 0) || Number(last.close) >= avg;
  const higherLows = n >= 3 && Number(rows[n - 1].low) > Number(rows[n - 2].low);
  const lowerHighs = n >= 3 && Number(rows[n - 1].high) < Number(rows[n - 2].high);
  // 高开/冲高兑现：先冲高至少0.6%，随后失守今开，并出现降低高点或跌破早盘均价，才允许小仓T出。
  // 前3分钟均价线仍会快速移动，不能要求它与今开同时失守，否则容易错过竞价兑现。
  if ((gapPct >= 0.8 || highFromOpen >= 0.6) && highFromOpen >= 0.6 && !aboveOpen && (lowerHighs || !aboveAvg)) {
    return { signal: 'small_sell', reason: '冲高后失守今开，且降低高点/跌破早盘均价', highFromOpen, lowFromOpen, aboveOpen, aboveAvg, higherLows, lowerHighs };
  }
  // 低开恐慌收回：先下探至少0.6%，再收回今开和早盘均价，才允许小仓买回。
  if ((gapPct <= -0.8 || lowFromOpen >= 0.6) && lowFromOpen >= 0.6 && aboveOpen && aboveAvg) {
    return { signal: 'small_buy', reason: '下探后收回今开与早盘均价', highFromOpen, lowFromOpen, aboveOpen, aboveAvg, higherLows, lowerHighs };
  }
  // 强承接：抬高低点并守住今开/均价，避免在强势开盘过早T出。
  if (aboveOpen && aboveAvg && (higherLows || Number(last.close) >= high * 0.997)) {
    return { signal: 'hold', reason: '承接强，守住今开与早盘均价', highFromOpen, lowFromOpen, aboveOpen, aboveAvg, higherLows, lowerHighs };
  }
  return { signal: 'observe', reason: volRatio > 1.5 ? '放量但方向未定' : '早盘结构尚未明确', highFromOpen, lowFromOpen, aboveOpen, aboveAvg, higherLows, lowerHighs };
}

// ── 分时现状分析 ──
// 三阶段逻辑：
//   preMacd      ：有效分时 ≤ 3 根（约 9:30~9:32）— 不使用 MACD，只看首根实体、均价和量比
//   macdForming  ：4~5 根（约 9:33~9:34）       — 观察首段高低点、均价线、量能和初步5分钟结构，不给T触发
//   macdConfirm  ：6~10 根（约 9:35~9:39）      — 单层价格行为评分决定方向；MACD仅旁路展示
//   盘中          ：有效分时 > 30 根            — 使用黄线方向、轨迹、量能与价格行为；MACD仅旁路展示
function analyzeTTimeData(timeKlines, quote, code = '') {
  const hasTime = !!timeKlines && timeKlines.length >= 2;
  const validKlines = hasTime ? filterTDisplayKlines(code, timeKlines) : [];
  const hasValidTime = validKlines.length >= 2;
  const completeKlines = validKlines.filter(k => k.complete !== false);
  const candleCount = completeKlines.length;
  const preMacd = candleCount <= 3;
  const macdForming = candleCount >= 4 && candleCount <= 5;
  const macdConfirm = candleCount >= 6 && candleCount <= 10;
  const pureAuction = preMacd || macdForming;
  const openPhase = candleCount <= 30;
  const lastPrice = (quote && Number(quote.price) > 0) ? Number(quote.price)
    : (hasValidTime ? validKlines[validKlines.length - 1].close : 0);
  const prevClose = (quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : 0;
  const open = (quote && Number(quote.open) > 0) ? Number(quote.open) : prevClose;
  const avgLine = hasValidTime ? buildAvgLine(validKlines) : null;
  const currentAvg = (avgLine && avgLine.length > 0) ? avgLine[avgLine.length - 1] : 0;
  // 基准价：开盘用今开（黄线不可靠），盘中用黄线
  const baseRef = openPhase ? (open || prevClose || lastPrice) : (currentAvg || lastPrice);
  const avgDev = baseRef > 0 ? (lastPrice - baseRef) / baseRef * 100 : 0;
  // 日内位置
  const dayHigh = (quote && Number(quote.high) > 0) ? Number(quote.high)
    : (hasValidTime ? Math.max(...validKlines.map(k => k.high)) : 0);
  const dayLow = (quote && Number(quote.low) > 0) ? Number(quote.low)
    : (hasValidTime ? Math.min(...validKlines.map(k => k.low)) : 0);
  const range = dayHigh - dayLow;
  const dayPosition = range > 0 ? (lastPrice - dayLow) / range * 100 : 50;
  const amplitude = prevClose > 0 ? range / prevClose * 100 : 0;
  // 量能：开盘用快照量比（竞价量/5日均量）；盘中用近5min vs 前5min
  let volRatio;
  if (hasValidTime && !openPhase) {
    const dn = validKlines.length;
    const rv = validKlines.slice(-5).map(k => k.vol || 0);
    const pv = dn >= 10 ? validKlines.slice(-10, -5).map(k => k.vol || 0) : rv;
    const recentAvgVol = rv.reduce((a, b) => a + b, 0) / rv.length;
    const prevAvgVol = pv.reduce((a, b) => a + b, 0) / pv.length;
    volRatio = prevAvgVol > 0 ? recentAvgVol / prevAvgVol : 1;
  } else {
    volRatio = (quote && Number(quote.volumeRatio) > 0) ? Number(quote.volumeRatio) : 1;
  }
  // 竞价缺口
  const gapPct = prevClose > 0 ? (open - prevClose) / prevClose * 100 : 0;
  // 开盘后走向：现价 vs 今开
  const openDirPct = open > 0 ? (lastPrice - open) / open * 100 : 0;
  // ── 轨迹维度 ──
  // 高点/低点相对今开的冲高/下探幅度（判断"先高后走低"必须先冲高过）
  const hiFromOpen = (open > 0 && dayHigh > open) ? (dayHigh - open) / open * 100 : 0;
  const loFromOpen = (open > 0 && dayLow < open) ? (open - dayLow) / open * 100 : 0;
  // 现价从今日高点回落 / 从今日低点回升的幅度
  const pullbackPct = dayHigh > 0 ? (dayHigh - lastPrice) / dayHigh * 100 : 0;
  const recoverPct = dayLow > 0 ? (lastPrice - dayLow) / dayLow * 100 : 0;
  // ── 振幅自适应确认阈值：波动越大，"冲高回落/低开企稳"的确认门槛越高 ──
  const confirmTh = Math.max(0.8, amplitude * 0.25);
  // ── 分时 MACD：仅当天 1 分钟数据，参数 12/26/9，首根收盘价为 EMA 初始值 ──
  const macdKlines = completeKlines;
  const closesArr = macdKlines.map(k => Number(k.close) || 0);
  const macd = closesArr.length ? calcMACD(closesArr) : null;
  const macdState = macd ? analyzeMACDState(macd, closesArr) : null;
  const priceAction = analyzePriceAction(validKlines, avgLine, lastPrice);
  const openFlash = preMacd ? analyzeOpenFlash(completeKlines, avgLine?.slice(0, completeKlines.length), open, gapPct, volRatio) : null;
  // 开盘场景由价格、量能与轨迹决定；MACD不参与场景识别或触发。
  const openScenario = (!pureAuction && openPhase) ? _openScenario({ gapPct, openDirPct, pullbackPct, recoverPct, confirmTh, hiFromOpen, loFromOpen }) : null;
  // 黄线斜率（近15分钟；开盘阶段无意义）
  let avgSlope = 0;
  if (!openPhase && avgLine && avgLine.length >= 15) {
    const old = avgLine[avgLine.length - 15];
    avgSlope = old > 0 ? (avgLine[avgLine.length - 1] - old) / old * 100 : 0;
  }
  const avgTrend = classifyAvgTrend(avgSlope, openPhase);
  return {
    lastPrice, prevClose, open, currentAvg, avgDev, baseRef, openPhase, pureAuction,
    preMacd, macdForming, macdConfirm,
    gapPct, openDirPct, openScenario, candleCount,
    dayHigh, dayLow, dayPosition, amplitude, volRatio, avgSlope, avgTrend, avgLine, timeKlines,
    pullbackPct, recoverPct, hiFromOpen, loFromOpen, confirmTh, macd, macdState, priceAction, openFlash,
  };
}

// 黄线趋势：累计均价的自然漂移很小，15 分钟变化达到 ±0.12% 才视为有方向，避免噪音频繁切换策略。
const AVG_TREND_THRESHOLD = 0.12;
function classifyAvgTrend(avgSlope, openPhase) {
  if (openPhase || !Number.isFinite(avgSlope)) return 'flat';
  if (avgSlope >= AVG_TREND_THRESHOLD) return 'rising';
  if (avgSlope <= -AVG_TREND_THRESHOLD) return 'falling';
  return 'flat';
}

// ── 波动率基准：近 N 日平均振幅（%）──
// 低波动标的（如红利低波 ETF，日均振幅约 1%）若沿用固定 % 做T阈值，T 区间会远大于当日实际波动，
// 图上价格被压扁、T 线贴边。故按「基准振幅 / 参考振幅」等比缩放做T阈值，且只缩小不放大，
// 保证对原有普通股票（振幅≈参考振幅）行为零影响。
const T_REF_AMP = 2.5;    // 参考振幅：固定阈值（约 1.5/2.8%）所对应的典型日振幅
const T_VOL_FLOOR = 0.35; // 缩放下限，避免低波动标的区间塌成一条线
function calcVolRef(dayKlines) {
  const rows = dayKlines || [];
  const n = rows.length;
  if (n < 2) return 0;
  const start = Math.max(1, n - 10);
  let sum = 0, cnt = 0;
  for (let i = start; i < n; i++) {
    const k = rows[i], p = rows[i - 1];
    if (!k || !p || !(p.close > 0) || !(k.high > 0) || !(k.low > 0)) continue;
    sum += (k.high - k.low) / p.close * 100;
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// ── 日内价格行为主信号：均价线、量能、前高前低、5分钟K结构 ──
// MACD 为滞后指标，仅作为旁路展示；不单独产生买卖触发。
function analyzePriceAction(klines, avgLine, lastPrice) {
  const allRows = (klines || []).filter(k => Number(k.close) > 0);
  // codeflicker-fix: EDGE-Issue-001/ggcwpau782ju8vj8yxvg - 实时价可用当前分钟，量能和K线结构仅使用已完成分钟。
  const completeCount = allRows.filter(k => k.complete !== false).length;
  const rows = allRows.slice(0, completeCount);
  const avgs = (avgLine || []).slice(0, completeCount);
  const n = rows.length;
  const none = { buyScore: 0, sellScore: 0, signal: 'wait', aboveAvg: false, avgBreakUp: false, avgBreakDown: false, retestHold: false, retestFail: false, breakHigh: false, breakLow: false, volBurst: false, volDry: false, fiveMin: 'neutral', priorHigh: 0, priorLow: 0 };
  if (n < 3 || avgs.length !== n) return none;
  const last = rows[n - 1], prev = rows[n - 2];
  const avg = avgs[n - 1], prevAvg = avgs[n - 2];
  const lookback = rows.slice(Math.max(0, n - 21), n - 1);
  const priorHigh = Math.max(...lookback.map(k => Number(k.high) || 0));
  const priorLow = Math.min(...lookback.map(k => Number(k.low) || Infinity));
  const avgBreakUp = prev.close < prevAvg && last.close >= avg;
  const avgBreakDown = prev.close >= prevAvg && last.close < avg;
  const aboveAvg = lastPrice >= (avgLine?.at(-1) || avg);
  // codeflicker-fix: LOGIC-Issue-001/ggcwpau782ju8vj8yxvg - 回踩要求此前连续站在均价线同侧，且与本分钟突破互斥。
  const stoodAbove = n >= 4 && rows.slice(n - 3, n - 1).every((k, i) => k.close >= avgs[n - 3 + i]);
  const stoodBelow = n >= 4 && rows.slice(n - 3, n - 1).every((k, i) => k.close < avgs[n - 3 + i]);
  const retestHold = !avgBreakUp && stoodAbove && last.low <= avg * 1.0015 && last.close >= avg;
  const retestFail = !avgBreakDown && stoodBelow && last.high >= avg * 0.9985 && last.close < avg;
  const breakHigh = priorHigh > 0 && last.close > priorHigh;
  const breakLow = isFinite(priorLow) && last.close < priorLow;
  const vols = rows.map(k => Number(k.vol) || 0);
  const currentVol = vols[n - 1];
  const baseVols = vols.slice(Math.max(0, n - 6), n - 1);
  const baseVol = baseVols.reduce((a, b) => a + b, 0) / Math.max(1, baseVols.length);
  const volBurst = baseVol > 0 && currentVol >= baseVol * 1.8;
  const volDry = baseVol > 0 && currentVol <= baseVol * 0.6;
  const five = rows.slice(Math.max(0, n - 5));
  const fiveOpen = Number(five[0].open) || Number(five[0].close);
  const fiveClose = Number(five[five.length - 1].close);
  const fiveHigh = Math.max(...five.map(k => Number(k.high) || 0));
  const fiveLow = Math.min(...five.map(k => Number(k.low) || Infinity));
  const fiveRange = Math.max(0.0001, fiveHigh - fiveLow);
  const fiveBody = (fiveClose - fiveOpen) / fiveRange;
  const fiveMin = fiveBody >= 0.35 ? 'bull' : fiveBody <= -0.35 ? 'bear' : 'neutral';
  let buyScore = 0, sellScore = 0;
  if (avgBreakUp) buyScore += 2;
  else if (retestHold) buyScore += 1;
  if (breakHigh) buyScore += 2;
  if (fiveMin === 'bull') buyScore += 1;
  if (volBurst && last.close >= avg) buyScore += 1;
  if (avgBreakDown) sellScore += 2;
  else if (retestFail) sellScore += 1;
  if (breakLow) sellScore += 2;
  if (fiveMin === 'bear') sellScore += 1;
  if (volBurst && last.close < avg) sellScore += 1;
  const signal = buyScore >= 3 && buyScore > sellScore ? 'buy' : sellScore >= 3 && sellScore > buyScore ? 'sell' : 'wait';
  return { buyScore, sellScore, signal, aboveAvg, avgBreakUp, avgBreakDown, retestHold, retestFail, breakHigh, breakLow, volBurst, volDry, fiveMin, priorHigh, priorLow, completeCount };
}

// ── 计算T位 ──
// pureAuction：返回 null（上层不渲染T位，只显示竞价分析）
function calcTPositions(activeForm, timeInfo, dayInfo) {
  const { lastPrice, currentAvg, dayLow, dayHigh, openPhase, pureAuction, macdForming, openScenario, open, prevClose, avgTrend = 'flat' } = timeInfo;
  const { bollUp, bollLow } = dayInfo;
  const prec = dayInfo.prec || 2;
  const r2 = v => Math.round(v * 10 ** prec) / 10 ** prec;
  // 波动率自适应：按日均振幅等比缩放做T阈值（只缩小，普通股票不受影响）
  const volRef = dayInfo.volRef > 0 ? dayInfo.volRef : T_REF_AMP;
  const volScale = Math.min(1, Math.max(T_VOL_FLOOR, volRef / T_REF_AMP));
  const isSwing = activeForm === 'swing' || activeForm === 'unclear';

  // ── 纯竞价阶段：数据不足，不给T位 ──
  if (pureAuction || macdForming) return null;

  // ── 开盘模式（6<=分时<=30）：基于「开盘场景 x 日线形态」给动态T位 ──
  if (openPhase) {
    const base = open || prevClose || lastPrice;
    let sellThLow, sellThHigh, buyThHigh, buyThLow;
    switch (openScenario) {
      case 'gap_up_reversal':
        // 高开后回落：冲高回落已确认，反抽今开附近就是T出点
        sellThLow = 0.3; sellThHigh = 1.2;
        buyThHigh = 0.8; buyThLow = 2.0;
        break;
      case 'gap_up_momentum':
        // 高开续涨：动量延续，卖出位大幅上移，别轻易T出踏空
        sellThLow = 2.0; sellThHigh = 4.0;
        buyThHigh = 0.3; buyThLow = 1.0;
        break;
      case 'gap_down_recovery':
        // 低开企稳：恐慌低开已止跌，卖出等反弹至今开附近
        sellThLow = 0.5; sellThHigh = 1.5;
        buyThHigh = 0.3; buyThLow = 1.2;
        break;
      case 'gap_down_panic':
        // 低开续跌：最危险，只要反抽稳就出，买回等量极缩
        sellThLow = 0.0; sellThHigh = 0.8;
        buyThHigh = 2.0; buyThLow = 4.0;
        break;
      case 'flat_rising':
        sellThLow = 1.0; sellThHigh = 2.0;
        buyThHigh = 0.5; buyThLow = 1.5;
        break;
      case 'flat_falling':
        sellThLow = 0.3; sellThHigh = 1.0;
        buyThHigh = 0.8; buyThLow = 2.0;
        break;
      default: // flat_neutral
        sellThLow = 0.5; sellThHigh = 1.5;
        buyThHigh = 0.5; buyThLow = 1.5;
    }
    // 日线形态微调（在场景基础上叠加）
    if (activeForm === 'downtrend') {
      sellThLow = Math.max(0, sellThLow - 0.2);
      sellThHigh = Math.max(sellThLow + 0.3, sellThHigh - 0.3);
      buyThHigh += 0.3; buyThLow += 0.5;
    } else if (activeForm === 'uptrend') {
      sellThLow += 0.3; sellThHigh += 0.5;
      buyThHigh = Math.max(0, buyThHigh - 0.2);
      buyThLow = Math.max(buyThHigh + 0.3, buyThLow - 0.3);
    }
    // 波动率自适应收窄（低波动标的）：等比缩放，保持 sell/buy 不等式关系不变
    sellThLow *= volScale; sellThHigh *= volScale;
    buyThHigh *= volScale; buyThLow *= volScale;
    const sellLow = r2(base * (1 + sellThLow / 100));
    const thresholdSellHigh = r2(base * (1 + sellThHigh / 100));
    // codeflicker-fix: LOGIC-Issue-002/ggcwpau782ju8vj8yxvg - BOLL低于卖区起点时不反向压低上界。
    const sellHigh = r2(bollUp > sellLow ? Math.min(bollUp, thresholdSellHigh) : thresholdSellHigh);
    const buyHigh = r2(base * (1 - buyThHigh / 100));
    const buyLowByDev = r2(base * (1 - buyThLow / 100));
    const buyLow = r2(dayLow > 0 && dayLow < buyHigh ? Math.max(dayLow, buyLowByDev) : buyLowByDev);
    const inSellZone = lastPrice >= sellLow;
    const inBuyZone = lastPrice <= buyHigh;
    const expectedTDiff = ((sellHigh - buyLow) / base * 100).toFixed(1);
    // codeflicker-fix: MAINT-Issue-001/ggcwpau782ju8vj8yxvg - 保留基础阈值、形态、缩放和BOLL约束轨迹便于排查。
    const thresholdTrace = { base, volRef, volScale, activeForm, openScenario, sellPct: [sellThLow, sellThHigh], buyPct: [buyThLow, buyThHigh], bollCapApplied: bollUp > sellLow && bollUp < thresholdSellHigh };
    return { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone, inNeutral: !inSellZone && !inBuyZone, expectedTDiff, base, prec, openPhase, openScenario, confirmTh: timeInfo.confirmTh, pullbackPct: timeInfo.pullbackPct, recoverPct: timeInfo.recoverPct, macdState: timeInfo.macdState, macd: timeInfo.macd, thresholdTrace };
  }

  // ── 盘中模式：基准=黄线 ──
  const base = currentAvg > 0 ? currentAvg : lastPrice;
  // 黄线方向优先：下行时把卖出位贴近黄线、买回位仅作止跌观察；
  // 上行时上移兑现区、买回位靠近黄线，避免在趋势里机械高抛低吸。
  let sellThLow = (isSwing ? 1.5 : 0.8) * volScale;
  let sellThHigh = (isSwing ? 2.8 : 1.5) * volScale;
  let buyThHigh = (isSwing ? 0.8 : 0.3) * volScale;
  let buyThLow = (isSwing ? 1.8 : 1.0) * volScale;
  if (avgTrend === 'falling') {
    sellThLow = 0.35 * volScale;
    sellThHigh = 1.05 * volScale;
    buyThHigh = 0.9 * volScale;
    buyThLow = 2.0 * volScale;
  } else if (avgTrend === 'rising') {
    sellThLow = 1.45 * volScale;
    sellThHigh = 2.65 * volScale;
    buyThHigh = 0.15 * volScale;
    buyThLow = 0.65 * volScale;
  }
  const sellLow = r2(base * (1 + sellThLow / 100));
  const thresholdSellHigh = r2(base * (1 + sellThHigh / 100));
  const sellHigh = r2(bollUp > sellLow ? Math.min(bollUp, thresholdSellHigh) : thresholdSellHigh);
  // buyLow < buyHigh 始终成立；下行趋势中该区域只代表止跌观察，非自动买点。
  const buyHigh = r2(base * (1 - buyThHigh / 100));
  const buyLowByDev = r2(base * (1 - buyThLow / 100));
  // dayLow 做地板只在它严格低于 buyHigh 时有意义，否则忽略（避免 buyLow > buyHigh）
  const buyLow = r2(dayLow > 0 && dayLow < buyHigh ? Math.max(dayLow, buyLowByDev) : buyLowByDev);
  // 当前位置
  const inSellZone = lastPrice >= sellLow;
  const inBuyZone = lastPrice <= buyHigh;
  const expectedTDiff = ((sellHigh - buyLow) / base * 100).toFixed(1);
  const thresholdTrace = { base, volRef, volScale, activeForm, avgTrend, sellPct: [sellThLow, sellThHigh], buyPct: [buyThLow, buyThHigh], bollCapApplied: bollUp > sellLow && bollUp < thresholdSellHigh };
  return { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone, inNeutral: !inSellZone && !inBuyZone, expectedTDiff, base, prec, avgTrend, macd: timeInfo.macd, macdState: timeInfo.macdState, confirmTh: timeInfo.confirmTh, thresholdTrace };
}

// ── 操作建议证据：只展示本次结论用到的事实；MACD始终标注为旁路，不承担触发。 ──
function buildTActionEvidence(timeInfo, tPos) {
  const { avgTrend = 'flat', avgSlope = 0, priceAction, volRatio, macdState, openPhase, pureAuction } = timeInfo;
  if (pureAuction) return '证据：开盘数据不足，等待首段高低点、均价线与量能结构';
  const trendLabel = openPhase ? '开盘阶段（黄线暂不判方向）'
    : `${avgTrend === 'rising' ? '黄线上行' : avgTrend === 'falling' ? '黄线下行' : '黄线走平'} ${avgSlope >= 0 ? '+' : ''}${Number(avgSlope).toFixed(2)}%`;
  const zoneLabel = !tPos ? '未生成T区' : tPos.inSellZone ? '卖出区' : tPos.inBuyZone ? '买回区' : '中性区';
  const pa = priceAction || {};
  const volumeLabel = Number.isFinite(volRatio) ? `近5分量 ${volRatio.toFixed(1)}×` : '量能待确认';
  const macdLabel = !macdState ? 'MACD待形成'
    : macdState.cross === 'gold' ? 'MACD金叉（辅助）'
      : macdState.cross === 'dead' ? 'MACD死叉（辅助）'
        : `${macdState.hist >= 0 ? 'MACD红柱' : 'MACD绿柱'}（辅助）`;
  return `证据：${trendLabel}｜${zoneLabel}｜买${pa.buyScore || 0}/卖${pa.sellScore || 0}分｜${volumeLabel}｜${macdLabel}`;
}

// ── 最终操作建议：唯一决策入口，文字长图与技术图必须共用，避免展示层各自判断。 ──
function resolveTAction(timeInfo, tPos) {
  const { lastPrice, openPhase, pureAuction, openScenario, priceAction, avgTrend = 'flat' } = timeInfo;
  const signal = priceAction?.signal || 'wait';
  const evidence = buildTActionEvidence(timeInfo, tPos);
  const downtrendT = !openPhase && avgTrend === 'falling';
  const uptrendT = !openPhase && avgTrend === 'rising';
  const fmt = value => Number.isFinite(value) ? Number(value).toFixed(tPos?.prec ?? 2) : '-';

  const withEvidence = action => ({ ...action, evidence });
  if (pureAuction || !tPos) {
    return withEvidence({ kind: 'wait', color: '#8a919c', title: '开盘观察：暂不生成完整T位', detail: '等待首段高低点、均价线与量能结构完成' });
  }
  const { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone } = tPos;
  if (openPhase && openScenario === 'gap_down_panic') {
    return withEvidence({ kind: 'risk', color: '#f5222d', title: '低开续跌：优先防守，暂不做T', detail: '等缩量止跌、5分钟转强并重新站回均价线' });
  }
  // 位置约束优先：不在买回区追卖，也不在卖出区追买。
  if (signal === 'sell' && inBuyZone) {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '买回区内走弱：不追卖', detail: `等待反弹到卖出区 ${fmt(sellLow)} ~ ${fmt(sellHigh)} 再确认` });
  }
  if (signal === 'buy' && inSellZone) {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '卖出区内转强：不追买', detail: `等待回落到买回区 ${fmt(buyLow)} ~ ${fmt(buyHigh)} 再确认` });
  }
  // 黄线方向是位置之后的过滤器：下行不逆势接回，上行不在区间外追卖。
  if (signal === 'buy' && downtrendT) {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '黄线下行：暂不逆势买回', detail: '买回区仅作止跌观察，等黄线走平/上拐并站稳' });
  }
  if (signal === 'sell' && uptrendT && !inSellZone) {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '黄线上行：暂不因回落追卖', detail: `等待进入兑现区 ${fmt(sellLow)} ~ ${fmt(sellHigh)} 再确认` });
  }
  // 价格行为只在匹配区间内给交易许可；中性区信号只记录方向，等待位置。
  if (signal === 'sell' && inSellZone) {
    return withEvidence({ kind: 'sell', color: '#f5222d', title: '价格行为确认：可分批T出 / 减仓', detail: `当前在卖出区 ${fmt(sellLow)} ~ ${fmt(sellHigh)}，空头结构已共振` });
  }
  if (signal === 'buy' && inBuyZone) {
    return withEvidence({ kind: 'buy', color: '#0aa869', title: '价格行为确认：可分批买回', detail: `当前在买回区 ${fmt(buyLow)} ~ ${fmt(buyHigh)}，止跌/转强结构已共振` });
  }
  if (signal === 'sell') {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '短线走弱：不追卖', detail: `现价未进卖出区，等反弹到 ${fmt(sellLow)} ~ ${fmt(sellHigh)}` });
  }
  if (signal === 'buy') {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '短线转强：不追买', detail: `现价未进买回区，等回踩到 ${fmt(buyLow)} ~ ${fmt(buyHigh)}` });
  }
  if (inSellZone) {
    return withEvidence({ kind: 'wait', color: '#fa8c16', title: '进入卖出参考区：等待走弱确认', detail: '观察反抽均价线失败、跌破前低、5分钟转阴或量能转弱' });
  }
  if (inBuyZone) {
    return downtrendT
      ? withEvidence({ kind: 'wait', color: '#fa8c16', title: '进入止跌观察区：暂不接回', detail: '黄线仍下行，等待走平/上拐、站回均价线和5分钟转强' })
      : withEvidence({ kind: 'wait', color: '#fa8c16', title: '进入买回参考区：等待转强确认', detail: '等待均价线突破/回踩、量能与5分钟结构共振' });
  }
  return withEvidence({ kind: 'wait', color: '#8a919c', title: '中性区间：持有观察', detail: '等待价格进入买卖区，再由价格行为确认' });
}

// ── 生成文字报告（教学式）──
// tPos 可能为 null（纯竞价阶段），需特殊处理
function buildTReport(name, code, autoForm, userFormRaw, timeInfo, dayInfo, tPos, resolvedAction = null) {
  const { lastPrice, currentAvg, avgDev, dayHigh, dayLow, dayPosition, volRatio, amplitude,
          avgSlope, avgTrend, openPhase, pureAuction, preMacd, macdForming, macdConfirm, open, gapPct, openDirPct, openScenario, candleCount,
          pullbackPct, recoverPct, hiFromOpen, loFromOpen, confirmTh, macd, macdState, priceAction, openFlash } = timeInfo;
  const { ma5, ma10, ma20, bollUp, bollLow, bollMid, bollWidth } = dayInfo;
  const now = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
  const isETF = isFundCode(code);
  const feeCfg = { ...CONFIG.tFees };
  const feeRate = isETF ? feeCfg.fundRoundTripRate * 100
    : (feeCfg.stockCommissionRate * 2 + feeCfg.stockStampDutyRate + feeCfg.stockTransferRate) * 100;
  const ampWarnTh = isETF ? 0.08 : 0.45;
  const ampCautionTh = isETF ? 0.20 : 0.80;
  const prec = dayInfo.prec || 2;
  const fp = v => isFinite(v) && v !== null ? Number(v).toFixed(prec) : '-';
  const fpp = v => isFinite(v) && v !== null ? Number(v).toFixed(2) : '-'; // 百分比固定 2 位
  const fpct = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  const FORM_LABEL = { uptrend: '上升单边', downtrend: '下降单边', swing: '震荡区间', unclear: '趋势不明' };
  const FORM_EMOJI = { uptrend: '📈', downtrend: '📉', swing: '〰️', unclear: '❓' };
  const SCENARIO_LABEL = {
    gap_up_reversal:  '🔻 高开回落',
    gap_up_momentum:  '🚀 高开续涨',
    gap_down_recovery:'🟢 低开企稳',
    gap_down_panic:   '🔴 低开续跌',
    flat_rising:      '↗️ 平开走强',
    flat_falling:     '↘️ 平开走弱',
    flat_neutral:     '➡️ 平开震荡',
  };
  const userFormLabel = userFormRaw === 'swing' ? '震荡' : userFormRaw === 'trend' ? '单边趋势' : null;
  const activeForm = userFormRaw === 'swing' ? 'swing' : userFormRaw === 'trend' ?
    (autoForm === 'uptrend' || autoForm === 'downtrend' ? autoForm : 'unclear') : autoForm;
  const hasTData = !!timeInfo.timeKlines && timeInfo.timeKlines.length >= 2;

  // 仅在有T位时解构
  const sellLow = tPos ? tPos.sellLow : 0;
  const sellHigh = tPos ? tPos.sellHigh : 0;
  const buyLow = tPos ? tPos.buyLow : 0;
  const buyHigh = tPos ? tPos.buyHigh : 0;
  const inSellZone = tPos ? tPos.inSellZone : false;
  const inBuyZone = tPos ? tPos.inBuyZone : false;
  const inNeutral = tPos ? tPos.inNeutral : true;
  const tTrend = tPos?.avgTrend || avgTrend || 'flat';
  // 模式必须在价格行为说明前确定；后续仅用于过滤操作，不替代价格位置与结构确认。
  const downtrendT = !openPhase && tTrend === 'falling';
  const uptrendT = !openPhase && tTrend === 'rising';
  const AVG_TREND_LABEL = { rising: '↗️ 黄线上行', falling: '↘️ 黄线下行', flat: '➡️ 黄线走平' };
  const avgSlopeText = !openPhase && currentAvg > 0 ? `近15分钟 ${avgSlope >= 0 ? '+' : ''}${avgSlope.toFixed(2)}%` : '开盘阶段暂不判定';
  // 实际阈值（用于文案）：随波动率自适应缩放，不能写死
  const tBase = (tPos && tPos.base > 0) ? tPos.base : (currentAvg > 0 ? currentAvg : lastPrice);
  const sellDevPct = tBase > 0 ? (sellLow - tBase) / tBase * 100 : 0;
  const buyDevPct = tBase > 0 ? (tBase - buyHigh) / tBase * 100 : 0;

  const L = [];
  L.push(`📊 ${name}（${code.toUpperCase()}）做T参考  ${now}`);
  L.push('');

  // ── 形态判断 ──
  L.push('━━━ 形态判断 ━━━');
  L.push(`🤖 机器人判断：${FORM_EMOJI[autoForm]} ${FORM_LABEL[autoForm]}`);
  if (userFormLabel) {
    if ((userFormRaw === 'swing' && (autoForm === 'uptrend' || autoForm === 'downtrend')) ||
        (userFormRaw === 'trend' && autoForm === 'swing')) {
      L.push(`⚠️ 你指定了「${userFormLabel}」，与机器人判断（${FORM_LABEL[autoForm]}）不同，注意额外风险！`);
    } else {
      L.push(`✅ 你指定「${userFormLabel}」，与机器人判断一致`);
    }
  }
  L.push('【判断依据】');
  if (ma5 && ma20) {
    const diff = Math.abs(ma5 - ma20) / ma20 * 100;
    if (autoForm === 'uptrend') {
      L.push(`· MA5(${fp(ma5)}) > MA10(${fp(ma10)}) > MA20(${fp(ma20)})，多头排列`);
      L.push(`· BOLL带宽${bollWidth.toFixed(1)}%，通道扩张，上涨动能在延续`);
    } else if (autoForm === 'downtrend') {
      L.push(`· MA5(${fp(ma5)}) < MA10(${fp(ma10)}) < MA20(${fp(ma20)})，空头排列`);
      L.push(`· BOLL带宽${bollWidth.toFixed(1)}%，下行压力持续`);
    } else if (autoForm === 'swing') {
      L.push(`· MA5(${fp(ma5)}) ≈ MA20(${fp(ma20)})，均线粘合，差距仅${diff.toFixed(1)}%`);
      L.push(`· BOLL带宽${bollWidth.toFixed(1)}%（<8%=收窄），价格在区间内震荡`);
    } else {
      L.push(`· MA5(${fp(ma5)}) / MA20(${fp(ma20)}) 差距${diff.toFixed(1)}%，方向不明朗`);
      L.push(`· BOLL带宽${bollWidth.toFixed(1)}%，趋势特征不明显`);
    }
  }
  if (bollUp && bollLow) L.push(`· BOLL区间 ${fp(bollLow)} ~ ${fp(bollUp)}（中轨 ${fp(bollMid)}）`);
  L.push('');

  // ── 竞价 / 分时现状 ──
  L.push('━━━ 分时现状 ━━━');
  const gapTxt = gapPct > 1 ? `高开 +${gapPct.toFixed(2)}%` : gapPct < -1 ? `低开 ${gapPct.toFixed(2)}%` : `平开 ${gapPct.toFixed(2)}%`;

  if (pureAuction) {
    // ── 前 3 分钟开盘快讯 / 3~5 分钟观察 ──
    const first = timeInfo.timeKlines && timeInfo.timeKlines[0];
    const firstDir = first ? (first.close >= first.open ? '首根实体偏强' : '首根实体偏弱') : '首根实体待确认';
    L.push(`🔔 竞价结果：今开 ${fp(open)}（${gapTxt}）  /  量比 ${volRatio.toFixed(1)}  /  现价 ${fp(lastPrice)}`);
    L.push('');
    if (gapPct > 2) {
      L.push(`📈 高开 +${gapPct.toFixed(1)}%，竞价资金积极抢筹`);
      if (volRatio > 1.5) L.push(`   🔥 量比 ${volRatio.toFixed(1)}（放量），情绪偏多，防冲高回落`);
      else L.push(`   ⚠️ 量比 ${volRatio.toFixed(1)} 一般，高开无放量支撑，警惕开盘直接回落`);
      L.push(`   💡 开盘策略：等开盘后5分钟确认方向`);
      L.push(`      · 若继续涨（放量突破今开）→ 动量延续，暂持，不急于T出`);
      L.push(`      · 若冲高后回落（缩量）→ 冲高回落确认，是T出良机`);
    } else if (gapPct > 0.5) {
      L.push(`📈 小幅高开 +${gapPct.toFixed(1)}%，方向待确认`);
      L.push(`   💡 等开盘后5分钟看量价配合再操作`);
    } else if (gapPct < -2) {
      L.push(`📉 低开 ${gapPct.toFixed(1)}%，竞价恐慌情绪`);
      if (volRatio > 1.5) L.push(`   ⚠️ 量比 ${volRatio.toFixed(1)} 放量低开，可能继续下探，买回需等量缩企稳`);
      else L.push(`   💡 量比 ${volRatio.toFixed(1)} 正常，缩量低开常有修复，等开盘方向确认`);
      L.push(`   💡 开盘策略：`);
      L.push(`      · 若低开后止跌缩量回升 → 恐慌已释放，是低位T买机会`);
      L.push(`      · 若低开后放量继续跌 → 单边下跌，不接，优先减仓`);
    } else if (gapPct < -0.5) {
      L.push(`📉 小幅低开 ${gapPct.toFixed(1)}%，方向待确认`);
      L.push(`   💡 等开盘后5分钟看量价配合再操作`);
    } else {
      L.push(`➡️ 平开（${gapTxt}），无方向性缺口`);
      L.push(`   💡 平开看开盘后走势与量能，再判断T方向`);
    }
    if (preMacd && openFlash) {
      const flash = openFlash;
      const hiTxt = flash.highFromOpen > 0 ? `最高较今开 +${fpp(flash.highFromOpen)}%` : '';
      const loTxt = flash.lowFromOpen > 0 ? `最低较今开 -${fpp(flash.lowFromOpen)}%` : '';
      L.push(`━━━ 开盘快讯（前${candleCount}分钟）━━━`);
      L.push(`→ ${[hiTxt, loTxt].filter(Boolean).join(' / ') || '首段振幅有限'}；${flash.reason}`);
      if (flash.signal === 'small_sell') {
        L.push(`🔴 小仓T出：高开/冲高兑现后失守今开，且出现降低高点或跌破早盘均价，建议仅用老仓的 10%~15% 先做T出。`);
        L.push(`   若重新站回今开或早盘均价，停止继续卖出；不使用MACD作为条件。`);
      } else if (flash.signal === 'small_buy') {
        L.push(`🟢 小仓买回：低开下探后同时收回今开和早盘均价，建议仅用预留T仓的 10%~15% 买回。`);
        L.push(`   若再次失守今开或早盘均价，停止继续买入；不使用MACD作为条件。`);
      } else if (flash.signal === 'hold') {
        L.push(`🟡 持有观察：早盘承接强，守住今开与均价，避免过早T出造成踏空。`);
      } else {
        L.push(`⏳ 暂不操作：开盘结构未明确，等待第4~5分钟形成更完整的高低点和量能关系。`);
      }
      L.push(`   注：这是开盘快讯，只给小仓方向，不生成完整盘中T区间。`);
    }
    L.push('');
    L.push(`⏰ 当前有效分时 ${candleCount} 根，${preMacd ? '前3分钟：以开盘快讯识别竞价兑现、恐慌收回或强承接；MACD不参与' : `3~5分钟：${firstDir}，观察首段高低点、均价线、量能和初步5分钟结构，暂不触发做T`}`);
    L.push(`   ${preMacd ? '第4~5分钟继续观察；第6根分钟K起启用单层价格行为评分。' : '第6根分钟K起启用单层价格行为评分。'}`);
    L.push(`   📉 分时MACD：当天1分钟K线(12,26,9)，首根收盘价为EMA初始值，仅作辅助参考`);
    L.push('');
    L.push(`下一张为技术图，请结合图中结构核对`);
    L.push(`⚠️ 非投资建议，仅供参考，请结合自身判断操作`);
    return L.join('\n');
  }

  if (openPhase) {
    // ── 开盘阶段（5~30根）：已有走势方向，显示场景判断 ──
    const dirTxt = openDirPct > 0.3 ? `开盘后走强 ${fpct(openDirPct)}（vs今开）`
      : openDirPct < -0.3 ? `开盘后走弱 ${fpct(openDirPct)}（vs今开）`
      : `开盘后震荡（vs今开 ${fpct(openDirPct)}）`;
    L.push(`今开 ${fp(open)}（${gapTxt}）  现价 ${fp(lastPrice)}  量比 ${volRatio.toFixed(1)}`);
    L.push(`→ ${dirTxt}`);
    if (openScenario) L.push(`→ 开盘场景：${SCENARIO_LABEL[openScenario] || openScenario}`);
    // 轨迹数据：冲高/下探 + 回落/回升
    if (hiFromOpen >= 0.5 || loFromOpen >= 0.5) {
      const trajBits = [];
      if (hiFromOpen >= 0.5) trajBits.push(`高点较今开冲高 ${fpp(hiFromOpen)}%`);
      if (loFromOpen >= 0.5) trajBits.push(`低点较今开下探 ${fpp(loFromOpen)}%`);
      L.push(`→ 轨迹：${trajBits.join(' / ')}，现价自高点回落 ${fpp(pullbackPct)}%（确认阈值 ${fpp(confirmTh)}%）`);
      L.push(`   💡 确认阈值 = max(0.8%, 今日振幅${fpp(amplitude)}% × 25%)——波动越大的票，回落要越深才当真`);
    }
    // 场景解读
    switch (openScenario) {
      case 'gap_up_reversal':
        L.push(`   📍 冲高回落确认：${hiFromOpen >= 1 ? `已冲高 ${fpp(hiFromOpen)}%` : '高开后走弱'}，从高点回落 ${fpp(pullbackPct)}% ≥ 阈值${fpp(confirmTh)}%`);
        L.push(`      回落 ${volRatio > 1.5 ? `放量（量比${volRatio.toFixed(1)}）→ 出货真实，T出信号强` : `缩量/平量（量比${volRatio.toFixed(1)}）→ 可能是洗盘，卖出位设高一点`}`);
        L.push(`      若反抽到今开附近，正是T出好时机`);
        break;
      case 'gap_up_momentum':
        L.push(`   🚀 高开续涨：动量延续中，做T踏空风险高`);
        L.push(`      → 高开后未出现≥${fpp(confirmTh)}%的回落，说明还在强势区`);
        L.push(`      追高买入成本太高；T出后若继续涨难以追回`);
        L.push(`      建议：耐心等明显冲高（今开+2%以上）才T出，别急`);
        break;
      case 'gap_down_recovery':
        L.push(`   🟢 低开企稳：${loFromOpen >= 1 ? `已下探 ${fpp(loFromOpen)}% 后回升 ${fpp(recoverPct)}%` : '低开后止跌回升'}，恐慌释放，多头在接`);
        L.push(`      回升 ${volRatio < 0.8 ? `缩量（量比${volRatio.toFixed(1)}）→ 抛压枯竭，买回信号强` : `量能尚可（量比${volRatio.toFixed(1)}）→ 等回踩确认`}`);
        L.push(`      若再回踩今开附近且缩量，是T买回的机会`);
        break;
      case 'gap_down_panic':
        L.push(`   🔴 低开续跌中：最危险场景，做T极难`);
        L.push(`      → 未出现≥${fpp(confirmTh)}%的有效回升，买方力量不足`);
        if (volRatio > 1.5) L.push(`   ⚠️ 放量下跌（量比${volRatio.toFixed(1)}），优先考虑减仓而非做T`);
        else L.push(`   💡 虽缩量但仍在低点附近，别急着抄底；等缩量止跌、5分钟结构转强并站回均价线`);
        break;
      case 'flat_rising':
        L.push(`   ↗️ 平开后走强，有发力苗头，T出位上移`);
        break;
      case 'flat_falling':
        L.push(`   ↘️ 平开后走弱，T卖出位相应下移，别等太高`);
        break;
      default:
        L.push(`   ➡️ 方向尚不明朗，等进一步确认（建议等到9:40后再操作）`);
    }
    L.push(`   ⏰ 开盘约 ${candleCount} 分钟，黄线参考价值有限，T位基于今开+走势判断`);
  } else if (currentAvg > 0) {
    // ── 盘中模式 ──
    L.push(`现价 ${fp(lastPrice)}  /  黄线均价 ${fp(currentAvg)}  /  偏离 ${fpct(avgDev)}`);
    L.push(`→ 黄线趋势：${AVG_TREND_LABEL[tTrend]}（${avgSlopeText}）`);
    const devLabel = Math.abs(avgDev) < 0.5 ? '均值附近，T的空间有限'
      : avgDev > 2 ? (uptrendT ? '明显偏高，接近上行黄线兑现区' : '明显偏高，接近T卖出窗口区')
      : avgDev > 0.5 ? (uptrendT ? '轻微偏高，上行趋势中先持有观察' : '轻微偏高，可准备挂卖单等待')
      : avgDev < -2 ? (downtrendT ? '明显偏低，但黄线下行仅作止跌观察' : '明显偏低，接近T买回窗口区')
      : (downtrendT ? '轻微偏低，黄线下行中不急于接回' : '轻微偏低，接近买回区域');
    L.push(`→ 【${devLabel}】`);
    L.push(`   💡 黄线 = 今日所有成交的加权均价。现价高于黄线表示平均持仓浮盈，低于黄线表示平均持仓浮亏；它是日内成本参考，不单独构成买卖理由。`);
  } else {
    L.push(`现价 ${fp(lastPrice)}（盘后/非交易时段，无实时分时数据，以日线数据为参考）`);
  }
  if (macdConfirm) {
    L.push(`→ ⏱ 开盘第6~10分钟：单层价格行为评分（均价线、量能、前高前低、5分钟K）决定是否给出做T建议；MACD仅同步显示。`);
  }
  // ── 价格行为主信号：均价线 + 量能 + 前高前低 + 5分钟结构 ──
  if (priceAction) {
    const pa = priceAction;
    const fiveTxt = pa.fiveMin === 'bull' ? '阳线结构' : pa.fiveMin === 'bear' ? '阴线结构' : '震荡结构';
    const volumeTxt = pa.volBurst ? '量能突增' : pa.volDry ? '量能收缩' : '量能平稳';
    L.push(`→ 🎯 价格行为主信号：${pa.aboveAvg ? '站上均价线' : '跌破均价线'} / ${fiveTxt} / ${volumeTxt}`);
    if (pa.breakHigh) L.push(`   📈 突破近20分钟前高 ${fp(pa.priorHigh)}，优先按突破强度判断，不抢先T出`);
    if (pa.breakLow) L.push(`   📉 跌破近20分钟前低 ${fp(pa.priorLow)}，优先防守，不抢先抄底`);
    if (pa.retestHold) L.push(`   🟢 回踩均价线未破，均价线支撑有效`);
    if (pa.retestFail) L.push(`   🔴 反抽均价线受压，均价线已转为压力`);
    if (pa.signal === 'buy') {
      L.push(downtrendT
        ? `   ⚠️ 短线修复评分 ${pa.buyScore} 分：黄线仍下行，仅观察止跌，不等同于买回信号`
        : `   ✅ 多头价格行为评分 ${pa.buyScore} 分（均价线/前高/5分钟K/量能共振；是否买回仍以当前区间为准）`);
    } else if (pa.signal === 'sell') {
      L.push(uptrendT
        ? `   ⚠️ 短线走弱评分 ${pa.sellScore} 分：黄线仍上行，仅观察回落，不等同于T出信号`
        : `   ⚠️ 空头价格行为评分 ${pa.sellScore} 分（均价线/前低/5分钟K/量能共振；是否T出仍以当前区间为准）`);
    } else L.push(`   ⏳ 价格行为未形成共振（买${pa.buyScore}分 / 卖${pa.sellScore}分），等待而非猜方向`);
  }
  // ── MACD：旁路辅助展示，不单独触发，也不影响价格行为信号 ──
  if (macdState && macd) {
    const crossTxt = macdState.crossText || (macdState.cross === 'gold' ? '金叉↑' : macdState.cross === 'dead' ? '死叉↓' : '无交叉');
    const zoneTxt = macdState.zeroAbove ? '零轴上方' : '零轴下方';
    const histTxt = macdState.hist >= 0 ? '红柱' : '绿柱';
  const histDir = macdState.histTrend === 'expand' ? '放大'
      : macdState.histTrend === 'shrink' ? '收敛'
        : macdState.histTrend === 'turn_red' ? '由绿转红' : macdState.histTrend === 'turn_green' ? '由红转绿' : '持平';
    L.push(`→ 📉 分时MACD：DIFF ${fp(macd.dif)} / DEA ${fp(macd.dea)} / ${histTxt}${histDir}，${zoneTxt}，${crossTxt}`);
    if (macdState.cross === 'gold') {
      L.push(macdState.crossZone === 'water_up'
        ? `   ℹ️ MACD水上金叉：动能状态偏强，仅供观察；没有价格行为信号时不单独追买`
        : `   ℹ️ MACD水下金叉：动能修复信息，仅供观察；不改变价格行为建议`);
    } else if (macdState.cross === 'dead') {
      L.push(macdState.crossZone === 'water_up'
        ? `   ℹ️ MACD水上死叉：动能转弱信息，仅供观察；单独发生不卖`
        : `   ℹ️ MACD水下死叉：弱势状态信息，仍以均价线、前低、量能和5分钟K为准`);
    }
    if (macdState.divergence === 'top') L.push(`   ⚠️ 顶背离：价格创新高但MACD未跟上，提示冲高回落风险；仍需价格位置与价格行为确认，不单独卖出。`);
    else if (macdState.divergence === 'bottom') L.push(`   🟢 底背离：价格创新低但MACD未跟跌，提示下跌动能可能衰竭；仍需止跌结构确认，不单独买回。`);
  } else if (hasTData) {
    L.push(`→ 📉 分时MACD：分时数据过少，暂不判断`);
  }
  // ── 盘中轨迹信号（≥30根后同样适用"先高后走低"）──
  if (!openPhase && !pureAuction && dayHigh > 0 && pullbackPct >= confirmTh && hiFromOpen >= 0.5) {
    L.push(`→ 📐 轨迹信号：今日高点 ${fp(dayHigh)} 已冲高 ${fpp(hiFromOpen)}%，现从高点回落 ${fpp(pullbackPct)}%`);
    L.push(`     回落幅度已超过确认阈值（${fpp(confirmTh)}%）；若同时反抽均价线失败或5分钟转阴，T出信号明确。`);
  } else if (!openPhase && !pureAuction && dayLow > 0 && recoverPct >= confirmTh && loFromOpen >= 0.5) {
    L.push(`→ 📐 轨迹信号：今日低点 ${fp(dayLow)} 已下探 ${fpp(loFromOpen)}%，现自低点回升 ${fpp(recoverPct)}%`);
    L.push(`     回升幅度已超过确认阈值（${fpp(confirmTh)}%）；若站回均价线或突破近端前高，才作为T买回时机。`);
  }
  L.push('');
  L.push(`日内区间 ${fp(dayLow)} ~ ${fp(dayHigh)}（振幅${amplitude.toFixed(1)}%），当前位于区间 ${dayPosition.toFixed(0)}% 高位`);
  L.push(`→ ${dayPosition > 65 ? '⚠️ 偏高位，上方空间已不多' : dayPosition < 35 ? '偏低位，下方空间已不多' : '中间位，双向均有空间'}`);
  L.push('');
  const volDesc = openPhase
    ? (volRatio > 1.5 ? `量比 ${volRatio.toFixed(1)}（放量）` : volRatio < 0.7 ? `量比 ${volRatio.toFixed(1)}（缩量）` : `量比 ${volRatio.toFixed(1)}（正常）`)
    : (volRatio > 1.5 ? `放量 +${((volRatio - 1) * 100).toFixed(0)}%` : volRatio < 0.7 ? `缩量 -${((1 - volRatio) * 100).toFixed(0)}%` : '量能正常');
  L.push(`量能：${openPhase ? '量比（vs 5日均量）' : '近5min vs 前5min'}  →  ${volDesc}`);
  if (inSellZone && volRatio < 0.8) L.push(uptrendT
    ? `→ 📍 进入上行黄线兑现区且量能收缩：观察冲高回落，不因缩量直接卖出`
    : `→ 📍 价涨量缩 = 上涨乏力，卖出区内可等待走弱确认`);
  else if (inSellZone && volRatio > 1.4) L.push(`→ ⚠️ 价涨放量 = 突破可能增加，谨慎T出`);
  else if (inBuyZone && volRatio < 0.8) L.push(downtrendT
    ? `→ 📍 价跌量缩但黄线仍下行：仅观察止跌，等待黄线走平/上拐`
    : `→ 📍 价跌量缩 = 下跌钝化，买回区内可等待转强确认`);
  else if (inBuyZone && volRatio > 1.4) L.push(`→ ⚠️ 价跌放量 = 抛压未释放，等量缩并形成止跌结构再考虑买回`);
  else L.push(`→ 量价中性，暂无明显T信号`);
  L.push('');

  // ── T位建议 ──
  const scenarioMark = openPhase && openScenario ? `·${SCENARIO_LABEL[openScenario] || ''}` : '';
  const stratLabel = activeForm === 'uptrend' ? '上升单边' : activeForm === 'downtrend' ? '下降单边' : '震荡';
  L.push(`━━━ T位建议（${stratLabel}${openPhase ? '·开盘' : ''}${scenarioMark}）━━━`);
  if (!openPhase && tTrend === 'falling') {
    L.push(`↘️ 黄线下行：当前采用防守/反弹T模式；下方绿色区仅作止跌观察，不是自动买回点。`);
  } else if (!openPhase && tTrend === 'rising') {
    L.push(`↗️ 黄线上行：当前采用持有/顺势T模式；上方红色区为兑现区，未到区间不因回落追卖。`);
  } else if (!openPhase) {
    L.push(`➡️ 黄线走平：当前采用双向震荡T模式，买卖均须等待价格行为确认。`);
  }
  if (activeForm === 'uptrend') {
    L.push(`⚠️ 上升单边：整体不建议做T（踏空风险大）`);
    L.push(`   趋势股卖了常常更贵买回，得不偿失`);
    if (openPhase) {
      if (openScenario === 'gap_up_momentum') {
        L.push(`   🚀 当前高开续涨，踏空风险极高，建议持仓观察`);
        L.push(`   如坚持做T：T量 ≤ 持仓15%，等今开+2%以上才考虑`);
      } else {
        L.push(`   如坚持做T：T量 ≤ 持仓20%，等明显冲高才出`);
      }
    } else {
      L.push(`   如坚持做T：T量 ≤ 持仓20%，买回位设在黄线附近`);
    }
    L.push('');
    L.push(`🔴 谨慎卖出：${fp(sellLow)} ~ ${fp(sellHigh)}`);
    L.push(`   ⚠️ 若放量突破 ${fp(sellHigh)} 上方，不建议卖出，观察是否趋势加速`);
    L.push('');
    L.push(`🟢 买回位：${fp(buyLow)} ~ ${fp(buyHigh)}`);
    L.push(openPhase ? `   回踩今开附近（浅调整）即可接回，别等深跌` : `   回踩黄线附近，均线支撑强`);
  } else if (activeForm === 'downtrend') {
    L.push(`⚠️ 下降单边：以「反弹T」为主，严控T量（≤ 持仓15%）`);
    L.push(`   下行趋势每次反弹空间有限，做T只能微降均价，无法扭转趋势`);
    L.push('');
    if (openPhase) {
      if (openScenario === 'gap_down_panic') {
        L.push(`   🔴 低开续跌中：做T难度极高，强烈建议优先减仓而非T`);
      }
      L.push(`🔴 卖出参考：${fp(sellLow)} ~ ${fp(sellHigh)}`);
      const sellCtx = openScenario === 'gap_up_reversal' ? '高开后回落，反抽到今开附近就是相对高位，别贪'
        : openScenario === 'gap_down_recovery' ? '低开后反弹接近今开，下行趋势中的相对高位'
        : '趋势向下，反弹高度有限，今开附近即高位';
      L.push(`   理由：${sellCtx}`);
      if (bollUp && bollUp > sellHigh) L.push(`   ↑ BOLL上轨(${fp(bollUp)}) 是强压力，不要等到那里`);
      L.push('');
      L.push(`🟢 买回参考：${fp(buyLow)} ~ ${fp(buyHigh)}`);
      const buyCtx = openScenario === 'gap_down_panic' ? '量极缩才接，当前放量续跌阶段暂不买'
        : '沿趋势下移，等缩量企稳再分批接';
      L.push(`   理由：${buyCtx}`);
      if (bollLow) L.push(`   ↓ BOLL下轨(${fp(bollLow)}) 是支撑参考`);
    } else {
      L.push(`🔴 卖出参考：${fp(sellLow)} ~ ${fp(sellHigh)}`);
      L.push(`   理由：反弹到黄线上方（+${fpp(sellDevPct)}%），下行趋势中的相对高位`);
      if (ma5) L.push(`   MA5(${fp(ma5)}) 是反弹压力位`);
      L.push('');
      L.push(`🟢 买回参考：${fp(buyLow)} ~ ${fp(buyHigh)}`);
      L.push(`   理由：等缩量后的阶段低点；量不缩不买回`);
      if (bollLow) L.push(`   BOLL下轨(${fp(bollLow)}) 有支撑`);
    }
  } else {
    // 震荡
    L.push(`🔴 卖出参考：${fp(sellLow)} ~ ${fp(sellHigh)}`);
    if (openPhase) {
      const sellR = openScenario === 'gap_up_reversal' ? '高开回落，反抽至今开附近即压力区'
        : openScenario === 'gap_up_momentum' ? '高开续涨冲高区，动量减弱时出'
        : openScenario === 'gap_down_recovery' ? '低开反弹接近今开，短线相对高位'
        : '相对今开的冲高区';
      L.push(`   理由：${sellR}`);
    } else {
      L.push(`   理由：偏离黄线+${fpp(sellDevPct)}%以上（现价高于当日平均成本，持仓者整体浮盈，需观察兑现压力）`);
    }
    if (bollUp) L.push(`   ↑ BOLL上轨(${fp(bollUp)}) 是强压力`);
    L.push('');
    L.push(`🟢 买回参考：${fp(buyLow)} ~ ${fp(buyHigh)}`);
    if (openPhase) {
      const buyR = openScenario === 'gap_down_panic' ? '量极缩才接，续跌中暂不买'
        : openScenario === 'gap_down_recovery' ? '低开企稳，回踩今开以下是低吸机会'
        : '相对今开的回落区，低吸';
      L.push(`   理由：${buyR}`);
    } else {
      L.push(`   理由：黄线附近（-${fpp(buyDevPct)}%内），现价低于当日平均成本，需等止跌结构而非机械接回`);
    }
    if (bollLow) L.push(`   ↓ BOLL下轨(${fp(bollLow)}) 是强支撑`);
    L.push('');
    L.push(`📏 T差参考：卖出${fp(sellLow)} → 买回${fp(buyHigh)}，差${fp(Math.max(0, sellLow - buyHigh))}元/股`);
    const tDiffPerShare = Math.max(0, sellLow - buyHigh);
    const refPrice = lastPrice > 0 ? lastPrice : (tPos ? tPos.base : 1);
    const fixedAmt = 10000;
    const fixedShares = Math.max(100, Math.floor(fixedAmt / refPrice / 100) * 100);
    const refAmt = Math.round(fixedShares * refPrice);
    const refAmtStr = refAmt >= 10000 ? `约${(refAmt / 10000).toFixed(1)}万元` : `约${refAmt}元`;
    if (fixedShares > 0 && tDiffPerShare > 0) {
      const val = fixedShares * refPrice;
      // codeflicker-fix: LOGIC-Issue-008/ggcwpau782ju8vj8yxvg - 统一基金识别，费率来自可覆盖配置。
      const fee = isETF
        ? val * feeCfg.fundRoundTripRate
        : Math.max(val * feeCfg.stockCommissionRate, feeCfg.stockMinCommission)
          + Math.max(val * feeCfg.stockCommissionRate, feeCfg.stockMinCommission)
          + val * feeCfg.stockStampDutyRate + val * feeCfg.stockTransferRate;
      const gross = fixedShares * tDiffPerShare;
      const net = Math.round(gross - fee);
      if (net > 0) {
        L.push(`   ${refAmtStr}/${fixedShares}股，本次T按默认费率估算净收益约 +${net}元（费用${Math.round(fee)}元）`);
      } else {
        L.push(`   ${refAmtStr}/${fixedShares}股，T差仅${Math.round(gross)}元，按默认费率估算费用${Math.round(fee)}元，可能亏损`);
      }
    } else if (tDiffPerShare <= 0) {
      L.push(`   ⚠️ 卖出区与买回区重叠，当前无T差，等振幅扩大再操作`);
    }
  }

  L.push('');
  // ── 当前操作建议（唯一决策入口：与第二张技术图共用）──
  L.push('━━━ 当前操作建议 ━━━');
  const action = resolvedAction || resolveTAction(timeInfo, tPos);
  L.push(`${action.kind === 'sell' ? '🎯' : action.kind === 'buy' ? '🟢' : action.kind === 'risk' ? '🚨' : '⏳'} ${action.title}`);
  L.push(`   ${action.detail}`);
  if (macdState?.cross === 'gold' || macdState?.cross === 'dead') {
    L.push(`   ℹ️ MACD${macdState.cross === 'gold' ? '金叉' : '死叉'}仅作动能同步，不改变以上操作建议。`);
  }
  if (amplitude < ampWarnTh) {
    L.push('');
    L.push(`⚠️ 今日振幅仅 ${amplitude.toFixed(1)}%，低于手续费成本（${feeRate}%），做T意义不大`);
  } else if (amplitude < ampCautionTh) {
    L.push('');
    L.push(`💡 今日振幅 ${amplitude.toFixed(1)}%，T差空间偏小，建议精准挂单，别强求`);
  }
  L.push('');
  L.push(`下一张为技术图，请结合图中结构核对`);
  L.push(`⚠️ 非投资建议，仅供参考，请结合自身判断操作`);
  return L.join('\n');
}

// ── 图表渲染：分时图 + T位水平标注线 + 分时MACD小面板 ──
function renderTPngCanvas(code, name, timeKlines, quote, dayInfo, tPos, action = null) {
  const { createCanvas } = require('@napi-rs/canvas');
  const chartAction = action || { kind: 'wait', color: '#8a919c', title: '操作建议：等待确认', detail: '结合买卖区、黄线方向和价格行为判断', evidence: '证据：等待实时结构确认' };
  // MACD_H 200→260：定标改回真线性后不再有压缩，把面板加高来补可读性
  const W = 1400, PAD = 74, TITLE_H = 154, VOL_H = 84, MACD_H = 260, LEG_H = 36;
  const plotH = 420;
  const H = TITLE_H + plotH + VOL_H + MACD_H + LEG_H + PAD + 8;
  const isHK = code.startsWith('hk'), isHF = code.startsWith('hf_');
  // 过滤有效分时（A股 9:30~15:00）
  const display = filterTDisplayKlines(code, timeKlines);
  const dn = display.length;
  if (dn < 2) return null;
  // 数据范围
  const avgLine = buildAvgLine(display);
  const lastPrice = (quote && Number(quote.price) > 0) ? Number(quote.price) : display[dn - 1].close;
  const prevClose = (quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : 0;
  const chg = prevClose > 0 ? lastPrice - prevClose : 0;
  const chgPct = prevClose > 0 ? chg / prevClose * 100 : 0;
  const allP = [...display.map(k => k.close), ...(avgLine || []), prevClose || 0,
    Math.max(tPos.sellHigh, tPos.buyLow), Math.min(tPos.sellLow, tPos.buyHigh)].filter(v => v > 0);
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const rng = (hi - lo) || 1;
  const pad = rng * 0.08; // 右侧留出标签空间
  const yMin = lo - pad, yMax = hi + pad;
  const Y = p => TITLE_H + plotH - ((p - yMin) / (yMax - yMin)) * plotH;
  const TOT = isHK ? 330 : 240;
  const tmin = t => {
    const s = String(t).replace(':', '');
    const m = Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
    if (isHK) return Math.min(TOT, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780)));
    return Math.min(TOT, Math.max(0, m <= 690 ? m - 570 : m - 660));
  };
  const plotW = W - PAD * 2;
  const mapX = isHF ? (i => PAD + (i / (dn - 1)) * plotW) : (i => PAD + (tmin(display[i].t) / TOT) * plotW);
  // ── 分时 MACD：当天 1 分钟数据，参数 12/26/9；与文字分析使用完全相同的序列
  const macdDisplay = display.filter(k => k.complete !== false);
  const mdn = macdDisplay.length;
  const closes = macdDisplay.map(k => Number(k.close) || 0);
  const macdData = calcMACD(closes);
  // 配色
  const upC = '#f5222d', downC = '#0aa869';
  const bg = '#ffffff', panel = '#f7f8fa', grid = '#e8eaed', sub = '#8a919c', ink = '#2b2f36';
  const priceCol = chg >= 0 ? upC : downC;
  const prec = dayInfo.prec || 2;
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-';
  // 画布
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  // 标题区
  ctx.fillStyle = panel; ctx.fillRect(0, 0, W, TITLE_H);
  const tAccGrad = ctx.createLinearGradient(PAD, 14, PAD, 52);
  tAccGrad.addColorStop(0, '#f5222d'); tAccGrad.addColorStop(1, '#ff7875');
  ctx.fillStyle = tAccGrad; ctx.fillRect(PAD, 14, 5, 38);
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 24px cjk';
  ctx.fillText(name, PAD + 16, 34);
  ctx.fillStyle = sub; ctx.font = '13px cjk';
  ctx.fillText('做T参考 · 分时', PAD + 16, 54);
  // 与文字长图复用同一最终决策：证据图也直接说明“现在做什么 / 等什么”。
  const actionBg = chartAction.kind === 'sell' ? '#fff1f0'
    : chartAction.kind === 'buy' ? '#f6ffed'
    : chartAction.kind === 'risk' ? '#fff2f0' : '#fff7e6';
  ctx.fillStyle = actionBg;
  ctx.beginPath(); ctx.roundRect(PAD, 68, W - PAD * 2, 78, 8); ctx.fill();
  ctx.fillStyle = chartAction.color; ctx.fillRect(PAD + 14, 77, 5, 58);
  ctx.textAlign = 'left'; ctx.font = 'bold 16px cjk';
  ctx.fillText(chartAction.title, PAD + 32, 82);
  ctx.fillStyle = ink; ctx.font = '13px cjk';
  ctx.fillText(chartAction.detail, PAD + 32, 103);
  // 单独的证据行：与操作条件留出足够行距，避免手机端看起来像被截断。
  ctx.fillStyle = 'rgba(138,145,156,0.12)';
  ctx.beginPath(); ctx.roundRect(PAD + 24, 116, W - PAD * 2 - 48, 22, 5); ctx.fill();
  ctx.fillStyle = sub; ctx.font = '11px cjk';
  ctx.fillText(chartAction.evidence || '证据：等待实时结构确认', PAD + 34, 127);
  ctx.textAlign = 'right'; ctx.fillStyle = priceCol; ctx.font = 'bold 28px cjk';
  ctx.fillText(fp(lastPrice), W - PAD, 38);
  ctx.font = '15px cjk';
  ctx.fillText(`${chg >= 0 ? '+' : ''}${fp(chg)}  (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)`, W - PAD, 58);
  // 网格
  ctx.setLineDash([4, 4]);
  [0.25, 0.5, 0.75].forEach(f => {
    const yy = TITLE_H + f * plotH;
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, yy); ctx.lineTo(W - PAD, yy); ctx.stroke();
    const pv = yMin + (1 - f) * (yMax - yMin);
    ctx.fillStyle = sub; ctx.font = '12px cjk'; ctx.textAlign = 'right';
    ctx.fillText(fp(pv), PAD - 8, yy);
  });
  ctx.setLineDash([]);
  // 昨收虚线（标签放左侧，避免占用右侧T位标签空间）
  if (prevClose > 0 && prevClose > yMin && prevClose < yMax) {
    const yRef = Y(prevClose);
    ctx.strokeStyle = 'rgba(138,145,156,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD, yRef); ctx.lineTo(W - PAD, yRef); ctx.stroke(); ctx.setLineDash([]);
    const rl = '昨 ' + fp(prevClose);
    ctx.font = '11px cjk'; const rlw = ctx.measureText(rl).width + 8;
    ctx.fillStyle = 'rgba(138,145,156,0.85)'; ctx.beginPath(); ctx.roundRect(PAD + 4, yRef - 10, rlw, 20, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(rl, PAD + 4 + rlw / 2, yRef);
  }
  // ── T位标注线（标签统一放右侧，避免与左侧价格线重叠）──
  const tagW = 132;
  const drawTLine = (price, color, dash, labelText) => {
    if (price <= yMin || price >= yMax) return;
    const yy = Y(price);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(PAD, yy); ctx.lineTo(W - PAD - tagW - 4, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = 'bold 12px cjk'; const lw = ctx.measureText(labelText).width + 12;
    const lx = W - PAD - tagW + (tagW - lw) / 2;
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(W - PAD - tagW, yy - 10, tagW, 20, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(labelText, lx + lw / 2, yy);
  };
  drawTLine(tPos.sellHigh, 'rgba(245,34,45,0.9)', [6, 3], `卖上 ${fp(tPos.sellHigh)}`);
  drawTLine(tPos.sellLow, 'rgba(245,34,45,0.55)', [4, 4], `卖出 ${fp(tPos.sellLow)}`);
  drawTLine(tPos.buyHigh, 'rgba(10,168,105,0.55)', [4, 4], `买回 ${fp(tPos.buyHigh)}`);
  drawTLine(tPos.buyLow, 'rgba(10,168,105,0.9)', [6, 3], `买下 ${fp(tPos.buyLow)}`);
  // 渐变填充
  const fillRgb = chg >= 0 ? '245,34,45' : '10,168,105';
  const fg = ctx.createLinearGradient(0, TITLE_H, 0, TITLE_H + plotH);
  fg.addColorStop(0, `rgba(${fillRgb},0.15)`); fg.addColorStop(1, `rgba(${fillRgb},0)`);
  ctx.fillStyle = fg; ctx.beginPath();
  ctx.moveTo(mapX(0), TITLE_H + plotH);
  for (let i = 0; i < dn; i++) ctx.lineTo(mapX(i), Y(display[i].close));
  ctx.lineTo(mapX(dn - 1), TITLE_H + plotH); ctx.closePath(); ctx.fill();
  // 价格线
  ctx.strokeStyle = priceCol; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < dn; i++) { const x = mapX(i), y = Y(display[i].close); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke();
  // 均价线（黄线）
  if (avgLine) {
    ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1.4; ctx.beginPath();
    for (let i = 0; i < dn; i++) { const x = mapX(i), y = Y(avgLine[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // 成交量柱（上移，为MACD面板腾空间）
  const volTop = TITLE_H + plotH;
  const volYBase = volTop + VOL_H;
  const maxVol = Math.max(...display.map(k => k.vol || 0), 1);
  const cw2 = isHF ? Math.max(1.5, plotW / dn * 0.7) : Math.max(1.5, plotW / TOT * 0.7);
  for (let i = 0; i < dn; i++) {
    const v = display[i].vol || 0; if (!v) continue;
    const bh = Math.round((v / maxVol) * VOL_H);
    const x = mapX(i); const col = display[i].close >= (i > 0 ? display[i - 1].close : display[i].close) ? upC : downC;
    ctx.fillStyle = col + '99'; ctx.fillRect(x - cw2 / 2, volYBase - bh, cw2, bh);
  }
  // ── 分时MACD小面板 ──
  const macdTop = volYBase + 8;
  const macdH = MACD_H - 36;
  ctx.fillStyle = panel; ctx.fillRect(PAD - 8, macdTop - 2, W - PAD * 2 + 16, macdH + 8);
  // 零轴
  const macdZeroY = macdTop + macdH / 2;
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, macdZeroY); ctx.lineTo(W - PAD, macdZeroY); ctx.stroke();
  if (macdData) {
    const { diff, hist } = macdData.series ? { diff: macdData.series.dif, hist: macdData.series.hist } : { diff: [], hist: [] };
    const hasSeries = diff.length === mdn;
    if (hasSeries) {
      // 柱状图（HIST=DIF-DEA再×2）
      const deaSeries = macdData.series ? macdData.series.dea : [];
      // 纵向定标：真线性、全域基准（同花顺分时副图口径），不做任何压缩或裁剪。
      // 曾试过 signed-sqrt 压缩来放大午后的小幅波动，但 sqrt 会把小值相对抬高 3 倍左右
      // （603986 实测 p50 从占 11% 抬到 34%），让全天的柱体看起来"个个都很大"——失真，已回退。
      // 现在柱高与 DIF/DEA 离零轴的距离都与数值严格成正比，图上读到多少就是多少。
      const mRef = Math.max(
        ...hist.map(v => Math.abs(v)),
        ...diff.map(v => Math.abs(v)),
        ...(deaSeries || []).map(v => Math.abs(v)),
        1e-6,
      );
      const mScale = (macdH * 0.45) / mRef;
      const sY = v => v * mScale;
      for (let i = 0; i < mdn; i++) {
        const v = hist[i];
        const bh = Math.max(1, Math.abs(sY(v)));
        const x = mapX(i);
        // 红涨绿跌
        const col = v >= 0 ? '#f5222d' : '#0aa869';
        ctx.fillStyle = col + 'cc';
        ctx.fillRect(x - Math.max(1.2, cw2 * 0.42), v >= 0 ? macdZeroY - bh : macdZeroY, Math.max(2, cw2 * 0.84), bh);
      }
      if (diff.length === mdn) {
        // 两遍描边：先白色宽描边再从上面画细彩线（浅底/红绿柱上都清晰，接近同花顺观感）
        const strokeSeries = (arr, color) => {
          for (const [lw, col] of [[3.2, 'rgba(255,255,255,0.92)'], [1.3, color]]) {
            ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
            for (let i = 0; i < mdn; i++) { const x = mapX(i), y = macdZeroY - sY(arr[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
            ctx.stroke();
          }
        };
        strokeSeries(diff, '#1677ff');                                   // DIF 蓝线
        if (deaSeries && deaSeries.length === dn) strokeSeries(deaSeries, '#f0a90b'); // DEA 黄线
      }
      // 刻度标注：面板上下缘对应的数值（真线性，直接可读）。
      // 当天首根收盘价为 EMA 初始值；开盘端的自然建仓过程会如实保留。
      const edgeVal = mRef / 0.9;
      ctx.fillStyle = sub; ctx.font = '10px cjk'; ctx.textAlign = 'left';
      ctx.fillText('+' + edgeVal.toFixed(2), PAD + 2, macdTop + 9);
      ctx.fillText('-' + edgeVal.toFixed(2), PAD + 2, macdTop + macdH - 3);
    }
    ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'left';
    const mState = analyzeMACDState(macdData, closes);
    const mtxt = mState
      ? `MACD DIF ${fp(macdData.dif)}  DEA ${fp(macdData.dea)}  ${mState.hist >= 0 ? '红柱' : '绿柱'}${mState.histTrend === 'expand' ? '↑' : '↓'} ${mState.crossText || ''}${mState.divergence === 'top' ? ' ⚠顶部背离' : mState.divergence === 'bottom' ? ' 底部背离' : ''}`
      : 'MACD 数据不足';
    ctx.fillText(mtxt, PAD + 4, macdTop + macdH + 12);
  } else {
    ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'left';
    ctx.fillText('MACD 数据不足', PAD + 4, macdTop + macdH + 12);
  }
  // X轴时间标签（价格区下方）
  ctx.textAlign = 'center'; ctx.fillStyle = sub; ctx.font = '12px cjk';
  const xlabels = isHF ? [] : [[0, '09:30'], [60, '10:30'], [120, '11:30'], [180, '14:00'], [TOT, '15:00']];
  xlabels.forEach(([tm, lb]) => ctx.fillText(lb, PAD + (tm / TOT) * plotW, volTop + 16));
  // 图例（最底部）
  const yLeg = volYBase + MACD_H + 8;
  ctx.fillStyle = panel; ctx.fillRect(PAD - 8, yLeg, W - PAD * 2 + 16, 26);
  const lgItems = [[`价格 ${fp(lastPrice)}`, priceCol]];
  if (avgLine) lgItems.push([`均价(黄线) ${fp(avgLine[dn - 1])}`, '#f0b90b']);
  lgItems.push([`卖出区 ${fp(tPos.sellLow)}~${fp(tPos.sellHigh)}`, 'rgba(245,34,45,0.85)']);
  lgItems.push([`买回区 ${fp(tPos.buyLow)}~${fp(tPos.buyHigh)}`, 'rgba(10,168,105,0.85)']);
  ctx.textAlign = 'left';
  lgItems.forEach((it, i) => {
    const cx = PAD + 8 + i * 230;
    ctx.fillStyle = it[1]; ctx.beginPath(); ctx.arc(cx + 5, yLeg + 13, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink; ctx.font = '12px cjk'; ctx.fillText(it[0], cx + 15, yLeg + 13);
  });
  // 右下角生成时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  ctx.fillText('生成 ' + new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), W - PAD, H - 12);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// ── 主命令函数 ──
async function cmdT(args) {
  const parts = (args || []).filter(Boolean);
  let userFormRaw = null, codeArg = '';
  for (const p of parts) {
    if (p.toLowerCase() === '-sw') userFormRaw = 'swing';
    else if (p.toLowerCase() === '-tr') userFormRaw = 'trend';
    else if (!codeArg) codeArg = p;
  }
  if (!codeArg) {
    return { ok: false, text: [
      '📋 用法：/t <代码或名称> [-sw 震荡] [-tr 单边]',
      '例：/t 600519    /t 贵州茅台 -sw    /t 宁德时代 -tr',
      '',
      '功能：三阶段识别（竞价→开盘确认→盘中），轨迹+量能+分时MACD',
      '      判断当前T位合理性，给出卖出/买回参考价及逐信号解读。',
      '原理说明：查看 reply/T_GUIDE.md',
    ].join('\n') };
  }
  // 解析代码
  let code = normalizeCode(codeArg);
  let name = codeArg;
  let resolveNotice = '';
  if (!code) {
    const resolved = await resolveStockCode(codeArg, { details: true });
    code = resolved.code;
    if (!code) return { ok: false, text: `⚠️ 找不到「${codeArg}」，请检查代码或名称` };
    name = resolved.name || codeArg;
    if (!resolved.exact) resolveNotice = `🔎 已按「${name}」查询\n`;
  }
  // 并行拉取：分时累计数据 + 真实1分钟OHLC + 日线 + 快照
  const [timeResult, minuteResult, dayResult, quote] = await Promise.all([
    fetchStockKline(code, 'time').catch(() => null),
    fetchStockMinuteKline(code, 'm1', 400).catch(() => null),
    fetchStockKline(code, 'day').catch(() => null),
    fetchStockQuote(code).catch(() => null),
  ]);
  const rawTimeKlines = Array.isArray(timeResult) ? timeResult : [];
  const minuteKlines = Array.isArray(minuteResult) ? minuteResult : [];
  const dayKlines = Array.isArray(dayResult) ? dayResult : [];
  const fallbackLastClose = dayKlines.length ? Number(dayKlines[dayKlines.length - 1].close) || 0 : 0;
  const fallbackPrevClose = dayKlines.length >= 2 ? Number(dayKlines[dayKlines.length - 2].close) || 0 : 0;
  // 快照盘后/网络失败时没有昨收：日线倒数第二根是稳定回退，图表、涨跌色和开盘缺口必须共用同一基准。
  const effectiveQuote = {
    ...(quote || {}),
    price: (quote && Number(quote.price) > 0) ? Number(quote.price) : (rawTimeKlines?.[rawTimeKlines.length - 1]?.close || fallbackLastClose),
    prevClose: (quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : fallbackPrevClose,
    open: (quote && Number(quote.open) > 0) ? Number(quote.open) : (rawTimeKlines?.[0]?.open || fallbackPrevClose),
  };
  const timeKlines = mergeTMinuteKlines(rawTimeKlines, minuteKlines, effectiveQuote);
  if (quote && quote.name) name = quote.name;
  if (!dayKlines || dayKlines.length < 20) {
    return { ok: false, text: `⚠️ 获取 ${name} 日线数据失败（至少需要20根K线才能分析）` };
  }
  // codeflicker-fix: LOGIC-Issue-005/ggcwpau782ju8vj8yxvg - 基础模式和波动基准仅使用昨日及更早的完整日K。
  const quoteDate = String(effectiveQuote.time || '').replace(/\D/g, '').slice(0, 8);
  const lastDayDate = String(dayKlines.at(-1)?.t || '').replace(/\D/g, '').slice(0, 8);
  const quoteHm = String(effectiveQuote.time || '').replace(/\D/g, '').slice(8, 12);
  const completedDayKlines = quoteDate && lastDayDate === quoteDate && quoteHm && quoteHm < '1501'
    ? dayKlines.slice(0, -1) : dayKlines;
  const dayInfo = analyzeTDayForm(completedDayKlines);
  dayInfo.volRef = calcVolRef(completedDayKlines);
  // 价格精度：场内基金（ETF/LOF）固定 3 位（最小变动价位 0.001）；其余按现价有效小数 >2 位判定
  dayInfo.prec = (() => {
    if (isFundCode(code)) return 3;
    const ref = (quote && isFinite(quote.price) && Number(quote.price) > 0) ? Number(quote.price) : 0;
    if (!(ref > 0)) return 2;
    const sv = String(ref), dot = sv.indexOf('.');
    return (dot > 0 && sv.slice(dot + 1).replace(/0+$/, '').length > 2) ? 3 : 2;
  })();
  // 分时分析（无分时/开盘不足30min → openPhase 模式，基准用今开+量比+日线位置）
  let timeInfo;
  if (timeKlines && timeKlines.length >= 2) {
    timeInfo = analyzeTTimeData(timeKlines, effectiveQuote, code);
  } else {
    // 盘前/盘后无分时：用快照 + 日线末尾补充
    const last = dayKlines[dayKlines.length - 1], prev = dayKlines[dayKlines.length - 2];
    const openVal = (quote && Number(quote.open) > 0) ? Number(quote.open) : (prev ? prev.close : last.close);
    const prevCloseVal = prev ? prev.close : last.close;
    const gapPctVal = prevCloseVal > 0 ? (openVal - prevCloseVal) / prevCloseVal * 100 : 0;
    timeInfo = {
      lastPrice: (quote && Number(quote.price) > 0) ? Number(quote.price) : last.close,
      prevClose: prevCloseVal,
      open: openVal,
      currentAvg: 0, avgDev: 0,
      baseRef: openVal,
      openPhase: true,
      pureAuction: true,
      gapPct: gapPctVal,
      openDirPct: 0,
      openScenario: null,
      candleCount: 0,
      dayHigh: (quote && Number(quote.high) > 0) ? Number(quote.high) : last.high,
      dayLow: (quote && Number(quote.low) > 0) ? Number(quote.low) : last.low,
      dayPosition: 50, amplitude: prev ? Math.abs(last.close - prev.close) / prevCloseVal * 100 : 0,
      volRatio: (quote && Number(quote.volumeRatio) > 0) ? Number(quote.volumeRatio) : 1,
      avgSlope: 0, avgLine: null, timeKlines: [],
    };
  }
  // 实际生效的形态
  // codeflicker-fix: LOGIC-Issue-004/ggcwpau782ju8vj8yxvg - 无方向的-tr不再默认解释为上涨。
  const activeForm = userFormRaw === 'swing' ? 'swing'
    : userFormRaw === 'trend' ? (dayInfo.form === 'uptrend' || dayInfo.form === 'downtrend' ? dayInfo.form : 'unclear')
    : dayInfo.form;
  // tPos 可能为 null（纯竞价阶段）
  const tPos = calcTPositions(activeForm, timeInfo, dayInfo);
  const currentAction = { ...resolveTAction(timeInfo, tPos), evidence: buildTActionEvidence(timeInfo, tPos) };
  const detailText = resolveNotice + buildTReport(name, code, dayInfo.form, userFormRaw, timeInfo, dayInfo, tPos, currentAction);
  // 生成图
  // codeflicker-fix: UX-Issue-001/3eskueweih7vfxxuhb7r
  // 手机端不截断完整分析：所有文字报告排版成第一张长图，分时技术图作为第二张证据图。
  let img = null, reportImg = null;
  try { reportImg = renderReportCard({ title: `${name} · 做T分析`, subtitle: `${code.toUpperCase()} · 完整文字报告`, report: detailText }); } catch (e) { console.error('[/t] 文字长图生成失败:', e.message); }
  try {
    if (timeKlines && timeKlines.length >= 5) {
      // 纯竞价阶段（tPos 为 null）：画简化分时图（无T位标注）
      img = tPos
        ? renderTPngCanvas(code, name, timeKlines, effectiveQuote, dayInfo, tPos, currentAction)
        : renderTPngCanvas(code, name, timeKlines, effectiveQuote, dayInfo, { sellLow: 0, sellHigh: 0, buyLow: 0, buyHigh: 0 }, currentAction);
    } else {
      img = renderStockPng(code, name, '日线', dayKlines, { maPeriods: [5, 10, 20], boll: true, timeMode: false, prec: 2 }, quote);
    }
  } catch (e) { console.error('[/t] 图表生成失败:', e.message); }
  return { ok: true, text: '', detailText, reportImg, img };
}

module.exports = { cmdT, analyzeTDayForm, analyzeTTimeData, calcTPositions, buildTActionEvidence, resolveTAction, buildTReport, renderTPngCanvas, calcMACD, analyzeMACDState, _openScenario };
