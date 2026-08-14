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
const CONFIG_PATH = process.env.PUSH_TARGETS || path.join(__dirname, 'push_targets.json');
let cfg = { private: [], groups: [], caption: '' };
try {
  if (fs.existsSync(CONFIG_PATH)) cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (e) { console.error('读取配置文件失败:', CONFIG_PATH, e.message); }

const PRIVATE_IDS = parseList(process.env.QQ_PRIVATE_IDS, process.env.QQ_PRIVATE_ID, cfg.private);
const GROUP_IDS = parseList(process.env.QQ_GROUP_IDS, process.env.QQ_GROUP_ID, cfg.groups);
const CAPTION = process.env.REPORT_CAPTION || cfg.caption || '';
// 图片尺寸：按手机端阅读优化。viewport 宽度越接近手机 CSS 宽度，发出去越不用放大看。
//   imageWidth 默认 600（CSS px），imageScale 默认 2（输出像素 = width*scale）
const IMAGE_WIDTH = parseInt(process.env.IMAGE_WIDTH || cfg.imageWidth || '600', 10) || 600;
const IMAGE_SCALE = parseInt(process.env.IMAGE_SCALE || cfg.imageScale || '2', 10) || 2;

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

(async () => {
  // 1) 登录健康检查（掉线就先告警退出，不浪费后续渲染）
  if (!(await checkLogin())) process.exit(4);

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
  for (const uid of PRIVATE_IDS) {
    const body = { user_id: Number(uid), message };
    const r = await fetch(NAPCAT_URL + '/send_private_msg', { method: 'POST', headers, body: JSON.stringify(body) });
    const t = await r.text();
    console.log(`私聊 ${uid} -> HTTP ${r.status}`, t.slice(0, 120));
    r.ok ? ok++ : fail++;
  }
  for (const gid of GROUP_IDS) {
    const body = { group_id: Number(gid), message };
    const r = await fetch(NAPCAT_URL + '/send_group_msg', { method: 'POST', headers, body: JSON.stringify(body) });
    const t = await r.text();
    console.log(`群 ${gid} -> HTTP ${r.status}`, t.slice(0, 120));
    r.ok ? ok++ : fail++;
  }
  console.log(`完成：成功 ${ok} 个，失败 ${fail} 个`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
