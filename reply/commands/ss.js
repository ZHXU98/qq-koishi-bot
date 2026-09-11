// ============================================================
// /ss 指数行情：上证/沪深300/深证综指 + 成交额对比 + 申万二级资金流
// ============================================================
const { NAPCAT_URL, TOKEN } = require('../config');
const { cacheGet, cacheSet, fmtAmountWan, fmtAmountYuan, estFullDayAmount, isTradingDay, normStockName } = require('../utils');
const { emFetchJson } = require('../market');

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

  // ---------- 全市场涨跌家数（/ss 内嵌，2026-09-11 新增） ----------
  // 数据源：东财 ulist，f104=上涨家数 f105=下跌家数 f106=平盘家数；上证(1.000001)+深证综指(0.399106)=沪深两市全量
  const EM_UP_DOWN = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f104,f105,f106&secids=1.000001,0.399106';
  async function fetchUpDownCount() {
    const cached = cacheGet('updown');
    if (cached) return cached;
    // 复用 emFetchJson：东财会阻断部分 IP 的主站节点，需按「上次成功节点优先」轮换到 push2delay
    const j = await emFetchJson(EM_UP_DOWN);
    const diff = j?.data?.diff;
    if (!Array.isArray(diff) || diff.length < 2) return null;
    const up = diff.reduce((s, x) => s + (Number(x.f104) || 0), 0);
    const down = diff.reduce((s, x) => s + (Number(x.f105) || 0), 0);
    const flat = diff.reduce((s, x) => s + (Number(x.f106) || 0), 0);
    const result = { up, down, flat };
    cacheSet('updown', result, 30000); // 30 秒缓存
    return result;
  }
  // 文本版涨跌家数
  function udText(ud) {
    if (!ud) return null;
    return `🔴 上涨 ${ud.up} 家　🟢 下跌 ${ud.down} 家　⚪ 平盘 ${ud.flat} 家`;
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
    const upC = '#f5222d', downC = '#0aa869'; // A股：涨红跌绿
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
    let H = 18 + 44 + (data.indices.length * (206 + 12)) + 132 + 12 + (data.sw2 && data.sw2.inflow.length ? 206 + 12 : 0) + 16;
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(Math.round(W * 1.2), Math.round(H * 1.2)); // 1.2x 分辨率，兼顾清晰与生成速度
    const ctx = canvas.getContext('2d');
    ctx.scale(1.2, 1.2);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    const mmdd = data.t.slice(5, 10);

    let y = 18;
    // 标题：左侧渐变 accent 竖条
    const ssGrad = ctx.createLinearGradient(PAD, y + 4, PAD, y + 40);
    ssGrad.addColorStop(0, '#f5222d'); ssGrad.addColorStop(1, '#ff7875');
    ctx.fillStyle = ssGrad; ctx.fillRect(PAD, y + 4, 5, 36);
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 26px cjk';
    ctx.fillText('指数行情' + (data.closed ? '（已收盘）' : ''), PAD + 16, y + 22);
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
      // 左侧渐变 accent 竖条（涨=红渐变，跌=绿渐变）
      const cardAccGrad = ctx.createLinearGradient(x0 + 14, y + 28, x0 + 14, y + cardH - 28);
      cardAccGrad.addColorStop(0, chgCol);
      cardAccGrad.addColorStop(1, it.chg >= 0 ? '#ff7875' : '#4cd8a8');
      ctx.fillStyle = cardAccGrad; ctx.fillRect(x0 + 14, y + 28, 4, cardH - 56);
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 18px cjk';
      ctx.fillText(it.name, x0 + 26, y + 28);
      ctx.fillStyle = sub; ctx.font = '13px cjk';
      ctx.fillText(String(it.code).slice(2), x0 + 160, y + 28);
      // 现价 + 涨跌（价格 40px 中心 y+66，分隔线下移到 y+92 避免交叉）
      ctx.fillStyle = chgCol; ctx.font = 'bold 40px cjk';
      ctx.fillText(f2(it.price), x0 + 18, y + 66);
      const chgTxt = `${it.chg >= 0 ? '+' : ''}${f2(it.chg)}  ${it.chgPct >= 0 ? '+' : ''}${f2(it.chgPct)}%`;
      ctx.textAlign = 'right'; ctx.font = 'bold 19px cjk';
      ctx.fillText(chgTxt, x0 + cw - 18, y + 66);
      // 分隔线（y+92，安全低于 40px 字体下边缘 y+86）
      ctx.strokeStyle = lineC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + 18, y + 92); ctx.lineTo(x0 + cw - 18, y + 92); ctx.stroke();
      // 三列：今开/最高/最低
      const colW3 = (cw - 36) / 3;
      ctx.textAlign = 'left';
      [['今开', f2(it.open)], ['最高', f2(it.high)], ['最低', f2(it.low)]].forEach((c2, i) => {
        const cx = x0 + 18 + colW3 * i;
        ctx.fillStyle = sub; ctx.font = '12px cjk';
        ctx.fillText(c2[0], cx, y + 108);
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
        ctx.fillText(c2[1], cx, y + 166);
      });
      // 放量缩量条（bar top y+178，h=24）
      const [ct, cc] = compLine(c, !data.closed);
      const barA = cc === upC ? 'rgba(245,34,45,0.08)' : cc === downC ? 'rgba(10,168,105,0.08)' : 'rgba(138,145,158,0.08)';
      ctx.fillStyle = barA; ctx.beginPath(); ctx.roundRect(x0 + 18, y + 178, cw - 36, 24, 8); ctx.fill();
      ctx.fillStyle = cc; ctx.textAlign = 'left'; ctx.font = 'bold 14px cjk';
      ctx.fillText(ct, x0 + 32, y + 190);
      y += cardH + 12;
    }

    // 全市场卡片
    const mc = comp(data.mkt.curYuan, data.mkt.prevYuan);
    const mktH = 132;
    rrect(x0, y, cw, mktH, 14, panel);
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 18px cjk';
    ctx.fillText('全市场（沪深两市合计）', x0 + 18, y + 28);
    ctx.font = 'bold 30px cjk';
    ctx.fillText(`${f1(data.mkt.amountWan / 10000)}亿`, x0 + 18, y + 64);
    if (!data.closed) {
      ctx.fillStyle = sub; ctx.textAlign = 'right'; ctx.font = '15px cjk';
      ctx.fillText(`预计全天 ${f1(data.mkt.est / 10000)}亿`, x0 + cw - 18, y + 62);
    }
    // 涨跌家数：醒目横条（三段等宽色块：上涨红 / 下跌绿 / 平盘灰）
    if (data.ud) {
      const segW = (cw - 36) / 3, barH = 24;
      const segs = [
        { label: `上涨 ${data.ud.up}`, col: upC },
        { label: `下跌 ${data.ud.down}`, col: downC },
        { label: `平盘 ${data.ud.flat}`, col: sub },
      ];
      segs.forEach((seg, i) => {
        const sx = x0 + 18 + segW * i;
        ctx.fillStyle = seg.col;
        ctx.beginPath(); ctx.roundRect(sx, y + 78, segW - 5, barH, 6); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.font = 'bold 14px cjk';
        // textBaseline='middle'，垂直中心正好在横条中央，不加额外偏移
        ctx.fillText(seg.label, sx + (segW - 5) / 2, y + 78 + barH / 2);
      });
      ctx.textAlign = 'left';
    }
    const [mt, mcol] = compLine(mc, !data.closed);
    ctx.fillStyle = mcol === upC ? 'rgba(245,34,45,0.08)' : mcol === downC ? 'rgba(10,168,105,0.08)' : 'rgba(138,145,158,0.08)';
    ctx.beginPath(); ctx.roundRect(x0 + 18, y + 104, cw - 36, 26, 8); ctx.fill();
    ctx.fillStyle = mcol; ctx.textAlign = 'left'; ctx.font = 'bold 13px cjk';
    ctx.fillText(mt, x0 + 32, y + 121);
    y += mktH + 12;

    // 申万二级行业资金流
    if (data.sw2 && data.sw2.inflow.length) {
      const swH = 206;
      rrect(x0, y, cw, swH, 14, panel);
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = 'bold 16px cjk';
      ctx.fillText('申万二级行业资金流（主力净流入）', x0 + 18, y + 26);
      const halfW = (cw - 36 - 12) / 2;
      const maxIn = Math.max(...data.sw2.inflow.map(r => r.yiyi), 1);
      const maxOut = Math.max(...data.sw2.outflow.map(r => Math.abs(r.yiyi)), 1);
      // 中间垂直分割线
      const divX = x0 + 18 + halfW + 6;
      ctx.strokeStyle = lineC; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(divX, y + 38); ctx.lineTo(divX, y + swH - 10); ctx.stroke();
      // 左：流入
      ctx.fillStyle = upC; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'left';
      ctx.fillText('流入 TOP5', x0 + 18, y + 48);
      data.sw2.inflow.forEach((r, i) => {
        const ry = y + 68 + i * 28;
        // 占比横条（右对齐，从列右边往左延伸）
        const bw = Math.round((r.yiyi / maxIn) * (halfW - 16));
        ctx.fillStyle = 'rgba(245,34,45,0.18)';
        ctx.beginPath(); ctx.roundRect(x0 + 18 + halfW - 6 - bw, ry - 9, bw, 18, 3); ctx.fill();
        ctx.fillStyle = ink; ctx.font = '13px cjk'; ctx.textAlign = 'left';
        ctx.fillText(r.name.length > 7 ? r.name.slice(0, 7) + '…' : r.name, x0 + 20, ry);
        ctx.fillStyle = upC; ctx.font = 'bold 13px cjk'; ctx.textAlign = 'right';
        ctx.fillText(`+${r.yiyi.toFixed(1)}亿`, x0 + 18 + halfW - 8, ry);
      });
      // 右：流出
      const rx2 = divX + 6;
      ctx.fillStyle = downC; ctx.font = 'bold 14px cjk'; ctx.textAlign = 'left';
      ctx.fillText('流出 TOP5', rx2, y + 48);
      data.sw2.outflow.forEach((r, i) => {
        const ry = y + 68 + i * 28;
        const bw = Math.round((Math.abs(r.yiyi) / maxOut) * (halfW - 16));
        ctx.fillStyle = 'rgba(10,168,105,0.18)';
        ctx.beginPath(); ctx.roundRect(rx2, ry - 9, bw, 18, 3); ctx.fill();
        ctx.fillStyle = ink; ctx.font = '13px cjk'; ctx.textAlign = 'left';
        ctx.fillText(r.name.length > 7 ? r.name.slice(0, 7) + '…' : r.name, rx2 + 2, ry);
        ctx.fillStyle = downC; ctx.font = 'bold 13px cjk'; ctx.textAlign = 'right';
        ctx.fillText(`${r.yiyi.toFixed(1)}亿`, rx2 + halfW - 8, ry);
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
    const upC = '#f5222d', downC = '#0aa869'; // A股：涨红跌绿
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
    const barBg = col => col === upC ? 'rgba(245,34,45,0.08)' : col === downC ? 'rgba(10,168,105,0.08)' : 'rgba(138,145,158,0.08)';

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
      // 现价 + 涨跌（价格 40px 中心 y+66，分隔线下移到 y+92 避免交叉）
      s += `<text x="${x0 + 18}" y="${y + 66}" font-family="PingFang SC,cjk" font-size="40" font-weight="bold" fill="${chgCol}">${f2(it.price)}</text>`;
      const chgTxt = `${it.chg >= 0 ? '+' : ''}${f2(it.chg)}  ${it.chgPct >= 0 ? '+' : ''}${f2(it.chgPct)}%`;
      s += `<text x="${x0 + cw - 18}" y="${y + 66}" text-anchor="end" font-family="PingFang SC,cjk" font-size="19" font-weight="bold" fill="${chgCol}">${chgTxt}</text>`;
      s += `<line x1="${x0 + 18}" y1="${y + 92}" x2="${x0 + cw - 18}" y2="${y + 92}" stroke="${lineC}" stroke-width="1"/>`;
      // 三列：今开/最高/最低
      const colW3 = (cw - 36) / 3;
      [['今开', f2(it.open)], ['最高', f2(it.high)], ['最低', f2(it.low)]].forEach((c2, i) => {
        const cx = x0 + 18 + colW3 * i;
        s += `<text x="${cx}" y="${y + 108}" font-family="PingFang SC,cjk" font-size="12" fill="${sub}">${c2[0]}</text>`;
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
        s += `<text x="${cx}" y="${y + 166}" font-family="PingFang SC,cjk" font-size="16" font-weight="bold" fill="${ink}">${esc(c2[1])}</text>`;
      });
      // 放量缩量条（bar top y+178，h=24）
      const [ct, cc] = compLine(c, !data.closed);
      s += `<rect x="${x0 + 18}" y="${y + 178}" width="${cw - 36}" height="24" rx="8" fill="${barBg(cc)}"/>`;
      s += `<text x="${x0 + 32}" y="${y + 190}" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${cc}">${esc(ct)}</text>`;
      y += cardH + 12;
    }

    // 全市场卡片
    const mc = comp(data.mkt.curYuan, data.mkt.prevYuan);
    const mktH = 132;
    s += `<rect x="${x0}" y="${y}" width="${cw}" height="${mktH}" rx="14" fill="${panel}"/>`;
    s += `<text x="${x0 + 18}" y="${y + 28}" font-family="PingFang SC,cjk" font-size="18" font-weight="bold" fill="${ink}">全市场（沪深两市合计）</text>`;
    s += `<text x="${x0 + 18}" y="${y + 64}" font-family="PingFang SC,cjk" font-size="30" font-weight="bold" fill="${ink}">${f1(data.mkt.amountWan / 10000)}亿</text>`;
    if (!data.closed) {
      s += `<text x="${x0 + cw - 18}" y="${y + 62}" text-anchor="end" font-family="PingFang SC,cjk" font-size="15" fill="${sub}">预计全天 ${f1(data.mkt.est / 10000)}亿</text>`;
    }
    // 涨跌家数：醒目横条（三段等宽色块：上涨红 / 下跌绿 / 平盘灰）
    if (data.ud) {
      const segW = (cw - 36) / 3, barH = 24;
      const segs = [
        { label: `上涨 ${data.ud.up}`, col: upC },
        { label: `下跌 ${data.ud.down}`, col: downC },
        { label: `平盘 ${data.ud.flat}`, col: sub },
      ];
      segs.forEach((seg, i) => {
        const sx = x0 + 18 + segW * i;
        s += `<rect x="${sx}" y="${y + 78}" width="${segW - 5}" height="${barH}" rx="6" fill="${seg.col}"/>`;
        s += `<text x="${sx + (segW - 5) / 2}" y="${y + 78 + barH / 2 + 5}" text-anchor="middle" dominant-baseline="middle" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="#ffffff">${esc(seg.label)}</text>`;
      });
    }
    const [mt, mcol] = compLine(mc, !data.closed);
    s += `<rect x="${x0 + 18}" y="${y + 104}" width="${cw - 36}" height="26" rx="8" fill="${barBg(mcol)}"/>`;
    s += `<text x="${x0 + 32}" y="${y + 121}" font-family="PingFang SC,cjk" font-size="13" font-weight="bold" fill="${mcol}">${esc(mt)}</text>`;
    y += mktH + 12;

    // 申万二级行业资金流
    if (data.sw2 && data.sw2.inflow.length) {
      const swH = 206;
      s += `<rect x="${x0}" y="${y}" width="${cw}" height="${swH}" rx="14" fill="${panel}"/>`;
      s += `<text x="${x0 + 18}" y="${y + 26}" font-family="PingFang SC,cjk" font-size="16" font-weight="bold" fill="${ink}">申万二级行业资金流（主力净流入）</text>`;
      const halfW = (cw - 36 - 12) / 2;
      // 左：流入 TOP5（行间距 28px，标题到第一行 22px 间隙）
      s += `<text x="${x0 + 18}" y="${y + 48}" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${upC}">流入 TOP5</text>`;
      data.sw2.inflow.forEach((r, i) => {
        const ry = y + 72 + i * 28;
        s += `<text x="${x0 + 18}" y="${ry}" font-family="PingFang SC,cjk" font-size="14" fill="${ink}">${esc(r.name.length > 9 ? r.name.slice(0, 9) + '…' : r.name)}</text>`;
        s += `<text x="${x0 + 18 + halfW - 6}" y="${ry}" text-anchor="end" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${upC}">+${r.yiyi.toFixed(1)}亿</text>`;
      });
      // 右：流出 TOP5
      const rx2 = x0 + 18 + halfW + 12;
      s += `<text x="${rx2}" y="${y + 48}" font-family="PingFang SC,cjk" font-size="14" font-weight="bold" fill="${downC}">流出 TOP5</text>`;
      data.sw2.outflow.forEach((r, i) => {
        const ry = y + 72 + i * 28;
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

  // —— 申万二级行业资金流（流入/流出前5）+ 全市场涨跌家数 ——
  const [sw2, ud] = await Promise.all([fetchSw2Flow(), fetchUpDownCount()]);

  const t = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const header = `${closed ? '🏁' : '📊'} 指数行情 ${closed ? '（已收盘）' : ''}${t.slice(5, 16)}`;

  // 主路径：渲染竖版白底卡片图（手机友好）
  const img = renderSSPng({ closed, nowHHMM, t, indices, mkt, sw2, ud });
  if (img) return { ok: true, text: header, img };

  // 渲染失败 → 文本 fallback
  const st = sw2Text(sw2);
  if (st) lines.push(st);
  const ut = udText(ud);
  if (ut) lines.push(ut);
  return { ok: false, text: [header, ...lines].join('\n').trim() };
}

module.exports = { cmdSS };
