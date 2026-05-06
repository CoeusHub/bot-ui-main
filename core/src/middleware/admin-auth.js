/**
 * 管理员鉴权中间件 - 校验请求中的 x-admin-token 或 JWT role=admin
 */
const { verifyJWT } = require('../services/user-auth');

function adminRequired(req, res, next) {
  // 先检查 x-admin-token（传统管理员登录）
  const adminToken = req.headers['x-admin-token'] || '';
  if (adminToken) {
    return next(); // admin token 已由 admin.js 的 authRequired 中间件校验
  }

  // 再检查 JWT token（用户但 role 可能是 admin）
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token) {
    const payload = verifyJWT(token);
    if (payload && payload.role === 'admin') {
      req.user = { userId: payload.userId, role: 'admin' };
      return next();
    }
  }

  return res.status(403).json({ ok: false, error: '需要管理员权限' });
}

module.exports = { adminRequired };
