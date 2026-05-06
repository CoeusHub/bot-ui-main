/**
 * 用户 API 控制器 - 注册、登录、个人信息
 * 挂载到主 Express app 上
 */
const { rateLimitMiddleware, recordLoginAttempts, clearLoginAttempts } = require('../services/security');
const { registerUser, loginUser, getUserById } = require('../services/user-auth');
const { getCDKeyStats } = require('../services/cdkey');
const { userAuthRequired } = require('../middleware/user-auth');

/**
 * 将用户 API 路由挂载到 Express app
 * @param {import('express').Express} app
 */
function mountUserAPI(app) {
  // 用户登录限流：每分钟最多 10 次
  const userLoginLimiter = rateLimitMiddleware({
    windowMs: 60000,
    maxRequests: 10,
    keyGenerator: (req) => req.ip,
  });

  // 用户注册限流：每分钟最多 3 次
  const userRegisterLimiter = rateLimitMiddleware({
    windowMs: 60000,
    maxRequests: 3,
    keyGenerator: (req) => req.ip,
  });

  // === 注册 ===
  app.post('/api/user/register', userRegisterLimiter, async (req, res) => {
    try {
      const { username, password, cdkey } = req.body || {};
      const result = await registerUser({ username, password, cdkey });
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }
      res.json({ ok: true, data: { userId: result.userId } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 登录 ===
  app.post('/api/user/login', userLoginLimiter, async (req, res) => {
    try {
      // 登录限流
      try {
        recordLoginAttempts(`user:${req.ip}`);
      } catch (e) {
        return res.status(429).json({ ok: false, error: e.message });
      }

      const { username, password } = req.body || {};
      const result = await loginUser({ username, password });

      if (!result.ok) {
        return res.status(401).json({ ok: false, error: result.error });
      }

      clearLoginAttempts(`user:${req.ip}`);
      res.json({
        ok: true,
        data: {
          token: result.token,
          user: result.user,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // === 获取个人信息 ===
  app.get('/api/user/profile', userAuthRequired, (req, res) => {
    try {
      const user = getUserById(req.user.userId);
      if (!user) {
        return res.status(404).json({ ok: false, error: '用户不存在' });
      }
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

  // === 获取卡密统计（管理员用，暂复用 admin auth） ===
  // 这里不做鉴权，交给 admin 中间件或后续管理员路由处理
  app.get('/api/admin/cdkey-stats', (req, res) => {
    try {
      // 简单的管理员 token 校验已在 admin.js 的中间件中处理
      const stats = getCDKeyStats();
      res.json({ ok: true, data: stats });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mountUserAPI };
