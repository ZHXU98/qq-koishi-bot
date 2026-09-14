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
  const ma20Dev = ma20 ? (lastClose - ma20) / ma20 * 100 : 0;
  return { ma5, ma10, ma20, bollUp, bollLow, bollMid, bollWidth, form, ma20Dev, lastClose };
}

// ── 分时MACD（与同花顺一致）──
// 计算方式：1分钟K线收盘价，EMA12/26 + DEA9
// 种子：前一日收盘价作为EMA初始值（同花顺分时MACD做法），从第1根分时起即可计算
// 返回最新值+完整序列；无分时数据时返回 null
function calcMACD(closes, prevClose) {
  const arr = (closes || []).filter(v => isFinite(v) && v > 0);
  if (!arr.length) return null;
  // 种子：昨收（若无昨收数据则退化为首根收盘价）
  const seed = (isFinite(prevClose) && prevClose > 0) ? prevClose : arr[0];
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
  const ema12 = calcEMA(arr, 12);
  const ema26 = calcEMA(arr, 26);
  const dif = arr.map((_, i) => ema12[i] - ema26[i]);
  // DEA 的种子用 0（昨收时 DIF=EMA12-EMA26=0），与同花顺一致
  const k9 = 2 / (9 + 1);
  const dea = [];
  let prevDea = 0;
  for (let i = 0; i < dif.length; i++) {
    prevDea = dif[i] * k9 + prevDea * (1 - k9);
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

// ── MACD状态解读：金叉/死叉 + 顶/底背离 + 柱体趋势 ──
function analyzeMACDState(macd, closes) {
  if (!macd) return null;
  const { series, dif, dea, hist } = macd;
  const d = series.dif, e = series.dea, h = series.hist;
  let cross = 'none';
  for (let i = d.length - 1; i >= 1; i--) {
    if (d[i - 1] < e[i - 1] && d[i] >= e[i]) { cross = 'gold'; break; }
    if (d[i - 1] >= e[i - 1] && d[i] < e[i]) { cross = 'dead'; break; }
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
  return { dif, dea, hist, cross, divergence, histTrend, zeroAbove: dif > 0 && dea > 0 };
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

// ── 分时现状分析 ──
// 三阶段逻辑：
//   pureAuction  ：分时 <  5 根（9:30~9:35 前）— 只有竞价数据，不给T位
//   openPhase    ：分时 < 30 根（~10:00 前）   — 用今开+5min走势确定做T场景
//   盘中          ：分时 ≥ 30 根              — 用黄线均价做基准（原逻辑）
function analyzeTTimeData(timeKlines, quote) {
  const hasTime = !!timeKlines && timeKlines.length >= 2;
  const candleCount = hasTime ? timeKlines.length : 0;
  const pureAuction = candleCount < 5;          // 不足5分钟：只有竞价，等方向确认
  const openPhase = candleCount < 30;           // 不足30分钟：开盘模式
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
  // ── 分时MACD（1分钟K线，昨收做种子，从第1根即可计算）──
  const closesArr = hasTime ? timeKlines.map(k => Number(k.close) || 0) : [];
  const macd = calcMACD(closesArr, prevClose);
  const macdState = macd ? analyzeMACDState(macd, closesArr) : null;
  // 开盘场景（纯竞价阶段暂无意义）
  const openScenario = (!pureAuction && openPhase) ? _openScenario({ gapPct, openDirPct, pullbackPct, recoverPct, confirmTh, hiFromOpen, loFromOpen }) : null;
  // 黄线斜率（近15分钟；开盘阶段无意义）
  let avgSlope = 0;
  if (!openPhase && avgLine && avgLine.length >= 15) {
    const old = avgLine[avgLine.length - 15];
    avgSlope = old > 0 ? (avgLine[avgLine.length - 1] - old) / old * 100 : 0;
  }
  return {
    lastPrice, prevClose, open, currentAvg, avgDev, baseRef, openPhase, pureAuction,
    gapPct, openDirPct, openScenario, candleCount,
    dayHigh, dayLow, dayPosition, amplitude, volRatio, avgSlope, avgLine, timeKlines,
    pullbackPct, recoverPct, hiFromOpen, loFromOpen, confirmTh, macd, macdState,
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

// ── 计算T位 ──
// pureAuction：返回 null（上层不渲染T位，只显示竞价分析）
function calcTPositions(activeForm, timeInfo, dayInfo) {
  const { lastPrice, currentAvg, dayLow, dayHigh, openPhase, pureAuction, openScenario, open, prevClose } = timeInfo;
  const { bollUp, bollLow } = dayInfo;
  const prec = dayInfo.prec || 2;
  const r2 = v => Math.round(v * 10 ** prec) / 10 ** prec;
  // 波动率自适应：按日均振幅等比缩放做T阈值（只缩小，普通股票不受影响）
  const volRef = dayInfo.volRef > 0 ? dayInfo.volRef : T_REF_AMP;
  const volScale = Math.min(1, Math.max(T_VOL_FLOOR, volRef / T_REF_AMP));
  const isSwing = activeForm === 'swing' || activeForm === 'unclear';

  // ── 纯竞价阶段：数据不足，不给T位 ──
  if (pureAuction) return null;

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
          avgSlope, openPhase, pureAuction, open, gapPct, openDirPct, openScenario, candleCount,
          pullbackPct, recoverPct, hiFromOpen, loFromOpen, confirmTh, macd, macdState } = timeInfo;
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
    // ── 纯竞价阶段：只有竞价信息，无法判断走势，不给T位 ──
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
    L.push('');
    L.push(`⏰ 当前分时数据：仅 ${candleCount} 根（9:30起约${candleCount}分钟），方向尚未确认`);
    L.push(`   ⚠️ 暂不给T位——等开盘5分钟后（约9:35）再查，系统将根据走势自动给出动态T位`);
    L.push(`   📉 分时MACD：开盘后即可计算（与同花顺一致，昨收做种子）`);
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
        else L.push(`   💡 虽缩量但仍在低点附近，别急着抄底，等MACD企稳`);
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
  // ── 分时MACD状态（两个模式共用）──
  if (macdState && macd) {
    const crossTxt = macdState.cross === 'gold' ? '金叉↑' : macdState.cross === 'dead' ? '死叉↓' : '无交叉';
    const zoneTxt = macdState.zeroAbove ? '零轴上方' : '零轴下方';
    const histTxt = macdState.hist >= 0 ? '红柱' : '绿柱';
    const histDir = macdState.histTrend === 'expand' ? '放大' : '收敛';
    L.push(`→ 📉 分时MACD：DIFF ${fp(macd.dif)} / DEA ${fp(macd.dea)} / ${histTxt}${histDir}，${zoneTxt}，${crossTxt}`);
    if (macdState.divergence === 'top') L.push(`   ⚠️ 顶背离：价格创新高但MACD未跟上 → 冲高回落前兆，卖出信号加强！`);
    else if (macdState.divergence === 'bottom') L.push(`   🟢 底背离：价格创新低但MACD未跟跌 → 跌势衰竭，买回信号加强！`);
  } else if (hasTData) {
    L.push(`→ 📉 分时MACD：分时数据过少，暂不判断`);
  }
  // ── 盘中轨迹信号（≥30根后同样适用"先高后走低"）──
  if (!openPhase && !pureAuction && dayHigh > 0 && pullbackPct >= confirmTh && hiFromOpen >= 0.5) {
    L.push(`→ 📐 轨迹信号：今日高点 ${fp(dayHigh)} 已冲高 ${fpp(hiFromOpen)}%，现从高点回落 ${fpp(pullbackPct)}%`);
    L.push(`     回落幅度已超过确认阈值（${fpp(confirmTh)}%），若伴随分时MACD死叉/顶背离，是明确的T卖出时机`);
  } else if (!openPhase && !pureAuction && dayLow > 0 && recoverPct >= confirmTh && loFromOpen >= 0.5) {
    L.push(`→ 📐 轨迹信号：今日低点 ${fp(dayLow)} 已下探 ${fpp(loFromOpen)}%，现自低点回升 ${fpp(recoverPct)}%`);
    L.push(`     回升幅度已超过确认阈值（${fpp(confirmTh)}%），若伴随分时MACD金叉/底背离，是明确的T买回时机`);
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
  // MACD 最终确认（三条件共振：轨迹 → 量能 → MACD）
  const macdConfirmSell = macdState && macdState.cross === 'dead';
  const macdConfirmBuy = macdState && macdState.cross === 'gold';
  if (openScenario === 'gap_down_panic' && openPhase) {
    L.push(`🚨 低开续跌中——做T难度极高，不建议操作`);
    L.push(`   优先方案：若跌幅已大（>3%），考虑部分减仓止损`);
    L.push(`   等量能明显萎缩（量比降至0.5以下）且MACD底背离/金叉再分批接`);
  } else if (inSellZone) {
    L.push(`🎯 当前 ${fp(lastPrice)} 已进入卖出参考区（≥ ${fp(sellLow)}）`);
    if (macdConfirmSell) L.push(`   📉 MACD死叉确认，卖出信号增强，建议优先挂单 ${fp(sellLow)} ~ ${fp(sellHigh)}`);
    else if (volRatio < 0.8) L.push(`   量缩确认，信号较强，建议挂单 ${fp(sellLow)} ~ ${fp(sellHigh)}`);
    else if (volRatio > 1.4) L.push(`   ⚠️ 放量注意！若持续放量是趋势突破，谨慎T出`);
    else L.push(`   可分批挂单 ${fp(sellLow)} ~ ${fp(sellHigh)}，等冲高机会`);
  } else if (inBuyZone) {
    L.push(`🎯 当前 ${fp(lastPrice)} 已进入买回参考区（≤ ${fp(buyHigh)}）`);
    if (macdConfirmBuy) L.push(`   📈 MACD金叉确认，买回信号增强，可在 ${fp(buyLow)} ~ ${fp(buyHigh)} 分批买回`);
    else if (volRatio < 0.8) L.push(`   缩量确认，信号较强，可在 ${fp(buyLow)} ~ ${fp(buyHigh)} 分批买回`);
    else if (volRatio > 1.4) L.push(`   ⚠️ 放量下跌，等量缩后再买回，不追跌`);
    else L.push(`   可在 ${fp(buyLow)} ~ ${fp(buyHigh)} 区间分批挂单买回`);
  } else {
    L.push(`⏳ 当前 ${fp(lastPrice)} 处于中性区间`);
    L.push(`   · 等涨到 ${fp(sellLow)} 以上 → 开始挂卖单准备T出`);
    L.push(`   · 等跌到 ${fp(buyHigh)} 以下 → 准备分批买回`);
    if (openPhase) L.push(`   · 开盘初期，方向可能还未走稳，不急`);
    else L.push(`   · 现阶段不操作，等更好的点位`);
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
  const W = 1000, PAD = 74, TITLE_H = 62, VOL_H = 80, MACD_H = 96, LEG_H = 36;
  const plotH = 360;
  const H = TITLE_H + plotH + VOL_H + MACD_H + LEG_H + PAD + 8;
  const isHK = code.startsWith('hk'), isHF = code.startsWith('hf_');
  // 过滤有效分时（A股 9:30~15:00）
  const display = isHF ? timeKlines : timeKlines.filter(k => { const t = String(k.t); return t >= '0930' && t <= '1500'; });
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
  const tmin = t => { const s = String(t).replace(':', ''); const m = Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4)); return isHK ? Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780))) : Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660)); };
  const plotW = W - PAD * 2;
  const mapX = isHF ? (i => PAD + (i / (dn - 1)) * plotW) : (i => PAD + (tmin(display[i].t) / TOT) * plotW);
  // 分时MACD小面板数据
  const closes = display.map(k => Number(k.close) || 0);
  const macdData = calcMACD(closes, prevClose);
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
  const macdH = MACD_H - 28;
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
      const mMax = Math.max(...hist.map(Math.abs), 0.0001);
      const mScale = macdH / 2 / mMax;
      for (let i = 0; i < dn; i++) {
        const v = hist[i];
        const bh = Math.abs(v) * mScale;
        const x = mapX(i);
        ctx.fillStyle = v >= 0 ? (upC + 'aa') : (downC + 'aa');
        // 红涨绿跌
        const col = v >= 0 ? '#f5222d' : '#0aa869';
        ctx.fillStyle = col + (v >= 0 ? 'cc' : 'cc');
        ctx.fillRect(x - cw2 / 2, v >= 0 ? macdZeroY - bh : macdZeroY, cw2, bh);
      }
      if (diff.length === dn) {
        const macdCol = '#7b61ff';
        ctx.strokeStyle = macdCol; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let i = 0; i < dn; i++) { const x = mapX(i), y = macdZeroY - diff[i] * mScale; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke();
        // DEA
        const deaIdx = macdData.series ? macdData.series.dea : [];
        if (deaIdx && deaIdx.length === dn) {
          ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1.2; ctx.beginPath();
          for (let i = 0; i < dn; i++) { const x = mapX(i), y = macdZeroY - deaIdx[i] * mScale; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'left';
    const mState = analyzeMACDState(macdData, closes);
    const mtxt = mState
      ? `MACD DIFF ${fp(macdData.dif)}  DEA ${fp(macdData.dea)}  ${mState.hist >= 0 ? '红柱' : '绿柱'}${mState.histTrend === 'expand' ? '↑' : '↓'} ${mState.cross === 'gold' ? '金叉' : mState.cross === 'dead' ? '死叉' : ''}${mState.divergence === 'top' ? ' ⚠顶部背离' : mState.divergence === 'bottom' ? ' 底部背离' : ''}`
      : 'MACD 数据不足';
    ctx.fillText(mtxt, PAD + 4, macdTop + macdH + 12);
  } else {
    ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'left';
    ctx.fillText('MACD 数据不足', PAD + 4, macdTop + macdH + 12);
  }
  // X轴时间标签（价格区下方）
  ctx.textAlign = 'center'; ctx.fillStyle = sub; ctx.font = '12px cjk';
  const xlabels = isHF ? [] : [[0, '09:30'], [59, '10:30'], [119, '11:30'], [180, '14:00'], [TOT - 1, '15:00']];
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
  // 并行拉取：分时 + 日线 + 快照
  const [timeKlines, dayKlines, quote] = await Promise.all([
    fetchStockKline(code, 'time').catch(() => null),
    fetchStockKline(code, 'day').catch(() => null),
    fetchStockQuote(code).catch(() => null),
  ]);
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
    timeInfo = analyzeTTimeData(timeKlines, quote);
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
        ? renderTPngCanvas(code, name, timeKlines, quote, dayInfo, tPos)
        : renderTPngCanvas(code, name, timeKlines, quote, dayInfo, { sellLow: 0, sellHigh: 0, buyLow: 0, buyHigh: 0 });
    } else {
      img = renderStockPng(code, name, '日线', dayKlines, { maPeriods: [5, 10, 20], boll: true, timeMode: false, prec: 2 }, quote);
    }
  } catch (e) { console.error('[/t] 图表生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdT, analyzeTDayForm, analyzeTTimeData, calcTPositions, buildTReport, renderTPngCanvas, calcMACD, analyzeMACDState, _openScenario };
