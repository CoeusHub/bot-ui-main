import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

interface UserInfo {
  userId: string
  username: string
  role: string
  status: string
  expireAt: number
  accountCount: number
  createdAt: number
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('user_token', '')
  const user = ref<UserInfo | null>(null)
  const loading = ref(false)
  const error = ref('')

  const isAdminRole = computed(() => {
    // 用户 JWT 中 role 为 admin
    if (user.value?.role === 'admin') return true
    // 管理员通过 admin_token 登录（存在 localStorage 中）
    if (localStorage.getItem('admin_token')) return true
    return false
  })
  const isLoggedIn = computed(() => !!token.value && !!user.value)
  const isExpired = computed(() => {
    if (!user.value?.expireAt) return false
    return Math.floor(Date.now() / 1000) > user.value.expireAt
  })
  const expireDate = computed(() => {
    if (!user.value?.expireAt) return ''
    return new Date(user.value.expireAt * 1000).toLocaleDateString('zh-CN')
  })

  function authHeaders() {
    return token.value ? { Authorization: `Bearer ${token.value}` } : {}
  }

  async function login(username: string, password: string) {
    loading.value = true
    error.value = ''
    try {
      const res = await axios.post('/api/user/login', { username, password })
      if (res.data.ok) {
        // 先同步写入 localStorage，确保 router.push 时守卫能读到
        localStorage.setItem('user_token', res.data.data.token)
        token.value = res.data.data.token
        user.value = res.data.data.user
        return true
      }
      error.value = res.data.error || '登录失败'
      return false
    } catch (e: any) {
      error.value = e.response?.data?.error || e.message || '登录异常'
      return false
    } finally {
      loading.value = false
    }
  }

  async function register(username: string, password: string, cdkey: string) {
    loading.value = true
    error.value = ''
    try {
      const res = await axios.post('/api/user/register', { username, password, cdkey })
      if (res.data.ok) {
        return { ok: true }
      }
      error.value = res.data.error || '注册失败'
      return { ok: false, error: res.data.error }
    } catch (e: any) {
      const msg = e.response?.data?.error || e.message || '注册异常'
      error.value = msg
      return { ok: false, error: msg }
    } finally {
      loading.value = false
    }
  }

  async function fetchProfile() {
    if (!token.value) return false
    try {
      const res = await axios.get('/api/user/profile', { headers: authHeaders() })
      if (res.data.ok) {
        user.value = res.data.data
        return true
      }
      // token 失效
      if (res.status === 401) {
        logout()
      }
      return false
    } catch (e: any) {
      if (e.response?.status === 401) {
        logout()
      }
      return false
    }
  }

  function logout() {
    localStorage.removeItem('user_token')
    token.value = ''
    user.value = null
  }

  return {
    token,
    user,
    loading,
    error,
    isAdminRole,
    isLoggedIn,
    isExpired,
    expireDate,
    authHeaders,
    login,
    register,
    fetchProfile,
    logout,
  }
})
