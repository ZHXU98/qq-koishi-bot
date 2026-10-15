// ============================================================
// 外汇数据层：新浪外汇（大陆直连）
// - 分时：最近 1440 根 1 分钟数据（滚动约 24 小时）
// - 日线：新浪完整历史；周/月由日线在命令层聚合
// - 外汇为 24×5 连续交易，周末返回最后一个交易时段
// ============================================================
const { cacheGet, cacheSet, coalesceRequest } = require('./utils');

const FX_MIN_URL = 'https://quotes.sina.cn/forex/api/openapi.php/NewForexService.getMinKline?symbol=%s&scale=%s&datalen=%s';
const FX_DAY_URL = 'https://quotes.sina.cn/forex/api/openapi.php/NewForexService.getDayKLine?symbol=%s';
const FX_QUOTE_URL = 'https://hq.sinajs.cn/list=%s';
const FX_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' };

const FX_CURRENCIES = {
  USD: '美元', EUR: '欧元', GBP: '英镑', JPY: '日元', AUD: '澳元',
  CHF: '瑞士法郎', CAD: '加元', NZD: '新西兰元', CNH: '离岸人民币', CNY: '人民币',
  HKD: '港元', SGD: '新加坡元', SEK: '瑞典克朗', NOK: '挪威克朗',
  TRY: '土耳其里拉', MXN: '墨西哥比索', ZAR: '南非兰特',
};

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
  'EUR/JPY': { symbol: 'fx_seurjpy', name: '欧元兑日元', prec: 3 },
  'EUR/GBP': { symbol: 'fx_seurgbp', name: '欧元兑英镑', prec: 5 },
  'EUR/CHF': { symbol: 'fx_seurchf', name: '欧元兑瑞郎', prec: 5 },
  'EUR/AUD': { symbol: 'fx_seuraud', name: '欧元兑澳元', prec: 5 },
  'EUR/CAD': { symbol: 'fx_seurcad', name: '欧元兑加元', prec: 5 },
  'EUR/NZD': { symbol: 'fx_seurnzd', name: '欧元兑新西兰元', prec: 5 },
  'USD/HKD': { symbol: 'fx_susdhkd', name: '美元兑港元', prec: 4 },
  'USD/SGD': { symbol: 'fx_susdsgd', name: '美元兑新加坡元', prec: 5 },
  'USD/SEK': { symbol: 'fx_susdsek', name: '美元兑瑞典克朗', prec: 4 },
  'USD/NOK': { symbol: 'fx_susdnok', name: '美元兑挪威克朗', prec: 4 },
  'USD/TRY': { symbol: 'fx_susdtry', name: '美元兑土耳其里拉', prec: 4 },
  'USD/MXN': { symbol: 'fx_susdmxn', name: '美元兑墨西哥比索', prec: 4 },
  'USD/ZAR': { symbol: 'fx_susdzar', name: '美元兑南非兰特', prec: 4 },
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
  'EURJPY': 'EUR/JPY', '欧元日元': 'EUR/JPY', '欧元兑日元': 'EUR/JPY',
  'EURGBP': 'EUR/GBP', '欧元英镑': 'EUR/GBP', '欧元兑英镑': 'EUR/GBP',
  'EURCHF': 'EUR/CHF', '欧元瑞郎': 'EUR/CHF', '欧元兑瑞郎': 'EUR/CHF',
  'EURAUD': 'EUR/AUD', '欧元澳元': 'EUR/AUD', '欧元兑澳元': 'EUR/AUD',
  'EURCAD': 'EUR/CAD', '欧元加元': 'EUR/CAD', '欧元兑加元': 'EUR/CAD',
  'EURNZD': 'EUR/NZD', '欧元纽元': 'EUR/NZD', '欧元新西兰元': 'EUR/NZD', '欧元兑新西兰元': 'EUR/NZD',
  'USDHKD': 'USD/HKD', '美元港元': 'USD/HKD', '美元兑港元': 'USD/HKD',
  'USDSGD': 'USD/SGD', '美元新加坡元': 'USD/SGD', '美元兑新加坡元': 'USD/SGD',
  'USDSEK': 'USD/SEK', '美元瑞典克朗': 'USD/SEK', '美元兑瑞典克朗': 'USD/SEK',
  'USDNOK': 'USD/NOK', '美元挪威克朗': 'USD/NOK', '美元兑挪威克朗': 'USD/NOK',
  'USDTRY': 'USD/TRY', '美元土耳其里拉': 'USD/TRY', '美元兑土耳其里拉': 'USD/TRY',
  'USDMXN': 'USD/MXN', '美元墨西哥比索': 'USD/MXN', '美元兑墨西哥比索': 'USD/MXN',
  'USDZAR': 'USD/ZAR', '美元南非兰特': 'USD/ZAR', '美元兑南非兰特': 'USD/ZAR',
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
      const j = await fetchJson(FX_MIN_URL
        .replace('%s', encodeURIComponent(info.symbol))
        .replace('%s', '1')
        .replace('%s', '1440'));
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

async function fetchFxKline(info, period) {
  const cfg = {
    m1: { scale: 1, datalen: 1440 },
    m5: { scale: 5, datalen: 1000 },
    m30: { scale: 30, datalen: 1000 },
    h1: { scale: 60, datalen: 1000 },
    h2: { scale: 60, datalen: 1000 },
  }[period];
  if (!cfg) return null;
  const key = `fx:kline:${period}:${info.symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    try {
      const j = await fetchJson(FX_MIN_URL
        .replace('%s', encodeURIComponent(info.symbol))
        .replace('%s', String(cfg.scale))
        .replace('%s', String(cfg.datalen)));
      const src = j?.result?.data;
      if (!Array.isArray(src) || src.length < 2) return null;
      let rows = src.map(r => ({
        t: String(r.d || '').slice(0, 16),
        open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), vol: 0,
      })).filter(k => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(k.t) && k.open > 0 && k.high > 0 && k.low > 0 && k.close > 0);
      if (period === 'h2') rows = aggregateFxHours(rows, 2);
      if (rows.length < 2) return null;
      cacheSet(key, rows, 30 * 1000);
      return rows;
    } catch (_) { return null; }
  });
}

function aggregateFxHours(rows, hours) {
  const out = [];
  for (const k of rows) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(k.t);
    if (!m) continue;
    const bucketHour = Math.floor(Number(m[2]) / hours) * hours;
    const bucket = `${m[1]} ${String(bucketHour).padStart(2, '0')}:00`;
    const last = out[out.length - 1];
    if (!last || last.t !== bucket) {
      out.push({ t: bucket, open: k.open, high: k.high, low: k.low, close: k.close, vol: 0 });
    } else {
      last.high = Math.max(last.high, k.high);
      last.low = Math.min(last.low, k.low);
      last.close = k.close;
    }
  }
  return out;
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

function fxListText() {
  const explain = pair => {
    const [base, quote] = pair.split('/');
    return `${pair}  ${FX_PAIRS[pair].name}（1${FX_CURRENCIES[base]}＝多少${FX_CURRENCIES[quote]}）`;
  };
  const groups = [
    ['主要直盘', ['USD/CNH', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'USD/CAD', 'NZD/USD', 'EUR/CNY']],
    ['欧元交叉盘', ['EUR/JPY', 'EUR/GBP', 'EUR/CHF', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD']],
    ['亚洲与新兴市场', ['USD/HKD', 'USD/SGD', 'USD/SEK', 'USD/NOK', 'USD/TRY', 'USD/MXN', 'USD/ZAR']],
  ];
  const codes = Object.entries(FX_CURRENCIES).map(([code, name]) => `${code} ${name}`).join('｜');
  const lines = [
    '💱 外汇货币对说明',
    '货币对按市场标准方向报价，不按数值大小排列。斜杠前是基础货币，后是计价货币。',
    '例如 EUR/JPY 177.00 表示：1欧元＝177.00日元。反向 JPY/EUR 可用 1÷177.00 计算，但不是常用报价方向。',
    '',
    `代码：${codes}`,
  ];
  for (const [title, pairs] of groups) {
    lines.push('', `【${title}】`, ...pairs.map(explain));
  }
  lines.push('', '输入方式（命令、周期和英文代码均不区分大小写；中英文均可加空格）：', '/fx EUR/JPY　/FX eurjpy　/fx eUr JpY　/fx 欧元 日元', '加周期示例：/FX -5M eur jpy　/fx -2h 欧元 英镑');
  return lines.join('\n');
}

module.exports = {
  FX_PAIRS, FX_ALIASES, FX_CURRENCIES, resolveFxPair,
  fetchFxMinute, fetchFxKline, aggregateFxHours, fetchFxDaily, fetchFxQuote, fxPairText, fxListText,
};
