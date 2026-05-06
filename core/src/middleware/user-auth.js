/**
 * 普通用户 JWT 鉴权中间件
 */
const { verifyJWT, checkAndFreezeExpired } = require('../services/user-auth');

/**
 * 必须登录：校验 Bearer token，注入 req.user
 */
function userAuthRequired(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ ok: false, error: '请先登录' });
  }

  const payload = verifyJWT(token);
  if (!payload || !payload.userId) {
    return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
  }

  // 检查用户是否过期
  const { expired } = checkAndFreezeExpired(payload.userId);
  if (expired) {
    return res.status(403).json({ ok: false, error: '会员已过期，请联系管理员续费' });
  }

  req.user = { userId: payload.userId, role: payload.role };
  next();
}

/**
 * 可选登录：有 token 则解析，无则继续（req.user 可能为空）
 */
function userAuthOptional(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (token) {
    const payload = verifyJWT(token);
    if (payload && payload.userId) {
      req.user = { userId: payload.userId, role: payload.role };
    }
  }
  next();
}

module.exports = {
  userAuthRequired,
  userAuthOptional,
};
