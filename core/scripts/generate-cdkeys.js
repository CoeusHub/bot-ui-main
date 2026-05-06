/**
 * 卡密批量生成脚本（管理员本地运行）
 *
 * 用法：
 *   node core/scripts/generate-cdkeys.js --type=day --days=30 --count=10
 *   node core/scripts/generate-cdkeys.js --type=month --days=3 --count=5
 *   node core/scripts/generate-cdkeys.js --type=permanent --count=3
 *
 * 输出：
 *   1. 明文卡密列表（分发给用户）
 *   2. 哈希列表 JSON 文件（可导入到服务器 cdkeys.json）
 *
 * 可选 --output=hashes.json 指定输出文件路径
 */

const path = require('node:path');
const fs = require('node:fs');

// 直接加载 cdkey 服务（无需走 runtime-paths）
const crypto = require('node:crypto');

function generateCDKeys(count, type, days) {
  const plaintext = [];
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const randomPart = crypto.randomBytes(8).toString('hex').toUpperCase();
    const key = `FARM-${randomPart}`;
    plaintext.push(key);
    hashes.push({
      hash: crypto.createHash('sha256').update(key).digest('hex'),
      type,
      days: type === 'permanent' ? 0 : (days || 1),
    });
  }
  return { plaintext, hashes };
}

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

const args = parseArgs();
const type = args.type || 'day';
const days = parseInt(args.days || '30', 10);
const count = parseInt(args.count || '10', 10);
const outputFile = args.output || null;

if (!['day', 'month', 'permanent'].includes(type)) {
  console.error('错误: --type 必须是 day, month 或 permanent');
  process.exit(1);
}

if (count < 1 || count > 1000) {
  console.error('错误: --count 必须在 1-1000 之间');
  process.exit(1);
}

const { plaintext, hashes } = generateCDKeys(count, type, days);

const typeLabel =
  type === 'day' ? `${days}天卡` :
  type === 'month' ? `${days}月卡` :
  '永久卡';

console.log('========================================');
console.log(`  卡密生成结果 - ${typeLabel} x ${count}`);
console.log('========================================');
console.log('');
console.log('--- 明文卡密（分发给用户，请妥善保管）---');
console.log('');
for (const key of plaintext) {
  console.log(`  ${key}`);
}
console.log('');
console.log('--- 哈希列表（可导入服务器 cdkeys.json）---');
console.log('');
console.log(JSON.stringify(hashes, null, 2));

if (outputFile) {
  const outPath = path.resolve(outputFile);
  fs.writeFileSync(outPath, JSON.stringify(hashes, null, 2), 'utf8');
  console.log('');
  console.log(`哈希列表已写入: ${outPath}`);
}

// 同时生成纯明文列表文件，方便分发
const plaintextFile = outputFile
  ? path.join(path.dirname(path.resolve(outputFile)), 'cdkeys_plaintext.txt')
  : path.join(process.cwd(), 'cdkeys_plaintext.txt');
fs.writeFileSync(plaintextFile, plaintext.join('\n'), 'utf8');
console.log(`明文列表已写入: ${plaintextFile}`);
