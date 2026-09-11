// ============================================================
// /info 个股速查 + /etfinfo ETF持仓
// ============================================================
const { cacheGet, cacheSet, normStockName, wrapText, f2p } = require('../utils');
const { emFetchJson, emSecid, fetchStockQuote, EM_UA } = require('../market');

// 用法：/info <代码或名称> [条数]（公告/新闻各 N 条，默认 8，1-10）
// 数据源：行情=腾讯 qt.gtimg.cn；公司概况=东财 F10 RPT_F10_BASIC_ORGINFO；公告=东财 np-anotice-stock；新闻=东财 search-api-web
const EM_F10 = 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_BASIC_ORGINFO&columns=ALL&filter=(SECUCODE%3D%22%s%22)&pageNumber=1&pageSize=1&source=HSF10&client=PC';
const EM_ANN = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=%s&page_index=1&ann_type=A&client_source=web&stock_list=%s';
const EM_NEWS = 'https://search-api-web.eastmoney.com/search/jsonp?cb=callback&param=%s';

// 东财行情节点轮换（2026-09-10 实测修）
// 现象：push2his.eastmoney.com / push2.eastmoney.com 会对调用方出口 IP 主动 RST（UND_ERR_SOCKET / ECONNRESET）。
// 已排除的因素：冷却 60s/90s 后不恢复（非限流）；换 UA/Referer 无效（非反爬头校验）；
// 容器与宿主机表现一致（非容器网络）；DNS 正确且换 IP 直连同样被重置（非 DNS 污染）。
// 结论：东财对部分调用方 IP 持续阻断主站节点，而 push2delay.eastmoney.com（延时行情节点）同接口稳定可用。
// 注：push2delay 的 dlmkts 延时市场名单为 8/10/128，不含沪深(1/0)、美股(105/106/107)、港股(116)，对我们取数即实时数据。
// 做法：按「上次成功节点优先」轮换，成功即记忆，避免每个请求都先撞一次墙。

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

// /info 图渲染：白底竖版（标题+行情+公司概况+公告+新闻）
function renderInfoPng(data) {
  try { return renderInfoPngCanvas(data); }
  catch (e) { console.error('[info] canvas 渲染失败:', e.message); return ''; }
}

function renderInfoPngCanvas(data) {
  const { createCanvas } = require('@napi-rs/canvas');
  const W = 720, PAD = 20;
  const bg = '#ffffff', panel = '#f7f8fa', ink = '#2b2f36', sub = '#8a919e', lineC = '#e8eaed';
  const upC = '#f5222d', downC = '#0aa869';
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
    ctx.fillStyle = panel; ctx.beginPath(); ctx.roundRect(PAD, y, W - PAD * 2, 92, 14); ctx.fill();
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
  sectionTitle(`最近新闻（${data.news.length}条）`, '#0aa869');
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

// 覆盖：A股场内 ETF / LOF / ETF联接 / 场外基金均可识别；持仓明细仅支持 A股/港股标的（美股持仓不展示）
// ETF 判定=简称含 ETF 且非联接基金（联接名称如"沪深300ETF联接A"非场内 ETF）
const EM_FUND_BASIC = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNBasicInformation?FCODE=%s&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8';
const EM_FUND_CC = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=%s&topline=10';
// 常见宽基指数 → 跟踪 ETF（输入"上证50"等指数名/代码时提示对应 ETF）
const IDX_ETF_MAP = {
  '000016': '510050（上证50ETF）', '000300': '510300（沪深300ETF）',
  '000905': '510500（中证500ETF）', '000852': '512100（中证1000ETF）',
  '000688': '588000（科创50ETF）', '399006': '159915（创业板ETF）',
  '399005': '159949（创业板50ETF）', '399001': '159903（深证ETF）',
};

// 6位基金代码 → 东财基金资料；非基金/查询失败返回 null
async function fetchFundBasic(code) {
  try {
    const r = await fetch(EM_FUND_BASIC.replace('%s', code), { headers: EM_UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const d = j && j.Datas;
    if (!d) return null;
    const name = String(d.SHORTNAME || '').trim();
    return {
      code, name,
      fullType: String(d.FTYPE || ''),
      sgzt: String(d.SGZT || ''),
      indexCode: String(d.INDEXCODE || ''),
      indexName: String(d.INDEXNAME || '').replace(/\(价格\)$/, ''),
      isEtf: /ETF/i.test(name) && !/联接/i.test(name),
    };
  } catch (_) { return null; }
}

// 定期报告股票前十（东财 jjcc HTML → 结构化）；无持仓披露/非基金返回 null
async function fetchFundHoldingTop(code) {
  try {
    const r = await fetch(EM_FUND_CC.replace('%s', code), {
      headers: { 'User-Agent': EM_UA['User-Agent'], 'Referer': `http://fundf10.eastmoney.com/ccmx_${code}.html` },
      signal: AbortSignal.timeout(8000),
    });
    const t = await r.text();
    const m = t.match(/content:"([\s\S]*?)"\s*,\s*arryear/);
    if (!m || !m[1]) return null;
    const content = m[1];
    const dateM = content.match(/截止至：<font[^>]*>([\d-]+)<\/font>/);
    const labelM = content.match(/(\d{4}年.{1,4}季度)/);
    const tbl = content.match(/<table[\s\S]*?<\/table>/);
    const holds = [];
    if (tbl) {
      const rows = [...tbl[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
      for (const rm of rows) {
        const tds = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);
        if (tds.length < 9) continue;
        const codeText = tds[1].replace(/<[^>]+>/g, '').trim(); // A股6位 / 港股5位 / 美股字母
        if (!codeText) continue;
        const pctM = tds[6].match(/([\d.]+)%/); // 占净值比例
        const clean = v => { const s = String(v).replace(/<[^>]+>/g, '').replace(/,/g, '').trim(); return s ? Number(s) : 0; };
        holds.push({ code: codeText, name: tds[2].replace(/<[^>]+>/g, '').trim(), pct: pctM ? Number(pctM[1]) : 0, mv: clean(tds[8]) }); // mv 单位：万元
      }
    }
    return { period: labelM ? labelM[1] : '', date: dateM ? dateM[1] : '', holds: holds.slice(0, 10) };
  } catch (_) { return null; }
}

async function cmdEtfInfo(args) {
  const parts = (args || []).map(a => String(a).trim()).filter(Boolean);
  if (!parts.length) return { ok: false, text: '📋 用法：/etfinfo <代码或名称>\n查 ETF 前十持仓 + 跟踪指数，并提示该代码/名称是不是 ETF\n例：/etfinfo 510300　/etfinfo 沪深300ETF　/etfinfo 159915　/etfinfo 纳指ETF' };
  const q = parts[0];
  let code = normalizeCode(q);
  if (!code) code = await resolveStockCode(q);
  if (!code) return { ok: false, text: `⚠️ 未找到「${q}」，请用 A股基金 6 位代码或名称（如 510300 / 沪深300ETF）` };
  const pre = code.slice(0, 2);
  const raw = code.slice(2).toUpperCase();
  // —— 非 A股市场：明确提示不是 A股 ETF ——
  if (pre === 'hk') {
    if (raw === 'HSI') return { ok: false, text: '⚠️ 恒生指数（HSI）是港股指数，不是 ETF\n跟踪它的 A股 ETF：/etfinfo 159920（恒生ETF）\n指数行情用 /stock 恒指　/stock -t 恒指' };
    return { ok: false, text: `⚠️ ${raw} 是港股标的，etfinfo 只查 A股场内基金持仓，不支持港股本体的持仓\n想看跟踪港股的 A股 ETF，请发其 A股代码或名称：\n/etfinfo 159920（恒生ETF）　/etfinfo 513180（恒生科技ETF华夏）\n港股行情用 /stock -t ${raw}` };
  }
  if (pre === 'us') return { ok: false, text: `⚠️ ${raw} 是美股标的，etfinfo 不支持美股\n看行情用 /stock -t ${raw.replace(/\.\w+$/, '')}` };
  if (pre === 'hf') return { ok: false, text: `⚠️ ${q} 是国际商品，不是 ETF\n商品行情请用：/stock -d ${q}（日线）　/stock -t ${q}（分时）` };
  // —— A股非基金（指数/股票）：先识别指数（腾讯快照 ZS 类型标识或代码段），再提示不是 ETF ——
  if (!/^5/.test(raw) && !/^1[56]/.test(raw)) {
    const qq = await fetchStockQuote(code);
    const isIdx = !!(qq && (qq.isIndex || /指数/.test(qq.name || ''))) || (pre === 'sh' && /^000\d{3}$/.test(raw)) || (pre === 'sz' && /^399\d{3}$/.test(raw));
    if (isIdx) {
      const nm = (qq && qq.name) || q;
      const etf = IDX_ETF_MAP[raw];
      return { ok: false, text: `⚠️ ${nm}（${raw}）是A股指数，不是 ETF\n${etf ? `跟踪该指数的 ETF：/etfinfo ${etf}` : '想查对应 ETF 持仓，发它的基金代码/名称即可'}\n指数行情用 /stock ${pre}${raw}　/ss（主要指数）` };
    }
    const qName = qq && qq.name ? ` ${qq.name}` : '';
    return { ok: false, text: `⚠️ ${raw}${qName} 是A股股票，不是 ETF\n看行情/资料请用：/stock ${raw}　/info ${raw}` };
  }
  // —— A股基金前缀（5/15/16）→ 东财核实（并行取资料+持仓） ——
  const [basic, cc] = await Promise.all([fetchFundBasic(raw), fetchFundHoldingTop(raw)]);
  if (!basic) return { ok: false, text: `⚠️ ${raw} 未在东财查到基金资料：不是场内基金/ETF，或代码有误` };
  const kind = basic.isEtf ? '✅ 是 ETF'
    : /联接/.test(basic.name) ? '⚠️ 是 ETF 联接基金（非场内 ETF，场内另有交易代码）'
    : /LOF/i.test(basic.name) ? '⚠️ 是 LOF，不是 ETF'
    : '⚠️ 是基金但不是 ETF';
  const L = [];
  L.push(`📊 ${basic.name}（${basic.code}）`);
  L.push(`${kind} ｜ ${basic.fullType}｜${basic.sgzt || '—'}`);
  const hasIdx = basic.indexName && basic.indexName !== '--';
  // 美股类基金判定（etfinfo 只做 A股/港股）：持仓全为美股 ticker（代码含字母，A股/港股均为纯数字）；
  // 无持仓披露时按跟踪指数特征词（纳斯达克/标普/道琼斯等）判定 → 整段不做美股
  const usWord = /纳斯达克|纳指|标普|道琼斯|S&P|NASDAQ|罗素/i;
  const hasHolds = !!(cc && cc.holds.length > 0);
  const cnHk = hasHolds ? cc.holds.filter(h => !/[A-Za-z]/.test(h.code)) : [];
  const usCnt = hasHolds ? cc.holds.length - cnHk.length : 0;
  if (hasHolds ? cnHk.length === 0 : usWord.test(basic.indexName || '')) {
    L.push(`📭 该基金为美股类（${hasIdx ? basic.indexName : basic.fullType}），etfinfo 只做 A股/港股、不做美股`);
    L.push('📌 数据来源：基金定期报告（天天基金）');
    return { ok: true, text: L.join('\n') };
  }
  if (hasIdx) L.push(`🎯 跟踪指数：${basic.indexName}${basic.indexCode && basic.indexCode !== '--' ? `（${basic.indexCode}）` : ''}`);
  else L.push('🎯 跟踪指数：无（非指数型基金）');
  const periodTxt = (cc && cc.period) ? cc.period : '最新披露';
  if (!hasHolds) {
    const t = basic.fullType || '';
    L.push(`📭 ${periodTxt}无股票持仓明细${/货币|债券|商品/.test(t) ? `（${t}一般无股票持仓）` : ''}`);
  } else {
    L.push(`🧾 前十持仓 ${periodTxt}${cc.date ? `（截止 ${cc.date}）` : ''}`);
    const fmtMv = v => v >= 10000 ? (v / 10000).toFixed(2) + '亿' : Math.round(v) + '万'; // mv 万元 → 亿/万
    cnHk.forEach((h, i) => L.push(`${i + 1}. ${h.name}(${h.code}) ${h.pct.toFixed(2)}%  ${fmtMv(h.mv)}`));
    const sum = cnHk.reduce((a, x) => a + x.pct, 0);
    if (usCnt > 0) L.push(`（另有 ${usCnt} 只美股持仓未展示，不计入）\n已展示持仓占比合计 ${sum.toFixed(2)}%`);
    else L.push(`前10合计 ${sum.toFixed(2)}%（集中度）`);
  }
  L.push('📌 数据来源：基金定期报告（天天基金）');
  return { ok: true, text: L.join('\n') };
}

module.exports = { cmdInfo, cmdEtfInfo };
