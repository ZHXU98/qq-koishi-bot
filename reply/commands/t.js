// ============================================================
// /t 做T参谋：形态判断 + 分时黄线分析 + T位建议（原理见 T_GUIDE.md）
// ============================================================
const { cacheGet, cacheSet, normStockName } = require('../utils');
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

// ── 分时现状分析 ──
function analyzeTTimeData(timeKlines, quote) {
  if (!timeKlines || timeKlines.length < 2) return null;
  const lastPrice = (quote && Number(quote.price) > 0) ? Number(quote.price) : timeKlines[timeKlines.length - 1].close;
  const prevClose = (quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : 0;
  const avgLine = buildAvgLine(timeKlines);
  const currentAvg = (avgLine && avgLine.length > 0) ? avgLine[avgLine.length - 1] : 0;
  const avgDev = currentAvg > 0 ? (lastPrice - currentAvg) / currentAvg * 100 : 0;
  // 日内位置
  const dayHigh = (quote && Number(quote.high) > 0) ? Number(quote.high) : Math.max(...timeKlines.map(k => k.high));
  const dayLow = (quote && Number(quote.low) > 0) ? Number(quote.low) : Math.min(...timeKlines.map(k => k.low));
  const range = dayHigh - dayLow;
  const dayPosition = range > 0 ? (lastPrice - dayLow) / range * 100 : 50;
  const amplitude = prevClose > 0 ? range / prevClose * 100 : 0;
  // 量能节奏：近5分钟 vs 前5分钟均量
  const dn = timeKlines.length;
  const rv = timeKlines.slice(-5).map(k => k.vol || 0);
  const pv = dn >= 10 ? timeKlines.slice(-10, -5).map(k => k.vol || 0) : rv;
  const recentAvgVol = rv.reduce((a, b) => a + b, 0) / rv.length;
  const prevAvgVol = pv.reduce((a, b) => a + b, 0) / pv.length;
  const volRatio = prevAvgVol > 0 ? recentAvgVol / prevAvgVol : 1;
  // 均价线斜率（近15分钟黄线方向）
  let avgSlope = 0;
  if (avgLine && avgLine.length >= 15) {
    const old = avgLine[avgLine.length - 15];
    avgSlope = old > 0 ? (avgLine[avgLine.length - 1] - old) / old * 100 : 0;
  }
  return { lastPrice, prevClose, currentAvg, avgDev, dayHigh, dayLow, dayPosition, amplitude, volRatio, avgSlope, avgLine, timeKlines };
}

// ── 计算T位 ──
function calcTPositions(activeForm, timeInfo, dayInfo) {
  const { lastPrice, currentAvg, dayLow, dayHigh } = timeInfo;
  const { bollUp, bollLow, bollMid } = dayInfo;
  const r2 = v => Math.round(v * 100) / 100;
  const base = currentAvg > 0 ? currentAvg : lastPrice;
  const isSwing = activeForm === 'swing' || activeForm === 'unclear';
  // 卖出区
  const sellThLow = isSwing ? 1.5 : 0.8;
  const sellThHigh = isSwing ? 2.8 : 1.5;
  const sellLow = r2(base * (1 + sellThLow / 100));
  const sellHigh = r2(Math.min(bollUp || base * 1.035, base * (1 + sellThHigh / 100)));
  // 买回区：buyLow < buyHigh 始终成立
  // buyThLow > buyThHigh 保证 byDev 的 buyLow < buyHigh；dayLow 仅在严格低于 buyHigh 时做地板
  const buyThHigh = isSwing ? 0.8 : 0.3;
  const buyThLow = isSwing ? 1.8 : 1.0;
  const buyHigh = r2(base * (1 - buyThHigh / 100));
  const buyLowByDev = r2(base * (1 - buyThLow / 100)); // 始终 < buyHigh（thLow > thHigh）
  // dayLow 做地板只在它严格低于 buyHigh 时有意义，否则忽略（避免 buyLow > buyHigh）
  const buyLow = r2(dayLow > 0 && dayLow < buyHigh ? Math.max(dayLow, buyLowByDev) : buyLowByDev);
  // 当前位置
  const inSellZone = lastPrice >= sellLow;
  const inBuyZone = lastPrice <= buyHigh;
  const expectedTDiff = ((sellHigh - buyLow) / base * 100).toFixed(1);
  return { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone, inNeutral: !inSellZone && !inBuyZone, expectedTDiff, base };
}

// ── 生成文字报告（教学式）──
function buildTReport(name, code, autoForm, userFormRaw, timeInfo, dayInfo, tPos) {
  const { lastPrice, currentAvg, avgDev, dayHigh, dayLow, dayPosition, volRatio, amplitude, avgSlope } = timeInfo;
  const { ma5, ma10, ma20, bollUp, bollLow, bollMid, bollWidth } = dayInfo;
  const { sellLow, sellHigh, buyLow, buyHigh, inSellZone, inBuyZone, inNeutral, expectedTDiff } = tPos;
  const now = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
  // 手续费：ETF万0.1双边（免五，无印花税无过户费）≈0.02%；个股万0.8双边+千1印花税+沪市过户费万0.2双向≈0.30%
  const isETF = /^(sh51|sz159)/.test(code);
  const feeRate = isETF ? 0.02 : 0.30;
  const feeDesc = isETF
    ? '买+卖万0.1（免五，无印花税）≈ 0.02%'
    : '买+卖万0.8 + 卖出印花税千1 + 沪市过户费万0.2双向 ≈ 0.30%';
  // 振幅告警阈值：费率的约1.5倍为有效做T最低门槛
  const ampWarnTh = isETF ? 0.08 : 0.45;
  const ampCautionTh = isETF ? 0.20 : 0.80;
  const fp = v => isFinite(v) && v !== null ? Number(v).toFixed(2) : '-';
  const fpct = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  const FORM_LABEL = { uptrend: '上升单边', downtrend: '下降单边', swing: '震荡区间', unclear: '趋势不明' };
  const FORM_EMOJI = { uptrend: '📈', downtrend: '📉', swing: '〰️', unclear: '❓' };
  // 用户指定的形态 label
  const userFormLabel = userFormRaw === 'swing' ? '震荡' : userFormRaw === 'trend' ? '单边趋势' : null;
  const activeForm = userFormRaw === 'swing' ? 'swing' : userFormRaw === 'trend' ?
    (autoForm === 'downtrend' ? 'downtrend' : 'uptrend') : autoForm;
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
  // ── 分时现状 ──
  L.push('━━━ 分时现状 ━━━');
  if (currentAvg > 0) {
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
  L.push('');
  L.push(`日内区间 ${fp(dayLow)} ~ ${fp(dayHigh)}（振幅${amplitude.toFixed(1)}%），当前位于区间 ${dayPosition.toFixed(0)}% 高位`);
  L.push(`→ 位置越高上方空间越小；${dayPosition > 65 ? '⚠️ 偏高位，上方空间已不多' : dayPosition < 35 ? '偏低位，下方空间已不多' : '中间位，双向均有空间'}`);
  L.push('');
  const volDesc = volRatio > 1.5 ? `放量 +${((volRatio - 1) * 100).toFixed(0)}%`
    : volRatio < 0.7 ? `缩量 -${((1 - volRatio) * 100).toFixed(0)}%` : '量能正常';
  L.push(`量能节奏：近5分钟 vs 前5分钟  →  ${volDesc}`);
  if (inSellZone && volRatio < 0.8) L.push(`→ 📍 价涨量缩 = 上涨乏力，T的经典卖出信号（没人在追高）`);
  else if (inSellZone && volRatio > 1.4) L.push(`→ ⚠️ 价涨放量 = 有人追筹，可能是趋势突破，T出后可能追不回来`);
  else if (inBuyZone && volRatio < 0.8) L.push(`→ 📍 价跌量缩 = 下跌钝化，T的买回信号（无人继续砸盘）`);
  else if (inBuyZone && volRatio > 1.4) L.push(`→ ⚠️ 价跌放量 = 有人在砸，等量能再缩后才考虑买回`);
  else L.push(`→ 量价中性，暂无明显T信号`);
  L.push('');
  // ── T位建议 ──
  const stratLabel = activeForm === 'uptrend' ? '上升单边' : activeForm === 'downtrend' ? '下降单边' : '震荡';
  L.push(`━━━ T位建议（${stratLabel}模式）━━━`);
  if (activeForm === 'uptrend') {
    L.push(`⚠️ 上升单边：整体不建议做T（踏空风险大）`);
    L.push(`   趋势股的特征是：涨了还会涨，卖了常常更贵才买回，得不偿失`);
    L.push(`   如坚持做T：每次T量 ≤ 持仓 20%，买回位设在黄线附近`);
    L.push('');
    L.push(`🔴 谨慎卖出：${fp(sellLow)} ~ ${fp(sellHigh)}`);
    L.push(`   理由：偏离黄线 +0.8% 以上（偏贵区），且量能未明显放大`);
    L.push(`   ⚠️ 若放量突破 ${fp(sellHigh)} 以上，不建议卖出，观察是否趋势加速`);
    L.push('');
    L.push(`🟢 买回位：${fp(buyLow)} ~ ${fp(buyHigh)}`);
    L.push(`   理由：回踩黄线附近，均线支撑较强；若跌破黄线则无需着急，可等更低`);
  } else if (activeForm === 'downtrend') {
    L.push(`⚠️ 下降单边：以「反弹T」为主，严控T量（建议 ≤ 持仓 15%）`);
    L.push(`   下行趋势中每次反弹空间有限，做T只能微降均价，无法扭转趋势`);
    L.push(`   重要：若反弹力度超预期，不要因T量过大而被迫高价补仓`);
    L.push('');
    L.push(`🔴 卖出参考：${fp(sellLow)} ~ ${fp(sellHigh)}`);
    L.push(`   理由：反弹到黄线上方（+0.8%），是下降趋势中难得的相对高位`);
    if (ma5) L.push(`   MA5(${fp(ma5)}) 是反弹压力位，靠近时警惕回落`);
    L.push('');
    L.push(`🟢 买回参考：${fp(buyLow)} ~ ${fp(buyHigh)}`);
    L.push(`   理由：等缩量后的阶段低点；不追杀跌，量不缩不买回`);
    if (bollLow) L.push(`   BOLL下轨(${fp(bollLow)}) 有支撑，可作为参考`);
  } else {
    // 震荡
    L.push(`🔴 卖出参考：${fp(sellLow)} ~ ${fp(sellHigh)}`);
    L.push(`   理由：偏离黄线 +1.5% 以上 = 今日成本偏贵区，此时持有者平均亏损，有出货压力`);
    if (bollUp) L.push(`   ↑ BOLL上轨(${fp(bollUp)}) 是强压力，可挂到此位附近`);
    L.push('');
    L.push(`🟢 买回参考：${fp(buyLow)} ~ ${fp(buyHigh)}`);
    L.push(`   理由：黄线附近（偏低 -0.8% 内）= 今日成本中枢，持有者平均有浮盈，下跌意愿弱`);
    if (bollLow) L.push(`   ↓ BOLL下轨(${fp(bollLow)}) 是强支撑，回踩此位量缩可买`);
    L.push('');
    L.push(`📏 T差参考：卖出${fp(sellLow)} → 买回${fp(buyHigh)}，差${fp(Math.max(0, sellLow - buyHigh))}元/股`);
    // 固定用1万元仓位估算盈亏（不问持仓，给个直观参考）
    const tDiffPerShare = Math.max(0, sellLow - buyHigh);
    const refPrice = lastPrice > 0 ? lastPrice : tPos.base;
    const fixedAmt = 10000; // 参考1万元，但最少算1手
    const fixedShares = Math.max(100, Math.floor(fixedAmt / refPrice / 100) * 100); // 买不到1手就按1手算
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
  if (inSellZone) {
    L.push(`🎯 当前 ${fp(lastPrice)} 已进入卖出参考区（≥ ${fp(sellLow)}）`);
    if (volRatio < 0.8) L.push(`   量能缩量确认，信号较强，建议挂单在 ${fp(sellLow)} ~ ${fp(sellHigh)}`);
    else if (volRatio > 1.4) L.push(`   ⚠️ 放量注意！若持续放量是趋势突破，谨慎T出`);
    else L.push(`   可分批挂单在 ${fp(sellLow)} ~ ${fp(sellHigh)}，等冲高机会`);
  } else if (inBuyZone) {
    L.push(`🎯 当前 ${fp(lastPrice)} 已进入买回参考区（≤ ${fp(buyHigh)}）`);
    if (volRatio < 0.8) L.push(`   缩量确认，信号较强，可在 ${fp(buyLow)} ~ ${fp(buyHigh)} 分批买回`);
    else if (volRatio > 1.4) L.push(`   ⚠️ 放量下跌，建议等量能缩减后再买回，不追跌`);
    else L.push(`   可在 ${fp(buyLow)} ~ ${fp(buyHigh)} 区间分批挂单买回`);
  } else {
    L.push(`⏳ 当前 ${fp(lastPrice)} 处于中性区间（两个T位之间）`);
    L.push(`   · 等涨到 ${fp(sellLow)} 以上 → 开始挂卖单准备T出`);
    L.push(`   · 等跌到 ${fp(buyHigh)} 以下 → 准备分批买回`);
    L.push(`   · 现阶段不操作，等更好的点位`);
  }
  if (amplitude < ampWarnTh) {
    L.push('');
    L.push(`⚠️ 今日振幅仅 ${amplitude.toFixed(1)}%，低于手续费成本（${feeRate}%），做T意义不大，建议观望`);
  } else if (amplitude < ampCautionTh) {
    L.push('');
    L.push(`💡 今日振幅 ${amplitude.toFixed(1)}%，T差空间偏小，建议精准挂单，别强求`);
  }
  L.push('');
  L.push(`📈 图表分析正在生成...`);
  L.push(`⚠️ 非投资建议，仅供参考，请结合自身判断操作`);
  return L.join('\n');
}

// ── 图表渲染：分时图 + T位水平标注线 ──
function renderTPngCanvas(code, name, timeKlines, quote, dayInfo, tPos) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD = 74, TITLE_H = 62, VOL_H = 80, LEG_H = 36;
  const plotH = 360;
  const H = TITLE_H + plotH + VOL_H + LEG_H + PAD + 8;
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
  const allP = [...display.map(k => k.close), ...(avgLine || []), prevClose || 0, tPos.sellHigh, tPos.buyLow].filter(v => v > 0);
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const rng = (hi - lo) || 1;
  const pad = rng * 0.06;
  const yMin = lo - pad, yMax = hi + pad;
  const Y = p => TITLE_H + plotH - ((p - yMin) / (yMax - yMin)) * plotH;
  const TOT = isHK ? 330 : 240;
  const tmin = t => { const s = String(t).replace(':', ''); const m = Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4)); return isHK ? Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780))) : Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660)); };
  const plotW = W - PAD * 2;
  const mapX = isHF ? (i => PAD + (i / (dn - 1)) * plotW) : (i => PAD + (tmin(display[i].t) / TOT) * plotW);
  // 配色
  const upC = '#f5222d', downC = '#0aa869';
  const bg = '#ffffff', panel = '#f7f8fa', grid = '#e8eaed', sub = '#8a919c', ink = '#2b2f36';
  const priceCol = chg >= 0 ? upC : downC;
  const fp = v => isFinite(v) ? Number(v).toFixed(2) : '-';
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
  // 昨收虚线
  if (prevClose > 0 && prevClose > yMin && prevClose < yMax) {
    const yRef = Y(prevClose);
    ctx.strokeStyle = 'rgba(138,145,156,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD, yRef); ctx.lineTo(W - PAD, yRef); ctx.stroke(); ctx.setLineDash([]);
    const rl = '昨 ' + fp(prevClose);
    ctx.font = '11px cjk'; const rlw = ctx.measureText(rl).width + 8;
    ctx.fillStyle = 'rgba(138,145,156,0.85)'; ctx.beginPath(); ctx.roundRect(W - PAD + 2, yRef - 10, rlw, 20, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(rl, W - PAD + 2 + rlw / 2, yRef);
  }
  // ── T位标注线 ──
  const drawTLine = (price, color, dash, labelText, labelSide) => {
    if (price <= yMin || price >= yMax) return;
    const yy = Y(price);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(PAD, yy); ctx.lineTo(W - PAD, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = 'bold 12px cjk'; const lw = ctx.measureText(labelText).width + 10;
    const lx = labelSide === 'left' ? PAD : W - PAD - lw;
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(lx, yy - 10, lw, 20, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(labelText, lx + lw / 2, yy);
  };
  drawTLine(tPos.sellHigh, 'rgba(245,34,45,0.9)', [6, 3], `卖出上限 ${fp(tPos.sellHigh)}`, 'left');
  drawTLine(tPos.sellLow, 'rgba(245,34,45,0.55)', [4, 4], `卖出 ${fp(tPos.sellLow)}`, 'left');
  drawTLine(tPos.buyHigh, 'rgba(10,168,105,0.55)', [4, 4], `买回 ${fp(tPos.buyHigh)}`, 'left');
  drawTLine(tPos.buyLow, 'rgba(10,168,105,0.9)', [6, 3], `买回下限 ${fp(tPos.buyLow)}`, 'left');
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
  // 成交量柱
  const volYBase = TITLE_H + plotH + VOL_H + 8;
  const maxVol = Math.max(...display.map(k => k.vol || 0), 1);
  const cw2 = isHF ? Math.max(1.5, plotW / dn * 0.7) : Math.max(1.5, plotW / TOT * 0.7);
  for (let i = 0; i < dn; i++) {
    const v = display[i].vol || 0; if (!v) continue;
    const bh = Math.round((v / maxVol) * VOL_H);
    const x = mapX(i); const col = display[i].close >= (i > 0 ? display[i - 1].close : display[i].close) ? upC : downC;
    ctx.fillStyle = col + '99'; ctx.fillRect(x - cw2 / 2, volYBase - bh, cw2, bh);
  }
  // X轴时间标签
  ctx.textAlign = 'center'; ctx.fillStyle = sub; ctx.font = '12px cjk';
  const xlabels = isHF ? [] : [[0, '09:30'], [59, '10:30'], [119, '11:30'], [180, '14:00'], [TOT - 1, '15:00']];
  xlabels.forEach(([tm, lb]) => ctx.fillText(lb, PAD + (tm / TOT) * plotW, TITLE_H + plotH + 16));
  // 图例
  const yLeg = TITLE_H + plotH + VOL_H + 14;
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
      '功能：基于分时黄线偏离 + 日线结构，判断当前T位合理性，',
      '      给出卖出参考价、买回参考价，以及量价信号解读。',
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
  // 分时分析（盘后无分时时用日线末尾数据补充）
  let timeInfo;
  if (timeKlines && timeKlines.length >= 5) {
    timeInfo = analyzeTTimeData(timeKlines, quote);
  } else {
    const last = dayKlines[dayKlines.length - 1], prev = dayKlines[dayKlines.length - 2];
    timeInfo = {
      lastPrice: (quote && Number(quote.price) > 0) ? Number(quote.price) : last.close,
      prevClose: prev ? prev.close : last.close,
      currentAvg: 0, avgDev: 0,
      dayHigh: (quote && Number(quote.high) > 0) ? Number(quote.high) : last.high,
      dayLow: (quote && Number(quote.low) > 0) ? Number(quote.low) : last.low,
      dayPosition: 50, amplitude: prev ? Math.abs(last.close - prev.close) / prev.close * 100 : 0,
      volRatio: 1, avgSlope: 0, avgLine: null, timeKlines: [],
    };
  }
  // 实际生效的形态
  const activeForm = userFormRaw === 'swing' ? 'swing'
    : userFormRaw === 'trend' ? (dayInfo.form === 'downtrend' ? 'downtrend' : 'uptrend')
    : dayInfo.form;
  const tPos = calcTPositions(activeForm, timeInfo, dayInfo);
  const text = buildTReport(name, code, dayInfo.form, userFormRaw, timeInfo, dayInfo, tPos);
  // 生成图
  let img = null;
  try {
    if (timeKlines && timeKlines.length >= 5) {
      img = renderTPngCanvas(code, name, timeKlines, quote, dayInfo, tPos);
    } else {
      img = renderStockPng(code, name, '日线', dayKlines, { maPeriods: [5, 10, 20], boll: true, timeMode: false, prec: 2 }, quote);
    }
  } catch (e) { console.error('[/t] 图表生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdT, analyzeTDayForm, analyzeTTimeData, calcTPositions, buildTReport, renderTPngCanvas };
