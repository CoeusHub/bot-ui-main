/**
 * 用户 API 控制器 - 注册、登录、个人信息、名下QQ号管理
 */
const { getDataFile, ensureDataDir, getUserDataDir, ensureUserDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
const { rateLimitMiddleware, recordLoginAttempts, clearLoginAttempts } = require('../services/security');
const { registerUser, loginUser, getUserById, saveUsers, loadUsers } = require('../services/user-auth');
const { getCDKeyStats, importCDKeyHashes, generateCDKeys } = require('../services/cdkey');
const { userAuthRequired } = require('../middleware/user-auth');
const { fetchProfileByCode } = require('../services/manual-login-profile');

// provider 和 workerControls 引用，由 mount 时注入
let _getProvider = null;
let _getWorkerControls = null;

function getUserAccounts(userId) {
  ensureUserDataDir(userId);
  const file = getUserDataDir(userId) + '/accounts.json';
  return readJsonFile(file, () => ({ accounts: [], nextId: 1 }));
}

function saveUserAccounts(userId, data) {
  ensureUserDataDir(userId);
  const file = getUserDataDir(userId) + '/accounts.json';
  writeJsonFileAtomic(file, data);
}

function mountUserAPI(app, getProvider, getWorkerControls) {
  _getProvider = getProvider || (() => null);
  _getWorkerControls = getWorkerControls || (() => ({}));

  const userLoginLimiter = rateLimitMiddleware({ windowMs: 60000, maxRequests: 30, namespace: 'user_login', keyGenerator: (req) => req.bid || req.ip });
  const userRegisterLimiter = rateLimitMiddleware({ windowMs: 60000, maxRequests: 20, namespace: 'user_register', keyGenerator: (req) => req.bid || req.ip });

  // === 注册 ===
  app.post('/api/user/register', userRegisterLimiter, async (req, res) => {
    try {
      const { username, password, cdkey } = req.body || {};
      const result = await registerUser({ username, password, cdkey });
      if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
      res.json({ ok: true, data: { userId: result.userId } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 登录 ===
  app.post('/api/user/login', userLoginLimiter, async (req, res) => {
    try {
      try {
        recordLoginAttempts(`user:${req.bid || req.ip}`);
      } catch (e) {
        return res.status(429).json({ ok: false, error: e.message });
      }
      const { username, password } = req.body || {};
      const result = await loginUser({ username, password });
      if (!result.ok) {
        return res.status(401).json({ ok: false, error: result.error, code: result.code || '' });
      }
      clearLoginAttempts(`user:${req.bid || req.ip}`);
      res.json({ ok: true, data: { token: result.token, user: result.user } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 续期（使用卡密延长会员） ===
  app.post('/api/user/renew', userRegisterLimiter, async (req, res) => {
    try {
      const { renewUser } = require('../services/user-auth');
      const { username, password, cdkey } = req.body || {};
      const result = await renewUser({ username, password, cdkey });
      if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
      res.json({ ok: true, data: { expireAt: result.expireAt } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 获取个人信息 ===
  app.get('/api/user/profile', userAuthRequired, (req, res) => {
    try {
      const user = getUserById(req.user.userId);
      if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
      res.json({
        ok: true,
        data: {
          userId: user.userId,
          username: user.username,
          role: user.role,
          status: user.status,
          expireAt: user.expireAt,
          accountCount: (user.accounts || []).length,
          createdAt: user.createdAt,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 获取名下QQ号列表 ===
  app.get('/api/user/accounts', userAuthRequired, (req, res) => {
    try {
      const data = getUserAccounts(req.user.userId);
      const controls = _getWorkerControls();
      data.accounts.forEach((a) => {
        a.running = !!(controls.workers && controls.workers[a.id]);
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 添加QQ号 ===
  app.post('/api/user/accounts', userAuthRequired, async (req, res) => {
    try {
      const { name, code, platform } = req.body || {};
      if (!code) return res.status(400).json({ ok: false, error: '请输入 Code' });

      // 可选：尝试通过code获取昵称和头像
      let avatar = '';
      let nick = '';
      try {
        const profile = await fetchProfileByCode(code, platform || 'qq');
        if (profile) {
          nick = profile.name || '';
          if (profile.avatar) avatar = profile.avatar;
          else if (profile.qq) avatar = `https://q1.qlogo.cn/g?b=qq&nk=${profile.qq}&s=640`;
        }
      } catch { /* code可能无效，但不阻止添加 */ }

      const data = getUserAccounts(req.user.userId);
      const id = String(data.nextId++);
      const account = {
        id,
        name: name || nick || `账号${id}`,
        code,
        platform: platform || 'qq',
        gid: '',
        uin: '',
        avatar: avatar || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      data.accounts.push(account);
      saveUserAccounts(req.user.userId, data);

      // 更新 users.json 中的 accounts 引用
      const db = loadUsers();
      if (db.users[req.user.userId]) {
        if (!db.users[req.user.userId].accounts) db.users[req.user.userId].accounts = [];
        db.users[req.user.userId].accounts.push(id);
        saveUsers(db);
      }

      res.json({ ok: true, data: account });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 更新QQ号 ===
  app.put('/api/user/accounts/:id', userAuthRequired, (req, res) => {
    try {
      const data = getUserAccounts(req.user.userId);
      const idx = data.accounts.findIndex(a => a.id === req.params.id);
      if (idx < 0) return res.status(404).json({ ok: false, error: '账号不存在' });

      const { name, code, platform } = req.body || {};
      if (name !== undefined) data.accounts[idx].name = name;
      if (code !== undefined) data.accounts[idx].code = code;
      if (platform !== undefined) data.accounts[idx].platform = platform;
      data.accounts[idx].updatedAt = Date.now();

      saveUserAccounts(req.user.userId, data);
      res.json({ ok: true, data: data.accounts[idx] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 删除QQ号 ===
  app.delete('/api/user/accounts/:id', userAuthRequired, (req, res) => {
    try {
      const data = getUserAccounts(req.user.userId);
      const idx = data.accounts.findIndex(a => a.id === req.params.id);
      if (idx < 0) return res.status(404).json({ ok: false, error: '账号不存在' });

      // 如果正在运行，先停止
      const controls = _getWorkerControls();
      if (controls.stopWorker) {
        try { controls.stopWorker(req.params.id); } catch {}
      }

      data.accounts.splice(idx, 1);
      saveUserAccounts(req.user.userId, data);

      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 启动QQ号 ===
  app.post('/api/user/accounts/:id/start', userAuthRequired, (req, res) => {
    try {
      const data = getUserAccounts(req.user.userId);
      const account = data.accounts.find(a => a.id === req.params.id);
      if (!account) return res.status(404).json({ ok: false, error: '账号不存在' });

      const controls = _getWorkerControls();
      if (!controls.startWorker) {
        return res.status(500).json({ ok: false, error: '系统未就绪' });
      }

      const userDataDir = getUserDataDir(req.user.userId);
      const result = controls.startWorker(account, {
        userId: req.user.userId,
        userDataDir,
      });

      res.json({ ok: result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 停止QQ号 ===
  app.post('/api/user/accounts/:id/stop', userAuthRequired, (req, res) => {
    try {
      const controls = _getWorkerControls();
      if (controls.stopWorker) {
        controls.stopWorker(req.params.id);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 获取用户设置 ===
  app.get('/api/user/settings', userAuthRequired, (req, res) => {
    try {
      const { readJsonFile } = require('../services/json-db');
      const dir = getUserDataDir(req.user.userId);
      const data = readJsonFile(dir + '/store.json', () => ({}));
      // 过滤掉管理员专属字段
      const safe = {
        automation: data.accountConfigs || {},
        intervals: data.intervals || {},
        plantingStrategy: data.plantingStrategy || '',
        preferredSeedId: data.preferredSeedId || 0,
        friendBlockLevel: data.friendBlockLevel || {},
        friendQuietHours: data.friendQuietHours || {},
        ui: data.ui || { theme: 'dark' },
      };
      res.json({ ok: true, data: safe });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 保存用户设置（过滤管理员字段） ===
  app.post('/api/user/settings/save', userAuthRequired, (req, res) => {
    try {
      const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
      const dir = getUserDataDir(req.user.userId);
      ensureUserDataDir(req.user.userId);
      const file = dir + '/store.json';
      const current = readJsonFile(file, () => ({}));

      // 只允许普通用户修改的字段
      const body = req.body || {};
      const allowedKeys = [
        'automation', 'intervals', 'plantingStrategy', 'preferredSeedId',
        'bagSeedPriority', 'friendBlockLevel', 'friendQuietHours', 'ui',
      ];
      for (const key of allowedKeys) {
        if (body[key] !== undefined) {
          current[key] = body[key];
        }
      }

      writeJsonFileAtomic(file, current);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mountUserAPI };
