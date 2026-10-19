import { readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { HOST_NAME } from './host-config.mjs'

export function ownsDevelopmentManifest(contents, binary, platform) {
  let manifest
  try { manifest = JSON.parse(contents) } catch { return false }
  if (manifest?.name !== HOST_NAME || typeof manifest.path !== 'string') return false
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!paths.isAbsolute(manifest.path) || !paths.isAbsolute(binary)) return false
  const actual = paths.normalize(manifest.path)
  const expected = paths.normalize(binary)
  return platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
}

// No paths are interpolated into PowerShell code. Checking and deleting the
// default value in one process also preserves any other values/subkeys.
const REGISTRY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$remove = $env:MONOSWITCH_UNINSTALL_REMOVE -eq '1'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:MONOSWITCH_UNINSTALL_KEY, $remove)
if ($null -eq $key) { Write-Output '"missing"'; exit 0 }
try {
  $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $value) { Write-Output '"missing"'; exit 0 }
  $owned = $false
  if (($value -is [string]) -and ($key.GetValueKind('') -eq [Microsoft.Win32.RegistryValueKind]::String)) {
    try {
      $owned = [System.IO.Path]::IsPathRooted($value) -and [string]::Equals(
        [System.IO.Path]::GetFullPath($value),
        [System.IO.Path]::GetFullPath($env:MONOSWITCH_UNINSTALL_MANIFEST),
        [System.StringComparison]::OrdinalIgnoreCase)
    } catch { $owned = $false }
  }
  if (-not $owned) { Write-Output '"foreign"'; exit 0 }
  if ($remove) { $key.DeleteValue('', $false) }
  Write-Output '"owned"'
} finally { $key.Dispose() }
`

export function updateRegistryRegistration({ key, manifest, remove }, spawn = spawnSync) {
  if (!key.startsWith('HKCU\\')) throw new Error('只能操作当前用户的浏览器注册。')
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: {
      ...process.env,
      MONOSWITCH_UNINSTALL_KEY: key.slice('HKCU\\'.length),
      MONOSWITCH_UNINSTALL_MANIFEST: manifest,
      MONOSWITCH_UNINSTALL_REMOVE: remove ? '1' : '0',
    },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`无法确认或移除浏览器注册表项，已保留开发注册文件。${result.error?.message || result.stderr || `PowerShell 退出码：${result.status}`}`)
  }
  let state
  try { state = JSON.parse(result.stdout.trim()) } catch { /* Treat unknown output as a failure. */ }
  if (!['owned', 'foreign', 'missing'].includes(state)) throw new Error('无法识别注册表查询结果，未删除开发注册文件。')
  return state
}

const systemIo = { readFile, rm, registry: updateRegistryRegistration }

export async function uninstallDevelopmentHost({ locations, platform, dryRun = false }, io = systemIo) {
  const result = { removeManifest: null, removeRegistry: null, warnings: [] }
  let contents
  try { contents = await io.readFile(locations.manifest, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return result
    throw new Error(`无法读取注册文件，已保留现有配置：${locations.manifest}。${error.message}`, { cause: error })
  }
  if (!ownsDevelopmentManifest(contents, locations.binary, platform)) {
    result.warnings.push(`已保留不属于开发安装的注册文件：${locations.manifest}`)
    return result
  }
  if (locations.registry) {
    const state = await io.registry({ key: locations.registry, manifest: locations.manifest, remove: !dryRun })
    if (state === 'owned') result.removeRegistry = locations.registry
    if (state === 'foreign') result.warnings.push(`已保留其他安装使用的注册表项：${locations.registry}`)
  }
  result.removeManifest = locations.manifest
  if (!dryRun) await io.rm(locations.manifest, { force: true })
  // The shared executable remains: another browser may still reference it.
  return result
}
