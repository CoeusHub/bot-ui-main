import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useAppStore } from '@/stores/app'
import { useToastStore } from '@/stores/toast'
import App from './App.vue'
import router from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// Global Error Handling
const toast = useToastStore()

// 动态导入失败 → 页面资源已更新，强制刷新
function handleChunkError(message: string) {
  if (message.includes('Failed to fetch dynamically imported module')
    || message.includes('Importing a module script failed')
    || message.includes('error loading dynamically imported module')) {
    console.warn('[reload] chunk load failed, reloading page:', message)
    window.location.reload()
    return true
  }
  return false
}

app.config.errorHandler = (err: any, _instance, info) => {
  console.error('全局 Vue 错误:', err, info)
  const message = err.message || String(err)
  if (message.includes('ResizeObserver loop'))
    return
  if (handleChunkError(message)) return
  toast.error(`应用错误: ${message}`)
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (reason && typeof reason === 'object' && 'isAxiosError' in reason)
    return

  console.error('Unhandled Rejection:', reason)
  const message = reason?.message || String(reason)
  if (handleChunkError(message)) return
  toast.error(`异步错误: ${message}`)
})

window.onerror = (message, _source, _lineno, _colno, error) => {
  console.error('Global Error:', message, error)
  if (String(message).includes('Script error'))
    return
  const msg = String(message)
  if (handleChunkError(msg)) return
  toast.error(`系统错误: ${msg}`)
}

// Apply theme from localStorage immediately, then sync from server if authed
const appStore = useAppStore()
appStore.fetchTheme()

app.mount('#app')
