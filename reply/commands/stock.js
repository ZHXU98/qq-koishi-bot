// ============================================================
// /stock 单只股票K线/分时图 + 行情速查
// ============================================================
const { cacheGet, cacheSet, esc, normStockName, f2p, isFundCode } = require('../utils');
const {
  STOCK_QUOTE, STOCK_FQKLINE, STOCK_MINUTE, STOCK_TIMELINE, STOCK_PERIODS, STOCK_PERIOD_LABEL, STOCK_LONG,
  normalizeCode, GLOBAL_ALIAS, GLOBAL_TEXT, EM_IDX_SECID, resolveStockCode,
  calcSMA, calcBOLL, buildAvgLine,
  fetchStockKline, fetchEmKline, HF_SINA_SYM, fetchSinaGlobalMin, aggHfKline, fetchSinaGlobalKline,
  emSecid, fetchEmTrends, fetchStockQuote, getYahooPremarketStatus, emFetchJson,
} = require('../market');

// 渲染 K 线 canvas → PNG base64（@napi-rs/canvas skia 路径，进程级字体缓存，渲染 ~50ms）
// 失败 fallback 到 resvg 版。SVG 元素 → canvas 命令一一映射：rect→fillRect、line→strokeLine、
// path→beginPath+moveTo+lineTo+stroke、text→fillText。
function renderStockPng(code, name, periodLabel, klines, opts, quote) {
  try {
    return renderStockPngCanvas(code, name, periodLabel, klines, opts, quote);
  } catch (e) {
    console.error('[stock] canvas 渲染失败，fallback resvg:', e.message);
    return renderStockPngSvg(code, name, periodLabel, klines, opts, quote);
  }
}

function renderStockPngCanvas(code, name, periodLabel, klines, { maPeriods, boll, timeMode, premarket = false, prec = 2, futures = false, continuous = false, noVolume = false }, quote) {
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-'; // 价格显示精度（ETF 三位小数时 prec=3，普通股票 2）
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD = 74, TITLE_H = 62, VOL_H = noVolume ? 48 : 120;
  const isHK = code.startsWith('hk'); // 港股：字段口径不同，不显示基本面面板
  const isUS = code.startsWith('us');
  const isHF = code.startsWith('hf_'); // 国际商品：接近24h连续交易，分时用索引等距映射
  // 连续交易时段（外盘商品 / 国内期货含夜盘）：分时按索引等距映射，不套用 A股/港股 的时段过滤与分钟对齐
  const contSess = isHF || futures || continuous;
  const prevLabel = futures ? '昨结' : '昨收'; // 期货涨跌基准是昨结算价，不是昨收
  const showInfo = !isHK && !isUS && !!quote && quote.mktCap > 0; // 有市值即显示（ETF 无 PE/PB 也显示，缺的字段留空）
  const LEG_H = timeMode ? 30 : ((maPeriods && maPeriods.length > 0) ? 66 : 40);
  const INFO_H = 98; // 四行：估值 / 股本·市值·股息 / 量能·交易 / 价位
  const H = TITLE_H + VOL_H + LEG_H + (showInfo ? INFO_H : 0) + PAD + 8 + 340;
  const n = klines.length;
  const display = timeMode
    ? (premarket ? klines.filter(k => { const t = String(k.t); return t >= '0400' && t < '0930'; }) : (contSess ? klines : klines.filter(k => { const t = String(k.t); return t >= '0930' && t <= ((isHK || isUS) ? '1600' : '1500'); }))) // 盘前：美东04:00-09:29；普通分时按各市场时段
    : (periodLabel === '日线' ? klines.slice(-60) : klines.slice(-120));
  const dn = display.length;
  const plotW = W - PAD * 2, plotH = H - TITLE_H - VOL_H - LEG_H - (showInfo ? INFO_H : 0) - PAD - 8;

  // 计算指标
  const allCloses = klines.map(k => k.close);
  function bi0(nn, dnn) { return nn - dnn; }
  const maSeries = (maPeriods || []).map(p => {
    const a = new Array(n).fill(null);
    let sum = 0;
    for (let i = 0; i < n; i++) { sum += allCloses[i]; if (i >= p) sum -= allCloses[i - p]; if (i >= p - 1) a[i] = sum / p; }
    return a;
  });
  const bollS = (boll && !timeMode) ? (() => {
    const period = 20, k = 2;
    const mid = maSeries[4] || (() => { const a = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += allCloses[i]; if (i >= period) s -= allCloses[i - period]; if (i >= period - 1) a[i] = s / period; } return a; })();
    const up = new Array(n).fill(null), low = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let v = 0; const m = mid[i];
      for (let j = i - period + 1; j <= i; j++) v += (allCloses[j] - m) ** 2;
      const sd = Math.sqrt(v / period);
      up[i] = m + k * sd; low[i] = m - k * sd;
    }
    return { mid: mid.slice(bi0(n, dn)), up: up.slice(bi0(n, dn)), low: low.slice(bi0(n, dn)) };
  })() : null;

  // 分时：均价/昨收
  const isIndex = /^(sh000|sz399|hkHSI|usDJI|usINX)/.test(code);
  let avgSeries = null, prevCloseRef = 0;
  if (timeMode) {
    if (premarket && Number(klines._prevClose) > 0) prevCloseRef = Number(klines._prevClose);
    else if (quote && Number(quote.prevClose) > 0) prevCloseRef = Number(quote.prevClose);
    if (!isIndex && !premarket && !noVolume) avgSeries = buildAvgLine(display); // 无成交量的外汇/盘前源不绘制伪均价线
  }

  // 价格范围
  const highs = display.map(k => k.high), lows = display.map(k => k.low);
  let allP = [...highs, ...lows];
  if (bollS) for (let i = 0; i < dn; i++) {
    if (bollS.up[i] != null) { allP.push(bollS.up[i]); allP.push(bollS.low[i]); }
  }
  if (timeMode) {
    if (avgSeries) allP.push(...avgSeries);
    if (prevCloseRef) allP.push(prevCloseRef);
  }
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const range = (hi - lo) || 1;
  const padP = range * 0.04;
  const yMin = lo - padP, yMax = hi + padP;
  const X = i => PAD + (i + 0.5) * (plotW / dn);
  const Y = p => TITLE_H + plotH - ((p - yMin) / (yMax - yMin)) * plotH;
  const step = plotW / dn;
  // 分时：X 轴按「交易分钟连续」映射（A股 9:30-11:30/13:00-15:00=240 分钟；港股 9:30-12:00/13:00-16:00=330 分钟），
  // 午休空档压缩成相邻，价格线自然连续（用户要求"连起来"，不强调午休空档）
  const TOT = premarket ? 330 : (isUS ? 390 : (isHK ? 330 : 240));
  const tmin = t => {
    const hh = Number(String(t).slice(0, 2)), mm = Number(String(t).slice(2, 4));
    const m = hh * 60 + mm;
    if (premarket) return Math.min(TOT - 1, Math.max(0, m - 240)); // 美股盘前 04:00-09:30
    if (isUS) return Math.min(TOT - 1, Math.max(0, m - 570)); // 美股 9:30-16:00 连续 390 分钟
    if (isHK) return Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780))); // 上午0-150 下午150-330
    return Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660));
  };
  const mapX = timeMode ? (contSess ? X : (i => PAD + (tmin(display[i].t) / TOT) * plotW)) : X;
  const cw = timeMode ? (contSess ? Math.max(1.5, plotW / dn * 0.7) : Math.max(1.5, plotW / TOT * 0.7)) : Math.max(2, Math.min(8, step * 0.6));

  // 配色
  const upC = '#f5222d', downC = '#0aa869';
  const bg = '#ffffff', panel = '#f7f8fa', grid = '#e8eaed';
  const ink = '#2b2f36', sub = '#8a919c';
  const maCols = ['#333333', '#f56c6c', '#409eff', '#9b59b6', '#2ecc71', '#e67e22', '#95a5a6'];
  const bollCol = '#f0b90b';

  // 最新一根
  const last = klines[n - 1];
  // 分时：现价/昨收用快照（分时数据末行是盘后杂数据，相邻价差≈0 会算错涨跌）；K线用数据收盘价
  // 国际商品(hf_)非分时：新浪日K最后一根与实时快照可能处于不同交易时段，
  // 因此涨跌额与基准统一使用快照口径，避免按相邻日K反算后与标题实时行情不一致。
  const lastPrice = premarket ? Number(last.close) : ((quote && Number(quote.price) > 0) ? Number(quote.price) : last.close);
  // 国际商品/国内期货非分时：涨跌额与基准统一取快照值；全球行情避免跨交易时段的日K偏移，
  // 国内期货则必须使用昨结算价，不能用日K相邻收盘价替代。
  const hfSnapChg = (contSess && !timeMode && quote && isFinite(Number(quote.chg))) ? Number(quote.chg) : NaN;
  const hfBase = (contSess && !timeMode && quote && Number(quote.price) > 0 && isFinite(hfSnapChg))
    ? Number(quote.price) - hfSnapChg : null;
  const prevClose = hfBase != null ? hfBase
    : ((timeMode && premarket && Number(klines._prevClose) > 0) ? Number(klines._prevClose)
      : ((timeMode && quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : (klines[n - 2]?.close ?? last.open)));
  // chg / chgPct 是「图内涨跌」的唯一口径（下方 numChg / numPct 直接引用，不再二次计算）
  const chg = isFinite(hfSnapChg) ? hfSnapChg : (lastPrice - prevClose);
  const chgPct = (isFinite(hfSnapChg) && quote && isFinite(Number(quote.chgPct)))
    ? Number(quote.chgPct) : (prevClose ? (chg / prevClose * 100) : 0);
  const chgCol = chg >= 0 ? upC : downC;
  // 分时：以「今开」为红绿基准（与价格线一致）；其他周期用昨收（标准涨跌幅）
  const openRef = premarket ? (klines[0]?.close ?? lastPrice) : ((quote && Number(quote.open) > 0) ? Number(quote.open) : (klines[0]?.close ?? lastPrice));

  // === 画 canvas（2x 分辨率输出，提升清晰度） ===
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  // codeflicker-fix: UX-Issue-004/2cwkmzcazaep8gv6n769
  // 单股图保持连续白底：分时主图、图例、量能和基本面自然对齐，避免多块白卡造成视觉断裂。
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.font = '13px cjk';
  ctx.textBaseline = 'middle';

  // 标题区
  ctx.fillStyle = panel; ctx.fillRect(0, 0, W, TITLE_H);
  // 左侧渐变 accent 竖条
  const titleAccGrad = ctx.createLinearGradient(PAD, 14, PAD, 52);
  titleAccGrad.addColorStop(0, '#f5222d'); titleAccGrad.addColorStop(1, '#ff7875');
  ctx.fillStyle = titleAccGrad; ctx.fillRect(PAD, 14, 5, 38);
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.font = 'bold 24px cjk';
  ctx.fillText(name, PAD + 16, 34);
  ctx.fillStyle = sub; ctx.font = '16px cjk';
  const displayCode = code.startsWith('fx_') ? code.slice(3).toUpperCase() : code.toUpperCase();
  ctx.fillText(displayCode, PAD + 16 + name.length * 24 + 8, 34);
  ctx.fillStyle = sub; ctx.font = '13px cjk';
  ctx.fillText(periodLabel, PAD + 16, 54);
  // 标题右侧：现价 + 涨跌（去掉「今日价格」文字标签）
  ctx.textAlign = 'right';
  const dCol = chgCol;
  const numChg = chg;
  const numPct = chgPct;
  ctx.fillStyle = dCol; ctx.font = 'bold 28px cjk';
  ctx.fillText(fp(lastPrice), W - PAD, 38);
  ctx.font = '15px cjk';
  const chgTxt = `${numChg >= 0 ? '+' : ''}${fp(numChg)}  (${numPct >= 0 ? '+' : ''}${numPct.toFixed(2)}%)`;
  ctx.fillText(chgTxt, W - PAD, 58);

  // 网格 + Y 轴
  const gridN = 5;
  ctx.setLineDash([4, 4]); // 虚线网格（更柔和）
  for (let i = 0; i <= gridN; i++) {
    const p = yMin + (yMax - yMin) * i / gridN;
    const y = Y(p);
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    ctx.fillStyle = sub; ctx.font = '12px cjk'; ctx.textAlign = 'right';
    ctx.fillText(fp(p), PAD - 10, y + 4);
  }
  ctx.setLineDash([]);

  // X 轴时间标签：画在主图底部内侧（分时精确对齐曲线时刻 tmin 映射，无人工偏移；
  // 11:30 与 13:00 在连续映射下相邻仅 1 格≈3.6px，13:00 不重复标注避免重叠与错位）
  ctx.textAlign = 'center';
  if (timeMode) {
    // 连续时段（外盘商品/国内期货）：取首/中/末时间标签；A股：09:30/10:30/11:30/14:00/15:00；
    // 港股：09:30/10:30/11:30/14:00/15:00/16:00（12:00/13:00 相邻不重复标）；美股 09:30-16:00 连续均匀标
    // 注意 外盘商品与国内期货分时的 t 可能是带冒号的 "06:00"，A股/港美股是紧凑的 "0930"——
    // 先去掉冒号再插，否则会拼成 "06::0"（外盘分时横轴标签一直是这样，2026-09-11 修）
    const fmtT = t => { const s = String(t).replace(':', ''); return s.slice(0, 2) + ':' + s.slice(2, 4); };
    const lbs = contSess
      ? [[0, fmtT(display[0].t)], [Math.floor(dn / 2), fmtT(display[Math.floor(dn / 2)].t)], [dn - 1, fmtT(display[dn - 1].t)]]
      : (premarket
        ? [[0, '04:00'], [90, '05:30'], [180, '07:00'], [270, '08:30'], [TOT - 1, '09:30']]
        : (isUS
          ? [[0, '09:30'], [90, '11:00'], [180, '12:30'], [270, '14:00'], [TOT - 1, '16:00']]
        : (isHK ? [[0, '09:30'], [60, '10:30'], [120, '11:30'], [180, '14:00'], [240, '15:00'], [TOT - 1, '16:00']] : [[0, '09:30'], [59, '10:30'], [119, '11:30'], [180, '14:00'], [TOT - 1, '15:00']])));
    lbs.forEach(([tm, lb]) => {
      ctx.fillStyle = sub; ctx.font = '12px cjk';
      // hf_ 的 lbs[0] 是「数据索引」而非分钟数（TOT=240 只对 A股/港美股成立），
      // 必须走等距映射 X()，否则 x = tm/TOT*plotW 会把中末标签甩到画布外（SVG 路径本就如此，canvas 漏了）
      ctx.fillText(lb, contSess ? X(tm) : (PAD + (tm / TOT) * plotW), TITLE_H + plotH + 16);
    });
  } else {
    [0, Math.floor((dn - 1) / 2), dn - 1].forEach(i => {
      const t = String(display[i].t);
      const label = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t)
        ? t.slice(5, 16)
        : (periodLabel.startsWith('日线') ? t.slice(5) : ((periodLabel.startsWith('周线') || periodLabel.startsWith('月线')) ? t.slice(2, 7) : t.slice(8, 12).replace(/(\d{2})(\d{2})/, '$1:$2')));
      ctx.fillStyle = sub; ctx.font = '12px cjk';
      ctx.fillText(label, X(i), TITLE_H + plotH + 16);
    });
  }

  // 图例纵坐标
  const yLegend = TITLE_H + plotH + 34;

  if (timeMode) {
    // 昨收基准
    if (prevCloseRef) {
      const yRef = Y(prevCloseRef);
      ctx.strokeStyle = 'rgba(138,145,156,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(PAD, yRef); ctx.lineTo(W - PAD, yRef); ctx.stroke(); ctx.setLineDash([]);
      // 昨收标签：改为右侧轴外小标注
      const refLabel = (prevLabel === '昨结' ? '昨结 ' : '昨 ') + fp(prevCloseRef);
      ctx.font = '11px cjk';
      const refLW = ctx.measureText(refLabel).width + 8;
      ctx.fillStyle = 'rgba(138,145,156,0.85)'; ctx.beginPath(); ctx.roundRect(W - PAD + 2, yRef - 10, refLW, 20, 3); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '11px cjk';
      ctx.fillText(refLabel, W - PAD + 2 + refLW / 2, yRef);
    }
    // 价格线颜色：按「昨收」判断（红涨绿跌标准口径）——现价 < 昨收（负收益）必须绿色。
    // 早期曾用「今开」作红绿基准，导致尾盘出现「现价 2904 < 昨收 2910 却仍是红线」的负收益红盘，
    // 2026-09-11 用户纠正为按昨收。与标题右上角 chgCol 保持一致。
    const priceCol = chg >= 0 ? upC : downC;
    if (dn > 0) {
      // 渐变填充（价格线下方半透明区域）
      const fillGrad = ctx.createLinearGradient(0, TITLE_H, 0, TITLE_H + plotH);
      const fillRgb = chg >= 0 ? '245,34,45' : '10,168,105';
      fillGrad.addColorStop(0, `rgba(${fillRgb},0.18)`);
      fillGrad.addColorStop(0.7, `rgba(${fillRgb},0.05)`);
      fillGrad.addColorStop(1, `rgba(${fillRgb},0)`);
      ctx.fillStyle = fillGrad;
      ctx.beginPath();
      const yBase = TITLE_H + plotH;
      ctx.moveTo(mapX(0), yBase);
      for (let i = 0; i < dn; i++) ctx.lineTo(mapX(i), Y(display[i].close));
      ctx.lineTo(mapX(dn - 1), yBase);
      ctx.closePath();
      ctx.fill();
      // 价格线
      ctx.strokeStyle = priceCol; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < dn; i++) {
        const px = mapX(i);
        if (i === 0) ctx.moveTo(px, Y(display[i].close)); else ctx.lineTo(px, Y(display[i].close));
      }
      ctx.stroke();
      // 均价线
      if (avgSeries) {
        ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1.4; ctx.beginPath();
        for (let i = 0; i < dn; i++) {
          const px = mapX(i);
          if (i === 0) ctx.moveTo(px, Y(avgSeries[i])); else ctx.lineTo(px, Y(avgSeries[i]));
        }
        ctx.stroke();
      }
      // codeflicker-fix: UX-Issue-006/p6gook46ctx42xf7wi3h
      // 高低点反映当日盘中振幅，使用今开而不是昨收做百分比基准；昨收仍只服务日涨跌和昨收参考线。
      if (openRef > 0 && dn > 0) {
        const hiIndex = display.reduce((best, k, i) => Number(k.high) > Number(display[best].high) ? i : best, 0);
        const loIndex = display.reduce((best, k, i) => Number(k.low) < Number(display[best].low) ? i : best, 0);
        const drawExtremum = (index, value, label, color, placeAbove) => {
          const px = mapX(index), py = Y(value);
          const pctToOpen = (value - openRef) / openRef * 100;
          const txt = `${label} ${fp(value)}（较开 ${pctToOpen >= 0 ? '+' : ''}${pctToOpen.toFixed(2)}%）`;
          ctx.font = 'bold 11px cjk';
          const tw = ctx.measureText(txt).width + 10, th = 19;
          const preferRight = px < PAD + plotW * 0.62;
          let lx = preferRight ? px + 8 : px - tw - 8;
          lx = Math.max(PAD + 2, Math.min(W - PAD - tw - 2, lx));
          let ly = placeAbove ? py - th - 8 : py + 8;
          ly = Math.max(TITLE_H + 3, Math.min(TITLE_H + plotH - th - 3, ly));
          ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, 2.8, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.fillRect(lx, ly, tw, th);
          ctx.strokeStyle = color + '99'; ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, th - 1);
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(txt, lx + 5, ly + th / 2);
        };
        drawExtremum(hiIndex, Number(display[hiIndex].high), '最高', upC, true);
        if (loIndex !== hiIndex) drawExtremum(loIndex, Number(display[loIndex].low), '最低', downC, false);
      }
    }
    // 图例与主图连续排版，避免分时图出现不齐的白色区块。
    ctx.fillStyle = panel; ctx.fillRect(PAD - 8, yLegend, W - PAD * 2 + 16, 30);
    const lg = [[`价格 ${fp(lastPrice)}`, priceCol]];
    if (avgSeries) lg.push([`均价 ${fp(avgSeries[dn - 1])}`, '#f0b90b']);
    if (prevCloseRef) lg.push([`${prevLabel} ${fp(prevCloseRef)}`, sub]);
    ctx.textAlign = 'left';
    lg.forEach((it, i) => {
      const cx = PAD + 60 + i * 220;
      // 圆点替代方块
      ctx.fillStyle = it[1]; ctx.beginPath(); ctx.arc(cx - 53, yLegend + 14, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = ink; ctx.font = '13px cjk';
      ctx.fillText(it[0], cx - 42, yLegend + 14);
    });
  } else {
    // 非分时：BOLL + MA + K线 + 最新价标注 + 图例
    if (bollS) {
      // 上下轨虚线
      const drawBollLine = (arr, dash) => { ctx.strokeStyle = bollCol; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); let started = false; for (let i = 0; i < dn; i++) { if (arr[i] == null) continue; if (!started) { ctx.moveTo(X(i), Y(arr[i])); started = true; } else ctx.lineTo(X(i), Y(arr[i])); } ctx.stroke(); ctx.setLineDash([]); };
      drawBollLine(bollS.up, [6, 4]); drawBollLine(bollS.low, [6, 4]);
      // 中轨
      ctx.strokeStyle = bollCol; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false; for (let i = 0; i < dn; i++) { if (bollS.mid[i] == null) continue; if (!started) { ctx.moveTo(X(i), Y(bollS.mid[i])); started = true; } else ctx.lineTo(X(i), Y(bollS.mid[i])); } ctx.stroke();
    }
    // MA（maSeries 为全量数组，绘制时按 bi0 对齐到显示区）
    const bi = n - dn;
    maSeries.forEach((series, idx) => {
      ctx.strokeStyle = maCols[idx % maCols.length]; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false;
      for (let i = 0; i < dn; i++) {
        const v = series[bi + i];
        if (v == null) continue;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      }
      ctx.stroke();
    });
    // K线
    for (let i = 0; i < dn; i++) {
      const k = display[i];
      const up = k.close >= k.open;
      const col = up ? upC : downC;
      const x = X(i);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(k.high)); ctx.lineTo(x, Y(k.low)); ctx.stroke();
      const top = Math.min(Y(k.open), Y(k.close)), hgt = Math.max(1.2, Math.abs(Y(k.open) - Y(k.close)));
      if (up) {
        // 涨：空心红（白底 + 红描边，A股习惯）
        ctx.fillStyle = '#ffffff'; ctx.fillRect(x - cw / 2, top, cw, hgt);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(x - cw / 2, top, cw, hgt);
      } else {
        // 跌：实心绿
        ctx.fillStyle = col; ctx.fillRect(x - cw / 2, top, cw, hgt);
      }
    }
    // 最新价横虚线 + 色块标签
    const yLast = Y(lastPrice);
  // 最新价标注：分时按今开红绿（与价格线/右上角一致），其他周期按昨收
  const markCol = chgCol; // 最新价标注颜色与右上角一致（昨收基准）
  ctx.strokeStyle = markCol; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(PAD, yLast); ctx.lineTo(W - PAD, yLast); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = markCol; ctx.fillRect(W - PAD, yLast - 12, 64, 24);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 13px cjk';
    ctx.fillText(fp(lastPrice), W - PAD + 32, yLast + 4);
    // 图例与主图连续排版，颜色与所画线一一对应。
    ctx.fillStyle = panel; ctx.fillRect(PAD - 8, yLegend, W - PAD * 2 + 16, LEG_H);
    const legendItems = [];
    if (bollS) legendItems.push(['BOLL', bollCol, bollS.mid[dn - 1]]);
    (maPeriods || []).forEach((p, idx) => legendItems.push([`MA${p}`, maCols[idx % maCols.length], maSeries[idx][n - 1]]));
    const itemsPerRow = Math.ceil(legendItems.length / 2) || 1;
    const colW = (W - PAD * 2) / itemsPerRow;
    ctx.textAlign = 'left';
    legendItems.forEach((it, idx) => {
      const row = idx < itemsPerRow ? 0 : 1;
      const col = idx < itemsPerRow ? idx : idx - itemsPerRow;
      const cx = PAD + colW * col + colW / 2;
      const cy = yLegend + 14 + row * 26;
      ctx.fillStyle = it[1]; ctx.beginPath(); ctx.arc(cx - colW / 2 + 15, cy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = ink; ctx.font = '13px cjk';
      ctx.fillText(`${it[0]} ${it[2] != null ? fp(it[2]) : '-'}`, cx - colW / 2 + 26, cy);
    });
  }

  // 成交量副图（fetchStockKline 已把 vol 差分好，渲染直接用）
  const volOf = (k, i) => k.vol;
  const vols = display.map((k, i) => volOf(k, i));
  const volBase = Math.max(...vols.slice(1), 1);
  const volTop = yLegend + LEG_H + 6;
  const volH = VOL_H - 22;
  // 外盘商品部分品种数据源不给量（黄金/白银/原油/天然气/美铜恒为 0）→ 画占位说明，不留空面板
  const noVol = !vols.some(v => Number(v) > 0);
  if (noVol) {
    ctx.fillStyle = sub; ctx.font = '13px cjk'; ctx.textAlign = 'center';
    ctx.fillText(noVolume ? '外汇现货无集中成交量' : '该品种数据源不提供成交量', W / 2, volTop + volH / 2);
  } else {
    for (let i = 0; i < dn; i++) {
      const k = display[i];
      const vh = Math.min(volOf(k, i), volBase * 2) / volBase * volH;
      const col = k.close >= (i > 0 ? display[i - 1].close : k.close) ? upC : downC;
      const xk = timeMode ? mapX(i) : X(i);
      ctx.fillStyle = col; ctx.globalAlpha = 0.4;
      ctx.fillRect(xk - cw / 2, volTop + volH - vh, cw, vh);
      ctx.globalAlpha = 1;
    }
  }
  if (!noVolume) {
    ctx.fillStyle = sub; ctx.textAlign = 'left'; ctx.font = '12px cjk';
    ctx.fillText('成交量', PAD, volTop + volH + 16);
  }

  // 基本面面板（个股）
  if (showInfo) {
    const infoTop = volTop + volH + 26;
    ctx.fillStyle = panel; ctx.fillRect(PAD - 8, infoTop - 6, W - PAD * 2 + 16, INFO_H);
    ctx.fillStyle = ink;
    // 数值格式化：无值(0/NaN)一律留空（ETF 无 PE/PB 等基本面字段 → 空白）
    const fb = (v, d = 2) => (v && isFinite(v) && Number(v) !== 0) ? Number(v).toFixed(d) : '';
    const fbu = (v, unit, d = 2) => (v && isFinite(v) && Number(v) !== 0) ? Number(v).toFixed(d) + unit : '';
    const fbp = v => (v && isFinite(v) && Number(v) !== 0) ? Number(v).toFixed(prec) : ''; // 价格按品种精度（ETF 三位小数）
    const yib = v => Number(v) > 0 ? (Number(v) / 1e8).toFixed(2) + '亿' : '';             // 股本(股)→亿股
    const amtYi = v => Number(v) > 0 ? (Number(v) / 1e4).toFixed(2) + '亿' : '';           // 成交额(A股=万元)→亿元
    const divAmt = quote.divYield > 0 ? quote.divYield * quote.price / 100 : 0;
    // hl: 1=红色加粗（PE动/PB 动态估值），2=深色加粗（价位 突出）
    const rows = [
      [
        { l: '市盈率(动)', v: fb(quote.peDyn), hl: 1 },
        { l: '市盈率(TTM)', v: fb(quote.peTtm) },
        { l: '市盈率(静)', v: fb(quote.peStatic) },
        { l: '市净率', v: fb(quote.pb), hl: 1 },
        { l: '每股收益', v: fb(quote.eps) },
        { l: '每股净资产', v: fb(quote.bvps) },
      ],
      [
        { l: '总股本', v: yib(quote.totalShares) },
        { l: '总市值', v: fbu(quote.mktCap, '亿') },
        { l: '流通股', v: yib(quote.floatShares) },
        { l: '流通值', v: fbu(quote.floatMktCap, '亿') },
        { l: '股息率(TTM)', v: fbu(quote.divYield, '%') },
        { l: '股息(TTM)', v: fb(divAmt) },
      ],
      [
        { l: '换手率', v: fbu(quote.turnover, '%') },
        { l: '量比', v: fb(quote.volumeRatio) },
        { l: '振幅', v: fbu(quote.amplitude, '%') },
        { l: '成交额', v: amtYi(quote.amount) },
        { l: '均价', v: fbp(quote.avgPrice) },
        { l: '昨收', v: fbp(quote.prevClose) },
      ],
      [
        { l: '今开', v: fbp(quote.open), hl: 2 },
        { l: '最高', v: fbp(quote.high), hl: 2 },
        { l: '最低', v: fbp(quote.low), hl: 2 },
        { l: '涨停', v: fbp(quote.limitUp), hl: 2 },
        { l: '跌停', v: fbp(quote.limitDown), hl: 2 },
      ],
    ];
    const colW = (W - PAD * 2) / 6;
    ctx.textAlign = 'left';
    rows.forEach((items, ri) => items.forEach((it, ci) => {
      const x = PAD + colW * ci + 10;
      const y = infoTop + 14 + ri * 24;
      ctx.fillStyle = sub; ctx.font = '12px cjk';
      ctx.fillText(it.l, x, y);
      const vx = x + ctx.measureText(it.l).width + 5;
      if (it.hl === 1) { ctx.fillStyle = upC; ctx.font = 'bold 12.5px cjk'; }
      else if (it.hl === 2) { ctx.fillStyle = '#1a1d23'; ctx.font = 'bold 13px cjk'; }
      else { ctx.fillStyle = ink; ctx.font = '12.5px cjk'; }
      ctx.fillText(it.v, vx, y);
    }));
  }

  // 右下角生成时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  ctx.fillText('生成 ' + hhmm, W - PAD, H - 12);

  // 编码 base64
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// 渲染 K 线 SVG → PNG base64（resvg fallback，@napi-rs/canvas 失败时使用）
function renderStockPngSvg(code, name, periodLabel, klines, { maPeriods, boll, timeMode, premarket = false, prec = 2, futures = false, continuous = false, noVolume = false }, quote) {
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-'; // 价格显示精度（ETF 三位小数时 prec=3，普通股票 2）
  const W = 1000, PAD = 74, TITLE_H = 62, VOL_H = noVolume ? 48 : 120;
  const isHK = code.startsWith('hk'); // 港股：字段口径不同，不显示基本面面板
  const isUS = code.startsWith('us');
  const isHF = code.startsWith('hf_'); // 国际商品：接近24h连续交易，分时用索引等距映射
  // 连续交易时段（外盘商品 / 国内期货含夜盘）：分时按索引等距映射，不套用 A股/港股 的时段过滤与分钟对齐
  const contSess = isHF || futures || continuous;
  const prevLabel = futures ? '昨结' : '昨收'; // 期货涨跌基准是昨结算价，不是昨收
  const showInfo = !isHK && !isUS && !!quote && quote.mktCap > 0; // 有市值即显示（ETF 无 PE/PB 也显示，缺的字段留空）
  // 分时：图例条占 30px（价格/均价/昨收），需计入否则成交量柱会捅进图例区；日线 66（两行）、分钟线 40（单行）
  const LEG_H = timeMode ? 30 : ((maPeriods && maPeriods.length > 0) ? 66 : 40);
  const INFO_H = 98; // 四行：估值 / 股本·市值·股息 / 量能·交易 / 价位
  const H = TITLE_H + VOL_H + LEG_H + (showInfo ? INFO_H : 0) + PAD + 8 + 340; // plotH 约 340+，总高自适应
  const n = klines.length;
  // 显示根数：分时=当天全部分钟（≤240）；日线=60 根（3 个月，指数日波动 20 点左右，根数过多会把近期波动压扁）；其余分钟线=120 根
  const display = timeMode
    ? (premarket ? klines.filter(k => { const t = String(k.t); return t >= '0400' && t < '0930'; }) : (contSess ? klines : klines.filter(k => { const t = String(k.t); return t >= '0930' && t <= ((isHK || isUS) ? '1600' : '1500'); }))) // 盘前：美东04:00-09:29；普通分时按各市场时段
    : (periodLabel === '日线' ? klines.slice(-60) : klines.slice(-120));
  const dn = display.length;
  const plotW = W - PAD * 2, plotH = H - TITLE_H - VOL_H - LEG_H - (showInfo ? INFO_H : 0) - PAD - 8;
  const highs = display.map(k => k.high), lows = display.map(k => k.low);

  // 计算指标（全量后切片）——先算，供价格范围与绘制共用
  const allCloses = klines.map(k => k.close);
  const maSeries = (maPeriods || []).map(p => calcSMA(allCloses, p).slice(bi0(n, dn)));
  const bollS = (boll && !timeMode) ? (() => { const b = calcBOLL(allCloses); return { mid: b.mid.slice(bi0(n, dn)), up: b.up.slice(bi0(n, dn)), low: b.low.slice(bi0(n, dn)) }; })() : null;
  function bi0(nn, dnn) { return nn - dnn; }

  // 分时模式：均价线 = 累计额/累计量（元/股），昨收为基准线
  // 注意：指数（sh000xxx / sz399xxx）分时数据的累计额/量是成分股合计（万亿/百亿手），
  //       算出的"均价"是无意义的垃圾值（上证实测 -200~4000，会撑爆 Y 轴），指数分时不画均价线（与行情软件一致）
  const isIndex = /^(sh000|sz399|hkHSI|usDJI|usINX)/.test(code);
  let avgSeries = null, prevCloseRef = 0;
  if (timeMode) {
    if (premarket && Number(klines._prevClose) > 0) prevCloseRef = Number(klines._prevClose);
    else if (quote && Number(quote.prevClose) > 0) prevCloseRef = Number(quote.prevClose);
    if (!isIndex && !premarket && !noVolume) avgSeries = buildAvgLine(display); // 无成交量的外汇/盘前源不绘制伪均价线
  }

  // 价格范围：高低点 + BOLL 上下轨 + 均价 + 昨收基准
  let allP = [...highs, ...lows];
  if (bollS) {
    for (let i = 0; i < dn; i++) {
      if (bollS.up[i] != null) { allP.push(bollS.up[i]); allP.push(bollS.low[i]); }
    }
  }
  if (timeMode) {
    if (avgSeries) allP.push(...avgSeries);
    if (prevCloseRef) allP.push(prevCloseRef);
  }
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const range = (hi - lo) || 1;
  const padP = range * 0.04; // Y 轴上下缓冲（紧凑，避免把近期波动压扁）
  const yMin = lo - padP, yMax = hi + padP;
  const X = i => PAD + (i + 0.5) * (plotW / dn);
  const Y = p => TITLE_H + plotH - ((p - yMin) / (yMax - yMin)) * plotH;
  const step = plotW / dn;
  // 分时模式：X 轴按「交易分钟连续」映射（A股 240 分钟；港股 9:30-12:00/13:00-16:00=330 分钟），午休相邻不强调
  const TOT = premarket ? 330 : (isUS ? 390 : (isHK ? 330 : 240));
  const tmin = t => {
    const hh = Number(String(t).slice(0, 2)), mm = Number(String(t).slice(2, 4));
    const m = hh * 60 + mm;
    if (premarket) return Math.min(TOT - 1, Math.max(0, m - 240)); // 美股盘前 04:00-09:30
    if (isUS) return Math.min(TOT - 1, Math.max(0, m - 570)); // 美股 9:30-16:00 连续 390 分钟
    if (isHK) return Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780))); // 上午0-150 下午150-330
    return Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660));
  };
  const mapX = timeMode ? (contSess ? X : (i => PAD + (tmin(display[i].t) / TOT) * plotW)) : X;
  const cw = timeMode ? (contSess ? Math.max(1.5, plotW / dn * 0.7) : Math.max(1.5, plotW / TOT * 0.7)) : Math.max(2, Math.min(8, step * 0.6)); // K线/分时柱宽

  // 白底配色
  const upCol = '#f5222d', downCol = '#0aa869'; // A股红涨绿跌
  const bg = '#ffffff', panel = '#f7f8fa', grid = '#e8eaed';
  const ink = '#2b2f36', sub = '#8a919c';
  const maCols = ['#333333', '#f56c6c', '#409eff', '#9b59b6', '#2ecc71', '#e67e22', '#95a5a6']; // MA5 黑线（用户指定），其余保持
  const bollCol = '#f0b90b';

  // 最新一根 & 涨跌
  const last = klines[n - 1];
  // 分时：现价/昨收用快照（分时末行是盘后杂数据，相邻价差≈0 会算错涨跌）；K线用数据收盘价
  const lastPrice = premarket ? Number(last.close) : ((quote && Number(quote.price) > 0) ? Number(quote.price) : last.close);
  // 国际商品/国内期货非分时：涨跌额与基准一律取快照自带值（原因见 renderStockPngCanvas 同处注释）
  const hfSnapChg = (contSess && !timeMode && quote && isFinite(Number(quote.chg))) ? Number(quote.chg) : NaN;
  const hfBase = (contSess && !timeMode && quote && Number(quote.price) > 0 && isFinite(hfSnapChg))
    ? Number(quote.price) - hfSnapChg : null;
  const prevClose = hfBase != null ? hfBase
    : ((timeMode && premarket && Number(klines._prevClose) > 0) ? Number(klines._prevClose)
      : ((timeMode && quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : (klines[n - 2]?.close ?? last.open)));
  const chg = isFinite(hfSnapChg) ? hfSnapChg : (lastPrice - prevClose);
  const chgPct = (isFinite(hfSnapChg) && quote && isFinite(Number(quote.chgPct)))
    ? Number(quote.chgPct) : (prevClose ? (chg / prevClose * 100) : 0);
  const isUp = chg >= 0;
  const chgCol = isUp ? upCol : downCol;
  // 分时：以「今开」为红绿基准（与价格线一致）；其他周期用昨收
  const openRef = premarket ? (klines[0]?.close ?? lastPrice) : ((quote && Number(quote.open) > 0) ? Number(quote.open) : (klines[0]?.close ?? lastPrice));

  const displayCode = code.startsWith('fx_') ? code.slice(3).toUpperCase() : code.toUpperCase();
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>
<rect x="0" y="0" width="${W}" height="${TITLE_H}" fill="${panel}"/>
<text x="${PAD}" y="34" font-family="PingFang SC,Hiragino Sans GB,cjk" font-size="24" font-weight="bold" fill="${ink}">${esc(name)} <tspan fill="${sub}" font-size="16">${esc(displayCode)}</tspan></text>
<text x="${PAD}" y="54" font-family="PingFang SC,cjk" font-size="13" fill="${sub}">${periodLabel}</text>`;
  // 标题右侧：今天价格（颜色分时按今开，其他按昨收；涨跌额/涨跌幅数字一律按昨收标准收益率）
  const dCol = chgCol; // 右上角颜色与收益率统一按昨收（红涨绿跌标准口径）
  const numChg = chg;
  const numPct = chgPct;
  s += `<text x="${W - PAD}" y="30" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" fill="${sub}">今日价格</text>`;
  s += `<text x="${W - PAD}" y="52" text-anchor="end" font-family="PingFang SC,cjk" font-size="26" font-weight="bold" fill="${dCol}">${fp(lastPrice)}</text>`;
  s += `<text x="${W - PAD}" y="70" text-anchor="end" font-family="PingFang SC,cjk" font-size="15" fill="${dCol}">${numChg >= 0 ? '+' : ''}${fp(numChg)} (${numPct >= 0 ? '+' : ''}${numPct.toFixed(2)}%)</text>`;

  // 网格 + Y 轴
  const gridN = 5;
  for (let i = 0; i <= gridN; i++) {
    const p = yMin + (yMax - yMin) * i / gridN;
    const y = Y(p);
    s += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${grid}" stroke-width="1" stroke-dasharray="4 4"/>`;
    s += `<text x="${PAD - 10}" y="${y + 5}" text-anchor="end" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${fp(p)}</text>`;
  }
  // X 轴时间标签：分时精确对齐曲线时刻 tmin 映射（12:00/13:00 相邻不重复标）；连续时段取首/中/末；其余取首/中/末
  if (timeMode) {
    // 注意 外盘商品与国内期货分时的 t 可能是带冒号的 "06:00"，A股/港美股是紧凑的 "0930"——
    // 先去掉冒号再插，否则会拼成 "06::0"（外盘分时横轴标签一直是这样，2026-09-11 修）
    const fmtT = t => { const s = String(t).replace(':', ''); return s.slice(0, 2) + ':' + s.slice(2, 4); };
    const lbs = contSess
      ? [[0, fmtT(display[0].t)], [Math.floor(dn / 2), fmtT(display[Math.floor(dn / 2)].t)], [dn - 1, fmtT(display[dn - 1].t)]]
      : (premarket
        ? [[0, '04:00'], [90, '05:30'], [180, '07:00'], [270, '08:30'], [TOT - 1, '09:30']]
        : (isUS
          ? [[0, '09:30'], [90, '11:00'], [180, '12:30'], [270, '14:00'], [TOT - 1, '16:00']]
        : (isHK ? [[0, '09:30'], [60, '10:30'], [120, '11:30'], [180, '14:00'], [240, '15:00'], [TOT - 1, '16:00']] : [[0, '09:30'], [59, '10:30'], [119, '11:30'], [180, '14:00'], [TOT - 1, '15:00']])));
    lbs.forEach(([tm, lb]) => {
      const x = contSess ? X(tm) : (PAD + (tm / TOT) * plotW);
      s += `<text x="${x.toFixed(1)}" y="${TITLE_H + plotH + 16}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${lb}</text>`;
    });
  } else {
    const ticks = [0, Math.floor((dn - 1) / 2), dn - 1];
    ticks.forEach(i => {
      const t = String(display[i].t);
      const label = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t)
        ? t.slice(5, 16)
        : (periodLabel.startsWith('日线') ? t.slice(5) : ((periodLabel.startsWith('周线') || periodLabel.startsWith('月线')) ? t.slice(2, 7) : t.slice(8, 12).replace(/(\d{2})(\d{2})/, '$1:$2')));
      s += `<text x="${X(i)}" y="${TITLE_H + plotH + 16}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${label}</text>`;
    });
  }

  // 图例区纵坐标（两种模式共用）
  const yLegend = TITLE_H + plotH + 34;

  if (timeMode) {
    // —— 分时模式：昨收基准虚线 + 价格线 + 均价线 ——
    if (prevCloseRef) {
      const yRef = Y(prevCloseRef);
      s += `<line x1="${PAD}" y1="${yRef}" x2="${W - PAD}" y2="${yRef}" stroke="${sub}" stroke-width="1.1" stroke-dasharray="4 4" opacity="0.8"/>`;
      s += `<rect x="${PAD - 6}" y="${yRef - 10}" width="70" height="20" rx="3" fill="${sub}"/>`;
      s += `<text x="${PAD + 29}" y="${yRef + 4}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="11" fill="#fff">${prevLabel} ${fp(prevCloseRef)}</text>`;
    }
    // 价格线颜色：按「昨收」判断（红涨绿跌，见 renderStockPngCanvas 同处注释）
    const priceCol = chg >= 0 ? upCol : downCol;
    let dPrice = '', dAvg = '';
    for (let i = 0; i < dn; i++) {
      const px = mapX(i).toFixed(1);
      dPrice += (i === 0 || !dPrice ? 'M ' : 'L ') + px + ' ' + Y(display[i].close).toFixed(1) + ' ';
      if (avgSeries) dAvg += (i === 0 || !dAvg ? 'M ' : 'L ') + px + ' ' + Y(avgSeries[i]).toFixed(1) + ' ';
    }
    s += `<path d="${dPrice}" fill="none" stroke="${priceCol}" stroke-width="2"/>`;
    if (avgSeries) s += `<path d="${dAvg}" fill="none" stroke="#f0b90b" stroke-width="1.4"/>`;
    // 图例：价格 / 均价（仅个股） / 昨收（整体下移 16px，避开 X 轴时间标签）
    s += `<rect x="${PAD - 8}" y="${yLegend}" width="${W - PAD * 2 + 16}" height="30" rx="8" fill="${panel}"/>`;
    const lg = [[`价格 ${fp(lastPrice)}`, priceCol]];
    if (avgSeries) lg.push([`均价 ${fp(avgSeries[dn - 1])}`, '#f0b90b']);
    if (prevCloseRef) lg.push([`${prevLabel} ${fp(prevCloseRef)}`, sub]);
    lg.forEach((it, i) => {
      const cx = PAD + 60 + i * 220;
      s += `<rect x="${cx - 60}" y="${yLegend + 7}" width="14" height="14" rx="3" fill="${it[1]}"/>`;
      s += `<text x="${cx - 40}" y="${yLegend + 19}" font-family="PingFang SC,cjk" font-size="13" fill="${ink}">${esc(it[0])}</text>`;
    });
  } else {
  // 主图：BOLL + MA（先画线，再画 K 线压在上面）
  if (bollS) {
    let dUp = '', dLow = '', dMid = '';
    for (let i = 0; i < dn; i++) {
      if (bollS.up[i] != null) dUp += (dUp ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(bollS.up[i]).toFixed(1) + ' ';
      if (bollS.low[i] != null) dLow += (dLow ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(bollS.low[i]).toFixed(1) + ' ';
      if (bollS.mid[i] != null) dMid += (dMid ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(bollS.mid[i]).toFixed(1) + ' ';
    }
    if (dUp) s += `<path d="${dUp}" fill="none" stroke="${bollCol}" stroke-width="1.6" stroke-dasharray="6 4"/>`;
    if (dLow) s += `<path d="${dLow}" fill="none" stroke="${bollCol}" stroke-width="1.6" stroke-dasharray="6 4"/>`;
    if (dMid) s += `<path d="${dMid}" fill="none" stroke="${bollCol}" stroke-width="1.4"/>`;
  }
  maSeries.forEach((series, idx) => {
    let d = '';
    for (let i = 0; i < dn; i++) if (series[i] != null) d += (d ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(series[i]).toFixed(1) + ' ';
    if (d) s += `<path d="${d}" fill="none" stroke="${maCols[idx % maCols.length]}" stroke-width="1.4"/>`;
  });

  // 主图：K线
  for (let i = 0; i < dn; i++) {
    const k = display[i];
    const up = k.close >= k.open;
    const col = up ? upCol : downCol;
    const x = X(i);
    const yHi = Y(k.high), yLo = Y(k.low);
    const yO = Y(k.open), yC = Y(k.close);
    s += `<line x1="${x}" y1="${yHi}" x2="${x}" y2="${yLo}" stroke="${col}" stroke-width="1"/>`;
    const top = Math.min(yO, yC), hgt = Math.max(1.2, Math.abs(yO - yC));
    if (up) {
      s += `<rect x="${x - cw / 2}" y="${top}" width="${cw}" height="${hgt}" fill="#ffffff" stroke="${col}" stroke-width="1" rx="1"/>`;
    } else {
      s += `<rect x="${x - cw / 2}" y="${top}" width="${cw}" height="${hgt}" fill="${col}" rx="1"/>`;
    }
  }

  // 最新价标注：横虚线 + 右侧色块标签（分时按今开红绿，其他周期按昨收）
  const yLast = Y(lastPrice);
  const markCol = chgCol; // 最新价标注颜色与右上角一致（昨收基准）
  s += `<line x1="${PAD}" y1="${yLast}" x2="${W - PAD}" y2="${yLast}" stroke="${markCol}" stroke-width="1.2" stroke-dasharray="6 4" opacity="0.7"/>`;
  s += `<rect x="${W - PAD}" y="${yLast - 12}" width="64" height="24" rx="4" fill="${markCol}"/>`;
  s += `<text x="${W - PAD + 32}" y="${yLast + 4}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="13" font-weight="bold" fill="#ffffff">${fp(lastPrice)}</text>`;

  // 图例区（每根线：色块 + 名称 + 最新值；日线 8 项分两行，分钟线 1 项单行；整体下移 16px 避开 X 轴时间标签）
  s += `<rect x="${PAD - 8}" y="${yLegend}" width="${W - PAD * 2 + 16}" height="${LEG_H}" rx="8" fill="${panel}"/>`;
  const legendItems = [];
  if (bollS) legendItems.push(['BOLL中', bollCol, bollS.mid[dn - 1]]);
  (maPeriods || []).forEach((p, idx) => legendItems.push([`MA${p}`, maCols[idx % maCols.length], maSeries[idx][dn - 1]]));
  const itemsPerRow = Math.ceil(legendItems.length / 2);
  const colW = (W - PAD * 2) / Math.max(itemsPerRow, 1);
  legendItems.forEach((it, idx) => {
    const row = idx < itemsPerRow ? 0 : 1;
    const col = idx < itemsPerRow ? idx : idx - itemsPerRow;
    const cx = PAD + colW * col + colW / 2;
    const cy = yLegend + 14 + row * 26;
    const v = it[2];
    const txt = `${it[0]} ${v != null ? fp(v) : '-'}`;
    s += `<rect x="${cx - colW / 2 + 8}" y="${cy - 7}" width="14" height="14" rx="3" fill="${it[1]}"/>`;
    s += `<text x="${cx - colW / 2 + 28}" y="${cy + 5}" font-family="PingFang SC,cjk" font-size="13" fill="${ink}">${esc(txt)}</text>`;
  });
  } // end else (非分时)

  // 成交量（底部副图）。注意 fetchStockKline/fetchSinaGlobalMin 产出的 vol 已是「每根量」
  // （腾讯分时是累计量、解析时已差分；分钟K/日K 本身就是单根量），此处不得再次差分——
  // 原先 timeMode 下再减前一根，会把分时量算成二次差分（多数柱被压成 0），与 canvas 路径不一致
  const volOf = (k, i) => k.vol;
  const vols = display.map((k, i) => volOf(k, i));
  // 排除首根（开盘量常异常放大，会把其余柱压到贴地）后的最大值作为高度基准，
  // 开盘柱封顶为基准的 2 倍（用户要求「深红 ≈ 红的 2 倍」），让中间时段柱可见
  const volBase = Math.max(...vols.slice(1), 1);
  const volTop = yLegend + LEG_H + 6;
  const volH = VOL_H - 22;
  // 外盘商品部分品种数据源不给量（黄金/白银/原油/天然气/美铜恒为 0）→ 画占位说明
  const noVol = !vols.some(v => Number(v) > 0);
  if (noVol) {
    s += `<text x="${W / 2}" y="${volTop + volH / 2}" font-family="PingFang SC,cjk" font-size="13" fill="${sub}" text-anchor="middle">${noVolume ? '外汇现货无集中成交量' : '该品种数据源不提供成交量'}</text>`;
  } else {
    for (let i = 0; i < dn; i++) {
      const k = display[i];
      const vh = Math.min(volOf(k, i), volBase * 2) / volBase * volH;
      const col = k.close >= (i > 0 ? display[i - 1].close : k.close) ? upCol : downCol;
      const xk = timeMode ? mapX(i) : X(i);
      s += `<rect x="${xk - cw / 2}" y="${volTop + volH - vh}" width="${cw}" height="${vh}" fill="${col}" opacity="0.4" rx="1"/>`;
    }
  }
  if (!noVolume) s += `<text x="${PAD}" y="${volTop + volH + 16}" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">成交量</text>`;

  // 底部基本面面板（个股，三行全字段）
  if (showInfo) {
    const infoTop = volTop + volH + 26;
    s += `<rect x="${PAD - 8}" y="${infoTop - 6}" width="${W - PAD * 2 + 16}" height="${INFO_H}" rx="8" fill="${panel}"/>`;
    // 数值格式化：无值(0/NaN)一律留空（ETF 无 PE/PB 等基本面字段 → 空白）
    const fb = (v, d = 2) => (v && isFinite(v) && Number(v) !== 0) ? v.toFixed(d) : '';
    const fbu = (v, unit, d = 2) => (v && isFinite(v) && Number(v) !== 0) ? v.toFixed(d) + unit : '';
    const fbp = v => (v && isFinite(v) && Number(v) !== 0) ? Number(v).toFixed(prec) : ''; // 价格按品种精度（ETF 三位小数）
    const yib = v => Number(v) > 0 ? (Number(v) / 1e8).toFixed(2) + '亿' : '';             // 股本(股)→亿股
    const amtYi = v => Number(v) > 0 ? (Number(v) / 1e4).toFixed(2) + '亿' : '';           // 成交额(A股=万元)→亿元
    const divAmt = quote.divYield > 0 ? quote.divYield * quote.price / 100 : 0;
    // 个股与 ETF 共用同一布局，接口没给的字段留空
    const rows = [
      [
        `市盈率(动) ${fb(quote.peDyn)}`, `市盈率(TTM) ${fb(quote.peTtm)}`, `市盈率(静) ${fb(quote.peStatic)}`,
        `市净率 ${fb(quote.pb)}`, `每股收益 ${fb(quote.eps)}`, `每股净资产 ${fb(quote.bvps)}`,
      ],
      [
        `总股本 ${yib(quote.totalShares)}`, `总市值 ${fbu(quote.mktCap, '亿')}`, `流通股 ${yib(quote.floatShares)}`,
        `流通值 ${fbu(quote.floatMktCap, '亿')}`, `股息率(TTM) ${fbu(quote.divYield, '%')}`, `股息(TTM) ${fb(divAmt)}`,
      ],
      [
        `换手率 ${fbu(quote.turnover, '%')}`, `量比 ${fb(quote.volumeRatio)}`, `振幅 ${fbu(quote.amplitude, '%')}`,
        `成交额 ${amtYi(quote.amount)}`, `均价 ${fbp(quote.avgPrice)}`, `昨收 ${fbp(quote.prevClose)}`,
      ],
      [
        `今开 ${fbp(quote.open)}`, `最高 ${fbp(quote.high)}`, `最低 ${fbp(quote.low)}`,
        `涨停 ${fbp(quote.limitUp)}`, `跌停 ${fbp(quote.limitDown)}`,
      ],
    ];
    const colW = (W - PAD * 2) / 6;
    const rowH = 24;
    rows.forEach((items, ri) => items.forEach((it, ci) => {
      s += `<text x="${PAD + colW * ci + 10}" y="${infoTop + 14 + ri * rowH}" font-family="PingFang SC,cjk" font-size="12.5" fill="${ink}">${esc(it)}</text>`;
    }));
  }

  // 右下角：生成时间（用户要求标注，便于核对时效）
  const genT = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  s += `<text x="${W - PAD}" y="${H - 12}" text-anchor="end" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">生成 ${genT}</text>`;

  s += `</svg>`;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const r = new Resvg(s, { fitTo: { mode: 'width', value: W }, font: { fontFiles: ['/app/fonts/cjk_sub.ttf'], loadSystemFonts: false, defaultFontFamily: 'PingFang SC' } });
    const png = r.render().asPng();
    return 'base64://' + png.toString('base64'); // 官方网关图片仅认 base64:// 前缀（2026-08-31 踩坑：data URI 会导致「上传URL错误」）
  } catch (e) {
    console.error('[stock] 渲染失败:', e.message);
    return '';
  }
}

// 命令入口：返回 { ok, text?, imgDataUri? }
async function cmdStock(args) {
  const parts = (args || []).map(a => a.trim()).filter(Boolean);
  let period = 'day';
  let codeInput = '';
  if (parts.length >= 1 && STOCK_PERIODS[parts[0].toLowerCase()]) {
    period = STOCK_PERIODS[parts[0].toLowerCase()];
    codeInput = parts.slice(1).join('');
  } else {
    codeInput = parts.join('');
  }
  const USAGE = '📋 用法：/stock <周期> <代码或名称>\n' +
    '周期：-d 日线 | -w 周线 | -M 月线 | -1m 1分钟 | -5m 5分钟 | -30m 30分钟 | -1h 60分钟 | -t 分时 | -pre 美股盘前\n' +
    '例：/stock -d 600519　/stock -t AAPL　/stock -pre NVDA\n' +
    '不写周期默认日线，如 /stock 600519';
  // 首参以 - 开头但不是合法周期 → 提示格式
  if (parts[0] && parts[0].startsWith('-') && !STOCK_PERIODS[parts[0].toLowerCase()]) {
    return { ok: false, text: `⚠️ 未知周期「${parts[0]}」，支持：-d / -w / -M / -1m / -5m / -30m / -1h / -t / -pre\n\n${USAGE}` };
  }
  if (!codeInput) return { ok: false, text: USAGE };
  const londonSpot = codeInput.toLowerCase().replace(/\s+/g, '');
  if (['伦敦银', '伦敦银现'].includes(londonSpot)) {
    return {
      ok: false,
      text: `⚠️ ${codeInput}通常指场外现货白银（XAG/USD），当前暂未接入。\n` +
        '如需国际白银期货，请使用 /stock COMEX白银 或 /fc COMEX白银',
    };
  }

  // 解析代码：数字直用，名称走搜索
  let code = normalizeCode(codeInput);
  let resolvedName = '';
  let resolveNotice = '';
  if (!code) {
    const resolved = await resolveStockCode(codeInput, { details: true });
    code = resolved.code;
    if (!code) return { ok: false, text: `⚠️ 未找到「${codeInput}」，请用代码或股票/ETF/港股/美股名称` };
    resolvedName = resolved.name || codeInput;
    if (!resolved.exact) resolveNotice = `🔎 已按「${resolvedName}」查询\n`;
  }
  const isUS = code.startsWith('us');
  const isHF = code.startsWith('hf_');
  if (period === 'premarket' && !isUS) {
    return { ok: false, text: '⚠️ 盘前行情目前仅支持美股和美股 ETF\n例：/stock -pre AAPL　/stock -pre NVDA　/stock -pre SPY' };
  }
  // 美股：分钟K 数据源不支持；日/周/月/分时/盘前可用
  if (isUS && !STOCK_LONG.includes(period) && period !== 'time' && period !== 'premarket') {
    return { ok: false, text: `⚠️ 美股暂不支持 ${STOCK_PERIOD_LABEL[period]}线（数据源限制）\n可用：/stock -d ${code}（日线）　/stock -w ${code}（周线）　/stock -M ${code}（月线）　/stock -t ${code}（分时）` };
  }
  // 港股：数据源（腾讯）无分钟K历史；日/周/月/分时可用
  const isHK = code.startsWith('hk');
  if (isHK && !STOCK_LONG.includes(period) && period !== 'time') {
    return { ok: false, text: `⚠️ 港股暂不支持 ${STOCK_PERIOD_LABEL[period]}线（数据源限制）\n可用：/stock -d ${code.slice(2)}（日线）　/stock -w ${code.slice(2)}（周线）　/stock -M ${code.slice(2)}（月线）　/stock -t ${code.slice(2)}（分时）` };
  }
  // 国际商品：日/周/月/分时均可用（日 K 走新浪全球期货，周/月由日 K 聚合）；分钟 K 数据源不支持
  if (isHF && !STOCK_LONG.includes(period) && period !== 'time') {
    const q = resolvedName || code; // 回显用户输入的名字（如「黄金」）而非内部代码 hf_GC
    return { ok: false, text: `⚠️ 国际商品暂不支持 ${STOCK_PERIOD_LABEL[period]}线（数据源限制）\n可用：/stock -d ${q}（日线）　/stock -w ${q}（周线）　/stock -M ${q}（月线）　/stock -t ${q}（分时）` };
  }
  // 全球指数：usDJI/usINX 日/周/月有东财 K 线（出图），分时/分钟级与 usIXIC 全周期 → 文本行情速查
  if (GLOBAL_TEXT[code] && !(EM_IDX_SECID[code] && STOCK_LONG.includes(period))) {
    const q = await fetchStockQuote(code);
    if (!q) return { ok: false, text: `⚠️ 获取 ${code} 行情失败，请稍后重试` };
    const note = period !== 'day'
      ? `\n⚠️ 该指数暂不支持${STOCK_PERIOD_LABEL[period]}图，以上为最新行情速查`
      : '';
    return { ok: true, text: globalQuoteText(code, q) + note };
  }
  const [kline, quote] = await Promise.all([fetchStockKline(code, period), fetchStockQuote(code)]);
  if (!kline) {
    const preStatus = period === 'premarket' ? getYahooPremarketStatus(code) : '';
    const msg = period === 'premarket'
      ? (preStatus === 'source_error'
        ? `⚠️ ${code.replace(/^us/, '').replace(/\.\w+$/, '')} 盘前数据源暂不可用，请稍后重试`
        : `⚠️ ${code.replace(/^us/, '').replace(/\.\w+$/, '')} 当前没有今日盘前成交（美东盘前 04:00–09:30）`)
      : `⚠️ 获取 ${code} ${STOCK_PERIOD_LABEL[period]} 数据失败，请确认代码是否正确`;
    return { ok: false, text: msg };
  }
  const name = code === 'hf_XAU'
    ? '伦敦金现货（美元/盎司）'
    : (quote?.name || resolvedName || code);
  const isPremarket = period === 'premarket';
  const effectiveQuote = isPremarket ? {
    ...(quote || {}),
    price: Number(kline[kline.length - 1]?.close) || 0,
    prevClose: Number(kline._prevClose) || Number(quote?.prevClose) || 0,
  } : quote;
  if (isPremarket && effectiveQuote.prevClose > 0) {
    effectiveQuote.chg = effectiveQuote.price - effectiveQuote.prevClose;
    effectiveQuote.chgPct = effectiveQuote.chg / effectiveQuote.prevClose * 100;
    effectiveQuote.open = Number(kline[0]?.close) || effectiveQuote.price;
  }
  // 分时/盘前若带数据日期，在标题标注日期
  const periodLabel = (STOCK_PERIOD_LABEL[period] || period) + ((period === 'time' || isPremarket) && kline._date ? ' ' + kline._date : '');

  const isDay = period === 'day';
  const isTime = period === 'time' || isPremarket;
  const maPeriods = (isDay || period === 'week' || period === 'month') ? [5, 10, 20] : []; // 日/周/月线保留 5/10/20 均线
  const last = kline[kline.length - 1];
  // 价格精度：场内基金（ETF/LOF）固定 3 位（最小变动价位 0.001）；普通股票 2 位；
  //           其余低价品种按真实现价判断（勿扫 qfq 历史价，前复权会产生 3 位假小数）
  let prec = isFundCode(code) ? 3 : 2;
  if (prec === 2) {
    const ref = (effectiveQuote && isFinite(effectiveQuote.price) && Number(effectiveQuote.price) > 0) ? Number(effectiveQuote.price) : (isFinite(last.close) ? Number(last.close) : 0);
    if (ref > 0) {
      const sv = String(ref);
      const dot = sv.indexOf('.');
      if (dot > 0 && sv.slice(dot + 1).replace(/0+$/, '').length > 2) prec = 3;
    }
  }
  const img = renderStockPng(code, name, periodLabel, kline, { maPeriods, boll: isDay || !isTime, timeMode: isTime, premarket: isPremarket, prec }, effectiveQuote);
  if (!img) return { ok: false, text: '⚠️ 图表渲染失败（服务端缺少字体/渲染库）' };

  const capCode = code.replace(/\.\w+$/, '').toUpperCase(); // usAAPL.OQ → USAAPL（图内代码去交易所后缀）
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-';
  const lastPx = (effectiveQuote && isFinite(effectiveQuote.price) && Number(effectiveQuote.price) > 0) ? Number(effectiveQuote.price) : last.close;
  const caption = `${resolveNotice}📈 ${name}（${capCode}）${periodLabel}\n${isPremarket ? '盘前价' : '现价'} ${fp(lastPx)}${effectiveQuote?.chgPct != null ? `  ${effectiveQuote.chg >= 0 ? '+' : ''}${fp(Number(effectiveQuote.chg))} (${effectiveQuote.chgPct >= 0 ? '+' : ''}${Number(effectiveQuote.chgPct).toFixed(2)}%)` : ''}`;
  return { ok: true, text: caption, img };
}

// 商品（hf_）/全球指数（usDJI/usIXIC/usINX/hkHSI）文本速查：无K线数据，仅输出快照行情
function globalQuoteText(code, q) {
  const arrow = q.chgPct >= 0 ? '🔺' : '🔻';
  const sym = code.replace('hf_', '').replace(/\.\w+$/, '').toUpperCase();
  const L = [];
  const priceLabel = q.market === 'hf' ? '现价' : '点位';
  L.push(`📈 ${q.name}（${sym}）`);
  L.push(`${priceLabel} ${f2p(q.price)}  ${arrow} ${q.chg >= 0 ? '+' : ''}${q.chg.toFixed(2)} (${q.chgPct >= 0 ? '+' : ''}${q.chgPct.toFixed(2)}%)`);
  L.push(`今开 ${q.open > 0 ? f2p(q.open) : '-'}  最高 ${q.high > 0 ? f2p(q.high) : '-'}  最低 ${q.low > 0 ? f2p(q.low) : '-'}  昨收 ${f2p(q.prevClose)}`);
  if (q.market === 'hf') L.push(`更新 ${q.date} ${q.time}（国际商品行情）`);
  else L.push(`更新 ${String(q.time).slice(5, 16)}${q.market === 'us' ? '（美东时间）' : '（北京时间）'}`);
  return L.join('\n');
}

module.exports = { renderStockPng, renderStockPngCanvas, renderStockPngSvg, cmdStock, globalQuoteText };
