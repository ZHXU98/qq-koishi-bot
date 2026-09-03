// 创建 QQ 机器人指令面板（/v2/panels）：group 指定群面板
// 运行：docker cp create_panels.mjs official-bot-gateway:/tmp/ && docker exec official-bot-gateway node /tmp/create_panels.mjs
// 凭证从容器环境变量读取。注意：desc 超过 30 字符会报「超出数量限制」30013（误导性错误码），已精简。
const APP_ID = process.env.QQBOT_APP_ID;
const APP_SECRET = process.env.QQBOT_APP_SECRET;
if (!APP_ID || !APP_SECRET) { console.error('❌ 缺少 QQBOT_APP_ID / QQBOT_APP_SECRET'); process.exit(1); }
const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const GROUP_609994072 = '0C8B659CEA602C4165ADAB0CF5D6271C'; // 旭指逆势复亏归零路

const ITEMS = [
  { type: 'command', name: '/ss', desc: '指数行情图' },
  { type: 'command', name: '/stock', desc: 'K线图，日线/分钟/分时' },
  { type: 'command', name: '/zj', desc: '申万行业资金流' },
  { type: 'command', name: '/快讯', desc: '最新重要资讯' },
  { type: 'command', name: '/ping', desc: '存活检测' },
  { type: 'command', name: '/status', desc: '服务状态' },
  { type: 'command', name: '/echo', desc: '复读' },
  { type: 'command', name: '/preview', desc: '磁力链接预览' },
  { type: 'command', name: '/help', desc: '指令菜单' },
];

async function getToken() {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: APP_ID, clientSecret: APP_SECRET }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (!j.access_token) { console.error('❌ token 失败:', JSON.stringify(j).slice(0, 200)); process.exit(1); }
  return j.access_token;
}

(async () => {
  const tk = await getToken();
  const H = { 'Content-Type': 'application/json', 'Authorization': `QQBot ${tk}` };
  console.log('== 创建 group（群聊）指定群面板 ==');
  const r = await fetch(API_BASE + '/v2/panels', { method: 'POST', headers: H, body: JSON.stringify({ scope: 'group', target_type: 'specific', group_openids: [GROUP_609994072], panel: { items: ITEMS, remark: '群聊指令面板（旭指逆势复亏归零路）' } }), signal: AbortSignal.timeout(15000) });
  console.log('  HTTP', r.status, JSON.stringify(await r.json()).slice(0, 150));
  console.log('== 查询验证 ==');
  for (const scope of ['c2c', 'group']) {
    const g = await fetch(API_BASE + '/v2/panels?scope=' + scope + '&limit=50', { headers: { 'Authorization': `QQBot ${tk}` } });
    const j = await g.json();
    const records = j.records || [];
    console.log('[' + scope + '] 面板数:', records.length);
    records.forEach(p => console.log('   -', p.panel_id, 'target:', p.target_type, 'items:', (p.panel?.items || []).map(i => i.name).join(', ')));
  }
})().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
