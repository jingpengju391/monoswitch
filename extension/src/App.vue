<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type {
  ComputerProfile,
  SharingIdentity,
  HostStatus,
  SwitchResult,
} from '../../shared/protocol'
import Icon from './Icon.vue'
import CopyButton from './CopyButton.vue'
import SharingPanel from './SharingPanel.vue'
import { t, diagnostic, locale, setLocale } from './i18n'
import { platformLabel } from './profiles'
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

const popupMode = new URLSearchParams(location.search).get('popup') === '1'
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
const localReady = computed(() => Boolean(display.value && settings.value.localInput !== null))
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

const openingPopup = ref(false)
async function openSmallWindow(): Promise<void> {
  if (openingPopup.value) return
  openingPopup.value = true
  try {
    if (isExtension) {
      await settingsSync.flush()
      const current = await chrome.tabs.getCurrent()
      if (current?.id === undefined) throw new Error('No source tab')
      const result = await chrome.runtime.sendMessage({ type: 'open-toolbar-popup', tabId: current.id })
      if (!result?.ok) throw new Error('Could not open toolbar popup')
    } else {
      const url = new URL(location.href)
      url.searchParams.set('popup', '1')
      location.href = url.href
    }
  } catch {
    error.value = '无法打开小窗口，请点击浏览器工具栏中的 MonoSwitch 图标。'
  } finally { openingPopup.value = false }
}

function openFullPage(): void {
  if (isExtension) void chrome.runtime.openOptionsPage()
  else {
    const url = new URL(location.href)
    url.searchParams.delete('popup')
    url.searchParams.delete('window')
    location.href = url.href
  }
}

function openShortcuts(): void {
  if (isExtension)
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  else
    notice.value = '加载扩展后，在 chrome://extensions/shortcuts 中设置快捷键。'
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
  <div :class="['app', 'unified-page', { onboarding: showSetup, 'popup-page': popupMode }]">
    <div v-if="demoMode" class="demo-banner"><span class="demo-dot"></span>{{ t('演示模式 · 不会控制真实显示器') }}</div>
    <header class="app-header">
      <div class="brand"><span class="brand-mark"><Icon name="monitor" :size="23" /></span><span>MonoSwitch<span class="brand-period">.</span></span></div>
      <select class="language-select" aria-label="Language / 语言" :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value)">
        <option value="zh-CN">中文</option><option value="en">English</option>
      </select>
      <button v-if="popupMode" class="text-button view-toggle" @click="openFullPage"><Icon name="external" :size="18" />{{ t('打开完整页面') }}</button>
      <button v-else class="text-button view-toggle" :disabled="openingPopup" @click="openSmallWindow"><Icon name="minimize" :size="18" />{{ t('打开小窗口') }}</button>
    </header>
    <main>
      <div v-if="notice" class="message success" role="status"><Icon name="check" :size="17" /><span>{{ t(notice) }}</span><button class="dismiss" :aria-label="t('关闭提示')" @click="notice = ''"><Icon name="close" :size="14" /></button></div>
      <div v-if="error" class="message danger" role="alert"><Icon name="info" :size="17" /><span>{{ diagnostic(error) }}</span></div>
      <section v-if="showSetup" class="setup-card">
        <div class="setup-content">
          <span v-if="installerPlatform" class="installer-platform">{{ installerPlatform }}</span>
          <p class="section-kicker">{{ t(upgrading ? "更新或重新安装组件" : "首次设置 · 仅需一次") }}</p>
          <h2>{{ t(setupTitle) }}</h2>
          <p v-if="upgrading">{{ t("运行安装器即可更新，无需删除旧组件。完成后返回，原有配置会保留。") }}</p>
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
          <CopyButton v-if="linuxInstall && installCommand" :text="installCommand" label="复制安装命令"
            @start="installCopyError = ''; installCommandCopied = false"
            @copied="installCommandCopied = true; checkInstallation()"
            @error="installCopyError = '复制失败，请选中上方命令手动复制。'" />
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
            <button v-if="upgrading" class="text-button" @click="upgrading = false; stopPolling(); refresh()">{{ t("返回") }}</button>
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
          <details v-if="hostError" class="diagnostics"><summary>{{ t('连接详情') }}</summary><p>{{ diagnostic(hostError) }}</p></details>
        </div>
      </section>

      <template v-else-if="status">
        <section class="control-summary" :aria-label="t('电脑连接')">
          <div class="computer-pair">
            <div><span class="small-label">{{ t('本机') }}</span><strong>{{ localTitle }}</strong><small>{{ platformLabel(status.platform) }}</small></div>
            <Icon name="arrow" :size="20" />
            <div><span class="small-label">{{ t(settings.peer ? '对端' : '待连接') }}</span><strong>{{ settings.peer?.name || t('另一台电脑') }}</strong><small>{{ settings.peer ? platformLabel(settings.peer.platform) : t('首次配对后，自动连接') }}</small></div>
          </div>
          <div class="control-action">
          <label v-if="display?.inputDetection === 'standard' && settings.peer" class="confirmation"><input v-model="confirmed" type="checkbox" /><span>{{ t('我确认另一台电脑连接在') }}<strong>{{ t(peerLabel) }}</strong>{{ t('。显示器未报告可用接口。') }}</span></label>
          <button v-if="settings.peer && localReady" class="primary-button switch-button" :disabled="!!block || busy || refreshing" @click="switchComputer">
            <span>{{ t(busy ? '正在发送指令…' : `切换到 ${settings.peer.name}`) }}</span><Icon :name="busy ? 'refresh' : 'arrow'" :class="{ spinning: busy }" :size="19" />
          </button>
          <p class="action-hint">{{ t(settings.peer && localReady ? block || (sharingRunning ? '画面、鼠标和键盘一起切换' : '切换画面；键盘与鼠标保持独立。') : localReady ? '在下方完成一次配对，即可切换。' : '先选择这台电脑连接的显示器接口。') }}</p>
          </div>
          <div v-if="visibleOperation" :class="['message', visibleOperation.state === 'failed' ? 'danger' : 'success']" role="status">
            <Icon :name="visibleOperation.state === 'failed' ? 'info' : 'check'" :size="17" /><span>{{ diagnostic(visibleOperation.state === 'accepted' ? '切换指令已发送，尚未验证画面。可刷新读取当前输入。' : visibleOperation.state === 'pending' ? '上次操作正在发送，请刷新确认状态。' : visibleOperation.message) }}</span>
          </div>
        </section>
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


        <div class="workspace-grid" :class="{ 'setup-pending': !localReady && !sharingRunning }">
        <SharingPanel v-show="localReady || sharingRunning" :profile="ownProfile" :host="status"
          @identity="sharingIdentity = $event" @running="sharingRunning = $event" @upgrade="upgrading = true; checkInstallation()" />
          <div class="settings-stack">
        <details class="panel local-settings" :open="!localReady">
          <summary>{{ t(localReady ? '显示器与接口' : '选择本机接口') }}<span v-if="localReady">{{ display?.name }} · {{ t(inputLabel(display, settings.localInput)) }}</span></summary>
          <p class="privacy-note">{{ t('系统信息由本地服务自动识别') }}</p>
          <div class="field-pair">
            <label class="field"><span>{{ t('共用显示器') }}</span><select v-model="settings.displayId" @change="settings.localInput = null"><option value="" disabled>{{ t('请选择显示器') }}</option><option v-for="item in status.displays" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
            <label class="field"><span>{{ t('本机连接的接口') }}</span><select v-model="settings.localInput" :disabled="!display"><option :value="null" disabled>{{ t('按实际接线选择') }}</option><option v-for="source in display?.inputs" :key="source.value" :value="source.value">{{ source.label }} · {{ source.value }}</option></select></label>
          </div>
          <p v-if="!status.displays.length" class="message warning">{{ t('未检测到可控制的显示器，请确认接线与 DDC/CI 设置。') }}</p>
          <p class="privacy-note">{{ t('查看本机视频线插入显示器的哪个接口。') }}</p>
          <button class="text-button" :disabled="refreshing || busy" @click="refresh"><Icon name="refresh" :size="15" :class="{ spinning: refreshing }" />{{ t('刷新显示器状态') }}</button>
        </details>
        <div v-if="display?.warning" class="message warning">{{ diagnostic(display.warning) }}</div>
        <div v-if="sourceMismatch" class="message danger">{{ t('显示器序列号不一致。请确认两台电脑连接同一显示器后重新配对。') }}</div>
        <details class="panel advanced-options">
          <summary>{{ t('更多选项') }}</summary>
          <label class="field"><span>{{ t('电脑名称') }}</span><input v-model="settings.localName" :placeholder="status.platform.hostname" maxlength="60" /></label>
          <button v-if="!demoMode" class="secondary-button" @click="upgrading = true; checkInstallation()">{{ t('重新下载组件') }}</button>
          <p v-if="monitorUnverified" class="privacy-note">{{ t('缺少显示器序列号，无法核对是否为同一台显示器。请按实际接线确认。') }}</p>
          <button v-if="settings.peer && !sharingRunning" class="text-button" @click="settings.peer = null">{{ t('移除另一台电脑') }}</button>
        </details>
          </div>
        </div>
      </template>
    </main>
    <footer class="app-footer"><span class="footer-status"><i :class="{ connected: ready }"></i>{{ t(ready ? '本地连接' : '等待连接') }}</span><button class="shortcut" :title="t('设置键盘快捷键')" @click="openShortcuts">{{ t(shortcut) }}<Icon name="external" :size="12" /></button></footer>
  </div>
</template>
