// ============================================================
// 基础指令：/help /ping /status /echo
// ============================================================
const { NAPCAT_URL, TOKEN, STARTED_AT, BOT_UIN, CONFIG } = require('../config');
const { uptimeText, nowText, sleep } = require('../utils');
const { napcat } = require('../gateway');

// ---------- 指令实现 ----------
function cmdHelp() {
  return [
    '📋 机器人指令菜单',
    '群聊：@我 + 指令；私聊：直接发送',
    '',
    '📈 行情',
    '/ss   指数行情图（上证/沪深300/全市场成交额/申万二级资金流）',
    '/stock <周期> <代码或名称>  K线图 / 行情速查',
    '        周期：-d 日线 / -w 周线 / -M 月线（均线+BOLL）/ -1m / -5m / -30m / -1h / -t 分时',
    '        例：/stock -d 600519　/stock -5m 贵州茅台　/stock -t 00700　/stock AAPL',
    '        支持 A股/港股/美股/ETF；港股 -d/-t；美股 -d/-t（盘后显示上个交易日）',
    '        国际商品 日/周/月/分时：/stock -d 黄金　/stock -w 布伦特原油　/stock -t 黄金；指数文本速查：/stock 道琼斯　/stock 恒指',
    '/stocks <周期> <组合名 或 股票...>   股票组合拼图（一图多看）',
    '        周期（单选）：-t 分时 / -d 日线 / -w 周线 / -m 月线（不写默认日线）',
    '        例：/stocks -d 我的持仓　/stocks -t 600519 000858　/stocks -w 贵州茅台 宁德时代',
    '/stocks -list   组合清单（只列名称+只数；-list <组合名> 看成分）',
    '        编辑类（仅机器人主人）：-add 新建/覆盖　-update 整组替换　-del 删除',
    '        例：/stocks -add 600519 300750 -name 我的持仓',
    '        　　/stocks -update 我的持仓 600519 300750 002594',
    '        　　/stocks -del 我的持仓',
    '/zj <1|2> [t|d]   行业资金流：留空=当前排行TOP10；t=分时波动曲线；d=日级流入曲线',
    '        例：/zj 2　/zj 1 t　/zj 2 d（曲线图为东财行业分类，申万无免费时序源）',
    '/info <代码或名称> [条数]   个股速查（仅A股）：行情/公司概况/公告/新闻',
    '        如 /info 600519　/info 平安银行 6（公告+新闻各 N 条，默认 3+5）',
    '/etfinfo <代码或名称>   ETF速查：前十持仓+跟踪指数（非ETF会明确提示）',
    '        例：/etfinfo 510300　/etfinfo 沪深300ETF　/etfinfo 纳指ETF　/etfinfo 600519',
    '/t <代码或名称> [-sw 震荡] [-tr 单边]   做T参谋：分时黄线+日线结构分析，给出T位建议',
    '        例：/t 600519　/t 贵州茅台 -sw　/t 宁德时代 -tr',
    '/an <代码或名称>   多周期技术分析：日线/周线/月线 + MA/BOLL/MACD/量价 + 综合图',
    '        例：/an 600519　/an 兆易创新　/an 红利低波',
    '',
    '📰 资讯',
    '/快讯   最新重要资讯（最近 10 条）',
    '',
    '🛠️ 工具',
    '/ping   存活检测　/status 服务状态',
    '/echo <内容>   复读',
    '/preview <磁力链接或40位hash>   磁力预览（仅管理员）',
    '/help   显示本菜单',
    '',
    '💡 直接发一条磁力链接（magnet:?xt=...）也能自动预览',
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
