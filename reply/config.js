// ============================================================
// 配置模块：环境变量 + 热加载配置（config.json）
// ============================================================
const fs = require('fs');
const path = require('path');

const WS_URL = process.env.NAPCAT_WS_URL || 'ws://127.0.0.1:3101';
const NAPCAT_URL = process.env.NAPCAT_URL || 'http://127.0.0.1:3100';
const TOKEN = process.env.NAPCAT_TOKEN || '';
const BOT_UIN = String(process.env.BOT_UIN || '');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
  groupAtOnly: true,
  privateAlways: true,
  admins: [],                // 管理员（群聊中不受指令限制）。只认主人 QQ 号 + 其他用户的 openid
  owners: [],                // 机器人主人（写操作唯一凭据，如 /stocks 的 -add/-update/-del）；填 QQ 号；空数组 = 谁都不能写
  privateWhitelist: [],
  groupWhitelist: [],        // 群白名单：空数组=不限制；非空=仅响应列表内群（如 ["528165429"]）
  groupAdminOnly: false,     // 群聊仅管理员可触发（非管理员消息一律不响应）
  groupRestrictedCmds: [],
  groupImages: false, // 群聊预览是否带图：腾讯对群聊批量图片有安全审核（涉黄会静默超时），默认 false=群聊只发文本，图片私聊补发
  restrictedMsg: '⚠️ 该指令仅限管理员使用',
  deniedMsg: '🛡️ 本机器人仅对授权账号开放',
  unknownMsg: '未知指令，发送 /help 查看可用指令',
  welcome: '👋 你好，我是机器人助手。群聊请 @我 + 指令，私聊可直接发送指令；发送 /help 查看全部指令。',
  tFees: {
    stockCommissionRate: 0.0008,
    stockMinCommission: 5,
    stockStampDutyRate: 0.001,
    stockTransferRate: 0.0004,
    fundRoundTripRate: 0.0002,
  },
};
// 保持对象身份稳定：index/gateway 等模块会在启动时持有 CONFIG 引用；
// 热加载只能原地写入，不能整体替换对象。
const CONFIG = { ...DEFAULTS };
function loadConfig() {
  let next = { ...DEFAULTS };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        next = { ...DEFAULTS, ...parsed, tFees: { ...DEFAULTS.tFees, ...(parsed.tFees || {}) } };
      }
    }
  } catch (e) {
    console.error('[config] 读取失败（恢复默认）:', e.message);
  }
  // codeflicker-fix: LOGIC-Issue-001/88kfhqxizxofpamlat74
  Object.assign(CONFIG, next);
  return CONFIG;
}
loadConfig();

const STARTED_AT = Date.now();

module.exports = { WS_URL, NAPCAT_URL, TOKEN, BOT_UIN, CONFIG_PATH, STARTED_AT, DEFAULTS, CONFIG, loadConfig };
