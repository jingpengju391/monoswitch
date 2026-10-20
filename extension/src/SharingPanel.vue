<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { HostStatus, Settings, SharingIdentity, SharingStatus } from '../../shared/protocol'
import { demoMode, isExtension, request } from './bridge'
import { t, diagnostic } from './i18n'
import Icon from './Icon.vue'

const props = defineProps<{ host: HostStatus; settings: Settings; compact?: boolean }>()
const emit = defineEmits<{ identity: [SharingIdentity | null]; upgrade: []; running: [boolean] }>()
const state = ref<SharingStatus | null>(null)
const role = ref<'server' | 'client'>('server')
const address = ref('')
const follow = ref(true)
const port = ref(24800)
const pending = ref(false)
const error = ref('')
const unsupported = ref(false)
const confirmed = ref(false)
const key = 'monoswitch.sharingSettings'
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let loaded = false
const paired = computed(() => Boolean(state.value?.identity && props.settings.peer?.sharing))
const blockers = computed(() => {
  const reasons: string[] = []
  if (!state.value?.installed) reasons.push('尚未检测到 Deskflow，请安装键鼠组件后重新检测。')
  if (!state.value?.identity) reasons.push('请先点击“准备键鼠配对”，生成本机身份。')
  if (!props.settings.peer?.sharing) reasons.push('对端配置不含键鼠身份：请在另一台电脑准备键鼠配对后，重新复制并导入它的配置。')
  if (paired.value && !confirmed.value) reasons.push('请勾选上方的配对确认，允许另一台电脑参与共享。')
  if (follow.value && (!props.settings.displayId || props.settings.localInput === null)) reasons.push('画面联动需要选择本机显示器和输入接口；也可先取消画面联动，仅测试键鼠。')
  if (role.value === 'client' && !address.value.trim()) reasons.push('请填写发送端的局域网 IP。')
  if (!Number.isInteger(port.value) || port.value < 1024 || port.value > 65535) reasons.push('连接端口需为 1024 到 65535 的整数。')
  return reasons
})
const canStart = computed(() => blockers.value.length === 0)


function apply(value: SharingStatus) {
  state.value = value
  emit('identity', value.identity)
  emit('running', value.running)
}
async function refresh() {
  clearTimeout(timer)
  if (disposed || demoMode) return
  if (pending.value) { timer = setTimeout(refresh, 2500); return }
  try {
    const response = await request<SharingStatus>({ action: 'sharingStatus' })
    if (disposed) return
    if (response.ok && typeof response.data.installed === 'boolean') {
      apply(response.data)
      unsupported.value = false
    } else {
      unsupported.value = !response.ok && response.error.code === 'INVALID_REQUEST'
      if (!response.ok) error.value = response.error.message
    }
  } catch { if (!disposed) error.value = '无法读取键鼠共享状态，请重试。' }
  finally { if (!disposed && !unsupported.value) timer = setTimeout(refresh, 2500) }
}
async function prepare() {
  pending.value = true; error.value = ''
  try {
    const response = await request<SharingIdentity>({ action: 'sharingIdentity' }, true)
    if (!response.ok) throw new Error(response.error.message)
    emit('identity', response.data)
    if (state.value) state.value.identity = response.data
  } catch (e) { error.value = e instanceof Error ? e.message : '无法生成键鼠配对信息。' }
  finally { pending.value = false }
}
async function install() {
  pending.value = true; error.value = ''
  try {
    const response = await request<SharingStatus>({ action: 'sharingInstall' }, true)
    if (!response.ok) throw new Error(response.error.message)
    apply(response.data)
  } catch (e) { error.value = e instanceof Error ? e.message : '键鼠组件安装失败。' }
  finally { pending.value = false }
}
async function start() {
  if (!canStart.value || !props.settings.peer?.sharing) return
  pending.value = true; error.value = ''
  try {
    const response = await request<SharingStatus>({ action: 'sharingStart', config: {
      role: role.value, peer: props.settings.peer.sharing,
      address: role.value === 'client' ? address.value.trim() : '', port: port.value,
      followDisplay: follow.value, displayId: props.settings.displayId, input: props.settings.localInput ?? 0,
    } }, true)
    if (!response.ok) throw new Error(response.error.message)
    apply(response.data)
  } catch (e) { error.value = e instanceof Error ? e.message : '无法启动键鼠共享。' }
  finally { pending.value = false }
}
async function stop() {
  pending.value = true; error.value = ''
  try {
    const response = await request<SharingStatus>({ action: 'sharingStop' }, true)
    if (!response.ok) throw new Error(response.error.message)
    apply(response.data)
  } catch (e) { error.value = e instanceof Error ? e.message : '无法停止键鼠共享。' }
  finally { pending.value = false }
}
watch(() => props.settings.peer?.sharing?.fingerprint, () => { confirmed.value = false })
watch([role, address, follow, port], () => {
  if (!loaded || !isExtension) return
  void chrome.storage.local.set({ [key]: { role: role.value, address: address.value, follow: follow.value, port: port.value } })
    .catch(() => { error.value = '键鼠设置保存失败，请重试。' })
})
onMounted(async () => {
  if (isExtension) {
    try {
      const saved = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined
      if (saved) {
        role.value = saved.role === 'client' ? 'client' : 'server'
        address.value = typeof saved.address === 'string' ? saved.address.slice(0, 64) : ''
        follow.value = saved.follow !== false
        port.value = typeof saved.port === 'number' && Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535 ? saved.port : 24800
      }
    } catch { /* Defaults remain usable when preferences are unavailable. */ }
  }
  loaded = true
  void refresh()
})
onUnmounted(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <section class="panel sharing-panel" :class="{ 'sharing-compact': compact }" :aria-label="t('键盘与鼠标共享')">
    <div class="panel-heading">
      <Icon name="link" :size="22" />
      <div><h2>{{ t('键盘与鼠标共享') }}</h2><p>{{ t('通过局域网共用一套键鼠') }}</p></div>
      <span class="tag" :class="{ green: state?.connected }">{{ t(state?.connected ? '已加密连接' : state?.running ? '等待另一台电脑' : '未开启') }}</span>
    </div>
    <p v-if="demoMode">{{ t('演示模式不会启动键鼠共享。') }}</p>
    <template v-else>
      <p v-if="unsupported">{{ t('需要更新本地组件才能使用键鼠共享。') }}</p>
      <button v-if="unsupported" class="secondary-button" @click="emit('upgrade')">{{ t('更新本地组件') }}</button>
      <template v-else-if="state">
        <template v-if="!compact && !state.running">
          <p>{{ t('两台电脑分别准备键鼠配对，然后重新交换上方的本机配置。') }}</p>
          <button v-if="!state.identity" class="secondary-button" :disabled="pending" @click="prepare">{{ t('准备键鼠配对') }}</button>
          <p v-else class="privacy-note">{{ t('本机配置已包含键鼠配对信息，请复制给另一台电脑。') }}</p>
          <div v-if="!state.installed" class="message warning sharing-install">
            <p>{{ t('需要 Deskflow 1.26 或更新版本作为键鼠组件。') }}</p>
            <button v-if="host.platform.os === 'linux'" class="secondary-button" :disabled="pending" @click="install">{{ t(pending ? '等待系统授权或安装完成…' : '安装键鼠组件') }}</button>
            <a v-else href="https://github.com/deskflow/deskflow/releases" target="_blank" rel="noreferrer">{{ t('下载官方键鼠组件') }}</a>
            <button class="text-button" :disabled="pending" @click="refresh">{{ t('重新检测') }}</button>
          </div>
          <div class="sharing-fields">
            <label class="field"><span>{{ t('键盘和鼠标接在哪里？') }}</span>
              <select v-model="role" :disabled="pending">
                <option value="server">{{ t('接在这台电脑（发送端）') }}</option>
                <option value="client">{{ t('接在另一台电脑（接收端）') }}</option>
              </select>
              <small>{{ t('接在显示器上时，Type-C 连接的电脑是发送端。') }}</small>
            </label>
            <label v-if="role === 'client'" class="field"><span>{{ t('发送端的局域网 IP') }}</span>
              <input v-model="address" placeholder="192.168.1.20" maxlength="64" :disabled="pending" autocomplete="off" />
            </label>
          </div>
          <label class="confirmation"><input v-model="follow" type="checkbox" :disabled="pending" /><span>{{ t('键鼠切换时，同时切换显示器画面') }}</span></label>
          <details class="diagnostics"><summary>{{ t('连接端口与配对校验') }}</summary>
            <label class="field"><span>{{ t('连接端口（两台保持一致）') }}</span><input v-model.number="port" type="number" min="1024" max="65535" :disabled="pending" /></label>
            <p>{{ t('本机指纹') }}: <code>{{ state.identity?.fingerprint || '—' }}</code></p>
            <p>{{ t('另一台电脑指纹') }}: <code>{{ settings.peer?.sharing?.fingerprint || '—' }}</code></p>
          </details>
          <p v-if="!paired" class="privacy-note">{{ t('请先完成两台电脑的键鼠配对信息交换。') }}</p>
          <label v-else class="confirmation"><input v-model="confirmed" type="checkbox" :disabled="pending" /><span>{{ t('我确认配置来自自己的另一台电脑，允许它参与键鼠共享。') }}</span></label>
          <div v-if="blockers.length" class="message warning" role="status">
            <ul><li v-for="reason in blockers" :key="reason">{{ t(reason) }}</li></ul>
          </div>
          <button class="primary-button" :disabled="!canStart || pending" @click="start">{{ t(pending ? '正在处理…' : '开启键鼠共享') }}</button>
          <p class="privacy-note">{{ t('仅在开启后监听网络。两台电脑需运行 Chrome；发送端不能休眠。macOS 需授权辅助功能，Wayland 可能需要系统授权。') }}</p>
        </template>
        <template v-if="state.running">
          <p>{{ t(state.active ? '键鼠当前在这台电脑' : '键鼠当前在另一台电脑') }}</p>
          <div class="sharing-shortcuts"><span><kbd>Ctrl + Shift + F8</kbd>{{ t('回到发送端') }}</span><span><kbd>Ctrl + Shift + F9</kbd>{{ t('切到接收端') }}</span></div>
          <p v-if="!state.connected" class="privacy-note">{{ t('尚未连接：请在另一台电脑也开启共享，并检查 IP、防火墙和配对信息。') }}</p>
          <button class="secondary-button" :disabled="pending" @click="stop">{{ t('停止键鼠共享') }}</button>
        </template>
        <p v-else-if="compact">{{ t('请在设置页面开启两台电脑的键鼠共享。') }}</p>
        <p v-if="state.lastError" class="message danger">{{ diagnostic(state.lastError) }}</p>
        <p v-if="state.displayMessage" class="message warning">{{ diagnostic(state.displayMessage) }}</p>
      </template>
      <p v-if="error" class="message danger" role="alert">{{ diagnostic(error) }}</p>
    </template>
  </section>
</template>
