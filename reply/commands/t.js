// ============================================================
// /t 做T参谋：形态判断 + 分时黄线分析 + T位建议（原理见 T_GUIDE.md）
// ============================================================
const { cacheGet, cacheSet, normStockName, isFundCode } = require('../utils');
const { resolveStockCode, normalizeCode, fetchStockKline, fetchStockQuote, buildAvgLine, calcSMA, calcBOLL } = require('../market');
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

function filterTDisplayKlines(code, timeKlines) {
  const arr = (timeKlines || []).filter(k => Number(k.close) > 0);
  if (code && code.startsWith('hf_')) return arr;
  return arr.filter(k => {
    const t = String(k.t).replace(':', '');
    return t >= '0930' && t <= '1500';
  });
}

// ── MACD状态解读：金叉/死叉 + 顶/底背离 + 柱体趋势 ──
function analyzeMACDState(macd, closes) {
  if (!macd) return null;
  const { series, dif, dea, hist } = macd;
  const d = series.dif, e = series.dea, h = series.hist;
  let cross = 'none', crossIndex = -1;
  for (let i = d.length - 1; i >= 1; i--) {
    if (d[i - 1] < e[i - 1] && d[i] >= e[i]) { cross = 'gold'; crossIndex = i; break; }
    if (d[i - 1] >= e[i - 1] && d[i] < e[i]) { cross = 'dead'; crossIndex = i; break; }
  }
  // 背离检测：取最后30根的局部顶/底，对比价格与DIF
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
      if (arr[t2] >= arr[t1] && d[t2] < d[t1]) divergence = 'top';
    }
    if (!divergence && bottoms.length >= 2) {
      const b1 = bottoms[bottoms.length - 2], b2 = bottoms[bottoms.length - 1];
      if (arr[b2] <= arr[b1] && d[b2] > d[b1]) divergence = 'bottom';
    }
  }
  const histTrend = h.length > 1 ? (h[h.length - 1] >= h[h.length - 2] ? 'expand' : 'shrink') : 'flat';
  const zeroAbove = dif > 0 && dea > 0;
  const crossLevel = crossIndex >= 0 ? (d[crossIndex] + e[crossIndex]) / 2 : (dif + dea) / 2;
  const crossZone = crossLevel >= 0 ? 'water_up' : 'water_down';
  const crossText = cross === 'gold'
    ? (crossZone === 'water_up' ? '水上金叉' : '水下金叉')
    : cross === 'dead'
      ? (crossZone === 'water_up' ? '水上死叉' : '水下死叉')
      : '无交叉';
  return { dif, dea, hist, cross, crossIndex, crossZone, crossText, divergence, histTrend, zeroAbove };
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
//   盘中          ：有效分时 > 10 根             — 使用既有黄线、轨迹、量能与 MACD 共振
function analyzeTTimeData(timeKlines, quote, code = '') {
  const hasTime = !!timeKlines && timeKlines.length >= 2;
  const validKlines = hasTime ? filterTDisplayKlines(code, timeKlines) : [];
  const candleCount = validKlines.length;
  const preMacd = candleCount <= 3;
  const macdForming = candleCount >= 4 && candleCount <= 5;
  const macdConfirm = candleCount >= 6 && candleCount <= 10;
  const pureAuction = preMacd || macdForming;
  const openPhase = candleCount <= 30;
  const lastPrice = (quote && Number(quote.price) > 0) ? Number(quote.price)
    : (hasTime ? timeKlines[timeKlines.length - 1].close : 0);
  const prevClose = (quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : 0;
  const open = (quote && Number(quote.open) > 0) ? Number(quote.open) : prevClose;
  const avgLine = hasTime ? buildAvgLine(timeKlines) : null;
  const currentAvg = (avgLine && avgLine.length > 0) ? avgLine[avgLine.length - 1] : 0;
  // 基准价：开盘用今开（黄线不可靠），盘中用黄线
  const baseRef = openPhase ? (open || prevClose || lastPrice) : (currentAvg || lastPrice);
  const avgDev = baseRef > 0 ? (lastPrice - baseRef) / baseRef * 100 : 0;
  // 日内位置
  const dayHigh = (quote && Number(quote.high) > 0) ? Number(quote.high)
    : (hasTime ? Math.max(...timeKlines.map(k => k.high)) : 0);
  const dayLow = (quote && Number(quote.low) > 0) ? Number(quote.low)
    : (hasTime ? Math.min(...timeKlines.map(k => k.low)) : 0);
  const range = dayHigh - dayLow;
  const dayPosition = range > 0 ? (lastPrice - dayLow) / range * 100 : 50;
  const amplitude = prevClose > 0 ? range / prevClose * 100 : 0;
  // 量能：开盘用快照量比（竞价量/5日均量）；盘中用近5min vs 前5min
  let volRatio;
  if (hasTime && !openPhase) {
    const dn = timeKlines.length;
    const rv = timeKlines.slice(-5).map(k => k.vol || 0);
    const pv = dn >= 10 ? timeKlines.slice(-10, -5).map(k => k.vol || 0) : rv;
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
  const macdKlines = validKlines;
  const closesArr = macdKlines.map(k => Number(k.close) || 0);
  const macd = closesArr.length ? calcMACD(closesArr) : null;
  const macdState = macd ? analyzeMACDState(macd, closesArr) : null;
  const priceAction = analyzePriceAction(validKlines, avgLine, lastPrice);
  const openFlash = preMacd ? analyzeOpenFlash(validKlines, avgLine, open, gapPct, volRatio) : null;
  // 开盘场景由价格、量能与轨迹决定；MACD不参与场景识别或触发。
  const openScenario = (!pureAuction && openPhase) ? _openScenario({ gapPct, openDirPct, pullbackPct, recoverPct, confirmTh, hiFromOpen, loFromOpen }) : null;
  // 黄线斜率（近15分钟；开盘阶段无意义）
  let avgSlope = 0;
  if (!openPhase && avgLine && avgLine.length >= 15) {
    const old = avgLine[avgLine.length - 15];
    avgSlope = old > 0 ? (avgLine[avgLine.length - 1] - old) / old * 100 : 0;
  }
  return {
    lastPrice, prevClose, open, currentAvg, avgDev, baseRef, openPhase, pureAuction,
    preMacd, macdForming, macdConfirm,
    gapPct, openDirPct, openScenario, candleCount,
    dayHigh, dayLow, dayPosition, amplitude, volRatio, avgSlope, avgLine, timeKlines,
    pullbackPct, recoverPct, hiFromOpen, loFromOpen, confirmTh, macd, macdState, priceAction, openFlash,
  };
}

// ── 波动率基准：近 N 日平均振幅（%）──
// 低波动标的（如红利低波 ETF，日均振幅约 1%）若沿用固定 % 做T阈值，T 区间会远大于当日实际波动，
// 图上价格被压扁、T 线贴边。故按「基准振幅 / 参考振幅」等比缩放做T阈值，且只缩小不放大，
// 保证对原有普通股票（振幅≈参考振幅）行为零影响。
const T_REF_AMP = 2.5;    // 参考振幅：固定阈值（约 1.5/2.8%）所对应的典型日振幅
const T_VOL_FLOOR = 0.35; // 缩放下限，避免低波动标的区间塌成一条线
function calcVolRef(dayKlines) {
  const n = (dayKlines || []).length;
  if (n < 2) return 0;
  const N = Math.min(10, n - 1);
  let sum = 0, cnt = 0;
  for (let i = n - N; i < n; i++) {
    const k = dayKlines[i], p = dayKlines[i - 1];
    if (!k || !p || !(p.close > 0) || !(k.high > 0) || !(k.low > 0)) continue;
    sum += (k.high - k.low) / p.close * 100; cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// ── 日内价格行为主信号：均价线、量能、前高前低、5分钟K结构 ──
// MACD 为滞后指标，仅作为旁路展示；不单独产生买卖触发。
function analyzePriceAction(klines, avgLine, lastPrice) {
  const rows = (klines || []).filter(k => Number(k.close) > 0);
  const n = rows.length;
  const none = { buyScore: 0, sellScore: 0, signal: 'wait', aboveAvg: false, avgBreakUp: false, avgBreakDown: false, retestHold: false, retestFail: false, breakHigh: false, breakLow: false, volBurst: false, volDry: false, fiveMin: 'neutral', priorHigh: 0, priorLow: 0 };
  if (n < 3 || !avgLine || avgLine.length !== n) return none;
  const last = rows[n - 1], prev = rows[n - 2];
  const avg = avgLine[n - 1], prevAvg = avgLine[n - 2];
  const lookback = rows.slice(Math.max(0, n - 21), n - 1);
  const priorHigh = Math.max(...lookback.map(k => Number(k.high) || 0));
  const priorLow = Math.min(...lookback.map(k => Number(k.low) || Infinity));
  const recent = rows.slice(Math.max(0, n - 4));
  const recentLow = Math.min(...recent.map(k => Number(k.low) || Infinity));
  const recentHigh = Math.max(...recent.map(k => Number(k.high) || 0));
  const avgBreakUp = prev.close < prevAvg && lastPrice >= avg;
  const avgBreakDown = prev.close >= prevAvg && lastPrice < avg;
  const aboveAvg = lastPrice >= avg;
  const retestHold = aboveAvg && recentLow <= avg * 1.0015;
  const retestFail = !aboveAvg && recentHigh >= avg * 0.9985;
  const breakHigh = priorHigh > 0 && lastPrice > priorHigh;
  const breakLow = isFinite(priorLow) && lastPrice < priorLow;
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
  if (retestHold) buyScore += 1;
  if (breakHigh) buyScore += 2;
  if (fiveMin === 'bull') buyScore += 1;
  if (volBurst && aboveAvg) buyScore += 1;
  if (avgBreakDown) sellScore += 2;
  if (retestFail) sellScore += 1;
  if (breakLow) sellScore += 2;
  if (fiveMin === 'bear') sellScore += 1;
  if (volBurst && !aboveAvg) sellScore += 1;
  // 单层价格行为信号：均价线、量能、前高前低与5分钟结构形成共振即触发。
  // 不再拆试探/确认档；MACD只作为旁路参考。
  const signal = buyScore >= 3 && buyScore > sellScore ? 'buy' : sellScore >= 3 && sellScore > buyScore ? 'sell' : 'wait';
  return { buyScore, sellScore, signal, aboveAvg, avgBreakUp, avgBreakDown, retestHold, retestFail, breakHigh, breakLow, volBurst, volDry, fiveMin, priorHigh, priorLow };
}

// ── 计算T位 ──
// pureAuction：返回 null（上层不渲染T位，只显示竞价分析）
function calcTPositions(activeForm, timeInfo, dayInfo) {
  const { lastPrice, currentAvg, dayLow, dayHigh, openPhase, pureAuction, macdForming, openScenario, open, prevClose } = timeInfo;
  const { bollUp, bollLow } = dayInfo;
  const prec = dayInfo.prec || 2;
  const r2 = v => Math.round(v * 10 ** prec) / 10 ** prec;
  // 波动率自适应：按日均振幅等比缩放做T阈值（只缩小，普通股票不受影响）
  const volRef = dayInfo.volRef > 0 ? dayInfo.volRef : T_REF_AMP;
  const volScale = Math.min(1, Math.max(T_VOL_FLOOR, volRef / T_REF_AMP));
  const isSwing = activeForm === 'swing' || activeForm === 'unclear';

  // ── 纯竞价阶段：数据不足，不给T位 ──
  if (pureAuction || macdForming) return null;

  // ── 开盘模式（5<=分时<30）：基于「开盘场景 x 日线形态」给动态T位 ──
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
    const sellHigh = r2(Math.min(bollUp || base * 1.05, base * (1 + sellThHigh / 100)));
    const buyHigh = r2(base * (1 - buyThHigh / 100));
    const buyLowByDev = r2(base * (1 - buyThLow / 100));
    const buyLow = r2(dayLow > 0 && dayLow < buyHigh ? Math.max(dayLow, buyLowByDev) : buyLowByDev);
    const inSellZone = lastPrice >= sellLow;
    const inBuyZone = lastPrice <= buyHigh;
    const expectedTDiff = ((sellHigh - buyLow) / base * 100).toFixed(1);
    return { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone, inNeutral: !inSellZone && !inBuyZone, expectedTDiff, base, openPhase, openScenario, confirmTh: timeInfo.confirmTh, pullbackPct: timeInfo.pullbackPct, recoverPct: timeInfo.recoverPct, macdState: timeInfo.macdState, macd: timeInfo.macd };
  }

  // ── 盘中模式：基准=黄线 ──
  const base = currentAvg > 0 ? currentAvg : lastPrice;
  // 卖出区（阈值随波动率自适应缩放）
  const sellThLow = (isSwing ? 1.5 : 0.8) * volScale;
  const sellThHigh = (isSwing ? 2.8 : 1.5) * volScale;
  const sellLow = r2(base * (1 + sellThLow / 100));
  const sellHigh = r2(Math.min(bollUp || base * 1.035, base * (1 + sellThHigh / 100)));
  // 买回区：buyLow < buyHigh 始终成立
  // buyThLow > buyThHigh 保证 byDev 的 buyLow < buyHigh；dayLow 仅在严格低于 buyHigh 时做地板
  const buyThHigh = (isSwing ? 0.8 : 0.3) * volScale;
  const buyThLow = (isSwing ? 1.8 : 1.0) * volScale;
  const buyHigh = r2(base * (1 - buyThHigh / 100));
  const buyLowByDev = r2(base * (1 - buyThLow / 100)); // 始终 < buyHigh（thLow > thHigh）
  // dayLow 做地板只在它严格低于 buyHigh 时有意义，否则忽略（避免 buyLow > buyHigh）
  const buyLow = r2(dayLow > 0 && dayLow < buyHigh ? Math.max(dayLow, buyLowByDev) : buyLowByDev);
  // 当前位置
  const inSellZone = lastPrice >= sellLow;
  const inBuyZone = lastPrice <= buyHigh;
  const expectedTDiff = ((sellHigh - buyLow) / base * 100).toFixed(1);
  return { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone, inNeutral: !inSellZone && !inBuyZone, expectedTDiff, base, macd: timeInfo.macd, macdState: timeInfo.macdState, confirmTh: timeInfo.confirmTh };
}

// ── 生成文字报告（教学式）──
// tPos 可能为 null（纯竞价阶段），需特殊处理
function buildTReport(name, code, autoForm, userFormRaw, timeInfo, dayInfo, tPos) {
  const { lastPrice, currentAvg, avgDev, dayHigh, dayLow, dayPosition, volRatio, amplitude,
          avgSlope, openPhase, pureAuction, preMacd, macdForming, macdConfirm, open, gapPct, openDirPct, openScenario, candleCount,
          pullbackPct, recoverPct, hiFromOpen, loFromOpen, confirmTh, macd, macdState, priceAction, openFlash } = timeInfo;
  const { ma5, ma10, ma20, bollUp, bollLow, bollMid, bollWidth } = dayInfo;
  const now = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
  const isETF = /^(sh51|sz159)/.test(code);
  const feeRate = isETF ? 0.02 : 0.30;
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
    (autoForm === 'downtrend' ? 'downtrend' : 'uptrend') : autoForm;
  const hasTData = !!timeInfo.timeKlines && timeInfo.timeKlines.length >= 2;

  // 仅在有T位时解构
  const sellLow = tPos ? tPos.sellLow : 0;
  const sellHigh = tPos ? tPos.sellHigh : 0;
  const buyLow = tPos ? tPos.buyLow : 0;
  const buyHigh = tPos ? tPos.buyHigh : 0;
  const inSellZone = tPos ? tPos.inSellZone : false;
  const inBuyZone = tPos ? tPos.inBuyZone : false;
  const inNeutral = tPos ? tPos.inNeutral : true;
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
    L.push(`📈 图表分析正在生成...`);
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
    const devLabel = Math.abs(avgDev) < 0.5 ? '均值附近，T的空间有限'
      : avgDev > 2 ? `📍 明显偏贵，处于T卖出窗口区`
      : avgDev > 0.5 ? `轻微偏贵，可准备挂卖单等待`
      : avgDev < -2 ? `📍 明显偏低，处于T买回窗口区`
      : `轻微偏低，接近买回区域`;
    L.push(`→ 【${devLabel}】`);
    L.push(`   💡 黄线 = 今日所有成交的加权均价。偏贵=持有者平均在亏（有出货压力）；偏低=持有者有浮盈（有支撑）`);
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
    if (pa.signal === 'buy') L.push(`   ✅ 买回信号：价格行为评分 ${pa.buyScore} 分（均价线/前高/5分钟K/量能共振）`);
    else if (pa.signal === 'sell') L.push(`   ⚠️ T出/减仓信号：价格行为评分 ${pa.sellScore} 分（均价线/前低/5分钟K/量能共振）`);
    else L.push(`   ⏳ 价格行为未形成共振（买${pa.buyScore}分 / 卖${pa.sellScore}分），等待而非猜方向`);
  }
  // ── MACD：旁路辅助展示，不单独触发，也不影响价格行为信号 ──
  if (macdState && macd) {
    const crossTxt = macdState.crossText || (macdState.cross === 'gold' ? '金叉↑' : macdState.cross === 'dead' ? '死叉↓' : '无交叉');
    const zoneTxt = macdState.zeroAbove ? '零轴上方' : '零轴下方';
    const histTxt = macdState.hist >= 0 ? '红柱' : '绿柱';
    const histDir = macdState.histTrend === 'expand' ? '放大' : '收敛';
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
    if (macdState.divergence === 'top') L.push(`   ⚠️ 顶背离：价格创新高但MACD未跟上 → 冲高回落前兆，卖出信号加强！`);
    else if (macdState.divergence === 'bottom') L.push(`   🟢 底背离：价格创新低但MACD未跟跌 → 跌势衰竭，买回信号加强！`);
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
  if (inSellZone && volRatio < 0.8) L.push(`→ 📍 价涨量缩 = 上涨乏力，T的经典卖出信号`);
  else if (inSellZone && volRatio > 1.4) L.push(`→ ⚠️ 价涨放量 = 趋势突破风险，谨慎T出`);
  else if (inBuyZone && volRatio < 0.8) L.push(`→ 📍 价跌量缩 = 下跌钝化，T的买回信号`);
  else if (inBuyZone && volRatio > 1.4) L.push(`→ ⚠️ 价跌放量 = 有人在砸，等量缩后再买回`);
  else L.push(`→ 量价中性，暂无明显T信号`);
  L.push('');

  // ── T位建议 ──
  const scenarioMark = openPhase && openScenario ? `·${SCENARIO_LABEL[openScenario] || ''}` : '';
  const stratLabel = activeForm === 'uptrend' ? '上升单边' : activeForm === 'downtrend' ? '下降单边' : '震荡';
  L.push(`━━━ T位建议（${stratLabel}${openPhase ? '·开盘' : ''}${scenarioMark}）━━━`);
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
      L.push(`   理由：偏离黄线+${fpp(sellDevPct)}%以上（今日持仓者平均亏损，有出货压力）`);
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
      L.push(`   理由：黄线附近（-${fpp(buyDevPct)}%内），持仓者有浮盈，下跌意愿弱`);
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
      const fee = isETF
        ? val * 0.0002
        : Math.max(val * 0.0008, 5) + Math.max(val * 0.0008, 5) + val * 0.001 + val * 0.0004;
      const gross = fixedShares * tDiffPerShare;
      const net = Math.round(gross - fee);
      if (net > 0) {
        L.push(`   ${refAmtStr}/${fixedShares}股，本次T净赚约 +${net}元（扣手续费${Math.round(fee)}元）`);
      } else {
        L.push(`   ${refAmtStr}/${fixedShares}股，T差仅${Math.round(gross)}元，手续费${Math.round(fee)}元，亏！`);
      }
    } else if (tDiffPerShare <= 0) {
      L.push(`   ⚠️ 卖出区与买回区重叠，当前无T差，等振幅扩大再操作`);
    }
  }

  L.push('');
  // ── 当前操作建议 ──
  L.push('━━━ 当前操作建议 ━━━');
  // 价格行为负责唯一触发；MACD仅同步展示，不影响价格行为信号。
  const macdEndorsesBuy = macdState && macdState.cross === 'gold';
  const macdEndorsesSell = macdState && macdState.cross === 'dead';
  const paSignal = priceAction ? priceAction.signal : 'wait';
  if (openScenario === 'gap_down_panic' && openPhase) {
    L.push(`🚨 低开续跌中——做T难度极高，不建议操作`);
    L.push(`   优先方案：若跌幅已大（>3%），考虑部分减仓止损`);
    L.push(`   等缩量止跌、5分钟K转强并重新站回均价线后，才考虑分批接回`);
  } else if (paSignal === 'sell') {
    L.push(`🎯 价格行为触发T出/减仓：均价线、前低、5分钟K与量能形成空头共振`);
    if (macdEndorsesSell) L.push(`   ℹ️ MACD死叉同向，可作为辅助参考；操作仍以价格行为为准`);
    else L.push(`   可结合卖出区 ${fp(sellLow)} ~ ${fp(sellHigh)} 分批执行；MACD不作为等待条件`);
  } else if (paSignal === 'buy') {
    L.push(`🎯 价格行为触发买回：均价线、前高、5分钟K与量能形成多头共振`);
    if (macdEndorsesBuy) L.push(`   ℹ️ MACD金叉同向，可作为辅助参考；操作仍以价格行为为准`);
    else L.push(`   可在买回区 ${fp(buyLow)} ~ ${fp(buyHigh)} 分批执行；MACD不作为等待条件`);
  } else if (inSellZone) {
    L.push(`⏳ 当前进入卖出参考区（≥ ${fp(sellLow)}），但价格行为未触发`);
    L.push(`   等待：反抽均价线失败、跌破近端低点、5分钟转阴或量能由涨转弱；不因MACD死叉单独卖出`);
  } else if (inBuyZone) {
    L.push(`⏳ 当前进入买回参考区（≤ ${fp(buyHigh)}），但价格行为未触发`);
    L.push(`   等待：均价线突破/回踩、前高前低、量能与5分钟结构出现共振；MACD不作为等待条件`);
  } else {
    L.push(`⏳ 当前 ${fp(lastPrice)} 处于中性区间，价格行为尚未形成共振`);
    L.push(`   · 均价线上方放量突破前高、5分钟转强 → 观察买回/持有机会`);
    L.push(`   · 均价线下方跌破前低、5分钟转弱 → 观察T出/减仓机会`);
  }
  if (amplitude < ampWarnTh) {
    L.push('');
    L.push(`⚠️ 今日振幅仅 ${amplitude.toFixed(1)}%，低于手续费成本（${feeRate}%），做T意义不大`);
  } else if (amplitude < ampCautionTh) {
    L.push('');
    L.push(`💡 今日振幅 ${amplitude.toFixed(1)}%，T差空间偏小，建议精准挂单，别强求`);
  }
  L.push('');
  L.push(`📈 图表分析正在生成...`);
  L.push(`⚠️ 非投资建议，仅供参考，请结合自身判断操作`);
  return L.join('\n');
}

// ── 图表渲染：分时图 + T位水平标注线 + 分时MACD小面板 ──
function renderTPngCanvas(code, name, timeKlines, quote, dayInfo, tPos) {
  const { createCanvas } = require('@napi-rs/canvas');
  // MACD_H 200→260：定标改回真线性后不再有压缩，把面板加高来补可读性
  const W = 1400, PAD = 74, TITLE_H = 62, VOL_H = 84, MACD_H = 260, LEG_H = 36;
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
  const closes = display.map(k => Number(k.close) || 0);
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
    const hasSeries = diff.length === dn;
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
      for (let i = 0; i < dn; i++) {
        const v = hist[i];
        const bh = Math.max(1, Math.abs(sY(v)));
        const x = mapX(i);
        // 红涨绿跌
        const col = v >= 0 ? '#f5222d' : '#0aa869';
        ctx.fillStyle = col + 'cc';
        ctx.fillRect(x - Math.max(1.2, cw2 * 0.42), v >= 0 ? macdZeroY - bh : macdZeroY, Math.max(2, cw2 * 0.84), bh);
      }
      if (diff.length === dn) {
        // 两遍描边：先白色宽描边再从上面画细彩线（浅底/红绿柱上都清晰，接近同花顺观感）
        const strokeSeries = (arr, color) => {
          for (const [lw, col] of [[3.2, 'rgba(255,255,255,0.92)'], [1.3, color]]) {
            ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
            for (let i = 0; i < dn; i++) { const x = mapX(i), y = macdZeroY - sY(arr[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
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
  if (!code) {
    code = await resolveStockCode(codeArg);
    if (!code) return { ok: false, text: `⚠️ 找不到「${codeArg}」，请检查代码或名称` };
  }
  // 并行拉取：当天分时 + 日线 + 快照
  const [timeResult, dayResult, quote] = await Promise.all([
    fetchStockKline(code, 'time').catch(() => null),
    fetchStockKline(code, 'day').catch(() => null),
    fetchStockQuote(code).catch(() => null),
  ]);
  const timeKlines = Array.isArray(timeResult) ? timeResult : [];
  const dayKlines = Array.isArray(dayResult) ? dayResult : [];
  const fallbackLastClose = dayKlines.length ? Number(dayKlines[dayKlines.length - 1].close) || 0 : 0;
  const fallbackPrevClose = dayKlines.length >= 2 ? Number(dayKlines[dayKlines.length - 2].close) || 0 : 0;
  // 快照盘后/网络失败时没有昨收：日线倒数第二根是稳定回退，图表、涨跌色和开盘缺口必须共用同一基准。
  const effectiveQuote = {
    ...(quote || {}),
    price: (quote && Number(quote.price) > 0) ? Number(quote.price) : (timeKlines?.[timeKlines.length - 1]?.close || fallbackLastClose),
    prevClose: (quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : fallbackPrevClose,
    open: (quote && Number(quote.open) > 0) ? Number(quote.open) : (timeKlines?.[0]?.open || fallbackPrevClose),
  };
  if (quote && quote.name) name = quote.name;
  if (!dayKlines || dayKlines.length < 20) {
    return { ok: false, text: `⚠️ 获取 ${name} 日线数据失败（至少需要20根K线才能分析）` };
  }
  // 日线分析
  const dayInfo = analyzeTDayForm(dayKlines);
  // 波动率基准（自适应做T阈值）：近10日平均振幅
  dayInfo.volRef = calcVolRef(dayKlines);
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
  const activeForm = userFormRaw === 'swing' ? 'swing'
    : userFormRaw === 'trend' ? (dayInfo.form === 'downtrend' ? 'downtrend' : 'uptrend')
    : dayInfo.form;
  // tPos 可能为 null（纯竞价阶段）
  const tPos = calcTPositions(activeForm, timeInfo, dayInfo);
  const text = buildTReport(name, code, dayInfo.form, userFormRaw, timeInfo, dayInfo, tPos);
  // 生成图
  let img = null;
  try {
    if (timeKlines && timeKlines.length >= 5) {
      // 纯竞价阶段（tPos 为 null）：画简化分时图（无T位标注）
      img = tPos
        ? renderTPngCanvas(code, name, timeKlines, effectiveQuote, dayInfo, tPos)
        : renderTPngCanvas(code, name, timeKlines, effectiveQuote, dayInfo, { sellLow: 0, sellHigh: 0, buyLow: 0, buyHigh: 0 });
    } else {
      img = renderStockPng(code, name, '日线', dayKlines, { maPeriods: [5, 10, 20], boll: true, timeMode: false, prec: 2 }, quote);
    }
  } catch (e) { console.error('[/t] 图表生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdT, analyzeTDayForm, analyzeTTimeData, calcTPositions, buildTReport, renderTPngCanvas, calcMACD, analyzeMACDState, _openScenario };
