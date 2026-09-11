// ============================================================
// 快讯：同花顺重要资讯拉取 / 每日汇总推送
// ============================================================
const { sleep } = require('../utils');
const { napcat, sendReply } = require('../gateway');
const { CONFIG } = require('../config');

// ---------- 快讯查询（同花顺官方「重要」资讯，2026-08-26 从网关迁入，qq-reply 为统一命令中心） ----------
const THS_URL = 'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&pageSize=50';
const NEWS_QUERY_LIMIT = Number(process.env.NEWS_QUERY_LIMIT || 10); // 查询返回条数
const DAILY_PUSH_HOUR = Number(process.env.DAILY_PUSH_HOUR || 21);
const DAILY_PUSH_MIN = Number(process.env.DAILY_PUSH_MIN || 30);
// 每日汇总推送总开关（2026-08-31 用户取消 21:30 汇总推送，默认关闭；
// 需恢复时在 docker-compose 设 DAILY_PUSH_ENABLED=true 即可，无需改代码）
const DAILY_PUSH_ENABLED = (process.env.DAILY_PUSH_ENABLED || 'false') === 'true';
const OWNER_QQ_FOR_WAKEUP = '1547450303'; // 每日汇总发送对象（网关 /send_wakeup 按 QQ 号映射 owner openid）

async function fetchImportantNews(limit = NEWS_QUERY_LIMIT) {
  try {
    const resp = await fetch(THS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    const j = await resp.json();
    return (j.data?.list || [])
      .filter((it) => Number(it.import) > 0) // 同花顺官方「重要」标记
      .slice(0, limit)
      .map((it, i) => {
        const t = new Date(Number(it.ctime) * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return `${i + 1}. [${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}] ${it.title}`;
      });
  } catch (e) {
    console.error('[news] 快讯抓取失败:', e.message);
    return [];
  }
}
function formatNewsReply(items, tag) {
  if (!items.length) return `${tag}：当前暂无重要资讯（非交易时段或同花顺无「重要」标记）。`;
  return `${tag}\n${items.join('\n')}`;
}
// 每日汇总（召回消息 is_wakeup，走网关 /send_wakeup，不占私聊主动配额；需当天有互动）
async function sendDailySummary() {
  const items = await fetchImportantNews(10);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const r = await napcat('/send_wakeup', { user_id: OWNER_QQ_FOR_WAKEUP, message: formatNewsReply(items, `📌 今日重要资讯汇总（${today}）`) }, { retry: false });
    console.log(`[news] 每日汇总发送结果: ${r ? 'ok' : 'failed'}`);
  } catch (e) {
    console.error('[news] 每日汇总发送失败（可能当日无互动或超配额）:', e.message);
  }
}

module.exports = { THS_URL, NEWS_QUERY_LIMIT, DAILY_PUSH_HOUR, DAILY_PUSH_MIN, DAILY_PUSH_ENABLED, OWNER_QQ_FOR_WAKEUP, fetchImportantNews, formatNewsReply, sendDailySummary };
