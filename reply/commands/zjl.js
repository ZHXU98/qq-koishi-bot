// ============================================================
// /zjl 个股资金流向：数据源=新浪财经（股票/ETF，免 token）
//   接口 MoneyFlow.ssl_qsfx_lscjfb 直接返回同花顺同款四档：
//   r0_net=超大单  r1_net=大单  r2_net=中单  r3_net=小单
//   主力 = 超大单 + 大单；散户 = 中单 + 小单；四档之和 = 总净额
//   · 今日：盘中显示当日实时累计，收盘后显示当日完整值
//   · 多周期：仅统计「已完成交易日」；盘中自动退回上一交易日，收盘后含当天
// ============================================================
const https = require('https');
const { cacheGet, cacheSet } = require('../utils');
const { normalizeCode, resolveStockCode, fetchStockQuote } = require('../market');

const SINA_STOCK_FLOW = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_lscjfb?page=1&num=140&sort=opendate&asc=0&daima=%s';

// 展示与分析周期（覆盖短中长）
const PERIODS = [3, 5, 10, 15, 20, 30, 60, 120];

function fetchJsonHttps(url, referer = 'https://finance.sina.com.cn/') {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function shanghaiNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: get('weekday'),
  };
}

// 交易状态：未开盘 / 交易中 / 已收盘（周末按已收盘处理）
function marketPhase(now = new Date()) {
  const { minutes, weekday } = shanghaiNow(now);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  if (minutes < 9 * 60 + 30) return 'preopen';
  if (minutes < 15 * 60) return 'open';
  return 'closed';
}

// 多周期口径：只取「已经收盘完成」的交易日；盘中/未开盘时今天不计入，自动退回上一交易日
function completedRows(rows, now = new Date()) {
  const { date: today } = shanghaiNow(now);
  if (marketPhase(now) === 'closed') return rows.filter(row => row.date <= today);
  return rows.filter(row => row.date < today);
}

// 新浪 lscjfb 口径：四档净额（超大单/大单/中单/小单），主力=超大+大，散户=中+小
function parseSinaRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const date = String(item?.opendate || '').slice(0, 10);
    const superNet = Number(item?.r0_net);
    const large = Number(item?.r1_net);
    const medium = Number(item?.r2_net);
    const small = Number(item?.r3_net);
    const total = Number(item?.netamount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (![superNet, large, medium, small].every(Number.isFinite)) return null;
    const main = superNet + large;              // 主力 = 超大单 + 大单
    const retail = medium + small;              // 散户 = 中单 + 小单
    return {
      date,
      main,
      super: superNet,
      large,
      medium,
      small,
      retail,
      total: Number.isFinite(total) ? total : main + retail,
    };
  }).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function fetchStockFlow(code) {
  const key = 'stock-flow:' + code;
  const cached = cacheGet(key);
  if (cached) return cached;
  const url = SINA_STOCK_FLOW.replace('%s', String(code).toLowerCase());
  const j = await fetchJsonHttps(url).catch(() => null);
  if (!j) return { error: 'upstream' };
  const rows = parseSinaRows(j);
  if (rows.length < 20) return null;
  const result = { rows, source: 'sina' };
  cacheSet(key, result, 3 * 60 * 1000); // 盘中今日值会变，缓存 3 分钟
  return result;
}

function sumPeriod(rows, days, field = 'main') {
  return rows.slice(-days).reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
}

function fmtMoney(value) {
  const n = Number(value) || 0;
  const sign = n > 0 ? '+' : '';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${sign}${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(n / 1e4).toFixed(0)}万`;
  return `${sign}${n.toFixed(0)}`;
}

function direction(value) {
  return value > 0 ? '净流入' : value < 0 ? '净流出' : '基本持平';
}

// 资金结构分析：所有跨周期比较统一用「日均净额」，避免长周期天然数值更大。
// 3日=超短情绪，5日=短线确认，10/15/20=波段，30/60/120=中长期背景。
function buildAnalysis(rows) {
  const n = rows.length;
  const has = d => n >= d;
  const net = d => (has(d) ? sumPeriod(rows, d, 'main') : null);
  const avg = d => (has(d) ? net(d) / d : null);
  const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
  const signText = v => v > 0 ? '流入' : v < 0 ? '流出' : '均衡';
  const absRatio = (a, b) => Math.abs(b || 0) > 0 ? Math.abs(a) / Math.abs(b) : 0;
  const majority = values => {
    const s = values.filter(v => v !== null).map(sign);
    const pos = s.filter(v => v > 0).length;
    const neg = s.filter(v => v < 0).length;
    return pos > neg ? 1 : neg > pos ? -1 : 0;
  };

  const v3 = avg(3), v5 = avg(5), v10 = avg(10), v15 = avg(15), v20 = avg(20), v30 = avg(30), v60 = avg(60), v120 = avg(120);
  const lines = [];

  const strengthText = [];
  if (v3 !== null) strengthText.push(`超短(3日) ${fmtMoney(v3)}/日`);
  if (v5 !== null) strengthText.push(`短(5日) ${fmtMoney(v5)}/日`);
  if (v20 !== null) strengthText.push(`波段(20日) ${fmtMoney(v20)}/日`);
  if (v60 !== null) strengthText.push(`中期(60日) ${fmtMoney(v60)}/日`);
  if (v120 !== null) strengthText.push(`长期(120日) ${fmtMoney(v120)}/日`);
  if (strengthText.length) lines.push(`日均强度：${strengthText.join('　')}`);

  // 1. 超短线节奏：3日不能忽视，用来判断资金是否突然加速或突然反向。
  if (v3 !== null && v5 !== null) {
    if (sign(v3) === sign(v5) && sign(v3) !== 0) {
      const ratio = absRatio(v3, v5);
      if (ratio >= 1.35) lines.push(`短线节奏：3日与5日同向${signText(v3)}，且3日日均强度明显大于5日，说明资金正在加速${signText(v3)}。`);
      else if (ratio <= 0.65) lines.push(`短线节奏：3日与5日同向${signText(v3)}，但3日力度弱于5日，说明短线${signText(v3)}节奏在放缓。`);
      else lines.push(`短线节奏：3日与5日同向${signText(v3)}，短线方向较一致。`);
    } else if (sign(v3) > 0 && sign(v5) < 0) {
      lines.push('短线节奏：5日仍为流出，但3日已转流入，说明超短资金开始回补，需要看能否带动5日翻正。');
    } else if (sign(v3) < 0 && sign(v5) > 0) {
      lines.push('短线节奏：5日仍为流入，但3日已转流出，说明短线资金开始回吐，追高需要谨慎。');
    }
  }

  // 2. 波段结构：10/15/20日共同判断，避免只看5日或20日。
  const swingState = majority([v10, v15, v20]);
  if (v10 !== null && v15 !== null && v20 !== null) {
    const sameSwing = sign(v10) === sign(v15) && sign(v15) === sign(v20) && sign(v20) !== 0;
    if (sameSwing) lines.push(`波段结构：10/15/20日全部${signText(v20)}，波段资金方向明确。`);
    else if (sign(v10) > 0 && sign(v15) > 0 && sign(v20) < 0) lines.push('波段结构：10日、15日已转流入，但20日仍流出，说明资金正在修复，但波段反转还没完全确认。');
    else if (sign(v10) < 0 && sign(v15) < 0 && sign(v20) > 0) lines.push('波段结构：20日仍流入，但10日、15日已转流出，说明波段资金开始松动，需防止由强转弱。');
    else if (swingState > 0) lines.push('波段结构：10/15/20日多数为流入，波段资金整体偏积极，但内部节奏不完全一致。');
    else if (swingState < 0) lines.push('波段结构：10/15/20日多数为流出，波段资金整体偏弱，反弹更适合先看修复。');
    else lines.push('波段结构：10/15/20日方向分歧，资金处于拉锯状态，趋势信号不明确。');
  }

  // 3. 中长期背景：30/60/120决定环境，不把短线回流误判成长期转强。
  const longState = majority([v30, v60, v120]);
  if (v30 !== null && v60 !== null && v120 !== null) {
    if (sign(v30) === sign(v60) && sign(v60) === sign(v120) && sign(v120) !== 0) lines.push(`中长期背景：30/60/120日全部${signText(v120)}，中长期资金方向明确。`);
    else if (longState > 0) lines.push('中长期背景：30/60/120日多数流入，中长期资金环境偏多，但仍需留意分歧周期。');
    else if (longState < 0) lines.push('中长期背景：30/60/120日多数流出，中长期资金环境偏弱，短线回流更可能先按反弹看。');
    else lines.push('中长期背景：30/60/120日方向分歧，说明资金仍在换手和重新定价阶段。');
  }

  // 4. 综合判断：把短线、波段、中长期合在一起。
  const shortState = majority([v3, v5]);
  if (shortState > 0 && swingState > 0 && longState > 0) lines.push('综合判断：短线、波段、中长期形成资金流入共振，是最强资金结构。');
  else if (shortState < 0 && swingState < 0 && longState < 0) lines.push('综合判断：短线、波段、中长期形成资金流出共振，资金结构偏弱，优先控制风险。');
  else if (shortState > 0 && swingState < 0 && longState < 0) lines.push('综合判断：3/5日短线回流，但10/15/20日波段和30/60/120日背景仍弱，更像弱势反弹初段，不能直接当作趋势反转。');
  else if (shortState > 0 && swingState < 0) lines.push('综合判断：短线回流但波段仍弱，更像超跌修复或反弹初期，需要10/15/20日继续改善。');
  else if (shortState < 0 && swingState > 0 && longState < 0) lines.push('综合判断：10/15/20日有修复，但3/5日重新转弱，且中长期背景偏弱，属于弱势背景下的波段修复遇阻。');
  else if (shortState < 0 && swingState > 0 && longState > 0) lines.push('综合判断：中长期和波段仍有资金基础，但3/5日短线转弱，偏向强势中的短线回吐，观察3日能否重新翻正。');
  else if (shortState < 0 && swingState > 0) lines.push('综合判断：波段仍有资金基础，但短线转弱，资金结构进入分歧，需要看3日与5日能否修复。');
  else if (swingState > 0 && longState < 0) lines.push('综合判断：波段资金转强但长周期仍弱，属于中期修复，确认度低于长期共振流入。');
  else if (swingState < 0 && longState > 0) lines.push('综合判断：长周期尚可但波段走弱，偏向趋势内调整，观察20日能否守住流入。');

  // 5. 关键统计补充
  if (has(20)) {
    const win = rows.slice(-20);
    const inflowDays = win.filter(r => r.main > 0).length;
    lines.push(`近20日主力合计 ${fmtMoney(net(20))}，其中 ${inflowDays} 天流入 / ${20 - inflowDays} 天流出。`);
  }
  if (has(120)) lines.push(`近120日主力合计 ${fmtMoney(net(120))}，${direction(net(120))}。`);
  return lines;
}

function buildFlowText(name, code, data, isEtf, phase) {
  const rows = data.rows;
  const today = rows.at(-1);
  const completed = completedRows(rows);
  const base = completed.length >= 20 ? completed : rows.slice(0, -1);
  const phaseText = phase === 'open' ? '交易中（当日为实时累计，尚未收盘）' : phase === 'preopen' ? '未开盘（当日暂无有效数据）' : '已收盘';
  const periodLines = PERIODS.map(days => {
    if (base.length < days) return `近${days}日：数据不足`;
    const v = sumPeriod(base, days, 'main');
    return `近${days}日：${fmtMoney(v)}　${direction(v)}`;
  });
  return [
    `💰 ${name}（${code.toUpperCase()}）资金流向${isEtf ? ' · ETF基础口径' : ''}`,
    '',
    '━━━ 今日 ━━━',
    `日期：${today.date}　${phaseText}`,
    `主力（超大单+大单）：${fmtMoney(today.main)}　${direction(today.main)}`,
    `超大单：${fmtMoney(today.super)}　大单：${fmtMoney(today.large)}`,
    `中单：${fmtMoney(today.medium)}　小单：${fmtMoney(today.small)}`,
    `散户（中单+小单）：${fmtMoney(today.retail)}　总净额：${fmtMoney(today.total)}`,
    '',
    '━━━ 多周期主力净额 ━━━',
    `统计基准：${base.at(-1)?.date || '-'}（已完成交易日）`,
    ...periodLines,
    '',
    '━━━ 资金结构分析 ━━━',
    ...buildAnalysis(base),
    isEtf ? '说明：ETF资金口径不代表真实申购赎回或机构实际持仓变化。' : '说明：主力=超大单+大单，散户=中单+小单；为成交单大小口径，不等同于真实机构账户。',
    '数据源：新浪财经',
  ].join('\n');
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const char of String(text || '')) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = char; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function renderFlowPng(name, code, data, isEtf, phase) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1080, PAD = 48;
  const probe = createCanvas(W, 100).getContext('2d');
  probe.font = '19px cjk';
  const rows = data.rows;
  const today = rows.at(-1);
  const completed = completedRows(rows);
  const base = completed.length >= 20 ? completed : rows.slice(0, -1);
  const phaseText = phase === 'open' ? '交易中 · 当日实时累计' : phase === 'preopen' ? '未开盘' : '已收盘';

  const periodCells = PERIODS.map(days => {
    const ok = base.length >= days;
    const v = ok ? sumPeriod(base, days, 'main') : null;
    return { label: `近${days}日`, value: ok ? fmtMoney(v) : '数据不足', dir: ok ? direction(v) : '', pos: ok ? v >= 0 : null };
  });

  const wrappedAnalysis = buildAnalysis(base).flatMap(t => wrapText(probe, t, W - PAD * 2 - 16));

  const todayH = 196, gridTop = 118 + todayH + 56, rowH = 66;
  const gridH = Math.ceil(periodCells.length / 2) * rowH;
  const analysisTop = gridTop + gridH + 60;
  const analysisH = wrappedAnalysis.length * 32;
  const H = analysisTop + analysisH + 74;

  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d'); ctx.scale(1.2, 1.2); ctx.textBaseline = 'middle';
  const ink = '#252b36', sub = '#7b8798', panel = '#f6f7f9', red = '#f5222d', green = '#0aa869', blue = '#1677ff';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = blue; ctx.fillRect(PAD, 28, 7, 64);
  ctx.fillStyle = ink; ctx.font = 'bold 30px cjk'; ctx.textAlign = 'left';
  ctx.fillText(`${name} · 资金流向${isEtf ? '（ETF基础）' : ''}`, PAD + 20, 48);
  ctx.fillStyle = sub; ctx.font = '17px cjk';
  ctx.fillText(`${code.toUpperCase()} · 多周期基准 ${base.at(-1)?.date || '-'} · ${phaseText}`, PAD + 20, 80);

  // 今日卡片：主力 / 超大单 / 大单 / 中单 / 小单 / 散户
  ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(PAD, 118, W - PAD * 2, todayH, 14); ctx.fill();
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText(`今日 ${today.date}（${phaseText}）`, PAD + 20, 150);
  const cells = [
    ['主力', today.main], ['超大单', today.super], ['大单', today.large],
    ['中单', today.medium], ['小单', today.small], ['散户', today.retail],
  ];
  const cellW = (W - PAD * 2 - 40) / 3;
  cells.forEach(([label, value], i) => {
    const x = PAD + 24 + (i % 3) * cellW;
    const y = 182 + Math.floor(i / 3) * 62;
    ctx.fillStyle = sub; ctx.font = '17px cjk'; ctx.fillText(label, x, y);
    ctx.fillStyle = value >= 0 ? red : green; ctx.font = 'bold 23px cjk'; ctx.fillText(fmtMoney(value), x, y + 28);
  });

  // 多周期数字网格（无柱状图）
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText('多周期主力净额', PAD, gridTop - 26);
  const colW = (W - PAD * 2) / 2;
  periodCells.forEach((cell, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = PAD + col * colW, y = gridTop + row * rowH;
    ctx.fillStyle = i % 4 < 2 ? '#fbfcfd' : '#f4f6f8';
    ctx.beginPath(); ctx.roundRect(x, y, colW - 14, rowH - 12, 8); ctx.fill();
    ctx.fillStyle = sub; ctx.font = '18px cjk'; ctx.textAlign = 'left';
    ctx.fillText(cell.label, x + 16, y + 27);
    ctx.textAlign = 'right';
    if (cell.value === '数据不足') { ctx.fillStyle = sub; ctx.font = 'bold 19px cjk'; ctx.fillText('数据不足', x + colW - 30, y + 27); }
    else { ctx.fillStyle = cell.pos ? red : green; ctx.font = 'bold 20px cjk'; ctx.fillText(`${cell.value}　${cell.dir}`, x + colW - 30, y + 27); }
  });

  // 分析文本
  ctx.textAlign = 'left';
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText('资金结构分析', PAD, analysisTop - 26);
  wrappedAnalysis.forEach((line, i) => {
    ctx.fillStyle = sub; ctx.font = '19px cjk';
    ctx.fillText(line, PAD + 4, analysisTop + i * 32 + 10);
  });

  const note = isEtf ? '数据源：新浪财经；ETF口径不代表申赎资金。' : '数据源：新浪财经；主力=超大单+大单，散户=中单+小单。';
  ctx.fillStyle = sub; ctx.font = '15px cjk'; ctx.fillText(note, PAD, H - 30);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

async function cmdZjl(args) {
  const raw = String((args || [])[0] || '').trim();
  if (!raw) return { ok: false, text: '📋 用法：/zjl <股票或ETF代码/名称>\n例：/zjl 600519　/zjl 沪深300ETF' };
  let code = normalizeCode(raw), name = raw;
  if (!code) { const resolved = await resolveStockCode(raw, { details: true }); code = resolved.code; name = resolved.name || raw; }
  if (!code || !/^(sh|sz)\d{6}$/i.test(code)) return { ok: false, text: `⚠️ 暂不支持「${raw}」，请输入 A 股股票或 ETF 代码/名称` };
  const [quote, flowResult] = await Promise.all([
    fetchStockQuote(code).catch(() => null),
    fetchStockFlow(code).catch(() => ({ error: 'upstream' })),
  ]);
  if (flowResult?.error === 'upstream') return { ok: false, text: `⚠️ ${name} 资金流数据源当前不可用，请稍后重试` };
  const flow = flowResult;
  if (!flow) return { ok: false, text: `⚠️ ${name} 暂无足够的已完成交易日资金流数据` };
  name = quote?.name || name;
  const isEtf = /ETF|LOF|基金/i.test(name) || /^sh5[1-8]|^sz1[56]/i.test(code);
  const phase = marketPhase();
  const text = buildFlowText(name, code, flow, isEtf, phase);
  let img = null; try { img = renderFlowPng(name, code, flow, isEtf, phase); } catch (e) { console.error('[zjl] 图片生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdZjl, completedRows, parseSinaRows, sumPeriod, marketPhase, buildAnalysis };
