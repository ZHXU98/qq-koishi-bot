/**
 * 测试 /t 做T参谋命令
 * 用法（在 reply/ 目录下运行）：
 *   node test_t.js 600519
 *   node test_t.js 600519 -sw
 *   node test_t.js 600519 -tr
 */
process.env.BOT_UIN = '10000';
process.env.NAPCAT_URL = 'http://127.0.0.1:3000';
const path = require('path');
const fs = require('fs');

const {
  cmdT,
  analyzeTDayForm,
  analyzeTTimeData,
  calcTPositions,
  fetchStockKline,
  fetchStockQuote,
} = require('./index.js');

async function run() {
  const args = process.argv.slice(2);
  const codeArg = args.find(a => !a.startsWith('-')) || '600519';
  const mode = args.find(a => a.startsWith('-')) || '';

  console.log(`\n🔍 测试 /t ${codeArg} ${mode}\n`);

  const cmdArgs = [codeArg, mode].filter(Boolean);
  const result = await cmdT(cmdArgs);

  if (!result.ok) {
    console.log('❌ 失败:', result.text);
    return;
  }

  console.log('===== 文字分析 =====');
  console.log(result.text);
  console.log('====================\n');

  if (result.img) {
    const imgData = result.img.replace('base64://', '');
    const outFile = path.join(__dirname, `test_t_${codeArg.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.png`);
    fs.writeFileSync(outFile, Buffer.from(imgData, 'base64'));
    console.log('✅ 图表已保存：', outFile);
  } else {
    console.log('⚠️ 无图表输出（盘后/非交易时段回退到日线）');
  }
}

run().catch(e => console.error('💥 异常:', e.message, '\n', e.stack));
