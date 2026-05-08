import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { useToastStore } from '@/stores/toast'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')

const api = axios.create({
  baseURL: '/',
  timeout: 10000,
})

api.interceptors.request.use((config) => {
  // 用户 JWT 优先：有 user_token 时只发 JWT，不发 admin token（避免双 token 冲突）
  const userToken = localStorage.getItem('user_token')
  if (userToken) {
    config.headers['Authorization'] = `Bearer ${userToken}`
  } else {
    const adminToken = tokenRef.value
    if (adminToken) {
      config.headers['x-admin-token'] = adminToken
    }
  }

  const accountId = accountIdRef.value
  if (accountId) {
    config.headers['x-account-id'] = accountId
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

api.interceptors.response.use((response) => {
  return response
}, (error) => {
  const toast = useToastStore()

  if (error.response) {
    if (error.response.status === 401) {
      if (!window.location.pathname.includes('/login')) {
        // 根据当前使用的 token 类型跳转对应登录页
        const hasUserToken = !!localStorage.getItem('user_token')
        tokenRef.value = ''
        localStorage.removeItem('user_token')
        if (hasUserToken) {
          window.location.href = '/user/login'
        } else {
          window.location.href = '/login'
        }
        toast.warning('登录已过期，请重新登录')
      }
    }
    else if (error.response.status >= 500) {
      const backendError = String(error.response.data?.error || error.response.data?.message || '')
      if (backendError === '账号未运行' || backendError === 'API Timeout') {
        return Promise.reject(error)
      }
      toast.error(`服务器错误: ${error.response.status} ${error.response.statusText}`)
    }
    else {
      const msg = error.response.data?.message || error.message
      toast.error(`请求失败: ${msg}`)
    }
  }
  else if (error.request) {
    toast.error('网络错误，无法连接到服务器')
  }
  else {
    toast.error(`错误: ${error.message}`)
  }

  return Promise.reject(error)
})

export default api
