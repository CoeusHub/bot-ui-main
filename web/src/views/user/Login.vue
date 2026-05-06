<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'
import { useUserStore } from '@/stores/user'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'

const router = useRouter()
const userStore = useUserStore()

const tab = ref<'login' | 'register' | 'renew'>('login')

// Login form
const loginUsername = ref('')
const loginPassword = ref('')
const loginLoading = ref(false)
const loginError = ref('')

// Register form
const regUsername = ref('')
const regPassword = ref('')
const regPassword2 = ref('')
const regCdkey = ref('')
const regLoading = ref(false)
const regError = ref('')
const regSuccess = ref(false)

// Renew form
const renewCdkey = ref('')
const renewLoading = ref(false)
const renewError = ref('')
const renewSuccess = ref(false)

const passwordMismatch = computed(() => {
  return regPassword.value && regPassword2.value && regPassword.value !== regPassword2.value
})

async function handleLogin() {
  loginLoading.value = true
  loginError.value = ''
  try {
    const res = await axios.post('/api/user/login', {
      username: loginUsername.value,
      password: loginPassword.value,
    })
    if (res.data.ok) {
      userStore.token = res.data.data.token
      userStore.user = res.data.data.user
      localStorage.setItem('user_token', res.data.data.token)
      router.push('/')
    } else {
      const code = res.data.code || ''
      if (code === 'ACCOUNT_EXPIRED' || code === 'ACCOUNT_FROZEN') {
        tab.value = 'renew'
        loginError.value = ''
      } else {
        loginError.value = res.data.error || '登录失败'
      }
    }
  } catch (e: any) {
    const data = e.response?.data
    if (data && (data.code === 'ACCOUNT_EXPIRED' || data.code === 'ACCOUNT_FROZEN')) {
      tab.value = 'renew'
    } else {
      loginError.value = data?.error || e.message || '登录异常'
    }
  } finally {
    loginLoading.value = false
  }
}

async function handleRegister() {
  regError.value = ''
  if (!regUsername.value.trim()) {
    regError.value = '请输入用户名'
    return
  }
  if (regPassword.value.length < 4) {
    regError.value = '密码长度至少 4 位'
    return
  }
  if (passwordMismatch.value) {
    regError.value = '两次密码输入不一致'
    return
  }
  if (!regCdkey.value.trim()) {
    regError.value = '请输入卡密'
    return
  }
  regLoading.value = true
  try {
    const res = await userStore.register(regUsername.value, regPassword.value, regCdkey.value)
    if (res.ok) {
      regSuccess.value = true
    } else {
      regError.value = res.error || '注册失败'
    }
  } finally {
    regLoading.value = false
  }
}

async function handleRenew() {
  if (!renewCdkey.value.trim()) {
    renewError.value = '请输入新的激活卡密'
    return
  }
  renewLoading.value = true
  renewError.value = ''
  try {
    const res = await axios.post('/api/user/renew', {
      username: loginUsername.value,
      password: loginPassword.value,
      cdkey: renewCdkey.value,
    })
    if (res.data.ok) {
      renewSuccess.value = true
    } else {
      renewError.value = res.data.error || '续期失败'
    }
  } catch (e: any) {
    renewError.value = e.response?.data?.error || e.message || '续期异常'
  } finally {
    renewLoading.value = false
  }
}

function switchTab(t: 'login' | 'register' | 'renew') {
  tab.value = t
  loginError.value = ''
  regError.value = ''
  regSuccess.value = false
  renewError.value = ''
  renewSuccess.value = false
}
</script>

<template>
  <div class="w-full flex items-start justify-center bg-gray-100 px-4 pt-[8vh] min-h-dvh sm:items-center dark:bg-gray-900 sm:pt-0">
    <div class="max-w-md w-full rounded-xl bg-white p-8 shadow-lg dark:bg-gray-800">
      <div class="mb-6 text-center">
        <h1 class="text-2xl text-gray-900 font-bold tracking-tight dark:text-white">
          QQ农场智能助手
        </h1>
      </div>

      <!-- Tab switcher -->
      <div class="flex mb-6 border-b border-gray-200 dark:border-gray-700">
        <button
          class="flex-1 pb-3 text-sm font-medium transition-colors"
          :class="tab === 'login' ? 'text-emerald-600 border-b-2 border-emerald-600' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'"
          @click="switchTab('login')"
        >
          登录
        </button>
        <button
          class="flex-1 pb-3 text-sm font-medium transition-colors"
          :class="tab === 'register' ? 'text-emerald-600 border-b-2 border-emerald-600' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'"
          @click="switchTab('register')"
        >
          注册
        </button>
        <button
          v-if="tab === 'renew'"
          class="flex-1 pb-3 text-sm font-medium transition-colors text-amber-600 border-b-2 border-amber-600"
        >
          续期
        </button>
      </div>

      <!-- Login tab -->
      <form v-if="tab === 'login'" class="space-y-4" @submit.prevent="handleLogin">
        <BaseInput v-model="loginUsername" placeholder="用户名" required />
        <BaseInput v-model="loginPassword" type="password" placeholder="密码" required />
        <div v-if="loginError" class="text-sm text-red-600 dark:text-red-400">
          {{ loginError }}
        </div>
        <BaseButton type="submit" variant="primary" block :loading="loginLoading">
          登录
        </BaseButton>
      </form>

      <!-- Register tab -->
      <form v-if="tab === 'register'" class="space-y-4" @submit.prevent="handleRegister">
        <div v-if="regSuccess" class="rounded-lg bg-emerald-50 p-4 text-center dark:bg-emerald-900/30">
          <div class="text-emerald-700 font-medium dark:text-emerald-300">注册成功！</div>
          <p class="mt-1 text-sm text-emerald-600 dark:text-emerald-400">请切换到"登录"页签进行登录</p>
        </div>
        <template v-else>
          <BaseInput v-model="regUsername" placeholder="用户名（2-32位中英文）" required />
          <BaseInput v-model="regPassword" type="password" placeholder="密码（至少4位）" required />
          <BaseInput v-model="regPassword2" type="password" placeholder="确认密码" required />
          <div v-if="passwordMismatch" class="text-sm text-red-600 dark:text-red-400">两次密码输入不一致</div>
          <BaseInput v-model="regCdkey" placeholder="卡密（FARM-XXXXXXXXXXXX）" required />
          <div v-if="regError" class="text-sm text-red-600 dark:text-red-400">{{ regError }}</div>
          <BaseButton type="submit" variant="primary" block :loading="regLoading">注册</BaseButton>
        </template>
      </form>

      <!-- Renew tab (shown when account expired) -->
      <form v-if="tab === 'renew'" class="space-y-4" @submit.prevent="handleRenew">
        <div class="rounded-lg bg-amber-50 p-4 text-sm dark:bg-amber-900/30">
          <p class="text-amber-800 font-medium dark:text-amber-300">账号已过期，请续期</p>
          <p class="mt-1 text-amber-600 dark:text-amber-400">
            账号 <strong>{{ loginUsername }}</strong> 的会员已到期，请输入新的激活卡密续期。
          </p>
        </div>
        <div v-if="renewSuccess" class="rounded-lg bg-emerald-50 p-4 text-center dark:bg-emerald-900/30">
          <div class="text-emerald-700 font-medium dark:text-emerald-300">续期成功！</div>
          <p class="mt-1 text-sm text-emerald-600 dark:text-emerald-400">请切换到"登录"页签重新登录</p>
        </div>
        <template v-else>
          <BaseInput v-model="renewCdkey" placeholder="新卡密（FARM-XXXXXXXXXXXX）" required />
          <div v-if="renewError" class="text-sm text-red-600 dark:text-red-400">{{ renewError }}</div>
          <BaseButton type="submit" variant="primary" block :loading="renewLoading">确认续期</BaseButton>
        </template>
      </form>

    </div>
  </div>
</template>
