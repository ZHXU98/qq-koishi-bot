// ============================================================
// NapCat 网关：HTTP API / 消息发送 / 消息解析 / 主人权限
// ============================================================
const { NAPCAT_URL, TOKEN, BOT_UIN, CONFIG } = require('./config');
const { sleep } = require('./utils');

const SEND_TIMEOUT_MS = Number(process.env.NAPCAT_SEND_TIMEOUT_MS || 12000);

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
      // 单次发送必须有上限，避免网关半开连接让整个命令链路永久等待。
      const r = await fetch(NAPCAT_URL + ep, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
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

// 逐张发送预览图（官方通道一条消息只能一张图；已走官方网关，无需 NapCat 频控，间隔 0）
// images 最多 10 张；可选先发 text（一条文本消息），再每张图单独一条消息
async function sendImagesSequential(ev, images, text = '', { delay = 0 } = {}) {
  if (text) await sendReply(ev, text);
  for (const img of (images || []).slice(0, 10)) {
    await sendReply(ev, '', [img]);
    if (delay > 0) await sleep(delay);
  }
}

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

let __ownerBind = { at: 0, openid: '' };
async function ownerOpenid() {
  if (Date.now() - __ownerBind.at < 60000) return __ownerBind.openid;
  let oid = '';
  try {
    const r = await fetch(NAPCAT_URL + '/bindings', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    oid = String((j && j.data && j.data.owner && j.data.owner.openid) || '');
  } catch (_) { /* 网关不可达时退化为「只按 QQ 号比对」，不阻塞指令 */ }
  __ownerBind = { at: Date.now(), openid: oid };
  return oid;
}
function ownerList() { return (CONFIG.owners || []).map(v => String(v).trim()).filter(Boolean); }
// 是否主人（异步：含 openid 兜底）。fail-closed —— owners 未配置且 openid 对不上时一律拒绝。
async function isOwnerCtx(ctx = {}) {
  if (ctx.isOwner) return true;
  const uid = String(ctx.uid || '').trim();
  if (!uid) return false;
  if (ownerList().includes(uid)) return true;
  const oid = await ownerOpenid();
  return !!oid && uid === oid;
}
function ownerDeniedMsg() {
  return ownerList().length
    ? '🛡️ 组合的增删改仅限机器人主人'
    : '🛡️ 组合的增删改仅限机器人主人；当前未配置 owners，请在 reply/config.json 中填写 owners 名单';
}

module.exports = { SEND_TIMEOUT_MS, napcat, sendReply, sendImagesSequential, parseMessage, ownerOpenid, ownerList, isOwnerCtx, ownerDeniedMsg };
