// ============================================================
// 外汇数据层：新浪外汇（大陆直连）
// - 分时：最近 1440 根 1 分钟数据（滚动约 24 小时）
// - 日线：新浪完整历史；周/月由日线在命令层聚合
// - 外汇为 24×5 连续交易，周末返回最后一个交易时段
// ============================================================
const { cacheGet, cacheSet, coalesceRequest } = require('./utils');

const FX_MIN_URL = 'https://quotes.sina.cn/forex/api/openapi.php/NewForexService.getMinKline?symbol=%s&scale=1&datalen=1440';
const FX_DAY_URL = 'https://quotes.sina.cn/forex/api/openapi.php/NewForexService.getDayKLine?symbol=%s';
const FX_QUOTE_URL = 'https://hq.sinajs.cn/list=%s';
const FX_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' };

const FX_PAIRS = {
  'USD/CNH': { symbol: 'fx_susdcnh', name: '美元兑离岸人民币', prec: 4 },
  'EUR/USD': { symbol: 'fx_seurusd', name: '欧元兑美元', prec: 5 },
  'GBP/USD': { symbol: 'fx_sgbpusd', name: '英镑兑美元', prec: 5 },
  'USD/JPY': { symbol: 'fx_susdjpy', name: '美元兑日元', prec: 3 },
  'AUD/USD': { symbol: 'fx_saudusd', name: '澳元兑美元', prec: 5 },
  'USD/CHF': { symbol: 'fx_susdchf', name: '美元兑瑞郎', prec: 5 },
  'USD/CAD': { symbol: 'fx_susdcad', name: '美元兑加元', prec: 5 },
  'NZD/USD': { symbol: 'fx_snzdusd', name: '新西兰元兑美元', prec: 5 },
  'EUR/CNY': { symbol: 'fx_seurcny', name: '欧元兑人民币', prec: 4 },
};

const FX_ALIASES = {
  'USDCNH': 'USD/CNH', '美元离岸人民币': 'USD/CNH', '美元兑离岸人民币': 'USD/CNH', '离岸人民币': 'USD/CNH', '离岸': 'USD/CNH',
  'EURUSD': 'EUR/USD', '欧元美元': 'EUR/USD', '欧元兑美元': 'EUR/USD',
  'GBPUSD': 'GBP/USD', '英镑美元': 'GBP/USD', '英镑兑美元': 'GBP/USD',
  'USDJPY': 'USD/JPY', '美元日元': 'USD/JPY', '美元兑日元': 'USD/JPY',
  'AUDUSD': 'AUD/USD', '澳元美元': 'AUD/USD', '澳元兑美元': 'AUD/USD',
  'USDCHF': 'USD/CHF', '美元瑞郎': 'USD/CHF', '美元兑瑞郎': 'USD/CHF',
  'USDCAD': 'USD/CAD', '美元加元': 'USD/CAD', '美元兑加元': 'USD/CAD',
  'NZDUSD': 'NZD/USD', '纽元美元': 'NZD/USD', '新西兰元美元': 'NZD/USD', '新西兰元兑美元': 'NZD/USD',
  'EURCNY': 'EUR/CNY', '欧元人民币': 'EUR/CNY', '欧元兑人民币': 'EUR/CNY',
};

function resolveFxPair(input) {
  const raw = String(input || '').trim();
  const normalized = raw.toUpperCase().replace(/[\s_-]/g, '').replace('／', '/');
  const slash = normalized.includes('/') ? normalized : normalized.replace(/^([A-Z]{3})([A-Z]{3})$/, '$1/$2');
  const key = FX_PAIRS[slash] ? slash : FX_ALIASES[raw.replace(/\s+/g, '')] || FX_ALIASES[normalized];
  return key && FX_PAIRS[key] ? { pair: key, ...FX_PAIRS[key] } : null;
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: FX_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchFxMinute(info) {
  const key = `fx:min:${info.symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    try {
      const j = await fetchJson(FX_MIN_URL.replace('%s', encodeURIComponent(info.symbol)));
      const src = j?.result?.data;
      if (!Array.isArray(src) || src.length < 2) return null;
      const rows = src.map(r => ({
        t: String(r.d || '').slice(11, 16),
        open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), vol: 0,
      })).filter(k => /^\d{2}:\d{2}$/.test(k.t) && k.open > 0 && k.high > 0 && k.low > 0 && k.close > 0);
      if (rows.length < 2) return null;
      const fmt = value => String(value || '').slice(5, 16);
      rows._date = `${fmt(src[0].d)} 至 ${fmt(src[src.length - 1].d)}`;
      const p = Number(src[0].p);
      if (p > 0) rows._prevClose = p;
      cacheSet(key, rows, 30 * 1000);
      return rows;
    } catch (_) { return null; }
  });
}

async function fetchFxDaily(info) {
  const key = `fx:day:${info.symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    try {
      const j = await fetchJson(FX_DAY_URL.replace('%s', encodeURIComponent(info.symbol)));
      const text = j?.result?.data;
      if (typeof text !== 'string' || !text.includes(',')) return null;
      const rows = text.split('|').map(line => {
        const f = line.split(',');
        return { t: f[0], open: Number(f[1]), low: Number(f[2]), high: Number(f[3]), close: Number(f[4]), vol: 0 };
      }).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k.t) && k.open > 0 && k.high > 0 && k.low > 0 && k.close > 0);
      if (rows.length < 2) return null;
      cacheSet(key, rows, 10 * 60 * 1000);
      return rows;
    } catch (_) { return null; }
  });
}

async function fetchFxQuote(info) {
  const key = `fx:quote:${info.symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    try {
      const resp = await fetch(FX_QUOTE_URL.replace('%s', encodeURIComponent(info.symbol)), {
        headers: FX_HEADERS, signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const text = new TextDecoder('gbk').decode(buf);
      const m = /="([^"]*)"/.exec(text);
      if (!m || !m[1]) return null;
      const f = m[1].split(',');
      const price = Number(f[8]);
      const chg = Number(f[11]);
      const prevClose = price > 0 && Number.isFinite(chg) ? price - chg : Number(f[3]);
      const q = {
        name: f[9] || info.name, price, prevClose,
        open: Number(f[5]) || price, high: Number(f[6]) || price, low: Number(f[7]) || price,
        chg: Number.isFinite(chg) ? chg : price - prevClose,
        chgPct: Number.isFinite(Number(f[10])) ? Number(f[10]) : (prevClose ? (price - prevClose) / prevClose * 100 : 0),
        date: f[17] || '', time: f[0] || '', volume: 0,
      };
      if (!(q.price > 0)) return null;
      cacheSet(key, q, 15 * 1000);
      return q;
    } catch (_) { return null; }
  });
}

function fxPairText() {
  return Object.entries(FX_PAIRS).map(([pair, x]) => `${pair} ${x.name}`).join('｜');
}

module.exports = { FX_PAIRS, FX_ALIASES, resolveFxPair, fetchFxMinute, fetchFxDaily, fetchFxQuote, fxPairText };
