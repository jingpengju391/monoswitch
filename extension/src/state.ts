import type { Display, HostStatus, Settings } from '../../shared/protocol'
import { validateProfile } from './profiles'

export const SETTINGS_KEY = 'monoswitch.settings'
export const OPERATION_KEY = 'monoswitch.operation'
export const DEFAULT_SETTINGS: Settings = {
  displayId: '',
  localName: '',
  localInput: null,
  peer: null,
}

export interface Operation {
  state: 'pending' | 'accepted' | 'failed'
  message: string
  timestamp: number
}

export function readOperation(value: unknown): Operation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Operation
  return ['pending', 'accepted', 'failed'].includes(item.state) &&
    typeof item.message === 'string' &&
    Number.isFinite(item.timestamp)
    ? item
    : null
}

export function readSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS }
  const item = value as Partial<Settings>
  let peer = null
  try {
    if (item.peer) peer = validateProfile(item.peer)
  } catch {
    /* Discard invalid imported profiles. */
  }
  return {
    displayId:
      typeof item.displayId === 'string' && item.displayId.length <= 512
        ? item.displayId
        : '',
    localName:
      typeof item.localName === 'string'
        ? item.localName.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 60)
        : '',
    localInput:
      Number.isInteger(item.localInput) &&
      Number(item.localInput) >= 1 &&
      Number(item.localInput) <= 255
        ? Number(item.localInput)
        : null,
    peer,
  }
}

export function activeDisplay(
  status: HostStatus | null,
  settings: Settings,
): Display | undefined {
  return status?.displays.find((display) => display.id === settings.displayId)
}

export function inputLabel(
  display: Display | undefined,
  input: number | null | undefined,
): string {
  if (input == null) return '待选择'
  return (
    display?.inputs.find((item) => item.value === input)?.label ??
    `输入源 ${input}`
  )
}

export function switchBlock(
  status: HostStatus | null,
  settings: Settings,
  confirmed = false,
): string | null {
  if (!status || !status.backend.available) return '请先连接本地服务'
  const display = activeDisplay(status, settings)
  if (!display) return '请先选择共用的显示器'
  if (!display.canSwitch) return '当前显示器暂不支持切换'
  if (settings.localInput === null) return '请先设置本机连接的接口'
  if (
    display.inputDetection === 'reported' &&
    !display.inputs.some((source) => source.value === settings.localInput)
  )
    return '显示器未报告支持本机输入源'
  if (!settings.peer) return '请先导入另一台电脑的配置'
  if (settings.localInput === settings.peer.input)
    return '两台电脑需要使用不同的输入接口'
  if (
    display.serial &&
    settings.peer.monitor.serial &&
    display.serial !== settings.peer.monitor.serial
  )
    return '两份配置的显示器序列号不一致'
  if (
    display.inputDetection === 'reported' &&
    !display.inputs.some((source) => source.value === settings.peer?.input)
  )
    return '显示器未报告支持对端输入源'
  if (display.inputDetection === 'standard' && !confirmed)
    return '请确认另一台电脑的输入接口'
  return null
}
