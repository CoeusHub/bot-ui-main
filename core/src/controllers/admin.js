const crypto = require('node:crypto');
/**
 * 管理面板 HTTP 服务
 * 改写为接收 DataProvider 模式
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const { version } = require('../../package.json');
const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getResourcePath } = require('../config/runtime-paths');
const store = require('../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef, normalizeAccountRef, resolveAccountId } = require('../services/account-resolver');
const { createModuleLogger } = require('../services/logger');
const { MiniProgramLoginSession } = require('../services/qrlogin');
const { sendPushooMessage } = require('../services/push');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { fetchProfileByCode } = require('../services/manual-login-profile');
const {
    hashPassword: secureHash,
    verifyPassword,
    rateLimitMiddleware,
    recordLoginAttempts,
    clearLoginAttempts
} = require('../services/security');
const { mountUserAPI } = require('./user-api');

const hashPassword = (pwd) => secureHash(pwd); // 兼容旧接口
const adminLogger = createModuleLogger('admin');

let app = null;
let server = null;
let provider = null; // DataProvider
let io = null;

function emitRealtimeStatus(accountId, status) {
    if (!io) return;
    const id = String(accountId || '').trim();
    if (!id) return;
    io.to(`account:${id}`).emit('status:update', { accountId: id, status });
    io.to('account:all').emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();
    if (id) io.to(`account:${id}`).emit('log:new', payload);
    io.to('account:all').emit('log:new', payload);
}

function emitRealtimeAccountLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();
    if (id) io.to(`account:${id}`).emit('account-log:new', payload);
    io.to('account:all').emit('account-log:new', payload);
}

function startAdminServer(dataProvider) {
    if (app) return;
    provider = dataProvider;

    app = express();
    app.use(express.json());

    // 挂载用户 API（注册/登录），不经过 admin 鉴权
    mountUserAPI(app,
        () => provider,
        () => (provider && provider.getWorkerControls ? provider.getWorkerControls() : {}),
    );

    const tokens = new Set();

    const issueToken = () => crypto.randomBytes(24).toString('hex');
    const authRequired = (req, res, next) => {
        // 检查是否禁用了密码认证
        if (store.getDisablePasswordAuth && store.getDisablePasswordAuth()) {
            return next();
        }

        // 先检查 x-admin-token（管理员）
        const adminToken = req.headers['x-admin-token'];
        if (adminToken && tokens.has(adminToken)) {
            req.adminToken = adminToken;
            return next();
        }

        // 再检查 JWT（普通用户）
        const authHeader = req.headers['authorization'] || '';
        const jwtToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (jwtToken) {
            const { verifyJWT, checkAndFreezeExpired } = require('../services/user-auth');
            const payload = verifyJWT(jwtToken);
            if (payload && payload.userId) {
                const { expired } = checkAndFreezeExpired(payload.userId);
                if (!expired) {
                    req.user = { userId: payload.userId, role: payload.role || 'user' };
                    return next();
                }
            }
        }

        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    };

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, Authorization');
        res.header('Access-Control-Allow-Credentials', 'true');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    // 浏览器标识：用 cookie 而非 IP 做速率限制的 key
    app.use((req, res, next) => {
        const raw = (req.headers.cookie || '');
        const match = raw.match(/(?:^|;\s*)bid=([^;]*)/);
        let bid = match ? match[1] : '';
        if (!bid) {
            bid = crypto.randomBytes(12).toString('hex');
            res.setHeader('Set-Cookie', `bid=${bid}; Path=/; SameSite=Lax; Max-Age=86400`);
        }
        req.bid = bid;
        next();
    });

    // 速率限制中间件（按浏览器标识）
    app.use('/api', rateLimitMiddleware({
        windowMs: 60000,  // 1分钟
        maxRequests: 100, // 最多100次
        namespace: 'global_api',
        keyGenerator: (req) => req.bid || req.ip,
    }));

    // 访问根路径 → 默认跳转用户登录页
    app.get('/', (req, res) => {
        res.redirect(302, '/user/login');
    });

    const webDist = path.join(__dirname, '../../../web/dist');
    if (fs.existsSync(webDist)) {
        // index.html 禁止缓存，确保浏览器始终加载最新版本
        app.use(express.static(webDist, {
            setHeaders(res, filePath) {
                if (filePath.endsWith('index.html')) {
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                } else {
                    // 带 hash 的资源文件可以长期缓存
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        }));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (req, res) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // 登录与鉴权
    app.post('/api/login', async (req, res) => {
        const { password } = req.body || {};
        
        // 记录登录尝试
        try {
            recordLoginAttempts(req.bid || req.ip);
        } catch (error) {
            return res.status(429).json({ ok: false, error: error.message });
        }
        
        const input = String(password || '');
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        let ok = false;
        
        if (storedHash) {
            // 优先使用安全验证 (支持PBKDF2和SHA256)
            ok = await verifyPassword(input, storedHash);
        } else {
            // 兼容旧配置
            ok = input === String(CONFIG.adminPassword || '');
        }
        
        if (!ok) {
            return res.status(401).json({ ok: false, error: 'Invalid password' });
        }
        
        // 登录成功
        clearLoginAttempts(req.bid || req.ip);
        const token = issueToken();
        tokens.add(token);
        res.json({ ok: true, data: { token } });
    });

    app.use('/api', (req, res, next) => {
        // Express app.use 下 req.path 是完整路径（含 /api 前缀），需要去掉前缀比较
        const p = req.path.replace(/^\/api/, '') || '/';
        if (p === '/login' || p === '/qr/create' || p === '/qr/check' || p === '/auth/validate' || p === '/admin/password-auth-status') return next();
        if (p.startsWith('/user/')) return next();
        if (p === '/announcement') return next();
        return authRequired(req, res, next);
    });

    app.post('/api/admin/change-password', async (req, res) => {
        const body = req.body || {};
        const oldPassword = String(body.oldPassword || '');
        const newPassword = String(body.newPassword || '');
        if (newPassword.length < 4) {
            return res.status(400).json({ ok: false, error: '新密码长度至少为 4 位' });
        }
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        const ok = storedHash
            ? await verifyPassword(oldPassword, storedHash)
            : oldPassword === String(CONFIG.adminPassword || '');
        if (!ok) {
            return res.status(400).json({ ok: false, error: '原密码错误' });
        }
        const nextHash = await hashPassword(newPassword);
        if (store.setAdminPasswordHash) {
            store.setAdminPasswordHash(nextHash);
        }
        res.json({ ok: true });
    });

    // API: 获取密码认证状态
    app.get('/api/admin/password-auth-status', (req, res) => {
        try {
            const disabled = store.getDisablePasswordAuth ? store.getDisablePasswordAuth() : false;
            res.json({ ok: true, data: { disabled } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置密码认证状态
    app.post('/api/admin/toggle-password-auth', async (req, res) => {
        try {
            const body = req.body || {};
            const disabled = Boolean(body.disabled);
            
            if (store.setDisablePasswordAuth) {
                store.setDisablePasswordAuth(disabled);
            }
            res.json({ ok: true, data: { disabled } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/ping', (req, res) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/auth/validate', (req, res) => {
        // 如果禁用了密码认证，直接返回有效
        if (store.getDisablePasswordAuth && store.getDisablePasswordAuth()) {
            return res.json({ ok: true, data: { valid: true, passwordDisabled: true } });
        }
        
        const token = String(req.headers['x-admin-token'] || '').trim();
        const valid = !!token && tokens.has(token);
        if (!valid) {
            return res.status(401).json({ ok: false, data: { valid: false }, error: 'Unauthorized' });
        }
        res.json({ ok: true, data: { valid: true, passwordDisabled: false } });
    });

    // API: 调度任务快照（用于调度收敛排查）
    app.get('/api/scheduler', async (req, res) => {
        try {
            const id = getAccId(req);
            if (provider && typeof provider.getSchedulerStatus === 'function') {
                const data = await provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({ ok: true, data: { runtime: getSchedulerRegistrySnapshot(), worker: null, workerError: 'DataProvider does not support scheduler status' } });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req, res) => {
        const token = req.adminToken;
        if (token) {
            tokens.delete(token);
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
        }
        res.json({ ok: true });
    });

    const getAccountList = () => {
        try {
            if (provider && typeof provider.getAccounts === 'function') {
                const data = provider.getAccounts();
                if (data && Array.isArray(data.accounts)) return data.accounts;
            }
        } catch {
            // ignore provider failures
        }
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        return Array.isArray(data.accounts) ? data.accounts : [];
    };

    const isSoftRuntimeError = (err) => {
        const msg = String((err && err.message) || '');
        return msg === '账号未运行' || msg === 'API Timeout';
    };

    function handleApiError(res, err) {
        if (isSoftRuntimeError(err)) {
            return res.json({ ok: false, error: err.message });
        }
        return res.status(500).json({ ok: false, error: err.message });
    }

    const resolveAccId = (rawRef) => {
        const input = normalizeAccountRef(rawRef);
        if (!input) return '';

        if (provider && typeof provider.resolveAccountId === 'function') {
            const resolvedByProvider = normalizeAccountRef(provider.resolveAccountId(input));
            if (resolvedByProvider) return resolvedByProvider;
        }

        const resolved = resolveAccountId(getAccountList(), input);
        return resolved || input;
    };

    // Helper to get account ID from header
    function getAccId(req) {
        return resolveAccId(req.headers['x-account-id']);
    }

    // API: 完整状态
    app.get('/api/status', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/automation', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农田详情
    app.get('/api/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友列表
    app.get('/api/friends', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getFriends(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友农田详情
    app.get('/api/interact-records', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.get('/api/friend/:gid/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const opType = String((req.body || {}).opType || '');
            const data = await provider.doFriendOp(id, req.params.gid, opType);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            if (provider && typeof provider.getFriendBlacklist === 'function') {
                const list = await provider.getFriendBlacklist(id);
                return res.json({ ok: true, data: Array.isArray(list) ? list : [] });
            }
            const list = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
            return res.json({ ok: true, data: Array.isArray(list) ? list : [] });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-blacklist/toggle', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gid = Number((req.body || {}).gid);
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });
        const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        let next;
        if (current.includes(gid)) {
            next = current.filter(g => g !== gid);
        } else {
            next = [...current, gid];
        }
        const saved = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;
        // 同步配置到 worker 进程
        if (provider && typeof provider.broadcastConfig === 'function') {
            provider.broadcastConfig(id);
        }
        res.json({ ok: true, data: saved });
    });

    // API: 好友缓存
    app.get('/api/friend-cache', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const list = store.getFriendCache ? store.getFriendCache(id) : [];
            return res.json({ ok: true, data: Array.isArray(list) ? list : [] });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-cache/update-from-visitors', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const friends = await provider.extractFriendsFromInteractRecords(id);
            if (!Array.isArray(friends) || friends.length === 0) {
                return res.json({ ok: true, data: store.getFriendCache ? store.getFriendCache(id) : [], message: '没有找到新的访客记录' });
            }
            const saved = store.updateFriendCache ? store.updateFriendCache(id, friends) : friends;
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: saved, message: '更新成功' });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-cache/import-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const input = req.body.gids;
            let gids = [];
            if (typeof input === 'string') {
                gids = input.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
            } else if (Array.isArray(input)) {
                gids = input;
            }
            const validGids = gids
                .map(g => Number(g))
                .filter(g => Number.isFinite(g) && g > 0);
            if (validGids.length === 0) {
                return res.json({ ok: false, error: '没有有效的 GID' });
            }
            const friends = validGids.map(gid => ({
                gid,
                nick: `GID:${gid}`,
                avatarUrl: '',
            }));
            const saved = store.updateFriendCache ? store.updateFriendCache(id, friends) : friends;
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: saved, message: `已导入 ${validGids.length} 个 GID` });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.delete('/api/friend-cache/:gid', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gid = Number(req.params.gid);
        if (!gid || !Number.isFinite(gid)) {
            return res.status(400).json({ ok: false, error: '无效的 GID' });
        }
        try {
            const current = store.getFriendCache ? store.getFriendCache(id) : [];
            const next = current.filter(f => f.gid !== gid);
            const saved = store.setFriendCache ? store.setFriendCache(id, next) : next;
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: saved, message: `已删除 GID:${gid}` });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // API: 种子列表
    app.get('/api/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 背包物品
    app.get('/api/bag', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 背包种子列表
    app.get('/api/bag/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getBagSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 启动账号
    app.post('/api/accounts/:id/start', (req, res) => {
        try {
            // JWT 用户：启动自己目录下的 QQ 号
            if (req.user && req.user.role === 'user') {
                const data = getUserAccountData(req.user.userId).read();
                const acc = data.accounts.find(a => a.id === req.params.id);
                if (!acc) return res.status(404).json({ ok: false, error: '账号不存在' });
                const wc = provider.getWorkerControls ? provider.getWorkerControls() : {};
                if (!wc.startWorker) return res.status(500).json({ ok: false, error: '系统未就绪' });
                const { getUserDataDir } = require('../config/runtime-paths');
                const ok = wc.startWorker(acc, { userId: req.user.userId, userDataDir: getUserDataDir(req.user.userId) });
                return res.json({ ok });
            }

            const ok = provider.startAccount(resolveAccId(req.params.id));
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 停止账号
    app.post('/api/accounts/:id/stop', (req, res) => {
        try {
            // JWT 用户
            if (req.user && req.user.role === 'user') {
                const wc = provider.getWorkerControls ? provider.getWorkerControls() : {};
                if (wc.stopWorker) { try { wc.stopWorker(req.params.id); } catch {} }
                return res.json({ ok: true });
            }

            const ok = provider.stopAccount(resolveAccId(req.params.id));
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农场一键操作
    app.post('/api/farm/operate', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const { opType } = req.body; // 'harvest', 'clear', 'plant', 'all'
            await provider.doFarmOp(id, opType);
            res.json({ ok: true });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.post('/api/farm/land/operate', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const action = String(body.action || '').trim().toLowerCase();
            const landId = Number(body.landId);
            const seedId = Number(body.seedId);

            if (!action) {
                return res.status(400).json({ ok: false, error: 'Missing action' });
            }
            if (!Number.isFinite(landId) || landId <= 0) {
                return res.status(400).json({ ok: false, error: 'Invalid landId' });
            }
            if (action === 'plant' && (!Number.isFinite(seedId) || seedId <= 0)) {
                return res.status(400).json({ ok: false, error: 'Invalid seedId' });
            }

            const data = await provider.doSingleLandOp(id, {
                action,
                landId,
                seedId: Number.isFinite(seedId) ? seedId : 0,
            });
            return res.json({ ok: true, data: data || {} });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // API: 数据分析
    app.get('/api/analytics', async (req, res) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置页统一保存（单次写入+单次广播）
    app.post('/api/settings/save', async (req, res) => {
        // JWT 用户：写入个人目录
        if (req.user && req.user.role === 'user') {
            try {
                const { ensureUserDataDir, getUserDataDir } = require('../config/runtime-paths');
                const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
                const dir = getUserDataDir(req.user.userId);
                ensureUserDataDir(req.user.userId);
                const file = dir + '/store.json';
                const current = readJsonFile(file, () => ({}));
                const body = req.body || {};
                const allowedKeys = ['automation', 'intervals', 'plantingStrategy', 'preferredSeedId', 'bagSeedPriority', 'friendBlockLevel', 'friendQuietHours', 'ui'];
                for (const key of allowedKeys) {
                    if (body[key] !== undefined) current[key] = body[key];
                }
                writeJsonFileAtomic(file, current);
                return res.json({ ok: true });
            } catch (e) {
                return res.status(500).json({ ok: false, error: e.message });
            }
        }

        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            const data = await provider.saveSettings(id, req.body || {});
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 公告（公开读取）
    app.get('/api/announcement', (req, res) => {
        try {
            const content = store.getAnnouncement ? store.getAnnouncement() : '';
            res.json({ ok: true, data: { content } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存公告（仅管理员）
    app.post('/api/admin/announcement', (req, res) => {
        try {
            const { content } = req.body || {};
            const result = store.setAnnouncement ? store.setAnnouncement(String(content || '')) : '';
            res.json({ ok: true, data: { content: result } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req, res) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存二维码登录接口配置
    app.post('/api/settings/qr-login', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const data = store.setQrLoginConfig ? store.setQrLoginConfig(body) : { apiDomain: 'q.qq.com' };
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 保存运行时连接/设备配置
    app.post('/api/settings/runtime-client', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (provider && typeof provider.setRuntimeClientConfig === 'function') {
                const data = await provider.setRuntimeClientConfig(body);
                return res.json({ ok: true, data: data || {} });
            }
            const saved = store.setRuntimeClientConfig ? store.setRuntimeClientConfig(body) : null;
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig('');
            }
            return res.json({ ok: true, data: { runtimeClient: saved } });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req, res) => {
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder() : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();
            const custom_headers = String(cfg.custom_headers || '').trim();
            const custom_body = String(cfg.custom_body || '').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if ((channel === 'webhook' || channel === 'custom_request') && !endpoint) {
                return res.status(400).json({ ok: false, error: '接口地址不能为空' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
                custom_headers,
                custom_body,
            });

            if (!ret || !ret.ok) {
                return res.status(400).json({ ok: false, error: (ret && ret.msg) || '推送失败', data: ret || {} });
            }
            return res.json({ ok: true, data: ret });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req, res) => {
        try {
            // JWT 用户：从个人目录读取，填充默认值
            if (req.user && req.user.role === 'user') {
                const { getUserDataDir } = require('../config/runtime-paths');
                const { readJsonFile } = require('../services/json-db');
                const file = getUserDataDir(req.user.userId) + '/store.json';
                const data = readJsonFile(file, () => ({}));

                // 默认自动化配置（与 store.js DEFAULT_ACCOUNT_CONFIG 同步）
                const defaultAutomation = {
                    farm: true, farm_manage: true, farm_water: true, farm_weed: true, farm_bug: true,
                    farm_push: true, land_upgrade: true, friend: true, friend_help_exp_limit: true,
                    friend_steal: true, friend_steal_blacklist: [], friend_help: true, friend_bad: false,
                    task: true, email: true, fertilizer_gift: false, fertilizer_buy: false,
                    fertilizer_buy_type: 'organic', fertilizer_buy_max: 10, fertilizer_buy_mode: 'threshold',
                    fertilizer_buy_threshold: 100, free_gifts: true, share_reward: true,
                    vip_gift: true, month_card: true, open_server_gift: true, fertilizer: 'none',
                    fertilizer_strategy: 'longest', fertilizer_multi_season: false,
                    fertilizer_land_types: ['gold', 'black', 'red', 'normal'],
                };
                const defaultIntervals = { farmMin: 5, farmMax: 10, friendMin: 10, friendMax: 20 };
                const defaultBlockLevel = { enabled: true, Level: 1 };
                const defaultQuietHours = { enabled: false, start: '23:00', end: '07:00' };

                return res.json({ ok: true, data: {
                    intervals: data.intervals || defaultIntervals,
                    strategy: data.plantingStrategy || 'level',
                    preferredSeed: data.preferredSeedId || 0,
                    bagSeedPriority: data.bagSeedPriority || [],
                    friendBlockLevel: data.friendBlockLevel || defaultBlockLevel,
                    friendQuietHours: data.friendQuietHours || defaultQuietHours,
                    automation: data.automation || defaultAutomation,
                    ui: data.ui || { theme: 'dark' },
                    offlineReminder: {},
                    qrLogin: { apiDomain: 'q.qq.com' },
                    runtimeClient: null,
                }});
            }

            const id = getAccId(req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = store.getIntervals(id);
            const strategy = store.getPlantingStrategy(id);
            const preferredSeed = store.getPreferredSeed(id);
            const bagSeedPriority = store.getBagSeedPriority(id);
            const friendBlockLevel = store.getFriendBlockLevel(id);
            const friendQuietHours = store.getFriendQuietHours(id);
            const automation = store.getAutomation(id);
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', reloginUrlMode: 'none', endpoint: '', token: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 1, offlineDeleteEnabled: false, custom_headers: '', custom_body: '' };
            const qrLogin = store.getQrLoginConfig
                ? store.getQrLoginConfig()
                : { apiDomain: 'q.qq.com' };
            const runtimeClient = store.getRuntimeClientConfig
                ? store.getRuntimeClientConfig()
                : null;
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, bagSeedPriority, friendBlockLevel, friendQuietHours, automation, ui, offlineReminder, qrLogin, runtimeClient } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 用户数据隔离：JWT 用户从自己的目录读写
    function getUserAccountData(userId) {
        const { getUserDataDir, ensureUserDataDir } = require('../config/runtime-paths');
        const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
        ensureUserDataDir(userId);
        const file = getUserDataDir(userId) + '/accounts.json';
        return {
            read: () => readJsonFile(file, () => ({ accounts: [], nextId: 1 })),
            write: (data) => writeJsonFileAtomic(file, data),
        };
    }

    // API: 账号管理
    app.get('/api/accounts', (req, res) => {
        try {
            // JWT 用户：从个人目录读取
            if (req.user && req.user.role === 'user') {
                const data = getUserAccountData(req.user.userId).read();
                res.json({ ok: true, data });
                return;
            }
            const data = provider.getAccounts();
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req, res) => {
        try {
            // JWT 用户：写入个人目录
            if (req.user && req.user.role === 'user') {
                const data = getUserAccountData(req.user.userId);
                const current = data.read();
                const body = req.body || {};
                const ref = body.id || body.accountId || body.uin;
                const idx = current.accounts.findIndex(a => a.id === String(ref));
                if (idx >= 0 && body.remark) {
                    current.accounts[idx].name = String(body.remark).trim();
                    current.accounts[idx].updatedAt = Date.now();
                }
                data.write(current);
                return res.json({ ok: true, data: current });
            }

            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList();
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (provider && typeof provider.setRuntimeAccountName === 'function') {
                provider.setRuntimeAccountName(accountId, remark);
            }
            if (provider && provider.addAccountLog) {
                provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            // JWT 用户：写入个人目录
            if (req.user && req.user.role === 'user') {
                const data = getUserAccountData(req.user.userId);
                const current = data.read();
                const body = req.body || {};
                const isUpdate = !!body.id;
                if (isUpdate) {
                    const idx = current.accounts.findIndex(a => a.id === String(body.id));
                    if (idx >= 0) {
                        if (body.name !== undefined) current.accounts[idx].name = body.name;
                        if (body.code !== undefined) current.accounts[idx].code = body.code;
                        current.accounts[idx].updatedAt = Date.now();
                    }
                } else {
                    const id = String(current.nextId++);
                    current.accounts.push({
                        id, name: body.name || `账号${id}`, code: body.code || '',
                        platform: body.platform || 'qq', gid: '', uin: '', avatar: '',
                        createdAt: Date.now(), updatedAt: Date.now(),
                    });
                }
                data.write(current);
                return res.json({ ok: true, data: current });
            }

            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const isUpdate = !!body.id;
            const resolvedUpdateId = isUpdate ? resolveAccId(body.id) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(body.id) } : { ...body };
            let wasRunning = false;
            let oldAccount = null;
            if (isUpdate && provider.isAccountRunning) {
                wasRunning = provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = provider.getAccounts();
                oldAccount = oldAccounts.accounts.find(a => a.id === payload.id) || null;
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            const incomingCode = String(payload.code || '').trim();
            const manualPlatform = String(payload.platform || (oldAccount && oldAccount.platform) || 'qq').trim().toLowerCase();
            if (incomingCode && manualPlatform === 'qq') {
                try {
                    const basicProfile = await fetchProfileByCode(incomingCode, {
                        platform: manualPlatform,
                    });

                    if (basicProfile.avatar) {
                        payload.avatar = basicProfile.avatar;
                        payload.avatarUrl = basicProfile.avatar;
                    }
                    if (basicProfile.gid > 0 && !String(payload.gid || '').trim()) {
                        payload.gid = String(basicProfile.gid);
                    }
                    if (basicProfile.openId && !String(payload.openId || '').trim()) {
                        payload.openId = basicProfile.openId;
                    }

                    const incomingName = String(payload.name || '').trim();
                    if (!incomingName && basicProfile.name) {
                        payload.name = basicProfile.name;
                    }
                } catch (error) {
                    adminLogger.warn('fetch manual account profile failed', {
                        error: error.message,
                        accountId: payload.id || '',
                    });
                }
            }

            const data = addOrUpdateAccount(payload);
            if (provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts[data.accounts.length - 1] || {}).id || '');
                const accountName = payload.name || '';
                provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts[data.accounts.length - 1];
                if (newAcc) provider.startAccount(newAcc.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/accounts/:id', (req, res) => {
        try {
            // JWT 用户：从个人目录删除
            if (req.user && req.user.role === 'user') {
                const data = getUserAccountData(req.user.userId);
                const current = data.read();
                const idx = current.accounts.findIndex(a => a.id === req.params.id);
                if (idx >= 0) current.accounts.splice(idx, 1);
                data.write(current);
                return res.json({ ok: true, data: current });
            }

            const resolvedId = resolveAccId(req.params.id) || String(req.params.id || '');
            const before = provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (provider.addAccountLog) {
                provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req, res) => {
        try {
            const limit = Number.parseInt(req.query.limit) || 100;
            const list = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
            // 与当前 web 前端保持一致：直接返回数组
            res.json(Array.isArray(list) ? list : []);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 日志
    app.get('/api/logs', (req, res) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(queryAccountIdRaw)) : getAccId(req);
        const options = {
            limit: Number.parseInt(req.query.limit) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = provider.clearLogs(id);

            if (io && provider && typeof provider.getLogs === 'function') {
                const accountLogs = provider.getLogs(id, { limit: 100 });
                io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = provider.getLogs('', { limit: 100 });
                io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // ============ 管理员：用户管理 ============
    app.get('/api/admin/users', (req, res) => {
        try {
            const { getUserList } = require('../services/user-auth');
            const list = getUserList();
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/users/:userId/status', (req, res) => {
        try {
            const { loadUsers, saveUsers } = require('../services/user-auth');
            const { userId } = req.params;
            const { status } = req.body || {};
            const db = loadUsers();
            const user = db.users[userId];
            if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
            if (status) user.status = status;
            user.updatedAt = Date.now();
            saveUsers(db);
            res.json({ ok: true, data: { userId, status: user.status } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 管理员手动延期（不消耗卡密）
    app.post('/api/admin/users/:userId/extend', (req, res) => {
        try {
            const { extendUserExpiry } = require('../services/user-auth');
            const { userId } = req.params;
            const days = Math.max(1, Number(req.body.days) || 30);
            const result = extendUserExpiry(userId, days);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true, data: { userId, days, expireAt: result.expireAt } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员：操作用户 QQ 账号 ============
    app.get('/api/admin/users/:userId/accounts', (req, res) => {
        try {
            const { getUserDataDir } = require('../config/runtime-paths');
            const { readJsonFile } = require('../services/json-db');
            const { userId } = req.params;
            const file = getUserDataDir(userId) + '/accounts.json';
            const data = readJsonFile(file, () => ({ accounts: [], nextId: 1 }));
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/users/:userId/accounts', async (req, res) => {
        try {
            const { getUserDataDir, ensureUserDataDir } = require('../config/runtime-paths');
            const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
            const { fetchProfileByCode } = require('../services/manual-login-profile');
            const { userId } = req.params;
            const { code, platform, name } = req.body || {};

            if (!code) return res.status(400).json({ ok: false, error: '请输入 Code' });

            const dir = getUserDataDir(userId);
            ensureUserDataDir(userId);
            const file = dir + '/accounts.json';
            const data = readJsonFile(file, () => ({ accounts: [], nextId: 1 }));

            // 尝试通过 code 获取昵称头像
            let avatar = '';
            let nick = '';
            try {
                const profile = await fetchProfileByCode(code, platform || 'qq');
                if (profile) {
                    nick = profile.name || '';
                    if (profile.qq) avatar = `https://q1.qlogo.cn/g?b=qq&nk=${profile.qq}&s=640`;
                }
            } catch { /* code 可能无效 */ }

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
            writeJsonFileAtomic(file, data);

            if (provider && provider.addAccountLog) provider.addAccountLog('admin_add_account', `管理员为用户 ${userId} 添加QQ号`, '', '', { userId, accountId: id });
            res.json({ ok: true, data: account });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.put('/api/admin/users/:userId/accounts/:accountId', (req, res) => {
        try {
            const { getUserDataDir } = require('../config/runtime-paths');
            const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
            const { userId, accountId } = req.params;
            const { code, name } = req.body || {};

            const file = getUserDataDir(userId) + '/accounts.json';
            const data = readJsonFile(file, () => ({ accounts: [], nextId: 1 }));
            const idx = data.accounts.findIndex(a => a.id === accountId);
            if (idx < 0) return res.status(404).json({ ok: false, error: '账号不存在' });

            if (code !== undefined) data.accounts[idx].code = code;
            if (name !== undefined) data.accounts[idx].name = name;
            data.accounts[idx].updatedAt = Date.now();
            writeJsonFileAtomic(file, data);

            res.json({ ok: true, data: data.accounts[idx] });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/admin/users/:userId/accounts/:accountId', (req, res) => {
        try {
            const { getUserDataDir } = require('../config/runtime-paths');
            const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
            const { userId, accountId } = req.params;

            const file = getUserDataDir(userId) + '/accounts.json';
            const data = readJsonFile(file, () => ({ accounts: [], nextId: 1 }));
            const idx = data.accounts.findIndex(a => a.id === accountId);
            if (idx < 0) return res.status(404).json({ ok: false, error: '账号不存在' });

            data.accounts.splice(idx, 1);
            writeJsonFileAtomic(file, data);

            if (provider && provider.addAccountLog) provider.addAccountLog('admin_delete_account', `管理员删除用户 ${userId} 的QQ号`, '', '', { userId, accountId });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员：卡密管理 ============
    app.get('/api/admin/cdkey-stats', (req, res) => {
        try {
            const { getCDKeyStats } = require('../services/cdkey');
            res.json({ ok: true, data: getCDKeyStats() });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/cdkeys/import', (req, res) => {
        try {
            const { importCDKeyHashes } = require('../services/cdkey');
            const { hashes } = req.body || {};
            if (!Array.isArray(hashes) || hashes.length === 0) {
                return res.status(400).json({ ok: false, error: '请提供卡密哈希列表' });
            }
            const result = importCDKeyHashes(hashes);
            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/cdkeys/generate', (req, res) => {
        try {
            const { generateCDKeys, importCDKeyHashes } = require('../services/cdkey');
            const { type, days, count } = req.body || {};
            const n = Math.min(Math.max(1, Number(count) || 1), 100);
            const t = ['day', 'month', 'permanent'].includes(type) ? type : 'day';
            const d = t === 'permanent' ? 0 : Math.max(1, Number(days) || 30);

            const { plaintext, hashes } = generateCDKeys(n, t, d);
            importCDKeyHashes(hashes);

            res.json({
                ok: true,
                data: { plaintext, type: t, days: d, count: n },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员：统一下发策略 ============
    app.post('/api/admin/policies', (req, res) => {
        try {
            const { loadUsers, saveUsers } = require('../services/user-auth');
            const { ensureUserDataDir, getUserDataDir } = require('../config/runtime-paths');
            const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
            const body = req.body || {};
            const userIds = body.userIds || [];
            const policyConfig = body.policyConfig || {};

            if (!Array.isArray(userIds) || userIds.length === 0) {
                return res.status(400).json({ ok: false, error: '请选择至少一个用户' });
            }

            let applied = 0;
            const db = loadUsers();

            for (const userId of userIds) {
                const user = db.users[userId];
                if (!user) continue;

                const dir = getUserDataDir(userId);
                ensureUserDataDir(userId);
                const file = dir + '/store.json';
                const current = readJsonFile(file, () => ({}));

                // 更新默认配置（新账号用）
                current.defaultAccountConfig = current.defaultAccountConfig || {};
                if (policyConfig.automation) {
                    current.defaultAccountConfig.automation = {
                        ...(current.defaultAccountConfig.automation || {}),
                        ...policyConfig.automation,
                    };
                }
                if (policyConfig.intervals) {
                    current.defaultAccountConfig.intervals = {
                        ...(current.defaultAccountConfig.intervals || {}),
                        ...policyConfig.intervals,
                    };
                }
                // 更新全局设置
                if (policyConfig.plantingStrategy) {
                    current.plantingStrategy = policyConfig.plantingStrategy;
                }
                if (policyConfig.preferredSeedId) {
                    current.preferredSeedId = policyConfig.preferredSeedId;
                }
                if (policyConfig.friendBlockLevel) {
                    current.friendBlockLevel = policyConfig.friendBlockLevel;
                }
                if (policyConfig.friendQuietHours) {
                    current.friendQuietHours = policyConfig.friendQuietHours;
                }

                // 同步到所有已有账号的配置（Worker 读的是 accountConfigs[id]）
                const accCfgMap = current.accountConfigs || {};
                if (typeof accCfgMap === 'object' && Object.keys(accCfgMap).length > 0) {
                    for (const [accId, accCfg] of Object.entries(accCfgMap)) {
                        if (policyConfig.intervals && accCfg && typeof accCfg === 'object') {
                            accCfg.intervals = {
                                ...(accCfg.intervals || {}),
                                ...policyConfig.intervals,
                            };
                        }
                        if (policyConfig.automation && accCfg && typeof accCfg === 'object') {
                            accCfg.automation = {
                                ...(accCfg.automation || {}),
                                ...policyConfig.automation,
                            };
                        }
                    }
                    current.accountConfigs = accCfgMap;
                }

                current._adminPolicyAppliedAt = Date.now();
                writeJsonFileAtomic(file, current);
                applied++;
            }

            // 广播到所有运行中的 Worker，让已启动的立即生效
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig('');
            }

            res.json({ ok: true, data: { applied, total: userIds.length } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员：所有用户账号总览 ============
    app.get('/api/admin/all-accounts', (req, res) => {
        try {
            const fs = require('node:fs');
            const { getUserDataDir } = require('../config/runtime-paths');
            const { readJsonFile } = require('../services/json-db');
            const { loadUsers } = require('../services/user-auth');

            const db = loadUsers();
            const result = [];

            for (const [userId, user] of Object.entries(db.users)) {
                const file = getUserDataDir(userId) + '/accounts.json';
                const accData = readJsonFile(file, () => ({ accounts: [] }));
                const accounts = (accData.accounts || []).map(a => ({
                    ...a,
                    ownerName: user.username,
                    ownerId: userId,
                }));
                result.push(...accounts);
            }

            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员：在线状态 ============
    app.get('/api/admin/online-workers', (req, res) => {
        try {
            const list = [];
            if (provider && provider.getWorkerControls) {
                const { workers } = provider.getWorkerControls();
                for (const [id, w] of Object.entries(workers || {})) {
                    list.push({
                        accountId: id,
                        name: w.name || '',
                        userId: w.userId || '',
                        connected: !!(w.status && w.status.connection && w.status.connection.connected),
                    });
                }
            }
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ QR Code Login APIs (无需账号选择) ============
    // 这些接口不需要 authRequired 也能调用（用于登录流程）
    app.post('/api/qr/create', async (req, res) => {
        try {
            const qrLogin = store.getQrLoginConfig ? store.getQrLoginConfig() : { apiDomain: 'q.qq.com' };
            const result = await MiniProgramLoginSession.requestLoginCode({ apiDomain: qrLogin.apiDomain });
            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/qr/check', async (req, res) => {
        const { code } = req.body || {};
        if (!code) {
            return res.status(400).json({ ok: false, error: 'Missing code' });
        }

        try {
            const qrLogin = store.getQrLoginConfig ? store.getQrLoginConfig() : { apiDomain: 'q.qq.com' };
            const result = await MiniProgramLoginSession.queryStatus(code, { apiDomain: qrLogin.apiDomain });

            if (result.status === 'OK') {
                const ticket = result.ticket;
                const uin = result.uin || '';
                const nickname = result.nickname || ''; // 获取昵称
                const appid = '1112386029'; // Farm appid

                const authCode = await MiniProgramLoginSession.getAuthCode(ticket, appid, { apiDomain: qrLogin.apiDomain });

                let avatar = '';
                if (uin) {
                    avatar = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
                }

                res.json({ ok: true, data: { status: 'OK', code: authCode, uin, avatar, nickname } });
            } else if (result.status === 'Used') {
                res.json({ ok: true, data: { status: 'Used' } });
            } else if (result.status === 'Wait') {
                res.json({ ok: true, data: { status: 'Wait' } });
            } else {
                res.json({ ok: true, data: { status: 'Error', error: result.msg } });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('*', (req, res) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    const applySocketSubscription = (socket, accountRef = '') => {
        const incoming = String(accountRef || '').trim();
        const resolved = incoming && incoming !== 'all' ? resolveAccId(incoming) : '';
        for (const room of socket.rooms) {
            if (room.startsWith('account:')) socket.leave(room);
        }
        if (resolved) {
            socket.join(`account:${resolved}`);
            socket.data.accountId = resolved;
        } else {
            socket.join('account:all');
            socket.data.accountId = '';
        }
        socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

        try {
            const targetId = socket.data.accountId || '';
            if (targetId && provider && typeof provider.getStatus === 'function') {
                const currentStatus = provider.getStatus(targetId);
                socket.emit('status:update', { accountId: targetId, status: currentStatus });
            }
            if (provider && typeof provider.getLogs === 'function') {
                const currentLogs = provider.getLogs(targetId, { limit: 100 });
                socket.emit('logs:snapshot', {
                    accountId: targetId || 'all',
                    logs: Array.isArray(currentLogs) ? currentLogs : [],
                });
            }
            if (provider && typeof provider.getAccountLogs === 'function') {
                const currentAccountLogs = provider.getAccountLogs(100);
                socket.emit('account-logs:snapshot', {
                    logs: Array.isArray(currentAccountLogs) ? currentAccountLogs : [],
                });
            }
        } catch {
            // ignore snapshot push errors
        }
    };

    const port = CONFIG.adminPort || 3456;
    server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    io = new SocketIOServer(server, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    io.use((socket, next) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !tokens.has(token)) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        return next();
    });

    io.on('connection', (socket) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(socket, body.accountId || '');
        });
    });
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
