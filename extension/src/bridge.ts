import type {
  HostStatus,
  NativeRequest,
  NativeResponse,
  Settings,
} from '../../shared/protocol'
import {
  readSettings,
  readOperation,
  SETTINGS_KEY,
  OPERATION_KEY,
  type Operation,
} from './state'

export const isExtension =
  typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id)
export const demoMode =
  !isExtension && new URLSearchParams(location.search).get('demo') === '1'

export async function loadSettings(): Promise<Settings> {
  const stored = isExtension
    ? (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]
    : JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
  return readSettings(stored)
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (isExtension)
    await chrome.storage.local.set({
      [SETTINGS_KEY]: JSON.parse(JSON.stringify(settings)),
    })
  else localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export async function loadOperation(): Promise<Operation | null> {
  if (!isExtension) return null
  return readOperation(
    (await chrome.storage.local.get(OPERATION_KEY))[OPERATION_KEY],
  )
}

export function request<T>(
  request: NativeRequest,
  confirmed = false,
): Promise<NativeResponse<T>> {
  if (!isExtension)
    return Promise.resolve({
      ok: false,
      error: {
        code: 'HOST_UNAVAILABLE',
        message: '请在 Chrome 中加载扩展，并安装本地服务。',
      },
    })
  return chrome.runtime.sendMessage({ type: 'native', request, confirmed })
}

export const demoStatus: HostStatus = {
  version: '0.1.0',
  platform: {
    os: 'linux',
    distribution: 'Manjaro Linux',
    arch: 'x86_64',
    hostname: 'studio-linux',
  },
  backend: { name: 'ddcutil', available: true },
  displays: [
    {
      id: 'demo-display',
      name: '27 英寸共享显示器',
      serial: 'DEMO-ONLY',
      currentInput: 15,
      inputs: [
        { value: 15, label: 'DisplayPort 1' },
        { value: 17, label: 'HDMI 1' },
        { value: 18, label: 'HDMI 2' },
      ],
      inputDetection: 'reported',
      canSwitch: true,
    },
  ],
  warnings: [],
}

export const demoSettings: Settings = {
  displayId: 'demo-display',
  localName: '工作站',
  localInput: 15,
  peer: {
    version: 1,
    name: 'MacBook Pro',
    platform: { os: 'macos', arch: 'aarch64', hostname: 'macbook-pro' },
    input: 17,
    monitor: { name: '27 英寸共享显示器', serial: 'DEMO-ONLY' },
  },
}
