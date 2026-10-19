import { describe, expect, it } from 'vitest'
import { platformTarget, selectInstaller, type Installer } from './installers'

const linux: Installer = {
  os: 'linux',
  arch: 'x86_64',
  file: 'installers/monoswitch-setup-v0.1.0-linux-x86_64.run',
  size: 100,
  sha256: 'a'.repeat(64),
  version: '0.1.0',
  extensionId: 'extension-id',
}

describe('bundled installer selection', () => {
  it('selects only a matching system, architecture and extension registration', () => {
    expect(
      selectInstaller(
        { version: '0.1.0', installers: [linux] },
        { os: 'linux', arch: 'x86-64' },
        'extension-id',
        '0.1.0',
      ),
    ).toEqual(linux)
    expect(
      selectInstaller(
        { version: '0.1.0', installers: [linux] },
        { os: 'win', arch: 'x86-64' },
        'extension-id',
        '0.1.0',
      ),
    ).toBeNull()
    expect(
      selectInstaller(
        { version: '0.1.0', installers: [linux] },
        { os: 'linux', arch: 'arm64' },
        'extension-id',
        '0.1.0',
      ),
    ).toBeNull()
    expect(
      selectInstaller(
        { version: '0.1.0', installers: [linux] },
        { os: 'linux', arch: 'x86-64' },
        'other-id',
        '0.1.0',
      ),
    ).toBeNull()
  })
  it('supports Apple Silicon Chrome while declining 32-bit Linux ARM', () => {
    expect(platformTarget({ os: 'mac', arch: 'arm' })).toEqual({
      os: 'macos',
      arch: 'aarch64',
    })
    expect(platformTarget({ os: 'linux', arch: 'arm' })).toBeNull()
    expect(platformTarget({ os: 'win', arch: 'x86-32' })).toBeNull()
  })
  it('rejects remote URLs, path traversal and invalid hashes', () => {
    for (const file of [
      'https://example.com/installer.exe',
      'installers/../bad.exe',
      'other/installer.exe',
    ]) {
      expect(
        selectInstaller(
          { version: '0.1.0', installers: [{ ...linux, file }] },
          { os: 'linux', arch: 'x86-64' },
          'extension-id',
          '0.1.0',
        ),
      ).toBeNull()
    }
    expect(
      selectInstaller(
        { version: '0.1.0', installers: [{ ...linux, sha256: '' }] },
        { os: 'linux', arch: 'x86-64' },
        'extension-id',
        '0.1.0',
      ),
    ).toBeNull()
  })
})
