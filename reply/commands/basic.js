// ============================================================
// 基础指令：/help /ping /status /echo
// ============================================================
const { NAPCAT_URL, TOKEN, STARTED_AT, BOT_UIN, CONFIG } = require('../config');
const { uptimeText, nowText, sleep } = require('../utils');
const { napcat } = require('../gateway');

// ---------- 指令实现 ----------
function cmdHelp() {
  return [
    '📋 指令菜单',
    '群聊：@我 + 指令；私聊：直接发送',
    '',
    '📈 行情',
    '/ss  市场总览',
    '/stock [周期] <代码或名称>  K线/分时/美股盘前',
    '  周期：-d 日 / -w 周 / -M 月 / -1m / -5m / -30m / -1h / -t 分时 / -pre 美股盘前',
    '/fc [周期] <品种或合约>  国内期货K线/分时（如 生猪2701、螺纹钢、IF2612）',
    '  周期：-d 日（默认）/ -w 周 / -M 月 / m 1分 / 5m / 15m / 30m / 60m / -t 分时',
    '  不写月份=主力连续（生猪→LH0）；郑商所可写 3 位月份（TA701）',
    '/stocks [周期] <组合名或股票...>  组合图（-t/-pre/-d/-w/-m）',
    '/stocks -list  组合清单；-add/-update/-del 仅主人',
    '/zj <1|2> [3|5|10|15|20|30|60|120]  行业近N日资金流；留空=当前排行',
    '/zjl <股票或ETF>  个股已完成交易日资金流（主力/超大单/大单/中单/小单+3~120日）',
    '/info <代码或名称> [条数]  A股资料',
    '/etfinfo <代码或名称>  ETF持仓',
    '/t <代码或名称> [-sw|-tr]  做T参谋',
    '/an <代码或名称>  多周期分析',
    '',
    '📰 /快讯  最新重要资讯',
    '',
    '🛠️ /ping  /status  /echo <内容>',
    '/preview <磁力链接或40位hash>  磁力预览（仅管理员）',
    '/help  显示本菜单',
  ].join('\n');
}
function cmdPing() {
  return `🏓 Pong! 服务存活正常（运行 ${uptimeText(Date.now() - STARTED_AT)}，${nowText()}）`;
}
async function cmdStatus(wsState) {
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

module.exports = { cmdHelp, cmdPing, cmdStatus, cmdEcho };
