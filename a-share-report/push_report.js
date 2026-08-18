// 把 A股 复盘 HTML 渲染成图片，并通过 NapCat OneBot HTTP 推送到 QQ（私聊和/或群聊，支持多目标）
//
// 目标配置（环境变量，多个用逗号分隔；也兼容单个旧变量）：
//   QQ_PRIVATE_IDS=1547450303,123456789   要私聊发送的 QQ 号列表
//   QQ_GROUP_IDS=389613106,836244807      要群发的群号列表
//   （兼容旧变量：QQ_PRIVATE_ID / QQ_GROUP_ID）
//   REPORT_CAPTION=今日复盘 👇             可选，图片前的文字说明
//   MESSAGE_FORMAT=array|string            可选，默认 array（见说明）
//   NAPCAT_URL / NAPCAT_TOKEN             可选
//   PUSH_TARGETS                          可选，推送目标配置文件路径（默认脚本同目录 push_targets.json）
//   CHROME_PATH                           可选，Chrome 可执行文件路径（默认 macOS 路径，换平台/电脑时覆盖）
//   REPORT_DIR                            可选，未传报告路径时按日期自动查找的目录（默认本机复盘目录）
//
// 用法: NODE_PATH=<ws>/node_modules node push_report.js [报告html路径]
//
// 重试配置（应对 NapCat 重启后图片通道热身延迟 / 瞬时网络抖动）：
//   SEND_RETRIES=2      单次发送失败后最多重试次数（默认 2）
//   SEND_RETRY_DELAY=3000  每次重试间隔(ms，默认 3000)
//
// array vs string 说明：
//   array  -> [{type:'image',data:{file:'base64://...'}}]  结构化，官方推荐，免转义，易组合多段
//   string -> "[CQ:image,file=base64://...]"               旧式 CQ 码，直观但长串需转义
const path = require('path');
const fs = require('fs');
const url = require('url');
const puppeteer = require('puppeteer-core');

// 清除代理环境变量，确保直连本机 NapCat (127.0.0.1:3000)
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

// Chrome 路径：默认 macOS 安装位置，换平台/换电脑时用 CHROME_PATH 覆盖（如 Linux 的 /usr/bin/google-chrome）
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// 未传报告路径时，按当天日期自动查找的目录；可经 REPORT_DIR 覆盖（换电脑时指向你的复盘目录）
const REPORT_DIR = process.env.REPORT_DIR || '/Users/zhangxu/WorkBuddy/个人demo/daily-review';
const NAPCAT_URL = process.env.NAPCAT_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.NAPCAT_TOKEN || '';
const MSG_FORMAT = (process.env.MESSAGE_FORMAT || 'array').toLowerCase();

function parseList(...vals) {
  const out = [];
  for (const v of vals) {
    if (!v) continue;
    // 支持逗号分隔字符串 或 已经是数组
    const arr = Array.isArray(v) ? v : String(v).split(',');
    for (const x of arr) { const t = String(x).trim(); if (t) out.push(t); }
  }
  return out;
}

// 目标配置：优先用环境变量，否则读取 push_targets.json（与脚本同目录）
//   QQ_PRIVATE_IDS / QQ_GROUP_IDS 可临时覆盖配置文件
// 抽成 loadTargets() 每次运行重新读盘，改 push_targets.json 无需重启/重跑即生效（与 ths-news 一致的热加载方式）。
const CONFIG_PATH = process.env.PUSH_TARGETS || path.join(__dirname, 'push_targets.json');
let PRIVATE_IDS = [], GROUP_IDS = [], CAPTION = '', IMAGE_WIDTH = 600, IMAGE_SCALE = 2;
function loadTargets() {
  let c = { private: [], groups: [], caption: '', imageWidth: 600, imageScale: 2 };
  try {
    if (fs.existsSync(CONFIG_PATH)) c = Object.assign(c, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) { console.error('读取配置文件失败（沿用上轮配置）:', CONFIG_PATH, e.message); }
  PRIVATE_IDS = parseList(process.env.QQ_PRIVATE_IDS, process.env.QQ_PRIVATE_ID, c.private);
  GROUP_IDS  = parseList(process.env.QQ_GROUP_IDS,  process.env.QQ_GROUP_ID,  c.groups);
  CAPTION     = process.env.REPORT_CAPTION || c.caption || '';
  // 图片尺寸：按手机端阅读优化。viewport 宽度越接近手机 CSS 宽度，发出去越不用放大看。
  //   imageWidth 默认 600（CSS px），imageScale 默认 2（输出像素 = width*scale）
  IMAGE_WIDTH = parseInt(process.env.IMAGE_WIDTH || c.imageWidth || '600', 10) || 600;
  IMAGE_SCALE = parseInt(process.env.IMAGE_SCALE || c.imageScale || '2', 10) || 2;
}
loadTargets(); // 进程启动先加载一次（本脚本为一次性运行，每次执行都会重新读盘）

function todayFile() {
  const d = new Date();
  const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(REPORT_DIR, `A股-${s}-复盘.html`);
}

// 登录健康检查：NapCat 掉线/票据失效时提前告警，避免静默失败 + 浪费一次渲染
async function checkLogin() {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  try {
    const r = await fetch(NAPCAT_URL + '/get_login_info', { method: 'POST', headers });
    const j = await r.json().catch(() => ({}));
    if (j.status !== 'ok' || !j.data || !j.data.user_id) {
      console.error('❌ NapCat 登录态异常 (get_login_info 返回非 ok)：', JSON.stringify(j).slice(0, 200));
      return false;
    }
    console.log('✅ 机器人在线：', j.data.nickname, '(', j.data.user_id, ')');
    return true;
  } catch (e) {
    console.error('❌ 无法连接 NapCat (', NAPCAT_URL, ')：', e.message);
    return false;
  }
}

function buildMessage(b64) {
  const file = 'base64://' + b64;
  if (MSG_FORMAT === 'string') {
    // CQ 码格式：文字(可选) + 图片
    const img = `[CQ:image,file=${file}]`;
    return CAPTION ? CAPTION + '\n' + img : img;
  }
  // array 段格式
  const segs = [];
  if (CAPTION) segs.push({ type: 'text', data: { text: CAPTION } });
  segs.push({ type: 'image', data: { file } });
  return segs;
}

// ---------- 发送（带重试，应对 NapCat 重启后图片通道热身延迟 / 瞬时网络抖动） ----------
const SEND_RETRIES = (() => { const n = Number(process.env.SEND_RETRIES); return Number.isFinite(n) && n >= 0 ? n : 2; })();
const SEND_RETRY_DELAY = (() => { const n = Number(process.env.SEND_RETRY_DELAY); return Number.isFinite(n) && n >= 0 ? n : 3000; })();
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

(async () => {
  // 1) 登录健康检查（掉线就先告警退出，不浪费后续渲染）
  if (!(await checkLogin())) process.exit(4);

  console.log('[targets] 推送目标 private=', JSON.stringify(PRIVATE_IDS), 'groups=', JSON.stringify(GROUP_IDS));

  if (PRIVATE_IDS.length === 0 && GROUP_IDS.length === 0) {
    console.error('缺少目标：请设置 QQ_PRIVATE_IDS 或 QQ_GROUP_IDS（逗号分隔多个）');
    process.exit(3);
  }
  const htmlArg = process.argv[2];
  const htmlPath = htmlArg ? path.resolve(htmlArg) : todayFile();
  if (!fs.existsSync(htmlPath)) { console.error('报告不存在:', htmlPath); process.exit(2); }

  const pngPath = process.env.REPORT_PNG || '/tmp/a_share_report.png';
  const fileUrl = url.pathToFileURL(htmlPath).href;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: IMAGE_WIDTH, height: 1000, deviceScaleFactor: IMAGE_SCALE });
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000)); // 等 ECharts 渲染
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  const size = fs.statSync(pngPath).size;
  console.log('渲染完成:', pngPath, (size / 1024 / 1024).toFixed(2) + 'MB');

  const b64 = fs.readFileSync(pngPath).toString('base64');
  const message = buildMessage(b64);

  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;

  let ok = 0, fail = 0;
  const targets = [
    ...PRIVATE_IDS.map(u => ({ kind: '私聊', id: u, ep: '/send_private_msg', body: { user_id: Number(u) } })),
    ...GROUP_IDS.map(g => ({ kind: '群', id: g, ep: '/send_group_msg', body: { group_id: Number(g) } })),
  ];
  for (const tg of targets) {
    const res = await sendWithRetry(tg.ep, { ...tg.body, message }, headers, `${tg.kind} ${tg.id}`);
    console.log(`${tg.kind} ${tg.id} -> ${res.ok ? '✅成功' : '❌失败(已重试' + SEND_RETRIES + '次)'}`, res.text.slice(0, 140));
    res.ok ? ok++ : fail++;
  }
  console.log(`完成：成功 ${ok} 个，失败 ${fail} 个`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
