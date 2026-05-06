/**
 * 卡密服务 - 哈希验证与消费
 */
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const CDKEY_FILE = 'cdkeys.json';

function loadCDKeys() {
  ensureDataDir();
  const data = readJsonFile(getDataFile(CDKEY_FILE));
  if (!data || !data.keys) return { keys: {} };
  return data;
}

function saveCDKeys(data) {
  ensureDataDir();
  writeJsonFileAtomic(getDataFile(CDKEY_FILE), data);
}

function hashKey(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext).trim()).digest('hex');
}

/**
 * 验证并消费卡密
 * @param {string} plaintext 明文卡密
 * @returns {{ ok: boolean, type?: string, days?: number, error?: string }}
 */
function verifyAndConsumeCDKey(plaintext) {
  const h = hashKey(plaintext);
  const db = loadCDKeys();
  const entry = db.keys[h];

  if (!entry) {
    return { ok: false, error: '卡密无效' };
  }
  if (entry.used) {
    return { ok: false, error: '卡密已被使用' };
  }
  if (entry.expireAt && Date.now() > entry.expireAt) {
    return { ok: false, error: '卡密已过期' };
  }

  // 标记已使用
  entry.used = true;
  entry.usedAt = Date.now();
  saveCDKeys(db);

  return { ok: true, type: entry.type, days: entry.days };
}

/**
 * 批量导入卡密哈希（管理员上传）
 * @param {Array<{hash: string, type: string, days: number}>} entries
 */
function importCDKeyHashes(entries) {
  const db = loadCDKeys();
  let added = 0;
  for (const e of entries) {
    if (!db.keys[e.hash]) {
      db.keys[e.hash] = {
        type: e.type,
        days: e.days,
        used: false,
        createdAt: Date.now(),
        expireAt: e.expireAt || 0,
      };
      added++;
    }
  }
  if (added > 0) {
    saveCDKeys(db);
  }
  return { added };
}

/**
 * 批量生成卡密（本地脚本使用）
 * @param {number} count 生成数量
 * @param {'day'|'month'|'permanent'} type 卡密类型
 * @param {number} days 天数（永久卡忽略）
 * @returns {{ plaintext: string[], hashes: Array<{hash: string, type: string, days: number}> }}
 */
function generateCDKeys(count, type, days) {
  const plaintext = [];
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const randomPart = crypto.randomBytes(8).toString('hex').toUpperCase();
    const key = `FARM-${randomPart}`;
    plaintext.push(key);
    hashes.push({
      hash: hashKey(key),
      type,
      days: type === 'permanent' ? 0 : days,
    });
  }
  return { plaintext, hashes };
}

function getCDKeyStats() {
  const db = loadCDKeys();
  const entries = Object.values(db.keys);
  return {
    total: entries.length,
    unused: entries.filter(e => !e.used).length,
    used: entries.filter(e => e.used).length,
  };
}

module.exports = {
  loadCDKeys,
  saveCDKeys,
  hashKey,
  verifyAndConsumeCDKey,
  importCDKeyHashes,
  generateCDKeys,
  getCDKeyStats,
};
