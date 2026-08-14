// 把 A股 复盘 HTML 渲染成 PNG（仅渲染，不推送；供手动检查或自动化前预览用）
//
// 用法: NODE_PATH=<ws>/node_modules node render_report.js <报告html路径> [输出png路径]
//   CHROME_PATH  可选，Chrome 可执行文件路径（默认 macOS 路径，换平台/电脑时覆盖）
//
// 依赖：宿主需安装 puppeteer-core 与一款 Chrome（本脚本不进容器，跑在宿主机）。
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

const htmlPath = path.resolve(process.argv[2]);
const outPath = process.argv[3] || '/tmp/report.png';
const fileUrl = url.pathToFileURL(htmlPath).href;
// Chrome 路径：默认 macOS 安装位置，换平台/换电脑时用 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 2 });
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000)); // 等 ECharts 渲染完成
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();
  console.log('SAVED', outPath);
})().catch(e => { console.error(e); process.exit(1); });
