// ============================================================
// /fc 国内期货 K线/分时图
// 用法：/fc [周期] <品种 或 合约>
//   周期：-t 分时 | m 1分钟 | 5m 5分钟 | 15m 15分钟 | 30m 30分钟 | 60m 60分钟
//         -d 日线（默认）| -w 周线 | -M 月线
//   合约：生猪2701（指定月份）/ lh2701 / TA601（郑商所 3 位月份自动补全）
//         不写月份 = 主力连续，如 生猪 → LH0
// 数据源：新浪内盘期货（快照 nf_ + InnerFuturesNewService 日/分钟/分时）
// 口径：期货涨跌以**昨结算价**为基准（与交易所涨跌停一致）；成交量/持仓量单位为手。
// ============================================================
const {
  FUT_PERIODS, FUT_PERIOD_LABEL, resolveFuturesInput, fetchFuturesQuote,
  fetchFuturesDaily, fetchFuturesKline, inferPricePrec, futuresVarietyText,
} = require('../futures');
const { aggHfKline } = require('../market');
const { renderStockPng, cmdStock } = require('./stock');

const FUT_USAGE_PERIOD = '-t 分时 | m 1分钟 | 5m 5分钟 | 15m 15分钟 | 30m 30分钟 | 60m 60分钟 | -d 日线（默认）| -w 周线 | -M 月线';
const GLOBAL_FUTURES = new Map([
  ['伦敦金', 'hf_XAU'], ['伦敦金现', 'hf_XAU'], ['现货黄金', 'hf_XAU'], ['xau', 'hf_XAU'], ['xauusd', 'hf_XAU'], ['xau/usd', 'hf_XAU'],
  ['纽约黄金', 'hf_GC'], ['comex黄金', 'hf_GC'], ['国际金', 'hf_GC'],
  ['纽约白银', 'hf_SI'], ['comex白银', 'hf_SI'],
  ['纽约原油', 'hf_CL'], ['美油', 'hf_CL'], ['wti', 'hf_CL'], ['wti原油', 'hf_CL'],
  ['布伦特原油', 'hf_OIL'], ['布油', 'hf_OIL'],
  ['美国天然气', 'hf_NG'],
  ['美铜', 'hf_HG'], ['comex铜', 'hf_HG'], ['伦铜', 'hf_CAD'],
  ['美豆', 'hf_S'], ['美国大豆', 'hf_S'],
  ['美豆粕', 'hf_SM'], ['美黄豆粉', 'hf_SM'],
  ['美豆油', 'hf_BO'], ['美黄豆油', 'hf_BO'],
  ['美玉米', 'hf_C'], ['美国玉米', 'hf_C'],
  ['美小麦', 'hf_W'], ['美国小麦', 'hf_W'],
]);
const GLOBAL_PERIOD_TOKEN = { time: '-t', day: '-d', week: '-w', month: '-M' };
const LONDON_SPOT = new Set(['伦敦银', '伦敦银现']);

function usageText() {
  return '📋 用法：/fc [周期] <品种 或 合约>\n' +
    `周期：${FUT_USAGE_PERIOD}\n` +
    '合约：生猪2701（指定月份）｜lh2701｜TA601（郑商所 3 位月份自动补全）\n' +
    '　　　不写月份＝主力连续，如 /fc 生猪 → LH0\n' +
    '例：/fc 生猪2701　/fc 螺纹钢　/fc 5m 沪金2612　/fc -t IF2612\n' +
    '国际：/fc -t 伦敦金　/fc -d COMEX黄金　/fc -w 布伦特原油（仅分时/日/周/月）\n' +
    '伦敦金为 XAU/USD 现货原始美元/盎司点位，不换汇、不折算沪金\n' +
    '\n支持品种（名称或代码均可）：\n' + futuresVarietyText();
}

// 周期查表：先按原样匹（区分 -M 月线 / -m 1分钟），再兑小写别名（日线 / -D / 5M / time）
function periodOf(token) {
  const t = String(token);
  return FUT_PERIODS[t] || FUT_PERIODS[t.toLowerCase()];
}

// 解析「周期 + 合约」：`-x` 形式可在任意位置；无 `-` 前缀的周期只在存在其它词时从首/尾识别，
// 避免把「T（10年期国债）」的合约代码当成周期 t
function parseArgs(parts) {
  const rest = [...parts];
  const take = i => { const p = periodOf(rest[i]); rest.splice(i, 1); return p; };
  for (let i = 0; i < rest.length; i++) {
    if (String(rest[i]).startsWith('-') && periodOf(rest[i])) return { period: take(i), contract: rest.join(' ') };
  }
  if (rest.length > 1) {
    for (const i of [0, rest.length - 1]) {
      if (periodOf(rest[i])) return { period: take(i), contract: rest.join(' ') };
    }
  }
  return { period: 'day', contract: rest.join(' ') };
}

// 新浪日K不含「当日未收盘」那根 → 用快照补上，否则日线图会停在昨天
function appendTodayBar(daily, q) {
  if (!q || !/^\d{4}-\d{2}-\d{2}$/.test(q.date || '') || !(q.price > 0)) return daily;
  const last = daily[daily.length - 1];
  if (!last || q.date <= last.t) return daily; // 已收盘/非交易日：快照日期与末根相同，无需补
  const k = {
    t: q.date,
    open: q.open > 0 ? q.open : q.price,
    high: q.high > 0 ? q.high : q.price,
    low: q.low > 0 ? q.low : q.price,
    close: q.price,
    vol: q.volume || 0, oi: q.openInterest || 0, settle: 0, partial: true,
  };
  // 补的这根来自快照，个别品种快照高低可能缺失，保证 high/low 包住 open/close
  k.high = Math.max(k.high, k.open, k.close);
  k.low = Math.min(k.low, k.open, k.close);
  return daily.concat([k]);
}

function quoteText(displayName, symbol, q) {
  const prec = inferPricePrec([{ open: q.open, high: q.high, low: q.low, close: q.price }]);
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-';
  const arrow = q.chg >= 0 ? '🔺' : '🔻';
  const L = [];
  L.push(`📈 ${displayName}（${symbol}）`);
  L.push(`现价 ${fp(q.price)}  ${arrow} ${q.chg >= 0 ? '+' : ''}${fp(q.chg)} (${q.chgPct >= 0 ? '+' : ''}${q.chgPct.toFixed(2)}%)`);
  L.push(`今开 ${fp(q.open)}  最高 ${fp(q.high)}  最低 ${fp(q.low)}  昨结 ${fp(q.preSettle)}`);
  L.push(`持仓 ${Number(q.openInterest) || 0} 手  成交 ${Number(q.volume) || 0} 手`);
  if (q.date) L.push(`更新 ${q.date} ${q.time || ''}（北京时间）`);
  return L.join('\n');
}

// 命令入口：返回 { ok, text?, img? }
async function cmdFc(args) {
  const parts = (args || []).map(a => String(a).trim()).filter(Boolean);
  // 形如 -x 但不在周期表 → 直接提示，避免被当成合约名去搜
  const badPeriod = parts.find(p => p.startsWith('-') && !periodOf(p));
  if (badPeriod) return { ok: false, text: `⚠️ 未知周期「${badPeriod}」\n\n${usageText()}` };

  const { period, contract } = parseArgs(parts);
  if (!contract) return { ok: false, text: usageText() };
  if (contract.startsWith('-')) return { ok: false, text: usageText() };

  const resolved = resolveFuturesInput(contract);
  if (!resolved) {
    const globalKey = contract.toLowerCase().replace(/\s+/g, '');
    if (LONDON_SPOT.has(globalKey)) {
      return {
        ok: false,
        text: `⚠️ ${contract}通常指场外现货白银（XAG/USD），当前暂未接入。\n` +
          '如需国际白银期货，请使用 /fc COMEX白银；国内期货使用 /fc 白银',
      };
    }
    const globalCode = GLOBAL_FUTURES.get(globalKey);
    if (globalCode) {
      const token = GLOBAL_PERIOD_TOKEN[period];
      if (!token) {
        return {
          ok: false,
          text: `⚠️ 该国际行情暂不支持${FUT_PERIOD_LABEL[period] || period}线（新浪全球行情源仅提供分时和日线）\n` +
            `可用：/fc -t ${contract}　/fc -d ${contract}　/fc -w ${contract}　/fc -M ${contract}`,
        };
      }
      return cmdStock([token, globalCode]);
    }
    return { ok: false, text: `⚠️ 未识别的期货品种/合约「${contract}」\n可填国内品种/合约，或明确的国际期货名，如 COMEX黄金 / WTI / 布伦特原油 / 美豆\n\n${usageText()}` };
  }
  const { symbol, isMain, variety } = resolved;
  const label = FUT_PERIOD_LABEL[period] || period;
  const needDaily = period === 'day' || period === 'week' || period === 'month';

  const [quote, raw] = await Promise.all([
    fetchFuturesQuote(symbol),
    needDaily ? fetchFuturesDaily(symbol) : fetchFuturesKline(symbol, period),
  ]);

  const name = quote?.name || resolved.displayName;
  if (!raw && !quote) {
    const hint = isMain ? '' : `该合约可能已到期，试试主力连续：/fc ${variety.name}\n`;
    return { ok: false, text: `⚠️ 未取到「${resolved.displayName}」（${symbol}）行情数据\n${hint}`.trimEnd() };
  }
  // 只有快照、没有K线（数据源缺该周期/合约）→ 文本速查
  if (!raw || raw.length < 2) {
    if (!quote) return { ok: false, text: `⚠️ 未取到「${resolved.displayName}」（${symbol}）${label}数据` };
    return { ok: true, text: quoteText(name, symbol, quote) + `\n⚠️ 暂无${label}数据，以上为最新行情速查` };
  }

  let klines = raw;
  if (needDaily) {
    const withToday = appendTodayBar(raw, quote);
    klines = period === 'day' ? withToday : aggHfKline(withToday, period);
  }
  if (!klines || klines.length < 2) return { ok: false, text: `⚠️ 「${resolved.displayName}」${label}数据不足，暂无法出图` };

  const prec = inferPricePrec(klines);
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-';
  const isTime = period === 'time';
  const isLong = needDaily;
  const periodLabel = label + (isTime && klines._date ? ' ' + klines._date : '');

  const img = renderStockPng(symbol, name, periodLabel, klines, {
    maPeriods: isLong ? [5, 10, 20] : [],
    boll: !isTime,
    timeMode: isTime,
    prec,
    futures: true,
  }, quote);
  if (!img) return { ok: false, text: '⚠️ 图表渲染失败（服务端缺少字体/渲染库）' };

  const L = [];
  let notice = '';
  if (isMain) notice = `ℹ️ 未指定合约，已用主力连续 ${symbol}（可加月份，如 ${variety.name}2701）\n`;
  L.push(`${notice}📈 ${name}（${symbol}）${periodLabel}`);
  if (quote) {
    L.push(`现价 ${fp(quote.price)}  ${quote.chg >= 0 ? '+' : ''}${fp(quote.chg)} (${quote.chgPct >= 0 ? '+' : ''}${quote.chgPct.toFixed(2)}%)`);
    L.push(`持仓 ${Number(quote.openInterest) || 0} 手  成交 ${Number(quote.volume) || 0} 手  昨结 ${fp(quote.preSettle)}`);
  } else {
    const last = klines[klines.length - 1];
    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(last.t)) ? `（${last.t}）` : '';
    L.push(`最新 ${fp(last.close)}${when}`);
    L.push('⚠️ 未取到实时快照，该合约可能已到期，以上为历史数据');
  }
  return { ok: true, text: L.join('\n'), img };
}

module.exports = { cmdFc, usageText, periodOf, parseArgs, appendTodayBar };
