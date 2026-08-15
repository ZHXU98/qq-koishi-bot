// 同花顺重要金融资讯聚合转发脚本（图片卡片推送，可容器化运行）
//
// 数据来源：同花顺官方 7×24 财经直播接口
//   https://news.10jqka.com.cn/tapp/news/push/stock/
//   该接口每条资讯自带 `import` 字段：import=3（或 >0）即同花顺标记为「重要」，
//   等价于原 RSSHub 的「重要」订阅标签，且为同花顺自带的重要性判定，比关键词加权更准。
//
// 流程（「有就发」模式）：
//   1. 每 10 分钟（容器内 start_news_cron.sh 循环）拉取官方接口，仅保留 import>0（同花顺「重要」标记）的资讯
//   2. 标签 + 关键词加权打分仅用于重要资讯内部排序，不参与过滤
//   3. 本地去重（seen 列表）后，本轮新捞到的所有重要资讯「立即全部推送」，不攒批、不丢弃
//   4. 通过 NapCat 以图片卡片（SVG→PNG，resvg 渲染）推送到 ths_news_targets.json 配置的 QQ 私聊/群；渲染失败时自动回退纯文字
//     单张卡片最多承载 MAX_PUSH 条，超过则拆成多张卡片发出，保证不丢任何一条
//
// 用法：
//   node fetch_ths_news.js              # 正式模式（每轮有新的重要资讯就立即全推）
//   node fetch_ths_news.js --dry-run    # 只打印筛选结果，不推送
//   node fetch_ths_news.js --force      # 立即推送本轮候选（全部），用于测试
//
// 配置：RSS 资讯独立配置 ths_news_targets.json（private / groups / imageWidth / imageScale），
//       回退 push_targets.json；与复盘报告 push_report.js 的分发目标解耦。
// 环境变量：NAPCAT_URL（默认 http://127.0.0.1:3000）、NAPCAT_TOKEN、THS_CONFIG（配置路径）、
//           THS_STATE（状态文件路径，默认 /tmp/ths_news_state.json）。

const fs = require('fs');
const path = require('path');

const __DIR = __dirname;
const CONFIG_PATH = path.join(__DIR, 'push_targets.json');
const NEWS_TARGETS_PATH = process.env.THS_CONFIG || path.join(__DIR, 'ths_news_targets.json');
const STATE_PATH = process.env.THS_STATE || '/tmp/ths_news_state.json';
const NAPCAT_URL = process.env.NAPCAT_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.NAPCAT_TOKEN || '';
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force'); // 立即推送当前 Top，用于测试

const MAX_PUSH = 8;             // 单条消息最多承载条数（超过则拆成多条发出，全部发送，不丢弃）
// 仅推送同花顺官方「重要」标记（import>0）的资讯；设为 'false' 则退化为关键词加权筛选
const IMPORT_ONLY = (process.env.IMPORT_ONLY || 'true') !== 'false';
const SEEN_KEEP = 500;          // 去重记录保留条数
const NEWS_CAPTION = '📌 同花顺重要金融资讯（同花顺官方「重要」标记）';
const FONT_PATH = process.env.THS_FONT || '/app/fonts/cjk.ttc'; // 容器内挂载的中文字体（方案A）
const CARD_W = 640;             // 卡片宽度

// ---------- 配置读取 ----------
const cfgPath = fs.existsSync(NEWS_TARGETS_PATH) ? NEWS_TARGETS_PATH : CONFIG_PATH;
let cfg = { private: [], groups: [], imageWidth: 600, imageScale: 2 };
try {
  if (fs.existsSync(cfgPath)) cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
} catch (e) { console.error('读取配置失败:', cfgPath, e.message); }
const PRIVATE_IDS = parseList(cfg.private);
const GROUP_IDS = parseList(cfg.groups);

function parseList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map(x => String(x).trim()).filter(Boolean);
}

// ---------- 加权打分 ----------
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
  return { seen: [], lastPush: 0 };
}
function saveState(st) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); }
  catch (e) { console.error('[state] 写入失败', e.message); }
}

// ---------- 工具 ----------
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

// ---------- 推送（图片卡片，渲染失败回退纯文字） ----------
async function pushToTargets(items, dateStr) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  // 按 MAX_PUSH 拆批，每批渲染成一张图片卡片（不丢弃任何一条）
  const batches = [];
  for (let i = 0; i < items.length; i += MAX_PUSH) batches.push(items.slice(i, i + MAX_PUSH));
  let ok = 0, fail = 0, sent = 0;
  for (const batch of batches) {
    const segs = await buildMessageSegs(batch, dateStr);
    for (const uid of PRIVATE_IDS) {
      const r = await fetch(NAPCAT_URL + '/send_private_msg', { method: 'POST', headers, body: JSON.stringify({ user_id: Number(uid), message: segs }) });
      const t = await r.text();
      console.log(`私聊 ${uid} -> HTTP ${r.status}`, t.slice(0, 100));
      r.ok ? ok++ : fail++;
    }
    for (const gid of GROUP_IDS) {
      const r = await fetch(NAPCAT_URL + '/send_group_msg', { method: 'POST', headers, body: JSON.stringify({ group_id: Number(gid), message: segs }) });
      const t = await r.text();
      console.log(`群 ${gid} -> HTTP ${r.status}`, t.slice(0, 100));
      r.ok ? ok++ : fail++;
    }
    sent += batch.length;
  }
  console.log(`完成：成功 ${ok} 个，失败 ${fail} 个（共 ${items.length} 条，分 ${batches.length} 图）`);
  return fail === 0;
}

// 优先渲染图片卡片；渲染异常则回退纯文字，保证不丢
async function buildMessageSegs(batch, dateStr) {
  try {
    const png = renderCard(dateStr, batch);
    return [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }];
  } catch (e) {
    console.error('渲染图片失败，回退纯文字:', e.message);
    const lines = batch.map(it => `【${fmtTime(it.time)}】${it.title}${it.desc ? '\n' + it.desc.slice(0, 140) : ''}`);
    const text = `${NEWS_CAPTION}\n${dateStr} · 同花顺官方「重要」·共 ${batch.length} 条\n\n` + lines.join('\n\n');
    return [{ type: 'text', data: { text } }];
  }
}

function renderCard(dateStr, items) {
  const { Resvg } = require('@resvg/resvg-js'); // 延迟 require，避免宿主无此模块时脚本加载失败
  const svg = buildCardSvg(dateStr, items);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W }, font: { fontFiles: [FONT_PATH] } });
  return resvg.render().asPng();
}

function buildCardSvg(dateStr, items) {
  const PAD = 36, INNER = CARD_W - PAD * 2;
  // 半角字符（含数字/英文/常见标点/省略号）按 0.56em 估算宽度（留出 resvg 实际渲染余量，避免右侧截断），全角按 1em
  const isHalf = ch => /[A-Za-z0-9 .,:%‘’“”\-/…]/.test(ch);
  // 行尾标点：避免换行后单独成行（孤立标点）
  const isTrailPunct = ch => /[。，！？；：、]/.test(ch);
  const cwOf = (ch, fs) => isHalf(ch) ? fs * 0.56 : fs;
  const lineW = (line, fs) => { let w = 0; for (const c of line) w += cwOf(c, fs); return w; };
  const wrap = (text, fs, maxW) => {
    const lines = []; let line = '', w = 0;
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
  let y = PAD; const blocks = [];
  blocks.push(`<defs><style>@font-face{font-family:'CJK';src:url('${FONT_PATH}')}</style></defs>`);
  blocks.push(`<rect x="${PAD}" y="${y}" width="6" height="34" rx="3" fill="#c0392b"/>`);
  blocks.push(`<text x="${PAD + 20}" y="${y + 28}" font-family="CJK" font-size="30" font-weight="700" fill="#1a1a1a">同花顺重要金融资讯</text>`);
  y += 34 + 12;
  blocks.push(`<text x="${PAD}" y="${y + 18}" font-family="CJK" font-size="20" fill="#888888">${dateStr} · 同花顺官方「重要」·共 ${items.length} 条</text>`);
  y += 18 + 22;
  blocks.push(`<line x1="${PAD}" y1="${y}" x2="${CARD_W - PAD}" y2="${y}" stroke="#eeeeee" stroke-width="2"/>`);
  y += 24;
  items.forEach((it, idx) => {
    // 条目间分隔线（首条不加）
    if (idx > 0) {
      y += 10;
      blocks.push(`<line x1="${PAD}" y1="${y}" x2="${CARD_W - PAD}" y2="${y}" stroke="#f0f0f0" stroke-width="1"/>`);
      y += 16;
    }
    const titleLines = wrap('【' + fmtTime(it.time) + '】' + it.title, 25, INNER);
    for (const ln of titleLines) { blocks.push(`<text x="${PAD}" y="${y + 22}" font-family="CJK" font-size="25" font-weight="700" fill="#222222">${x(ln)}</text>`); y += 30; }
    y += 10; // 标题↔摘要呼吸
    const { lines: descLines } = clipDesc(it.desc || '');
    for (const ln of descLines) { blocks.push(`<text x="${PAD}" y="${y + 20}" font-family="CJK" font-size="19" fill="#666666">${x(ln)}</text>`); y += 28; }
    y += 6; // 条目尾部留白（条目间的较大间距由分隔线段承担）
  });
  const H = y + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${H}" viewBox="0 0 ${CARD_W} ${H}"><rect x="0" y="0" width="${CARD_W}" height="${H}" rx="20" fill="#ffffff"/>${blocks.join('')}</svg>`;
}

// ---------- 主流程 ----------
async function main() {
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
    console.log(`本轮新候选 ${candidates.length} 条（同花顺「重要」+最近72h+未推送）——「有就发」模式将全部推送，不攒批、不丢弃`);
    candidates.slice(0, 12).forEach((c, i) => console.log(`  ${i + 1}. [重要 import=${c.import}][分${c.score}] ${fmtTime(c.time)} ${c.title}`));
    return;
  }

  // --force：立即推送本轮全部候选（用于测试验证）
  if (FORCE) {
    if (candidates.length === 0) { console.log('无可推送候选'); return; }
    if (!(await checkLogin())) { console.error('登录态异常，退出'); process.exit(4); }
    await pushToTargets(candidates, dateStr);
    for (const c of candidates) seenSet.add(c.link);
    st.seen = Array.from(seenSet).slice(-SEEN_KEEP);
    st.lastPush = Date.now();
    saveState(st);
    console.log('force 推送完成');
    return;
  }

  // 「有就发」：本轮新捞到的所有重要资讯立即全部推送，不攒批、不丢弃
  if (candidates.length === 0) {
    saveState(st);
    console.log('本轮无新重要资讯');
    return;
  }
  for (const c of candidates) seenSet.add(c.link);
  st.seen = Array.from(seenSet).slice(-SEEN_KEEP);

  if (!(await checkLogin())) { console.error('登录态异常，暂不推送'); saveState(st); process.exit(4); }
  await pushToTargets(candidates, dateStr);
  st.lastPush = Date.now();
  saveState(st);
  console.log(`本轮推送完成，共 ${candidates.length} 条重要资讯`);
}

// 仅当直接运行本文件时才执行主流程；被 require 时仅暴露渲染函数（供验证/复用脚本使用）
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { buildCardSvg, renderCard, CARD_W, FONT_PATH };
