<script setup lang="ts">
import { ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useToastStore } from '@/stores/toast'

interface QQAccount {
  id: string; name: string; code: string; platform: string
  gid: string; uin: string; avatar: string; running: boolean
}

const props = defineProps<{ userId: string; username: string; show: boolean }>()
const emit = defineEmits(['close'])

const toast = useToastStore()
const accounts = ref<QQAccount[]>([])
const loading = ref(false)

// Add form
const addCode = ref('')
const addName = ref('')
const addPlatform = ref('qq')
const addLoading = ref(false)

// Edit state
const editingId = ref('')
const editCode = ref('')
const editName = ref('')
const editSaving = ref(false)

const platformOptions = [
  { label: 'QQ', value: 'qq' },
  { label: '微信', value: 'wx' },
]

async function fetchAccounts() {
  loading.value = true
  try {
    const res = await api.get(`/api/admin/users/${props.userId}/accounts`)
    if (res.data.ok) accounts.value = res.data.data.accounts || []
  } catch { toast.error('获取账号列表失败') }
  finally { loading.value = false }
}

function startEdit(acc: QQAccount) {
  editingId.value = acc.id
  editCode.value = acc.code
  editName.value = acc.name
}

function cancelEdit() {
  editingId.value = ''
}

async function handleSaveEdit(acc: QQAccount) {
  if (!editCode.value.trim()) { toast.warning('请输入 Code'); return }
  editSaving.value = true
  try {
    const res = await api.put(`/api/admin/users/${props.userId}/accounts/${acc.id}`, { code: editCode.value, name: editName.value })
    if (res.data.ok) {
      toast.success('修改成功')
      editingId.value = ''
      fetchAccounts()
    }
  } catch (e: any) { toast.error('修改失败') }
  finally { editSaving.value = false }
}

async function handleAdd() {
  if (!addCode.value.trim()) { toast.warning('请输入 Code'); return }
  addLoading.value = true
  try {
    const res = await api.post(`/api/admin/users/${props.userId}/accounts`, { code: addCode.value, name: addName.value, platform: addPlatform.value })
    if (res.data.ok) {
      toast.success('添加成功')
      addCode.value = ''; addName.value = ''
      fetchAccounts()
    }
  } catch (e: any) { toast.error('添加失败') }
  finally { addLoading.value = false }
}

async function handleDelete(acc: QQAccount) {
  if (!confirm(`确定删除「${acc.name}」吗？`)) return
  try {
    await api.delete(`/api/admin/users/${props.userId}/accounts/${acc.id}`)
    toast.success('已删除')
    fetchAccounts()
  } catch { toast.error('删除失败') }
}

watch(() => props.show, (v) => { if (v) { editingId.value = ''; fetchAccounts() } })
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="emit('close')">
    <div class="w-full max-w-2xl max-h-[80vh] rounded-xl bg-white shadow-xl dark:bg-gray-800 flex flex-col">
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
        <h3 class="text-lg font-bold text-gray-900 dark:text-white">
          管理QQ号 — {{ username }}
        </h3>
        <button class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" @click="emit('close')">
          <div class="i-carbon-close text-xl" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6 space-y-4">
        <div v-if="accounts.length === 0" class="text-center text-sm text-gray-400 py-4">暂无QQ号</div>
        <div v-for="acc in accounts" :key="acc.id" class="rounded-lg border border-gray-100 p-3 dark:border-gray-700">
          <!-- View mode -->
          <div v-if="editingId !== acc.id" class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <img v-if="acc.avatar" :src="acc.avatar" class="w-8 h-8 rounded-full">
              <div v-else class="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600" />
              <div>
                <div class="text-sm font-medium text-gray-900 dark:text-white">{{ acc.name }}</div>
                <div class="text-xs text-gray-400">{{ acc.platform === 'wx' ? '微信' : 'QQ' }} · Code: {{ acc.code?.substring(0, 12) }}{{ (acc.code?.length || 0) > 12 ? '...' : '' }}</div>
              </div>
            </div>
            <div class="flex items-center gap-1.5">
              <BaseButton variant="ghost" size="sm" @click="startEdit(acc)">编辑</BaseButton>
              <BaseButton variant="danger" size="sm" @click="handleDelete(acc)">删除</BaseButton>
            </div>
          </div>
          <!-- Edit mode -->
          <div v-else class="space-y-2">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <BaseInput v-model="editCode" placeholder="Code" />
              <BaseInput v-model="editName" placeholder="备注名" />
            </div>
            <div class="flex justify-end gap-1.5">
              <BaseButton variant="ghost" size="sm" @click="cancelEdit">取消</BaseButton>
              <BaseButton variant="primary" size="sm" :loading="editSaving" @click="handleSaveEdit(acc)">保存</BaseButton>
            </div>
          </div>
        </div>

        <!-- Add new -->
        <div class="border-t pt-4 dark:border-gray-700">
          <h4 class="text-sm font-medium text-gray-900 dark:text-white mb-3">添加QQ号</h4>
          <div class="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div class="sm:col-span-2">
              <BaseInput v-model="addCode" placeholder="输入 Code" />
            </div>
            <BaseInput v-model="addName" placeholder="备注名（可选）" />
            <BaseSelect v-model="addPlatform" :options="platformOptions" />
          </div>
          <div class="mt-3 flex justify-end">
            <BaseButton variant="primary" size="sm" :loading="addLoading" @click="handleAdd">添加</BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
