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
let reconnectTimer = null; // WS 重连定时器（连接失败时 ws 库可能不触发 onclose，必须独立调度）

// ---------- 配置（热加载） ----------
const DEFAULTS = {
  groupAtOnly: true,
  privateAlways: true,
  admins: [],
  privateWhitelist: [],
  groupWhitelist: [],        // 群白名单：空数组=不限制；非空=仅响应列表内群（如 ["528165429"]）
  groupAdminOnly: false,     // 群聊仅管理员可触发（非管理员消息一律不响应）
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
// 进程级注册中文字体（@napi-rs/canvas skia，进程内缓存一次永久生效）
// 注册为别名 'cjk'（短名）+ 字体真名 'Hiragino Sans GB W3' 双名
const { GlobalFonts } = require('@napi-rs/canvas');
try { GlobalFonts.registerFromPath('/app/fonts/cjk_sub.ttf', 'cjk'); } catch (_) { /* 不可用时回退 resvg */ }
try { GlobalFonts.registerFromPath('/app/fonts/cjk_sub.ttf'); } catch (_) {}

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

// 逐张发送预览图（官方通道一条消息只能一张图；已走官方网关，无需 NapCat 频控，间隔 0）
// images 最多 10 张；可选先发 text（一条文本消息），再每张图单独一条消息
async function sendImagesSequential(ev, images, text = '', { delay = 0 } = {}) {
  if (text) await sendReply(ev, text);
  for (const img of (images || []).slice(0, 10)) {
    await sendReply(ev, '', [img]);
    if (delay > 0) await sleep(delay);
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
    '📈 行情',
    '/ss   指数行情图（上证/沪深300/全市场成交额/申万二级资金流）',
    '/stock <周期> <代码或名称>  K线图 / 行情速查',
    '        周期：-d 日线 / -w 周线 / -M 月线（均线+BOLL）/ -1m / -5m / -30m / -1h / -t 分时',
    '        例：/stock -d 600519　/stock -5m 贵州茅台　/stock -t 00700　/stock AAPL',
    '        支持 A股/港股/美股/ETF；港股 -d/-t；美股 -d/-t（盘后显示上个交易日）',
    '        商品 -t 分时图：/stock -t 布伦特原油　/stock -t 黄金；指数文本速查：/stock 道琼斯　/stock 恒指',
    '/zj <1|2> [t|d]   行业资金流：留空=当前排行TOP10；t=分时波动曲线；d=日级流入曲线',
    '        例：/zj 2　/zj 1 t　/zj 2 d（曲线图为东财行业分类，申万无免费时序源）',
    '/info <代码或名称> [条数]   个股速查（仅A股）：行情/公司概况/公告/新闻',
    '        如 /info 600519　/info 平安银行 6（公告+新闻各 N 条，默认 3+5）',
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

// ---------- 指数行情（/ss：上证指数 + 沪深300，2026-08-31 新增） ----------
// 数据源：腾讯行情 qt.gtimg.cn（GBK 编码，零鉴权，字段以 ~ 分隔，实时行情）
//         + 同花顺 30 分钟K线 d.10jqka.com.cn（含成交额字段，取上一交易日同时刻累计额，对比放量/缩量）
//         （腾讯 mkline 分钟K只有成交量[手]无成交额，不满足"金额"需求；东财 push2his 容器内不可达）
// 盘中：现价/涨跌/今开/最高/最低/成交额/预计全天成交额/较上一交易日同时刻放量缩量
// 收盘后（>=15:00 或非交易日）：开盘价/收盘价/成交额/较上一交易日全天放量缩量
const SS_QUOTES = 'https://qt.gtimg.cn/q=sh000001,sh000300,sz399106';
// 同花顺 30 分钟K线：周期 41（30min），返回最近 140 根 ≈ 17 个交易日，含成交额（元）
const SS_MIN30 = 'https://d.10jqka.com.cn/v6/line/%s/41/last.js';
// 腾讯代码 → 同花顺代码（sz399106=深证综指，全市场=上证+深证综指）
const SS_THS = { sh000001: 'hs_1A0001', sh000300: 'hs_399300', sz399106: 'hs_399106' };

function fmtAmountWan(v) { return (v / 10000).toFixed(1) + '亿'; }
function fmtAmountYuan(v) { return (v / 1e8).toFixed(1) + '亿'; }
// 预计全天成交额（万）。优先按上一交易日同时刻完成度比例校正（ratio=全天/同时刻>1，
// 天然含"上午量>下午量"分布与午休处理）；无历史比例时回退 240 分钟线性外推。
function estFullDayAmount(amountWan, now, ratio) {
  if (ratio && ratio > 1) return Math.round(amountWan * ratio);
  const min = now.getHours() * 60 + now.getMinutes();
  let traded = 0;
  if (min <= 570) traded = 0;              // 9:30 前
  else if (min <= 690) traded = min - 570; // 9:30-11:30
  else if (min <= 780) traded = 120;       // 午休
  else if (min <= 900) traded = 120 + (min - 780); // 13:00-15:00
  else traded = 240;                       // 15:00 后
  return traded > 0 ? Math.round(amountWan * 240 / traded) : 0;
}
function isTradingDay(d) { // 粗略：周一至周五视为交易日（节假日不单独判断，收盘态自动兜底）
  const w = d.getDay();
  return w !== 0 && w !== 6;
}
// ---- 行情数据内存缓存（降低重复接口请求；key 带日期/TTL 自动失效） ----
const __CACHE = new Map();
function cacheGet(key) { const c = __CACHE.get(key); return c && c.exp > Date.now() ? c.val : undefined; }
function cacheSet(key, val, ttlMs) { __CACHE.set(key, { exp: Date.now() + ttlMs, val }); }

// 上一交易日成交额（元）。返回 { sameTime: 与 nowHHMM 同时刻(30分钟档)的累计, fullDay: 全天累计 }；
// 取不到返回 null。同花顺 41 每行 = "YYYYMMDDHHMM,开,收,高,低,量(股),额(元),换手"（[6]=成交额元，单档增量，需累加）
// 优化：同花顺历史部分（上一交易日）在当天固定不变 → 按「代码+今天日期」缓存原始行，当日只拉一次接口，后续纯内存累加
async function prevTradingAmount(code, nowHHMM) {
  const ths = SS_THS[code];
  if (!ths) return null;
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const ckey = 'ths30:' + ths + ':' + ymd;
  let rows = cacheGet(ckey);
  if (!rows) {
    let body;
    for (let i = 0; i < 5; i++) { // 同花顺接口偶发 502，重试 5 次
      try {
        const resp = await fetch(SS_MIN30.replace('%s', ths), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Referer': 'https://www.10jqka.com.cn/' },
          signal: AbortSignal.timeout(8000),
        });
        body = await resp.text();
        if (body.includes('"data"') && body.length > 1000) break;
      } catch (_) { /* 重试 */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!body) return null;
    try {
      const i = body.indexOf('{');
      const j = JSON.parse(body.slice(i, body.lastIndexOf('}') + 1));
      rows = String(j.data || '').split(';').filter(Boolean);
      if (rows.length < 8) return null;
      cacheSet(ckey, rows, 24 * 3600 * 1000); // 当天固定，缓存到次日（key 含日期自动失效）
    } catch (_) { return null; }
  }
  try {
    // 按日期分组（末位=今日，倒数第2=上一交易日；盘前今日未生成时末位即上一交易日）
    const dates = [];
    for (const line of rows) {
      const d = line.slice(0, 8);
      if (dates[dates.length - 1] !== d) dates.push(d);
    }
    const prevDate = (dates[dates.length - 1] < ymd) ? dates[dates.length - 1] : dates[dates.length - 2];
    if (!prevDate) return null;
    const hhmmCmp = nowHHMM.replace(':', ''); // "1233"
    let sameTime = 0, fullDay = 0;
    for (const line of rows) {
      if (!line.startsWith(prevDate)) continue;
      const amt = Number(line.split(',')[6]) || 0; // [6]=成交额（元）
      fullDay += amt;
      if (line.slice(8, 12) <= hhmmCmp) sameTime += amt; // 同时刻（30分钟档）累计
    }
    return { sameTime, fullDay };
  } catch (_) { return null; }
}
  // 放量/缩量描述：cur/prev 均为金额（元）。盘中基准=上一交易日同时刻累计，收盘=上一交易日全天
  function amountCompareTxt(curYuan, prevYuan) {
    if (!prevYuan || !curYuan) return '较上一交易日 -';
    const diff = curYuan - prevYuan;
    const pct = diff / prevYuan * 100;
    if (Math.abs(pct) < 0.5) return `较上一交易日基本持平（${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`;
    const dir = diff > 0 ? '🔴 放量' : '🟢 缩量';
    return `较上一交易日${dir} ${fmtAmountYuan(Math.abs(diff))}（${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`;
  }

  // ---------- 申万二级行业资金流（/ss 内嵌块，2026-08-31 新增） ----------
  // 数据源：腾讯板块行情 getRank?board_type=hy2（申万二级，124 个行业），
  //         字段 zljlr = 主力净流入（万元）；本地排序取流入/流出前5。
  const SS_SW2 = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy2&sort_type=price&direct=down&offset=0&count=200';
  async function fetchSw2Flow() {
    const cached = cacheGet('sw2top5');
    if (cached) return cached;
    try {
      const resp = await fetch(SS_SW2, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(8000),
      });
      const j = await resp.json();
      const list = j?.data?.rank_list;
      if (!Array.isArray(list) || list.length === 0) return null;
      // zljlr 单位万 → 亿
      const rows = list.map(r => ({ name: r.name, yiyi: (Number(r.zljlr) || 0) / 10000 })).filter(r => r.yiyi !== 0);
      rows.sort((a, b) => b.yiyi - a.yiyi);
      const result = { inflow: rows.slice(0, 5), outflow: rows.slice(-5).reverse() };
      cacheSet('sw2top5', result, 15000); // 主力净流入 15 秒内可视为一致
      return result;
    } catch (_) { return null; }
  }
  // 文本版（图片渲染失败时的 fallback）
  function sw2Text(sw2) {
    if (!sw2) return null;
    const fmt = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}亿`;
    return [
      '🏦 申万二级行业资金流（主力净流入）',
      '🔴 流入 TOP5：' + sw2.inflow.map(r => `${r.name} ${fmt(r.yiyi)}`).join('、'),
      '🟢 流出 TOP5：' + sw2.outflow.map(r => `${r.name} ${fmt(r.yiyi)}`).join('、'),
    ].join('\n');
  }

  // ---------- /ss 指数行情图（白底竖版卡片，手机阅读友好，2026-08-31 新增） ----------
  // data: { closed, nowHHMM, t, indices:[{code,name,price,open,chg,chgPct,high,low,amountWan,est,curYuan,prevAmt}],
  //         mkt:{amountWan,est,curYuan,prevYuan}, sw2:{inflow,outflow}|null }
  // /ss 指数行情图：canvas 版（skia 快），失败 fallback resvg 版 renderSSPngSvg
  function renderSSPng(data) {
    try { return renderSSPngCanvas(data); }
    catch (e) { console.error('[ss] canvas 渲染失败，fallback resvg:', e.message); return renderSSPngSvg(data); }
  }
  function renderSSPngCanvas(data) {
    const W = 720, PAD = 22;
    const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
    const upC = '#e0483e', downC = '#2aa36b'; // A股：涨红跌绿
    const f2 = v => (isFinite(v) ? v.toFixed(2) : '-');
    const f1 = v => (isFinite(v) ? v.toFixed(1) : '-');
    const comp = (cur, prev) => {
      if (!prev || !cur) return null;
      const diff = cur - prev, pct = diff / prev * 100;
      if (Math.abs(pct) < 0.5) return { dir: '持平', diff, pct };
      return { dir: diff > 0 ? '放量' : '缩量', diff, pct };
    };
    const compLine = (c, sameTime) => {
      if (!c) return ['较上一交易日 -', sub];
      if (c.dir === '持平') return [`较上一交易日基本持平（${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%）`, sub];
      const col = c.dir === '放量' ? upC : downC;
      const txt = `较上一交易日${sameTime ? '同时刻 ' : ''}${c.dir} ${(Math.abs(c.diff) / 1e8).toFixed(1)}亿（${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%）`;
      return [txt, col];
    };
    // 计算总高度（与 SVG 版布局一致）
    let H = 18 + 44 + (data.indices.length * (206 + 12)) + 104 + 12 + (data.sw2 && data.sw2.inflow.length ? 206 + 12 : 0) + 16;
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2)); // 1.2x 分辨率，兼顾清晰与生成速度
    const ctx = canvas.getContext('2d');
    ctx.scale(1.2, 1.2);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    const mmdd = data.t.slice(5, 10);

    let y = 18;
    // 标题
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 26px cjk';
    ctx.fillText('指数行情' + (data.closed ? '（已收盘）' : ''), PAD, y + 22);
    ctx.fillStyle = data.closed ? sub : upC; ctx.textAlign = 'right'; ctx.font = '15px cjk';
    ctx.fillText((data.closed ? '已收盘' : '盘中') + ' ' + mmdd + ' ' + data.nowHHMM, W - PAD, y + 22);
    y += 44;

    const x0 = PAD, cw = W - PAD * 2;
    const rrect = (x, yy, w, h, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, yy, w, h, r); ctx.fill(); };
    // 指数卡片
    for (const it of data.indices) {
      const cardH = 206;
      const c = comp(it.curYuan, it.prevAmt);
      const chgCol = it.chg >= 0 ? upC : downC;
      rrect(x0, y, cw, cardH, 14, panel);
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 18px cjk';
      ctx.fillText(it.name, x0 + 18, y + 28);
      ctx.fillStyle = sub; ctx.font = '13px cjk';
      ctx.fillText(String(it.code).slice(2), x0 + 152, y + 28);
      // 现价 + 涨跌
      ctx.fillStyle = chgCol; ctx.font = 'bold 40px cjk';
      ctx.fillText(f2(it.price), x0 + 18, y + 72);
      const chgTxt = `${it.chg >= 0 ? '+' : ''}${f2(it.chg)}  ${it.chgPct >= 0 ? '+' : ''}${f2(it.chgPct)}%`;
      ctx.textAlign = 'right'; ctx.font = 'bold 19px cjk';
      ctx.fillText(chgTxt, x0 + cw - 18, y + 70);
      // 分隔线
      ctx.strokeStyle = lineC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + 18, y + 86); ctx.lineTo(x0 + cw - 18, y + 86); ctx.stroke();
      // 三列：今开/最高/最低
      const colW3 = (cw - 36) / 3;
      ctx.textAlign = 'left';
      [['今开', f2(it.open)], ['最高', f2(it.high)], ['最低', f2(it.low)]].forEach((c2, i) => {
        const cx = x0 + 18 + colW3 * i;
        ctx.fillStyle = sub; ctx.font = '12px cjk';
        ctx.fillText(c2[0], cx, y + 106);
        ctx.fillStyle = ink; ctx.font = 'bold 17px cjk';
        ctx.fillText(c2[1], cx, y + 126);
      });
      // 两列：成交额 / 预计全天
      const amtCols = data.closed
        ? [['全天成交额', `${f1(it.amountWan / 10000)}亿`], ['较上一交易日', (() => { const t2 = compLine(c, false)[0]; return t2.replace('较上一交易日', ''); })()]]
        : [[`成交额（${data.nowHHMM}）`, `${f1(it.amountWan / 10000)}亿`], ['预计全天', `${f1(it.est / 10000)}亿`]];
      const colW2 = (cw - 36) / 2;
      amtCols.forEach((c2, i) => {
        const cx = x0 + 18 + colW2 * i;
        ctx.fillStyle = sub; ctx.font = '12px cjk';
        ctx.fillText(c2[0], cx, y + 148);
        ctx.fillStyle = ink; ctx.font = 'bold 16px cjk';
        ctx.fillText(c2[1], cx, y + 168);
      });
      // 放量缩量条
      const [ct, cc] = compLine(c, !data.closed);
      const barA = cc === upC ? 'rgba(224,72,62,0.08)' : cc === downC ? 'rgba(42,163,107,0.08)' : 'rgba(138,145,158,0.08)';
      ctx.fillStyle = barA; ctx.beginPath(); ctx.roundRect(x0 + 18, y + 178, cw - 36, 28, 8); ctx.fill();
      ctx.fillStyle = cc; ctx.textAlign = 'left'; ctx.font = 'bold 14px cjk';
      ctx.fillText(ct, x0 + 32, y + 196);
      y += cardH + 12;
    }

    // 全市场卡片
    const mc = comp(data.mkt.curYuan, data.mkt.prevYuan);
    const mktH = 104;
    rrect(x0, y, cw, mktH, 14, panel);
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 18px cjk';
    ctx.fillText('全市场（沪深两市合计）', x0 + 18, y + 28);
    ctx.font = 'bold 30px cjk';
    ctx.fillText(`${f1(data.mkt.amountWan / 10000)}亿`, x0 + 18, y + 68);
    if (!data.closed) {
      ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '15px cjk';
      ctx.fillText(`预计全天 ${f1(data.mkt.est / 10000)}亿`, x0 + cw - 18, y + 66);
    }
    const [mt, mcol] = compLine(mc, !data.closed);
    ctx.fillStyle = mcol === upC ? 'rgba(224,72,62,0.08)' : mcol === downC ? 'rgba(42,163,107,0.08)' : 'rgba(138,145,158,0.08)';
    ctx.beginPath(); ctx.roundRect(x0 + 18, y + 76, cw - 36, 26, 8); ctx.fill();
    ctx.fillStyle = mcol; ctx.textAlign = 'left'; ctx.font = 'bold 13px cjk';
    ctx.fillText(mt, x0 + 32, y + 93);
    y += mktH + 12;

    // 申万二级行业资金流
    if (data.sw2 && data.sw2.inflow.length) {
      const swH = 206;
      rrect(x0, y, cw, swH, 14, panel);
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 16px cjk';
      ctx.fillText('申万二级行业资金流（主力净流入）', x0 + 18, y + 28);
      const halfW = (cw - 36 - 12) / 2;
      // 左：流入
      ctx.fillStyle = upC; ctx.font = 'bold 14px cjk';
      ctx.fillText('流入 TOP5', x0 + 18, y + 54);
      data.sw2.inflow.forEach((r, i) => {
        const ry = y + 54 + 14 + i * 26;
        ctx.fillStyle = ink; ctx.font = '14px cjk'; ctx.textAlign = 'left';
        ctx.fillText(r.name.length > 9 ? r.name.slice(0, 9) + '…' : r.name, x0 + 18, ry);
        ctx.fillStyle = upC; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'right';
        ctx.fillText(`+${r.yiyi.toFixed(1)}亿`, x0 + 18 + halfW - 6, ry);
      });
      // 右：流出
      const rx2 = x0 + 18 + halfW + 12;
      ctx.textAlign = 'left';
      ctx.fillStyle = downC; ctx.font = 'bold 14px cjk';
      ctx.fillText('流出 TOP5', rx2, y + 54);
      data.sw2.outflow.forEach((r, i) => {
        const ry = y + 54 + 14 + i * 26;
        ctx.fillStyle = ink; ctx.font = '14px cjk'; ctx.textAlign = 'left';
        ctx.fillText(r.name.length > 9 ? r.name.slice(0, 9) + '…' : r.name, rx2, ry);
        ctx.fillStyle = downC; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'right';
        ctx.fillText(`${r.yiyi.toFixed(1)}亿`, rx2 + halfW - 6, ry);
      });
    }

    // 右下角生成时间
    ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
    ctx.fillText('生成 ' + new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), W - PAD, H - 12);
    return 'base64://' + canvas.toBuffer('image/png').toString('base64');
  }

  // /ss 指数行情图：resvg 版（canvas 失败 fallback）
  function renderSSPngSvg(data) {
    const W = 720, PAD = 22;
    const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
    const upC = '#e0483e', downC = '#2aa36b'; // A股：涨红跌绿
    const f2 = v => (isFinite(v) ? v.toFixed(2) : '-');
    const f1 = v => (isFinite(v) ? v.toFixed(1) : '-');
    const comp = (cur, prev) => {
      if (!prev || !cur) return null;
      const diff = cur - prev, pct = diff / prev * 100;
      if (Math.abs(pct) < 0.5) return { dir: '持平', diff, pct };
      return { dir: diff > 0 ? '放量' : '缩量', diff, pct };
    };
    const compLine = (c, sameTime) => {
      if (!c) return ['较上一交易日 -', sub];
      if (c.dir === '持平') return [`较上一交易日基本持平（${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%）`, sub];
      const col = c.dir === '放量' ? upC : downC;
      const txt = `较上一交易日${sameTime ? '同时刻 ' : ''}${c.dir} ${(Math.abs(c.diff) / 1e8).toFixed(1)}亿（${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%）`;
      return [txt, col];
    };
    const barBg = col => col === upC ? 'rgba(224,72,62,0.08)' : col === downC ? 'rgba(42,163,107,0.08)' : 'rgba(138,145,158,0.08)';

    let y = 18, s = '';
    const mmdd = data.t.slice(5, 10);

    // 标题
    s += `<text x="${PAD}" y="${y + 22}" font-family="PingFang SC,cjk" font-size="26" font-weight="bold" fill="${ink}">指数行情${data.closed ? '（已收盘）' : ''}</text>`;
    const tCol = data.closed ? sub : upC;
    s += `<text x="${W - PAD}" y="${y + 22}" text-anchor="end" font-family="PingFang SC,cjk" font-size="15" fill="${tCol}">${data.closed ? '已收盘' : '盘中'} ${mmdd} ${data.nowHHMM}</text>`;
    y += 44;

    const x0 = PAD, cw = W - PAD * 2;
    // 指数卡片
    for (const it of data.indices) {
      const cardH = 206;
      const c = comp(it.curYuan, it.prevAmt);
      const chgCol = it.chg >= 0 ? upC : downC;
      s += `<rect x="${x0}" y="${y}" width="${cw}" height="${cardH}" rx="14" fill="${panel}"/>`;
      s += `<text x="${x0 + 18}" y="${y + 28}" font-family="PingFang SC,cjk" font-size="18" font-weight="bold" fill="${ink}">${esc(it.name)}</text>`;
      s += `<text x="${x0 + 152}" y="${y + 28}" font-family="PingFang SC,cjk" font-size="13" fill="${sub}">${String(it.code).slice(2)}</text>`;
      // 现价 + 涨跌
      s += `<text x="${x0 + 18}" y="${y + 72}" font-family="PingFang SC,cjk" font-size="40" font-weight="bold" fill="${chgCol}">${f2(it.price)}</text>`;
      const chgTxt = `${it.chg >= 0 ? '+' : ''}${f2(it.chg)}  ${it.chgPct >= 0 ? '+' : ''}${f2(it.chgPct)}%`;
      s += `<text x="${x0 + cw - 18}" y="${y + 70}" text-anchor="end" font-family="PingFang SC,cjk" font-size="19" font-weight="bold" fill="${chgCol}">${chgTxt}</text>`;
      s += `<line x1="${x0 + 18}" y1="${y + 86}" x2="${x0 + cw - 18}" y2="${y + 86}" stroke="${lineC}" stroke-width="1"/>`;
      // 三列：今开/最高/最低
      const colW3 = (cw - 36) / 3;
      [['今开', f2(it.open)], ['最高', f2(it.high)], ['最低', f2(it.low)]].forEach((c2, i) => {
        const cx = x0 + 18 + colW3 * i;
        s += `<text x="${cx}" y="${y + 106}" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${c2[0]}</text>`;
        s += `<text x="${cx}" y="${y + 126}" font-family="PingFang SC,cjk" font-size="17" font-weight="bold" fill="${ink}">${c2[1]}</text>`;
      });
      // 两列：成交额 / 预计全天（收盘态：全天成交额 / 较上一交易日）
      const amtCols = data.closed
        ? [['全天成交额', `${f1(it.amountWan / 10000)}亿`], ['较上一交易日', (() => { const t2 = compLine(c, false)[0]; return t2.replace('较上一交易日', ''); })()]]
        : [[`成交额（${data.nowHHMM}）`, `${f1(it.amountWan / 10000)}亿`], ['预计全天', `${f1(it.est / 10000)}亿`]];
      const colW2 = (cw - 36) / 2;
      amtCols.forEach((c2, i) => {
        const cx = x0 + 18 + colW2 * i;
        s += `<text x="${cx}" y="${y + 148}" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${c2[0]}</text>`;
        s += `<text x="${cx}" y="${y + 168}" font-family="PingFang SC,cjk" font-size="16" font-weight="bold" fill="${ink}">${esc(c2[1])}</text>`;
      });
      // 放量缩量条
      const [ct, cc] = compLine(c, !data.closed);
      s += `<rect x="${x0 + 18}" y="${y + 178}" width="${cw - 36}" height="28" rx="8" fill="${barBg(cc)}"/>`;
      s += `<text x="${x0 + 32}" y="${y + 196}" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${cc}">${esc(ct)}</text>`;
      y += cardH + 12;
    }

    // 全市场卡片
    const mc = comp(data.mkt.curYuan, data.mkt.prevYuan);
    const mktH = 104;
    s += `<rect x="${x0}" y="${y}" width="${cw}" height="${mktH}" rx="14" fill="${panel}"/>`;
    s += `<text x="${x0 + 18}" y="${y + 28}" font-family="PingFang SC,cjk" font-size="18" font-weight="bold" fill="${ink}">全市场（沪深两市合计）</text>`;
    s += `<text x="${x0 + 18}" y="${y + 68}" font-family="PingFang SC,cjk" font-size="30" font-weight="bold" fill="${ink}">${f1(data.mkt.amountWan / 10000)}亿</text>`;
    if (!data.closed) {
      s += `<text x="${x0 + cw - 18}" y="${y + 66}" text-anchor="end" font-family="PingFang SC,cjk" font-size="15" fill="${sub}">预计全天 ${f1(data.mkt.est / 10000)}亿</text>`;
    }
    const [mt, mcol] = compLine(mc, !data.closed);
    s += `<rect x="${x0 + 18}" y="${y + 76}" width="${cw - 36}" height="26" rx="8" fill="${barBg(mcol)}"/>`;
    s += `<text x="${x0 + 32}" y="${y + 93}" font-family="PingFang SC,cjk" font-size="13" font-weight="bold" fill="${mcol}">${esc(mt)}</text>`;
    y += mktH + 12;

    // 申万二级行业资金流
    if (data.sw2 && data.sw2.inflow.length) {
      const swH = 206;
      s += `<rect x="${x0}" y="${y}" width="${cw}" height="${swH}" rx="14" fill="${panel}"/>`;
      s += `<text x="${x0 + 18}" y="${y + 28}" font-family="PingFang SC,cjk" font-size="16" font-weight="bold" fill="${ink}">申万二级行业资金流（主力净流入）</text>`;
      const halfW = (cw - 36 - 12) / 2;
      // 左：流入 TOP5
      s += `<text x="${x0 + 18}" y="${y + 54}" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${upC}">流入 TOP5</text>`;
      data.sw2.inflow.forEach((r, i) => {
        const ry = y + 54 + 14 + i * 26;
        s += `<text x="${x0 + 18}" y="${ry}" font-family="PingFang SC,cjk" font-size="14" fill="${ink}">${esc(r.name.length > 9 ? r.name.slice(0, 9) + '…' : r.name)}</text>`;
        s += `<text x="${x0 + 18 + halfW - 6}" y="${ry}" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${upC}">+${r.yiyi.toFixed(1)}亿</text>`;
      });
      // 右：流出 TOP5
      const rx2 = x0 + 18 + halfW + 12;
      s += `<text x="${rx2}" y="${y + 54}" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${downC}">流出 TOP5</text>`;
      data.sw2.outflow.forEach((r, i) => {
        const ry = y + 54 + 14 + i * 26;
        s += `<text x="${rx2}" y="${ry}" font-family="PingFang SC,cjk" font-size="14" fill="${ink}">${esc(r.name.length > 9 ? r.name.slice(0, 9) + '…' : r.name)}</text>`;
        s += `<text x="${rx2 + halfW - 6}" y="${ry}" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${downC}">${r.yiyi.toFixed(1)}亿</text>`;
      });
      y += swH + 12;
    }

    const H = Math.ceil(y) + 16;
    // 右下角：生成时间
    const genT = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="${bg}"/>${s}<text x="${W - PAD}" y="${H - 12}" text-anchor="end" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">生成 ${genT}</text></svg>`;
    try {
      const { Resvg } = require('@resvg/resvg-js');
      const r = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { fontFiles: ['/app/fonts/cjk_sub.ttf'], loadSystemFonts: false, defaultFontFamily: 'PingFang SC' } });
      const png = r.render().asPng();
      return 'base64://' + png.toString('base64'); // 官方网关图片仅认 base64:// 前缀
    } catch (e) {
      console.error('[ss] 渲染失败:', e.message);
      return '';
    }
  }

  async function cmdSS() {
  let text;
  try {
    const resp = await fetch(SS_QUOTES, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(8000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    text = new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return { ok: false, text: '⚠️ 行情获取失败：' + e.message };
  }

  const now = new Date();
  const p2 = s => String(s).padStart(2, '0');
  const closed = !isTradingDay(now) || (now.getHours() * 60 + now.getMinutes()) >= 900; // >=15:00 或非交易日 = 收盘态
  const nowHHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`;

  // 并行预取三个标的（上证/沪深300/深证综指）的上一交易日 {sameTime, fullDay} 成交额（元）
  const prevAmts = {};
  await Promise.all(['sh000001', 'sh000300', 'sz399106'].map(async (c) => {
    prevAmts[c] = await prevTradingAmount(c, nowHHMM);
  }));

  const indices = [];   // 图片渲染用（结构化）
  const lines = [];     // 文本 fallback
  let mktAmountWan = 0; // 全市场（上证+深证综指）当日成交额（万）
  for (const raw of text.split(';')) {
    const m = raw.match(/v_(\w+)="([^"]+)"/);
    if (!m) continue;
    const a = m[2].split('~');
    if (a.length < 35) continue;
    const code = m[1];               // sh000001 / sh000300 / sz399106
    const amountWan = Number(a[37]); // 当日成交额（万）
    // 全市场 = 沪市（上证指数）+ 深市（深证综指），沪深300 为成分股指数不重复计入
    if (code === 'sz399106' || code === 'sh000001') mktAmountWan += amountWan;
    if (code === 'sz399106') continue; // 深证综指仅用于全市场汇总，不单独展示
    const name = a[1];
    const price = Number(a[3]);      // 现价（收盘后=收盘价）
    const open = Number(a[5]);       // 今开
    const chg = Number(a[31]);       // 涨跌额
    const chgPct = Number(a[32]);    // 涨跌幅%
    const high = Number(a[33]);      // 最高
    const low = Number(a[34]);       // 最低
    const prev = prevAmts[code] || null;
    const curYuan = amountWan * 10000;                     // 当日成交额（元）
    const prevCmp = closed ? (prev ? prev.fullDay : 0) : (prev ? prev.sameTime : 0); // 对比基准（元）
    // 预计全天：按上一交易日同时刻完成度比例校正（上午量>下午量，午休按上午完成度），无历史则线性回退
    const est = estFullDayAmount(amountWan, now, prev && prev.sameTime > 0 ? prev.fullDay / prev.sameTime : 0);
    const arrow = chg > 0 ? '🔺' : chg < 0 ? '🔻' : '➖';
    const chgTxt = `${arrow} ${chg > 0 ? '+' : ''}${chg.toFixed(2)} (${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%)`;

    indices.push({ code, name, price, open, chg, chgPct, high, low, amountWan, est, curYuan, prevAmt: prevCmp });

    lines.push(`📊 ${name}（${code.slice(2)}）`);
    if (closed) {
      // 收盘态：开盘价 / 收盘价 / 全天成交额 / 较上一交易日全天
      lines.push(`开盘 ${open.toFixed(2)}  收盘 ${price.toFixed(2)}  ${chgTxt}`);
      lines.push(`最高 ${high.toFixed(2)}  最低 ${low.toFixed(2)}`);
      lines.push(`全天成交额 ${fmtAmountWan(amountWan)}`);
      lines.push(amountCompareTxt(curYuan, prevCmp));
    } else {
      // 盘中：现价 / 今日高低 / 当前成交额 + 预计全天 / 较上一交易日同时刻
      lines.push(`现价 ${price.toFixed(2)}  ${chgTxt}`);
      lines.push(`今开 ${open.toFixed(2)}  最高 ${high.toFixed(2)}  最低 ${low.toFixed(2)}`);
      lines.push(`成交额 ${fmtAmountWan(amountWan)}（${nowHHMM}）  预计全天 ${fmtAmountWan(est)}`);
      lines.push(amountCompareTxt(curYuan, prevCmp));
    }
    lines.push('');
  }
  if (indices.length === 0) return { ok: false, text: '⚠️ 行情数据解析失败' };

  // —— 全市场汇总（沪深两市合计 = 上证 + 深证综指）——
  const mktSame = (prevAmts.sh000001?.sameTime || 0) + (prevAmts.sz399106?.sameTime || 0); // 上一交易日同时刻（元）
  const mktFull = (prevAmts.sh000001?.fullDay || 0) + (prevAmts.sz399106?.fullDay || 0);   // 上一交易日全天（元）
  const mktPrev = closed ? mktFull : mktSame; // 对比基准（元）
  const mkt = { amountWan: mktAmountWan, est: estFullDayAmount(mktAmountWan, now, mktSame > 0 ? mktFull / mktSame : 0), curYuan: mktAmountWan * 10000, prevYuan: mktPrev };
  lines.push('🌐 全市场（沪深两市合计）');
  if (closed) {
    lines.push(`全天成交额 ${fmtAmountWan(mktAmountWan)}`);
    lines.push(amountCompareTxt(mkt.curYuan, mktPrev));
  } else {
    lines.push(`成交额 ${fmtAmountWan(mktAmountWan)}（${nowHHMM}）  预计全天 ${fmtAmountWan(mkt.est)}`);
    lines.push(amountCompareTxt(mkt.curYuan, mktPrev));
  }
  lines.push('');

  // —— 申万二级行业资金流（流入/流出前5）——
  const sw2 = await fetchSw2Flow();

  const t = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const header = `${closed ? '🏁' : '📊'} 指数行情 ${closed ? '（已收盘）' : ''}${t.slice(5, 16)}`;

  // 主路径：渲染竖版白底卡片图（手机友好）
  const img = renderSSPng({ closed, nowHHMM, t, indices, mkt, sw2 });
  if (img) return { ok: true, text: header, img };

  // 渲染失败 → 文本 fallback
  const st = sw2Text(sw2);
  if (st) lines.push(st);
  return { ok: false, text: [header, ...lines].join('\n').trim() };
}

// ---------- /stock K线图（2026-08-31 新增） ----------
// 用法：/stock <周期> <代码或名称>，如 /stock -d 600519 / /stock -5m 贵州茅台 / /stock -30m 510300
// 周期：-d 日线（含 MA5/10/20/30/60/120/250 + BOLL）|-1m|-5m|-30m|-1h（仅 BOLL）
// 数据：腾讯 fqkline（日K qfqday）与 mkline（分钟K m5/m1/m30/m60）；名称经 smartbox 解析
// 渲染：@resvg/resvg-js（共享 ths-news-modules 卷）→ PNG base64 → sendReply 发图
const STOCK_QUOTE = 'https://qt.gtimg.cn/q=%s';                    // 实时快照（名称/现价，GBK）
const STOCK_FQKLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,%s,,,320,qfq'; // 日/周/月K（320根，qfq 前复权）
const STOCK_MINUTE = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=%s,%s,,320'; // 分钟K
const STOCK_TIMELINE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=%s'; // 当日分时（分钟级）
const STOCK_SEARCH = 'https://smartbox.gtimg.cn/s3/?v=2&q=%s&t=all'; // 名称→代码（GBK）

// 周期归一化（-d 日线 / -w 周线 / -M 月线 / -t 分时；分钟：-1m/-5m/-30m/-1h）
const STOCK_PERIODS = { '-d': 'day', '-w': 'week', '-week': 'week', '周线': 'week', '周k': 'week', '-m': 'month', '-M': 'month', '-month': 'month', '月线': 'month', '月k': 'month', '-1m': 'm1', '-5m': 'm5', '-30m': 'm30', '-1h': 'm60', '-t': 'time', '-time': 'time', '分时': 'time' };
const STOCK_PERIOD_LABEL = { day: '日线', week: '周线', month: '月线', m1: '1分钟', m5: '5分钟', m30: '30分钟', m60: '60分钟', time: '分时' };
const STOCK_LONG = ['day', 'week', 'month']; // 长周期（日/周/月，fqkline 接口）

// 代码归一化：纯数字 → sh/sz 前缀（6开头/5开头沪，0/3开头深；ETF/基金同样规则）；5 位及以下 → 港股 hk 补零；
// us 前缀 → 美股（可带交易所后缀如 usAAPL.OQ）；hf_ 前缀 → 全球商品（布伦特原油/黄金等）
function normalizeCode(raw) {
  let c = String(raw || '').trim().toLowerCase();
  if (/^(sh|sz|bj)/.test(c)) return c;
  if (/^hk/.test(c)) return 'hk' + c.slice(2).toUpperCase(); // hk00700 / hkhsi→hkHSI
  if (/^us[a-z0-9.]{1,10}$/.test(c)) return 'us' + c.slice(2).toUpperCase(); // usaapl→usAAPL、usAAPL.OQ→usAAPL.OQ
  if (/^hf_[a-z0-9]{1,6}$/.test(c)) return c.toUpperCase(); // hf_oil→hf_OIL
  if (/^\d{6}$/.test(c)) {
    if (/^[56]/.test(c)) return 'sh' + c; // 60xxxx 沪A / 51xxxx 沪ETF
    return 'sz' + c;                       // 00/30 深A、15xxxx 深ETF
  }
  if (/^\d{1,5}$/.test(c)) return 'hk' + c.padStart(5, '0'); // 港股：1-5 位数字补零（700→hk00700）
  return '';
}

// 中文名/缩写 → 腾讯代码 的别名表（先于 smartbox 搜索命中；覆盖常见商品/全球指数/美股ETF）
const GLOBAL_ALIAS = {
  '布伦特原油': 'hf_OIL', '布油': 'hf_OIL',
  '纽约原油': 'hf_CL', '美油': 'hf_CL', 'wti': 'hf_CL', 'wti原油': 'hf_CL',
  '黄金': 'hf_GC', '纽约黄金': 'hf_GC', 'comex黄金': 'hf_GC', '伦敦金': 'hf_GC', '伦敦金现': 'hf_GC', '国际金': 'hf_GC',
  '白银': 'hf_SI', '纽约白银': 'hf_SI', '伦敦银': 'hf_SI',
  '天然气': 'hf_NG', '美国天然气': 'hf_NG',
  '美铜': 'hf_HG', '伦铜': 'hf_CAD',
  '费城半导体': 'usSOXX.OQ', '费半': 'usSOXX.OQ', '费城半导体指数': 'usSOXX.OQ',
  '道琼斯': 'usDJI', '道指': 'usDJI', '道琼斯指数': 'usDJI',
  '纳斯达克': 'usIXIC', '纳指': 'usIXIC', '纳斯达克指数': 'usIXIC',
  '标普500': 'usINX', '标普': 'usINX', '标普指数': 'usINX', 'sp500': 'usINX',
  '恒生指数': 'hkHSI', '恒指': 'hkHSI',
  '上证指数': 'sh000001', '上证': 'sh000001', '沪指': 'sh000001',
  '深证成指': 'sz399001', '深成指': 'sz399001',
  '创业板指': 'sz399006', '创业板': 'sz399006',
  '沪深300': 'sh000300', '中证500': 'sh000905', '上证50': 'sh000016', '科创50': 'sh000688',
};
// 无K线数据 → 文本行情速查 的代码（全球指数；hf_ 商品前缀另有判断）
const GLOBAL_TEXT = { 'usDJI': 1, 'usIXIC': 1, 'usINX': 1, 'hkHSI': 1 };

// 名称 → 代码（先查中文别名表，再走腾讯 smartbox；smartbox 支持 A股/港股/美股缩写与中文名）
async function resolveStockCode(q) {
  const key = String(q || '').trim().toLowerCase();
  if (GLOBAL_ALIAS[key]) return GLOBAL_ALIAS[key];
  try {
    const resp = await fetch(STOCK_SEARCH.replace('%s', encodeURIComponent(q)), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const m = text.match(/v_hint="([^"]+)"/);
    if (!m) return '';
    const first = m[1].split('^')[0]; // "sh~600519~贵州茅台~gzmt~GP-A" / "hk~00700~腾讯控股~txkg~GP" / "us~aapl.oq~苹果~pg~GP"
    const parts = first.split('~');
    if (parts.length >= 3) {
      if (parts[0] === 'us') return 'us' + String(parts[1]).toUpperCase(); // us~aapl.oq → usAAPL.OQ（带交易所后缀，供K线）
      if (/^\d{5,6}$/.test(parts[1])) return parts[0] + parts[1]; // A股6位 / 港股5位
    }
    return '';
  } catch (_) { return ''; }
}

// 指标计算
function calcSMA(arr, period) { // arr 为收盘价数组（旧→新），返回同长数组（前 period-1 为 null）
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function calcBOLL(closes, period = 20, k = 2) { // 返回 { mid, up, low } 三数组
  const mid = calcSMA(closes, period);
  const up = new Array(closes.length).fill(null);
  const low = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    up[i] = mean + k * sd;
    low[i] = mean - k * sd;
  }
  return { mid, up, low };
}

// 拉取 K 线/分时：period='day' 走日K（qfqday），'time' 走当日分时，否则分钟K（m1/m5/m30/m60）
// 美股日K：接口需带交易所后缀（.OQ 纳斯达克 / .N 纽交所），无后缀输入按 .OQ → .N 依次尝试
async function fetchStockKline(code, period) {
  const ckey = 'kline:' + code + ':' + period;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  const parse = (j, key) => {
    const d = j?.data?.[key];
    if (!d) return null;
    if (period === 'time') {
      // 分时："0930 1297.99 270 35045730.00" = 时间 价格 累计量(手) 累计额(元)
      // 腾讯给的是累计量 → 差分出「每分钟量」用于画柱；cumVol 保留供均价计算（cumAmt/cumVol）
      const rows = d?.data?.data || [];
      if (!Array.isArray(rows) || rows.length < 2) return null;
      let prevVol = 0;
      return rows.map(r => {
        const p = String(r).split(' ');
        const close = Number(p[1]), cumVol = Number(p[2]), cumAmt = Number(p[3]);
        const diffVol = Math.max(0, cumVol - prevVol); prevVol = cumVol;
        return {
          t: p[0], open: close, close, high: close, low: close,
          vol: diffVol, cumVol: cumVol, cumAmt,
        };
      });
    }
    const raw = d['qfq' + period] || d[period] || []; // day→qfqday||day；week→qfqweek||week；month→qfqmonth||month；m5→d.m5
    if (!Array.isArray(raw) || raw.length < 2) return null;
    return raw.map(r => ({
      t: r[0], open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), vol: Number(r[5]),
    }));
  };
  const fetchOnce = async (url, key) => {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const j = await resp.json();
      return parse(j, key);
    } catch (_) { return null; }
  };
  const isLong = STOCK_LONG.includes(period);
  let result = null;
  if (isLong && code.startsWith('us')) {
    // 美股日/周/月K：接口需带交易所后缀（.OQ 纳斯达克 / .N 纽交所），无后缀输入按 .OQ → .N 依次尝试
    const cands = code.includes('.') ? [code] : [code + '.OQ', code + '.N'];
    for (const cand of cands) {
      const r = await fetchOnce(STOCK_FQKLINE.replace('%s', cand).replace('%s', period), cand);
      if (r && r.length >= 10) { result = r; break; }
    }
  } else {
    if (period === 'time' && code.startsWith('hf_')) {
      result = await fetchSinaGlobalMin(code); // 国际商品：腾讯/东财无分时，走新浪全球期货
    } else {
      let url;
      if (isLong) url = STOCK_FQKLINE.replace('%s', code).replace('%s', period); // 日/周/月K
      else if (period === 'time') url = STOCK_TIMELINE.replace('%s', code);
      else url = STOCK_MINUTE.replace('%s', code).replace('%s', period);
      result = await fetchOnce(url, code);
      // 分时：腾讯在没开盘/休市/美股盘后时只有 0-1 行 → 用东财最近交易日分时（ndays=1 自动取最近交易日）
      if (period === 'time' && (!result || result.length < 2)) {
        result = await fetchEmTrends(emSecid(code), code.startsWith('us'));
      }
    }
  }
  if (!result) return null;
  cacheSet(ckey, result, 5000); // K线分钟级变化，5 秒缓存足够
  return result;
}

// 新浪全球期货 1 分钟分时（腾讯/东财对 hf_ 国际商品均无分时；新浪 GlobalFuturesService 可用）
// symbol：OIL布油 GC美黄金 SI美白银 CL WTI NG天然气 HG美铜 CAD伦铜
const HF_SINA_SYM = { 'hf_OIL': 'OIL', 'hf_GC': 'GC', 'hf_SI': 'SI', 'hf_CL': 'CL', 'hf_NG': 'NG', 'hf_HG': 'HG', 'hf_CAD': 'CAD' };
const SINA_GLOBAL_MIN = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_Global_=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=%s&type=1';
async function fetchSinaGlobalMin(code) {
  const sym = HF_SINA_SYM[code];
  if (!sym) return null;
  try {
    const resp = await fetch(SINA_GLOBAL_MIN.replace('%s', sym), { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(8000) });
    const t = await resp.text();
    const si = t.indexOf('('), ei = t.lastIndexOf(')');
    if (si < 0 || ei < si) return null;
    const j = JSON.parse(t.slice(si + 1, ei));
    const rows = j?.minLine_1d;
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const out = [];
    rows.forEach((row, i) => {
      const isFirst = i === 0; // 首行带日期/交易所/基准；后续行字段压缩
      const price = Number(row[1]) || 0;
      const tstr = String(isFirst ? row[4] : row[0]);
      out.push({
        t: tstr, open: price, close: price, high: price, low: price,
        vol: Number(isFirst ? row[6] : row[2]) || 0,        // 新浪为分钟量（非累计）
        avgPrice: Number(isFirst ? row[8] : row[4]) || 0,    // 当日累计均价
      });
    });
    out._date = String(rows[0][0] || '').slice(5); // MM-DD
    return out;
  } catch (_) { return null; }
}

// 东财 trends2 分时（兜底：腾讯无分时/盘后时取最近交易日完整分时）
// 返回与腾讯分时同构的数组（t=HHMM、close、vol=累计量、cumAmt=累计额），数组挂 _date 属性（MM-DD）供显示
const EM_TRENDS = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=%s&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0';
// 东财 secid：沪 1.xxxxxx / 深北 0.xxxxxx / 港股 116.xxxxx / 美股 105=纳斯达克 106=纽交所 107=AMEX
function emSecid(code) {
  const c = String(code).toLowerCase();
  if (c.startsWith('us')) {
    const sym = code.replace(/\.\w+$/, '').slice(2).toUpperCase();
    const mkt = /\.n$/.test(c) ? 106 : /\.am$/.test(c) ? 107 : 105;
    return mkt + '.' + sym;
  }
  if (c.startsWith('hk')) return '116.' + code.slice(2);
  const raw = code.replace(/^(sh|sz|bj)/, '');
  return (c.startsWith('sh') ? '1.' : '0.') + raw;
}
async function fetchEmTrends(secid, isUS) {
  try {
    const resp = await fetch(EM_TRENDS.replace('%s', secid), { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const j = await resp.json();
    const rows = j?.data?.trends;
    if (!Array.isArray(rows) || rows.length < 2) { console.error('[fetchEmTrends] 数据为空', secid, rows ? rows.length : 'no-trends'); return null; }
    const out = [];
    let dateStr = '';
    // 东财美股 f56/f57 语义随行情状态变化：
    //  - 收盘后完整数据：各行为分钟量，但末行+中间部分行是"全天/时段累计快照"（单行额 ≥ 全天 20%，如 QQQ 11:31 单分钟 24.7亿=全天 74.7%）→ 需削峰
    //  - 盘中实时数据（未收盘）：每行都是正常分钟量，末行非累计 → 不能拿末行当基准，否则所有行都会被误判削掉
    // 判定「是否已收盘完整」：末行 f56 突变 ≥ 前一行 3 倍（累计值特征）；盘中末行是普通分钟量（同量级）
    const lastVolRaw = Number(rows[rows.length - 1].split(',')[5]) || 0;
    const prevVolRaw = Number(rows[rows.length - 2].split(',')[5]) || 0;
    const fullDay = lastVolRaw > prevVolRaw * 3;
    const dayTotal = fullDay ? (Number(rows[rows.length - 1].split(',')[6]) || 0) : 0;
    const anomalyTh = (fullDay && dayTotal > 0) ? dayTotal * 0.2 : Infinity; // 盘中/无累计基准 → 不削峰
    rows.forEach((r, i) => {
      const p = String(r).split(',');
      const bj = String(p[0]); // "2026-08-31 21:30"（东财统一北京时间）
      if (!dateStr && bj.length >= 10) dateStr = bj.slice(5, 10); // MM-DD
      let t;
      if (isUS) {
        // 美东 = 北京 -12h（夏令时）：21:30→09:30、跨天 04:00→16:00
        let m = (Number(bj.slice(11, 13)) * 60 + Number(bj.slice(14, 16)) + 720) % 1440;
        t = String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0');
      } else {
        t = bj.slice(11, 13) + bj.slice(14, 16);
      }
      const close = Number(p[1]);
      const amt = Number(p[6]) || 0;
      const vol = (amt >= anomalyTh) ? 0 : (Number(p[5]) || 0); // 收盘完整数据才削累计快照，保留价格点
      out.push({ t, open: close, close, high: close, low: close, vol, avgPrice: Number(p[7]) || 0, cumAmt: amt });
    });
    out._date = dateStr;
    return out;
  } catch (e) { console.error('[fetchEmTrends] 异常', secid, e && e.message); return null; }
}

// 取实时快照（名称/现价/涨跌），GBK 解码；5 秒缓存（盘中反复查同票时命中）
// 支持：A股/港股/美股（~分隔）；hf_ 全球商品（逗号分隔：现价,涨跌额,昨收,今开,最高,最低,时间,...,日期,名称）
async function fetchStockQuote(code) {
  const ckey = 'quote:' + code;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  try {
    if (code.startsWith('hf_')) {
      const resp = await fetch(STOCK_QUOTE.replace('%s', code), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
      const buf = Buffer.from(await resp.arrayBuffer());
      const text = new TextDecoder('gbk').decode(buf);
      const m = text.match(/v_\w+="([^"]+)"/);
      if (!m) return null;
      const f = m[1].split(',');
      const price = Number(f[0]), chg = Number(f[1]), prevClose = Number(f[2]);
      const result = {
        name: f[13] || code, price, prevClose, open: Number(f[3]), high: Number(f[4]), low: Number(f[5]),
        chg, chgPct: prevClose > 0 ? chg / prevClose * 100 : 0,
        time: f[6] || '', date: f[12] || '', market: 'hf',
        amount: 0, turnover: 0, volumeRatio: 0, amplitude: 0,
        peDyn: 0, peTtm: 0, peStatic: 0, pb: 0, eps: 0, bvps: 0,
        totalShares: 0, floatShares: 0, mktCap: 0, floatMktCap: 0, divYield: 0,
      };
      cacheSet(ckey, result, 5000);
      return result;
    }
    // A股/港股/美股/指数：~ 分隔；美股快照必须用无后缀代码（usAAPL，带 .OQ 会 none_match）
    const reqCode = code.startsWith('us') ? code.replace(/\.\w+$/, '') : code;
    const resp = await fetch(STOCK_QUOTE.replace('%s', reqCode), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const m = text.match(/v_\w+="([^"]+)"/);
    if (!m) return null;
    const a = m[1].split('~');
    const isUS = code.startsWith('us');
    const price = Number(a[3]);
    const peDyn = isUS ? 0 : Number(a[52]), peTtm = Number(a[39]), peStatic = isUS ? 0 : Number(a[53]);
    const pb = isUS ? 0 : Number(a[46]); // 美股 a[46] 是公司英文名，无 PB
    const result = {
      name: a[1], price, prevClose: Number(a[4]), open: Number(a[5]),
      chg: Number(a[31]), chgPct: Number(a[32]), high: Number(a[33]), low: Number(a[34]),
      currency: a[35] || '',            // USD / HKD / CNY
      time: a[30] || '',                // 行情时间戳（美股为美东时间）
      market: isUS ? 'us' : (code.startsWith('hk') ? 'hk' : 'cn'),
      // 基本面（腾讯快照；ETF/指数这些字段通常为空或 0；美股 PE 在 a[39]，市值单位=亿美元）
      peDyn, peTtm, peStatic, pb,
      eps: isUS ? 0 : (peTtm > 0 ? price / peTtm : 0),      // 每股收益 ≈ 现价/PE(TTM)
      bvps: isUS ? 0 : (pb > 0 ? price / pb : 0),           // 每股净资产 ≈ 现价/市净率
      totalShares: isUS ? 0 : (Number(a[73]) || 0),         // 总股本（股）
      floatShares: isUS ? 0 : (Number(a[72]) || 0),         // 流通股本（股）
      mktCap: Number(a[45]) || 0,              // 总市值（A股=亿人民币，美股=亿美元）
      floatMktCap: Number(a[44]) || 0,         // 流通市值（同上）
      divYield: isUS ? 0 : (Number(a[64]) || 0),            // 股息率(TTM)（%）
      turnover: Number(a[38]) || 0,            // 换手率（%）
      volumeRatio: Number(a[49]) || 0,         // 量比
      amplitude: Number(a[43]) || 0,           // 振幅（%）
      avgPrice: Number(a[51]) || 0,            // 均价
      high: Number(a[33]) || 0, low: Number(a[34]) || 0,  // 今日最高/最低
      limitUp: Number(a[47]) || 0,             // 涨停价
      limitDown: Number(a[48]) || 0,           // 跌停价
      amount: Number(a[37]) || 0,              // 成交额（A股=万，港股=元，美股=美元）
    };
    cacheSet(ckey, result, 5000);
    return result;
  } catch (_) { return null; }
}

// 渲染 K 线 canvas → PNG base64（@napi-rs/canvas skia 路径，进程级字体缓存，渲染 ~50ms）
// 失败 fallback 到 resvg 版。SVG 元素 → canvas 命令一一映射：rect→fillRect、line→strokeLine、
// path→beginPath+moveTo+lineTo+stroke、text→fillText。
function renderStockPng(code, name, periodLabel, klines, opts, quote) {
  try {
    return renderStockPngCanvas(code, name, periodLabel, klines, opts, quote);
  } catch (e) {
    console.error('[stock] canvas 渲染失败，fallback resvg:', e.message);
    return renderStockPngSvg(code, name, periodLabel, klines, opts, quote);
  }
}
function renderStockPngCanvas(code, name, periodLabel, klines, { maPeriods, boll, timeMode, prec = 2 }, quote) {
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-'; // 价格显示精度（ETF 三位小数时 prec=3，普通股票 2）
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD = 74, TITLE_H = 62, VOL_H = 120;
  const isHK = code.startsWith('hk'); // 港股：字段口径不同，不显示基本面面板
  const isUS = code.startsWith('us');
  const isHF = code.startsWith('hf_'); // 国际商品：接近24h连续交易，分时用索引等距映射
  const showInfo = !isHK && !isUS && quote && (quote.peTtm > 0 || quote.pb > 0) && quote.mktCap > 0; // 美股无 PE动/静/PB 等字段，同样不显示
  const LEG_H = timeMode ? 30 : ((maPeriods && maPeriods.length > 0) ? 66 : 40);
  const INFO_H = 74;
  const H = TITLE_H + VOL_H + LEG_H + (showInfo ? INFO_H : 0) + PAD + 8 + 340;
  const n = klines.length;
  const display = timeMode
    ? (isHF ? klines : klines.filter(k => { const t = String(k.t); return t >= '0930' && t <= ((isHK || isUS) ? '1600' : '1500'); })) // 分时：当天全部数据（港股/美股到16:00），商品全量
    : (periodLabel === '日线' ? klines.slice(-60) : klines.slice(-120));
  const dn = display.length;
  const plotW = W - PAD * 2, plotH = H - TITLE_H - VOL_H - LEG_H - (showInfo ? INFO_H : 0) - PAD - 8;

  // 计算指标
  const allCloses = klines.map(k => k.close);
  function bi0(nn, dnn) { return nn - dnn; }
  const maSeries = (maPeriods || []).map(p => {
    const a = new Array(n).fill(null);
    let sum = 0;
    for (let i = 0; i < n; i++) { sum += allCloses[i]; if (i >= p) sum -= allCloses[i - p]; if (i >= p - 1) a[i] = sum / p; }
    return a;
  });
  const bollS = (boll && !timeMode) ? (() => {
    const period = 20, k = 2;
    const mid = maSeries[4] || (() => { const a = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += allCloses[i]; if (i >= period) s -= allCloses[i - period]; if (i >= period - 1) a[i] = s / period; } return a; })();
    const up = new Array(n).fill(null), low = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let v = 0; const m = mid[i];
      for (let j = i - period + 1; j <= i; j++) v += (allCloses[j] - m) ** 2;
      const sd = Math.sqrt(v / period);
      up[i] = m + k * sd; low[i] = m - k * sd;
    }
    return { mid: mid.slice(bi0(n, dn)), up: up.slice(bi0(n, dn)), low: low.slice(bi0(n, dn)) };
  })() : null;

  // 分时：均价/昨收
  const isIndex = /^(sh000|sz399|hkHSI)/.test(code);
  let avgSeries = null, prevCloseRef = 0;
  if (timeMode) {
    if (quote && Number(quote.prevClose) > 0) prevCloseRef = Number(quote.prevClose);
    if (!isIndex) avgSeries = display.map(k => (k.avgPrice > 0) ? k.avgPrice : ((k.cumAmt && k.cumVol) ? (k.cumAmt / (k.cumVol * ((isHK || isUS) ? 1 : 100))) : k.close)); // 港股/美股分时量单位是股，A股是手
  }

  // 价格范围
  const highs = display.map(k => k.high), lows = display.map(k => k.low);
  let allP = [...highs, ...lows];
  if (bollS) for (let i = 0; i < dn; i++) {
    if (bollS.up[i] != null) { allP.push(bollS.up[i]); allP.push(bollS.low[i]); }
  }
  if (timeMode) {
    if (avgSeries) allP.push(...avgSeries);
    if (prevCloseRef) allP.push(prevCloseRef);
  }
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const range = (hi - lo) || 1;
  const padP = range * 0.04;
  const yMin = lo - padP, yMax = hi + padP;
  const X = i => PAD + (i + 0.5) * (plotW / dn);
  const Y = p => TITLE_H + plotH - ((p - yMin) / (yMax - yMin)) * plotH;
  const step = plotW / dn;
  // 分时：X 轴按「交易分钟连续」映射（A股 9:30-11:30/13:00-15:00=240 分钟；港股 9:30-12:00/13:00-16:00=330 分钟），
  // 午休空档压缩成相邻，价格线自然连续（用户要求"连起来"，不强调午休空档）
  const TOT = isUS ? 390 : (isHK ? 330 : 240);
  const tmin = t => {
    const hh = Number(String(t).slice(0, 2)), mm = Number(String(t).slice(2, 4));
    const m = hh * 60 + mm;
    if (isUS) return Math.min(TOT - 1, Math.max(0, m - 570)); // 美股 9:30-16:00 连续 390 分钟
    if (isHK) return Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780))); // 上午0-150 下午150-330
    return Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660));
  };
  const mapX = timeMode ? (isHF ? X : (i => PAD + (tmin(display[i].t) / TOT) * plotW)) : X;
  const cw = timeMode ? (isHF ? Math.max(1.5, plotW / dn * 0.7) : Math.max(1.5, plotW / TOT * 0.7)) : Math.max(2, Math.min(8, step * 0.6));

  // 配色
  const upC = '#e0483e', downC = '#12a05c';
  const bg = '#ffffff', panel = '#f7f8fa', grid = '#e8eaed';
  const ink = '#2b2f36', sub = '#8a919c';
  const maCols = ['#333333', '#f56c6c', '#409eff', '#9b59b6', '#2ecc71', '#e67e22', '#95a5a6'];
  const bollCol = '#f0b90b';

  // 最新一根
  const last = klines[n - 1];
  // 分时：现价/昨收用快照（分时数据末行是盘后杂数据，相邻价差≈0 会算错涨跌）；K线用数据收盘价
  const lastPrice = (quote && Number(quote.price) > 0) ? Number(quote.price) : last.close;
  const prevClose = (timeMode && quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : (klines[n - 2]?.close ?? last.open);
  const chg = lastPrice - prevClose;
  const chgPct = prevClose ? (chg / prevClose * 100) : 0;
  const chgCol = chg >= 0 ? upC : downC;
  // 分时：以「今开」为红绿基准（与价格线一致）；其他周期用昨收（标准涨跌幅）
  const openRef = (quote && Number(quote.open) > 0) ? Number(quote.open) : (klines[0]?.close ?? lastPrice);

  // === 画 canvas（2x 分辨率输出，提升清晰度） ===
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.font = '13px cjk';
  ctx.textBaseline = 'middle';

  // 标题区
  ctx.fillStyle = panel; ctx.fillRect(0, 0, W, TITLE_H);
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.font = '24px cjk';
  ctx.fillText(name, PAD, 34);
  ctx.fillStyle = sub; ctx.font = '16px cjk';
  ctx.fillText(code.toUpperCase(), PAD + name.length * 24 + 8, 34);
  ctx.fillStyle = sub; ctx.font = '13px cjk';
  ctx.fillText(periodLabel, PAD, 54);
  // 标题右侧今日价：颜色分时按今开（用户要求），其他周期按昨收；涨跌额/涨跌幅数字一律按昨收（标准收益率口径）
  ctx.textAlign = 'right';
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText('今日价格', W - PAD, 30);
  const dCol = chgCol; // 右上角颜色与收益率统一按昨收（红涨绿跌标准口径）
  const numChg = lastPrice - prevClose;
  const numPct = prevClose ? (numChg / prevClose * 100) : 0;
  ctx.fillStyle = dCol; ctx.font = 'bold 26px cjk';
  ctx.fillText(fp(lastPrice), W - PAD, 52);
  ctx.font = '15px cjk';
  const chgTxt = `${numChg >= 0 ? '+' : ''}${fp(numChg)} (${numPct >= 0 ? '+' : ''}${numPct.toFixed(2)}%)`;
  ctx.fillText(chgTxt, W - PAD, 70);

  // 网格 + Y 轴
  const gridN = 5;
  for (let i = 0; i <= gridN; i++) {
    const p = yMin + (yMax - yMin) * i / gridN;
    const y = Y(p);
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    ctx.fillStyle = sub; ctx.font = '12px cjk'; ctx.textAlign = 'right';
    ctx.fillText(fp(p), PAD - 10, y + 4);
  }

  // X 轴时间标签：画在主图底部内侧（分时精确对齐曲线时刻 tmin 映射，无人工偏移；
  // 11:30 与 13:00 在连续映射下相邻仅 1 格≈3.6px，13:00 不重复标注避免重叠与错位）
  ctx.textAlign = 'center';
  if (timeMode) {
    // 商品(hf)：连续交易时段，取首/中/末时间标签；A股：09:30/10:30/11:30/14:00/15:00；
    // 港股：09:30/10:30/11:30/14:00/15:00/16:00（12:00/13:00 相邻不重复标）；美股 09:30-16:00 连续均匀标
    const fmtT = t => String(t).slice(0, 2) + ':' + String(t).slice(2, 4);
    const lbs = isHF
      ? [[0, fmtT(display[0].t)], [Math.floor(dn / 2), fmtT(display[Math.floor(dn / 2)].t)], [dn - 1, fmtT(display[dn - 1].t)]]
      : (isUS
        ? [[0, '09:30'], [90, '11:00'], [180, '12:30'], [270, '14:00'], [TOT - 1, '16:00']]
        : (isHK ? [[0, '09:30'], [60, '10:30'], [120, '11:30'], [180, '14:00'], [240, '15:00'], [TOT - 1, '16:00']] : [[0, '09:30'], [59, '10:30'], [119, '11:30'], [180, '14:00'], [TOT - 1, '15:00']]));
    lbs.forEach(([tm, lb]) => {
      ctx.fillStyle = sub; ctx.font = '12px cjk';
      ctx.fillText(lb, PAD + (tm / TOT) * plotW, TITLE_H + plotH + 16);
    });
  } else {
    [0, Math.floor((dn - 1) / 2), dn - 1].forEach(i => {
      const t = String(display[i].t);
      const label = periodLabel === '日线' ? t.slice(5) : (periodLabel === '周线' || periodLabel === '月线' ? t.slice(2, 7) : t.slice(8, 12).replace(/(\d{2})(\d{2})/, '$1:$2'));
      ctx.fillStyle = sub; ctx.font = '12px cjk';
      ctx.fillText(label, X(i), TITLE_H + plotH + 16);
    });
  }

  // 图例纵坐标
  const yLegend = TITLE_H + plotH + 34;

  if (timeMode) {
    // 昨收基准
    if (prevCloseRef) {
      const yRef = Y(prevCloseRef);
      ctx.strokeStyle = sub; ctx.lineWidth = 1.1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(PAD, yRef); ctx.lineTo(W - PAD, yRef); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = sub; ctx.fillRect(PAD - 6, yRef - 10, 70, 20);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '11px cjk';
      ctx.fillText('昨收 ' + fp(prevCloseRef), PAD + 29, yRef + 4);
    }
    // 价格线颜色：以「今开」为红绿基准（现价 > 今开 = 红），而非昨收（用户要求，与行情软件"红上绿下"一致）
    const priceCol = lastPrice >= openRef ? upC : downC;
    if (dn > 0) {
      ctx.strokeStyle = priceCol; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < dn; i++) {
        const px = mapX(i);
        if (i === 0) ctx.moveTo(px, Y(display[i].close)); else ctx.lineTo(px, Y(display[i].close));
      }
      ctx.stroke();
      if (avgSeries) {
        ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1.4; ctx.beginPath();
        for (let i = 0; i < dn; i++) {
          const px = mapX(i);
          if (i === 0) ctx.moveTo(px, Y(avgSeries[i])); else ctx.lineTo(px, Y(avgSeries[i]));
        }
        ctx.stroke();
      }
    }
    // 图例（整体下移 16px，避开 X 轴时间标签；色块与文字垂直中心对齐）
    ctx.fillStyle = panel; ctx.fillRect(PAD - 8, yLegend, W - PAD * 2 + 16, 30);
    const lg = [[`价格 ${fp(lastPrice)}`, priceCol]];
    if (avgSeries) lg.push([`均价 ${fp(avgSeries[dn - 1])}`, '#f0b90b']);
    if (prevCloseRef) lg.push([`昨收 ${fp(prevCloseRef)}`, sub]);
    ctx.textAlign = 'left';
    lg.forEach((it, i) => {
      const cx = PAD + 60 + i * 220;
      ctx.fillStyle = it[1]; ctx.fillRect(cx - 60, yLegend + 7, 14, 14);
      ctx.fillStyle = ink; ctx.font = '13px cjk';
      ctx.fillText(it[0], cx - 40, yLegend + 14);
    });
  } else {
    // 非分时：BOLL + MA + K线 + 最新价标注 + 图例
    if (bollS) {
      // 上下轨虚线
      const drawBollLine = (arr, dash) => { ctx.strokeStyle = bollCol; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); let started = false; for (let i = 0; i < dn; i++) { if (arr[i] == null) continue; if (!started) { ctx.moveTo(X(i), Y(arr[i])); started = true; } else ctx.lineTo(X(i), Y(arr[i])); } ctx.stroke(); ctx.setLineDash([]); };
      drawBollLine(bollS.up, [6, 4]); drawBollLine(bollS.low, [6, 4]);
      // 中轨
      ctx.strokeStyle = bollCol; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false; for (let i = 0; i < dn; i++) { if (bollS.mid[i] == null) continue; if (!started) { ctx.moveTo(X(i), Y(bollS.mid[i])); started = true; } else ctx.lineTo(X(i), Y(bollS.mid[i])); } ctx.stroke();
    }
    // MA（maSeries 为全量数组，绘制时按 bi0 对齐到显示区）
    const bi = n - dn;
    maSeries.forEach((series, idx) => {
      ctx.strokeStyle = maCols[idx % maCols.length]; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false;
      for (let i = 0; i < dn; i++) {
        const v = series[bi + i];
        if (v == null) continue;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      }
      ctx.stroke();
    });
    // K线
    for (let i = 0; i < dn; i++) {
      const k = display[i];
      const up = k.close >= k.open;
      const col = up ? upC : downC;
      const x = X(i);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(k.high)); ctx.lineTo(x, Y(k.low)); ctx.stroke();
      const top = Math.min(Y(k.open), Y(k.close)), hgt = Math.max(1.2, Math.abs(Y(k.open) - Y(k.close)));
      ctx.fillStyle = col; ctx.fillRect(x - cw / 2, top, cw, hgt);
    }
    // 最新价横虚线 + 色块标签
    const yLast = Y(lastPrice);
  // 最新价标注：分时按今开红绿（与价格线/右上角一致），其他周期按昨收
  const markCol = chgCol; // 最新价标注颜色与右上角一致（昨收基准）
  ctx.strokeStyle = markCol; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(PAD, yLast); ctx.lineTo(W - PAD, yLast); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = markCol; ctx.fillRect(W - PAD, yLast - 12, 64, 24);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 13px cjk';
    ctx.fillText(fp(lastPrice), W - PAD + 32, yLast + 4);
    // 图例（整体下移 16px，避开 X 轴时间标签；色块与文字垂直中心对齐，颜色与所画线一一对应）
    ctx.fillStyle = panel; ctx.fillRect(PAD - 8, yLegend, W - PAD * 2 + 16, LEG_H);
    const legendItems = [];
    if (bollS) legendItems.push(['BOLL', bollCol, bollS.mid[dn - 1]]);
    (maPeriods || []).forEach((p, idx) => legendItems.push([`MA${p}`, maCols[idx % maCols.length], maSeries[idx][n - 1]]));
    const itemsPerRow = Math.ceil(legendItems.length / 2) || 1;
    const colW = (W - PAD * 2) / itemsPerRow;
    ctx.textAlign = 'left';
    legendItems.forEach((it, idx) => {
      const row = idx < itemsPerRow ? 0 : 1;
      const col = idx < itemsPerRow ? idx : idx - itemsPerRow;
      const cx = PAD + colW * col + colW / 2;
      const cy = yLegend + 14 + row * 26;
      ctx.fillStyle = it[1]; ctx.fillRect(cx - colW / 2 + 8, cy - 7, 14, 14);
      ctx.fillStyle = ink; ctx.font = '13px cjk';
      ctx.fillText(`${it[0]} ${it[2] != null ? fp(it[2]) : '-'}`, cx - colW / 2 + 28, cy);
    });
  }

  // 成交量副图（fetchStockKline 已把 vol 差分好，渲染直接用）
  const volOf = (k, i) => k.vol;
  const vols = display.map((k, i) => volOf(k, i));
  const volBase = Math.max(...vols.slice(1), 1);
  const volTop = yLegend + LEG_H + 6;
  const volH = VOL_H - 22;
  for (let i = 0; i < dn; i++) {
    const k = display[i];
    const vh = Math.min(volOf(k, i), volBase * 2) / volBase * volH;
    const col = k.close >= (i > 0 ? display[i - 1].close : k.close) ? upC : downC;
    const xk = timeMode ? mapX(i) : X(i);
    ctx.fillStyle = col; ctx.globalAlpha = 0.5;
    ctx.fillRect(xk - cw / 2, volTop + volH - vh, cw, vh);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = sub; ctx.textAlign = 'left'; ctx.font = '12px cjk';
  ctx.fillText('成交量', PAD, volTop + volH + 16);

  // 基本面面板（个股）
  if (showInfo) {
    const infoTop = volTop + volH + 26;
    ctx.fillStyle = panel; ctx.fillRect(PAD - 8, infoTop - 6, W - PAD * 2 + 16, INFO_H);
    ctx.fillStyle = ink;
    const f = v => isFinite(v) ? v.toFixed(2) : '-';
    const yi = s => Number(s) / 1e8;
    // hl: 1=红色加粗（PE动/PB 动态估值），2=深色加粗（今开/最高/最低 突出）
    const rows = [
      [
        { l: '市盈率(动)', v: f(quote.peDyn), hl: 1 },
        { l: '市盈率(TTM)', v: f(quote.peTtm) },
        { l: '市盈率(静)', v: f(quote.peStatic) },
        { l: '市净率', v: f(quote.pb), hl: 1 },
        { l: '每股收益', v: f(quote.eps) },
        { l: '股息(TTM)', v: f(quote.divYield > 0 ? quote.divYield * quote.price / 100 : 0) },
      ],
      [
        { l: '总股本', v: (yi(quote.totalShares) ? yi(quote.totalShares).toFixed(2) + '亿' : '-') },
        { l: '总市值', v: f(quote.mktCap) + '亿' },
        { l: '每股净资产', v: f(quote.bvps) },
        { l: '股息率(TTM)', v: f(quote.divYield) + '%' },
        { l: '流通股', v: (yi(quote.floatShares) ? yi(quote.floatShares).toFixed(2) + '亿' : '-') },
        { l: '流通值', v: f(quote.floatMktCap) + '亿' },
      ],
      [
        { l: '换手率', v: f(quote.turnover) + '%' },
        { l: '量比', v: f(quote.volumeRatio) },
        { l: '振幅', v: f(quote.amplitude) + '%' },
        { l: '今开', v: f(quote.open), hl: 2 },
        { l: '最高', v: f(quote.high), hl: 2 },
        { l: '最低', v: f(quote.low), hl: 2 },
      ],
    ];
    const colW = (W - PAD * 2) / 6;
    ctx.textAlign = 'left';
    rows.forEach((items, ri) => items.forEach((it, ci) => {
      const x = PAD + colW * ci + 10;
      const y = infoTop + 14 + ri * 24;
      ctx.fillStyle = sub; ctx.font = '12px cjk';
      ctx.fillText(it.l, x, y);
      const vx = x + ctx.measureText(it.l).width + 5;
      if (it.hl === 1) { ctx.fillStyle = upC; ctx.font = 'bold 12.5px cjk'; }
      else if (it.hl === 2) { ctx.fillStyle = '#1a1d23'; ctx.font = 'bold 13px cjk'; }
      else { ctx.fillStyle = ink; ctx.font = '12.5px cjk'; }
      ctx.fillText(it.v, vx, y);
    }));
  }

  // 右下角生成时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  ctx.fillText('生成 ' + hhmm, W - PAD, H - 12);

  // 编码 base64
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// 渲染 K 线 SVG → PNG base64（resvg fallback，@napi-rs/canvas 失败时使用）
function renderStockPngSvg(code, name, periodLabel, klines, { maPeriods, boll, timeMode, prec = 2 }, quote) {
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-'; // 价格显示精度（ETF 三位小数时 prec=3，普通股票 2）
  const W = 1000, PAD = 74, TITLE_H = 62, VOL_H = 120;
  const isHK = code.startsWith('hk'); // 港股：字段口径不同，不显示基本面面板
  const isUS = code.startsWith('us');
  const isHF = code.startsWith('hf_'); // 国际商品：接近24h连续交易，分时用索引等距映射
  const showInfo = !isHK && !isUS && quote && (quote.peTtm > 0 || quote.pb > 0) && quote.mktCap > 0; // 美股无 PE动/静/PB 等字段，同样不显示
  // 分时：图例条占 30px（价格/均价/昨收），需计入否则成交量柱会捅进图例区；日线 66（两行）、分钟线 40（单行）
  const LEG_H = timeMode ? 30 : ((maPeriods && maPeriods.length > 0) ? 66 : 40);
  const INFO_H = 74; // 基本面三行
  const H = TITLE_H + VOL_H + LEG_H + (showInfo ? INFO_H : 0) + PAD + 8 + 340; // plotH 约 340+，总高自适应
  const n = klines.length;
  // 显示根数：分时=当天全部分钟（≤240）；日线=60 根（3 个月，指数日波动 20 点左右，根数过多会把近期波动压扁）；其余分钟线=120 根
  const display = timeMode
    ? (isHF ? klines : klines.filter(k => { const t = String(k.t); return t >= '0930' && t <= ((isHK || isUS) ? '1600' : '1500'); })) // 分时：当天全部数据（港股/美股到16:00），商品全量
    : (periodLabel === '日线' ? klines.slice(-60) : klines.slice(-120));
  const dn = display.length;
  const plotW = W - PAD * 2, plotH = H - TITLE_H - VOL_H - LEG_H - (showInfo ? INFO_H : 0) - PAD - 8;
  const highs = display.map(k => k.high), lows = display.map(k => k.low);

  // 计算指标（全量后切片）——先算，供价格范围与绘制共用
  const allCloses = klines.map(k => k.close);
  const maSeries = (maPeriods || []).map(p => calcSMA(allCloses, p).slice(bi0(n, dn)));
  const bollS = (boll && !timeMode) ? (() => { const b = calcBOLL(allCloses); return { mid: b.mid.slice(bi0(n, dn)), up: b.up.slice(bi0(n, dn)), low: b.low.slice(bi0(n, dn)) }; })() : null;
  function bi0(nn, dnn) { return nn - dnn; }

  // 分时模式：均价线 = 累计额/累计量（元/股），昨收为基准线
  // 注意：指数（sh000xxx / sz399xxx）分时数据的累计额/量是成分股合计（万亿/百亿手），
  //       算出的"均价"是无意义的垃圾值（上证实测 -200~4000，会撑爆 Y 轴），指数分时不画均价线（与行情软件一致）
  const isIndex = /^(sh000|sz399|hkHSI)/.test(code);
  let avgSeries = null, prevCloseRef = 0;
  if (timeMode) {
    // 昨收 = 快照 a[4]（最准），用户要求拿不到就算了不画线
    if (quote && Number(quote.prevClose) > 0) prevCloseRef = Number(quote.prevClose);
    if (!isIndex) avgSeries = display.map(k => (k.avgPrice > 0) ? k.avgPrice : ((k.cumAmt && k.cumVol) ? (k.cumAmt / (k.cumVol * ((isHK || isUS) ? 1 : 100))) : k.close)); // 港股/美股分时量单位是股，A股是手
  }

  // 价格范围：高低点 + BOLL 上下轨 + 均价 + 昨收基准
  let allP = [...highs, ...lows];
  if (bollS) {
    for (let i = 0; i < dn; i++) {
      if (bollS.up[i] != null) { allP.push(bollS.up[i]); allP.push(bollS.low[i]); }
    }
  }
  if (timeMode) {
    if (avgSeries) allP.push(...avgSeries);
    if (prevCloseRef) allP.push(prevCloseRef);
  }
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const range = (hi - lo) || 1;
  const padP = range * 0.04; // Y 轴上下缓冲（紧凑，避免把近期波动压扁）
  const yMin = lo - padP, yMax = hi + padP;
  const X = i => PAD + (i + 0.5) * (plotW / dn);
  const Y = p => TITLE_H + plotH - ((p - yMin) / (yMax - yMin)) * plotH;
  const step = plotW / dn;
  // 分时模式：X 轴按「交易分钟连续」映射（A股 240 分钟；港股 9:30-12:00/13:00-16:00=330 分钟），午休相邻不强调
  const TOT = isUS ? 390 : (isHK ? 330 : 240);
  const tmin = t => {
    const hh = Number(String(t).slice(0, 2)), mm = Number(String(t).slice(2, 4));
    const m = hh * 60 + mm;
    if (isUS) return Math.min(TOT - 1, Math.max(0, m - 570)); // 美股 9:30-16:00 连续 390 分钟
    if (isHK) return Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780))); // 上午0-150 下午150-330
    return Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660));
  };
  const mapX = timeMode ? (isHF ? X : (i => PAD + (tmin(display[i].t) / TOT) * plotW)) : X;
  const cw = timeMode ? (isHF ? Math.max(1.5, plotW / dn * 0.7) : Math.max(1.5, plotW / TOT * 0.7)) : Math.max(2, Math.min(8, step * 0.6)); // K线/分时柱宽

  // 白底配色
  const upCol = '#e0483e', downCol = '#12a05c'; // A股红涨绿跌
  const bg = '#ffffff', panel = '#f7f8fa', grid = '#e8eaed';
  const ink = '#2b2f36', sub = '#8a919c';
  const maCols = ['#333333', '#f56c6c', '#409eff', '#9b59b6', '#2ecc71', '#e67e22', '#95a5a6']; // MA5 黑线（用户指定），其余保持
  const bollCol = '#f0b90b';

  // 最新一根 & 涨跌
  const last = klines[n - 1];
  // 分时：现价/昨收用快照（分时末行是盘后杂数据，相邻价差≈0 会算错涨跌）；K线用数据收盘价
  const lastPrice = (quote && Number(quote.price) > 0) ? Number(quote.price) : last.close;
  const prevClose = (timeMode && quote && Number(quote.prevClose) > 0) ? Number(quote.prevClose) : (klines[n - 2]?.close ?? last.open);
  const chg = lastPrice - prevClose;
  const chgPct = prevClose ? (chg / prevClose * 100) : 0;
  const isUp = chg >= 0;
  const chgCol = isUp ? upCol : downCol;
  // 分时：以「今开」为红绿基准（与价格线一致）；其他周期用昨收
  const openRef = (quote && Number(quote.open) > 0) ? Number(quote.open) : (klines[0]?.close ?? lastPrice);

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>
<rect x="0" y="0" width="${W}" height="${TITLE_H}" fill="${panel}"/>
<text x="${PAD}" y="34" font-family="PingFang SC,Hiragino Sans GB,cjk" font-size="24" font-weight="bold" fill="${ink}">${esc(name)} <tspan fill="${sub}" font-size="16">${code.toUpperCase()}</tspan></text>
<text x="${PAD}" y="54" font-family="PingFang SC,cjk" font-size="13" fill="${sub}">${periodLabel}</text>`;
  // 标题右侧：今天价格（颜色分时按今开，其他按昨收；涨跌额/涨跌幅数字一律按昨收标准收益率）
  const dCol = chgCol; // 右上角颜色与收益率统一按昨收（红涨绿跌标准口径）
  const numChg = lastPrice - prevClose;
  const numPct = prevClose ? (numChg / prevClose * 100) : 0;
  s += `<text x="${W - PAD}" y="30" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" fill="${sub}">今日价格</text>`;
  s += `<text x="${W - PAD}" y="52" text-anchor="end" font-family="PingFang SC,cjk" font-size="26" font-weight="bold" fill="${dCol}">${fp(lastPrice)}</text>`;
  s += `<text x="${W - PAD}" y="70" text-anchor="end" font-family="PingFang SC,cjk" font-size="15" fill="${dCol}">${numChg >= 0 ? '+' : ''}${fp(numChg)} (${numPct >= 0 ? '+' : ''}${numPct.toFixed(2)}%)</text>`;

  // 网格 + Y 轴
  const gridN = 5;
  for (let i = 0; i <= gridN; i++) {
    const p = yMin + (yMax - yMin) * i / gridN;
    const y = Y(p);
    s += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${grid}" stroke-width="1"/>`;
    s += `<text x="${PAD - 10}" y="${y + 5}" text-anchor="end" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${fp(p)}</text>`;
  }
  // X 轴时间标签：分时精确对齐曲线时刻 tmin 映射（12:00/13:00 相邻不重复标）；商品取首/中/末；其余取首/中/末
  if (timeMode) {
    const fmtT = t => String(t).slice(0, 2) + ':' + String(t).slice(2, 4);
    const lbs = isHF
      ? [[0, fmtT(display[0].t)], [Math.floor(dn / 2), fmtT(display[Math.floor(dn / 2)].t)], [dn - 1, fmtT(display[dn - 1].t)]]
      : (isUS
        ? [[0, '09:30'], [90, '11:00'], [180, '12:30'], [270, '14:00'], [TOT - 1, '16:00']]
        : (isHK ? [[0, '09:30'], [60, '10:30'], [120, '11:30'], [180, '14:00'], [240, '15:00'], [TOT - 1, '16:00']] : [[0, '09:30'], [59, '10:30'], [119, '11:30'], [180, '14:00'], [TOT - 1, '15:00']]));
    lbs.forEach(([tm, lb]) => {
      const x = isHF ? X(tm) : (PAD + (tm / TOT) * plotW);
      s += `<text x="${x.toFixed(1)}" y="${TITLE_H + plotH + 16}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${lb}</text>`;
    });
  } else {
    const ticks = [0, Math.floor((dn - 1) / 2), dn - 1];
    ticks.forEach(i => {
      const t = String(display[i].t);
      const label = periodLabel === '日线' ? t.slice(5) : (periodLabel === '周线' || periodLabel === '月线' ? t.slice(2, 7) : t.slice(8, 12).replace(/(\d{2})(\d{2})/, '$1:$2'));
      s += `<text x="${X(i)}" y="${TITLE_H + plotH + 16}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${label}</text>`;
    });
  }

  // 图例区纵坐标（两种模式共用）
  const yLegend = TITLE_H + plotH + 34;

  if (timeMode) {
    // —— 分时模式：昨收基准虚线 + 价格线 + 均价线 ——
    if (prevCloseRef) {
      const yRef = Y(prevCloseRef);
      s += `<line x1="${PAD}" y1="${yRef}" x2="${W - PAD}" y2="${yRef}" stroke="${sub}" stroke-width="1.1" stroke-dasharray="4 4" opacity="0.8"/>`;
      s += `<rect x="${PAD - 6}" y="${yRef - 10}" width="70" height="20" rx="3" fill="${sub}"/>`;
      s += `<text x="${PAD + 29}" y="${yRef + 4}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="11" fill="#fff">昨收 ${fp(prevCloseRef)}</text>`;
    }
    // 价格线颜色：以「今开」为红绿基准（现价 > 今开 = 红），而非昨收（用户要求，与行情软件一致）
    const priceCol = lastPrice >= openRef ? upCol : downCol;
    let dPrice = '', dAvg = '';
    for (let i = 0; i < dn; i++) {
      const px = mapX(i).toFixed(1);
      dPrice += (i === 0 || !dPrice ? 'M ' : 'L ') + px + ' ' + Y(display[i].close).toFixed(1) + ' ';
      if (avgSeries) dAvg += (i === 0 || !dAvg ? 'M ' : 'L ') + px + ' ' + Y(avgSeries[i]).toFixed(1) + ' ';
    }
    s += `<path d="${dPrice}" fill="none" stroke="${priceCol}" stroke-width="2"/>`;
    if (avgSeries) s += `<path d="${dAvg}" fill="none" stroke="#f0b90b" stroke-width="1.4"/>`;
    // 图例：价格 / 均价（仅个股） / 昨收（整体下移 16px，避开 X 轴时间标签）
    s += `<rect x="${PAD - 8}" y="${yLegend}" width="${W - PAD * 2 + 16}" height="30" rx="8" fill="${panel}"/>`;
    const lg = [[`价格 ${fp(lastPrice)}`, priceCol]];
    if (avgSeries) lg.push([`均价 ${fp(avgSeries[dn - 1])}`, '#f0b90b']);
    lg.push([`昨收 ${fp(prevCloseRef)}`, sub]);
    lg.forEach((it, i) => {
      const cx = PAD + 60 + i * 220;
      s += `<rect x="${cx - 60}" y="${yLegend + 7}" width="14" height="14" rx="3" fill="${it[1]}"/>`;
      s += `<text x="${cx - 40}" y="${yLegend + 19}" font-family="PingFang SC,cjk" font-size="13" fill="${ink}">${esc(it[0])}</text>`;
    });
  } else {
  // 主图：BOLL + MA（先画线，再画 K 线压在上面）
  if (bollS) {
    let dUp = '', dLow = '', dMid = '';
    for (let i = 0; i < dn; i++) {
      if (bollS.up[i] != null) dUp += (dUp ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(bollS.up[i]).toFixed(1) + ' ';
      if (bollS.low[i] != null) dLow += (dLow ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(bollS.low[i]).toFixed(1) + ' ';
      if (bollS.mid[i] != null) dMid += (dMid ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(bollS.mid[i]).toFixed(1) + ' ';
    }
    if (dUp) s += `<path d="${dUp}" fill="none" stroke="${bollCol}" stroke-width="1.6" stroke-dasharray="6 4"/>`;
    if (dLow) s += `<path d="${dLow}" fill="none" stroke="${bollCol}" stroke-width="1.6" stroke-dasharray="6 4"/>`;
    if (dMid) s += `<path d="${dMid}" fill="none" stroke="${bollCol}" stroke-width="1.4"/>`;
  }
  maSeries.forEach((series, idx) => {
    let d = '';
    for (let i = 0; i < dn; i++) if (series[i] != null) d += (d ? 'L ' : 'M ') + X(i).toFixed(1) + ' ' + Y(series[i]).toFixed(1) + ' ';
    if (d) s += `<path d="${d}" fill="none" stroke="${maCols[idx % maCols.length]}" stroke-width="1.4"/>`;
  });

  // 主图：K线
  for (let i = 0; i < dn; i++) {
    const k = display[i];
    const up = k.close >= k.open;
    const col = up ? upCol : downCol;
    const x = X(i);
    const yHi = Y(k.high), yLo = Y(k.low);
    const yO = Y(k.open), yC = Y(k.close);
    s += `<line x1="${x}" y1="${yHi}" x2="${x}" y2="${yLo}" stroke="${col}" stroke-width="1"/>`;
    const top = Math.min(yO, yC), hgt = Math.max(1.2, Math.abs(yO - yC));
    s += `<rect x="${x - cw / 2}" y="${top}" width="${cw}" height="${hgt}" fill="${col}" rx="1"/>`;
  }

  // 最新价标注：横虚线 + 右侧色块标签（分时按今开红绿，其他周期按昨收）
  const yLast = Y(lastPrice);
  const markCol = chgCol; // 最新价标注颜色与右上角一致（昨收基准）
  s += `<line x1="${PAD}" y1="${yLast}" x2="${W - PAD}" y2="${yLast}" stroke="${markCol}" stroke-width="1.2" stroke-dasharray="6 4" opacity="0.7"/>`;
  s += `<rect x="${W - PAD}" y="${yLast - 12}" width="64" height="24" rx="4" fill="${markCol}"/>`;
  s += `<text x="${W - PAD + 32}" y="${yLast + 4}" text-anchor="middle" font-family="PingFang SC,cjk" font-size="13" font-weight="bold" fill="#ffffff">${fp(lastPrice)}</text>`;

  // 图例区（每根线：色块 + 名称 + 最新值；日线 8 项分两行，分钟线 1 项单行；整体下移 16px 避开 X 轴时间标签）
  s += `<rect x="${PAD - 8}" y="${yLegend}" width="${W - PAD * 2 + 16}" height="${LEG_H}" rx="8" fill="${panel}"/>`;
  const legendItems = [];
  if (bollS) legendItems.push(['BOLL中', bollCol, bollS.mid[dn - 1]]);
  (maPeriods || []).forEach((p, idx) => legendItems.push([`MA${p}`, maCols[idx % maCols.length], maSeries[idx][dn - 1]]));
  const itemsPerRow = Math.ceil(legendItems.length / 2);
  const colW = (W - PAD * 2) / Math.max(itemsPerRow, 1);
  legendItems.forEach((it, idx) => {
    const row = idx < itemsPerRow ? 0 : 1;
    const col = idx < itemsPerRow ? idx : idx - itemsPerRow;
    const cx = PAD + colW * col + colW / 2;
    const cy = yLegend + 14 + row * 26;
    const v = it[2];
    const txt = `${it[0]} ${v != null ? fp(v) : '-'}`;
    s += `<rect x="${cx - colW / 2 + 8}" y="${cy - 7}" width="14" height="14" rx="3" fill="${it[1]}"/>`;
    s += `<text x="${cx - colW / 2 + 28}" y="${cy + 5}" font-family="PingFang SC,cjk" font-size="13" fill="${ink}">${esc(txt)}</text>`;
  });
  } // end else (非分时)

  // 成交量（底部副图；分时模式每根取累计量差值=该分钟增量）
  const volOf = (k, i) => timeMode ? Math.max(0, k.vol - (i > 0 ? display[i - 1].vol : 0)) : k.vol;
  const vols = display.map((k, i) => volOf(k, i));
  // 排除首根（开盘量常异常放大，会把其余柱压到贴地）后的最大值作为高度基准，
  // 开盘柱封顶为基准的 2 倍（用户要求「深红 ≈ 红的 2 倍」），让中间时段柱可见
  const volBase = Math.max(...vols.slice(1), 1);
  const volTop = yLegend + LEG_H + 6;
  const volH = VOL_H - 22;
  for (let i = 0; i < dn; i++) {
    const k = display[i];
    const vh = Math.min(volOf(k, i), volBase * 2) / volBase * volH;
    const col = k.close >= (i > 0 ? display[i - 1].close : k.close) ? upCol : downCol;
    const xk = timeMode ? mapX(i) : X(i);
    s += `<rect x="${xk - cw / 2}" y="${volTop + volH - vh}" width="${cw}" height="${vh}" fill="${col}" opacity="0.5" rx="1"/>`;
  }
  s += `<text x="${PAD}" y="${volTop + volH + 16}" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">成交量</text>`;

  // 底部基本面面板（个股，三行全字段）
  if (showInfo) {
    const infoTop = volTop + volH + 26;
    s += `<rect x="${PAD - 8}" y="${infoTop - 6}" width="${W - PAD * 2 + 16}" height="${INFO_H}" rx="8" fill="${panel}"/>`;
    const f = (v, d = 2) => v && isFinite(v) ? v.toFixed(d) : '-';
    const yi = v => Number(v) > 0 ? (Number(v) / 1e8).toFixed(2) + '亿' : '-'; // 股本股→亿
    const divAmt = quote.divYield > 0 ? quote.divYield * quote.price / 100 : 0;
    const rows = [
      // 行1：估值
      [
        `市盈率(动) ${f(quote.peDyn)}`, `市盈率(TTM) ${f(quote.peTtm)}`, `市盈率(静) ${f(quote.peStatic)}`,
        `市净率 ${f(quote.pb)}`, `每股收益 ${f(quote.eps)}`, `每股净资产 ${f(quote.bvps)}`,
      ],
      // 行2：股本/市值/股息
      [
        `总市值 ${f(quote.mktCap)}亿`, `流通值 ${f(quote.floatMktCap)}亿`,
        `总股本 ${yi(quote.totalShares)}`, `流通股 ${yi(quote.floatShares)}`,
        `股息率(TTM) ${f(quote.divYield)}%`, `股息(TTM) ${f(divAmt)}`,
      ],
      // 行3：交易/行情
      [
        `换手率 ${f(quote.turnover)}%`, `量比 ${f(quote.volumeRatio)}`, `振幅 ${f(quote.amplitude)}%`,
        `今开 ${f(quote.open)}`, `最高 ${f(quote.high)}`, `最低 ${f(quote.low)}`,
      ],
    ];
    const colW = (W - PAD * 2) / 6;
    const rowH = 24;
    rows.forEach((items, ri) => items.forEach((it, ci) => {
      s += `<text x="${PAD + colW * ci + 10}" y="${infoTop + 14 + ri * rowH}" font-family="PingFang SC,cjk" font-size="12.5" fill="${ink}">${esc(it)}</text>`;
    }));
  }

  // 右下角：生成时间（用户要求标注，便于核对时效）
  const genT = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  s += `<text x="${W - PAD}" y="${H - 12}" text-anchor="end" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">生成 ${genT}</text>`;

  s += `</svg>`;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const r = new Resvg(s, { fitTo: { mode: 'width', value: W }, font: { fontFiles: ['/app/fonts/cjk_sub.ttf'], loadSystemFonts: false, defaultFontFamily: 'PingFang SC' } });
    const png = r.render().asPng();
    return 'base64://' + png.toString('base64'); // 官方网关图片仅认 base64:// 前缀（2026-08-31 踩坑：data URI 会导致「上传URL错误」）
  } catch (e) {
    console.error('[stock] 渲染失败:', e.message);
    return '';
  }
}
function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// 命令入口：返回 { ok, text?, imgDataUri? }
async function cmdStock(args) {
  const parts = (args || []).map(a => a.trim()).filter(Boolean);
  let period = 'day';
  let codeInput = '';
  if (parts.length >= 1 && STOCK_PERIODS[parts[0].toLowerCase()]) {
    period = STOCK_PERIODS[parts[0].toLowerCase()];
    codeInput = parts.slice(1).join('');
  } else {
    codeInput = parts.join('');
  }
  const USAGE = '📋 用法：/stock <周期> <代码或名称>\n' +
    '周期：-d 日线 | -w 周线 | -M 月线 | -1m 1分钟 | -5m 5分钟 | -30m 30分钟 | -1h 60分钟 | -t 分时\n' +
    '例：/stock -d 600519　/stock -w 贵州茅台　/stock -M 00700　/stock -t AAPL\n' +
    '不写周期默认日线，如 /stock 600519';
  // 首参以 - 开头但不是合法周期 → 提示格式
  if (parts[0] && parts[0].startsWith('-') && !STOCK_PERIODS[parts[0].toLowerCase()]) {
    return { ok: false, text: `⚠️ 未知周期「${parts[0]}」，支持：-d / -w / -M / -1m / -5m / -30m / -1h / -t\n\n${USAGE}` };
  }
  if (!codeInput) return { ok: false, text: USAGE };

  // 解析代码：数字直用，名称走搜索
  let code = normalizeCode(codeInput);
  let resolvedName = '';
  if (!code) {
    code = await resolveStockCode(codeInput);
    if (!code) return { ok: false, text: `⚠️ 未找到「${codeInput}」，请用代码或股票/ETF/港股/美股名称` };
    resolvedName = codeInput;
  }
  const isUS = code.startsWith('us');
  const isHF = code.startsWith('hf_');
  // 美股：分钟K 数据源不支持；日/周/月/分时可用（盘后分时自动回退上个交易日）
  if (isUS && !STOCK_LONG.includes(period) && period !== 'time') {
    return { ok: false, text: `⚠️ 美股暂不支持 ${STOCK_PERIOD_LABEL[period]} 分钟线（数据源限制）\n可用：/stock -d ${code}（日线）　/stock -w ${code}（周线）　/stock -M ${code}（月线）　/stock -t ${code}（分时）` };
  }
  // 港股：数据源（腾讯）无分钟K历史；日/周/月/分时可用
  const isHK = code.startsWith('hk');
  if (isHK && !STOCK_LONG.includes(period) && period !== 'time') {
    return { ok: false, text: `⚠️ 港股暂不支持 ${STOCK_PERIOD_LABEL[period]} 分钟线（数据源限制）\n可用：/stock -d ${code.slice(2)}（日线）　/stock -w ${code.slice(2)}（周线）　/stock -M ${code.slice(2)}（月线）　/stock -t ${code.slice(2)}（分时）` };
  }
  // 国际商品：仅分时 -t（新浪全球期货），无日K/分钟K
  if (isHF && period !== 'time') {
    if (period === 'day') {
      const q = await fetchStockQuote(code);
      return { ok: true, text: q ? globalQuoteText(code, q) : `⚠️ 获取 ${code} 行情失败，请稍后重试` };
    }
    return { ok: false, text: `⚠️ 国际商品仅支持 -t 分时图（新浪数据源限制）\n可用：/stock -t ${code}` };
  }
  // 全球指数（usDJI/usIXIC/usINX/hkHSI）：无K线 → 文本行情速查；例外：恒指 hkHSI 腾讯有分时 → 支持 -t 图
  if (GLOBAL_TEXT[code] && !(code === 'hkHSI' && period === 'time')) {
    const q = await fetchStockQuote(code);
    if (!q) return { ok: false, text: `⚠️ 获取 ${code} 行情失败，请稍后重试` };
    const note = period !== 'day'
      ? `\n⚠️ ${STOCK_PERIOD_LABEL[period]}图暂不支持（腾讯对国际商品/指数无该周期数据），以上为最新行情速查`
      : '';
    return { ok: true, text: globalQuoteText(code, q) + note };
  }
  const [kline, quote] = await Promise.all([fetchStockKline(code, period), fetchStockQuote(code)]);
  if (!kline) return { ok: false, text: `⚠️ 获取 ${code} ${STOCK_PERIOD_LABEL[period]} 数据失败，请确认代码是否正确` };
  const name = quote?.name || resolvedName || code;
  // 分时若用的是历史数据（东财 fallback），在标题标注日期，如「分时 08-31」
  const periodLabel = (STOCK_PERIOD_LABEL[period] || period) + (period === 'time' && kline._date ? ' ' + kline._date : '');

  const isDay = period === 'day';
  const isTime = period === 'time';
  const maPeriods = (isDay || period === 'week' || period === 'month') ? [5, 10, 20] : []; // 日/周/月线保留 5/10/20 均线
  const last = kline[kline.length - 1];
  // 价格精度：普通股票 2 位，部分 ETF/品种价格三位小数 → 按真实现价判断（勿扫 qfq 历史价，前复权会产生 3 位假小数）
  let prec = 2;
  const ref = (quote && isFinite(quote.price) && Number(quote.price) > 0) ? Number(quote.price) : (isFinite(last.close) ? Number(last.close) : 0);
  if (ref > 0) {
    const sv = String(ref);
    const dot = sv.indexOf('.');
    if (dot > 0 && sv.slice(dot + 1).replace(/0+$/, '').length > 2) prec = 3;
  }
  const img = renderStockPng(code, name, periodLabel, kline, { maPeriods, boll: isDay || !isTime, timeMode: isTime, prec }, quote);
  if (!img) return { ok: false, text: '⚠️ 图表渲染失败（服务端缺少字体/渲染库）' };

  const capCode = code.replace(/\.\w+$/, '').toUpperCase(); // usAAPL.OQ → USAAPL（图内代码去交易所后缀）
  const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-';
  const lastPx = (quote && isFinite(quote.price) && Number(quote.price) > 0) ? Number(quote.price) : last.close; // 现价用快照（K线末根可能丢精度）
  const caption = `📈 ${name}（${capCode}）${periodLabel}\n现价 ${fp(lastPx)}${quote?.chgPct != null ? `  ${quote.chg >= 0 ? '+' : ''}${fp(Number(quote.chg))} (${quote.chgPct >= 0 ? '+' : ''}${Number(quote.chgPct).toFixed(2)}%)` : ''}`;
  return { ok: true, text: caption, img };
}

// 商品（hf_）/全球指数（usDJI/usIXIC/usINX/hkHSI）文本速查：无K线数据，仅输出快照行情
function globalQuoteText(code, q) {
  const arrow = q.chgPct >= 0 ? '🔺' : '🔻';
  const sym = code.replace('hf_', '').replace(/\.\w+$/, '').toUpperCase();
  const L = [];
  const priceLabel = q.market === 'hf' ? '现价' : '点位';
  L.push(`📈 ${q.name}（${sym}）`);
  L.push(`${priceLabel} ${f2p(q.price)}  ${arrow} ${q.chg >= 0 ? '+' : ''}${q.chg.toFixed(2)} (${q.chgPct >= 0 ? '+' : ''}${q.chgPct.toFixed(2)}%)`);
  L.push(`今开 ${q.open > 0 ? f2p(q.open) : '-'}  最高 ${q.high > 0 ? f2p(q.high) : '-'}  最低 ${q.low > 0 ? f2p(q.low) : '-'}  昨收 ${f2p(q.prevClose)}`);
  if (q.market === 'hf') L.push(`更新 ${q.date} ${q.time}（国际商品行情）`);
  else L.push(`更新 ${String(q.time).slice(5, 16)}${q.market === 'us' ? '（美东时间）' : '（北京时间）'}`);
  return L.join('\n');
}

// ---------- /info 个股信息速查（公司概况+行情+公告+新闻，2026-09-01 新增） ----------
// 用法：/info <代码或名称> [条数]（公告/新闻各 N 条，默认 8，1-10）
// 数据源：行情=腾讯 qt.gtimg.cn；公司概况=东财 F10 RPT_F10_BASIC_ORGINFO；公告=东财 np-anotice-stock；新闻=东财 search-api-web
const EM_F10 = 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_BASIC_ORGINFO&columns=ALL&filter=(SECUCODE%3D%22%s%22)&pageNumber=1&pageSize=1&source=HSF10&client=PC';
const EM_ANN = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=%s&page_index=1&ann_type=A&client_source=web&stock_list=%s';
const EM_NEWS = 'https://search-api-web.eastmoney.com/search/jsonp?cb=callback&param=%s';
const EM_UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Referer': 'https://www.eastmoney.com/' };

// 6位代码 → { pre:'sh'|'sz'|'bj', raw, secucode:'000001.SZ' }
function infoMarket(code) {
  let c = String(code || '').toLowerCase();
  if (/^(sh|sz|bj|hk)/.test(c)) {
    const pre = c.slice(0, 2); const raw = c.slice(2);
    return { pre, raw, secucode: pre === 'hk' ? `${raw}.HK` : `${raw}.${pre.toUpperCase()}` };
  }
  const raw = c;
  const pre = /^[69]/.test(c) ? 'sh' : /^[48]/.test(c) ? 'bj' : 'sz';
  return { pre, raw, secucode: `${raw}.${pre.toUpperCase()}` };
}

async function fetchCompany(secucode) { // 东财 F10 公司概况
  try {
    const r = await fetch(EM_F10.replace('%s', encodeURIComponent(secucode)), { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const row = j?.result?.data?.[0];
    if (!row) return null;
    return {
      org: row.ORG_NAME, industry: row.INDUSTRYCSRC1, emIndustry: row.EM2016,
      chairman: row.CHAIRMAN, president: row.PRESIDENT, secretary: row.SECRETARY,
      web: row.ORG_WEB, listDate: (row.LISTING_DATE || '').slice(0, 10), emp: row.EMP_NUM,
      profile: String(row.ORG_PROFILE || '').trim(), mainBiz: String(row.MAIN_BUSINESS || '').trim(),
    };
  } catch (_) { return null; }
}

async function fetchAnns(code, n) { // 东财最近公告
  try {
    const r = await fetch(EM_ANN.replace('%s', n).replace('%s', code), { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const list = j?.data?.list || [];
    return list.slice(0, n).map(a => ({
      date: (a.notice_date || '').slice(0, 10),
      title: a.title || '',
      url: `https://data.eastmoney.com/notices/detail/${code}/${a.art_code}.html`,
    }));
  } catch (_) { return []; }
}

async function fetchNews(keyword, n) { // 东财个股新闻（按时间倒序）
  try {
    const param = JSON.stringify({
      uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: n, preTag: '', postTag: '' } },
    }, null, 0);
    const r = await fetch(EM_NEWS.replace('%s', encodeURIComponent(param)), { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    const i = t.indexOf('('), j = t.lastIndexOf(')');
    if (i < 0 || j < i) return [];
    const d = JSON.parse(t.slice(i + 1, j));
    const list = d?.result?.cmsArticleWebOld || [];
    return list.slice(0, n).map(a => ({ date: (a.date || '').slice(0, 16), media: a.mediaName || '', title: a.title || '', url: a.url || '' }));
  } catch (_) { return []; }
}

// 折行：文本按宽度换行，最多 maxLines 行
function wrapText(ctx, text, maxW, maxLines) {
  const out = [];
  for (const seg of String(text).split('\n')) {
    let line = '';
    for (const ch of seg) {
      if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; if (out.length >= maxLines) return out; }
      else line += ch;
    }
    if (line) out.push(line);
    if (out.length >= maxLines) return out;
  }
  return out;
}

// /info 图渲染：白底竖版（标题+行情+公司概况+公告+新闻）
function renderInfoPng(data) {
  try { return renderInfoPngCanvas(data); }
  catch (e) { console.error('[info] canvas 渲染失败:', e.message); return ''; }
}
function renderInfoPngCanvas(data) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 720, PAD = 20;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#e0483e', downC = '#2aa36b';
  const f2 = v => (isFinite(v) ? v.toFixed(2) : '-');
  // 预排版计算高度
  const ctx0 = createCanvas(W, 100).getContext('2d');
  ctx0.font = '13px cjk';
  const rowH = 22;
  let y = 18;
  y += 46;                                  // 标题区
  y += 92 + 10;                             // 行情卡片
  y += 24;                                  // 公司块 label
  y += wrapText(ctx0, data.co?.profile || '', W - PAD * 2 - 10, 3).length * rowH + 8;
  y += wrapText(ctx0, data.co?.mainBiz || '', W - PAD * 2 - 10, 2).length * rowH + 8;
  if (data.co) y += rowH;                   // 高管行
  y += 24;                                  // 公告块 label
  y += Math.min(data.anns.length, data.nAnn) * rowH + 8;
  y += 24;                                  // 新闻块 label
  y += Math.min(data.news.length, data.nNews) * rowH;
  y += 28;                                  // 底部时间
  const H = Math.ceil(y) + 8;

  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  y = 18;
  // 标题
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 26px cjk';
  ctx.fillText(data.name, PAD, y + 20);
  const nameW = ctx.measureText(data.name).width;
  ctx.fillStyle = sub; ctx.font = '15px cjk';
  ctx.fillText(data.code, PAD + nameW + 10, y + 20);
  if (data.co?.emIndustry) {
    const iw = ctx.measureText(data.code).width;
    ctx.fillStyle = upC; ctx.font = '13px cjk';
    ctx.fillText('· ' + data.co.emIndustry, PAD + nameW + 10 + iw + 8, y + 20);
  }
  ctx.fillStyle = sub; ctx.font = '13px cjk';
  ctx.fillText('个股信息速查', W - PAD, y + 20);
  y += 46;

  // 行情卡片
  const q = data.quote;
  if (q) {
    const chgCol = q.chgPct >= 0 ? upC : downC;
    ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(PAD, y, W - PAD * 2, 92, 12); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 22px cjk';
    ctx.fillText(f2(q.price), PAD + 16, y + 26);
    ctx.fillStyle = chgCol; ctx.font = 'bold 16px cjk';
    ctx.fillText(`${q.chgPct >= 0 ? '+' : ''}${f2(q.chg)}  (${q.chgPct >= 0 ? '+' : ''}${f2(q.chgPct)}%)`, PAD + 16 + ctx.measureText(f2(q.price)).width + 14, y + 26);
    // 两列信息
    ctx.fillStyle = sub; ctx.font = '12px cjk';
    const infoL = `今开 ${f2(q.open)}  最高 ${f2(q.high)}  最低 ${f2(q.low)}`;
    ctx.fillText(infoL, PAD + 16, y + 52);
    const amt = q.amount > 0 ? (q.amount / 10000).toFixed(1) + '亿' : '-';
    const infoR = `成交额 ${amt}  换手 ${q.turnover ? q.turnover + '%' : '-'}  量比 ${q.volumeRatio || '-'}`;
    ctx.fillText(infoR, PAD + 16, y + 74);
    ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '12px cjk';
    ctx.fillText((q.time || '').slice(11, 16) + ' ' + (q.time || '').slice(0, 10), W - PAD - 16, y + 52);
    y += 92 + 10;
  }

  // 小节标题：色块 + 文字（cjk 字体无 emoji glyph，用色块避免豆腐块错位）
  const sectionTitle = (label, color) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(PAD, y - 9, 6, 16, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 15px cjk';
    ctx.fillText(label, PAD + 14, y);
  };

  // 公司概况
  const co = data.co;
  if (co) {
    sectionTitle('公司概况', '#409eff');
    y += 24;
    const drawBlock = (label, text, maxLines) => {
      const lines = wrapText(ctx, text, W - PAD * 2 - 10, maxLines);
      ctx.fillStyle = sub; ctx.font = '13px cjk';
      ctx.fillText(label, PAD, y + 9);
      y += 18;
      ctx.fillStyle = ink; ctx.font = '13px cjk';
      for (const ln of lines) { ctx.fillText(ln, PAD + 4, y + 9); y += rowH; }
      y += 6;
    };
    if (co.profile) drawBlock('简介', co.profile, 3);
    if (co.mainBiz) drawBlock('主营', co.mainBiz, 2);
    ctx.fillStyle = sub; ctx.font = '12px cjk';
    const mgr = [co.chairman && `董事长 ${co.chairman}`, co.president && `总经理 ${co.president}`, co.secretary && `董秘 ${co.secretary}`, co.listDate && `上市 ${co.listDate}`, co.emp && `员工 ${co.emp}人`].filter(Boolean).join('  ');
    ctx.fillText(mgr, PAD + 4, y + 10);
    y += rowH + 8;
  }

  // 公告
  sectionTitle(`最近公告（${data.anns.length}条）`, '#e6a23c');
  y += 24;
  ctx.fillStyle = ink; ctx.font = '13px cjk';
  data.anns.slice(0, data.nAnn).forEach(a => {
    ctx.fillStyle = sub;
    ctx.fillText(a.date, PAD + 2, y + 8);
    ctx.fillStyle = ink;
    const title = a.title.length > 32 ? a.title.slice(0, 32) + '…' : a.title;
    ctx.fillText(title, PAD + 92, y + 8);
    y += rowH;
  });
  y += 8;

  // 新闻
  sectionTitle(`最近新闻（${data.news.length}条）`, '#2aa36b');
  y += 24;
  data.news.slice(0, data.nNews).forEach(nw => {
    ctx.fillStyle = sub; ctx.font = '12px cjk';
    ctx.fillText(nw.date.slice(5), PAD + 2, y + 8);
    ctx.fillStyle = ink; ctx.font = '13px cjk';
    const title = nw.title.length > 36 ? nw.title.slice(0, 36) + '…' : nw.title;
    ctx.fillText(title, PAD + 78, y + 8);
    if (nw.media) { ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.fillText(nw.media, PAD + 78 + ctx.measureText(title).width + 8, y + 8); }
    y += rowH;
  });

  // 底部时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  ctx.fillText('生成 ' + new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), W - PAD, H - 12);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// 文本输出（手机端阅读优化：分段清晰，emoji 由 QQ 消息原生渲染）
function infoText(data) {
  const L = [];
  if (data.deadQuote) L.push('⚠️ 当前无实时交易数据（该股可能停牌或已退市），以下行情为残留快照，仅供参考');
  const q = data.quote;
  if (q) {
    const arrow = q.chgPct >= 0 ? '🔺' : '🔻';
    L.push(`📊 ${data.name}（${data.code}）${data.co?.emIndustry ? '·' + data.co.emIndustry : ''}`);
    L.push(`现价 ${f2p(q.price)}  ${arrow} ${q.chg >= 0 ? '+' : ''}${Number(q.chg).toFixed(2)} (${q.chgPct >= 0 ? '+' : ''}${Number(q.chgPct).toFixed(2)}%)`);
    L.push(`今开 ${q.open > 0 ? f2p(q.open) : '-'}  最高 ${q.high > 0 ? f2p(q.high) : '-'}  最低 ${q.low > 0 ? f2p(q.low) : '-'}`);
    L.push(`成交额 ${q.amount > 0 ? (q.amount / 10000).toFixed(1) + '亿' : '-'}  换手 ${q.turnover ? q.turnover + '%' : '-'}  量比 ${q.volumeRatio || '-'}`);
    // 基本面（市值/PE/PB/股息率；ETF/指数等无值字段自动跳过）
    const cap = q.mktCap > 0 ? (q.mktCap >= 10000 ? (q.mktCap / 10000).toFixed(2) + '万亿' : q.mktCap.toFixed(0) + '亿') : '';
    const fcap = q.floatMktCap > 0 ? (q.floatMktCap >= 10000 ? (q.floatMktCap / 10000).toFixed(2) + '万亿' : q.floatMktCap.toFixed(0) + '亿') : '';
    const capLine = [cap && `总市值 ${cap}`, fcap && fcap !== cap && `流通市值 ${fcap}`].filter(Boolean).join('  ');
    const peVal = q.peTtm > 0 ? q.peTtm : (q.peDyn > 0 ? q.peDyn : 0);
    const valLine = [
      peVal > 0 ? `PE(TTM) ${peVal.toFixed(1)}` : '',
      q.pb > 0 ? `PB ${q.pb.toFixed(1)}` : '',
      q.divYield > 0 ? `股息率 ${q.divYield.toFixed(1)}%` : '',
    ].filter(Boolean).join('  ');
    if (capLine) L.push(capLine);
    if (valLine) L.push(valLine);
  } else {
    L.push(`📊 ${data.name}（${data.code}）`);
  }
  const co = data.co;
  if (co) {
    L.push('');
    L.push('🏢 公司概况');
    if (co.profile) L.push(`简介：${co.profile.length > 80 ? co.profile.slice(0, 80) + '…' : co.profile}`);
    if (co.mainBiz) L.push(`主营：${co.mainBiz.length > 70 ? co.mainBiz.slice(0, 70) + '…' : co.mainBiz}`);
    const mgr = [co.chairman && `董事长 ${co.chairman}`, co.president && `总经理 ${co.president}`, co.listDate && `上市 ${co.listDate}`, co.emp && `员工 ${co.emp}人`].filter(Boolean).join('  ');
    if (mgr) L.push(mgr);
  }
  L.push('');
  L.push(`📢 最近公告（${Math.min(data.anns.length, data.nAnn)}条）`);
  data.anns.slice(0, data.nAnn).forEach(a => L.push(`${a.date}  ${a.title.length > 38 ? a.title.slice(0, 38) + '…' : a.title}`));
  L.push('');
  L.push(`📰 最近新闻（${Math.min(data.news.length, data.nNews)}条）`);
  data.news.slice(0, data.nNews).forEach(n => L.push(`${n.date.slice(5, 16)}  ${n.title.length > 34 ? n.title.slice(0, 34) + '…' : n.title}${n.media ? '（' + n.media + '）' : ''}`));
  return L.join('\n');
}
// 价格格式化：动态 2~3 位小数（普通股票 2 位，ETF/品种三位小数时显示 3 位；不统一强制 3 位）
const f2p = v => {
  if (!isFinite(v)) return '-';
  const n = Number(v);
  const s = String(Math.abs(n));
  const dot = s.indexOf('.');
  const dec = dot >= 0 ? s.slice(dot + 1).replace(/0+$/, '').length : 0;
  return n.toFixed(Math.min(3, Math.max(2, dec)));
};

async function cmdInfo(args) {
  const parts = (args || []).map(a => a.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, text: '📋 用法：/info <代码或名称> [条数]\n例：/info 600519　/info 平安银行 6\n公告 3 条 + 新闻 5 条（可选第二参数统一 1-10）' };
  const codeInput = parts[0];
  let nAnn = 3, nNews = 5; // 默认：公告 3 条、新闻 5 条
  if (parts[1] && /^\d{1,2}$/.test(parts[1])) { const nn = Math.min(10, Math.max(1, parseInt(parts[1], 10))); nAnn = nn; nNews = nn; }
  // 解析代码
  let code = normalizeCode(codeInput);
  let resolvedName = '';
  if (!code) {
    code = await resolveStockCode(codeInput);
    if (!code) return { ok: false, text: `⚠️ 未找到「${codeInput}」，请用代码或名称` };
    resolvedName = codeInput;
  }
  if (/^(hk|us)/.test(code) || code.startsWith('hf_')) return { ok: false, text: '⚠️ /info 暂仅支持A股（公司资料来自东财F10）\n港股/美股/商品可用 /stock 看行情：/stock 00700　/stock AAPL　/stock 布伦特原油' };
  const mk = infoMarket(code);
  // 先取行情（拿名称做新闻关键词），再并行取公司概况/公告/新闻
  const quote = await fetchStockQuote(code);
  // 无交易行情检测：有价格但今开/成交/换手全为 0 → 停牌或已退市（如 600001 邯郸钢铁，腾讯只留退市前残留快照）
  const deadQuote = !!(quote && quote.price > 0 && quote.open <= 0 && quote.amount <= 0 && quote.turnover <= 0);
  const name = quote?.name || resolvedName || mk.raw;
  const [co, anns, news] = await Promise.all([
    fetchCompany(mk.secucode),
    fetchAnns(mk.raw, nAnn),
    fetchNews(name, nNews),
  ]);
  const data = { name, code: code.toUpperCase(), quote, co, anns, news, nAnn, nNews, deadQuote };
  // 纯文本输出（手机端阅读友好，图渲染易错位已弃用）
  return { ok: true, text: infoText(data) };
}

// ---------- /zj 申万行业资金流（2026-08-31 新增） ----------
// 用法：/zj <级别>，级别：1 一级 / 2 二级 / 3 三级
// 数据源：腾讯板块行情 getRank（hy=申万一级 31 个、hy2=申万二级 124 个），字段 zljlr=主力净流入（万）
// 注意：腾讯 hy3 无数据（total=0 实测），申万三级资金流免费源暂缺，命令内做明确提示。
const ZJ_RANK = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=%s&sort_type=price&direct=down&offset=0&count=200';
const ZJ_LEVEL_BT = { '1': 'hy', '一级': 'hy', 'sw1': 'hy', '一': 'hy', '2': 'hy2', '二级': 'hy2', 'sw2': 'hy2', '二': 'hy2', '3': 'hy3', '三级': 'hy3', 'sw3': 'hy3', '三': 'hy3' };
const ZJ_LEVEL_LABEL = { hy: '申万一级', hy2: '申万二级', hy3: '申万三级' };

// ---------- 东财行业资金流曲线（分时波动 / 日级流入，2026-09-01 新增） ----------
// 说明：申万分类无免费时序资金流源（腾讯仅快照、同花顺反爬），曲线图用东财行业分类（86 个，粒度≈申万二级）。
// 分时：push2 fflow/kline klt=1（主力净流入累计，元）→ 差分得每分钟净流入（波动直观）；
// 日K：push2his fflow/daykline klt=101（120 日每日主力净流入，元）。
const EM_BOARD_LIST = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f62';
const EM_BOARD_FF_MIN = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=90.%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
const EM_BOARD_FF_DAY = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=120&klt=101&secid=90.%s&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
const ZJ_PALETTE = ['#e0483e', '#2aa36b', '#409eff', '#f56c6c', '#9b59b6', '#e67e22', '#2ecc71', '#3498db', '#e74c3c', '#1abc9c', '#f39c12', '#8e44ad', '#2980b9', '#c0392b', '#27ae60', '#d35400', '#16a085', '#7f8c8d', '#d68910', '#34495e'];

// 东财行业列表（按当前主力净流入排序），返回 [{code,name,zljlr(元)}...]
async function fetchEmBoards() {
  const cached = cacheGet('emboards');
  if (cached) return cached;
  try {
    const r = await fetch(EM_BOARD_LIST, { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const list = (j.data?.diff || []).map(x => ({ code: String(x.f12), name: String(x.f14 || ''), zljlr: Number(x.f62) || 0 }));
    if (list.length < 2) return null;
    list.sort((a, b) => b.zljlr - a.zljlr);
    cacheSet('emboards', list, 30000); // 板块列表 30s 缓存
    return list;
  } catch (_) { return null; }
}

// 单行业主力净流入序列（元）：mode='t' 1 分钟分时（累计差分→每分钟净流入）；'d' 120 日日净流入
async function fetchBoardFflow(code, mode) {
  const ckey = 'bff:' + code + ':' + mode;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  try {
    const url = (mode === 't' ? EM_BOARD_FF_MIN : EM_BOARD_FF_DAY).replace('%s', code);
    const r = await fetch(url, { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const kl = j.data?.klines;
    if (!Array.isArray(kl) || kl.length < 2) return null;
    let prev = 0;
    const out = kl.map(k => {
      const p = String(k).split(',');
      const main = Number(p[1]) || 0;
      const v = mode === 't' ? main - prev : main; // 分时：差分得每分钟净流入；日K：当日净流入
      prev = main;
      return { t: p[0], v };
    });
    cacheSet(ckey, out, mode === 't' ? 15000 : 600000); // 分时 15s、日K 10min
    return out;
  } catch (_) { return null; }
}

// 行业资金流曲线图（canvas 白底竖版）：series=[{name,zljlr,points:[{t,v}]}]
function renderZjCurveCanvas(series, mode, levelLabel) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 1000, PAD_L = 84, PAD_R = 20, TITLE_H = 62;
  const n = series.length;
  const legendRows = Math.ceil(n / 2);
  const LEG_H = legendRows * 24 + 8;
  const plotH = 320;
  const H = TITLE_H + plotH + LEG_H + 26;
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2));
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  const bg = '#ffffff', ink = '#2b2f36', sub = '#8a919e', grid = '#e8eaed';
  const upC = '#e0483e', downC = '#2aa36b';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 24px cjk';
  ctx.fillText(`${mode === 't' ? '行业资金分时波动' : '行业资金日级流入'}（${levelLabel}）`, PAD_L, 28);
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText(`${mode === 't' ? '每分钟主力净流入（差分）' : '每日主力净流入'} · 东财行业分类 · ${hhmm}`, PAD_L, 50);
  // 数值范围
  const plotW = W - PAD_L - PAD_R;
  let yMin = 0, yMax = 0;
  for (const s of series) for (const p of s.points) { if (p.v > yMax) yMax = p.v; if (p.v < yMin) yMin = p.v; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const padY = (yMax - yMin) * 0.06 || 1;
  yMin -= padY; yMax += padY;
  const dn = Math.max(...series.map(s => s.points.length));
  const Y = v => TITLE_H + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const X = i => PAD_L + (i + 0.5) * (plotW / dn);
  // 0 轴（资金流出流入分界）
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = grid; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, Y(0)); ctx.lineTo(W - PAD_R, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // 横向网格 + Y 轴标签
  const fmtYi = v => Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + '百亿' : (v / 1e8).toFixed(1) + '亿';
  ctx.font = '12px cjk';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * i / 4;
    const y = Y(v);
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
    ctx.fillStyle = sub; ctx.textAlign = 'right';
    ctx.fillText(fmtYi(v), PAD_L - 8, y);
  }
  // 曲线
  ctx.lineWidth = 2;
  series.forEach((s, si) => {
    ctx.strokeStyle = ZJ_PALETTE[si % ZJ_PALETTE.length];
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = X(i), y = Y(p.v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  // X 轴标签（分时：首/中/末时间；日K：首/中/末日期）
  const idxs = [0, Math.floor((dn - 1) / 2), dn - 1];
  ctx.fillStyle = sub; ctx.textAlign = 'center'; ctx.font = '12px cjk';
  idxs.forEach(i => {
    const t = String(series[0].points[Math.min(i, series[0].points.length - 1)].t);
    const lb = mode === 't' ? t.slice(11, 16) : t.slice(5);
    ctx.fillText(lb, X(i), TITLE_H + plotH + 14);
  });
  // 图例（每行 2 个：色块+名称+当前累计/最新净流入）
  const legTop = TITLE_H + plotH + 26;
  const legW = (plotW - 12) / 2;
  series.forEach((s, si) => {
    const row = Math.floor(si / 2), col = si % 2;
    const x0 = PAD_L + col * (legW + 12);
    const y0 = legTop + row * 24;
    const lastV = mode === 't' ? (s.zljlr || 0) : s.points[s.points.length - 1].v; // 分时=当日累计，日K=最新日
    const yi = lastV / 1e8;
    const colC = lastV >= 0 ? upC : downC;
    ctx.fillStyle = ZJ_PALETTE[si % ZJ_PALETTE.length];
    ctx.fillRect(x0, y0 - 7, 14, 14);
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '13px cjk';
    const nm = s.name.length > 6 ? s.name.slice(0, 6) : s.name;
    ctx.fillText(nm, x0 + 20, y0);
    ctx.fillStyle = colC; ctx.textAlign = 'right'; ctx.font = 'bold 13px cjk';
    ctx.fillText(`${yi >= 0 ? '+' : ''}${yi.toFixed(1)}亿`, x0 + legW - 8, y0);
  });
  // 底部说明
  ctx.fillStyle = sub; ctx.textAlign = 'left'; ctx.font = '11px cjk';
  ctx.fillText(`曲线为东财行业分类主力净流入；图例数值：分时=当日累计，日线=最新一日`, PAD_L, H - 10);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// 生成行业资金流曲线（bt='hy'|'hy2'；mode='t'|'d'）
async function renderZjCurve(bt, mode) {
  const isL1 = bt === 'hy';
  const n = isL1 ? 10 : 5; // 一级：流入10+流出10；二级：流入5+流出5
  const boards = await fetchEmBoards();
  if (!boards || boards.length < 2) return { ok: false, text: '⚠️ 获取行业列表失败，请稍后重试' };
  const picks = [...boards.slice(0, n), ...boards.slice(-n).reverse()];
  const series = (await Promise.all(picks.map(async b => {
    const points = await fetchBoardFflow(b.code, mode);
    return points ? { name: b.name, zljlr: b.zljlr, points } : null;
  }))).filter(Boolean);
  if (series.length < 2) return { ok: false, text: '⚠️ 资金流数据获取失败，请稍后重试' };
  const img = renderZjCurveCanvas(series, mode, isL1 ? '一级' : '二级');
  if (!img) return { ok: false, text: '⚠️ 图表渲染失败' };
  const label = mode === 't' ? '资金分时波动' : '资金日级流入';
  return { ok: true, text: `📊 东财行业${label}（${isL1 ? '一级：流入10+流出10' : '二级：流入5+流出5'}）`, img };
}


// 拉取指定级别行业资金流，返回 { inflow:[{name,zljlr亿}...], outflow:[...] }，失败返回 null
// 主力净流入盘中 15 秒内可视为一致 → 内存缓存 15s
async function fetchSwZj(bt) {
  const cached = cacheGet('zj:' + bt);
  if (cached) return cached;
  try {
    const resp = await fetch(ZJ_RANK.replace('%s', bt), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await resp.json();
    const list = j?.data?.rank_list;
    if (!Array.isArray(list) || list.length === 0) return null;
    const rows = list.map(r => ({ name: r.name, yiyi: (Number(r.zljlr) || 0) / 10000 })).filter(r => r.yiyi !== 0);
    rows.sort((a, b) => b.yiyi - a.yiyi);
    const result = { inflow: rows.slice(0, 10), outflow: rows.slice(-10).reverse() };
    cacheSet('zj:' + bt, result, 15000);
    return result;
  } catch (_) { return null; }
}

// 渲染申万行业资金流竖版卡片图（白底，两列 TOP10，手机友好）：canvas 版优先，失败 fallback resvg
function renderZjPng(data, levelLabel) {
  try { return renderZjPngCanvas(data, levelLabel); }
  catch (e) { console.error('[zj] canvas 渲染失败，fallback resvg:', e.message); return renderZjPngSvg(data, levelLabel); }
}
function renderZjPngCanvas(data, levelLabel) {
  const W = 720, PAD = 22;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#e0483e', downC = '#2aa36b'; // 流入红 / 流出绿（A股红涨绿跌）
  const now = new Date();
  const mmdd = `${now.getMonth() + 1}/${now.getDate()}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const H = 430;
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2)); // 1.2x 分辨率，兼顾清晰与生成速度
  const ctx = canvas.getContext('2d');
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  // 标题
  ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 26px cjk';
  ctx.fillText(`${levelLabel}行业资金流`, PAD, 40);
  ctx.fillStyle = sub; ctx.font = '14px cjk';
  ctx.fillText(`主力净流入 · ${mmdd} ${hhmm}`, PAD, 62);
  // 列头
  const yHead = 96;
  const halfW = (W - PAD * 2 - 12) / 2;
  ctx.fillStyle = upC; ctx.fillRect(PAD, yHead - 14, 14, 14);
  ctx.font = 'bold 15px cjk'; ctx.textAlign = 'left';
  ctx.fillText('流入 TOP10', PAD + 20, yHead);
  ctx.fillStyle = downC; ctx.fillRect(PAD + 12 + halfW + 12, yHead - 14, 14, 14);
  ctx.fillText('流出 TOP10', PAD + 12 + halfW + 12 + 20, yHead);
  // 分隔线
  ctx.strokeStyle = lineC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, yHead + 16); ctx.lineTo(W - PAD, yHead + 16); ctx.stroke();
  // 两列各 10 行
  for (let i = 0; i < 10; i++) {
    const ry = yHead + 34 + i * 28;
    const draw = (list, xBase, col, sign) => {
      const r = list[i];
      if (!r) return;
      const name = r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name;
      ctx.fillStyle = sub; ctx.font = '11px cjk'; ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), xBase - 14, ry);
      ctx.fillStyle = ink; ctx.font = '14px cjk';
      ctx.fillText(name, xBase, ry);
      ctx.fillStyle = col; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'right';
      ctx.fillText(`${sign}${r.yiyi.toFixed(1)}亿`, xBase + halfW - 12, ry);
    };
    draw(data.inflow, PAD + 14 + 16, upC, '+');
    draw(data.outflow, PAD + 14 + halfW + 12 + 16, downC, '');
  }
  // 生成时间
  ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '11px cjk';
  ctx.fillText('生成 ' + hhmm, W - PAD, H - 14);
  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}
// 渲染申万行业资金流竖版卡片图（resvg fallback）
function renderZjPngSvg(data, levelLabel) {
  const W = 720, PAD = 22;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#e0483e', downC = '#2aa36b'; // 流入红 / 流出绿（A股红涨绿跌）
  const now = new Date();
  const mmdd = `${now.getMonth() + 1}/${now.getDate()}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const H = 430;
  let s = '';
  // 标题
  s += `<text x="${PAD}" y="40" font-family="PingFang SC,cjk" font-size="26" font-weight="bold" fill="${ink}">${levelLabel}行业资金流</text>`;
  s += `<text x="${PAD}" y="62" font-family="PingFang SC,cjk" font-size="14" fill="${sub}">主力净流入 · ${mmdd} ${hhmm}</text>`;
  // 列头
  const yHead = 96;
  const halfW = (W - PAD * 2 - 12) / 2;
  s += `<rect x="${PAD}" y="${yHead - 14}" width="14" height="14" rx="3" fill="${upC}"/><text x="${PAD + 20}" y="${yHead}" font-family="PingFang SC,cjk" font-size="15" font-weight="bold" fill="${upC}">流入 TOP10</text>`;
  s += `<rect x="${PAD + 12 + halfW + 12}" y="${yHead - 14}" width="14" height="14" rx="3" fill="${downC}"/><text x="${PAD + 12 + halfW + 12 + 20}" y="${yHead}" font-family="PingFang SC,cjk" font-size="15" font-weight="bold" fill="${downC}">流出 TOP10</text>`;
  // 两列各 10 行
  for (let i = 0; i < 10; i++) {
    const ry = yHead + 34 + i * 28;
    const draw = (list, xBase, col, sign) => {
      const r = list[i];
      if (!r) return;
      const name = r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name;
      s += `<text x="${xBase}" y="${ry}" font-family="PingFang SC,cjk" font-size="14" fill="${ink}">${esc(name)}</text>`;
      const amt = `${sign}${r.yiyi.toFixed(1)}亿`;
      s += `<text x="${xBase + halfW - 12}" y="${ry}" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${col}">${amt}</text>`;
      // 序号
      s += `<text x="${xBase - 14}" y="${ry}" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">${i + 1}</text>`;
    };
    draw(data.inflow, PAD + 14 + 16, upC, '+');
    draw(data.outflow, PAD + 14 + halfW + 12 + 16, downC, '');
  }
  // 分隔线
  s += `<line x1="${PAD}" y1="${yHead + 16}" x2="${W - PAD}" y2="${yHead + 16}" stroke="${lineC}" stroke-width="1"/>`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="${bg}"/>${s}<text x="${W - PAD}" y="${H - 14}" text-anchor="end" font-family="PingFang SC,cjk" font-size="11" fill="${sub}">生成 ${hhmm}</text></svg>`;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { fontFiles: ['/app/fonts/cjk_sub.ttf'], loadSystemFonts: false, defaultFontFamily: 'PingFang SC' } });
    const png = r.render().asPng();
    return 'base64://' + png.toString('base64');
  } catch (e) {
    console.error('[zj] 渲染失败:', e.message);
    return '';
  }
}

async function cmdZj(args) {
  const parts = (args || []).map(a => String(a).trim()).filter(Boolean);
  const p = String(parts[0] || '').toLowerCase();
  const bt = ZJ_LEVEL_BT[p];
  if (!bt) return { ok: false, text: '⚠️ 请指定级别：/zj 1（一级） /zj 2（二级）\n第二参数可选：t/分时=分时波动曲线　d/日=日级流入曲线\n例：/zj 2（当前排行）　/zj 1 t（一级分时）　/zj 2 d（二级日线）' };
  const m = String(parts[1] || '').toLowerCase();
  if (m === 't' || m === '分时' || m === 'time') return renderZjCurve(bt, 't');
  if (m === 'd' || m === '日' || m === '日线' || m === 'day') return renderZjCurve(bt, 'd');
  if (m) return { ok: false, text: '⚠️ 第二参数：t/分时=分时曲线　d/日=日线曲线（留空=当前排行）\n例：/zj 2　/zj 1 t　/zj 2 d' };
  if (bt === 'hy3') return { ok: false, text: '⚠️ 申万三级资金流暂无公开免费数据源（腾讯仅提供一级/二级）。\n当前可用：/zj 1 申万一级、/zj 2 申万二级；如需三级可试试问财/付费终端。' };
  const data = await fetchSwZj(bt);
  if (!data) return { ok: false, text: `⚠️ ${ZJ_LEVEL_LABEL[bt]}行业资金流获取失败，请稍后重试` };
  const img = renderZjPng(data, ZJ_LEVEL_LABEL[bt]);
  if (img) return { ok: true, text: `🏦 ${ZJ_LEVEL_LABEL[bt]}行业资金流`, img };
  // 渲染失败 → 文本 fallback
  const fmt = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}亿`;
  return { ok: false, text: `🏦 ${ZJ_LEVEL_LABEL[bt]}行业资金流（主力净流入）\n🔴 流入 TOP10：${data.inflow.map(r => `${r.name} ${fmt(r.yiyi)}`).join('、')}\n🟢 流出 TOP10：${data.outflow.map(r => `${r.name} ${fmt(r.yiyi)}`).join('、')}` };
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
// 每日汇总推送总开关（2026-08-31 用户取消 21:30 汇总推送，默认关闭；
// 需恢复时在 docker-compose 设 DAILY_PUSH_ENABLED=true 即可，无需改代码）
const DAILY_PUSH_ENABLED = (process.env.DAILY_PUSH_ENABLED || 'false') === 'true';
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
    case 'ss': case '指数': return { name: 'ss', type: 'ss' };
    case 'stock': case '股票': case 'K线': return { name: 'stock', type: 'stock', args: parts };
    case 'zj': case '资金': return { name: 'zj', type: 'zj', args: parts };
    case 'info': case '个股': case '资料': return { name: 'info', type: 'info', args: parts };
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
    // 群白名单：非空时仅响应指定群
    const gw = CONFIG.groupWhitelist || [];
    if (gw.length > 0 && !gw.includes(String(ev.group_id))) return;
    // 群聊仅管理员：非管理员一律不响应
    if (CONFIG.groupAdminOnly && !isAdmin) return;
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
      await sendReply(ev, '', [r.img]); // 只发图，信息都在图上
    } else {
      await sendReply(ev, r.text || '⚠️ 图表生成失败');
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
  } else {
    await sendReply(ev, cmd.text);
  }
}

// ---------- WebSocket 事件通道（断线自动重连） ----------
function connect() {
  wsState = 'connecting';
  console.log(`[ws] 连接 ${WS_URL} ...`);
  const w = new WebSocket(WS_URL);
  let connected = false;
  // 统一重连调度：error/close 都可能触发，用定时器防重复；连接失败不依赖 onclose（NapCat 未就绪时常见）
  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    wsState = 'offline';
    console.log(`⚠️ WebSocket ${connected ? '断开' : '连接失败'}，5 秒后重连...`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  };
  w.onopen = () => {
    connected = true;
    wsState = 'online';
    console.log('✅ WebSocket 已连接', WS_URL);
  };
  w.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(String(e.data)); } catch (_) { return; }
    handleEvent(ev).catch(err => console.error('[event] 处理异常:', err.message));
  };
  w.onclose = () => scheduleReconnect();
  w.onerror = (err) => {
    console.error('[ws] 错误:', (err && err.message) || '未知');
    scheduleReconnect();
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

module.exports = { handleEvent, routeCommand, parseMessage, loadConfig, sendReply, cmdStatus, cmdPreview, cmdStock, cmdSS, cmdZj, cmdInfo, cmdHelp, extractMagnet, genHardwareStats, CONFIG, BOT_UIN };
