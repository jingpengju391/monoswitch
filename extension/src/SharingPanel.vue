<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { ComputerProfile, HostStatus, SharingIdentity, SharingStatus } from '../../shared/protocol'
import { demoMode, request } from './bridge'
import { t, diagnostic } from './i18n'
import Icon from './Icon.vue'
import CopyButton from './CopyButton.vue'

const props = defineProps<{ host: HostStatus; profile: ComputerProfile | null }>()
const emit = defineEmits<{ identity: [SharingIdentity | null]; upgrade: []; running: [boolean] }>()
const state = ref<SharingStatus | null>(null)
const pending = ref(false)
const error = ref('')
const unsupported = ref(false)
const code = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
function apply(value: SharingStatus) {
  state.value = value
  emit('identity', value.identity)
  emit('running', value.running)
}
async function refresh() {
  clearTimeout(timer)
  if (disposed || demoMode) return
  if (pending.value) { timer = setTimeout(refresh, 2000); return }
  try {
    const response = await request<SharingStatus>({ action: 'sharingStatus' })
    if (disposed) return
    if (response.ok && typeof response.data.installed === 'boolean') {
      apply(response.data)
      unsupported.value = false
    } else if (!response.ok) {
      unsupported.value = response.error.code === 'INVALID_REQUEST'
      error.value = response.error.message
    }
  } catch { if (!disposed) error.value = '无法读取键鼠共享状态，请重试。' }
  finally { if (!disposed && !unsupported.value) timer = setTimeout(refresh, 2000) }
}
async function run(action: 'sharingInstall' | 'sharingStop' | 'sharingPairHost' | 'sharingPairJoin') {
  if (pending.value) return
  pending.value = true; error.value = ''
  try {
    const message = action === 'sharingPairHost' || action === 'sharingPairJoin'
      ? { action, profile: props.profile!, ...(action === 'sharingPairJoin' ? { code: code.value.trim() } : {}) }
      : { action }
    if ((action === 'sharingPairHost' || action === 'sharingPairJoin') && !props.profile) throw new Error('请先选择本机显示器和输入接口。')
    const response = await request<SharingStatus>(message as Parameters<typeof request>[0], true)
    if (!response.ok) {
      if (response.error.code === 'INVALID_REQUEST') unsupported.value = true
      throw new Error(response.error.message)
    }
    apply(response.data)
  } catch (e) { error.value = e instanceof Error ? e.message : '无法启动键鼠共享。' }
  finally { pending.value = false }
}
onMounted(() => void refresh())
onUnmounted(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <section class="panel sharing-panel" :class="{ 'sharing-connected': state?.connected }" :aria-label="t('键盘与鼠标共享')">
    <div class="panel-heading">
      <Icon name="link" :size="22" />
      <div><h2>{{ t('键盘与鼠标共享') }}</h2><p>{{ t('点击切换电脑，画面和键鼠一起过去') }}</p></div>
      <span class="tag" :class="{ green: state?.connected }">{{ t(state?.connected ? '已连接，可以切换' : state?.running ? '尚未连通' : '未开启') }}</span>
    </div>
    <p v-if="demoMode">{{ t('演示模式不会启动键鼠共享。') }}</p>
    <template v-else-if="unsupported">
      <p>{{ t('需要更新本地组件才能使用键鼠共享。') }}</p>
      <button class="secondary-button" @click="emit('upgrade')">{{ t('更新本地组件') }}</button>
    </template>
    <template v-else-if="state">
      <template v-if="state.running">
        <template v-if="!state.connected">
          <p>{{ t('尚未建立键鼠连接。请保持两台 Chrome 运行；若此前手动配置未连通，停止后使用下面的一次性配对。') }}</p>
          <p>{{ t(state.role === 'server' ? '本机是发送端，正在等待接收端连接。' : '本机是接收端，正在连接发送端。') }}</p>
        </template>
        <details class="sharing-management" :open="!state.connected"><summary>{{ t('连接管理') }}</summary><p class="privacy-note">{{ t('配对后随 Chrome 启动自动连接；主动停止会关闭自动连接。发送端不能休眠。') }}</p><button class="secondary-button" :disabled="pending" @click="run('sharingStop')">{{ t('停止键鼠共享') }}</button></details>
      </template>
      <template v-else>
        <div v-if="!state.installed" class="message warning sharing-install">
          <p>{{ t('需要 Deskflow 1.26 或更新版本作为键鼠组件。') }}</p>
          <button v-if="host.platform.os === 'linux'" class="secondary-button" :disabled="pending" @click="run('sharingInstall')">{{ t(pending ? '等待系统授权或安装完成…' : '安装键鼠组件') }}</button>
          <a v-else href="https://github.com/deskflow/deskflow/releases" target="_blank" rel="noreferrer">{{ t('下载官方键鼠组件') }}</a>
          <button class="text-button" :disabled="pending" @click="refresh">{{ t('重新检测') }}</button>
        </div>
        <p v-if="!profile" class="message warning">{{ t('请先在上方选择本机显示器和实际连接的输入接口。无需手动交换对端配置。') }}</p>
        <template v-if="state.pairingCode">
          <h3>{{ t('等待另一台输入配对码') }}</h3>
          <p>{{ t('把下面的配对码发送到 HDMI 那台电脑，在它的键鼠共享区域粘贴并连接。只需这一次，不用再把配置复制回来。') }}</p>
          <textarea :value="state.pairingCode" readonly rows="3" :aria-label="t('一次性配对码')" />
          <CopyButton :text="state.pairingCode" label="复制配对码"
            @start="error = ''" @error="error = '复制失败，请选中配对码手动复制。'" />
          <p class="privacy-note">{{ t('配对码五分钟有效，仅发给自己的另一台电脑。配对成功后两边会自动连接。') }}</p>
          <button class="text-button" :disabled="pending" @click="run('sharingStop')">{{ t('取消配对') }}</button>
        </template>
        <template v-else>
          <div class="sharing-fields">
            <div>
              <h3>{{ t('Type-C 连接的电脑') }}</h3>
              <p>{{ t('键鼠接在显示器上，由这台电脑共享出去。') }}</p>
              <button class="primary-button" :disabled="pending || !state.installed || !profile" @click="run('sharingPairHost')">{{ t('生成配对码') }}</button>
            </div>
            <div>
              <h3>{{ t('HDMI 连接的电脑') }}</h3>
              <p>{{ t('输入 Type-C 那台生成的配对码，自动完成双向配对。') }}</p>
              <textarea v-model="code" rows="3" maxlength="8192" :placeholder="t('粘贴 MS2. 开头的配对码')" :aria-label="t('另一台电脑的配对码')" />
              <button class="primary-button" :disabled="pending || !state.installed || !profile || !code.trim()" @click="run('sharingPairJoin')">{{ t(pending ? '正在连接…' : '连接并开启共享') }}</button>
            </div>
          </div>
          <p class="privacy-note">{{ t('键鼠直接插在电脑上时，在接着键鼠的电脑生成配对码。') }}</p>
        </template>
      </template>
      <p v-if="state.lastError" class="message danger">{{ diagnostic(state.lastError) }}</p>
      <p v-if="state.displayMessage" class="message warning">{{ diagnostic(state.displayMessage) }}</p>
    </template>
    <p v-if="error" class="message danger" role="alert">{{ diagnostic(error) }}</p>
  </section>
</template>
