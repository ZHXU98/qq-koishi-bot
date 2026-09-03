// official-bot-gateway —— 官方 QQ 机器人网关（OneBot 兼容层）
//
// 定位：以官方开放平台（appid + appsecret）替换 NapCat，作为 ths-news / qq-reply /
//       a-share-report / monitor 的统一消息入口。对外暴露与 NapCat OneBot 兼容的
//       HTTP + WebSocket 接口，现有服务几乎零改动即可切换（把 NAPCAT_URL 指向本网关）。
//
// 能力：
//   HTTP（OneBot 兼容，端口 GW_HTTP_PORT 默认 3100）
//     POST /send_private_msg  {user_id, message}            私聊发送（user_id 支持 QQ号[仅owner] 或 openid）
//     POST /send_group_msg    {group_id, message}           群聊发送（group_id 为群 openid）
//     POST /send_msg          {message_type, user_id|group_id, message}
//     POST /get_login_info                                   返回官方机器人信息（恒在线）
//     POST /get_status                                       {online:true, good:true}
//     GET  /bindings                                         查看已学习的 openid 绑定
//   WebSocket（端口 GW_WS_PORT 默认 3101）
//     将官方消息事件翻译为 OneBot 风格事件推送（供 qq-reply 等订阅）
//
// 关键设计：
//   - openid 学习：官方 API 只认 openid（不认 QQ 号）。私聊机器人发送 "bind-owner"（见
//     GW_OWNER_TOKEN）可把该 openid 绑定为管理员（OWNER_QQ）；群消息/私聊消息到达即自动
//     记录 openid，可通过 GET /bindings 查看后手动写入 bindings.json 补全映射。
//   - 消息翻译：OneBot array（text / image[base64://]）→ 官方 sendText / sendImage（自动上传）。
//   - 主动推送：target 不带 msgId 即主动消息（受官方配额限制：单聊 1000 条/用户/天，群 1000 条/群/天）。
//   - 被动回复：事件转发带 msgId，下游 send_private_msg/send_group_msg 若携带 msg_id 字段则走被动回复。
//
// 环境变量：
//   QQBOT_APP_ID / QQBOT_APP_SECRET   官方机器人凭证（必填）
//   OWNER_QQ                          管理员 QQ 号（默认 1547450303，用于 owner 逆向映射）
//   GW_OWNER_TOKEN                    绑定 owner 的口令（默认 bind-owner）
//   GW_HTTP_PORT / GW_WS_PORT         监听端口（默认 3100 / 3101）
//   GW_BIND_FILE                      bindings 持久化路径（默认 ./bindings.json）

import { QQBot, MediaFileType } from '@tencent-connect/qqbot-nodejs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = process.env.QQBOT_APP_ID || '';
const APP_SECRET = process.env.QQBOT_APP_SECRET || '';
const OWNER_QQ = process.env.OWNER_QQ || '1547450303';
const OWNER_TOKEN = process.env.GW_OWNER_TOKEN || 'bind-owner';
const HTTP_PORT = Number(process.env.GW_HTTP_PORT || 3100);
const WS_PORT = Number(process.env.GW_WS_PORT || 3101);
const BIND_FILE = process.env.GW_BIND_FILE || path.join(__dirname, 'bindings.json');

// ==================== bindings：openid 学习与持久化 ====================
// { owner: {openid, qq}, users: { [openid]: {qq?, firstSeen} }, groups: { [groupOpenid]: {name?, firstSeen} } }
function loadBindings() {
  try { return JSON.parse(fs.readFileSync(BIND_FILE, 'utf8')); }
  catch { return { owner: { openid: '', qq: OWNER_QQ }, users: {}, groups: {} }; }
}
let bindings = loadBindings();
function saveBindings() {
  try { fs.writeFileSync(BIND_FILE, JSON.stringify(bindings, null, 2)); }
  catch (e) { console.error('[bindings] 保存失败:', e.message); }
}
function learnUser(openid, qq = '') {
  if (openid && !bindings.users[openid]) {
    bindings.users[openid] = { qq, firstSeen: new Date().toISOString() };
    saveBindings();
    console.log('[bindings] 新用户 openid 已学习:', openid, qq ? `(${qq})` : '');
  }
}
function learnGroup(openid, name = '') {
  if (openid && !bindings.groups[openid]) {
    bindings.groups[openid] = { name, firstSeen: new Date().toISOString() };
    saveBindings();
    console.log('[bindings] 新群 openid 已学习:', openid, name ? `(${name})` : '');
  }
}
function bindOwner(openid) {
  bindings.owner = { openid, qq: OWNER_QQ };
  saveBindings();
  console.log(`[bindings] ✅ 管理员已绑定: openid=${openid} qq=${OWNER_QQ}`);
}
// QQ号 → openid（仅 owner 支持，其余 QQ 号无法反查，需手动配置 bindings.users）
function openidByQq(qq) {
  const o = String(qq);
  if (o === OWNER_QQ && bindings.owner.openid) return bindings.owner.openid;
  for (const [oid, u] of Object.entries(bindings.users)) if (u.qq && String(u.qq) === o) return oid;
  return '';
}
// QQ 群号 → 群 openid（官方事件只有群 openid 无群号，需在 bindings.groups 手动补 qq 字段；
// 例：GET /bindings 查看群 openid 后，在 bindings.json 的 groups 里给对应项加 "qq": "609994072"）
function groupOpenidByQq(qq) {
  const g = String(qq);
  for (const [oid, grp] of Object.entries(bindings.groups)) if (grp.qq && String(grp.qq) === g) return oid;
  return '';
}
// openid → QQ 号（逆向，供事件翻译时把 owner 显示成 QQ 号）
function qqByOpenid(oid) {
  if (bindings.owner.openid === oid) return bindings.owner.qq;
  const u = bindings.users[oid];
  return u?.qq || '';
}

// ==================== OneBot 消息解析 ====================
// message 支持：字符串 / [{type:'text',data:{text}}, {type:'image',data:{file:'base64://...'|'http://...'}}]
function parseOneBotMessage(message) {
  let segs = [];
  if (typeof message === 'string') segs = [{ type: 'text', data: { text: message } }];
  else if (Array.isArray(message)) segs = message;
  else if (message && typeof message === 'object') segs = [message];
  const texts = [];
  const images = [];
  for (const s of segs) {
    if (!s || !s.type) continue;
    if (s.type === 'text') texts.push(s.data?.text || '');
    else if (s.type === 'image') {
      const f = s.data?.file || s.data?.url || '';
      images.push(f);
    }
  }
  return { text: texts.join(''), images };
}

// ==================== 官方机器人 ====================
if (!APP_ID || !APP_SECRET) {
  console.error('❌ 缺少 QQBOT_APP_ID / QQBOT_APP_SECRET 环境变量，退出。请在 .env 配置后重启。');
  process.exit(1);
}

const bot = new QQBot({ appId: APP_ID, appSecret: APP_SECRET, logger: console });

bot.on('ready', (d) => console.log('✅ 官方机器人已连接 Gateway, sessionId:', d?.sessionId || ''));
bot.on('resumed', () => console.log('↻ 已重连'));
bot.on('error', (e) => console.error('[bot] 错误:', e?.message || e));

// ---------- 入站消息：学习 openid + 翻译为 OneBot 事件推送 ----------
bot.on('message', async (ctx, msg) => {
  try {
    const kind = msg.kind; // c2c | group | guild | dm
    if (kind === 'c2c') {
      learnUser(msg.senderId);
      // owner 绑定口令
      if (msg.content && msg.content.trim() === OWNER_TOKEN) {
        bindOwner(msg.senderId);
        await bot.sendText(msg.replyTarget, `✅ 已绑定为管理员（QQ ${OWNER_QQ}）。`);
        return;
      }
    } else if (kind === 'group') {
      learnGroup(msg.groupOpenid || '');
    } else {
      return; // 频道/私信暂不处理
    }

    // 业务指令（快讯等）已迁移至 qq-reply 容器统一处理；网关只负责事件转发与发送通道
    const onebot = {
      post_type: 'message',
      self_id: APP_ID,
      time: Math.floor(Date.now() / 1000),
      message_id: msg.messageId,
      message_type: kind === 'group' ? 'group' : 'private',
      user_id: qqByOpenid(msg.senderId) || msg.senderId,
      // 群事件：官方 GROUP_* 事件均为被@触发，转发时补 at 段供下游（qq-reply）识别；
      // at.qq 用官方 APP_ID，下游 BOT_UIN 需保持一致。
      // 注意：官方 content 在@时带 "<@openid> " 前缀标记（2026-08-31 实测），必须剥离，
      //       否则下游把 "<@xxx>" 当命令首词匹配失败（@+指令不回复的根因）。
      text: (msg.content || '').replace(/<@[0-9A-Za-z_]+>/g, '').trim(),
      message: kind === 'group'
        ? [{ type: 'at', data: { qq: String(APP_ID) } }, { type: 'text', data: { text: (msg.content || '').replace(/<@[0-9A-Za-z_]+>/g, '').trim() } }]
        : [{ type: 'text', data: { text: msg.content || '' } }],
      raw_message: (msg.content || '').replace(/<@[0-9A-Za-z_]+>/g, '').trim(),
      sender: { user_id: qqByOpenid(msg.senderId) || msg.senderId, nickname: msg.senderName || '' },
      // 网关私有扩展：供下游被动回复时使用
      _reply: { scope: kind === 'group' ? 'group' : 'c2c', targetId: kind === 'group' ? msg.groupOpenid : msg.senderId, msgId: msg.messageId },
    };
    if (kind === 'group') onebot.group_id = msg.groupOpenid;
    broadcast(onebot);
  } catch (e) {
    console.error('[event] 处理入站消息失败:', e.message);
  }
});

// ==================== 发送翻译 ====================
async function sendToOneBot(params) {
  // params: { message_type?, user_id?, group_id?, message, msg_id? }
  const scope = params.message_type === 'group' || params.group_id ? 'group' : 'c2c';
  const { text, images } = parseOneBotMessage(params.message);

  let target;
  if (scope === 'group') {
    const gid = String(params.group_id || '');
    target = { scope: 'group', targetId: groupOpenidByQq(gid) || gid }; // 支持 QQ 群号或群 openid
  } else {
    const uid = String(params.user_id || '');
    const oid = openidByQq(uid) || uid; // 支持 owner QQ 号或 openid
    if (!oid) return { status: 'failed', retcode: 200, data: null, message: '无法解析用户 openid（请先让用户私聊机器人，或配置 bindings）' };
    target = { scope: 'c2c', targetId: oid };
  }
  if (params.msg_id) target.msgId = params.msg_id; // 带 msg_id = 被动回复

  try {
    let res;
    if (images.length > 0) {
      // 图片：base64:// 前缀 → fileData；否则当 url 或文件路径
      const img = images[0];
      let source;
      if (img.startsWith('base64://')) source = { fileData: img.slice('base64://'.length) };
      else if (/^https?:\/\//i.test(img)) source = { url: img };
      else source = { url: img };
      res = await bot.sendImage(target, source, text ? { content: text } : {});
    } else {
      res = await bot.sendText(target, text || ' ');
    }
    return { status: 'ok', retcode: 0, data: { message_id: res?.id || '' }, message: '', wording: '' };
  } catch (e) {
    console.error('[send] 失败:', e.message);
    return { status: 'failed', retcode: 200, data: null, message: String(e.message || e) };
  }
}

// ==================== HTTP 服务（OneBot 兼容） ====================
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({ _parseError: true, raw: d }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method !== 'POST' && req.method !== 'GET') return sendJson(res, 404, { status: 'failed', retcode: 404, data: null, message: 'Not Found' });

  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body._parseError) return sendJson(res, 400, { status: 'failed', retcode: 400, data: null, message: 'Bad JSON: ' + String(body.raw).slice(0, 100) });

      switch (url) {
        case '/send_private_msg':
          return sendJson(res, 200, await sendToOneBot({ user_id: body.user_id, message: body.message, msg_id: body.msg_id }));
        case '/send_group_msg':
          return sendJson(res, 200, await sendToOneBot({ message_type: 'group', group_id: body.group_id, message: body.message, msg_id: body.msg_id }));
        case '/send_msg':
          return sendJson(res, 200, await sendToOneBot(body));
        case '/get_login_info':
          return sendJson(res, 200, { status: 'ok', retcode: 0, data: { user_id: APP_ID, nickname: `OfficialBot(${APP_ID})`, official: true }, message: '', wording: '' });
        case '/get_status':
          return sendJson(res, 200, { status: 'ok', retcode: 0, data: { online: true, good: true, official: true }, message: '', wording: '' });
        case '/send_wakeup':
          // 手动触发召回消息（C2C，每日最多 1 条，需用户当日有过互动）
          const wOid = openidByQq(body.user_id || '') || bindings.owner.openid;
          if (!wOid) return sendJson(res, 200, { status: 'failed', retcode: 200, data: null, message: 'owner 未绑定 openid' });
          try {
            const wr = await bot.sendWakeup({ scope: 'c2c', targetId: wOid }, String(body.message || ''));
            return sendJson(res, 200, { status: 'ok', retcode: 0, data: { message_id: wr?.id || '' }, message: '', wording: '' });
          } catch (e) {
            return sendJson(res, 200, { status: 'failed', retcode: 200, data: null, message: String(e?.message || e) });
          }
        default:
          return sendJson(res, 404, { status: 'failed', retcode: 404, data: null, message: `Not Found: ${url}` });
      }
    } else {
      if (url === '/bindings') {
        return sendJson(res, 200, { status: 'ok', retcode: 0, data: bindings });
      }
      if (url === '/health') return sendJson(res, 200, { status: 'ok', data: { official: true, ws: wss.clients.size } });
      return sendJson(res, 404, { status: 'failed', retcode: 404, data: null, message: `Not Found: ${url}` });
    }
  } catch (e) {
    console.error('[http] 处理失败:', e.message);
    return sendJson(res, 500, { status: 'failed', retcode: 500, data: null, message: e.message });
  }
});
server.listen(HTTP_PORT, '0.0.0.0', () => console.log(`🌐 网关 HTTP 监听 :${HTTP_PORT} (OneBot 兼容)`));

// ==================== WS 事件转发 ====================
const wss = new WebSocketServer({ port: WS_PORT }, () => console.log(`🔌 网关 WS 监听 :${WS_PORT} (OneBot 事件推送)`));
function broadcast(event) {
  const s = JSON.stringify(event);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

// ==================== 启动 ====================
process.on('SIGINT', () => { console.log('\n退出'); bot.stop(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n退出'); bot.stop(); process.exit(0); });

bot.start().catch((e) => {
  console.error('❌ 机器人启动失败:', e?.message || e);
  process.exit(1);
});
console.log('🚀 official-bot-gateway 启动中…');
