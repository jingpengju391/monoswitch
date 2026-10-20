import { afterEach, expect, it, vi } from 'vitest'
import { createSharingConnection } from './sharing-connection'

function fixture() {
  let reply: (value: unknown) => void = () => {}
  let disconnected: () => void = () => {}
  const port = {
    onMessage: { addListener: (fn: typeof reply) => { reply = fn } },
    onDisconnect: { addListener: (fn: typeof disconnected) => { disconnected = fn } },
    postMessage: vi.fn(), disconnect: vi.fn(),
  }
  const api = { runtime: { connectNative: vi.fn(() => port), lastError: undefined } }
  const connection = createSharingConnection(api as unknown as typeof chrome)
  return { connection, port, api, reply: (value: unknown) => reply(value), disconnect: () => disconnected() }
}
afterEach(() => vi.useRealTimers())
it('serializes requests on one port and closes it after stopping', async () => {
  const f = fixture()
  const first = f.connection.request({ action: 'sharingStatus' })
  const stop = f.connection.request({ action: 'sharingStop' })
  await Promise.resolve()
  expect(f.port.postMessage).toHaveBeenCalledTimes(1)
  f.reply({ ok: true, data: { running: true } })
  await first
  await Promise.resolve()
  expect(f.port.postMessage).toHaveBeenLastCalledWith({ action: 'sharingStop' })
  f.reply({ ok: true, data: { running: false } })
  expect(await stop).toEqual({ ok: true, data: { running: false } })
  expect(f.api.runtime.connectNative).toHaveBeenCalledTimes(1)
  expect(f.port.disconnect).toHaveBeenCalledOnce()
  expect(f.connection.connected()).toBe(false)
})
it('settles pending requests on native disconnect and permits reconnect', async () => {
  const f = fixture()
  const first = f.connection.request({ action: 'sharingStatus' })
  await Promise.resolve()
  f.disconnect()
  expect(await first).toMatchObject({ ok: false, error: { code: 'SHARING_DISCONNECTED' } })
  const second = f.connection.request({ action: 'sharingStatus' })
  await Promise.resolve()
  f.reply({ ok: true, data: {} })
  expect((await second).ok).toBe(true)
  expect(f.api.runtime.connectNative).toHaveBeenCalledTimes(2)
  f.connection.close()
})
it('closes a stuck session instead of leaving input capture running', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const pending = f.connection.request({ action: 'sharingStatus' })
  await vi.advanceTimersByTimeAsync(15_000)
  expect((await pending).ok).toBe(false)
  expect(f.port.disconnect).toHaveBeenCalledOnce()
})
it('reconnects once when an old host rejects a new pairing action', async () => {
  const f = fixture()
  const message = { action: 'sharingPairHost', profile: {} } as Parameters<typeof f.connection.request>[0]
  const result = f.connection.request(message)
  await Promise.resolve()
  f.reply({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Old host' } })
  await vi.waitFor(() => expect(f.api.runtime.connectNative).toHaveBeenCalledTimes(2))
  expect(f.port.postMessage).toHaveBeenLastCalledWith(message)
  f.reply({ ok: true, data: { pairingCode: 'MS2.test' } })
  expect(await result).toMatchObject({ ok: true })
  f.connection.close()
})
it('does not loop if the installed host also rejects pairing', async () => {
  const f = fixture()
  const result = f.connection.request({ action: 'sharingPairHost', profile: {} } as Parameters<typeof f.connection.request>[0])
  await Promise.resolve()
  const rejection = { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unsupported' } }
  f.reply(rejection)
  await vi.waitFor(() => expect(f.api.runtime.connectNative).toHaveBeenCalledTimes(2))
  f.reply(rejection)
  expect(await result).toEqual(rejection)
  expect(f.connection.connected()).toBe(false)
  expect(f.api.runtime.connectNative).toHaveBeenCalledTimes(2)
})
