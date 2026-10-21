// ============================================================
// /stocks 组合拼图：组合 CRUD + 多股票一图拼图
// ============================================================
const path = require('path');
const fs = require('fs');
const { NAPCAT_URL, TOKEN, CONFIG } = require('../config');
const { cacheGet, cacheSet, mapLimit, normStockName, nowText, isFundCode } = require('../utils');
const { isOwnerCtx, ownerDeniedMsg } = require('../gateway'); // 组合编辑闸门（拆分后漏引入 → -add/-update/-del 曾 ReferenceError）
const {
  STOCK_QUOTE, STOCK_PERIOD_LABEL, normalizeCode, GLOBAL_ALIAS, GLOBAL_TEXT, EM_IDX_SECID,
  resolveStockCode, calcSMA, calcBOLL, buildAvgLine, BARE_PERIOD,
  fetchStockKline, aggHfKline, fetchEmTrends, fetchStockQuote, getYahooPremarketStatus,
} = require('../market');

//       每格为精简走势（无成交量/均线/BOLL），各自价格轴 + 区间起点虚线基准；
//       涨红跌绿，字号按列数收缩以保证手机端可读。
const PORTFOLIO_DIR = process.env.PORTFOLIO_DIR || path.join(__dirname, '..', 'data');
const PORTFOLIO_PATH = path.join(PORTFOLIO_DIR, 'portfolios.json');
const PORTFOLIO_MAX = 20;      // 单个组合最多保存的股票数
const STOCKS_RENDER_MAX = 16;  // 单张拼图最多渲染的股票数
// 组合名：中英文/数字/下划线打头，后接中英文/数字/下划线/点/短横线，总长 1-12；首字符不得是 -（避免与参数混淆）
const PORTFOLIO_NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_][\u4e00-\u9fa5A-Za-z0-9_.\-]{0,11}$/;
// 只保留 分时/日/周/月 四个周期（用户要求：不需要分钟/小时图）
const STOCKS_PERIODS = { '-t': 'time', '-time': 'time', '分时': 'time', '-pre': 'premarket', 'pre': 'premarket', '盘前': 'premarket', '-d': 'day', '-day': 'day', '日线': 'day', '-w': 'week', '-week': 'week', '周线': 'week', '-m': 'month', '-month': 'month', '月线': 'month' };
const STOCKS_PERIOD_LABEL = { day: '日线', week: '周线', month: '月线', time: '分时', premarket: '盘前' };
const STOCKS_USAGE = [
  '📋 /stocks 股票组合',
  '出图：/stocks <周期> <组合名 或 股票...>',
  '　　周期（单选）：-t 分时 | -pre 美股盘前 | -d 日线 | -w 周线 | -m 月线（不写默认日线）',
  '　　　　（t/d/w/m 也可省略减号，如 /stocks t 美股存储）',
  '　　例：/stocks -d 我的持仓　/stocks -t 600519 000858　/stocks -w 贵州茅台 宁德时代',
  '组合：/stocks -list　组合清单（只列名称+只数）',
  '　　　/stocks -list <组合名>　查看某个组合的成分',
  '编辑（仅机器人主人）：',
  '　/stocks -add <股票...> -name <组合名>　新建 / 整组覆盖',
  '　/stocks -update <组合名> <股票...>　　 用新名单整组替换（组合须已存在）',
  '　/stocks -del <组合名>　　　　　　　　　删除组合',
  '　　例：/stocks -add 600519 300750 -name 我的持仓',
  '　　　　/stocks -update 我的持仓 600519 300750 002594',
  `单张图最多 ${STOCKS_RENDER_MAX} 只，单个组合最多保存 ${PORTFOLIO_MAX} 只`,
].join('\n');
const STOCKS_EDIT_MODES = ['add', 'update', 'del'];

// 组合存储：data/portfolios.json（容器挂载 ./reply/data，可写；tmp+rename 原子替换）
function loadPortfolios() {
  try {
    if (!fs.existsSync(PORTFOLIO_PATH)) return {};
    const j = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (e) { console.error('[stocks] portfolios 读取失败:', e.message); return {}; }
}
function savePortfolios(obj) {
  try {
    if (!fs.existsSync(PORTFOLIO_DIR)) fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });
    const tmp = PORTFOLIO_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, PORTFOLIO_PATH);
    return true;
  } catch (e) { console.error('[stocks] portfolios 写入失败:', e.message); return false; }
}
// 组合名查找：忽略大小写（用户不愿每次区分 a/A）→ 返回实际存在的键，找不到返回 ''
function findPortfolioKey(pf, target) {
  const t = String(target || '').trim();
  if (!t || !pf) return '';
  if (pf[t]) return t;
  const tl = t.toLowerCase();
  return Object.keys(pf).find(k => k.toLowerCase() === tl) || '';
}

// 列数自适应（2026-09-11 用户调整阈值）：1 只→1 列；≤4 只→2 列；5-9 只→3 列；≥10 只→4 列
function stocksGridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

// 子图显示窗口：分时=当日交易时段（商品全量），其余=最近 60 根
function stocksWindow(it, period) {
  const kl = it.klines || [];
  if (period !== 'time' && period !== 'premarket') return kl.slice(-60);
  if (period === 'premarket') return kl;
  if (it.mkt === 'hf') return kl;
  const cap = it.mkt === 'cn' ? '1500' : '1600';
  const f = kl.filter(k => { const t = String(k.t); return t >= '0930' && t <= cap; });
  return f.length >= 2 ? f : kl;
}

// 渲染组合拼图 → 'base64://...'
function buildStocksPng(items, meta) {
  const { createCanvas } = require('@napi-rs/canvas');
  const UP = '#f5222d', DOWN = '#0aa869';
  const BG = '#ffffff', PANEL = '#f7f8fa', LINE = '#e8eaed', GRIDL = '#f1f3f6';
  const INK = '#2b2f36', SUB = '#8a919c', FAINT = '#a9aeb8', BASE = '#c9ced6';
  const AVG = '#f0b90b';

  const W = 1080;
  const n = items.length;
  const cols = stocksGridCols(n);
  const rows = Math.ceil(n / cols);
  // codeflicker-fix: UX-Issue-002/9w1uayqs7526yog8f3nw
  // 组合图不再像紧贴的表格：留出画布边缘和卡间距，手机缩放时更容易逐只扫读。
  const OUTER = 18, GAP = 14;
  const base = Math.floor((W - OUTER * 2 - (cols - 1) * GAP) / cols);
  const rem = (W - OUTER * 2 - (cols - 1) * GAP) - base * cols;
  const colW = [], colX = [];
  let acc = OUTER;
  for (let i = 0; i < cols; i++) { const w = base + (i < rem ? 1 : 0); colW.push(w); colX.push(acc); acc += w + GAP; }

  const HEADER_H = 144, FOOTER_H = 54;
  const F = cols <= 1 ? { name: 36, chg: 36, meta: 23 }
    : cols === 2 ? { name: 31, chg: 30, meta: 22 }
      : cols === 3 ? { name: 27, chg: 26, meta: 21 }
        : { name: 25, chg: 24, meta: 20 };
  const PADX = cols <= 2 ? 22 : (cols === 3 ? 16 : 14);
  const PADY = 18;
  const TITLE_ROW = Math.round(F.name * 1.55);
  const META_ROW = Math.round(F.meta * 1.8);
  const chartW = base - PADX * 2;
  const chartH = Math.round(chartW * 0.58);
  const cellH = PADY + TITLE_ROW + chartH + META_ROW + PADY;
  const gridH = rows * cellH + (rows - 1) * GAP;
  const GY = HEADER_H + OUTER;
  const FOY = GY + gridH + OUTER;
  const H = FOY + FOOTER_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  // —— 顶部汇总栏 ——
  ctx.fillStyle = PANEL; ctx.fillRect(0, 0, W, HEADER_H);
  const MX = 30;
  // 左侧渐变 accent 竖条（与 THS 卡风格统一）
  const hGrad = ctx.createLinearGradient(MX, 28, MX, 72);
  hGrad.addColorStop(0, '#f5222d'); hGrad.addColorStop(1, '#ff7875');
  ctx.fillStyle = hGrad; ctx.fillRect(MX, 28, 5, 44);
  ctx.textAlign = 'left';
  ctx.fillStyle = INK; ctx.font = 'bold 36px cjk';
  ctx.fillText(meta.title, MX + 16, 50);
  ctx.fillStyle = SUB; ctx.font = '23px cjk';
  ctx.fillText(meta.sub, MX + 16, 92);
  ctx.textAlign = 'right';
  ctx.fillStyle = meta.avgCol; ctx.font = 'bold 40px cjk';
  ctx.fillText(meta.avgTxt, W - MX, 50);
  ctx.fillStyle = SUB; ctx.font = '23px cjk';
  ctx.fillText(meta.statsTxt, W - MX, 92);

  // —— 卡片画布：浅灰背景上的独立白卡，避免多标的图像表格一样粘连 ——
  ctx.fillStyle = '#f5f6f8'; ctx.fillRect(0, HEADER_H, W, FOY - HEADER_H);

  for (let i = 0; i < n; i++) {
    const it = items[i];
    const r = Math.floor(i / cols), c0 = i % cols;
    const cx = colX[c0], cy = GY + r * (cellH + GAP), cwid = colW[c0];
    ctx.fillStyle = it.error ? '#f4f5f7' : '#ffffff';
    ctx.beginPath(); ctx.roundRect(cx, cy, cwid, cellH, 14); ctx.fill();
    ctx.strokeStyle = '#e7eaf0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(cx + 0.5, cy + 0.5, cwid - 1, cellH - 1, 14); ctx.stroke();

    if (it.error) {
      ctx.textAlign = 'center';
      ctx.fillStyle = FAINT; ctx.font = `${F.name}px cjk`;
      ctx.fillText(it.name || it.code, cx + cwid / 2, cy + cellH / 2 - F.meta);
      ctx.fillStyle = '#c2c6cd'; ctx.font = `${F.meta}px cjk`;
      ctx.fillText(it.msg || '取数失败', cx + cwid / 2, cy + cellH / 2 + F.meta);
      continue;
    }

    // 标题行：名称（左） + 涨跌幅（右，涨红跌绿）
    const titleY = cy + PADY + TITLE_ROW / 2;
    ctx.textAlign = 'left';
    ctx.font = `bold ${F.name}px cjk`;
    const chgTxt = `${it.chgPct >= 0 ? '+' : ''}${it.chgPct.toFixed(2)}%`;
    const reserve = ctx.measureText(chgTxt).width + 14;
    let nm = String(it.name || it.code);
    while (nm.length > 1 && ctx.measureText(nm).width > cwid - PADX * 2 - reserve) nm = nm.slice(0, -1);
    ctx.fillStyle = INK;
    ctx.fillText(nm, cx + PADX, titleY);
    ctx.textAlign = 'right';
    ctx.fillStyle = it.chgPct >= 0 ? UP : DOWN;
    ctx.font = `bold ${F.chg}px cjk`;
    ctx.fillText(chgTxt, cx + cwid - PADX, titleY);

    // —— 迷你走势 ——
    const chX = cx + PADX, chY = cy + PADY + TITLE_ROW, dn = it.disp.length;
    const cellChartW = cwid - PADX * 2;
    const closes = it.disp.map(k => k.close);
    let lo = Math.min(...it.disp.map(k => k.low)), hi = Math.max(...it.disp.map(k => k.high));
    if (!isFinite(lo) || !isFinite(hi)) { lo = Math.min(...closes); hi = Math.max(...closes); }
    if (it.avgLine) { lo = Math.min(lo, ...it.avgLine); hi = Math.max(hi, ...it.avgLine); }
    if (it.baseline > 0) { lo = Math.min(lo, it.baseline); hi = Math.max(hi, it.baseline); }
    const rng = (hi - lo) || 1;
    const yMin = lo - rng * 0.05, yMax = hi + rng * 0.05;
    const Y = p => chY + chartH - ((p - yMin) / (yMax - yMin)) * chartH;

    // 浅网格 2 条
    ctx.strokeStyle = GRIDL; ctx.lineWidth = 1;
    [1 / 3, 2 / 3].forEach(f => {
      const yy = Math.round(chY + f * chartH) + 0.5;
      ctx.beginPath(); ctx.moveTo(chX, yy); ctx.lineTo(chX + cellChartW, yy); ctx.stroke();
    });
    // 区间起点基准虚线（分时为昨收）。标签不在这里画——曲线后画会盖住标签，
    // 挪到下方 time 分支末尾（价格线画完后）做冲突避让。
    if (it.baseline > 0) {
      const yb = Y(it.baseline);
      if (yb > chY - 1 && yb < chY + chartH + 1) {
        ctx.strokeStyle = BASE; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(chX, yb); ctx.lineTo(chX + cellChartW, yb); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (meta.period === 'time' || meta.period === 'premarket') {
      // 分时：价格线（红/绿按昨收）+ 均价线 + 末端圆点
      // 横轴：A股/港股/美股按「交易分钟」映射（午休压缩，与单只 /stock 的 tmin 一致），
      //   让「盘中进行到一半」正确停在对应位置，而不是被索引等距铺满到末尾（=误显示成已收盘）。
      //   商品(hf)近 24h 连续、无固定交易时段，保持索引等距。2026-09-11 修复。
      const isPreItem = it.itemPeriod === 'premarket';
      const TOT = isPreItem ? 330 : (it.mkt === 'us' ? 390 : (it.mkt === 'hk' ? 330 : 240));
      const tmin = t => {
        const s = String(t).replace(':', '');
        const m = Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
        if (isPreItem) return Math.min(TOT - 1, Math.max(0, m - 240));
        if (it.mkt === 'us') return Math.min(TOT - 1, Math.max(0, m - 570));
        if (it.mkt === 'hk') return Math.min(TOT - 1, Math.max(0, m <= 720 ? m - 570 : 150 + (m - 780)));
        return Math.min(TOT - 1, Math.max(0, m <= 690 ? m - 571 : m - 660));
      };
      const px = i2 => it.mkt === 'hf'
        ? chX + (dn <= 1 ? 0 : (i2 / (dn - 1)) * cellChartW)
        : chX + (tmin(it.disp[i2].t) / TOT) * cellChartW;
      // 渐变填充（价格线下方半透明区域）
      const fillRgb = it.chgPct >= 0 ? '245,34,45' : '10,168,105';
      const fillGrad = ctx.createLinearGradient(0, chY, 0, chY + chartH);
      fillGrad.addColorStop(0, `rgba(${fillRgb},0.15)`);
      fillGrad.addColorStop(1, `rgba(${fillRgb},0)`);
      ctx.fillStyle = fillGrad;
      ctx.beginPath();
      ctx.moveTo(px(0), chY + chartH);
      for (let k = 0; k < dn; k++) ctx.lineTo(px(k), Y(it.disp[k].close));
      ctx.lineTo(px(dn - 1), chY + chartH);
      ctx.closePath();
      ctx.fill();
      // 价格线
      ctx.beginPath();
      for (let k = 0; k < dn; k++) { const x = px(k), y = Y(it.disp[k].close); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = it.lineCol; ctx.lineWidth = 2.2; ctx.stroke();
      if (it.avgLine) {
        ctx.beginPath();
        for (let k = 0; k < dn; k++) { const x = px(k), y = Y(it.avgLine[k]); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.strokeStyle = AVG; ctx.lineWidth = 1.6; ctx.stroke();
      }
      ctx.fillStyle = it.lineCol;
      ctx.beginPath(); ctx.arc(px(dn - 1), Y(it.disp[dn - 1].close), 4, 0, Math.PI * 2); ctx.fill();

      // 昨收标签：与现价标签对角错开——现价涨(右上)则昨收贴右下，现价跌(右下)则昨收贴右上
      // 灰色底，不抢现价（红绿）的视觉焦点
      if (it.prevText && it.baseline > 0) {
        const lb = '昨收 ' + it.prevText;
        ctx.font = `${Math.max(15, F.meta - 3)}px cjk`;
        const lw = ctx.measureText(lb).width + 10;
        const lh = 18;
        const ly = it.chgPct >= 0 ? (chY + chartH - lh - 2) : (chY + 2);
        ctx.fillStyle = 'rgba(201,206,214,0.88)';
        ctx.beginPath(); ctx.roundRect(chX + cellChartW - lw, ly, lw, lh, 4); ctx.fill();
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText(lb, chX + cellChartW - lw / 2, ly + lh / 2);
        ctx.textAlign = 'left';
      }
    } else {
      // K线：蜡烛（涨红跌绿）
      const step = cellChartW / dn;
      const bw = Math.max(1.2, Math.min(9, step * 0.62));
      for (let k = 0; k < dn; k++) {
        const d = it.disp[k];
        const xx = chX + (k + 0.5) * step;
        const up = d.close >= d.open;
        const col = up ? UP : DOWN;
        ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, Y(d.high)); ctx.lineTo(xx, Y(d.low)); ctx.stroke();
        const yT = Y(Math.max(d.open, d.close));
        const bh = Math.max(1, Y(Math.min(d.open, d.close)) - yT);
        if (up) {
          ctx.fillStyle = '#ffffff'; ctx.fillRect(xx - bw / 2, yT, bw, bh);
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(xx - bw / 2, yT, bw, bh);
        } else {
          ctx.fillStyle = col; ctx.fillRect(xx - bw / 2, yT, bw, bh);
        }
      }
    }

    // 现价标签：直接画进走势图（涨红跌绿），不占底部信息行
    // 分时：涨(红)→右上角、跌(绿)→右下角，与「昨收」标签对角错开；日线固定右上角
    if (it.livePxTxt && it.livePxTxt !== '-') {
      const liveTxt = it.livePxTxt;
      ctx.font = `bold ${Math.max(16, F.meta - 1)}px cjk`;
      const lw = ctx.measureText(liveTxt).width + 12;
      const lx = chX + cellChartW - lw;
      const ly = (meta.period === 'time' || meta.period === 'premarket')
        ? (it.chgPct >= 0 ? (chY + 2) : (chY + chartH - 22))
        : (chY + 2);
      ctx.fillStyle = it.chgPct >= 0 ? UP : DOWN;
      ctx.fillRect(lx, ly, lw, 20);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(liveTxt, lx + lw / 2, ly + 11);
      ctx.textAlign = 'left';
    }

    // 底部信息行：代码（左） + 区间涨跌幅/振幅（右）；宽度不足时收缩左侧，避免重叠
    const metaY = cy + PADY + TITLE_ROW + chartH + META_ROW / 2;
    ctx.font = `${F.meta}px cjk`;
    const availM = cwid - PADX * 2;
    const rW = ctx.measureText(it.metaRight).width;
    let mL = it.metaLeft;
    while (mL.length > 2 && ctx.measureText(mL).width + rW + 12 > availM) mL = mL.slice(0, -1);
    ctx.textAlign = 'left'; ctx.fillStyle = SUB;
    ctx.fillText(mL, cx + PADX, metaY);
    ctx.textAlign = 'right'; ctx.fillStyle = it.metaCol;
    ctx.fillText(it.metaRight, cx + cwid - PADX, metaY);
  }

  // —— 底部 ——
  ctx.fillStyle = PANEL; ctx.fillRect(0, FOY, W, 1 + FOOTER_H);
  ctx.strokeStyle = LINE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, FOY + 0.5); ctx.lineTo(W, FOY + 0.5); ctx.stroke();
  ctx.textAlign = 'center'; ctx.fillStyle = FAINT;
  // 页脚自适应：失败/截断提示并入后可能变长 → 先缩字号（21→13），仍超宽再截断
  let ffs = 21;
  const fitFooter = () => { ctx.font = `${ffs}px cjk`; return ctx.measureText(meta.footer).width <= W - 24; };
  while (ffs > 13 && !fitFooter()) ffs -= 1;
  let ftxt = meta.footer;
  while (ftxt.length > 4 && ctx.measureText(ftxt).width > W - 12) ftxt = ftxt.slice(0, -1);
  ctx.fillText(ftxt, W / 2, FOY + 1 + FOOTER_H / 2);

  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

// 解析股票参数 → { okList, bad }：保序、去重、逐个验证「能解析出代码且有行情」
async function resolveStockArgs(list) {
  const resolved = await mapLimit(list, 4, async q => {
    let code = normalizeCode(q);
    if (!code) code = await resolveStockCode(q);
    if (!code) return { q, err: '未找到' };
    const qt = await fetchStockQuote(code);
    if (!qt || !(Number(qt.price) > 0)) return { q, err: '无行情' };
    return { code, name: qt.name || q };
  });
  const okList = [], bad = [], seen = new Set();
  for (const r of resolved) {
    if (r.err) { bad.push(`${r.q}（${r.err}）`); continue; }
    if (seen.has(r.code)) continue;
    seen.add(r.code); okList.push({ code: r.code, name: r.name });
  }
  return { okList, bad };
}

// 命令入口：/stocks（返回 { ok, text? } 或 { ok, img, note? }）
// 权限：list / 出图 → 所有人可用；add / update / del → 仅 owners（writeOwnerGate）
async function cmdStocks(args, ctx = {}) {
  const raw = (args || []).map(a => String(a).trim()).filter(Boolean);
  if (!raw.length) return { ok: false, text: STOCKS_USAGE };

  let mode = 'query', nameFromFlag = false, name = '';
  const periods = [], operands = [], modes = new Set();
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i], pl = p.toLowerCase();
    if (pl === '-add' || pl === 'add' || pl === '新增') { mode = 'add'; modes.add('add'); continue; }
    if (pl === '-update' || pl === 'update' || pl === '-set' || pl === '修改' || pl === '更新') { mode = 'update'; modes.add('update'); continue; }
    if (pl === '-del' || pl === '-rm' || pl === '-delete' || pl === 'del' || pl === '删除') { mode = 'del'; modes.add('del'); continue; }
    if (pl === '-list' || pl === 'list' || pl === '列表') { mode = 'list'; modes.add('list'); continue; }
    if (pl === '-name' || pl === 'name' || pl === '名称') {
      // 只吃紧跟的一个 token：组合名本身不允许空格，贪婪消费会把后面的股票一起吞掉
      // （曾导致 `/stocks -update -name 我的持仓 300750` 被误判为「没给股票」）
      name = (i + 1 < raw.length ? raw[++i] : '').trim(); nameFromFlag = true; continue;
    }
    if (STOCKS_PERIODS[pl]) { periods.push(STOCKS_PERIODS[pl]); continue; }
    // 手机端敲 - 不方便：首/尾 token 允许省略减号（t/d/w/m）。组合名与股票名不会是单字母，风险可控
    if ((i === 0 || i === raw.length - 1) && !pl.startsWith('-') && raw.length > 1 && BARE_PERIOD[pl]) {
      periods.push(BARE_PERIOD[pl]); continue;
    }
    // 以 - 开头的 token 一律当未知参数（组合名不允许以 - 打头）；
    // 编辑指令下额外提示「它可能是你想写的组合名」，避免用户以为命令坏了
    if (p.startsWith('-') && p.length > 1) {
      const bare = p.replace(/^-+/, '');
      const hint = (STOCKS_EDIT_MODES.includes(mode) && bare) ? `\n💡 组合名不能以 - 开头；如果「${p}」是组合名，请写成「${bare}」` : '';
      return { ok: false, text: `⚠️ 未知参数「${p}」${hint}\n\n${STOCKS_USAGE}` };
    }
    operands.push(p);
  }
  // 操作符互斥：-add / -update / -del / -list 一次只能用一种（避免「后写的静默覆盖前写的」）
  if (modes.size > 1) {
    return { ok: false, text: `⚠️ 一次只能用一种操作，检测到：${[...modes].map(m => '-' + m).join('、')}\n\n${STOCKS_USAGE}` };
  }
  const isEdit = STOCKS_EDIT_MODES.includes(mode);
  // -name 写了但后面没跟值 → 明确报错（否则会被当成「组合名为空」，提示方向不对）
  if (nameFromFlag && !name && isEdit) {
    return { ok: false, text: `⚠️ -name 后面缺少组合名（组合名不能含空格）\n\n${STOCKS_USAGE}` };
  }
  // —— 写操作闸门：仅主人 ——（与 groupRestrictedCmds 无关，群内普通成员即使能调 /stocks 也会被这里拦下）
  if (isEdit && !(await isOwnerCtx(ctx))) return { ok: false, text: ownerDeniedMsg() };
  // 编辑指令不接受周期参数（否则用户会以为顺带出了图）
  if (isEdit && periods.length) {
    return { ok: false, text: `⚠️ -${mode} 是编辑指令，不接受周期参数\n想看行情请单独发：/stocks <周期> <组合名>` };
  }

  // —— 列出组合（所有人）——
  // 默认一次性列出全部组合及其成分（组合名匹配不分大小写）；只看某一个：/stocks -list <组合名>
  if (mode === 'list') {
    const pf = loadPortfolios(), keys = Object.keys(pf);
    if (!keys.length) return { ok: false, text: `📋 还没有保存任何组合\n\n${STOCKS_USAGE}` };

    // 详情模式：/stocks -list <组合名> → 只列该组合的成分
    if (operands.length) {
      const target = operands[0];
      const hit = findPortfolioKey(pf, target);
      if (!hit) return { ok: false, text: `⚠️ 没有找到组合【${target}】\n现有组合：${keys.sort().join('、')}` };
      const st = (pf[hit] && Array.isArray(pf[hit].stocks)) ? pf[hit].stocks : [];
      const names = st.map(s => s.name || s.code).join('、') || '（空）';
      return { ok: true, text: [
        `📋 【${hit}】${st.length} 只　更新 ${pf[hit].updated || pf[hit].created || '-'}`,
        names,
        '',
        `出图：/stocks -d ${hit}`,
      ].join('\n') };
    }

    // 全部组合：每个组合一行「名称 N只：成分…」（成分不截断，一次看全）
    const sorted = keys.sort();
    const total = sorted.reduce((n, k) => n + (((pf[k] && Array.isArray(pf[k].stocks)) ? pf[k].stocks.length : 0)), 0);
    const L = [`📋 已保存的组合（${sorted.length} 个，共 ${total} 只）`];
    sorted.forEach(k => {
      const st = (pf[k] && Array.isArray(pf[k].stocks)) ? pf[k].stocks : [];
      const names = st.map(s => s.name || s.code).join('、') || '（空）';
      L.push(`${k} ${st.length}只：${names}`);
    });
    L.push('');
    L.push('出图：/stocks -d <组合名>　单看一个：/stocks -list <组合名>');
    return { ok: true, text: L.join('\n') };
  }

  // —— 新建 / 整组覆盖（-add，仅主人） ——
  if (mode === 'add') {
    if (!nameFromFlag || !name) return { ok: false, text: `⚠️ 缺少组合名，请用 -name <组合名>\n\n${STOCKS_USAGE}` };
    if (!PORTFOLIO_NAME_RE.test(name)) return { ok: false, text: '⚠️ 组合名仅支持中英文/数字/下划线/短横线/点，长度 1-12，且不能以 - 开头' };
    if (!operands.length) return { ok: false, text: '⚠️ 未指定股票，例：/stocks -add 600519 300750 -name 我的持仓' };
    if (operands.length > PORTFOLIO_MAX) return { ok: false, text: `⚠️ 单个组合最多 ${PORTFOLIO_MAX} 只（当前 ${operands.length} 只），组合未改动` };
    const { okList, bad } = await resolveStockArgs(operands);
    if (!okList.length) return { ok: false, text: `⚠️ 没有解析出有效股票，组合未改动${bad.length ? `\n${bad.join('、')}` : ''}` };
    const pf = loadPortfolios();
    const key = findPortfolioKey(pf, name) || name; // 已有同名（忽略大小写）则复用原键，避免建出重复组合
    const existed = !!pf[key];
    pf[key] = {
      owner: String((existed && pf[key].owner) || ctx.uid || ''),
      created: existed ? (pf[key].created || nowText()) : nowText(),
      updated: nowText(),
      stocks: okList,
    };
    if (!savePortfolios(pf)) return { ok: false, text: '⚠️ 组合保存失败（服务端写盘异常），请查看容器日志' };
    const L = [`${existed ? '♻️ 已覆盖组合' : '✅ 已保存组合'}【${key}】${okList.length} 只`,
      `　${okList.map(s => s.name).join('、')}`];
    if (bad.length) L.push(`⚠️ 已跳过：${bad.join('、')}`);
    L.push(`→ /stocks -d ${key}`);
    return { ok: true, text: L.join('\n') };
  }

  // —— 整组替换（-update，仅主人）：组合必须已存在，用新名单整体覆盖 ——
  if (mode === 'update') {
    // 组合名：给了 -name 就用它、位置参数全当股票；否则取第一个位置参数当组合名
    const target = (nameFromFlag ? name : (operands[0] || '')).trim();
    const stockArgs = nameFromFlag ? operands : operands.slice(1);
    if (!target) return { ok: false, text: `⚠️ 缺少组合名，例：/stocks -update 我的持仓 600519 300750\n\n${STOCKS_USAGE}` };
    if (!PORTFOLIO_NAME_RE.test(target)) return { ok: false, text: `⚠️ 组合名「${target}」不合法（中英文/数字/下划线打头，后接中英文/数字/下划线/点/短横线，1-12 字符）` };
    // 边界：不给股票 ≠ 清空组合。清空是破坏性操作，必须显式用 -del，这里一律拒绝。
    if (!stockArgs.length) {
      return { ok: false, text: `⚠️ -update 至少要给一只股票（不会把组合清空）\n例：/stocks -update ${target} 600519 300750\n想删掉整个组合请用：/stocks -del ${target}` };
    }
    // 边界：超上限直接拒绝，不静默截断（否则会悄悄丢票）
    if (stockArgs.length > PORTFOLIO_MAX) {
      return { ok: false, text: `⚠️ 单个组合最多 ${PORTFOLIO_MAX} 只（本次给了 ${stockArgs.length} 只），组合未改动` };
    }
    const pf = loadPortfolios();
    const hitKey = findPortfolioKey(pf, target); // 组合名忽略大小写
    if (!hitKey) {
      const keys = Object.keys(pf);
      return {
        ok: false,
        text: `⚠️ 没有找到组合【${target}】，-update 只能改已存在的组合\n`
          + `新建请用：/stocks -add ${stockArgs.slice(0, 3).join(' ')}${stockArgs.length > 3 ? ' …' : ''} -name ${target}`
          + (keys.length ? `\n现有组合：${keys.join('、')}` : ''),
      };
    }
    const { okList, bad } = await resolveStockArgs(stockArgs);
    // 边界：全解析失败时保持原组合不动，避免「手滑打错名字把组合清空」
    if (!okList.length) return { ok: false, text: `⚠️ 没有解析出有效股票，组合未改动${bad.length ? `\n${bad.join('、')}` : ''}` };
    const before = (Array.isArray(pf[hitKey].stocks) ? pf[hitKey].stocks : []).map(s => s.name || s.code);
    pf[hitKey] = {
      owner: String(pf[hitKey].owner || ctx.uid || ''),
      created: pf[hitKey].created || nowText(),
      updated: nowText(),
      stocks: okList,
    };
    if (!savePortfolios(pf)) return { ok: false, text: '⚠️ 组合保存失败（服务端写盘异常），请查看容器日志' };
    // 显式列出增删，避免「手滑换错名单」时无感（写操作可逆性差，回执要够清楚）
    const beforeSet = new Set(before);
    const afterNames = okList.map(s => s.name);
    const added = afterNames.filter(x => !beforeSet.has(x));
    const removed = before.filter(x => !new Set(afterNames).has(x));
    const L = [`✏️ 已更新组合【${hitKey}】：${before.length} 只 → ${okList.length} 只`];
    if (added.length) L.push(`　＋ 新增：${added.join('、')}`);
    if (removed.length) L.push(`　－ 移除：${removed.join('、')}`);
    L.push(`　当前：${afterNames.join('、')}`);
    if (bad.length) L.push(`⚠️ 已跳过：${bad.join('、')}`);
    L.push(`→ /stocks -d ${hitKey}`);
    return { ok: true, text: L.join('\n') };
  }

  // —— 删除组合（-del，仅主人） ——
  if (mode === 'del') {
    const target = (name || operands.join('')).trim();
    if (!target) return { ok: false, text: `⚠️ 请指定要删除的组合名，例：/stocks -del 我的持仓` };
    const pf = loadPortfolios();
    const hitKey = findPortfolioKey(pf, target); // 组合名忽略大小写
    if (!hitKey) {
      const keys = Object.keys(pf);
      return { ok: false, text: `⚠️ 没有找到组合【${target}】${keys.length ? `\n现有组合：${keys.join('、')}` : ''}` };
    }
    const cnt = (Array.isArray(pf[hitKey].stocks) ? pf[hitKey].stocks : []).length;
    delete pf[hitKey];
    if (!savePortfolios(pf)) return { ok: false, text: '⚠️ 删除失败（服务端写盘异常），组合未改动' };
    return { ok: true, text: `🗑️ 已删除组合【${hitKey}】（${cnt} 只）` };
  }

  // —— 出图 ——
  const uniq = [...new Set(periods)];
  if (uniq.length > 1) return { ok: false, text: '⚠️ 周期只能指定一个（-t 分时 / -pre 美股盘前 / -d 日线 / -w 周线 / -m 月线）' };
  const period = uniq[0] || 'day';
  if (!operands.length) return { ok: false, text: STOCKS_USAGE };

  const pf = loadPortfolios();
  const notes = [];
  let title = '自选股', targets = [];
  const comboKey = (operands.length === 1) ? findPortfolioKey(pf, operands[0]) : ''; // 组合名忽略大小写
  if (comboKey) {
    const st = Array.isArray(pf[comboKey].stocks) ? pf[comboKey].stocks : [];
    if (!st.length) return { ok: false, text: `⚠️ 组合【${comboKey}】是空的，请重新用 -add 保存` };
    targets = st.slice(0, STOCKS_RENDER_MAX).map(s => ({ code: s.code, hint: s.name }));
    title = comboKey;
    if (st.length > targets.length) notes.push(`组合共 ${st.length} 只，仅显示前 ${targets.length} 只`);
  } else {
    const qs = operands.slice(0, STOCKS_RENDER_MAX);
    if (operands.length > qs.length) notes.push(`最多显示 ${STOCKS_RENDER_MAX} 只，已取前 ${qs.length} 只`);
    targets = qs.map(q => ({ q }));
  }

  const resolved = await mapLimit(targets, 4, async t => {
    if (t.code) return { code: t.code, hint: t.hint };
    let code = normalizeCode(t.q);
    if (!code) code = await resolveStockCode(t.q);
    return code ? { code, hint: t.q } : { code: '', hint: t.q, err: `未找到「${t.q}」` };
  });

  const items = await mapLimit(resolved, 4, async t => {
    if (!t.code) return { error: true, code: t.hint, name: t.hint, msg: '未找到该标的' };
    const mkt = t.code.startsWith('us') ? 'us' : t.code.startsWith('hk') ? 'hk' : t.code.startsWith('hf_') ? 'hf' : 'cn';
    const itemPeriod = period === 'premarket' ? (mkt === 'us' ? 'premarket' : 'time') : period;
    const [kl, qt] = await Promise.all([fetchStockKline(t.code, itemPeriod), fetchStockQuote(t.code)]);
    const label = (qt && qt.name) || t.hint || t.code;
    if (!kl || !kl.length) {
      const preStatus = itemPeriod === 'premarket' ? getYahooPremarketStatus(t.code) : '';
      const msg = itemPeriod === 'premarket'
        ? (preStatus === 'source_error' ? '盘前数据源暂不可用' : '暂无今日盘前成交')
        : '取数失败';
      return { error: true, code: t.code, name: label, msg, mkt };
    }
    return { code: t.code, name: label, klines: kl, quote: qt, mkt, itemPeriod };
  });

  const valid = items.filter(it => !it.error);
  if (!valid.length) {
    return { ok: false, text: `⚠️ ${STOCKS_PERIOD_LABEL[period]}数据获取失败\n${items.map(it => `${it.name}：${it.msg}`).join('\n')}` };
  }
  if (items.length === 1 && valid.length === 1) title = valid[0].name; // 单只标的：标题直接用股票名

  // 逐项派生出图所需字段
  const cols = stocksGridCols(items.length);
  const baseW = Math.floor((1080 - (cols - 1)) / cols); // 与 buildStocksPng 的列宽算法一致
  // 实测字宽（1080px 画布）：1列可用 1036 / 2列 495 / 3列 327 / 4列 241
  // 现价已改画进走势图（见 buildStocksPng），底部行只保留「代码 + 区间 xxx%」
  const showPrefix = baseW >= 300;
  let up = 0, down = 0, sum = 0, cnt = 0;
  for (const it of items) {
    if (it.error) continue;
    const disp = stocksWindow(it, period);
    const cl = disp.map(k => k.close);
    const last = cl[cl.length - 1], first = cl[0];
    const q = it.quote;
    const isPreItem = it.itemPeriod === 'premarket';
    const livePx = isPreItem ? Number(last) : ((q && Number(q.price) > 0) ? Number(q.price) : last);
    const prevClose = isPreItem && Number(it.klines._prevClose) > 0 ? Number(it.klines._prevClose)
      : ((q && Number(q.prevClose) > 0) ? Number(q.prevClose)
        : ((period === 'time' || period === 'premarket') ? first : (it.klines[it.klines.length - 2]?.close ?? first)));
    const chgPct = isPreItem
      ? (prevClose > 0 ? (livePx - prevClose) / prevClose * 100 : 0)
      : ((q && isFinite(q.chgPct) && q.chgPct !== 0) ? Number(q.chgPct)
        : (prevClose > 0 ? (livePx - prevClose) / prevClose * 100 : 0));

    // 价格精度：场内基金（ETF/LOF）固定 3 位；否则现价有三位小数时保留 3 位
    let prec = isFundCode(it.code) ? 3 : 2;
    if (prec === 2) {
      const sv = String(livePx), dot = sv.indexOf('.');
      if (dot > 0 && sv.slice(dot + 1).replace(/0+$/, '').length > 2) prec = 3;
    }
    const fp = v => isFinite(v) ? Number(v).toFixed(prec) : '-';

    it.disp = disp;
    it.chgPct = chgPct;
    it.lineCol = chgPct >= 0 ? '#f5222d' : '#0aa869'; // 分时价格线红绿按昨收涨跌（与单只 /stock 一致）
    it.baseline = (period === 'time' || period === 'premarket') ? (prevClose > 0 ? prevClose : 0) : (first || 0);
    it.avgLine = ((period === 'time' || period === 'premarket') && !isPreItem && !/^(sh000|sz399|hkHSI|usDJI|usINX)/.test(it.code))
      ? buildAvgLine(disp) : null;
    // 注：指数（sh000xxx/sz399xxx/hkHSI）的「累计额/累计量」是全部成分股合计，
    //   算出的均价（~2700）与指数点位（~3300）完全不在一个量级，加进 Y 轴会把
    //   价格线压成只剩顶部一小条。单只 /stock -t 在 renderStockPngCanvas/Svg 里
    //   已有同样的 isIndex 守卫（line ~1254/1604），这里补上保持一致。
    const codeShort = it.code.replace(/\.\w+$/, '').toUpperCase();
    it.livePx = livePx;
    it.livePxTxt = fp(livePx);
    it.metaLeft = codeShort;
    it.prevText = ((period === 'time' || period === 'premarket') && prevClose > 0) ? fp(prevClose) : '';
    if (period === 'time' || period === 'premarket') {
      const hi = Math.max(...disp.map(k => k.high)), lo2 = Math.min(...disp.map(k => k.low));
      const amp = prevClose > 0 ? (hi - lo2) / prevClose * 100 : 0;
      it.metaRight = `${showPrefix ? '振幅 ' : ''}${amp.toFixed(2)}%`;
      it.metaCol = '#8a919c';
    } else {
      const rp = (first > 0) ? (last - first) / first * 100 : 0;
      it.metaRight = `${showPrefix ? '区间 ' : ''}${rp >= 0 ? '+' : ''}${rp.toFixed(2)}%`;
      it.metaCol = rp >= 0 ? '#f5222d' : '#0aa869';
    }
    if (Number.isFinite(chgPct)) { sum += chgPct; cnt++; chgPct >= 0 ? up++ : down++; }
  }

  const avg = cnt ? sum / cnt : 0;
  const dt = new Date();
  const p2 = x => String(x).padStart(2, '0');
  const today = `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
  const hhmm = `${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
  const failNote = items.filter(it => it.error).map(it => `${it.name} ${it.msg || '取数失败'}`).join('；');
  // 数据来源并非只有腾讯：国际商品走新浪全球期货 → 页脚按实际来源标注，避免误导
  const srcs = [];
  if (items.some(it => !it.error && it.itemPeriod === 'premarket')) srcs.push('Yahoo盘前');
  if (items.some(it => !it.error && it.mkt === 'hf')) srcs.push('新浪全球期货');
  if (items.some(it => !it.error && it.klines && it.klines._src === 'sina')) srcs.push('新浪美股分时');
  if (items.some(it => !it.error && it.itemPeriod !== 'premarket' && it.mkt !== 'hf')) srcs.push('腾讯行情');
  // 用途/统计/失败提示一律并进页脚（图内已可见），不再额外单发一条消息——
  // 2026-09-11 用户要求：灰底格 + 页脚已足够说明，重复文本消息是干扰。
  const mixedNote = period === 'premarket' && items.some(it => !it.error && it.mkt !== 'us')
    ? '非美股标的按普通分时展示' : '';
  const footer = [`数据来源：${srcs.join(' + ') || '腾讯行情'} · ${STOCKS_PERIOD_LABEL[period]} · 生成 ${today} ${hhmm}`]
    .concat(mixedNote ? [mixedNote] : [])
    .concat(failNote ? [failNote] : [])
    .concat(notes.filter(Boolean))
    .join('　|　');

  const img = buildStocksPng(items, {
    period, title,
    sub: `${STOCKS_PERIOD_LABEL[period]} · ${today} ${hhmm}`,
    avgTxt: `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`,
    avgCol: avg >= 0 ? '#f5222d' : '#0aa869',
    statsTxt: `${valid.length} 只 · ${up} 涨 ${down} 跌`,
    footer,
  });
  return { ok: true, img }; // 失败/截断提示已在图内（灰底格 + 页脚），不再额外发文本消息
}

module.exports = { cmdStocks, loadPortfolios, savePortfolios, resolveStockArgs };
