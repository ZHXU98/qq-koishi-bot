// ============================================================
// /zjl 个股资金流向：数据源=新浪财经（股票/ETF）
//   · 今日：盘中显示当日实时累计，收盘后显示当日完整值
//   · 多周期：仅统计「已完成交易日」；盘中自动退回上一交易日，收盘后含当天
// ============================================================
const https = require('https');
const { cacheGet, cacheSet, fmtAmountYuan } = require('../utils');
const { normalizeCode, resolveStockCode, fetchStockQuote } = require('../market');

const SINA_STOCK_FLOW = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=140&sort=opendate&asc=0&daima=%s';

// 分析只保留最近 20 日以内的窗口（用户要求：看资金流向只看最近 20 日）
const PERIODS = [3, 5, 10, 20];
const WINDOW = 20;

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
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes };
}

// 交易状态：未开盘 / 交易中 / 已收盘（按上海时间粗略判定，周末视为已收盘）
function marketPhase(now = new Date()) {
  const { minutes } = shanghaiNow(now);
  const weekday = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', weekday: 'short' }).formatToParts(now).find(p => p.type === 'weekday')?.value === 'Sat' ? 6 : 0) || 0;
  if (weekday === 6) return 'closed';
  if (minutes < 9 * 60 + 30) return 'preopen';
  if (minutes < 15 * 60) return 'open';
  return 'closed';
}

// 多周期口径：只取「已经收盘完成」的交易日。盘中/未开盘时今天不计入，自动退回上一交易日。
function completedRows(rows, now = new Date()) {
  const { date: today } = shanghaiNow(now);
  const phase = marketPhase(now);
  if (phase === 'closed') return rows.filter(row => row.date <= today);
  return rows.filter(row => row.date < today);
}

function parseSinaRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const date = String(item?.opendate || '').slice(0, 10);
    const main = Number(item?.r0_net);      // 主力（大单）净额
    const total = Number(item?.netamount);  // 全单净额
    const turnover = Number(item?.turnover);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(main) || !Number.isFinite(total)) return null;
    return { date, main, total, retail: total - main, turnover: Number.isFinite(turnover) ? turnover : null };
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
  return `${n > 0 ? '+' : ''}${fmtAmountYuan(n)}`;
}

function direction(value) {
  return value > 0 ? '净流入' : value < 0 ? '净流出' : '基本持平';
}

// 资金解读：只围绕最近 20 日做趋势判断，不再用「主力 vs 散户」这种近似恒等式当结论。
function buildReadout(rows) {
  const win = rows.slice(-WINDOW);
  const n = win.length;
  const main20 = sumPeriod(win, n, 'main');
  const main5 = sumPeriod(win, 5, 'main');
  const mainToday = win[n - 1].main;
  const inflowDays = win.filter(r => r.main > 0).length;
  const outflowDays = n - inflowDays;
  const flowRatio = main20 !== 0 ? main5 / Math.abs(main20) : 0;
  const parts = [];
  parts.push(`近${n}日主力合计 ${fmtMoney(main20)}（${inflowDays}天流入 / ${outflowDays}天流出）`);
  if (main20 > 0 && main5 > 0) parts.push('近5日仍在净流入，中期资金偏积极');
  else if (main20 < 0 && main5 < 0) parts.push('近5日继续净流出，短期资金尚未转向');
  else if (main20 > 0 && main5 < 0) parts.push('中期净流入但近5日转为净流出，资金有减弱迹象');
  else if (main20 < 0 && main5 > 0) parts.push('中期净流出但近5日转为净流入，资金有回流迹象');
  else parts.push('多空资金接近平衡，方向暂不明确');
  if (Math.abs(flowRatio) >= 0.6) parts.push('近5日占近20日比重较高，节奏较集中');
  if (mainToday > 0 && main20 < 0) parts.push(`当日${fmtMoney(mainToday)}，短线有回补但未改变20日流出格局`);
  if (mainToday < 0 && main20 > 0) parts.push(`当日${fmtMoney(mainToday)}，出现回吐但20日仍为净流入`);
  return parts.join('；') + '。';
}

function buildFlowText(name, code, data, isEtf, phase) {
  const rows = data.rows;
  const today = rows.at(-1);
  const completed = completedRows(rows);
  const base = completed.length >= 20 ? completed : rows.slice(0, -1);
  const periods = PERIODS.map(days => ({ days, value: base.length >= days ? sumPeriod(base, days, 'main') : null }));
  const phaseText = phase === 'open' ? '交易中（当日为实时累计，尚未收盘）' : phase === 'preopen' ? '未开盘（当日暂无有效数据）' : '已收盘';
  return [
    `💰 ${name}（${code.toUpperCase()}）资金流向${isEtf ? ' · ETF基础口径' : ''}`,
    '',
    '━━━ 今日 ━━━',
    `日期：${today.date}　${phaseText}`,
    `主力：${fmtMoney(today.main)}　${direction(today.main)}`,
    `总净额：${fmtMoney(today.total)}　散户（总净额-主力）：${fmtMoney(today.retail)}`,
    '',
    `━━━ 多周期主力净额（近${WINDOW}日） ━━━`,
    `统计基准：${base.at(-1)?.date || '-'}（已完成交易日）`,
    ...periods.map(p => `近${p.days}日：${p.value === null ? '数据不足' : `${fmtMoney(p.value)}　${direction(p.value)}`}`),
    '',
    `资金解读：${buildReadout(rows)}`,
    isEtf ? '说明：ETF资金口径不代表真实申购赎回或机构实际持仓变化。' : '说明：主力=大单净额，散户=总净额-主力；为成交单大小口径，不等同于真实机构账户。',
    '数据源：新浪财经',
  ].join('\n');
}

function renderFlowPng(name, code, data, isEtf, phase) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1080, PAD = 48, H = 820;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d'); ctx.scale(1.2, 1.2); ctx.textBaseline = 'middle';
  const ink = '#252b36', sub = '#7b8798', panel = '#f6f7f9', red = '#f5222d', green = '#0aa869', blue = '#1677ff';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = blue; ctx.fillRect(PAD, 28, 7, 64);
  ctx.fillStyle = ink; ctx.font = 'bold 30px cjk'; ctx.textAlign = 'left';
  ctx.fillText(`${name} · 资金流向${isEtf ? '（ETF基础）' : ''}`, PAD + 20, 48);
  const rows = data.rows;
  const today = rows.at(-1);
  const completed = completedRows(rows);
  const base = completed.length >= 20 ? completed : rows.slice(0, -1);
  const phaseText = phase === 'open' ? '交易中 · 当日实时累计' : phase === 'preopen' ? '未开盘' : '已收盘';
  ctx.fillStyle = sub; ctx.font = '17px cjk';
  ctx.fillText(`${code.toUpperCase()} · 多周期基准 ${base.at(-1)?.date || '-'} · ${phaseText}`, PAD + 20, 80);

  // 今日卡片
  const todayY = 118;
  ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(PAD, todayY, W - PAD * 2, 128, 14); ctx.fill();
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText(`今日 ${today.date}（${phaseText}）`, PAD + 20, todayY + 32);
  const todayCells = [['主力', today.main], ['总净额', today.total], ['散户', today.retail]];
  const cellW = (W - PAD * 2 - 40) / 3;
  todayCells.forEach(([label, value], i) => {
    const x = PAD + 24 + i * cellW;
    ctx.fillStyle = sub; ctx.font = '18px cjk'; ctx.fillText(label, x, todayY + 68);
    ctx.fillStyle = value >= 0 ? red : green; ctx.font = 'bold 24px cjk'; ctx.fillText(fmtMoney(value), x, todayY + 100);
  });

  // 多周期柱状图
  const chartY = todayY + 128 + 52;
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText(`多周期主力净额（近${WINDOW}日）`, PAD, chartY);
  const periods = PERIODS.map(days => ({ days, value: base.length >= days ? sumPeriod(base, days, 'main') : null }));
  const known = periods.filter(p => p.value !== null);
  const maxAbs = Math.max(...known.map(p => Math.abs(p.value)), 1);
  const chartX = PAD + 8, chartW = W - PAD * 2 - 16, baseY = chartY + 150;
  ctx.strokeStyle = '#dfe4ea'; ctx.beginPath(); ctx.moveTo(chartX, baseY); ctx.lineTo(chartX + chartW, baseY); ctx.stroke();
  const slot = chartW / periods.length;
  periods.forEach((p, i) => {
    const cx = chartX + slot * i + slot / 2;
    const h = p.value === null ? 0 : Math.max(3, Math.abs(p.value) / maxAbs * 90);
    if (h) { ctx.fillStyle = p.value >= 0 ? red : green; ctx.fillRect(cx - 40, p.value >= 0 ? baseY - h : baseY, 80, h); }
    ctx.fillStyle = ink; ctx.font = '17px cjk'; ctx.textAlign = 'center'; ctx.fillText(`${p.days}日`, cx, baseY + 28);
    ctx.fillStyle = p.value === null ? sub : p.value >= 0 ? red : green; ctx.font = 'bold 16px cjk';
    ctx.fillText(p.value === null ? '数据不足' : fmtMoney(p.value), cx, p.value === null ? baseY - 18 : p.value >= 0 ? baseY - h - 20 : baseY + h + 44);
  });

  ctx.textAlign = 'left';
  const note = isEtf ? '数据源：新浪财经；ETF口径不代表申赎资金。' : '数据源：新浪财经；主力=大单净额，散户=总净额-主力。';
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

module.exports = { cmdZjl, completedRows, parseSinaRows, sumPeriod, marketPhase, buildReadout };
