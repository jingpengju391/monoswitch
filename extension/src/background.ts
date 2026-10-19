import {
  HOST_NAME,
  type HostStatus,
  type NativeRequest,
  type NativeResponse,
  type SwitchResult,
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

let busy = false
let repairing = false

function repairNative(): Promise<NativeResponse<HostStatus>> {
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
      port.postMessage({ action: 'repair' })
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
      request?: NativeRequest
      confirmed?: boolean
    }
    if (data.type === 'system-setup-state') {
      sendResponse({ running: repairing })
      return false
    }
    if (data.type !== 'native' || !data.request) return false
    if (data.request.action === 'status') {
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
  // A shortcut cannot confirm unreported monitor inputs; use the popup for those.
  if (command === 'switch-peer') void switchPeer(false)
})

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage()
})
