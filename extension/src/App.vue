<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type {
  ComputerProfile,
  SharingIdentity,
  HostStatus,
  SwitchResult,
} from '../../shared/protocol'
import Icon from './Icon.vue'
import SharingPanel from './SharingPanel.vue'
import { t, diagnostic, locale, setLocale } from './i18n'
import { decodeProfile, encodeProfile, platformLabel } from './profiles'
import {
  activeDisplay,
  inputLabel,
  OPERATION_KEY,
  SETTINGS_KEY,
  readOperation,
  switchBlock,
  type Operation,
} from './state'
import {
  demoMode,
  demoSettings,
  demoStatus,
  isExtension,
  loadOperation,
  loadSettings,
  request,
  saveSettings,
} from './bridge'
import { platformTarget, selectInstaller, type Installer } from './installers'
import { createSettingsSync } from './settings-sync'
import { createInstallerDownload } from './installer-download'
import { REPAIR_KEY, readRepairProgress } from './system-setup'

const settingsPage =
  new URLSearchParams(location.search).get('settings') === '1'
const status = ref<HostStatus | null>(null)
const sharingIdentity = ref<SharingIdentity | null>(null)
const sharingRunning = ref(false)
const busy = ref(false)
const refreshing = ref(false)
const hostError = ref('')
const notice = ref('')
const error = ref('')
const repairProgress = ref(readRepairProgress(null))
const upgrading = ref(false)
const showSetup = computed(() => !status.value || upgrading.value)
const settingsSync = createSettingsSync(saveSettings, () => {
  error.value = '配置保存失败，请重试。'
})
const { settings } = settingsSync
const profileText = ref('')
const profileError = ref('')
const confirmed = ref(false)
const latest = ref<Operation | null>(null)
const shortcut = ref('Alt + Shift + M')
const installer = ref<Installer | null>(null)
const installerPlatform = ref('')
const installerError = ref('')
const installerDownload = shallowRef<ReturnType<
  typeof createInstallerDownload
> | null>(null)
const preparingInstaller = ref(isExtension)
const installerOpened = ref(false)
const installCommandCopied = ref(false)
const installCopyError = ref('')
const waitingForInstall = ref(false)
const installTimedOut = ref(false)
let disposed = false
let pollTimer: ReturnType<typeof setInterval> | undefined
const downloadState = computed(() =>
  installerDownload.value?.state.value ?? { phase: 'idle', id: null, error: '' },
)
const downloadReady = computed(() => downloadState.value.phase === 'ready')
const downloading = computed(() => downloadState.value.phase === 'downloading')
const linuxInstall = computed(() => downloadReady.value && installer.value?.os === 'linux' && installer.value.file.endsWith('.run'))
const archiveInstaller = computed(() => installer.value?.file.endsWith('.zip') === true)
const installCommand = computed(() => installerDownload.value?.installCommand.value ?? '')
const installStep = computed(() =>
  downloadReady.value ? 2 : 1,
)
const installSteps = computed(() => [
  '下载组件',
  archiveInstaller.value ? '解压并打开' : installer.value?.os === 'linux' ? '运行安装' : '打开安装器',
  '自动连接',
])
const setupTitle = computed(() => {
  if (linuxInstall.value) return '组件已下载，还需安装'
  if (installerOpened.value) return '安装完成后，自动连接'
  if (downloadReady.value)
    return archiveInstaller.value
      ? '解压后，打开安装器'
      : '组件已下载，继续安装'
  if (downloading.value) return '正在下载连接组件'
  return '连接你的显示器'
})
const display = computed(() => activeDisplay(status.value, settings.value))
const ready = computed(() => Boolean(status.value?.backend.available))
const block = computed(() =>
  switchBlock(status.value, settings.value, confirmed.value),
)
const localTitle = computed(
  () =>
    settings.value.localName.trim() ||
    status.value?.platform.hostname ||
    '这台电脑',
)
const currentLabel = computed(() =>
  inputLabel(display.value, display.value?.currentInput),
)
const peerLabel = computed(() =>
  inputLabel(display.value, settings.value.peer?.input),
)
const monitorUnverified = computed(
  () =>
    settings.value.peer &&
    (!display.value?.serial || !settings.value.peer.monitor.serial),
)
const sourceMismatch = computed(
  () =>
    display.value?.serial &&
    settings.value.peer?.monitor.serial &&
    display.value.serial !== settings.value.peer.monitor.serial,
)
const ownProfile = computed<ComputerProfile | null>(() => {
  if (
    !status.value ||
    !display.value ||
    settings.value.localInput === null ||
    !localTitle.value.trim()
  )
    return null
  return {
    version: 1,
    name: localTitle.value.trim(),
    ...(sharingIdentity.value ? { sharing: sharingIdentity.value } : {}),
    platform: status.value.platform,
    input: settings.value.localInput,
    monitor: {
      name: display.value.name,
      ...(display.value.serial ? { serial: display.value.serial } : {}),
    },
  }
})
const exportText = computed(() => {
  if (!ownProfile.value) return ''
  try {
    return encodeProfile(ownProfile.value)
  } catch {
    return ''
  }
})
const visibleOperation = computed(() =>
  latest.value && Date.now() - latest.value.timestamp < 10 * 60 * 1000
    ? latest.value
    : null,
)

async function refresh(): Promise<void> {
  if (refreshing.value || busy.value) return
  refreshing.value = true
  hostError.value = ''
  error.value = ''
  try {
    const response = demoMode
      ? { ok: true as const, data: structuredClone(demoStatus) }
      : await request<HostStatus>({ action: 'status' })
    if (!response.ok) {
      status.value = null
      hostError.value = response.error.message
      return
    }
    status.value = response.data
    if (waitingForInstall.value && !upgrading.value) notice.value = '本地组件已连接，可以继续设置显示器。'
    if (!upgrading.value) stopPolling()
    if (!settings.value.displayId && response.data.displays.length === 1)
      settings.value.displayId = response.data.displays[0]!.id
  } catch (cause) {
    status.value = null
    hostError.value =
      cause instanceof Error ? cause.message : '本地服务暂时没有响应。'
  } finally {
    refreshing.value = false
  }
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
  waitingForInstall.value = false
}

async function repairSystem(): Promise<void> {
  if (repairProgress.value.running || busy.value || demoMode) return
  repairProgress.value = { running: true, failed: false, message: '请完成系统授权，随后自动配置并检测。' }
  try {
    const result = await request<HostStatus>({ action: 'repair' }, true)
    if (!result.ok) {
      repairProgress.value = { running: false, failed: true, message: result.error.message }
      return
    }
    status.value = result.data
    repairProgress.value = { running: false, failed: false, message: '系统配置完成，已重新检测显示器。' }
    if (!settings.value.displayId && result.data.displays.length === 1)
      settings.value.displayId = result.data.displays[0]!.id
  } catch {
    repairProgress.value = { running: false, failed: true, message: '配置连接中断，请重新检测后再试。' }
  }
}

function checkInstallation(): void {
  stopPolling()
  installTimedOut.value = false
  if (upgrading.value) { void refresh(); return }
  if (status.value) return
  waitingForInstall.value = true
  void refresh()
  const deadline = Date.now() + 600_000
  pollTimer = setInterval(() => {
    if (Date.now() > deadline || (status.value && !upgrading.value)) {
      installTimedOut.value = !status.value || upgrading.value
      stopPolling()
      return
    }
    void refresh()
  }, 3000)
}

function downloadInstaller(): void {
  void installerDownload.value?.download()
}

async function copyInstallCommand(): Promise<void> {
  if (!installCommand.value) return
  installCopyError.value = ''
  try {
    await navigator.clipboard.writeText(installCommand.value)
    if (disposed) return
    installCommandCopied.value = true
    checkInstallation()
  } catch {
    if (!disposed) installCopyError.value = '复制失败，请选中上方命令手动复制。'
  }
}

function openInstaller(): void {
  // Invoke immediately inside the click handler to retain Chrome's user gesture.
  const opened = installerDownload.value?.open()
  if (opened)
    void opened.then((success) => {
      if (success && !disposed) {
        installerOpened.value = true
        checkInstallation()
      }
    })
}

watch(
  () => downloadState.value.phase,
  (phase) => {
    installerOpened.value = false
    installCommandCopied.value = false
    installCopyError.value = ''
    installTimedOut.value = false
    if (phase === 'ready') checkInstallation()
    else stopPolling()
  },
)

async function prepareInstaller(): Promise<void> {
  if (!isExtension) return
  try {
    const platform = await chrome.runtime.getPlatformInfo()
    const target = platformTarget(platform)
    installerPlatform.value = target
      ? `${{ windows: 'Windows', macos: 'macOS', linux: 'Linux' }[target.os]} · ${target.arch === 'aarch64' ? 'ARM64' : 'x64'}`
      : `${platform.os} · ${platform.arch}`
    const response = await fetch(
      chrome.runtime.getURL('installers/catalog.json'),
    )
    if (response.ok) {
      const catalog: unknown = await response.json()
      if (disposed) return
      installer.value = selectInstaller(
        catalog,
        platform,
        chrome.runtime.id,
        chrome.runtime.getManifest().version,
      )
      if (installer.value) {
        installerDownload.value = createInstallerDownload(installer.value)
        await installerDownload.value.restore()
      }
    }
  } catch {
    installer.value = null
    installerError.value = '无法准备安装器，请在 chrome://extensions 重新加载 MonoSwitch 后重试。'
  } finally {
    preparingInstaller.value = false
  }
}

async function switchComputer(): Promise<void> {
  if (block.value || busy.value || !display.value || !settings.value.peer)
    return
  if (demoMode) {
    notice.value = '这是界面演示，没有发送显示器切换指令。'
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  const target = {
    action: 'switch' as const,
    displayId: display.value.id,
    input: settings.value.peer.input,
  }
  const targetConfirmed = confirmed.value
  try {
    await settingsSync.flush()
    settingsSync.applyStored(await loadSettings())
    if (
      settings.value.displayId !== target.displayId ||
      settings.value.peer?.input !== target.input
    ) {
      error.value = '配置已在其他页面更新，请确认目标电脑后重试。'
      return
    }
    const response = await request<SwitchResult>(target, targetConfirmed)
    if (!response.ok) {
      error.value = response.error.message
      return
    }
    if (!response.data.accepted) {
      error.value = response.data.message
      return
    }
    latest.value = {
      state: 'accepted',
      message: response.data.message,
      timestamp: Date.now(),
    }
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : '发送失败，请稍后再试。'
  } finally {
    busy.value = false
  }
}

function openSettings(): void {
  if (isExtension) void chrome.runtime.openOptionsPage()
  else location.search = demoMode ? '?settings=1&demo=1' : '?settings=1'
}

function openPopup(): void {
  location.search = demoMode ? '?demo=1' : ''
}
function openShortcuts(): void {
  if (isExtension)
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  else
    notice.value = '加载扩展后，在 chrome://extensions/shortcuts 中设置快捷键。'
}

async function copyProfile(): Promise<void> {
  try {
    await navigator.clipboard.writeText(exportText.value)
    notice.value = '本机配置已复制，可粘贴到另一台电脑。'
  } catch {
    notice.value = '请选中下方配置文本并手动复制。'
  }
}

function importProfile(): void {
  profileError.value = ''
  try {
    settings.value.peer = decodeProfile(profileText.value)
    profileText.value = ''
    notice.value = '另一台电脑已添加，配置自动保存在本机。'
  } catch (cause) {
    profileError.value = cause instanceof Error ? cause.message : '配置无效。'
  }
}

function onStorage(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  if (area === 'local' && changes[SETTINGS_KEY])
    settingsSync.applyStored(changes[SETTINGS_KEY].newValue)
  if (area === 'local' && changes[OPERATION_KEY])
    latest.value = readOperation(changes[OPERATION_KEY].newValue)
  if (area === 'local' && changes[REPAIR_KEY]) {
    const wasRunning = repairProgress.value.running
    repairProgress.value = readRepairProgress(changes[REPAIR_KEY].newValue)
    if (wasRunning && !repairProgress.value.running && !repairProgress.value.failed) void refresh()
  }
}

watch(
  () => [
    settings.value.displayId,
    settings.value.localInput,
    settings.value.peer?.input,
    settings.value.peer?.name,
  ],
  () => {
    confirmed.value = false
  },
)

onMounted(async () => {
  try {
    const savedSettings = demoMode
      ? structuredClone(demoSettings)
      : await loadSettings()
    settingsSync.initialize(savedSettings)
    latest.value = await loadOperation()
    if (isExtension) {
      chrome.storage.onChanged.addListener(onStorage)
      const progress = await chrome.runtime.sendMessage({ type: 'system-setup-state' })
      repairProgress.value = readRepairProgress(progress)
      const commands = await chrome.commands.getAll()
      shortcut.value =
        commands.find((command) => command.name === 'switch-peer')?.shortcut ||
        '尚未设置快捷键'
      void prepareInstaller()
    }
  } catch {
    settingsSync.initialize(settings.value)
    error.value = '无法读取配置，请重新设置。'
  }
  await refresh()
})
onUnmounted(() => {
  disposed = true
  stopPolling()
  installerDownload.value?.dispose()
  settingsSync.stop()
  if (isExtension) chrome.storage.onChanged.removeListener(onStorage)
})
</script>

<template>
  <div :class="['app', { 'settings-page': settingsPage, onboarding: showSetup }]">
    <div v-if="demoMode" class="demo-banner">
      <span class="demo-dot"></span>{{ t("演示模式 · 不会控制真实显示器") }}</div>
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark"><Icon name="monitor" :size="23" /></span
        ><span>MonoSwitch<span class="brand-period">.</span></span>
      </div>
      <select class="language-select" aria-label="Language / 语言" :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value)">
        <option value="zh-CN">中文</option>
        <option value="en">English</option>
      </select>
      <button
        v-if="!settingsPage"
        class="icon-button"
        :aria-label='t("打开设置")'
        :title='t("设置")'
        @click="openSettings"
      >
        <Icon name="settings" />
      </button>
      <button v-else class="text-button" @click="openPopup">{{ t("返回控制台") }}<Icon name="arrow" :size="16" />
      </button>
    </header>

    <main>
      <div :class="['intro', { 'settings-intro': settingsPage }]">
        <p class="eyebrow">
          {{ t(settingsPage ? 'YOUR SETUP' : 'ONE DISPLAY. TWO WORLDS.') }}
        </p>
        <h1>
          {{ t(!status ? '完成首次连接。' : settingsPage ? '让两台电脑，默契配合。' : '一屏，两台电脑。') }}
        </h1>
        <p class="intro-description">
          {{
            t(!status
              ? '为这台电脑安装连接组件，之后在浏览器中轻松切换。'
              : settingsPage
              ? '选好接口，交换配置。下次切换，只需轻轻一点。'
              : '专注眼前，随时切换。')
          }}
        </p>
      </div>

      <div v-if="notice" class="message success" role="status">
        <Icon name="check" :size="17" /><span>{{ t(notice) }}</span
        ><button class="dismiss" :aria-label='t("关闭提示")' @click="notice = ''">
          <Icon name="close" :size="14" />
        </button>
      </div>
      <div v-if="error" class="message danger" role="alert">
        <Icon name="info" :size="17" /><span>{{ diagnostic(error) }}</span>
      </div>

      <section v-if="showSetup" class="setup-card">
        <aside class="setup-overview">
          <div class="setup-overview-heading">
            <span class="setup-icon"><Icon name="monitor" :size="28" /></span>
            <p class="section-kicker">{{ t("一块屏幕，自由切换") }}</p>
            <h2>{{ t("三步，准备就绪。") }}</h2>
            <p class="setup-overview-copy">{{ t("只需在每台电脑上设置一次。") }}</p>
          </div>
          <ol class="install-steps" :aria-label='t("安装进度")'>
            <li
              v-for="(label, index) in installSteps"
              :key="index"
              :class="{ active: installStep === index + 1, done: installStep > index + 1 }"
              :aria-current="installStep === index + 1 ? 'step' : undefined"
            >
              <span class="install-step-number">
                <Icon v-if="installStep > index + 1" name="check" :size="14" />
                <template v-else>{{ t(index + 1) }}</template>
              </span>
              <div>
                <strong>{{ t(label) }}</strong>
                <small>{{ t(['获取适合这台电脑的组件', '按照右侧指引完成安装', '连接成功后，开始设置显示器'][index]) }}</small>
              </div>
            </li>
          </ol>
          <span v-if="installerPlatform" class="installer-platform">
            <span class="platform-dot"></span>{{ installerPlatform }}
          </span>
        </aside>
        <div class="setup-content">
          <p class="section-kicker">{{ t(upgrading ? "更新或重新安装组件" : "首次设置 · 仅需一次") }}</p>
          <h2>{{ t(setupTitle) }}</h2>
          <p v-if="upgrading">{{ t("运行安装器即可更新，无需删除旧组件。完成后返回设置，原有配置会保留。") }}</p>
          <p v-if="linuxInstall && installCommand">{{ t("已下载 Install MonoSwitch.run。在文件属性中允许执行后双击，或复制下方命令运行；成功后安装器自动删除。") }}</p>
          <p v-else-if="linuxInstall">{{ t("在文件夹中找到安装器，在文件属性中允许执行，再双击运行。") }}</p>
          <p v-else-if="installerOpened && archiveInstaller">{{ t("解压后双击 Install MonoSwitch，按提示授权。成功后安装器会自动删除。") }}</p>
          <p v-else-if="installerOpened">{{ t("在系统窗口中完成安装，回到这里即可。") }}</p>
          <p v-else-if="downloadReady && archiveInstaller">{{ t("解压后双击 Install MonoSwitch，按提示授权。完成后自动连接并删除安装器。") }}</p>
          <p v-else-if="downloadReady">{{ t("点击下方按钮，按系统提示完成安装。") }}</p>
          <p v-else-if="downloading">{{ t("请稍候，下载完成后会显示安装步骤。") }}</p>
          <p v-else>{{ t("安装一个轻量连接组件，之后都在扩展中切换。") }}</p>
          <div v-if="downloadState.error" class="message danger install-error" role="alert">
            <Icon name="info" :size="17" /><span>{{ t(downloadState.error) }}</span>
          </div>
          <div v-if="linuxInstall && installCommand" class="install-command">
            <span>{{ t("仅首次安装需要 · 按需确认系统授权") }}</span>
            <code tabindex="0" :aria-label='t("Linux 安装命令")'>{{ installCommand }}</code>
          </div>
          <p v-if="installCopyError" class="message danger" role="alert">{{ t(installCopyError) }}</p>
          <button v-if="linuxInstall && installCommand" class="primary-button" @click="copyInstallCommand">
            {{ t(installCommandCopied ? '再次复制安装命令' : '复制安装命令') }}
            <Icon name="copy" :size="17" />
          </button>
          <button v-else-if="linuxInstall" class="primary-button" @click="installerDownload?.show()">{{ t("在文件夹中显示") }}<Icon name="external" :size="17" />
          </button>
          <button v-else-if="installer && downloadReady" class="primary-button" @click="openInstaller">
            {{ t(installerOpened ? '再次打开' : archiveInstaller ? '解压安装包' : '打开安装器') }}
            <Icon name="external" :size="17" />
          </button>
          <button v-else-if="installer" class="primary-button" :disabled="downloading || preparingInstaller" @click="downloadInstaller">
            <Icon v-if="downloading" name="refresh" :size="17" class="spinning" />
            {{ t(downloading ? '正在下载…' : ['interrupted', 'missing'].includes(downloadState.phase) ? '重新下载' : '下载组件') }}
            <Icon v-if="!downloading" name="arrow" :size="17" />
          </button>
          <p v-else-if="preparingInstaller" class="installer-unavailable" role="status">{{ t("正在准备安装包…") }}</p>
          <p
            v-else-if="!installer"
            class="installer-unavailable"
          >
            {{
              t(installerError || (isExtension
                ? '此扩展包尚未包含当前系统的安装器，请使用对应系统的完整发布包。'
                : '请先在 Chrome 中加载 MonoSwitch 扩展。'))
            }}
          </p>
          <div class="install-actions">
            <button v-if="installer && downloadReady" class="text-button" @click="installerDownload?.download(true)">{{ t("重新下载") }}</button>
            <button v-if="upgrading" class="text-button" @click="upgrading = false; stopPolling(); refresh()">{{ t("返回设置") }}</button>
            <button v-if="downloadReady && (!linuxInstall || installCommand)" class="text-button" @click="installerDownload?.show()">{{ t("在文件夹中显示") }}</button>
            <button class="text-button" :disabled="refreshing" @click="checkInstallation">
              {{ t(refreshing ? '检测中…' : downloadState.phase === 'idle' ? '已安装，重新检测' : '重新检测') }}
            </button>
          </div>
          <p v-if="installCommandCopied" class="install-copy-status" role="status">{{ t("已复制，请在终端粘贴并回车。复制命令不会自动安装。") }}</p>
          <p v-if="installTimedOut" class="installer-unavailable" role="status">{{ t("尚未检测到组件，完成安装后可点击“重新检测”。") }}</p>
          <p v-else-if="waitingForInstall && downloadReady" class="install-waiting" role="status">
            <span class="waiting-dot"></span>{{ t("正在等待组件连接，无需反复刷新") }}</p>
          <details v-if="linuxInstall" class="diagnostics install-help">
            <summary>{{ t("通过文件管理器安装") }}</summary>
            <p>{{ t("点击“在文件夹中显示”，在文件属性的权限页勾选“允许执行”，再双击安装器。若仍无法启动，请使用上方终端命令。") }}</p>
          </details>
          <details class="diagnostics">
            <summary>{{ t("连接详情与开发者安装") }}</summary>
            <p v-if="hostError">{{ diagnostic(hostError) }}</p>
            <p>{{ t("源码开发：在项目根目录执行") }}<code>npm run setup</code>{{ t("。普通用户请使用发布包中的安装器。") }}</p>
          </details>
        </div>
      </section>

      <template v-else-if="status">
        <section v-if="!demoMode && status.platform.os === 'linux' && (status.systemSetup?.needsRepair || !status.systemSetup || repairProgress.message || repairProgress.running)" class="panel system-setup-panel">
          <h2>{{ t(status.systemSetup ? '自动配置显示器控制' : '升级组件，启用自动配置') }}</h2>
          <p v-if="status.systemSetup?.needsRepair">{{ status.systemSetup.issues.map(t).join(locale === 'en' ? ', ' : '、') }}</p>
          <p v-else-if="!status.systemSetup">{{ t("新版安装器会自动检查依赖、启用系统接口并设置开机加载。") }}</p>
          <p>{{ t("系统可能要求确认管理员权限。完成后会自动检测显示器。") }}</p>
          <button v-if="!status.systemSetup" class="primary-button" @click="upgrading = true; checkInstallation()">{{ t("更新本地组件") }}</button>
          <button v-else-if="status.systemSetup.needsRepair" class="primary-button" :disabled="repairProgress.running || !status.systemSetup.canRepair || busy" @click="repairSystem">
            {{ t(repairProgress.running ? '正在自动配置…' : '自动配置') }}
          </button>
          <p v-if="status.systemSetup?.needsRepair && !status.systemSetup.canRepair">{{ t("当前系统无法使用图形授权，请在终端重新运行安装器。") }}</p>
          <p v-if="repairProgress.message" :class="['message', repairProgress.failed ? 'danger' : 'success']" :role="repairProgress.failed ? 'alert' : 'status'">{{ diagnostic(repairProgress.message) }}</p>
        </section>
        <div
          v-if="status.backend.hint || !ready"
          class="message warning"
          role="status"
        >
          <Icon name="info" :size="17" /><span>{{
            diagnostic(status.backend.hint || '本地服务已连接，显示器控制后端尚未就绪。')
          }}</span>
        </div>
        <div
          v-for="warning in status.warnings"
          :key="warning"
          class="message warning"
        >
          <Icon name="info" :size="17" /><span>{{ diagnostic(warning) }}</span>
        </div>

        <div v-if="settingsPage" class="settings-grid">
          <section class="panel">
            <div class="panel-heading">
              <span class="step-number">01</span>
              <div>
                <h2>{{ t("设置这台电脑") }}</h2>
                <p>{{ t("系统信息由本地服务自动识别") }}</p>
              </div>
            </div>
            <div class="system-strip">
              <Icon name="laptop" :size="21" />
              <div>
                <strong>{{ platformLabel(status.platform) }}</strong
                ><span
                  >{{ status.platform.arch }} ·
                  {{ status.platform.hostname }}</span
                >
              </div>
              <span class="tag green">{{ t("自动识别") }}</span>
            </div>
            <label class="field"
              ><span>{{ t("电脑名称") }}</span
              ><input
                v-model="settings.localName"
                :placeholder="status.platform.hostname"
                maxlength="60"
                autocomplete="off"
            /></label>
            <label class="field"
              ><span>{{ t("共用显示器") }}</span
              ><select
                v-model="settings.displayId"
                @change="settings.localInput = null"
              >
                <option value="" disabled>{{ t("请选择显示器") }}</option>
                <option
                  v-for="item in status.displays"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }}
                </option></select
              ><small v-if="status.displays.length === 0"
                >{{ t("未检测到可控制的显示器，请确认接线与 DDC/CI 设置。") }}</small
              ></label
            >
            <label class="field"
              ><span>{{ t("本机连接的接口") }}</span
              ><select v-model="settings.localInput" :disabled="!display">
                <option :value="null" disabled>{{ t("按实际接线选择") }}</option>
                <option
                  v-for="source in display?.inputs"
                  :key="source.value"
                  :value="source.value"
                >
                  {{ source.label }} · {{ t(source.value) }}
                </option></select
              ><small>{{ t("查看本机视频线插入显示器的哪个接口。") }}</small></label
            >
            <div
              v-if="display?.inputDetection === 'standard'"
              class="message warning compact"
            >
              <Icon name="info" :size="16" /><span
                >{{ t("显示器未报告接口列表。这里列出标准输入源，需按实际接线确认。") }}</span
              >
            </div>
            <details :open="demoMode"><summary>{{ t("仅切画面时，手动交换配置") }}</summary>
            <div class="export-box">
              <div class="export-heading">
                <h3>{{ t("本机配置") }}</h3>
                <button
                  class="text-button"
                  :disabled="!exportText"
                  @click="copyProfile"
                >
                  <Icon name="copy" :size="15" />{{ t("复制配置") }}</button>
              </div>
              <textarea
                :value="exportText"
                readonly
                rows="3"
                :aria-label='t("本机导出配置")'
                :placeholder='t("选择显示器与本机接口后，即可生成配置。")'
              />
              <p>{{ t("将这段配置粘贴到另一台电脑的 MonoSwitch。") }}</p>
            </div></details>
          </section>

          <section class="panel">
            <div class="panel-heading">
              <span class="step-number">02</span>
              <div>
                <h2>{{ t("连接另一台电脑") }}</h2>
                <p>{{ t("从另一台电脑导入它的配置") }}</p>
              </div>
            </div>
            <div v-if="settings.peer" class="peer-summary">
              <span class="device-icon"><Icon name="laptop" :size="24" /></span>
              <div>
                <strong>{{ settings.peer.name }}</strong
                ><span
                  >{{ platformLabel(settings.peer.platform) }} ·
                  {{ t(peerLabel) }}</span
                >
              </div>
              <button
                class="icon-button"
                :aria-label='t("移除另一台电脑")'
                :title='t("移除配置")'
                @click="settings.peer = null"
              >
                <Icon name="close" :size="16" />
              </button>
            </div>
            <div v-else class="pair-placeholder">
              <span class="pair-art"
                ><Icon name="laptop" :size="32" /><i></i
                ><Icon name="monitor" :size="32"
              /></span>
              <h3>{{ t("把另一台电脑带进来") }}</h3>
              <p>{{ t("使用下方键鼠共享的一次性配对，会自动添加另一台电脑。") }}</p>
            </div>
            <details :open="demoMode"><summary>{{ t("仅切画面时，手动交换配置") }}</summary>
            <label class="field"
              ><span>{{
                t(settings.peer ? '更新对端配置' : '另一台电脑的配置')
              }}</span
              ><textarea
                v-model="profileText"
                rows="5"
                maxlength="8192"
                spellcheck="false"
                :placeholder='t("粘贴以 MS1. 开头的配置…")'
              />
            </label>
            <p v-if="profileError" class="inline-error" role="alert">
              {{ t(profileError) }}
            </p>
            <button
              class="secondary-button"
              :disabled="!profileText.trim()"
              @click="importProfile"
            >
              <Icon name="link" :size="17" />{{
                t(settings.peer ? '更新配置' : '导入配置')
              }}
            </button>
            <p class="privacy-note">{{ t("系统信息来自对端导出的配置，无法通过视频线自动读取。配置含电脑名、系统和显示器信息，仅保存在本机。") }}</p></details>
          </section>
        </div>

        <template v-else>
          <section class="display-card">
            <div class="display-heading">
              <span class="small-label">{{ t("共用显示器") }}</span
              ><button
                class="icon-button small"
                :disabled="refreshing || busy"
                :aria-label='t("刷新显示器状态")'
                :title='t("刷新")'
                @click="refresh"
              >
                <Icon
                  name="refresh"
                  :size="16"
                  :class="{ spinning: refreshing }"
                />
              </button>
            </div>
            <div class="display-detail">
              <span class="display-icon"
                ><Icon name="monitor" :size="28"
              /></span>
              <div>
                <strong>{{ display?.name || t('请选择显示器') }}</strong
                ><span v-if="display?.currentInput != null"
                  >{{ t("当前输入") }}<b>{{ t(currentLabel) }}</b></span
                ><span v-else>{{
                  t(display
                    ? '当前输入暂不可读'
                    : `${status.displays.length} 台显示器已检测`)
                }}</span>
              </div>
              <span
                :class="['status-dot', { offline: !display?.canSwitch }]"
              ></span>
            </div>
          </section>
          <section class="devices" :aria-label='t("电脑连接")'>
            <div class="device-card local">
              <div class="device-top">
                <span class="device-icon"
                  ><Icon name="laptop" :size="23" /></span
                ><span class="tag green">{{ t("本机") }}</span>
              </div>
              <h2>{{ settings.localName.trim() || status.platform.hostname || t('这台电脑') }}</h2>
              <p>{{ platformLabel(status.platform) }}</p>
              <span class="input-tag">{{
                t(inputLabel(display, settings.localInput))
              }}</span>
            </div>
            <span class="connection-line"
              ><Icon name="arrow" :size="15"
            /></span>
            <div :class="['device-card', { unpaired: !settings.peer }]">
              <div class="device-top">
                <span class="device-icon"
                  ><Icon name="laptop" :size="23" /></span
                ><span class="tag">{{
                  t(settings.peer ? '对端' : '待添加')
                }}</span>
              </div>
              <h2>{{ settings.peer?.name || t('另一台电脑') }}</h2>
              <p>
                {{
                  t(settings.peer
                    ? platformLabel(settings.peer.platform)
                    : '导入配置后连接')
                }}
              </p>
              <span class="input-tag">{{ t(peerLabel) }}</span>
            </div>
          </section>
          <p v-if="settings.peer" class="source-note">{{ t("本机系统自动识别 · 对端系统来自导入配置") }}</p>
          <label
            v-if="display?.inputDetection === 'standard' && settings.peer"
            class="confirmation"
            ><input v-model="confirmed" type="checkbox" /><span
              >{{ t("我确认另一台电脑连接在") }}<strong>{{ t(peerLabel) }}</strong
              >{{ t("。显示器未报告可用接口。") }}</span
            ></label
          >
        </template>

        <div v-if="display?.warning" class="message warning">
          <Icon name="info" :size="17" /><span>{{ diagnostic(display.warning) }}</span>
        </div>
        <div v-if="sourceMismatch" class="message danger">
          <Icon name="info" :size="17" /><span
            >{{ t("显示器序列号不一致。请确认两台电脑连接同一显示器后重新导出配置。") }}</span
          >
        </div>
        <div v-else-if="monitorUnverified" class="message warning">
          <Icon name="info" :size="17" /><span
            >{{ t("缺少显示器序列号，无法核对是否为同一台显示器。请按实际接线确认。") }}</span
          >
        </div>

        <div v-if="!settingsPage" class="switch-section">
          <button
            v-if="!settings.peer || settings.localInput === null || !display"
            class="primary-button"
            @click="openSettings"
          >{{ t("完成连接设置") }}<Icon name="arrow" :size="18" />
          </button>
          <button
            v-else
            class="primary-button switch-button"
            :disabled="!!block || busy || refreshing"
            @click="switchComputer"
          >
            <span>{{
              t(busy ? '正在发送指令…' : `切换到 ${settings.peer.name}`)
            }}</span
            ><Icon
              :name="busy ? 'refresh' : 'arrow'"
              :class="{ spinning: busy }"
              :size="19"
            />
          </button>
          <p
            v-if="
              block && settings.peer && settings.localInput !== null && display
            "
            class="action-hint"
          >
            {{ t(block) }}
          </p>
          <p
            v-else-if="settings.peer && settings.localInput !== null"
            class="action-hint"
          >{{ t(sharingRunning ? '切换时，键盘和鼠标会一起切到另一台电脑。' : '切换画面；键盘与鼠标保持独立。') }}</p>
        </div>

        <div
          v-if="visibleOperation && !settingsPage"
          :class="[
            'message',
            visibleOperation.state === 'failed' ? 'danger' : 'success',
          ]"
          role="status"
        >
          <Icon
            :name="visibleOperation.state === 'failed' ? 'info' : 'check'"
            :size="17"
          /><span>{{
            diagnostic(visibleOperation.state === 'accepted'
              ? '切换指令已发送，尚未验证画面。可刷新读取当前输入。'
              : visibleOperation.state === 'pending'
                ? '上次操作正在发送，请刷新确认状态。'
                : visibleOperation.message)
          }}</span>
        </div>

        <SharingPanel :profile="ownProfile" :host="status" :settings="settings" :compact="!settingsPage"
          @identity="sharingIdentity = $event" @running="sharingRunning = $event"
          @upgrade="upgrading = true; checkInstallation()" />
        <section v-if="settingsPage && !demoMode" class="panel">
          <div class="export-heading">
            <h3>{{ t("本地组件") }}</h3>
            <button class="text-button" @click="upgrading = true; checkInstallation()">{{ t("重新下载组件") }}</button>
          </div>
          <p class="privacy-note">{{ t("更新或重新安装时使用，已有显示器和配对配置会保留。") }}</p>
        </section>
        <section v-if="settingsPage" class="setup-notes">
          <div>
            <Icon name="info" :size="19" />
            <p>{{ t("两台电脑分别连接显示器的不同视频接口，并开启显示器菜单中的 DDC/CI。返回另一台电脑时，在那台电脑使用同一个扩展。") }}</p>
          </div>
          <div>
            <Icon name="monitor" :size="19" />
            <p>{{ t("能否切换取决于显示器与视频链路。macOS 的兼容性还取决于硬件和控制后端，支持情况以本地检测结果为准。") }}</p>
          </div>
        </section>
      </template>
    </main>

    <footer class="app-footer">
      <span class="footer-status"
        ><i :class="{ connected: ready }"></i
        >{{ t(ready ? '本地连接' : '等待连接')
        }}<span v-if="settingsPage" class="saved-label">{{ t("· 设置自动保存") }}</span
        ></span
      ><button class="shortcut" :title='t("设置键盘快捷键")' @click="openShortcuts">
        {{ t(shortcut) }}<Icon name="external" :size="12" />
      </button>
    </footer>
  </div>
</template>
