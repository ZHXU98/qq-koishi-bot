// ============================================================
// /preview 磁力链接预览
// ============================================================
const { extractMagnet, fmtSize } = require('../utils');

// 未收录时 name 为空 / type=UNKNOWN。截图仅视频类资源有。
const WHATSLINK_API = 'https://whatslink.info/api/v1/link';

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

module.exports = { cmdPreview };
