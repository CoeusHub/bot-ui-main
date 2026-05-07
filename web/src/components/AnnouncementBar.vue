<script setup lang="ts">
import { onMounted, ref } from 'vue'
import axios from 'axios'

const content = ref('')
const dismissed = ref(false)

onMounted(async () => {
  // 检查今天是否已关闭
  const today = new Date().toLocaleDateString('zh-CN')
  const dismissedDate = localStorage.getItem('announcement_dismissed_date')
  if (dismissedDate === today) {
    dismissed.value = true
    return
  }

  try {
    const res = await axios.get('/api/announcement')
    if (res.data.ok && res.data.data.content) {
      content.value = res.data.data.content
    }
  } catch { /* ignore */ }
})

function dismiss() {
  dismissed.value = true
  const today = new Date().toLocaleDateString('zh-CN')
  localStorage.setItem('announcement_dismissed_date', today)
}
</script>

<template>
  <div
    v-if="content && !dismissed"
    class="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-900/20"
  >
    <span class="text-lg shrink-0 mt-0.5">📢</span>
    <p class="flex-1 text-sm text-amber-800 dark:text-amber-200 whitespace-pre-wrap">{{ content }}</p>
    <button
      class="shrink-0 text-amber-400 hover:text-amber-600 dark:hover:text-amber-300"
      @click="dismiss"
      title="关闭（今天不再显示）"
    >
      <div class="i-carbon-close text-lg" />
    </button>
  </div>
</template>
