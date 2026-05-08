<script setup lang="ts">
import { ref, computed } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()

const cdkeyType = ref('day')
const cdkeyDays = ref(1)
const cdkeyCount = ref(1)
const generating = ref(false)
const generatedKeys = ref<string[]>([])
const importing = ref(false)
const importJson = ref('')

const typeOptions = [
  { label: '天卡', value: 'day' },
  { label: '月卡', value: 'month' },
  { label: '永久卡', value: 'permanent' },
]

const daysLabel = computed(() => {
  return cdkeyType.value === 'day' ? '天数' : '月数'
})

async function generate() {
  generating.value = true
  try {
    const res = await api.post('/api/admin/cdkeys/generate', {
      type: cdkeyType.value,
      days: cdkeyDays.value,
      count: cdkeyCount.value,
    })
    if (res.data.ok) {
      generatedKeys.value = res.data.data.plaintext
      toast.success(`成功生成 ${res.data.data.count} 个卡密`)
    }
  } catch (e: any) {
    toast.error('生成失败')
  } finally {
    generating.value = false
  }
}

async function importHashes() {
  if (!importJson.value.trim()) return
  importing.value = true
  try {
    const hashes = JSON.parse(importJson.value)
    if (!Array.isArray(hashes)) throw new Error('格式错误')
    const res = await api.post('/api/admin/cdkeys/import', { hashes })
    if (res.data.ok) {
      toast.success(`成功导入 ${res.data.data.added} 个卡密，跳过 ${hashes.length - res.data.data.added} 个重复`)
      importJson.value = ''
    }
  } catch (e: any) {
    toast.error('导入失败：' + (e.message || '格式错误'))
  } finally {
    importing.value = false
  }
}

function copyKeys() {
  const text = generatedKeys.value.join('\n')
  navigator.clipboard.writeText(text).then(() => {
    toast.success('已复制到剪贴板')
  })
}
</script>

<template>
  <div class="space-y-6 w-[90%] mx-auto">
    <h2 class="text-xl font-bold text-gray-900 dark:text-white">卡密管理</h2>

    <!-- Generate section -->
    <div class="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800 space-y-4">
      <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">本地生成卡密</h3>
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div>
          <label class="text-xs text-gray-500 dark:text-gray-400 mb-1 block">类型</label>
          <BaseSelect v-model="cdkeyType" :options="typeOptions" />
        </div>
        <div>
          <label class="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{{ daysLabel }}</label>
          <BaseInput v-model="cdkeyDays" type="number" placeholder="30" />
        </div>
        <div>
          <label class="text-xs text-gray-500 dark:text-gray-400 mb-1 block">数量</label>
          <BaseInput v-model="cdkeyCount" type="number" placeholder="5" />
        </div>
        <div class="flex items-end">
          <BaseButton variant="primary" block :loading="generating" @click="generate">
            生成
          </BaseButton>
        </div>
      </div>

      <!-- Generated keys -->
      <div v-if="generatedKeys.length > 0" class="mt-4 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-600 dark:text-gray-300">
            已生成 {{ generatedKeys.length }} 个卡密（已自动导入服务器）
          </span>
          <BaseButton variant="ghost" size="sm" @click="copyKeys">复制全部</BaseButton>
        </div>
        <div class="rounded-lg bg-gray-50 p-3 font-mono text-xs dark:bg-gray-900 max-h-48 overflow-y-auto">
          <div v-for="key in generatedKeys" :key="key" class="py-0.5 text-gray-700 dark:text-gray-300">
            {{ key }}
          </div>
        </div>
        <p class="text-xs text-amber-600 dark:text-amber-400">
          请将以上卡密通过安全渠道（私聊/邮件）分发给用户，切勿在公开场合传播。
        </p>
      </div>
    </div>

    <!-- Import section -->
    <div class="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800 space-y-4">
      <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">
        导入卡密哈希（从本地脚本生成的 JSON 文件）
      </h3>
      <BaseInput v-model="importJson" placeholder="粘贴 JSON 数组 [{hash, type, days}, ...]" />
      <div class="text-xs text-gray-400 dark:text-gray-500">
        格式示例：{`[{"hash":"abc...", "type":"month", "days":1}]`}
      </div>
      <BaseButton variant="primary" :loading="importing" @click="importHashes">
        导入
      </BaseButton>
    </div>
  </div>
</template>
