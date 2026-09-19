// 同花顺重要金融资讯聚合转发脚本（图片卡片推送，可容器化运行）
//
// 数据来源：同花顺官方 7×24 财经直播接口
//   https://news.10jqka.com.cn/tapp/news/push/stock/
//   该接口每条资讯自带 `import` 字段：import=3（或 >0）即同花顺标记为「重要」，
//   等价于原 RSSHub 的「重要」订阅标签，且为同花顺自带的重要性判定，比关键词加权更准。
//
// 流程（分级聚合模式）：
//   1. 每 5 分钟（容器内 start_news_cron.sh 循环，NEWS_INTERVAL=300）拉取官方接口，仅保留 import>0（同花顺「重要」标记）的资讯
//   2. 关键词加权打分用于在「重要」内部再分档（同花顺只有 import>0 一档，细分靠关键词）
//   3. 命中必推关键词（URGENT_KEYWORDS）→ 极重要，立即推送
//   4. 其余重要资讯入 pending 缓冲，攒够 AGG_COUNT 条（默认 8）或到整点/半点（每 30 分钟）才推一批
//   5. 通过官方网关以图片卡片（SVG→PNG，resvg 渲染）推送到 ths_news_targets.json 配置的 QQ 私聊/群；渲染失败时自动回退纯文字
//     单张卡片最多承载 MAX_PUSH 条，超过则拆成多张卡片发出，保证不丢任何一条
//
// 用法：
//   node fetch_ths_news.js              # 正式模式（极重要立即推 + 其余聚合推）
//   node fetch_ths_news.js --dry-run    # 只打印筛选结果（标注分级），不推送
//   node fetch_ths_news.js --force      # 立即推送本轮候选（全部），用于测试
//
// 配置：RSS 资讯独立配置 ths_news_targets.json（private / groups / imageWidth / imageScale），
//       回退 push_targets.json；与复盘报告 push_report.js 的分发目标解耦。
// 环境变量：NAPCAT_URL（默认 http://127.0.0.1:3100，官方网关；容器内由 compose 注入
//           http://official-bot-gateway:3100）、NAPCAT_TOKEN、THS_CONFIG（配置路径）、
//           THS_STATE（状态文件路径，默认 /tmp/ths_news_state.json）。

const fs = require('fs');
const path = require('path');

const __DIR = __dirname;
const CONFIG_PATH = path.join(__DIR, 'push_targets.json');
const NEWS_TARGETS_PATH = process.env.THS_CONFIG || path.join(__DIR, 'ths_news_targets.json');
const RULES_PATH = process.env.THS_RULES || path.join(__DIR, 'news_rules.json');
const STATE_PATH = process.env.THS_STATE || '/tmp/ths_news_state.json';
const NAPCAT_URL = process.env.NAPCAT_URL || 'http://127.0.0.1:3100'; // 官方网关（变量名沿用历史命名）
const TOKEN = process.env.NAPCAT_TOKEN || '';
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force'); // 立即推送当前 Top，用于测试

const MAX_PUSH = 8;             // 单条消息最多承载条数（超过则拆成多条发出，全部发送，不丢弃）
// 聚合推送阈值：重要资讯攒够该条数即推一批。可用环境变量 AGG_COUNT 覆盖。
const AGG_COUNT = (() => { const n = Number(process.env.AGG_COUNT); return Number.isFinite(n) && n >= 1 ? n : 8; })();
// 聚合节奏：攒够 AGG_COUNT 条即推，或到整点/半点（每 30 分钟）兑底推。
// 仅推送同花顺官方「重要」标记（import>0）的资讯；设为 'false' 则退化为关键词加权筛选
const IMPORT_ONLY = (process.env.IMPORT_ONLY || 'true') !== 'false';
const SEEN_KEEP = 500;          // 去重记录保留条数
const NEWS_CAPTION = '📌 同花顺重要金融资讯（同花顺官方「重要」标记）';
// 字体路径：容器内 /app/fonts/cjk.ttc → ths-news/fonts 相对路径 → macOS 系统字体（本地开发）
const FONT_PATH = (() => {
  if (process.env.THS_FONT) return process.env.THS_FONT;
  const candidates = [
    path.join(__DIR, 'fonts', 'cjk.ttc'),       // 项目内置 WQY（优先）
    '/app/fonts/cjk.ttc',                        // 容器旧挂载路径（兼容）
    '/System/Library/Fonts/PingFang.ttc',        // macOS 本地开发 fallback
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return candidates[0];
})();
const CARD_W = 640;             // 卡片宽度

// ---------- 配置读取（热加载：每个推送周期重新读盘，改 ths_news_targets.json 无需重启容器即可生效）----------
const cfgPath = fs.existsSync(NEWS_TARGETS_PATH) ? NEWS_TARGETS_PATH : CONFIG_PATH;
let PRIVATE_IDS = [];
let GROUP_IDS = [];
let lastTargetsSig = '';
// 重新读取推送目标；仅在目标集合变化时打印日志（减少噪音），读取失败则沿用上轮配置（不丢目标）。
function loadTargets() {
  try {
    if (!fs.existsSync(cfgPath)) return;
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const priv = parseList(c.private);
    const grp = parseList(c.groups);
    const sig = JSON.stringify(priv) + '|' + JSON.stringify(grp);
    if (sig !== lastTargetsSig) {
      PRIVATE_IDS = priv;
      GROUP_IDS = grp;
      lastTargetsSig = sig;
      console.log('[targets] 配置已更新 private=', JSON.stringify(PRIVATE_IDS), 'groups=', JSON.stringify(GROUP_IDS));
    }
  } catch (e) {
    console.error('读取配置失败（沿用上轮配置）:', cfgPath, e.message);
  }
}
loadTargets(); // 进程启动先加载一次

function parseList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map(x => String(x).trim()).filter(Boolean);
}

// ---------- 事件等级与主题规则（每轮热加载，维护词库无需重启） ----------
let NEWS_RULES = { redRisk: [], priceShock: [], predictiveWords: [], clarificationWords: [], equityMarketWords: [], yellowEvent: [], topics: {} };
let lastRulesSig = '';
function loadNewsRules() {
  try {
    if (!fs.existsSync(RULES_PATH)) return NEWS_RULES;
    const parsed = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('规则文件必须是对象');
    const next = {
      redRisk: Array.isArray(parsed.redRisk) ? parsed.redRisk.map(String).filter(Boolean) : [],
      priceShock: Array.isArray(parsed.priceShock) ? parsed.priceShock.map(String).filter(Boolean) : [],
      predictiveWords: Array.isArray(parsed.predictiveWords) ? parsed.predictiveWords.map(String).filter(Boolean) : [],
      clarificationWords: Array.isArray(parsed.clarificationWords) ? parsed.clarificationWords.map(String).filter(Boolean) : [],
      equityMarketWords: Array.isArray(parsed.equityMarketWords) ? parsed.equityMarketWords.map(String).filter(Boolean) : [],
      yellowEvent: Array.isArray(parsed.yellowEvent) ? parsed.yellowEvent.map(String).filter(Boolean) : [],
      topics: parsed.topics && typeof parsed.topics === 'object' ? parsed.topics : {},
    };
    const sig = JSON.stringify(next);
    if (sig !== lastRulesSig) {
      NEWS_RULES = next;
      lastRulesSig = sig;
      console.log(`[rules] 已加载：风险 ${next.redRisk.length} 词 / 价格冲击 ${next.priceShock.length} 词 / 黄色 ${next.yellowEvent.length} 词 / ${Object.keys(next.topics).length} 个主题`);
    }
  } catch (e) {
    console.error('[rules] 读取失败（沿用上轮规则）:', e.message);
  }
  return NEWS_RULES;
}
loadNewsRules();

function matchedKeywords(text, words) {
  return (words || []).filter(k => k && text.includes(k));
}
function classifyNews(item) {
  const title = String(item.title || '');
  const desc = String(item.desc || '');
  const text = `${title} ${desc}`;
  const rules = NEWS_RULES;
  let topic = 'market', topicRule = null, topicScore = 0;
  const shockTopics = new Set(['gold', 'energy', 'gas_coal', 'industrial_metals', 'new_energy_resources', 'agriculture', 'rates_fx']);
  const commodityTopics = new Set(['gold', 'energy', 'gas_coal', 'industrial_metals', 'new_energy_resources', 'agriculture']);
  for (const [key, rule] of Object.entries(rules.topics || {})) {
    const titleHits = matchedKeywords(title, rule.keywords);
    const descHits = matchedKeywords(desc, rule.keywords);
    // 主题只由标的/行业词决定；“涨超、失守、跳水”等通用异动词只决定等级，不能抢走主题。
    // 标题是新闻主语，摘要只是辅助：避免一个概览稿因罗列多个品种而抢错主题。
    const score = titleHits.length * 5 + descHits.length
      + (commodityTopics.has(key) && titleHits.length ? 4 : 0);
    if (score > topicScore) { topic = key; topicRule = rule; topicScore = score; }
  }
  let redHits = matchedKeywords(text, rules.redRisk);
  // 新闻标题明确是澄清/否认时，常会引用第三方风险背景（如“未参与破产企业投资”），
  // 不应把被引用对象的风险误报给当前主体。
  const clarificationTitle = (rules.clarificationWords || []).some(word => new RegExp(word).test(title));
  if (clarificationTitle) redHits = [];
  let yellowHits = matchedKeywords(text, rules.yellowEvent);
  const titleShockHits = matchedKeywords(title, rules.priceShock);
  const predictiveHits = matchedKeywords(text, rules.predictiveWords);
  const titleTopicStrongHits = topicRule ? matchedKeywords(title, topicRule.strong) : [];
  const equityMarketTitle = matchedKeywords(title, rules.equityMarketWords).length > 0;
  // A股板块/个股行情不应因“煤炭、锂、黄金”等行业词自动升级为商品关注事件。
  if (equityMarketTitle || clarificationTitle) yellowHits = [];
  const priceShock = shockTopics.has(topic) && titleShockHits.length > 0 && !equityMarketTitle;
  // 预测性文字只表达预期，不能因“预计加息/降息”自动升级；真实价格冲击与明确风险仍保留红色。
  const predictedRateOnly = topic === 'rates_fx' && predictiveHits.length > 0 && !priceShock && !redHits.length;
  const level = !clarificationTitle && (redHits.length || priceShock || (titleTopicStrongHits.length && !predictedRateOnly)) ? 'red' : yellowHits.length ? 'yellow' : 'normal';
  return {
    topic,
    topicLabel: topicRule?.label || '市场资讯',
    topicColor: topicRule?.color || '#C0392B',
    topicSoftColor: topicRule?.softColor || '#FFF1F1',
    level,
    levelLabel: level === 'red' ? '重大异动' : level === 'yellow' ? '关注事件' : '重要资讯',
    redHits,
    yellowHits,
    shockHits: priceShock ? titleShockHits : [],
    predictiveHits,
    topicStrongHits: titleTopicStrongHits,
  };
}

// ---------- 加权打分（仅用于同一聚合批次内排序；事件等级由规则库决定） ----------
const KEYWORDS = {
  '降准': 3, '降息': 3, '央行': 2, '证监会': 3, '汇金': 3, '证金': 2,
  '财政部': 2, '国务院': 2, 'MLF': 2, '逆回购': 1, '互换便利': 2, '互换': 1,
  'IPO': 2, '退市': 2, '涨停': 1, '跌停': 1, '关税': 3, '美联储': 3,
  '非农': 2, 'GDP': 2, 'CPI': 2, 'PMI': 2, '业绩': 1, '预告': 1, '中报': 1, '三季报': 1,
  '重组': 2, '并购': 2, '举牌': 2, '增持': 1, '减持': 1, '回购': 1,
  '北向': 2, '两融': 1, '政策': 2, '稳定币': 2, '人民币': 2, '汇率': 2,
  '黄金': 1, '原油': 1, '半导体': 1, '芯片': 1, '算力': 1, '新能源': 1,
  '地产': 1, '券商': 1, '银行': 1, '保险': 1, '白酒': 1, '医药': 1, '锂': 1, '光伏': 1,
  '英伟达': 2, '苹果': 1, '特斯拉': 1, '港股通': 1, 'A50': 1, '富时': 1,
  '量化': 1, '印花税': 3, '国家队': 3, '救市': 2, '利空': 1, '利好': 1,
};
const TAG_WEIGHT = { '重要': 3, 'A股': 2, '港股': 1, '美股': 1, '异动': 1, '公告': 1, '机会': 1 };

function scoreNews(item) {
  let s = 0;
  const text = (item.title || '') + ' ' + (item.desc || '');
  for (const [k, w] of Object.entries(KEYWORDS)) if (text.includes(k)) s += w;
  if (item.tag) for (const t of String(item.tag).split(',')) { const tw = TAG_WEIGHT[t.trim()]; if (tw) s += tw; }
  if (item.level === 'red') s += 20;
  else if (item.level === 'yellow') s += 8;
  return s;
}

// ---------- 数据源 ----------
async function fetchFromOfficial() {
  try {
    const resp = await fetch('https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&pageSize=50', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    const j = await resp.json();
    const items = (j.data?.list || []).map(it => ({
      title: it.title,
      desc: it.digest || it.short || '',
      link: it.url,
      time: Number(it.ctime) * 1000,
      tag: it.tag,
      import: it.import,
    }));
    console.log('[src] 同花顺官方接口 ->', items.length, '条');
    return items;
  } catch (e) { console.log('[src] 同花顺官方接口失败', e.message); return []; }
}

async function fetchImportant() {
  return fetchFromOfficial();
}

// ---------- 状态管理 ----------
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) { console.log('[state] 读取失败，重建', e.message); }
  return { seen: [], pending: [], lastPush: 0, lastAggSlot: '' };
}
function saveState(st) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); }
  catch (e) { console.error('[state] 写入失败', e.message); }
}

// ---------- 工具 ----------
// 同花顺 import 字段：实测只有 0（普通）和 3（官方「重要」）两档，1/2 从未出现。
// codeflicker-fix: NEWS-IMPORT-DOT-001/rhs6oo6sfjijtw6lhu07
// importDot 只用于**纯文本**消息（QQ 客户端自带 emoji 字体，可正常显示）。
function importDot(item) {
  const level = Number(item?.import);
  return level === 3 ? '🔴 ' : level === 2 ? '🟡 ' : level === 1 ? '🔵 ' : '';
}
function displayTitle(item) { return importDot(item) + String(item?.title || ''); }
// 图片卡片（canvas / SVG）里不能用 emoji：cjk.ttc 无 emoji 字形，会渲染成豆腐块/空点。
// 改为画布直接绘制圆点（与字体无关）。颜色跟随**事件等级**（levelStyle），与右侧 badge 同色：
// 红=重大异动 / 棕橙=关注事件 / 灰=重要资讯；不再按 import 分色（那只会永远红点）。
const IMPORT_DOT_R = 5.5;   // 圆点半径
const IMPORT_DOT_GAP = 12;  // 圆点右缘到标题首字左缘的间距
// import>0 = 官方「重要」标记，仅决定「画不画点」；点的颜色另由事件等级决定
function importLevel(item) {
  const level = Number(item?.import);
  return Number.isFinite(level) && level > 0 ? level : 0;
}
function importDotColor(item) { return importLevel(item) ? levelStyle(item).color : null; }
// 标题首行需要为圆点预留的宽度（无标记则 0）
function importDotWidth(item) { return importLevel(item) ? IMPORT_DOT_R * 2 + IMPORT_DOT_GAP : 0; }
// 图片渲染专用：纯标题（标记由绘制承担，不拼 emoji）
function titlePlain(item) { return String(item?.title || ''); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const RECENT_WINDOW = 72 * 3600 * 1000; // 仅纳入最近 72 小时，避免推远古资讯

// ---------- 推送（纯文字） ----------
async function checkLogin() {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  try {
    const r = await fetch(NAPCAT_URL + '/get_login_info', { method: 'POST', headers });
    const j = await r.json().catch(() => ({}));
    if (j.status !== 'ok' || !j.data || !j.data.user_id) { console.error('❌ NapCat 登录态异常'); return false; }
    console.log('✅ 机器人在线：', j.data.nickname, '(', j.data.user_id, ')');
    return true;
  } catch (e) { console.error('❌ 无法连接 NapCat：', e.message); return false; }
}

// ---------- 发送（带重试，应对 NapCat 重启后图片通道热身延迟 / 瞬时网络抖动） ----------
// SEND_RETRIES：发送失败后最多重试次数（默认 2）；SEND_RETRY_DELAY：每次重试间隔(ms，默认 3000)
const SEND_RETRIES = (() => { const n = Number(process.env.SEND_RETRIES); return Number.isFinite(n) && n >= 0 ? n : 2; })();
const SEND_RETRY_DELAY = (() => { const n = Number(process.env.SEND_RETRY_DELAY); return Number.isFinite(n) && n >= 0 ? n : 3000; })();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 发送节流（防腾讯风控：QQ 对短时高频群发/私发敏感，掉线多由「瞬时连发」触发） ----------
// SEND_MIN_INTERVAL：同一批内目标与目标之间的最小间隔(ms，默认 2000)；SEND_JITTER：随机抖动上限(ms，默认 3000)
//   → 实际间隔 = SEND_MIN_INTERVAL + [0, SEND_JITTER) 随机值，打散节奏避免固定间隔被识别
// BATCH_MIN_INTERVAL：批与批（多张卡片）之间的最小间隔(ms，默认 5000)；BATCH_JITTER：随机抖动上限(ms，默认 5000)
// 均为纯发送节奏控制，不吞消息、不影响重试逻辑；可在 docker-compose environment 中调整或设 0 关闭
const SEND_MIN_INTERVAL = (() => { const n = Number(process.env.SEND_MIN_INTERVAL); return Number.isFinite(n) && n >= 0 ? n : 2000; })();
const SEND_JITTER = (() => { const n = Number(process.env.SEND_JITTER); return Number.isFinite(n) && n >= 0 ? n : 3000; })();
const BATCH_MIN_INTERVAL = (() => { const n = Number(process.env.BATCH_MIN_INTERVAL); return Number.isFinite(n) && n >= 0 ? n : 5000; })();
const BATCH_JITTER = (() => { const n = Number(process.env.BATCH_JITTER); return Number.isFinite(n) && n >= 0 ? n : 5000; })();
const jittered = (base, jitter) => base + Math.floor(Math.random() * (jitter + 1));

// 单次发送并解析真实成败（HTTP 200 + body.status=ok + retcode=0 才算成功）
async function sendOnce(ep, body, headers) {
  const r = await fetch(NAPCAT_URL + ep, { method: 'POST', headers, body: JSON.stringify(body) });
  const t = await r.text();
  let bodyOk = r.ok;
  try {
    const j = JSON.parse(t);
    if (!j || j.status !== 'ok' || (j.retcode != null && j.retcode !== 0)) bodyOk = false;
  } catch (_) { /* 响应体非 JSON 时信任 HTTP 状态 */ }
  return { ok: bodyOk, text: t };
}

// 带重试的发送：最多 1 + SEND_RETRIES 次；任一成功即返回 ok；全部失败返回最后一次响应
async function sendWithRetry(ep, body, headers, label) {
  let last = { ok: false, text: '' };
  for (let attempt = 1; attempt <= SEND_RETRIES + 1; attempt++) {
    const res = await sendOnce(ep, body, headers);
    if (res.ok) return res;
    last = res;
    if (attempt <= SEND_RETRIES) {
      console.log(`  ↻ ${label} 第${attempt}次失败，${SEND_RETRY_DELAY}ms 后重试(${attempt}/${SEND_RETRIES})：${res.text.slice(0, 100)}`);
      await sleep(SEND_RETRY_DELAY);
    }
  }
  return last;
}

// ---------- 推送（图片卡片，渲染失败回退纯文字） ----------
// 返回 { ok, fail, privateFail }。注意 NapCat 业务失败也返回 HTTP 200 + body.status="failed"，
// 因此必须解析响应体判断真实成败，不能只看 HTTP 状态码（否则会「以为发了其实没发」）。
async function pushToTargets(items, dateStr) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  // 按 MAX_PUSH 拆批，每批渲染成一张图片卡片（不丢弃任何一条）
  const batches = [];
  for (let i = 0; i < items.length; i += MAX_PUSH) batches.push(items.slice(i, i + MAX_PUSH));
  let ok = 0, fail = 0, privateFail = 0;
  const targets = [
    ...PRIVATE_IDS.map(u => ({ kind: '私聊', id: u, ep: '/send_private_msg', body: { user_id: Number(u) } })),
    ...GROUP_IDS.map(g => ({ kind: '群', id: g, ep: '/send_group_msg', body: { group_id: Number(g) } })),
  ];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const segs = await buildMessageSegs(batch, dateStr);
    for (let j = 0; j < targets.length; j++) {
      const tg = targets[j];
      const res = await sendWithRetry(tg.ep, { ...tg.body, message: segs }, headers, `${tg.kind} ${tg.id}`);
      console.log(`${tg.kind} ${tg.id} -> ${res.ok ? '✅成功' : '❌失败(已重试' + SEND_RETRIES + '次)'}`, res.text.slice(0, 140));
      res.ok ? ok++ : fail++;
      if (!res.ok && tg.kind === '私聊') privateFail++;
      // 节流：同一批内目标之间随机间隔，避免瞬时连发触发风控
      if (j < targets.length - 1) await sleep(jittered(SEND_MIN_INTERVAL, SEND_JITTER));
    }
    // 节流：批（多张卡片）之间随机间隔
    if (i < batches.length - 1) await sleep(jittered(BATCH_MIN_INTERVAL, BATCH_JITTER));
  }
  console.log(`完成：成功 ${ok} 个，失败 ${fail} 个（共 ${items.length} 条，分 ${batches.length} 图）`);
  return { ok, fail, privateFail };
}

// 优先渲染图片卡片；渲染异常则回退纯文字，保证不丢
async function buildMessageSegs(batch, dateStr) {
  try {
    const png = renderCard(dateStr, batch);
    return [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }];
  } catch (e) {
    console.error('渲染图片失败，回退纯文字:', e.message);
    const lines = batch.map(it => `【${fmtTime(it.time)}】${displayTitle(it)}${it.desc ? '\n' + it.desc.slice(0, 140) : ''}`);
    const text = `${NEWS_CAPTION}\n${dateStr} · 同花顺官方「重要」·共 ${batch.length} 条\n\n` + lines.join('\n\n');
    return [{ type: 'text', data: { text } }];
  }
}

function cardMeta(dateStr, items) {
  const first = items[0] || {};
  const sameTopic = items.length > 0 && items.every(it => it.topic && it.topic === first.topic);
  const hasRed = items.some(it => it.level === 'red');
  const hasYellow = items.some(it => it.level === 'yellow');
  return {
    title: sameTopic ? `${first.topicLabel}快讯` : (hasRed ? '市场重大异动' : hasYellow ? '市场关注事件' : '同花顺重要金融资讯'),
    color: sameTopic ? first.topicColor : (hasRed ? '#C0392B' : hasYellow ? '#D97706' : '#C0392B'),
    softColor: sameTopic ? first.topicSoftColor : (hasRed ? '#FFF1F1' : hasYellow ? '#FFF7E6' : '#FFF1F1'),
    subtitle: sameTopic ? `${dateStr} · ${first.topicLabel} · 共 ${items.length} 条` : `${dateStr} · 同花顺官方「重要」· 共 ${items.length} 条`,
  };
}
function levelStyle(it) {
  if (it.level === 'red') return { label: '重大异动', color: '#C0392B', bg: '#FFF1F1' };
  if (it.level === 'yellow') return { label: '关注事件', color: '#B45309', bg: '#FFF7E6' };
  return { label: '重要资讯', color: '#64748B', bg: '#F1F5F9' };
}

function loadRenderModule(name) {
  try { return require(name); }
  catch (firstError) {
    // /快讯 从 reply 进程复用该卡片时，依赖安装在 reply/node_modules；
    // 主动推送容器仍优先走当前模块自己的依赖解析。
    try { return require(path.join(__DIR, '..', 'reply', 'node_modules', name)); }
    catch (_) { throw firstError; }
  }
}

function renderCard(dateStr, items) {
  // 2026-09-16：改为优先 @napi-rs/canvas，resvg 仅作回退。原因是「字体」这一层的开销：
  // resvg 每次 new Resvg() 都会重新解析整个字体文件（cjk.ttc 5MB ≈ 4s，实测
  //   new Resvg 4053ms / render 仅 47ms；关掉 loadSystemFonts 仍是 4.1s，说明 100% 是 fontFiles 解析），
  // 而 canvas 走 GlobalFonts.registerFromPath 注册一次、字体常驻进程，同一张卡 ≈ 85ms（快约 50 倍）。
  // 画质两路一致（同一套配色/字号/标签），故容器内一律走 canvas 以省掉每次 4s。
  try {
    return renderCardCanvas(dateStr, items);
  } catch (e) {
    console.error('[renderCard] canvas 渲染失败，回退 resvg:', e.message);
  }
  if (fs.existsSync(FONT_PATH)) {
    try {
      const { Resvg } = loadRenderModule('@resvg/resvg-js');
      const svg = buildCardSvg(dateStr, items);
      const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W }, font: { fontFiles: [FONT_PATH], loadSystemFonts: false } });
      return resvg.render().asPng();
    } catch (e) {
      console.error('[renderCard] resvg 回退也失败:', e.message);
    }
  }
  throw new Error('无可用图片渲染引擎（canvas / resvg 均不可用）');
}

// canvas 引擎的中文字体是否已注册（进程级一次性，见 renderCardCanvas）
let canvasFontReady = false;

function renderCardCanvas(dateStr, items) {
  const { createCanvas, GlobalFonts } = loadRenderModule('@napi-rs/canvas');
  // registerFromPath 会把整个字体文件解析进全局字体库，进程内注册一次即可复用，
  // 每张卡片重复注册纯属浪费（实测首张 137ms / 后续稳定 85ms，差异即首次解析）。
  if (!canvasFontReady) {
    // 优先注册项目内置 WQY；再补充系统字体作 fallback
    const fontCandidates = [
      path.join(__DIR, 'fonts', 'cjk.ttc'),        // 项目内置 WQY（最优先）
      '/app/fonts/cjk.ttc',                        // 容器旧挂载路径（兼容）
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/Hiragino Sans GB.ttc',
      '/System/Library/Fonts/STHeiti Light.ttc',
    ];
    for (const fp of fontCandidates) {
      if (fs.existsSync(fp)) { try { GlobalFonts.registerFromPath(fp, 'cjk'); } catch (_) {} }
    }
    canvasFontReady = true;
  }

  const PAD = 36, INNER = CARD_W - PAD * 2;
  const isHalf = ch => /[A-Za-z0-9 .,:%''""\-/…]/.test(ch);
  const cwOf = (ch, fs) => isHalf(ch) ? fs * 0.55 : fs;
  const wrap = (text, fs, maxW, firstIndent = 0) => {
    const lines = []; let line = '', w = firstIndent; // firstIndent：首行为绘制圆点预留的宽度
    for (const ch of String(text)) {
      const cw = cwOf(ch, fs);
      if (w + cw > maxW && line) { lines.push(line); line = ch; w = cw; }
      else { line += ch; w += cw; }
    }
    if (line) lines.push(line);
    return lines;
  };
  const clipDesc = (text) => {
    const all = wrap(text || '', 19, INNER);
    if (all.length <= 3) return all;
    let last = all[2];
    while (last.length > 1 && cwOf('…', 19) + last.split('').reduce((s, c) => s + cwOf(c, 19), 0) > INNER) last = last.slice(0, -1);
    return [...all.slice(0, 2), last + '…'];
  };

  // 先计算总高度（与渲染逻辑同步：badge 26 + 标题行×28 + 摘要行×25 + 上下 padding 各 14）
  let yCalc = PAD + 34 + 12 + 18 + 22 + 2 + 24;
  items.forEach((it) => {
    const titleLns = wrap(titlePlain(it), 22, INNER, importDotWidth(it));
    const descLns = clipDesc(it.desc || '');
    yCalc += 14 + 26 + titleLns.length * 28 + (descLns.length ? 8 + descLns.length * 25 : 0) + 14;
  });
  const H = yCalc + PAD;

  const canvas = createCanvas(CARD_W, H);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  const meta = cardMeta(dateStr, items);
  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(0, 0, CARD_W, H, 20); ctx.fill();

  let y = PAD;
  // 标题栏：左侧渐变 accent 竖条
  const hGrad = ctx.createLinearGradient(PAD, y, PAD, y + 34);
  hGrad.addColorStop(0, meta.color); hGrad.addColorStop(1, meta.color);
  ctx.fillStyle = hGrad; ctx.fillRect(PAD, y, 6, 34);
  ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 30px cjk';
  ctx.fillText(meta.title, PAD + 20, y + 28);
  y += 34 + 12;

  ctx.fillStyle = '#888888'; ctx.font = '20px cjk';
  ctx.fillText(meta.subtitle, PAD, y + 18);
  y += 18 + 22;

  ctx.strokeStyle = '#eeeeee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CARD_W, y); ctx.stroke();
  y += 24;

  items.forEach((it, idx) => {
    // 奇偶行交替背景
    const rowBg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    const titleLns = wrap(titlePlain(it), 22, INNER, importDotWidth(it));
    const descLns = clipDesc(it.desc || '');
    const rowH = 14 + 26 + titleLns.length * 28 + (descLns.length ? 8 + descLns.length * 25 : 0) + 14;
    ctx.fillStyle = rowBg; ctx.fillRect(0, y, CARD_W, rowH);
    y += 14;

    // 时间与事件标签
    const timeTxt = fmtTime(it.time);
    const lev = levelStyle(it);
    ctx.font = '13px cjk';
    const timeW = ctx.measureText(timeTxt).width + 14;
    const topicW = ctx.measureText(it.topicLabel || '市场资讯').width + 14;
    const levelW = ctx.measureText(lev.label).width + 14;
    const badgeY = y;
    ctx.fillStyle = '#edf0f4'; ctx.beginPath(); ctx.roundRect(PAD, badgeY, timeW, 20, 4); ctx.fill();
    ctx.fillStyle = '#8b919e'; ctx.textAlign = 'center'; ctx.fillText(timeTxt, PAD + timeW / 2, badgeY + 13.5);
    ctx.fillStyle = it.topicSoftColor || '#F1F5F9'; ctx.beginPath(); ctx.roundRect(PAD + timeW + 6, badgeY, topicW, 20, 4); ctx.fill();
    ctx.fillStyle = it.topicColor || '#64748B'; ctx.fillText(it.topicLabel || '市场资讯', PAD + timeW + 6 + topicW / 2, badgeY + 13.5);
    ctx.fillStyle = lev.bg; ctx.beginPath(); ctx.roundRect(PAD + timeW + topicW + 12, badgeY, levelW, 20, 4); ctx.fill();
    ctx.fillStyle = lev.color; ctx.fillText(lev.label, PAD + timeW + topicW + 12 + levelW / 2, badgeY + 13.5);
    ctx.textAlign = 'left';
    y += 26; // 标签高20 + 间距6

    // 标题（去掉时间戳，字号稍收）；import 等级标记用绘制圆点，首行文字右移让位
    ctx.font = 'bold 22px cjk';
    const dotW = importDotWidth(it);
    const dotCol = importDotColor(it);
    for (let i = 0; i < titleLns.length; i++) {
      if (i === 0 && dotCol) {
        ctx.fillStyle = dotCol;
        ctx.beginPath(); ctx.arc(PAD + IMPORT_DOT_R, y + 13, IMPORT_DOT_R, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(titleLns[i], PAD + (i === 0 ? dotW : 0), y + 20);
      y += 28;
    }

    // 摘要
    if (descLns.length) {
      y += 8;
      ctx.fillStyle = '#6b7280'; ctx.font = '18px cjk';
      for (const ln of descLns) { ctx.fillText(ln, PAD, y + 18); y += 25; }
    }
    y += 14;

    // 分隔线（最后一条不加）
    if (idx < items.length - 1) {
      ctx.strokeStyle = '#edf0f3'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CARD_W, y); ctx.stroke();
    }
  });

  return canvas.toBuffer('image/png');
}

function buildCardSvg(dateStr, items) {
  const PAD = 36, INNER = CARD_W - PAD * 2;
  // 半角字符（含数字/英文/常见标点/省略号）按 0.56em 估算宽度（留出 resvg 实际渲染余量，避免右侧截断），全角按 1em
  const isHalf = ch => /[A-Za-z0-9 .,:%‘’“”\-/…]/.test(ch);
  // 行尾标点：避免换行后单独成行（孤立标点）
  const isTrailPunct = ch => /[。，！？；：、]/.test(ch);
  const cwOf = (ch, fs) => isHalf(ch) ? fs * 0.56 : fs;
  const lineW = (line, fs) => { let w = 0; for (const c of line) w += cwOf(c, fs); return w; };
  const wrap = (text, fs, maxW, firstIndent = 0) => {
    const lines = []; let line = '', w = firstIndent; // firstIndent：首行为绘制圆点预留的宽度
    for (const ch of String(text)) {
      const cw = cwOf(ch, fs);
      if (w + cw > maxW && line) {
        // 行尾标点强制贴当前行末尾（允许轻微溢出），杜绝「。」单独换行
        if (isTrailPunct(ch)) { line += ch; lines.push(line); line = ''; w = 0; }
        else { lines.push(line); line = ch; w = cw; }
      } else { line += ch; w += cw; }
    }
    if (line) lines.push(line);
    return lines;
  };
  // 摘要截断到 3 行：超出则在末行追加「…」（若仍溢出则去掉末尾字符腾位）
  const clipDesc = (text) => {
    const fs = 19;
    const all = wrap(text || '', fs, INNER);
    if (all.length <= 3) return { lines: all, clipped: false };
    const kept = all.slice(0, 3);
    const ell = '…'; const ew = cwOf(ell, fs);
    let last = kept[2];
    while (lineW(last, fs) + ew > INNER && last.length > 0) last = last.slice(0, -1);
    kept[2] = last + ell;
    return { lines: kept, clipped: true };
  };
  const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const meta = cardMeta(dateStr, items);
  let y = PAD; const blocks = [];
  blocks.push(`<defs><style>@font-face{font-family:'CJK';src:url('${FONT_PATH}')}</style></defs>`);
  blocks.push(`<rect x="${PAD}" y="${y}" width="6" height="34" rx="3" fill="${meta.color}"/>`);
  blocks.push(`<text x="${PAD + 20}" y="${y + 28}" font-family="CJK" font-size="30" font-weight="700" fill="#1a1a1a">${x(meta.title)}</text>`);
  y += 34 + 12;
  blocks.push(`<text x="${PAD}" y="${y + 18}" font-family="CJK" font-size="20" fill="#888888">${x(meta.subtitle)}</text>`);
  y += 18 + 22;
  blocks.push(`<line x1="${PAD}" y1="${y}" x2="${CARD_W - PAD}" y2="${y}" stroke="#eeeeee" stroke-width="2"/>`);
  y += 24;
  items.forEach((it, idx) => {
    // 奇偶行交替背景（从 y 起到本条末尾，先占位后续再精算）
    const rowBg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    // 估算本条高度（时间行20 + 标题行×30 + 摘要行×26 + 内边距）
    const estTitleLines = wrap(titlePlain(it), 23, INNER, importDotWidth(it)).length;
    const estDescLines = Math.min(3, wrap(it.desc || '', 18, INNER).length);
    const estH = 20 + estTitleLines * 30 + (estDescLines > 0 ? 8 + estDescLines * 26 : 0) + 20;
    blocks.push(`<rect x="0" y="${y}" width="${CARD_W}" height="${estH}" fill="${rowBg}"/>`);
    y += 12;
    // 时间 + 主题 + 事件等级标签
    const timeTxt = fmtTime(it.time);
    const lev = levelStyle(it);
    const timeBadgeW = timeTxt.length * 11 + 14;
    const topicTxt = it.topicLabel || '市场资讯';
    const topicBadgeW = topicTxt.length * 13 + 14;
    const levelBadgeW = lev.label.length * 13 + 14;
    blocks.push(`<rect x="${PAD}" y="${y}" width="${timeBadgeW}" height="20" rx="4" fill="#f0f2f5"/>`);
    blocks.push(`<text x="${PAD + timeBadgeW / 2}" y="${y + 14}" text-anchor="middle" font-family="CJK" font-size="13" fill="#8b919e">${x(timeTxt)}</text>`);
    blocks.push(`<rect x="${PAD + timeBadgeW + 6}" y="${y}" width="${topicBadgeW}" height="20" rx="4" fill="${it.topicSoftColor || '#F1F5F9'}"/>`);
    blocks.push(`<text x="${PAD + timeBadgeW + 6 + topicBadgeW / 2}" y="${y + 14}" text-anchor="middle" font-family="CJK" font-size="13" fill="${it.topicColor || '#64748B'}">${x(topicTxt)}</text>`);
    blocks.push(`<rect x="${PAD + timeBadgeW + topicBadgeW + 12}" y="${y}" width="${levelBadgeW}" height="20" rx="4" fill="${lev.bg}"/>`);
    blocks.push(`<text x="${PAD + timeBadgeW + topicBadgeW + 12 + levelBadgeW / 2}" y="${y + 14}" text-anchor="middle" font-family="CJK" font-size="13" fill="${lev.color}">${x(lev.label)}</text>`);
    y += 26; // 标签高20 + 间距6
    // 标题（无时间戳，字号稍小）；import 等级标记用绘制的圆点（字体无 emoji 字形）
    const titleLines = wrap(titlePlain(it), 23, INNER, importDotWidth(it));
    const dotW = importDotWidth(it);
    const dotCol = importDotColor(it);
    for (let i = 0; i < titleLines.length; i++) {
      if (i === 0 && dotCol) blocks.push(`<circle cx="${PAD + IMPORT_DOT_R}" cy="${y + 13}" r="${IMPORT_DOT_R}" fill="${dotCol}"/>`);
      blocks.push(`<text x="${PAD + (i === 0 ? dotW : 0)}" y="${y + 20}" font-family="CJK" font-size="23" font-weight="700" fill="#1a1a1a">${x(titleLines[i])}</text>`);
      y += 28;
    }
    // 摘要
    if (it.desc) {
      y += 6;
      const { lines: descLines } = clipDesc(it.desc);
      for (const ln of descLines) { blocks.push(`<text x="${PAD}" y="${y + 18}" font-family="CJK" font-size="18" fill="#6b7280">${x(ln)}</text>`); y += 24; }
    }
    y += 12;
    // 条目间分隔线
    if (idx < items.length - 1) {
      blocks.push(`<line x1="0" y1="${y}" x2="${CARD_W}" y2="${y}" stroke="#edf0f3" stroke-width="1"/>`);
    }
  });
  const H = y + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${H}" viewBox="0 0 ${CARD_W} ${H}"><rect x="0" y="0" width="${CARD_W}" height="${H}" rx="20" fill="#ffffff"/>${blocks.join('')}</svg>`;
}

// ---------- 主流程 ----------
async function main() {
  loadTargets(); // 热加载推送目标：每个推送周期重新读盘，改配置无需重启容器
  loadNewsRules(); // 热加载事件/主题词库：改 news_rules.json 无需重启容器
  const dt = new Date();
  const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  console.log('=== 同花顺重要资讯聚合', dateStr, DRY ? '(dry-run)' : FORCE ? '(force)' : '', '===');

  const st = loadState();
  const seenSet = new Set(st.seen);

  const raw = await fetchImportant();
  if (raw.length === 0) { console.log('未获取到任何资讯，退出'); return; }

  const cutoff = Date.now() - RECENT_WINDOW;
  const candidates = [];
  for (const it of raw) {
    if (!it.link || seenSet.has(it.link)) continue;       // 去重
    if (!it.time || it.time < cutoff) continue;            // 仅最近 72 小时
    const classified = classifyNews(it);
    Object.assign(it, classified);
    it.score = scoreNews(it);
    if (IMPORT_ONLY) {
      if (!(Number(it.import) > 0)) continue;              // 仅同花顺官方「重要」标记
    } else if (it.score <= 0) {
      continue;                                            // 关键词兜底：至少命中一个金融关键词
    }
    candidates.push(it);
  }
  candidates.sort((a, b) => b.score - a.score);
  console.log(`本次新候选 ${candidates.length} 条（同花顺「重要」且最近72h且未推送）`);

  if (DRY) {
    console.log('[targets] private=', JSON.stringify(PRIVATE_IDS), 'groups=', JSON.stringify(GROUP_IDS));
    console.log(`本轮新候选 ${candidates.length} 条（同花顺「重要」且最近72h且未推送）——红色即时 ${candidates.filter(c => c.level === 'red').length} 条 / 黄色关注 ${candidates.filter(c => c.level === 'yellow').length} 条 / 普通 ${candidates.filter(c => c.level === 'normal').length} 条`);
    candidates.slice(0, 12).forEach((c, i) => console.log(`  ${i + 1}. [${c.level === 'red' ? '🔴即时' : c.level === 'yellow' ? '🟡关注' : '聚合'}] [${c.topicLabel}][分${c.score}] ${fmtTime(c.time)} ${c.title}`));
    return;
  }

  // --force：立即推送本轮全部候选（用于测试验证）
  if (FORCE) {
    if (candidates.length === 0) { console.log('无可推送候选'); return; }
    if (!(await checkLogin())) { console.error('登录态异常，退出'); return; }
    const fres = await pushToTargets(candidates, dateStr);
    for (const c of candidates) seenSet.add(c.link);
    st.seen = Array.from(seenSet).slice(-SEEN_KEEP);
    if (fres.privateFail > 0) console.error(`⚠️ force：私聊推送失败 ${fres.privateFail} 个`);
    st.lastPush = Date.now();
    saveState(st);
    console.log('force 推送完成');
    return;
  }

  // —— 分级：红色风险/主题强事件立即推；黄色关注和普通重要进入原有聚合缓冲 ——
  const urgent = candidates.filter(c => c.level === 'red');
  const normal = candidates.filter(c => c.level !== 'red');

  // 1) 红色风险 / 商品强事件：立即推送（保持既有私聊+群聊目标和发送节流）
  if (urgent.length > 0) {
    for (const c of urgent) seenSet.add(c.link);
    if (await checkLogin()) {
      const ures = await pushToTargets(urgent, dateStr);
      if (ures.privateFail > 0) {
        for (const c of urgent) seenSet.delete(c.link); // 失败回滚，下轮重试
        console.error(`⚠️ 红色风险私聊失败 ${ures.privateFail} 个，回滚 seen 下轮重试`);
      } else {
        console.log(`✅ 红色风险推送完成，共 ${urgent.length} 条`);
      }
    } else {
      for (const c of urgent) seenSet.delete(c.link); // 登录异常，回滚 seen 下轮重试
      console.error('登录态异常，红色风险资讯暂不推送，下轮重试');
    }
  }

  // 2) 黄色关注 + 普通重要：保留原有缓冲策略，攒够 AGG_COUNT 条或到整点/半点再推
  if (normal.length > 0) {
    for (const c of normal) seenSet.add(c.link);
    if (!Array.isArray(st.pending)) st.pending = [];
    st.pending.push(...normal);
    console.log(`黄色/普通资讯入缓冲，当前待推 ${st.pending.length} 条`);
  }
  st.seen = Array.from(seenSet).slice(-SEEN_KEEP);
  saveState(st);

  // 3) 聚合判断：攒够 AGG_COUNT 条，或到整点/半点（每 30 分钟一个槽）
  const now = new Date();
  const slotKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes() < 30 ? '00' : '30'}`;
  const pending = Array.isArray(st.pending) ? st.pending : [];
  const isNewSlot = slotKey !== (st.lastAggSlot || '');
  const shouldPush = pending.length >= AGG_COUNT || (isNewSlot && pending.length > 0);

  if (!shouldPush) {
    console.log(`本轮不推聚合（待推 ${pending.length} 条，攒够 ${AGG_COUNT} 条或到整点/半点触发）`);
    return;
  }

  if (!(await checkLogin())) { console.error('登录态异常，暂不推聚合，下轮重试'); return; }

  const res = await pushToTargets(pending, dateStr);
  if (res.privateFail > 0) {
    console.error(`⚠️ 聚合私聊失败 ${res.privateFail} 个，保留缓冲下轮重试`);
  } else {
    st.pending = [];
    st.lastAggSlot = slotKey;
    if (res.fail > res.privateFail) {
      console.error(`⚠️ 聚合群推送失败 ${res.fail - res.privateFail} 个（私聊已送达，群权限需用户侧修复）`);
    }
  }
  st.lastPush = Date.now();
  saveState(st);
  console.log(`聚合推送完成，共 ${pending.length} 条`);
}

// 仅当直接运行本文件时才执行主流程；被 require 时仅暴露渲染函数（供验证/复用脚本使用）
if (require.main === module) {
  const SCHEDULE = !DRY && !FORCE;
  const INTERVAL_MS = (parseInt(process.env.NEWS_INTERVAL || '600', 10) || 600) * 1000;

  // 单轮执行 + 异常兜底：任何一轮出错都只记录，不影响后续调度，绝不让进程退出
  async function tick() {
    try {
      await main();
    } catch (e) {
      console.error('[tick] 本轮异常（已捕获，继续调度）:', e);
    }
  }

  if (SCHEDULE) {
    // 自调度模式：node 常驻，每 NEWS_INTERVAL 秒跑一轮，彻底不依赖 shell 的 while 循环
    console.log(`[scheduler] 自调度模式启动，间隔 ${INTERVAL_MS / 1000}s`);
    tick();
    setInterval(tick, INTERVAL_MS);
  } else {
    // --dry-run / --force：一次性执行
    tick();
  }
}

module.exports = { buildCardSvg, renderCard, cardMeta, levelStyle, importDot, displayTitle, importLevel, importDotColor, importDotWidth, titlePlain, loadNewsRules, classifyNews, CARD_W, FONT_PATH };
