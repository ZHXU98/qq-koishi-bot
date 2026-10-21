#!/usr/bin/env node
// qq-reply —— NapCat QQ 机器人「被@回复 + 指令」服务（零依赖）
//
// 职责：连接 NapCat 正向 WebSocket（事件上报），接收消息事件；检测「被 @」与
//       「指令前缀」，通过 NapCat HTTP API 回复。
//       群聊：仅响应被 @ 机器人的消息（@ 后跟指令）；私聊：所有消息均响应。
//
// 依赖：Node >= 21（内置全局 WebSocket 客户端与 fetch），无需 npm install
//
// 环境变量（变量名沿用 NapCat 时代命名，现指向官方 QQ 机器人网关）：
//   NAPCAT_WS_URL   ws://official-bot-gateway:3101   事件通道（OneBot 风格 WS）
//   NAPCAT_URL      http://official-bot-gateway:3100 发送地址（OneBot 兼容 HTTP）
//   NAPCAT_TOKEN    (空)               access token（若启用）
//   BOT_UIN         机器人标识（识别 @ 用，docker-compose 传 ${QQBOT_APP_ID}）
//
// 配置文件 config.json（热加载：每次收到消息重新读盘，改完无需重启）：
//   groupAtOnly:         群聊仅响应被 @ 的消息（默认 true）
//   privateAlways:       私聊总是响应（默认 true）
//   admins:              管理员 QQ/openid 列表（群聊中不受指令限制）
//   owners:              机器人主人列表（写操作唯一凭据，如 /stocks 的 -add/-update/-del）；
//                        填 QQ 号即可。网关只会把 bindings.owner 还原成纯 QQ 号，其余用户
//                        的 user_id 是 openid；故代码另取网关 owner.openid 做兜底比对
//                        （60 秒缓存），bindings 被重置时主人不会被锁在门外。
//   privateWhitelist:    私聊白名单（非列表内账号私聊一律拒绝；空数组 = 不限制）
//   groupRestrictedCmds: 群聊中非管理员可用的指令名白名单（如 ["ping","status"]；空数组 = 不限制）
//   restrictedMsg:       群聊非管理员使用受限指令时的提示
//   deniedMsg:           私聊非白名单账号的拒绝提示（置空字符串则完全忽略不回复）
//   unknownMsg:          未识别指令时的提示文本
//   welcome:             非指令消息的引导语（置空字符串则忽略不回复）

// ============================================================
// 入口：装配各模块并启动（模块拆分见 2026-09-11 重构）
//   config.js    环境变量与热加载配置
//   utils.js     通用工具（时间/缓存/格式化）
//   gateway.js   NapCat 网关（HTTP/WS/主人权限）
//   market.js    行情数据层（代码解析/K线/指标/全球商品）
//   futures.js   国内期货数据层（品种表/合约解析/快照/K线）
//   forex.js    外汇数据层（货币对解析/24小时分时/日线）
//   commands/*   各指令域（ss/stock/stocks/fc/fx/zj/info/preview/news/t/basic）
// ============================================================
const fs = require('fs');
const path = require('path');

// 配置与工具
const { WS_URL, NAPCAT_URL, TOKEN, BOT_UIN, CONFIG_PATH, STARTED_AT, DEFAULTS, CONFIG, loadConfig } = require('./config');
const { sleep, uptimeText, nowText, extractMagnet } = require('./utils');
// 网关
const { napcat, sendReply, sendImagesSequential, parseMessage, ownerOpenid, ownerList, isOwnerCtx, ownerDeniedMsg } = require('./gateway');
// 快讯/每日汇总
const { NEWS_QUERY_LIMIT, DAILY_PUSH_HOUR, DAILY_PUSH_MIN, DAILY_PUSH_ENABLED, fetchImportantNews, formatNewsReply, cmdNews, sendDailySummary } = require('./commands/news');
// 指令域
const { cmdHelp, cmdPing, cmdStatus, cmdEcho } = require('./commands/basic');
const { cmdSS } = require('./commands/ss');
const { cmdStock } = require('./commands/stock');
const { cmdStocks } = require('./commands/stocks');
const { cmdFc } = require('./commands/fc');
const { cmdFx } = require('./commands/fx');
const { cmdInfo, cmdEtfInfo } = require('./commands/info');
const { cmdZj } = require('./commands/zj');
const { cmdPreview } = require('./commands/preview');
const { cmdT } = require('./commands/t');
const { cmdAn } = require('./commands/an');
const { cmdZjl } = require('./commands/zjl');

let wsState = 'idle';
let reconnectTimer = null; // WS 重连定时器（连接失败时 ws 库可能不触发 onclose，必须独立调度）
let curSocket = null;      // 当前 WS（僵尸检测/迟到回调只作用于它）
let staleTimer = null;     // 僵尸连接检测定时器
let lastPushAt = 0;        // 上次收到任何推送（含网关心跳）的时刻
// 网关每 GW_HEARTBEAT_MS（默认 30s）下发一次 meta_event 心跳；超过阈值仍收不到任何推送，
// 说明连接已半开（宿主休眠/切网后 onclose 常不触发）→ 主动断开重连。
const STALE_PUSH_MS = Number(process.env.WS_STALE_MS || 90000);
const STALE_CHECK_MS = Number(process.env.WS_STALE_CHECK_MS || 15000);
const ts = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const { initChartFonts } = require('./chart-fonts');
initChartFonts();

// ---------- 指令路由 ----------
function routeByWord(raw, parts) {
  switch (raw) {
    case 'help': case '菜单': return { name: 'help', type: 'text', text: cmdHelp() };
    case 'ping': case '存活': return { name: 'ping', type: 'text', text: cmdPing() };
    case 'status': case '状态': return { name: 'status', type: 'status' };
    case 'echo': case '复读': return { name: 'echo', type: 'text', text: cmdEcho(parts) };
    case 'preview': case '预览': case '磁力预览': case 'seed': return { name: 'preview', type: 'preview', text: parts.join(' ') };
    case '快讯': case 'news': case '资讯': return { name: 'news', type: 'news' };
    case 'ss': case '指数': return { name: 'ss', type: 'ss' };
    case 'stock': case '股票': case 'K线': case 'k线': return { name: 'stock', type: 'stock', args: parts };
    case 'fc': case '期货': return { name: 'fc', type: 'fc', args: parts };
    case 'fx': case '外汇': case '汇率': return { name: 'fx', type: 'fx', args: parts };
    case 'stocks': case '组合': case '自选': return { name: 'stocks', type: 'stocks', args: parts };
    case 'zj': case '资金': return { name: 'zj', type: 'zj', args: parts };
    case 'info': case '个股': case '资料': return { name: 'info', type: 'info', args: parts };
    case 'etfinfo': case 'etf': case '基金持仓': return { name: 'etfinfo', type: 'etfinfo', args: parts };
    case 't': case '做t': case '做T': case 'doT': return { name: 't', type: 't', args: parts };
    case 'an': case '分析': case '技术分析': return { name: 'an', type: 'an', args: parts };
    case 'zjl': case 'flow': case '资金流': case '资金流向': return { name: 'zjl', type: 'zjl', args: parts };
    default: return null;
  }
}

function routeCommand(text) {
  const parts = text.split(/\s+/);
  const raw = (parts.shift() || '').toLowerCase().replace(/^[\/／]/, '');
  const hit = routeByWord(raw, parts);
  if (hit) return hit;
  // 容错：手机端容易漏掉「命令」与「-参数」之间的空格（曾把 /stock -t 打成 stock-t 被整条静默丢弃）
  // → 在第一个减号处切开重试一次，减号部分塞回参数最前面
  const di = raw.indexOf('-');
  if (di > 0 && raw.length > di + 1) {
    const retried = routeByWord(raw.slice(0, di), [raw.slice(di), ...parts]);
    if (retried && retried.args) return retried; // 只对「带参数」的命令生效，避免 preview/echo 之类误命中
  }
  return null;
}

// ---------- 事件处理 ----------
async function handleEvent(ev) {
  if (!ev || ev.post_type !== 'message') return; // 仅处理消息事件
  loadConfig(); // 每次收到消息重新读盘：改 config.json 无需重启立即生效
  const { atMe, atAny, text } = parseMessage(ev.message);
  if (!text) return; // 纯 @ 无文字（或只有图片/表情）→ 不打扰

  const uid = String(ev.user_id ?? '');
  // 注意：官方通道下网关只把「主人」的 openid 反查成 QQ 号（gateway 的 qqByOpenid 只认 bindings.owner），
  // 其他用户事件里的 user_id 是 **openid**。所以 admins 若要给非主人放权，必须填 TA 的 openid，填 QQ 号永远不匹配。
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
    // 群白名单：非空时仅响应指定群
    const gw = CONFIG.groupWhitelist || [];
    if (gw.length > 0 && !gw.includes(String(ev.group_id))) return;
    // 群聊仅管理员：非管理员一律不响应
    if (CONFIG.groupAdminOnly && !isAdmin) return;
    // 群聊仅响应被 @；例外：管理员直接发磁链也触发自动预览（普通成员仍须 @）
    if (CONFIG.groupAtOnly && !atMe && !(isAdmin && autoMg)) {
      // 仅当「确实 @ 了但没被识别」才记一笔（BOT_UIN 与网关 at 标识不一致是 @ 无反应的经典原因）；
      // 普通未 @ 的消息不记录，避免刷屏。
      if (atAny) console.log(`[msg] ${ts()} 群消息已 @ 但未被识别（BOT_UIN=${BOT_UIN || '(未设置)'}）→ 忽略`);
      return;
    }
  } else {
    return; // 其它消息类型（讨论组等）暂不处理
  }

  const scopeText = ev.message_type === 'group' ? '群' : '私聊';
  let cmd = routeCommand(text);
  if (!cmd) {
    if (autoMg) {
      // 含磁力链接：自动预览（权限同 /preview）
      cmd = { name: 'preview', type: 'preview', text: autoMg };
    } else {
      // 群聊/私聊统一：非特定指令的消息（闲聊等）一律忽略，不打扰
      console.log(`[msg] ${ts()} ${scopeText} 未识别指令 → 忽略`);
      return;
    }
  }
  // 只记路由结果（指令名），不记正文
  console.log(`[msg] ${ts()} ${scopeText} → /${cmd.name}`);

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
    await sendReply(ev, await cmdStatus(wsState));
  } else if (cmd.type === 'news') {
    // 被动 /快讯：固定最近 10 条重要资讯，使用 RSS 同款主题/等级卡片，一张长图承载。
    const r = await cmdNews();
    if (r.ok && r.img) await sendReply(ev, '', [r.img]);
    else await sendReply(ev, r.text || '⚠️ 快讯获取失败');
  } else if (cmd.type === 'ss') {
    const r = await cmdSS();
    if (r.ok && r.img) {
      await sendReply(ev, '', [r.img]); // 只发图，信息都在图上
    } else {
      await sendReply(ev, r.text || '⚠️ 行情获取失败');
    }
  } else if (cmd.type === 'stock') {
    const r = await cmdStock(cmd.args);
    if (r.ok && r.img) {
      // 多候选时仍只发送一条图文消息；候选字符串作为图片消息 content 附带。
      await sendReply(ev, r.note || '', [r.img]);
    } else {
      await sendReply(ev, r.text || '⚠️ 图表生成失败');
    }
  } else if (cmd.type === 'fc') {
    // /fc 国内期货：文字（含主力连续提示/持仓成交）+ K线图一条消息下发
    const r = await cmdFc(cmd.args);
    if (r.ok && r.img) await sendReply(ev, r.text || '', [r.img]);
    else await sendReply(ev, r.text || '⚠️ 期货行情获取失败');
  } else if (cmd.type === 'fx') {
    const r = await cmdFx(cmd.args);
    if (r.ok && r.img) await sendReply(ev, '', [r.img]);
    else await sendReply(ev, r.text || '⚠️ 外汇行情获取失败');
  } else if (cmd.type === 'stocks') {
    const r = await cmdStocks(cmd.args, { isAdmin, uid });
    if (r.ok && r.img) {
      await sendReply(ev, '', [r.img]); // 只发图，信息都在图上
      if (r.note) await sendReply(ev, r.note); // 截断/失败等提示另发一条
    } else {
      await sendReply(ev, r.text || '⚠️ 生成失败');
    }
  } else if (cmd.type === 'zj') {
    const r = await cmdZj(cmd.args);
    if (r.ok && r.img) {
      await sendReply(ev, '', [r.img]); // 只发图
    } else {
      await sendReply(ev, r.text || '⚠️ 资金流获取失败');
    }
  } else if (cmd.type === 'info') {
    const r = await cmdInfo(cmd.args);
    await sendReply(ev, r.text || '⚠️ 个股信息获取失败');
  } else if (cmd.type === 'etfinfo') {
    const r = await cmdEtfInfo(cmd.args);
    await sendReply(ev, r.text || '⚠️ ETF 信息获取失败');
  } else if (cmd.type === 't') {
    // /t 做T参谋：直接发文字分析，再发图
    const r = await cmdT(cmd.args);
    if (!r.ok) {
      await sendReply(ev, r.text || '⚠️ 做T分析失败');
    } else {
      if (r.reportImg) await sendReply(ev, '', [r.reportImg]);
      else await sendReply(ev, r.detailText || r.text);
      if (r.img) await sendReply(ev, '', [r.img]);
    }
  } else if (cmd.type === 'an') {
    // /an：完整文字分析长图 → 多周期技术图
    const r = await cmdAn(cmd.args);
    if (!r.ok) {
      await sendReply(ev, r.text || '⚠️ 多周期分析失败');
    } else {
      if (r.reportImg) await sendReply(ev, '', [r.reportImg]);
      else await sendReply(ev, r.detailText || r.text);
      if (r.img) await sendReply(ev, '', [r.img]);
    }
  } else if (cmd.type === 'zjl') {
    const r = await cmdZjl(cmd.args);
    if (!r.ok) {
      await sendReply(ev, r.text || '⚠️ 个股资金流获取失败');
    } else {
      if (r.img) await sendReply(ev, '', [r.img]);
      else await sendReply(ev, r.text || '⚠️ 资金流图片生成失败');
    }
  } else {
    await sendReply(ev, cmd.text);
  }
}

// ---------- WebSocket 事件通道（断线自动重连） ----------
function connect() {
  wsState = 'connecting';
  console.log(`[ws] 连接 ${WS_URL} ...`);
  const w = new WebSocket(WS_URL);
  curSocket = w;
  lastPushAt = Date.now();
  let connected = false;
  // 统一重连调度：error/close 都可能触发，用定时器防重复；连接失败不依赖 onclose（网关未就绪时常见）
  const scheduleReconnect = () => {
    if (curSocket !== w) return; // 已被更新的连接取代，忽略旧连接的迟到回调
    if (reconnectTimer) return;
    wsState = 'offline';
    console.log(`⚠️ WebSocket ${connected ? '断开' : '连接失败'}，5 秒后重连...`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  };
  w.onopen = () => {
    connected = true;
    wsState = 'online';
    lastPushAt = Date.now();
    console.log('✅ WebSocket 已连接', WS_URL);
  };
  w.onmessage = (e) => {
    lastPushAt = Date.now(); // 任何入站（含网关心跳 meta_event）都算「连接活着」
    let ev;
    try { ev = JSON.parse(String(e.data)); } catch (_) { return; }
    handleEvent(ev).catch(err => console.error('[event] 处理异常:', err.message));
  };
  w.onclose = () => scheduleReconnect();
  w.onerror = (err) => {
    console.error('[ws] 错误:', (err && err.message) || '未知');
    scheduleReconnect();
  };
  // 僵尸连接检测：半开的 TCP 不会触发 onclose，只能靠「长时间收不到任何推送」判定
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    if (curSocket !== w || wsState !== 'online') return;
    const idle = Date.now() - lastPushAt;
    if (idle <= STALE_PUSH_MS) return;
    console.log(`⚠️ WebSocket 已 ${Math.round(idle / 1000)}s 收不到任何推送（疑似半开连接），主动断开重连...`);
    try { w.close(); } catch (_) { /* ignore */ }
    scheduleReconnect(); // close 未触发 onclose 时的兜底（reconnectTimer 已去重）
  }, STALE_CHECK_MS);
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
  // 2026-08-31：默认关闭（DAILY_PUSH_ENABLED 未设/非 true 时不注册定时器）
  let lastDaily = '';
  if (DAILY_PUSH_ENABLED) {
    setInterval(() => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (lastDaily === today) return;
      if (now.getHours() === DAILY_PUSH_HOUR && now.getMinutes() >= DAILY_PUSH_MIN && now.getMinutes() < DAILY_PUSH_MIN + 10) {
        lastDaily = today;
        sendDailySummary();
      }
    }, 60 * 1000);
  } else {
    console.log('[news] 每日汇总推送已关闭（DAILY_PUSH_ENABLED 未启用）');
  }
}

// 仅当直接运行本文件时才启动服务；被 require 时暴露内部函数（供测试/复用）
if (require.main === module) {
  main();
}

module.exports = {
  handleEvent, routeCommand, parseMessage, loadConfig, sendReply,
  cmdStatus, cmdPreview, cmdStock, cmdStocks, cmdSS, cmdZj, cmdInfo, cmdEtfInfo, cmdHelp, cmdT, cmdAn, cmdZjl, cmdFc, cmdFx,
  extractMagnet, genHardwareStats: require('./commands/basic').genHardwareStats,
  fetchStockKline: require('./market').fetchStockKline,
  fetchStockQuote: require('./market').fetchStockQuote,
  buildAvgLine: require('./market').buildAvgLine,
  CONFIG, BOT_UIN, WS_URL, NAPCAT_URL, TOKEN,
};