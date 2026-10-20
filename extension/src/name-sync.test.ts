import { describe, expect, it, vi } from 'vitest'
import { syncNames } from './name-sync'
import { fixtures } from './test-fixtures'
import { SETTINGS_KEY } from './state'
import type { NativeResponse, SharingStatus } from '../../shared/protocol'

function setup() {
  const settings = fixtures().settings
  const identity = { id: 'ms-' + 'a'.repeat(16), fingerprint: 'a'.repeat(64) }
  settings.peer!.sharing = identity
  const storage = {
    get: vi.fn(async () => ({ [SETTINGS_KEY]: structuredClone(settings) })),
    set: vi.fn(async () => {}),
  }
  const request = vi.fn(async (): Promise<NativeResponse<unknown>> => ({ ok: true, data: {} }))
  const result: NativeResponse<Partial<SharingStatus>> = { ok: true, data: {
    nameSync: true, running: true, localName: settings.localName,
    peerIdentity: identity, peerName: '新电脑',
  } }
  return { settings, storage, request, result, sync: () => syncNames(result, request, storage as never) }
}
describe('paired computer names', () => {
  it('publishes the latest local name and updates only the peer name', async () => {
    const s = setup()
    s.settings.localName = '新本机'
    await s.sync()
    expect(s.request).toHaveBeenCalledWith({ action: 'sharingSetName', name: '新本机' })
    expect(s.storage.set).toHaveBeenCalledWith({ [SETTINGS_KEY]: {
      ...s.settings, peer: { ...s.settings.peer, name: '新电脑' },
    } })
  })
  it('does not send unsupported commands to old components', async () => {
    const s = setup()
    s.result.data.nameSync = false
    await s.sync()
    expect(s.request).not.toHaveBeenCalled()
    expect(s.storage.set).not.toHaveBeenCalled()
  })
  it('rejects metadata from a different pairing and malformed names', async () => {
    for (const name of ['', 'bad\nname', 'x'.repeat(61)]) {
      const s = setup()
      s.result.data.peerName = name
      await s.sync()
      expect(s.storage.set).not.toHaveBeenCalled()
    }
    const s = setup()
    s.result.data.peerIdentity = { id: 'different', fingerprint: 'b'.repeat(64) }
    await s.sync()
    expect(s.request).not.toHaveBeenCalled()
    expect(s.storage.set).not.toHaveBeenCalled()
  })
  it('preserves edits made while waiting for the native component', async () => {
    const s = setup()
    s.result.data.localName = 'old'
    s.request.mockImplementation(async () => {
      s.settings.localName = 'newer'
      s.settings.localInput = 18
      return { ok: true, data: {} }
    })
    await s.sync()
    expect(s.storage.set).toHaveBeenCalledWith({ [SETTINGS_KEY]: expect.objectContaining({ localName: 'newer', localInput: 18 }) })
  })
  it('does not overwrite a new pairing or repeatedly save unchanged names', async () => {
    const s = setup()
    s.result.data.localName = 'old'
    s.request.mockImplementation(async () => {
      s.settings.peer!.sharing = { id: 'new', fingerprint: 'b'.repeat(64) }
      return { ok: true, data: {} }
    })
    await s.sync()
    expect(s.storage.set).not.toHaveBeenCalled()
    const unchanged = setup()
    unchanged.result.data.peerName = unchanged.settings.peer!.name
    await unchanged.sync()
    expect(unchanged.storage.set).not.toHaveBeenCalled()
  })
})
