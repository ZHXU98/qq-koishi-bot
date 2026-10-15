// ============================================================
// /fx 外汇 K线 / 最近24小时分时图
// 用法：/fx [-t|-d|-w|-m] <货币对或中文名>
// 数据源：新浪外汇（大陆直连）；外汇为 24×5，周末显示最后交易时段
// ============================================================
const { resolveFxPair, fetchFxMinute, fetchFxDaily, fetchFxQuote, fxPairText } = require('../forex');
const { aggHfKline } = require('../market');
const { renderStockPng } = require('./stock');

const FX_PERIODS = {
  '-t': 'time', 't': 'time', 'time': 'time', '分时': 'time', '24h': 'time',
  '-d': 'day', 'd': 'day', 'day': 'day', '日': 'day', '日线': 'day',
  '-w': 'week', 'w': 'week', 'week': 'week', '周': 'week', '周线': 'week',
  '-m': 'month', 'm': 'month', '-M': 'month', 'M': 'month', 'month': 'month', '月': 'month', '月线': 'month',
};
const FX_LABELS = { time: '最近24小时', day: '日线', week: '周线', month: '月线' };

function usageText() {
  return '📋 用法：/fx [周期] <货币对或名称>\n' +
    '周期：-t 最近24小时（默认）｜-d 日线｜-w 周线｜-m 月线\n' +
    '例：/fx USD/CNH　/fx -d EUR/USD　/fx -w 英镑美元　/fx -m 美元日元\n' +
    '支持：' + fxPairText();
}

function periodOf(token) {
  const t = String(token || '');
  return FX_PERIODS[t] || FX_PERIODS[t.toLowerCase()];
}

function parseArgs(parts) {
  const rest = [...parts];
  for (let i = 0; i < rest.length; i++) {
    const p = periodOf(rest[i]);
    if (p && (String(rest[i]).startsWith('-') || rest.length > 1)) {
      rest.splice(i, 1);
      return { period: p, query: rest.join(' ') };
    }
  }
  return { period: 'time', query: rest.join(' ') };
}

function weekendNotice(rows) {
  const last = rows?.[rows.length - 1];
  if (!last) return '';
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return '（周末休市，显示最后交易时段）';
  return '';
}

function appendCurrentBar(daily, quote) {
  if (!quote || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date || '') || !(quote.price > 0)) return daily;
  const last = daily[daily.length - 1];
  if (!last || quote.date <= last.t) return daily;
  const open = quote.open > 0 ? quote.open : quote.price;
  const bar = {
    t: quote.date,
    open,
    high: Math.max(quote.high || quote.price, open, quote.price),
    low: Math.min(quote.low || quote.price, open, quote.price),
    close: quote.price,
    vol: 0,
    partial: true,
  };
  return daily.concat([bar]);
}

async function cmdFx(args) {
  const parts = (args || []).map(x => String(x).trim()).filter(Boolean);
  const badPeriod = parts.find(x => x.startsWith('-') && !periodOf(x));
  if (badPeriod) return { ok: false, text: `⚠️ 未知周期「${badPeriod}」\n\n${usageText()}` };

  const { period, query } = parseArgs(parts);
  if (!query) return { ok: false, text: usageText() };
  const info = resolveFxPair(query);
  if (!info) return { ok: false, text: `⚠️ 未识别的外汇货币对「${query}」\n\n${usageText()}` };

  const isTime = period === 'time';
  const [raw, quote] = await Promise.all([
    isTime ? fetchFxMinute(info) : fetchFxDaily(info),
    fetchFxQuote(info),
  ]);
  if (!raw || raw.length < 2) return { ok: false, text: `⚠️ 未取到 ${info.pair} ${FX_LABELS[period]}数据，请稍后重试` };

  const dailyWithCurrent = isTime ? raw : appendCurrentBar(raw, quote);
  const klines = period === 'week' || period === 'month' ? aggHfKline(dailyWithCurrent, period) : dailyWithCurrent;
  if (!klines || klines.length < 2) return { ok: false, text: `⚠️ ${info.pair} ${FX_LABELS[period]}数据不足，暂无法出图` };

  if (isTime && Number(raw._prevClose) > 0) raw._prevClose = Number(raw._prevClose);
  const range = isTime && raw._date ? ` ${raw._date}` : '';
  const periodLabel = `${FX_LABELS[period]}${range}${isTime ? weekendNotice(raw) : ''}`;
  const effectiveQuote = quote || {
    price: klines[klines.length - 1].close,
    prevClose: isTime ? Number(raw._prevClose) || klines[0].close : klines[klines.length - 2].close,
    open: klines[0].open,
    high: Math.max(...klines.map(k => k.high)), low: Math.min(...klines.map(k => k.low)),
  };
  if (isTime && !quote && Number(raw._prevClose) > 0) effectiveQuote.prevClose = Number(raw._prevClose);

  const img = renderStockPng(`fx_${info.pair}`, info.name, periodLabel, klines, {
    maPeriods: isTime ? [] : [5, 10, 20],
    boll: !isTime,
    timeMode: isTime,
    prec: info.prec,
    continuous: true,
    noVolume: true,
  }, effectiveQuote);
  if (!img) return { ok: false, text: '⚠️ 外汇图表渲染失败（服务端缺少字体/渲染库）' };

  return { ok: true, img, text: `💱 ${info.name}（${info.pair}）${periodLabel}` };
}

module.exports = { FX_PERIODS, FX_LABELS, usageText, periodOf, parseArgs, appendCurrentBar, cmdFx };
