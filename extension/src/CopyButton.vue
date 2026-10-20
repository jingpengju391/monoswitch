<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { t } from './i18n'

const props = defineProps<{ text: string; label: string }>()
const emit = defineEmits<{ copied: []; error: []; start: [] }>()
const state = ref<'idle' | 'copying' | 'copied'>('idle')
let resetTimer: ReturnType<typeof setTimeout> | undefined
let revision = 0

function reset() {
  revision++
  clearTimeout(resetTimer)
  state.value = 'idle'
}

async function copy() {
  if (!props.text || state.value === 'copying') return
  clearTimeout(resetTimer)
  const current = ++revision
  state.value = 'copying'
  emit('start')
  try {
    await navigator.clipboard.writeText(props.text)
    if (current !== revision) return
    state.value = 'copied'
    resetTimer = setTimeout(reset, 2000)
    emit('copied')
  } catch {
    if (current !== revision) return
    state.value = 'idle'
    emit('error')
  }
}

watch(() => props.text, reset)
onUnmounted(reset)
</script>

<template>
  <button class="primary-button copy-button" :class="{ 'copy-success': state === 'copied' }"
    :disabled="!text || state === 'copying'" :aria-busy="state === 'copying'" @click="copy">
    <span aria-live="polite">{{ t(state === 'copied' ? '已复制' : state === 'copying' ? '正在复制…' : label) }}</span>
    <Icon :name="state === 'copied' ? 'check' : state === 'copying' ? 'refresh' : 'copy'"
      :class="{ spinning: state === 'copying' }" :size="17" />
  </button>
</template>
