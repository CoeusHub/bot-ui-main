import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { menuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

async function ensureAdminTokenValid() {
  // 直接读 localStorage，避免 useStorage ref 同步延迟
  const token = String(localStorage.getItem('admin_token') || '').trim()
  try {
    const authCheckResponse = await axios.get('/api/auth/validate', {
      headers: token ? { 'x-admin-token': token } : {},
      timeout: 6000,
    })
    if (authCheckResponse.data && authCheckResponse.data.ok) {
      const { valid, passwordDisabled } = authCheckResponse.data.data
      if (passwordDisabled) return true
      if (valid && token) return true
    }
    return false
  } catch {
    return false
  }
}

async function ensureUserTokenValid() {
  // 直接读 localStorage，避免 useStorage ref 同步延迟
  const token = String(localStorage.getItem('user_token') || '').trim()
  if (!token) return false
  try {
    const res = await axios.get('/api/user/profile', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    })
    return !!(res.data && res.data.ok)
  } catch {
    return false
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: menuRoutes.map(route => ({
        path: route.path,
        name: route.name,
        component: route.component,
      })),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
    {
      path: '/user/login',
      name: 'user-login',
      component: () => import('@/views/user/Login.vue'),
    },
  ],
})

router.beforeEach(async (to, _from) => {
  NProgress.start()

  // === 管理员登录页 ===
  if (to.name === 'login') {
    const adminValid = await ensureAdminTokenValid()
    if (adminValid) return { name: 'dashboard' }
    return true
  }

  // === 用户登录/注册页 ===
  if (to.name === 'user-login') {
    const userValid = await ensureUserTokenValid()
    if (userValid) return { name: 'dashboard' }
    return true
  }

  // === 需要认证的页面：优先检查用户 token，然后检查管理员 token ===
  const hadUserToken = !!localStorage.getItem('user_token')
  const hadAdminToken = !!localStorage.getItem('admin_token')

  const userValid = await ensureUserTokenValid()
  if (userValid) return true

  const adminValid = await ensureAdminTokenValid()
  if (adminValid) return true

  // 都无效 → 清除 token，根据之前使用的登录方式跳转
  localStorage.removeItem('admin_token')
  localStorage.removeItem('user_token')

  if (hadUserToken) return { name: 'user-login' }
  if (hadAdminToken) return { name: 'login' }
  // 首次访问（无任何 token） → 默认跳转用户登录页
  return { name: 'user-login' }
})

router.afterEach(() => {
  NProgress.done()
})

router.onError((error) => {
  const msg = String(error?.message || '')
  if (msg.includes('Failed to fetch dynamically imported module')
    || msg.includes('Importing a module script failed')) {
    console.warn('[router] chunk load failed, reloading page:', msg)
    window.location.reload()
  }
})

export default router
