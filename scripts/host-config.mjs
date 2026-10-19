import { createHash } from 'node:crypto'
import path from 'node:path'

export const HOST_NAME = 'io.monoswitch.host'

export function extensionId(key) {
  if (typeof key !== 'string' || !key.length) throw new Error('扩展 manifest 缺少固定公钥 key。')
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(n => String.fromCharCode(97 + n)).join('')
}

export function installPaths({ platform, home, env = {}, browser = 'chrome' }) {
  if (!['chrome', 'chromium'].includes(browser)) throw new Error('browser 必须是 chrome 或 chromium。')
  const p = platform === 'win32' ? path.win32 : path.posix
  let directory, manifest, registry
  if (platform === 'win32') {
    directory = p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'MonoSwitch')
    manifest = p.join(directory, `${browser}-${HOST_NAME}.json`)
    registry = `HKCU\\Software\\${browser === 'chrome' ? 'Google\\Chrome' : 'Chromium'}\\NativeMessagingHosts\\${HOST_NAME}`
  } else if (platform === 'darwin') {
    directory = p.join(home, 'Library', 'Application Support', 'MonoSwitch')
    manifest = p.join(home, 'Library', 'Application Support', browser === 'chrome' ? 'Google/Chrome' : 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`)
  } else if (platform === 'linux') {
    directory = p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'monoswitch')
    manifest = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), browser === 'chrome' ? 'google-chrome' : 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`)
  } else {
    throw new Error(`不支持的系统：${platform}`)
  }
  return { directory, manifest, registry, binary: p.join(directory, platform === 'win32' ? 'monoswitch-host.exe' : 'monoswitch-host') }
}

export function hostManifest(binary, id) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error('扩展 ID 格式不正确。')
  if (!path.posix.isAbsolute(binary) && !path.win32.isAbsolute(binary)) throw new Error('本地程序必须使用绝对路径。')
  return {
    name: HOST_NAME,
    description: 'MonoSwitch display input controller',
    path: binary,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }
}
