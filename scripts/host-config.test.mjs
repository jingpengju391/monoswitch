import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extensionId, hostManifest, installPaths } from './host-config.mjs'

test('Linux/Manjaro respects XDG paths without requiring root', () => {
  const paths = installPaths({ platform: 'linux', home: '/home/a', env: { XDG_CONFIG_HOME: '/custom/config', XDG_DATA_HOME: '/custom/data' } })
  assert.equal(paths.manifest, '/custom/config/google-chrome/NativeMessagingHosts/io.monoswitch.host.json')
  assert.equal(paths.binary, '/custom/data/monoswitch/monoswitch-host')
  assert.equal(paths.registry, undefined)
})

test('macOS path preserves spaces and Chromium selection', () => {
  const paths = installPaths({ platform: 'darwin', home: '/Users/a b', browser: 'chromium' })
  assert.equal(paths.manifest, '/Users/a b/Library/Application Support/Chromium/NativeMessagingHosts/io.monoswitch.host.json')
})

test('Windows registers per user with an absolute executable path', () => {
  const paths = installPaths({ platform: 'win32', home: 'C:\\Users\\a b' })
  assert.equal(paths.registry, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\io.monoswitch.host')
  assert.equal(paths.binary, 'C:\\Users\\a b\\AppData\\Local\\MonoSwitch\\monoswitch-host.exe')
})

test('extension IDs are deterministic and host allowlist is exact', () => {
  const id = extensionId(Buffer.from('test-public-key').toString('base64'))
  assert.match(id, /^[a-p]{32}$/)
  assert.equal(id, extensionId(Buffer.from('test-public-key').toString('base64')))
  assert.deepEqual(hostManifest('/tmp/a b/host', id).allowed_origins, [`chrome-extension://${id}/`])
  assert.throws(() => hostManifest('relative/host', id))
  assert.throws(() => hostManifest('/host', '*'))
  assert.throws(() => installPaths({ platform: 'linux', home: '/home/a', browser: 'invalid' }))
})
