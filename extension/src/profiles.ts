import type { ComputerProfile, PlatformInfo, SharingIdentity } from '../../shared/protocol'

const MAX_LENGTH = 8192
const PREFIX = 'MS1.'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('配置格式不正确。请从另一台电脑重新导出。')
  return value as Record<string, unknown>
}

function field(value: unknown, label: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label}无效。`)
  return value.trim()
}

export function validateProfile(value: unknown): ComputerProfile {
  const data = object(value)
  if (data.version !== 1) throw new Error('不支持此配置版本。')
  if (
    !Number.isInteger(data.input) ||
    Number(data.input) < 1 ||
    Number(data.input) > 255
  )
    throw new Error('输入源必须是 1–255 的整数。')
  const rawPlatform = object(data.platform)
  if (!['windows', 'macos', 'linux'].includes(String(rawPlatform.os)))
    throw new Error('无法识别配置中的操作系统。')
  const platform: PlatformInfo = {
    os: rawPlatform.os as PlatformInfo['os'],
    arch: field(rawPlatform.arch, '系统架构', 64),
    hostname: field(rawPlatform.hostname, '电脑主机名', 128),
  }
  if (rawPlatform.distribution !== undefined)
    platform.distribution = field(rawPlatform.distribution, '发行版', 100)
  const rawMonitor = object(data.monitor)
  const monitor: ComputerProfile['monitor'] = {
    name: field(rawMonitor.name, '显示器名称', 160),
  }
  if (rawMonitor.serial !== undefined)
    monitor.serial = field(rawMonitor.serial, '显示器序列号', 128)
  return {
    version: 1,
    ...(data.sharing === undefined ? {} : { sharing: validateSharingIdentity(data.sharing) }),
    name: field(data.name, '电脑名称', 60),
    platform,
    input: Number(data.input),
    monitor,
  }
}

export function encodeProfile(profile: ComputerProfile): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify(validateProfile(profile)),
  )
  return (
    PREFIX +
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
  )
}

export function decodeProfile(text: string): ComputerProfile {
  const input = text.trim()
  if (input.length > MAX_LENGTH) throw new Error('配置过长，最多支持 8 KiB。')
  if (!input.startsWith(PREFIX))
    throw new Error('配置应以 MS1. 开头，请完整粘贴。')
  try {
    const raw = atob(input.slice(PREFIX.length))
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      ),
    )
    return validateProfile(value)
  } catch (error) {
    if (
      error instanceof Error &&
      !(error instanceof SyntaxError) &&
      error.name !== 'InvalidCharacterError' &&
      error.name !== 'TypeError'
    )
      throw error
    throw new Error('配置内容损坏，请重新复制。')
  }
}

export function platformLabel(platform: PlatformInfo): string {
  if (platform.os === 'windows') return 'Windows'
  if (platform.os === 'macos') return 'macOS'
  return platform.distribution || 'Linux'
}

export function validateSharingIdentity(value: unknown): SharingIdentity {
  const identity = object(value)
  if (typeof identity.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.fingerprint)
    || identity.id !== `ms-${identity.fingerprint.slice(0, 16)}`) {
    throw new Error('键鼠配对配置无效，请重新交换配置。')
  }
  return { id: identity.id as string, fingerprint: identity.fingerprint }
}
