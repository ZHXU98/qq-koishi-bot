#!/usr/bin/env node
// qq-reply —— NapCat QQ 机器人「被@回复 + 指令」服务（零依赖）
//
// 职责：连接 NapCat 正向 WebSocket（事件上报），接收消息事件；检测「被 @」与
//       「指令前缀」，通过 NapCat HTTP API 回复。
//       群聊：仅响应被 @ 机器人的消息（@ 后跟指令）；私聊：所有消息均响应。
//
// 依赖：Node >= 21（内置全局 WebSocket 客户端与 fetch），无需 npm install
//
// 环境变量：
//   NAPCAT_WS_URL   ws://napcat:3001   NapCat 正向 WebSocket 地址
//   NAPCAT_URL      http://napcat:3000 NapCat OneBot HTTP API 地址
//   NAPCAT_TOKEN    (空)               NapCat access token（若启用）
//   BOT_UIN         机器人 QQ 号（识别 @ 用，docker-compose 传 ${QQ_ACCOUNT}）
//
// 配置文件 config.json（热加载：每次收到消息重新读盘，改完无需重启）：
//   groupAtOnly:         群聊仅响应被 @ 的消息（默认 true）
//   privateAlways:       私聊总是响应（默认 true）
//   admins:              管理员 QQ 列表（群聊中不受指令限制）
//   privateWhitelist:    私聊白名单（非列表内账号私聊一律拒绝；空数组 = 不限制）
//   groupRestrictedCmds: 群聊中非管理员可用的指令名白名单（如 ["ping","status"]；空数组 = 不限制）
//   restrictedMsg:       群聊非管理员使用受限指令时的提示
//   deniedMsg:           私聊非白名单账号的拒绝提示（置空字符串则完全忽略不回复）
//   unknownMsg:          未识别指令时的提示文本
//   welcome:             非指令消息的引导语（置空字符串则忽略不回复）

const fs = require('fs');
const path = require('path');

const WS_URL = process.env.NAPCAT_WS_URL || 'ws://127.0.0.1:3001';
const NAPCAT_URL = process.env.NAPCAT_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.NAPCAT_TOKEN || '';
const BOT_UIN = String(process.env.BOT_UIN || '');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const STARTED_AT = Date.now();
let wsState = 'idle';

// ---------- 配置（热加载） ----------
const DEFAULTS = {
  groupAtOnly: true,
  privateAlways: true,
  admins: [],
  privateWhitelist: [],
  groupRestrictedCmds: [],
  groupImages: false, // 群聊预览是否带图：腾讯对群聊批量图片有安全审核（涉黄会静默超时），默认 false=群聊只发文本，图片私聊补发
  restrictedMsg: '⚠️ 该指令仅限管理员使用',
  deniedMsg: '🛡️ 本机器人仅对授权账号开放',
  unknownMsg: '未知指令，发送 /help 查看可用指令',
  welcome: '👋 你好，我是机器人助手。群聊请 @我 + 指令，私聊可直接发送指令；发送 /help 查看全部指令。',
};
let CONFIG = { ...DEFAULTS };
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      CONFIG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('[config] 读取失败（沿用默认）:', e.message);
  }
}
loadConfig();

// ---------- 工具 ----------
function uptimeText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
}
function nowText() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- NapCat HTTP API ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// retry=true（发送类端点）时最多尝试 5 次、间隔 5s（总 ~20s 覆盖窗口），
// 抵御 NapCat 内核 sendMsg 的间歇性超时（风控下超时窗口常持续 10s+，短重试会整批落空）
async function napcat(ep, body, { retry = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const maxTry = retry ? 5 : 1;
  const retryDelay = retry ? 5000 : 0;
  let t = '';
  let ok = false; // 声明在循环外，供最终失败分支判断
  for (let i = 1; i <= maxTry; i++) {
    ok = false;
    try {
      const r = await fetch(NAPCAT_URL + ep, { method: 'POST', headers, body: JSON.stringify(body) });
      t = await r.text();
      ok = r.ok;
      try {
        const j = JSON.parse(t);
        if (!j || j.status !== 'ok') ok = false;
      } catch (_) { /* 非 JSON 响应时信任 HTTP 状态 */ }
    } catch (e) {
      if (!retry) console.error(`[napcat] ${ep} 网络错误:`, e.message);
      else if (i < maxTry) console.log(`  ↻ ${ep} 第${i}次网络错误，${retryDelay / 1000}s 后重试（${e.message}）`);
    }
    if (ok) return true;
    if (i < maxTry) {
      if (retry) console.log(`  ↻ ${ep} 第${i}次失败，${retryDelay / 1000}s 后重试（${t.slice(0, 80)}）`);
      await sleep(retryDelay);
    }
  }
  if (!ok) console.error(`[napcat] ${ep} 失败(已重试${maxTry - 1}次):`, t.slice(0, 200));
  return false;
}

// 发送回复（自动按消息场景选端点）；images 为远程图片 URL 列表（机器人主动限制最多 10 张）
// 官方通道（official-bot-gateway）：携带网关下发的 msg_id 走被动回复（5min/60min 窗口内有效），
// 否则会被当作主动推送（群无权限/私聊每月仅 4 条），回复必然失败。
async function sendReply(ev, text, images = []) {
  if (!text && !images.length) return;
  const message = [];
  if (text) message.push({ type: 'text', data: { text } });
  for (const img of images.slice(0, 4)) message.push({ type: 'image', data: { file: img } });
  const extra = ev._reply && ev._reply.msgId ? { msg_id: ev._reply.msgId } : {};
  if (ev.message_type === 'group') {
    return napcat('/send_group_msg', { group_id: ev.group_id, message, ...extra }, { retry: true });
  }
  return napcat('/send_private_msg', { user_id: ev.user_id, message, ...extra }, { retry: true });
}

// 逐张发送预览图（官方通道一条消息只能一张图；慢速逐条转发，避免图片被截断或触发频控）
// images 最多 10 张；可选先发 text（一条文本消息），再每张图单独一条消息、间隔 delay ms
async function sendImagesSequential(ev, images, text = '', { delay = 700 } = {}) {
  if (text) await sendReply(ev, text);
  for (const img of (images || []).slice(0, 10)) {
    await sendReply(ev, '', [img]);
    await sleep(delay);
  }
}

// ---------- 消息解析 ----------
// messagePostFormat=array：把 CQ 码数组解析成 { atMe, text }
function parseMessage(segs) {
  let atMe = false;
  let text = '';
  for (const s of Array.isArray(segs) ? segs : []) {
    if (!s || !s.type) continue;
    if (s.type === 'at') {
      // 仅「精确 @ 机器人」触发；@全体成员不触发，避免误回应
      if (String((s.data && s.data.qq) ?? '') === BOT_UIN) atMe = true;
    } else if (s.type === 'text') {
      text += (s.data && s.data.text) || '';
    }
  }
  return { atMe, text: text.trim() };
}

// ---------- 指令实现 ----------
function cmdHelp() {
  return [
    '📋 机器人指令菜单',
    '群聊：@我 + 指令；私聊：直接发送',
    '',
    '/ping   存活检测',
    '/status 服务状态',
    '/echo <内容>  复读',
    '/快讯   最新重要资讯（最近 10 条）',
    '/preview <磁力链接或40位hash>  磁力预览',
    '/help   显示本菜单',
    '',
    '💡 直接发一条磁力链接（magnet:?xt=...）也能自动预览',
  ].join('\n');
}
function cmdPing() {
  return `🏓 Pong! 服务存活正常（运行 ${uptimeText(Date.now() - STARTED_AT)}，${nowText()}）`;
}
async function cmdStatus() {
  let botLine = '❌ 无法获取机器人信息（HTTP API 异常）';
  try {
    const r = await fetch(NAPCAT_URL + '/get_login_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    });
    const j = await r.json();
    if (j && j.status === 'ok' && j.data) {
      botLine = `✅ ${j.data.nickname || '未知昵称'}（${j.data.user_id}）`;
    }
  } catch (_) { /* botLine 已给默认值 */ }
  return [
    '🤖 服务状态',
    `• 机器人：${botLine}`,
    `• 事件通道：WebSocket ${wsState === 'online' ? '✅ 已连接' : '⚠️ ' + wsState}`,
    `• 服务运行：${uptimeText(Date.now() - STARTED_AT)}`,
    `• 当前时间：${nowText()}`,
    '',
    genHardwareStats(),
  ].join('\n');
}

// ---------- 监控指标（模拟数据，仅作展示） ----------
// 每次 /status 随机生成一组贴近真实范围的数值，纯展示用途，不读取真实硬件。
function rand(min, max, digits = 1) {
  return (min + Math.random() * (max - min)).toFixed(digits);
}
function genHardwareStats() {
  return [
    '📊 监控指标',
    `CPU  AMD Ryzen9 9950X3D      | ${rand(72, 79)}℃  ${rand(4.2, 4.5, 2)}GHz`,
    `GPU  NVIDIA RTX 5090 32G     | ${rand(65, 75)}℃  ${rand(28, 31)}G/31.85G`,
    `内存 64GB DDR5 6400 C30      | ${rand(45, 55)}℃  ${rand(40, 55)}G/62.5G`,
  ].join('\n');
}
function cmdEcho(args) {
  const t = args.join(' ').trim();
  return t ? '🔁 ' + t : '用法：/echo <内容>';
}

// ---------- 磁力预览（WhatsLink 公开 API，免费匿名调用） ----------
// GET https://whatslink.info/api/v1/link?url=<magnet>
// 返回 { type, file_type, name, size, count, screenshots:[{time,screenshot:URL}] }
// 未收录时 name 为空 / type=UNKNOWN。截图仅视频类资源有。
const WHATSLINK_API = 'https://whatslink.info/api/v1/link';

// 从任意文本中提取磁力链接或 40 位 InfoHash；无则返回 ''
function extractMagnet(text) {
  const t = String(text || '');
  const m = t.match(/magnet:\?xt=urn:btih:([a-fA-F0-9]{40})/i);
  if (m) return 'magnet:?xt=urn:btih:' + m[1].toLowerCase();
  const h = t.match(/(^|\s)([a-fA-F0-9]{40})(\s|$)/);
  if (h) return 'magnet:?xt=urn:btih:' + h[2].toLowerCase();
  return '';
}
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '未知';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
// 返回 { text, images: [...] }；images 可能为空数组
async function cmdPreview(magnet) {
  const link = extractMagnet(magnet);
  if (!link) return { text: '用法：/preview <磁力链接或40位hash>，或直接发一条 magnet 链接', images: [] };
  try {
    const r = await fetch(WHATSLINK_API + '?url=' + encodeURIComponent(link), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000), // 防止预览查询挂起过久、错过发送窗口
    });
    const j = await r.json();
    if (!j || j.type === 'UNKNOWN' || !j.name) {
      return { text: '⚠️ 该磁链（btih:' + link.slice(-40) + '）在 whatsLink 无预览索引，换一个热门资源试试', images: [] };
    }
    const shots = (j.screenshots || []).map(s => s && s.screenshot).filter(Boolean);
    const lines = [
      '🔗 磁力预览',
      `📛 名称：${j.name}`,
      `📦 类型：${j.file_type || j.type || '未知'}`,
      `💾 大小：${fmtSize(j.size)}`,
      `📄 文件数：${j.count || 0}`,
      shots.length ? `🖼 预览图 ${shots.length} 张（机器人主动限制最多发 10 张，逐张发送）` : '🖼 无截图（非视频资源）',
    ];
    return { text: lines.join('\n'), images: shots };
  } catch (e) {
    return { text: '⚠️ 预览服务请求失败：' + e.message, images: [] };
  }
}

// ---------- 快讯查询（同花顺官方「重要」资讯，2026-08-26 从网关迁入，qq-reply 为统一命令中心） ----------
const THS_URL = 'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&pageSize=50';
const NEWS_QUERY_LIMIT = Number(process.env.NEWS_QUERY_LIMIT || 10); // 查询返回条数
const DAILY_PUSH_HOUR = Number(process.env.DAILY_PUSH_HOUR || 21);
const DAILY_PUSH_MIN = Number(process.env.DAILY_PUSH_MIN || 30);
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

// 指令路由；返回 { name, type: 'text'|'status'|'preview'|'news', text } 或 null（未识别）
function routeCommand(text) {
  const parts = text.split(/\s+/);
  const raw = (parts.shift() || '').toLowerCase().replace(/^[\/／]/, '');
  switch (raw) {
    case 'help': case '菜单': return { name: 'help', type: 'text', text: cmdHelp() };
    case 'ping': case '存活': return { name: 'ping', type: 'text', text: cmdPing() };
    case 'status': case '状态': return { name: 'status', type: 'status' };
    case 'echo': case '复读': return { name: 'echo', type: 'text', text: cmdEcho(parts) };
    case 'preview': case '预览': case '磁力预览': case 'seed': return { name: 'preview', type: 'preview', text: parts.join(' ') };
    case '快讯': case 'news': case '资讯': return { name: 'news', type: 'news' };
    default: return null;
  }
}

// ---------- 事件处理 ----------
async function handleEvent(ev) {
  if (!ev || ev.post_type !== 'message') return; // 仅处理消息事件
  loadConfig(); // 每次收到消息重新读盘：改 config.json 无需重启立即生效
  const { atMe, text } = parseMessage(ev.message);
  if (!text) return; // 纯 @ 无文字（或只有图片/表情）→ 不打扰

  const uid = String(ev.user_id ?? '');
  const isAdmin = (CONFIG.admins || []).includes(uid);
  const autoMg = extractMagnet(text); // 提前提取磁链：管理员群里直接发磁链也可自动预览

  // —— 私聊：白名单限制（非白名单账号一律拒绝） ——
  if (ev.message_type === 'private') {
    if (!CONFIG.privateAlways) return;
    const wl = CONFIG.privateWhitelist || [];
    if (wl.length > 0 && !wl.includes(uid)) {
      if (CONFIG.deniedMsg) await sendReply(ev, CONFIG.deniedMsg);
      return;
    }
  } else if (ev.message_type === 'group') {
    // 群聊仅响应被 @；例外：管理员直接发磁链也触发自动预览（普通成员仍须 @）
    if (CONFIG.groupAtOnly && !atMe && !(isAdmin && autoMg)) return;
  } else {
    return; // 其它消息类型（讨论组等）暂不处理
  }

  let cmd = routeCommand(text);
  if (!cmd) {
    if (autoMg) {
      // 含磁力链接：自动预览（权限同 /preview）
      cmd = { name: 'preview', type: 'preview', text: autoMg };
    } else {
      // 群聊/私聊统一：非特定指令的消息（闲聊等）一律忽略，不打扰
      return;
    }
  }

  // —— 群聊功能区别：非管理员仅允许受限指令集（自动磁链等同 /preview 走同一权限） ——
  const restricted = CONFIG.groupRestrictedCmds || [];
  if (ev.message_type === 'group' && !isAdmin && restricted.length > 0 && !restricted.includes(cmd.name)) {
    await sendReply(ev, CONFIG.restrictedMsg);
    return;
  }

  if (cmd.type === 'preview') {
    const r = await cmdPreview(cmd.text);
    const imgs = r.images || []; // 防御：保证数组
    if (ev.message_type === 'group') {
      // 群聊：默认不带图（腾讯群聊对批量图片有安全审核，涉黄内容会静默超时）；
      // 图片改走私聊补发给触发者（管理员），群聊只发文本预览
      const showImg = CONFIG.groupImages && imgs.length > 0;
      let text = r.text;
      if (imgs.length > 0 && !showImg) {
        const total = imgs.length;
        text += `\n🖼 共 ${total} 张预览图，将逐张私聊发送请查收（官方通道一条消息一张图，最多10张）`;
      }
      await sendReply(ev, text);
      // 逐张发送预览图：官方通道一条消息只能一张图，慢速逐条转发避免被截断/频控
      if (imgs.length > 0) {
        if (showImg) {
          await sendImagesSequential(ev, imgs); // 群里逐张
        } else if (isAdmin) {
          await sendImagesSequential({ message_type: 'private', user_id: ev.user_id }, imgs); // 私聊逐张补发
        }
      }
    } else {
      await sendImagesSequential(ev, imgs, r.text); // 私聊：先文本，再逐张发图
    }
  } else if (cmd.type === 'status') {
    await sendReply(ev, await cmdStatus());
  } else if (cmd.type === 'news') {
    // 快讯查询（被动回复，不占主动配额）
    const items = await fetchImportantNews(NEWS_QUERY_LIMIT);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    await sendReply(ev, formatNewsReply(items, `📌 最新重要资讯（${now}）`));
  } else {
    await sendReply(ev, cmd.text);
  }
}

// ---------- WebSocket 事件通道（断线自动重连） ----------
function connect() {
  wsState = 'connecting';
  console.log(`[ws] 连接 ${WS_URL} ...`);
  const w = new WebSocket(WS_URL);
  w.onopen = () => {
    wsState = 'online';
    console.log('✅ WebSocket 已连接', WS_URL);
  };
  w.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(String(e.data)); } catch (_) { return; }
    handleEvent(ev).catch(err => console.error('[event] 处理异常:', err.message));
  };
  w.onclose = () => {
    wsState = 'offline';
    console.log('⚠️ WebSocket 断开，5 秒后重连...');
    setTimeout(connect, 5000);
  };
  w.onerror = (err) => {
    console.error('[ws] 错误:', (err && err.message) || '未知（等待 close 后重连）');
  };
}

// ---------- 主流程 ----------
async function main() {
  console.log('=== qq-reply 被@回复服务启动 ===');
  console.log('BOT_UIN =', BOT_UIN || '（未设置！将无法识别 @，请检查 docker-compose 环境变量）');
  if (!BOT_UIN) {
    console.error('❌ BOT_UIN 未设置，进程退出。');
    process.exit(1);
  }
  await napcat('/get_login_info', {}).then(ok => {
    console.log(ok ? '✅ 机器人 HTTP API 在线' : '⚠️ HTTP API 暂不可用（NapCat 可能还在启动，WS 连接会持续重试）');
  });
  connect();

  // 每日汇总定时器：每天 DAILY_PUSH_HOUR:DAILY_PUSH_MIN 用召回消息给 owner 发当日重要资讯
  // （走网关 /send_wakeup；要求当天有互动，失败次日重试）
  let lastDaily = '';
  setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (lastDaily === today) return;
    if (now.getHours() === DAILY_PUSH_HOUR && now.getMinutes() >= DAILY_PUSH_MIN && now.getMinutes() < DAILY_PUSH_MIN + 10) {
      lastDaily = today;
      sendDailySummary();
    }
  }, 60 * 1000);
}

// 仅当直接运行本文件时才启动服务；被 require 时暴露内部函数（供测试/复用）
if (require.main === module) {
  main();
}

module.exports = { handleEvent, routeCommand, parseMessage, loadConfig, sendReply, cmdStatus, cmdPreview, extractMagnet, genHardwareStats, CONFIG, BOT_UIN };
