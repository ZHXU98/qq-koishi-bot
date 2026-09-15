// ============================================================
// 快讯：同花顺重要资讯拉取 / 每日汇总推送
// ============================================================
const { sleep } = require('../utils');
const { napcat, sendReply } = require('../gateway');
const { CONFIG } = require('../config');
const { renderCard, loadNewsRules, classifyNews } = require('../../ths-news/fetch_ths_news');

// ---------- 快讯查询（同花顺官方「重要」资讯，2026-08-26 从网关迁入，qq-reply 为统一命令中心） ----------
const THS_URL = 'https://news.10jqka.com.cn/tapp/news/push/stock/?page=%s&tag=&pageSize=50';
const NEWS_MAX_PAGES = Number(process.env.NEWS_MAX_PAGES || 3);
const NEWS_QUERY_LIMIT = Number(process.env.NEWS_QUERY_LIMIT || 10); // 查询返回条数
const DAILY_PUSH_HOUR = Number(process.env.DAILY_PUSH_HOUR || 21);
const DAILY_PUSH_MIN = Number(process.env.DAILY_PUSH_MIN || 30);
// 每日汇总推送总开关（2026-08-31 用户取消 21:30 汇总推送，默认关闭；
// 需恢复时在 docker-compose 设 DAILY_PUSH_ENABLED=true 即可，无需改代码）
const DAILY_PUSH_ENABLED = (process.env.DAILY_PUSH_ENABLED || 'false') === 'true';
const OWNER_QQ_FOR_WAKEUP = '1547450303'; // 每日汇总发送对象（网关 /send_wakeup 按 QQ 号映射 owner openid）

async function fetchImportantNewsData(limit = NEWS_QUERY_LIMIT) {
  try {
    const selected = [];
    const seen = new Set();
    const maxPages = Math.max(1, NEWS_MAX_PAGES);
    for (let page = 1; page <= maxPages && selected.length < limit; page++) {
      const resp = await fetch(THS_URL.replace('%s', page), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      });
      const j = await resp.json();
      const list = j.data?.list || [];
      for (const it of list) {
        if (!(Number(it.import) > 0)) continue; // 同花顺官方「重要」标记
        const key = String(it.id || `${it.ctime}:${it.title}`);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push({
          title: String(it.title || ''),
          desc: String(it.digest || it.short || ''),
          time: Number(it.ctime) * 1000,
          link: it.url || '',
          tag: it.tag || '',
          import: it.import,
        });
        if (selected.length >= limit) break;
      }
      if (!list.length) break;
    }
    return selected;
  } catch (e) {
    console.error('[news] 快讯抓取失败:', e.message);
    return [];
  }
}

async function fetchImportantNews(limit = NEWS_QUERY_LIMIT) {
  const selected = await fetchImportantNewsData(limit);
  return selected.map((it, i) => {
    const t = new Date(it.time);
    const p = (n) => String(n).padStart(2, '0');
    return `${i + 1}. [${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}] ${it.title}`;
  });
}

// 被动 /快讯：固定最近 10 条同花顺重要资讯，一次生成一张长图；不沿用主动推送的 8 条拆图规则。
async function cmdNews() {
  const items = await fetchImportantNewsData(NEWS_QUERY_LIMIT);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const tag = `📌 最新重要资讯（${now}）`;
  if (!items.length) return { ok: false, text: formatNewsReply([], tag) };
  try {
    loadNewsRules();
    const classified = items.map(it => ({ ...it, ...classifyNews(it) }));
    const dateStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const png = renderCard(dateStr, classified);
    if (!png) throw new Error('未生成图片');
    return { ok: true, img: 'base64://' + png.toString('base64'), text: tag };
  } catch (e) {
    console.error('[news] 快讯卡片渲染失败，回退文本:', e.message);
    return { ok: false, text: formatNewsReply(await fetchImportantNews(NEWS_QUERY_LIMIT), tag) };
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

module.exports = { THS_URL, NEWS_MAX_PAGES, NEWS_QUERY_LIMIT, DAILY_PUSH_HOUR, DAILY_PUSH_MIN, DAILY_PUSH_ENABLED, OWNER_QQ_FOR_WAKEUP, fetchImportantNewsData, fetchImportantNews, cmdNews, formatNewsReply, sendDailySummary };
