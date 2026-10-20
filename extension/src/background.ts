import {
  HOST_NAME,
  type HostStatus,
  type NativeRequest,
  type NativeResponse,
  type SwitchResult,
  type SharingStatus,
  type SharingConfig,
  type PairedComputer,
} from '../../shared/protocol'
import {
  activeDisplay,
  readSettings,
  OPERATION_KEY,
  SETTINGS_KEY,
  switchBlock,
  type Operation,
} from './state'
import { REPAIR_KEY } from './system-setup'
import { createSharingConnection } from './sharing-connection'
import { validateProfile } from './profiles'
import { syncNames } from './name-sync'
import { openToolbarPopup } from './toolbar-popup'
const sharing = createSharingConnection()

const RESUME_KEY = 'monoswitch.sharingResume'
let pairTimer: ReturnType<typeof setTimeout> | undefined
let pairGeneration = 0
let sharingError = ''
function cancelPairing() { ++pairGeneration; clearTimeout(pairTimer) }
async function startPaired(paired: PairedComputer, role: 'server' | 'client'): Promise<NativeResponse<unknown>> {
  const peer = validateProfile(paired.peer)
  const settings = readSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY])
  if (!peer.sharing || !settings.displayId || settings.localInput === null) return failure('NOT_READY', '请先选择本机显示器和输入接口。')
  const config: SharingConfig = { role, peer: peer.sharing, address: paired.address, port: paired.port,
    followDisplay: true, displayId: settings.displayId, input: settings.localInput }
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, peer } })
  const result = await sharing.request({ action: 'sharingStart', config })
  if (result.ok) {
    await chrome.storage.local.set({ [RESUME_KEY]: config })
    await syncNames(result, sharing.request)
  }
  return result
}
async function awaitPair(generation: number, deadline: number) {
  if (generation !== pairGeneration || Date.now() > deadline) return
  try {
    const result = await sharing.request({ action: 'sharingStatus' }) as NativeResponse<SharingStatus>
    if (generation !== pairGeneration || !result.ok) return
    if (result.data.paired) {
      const started = await startPaired(result.data.paired, 'server')
      if (!started.ok) { sharingError = started.error.message; await operation('failed', sharingError) }
      return
    }
    if (result.data.pairingCode) pairTimer = setTimeout(() => void awaitPair(generation, deadline), 1000)
  } catch { await operation('failed', '自动配对未完成，请重新生成配对码。') }
}
async function pair(request: Extract<NativeRequest, { action: 'sharingPairHost' | 'sharingPairJoin' }>) {
  await resumed
  sharingError = ''
  cancelPairing()
  const generation = pairGeneration
  await chrome.storage.local.remove(RESUME_KEY)
  const result = await sharing.request(request)
  if (generation !== pairGeneration) return failure('PAIRING_CHANGED', '配对已在另一窗口更新，请重新检测。')
  if (!result.ok) return result
  if (request.action === 'sharingPairJoin') return startPaired(result.data as PairedComputer, 'client')
  pairTimer = setTimeout(() => void awaitPair(generation, Date.now() + 300_000), 1000)
  return result
}
// Explicitly stopping revokes resume. Only a successfully authorized pairing is resumed.
async function resumeSharing() {
  try {
    if (sharing.connected()) return
    const config = (await chrome.storage.local.get(RESUME_KEY))[RESUME_KEY] as SharingConfig | undefined
    if (!config) return
    const settings = readSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY])
    if (settings.peer?.sharing?.fingerprint !== config.peer.fingerprint) return
    const result = await sharing.request({ action: 'sharingStart', config: { ...config,
      displayId: settings.displayId, input: settings.localInput ?? 0 } })
    if (!result.ok) { sharingError = result.error.message; await operation('failed', sharingError) }
    else await syncNames(result, sharing.request)
  } catch { /* A later explicit pairing can replace invalid saved configuration. */ }
}
const resumed = resumeSharing()
chrome.runtime.onStartup?.addListener(() => { void resumed.then(resumeSharing) })
chrome.storage.onChanged?.addListener((changes, area) => {
  const changed = changes[SETTINGS_KEY]
  if (area !== 'local' || !changed || readSettings(changed.oldValue).localName === readSettings(changed.newValue).localName) return
  void resumed.then(async () => {
    if (sharing.connected()) await syncNames(await sharing.request({ action: 'sharingStatus' }), sharing.request)
  }).catch(() => {})
})

let busy = false
let repairing = false

function repairNative(action: 'repair' | 'sharingInstall' = 'repair'): Promise<NativeResponse<HostStatus>> {
  return new Promise(resolve => {
    // Keep the worker alive while the user authorizes and packages install.
    const port = chrome.runtime.connectNative(HOST_NAME)
    let finished = false
    const finish = (response: NativeResponse<HostStatus>) => {
      if (finished) return
      finished = true
      resolve(response)
      port.disconnect()
    }
    port.onMessage.addListener(finish)
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError
      finish(failure('SETUP_DISCONNECTED', error?.message || '配置连接已断开，请重新检测系统状态。'))
    })
    try {
      port.postMessage({ action })
    } catch {
      finish(failure('SETUP_DISCONNECTED', '无法向本地组件发送配置请求。'))
    }
  })
}

async function repairSystem(): Promise<NativeResponse<HostStatus>> {
  if (busy) return failure('BUSY', '已有操作正在进行，请稍后再试。')
  busy = true
  repairing = true
  let result: NativeResponse<HostStatus>
  try {
    await chrome.storage.local.set({ [REPAIR_KEY]: { running: true, failed: false, message: '等待系统授权或安装完成，关闭此页面也会继续。' } })
    result = await repairNative()
  } catch {
    result = failure('SETUP_FAILED', '无法启动自动配置，请重新加载扩展后重试。')
  }
  await chrome.storage.local.set({ [REPAIR_KEY]: {
    running: false,
    failed: !result.ok,
    message: result.ok ? '系统配置完成，已重新检测显示器。' : result.error.message,
  } }).catch(() => {})
  busy = false
  repairing = false
  return result
}

function failure(code: string, message: string): NativeResponse<never> {
  return { ok: false, error: { code, message } }
}

function native<T>(request: NativeRequest): Promise<NativeResponse<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(
      HOST_NAME,
      request,
      (response: NativeResponse<T> | undefined) => {
        const error = chrome.runtime.lastError
        resolve(
          error
            ? failure('HOST_UNAVAILABLE', error.message || '无法连接本地服务。')
            : (response ?? failure('EMPTY_RESPONSE', '本地服务没有返回结果。')),
        )
      },
    )
  })
}

async function operation(
  state: Operation['state'],
  message: string,
): Promise<void> {
  await chrome.storage.local.set({
    [OPERATION_KEY]: {
      state,
      message,
      timestamp: Date.now(),
    } satisfies Operation,
  })
}

async function switchPeer(
  confirmed: boolean,
  expected?: Extract<NativeRequest, { action: 'switch' }>,
): Promise<NativeResponse<SwitchResult>> {
  if (busy) return failure('BUSY', '正在切换，请稍后再试。')
  busy = true
  try {
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]
    const settings = readSettings(stored)
    const response = await native<HostStatus>({ action: 'status' })
    if (!response.ok) {
      await operation('failed', response.error.message)
      return response
    }
    const blocked = switchBlock(response.data, settings, confirmed)
    if (blocked) {
      await operation('failed', blocked)
      return failure('NOT_READY', blocked)
    }
    const display = activeDisplay(response.data, settings)!
    const input = settings.peer!.input
    if (
      expected &&
      (expected.displayId !== display.id || expected.input !== input)
    )
      return failure('SETTINGS_CHANGED', '配置已更新，请刷新后重试。')
    await resumed
    const resume = (await chrome.storage.local.get(RESUME_KEY))[RESUME_KEY]
    if (resume && !sharing.connected()) await resumeSharing()
    if (resume && !sharing.connected()) return failure('NOT_READY', '键鼠共享未能启动，未切换画面。请在设置页重新连接。')
    if (sharing.connected()) {
      const shared = await sharing.request({ action: 'sharingStatus' }) as NativeResponse<SharingStatus>
      if (!shared.ok) return shared
      if (!shared.data.running && resume) return failure('NOT_READY', '键鼠共享未能启动，未切换画面。请在设置页重新连接。')
      if (shared.data.running) {
        const focus = await sharing.request({ action: 'sharingSwitch' }) as NativeResponse<SwitchResult>
        if (!focus.ok) { await operation('failed', focus.error.message); return focus }
      }
    }
    await operation('pending', '正在向显示器发送切换指令…')
    const result = await native<SwitchResult>({
      action: 'switch',
      displayId: display.id,
      input,
    })
    await operation(
      result.ok && result.data.accepted ? 'accepted' : 'failed',
      result.ok ? result.data.message : result.error.message,
    )
    return result
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '切换失败，请刷新后重试。'
    await operation('failed', message)
    return failure('SWITCH_FAILED', message)
  } finally {
    busy = false
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      !message ||
      typeof message !== 'object'
    )
      return false
    const data = message as {
      type?: string
      tabId?: number
      request?: NativeRequest
      confirmed?: boolean
    }
    if (data.type === 'open-toolbar-popup') {
      if (!Number.isInteger(data.tabId)) return false
      void openToolbarPopup(data.tabId!).then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }))
      return true
    }
    if (data.type === 'system-setup-state') {
      sendResponse({ running: repairing })
      return false
    }
    if (data.type !== 'native' || !data.request) return false
    if ((data.request.action === 'sharingPairHost' || data.request.action === 'sharingPairJoin') && data.confirmed === true) {
      void pair(data.request).then(sendResponse).catch(() => sendResponse(failure('PAIRING_FAILED', '自动配对未完成，请重新生成配对码。')))
    } else if (data.request.action === 'sharingStatus') {
      void resumed.then(() => sharing.connected() ? sharing.request(data.request!) : native(data.request!)).then(async result => {
        await syncNames(result, sharing.request)
        if (result.ok && sharingError) sendResponse({ ...result, data: { ...(result.data as SharingStatus), lastError: sharingError } })
        else sendResponse(result)
      }).catch(() => sendResponse(failure('SHARING_DISCONNECTED', '无法读取键鼠共享状态，请重试。')))
    } else if (data.request.action === 'sharingIdentity' && data.confirmed === true) {
      void native(data.request).then(sendResponse)
    } else if (data.request.action === 'sharingInstall' && data.confirmed === true) {
      void repairNative('sharingInstall').then(sendResponse).catch(() => sendResponse(failure('SETUP_FAILED', '无法启动自动配置，请重新加载扩展后重试。')))
    } else if ((data.request.action === 'sharingStart' || data.request.action === 'sharingStop') && data.confirmed === true) {
      if (data.request.action === 'sharingStop') { sharingError = ''; cancelPairing(); void chrome.storage.local.remove(RESUME_KEY) }
      void sharing.request(data.request).then(sendResponse)
    } else if (data.request.action === 'status') {
      void native<HostStatus>({ action: 'status' }).then(sendResponse)
    } else if (data.request.action === 'repair' && data.confirmed === true) {
      void repairSystem().then(sendResponse)
    } else if (
      data.request.action === 'switch' &&
      typeof data.request.displayId === 'string' &&
      Number.isInteger(data.request.input)
    ) {
      void switchPeer(data.confirmed === true, data.request).then(sendResponse)
    } else {
      sendResponse(failure('INVALID_REQUEST', '请求格式不正确。'))
    }
    return true
  },
)

chrome.commands.onCommand.addListener((command) => {
  // A shortcut cannot confirm unreported monitor inputs; use the full page for those.
  if (command === 'switch-peer') void switchPeer(false)
})

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage()
})
