// ============================================================
// 国内期货数据层：品种表 / 合约解析 / 行情快照 / K线（日/分钟/分时）
// 数据源：新浪内盘期货
//   快照    https://hq.sinajs.cn/list=nf_<SYMBOL>            （GBK，必须带 Referer）
//   日K     InnerFuturesNewService.getDailyKLine?symbol=     （商品/中金所通用）
//   分钟K   InnerFuturesNewService.getFewMinLine?symbol=&type=（1/5/15/30/60）
//   分时    InnerFuturesNewService.getMinLine?symbol=
// 覆盖：上期所 SHFE / 大商所 DCE / 郑商所 CZCE / 上期能源 INE / 广期所 GFEX / 中金所 CFFEX
//
// 约定：价格单位=元（国债期货=百元净价、股指=点）；成交量=手；持仓量=手。
// 合约代码：<品种代码><YYMM>，如 LH2701（生猪 2027-01）；郑商所原生 3 位月份（TA701）自动补全。
// 主力连续：<品种代码>0，如 LH0。
// 涨跌口径：期货统一以**昨结算价**为基准（与交易所涨跌停一致），非股票式昨收。
// ============================================================
const { cacheGet, cacheSet, coalesceRequest } = require('./utils');
const { aggHfKline } = require('./market');

const FUT_HQ = 'https://hq.sinajs.cn/list=nf_%s';
const FUT_DAILY = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_fut=/InnerFuturesNewService.getDailyKLine?symbol=%s';
const FUT_MIN = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_fut=/InnerFuturesNewService.getFewMinLine?symbol=%s&type=%s';
const FUT_TICK = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_fut=/InnerFuturesNewService.getMinLine?symbol=%s';
// 新浪内盘接口用 Referer 做来源校验（缺失时返回空串），UA 也一并带上
const FUT_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' };

const FUT_DAILY_TTL = 5 * 60 * 1000;   // 日K 只随收盘/结算变化
const FUT_MIN_TTL = 20 * 1000;         // 分钟K 盘中变化快
const FUT_TICK_TTL = 20 * 1000;
const FUT_QUOTE_TTL = 5000;

// ---------- 周期 ----------
// 分钟周期用 m1/m5/m15/m30/m60（m 后面的数字即新浪 type）；h 前缀为「小时数」（由 m60 聚合）
const FUT_PERIODS = {
  '-t': 'time', '-time': 'time', 't': 'time', 'time': 'time', '分时': 'time',
  '-d': 'day', 'd': 'day', 'day': 'day', '日': 'day', '日线': 'day', '日k': 'day', '1d': 'day',
  '-w': 'week', 'w': 'week', 'week': 'week', '周': 'week', '周线': 'week', '周k': 'week',
  '-M': 'month', 'M': 'month', 'month': 'month', '月': 'month', '月线': 'month', '月k': 'month', 'mon': 'month',
  'm': 'm1', '-m': 'm1', '1m': 'm1', '-1m': 'm1', '1分': 'm1', '1分钟': 'm1',
  '5m': 'm5', '-5m': 'm5', '5分': 'm5', '5分钟': 'm5',
  '15m': 'm15', '-15m': 'm15', '15分': 'm15', '15分钟': 'm15',
  '30m': 'm30', '-30m': 'm30', '30分': 'm30', '30分钟': 'm30',
  '60m': 'm60', '-60m': 'm60', '1h': 'm60', '-1h': 'm60', 'h': 'm60', '60分': 'm60', '60分钟': 'm60',
};
const FUT_PERIOD_LABEL = {
  time: '分时', day: '日线', week: '周线', month: '月线',
  m1: '1分钟', m5: '5分钟', m15: '15分钟', m30: '30分钟', m60: '60分钟',
  h2: '2小时', h3: '3小时', h4: '4小时', h6: '6小时',
};

// ---------- 品种表 ----------
// [品种代码, 显示名, 交易所, 别名...]
// 别名用于中文/常用简称检索（不含月份），如「生猪」「螺纹钢」「PVC」；代码本身也可直接输入。
const FUT_EXCHANGE_NAME = { SHFE: '上期所', DCE: '大商所', CZCE: '郑商所', INE: '上期能源', GFEX: '广期所', CFFEX: '中金所' };
const FUT_VARIETY_LIST = [
  // —— 上期所 ——
  ['CU', '沪铜', 'SHFE', '铜', '铜期货'],
  ['AL', '沪铝', 'SHFE', '铝'],
  ['ZN', '沪锌', 'SHFE', '锌'],
  ['PB', '沪铅', 'SHFE', '铅'],
  ['NI', '沪镍', 'SHFE', '镍'],
  ['SN', '沪锡', 'SHFE', '锡'],
  ['AU', '沪金', 'SHFE', '黄金', '金'],
  ['AG', '沪银', 'SHFE', '白银', '银'],
  ['RB', '螺纹钢', 'SHFE', '螺纹'],
  ['WR', '线材', 'SHFE'],
  ['HC', '热轧卷板', 'SHFE', '热卷'],
  ['SS', '不锈钢', 'SHFE'],
  ['FU', '燃料油', 'SHFE'],
  ['BU', '石油沥青', 'SHFE', '沥青'],
  ['RU', '天然橡胶', 'SHFE', '橡胶', '沪胶'],
  ['SP', '纸浆', 'SHFE', '漂针浆'],
  ['AO', '氧化铝', 'SHFE'],
  ['BR', '丁二烯橡胶', 'SHFE', '顺丁橡胶'],
  ['AD', '铸造铝合金', 'SHFE', '铝合金'],
  // —— 上期能源 ——
  ['SC', '原油', 'INE', '上海原油', 'sc原油'],
  ['NR', '20号胶', 'INE'],
  ['LU', '低硫燃料油', 'INE', '低硫燃油'],
  ['BC', '国际铜', 'INE', '国际铜'],
  ['EC', '集运指数(欧线)', 'INE', '集运指数', '欧线集运', '集运'],
  // —— 大商所 ——
  ['A', '豆一', 'DCE', '黄豆一号'],
  ['B', '豆二', 'DCE', '黄豆二号'],
  ['M', '豆粕', 'DCE', '豆粉'],
  ['Y', '豆油', 'DCE'],
  ['P', '棕榈油', 'DCE', '棕油'],
  ['C', '玉米', 'DCE'],
  ['CS', '玉米淀粉', 'DCE', '淀粉'],
  ['JD', '鸡蛋', 'DCE'],
  ['LH', '生猪', 'DCE'],
  ['FB', '纤维板', 'DCE'],
  ['BB', '胶合板', 'DCE'],
  ['L', '聚乙烯', 'DCE', '塑料', 'lldpe'],
  ['V', '聚氯乙烯', 'DCE', 'PVC', 'pvc'],
  ['PP', '聚丙烯', 'DCE'],
  ['EG', '乙二醇', 'DCE'],
  ['EB', '苯乙烯', 'DCE'],
  ['PG', '液化石油气', 'DCE', 'LPG', '液化气'],
  ['J', '焦炭', 'DCE'],
  ['JM', '焦煤', 'DCE'],
  ['I', '铁矿石', 'DCE', '铁矿'],
  ['RR', '粳米', 'DCE'],
  ['LG', '原木', 'DCE'],
  // —— 郑商所 ——
  ['SR', '白糖', 'CZCE', '糖'],
  ['CF', '棉花', 'CZCE', '郑棉'],
  ['CY', '棉纱', 'CZCE'],
  ['TA', 'PTA', 'CZCE', 'pta', '精对苯二甲酸'],
  ['MA', '甲醇', 'CZCE'],
  ['FG', '玻璃', 'CZCE'],
  ['SA', '纯碱', 'CZCE'],
  ['ZC', '动力煤', 'CZCE'],
  ['OI', '菜籽油', 'CZCE', '菜油'],
  ['RM', '菜籽粕', 'CZCE', '菜粕'],
  ['RI', '早籼稻', 'CZCE', '早稻'],
  ['WH', '强麦', 'CZCE'],
  ['PM', '普麦', 'CZCE'],
  ['RS', '油菜籽', 'CZCE', '菜籽'],
  ['AP', '苹果', 'CZCE'],
  ['CJ', '红枣', 'CZCE'],
  ['PK', '花生', 'CZCE'],
  ['SF', '硅铁', 'CZCE'],
  ['SM', '锰硅', 'CZCE'],
  ['UR', '尿素', 'CZCE'],
  ['PF', '短纤', 'CZCE', '涤纶短纤'],
  ['SH', '烧碱', 'CZCE', '液碱'],
  ['PX', '对二甲苯', 'CZCE'],
  ['PR', '瓶片', 'CZCE'],
  ['JR', '粳稻', 'CZCE'],
  ['LR', '晚籼稻', 'CZCE', '晚稻'],
  // —— 广期所 ——
  ['SI', '工业硅', 'GFEX'],
  ['LC', '碳酸锂', 'GFEX', '锂'],
  ['PS', '多晶硅', 'GFEX'],
  // —— 中金所 ——
  ['IF', '沪深300股指', 'CFFEX', '沪深300', '沪深300指数'],
  ['IH', '上证50股指', 'CFFEX', '上证50'],
  ['IC', '中证500股指', 'CFFEX', '中证500'],
  ['IM', '中证1000股指', 'CFFEX', '中证1000'],
  ['T', '10年期国债', 'CFFEX', '十年国债', '十债'],
  ['TF', '5年期国债', 'CFFEX', '五年国债', '五债'],
  ['TS', '2年期国债', 'CFFEX', '两年国债', '二债'],
  ['TL', '30年期国债', 'CFFEX', '三十年国债', '三十债'],
];

const FUT_BY_CODE = new Map();  // 'LH'   → variety
const FUT_BY_ALIAS = new Map(); // '生猪' / 'PVC' → variety
for (const [code, name, exchange, ...aliases] of FUT_VARIETY_LIST) {
  const v = { code, name, exchange, exchangeName: FUT_EXCHANGE_NAME[exchange] || exchange };
  FUT_BY_CODE.set(code, v);
  FUT_BY_ALIAS.set(name.toLowerCase(), v);
  for (const a of aliases) FUT_BY_ALIAS.set(String(a).toLowerCase(), v);
}

// ---------- 合约解析 ----------
// 郑商所原生月份是 3 位（年个位+两位月，如 701=2027-01）→ 补成 4 位 YYMM
function normMonthCode(digits) {
  const d = String(digits || '');
  if (/^\d{4}$/.test(d)) return d;
  if (/^\d{3}$/.test(d)) {
    const y = Number(d[0]), mm = d.slice(1);
    const curYY = new Date().getFullYear() % 100;
    let yy = Math.floor(curYY / 10) * 10 + y;
    if (yy < curYY - 1) yy += 10; // 已明显过期 → 视作下一个十年
    return String(yy).padStart(2, '0') + mm;
  }
  return '';
}

function buildContract(v, digits) {
  const d = String(digits || '').trim();
  if (!d || d === '0') {
    return {
      code: v.code, symbol: v.code + '0', month: '', isMain: true, variety: v,
      displayName: v.name + '主力',
    };
  }
  const month = normMonthCode(d);
  if (!month) return null;
  return {
    code: v.code, symbol: v.code + month, month, isMain: false, variety: v,
    displayName: v.name + month,
  };
}

// 输入 → 合约。支持：生猪2701 / 生猪 2701 / LH2701 / lh2701 / TA601 / 生猪 / 生猪主力 / LH / PVC
function resolveFuturesInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const up = raw.toUpperCase().replace(/\s+/g, '').replace(/[（(]/g, '').replace(/[）)]/g, '');
  // 1) 英文代码（或英文别名）+ 可选月份：LH2701 / TA601 / LH0 / IF2612
  let m = up.match(/^([A-Z]{1,4})(\d{0,4})$/);
  if (m) {
    const v = FUT_BY_CODE.get(m[1]) || FUT_BY_ALIAS.get(m[1].toLowerCase());
    if (v) return buildContract(v, m[2]);
  }
  // 2) 中文名 + 月份：生猪2701 / 20号胶2701
  m = raw.match(/^(.+?)\s*(\d{3,4})$/);
  if (m) {
    const v = FUT_BY_ALIAS.get(m[1].replace(/\s+/g, '').toLowerCase());
    if (v) return buildContract(v, m[2]);
  }
  // 3) 纯中文名（允许 主力/连续/主连/指数 后缀）：生猪 / 螺纹钢 / 生猪主力
  const nameOnly = up.replace(/(主力|连续|主连|指数)$/, '');
  const v = FUT_BY_ALIAS.get(nameOnly.toLowerCase());
  if (v) return buildContract(v, '');
  return null;
}

// ---------- 通用请求 ----------
// 新浪 JSONP：var _fut=([...]);  → 取 ([ 到 ]) 之间的 JSON
async function jsonpArray(url, timeout = 10000) {
  try {
    const resp = await fetch(url, { headers: FUT_HEADERS, signal: AbortSignal.timeout(timeout) });
    const text = await resp.text();
    const si = text.indexOf('([');
    const ei = text.lastIndexOf('])');
    if (si < 0 || ei < si) return null;
    const parsed = JSON.parse(text.slice(si + 1, ei + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

// ---------- 快照 ----------
// 新浪内盘快照有两种字段布局：
//  A. 商品期货（上期所/大商所/郑商所/上期能源/广期所）：以「合约名」开头
//     [0]名称 [1]时间HHMMSS [2]开 [3]高 [4]低 [5]昨收(常为0) [6]买价 [7]卖价 [8]最新
//     [9]今结算 [10]昨结算 [11]买量 [12]卖量 [13]持仓量 [14]成交量 [15]交易所 [16]品种 [17]日期
//  B. 中金所（IF/IH/IC/IM/T/TF/TS/TL）：以数值开头，名称在最后一位
//     [0]开 [1]高 [2]低 [3]最新 [4]成交量 [5]成交额 [6]持仓量 [9]涨停 [10]跌停
//     [13]昨收 [14]昨结算 [后面]日期/时间/均价/名称
function parseFuturesQuote(symbol, f) {
  if (!Array.isArray(f) || f.length < 6) return null;
  const num = v => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
  const numericFirst = /^[\d.\-]+$/.test(String(f[0] || '').trim()); // 数值开头 → 中金所布局
  const dateIdx = f.findIndex(v => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()));
  const date = dateIdx >= 0 ? String(f[dateIdx]).trim() : '';

  let name, time, open, high, low, price, preSettle, preClose, volume, oi, amount, avgPrice, limitUp, limitDown, varietyName;
  if (numericFirst) {
    name = String(f[f.length - 1] || '').trim();
    time = (dateIdx >= 0 && f[dateIdx + 1]) ? String(f[dateIdx + 1]).trim() : '';
    open = num(f[0]); high = num(f[1]); low = num(f[2]); price = num(f[3]);
    volume = num(f[4]); amount = num(f[5]); oi = num(f[6]);
    limitUp = num(f[9]); limitDown = num(f[10]);
    preClose = num(f[13]); preSettle = num(f[14]);
    avgPrice = num(f[f.length - 2]);
    varietyName = name;
  } else {
    name = String(f[0] || '').trim();
    const rawTime = String(f[1] || '').trim();
    time = rawTime.length === 6 ? `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:${rawTime.slice(4, 6)}` : rawTime;
    open = num(f[2]); high = num(f[3]); low = num(f[4]);
    price = num(f[8]); preSettle = num(f[10]);
    preClose = num(f[5]) || preSettle;   // 商品布局的「昨收」常年为 0 → 退回昨结算
    oi = num(f[13]); volume = num(f[14]);
    varietyName = String(f[16] || '').trim();
    avgPrice = num(f[28]);
  }
  if (!(price > 0)) return null; // 已到期/不存在的合约返回空串
  const base = preSettle > 0 ? preSettle : preClose;
  const chg = base > 0 ? price - base : 0;
  return {
    symbol, name: name || symbol, variety: varietyName || '', market: 'nf',
    isIndex: false, exchange: '', exchangeName: '',
    price, prevClose: base, preSettle: preSettle || base, preCloseRaw: preClose,
    open, high, low, chg, chgPct: base > 0 ? chg / base * 100 : 0,
    volume, openInterest: oi, amount, avgPrice, limitUp, limitDown,
    date, time,
    mktCap: 0, // 期货无市值 → 复用股票渲染器时自动隐藏基本面面板
  };
}

async function fetchFuturesQuote(symbol) {
  const key = 'futq:' + symbol;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  return coalesceRequest(key, async () => {
    const again = cacheGet(key);
    if (again !== undefined) return again;
    let out = null;
    try {
      const resp = await fetch(FUT_HQ.replace('%s', symbol), { headers: FUT_HEADERS, signal: AbortSignal.timeout(8000) });
      const buf = Buffer.from(await resp.arrayBuffer());
      const text = new TextDecoder('gbk').decode(buf);
      const m = text.match(/="([^"]*)"/);
      if (m && m[1]) out = parseFuturesQuote(symbol, m[1].split(','));
    } catch (_) { out = null; }
    // 空结果也短缓存：不存在的合约（已到期）不必每条消息都打上游
    cacheSet(key, out, out ? FUT_QUOTE_TTL : 60000);
    return out;
  });
}

// ---------- K线 ----------
// 日K：[{d,o,h,l,c,v,p,s}] → d=日期 o/h/l/c v=成交量(手) p=持仓量(手) s=结算价
// 注意：新浪日K**不含当日未收盘那根**，调用方需自行用快照补当日（见 commands/fc.js）
async function fetchFuturesDaily(symbol) {
  const key = 'futd:' + symbol;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    const again = cacheGet(key);
    if (again) return again;
    const arr = await jsonpArray(FUT_DAILY.replace('%s', symbol));
    if (!arr || arr.length < 2) return null;
    const rows = arr.map(r => ({
      t: String(r.d || '').slice(0, 10),
      open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
      vol: Number(r.v) || 0, oi: Number(r.p) || 0, settle: Number(r.s) || 0,
    })).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k.t) && k.open > 0 && k.close > 0 && k.high > 0 && k.low > 0);
    if (rows.length < 2) return null;
    cacheSet(key, rows, FUT_DAILY_TTL);
    return rows;
  });
}

// 分钟K：d 形如「2026-09-29 14:10:00」→ t 压缩成 12 位「202609291410」（与股票分钟K口径一致）
async function fetchFuturesMinutes(symbol, type) {
  const key = `futm:${symbol}:${type}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    const again = cacheGet(key);
    if (again) return again;
    const arr = await jsonpArray(FUT_MIN.replace('%s', symbol).replace('%s', type));
    if (!arr || arr.length < 2) return null;
    const rows = arr.map(r => {
      const t = String(r.d || '').replace(/\D/g, '').slice(0, 12);
      return { t, open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), vol: Number(r.v) || 0, oi: Number(r.p) || 0 };
    }).filter(k => /^\d{12}$/.test(k.t) && k.close > 0);
    if (rows.length < 2) return null;
    cacheSet(key, rows, FUT_MIN_TTL);
    return rows;
  });
}

// 分时：[[时间, 价, 均价, 分钟量, 持仓, 昨收, 日期], ...]（首行带「昨收/日期」，后续行压缩为 5 列）
async function fetchFuturesTick(symbol) {
  const key = 'futt:' + symbol;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesceRequest(key, async () => {
    const again = cacheGet(key);
    if (again) return again;
    const arr = await jsonpArray(FUT_TICK.replace('%s', symbol));
    if (!arr || arr.length < 2) return null;
    const rows = arr.map(r => {
      const price = Number(r[1]) || 0;
      return {
        t: String(r[0] || '').replace(':', ''), open: price, close: price, high: price, low: price,
        vol: Number(r[3]) || 0, oi: Number(r[4]) || 0, avgPrice: Number(r[2]) || 0,
      };
    }).filter(k => /^\d{4}$/.test(k.t) && k.close > 0);
    if (rows.length < 2) return null;
    const first = arr[0];
    if (first && first.length > 6 && /^\d{4}-\d{2}-\d{2}$/.test(String(first[6]))) rows._date = String(first[6]).slice(5);
    cacheSet(key, rows, FUT_TICK_TTL);
    return rows;
  });
}

// 分钟K → N 小时K（同一交易日内每 N 根合并一根；新浪无原生小时线，60 分钟线为交易所时段划分）
function aggMinuteKline(rows, barsPer) {
  const out = [];
  let day = '', bucket = null, count = 0;
  for (const k of rows) {
    const d = k.t.slice(0, 8);
    if (d !== day) { day = d; bucket = null; count = 0; }
    if (!bucket || count >= barsPer) {
      bucket = { t: k.t, open: k.open, high: k.high, low: k.low, close: k.close, vol: k.vol, oi: k.oi };
      out.push(bucket); count = 1;
    } else {
      if (k.high > bucket.high) bucket.high = k.high;
      if (k.low < bucket.low) bucket.low = k.low;
      bucket.close = k.close; bucket.vol += k.vol; bucket.oi = k.oi; count++;
    }
  }
  return out;
}

// 统一K线入口（周期见 FUT_PERIODS 的值）
async function fetchFuturesKline(symbol, period) {
  if (period === 'time') return fetchFuturesTick(symbol);
  if (period === 'day' || period === 'week' || period === 'month') {
    const daily = await fetchFuturesDaily(symbol);
    if (!daily || daily.length < 2) return null;
    if (period === 'week' || period === 'month') return aggHfKline(daily, period);
    return daily.slice(); // 复制：调用方可能追加「当日未收盘」那根，不能污染缓存
  }
  const mh = period.match(/^m(\d+)$/);
  if (mh) return fetchFuturesMinutes(symbol, Number(mh[1]));
  const hh = period.match(/^h(\d+)$/);
  if (hh) {
    const bars = Number(hh[1]); // 60 分钟线 1 根/小时
    const base = await fetchFuturesMinutes(symbol, 60);
    if (!base || base.length < 2) return null;
    const agg = aggMinuteKline(base, bars);
    return agg.length >= 2 ? agg : null;
  }
  return null;
}

// ---------- 展示辅助 ----------
// 期货价格精度由数据自身决定：生猪/螺纹钢等为整数，国债 3 位、黄金 2 位、股指 1 位
function inferPricePrec(klines) {
  let p = 0;
  for (const k of klines) {
    for (const v of [k.open, k.high, k.low, k.close]) {
      if (!isFinite(v)) continue;
      const s = String(v);
      const dot = s.indexOf('.');
      if (dot < 0 || /e/i.test(s)) continue;
      const dec = s.slice(dot + 1).replace(/0+$/, '').length;
      if (dec > p) p = dec;
      if (p >= 3) return 3;
    }
  }
  return p;
}

// 品种速查表（按交易所分组，用于 /fc 无参时的帮助文案）
function futuresVarietyText() {
  const groups = new Map();
  for (const v of FUT_BY_CODE.values()) {
    if (!groups.has(v.exchangeName)) groups.set(v.exchangeName, []);
    groups.get(v.exchangeName).push(`${v.name}${v.code}`);
  }
  return [...groups.entries()].map(([ex, items]) => `${ex}：${items.join(' ')}`).join('\n');
}

module.exports = {
  FUT_PERIODS, FUT_PERIOD_LABEL, FUT_EXCHANGE_NAME, FUT_VARIETY_LIST,
  FUT_BY_CODE, FUT_BY_ALIAS, normMonthCode, buildContract, resolveFuturesInput,
  fetchFuturesQuote, parseFuturesQuote,
  fetchFuturesDaily, fetchFuturesMinutes, fetchFuturesTick, fetchFuturesKline,
  aggMinuteKline, inferPricePrec, futuresVarietyText,
};
