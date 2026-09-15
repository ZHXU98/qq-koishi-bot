// ============================================================
// 通用工具：时间格式化 / 缓存 / 金额换算 / 文本工具
// ============================================================

function uptimeText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
}
function nowText() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtAmountWan(v) { return (v / 10000).toFixed(1) + '亿'; }
function fmtAmountYuan(v) { return (v / 1e8).toFixed(1) + '亿'; }
// 预计全天成交额（万）。优先按上一交易日同时刻完成度比例校正（ratio=全天/同时刻>1，
// 天然含"上午量>下午量"分布与午休处理）；无历史比例时回退 240 分钟线性外推。
function estFullDayAmount(amountWan, now, ratio) {
  if (ratio && ratio > 1) return Math.round(amountWan * ratio);
  const min = now.getHours() * 60 + now.getMinutes();
  let traded = 0;
  if (min <= 570) traded = 0;              // 9:30 前
  else if (min <= 690) traded = min - 570; // 9:30-11:30
  else if (min <= 780) traded = 120;       // 午休
  else if (min <= 900) traded = 120 + (min - 780); // 13:00-15:00
  else traded = 240;                       // 15:00 后
  return traded > 0 ? Math.round(amountWan * 240 / traded) : 0;
}
function isTradingDay(d) { // 粗略：周一至周五视为交易日（节假日不单独判断，收盘态自动兜底）
  const w = d.getDay();
  return w !== 0 && w !== 6;
}
// ---- 行情数据内存缓存（降低重复接口请求；key 带日期/TTL 自动失效） ----
const __CACHE = new Map();
const __INFLIGHT = new Map();
function cacheGet(key) { const c = __CACHE.get(key); return c && c.exp > Date.now() ? c.val : undefined; }
function cacheSet(key, val, ttlMs) { __CACHE.set(key, { exp: Date.now() + ttlMs, val }); }
// 同一份行情仍在请求时复用 Promise，避免缓存写入前被并发命令重复打上游。
function coalesceRequest(key, loader) {
  const running = __INFLIGHT.get(key);
  if (running) return running;
  const task = Promise.resolve().then(loader).finally(() => __INFLIGHT.delete(key));
  __INFLIGHT.set(key, task);
  return task;
}

function normStockName(s) {
  const v = String(s || '').trim();
  return /^[\u4e00-\u9fa5\s]+$/.test(v) ? v.replace(/\s+/g, '') : v;
}

// 场内基金（ETF/LOF）判定：沪市 5xxxxx、深市 15xxxx / 16xxxx。
// 场内基金最小变动价位 0.001 → 价格应固定 3 位小数（不能只看现价字符串，现价恰为 1.21 时会误判成 2 位）
function isFundCode(code) {
  return /^(sh5|sz15|sz16)/.test(String(code || '').toLowerCase());
}

function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function wrapText(ctx, text, maxW, maxLines) {
  const out = [];
  for (const seg of String(text).split('\n')) {
    let line = '';
    for (const ch of seg) {
      if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; if (out.length >= maxLines) return out; }
      else line += ch;
    }
    if (line) out.push(line);
    if (out.length >= maxLines) return out;
  }
  return out;
}

const f2p = v => {
  if (!isFinite(v)) return '-';
  const n = Number(v);
  const s = String(Math.abs(n));
  const dot = s.indexOf('.');
  const dec = dot >= 0 ? s.slice(dot + 1).replace(/0+$/, '').length : 0;
  return n.toFixed(Math.min(3, Math.max(2, dec)));
};

function extractMagnet(text) {
  const t = String(text || '');
  const m = t.match(/magnet:\?xt=urn:btih:([a-fA-F0-9]{40})/i);
  if (m) return 'magnet:?xt=urn:btih:' + m[1].toLowerCase();
  const h = t.match(/(^|\s)([a-fA-F0-9]{40})(\s|$)/);
  if (h) return 'magnet:?xt=urn:btih:' + h[2].toLowerCase();
  return '';
}
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '未知';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

module.exports = {
  uptimeText, nowText, sleep, fmtAmountWan, fmtAmountYuan, estFullDayAmount, isTradingDay,
  cacheGet, cacheSet, coalesceRequest, normStockName, isFundCode, esc, mapLimit, wrapText, extractMagnet, fmtSize, f2p,
};
