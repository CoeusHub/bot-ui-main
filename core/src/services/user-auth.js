/**
 * 用户认证服务 - 注册、登录、JWT 与密码加密
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir, getUserDataDir } = require('../config/runtime-paths');
const { readJsonFile, readTextFile, writeTextFileAtomic, writeJsonFileAtomic } = require('./json-db');
const { hashPassword, verifyPassword, checkPasswordStrength } = require('./security');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('user-auth');

const USERS_FILE = 'users.json';
const JWT_SECRET_FILE = '.jwtsecret';

// JWT secret: 从 data/.jwtsecret 读取，或首次自动生成并持久化
let _jwtSecret = null;
function getJWTSecret() {
  if (_jwtSecret) return _jwtSecret;
  ensureDataDir();
  const secretPath = getDataFile(JWT_SECRET_FILE);
  try {
    const existing = readTextFile(secretPath, '');
    if (existing && existing.trim()) {
      _jwtSecret = existing.trim();
      return _jwtSecret;
    }
  } catch (e) { /* ignore */ }

  _jwtSecret = crypto.randomBytes(32).toString('hex');
  try {
    writeTextFileAtomic(secretPath, _jwtSecret);
  } catch (e) {
    logger.warn('无法持久化 JWT secret，运行期间有效', { error: e.message });
  }
  return _jwtSecret;
}

// --- JWT ---

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generateJWT(payload, expiresInSec = 86400) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const bodyB64 = base64url(Buffer.from(JSON.stringify(body)));
  const signature = crypto.createHmac('sha256', getJWTSecret())
    .update(`${headerB64}.${bodyB64}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  return `${headerB64}.${bodyB64}.${signature}`;
}

function verifyJWT(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;

  const [headerB64, bodyB64, sigB64] = parts;
  const expectedSig = crypto.createHmac('sha256', getJWTSecret())
    .update(`${headerB64}.${bodyB64}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  if (sigB64 !== expectedSig) return null;

  try {
    const body = JSON.parse(Buffer.from(bodyB64, 'base64').toString('utf8'));
    if (body.exp && Date.now() / 1000 > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

// --- 用户数据库 ---

function loadUsers() {
  ensureDataDir();
  const data = readJsonFile(getDataFile(USERS_FILE));
  if (!data || !data.users) return { users: {} };
  return data;
}

function saveUsers(data) {
  ensureDataDir();
  writeJsonFileAtomic(getDataFile(USERS_FILE), data);
}

function getUserById(userId) {
  const db = loadUsers();
  return db.users[userId] || null;
}

function getUserByUsername(username) {
  const db = loadUsers();
  const key = String(username || '').toLowerCase();
  for (const [id, u] of Object.entries(db.users)) {
    if (String(u.username || '').toLowerCase() === key) {
      return { ...u, userId: id };
    }
  }
  return null;
}

/**
 * 计算卡密过期时间
 */
function calcExpireAt(type, days) {
  const now = Math.floor(Date.now() / 1000);
  switch (type) {
    case 'day':
      return now + (days || 1) * 86400;
    case 'month':
      return now + (days || 1) * 30 * 86400;
    case 'permanent':
      return 253402300799; // 9999-12-31 23:59:59 UTC
    default:
      return now + 86400;
  }
}

/**
 * 注册新用户
 * @param {{ username: string, password: string, cdkey: string }} params
 * @returns {{ ok: boolean, userId?: string, error?: string }}
 */
async function registerUser({ username, password, cdkey }) {
  // 校验卡密
  const { verifyAndConsumeCDKey } = require('./cdkey');
  const cdkeyResult = verifyAndConsumeCDKey(cdkey);
  if (!cdkeyResult.ok) {
    return { ok: false, error: cdkeyResult.error };
  }

  // 校验用户名
  const name = String(username || '').trim();
  if (!name || name.length < 2 || name.length > 32) {
    return { ok: false, error: '用户名长度需在 2-32 位之间' };
  }
  if (!/^[A-Za-z0-9_\-一-鿿]+$/.test(name)) {
    return { ok: false, error: '用户名只能包含中英文、数字、下划线和连字符' };
  }

  // 检查是否重复
  if (getUserByUsername(name)) {
    return { ok: false, error: '用户名已被注册' };
  }

  // 校验密码强度
  const pw = String(password || '');
  const strength = checkPasswordStrength(pw);
  if (!strength.valid) {
    return { ok: false, error: strength.feedback[0] };
  }

  const passwordHash = await hashPassword(pw);
  const userId = crypto.randomUUID();
  const now = Date.now();

  const db = loadUsers();
  db.users[userId] = {
    userId,
    username: name,
    passwordHash,
    role: 'user',
    expireAt: calcExpireAt(cdkeyResult.type, cdkeyResult.days),
    status: 'active',
    accounts: [],
    createdAt: now,
    updatedAt: now,
  };
  saveUsers(db);

  // 为用户创建数据目录
  const userDir = getUserDataDir(userId);
  try {
    require('node:fs').mkdirSync(userDir, { recursive: true });
  } catch (e) { /* 忽略 */ }

  logger.info('用户注册成功', { userId, username: name });
  return { ok: true, userId };
}

/**
 * 用户登录
 * @param {{ username: string, password: string }} params
 * @returns {{ ok: boolean, token?: string, user?: object, error?: string }}
 */
async function loginUser({ username, password }) {
  const pw = String(password || '');
  if (!pw) {
    return { ok: false, error: '请输入密码' };
  }

  const user = getUserByUsername(username);
  if (!user) {
    return { ok: false, error: '用户名或密码错误' };
  }

  if (user.status === 'frozen') {
    return { ok: false, error: '账号已被冻结，请续期', code: 'ACCOUNT_FROZEN' };
  }
  if (user.status !== 'active') {
    return { ok: false, error: '账号已被禁用' };
  }

  const valid = await verifyPassword(pw, user.passwordHash);
  if (!valid) {
    return { ok: false, error: '用户名或密码错误' };
  }

  // 检查是否已过期 → 自动冻结
  const now = Math.floor(Date.now() / 1000);
  if (user.expireAt && now > user.expireAt) {
    user.status = 'frozen';
    user.updatedAt = Date.now();
    const db = loadUsers();
    db.users[user.userId] = user;
    saveUsers(db);
    logger.info('用户已过期，自动冻结', { userId: user.userId, username: user.username });
    return { ok: false, error: '会员已过期，账号已冻结，请续期', code: 'ACCOUNT_EXPIRED' };
  }

  const token = generateJWT({ userId: user.userId, role: 'user' });

  return {
    ok: true,
    token,
    user: {
      userId: user.userId,
      username: user.username,
      role: user.role,
      expireAt: user.expireAt,
    },
  };
}

/**
 * 检查用户是否过期，过期则自动冻结
 */
function checkAndFreezeExpired(userId) {
  const db = loadUsers();
  const user = db.users[userId];
  if (!user) return { expired: false };

  const now = Math.floor(Date.now() / 1000);
  if (user.expireAt && now > user.expireAt && user.status === 'active') {
    user.status = 'frozen';
    user.updatedAt = Date.now();
    saveUsers(db);
    logger.info('用户已过期，自动冻结', { userId, username: user.username });
    return { expired: true, frozen: true };
  }
  return { expired: now > (user.expireAt || 0) };
}

/**
 * 用户续期：用新卡密延长会员时间
 * @returns {{ ok: boolean, expireAt?: number, error?: string }}
 */
async function renewUser({ username, password, cdkey }) {
  const pw = String(password || '');
  if (!pw) return { ok: false, error: '请输入密码' };

  const user = getUserByUsername(username);
  if (!user) return { ok: false, error: '用户名或密码错误' };

  const valid = await verifyPassword(pw, user.passwordHash);
  if (!valid) return { ok: false, error: '用户名或密码错误' };

  if (user.status !== 'frozen') {
    return { ok: false, error: '账号状态正常，无需续期' };
  }

  // 验证卡密
  const { verifyAndConsumeCDKey, hashKey } = require('./cdkey');
  const cdkeyResult = verifyAndConsumeCDKey(cdkey);
  if (!cdkeyResult.ok) return { ok: false, error: cdkeyResult.error };

  // 计算新的到期时间
  const now = Math.floor(Date.now() / 1000);
  const oldExpireAt = user.expireAt || now;
  // 如果已过期超过 30 天，从当前时间开始加；否则在原到期时间基础上叠加
  const EXPIRED_TOO_LONG = 30 * 86400;
  const baseTime = (now - oldExpireAt > EXPIRED_TOO_LONG) ? now : oldExpireAt;

  let addSeconds = 0;
  switch (cdkeyResult.type) {
    case 'day': addSeconds = (cdkeyResult.days || 1) * 86400; break;
    case 'month': addSeconds = (cdkeyResult.days || 1) * 30 * 86400; break;
    case 'permanent': addSeconds = 253402300799 - baseTime; break;
    default: addSeconds = 86400;
  }

  user.expireAt = baseTime + addSeconds;
  user.status = 'active';
  user.updatedAt = Date.now();

  const db = loadUsers();
  db.users[user.userId] = user;
  saveUsers(db);

  logger.info('用户续期成功', { userId: user.userId, username: user.username, expireAt: user.expireAt });
  return { ok: true, expireAt: user.expireAt };
}

/**
 * 管理员手动延期（不消耗卡密）
 * @returns {{ ok: boolean, expireAt?: number }}
 */
function extendUserExpiry(userId, days) {
  const db = loadUsers();
  const user = db.users[userId];
  if (!user) return { ok: false, error: '用户不存在' };

  const now = Math.floor(Date.now() / 1000);
  const baseTime = (user.expireAt && user.expireAt > now) ? user.expireAt : now;
  user.expireAt = baseTime + days * 86400;
  user.status = 'active';
  user.updatedAt = Date.now();

  db.users[userId] = user;
  saveUsers(db);

  logger.info('管理员手动延期', { userId, days, newExpireAt: user.expireAt });
  return { ok: true, expireAt: user.expireAt };
}

/**
 * 清理僵尸账号：删除过期超 90 天且已冻结的用户
 * @returns {number} 清理数量
 */
function cleanupZombieAccounts() {
  const db = loadUsers();
  const now = Math.floor(Date.now() / 1000);
  const ZOMBIE_DAYS = 90 * 86400;
  const fs = require('node:fs');
  const { getUserDataDir } = require('../config/runtime-paths');

  let cleaned = 0;
  for (const [userId, user] of Object.entries(db.users)) {
    if (user.status !== 'frozen') continue;
    if (!user.expireAt || now - user.expireAt < ZOMBIE_DAYS) continue;

    // 删除用户数据目录
    try {
      const dir = getUserDataDir(userId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    } catch (e) { logger.warn('清理用户目录失败', { userId, error: e.message }); }

    delete db.users[userId];
    cleaned++;
    logger.info('已清理僵尸账号', { userId, username: user.username });
  }

  if (cleaned > 0) {
    saveUsers(db);
  }
  return cleaned;
}

/**
 * 获取用户列表（管理员用）
 */
function getUserList() {
  const fs = require('node:fs');
  const { getUserDataDir } = require('../config/runtime-paths');
  const db = loadUsers();
  return Object.values(db.users).map(u => {
    let accountCount = (u.accounts || []).length;
    // 从用户数据目录读取实际 QQ 号数量
    try {
      const file = getUserDataDir(u.userId) + '/accounts.json';
      if (fs.existsSync(file)) {
        const accData = JSON.parse(fs.readFileSync(file, 'utf8'));
        accountCount = (accData.accounts || []).length;
      }
    } catch { /* 忽略读取错误 */ }
    return {
      userId: u.userId,
      username: u.username,
      role: u.role,
      status: u.status,
      expireAt: u.expireAt,
      accountCount,
      createdAt: u.createdAt,
    };
  });
}

module.exports = {
  generateJWT,
  verifyJWT,
  getJWTSecret,
  loadUsers,
  saveUsers,
  getUserById,
  getUserByUsername,
  registerUser,
  loginUser,
  renewUser,
  extendUserExpiry,
  cleanupZombieAccounts,
  calcExpireAt,
  checkAndFreezeExpired,
  getUserList,
};
