export interface Installer {
  os: 'windows' | 'macos' | 'linux'
  arch: 'x86_64' | 'aarch64'
  file: string
  size: number
  sha256: string
  version: string
  extensionId: string
}

export function platformTarget(platform: {
  os: string
  arch: string
}): { os: Installer['os']; arch: Installer['arch'] } | null {
  const os = { win: 'windows', mac: 'macos', linux: 'linux' }[platform.os] as
    | Installer['os']
    | undefined
  const arch = ({ 'x86-64': 'x86_64', arm64: 'aarch64' }[platform.arch] ??
    (platform.os === 'mac' && platform.arch === 'arm'
      ? 'aarch64'
      : undefined)) as Installer['arch'] | undefined
  return os && arch ? { os, arch } : null
}

export function selectInstaller(
  catalog: unknown,
  platform: { os: string; arch: string },
  extensionId: string,
  version: string,
): Installer | null {
  const target = platformTarget(platform)
  if (!target || !catalog || typeof catalog !== 'object') return null
  const data = catalog as { version?: unknown; installers?: unknown }
  if (data.version !== version || !Array.isArray(data.installers)) return null
  return (
    data.installers.find((value: unknown): value is Installer => {
      if (!value || typeof value !== 'object') return false
      const item = value as Installer
      return (
        item.os === target.os &&
        item.arch === target.arch &&
        item.extensionId === extensionId &&
        item.version === version &&
        typeof item.file === 'string' &&
        /^installers\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:run|exe|zip)$/u.test(
          item.file,
        ) &&
        !item.file.includes('..') &&
        typeof item.size === 'number' &&
        item.size > 0 &&
        typeof item.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(item.sha256)
      )
    }) ?? null
  )
}
