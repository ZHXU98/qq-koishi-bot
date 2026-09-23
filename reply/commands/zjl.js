// ============================================================
// /zjl 个股资金流向：仅使用已完成交易日的东财历史资金流
// ============================================================
const https = require('https');
const { cacheGet, cacheSet, fmtAmountYuan } = require('../utils');
const { emFetchJson, emSecid, normalizeCode, resolveStockCode, fetchStockQuote } = require('../market');

const EM_STOCK_FLOW_DAY = 'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=120&klt=101&secid=%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
const PERIODS = [3, 5, 15, 20, 30, 60, 120];
const FLOW_FIELDS = ['main', 'super', 'large', 'medium', 'small'];
const FLOW_LABELS = { main: '主力', super: '超大单', large: '大单', medium: '中单', small: '小单' };

function fetchJsonHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } }, res => {
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

function completedRows(rows, now = new Date()) {
  const { date: today, minutes } = shanghaiTodayParts(now);
  const closedToday = minutes >= 15 * 60;
  return rows.filter(row => row.date < today || (row.date === today && closedToday));
}

function parseFlowRows(klines) {
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

async function fetchStockFlow(code) {
  const key = 'stock-flow:' + code;
  const cached = cacheGet(key);
  if (cached) return cached;
  const url = EM_STOCK_FLOW_DAY.replace('%s', emSecid(code));
  const j = await emFetchJson(url, 10000) || await fetchJsonHttps(url).catch(() => null);
  if (!j) return { error: 'upstream' };
  const rawRows = parseFlowRows(j?.data?.klines);
  const rows = completedRows(rawRows);
  if (rows.length < 20) return null;
  const result = { name: String(j?.data?.name || ''), rows, sourceDate: rows.at(-1).date };
  cacheSet(key, result, 10 * 60 * 1000);
  return result;
}

function sumPeriod(rows, days) {
  const selected = rows.slice(-days);
  return Object.fromEntries(FLOW_FIELDS.map(field => [field, selected.reduce((sum, row) => sum + row[field], 0)]));
}

function periodValue(rows, days, field = 'main') {
  return rows.length >= days ? sumPeriod(rows, days)[field] : null;
}

function fmtPeriodValue(value) {
  return value === null ? '数据不足' : fmtMoney(value);
}

function direction(value) {
  return value > 0 ? '净流入' : value < 0 ? '净流出' : '基本持平';
}

function buildFlowText(name, code, data, isEtf) {
  const latest = data.rows.at(-1);
  const main = latest.main;
  const periods = PERIODS.map(days => ({ days, value: periodValue(data.rows, days) }));
  const mainTrend = periods.map(p => `${p.days}日${p.value === null ? '数据不足' : direction(p.value)}`).join('、');
  const retail = latest.small + latest.medium;
  return [
    `💰 ${name}（${code.toUpperCase()}）资金流向${isEtf ? ' · ETF基础口径' : ''}`,
    `数据日期：${data.sourceDate}（仅统计已完成交易日）`,
    '',
    '━━━ 最近完成交易日 ━━━',
    `主力：${fmtMoney(latest.main)}　${direction(latest.main)}`,
    `超大单：${fmtMoney(latest.super)}　大单：${fmtMoney(latest.large)}`,
    `中单：${fmtMoney(latest.medium)}　小单：${fmtMoney(latest.small)}`,
    `大资金合计：${fmtMoney(latest.super + latest.large)}；中小单合计：${fmtMoney(retail)}`,
    '',
    '━━━ 多周期主力净额 ━━━',
    ...periods.map(p => `近${p.days}日：${fmtPeriodValue(p.value)}${p.value === null ? '' : `　${direction(p.value)}`}`),
    '',
    `资金解读：${mainTrend}。${main > 0 && retail < 0 ? '主力流入、中小单流出，存在大资金承接。' : main < 0 && retail > 0 ? '主力流出、中小单流入，注意资金派发风险。' : '主力与中小单方向暂未形成明显背离。'}`,
    isEtf ? '说明：ETF仅展示东财可用的单量资金分类，不代表真实申购赎回或机构实际持仓变化。' : '说明：主力/大小单为数据源按成交单大小划分的资金口径，不等同于真实机构账户。',
  ].join('\n');
}

function renderFlowPng(name, code, data, isEtf) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1080, PAD = 48, rowH = 42, H = 760;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d'); ctx.scale(1.2, 1.2); ctx.textBaseline = 'middle';
  const ink = '#252b36', sub = '#7b8798', panel = '#f6f7f9', red = '#f5222d', green = '#0aa869', blue = '#1677ff';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = blue; ctx.fillRect(PAD, 28, 7, 64);
  ctx.fillStyle = ink; ctx.font = 'bold 30px cjk'; ctx.textAlign = 'left'; ctx.fillText(`${name} · 资金流向${isEtf ? '（ETF基础）' : ''}`, PAD + 20, 48);
  ctx.fillStyle = sub; ctx.font = '17px cjk'; ctx.fillText(`${code.toUpperCase()} · 数据日期 ${data.sourceDate} · 仅完成交易日`, PAD + 20, 80);
  const panelY = 118; ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(PAD, panelY, W - PAD * 2, 250, 14); ctx.fill();
  ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText('最近完成交易日资金拆分', PAD + 20, panelY + 30);
  const latest = data.rows.at(-1); const cols = ['main', 'super', 'large', 'medium', 'small'];
  cols.forEach((field, i) => {
    const x = PAD + 24 + (i % 3) * 320, y = panelY + 78 + Math.floor(i / 3) * 64;
    const value = latest[field]; ctx.fillStyle = sub; ctx.font = '18px cjk'; ctx.fillText(FLOW_LABELS[field], x, y);
    ctx.fillStyle = value >= 0 ? red : green; ctx.font = 'bold 23px cjk'; ctx.fillText(fmtMoney(value), x, y + 30);
  });
  const chartY = 394; ctx.fillStyle = ink; ctx.font = 'bold 20px cjk'; ctx.fillText('多周期主力净额', PAD, chartY);
  const chartX = PAD + 190, chartW = W - PAD * 2 - 220, baseY = chartY + 100;
  const periods = PERIODS.map(days => ({ days, value: periodValue(data.rows, days) }));
  const knownPeriods = periods.filter(p => p.value !== null);
  const maxAbs = Math.max(...knownPeriods.map(p => Math.abs(p.value)), 1); ctx.strokeStyle = '#dfe4ea'; ctx.beginPath(); ctx.moveTo(chartX, baseY); ctx.lineTo(chartX + chartW, baseY); ctx.stroke();
  periods.forEach((p, i) => { const x = chartX + i * (chartW / PERIODS.length) + 8, h = p.value === null ? 0 : Math.max(3, Math.abs(p.value) / maxAbs * 78); ctx.fillStyle = p.value === null ? '#c8ced6' : p.value >= 0 ? red : green; if (h) ctx.fillRect(x, p.value >= 0 ? baseY - h : baseY, 72, h); ctx.fillStyle = ink; ctx.font = '16px cjk'; ctx.textAlign = 'center'; ctx.fillText(`${p.days}日`, x + 36, baseY + 24); ctx.fillStyle = p.value === null ? sub : p.value >= 0 ? red : green; ctx.font = 'bold 14px cjk'; ctx.fillText(fmtPeriodValue(p.value), x + 36, p.value === null ? baseY - 16 : p.value >= 0 ? baseY - h - 16 : baseY + h + 42); });
  ctx.fillStyle = sub; ctx.textAlign = 'left'; ctx.font = '15px cjk'; ctx.fillText(isEtf ? 'ETF说明：单量资金分类仅作基础参考，不代表申赎资金。' : '说明：主力/大小单按成交单大小划分，不等同于真实机构资金。', PAD, H - 34);
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
  if (flowResult?.error === 'upstream') return { ok: false, text: `⚠️ ${name} 资金流接口当前无法访问（东财连接被重置），请稍后重试` };
  const flow = flowResult;
  if (!flow) return { ok: false, text: `⚠️ ${name} 暂无足够的已完成交易日资金流数据` };
  name = quote?.name || flow.name || name;
  const isEtf = /ETF|LOF|基金/i.test(name) || /^(sh)51|^sz15|^sz16/i.test(code);
  const text = buildFlowText(name, code, flow, isEtf);
  let img = null; try { img = renderFlowPng(name, code, flow, isEtf); } catch (e) { console.error('[zjl] 图片生成失败:', e.message); }
  return { ok: true, text, img };
}

module.exports = { cmdZjl, completedRows, parseFlowRows, sumPeriod };
