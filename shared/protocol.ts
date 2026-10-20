/** JSON contract shared by the extension and the Rust Native Messaging host. */
export const HOST_NAME = 'io.monoswitch.host'
export const VERSION = '0.1.0'

export interface PlatformInfo {
  os: 'windows' | 'macos' | 'linux'
  distribution?: string
  arch: string
  hostname: string
}

export interface InputSource {
  value: number
  label: string
}

export interface Display {
  id: string
  name: string
  serial?: string
  currentInput: number | null
  inputs: InputSource[]
  inputDetection: 'reported' | 'standard'
  canSwitch: boolean
  warning?: string
}

export interface HostStatus {
  version: string
  platform: PlatformInfo
  backend: { name: string; available: boolean; hint?: string }
  displays: Display[]
  warnings: string[]
  systemSetup?: { needsRepair: boolean; canRepair: boolean; issues: string[] }
}

export interface SwitchResult {
  accepted: boolean
  message: string
}

export type NativeRequest =
  | { action: 'status' }
  | { action: 'sharingStatus' }
  | { action: 'sharingIdentity' }
  | { action: 'sharingInstall' }
  | { action: 'sharingStart'; config: SharingConfig }
  | { action: 'sharingStop' }
  | { action: 'repair' }
  | { action: 'switch'; displayId: string; input: number }

export type NativeResponse<T = HostStatus | SwitchResult> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: string } }

/** A profile is exported on the other computer; DDC cannot discover its OS. */
export interface ComputerProfile {
  version: 1
  name: string
  platform: PlatformInfo
  input: number
  monitor: { name: string; serial?: string }
  sharing?: SharingIdentity
}

export interface Settings {
  displayId: string
  localName: string
  localInput: number | null
  peer: ComputerProfile | null
}

export interface SharingIdentity { id: string; fingerprint: string }
export interface SharingConfig {
  role: 'server' | 'client'
  peer: SharingIdentity
  address: string
  port: number
  followDisplay: boolean
  displayId: string
  input: number
}
export interface SharingStatus {
  installed: boolean
  running: boolean
  connected: boolean
  active: boolean
  role: 'server' | 'client' | null
  identity: SharingIdentity | null
  lastError: string | null
  displayMessage: string | null
}
