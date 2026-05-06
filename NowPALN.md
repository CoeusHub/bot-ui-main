# QQ 农场多账号挂机 + Web 面板 — 功能模块骨架

## 项目概览

基于 Node.js 的 QQ 农场自动化工具，master-worker 架构，支持多账号管理、Web 控制面板、实时日志与数据分析。

---

## 一、技术栈

| 层级 | 技术 |
|------|------|
| 后端运行时 | Node.js 20+ |
| HTTP/WS 服务 | Express 4 + Socket.IO 4 |
| 游戏协议 | Protobuf (protobufjs) |
| 前端框架 | Vue 3 + TypeScript 5 |
| 构建工具 | Vite 7 |
| 状态管理 | Pinia 3 |
| CSS 方案 | UnoCSS |
| 打包部署 | Docker Compose / pkg 二进制 |
| 包管理 | pnpm 10 (monorepo) |

---

## 二、项目目录骨架

```
qq-farm-bot-ui/
├── core/                          # 后端引擎
│   ├── client.js                  # 主进程入口
│   ├── src/
│   │   ├── config/                # 全局配置与游戏数据
│   │   ├── controllers/           # HTTP API + Socket.IO
│   │   ├── core/                  # 单账号 Worker 进程
│   │   ├── models/                # 持久化存储层
│   │   ├── proto/                 # Protobuf 协议定义（17个）
│   │   ├── runtime/               # 运行时引擎（进程管理/状态同步/重登录）
│   │   └── services/              # 业务逻辑（25个服务模块）
│   └── data/                      # 运行时数据
├── web/                           # 前端面板
│   └── src/
│       ├── api/                   # Axios 客户端
│       ├── components/            # Vue 组件（UI 基础 + 业务组件）
│       ├── layouts/               # 布局组件
│       ├── router/                # 路由与菜单定义
│       ├── stores/                # Pinia 状态（8 个 store）
│       └── views/                 # 7 个页面视图
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

---

## 三、后端模块骨架 (core/)

### 3.1 主进程入口 — `core/client.js`
- 判断运行模式（Worker 模式 vs 主进程模式）
- 创建 RuntimeEngine，绑定状态/日志回调到 WebSocket
- 启动 Admin 服务器 + 自动启动所有账号

### 3.2 配置层 — `core/src/config/`

| 模块 | 职责 |
|------|------|
| `config.js` | 全局常量：游戏服务器地址、客户端版本、心跳间隔、农场/好友巡检间隔、设备信息、植物生长阶段枚举 |
| `gameConfig.js` | 静态游戏数据加载：植物表、种子表、等级经验表、物品信息、种子图片映射；提供植物/种子/果实/价格查询 API |
| `runtime-paths.js` | 运行时路径解析：开发模式 vs pkg 打包模式的数据目录、资源路径、share.txt 路径 |

### 3.3 Admin 控制器 — `core/src/controllers/admin.js`

HTTP API 网关 + WebSocket 实时推送。提供的接口分类如下：

| 功能域 | 接口数 | 说明 |
|--------|--------|------|
| 认证 | 4 | 登录/改密/Token验证/禁用密码认证 |
| 状态与日志 | 4 | 状态快照 / 日志查询 / 清日志 / 调度器状态 |
| 农场操作 | 2 | 批量农场操作 / 单块土地操作 |
| 土地/背包/好友数据 | 8 | 土地详情、好友列表、好友土地、好友操作、种子、背包 |
| 好友管理 | 4 | 黑名单增删、好友缓存 CRUD、导入访客 GID |
| 设置 | 2 | 统一保存接口、主题设置 |
| 通知 | 2 | 离线提醒配置、测试推送 |
| 账号管理 | 4 | 增删改查 + Code 获取头像昵称 |
| 数据分析 | 1 | 作物效率排行榜 |
| QR 登录 | 4 | 创建/轮询/状态检查/获取 AuthCode |
| WebSocket | 实时 | 按账号推送状态 + 日志到前端 |

### 3.4 Worker 进程 — `core/src/core/worker.js`

每个账号一个独立进程/线程，通过 IPC 与主进程通信：

- **连接管理**：WebSocket 连接游戏服务器，处理登录、踢下线
- **消息处理**：接收 master 的 start/stop/config_sync/api_call 指令
- **统一调度器**：农场巡检 + 好友巡检，间隔独立随机化
- **农场巡检 (Farm Tick)**：检查土地 → 收获/种植/浇水/除草/除虫/施肥/铲除/升级
- **好友巡检 (Friend Tick)**：扫描好友 → 偷菜/帮忙/捣乱
- **每日例行**：定时检测日期变更，触发所有每日礼包领取
- **状态同步**：每 3 秒向 master 发送完整状态快照

### 3.5 持久化存储 — `core/src/models/store.js`

| 存储 | 文件 | 内容 |
|------|------|------|
| 全局配置 | `store.json` | 自动化开关、种植策略、间隔、好友设置、UI 主题、通知配置、QR 配置、运行时配置、管理员密码 |
| 账号列表 | `accounts.json` | 账号 CRUD（id/name/code/platform/gid/uin/avatar/token） |

特性：原子写入（临时文件+重命名）、去重写入、配置校验与默认值填充

### 3.6 运行时引擎 — `core/src/runtime/`

| 模块 | 职责 |
|------|------|
| `runtime-engine.js` | **顶层编排器**：组合状态管理、Worker 管理、重登录服务、数据提供层；提供 start/stop/broadcastConfig |
| `runtime-state.js` | **共享内存状态**：workers 表、全局日志（上限 1000）、账号审计日志（上限 300）、EventEmitter 事件总线、配置版本号 |
| `worker-manager.js` | **Worker 生命周期**：创建/停止/重启 Worker 进程、IPC 消息路由、状态同步处理、离线检测与自动删除 |
| `data-provider.js` | **API 数据抽象层**：将 admin 控制器的请求转换为 Worker IPC 调用或存储读写 |
| `relogin-reminder.js` | **离线重登录**：生成小程序登录二维码、推送通知、轮询扫码状态、自动更新 Code 并重启 Worker |

### 3.7 业务服务层 — `core/src/services/`（25 个模块）

#### 核心游戏逻辑

| 模块 | 职责 |
|------|------|
| `farm.js` | **农场核心**（最大模块）：土地分析（可收获/缺水/长草/虫害/生长中/空地/枯萎/可解锁/可升级）、种植策略（优选种子→背包种子→商店种子）、施肥系统（普通/有机/混合 + 土地类型过滤 + 多季作物）、批量操作优化、收货→种植流水线 |
| `friend.js` | **好友核心**（第二大模块）：好友列表获取（平台 API + 游戏 RPC + 缓存回退）、进入/离开好友农场、帮忙操作（浇水/除草/除虫）、偷菜、捣乱（放虫/放草）、每日操作次数限制（8 种）、访客优先级排序、黑名单自动检测、静默时段 |
| `warehouse.js` | **仓库**：背包物品查询、果实出售（批量+单卖回退）、种子提取、化肥礼包自动开（计算容器上限防溢出）、化肥容器时间查询 |
| `task.js` | **任务系统**：每日/成长/主线任务检测与领取、活跃度奖励、插画手册奖励、push 事件监听实时领取 |
| `email.js` | **邮件**：系统/玩家邮件拉取、去重批量领取、单封领取降级 |

#### 自动化辅助

| 模块 | 职责 |
|------|------|
| `mall.js` | **商城**：自动购买化肥容器（按阈值/无限模式）、免费礼包领取 |
| `share.js` | **每日分享**：检测可分享→上报分享→领取奖励 |
| `monthcard.js` | **月卡**：查询可领取奖励→逐条领取 |
| `openserver.js` | **开服红包**：查询今日领取状态→领取 |
| `qqvip.js` | **QQ会员**：每日礼包状态查询与领取 |
| `invite.js` | **邀请码**：解析 share.txt、上报 Ark 点击、批量发送好友申请（微信平台） |
| `stats.js` | **会话统计**：操作计数、金币/经验增量追踪、去重 delta 检测 |

#### 通用工具

| 模块 | 职责 |
|------|------|
| `common.js` | 日期工具、每日冷却器、每日任务管理器、超时包装、重试包装、速率限制器、深度合并 |
| `logger.js` | 结构化日志（Winston/Console）、敏感信息脱敏（code/token/password） |
| `scheduler.js` | 轻量定时器：命名空间隔离、防重叠执行、任务注册表 |
| `scheduler-optimized.js` | 时间轮调度器（60 槽 100ms 精度）、大任务量优化（备用，未实际使用） |
| `rate-limiter.js` | 令牌桶 + 优先队列 + 批量操作优化器（农场 3 并发 / 好友 1 并发） |
| `security.js` | PBKDF2 密码哈希、登录限流（5 次锁 5 分钟）、Token 生成、密码强度检测 |
| `push.js` | 多通道推送（Bark/企业微信/Discord/Telegram/自定义 Webhook 等 20+） |
| `qrlogin.js` | QQ QR 登录 + 小程序登录双实现 |
| `manual-login-profile.js` | 用 Code 单次连接获取玩家头像和昵称 |
| `account-resolver.js` | 账号引用解析（id/uin/qq 任一字段匹配） |
| `analytics.js` | 作物效率排行计算（经验/收益/施肥经验/施肥收益 × 每小时） |
| `config-validator.js` | JSON Schema 风格配置校验器 |
| `interact.js` | 访客记录拉取 + 好友 GID 提取 |
| `status.js` | 终端状态栏（ANSI 转义码，预留顶部 2 行） |
| `json-db.js` | 原子文件读写（temp + rename） |

### 3.8 Protobuf 协议 — `core/src/proto/`（17 个 .proto 文件）

| 协议文件 | 对应服务 |
|----------|----------|
| `corepb.proto` | 网关/核心消息 |
| `userpb.proto` | 用户/登录 |
| `plantpb.proto` | 种植/农场 |
| `friendpb.proto` | 好友 |
| `visitpb.proto` | 访问（进出农场） |
| `taskpb.proto` | 任务 |
| `emailpb.proto` | 邮件 |
| `itempb.proto` | 物品/背包 |
| `shoppb.proto` | 商店 |
| `mallpb.proto` | 商城 |
| `sharepb.proto` | 分享 |
| `interactpb.proto` | 访客/互动记录 |
| `illustratedpb.proto` | 插画手册 |
| `notifypb.proto` | 推送通知 |
| `qqvipp.proto` | QQ VIP |
| `redpacketpb.proto` | 红包 |
| `game.proto` | 游戏级消息 |

---

## 四、前端模块骨架 (web/)

### 4.1 入口与路由

| 文件 | 职责 |
|------|------|
| `main.ts` | 创建 Vue 应用，安装 Pinia/Router，全局错误捕获 |
| `App.vue` | 根组件：`<RouterView>` + `<ToastContainer>`，主题初始化 |
| `router/index.ts` | 路由定义 + 导航守卫（Token 校验 → 重定向到 Login 或 Dashboard） |
| `router/menu.ts` | 侧边栏菜单项定义（6 个路由） |

### 4.2 布局 — `layouts/DefaultLayout.vue`

- 左侧：Sidebar（导航 + 账号切换 + 连接状态）
- 右侧：页面内容区（带过渡动画）
- 移动端：汉堡菜单 + 抽屉式侧边栏

### 4.3 UI 基础组件 — `components/ui/`

| 组件 | 说明 |
|------|------|
| `BaseButton.vue` | 多风格按钮（primary/secondary/danger/success/ghost/outline/text）+ loading 状态 |
| `BaseInput.vue` | 文本输入框 + 密码显隐切换 + 清空按钮 |
| `BaseSelect.vue` | 下拉选择器 + 自定义渲染插槽 |
| `BaseSwitch.vue` | 开关切换 |
| `BaseTextarea.vue` | 多行文本输入 |

### 4.4 业务组件 — `components/`

| 组件 | 说明 |
|------|------|
| `Sidebar.vue` | 主侧边栏：品牌区、账号下拉（头像/昵称/备注/平台标签）、菜单导航、连接状态指示器（绿/灰/红）、主题切换、自动开面板 |
| `FarmPanel.vue` | 农场土地网格：2x2 作物合并渲染、右键菜单（铲除/种植/施肥）、倒计时、种子选择弹窗 |
| `LandCard.vue` | 单块土地卡片：作物图片/名称/倒计时/阶段/土地类型/季节/需求徽章 |
| `BagPanel.vue` | 背包面板：按类型 Tab 过滤、物品卡片网格、自动刷新 |
| `TaskPanel.vue` | 每日任务 + 成长任务 + 每日礼包概览 |
| `DailyOverview.vue` | 每日礼包状态网格（邮件/分享/VIP/月卡/开服等） |
| `AccountModal.vue` | 账号弹窗：QR 登录（扫码轮询）+ 手动 Code 输入 双模式 |
| `ConfirmModal.vue` | 通用确认对话框（支持 danger/primary 类型 + alert 模式） |
| `RemarkModal.vue` | 修改账号备注名 |
| `ThemeToggle.vue` | 主题切换按钮（亮色/暗色） |
| `ToastContainer.vue` | 全局 Toast 通知（成功/错误/警告/信息），右上角弹出，动画过渡 |

### 4.5 状态管理 — `stores/`（8 个 Pinia Store）

| Store | 职责 |
|-------|------|
| `app.ts` | 全局 UI 状态：侧边栏开关、暗色模式（localStorage 持久化） |
| `account.ts` | 账号列表管理：增删改查、启动/停止、日志拉取 |
| `status.ts` | 实时状态与日志：HTTP 状态快照 + Socket.IO 实时推送 |
| `farm.ts` | 农场数据：土地列表、种子列表、背包种子、批量/单块操作 |
| `friend.ts` | 好友管理（最大 Store）：好友列表、好友土地、互动记录、黑名单、好友缓存、导入 GID |
| `bag.ts` | 背包物品：全部/仪表板 两种视图 |
| `setting.ts` | 设置管理（最复杂 Store）：种植策略、自动化开关、施肥配置、间隔、好友设置、离线通知、QR 配置、运行时客户端配置（约 40 个配置项） |
| `toast.ts` | Toast 通知队列：添加/移除/去重/防抖 |

### 4.6 页面视图 — `views/`（7 个页面）

| 页面 | 路由 | 功能摘要 |
|------|------|----------|
| `Login.vue` | `/login` | 登录页：密码输入 + Token 存储 |
| `Dashboard.vue` | `/`（概览） | 三栏布局：账号信息 + 资产卡片 / 日志查看器（多条件筛选） / 巡检倒计时 + 今日操作统计 |
| `Personal.vue` | `/personal` | 三 Tab：我的农场（FarmPanel）/ 我的背包（BagPanel）/ 我的任务（TaskPanel） |
| `Friends.vue` | `/friends` | 好友管理三区：近期访客 / 好友列表（展开看土地+操作按钮）/ 黑名单；搜索筛选；GID 导入 |
| `Analytics.vue` | `/analytics` | 作物数据分析：策略推荐面板（4 种策略最优作物）+ 全部作物排序表（经验/收益多维度） |
| `Accounts.vue` | `/accounts` | 账号卡片网格：头像/名称/绑定信息/启停开关/编辑/删除；自动刷新 |
| `Settings.vue` | `/settings` | 双栏设置：左栏（种植策略 + 自动化开关 + 好友设置 + 肥料配置 + 偷菜黑名单）；右栏（密码 + 运行时客户端 + QR 登录 + 离线通知 20+ 通道） |

### 4.7 API 层 — `api/index.ts`

- Axios 实例：自动注入 `x-admin-token` + `x-account-id`
- 响应拦截：401→跳转登录、500+→后端已知错误透传、网络错误→Toast

---

## 五、数据流架构

```
                         ┌─────────────────────┐
                         │    Web 前端 (Vue 3)  │
                         │  Pinia Stores        │
                         └──────┬──────┬────────┘
                   HTTP/REST │      │ Socket.IO (实时)
                             │      │
                         ┌───┴──────┴───┐
                         │  Admin Server │  ← controllers/admin.js
                         │  Express 4    │
                         └──────┬───────┘
                                │
                    ┌───────────┴───────────┐
                    │   Runtime Engine      │  ← runtime/runtime-engine.js
                    │   (Master Process)    │
                    └───────────┬───────────┘
                                │ IPC (worker_threads / child_process)
              ┌─────────────────┼─────────────────┐
              │                 │                 │
     ┌────────┴────────┐ ┌─────┴─────┐  ┌────────┴────────┐
     │ Worker (账号1)  │ │ Worker 2  │  │ Worker N        │
     │ core/worker.js  │ │           │  │                 │
     └────────┬────────┘ └───────────┘  └─────────────────┘
              │ WebSocket (wss://gate-obt.nqf.qq.com)
     ┌────────┴────────┐
     │  游戏服务器      │
     │  Protobuf 协议   │
     └─────────────────┘
```

---

## 六、核心自动化流程

### 6.1 农场巡检 (Farm Tick)
```
checkFarm()
  ├─ getAllLands()            → 获取土地状态
  ├─ analyzeLands()           → 分类：可收获/缺水/长草/虫害/生长中/空地/枯萎/可升级
  ├─ harvest()                → 收获成熟作物
  ├─ sellAllFruits()          → 出售收获果实
  ├─ waterLand() / weedOut() / insecticide()  → 批量维护操作
  ├─ removePlant()            → 铲除枯萎作物
  ├─ upgradeLand() / unlockLand() → 土地升级/解锁
  └─ findBestSeed() + plantSeeds() → 按策略种植
       ├─ preferred（指定种子）
       ├─ level（最高等级）
       ├─ max_exp / max_fert_exp（最大经验效率）
       ├─ max_profit / max_fert_profit（最大收益效率）
       └─ bag_priority（优先使用背包种子）
```

### 6.2 好友巡检 (Friend Tick)
```
checkFriends()
  ├─ getAllFriends()          → 获取好友列表（平台 API + 游戏 RPC + 缓存）
  ├─ 构建优先队列（可见偷菜/帮忙标记的好友）
  ├─ 构建空闲探测队列（无标记好友，20min/2min 冷却）
  ├─ visitFriend(friend)
  │    ├─ enterFriendFarm()   → 进入好友农场
  │    ├─ analyzeFriendLands()→ 分析可操作土地
  │    ├─ helpWater/Weed/Bug  → 帮忙操作（受每日限制）
  │    ├─ stealHarvest()      → 偷菜（受每日限制 + 静默时段 + 作物黑名单）
  │    └─ putInsects/Weeds    → 捣乱（受每日限制 + 静默时段）
  └─ 自动接受好友申请 + 自动检测被屏蔽好友
```

### 6.3 每日例行
```
每日日期变更检测（30s 间隔）
  ├─ checkAndClaimEmails()    → 邮件奖励
  ├─ performDailyShare()      → 分享奖励
  ├─ performDailyMonthCardGift() → 月卡礼包
  ├─ buyFreeGifts()           → 商城免费礼包
  ├─ performDailyVipGift()    → QQ VIP 礼包
  └─ performDailyOpenServerGift() → 开服红包
```

---

## 七、安全机制

| 机制 | 实现 |
|------|------|
| 认证 | Token-based 登录 + 密码可禁用（仅本地访问） |
| 密码存储 | PBKDF2-SHA512（10 万次迭代 + 随机盐） |
| 登录限流 | IP 级别：5 次失败锁定 5 分钟 |
| 日志脱敏 | code/token/password 自动从日志中剥离 |
| 敏感头处理 | WebSocket URL 参数脱敏 |

---

## 八、部署方式

| 方式 | 命令 | 产物 |
|------|------|------|
| 源码开发 | `pnpm dev:core` + `pnpm dev:web` | — |
| 源码生产 | `pnpm build:web && pnpm dev:core` | 前端构建到 `web/dist/` |
| Docker | `docker compose up -d --build` | 容器化部署 |
| 二进制打包 | `pnpm package:release` | Win/Linux/macOS 可执行文件 |
