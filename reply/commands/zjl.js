// ============================================================
// /zjl 个股资金流向：仅使用已完成交易日的历史资金流
// 数据源：东财（含大小单细分，优先）→ 新浪（主力/净额，兜底）
// ============================================================
const https = require('https');
const { cacheGet, cacheSet, fmtAmountYuan } = require('../utils');
const { emFetchJson, emSecid, normalizeCode, resolveStockCode, fetchStockQuote } = require('../market');

// 数据源1（优先）：东财个股资金流日线，含主力/超大单/大单/中单/小单细分
const EM_STOCK_FLOW_DAY = 'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=130&klt=101&secid=%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
// 数据源2（兜底）：新浪个股资金流历史（netamount=总净额，r0_net=主力净额），支持股票与 ETF
const SINA_STOCK_FLOW = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=130&sort=opendate&asc=0&daima=%s';

const PERIODS = [3, 5, 15, 20, 30, 60, 120];
const FLOW_FIELDS = ['main', 'super', 'large', 'medium', 'small'];
const FLOW_LABELS = { main: '主力', super: '超大单', large: '大单', medium: '中单', small: '小单' };

function fetchJsonHttps(url, referer = 'https://quote.eastmoney.com/') {
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

function shanghaiTodayParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// 只保留「已经收盘完成」的交易日；盘中/未收盘时自动退回上一交易日
function completedRows(rows, now = new Date()) {
  const { date: today, minutes } = shanghaiTodayParts(now);
  const closedToday = minutes >= 15 * 60;
  return rows.filter(row => row.date < today || (row.date === today && closedToday));
}

// 东财口径：主力/超大单/大单/中单/小单五档净额
function parseEmRows(klines) {
  if (!Array.isArray(klines)) return [];
  return klines.map(raw => {
    const p = String(raw).split(',');
    return {
      date: String(p[0] || '').slice(0, 10),
      main: Number(p[1]),
      small: Number(p[2]),
      medium: Number(p[3]),
      large: Number(p[4]),
      super: Number(p[5]),
    };
  }).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && FLOW_FIELDS.every(k => Number.isFinite(row[k])));
}

// 新浪口径：主力净额(r0_net) + 总净额(netamount)；散户 = 总净额 - 主力净额
// 该源没有超大单/大单/中单/小单细分，故细分字段置为 null，展示层按数据源说明。
function parseSinaRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const date = String(item?.opendate || '').slice(0, 10);
    const main = Number(item?.r0_net);
    const total = Number(item?.netamount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(main) || !Number.isFinite(total)) return null;
    return { date, main, super: null, large: null, medium: null, small: total - main };
  }).filter(Boolean);
}

async function fetchEmFlow(code) {
  const url = EM_STOCK_FLOW_DAY.replace('%s', emSecid(code));
  const j = await emFetchJson(url, 10000) || await fetchJsonHttps(url).catch(() => null);
  if (!j) return null;
  const rows = completedRows(parseEmRows(j?.data?.klines));
  if (rows.length < 20) return null;
  return { name: String(j?.data?.name || ''), rows, source: 'eastmoney' };
}

async function fetchSinaFlow(code) {
  const url = SINA_STOCK_FLOW.replace('%s', String(code).toLowerCase());
  const j = await fetchJsonHttps(url, 'https://finance.sina.com.cn/').catch(() => null);
  if (!j) return null;
  // 新浪返回为倒序（最新在前），统一升序，保证「最近交易日」和多周期累计口径正确。
  const rows = completedRows(parseSinaRows(j)).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  if (rows.length < 20) return null;
  return { name: '', rows, source: 'sina' };
}

// 东财优先（含大小单细分）；东财不可用时自动切换新浪（主力/净额口径）
async function fetchStockFlow(code) {
  const key = 'stock-flow:' + code;
  const cached = cacheGet(key);
  if (cached) return cached;
  const result = await fetchEmFlow(code).catch(() => null) || await fetchSinaFlow(code).catch(() => null);
  if (!result) return { error: 'upstream' };
  result.sourceDate = result.rows.at(-1).date;
  cacheSet(key, result, 10 * 60 * 1000);
  return result;
}

function sumPeriod(rows, days) {
  const selected = rows.slice(-days);
  return Object.fromEntries(FLOW_FIELDS.map(field => [field, selected.reduce((sum, row) => sum + (Number(row[field]) || 0), 0)]));
}

function periodValue(rows, days, field = 'main') {
  return rows.length >= days ? sumPeriod(rows, days)[field] : null;
}

function fmtMoney(value) {
  const n = Number(value) || 0;
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtAmountYuan(n)}`;
}

function fmtPeriodValue(value) {
  return value === null ? '数据不足' : fmtMoney(value);
}

function direction(value) {
  return value > 0 ? '净流入' : value < 0 ? '净流出' : '基本持平';
}

function buildFlowText(name, code, data, isEtf) {
  const latest = data.rows.at(-1);
  const periods = PERIODS.map(days => ({ days, value: periodValue(data.rows, days) }));
  const mainTrend = periods.map(p => `${p.days}日${p.value === null ? '数据不足' : direction(p.value)}`).join('、');
  const detailed = Number.isFinite(latest.super) && Number.isFinite(latest.large) && Number.isFinite(latest.medium);
  const retail = latest.small;
  const latestLines = detailed
    ? [
        `主力：${fmtMoney(latest.main)}　${direction(latest.main)}`,
        `超大单：${fmtMoney(latest.super)}　大单：${fmtMoney(latest.large)}`,
        `中单：${fmtMoney(latest.medium)}　小单：${fmtMoney(latest.small)}`,
        `大资金合计：${fmtMoney(latest.super + latest.large)}；中小单合计：${fmtMoney(latest.medium + latest.small)}`,
      ]
    : [
        `主力：${fmtMoney(latest.main)}　${direction(latest.main)}`,
        `散户（总净额-主力）：${fmtMoney(retail)}　${direction(retail)}`,
      ];
  return [
    `💰 ${name}（${code.toUpperCase()}）资金流向${isEtf ? ' · ETF基础口径' : ''}`,
    `数据日期：${data.sourceDate}（仅统计已完成交易日）`,
    '',
    '━━━ 最近完成交易日 ━━━',
    ...latestLines,
    '',
    '━━━ 多周期主力净额 ━━━',
    ...periods.map(p => `近${p.days}日：${fmtPeriodValue(p.value)}${p.value === null ? '' : `　${direction(p.value)}`}`),
    '',
    `资金解读：${mainTrend}。${latest.main > 0 && retail < 0 ? '主力流入、散户流出，存在大资金承接。' : latest.main < 0 && retail > 0 ? '主力流出、散户流入，注意资金派发风险。' : '主力与散户方向暂未形成明显背离。'}`,
    isEtf ? '说明：ETF资金口径不代表真实申购赎回或机构实际持仓变化。' : '说明：主力/大小单为数据源按成交单大小划分的资金口径，不等同于真实机构账户。',
    data.source === 'sina' ? '数据源：新浪财经（东财接口当前不可用，已自动切换）' : '数据源：东方财富',
  ].join('\n');
}

function renderFlowPng(name, code, data, isEtf) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1080, PAD = 48, H = 780;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d'); ctx.scale(1.2, 1.2); ctx.textBaseline = 'middle';
  const ink = '#252b36', sub = '#7b8798', panel = '#f6f7f9', red = '#f5222d', green = '#0aa869', blue = '#1677ff';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = blue; ctx.fillRect(PAD, 28, 7, 64);
  ctx.fillStyle = ink; ctx.font = 'bold 30px cjk'; ctx.textAlign = 'left';
  ctx.fillText(`${name} · 资金流向${isEtf ? '（ETF基础）' : ''}`, PAD + 20, 48);
  ctx.fillStyle = sub; ctx.font = '17px cjk';
  ctx.fillText(`${code.toUpperCase()} · 数据日期 ${data.sourceDate} · 仅完成交易日`, PAD + 20, 80);

  const latest = data.rows.at(-1);
  const detailed = Number.isFinite(latest.super) && Number.isFinite(latest.large) && Number.isFinite(latest.medium);
  const cells = detailed
    ? [['主力', latest.main], ['超大单', latest.super], ['大单', latest.large], ['中单', latest.medium], ['小单', latest.small]]
    : [['主力净额', latest.main], ['散户净额', latest.small]];
  const panelY = 118, cellCols = 3, cellW = (W - PAD * 2 - 40) / cellCols;
  const panelH = 60 + Math.ceil(cells.length / cellCols) * 74;
  ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(PAD, panelY, W - PAD * 2, panelH, 14); ctx.fill();
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk';
  ctx.fillText('最近完成交易日资金拆分', PAD + 20, panelY + 30);
  cells.forEach(([label, value], i) => {
    const x = PAD + 24 + (i % cellCols) * cellW;
    const y = panelY + 80 + Math.floor(i / cellCols) * 74;
    ctx.fillStyle = sub; ctx.font = '18px cjk'; ctx.fillText(label, x, y);
    ctx.fillStyle = value >= 0 ? red : green; ctx.font = 'bold 23px cjk'; ctx.fillText(fmtMoney(value), x, y + 30);
  });

  const chartY = panelY + panelH + 46;
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText('多周期主力净额', PAD, chartY);
  const chartX = PAD + 8, chartW = W - PAD * 2 - 16, baseY = chartY + 130;
  const periods = PERIODS.map(days => ({ days, value: periodValue(data.rows, days) }));
  const known = periods.filter(p => p.value !== null);
  const maxAbs = Math.max(...known.map(p => Math.abs(p.value)), 1);
  ctx.strokeStyle = '#dfe4ea'; ctx.beginPath(); ctx.moveTo(chartX, baseY); ctx.lineTo(chartX + chartW, baseY); ctx.stroke();
  const slot = chartW / periods.length;
  periods.forEach((p, i) => {
    const cx = chartX + slot * i + slot / 2;
    const h = p.value === null ? 0 : Math.max(3, Math.abs(p.value) / maxAbs * 82);
    if (h) { ctx.fillStyle = p.value >= 0 ? red : green; ctx.fillRect(cx - 34, p.value >= 0 ? baseY - h : baseY, 68, h); }
    ctx.fillStyle = ink; ctx.font = '16px cjk'; ctx.textAlign = 'center'; ctx.fillText(`${p.days}日`, cx, baseY + 26);
    ctx.fillStyle = p.value === null ? sub : p.value >= 0 ? red : green; ctx.font = 'bold 15px cjk';
    ctx.fillText(fmtPeriodValue(p.value), cx, p.value === null ? baseY - 16 : p.value >= 0 ? baseY - h - 18 : baseY + h + 40);
  });
  ctx.textAlign = 'left';
  const note = data.source === 'sina'
    ? (isEtf ? '数据源：新浪财经；ETF口径不代表申赎资金。' : '数据源：新浪财经；主力=大单净额，散户=总净额-主力。')
    : (isEtf ? '数据源：东方财富；ETF口径不代表申赎资金。' : '数据源：东方财富；主力/大小单按成交单大小划分。');
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
  if (flowResult?.error === 'upstream') return { ok: false, text: `⚠️ ${name} 资金流数据源当前均不可用，请稍后重试` };
  const flow = flowResult;
  if (!flow) return { ok: false, text: `⚠️ ${name} 暂无足够的已完成交易日资金流数据` };
  name = quote?.name || flow.name || name;
  const isEtf = /ETF|LOF|基金/i.test(name) || /^sh5[1-8]|^sz1[56]/i.test(code);
  const text = buildFlowText(name, code, flow, isEtf);
  let img = null; try { img = renderFlowPng(name, code, flow, isEtf); } catch (e) { console.error('[zjl] 图片生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdZjl, completedRows, parseEmRows, parseSinaRows, sumPeriod };
