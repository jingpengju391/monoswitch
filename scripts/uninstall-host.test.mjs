import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOST_NAME, hostManifest, installPaths } from './host-config.mjs'
import { ownsDevelopmentManifest, uninstallDevelopmentHost, updateRegistryRegistration } from './uninstall-host.mjs'

const extension = 'abcdefghijklmnopabcdefghijklmnop'
const platforms = ['linux', 'darwin', 'win32']
const homes = { linux: '/home/中文 user', darwin: '/Users/中文 user', win32: 'C:\\Users\\中文 user' }
const locationsFor = platform => installPaths({ platform, home: homes[platform] })
const manifestFor = binary => JSON.stringify(hostManifest(binary, extension))

function simulatedIo(contents, registryState = 'owned') {
  const calls = []
  return {
    calls,
    async readFile(file) { calls.push(['read', file]); return contents },
    async rm(file) { calls.push(['remove', file]) },
    async registry(request) { calls.push(['registry', request]); return registryState },
  }
}

for (const platform of platforms) {
  test(`${platform}: uninstall removes only its developer manifest and keeps the shared binary`, async () => {
    const locations = locationsFor(platform)
    const io = simulatedIo(manifestFor(locations.binary))
    const result = await uninstallDevelopmentHost({ locations, platform }, io)
    assert.deepEqual(io.calls.filter(([action]) => action === 'remove'), [['remove', locations.manifest]])
    assert.equal(result.removeManifest, locations.manifest)
    assert.equal(result.removeRegistry, locations.registry ?? null)
    if (platform === 'win32') {
      assert.deepEqual(io.calls[1], ['registry', { key: locations.registry, manifest: locations.manifest, remove: true }])
    }
  })

  test(`${platform}: a native installation replacing the developer manifest is preserved`, async () => {
    const locations = locationsFor(platform)
    const nativeBinary = platform === 'win32'
      ? 'C:\\Users\\中文 user\\AppData\\Local\\monoswitch\\bin\\monoswitch-host-version.exe'
      : `${locations.directory}/bin/monoswitch-host-version`
    const io = simulatedIo(manifestFor(nativeBinary))
    const result = await uninstallDevelopmentHost({ locations, platform }, io)
    assert.deepEqual(io.calls, [['read', locations.manifest]])
    assert.equal(result.removeManifest, null)
    assert.equal(result.removeRegistry, null)
    assert.equal(result.warnings.length, 1)
  })
}

test('Windows preserves a native registry replacement while removing the stale developer manifest', async () => {
  const locations = locationsFor('win32')
  const io = simulatedIo(manifestFor(locations.binary), 'foreign')
  const result = await uninstallDevelopmentHost({ locations, platform: 'win32' }, io)
  assert.equal(result.removeRegistry, null)
  assert.equal(result.removeManifest, locations.manifest)
  assert.equal(result.warnings.length, 1)
})

test('invalid JSON, mismatching host names, and nonabsolute paths never authorize removal', () => {
  for (const platform of platforms) {
    const { binary } = locationsFor(platform)
    for (const contents of ['{', 'null', JSON.stringify({ name: 'another.host', path: binary }), JSON.stringify({ name: HOST_NAME, path: 'monoswitch-host' })]) {
      assert.equal(ownsDevelopmentManifest(contents, binary, platform), false)
    }
  }
})

test('Windows path comparison handles case, separators, Chinese names, and spaces', () => {
  const { binary } = locationsFor('win32')
  assert.equal(ownsDevelopmentManifest(manifestFor(binary.toUpperCase().replaceAll('\\', '/')), binary, 'win32'), true)
  assert.equal(ownsDevelopmentManifest(manifestFor(`${binary}.other`), binary, 'win32'), false)
  const linux = locationsFor('linux').binary
  assert.equal(ownsDevelopmentManifest(manifestFor(linux.toUpperCase()), linux, 'linux'), false)
})

test('dry run inspects ownership without deleting a file or registry value', async () => {
  const locations = locationsFor('win32')
  const io = simulatedIo(manifestFor(locations.binary))
  const result = await uninstallDevelopmentHost({ locations, platform: 'win32', dryRun: true }, io)
  assert.equal(result.removeRegistry, locations.registry)
  assert.equal(result.removeManifest, locations.manifest)
  assert.deepEqual(io.calls, [['read', locations.manifest], ['registry', { key: locations.registry, manifest: locations.manifest, remove: false }]])
})

test('unreadable manifests and registry failures preserve files and report the failure', async () => {
  const locations = locationsFor('win32')
  const unreadable = simulatedIo(null)
  unreadable.readFile = async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }) }
  await assert.rejects(uninstallDevelopmentHost({ locations, platform: 'win32' }, unreadable), /已保留现有配置/)
  assert.deepEqual(unreadable.calls, [])
  const registryFailure = simulatedIo(manifestFor(locations.binary))
  registryFailure.registry = async () => { throw new Error('registry access denied') }
  await assert.rejects(uninstallDevelopmentHost({ locations, platform: 'win32' }, registryFailure), /registry access denied/)
  assert.deepEqual(registryFailure.calls, [['read', locations.manifest]])
})

test('missing manifests are a no-op even if Windows has a registration', async () => {
  const locations = locationsFor('win32')
  const io = simulatedIo(null)
  io.readFile = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
  const result = await uninstallDevelopmentHost({ locations, platform: 'win32' }, io)
  assert.deepEqual(io.calls, [])
  assert.equal(result.removeRegistry, null)
})

test('Windows registry calls pass paths as data and reject failures or unexpected output', () => {
  const locations = locationsFor('win32')
  const unusualPath = "C:\\Users\\中文 ' $(data) user\\manifest.json"
  const request = { key: locations.registry, manifest: unusualPath, remove: true }
  const state = updateRegistryRegistration(request, (command, args, options) => {
    assert.equal(command, 'powershell.exe')
    assert.equal(args.includes(unusualPath), false)
    assert.equal(args.at(-1).includes(unusualPath), false)
    assert.equal(options.env.MONOSWITCH_UNINSTALL_MANIFEST, unusualPath)
    assert.equal(options.env.MONOSWITCH_UNINSTALL_KEY, locations.registry.slice('HKCU\\'.length))
    assert.equal(options.env.MONOSWITCH_UNINSTALL_REMOVE, '1')
    assert.equal(options.windowsHide, true)
    return { status: 0, stdout: '"owned"\r\n' }
  })
  assert.equal(state, 'owned')
  for (const result of [
    { status: 1, stdout: '"owned"', stderr: 'access denied' },
    { status: null, error: new Error('spawn failed') },
    { status: 0, stdout: 'unexpected output' },
    { status: 0, stdout: '"unexpected state"' },
  ]) {
    assert.throws(() => updateRegistryRegistration(request, () => result), /已保留|未删除/)
  }
  assert.throws(() => updateRegistryRegistration({ ...request, key: 'HKLM\\Software\\Other' }), /当前用户/)
})
