<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import UserAccountModal from '@/components/UserAccountModal.vue'
import { useToastStore } from '@/stores/toast'
import { useSettingStore } from '@/stores/setting'

interface UserRow {
  userId: string
  username: string
  role: string
  status: string
  expireAt: number
  accountCount: number
  createdAt: number
}

const users = ref<UserRow[]>([])
const loading = ref(false)
const toast = useToastStore()
const settingStore = useSettingStore()

// 策略下发
const showPolicyModal = ref(false)
const policyTarget = ref<UserRow | null>(null)
const policySaving = ref(false)

// 可编辑的策略参数
const policyPlantingStrategy = ref('level')
const policyFarmMin = ref(5)
const policyFarmMax = ref(10)
const policyFriendMin = ref(10)
const policyFriendMax = ref(20)

const strategyOptions = [
  { label: '最高等级优先', value: 'level' },
  { label: '最大经验/小时', value: 'max_exp' },
  { label: '最大收益/小时', value: 'max_profit' },
  { label: '施肥最大经验/小时', value: 'max_fert_exp' },
  { label: '施肥最大收益/小时', value: 'max_fert_profit' },
  { label: '背包种子优先', value: 'bag_priority' },
]

// 手动延期
const showExtendModal = ref(false)
const extendTarget = ref<UserRow | null>(null)
const extendDays = ref(30)
const extendSaving = ref(false)

// 管理 QQ 号
const showAccountModal = ref(false)
const accountModalUserId = ref('')
const accountModalUsername = ref('')

async function fetchUsers() {
  loading.value = true
  try {
    const res = await api.get('/api/admin/users')
    if (res.data.ok) users.value = res.data.data
  } catch (e: any) {
    toast.error('获取用户列表失败')
  } finally {
    loading.value = false
  }
}

async function toggleStatus(userId: string, newStatus: string) {
  try {
    const res = await api.post(`/api/admin/users/${userId}/status`, { status: newStatus })
    if (res.data.ok) {
      toast.success('状态更新成功')
      fetchUsers()
    }
  } catch (e: any) {
    toast.error('操作失败')
  }
}

async function openPolicy(u: UserRow) {
  policyTarget.value = u
  // 默认值从管理员当前设置读取，没有则用内置默认值
  if (!settingStore.settings) await settingStore.fetchSettings('')
  const s = settingStore.settings
  policyPlantingStrategy.value = s?.plantingStrategy || 'level'
  policyFarmMin.value = s?.intervals?.farmMin || 5
  policyFarmMax.value = s?.intervals?.farmMax || 10
  policyFriendMin.value = s?.intervals?.friendMin || 10
  policyFriendMax.value = s?.intervals?.friendMax || 20
  showPolicyModal.value = true
}

async function handlePolicy() {
  if (!policyTarget.value) return
  policySaving.value = true
  try {
    const policyConfig = {
      plantingStrategy: policyPlantingStrategy.value,
      intervals: {
        farmMin: policyFarmMin.value,
        farmMax: policyFarmMax.value,
        friendMin: policyFriendMin.value,
        friendMax: policyFriendMax.value,
      },
    }

    const res = await api.post('/api/admin/policies', { userIds: [policyTarget.value.userId], policyConfig })
    if (res.data.ok) {
      toast.success(`策略已下发到 ${policyTarget.value.username}`)
      showPolicyModal.value = false
    } else {
      toast.error(res.data.error || '下发失败')
    }
  } catch (e: any) {
    toast.error('下发失败')
  } finally {
    policySaving.value = false
  }
}

async function handleExtend() {
  if (!extendTarget.value) return
  extendSaving.value = true
  try {
    const res = await api.post(`/api/admin/users/${extendTarget.value.userId}/extend`, { days: extendDays.value })
    if (res.data.ok) {
      toast.success(`已为 ${extendTarget.value.username} 延期 ${extendDays.value} 天`)
      showExtendModal.value = false
      fetchUsers()
    } else {
      toast.error(res.data.error || '延期失败')
    }
  } catch (e: any) {
    toast.error('延期失败')
  } finally {
    extendSaving.value = false
  }
}

function openExtend(u: UserRow) {
  extendTarget.value = u
  extendDays.value = 30
  showExtendModal.value = true
}

function formatTime(ts: number) {
  if (!ts) return '-'
  return new Date(ts * 1000).toLocaleDateString('zh-CN')
}

function formatCtime(ts: number) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN')
}

onMounted(fetchUsers)
</script>

<template>
  <div class="space-y-4 w-[90%] mx-auto">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold text-gray-900 dark:text-white">用户管理</h2>
      <BaseButton variant="ghost" size="sm" :loading="loading" @click="fetchUsers">
        刷新
      </BaseButton>
    </div>

    <div class="rounded-xl bg-white shadow-sm overflow-hidden dark:bg-gray-800">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-gray-600 dark:text-gray-300">用户名</th>
              <th class="px-4 py-3 text-left text-gray-600 dark:text-gray-300">状态</th>
              <th class="px-4 py-3 text-left text-gray-600 dark:text-gray-300">到期时间</th>
              <th class="px-4 py-3 text-left text-gray-600 dark:text-gray-300">QQ号数</th>
              <th class="px-4 py-3 text-left text-gray-600 dark:text-gray-300">注册时间</th>
              <th class="px-4 py-3 text-left text-gray-600 dark:text-gray-300">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
            <tr v-if="users.length === 0">
              <td colspan="6" class="px-4 py-12 text-center text-gray-400">暂无用户</td>
            </tr>
            <tr v-for="u in users" :key="u.userId">
              <td class="px-4 py-3 font-medium text-gray-900 dark:text-white">
                {{ u.username }}
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="u.status === 'active'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'"
                >
                  {{ u.status === 'active' ? '正常' : u.status === 'frozen' ? '已冻结' : u.status }}
                </span>
              </td>
              <td class="px-4 py-3 text-gray-600 dark:text-gray-300">
                {{ formatTime(u.expireAt) }}
              </td>
              <td class="px-4 py-3 text-gray-600 dark:text-gray-300">
                {{ u.accountCount }}
              </td>
              <td class="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                {{ formatCtime(u.createdAt) }}
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1.5">
                  <BaseButton variant="primary" size="sm" @click="openPolicy(u)">
                    下发策略
                  </BaseButton>
                  <BaseButton variant="success" size="sm" @click="openExtend(u)">
                    延期
                  </BaseButton>
                  <BaseButton variant="outline" size="sm" @click="showAccountModal = true; accountModalUserId = u.userId; accountModalUsername = u.username">
                    管理QQ号
                  </BaseButton>
                  <BaseButton
                    v-if="u.status === 'active'"
                    variant="danger" size="sm"
                    @click="toggleStatus(u.userId, 'frozen')"
                  >
                    冻结
                  </BaseButton>
                  <BaseButton
                    v-else-if="u.status === 'frozen'"
                    variant="success" size="sm"
                    @click="toggleStatus(u.userId, 'active')"
                  >
                    解冻
                  </BaseButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 策略下发弹窗 -->
    <div v-if="showPolicyModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="showPolicyModal = false">
      <div class="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800 space-y-4">
        <h3 class="text-lg font-bold text-gray-900 dark:text-white">
          下发策略到 {{ policyTarget?.username }}
        </h3>

        <div class="space-y-3">
          <div>
            <label class="text-sm text-gray-500 dark:text-gray-400">种植策略</label>
            <BaseSelect v-model="policyPlantingStrategy" :options="strategyOptions" class="mt-1" />
          </div>
          <div>
            <label class="text-sm text-gray-500 dark:text-gray-400">农场巡检间隔（秒）</label>
            <div class="flex items-center gap-2 mt-1">
              <input v-model.number="policyFarmMin" type="number" min="1" class="w-20 border border-gray-200 rounded-lg bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              <span class="text-gray-400">~</span>
              <input v-model.number="policyFarmMax" type="number" min="1" class="w-20 border border-gray-200 rounded-lg bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              <span class="text-xs text-gray-400">秒</span>
            </div>
          </div>
          <div>
            <label class="text-sm text-gray-500 dark:text-gray-400">好友巡检间隔（秒）</label>
            <div class="flex items-center gap-2 mt-1">
              <input v-model.number="policyFriendMin" type="number" min="1" class="w-20 border border-gray-200 rounded-lg bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              <span class="text-gray-400">~</span>
              <input v-model.number="policyFriendMax" type="number" min="1" class="w-20 border border-gray-200 rounded-lg bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              <span class="text-xs text-gray-400">秒</span>
            </div>
          </div>
          <p class="text-xs text-amber-600 dark:text-amber-400">
            下发的策略作为默认值，用户可在自己的设置中覆盖。
          </p>
        </div>

        <div class="flex justify-end gap-3">
          <BaseButton variant="ghost" @click="showPolicyModal = false">取消</BaseButton>
          <BaseButton variant="primary" :loading="policySaving" @click="handlePolicy">确定下发</BaseButton>
        </div>
      </div>
    </div>

    <!-- 延期弹窗 -->
    <div v-if="showExtendModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="showExtendModal = false">
      <div class="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800 space-y-4">
        <h3 class="text-lg font-bold text-gray-900 dark:text-white">
          手动延期 → {{ extendTarget?.username }}
        </h3>
        <div class="space-y-3">
          <div>
            <label class="text-sm text-gray-500 dark:text-gray-400">延期天数</label>
            <input
              v-model.number="extendDays"
              type="number" min="1" max="3650"
              class="mt-1 w-full border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
          </div>
          <p class="text-xs text-gray-400 dark:text-gray-500">不消耗卡密，直接增加会员时长</p>
        </div>
        <div class="flex justify-end gap-3">
          <BaseButton variant="ghost" @click="showExtendModal = false">取消</BaseButton>
          <BaseButton variant="success" :loading="extendSaving" @click="handleExtend">延期 {{ extendDays }} 天</BaseButton>
        </div>
      </div>
    </div>

    <!-- QQ号管理弹窗 -->
    <UserAccountModal
      :user-id="accountModalUserId"
      :username="accountModalUsername"
      :show="showAccountModal"
      @close="showAccountModal = false"
    />
  </div>
</template>
