// ============================================================
// 行情数据层：代码解析 / K线分时拉取 / 指标计算 / 全球商品
// 数据源：腾讯 qfq / 分钟K / 分时 + 东财K线 + 新浪全球期货
// ============================================================
const { cacheGet, cacheSet, coalesceRequest, normStockName } = require('./utils');

const STOCK_QUOTE = 'https://qt.gtimg.cn/q=%s';                    // 实时快照（名称/现价，GBK）
const STOCK_FQKLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,%s,,,320,qfq'; // 日/周/月K（320根，qfq 前复权）
const STOCK_MINUTE = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=%s,%s,,320'; // 分钟K
const STOCK_TIMELINE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=%s'; // 当日分时（分钟级）
const STOCK_SEARCH = 'https://smartbox.gtimg.cn/s3/?v=2&q=%s&t=all'; // 名称→代码（GBK）

// 周期归一化（-d 日线 / -w 周线 / -M 月线 / -t 分时；分钟：-1m/-5m/-30m/-1h）
const STOCK_PERIODS = { '-d': 'day', '-w': 'week', '-week': 'week', '周线': 'week', '周k': 'week', '-m': 'month', '-M': 'month', '-month': 'month', '月线': 'month', '月k': 'month', '-1m': 'm1', '-5m': 'm5', '-30m': 'm30', '-1h': 'm60', '-t': 'time', '-time': 'time', '分时': 'time', '-pre': 'premarket', 'pre': 'premarket', '盘前': 'premarket' };
const STOCK_PERIOD_LABEL = { day: '日线', week: '周线', month: '月线', m1: '1分钟', m5: '5分钟', m30: '30分钟', m60: '60分钟', time: '分时', premarket: '盘前' };
// 手机端敲「-」不方便 → 允许省略前导 - 的周期别名（t/d/w/m）。
// ⚠️ 只在「后面还跟着代码/组合名」时才当周期用：美股 T/D/W/M（AT&T / Dominion / Wayfair / Macy's）
//    本身就是合法代码，单独一个字母必须仍然按代码解析。
const BARE_PERIOD = { t: 'time', d: 'day', w: 'week', m: 'month' };
const STOCK_LONG = ['day', 'week', 'month']; // 长周期（日/周/月，fqkline 接口）

function normalizeCode(raw) {
  let c = String(raw || '').trim().toLowerCase();
  if (/^(sh|sz|bj)/.test(c)) return c;
  if (/^hk/.test(c)) return 'hk' + c.slice(2).toUpperCase(); // hk00700 / hkhsi→hkHSI
  if (/^us[a-z0-9.]{1,10}$/.test(c)) return 'us' + c.slice(2).toUpperCase(); // usaapl→usAAPL、usAAPL.OQ→usAAPL.OQ
  if (/^hf_[a-z0-9]{1,6}$/.test(c)) return 'hf_' + c.slice(3).toUpperCase(); // hf_oil→hf_OIL（前缀保持小写，系统其余处均按小写 hf_ 判断）
  if (/^\d{6}$/.test(c)) {
    if (/^[56]/.test(c)) return 'sh' + c; // 60xxxx 沪A / 51xxxx 沪ETF
    return 'sz' + c;                       // 00/30 深A、15xxxx 深ETF
  }
  if (/^\d{1,5}$/.test(c)) return 'hk' + c.padStart(5, '0'); // 港股：1-5 位数字补零（700→hk00700）
  return '';
}

const GLOBAL_ALIAS = {
  '布伦特原油': 'hf_OIL', '布油': 'hf_OIL',
  '纽约原油': 'hf_CL', '美油': 'hf_CL', 'wti': 'hf_CL', 'wti原油': 'hf_CL',
  '黄金': 'hf_GC', '纽约黄金': 'hf_GC', 'comex黄金': 'hf_GC', '国际金': 'hf_GC',
  '伦敦金': 'hf_XAU', '伦敦金现': 'hf_XAU', '现货黄金': 'hf_XAU', 'xau': 'hf_XAU', 'xauusd': 'hf_XAU', 'xau/usd': 'hf_XAU',
  '白银': 'hf_SI', '纽约白银': 'hf_SI', 'comex白银': 'hf_SI',
  '天然气': 'hf_NG', '美国天然气': 'hf_NG',
  '美铜': 'hf_HG', '伦铜': 'hf_CAD',
  '大豆': 'hf_S', '美豆': 'hf_S', '黄豆': 'hf_S', '美国大豆': 'hf_S',
  '豆粕': 'hf_SM', '豆粉': 'hf_SM', '美黄豆粉': 'hf_SM',
  '豆油': 'hf_BO', '美黄豆油': 'hf_BO',
  '玉米': 'hf_C', '美玉米': 'hf_C', '美国玉米': 'hf_C',
  '小麦': 'hf_W', '美小麦': 'hf_W', '美国小麦': 'hf_W',
  '费城半导体': 'usSOXX.OQ', '费半': 'usSOXX.OQ', '费城半导体指数': 'usSOXX.OQ',
  '道琼斯': 'usDJI', '道指': 'usDJI', '道琼斯指数': 'usDJI',
  '纳斯达克': 'usIXIC', '纳指': 'usIXIC', '纳斯达克指数': 'usIXIC',
  '标普500': 'usINX', '标普': 'usINX', '标普指数': 'usINX', 'sp500': 'usINX',
  '恒生指数': 'hkHSI', '恒指': 'hkHSI',
  '上证指数': 'sh000001', '上证': 'sh000001', '沪指': 'sh000001',
  '深证成指': 'sz399001', '深成指': 'sz399001',
  '创业板指': 'sz399006', '创业板': 'sz399006',
  '沪深300': 'sh000300', '中证500': 'sh000905', '上证50': 'sh000016', '科创50': 'sh000688',
};
// 无K线数据 → 文本行情速查 的代码（全球指数；hf_ 商品前缀另有判断）
// 2026-09-11：hkHSI 移出——实测腾讯对恒指日/周/月/分时全有数据，此前文本拦截是过时限制；
// usDJI/usINX 日/周/月改走东财 K 线（EM_IDX_SECID），仅分时/分钟级仍文本速查；usIXIC（纳指综合）
// 东财无对应 secid（100.IXIC/NIXIC/NASDAQ 等均无），保持全周期文本速查。
const GLOBAL_TEXT = { 'usDJI': 1, 'usIXIC': 1, 'usINX': 1 };
// 美股指数 → 东财 secid（日/周/月 K 线可用；分时口径与个股不同，不接）
const EM_IDX_SECID = { 'usDJI': '100.DJIA', 'usINX': '100.SPX' };

async function resolveStockCode(q, { details = false } = {}) {
  const rawQuery = String(q || '').trim();
  const key = rawQuery.toLowerCase();
  const result = { code: '', name: '', exact: false, candidates: [] };
  if (['伦敦银', '伦敦银现'].includes(key)) return details ? result : '';
  if (GLOBAL_ALIAS[key]) {
    result.code = GLOBAL_ALIAS[key];
    result.name = rawQuery;
    result.exact = true;
    return details ? result : result.code;
  }
  try {
    const resp = await fetch(STOCK_SEARCH.replace('%s', encodeURIComponent(rawQuery)), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const m = text.match(/v_hint="([^"]+)"/);
    if (!m) return details ? result : '';
    const candidates = m[1].split('^').map(row => {
      const parts = row.split('~');
      if (parts.length < 3) return null;
      const market = parts[0], rawCode = String(parts[1]);
      const name = normStockName(parts[2].replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
      let code = '';
      if (market === 'us') code = 'us' + rawCode.toUpperCase();
      else if (/^\d{5,6}$/.test(rawCode)) code = market + rawCode;
      return code ? { market, rawCode, code, name } : null;
    }).filter(Boolean);
    result.candidates = candidates;
    if (!candidates.length) return details ? result : '';
    const normalizedQuery = normStockName(rawQuery).toLowerCase();
    const hit = candidates.find(item => item.name.toLowerCase() === normalizedQuery) || candidates[0];
    result.code = hit.code;
    result.name = hit.name;
    result.exact = hit.name.toLowerCase() === normalizedQuery;
    return details ? result : result.code;
  } catch (_) { return details ? result : ''; }
}

function calcSMA(arr, period) { // arr 为收盘价数组（旧→新），返回同长数组（前 period-1 为 null）
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function calcBOLL(closes, period = 20, k = 2) { // 返回 { mid, up, low } 三数组
  const mid = calcSMA(closes, period);
  const up = new Array(closes.length).fill(null);
  const low = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    up[i] = mean + k * sd;
    low[i] = mean - k * sd;
  }
  return { mid, up, low };
}

function buildAvgLine(disp) {
  if (!disp || disp.length < 2) return null;
  const withAvg = disp.filter(k => Number(k.avgPrice) > 0).length;
  if (withAvg >= disp.length * 0.8) return disp.map(k => (Number(k.avgPrice) > 0 ? Number(k.avgPrice) : k.close));
  const last = disp[disp.length - 1];
  const lastAmt = Number(last.cumAmt), lastVol = Number(last.cumVol), px = Number(last.close);
  if (!(lastAmt > 0) || !(lastVol > 0) || !(px > 0)) return null;
  let div = 0;
  for (const d of [100, 1]) {
    const v = lastAmt / (lastVol * d);
    if (v > 0 && Math.abs(v - px) / px < 0.2) { div = d; break; }
  }
  if (!div) return null; // 两个口径都对不上 → 宁可不画均价线，也不压扁价格线
  return disp.map(k => {
    const a = Number(k.avgPrice);
    if (a > 0) return a;
    const amt = Number(k.cumAmt), vol = Number(k.cumVol);
    return (amt > 0 && vol > 0) ? amt / (vol * div) : k.close;
  });
}

const _yahooPremarketLastGood = new Map(); // symbol → 当日最后一份最完整数据，防止上游残缺响应覆盖
const _yahooPremarketStatus = new Map();   // symbol → ok / no_data / source_error（供命令层给准确提示）
function yahooSymbol(code) {
  return String(code || '').slice(2).replace(/\.(OQ|N|AM)$/i, '').toUpperCase();
}
function getYahooPremarketStatus(code) {
  return _yahooPremarketStatus.get(yahooSymbol(code)) || '';
}
async function fetchYahooPremarket(code) {
  if (!String(code || '').startsWith('us')) return null;
  const symbol = yahooSymbol(code);
  if (!/^[A-Z0-9.^-]{1,15}$/.test(symbol)) return null;
  const ckey = 'yahoo-premarket:' + symbol;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  return coalesceRequest(ckey, async () => {
    const cachedAgain = cacheGet(ckey);
    if (cachedAgain) return cachedAgain;
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = ts => dtf.formatToParts(new Date(ts * 1000)).reduce((o, p) => (o[p.type] = p.value, o), {});
    const nowParts = parts(Math.floor(Date.now() / 1000));
    const nyToday = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
    const parseResult = result => {
      const timestamps = result?.timestamp;
      const quote = result?.indicators?.quote?.[0];
      if (!Array.isArray(timestamps) || !quote) return null;
      const out = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = Number(quote.close?.[i]);
        if (!(close > 0)) continue;
        const p = parts(timestamps[i]);
        const date = `${p.year}-${p.month}-${p.day}`;
        const t = `${p.hour}${p.minute}`;
        if (date !== nyToday || t < '0400' || t >= '0930') continue;
        out.push({
          t, open: Number(quote.open?.[i]) || close, close,
          high: Number(quote.high?.[i]) || close, low: Number(quote.low?.[i]) || close,
          vol: Number(quote.volume?.[i]) || 0,
        });
      }
      if (!out.length) return null;
      out._date = nyToday.slice(5);
      out._prevClose = Number(result?.meta?.chartPreviousClose || result?.meta?.previousClose || result?.meta?.regularMarketPreviousClose) || 0;
      out._symbol = symbol;
      return out;
    };
    const fetchHost = async host => {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const result = (await resp.json())?.chart?.result?.[0];
        return { ok: true, data: parseResult(result) };
      } catch (e) {
        return { ok: false, error: e && e.message || 'unknown' };
      }
    };
    // Yahoo 两个公开节点偶尔一个只返回零散分钟点；并行取两份，择完整者。
    let attempts = await Promise.all(['query1', 'query2'].map(fetchHost));
    let candidates = attempts.filter(x => x.data?.length).map(x => x.data);
    // 两节点都只给出极少点时再快速重试一次；低流动性股票最终仍保留少量真实成交，不粗暴判空。
    if (candidates.length && Math.max(...candidates.map(x => x.length)) < 5) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const retry = await Promise.all(['query1', 'query2'].map(fetchHost));
      attempts = attempts.concat(retry);
      candidates = candidates.concat(retry.filter(x => x.data?.length).map(x => x.data));
    }
    let best = candidates.sort((a, b) => b.length - a.length)[0] || null;
    const stale = _yahooPremarketLastGood.get(symbol);
    if (stale && stale._date === nyToday.slice(5) && (!best || stale.length > best.length)) {
      best = stale; // 同日上游响应变短视为残缺，退回进程内最后完整数据
      best._stale = true;
    }
    if (best) {
      _yahooPremarketLastGood.set(symbol, best);
      _yahooPremarketStatus.set(symbol, 'ok');
      cacheSet(ckey, best, 15000);
      return best;
    }
    const anySuccess = attempts.some(x => x.ok);
    _yahooPremarketStatus.set(symbol, anySuccess ? 'no_data' : 'source_error');
    if (!anySuccess) console.error('[yahoo-premarket] 两节点均失败', symbol, attempts.map(x => x.error).filter(Boolean).join(' / '));
    return null;
  });
}

async function fetchStockKline(code, period) {
  const ckey = 'kline:' + code + ':' + period;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  return coalesceRequest(ckey, async () => {
    const cachedAgain = cacheGet(ckey);
    if (cachedAgain) return cachedAgain;
  const parse = (j, key) => {
    const d = j?.data?.[key];
    if (!d) return null;
    if (period === 'time') {
      // 分时："0930 1297.99 270 35045730.00" = 时间 价格 累计量(手) 累计额(元)
      // 腾讯给的是累计量 → 差分出「每分钟量」用于画柱；cumVol 保留供均价计算（cumAmt/cumVol）
      const rows = d?.data?.data || [];
      if (!Array.isArray(rows) || rows.length < 2) return null;
      let prevVol = 0;
      return rows.map(r => {
        const p = String(r).split(' ');
        const close = Number(p[1]), cumVol = Number(p[2]), cumAmt = Number(p[3]);
        const diffVol = Math.max(0, cumVol - prevVol); prevVol = cumVol;
        return {
          t: p[0], open: close, close, high: close, low: close,
          vol: diffVol, cumVol: cumVol, cumAmt,
        };
      });
    }
    const raw = d['qfq' + period] || d[period] || []; // day→qfqday||day；week→qfqweek||week；month→qfqmonth||month；m5→d.m5
    if (!Array.isArray(raw) || raw.length < 2) return null;
    return raw.map(r => ({
      t: r[0], open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), vol: Number(r[5]),
    }));
  };
  const fetchOnce = async (url, key) => {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const j = await resp.json();
      return parse(j, key);
    } catch (_) { return null; }
  };
  const isLong = STOCK_LONG.includes(period);
  let result = null;
  if (period === 'premarket') {
    result = await fetchYahooPremarket(code);
  } else if (EM_IDX_SECID[code] && isLong) {
    // 美股指数（道指/标普500）：腾讯无 K 线，走东财 kline（日 klt=101 / 周 102 / 月 103，320 根）
    // 2026-09-11 新增；分时不走此路（东财对指数分时的采样口径与个股不同），仍文本速查
    result = await fetchEmKline(EM_IDX_SECID[code], { day: 101, week: 102, month: 103 }[period]);
  } else if (isLong && code.startsWith('us')) {
    // 美股日/周/月K：接口需带交易所后缀（.OQ 纳斯达克 / .N 纽交所），无后缀输入按 .OQ → .N 依次尝试
    const cands = code.includes('.') ? [code] : [code + '.OQ', code + '.N'];
    for (const cand of cands) {
      const r = await fetchOnce(STOCK_FQKLINE.replace('%s', cand).replace('%s', period), cand);
      if (r && r.length >= 10) { result = r; break; }
    }
  } else {
    if (code.startsWith('hf_')) {
      // 国际商品：腾讯/东财既无分时也无日线，一律走新浪全球期货
      // （分时=当日分钟线；日/周/月=全球期货日 K，周月由日 K 本地聚合）
      result = period === 'time' ? await fetchSinaGlobalMin(code) : await fetchSinaGlobalKline(code, period);
    } else {
      let url;
      if (isLong) url = STOCK_FQKLINE.replace('%s', code).replace('%s', period); // 日/周/月K
      else if (period === 'time') url = STOCK_TIMELINE.replace('%s', code);
      else url = STOCK_MINUTE.replace('%s', code).replace('%s', period);
      result = await fetchOnce(url, code);
      // 分时：腾讯在没开盘/休市/美股盘后时只有 0-1 行 → 用东财最近交易日分时（ndays=1 自动取最近交易日）
      if (period === 'time' && (!result || result.length < 2)) {
        if (code.startsWith('us')) {
          // 美股：腾讯美股分钟只回 1 行，历来全靠东财 trends2；该接口 2026-10 起对本机出口直接 RST
          // （同域名 kline 仍 200）→ 改为新浪 1 分钟优先、东财兜底，否则整个美股组合「取数失败」无图
          const sina = await fetchSinaUsMin(code);
          result = (sina && sina.length >= 2) ? sina : await fetchEmTrends(emSecid(code), true);
        } else {
          result = await fetchEmTrends(emSecid(code), false);
        }
      }
    }
  }
  if (!result) return null;
  cacheSet(ckey, result, 5000); // K线分钟级变化，5 秒缓存足够
  return result;
  });
}

async function fetchEmKline(secid, klt) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=%s&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&fqt=1&lmt=320&end=20500101&klt=' + klt;
  const j = await emFetchJson(url.replace('%s', secid));
  const kl = j?.data?.klines;
  if (!Array.isArray(kl) || kl.length < 2) return null;
  return kl.map(r => {
    const p = String(r).split(',');
    return { t: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), vol: Number(p[5]) };
  });
}

const HF_SINA_SYM = { 'hf_XAU': 'XAU', 'hf_OIL': 'OIL', 'hf_GC': 'GC', 'hf_SI': 'SI', 'hf_CL': 'CL', 'hf_NG': 'NG', 'hf_HG': 'HG', 'hf_CAD': 'CAD',
  'hf_S': 'S', 'hf_SM': 'SM', 'hf_BO': 'BO', 'hf_C': 'C', 'hf_W': 'W' };
const SINA_GLOBAL_MIN = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_Global_=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=%s&type=1';
async function fetchSinaGlobalMin(code) {
  const sym = HF_SINA_SYM[code];
  if (!sym) return null;
  try {
    const resp = await fetch(SINA_GLOBAL_MIN.replace('%s', sym), { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(8000) });
    const t = await resp.text();
    const si = t.indexOf('('), ei = t.lastIndexOf(')');
    if (si < 0 || ei < si) return null;
    const j = JSON.parse(t.slice(si + 1, ei));
    const rows = j?.minLine_1d;
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const out = [];
    rows.forEach((row, i) => {
      const isFirst = i === 0; // 首行带日期/交易所/基准；后续行字段压缩
      const price = Number(row[1]) || 0;
      const tstr = String(isFirst ? row[4] : row[0]);
      out.push({
        t: tstr, open: price, close: price, high: price, low: price,
        vol: Number(isFirst ? row[6] : row[2]) || 0,        // 新浪为分钟量（非累计）
        avgPrice: Number(isFirst ? row[8] : row[4]) || 0,    // 当日累计均价
      });
    });
    // 时段标注：外盘近 23 小时连续交易、会话跨自然日（如 06:00 开 → 次日 01:29），
    // 只写首行日期（09-10）会让人误以为整张图是「9-10 那一天」，故直接给起止时刻。
    // 首行第 0 位是日期、第 9 位是完整时间戳；后续行被压缩，第 5 位才是时间戳
    const mdts = s => {
      const m = /(\d{4})-(\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || ''));
      return m ? `${m[2]} ${m[3]}` : '';
    };
    const st = mdts(rows[0][9]) || mdts(rows[0][0]);
    const en = mdts(rows[rows.length - 1][5]) || mdts(rows[rows.length - 1][4]);
    out._date = (st && en) ? `${st} 至 ${en}` : String(rows[0][0] || '').slice(5);
    return out;
  } catch (_) { return null; }
}

const SINA_GLOBAL_DAILY = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=%s';
const HF_DAILY_TTL = 10 * 60 * 1000;    // 日线一天才变一次；单次响应近 400KB，必须长缓存，否则组合出图会反复重拉
const _hfDailyCache = new Map();        // symbol → { at, rows }（进程级）
async function fetchSinaGlobalDaily(sym) {
  const hit = _hfDailyCache.get(sym);
  if (hit && Date.now() - hit.at < HF_DAILY_TTL) return hit.rows;
  const stale = hit ? hit.rows : null; // 上游偶发失败时退回旧数据，不阻塞出图
  try {
    const resp = await fetch(SINA_GLOBAL_DAILY.replace('%s', sym), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(12000),
    });
    const t = await resp.text();
    const si = t.indexOf('('), ei = t.lastIndexOf(')');
    if (si < 0 || ei < si) return stale;
    const j = JSON.parse(t.slice(si + 1, ei));
    if (!Array.isArray(j) || j.length < 2) return stale;
    const rows = j.map(r => ({
      t: String(r.date || '').slice(0, 10),
      open: Number(r.open), close: Number(r.close),
      high: Number(r.high), low: Number(r.low),
      vol: Number(r.volume) || 0,
    })).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k.t) && k.open > 0 && k.close > 0 && k.high > 0 && k.low > 0);
    if (rows.length < 2) return stale;
    _hfDailyCache.set(sym, { at: Date.now(), rows });
    return rows;
  } catch (_) { return stale; }
}
// 日 K → 周 K / 月 K（首根取开、最高取 max、最低取 min、末根取收、量求和）
// 周以「当周周一日期」为标签，月以「当月 1 日」为标签；渲染层按 t.slice(2,7) 显示 YY-MM，两种都适用
function aggHfKline(daily, period) {
  const bucketOf = k => {
    if (period === 'month') return k.t.slice(0, 7) + '-01';
    const d = new Date(k.t + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 回退到本周一（周一=0）
    return d.toISOString().slice(0, 10);
  };
  const out = [], idx = new Map();
  for (const k of daily) {
    const b = bucketOf(k);
    const g = idx.get(b);
    if (!g) {
      idx.set(b, { t: b, open: k.open, high: k.high, low: k.low, close: k.close, vol: k.vol });
      out.push(idx.get(b));
    } else {
      if (k.high > g.high) g.high = k.high;
      if (k.low < g.low) g.low = k.low;
      g.close = k.close;
      g.vol += k.vol;
    }
  }
  return out;
}
// 国际商品 日/周/月 K（统一入口；分钟 K 数据源不支持，调用方需先拦截）
async function fetchSinaGlobalKline(code, period) {
  const sym = HF_SINA_SYM[code];
  if (!sym) return null;
  const daily = await fetchSinaGlobalDaily(sym);
  if (!daily || daily.length < 2) return null;
  if (period === 'week' || period === 'month') return aggHfKline(daily, period);
  return daily;
}

const EM_TRENDS = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=%s&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0';
// 东财 secid：沪 1.xxxxxx / 深北 0.xxxxxx / 港股 116.xxxxx / 美股 105=纳斯达克 106=纽交所 107=AMEX
function emSecid(code) {
  const c = String(code).toLowerCase();
  if (c.startsWith('us')) {
    const sym = code.replace(/\.\w+$/, '').slice(2).toUpperCase();
    const mkt = /\.n$/.test(c) ? 106 : /\.am$/.test(c) ? 107 : 105;
    return mkt + '.' + sym;
  }
  if (c.startsWith('hk')) return '116.' + code.slice(2);
  const raw = code.replace(/^(sh|sz|bj)/, '');
  return (c.startsWith('sh') ? '1.' : '0.') + raw;
}
async function fetchEmTrends(secid, isUS) {
  try {
    const j = await emFetchJson(EM_TRENDS.replace('%s', secid));
    const rows = j?.data?.trends;
    if (!Array.isArray(rows) || rows.length < 2) { console.error('[fetchEmTrends] 数据为空', secid, rows ? rows.length : 'no-trends'); return null; }
    const out = [];
    let dateStr = '';
    // 东财美股 f56/f57 语义随行情状态变化：
    //  - 收盘后完整数据：各行为分钟量，但末行+中间部分行是"全天/时段累计快照"（单行额 ≥ 全天 20%，如 QQQ 11:31 单分钟 24.7亿=全天 74.7%）→ 需削峰
    //  - 盘中实时数据（未收盘）：每行都是正常分钟量，末行非累计 → 不能拿末行当基准，否则所有行都会被误判削掉
    // 判定「是否已收盘完整」：末行 f56 突变 ≥ 前一行 3 倍（累计值特征）；盘中末行是普通分钟量（同量级）
    const lastVolRaw = Number(rows[rows.length - 1].split(',')[5]) || 0;
    const prevVolRaw = Number(rows[rows.length - 2].split(',')[5]) || 0;
    const fullDay = lastVolRaw > prevVolRaw * 3;
    const dayTotal = fullDay ? (Number(rows[rows.length - 1].split(',')[6]) || 0) : 0;
    const anomalyTh = (fullDay && dayTotal > 0) ? dayTotal * 0.2 : Infinity; // 盘中/无累计基准 → 不削峰
    rows.forEach((r, i) => {
      const p = String(r).split(',');
      const bj = String(p[0]); // "2026-08-31 21:30"（东财统一北京时间）
      if (!dateStr && bj.length >= 10) dateStr = bj.slice(5, 10); // MM-DD
      let t;
      if (isUS) {
        // 美东 = 北京 -12h（夏令时）：21:30→09:30、跨天 04:00→16:00
        let m = (Number(bj.slice(11, 13)) * 60 + Number(bj.slice(14, 16)) + 720) % 1440;
        t = String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0');
      } else {
        t = bj.slice(11, 13) + bj.slice(14, 16);
      }
      const close = Number(p[1]);
      const amt = Number(p[6]) || 0;
      const vol = (amt >= anomalyTh) ? 0 : (Number(p[5]) || 0); // 收盘完整数据才削累计快照，保留价格点
      out.push({ t, open: close, close, high: close, low: close, vol, avgPrice: Number(p[7]) || 0, cumAmt: amt });
    });
    out._date = dateStr;
    return out;
  } catch (e) { console.error('[fetchEmTrends] 异常', secid, e && e.message); return null; }
}

// 美股分时（新浪，2026-10-19 起为美股主源）：东财 trends2 对本机出口 RST 时的替代
// 接口固定回最近 5 个交易日、type=1 为 1 分钟粒度；d 是美东时间，a 是该分钟成交额（美元）→ 均价可用累计额/累计量精确算
// 注意：必须用 stock.finance.sina.com.cn 的 jsonp_v2；quotes.sina.cn 的 json_v2 会回 {"__ERROR":3,"Service not valid"}
const SINA_US_MIN = 'https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_US_MIN_=/US_MinKService.getMinK?symbol=%s&type=1';
async function fetchSinaUsMin(code) {
  const sym = String(code).replace(/^us/i, '').replace(/\.\w+$/, '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) return null;
  try {
    const resp = await fetch(SINA_US_MIN.replace('%s', encodeURIComponent(sym)), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(9000),
    });
    const txt = await resp.text();
    const si = txt.indexOf('(['), ei = txt.lastIndexOf('])');
    if (si < 0 || ei < si) return null;
    const rows = JSON.parse(txt.slice(si + 1, ei + 1));
    if (!Array.isArray(rows) || rows.length < 2) return null;
    // 只取最近一个交易日（接口给 5 日，画分时不能把历史日子接在同一根时间轴上）
    const lastDay = String(rows[rows.length - 1].d || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
    let cumVol = 0, cumAmt = 0;
    const out = [];
    for (const r of rows) {
      const ds = String(r.d || '');
      if (ds.slice(0, 10) !== lastDay) continue;
      const close = Number(r.c);
      if (!(close > 0)) continue;
      const vol = Number(r.v) || 0;
      cumVol += vol;
      cumAmt += Number(r.a) || 0;
      out.push({
        t: ds.slice(11, 13) + ds.slice(14, 16),   // 美东 HHMM，与东财分支同口径
        open: Number(r.o) || close, close,
        high: Number(r.h) || close, low: Number(r.l) || close,
        vol, cumVol, cumAmt,
        avgPrice: (cumVol > 0 && cumAmt > 0) ? cumAmt / cumVol : close,
      });
    }
    if (out.length < 2) return null;
    out._date = lastDay.slice(5);
    out._src = 'sina';          // 供页脚标注实际来源（stocks.js 按 klines._src 判断）
    return out;
  } catch (_) { return null; }
}

async function fetchStockMinuteKline(code, period = 'm1', limit = 400) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 400));
  const ckey = `minute:${code}:${period}:${lim}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  return coalesceRequest(ckey, async () => {
    const cachedAgain = cacheGet(ckey);
    if (cachedAgain) return cachedAgain;
  try {
    const url = STOCK_MINUTE.replace('%s', code).replace('%s', period).replace(/,320$/, ',' + lim);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    const j = await resp.json();
    const d = j?.data?.[code];
    const raw = d?.[period] || [];
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const out = raw.map(r => ({
      t: r[0], open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), vol: Number(r[5]),
    })).filter(k => isFinite(k.close) && k.close > 0);
    if (out.length < 2) return null;
    cacheSet(ckey, out, 5000);
    return out;
  } catch (_) { return null; }
  });
}
async function fetchStockQuote(code) {
  const ckey = 'quote:' + code;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  return coalesceRequest(ckey, async () => {
    const cachedAgain = cacheGet(ckey);
    if (cachedAgain) return cachedAgain;
    try {
    if (code.startsWith('hf_')) {
      const resp = await fetch('https://hq.sinajs.cn/list=' + encodeURIComponent(code), {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(6000),
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const text = new TextDecoder('gbk').decode(buf);
      const m = text.match(/hq_str_[\w.]+="([^"]+)"/);
      if (!m) return null;
      const f = m[1].split(',');
      const price = Number(f[0]);
      const prevClose = Number(f[7]);
      const chg = (price > 0 && prevClose > 0) ? price - prevClose : 0;
      const result = {
        name: normStockName(f[13]) || code, isIndex: false, price, prevClose, open: Number(f[8]), high: Number(f[4]), low: Number(f[5]),
        chg, chgPct: prevClose > 0 ? chg / prevClose * 100 : 0,
        time: f[6] || '', date: f[12] || '', market: 'hf',
        amount: 0, turnover: 0, volumeRatio: 0, amplitude: 0,
        peDyn: 0, peTtm: 0, peStatic: 0, pb: 0, eps: 0, bvps: 0,
        totalShares: 0, floatShares: 0, mktCap: 0, floatMktCap: 0, divYield: 0,
      };
      cacheSet(ckey, result, 5000);
      return result;
    }
    // A股/港股/美股/指数：~ 分隔；美股快照必须用无后缀代码（usAAPL，带 .OQ 会 none_match）
    const reqCode = code.startsWith('us') ? code.replace(/\.\w+$/, '') : code;
    const resp = await fetch(STOCK_QUOTE.replace('%s', reqCode), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const m = text.match(/v_[\w.]+="([^"]+)"/);
    if (!m) return null;
    const a = m[1].split('~');
    const isUS = code.startsWith('us');
    const isIndex = a.indexOf('ZS') > 0; // 腾讯证券类型：ZS=指数（名称如"上证50/沪深300"不含"指数"二字，须靠此标识）
    const price = Number(a[3]);
    const peDyn = isUS ? 0 : Number(a[52]), peTtm = Number(a[39]), peStatic = isUS ? 0 : Number(a[53]);
    const pb = isUS ? 0 : Number(a[46]); // 美股 a[46] 是公司英文名，无 PB
    const result = {
      name: normStockName(a[1]), isIndex, price, prevClose: Number(a[4]), open: Number(a[5]),
      chg: Number(a[31]), chgPct: Number(a[32]), high: Number(a[33]), low: Number(a[34]),
      currency: a[35] || '',            // USD / HKD / CNY
      time: a[30] || '',                // 行情时间戳（美股为美东时间）
      market: isUS ? 'us' : (code.startsWith('hk') ? 'hk' : 'cn'),
      // 基本面（腾讯快照；ETF/指数这些字段通常为空或 0；美股 PE 在 a[39]，市值单位=亿美元）
      peDyn, peTtm, peStatic, pb,
      eps: isUS ? 0 : (peTtm > 0 ? price / peTtm : 0),      // 每股收益 ≈ 现价/PE(TTM)
      bvps: isUS ? 0 : (pb > 0 ? price / pb : 0),           // 每股净资产 ≈ 现价/市净率
      totalShares: isUS ? 0 : (Number(a[73]) || 0),         // 总股本（股）
      floatShares: isUS ? 0 : (Number(a[72]) || 0),         // 流通股本（股）
      mktCap: Number(a[45]) || 0,              // 总市值（A股=亿人民币，美股=亿美元）
      floatMktCap: Number(a[44]) || 0,         // 流通市值（同上）
      divYield: isUS ? 0 : (Number(a[64]) || 0),            // 股息率(TTM)（%）
      turnover: Number(a[38]) || 0,            // 换手率（%）
      volumeRatio: Number(a[49]) || 0,         // 量比
      amplitude: Number(a[43]) || 0,           // 振幅（%）
      avgPrice: Number(a[51]) || 0,            // 均价
      high: Number(a[33]) || 0, low: Number(a[34]) || 0,  // 今日最高/最低
      limitUp: Number(a[47]) || 0,             // 涨停价
      limitDown: Number(a[48]) || 0,           // 跌停价
      amount: Number(a[37]) || 0,              // 成交额（A股=万，港股=元，美股=美元）
    };
    cacheSet(ckey, result, 5000);
    return result;
  } catch (_) { return null; }
  });
}

// 东财个股行业与行业板块强弱：两者使用同一口径，避免把 F10 行业和申万排行硬拼。
const EM_STOCK_INDUSTRY = 'https://push2.eastmoney.com/api/qt/stock/get?secid=%s&fields=f58,f127';
const EM_INDUSTRY_BOARDS = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3';
const EM_INDUSTRY_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.%s&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&fqt=1&lmt=320&end=20500101&klt=101';
async function fetchEmStockIndustry(code) {
  if (!/^(sh|sz|bj)\d{6}$/i.test(String(code || ''))) return null;
  const key = 'em-industry:' + code;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const j = await emFetchJson(EM_STOCK_INDUSTRY.replace('%s', emSecid(code)));
  const name = String(j?.data?.f127 || '').trim();
  const result = name ? { name } : null;
  cacheSet(key, result, 10 * 60 * 1000);
  return result;
}
async function fetchEmIndustryKline(code) {
  if (!/^BK\d+$/i.test(String(code || ''))) return null;
  const key = 'em-industry-kline:' + code;
  const cached = cacheGet(key);
  if (cached) return cached;
  const j = await emFetchJson(EM_INDUSTRY_KLINE.replace('%s', code));
  const rows = (j?.data?.klines || []).map(row => {
    const p = String(row).split(',');
    return { t: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), vol: Number(p[5]) };
  }).filter(k => k.t && k.close > 0);
  if (rows.length < 70) return null;
  cacheSet(key, rows, 5 * 60 * 1000);
  return rows;
}
async function fetchEmIndustryBoards() {
  const key = 'em-industry-boards';
  const cached = cacheGet(key);
  if (cached) return cached;
  const j = await emFetchJson(EM_INDUSTRY_BOARDS);
  const list = (j?.data?.diff || []).map(row => ({
    code: String(row.f12 || ''), name: String(row.f14 || ''), chgPct: Number(row.f3),
  })).filter(row => row.code && row.name && Number.isFinite(row.chgPct));
  if (!list.length) return null;
  list.sort((a, b) => b.chgPct - a.chgPct);
  cacheSet(key, list, 30000);
  return list;
}
const EM_HOSTS = ['push2his.eastmoney.com', 'push2.eastmoney.com', 'push2delay.eastmoney.com'];
// 东财 UA（emFetchJson 及各东财接口共用）
const EM_UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Referer': 'https://www.eastmoney.com/' };
let _emHost = EM_HOSTS[0];
async function emFetchJson(url, timeout = 8000) {
  const hosts = [_emHost, ...EM_HOSTS.filter(h => h !== _emHost)];
  let lastErr;
  for (const h of hosts) {
    try {
      const u = new URL(url); u.host = h;
      const r = await fetch(u.href, { headers: EM_UA, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (h !== _emHost) { console.log('[em] 节点切换 ' + _emHost + ' -> ' + h); _emHost = h; }
      return j;
    } catch (e) { lastErr = e; }
  }
  console.error('[em] 全部节点失败', String(url).slice(0, 70), lastErr && lastErr.message);
  return null;
}

module.exports = {
  STOCK_QUOTE, STOCK_FQKLINE, STOCK_MINUTE, STOCK_TIMELINE, STOCK_SEARCH,
  STOCK_PERIODS, STOCK_PERIOD_LABEL, BARE_PERIOD, STOCK_LONG,
  normalizeCode, GLOBAL_ALIAS, GLOBAL_TEXT, EM_IDX_SECID, resolveStockCode,
  calcSMA, calcBOLL, buildAvgLine, fetchStockKline, fetchStockMinuteKline, fetchEmKline,
  HF_SINA_SYM, SINA_GLOBAL_MIN, fetchSinaGlobalMin, SINA_GLOBAL_DAILY, HF_DAILY_TTL,
  fetchSinaGlobalDaily, aggHfKline, fetchSinaGlobalKline, EM_TRENDS, emSecid, fetchEmTrends,
  SINA_US_MIN, fetchSinaUsMin,
  fetchYahooPremarket, getYahooPremarketStatus, fetchStockQuote, EM_STOCK_INDUSTRY, EM_INDUSTRY_BOARDS, EM_INDUSTRY_KLINE, fetchEmStockIndustry, fetchEmIndustryKline, fetchEmIndustryBoards, EM_HOSTS, EM_UA, _emHost, emFetchJson,
};
