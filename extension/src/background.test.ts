import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeRequest } from '../../shared/protocol'
import { fixtures } from './test-fixtures'
import { OPERATION_KEY, SETTINGS_KEY } from './state'
import { REPAIR_KEY } from './system-setup'

let state: ReturnType<typeof fixtures>
let onMessage: (
  message: unknown,
  sender: { id: string },
  callback: (result: unknown) => void,
) => boolean
let onCommand: (command: string) => void
let nativeCalls: NativeRequest[]
let saved: Record<string, unknown>
let delaySwitch: ((response: unknown) => void) | null
let repairReply: (response: unknown) => void
let repairDisconnect: () => void

beforeEach(async () => {
  vi.resetModules()
  state = fixtures()
  nativeCalls = []
  saved = {}
  delaySwitch = null
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      connectNative: vi.fn(() => ({
        onMessage: { addListener: (listener: typeof repairReply) => { repairReply = listener } },
        onDisconnect: { addListener: (listener: typeof repairDisconnect) => { repairDisconnect = listener } },
        postMessage: (request: NativeRequest) => { nativeCalls.push(request) },
        disconnect: vi.fn(),
      })),
      sendNativeMessage: vi.fn(
        (
          _host: string,
          request: NativeRequest,
          callback: (response: unknown) => void,
        ) => {
          nativeCalls.push(request)
          if (request.action === 'status')
            callback({ ok: true, data: state.status })
          else if (delaySwitch) delaySwitch = callback
          else
            callback({
              ok: true,
              data: {
                accepted: true,
                message: 'Command accepted; not verified',
              },
            })
        },
      ),
      onMessage: {
        addListener: (listener: typeof onMessage) => {
          onMessage = listener
        },
      },
      onInstalled: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ [SETTINGS_KEY]: state.settings })),
        remove: vi.fn(async (key: string) => { delete saved[key] }),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(saved, value)
        }),
      },
    },
    commands: {
      onCommand: {
        addListener: (listener: typeof onCommand) => {
          onCommand = listener
        },
      },
    },
  })
  await import('./background')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function send(request: NativeRequest, confirmed = false): Promise<unknown> {
  return new Promise((resolve) =>
    onMessage(
      { type: 'native', request, confirmed },
      { id: 'test-extension' },
      resolve,
    ),
  )
}

describe('explicit system configuration', () => {
  it('never elevates during status checks or without an explicit confirmed action', async () => {
    await send({ action: 'status' })
    expect(await send({ action: 'repair' })).toMatchObject({ ok: false })
    expect(chrome.runtime.connectNative).not.toHaveBeenCalled()
  })

  it('keeps a native port alive, prevents duplicates and saves completion', async () => {
    const pending = send({ action: 'repair' }, true)
    await vi.waitFor(() => expect(nativeCalls).toEqual([{ action: 'repair' }]))
    expect(saved[REPAIR_KEY]).toMatchObject({ running: true })
    expect(await send({ action: 'repair' }, true)).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    let progress: unknown
    onMessage({ type: 'system-setup-state' }, { id: 'test-extension' }, result => { progress = result })
    expect(progress).toEqual({ running: true })
    repairReply({ ok: true, data: state.status })
    expect(await pending).toMatchObject({ ok: true })
    expect(saved[REPAIR_KEY]).toMatchObject({ running: false, failed: false })
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
  })

  it('reports cancelled authorization and can retry without claiming success', async () => {
    const pending = send({ action: 'repair' }, true)
    await vi.waitFor(() => expect(nativeCalls).toHaveLength(1))
    repairReply({ ok: false, error: { code: 'SETUP_FAILED', message: '已取消授权' } })
    expect(await pending).toMatchObject({ ok: false })
    expect(saved[REPAIR_KEY]).toMatchObject({ running: false, failed: true, message: '已取消授权' })
    const retry = send({ action: 'repair' }, true)
    await vi.waitFor(() => expect(nativeCalls).toHaveLength(2))
    repairDisconnect()
    expect(await retry).toMatchObject({ ok: false, error: { code: 'SETUP_DISCONNECTED' } })
  })
})

describe('background switch orchestration', () => {
  it('rechecks current hardware, switches only the saved peer and persists acceptance', async () => {
    const result = await send({
      action: 'switch',
      displayId: 'monitor-1',
      input: 17,
    })
    expect(result).toMatchObject({ ok: true, data: { accepted: true } })
    expect(nativeCalls).toEqual([
      { action: 'status' },
      { action: 'switch', displayId: 'monitor-1', input: 17 },
    ])
    expect(saved[OPERATION_KEY]).toMatchObject({ state: 'accepted' })
  })
  it('rejects stale popup requests instead of switching an unexpected input', async () => {
    const result = await send({
      action: 'switch',
      displayId: 'monitor-1',
      input: 18,
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SETTINGS_CHANGED' },
    })
    expect(nativeCalls).toHaveLength(1)
  })
  it('prevents overlapping switch requests even across popup instances', async () => {
    delaySwitch = () => {}
    const first = send({ action: 'switch', displayId: 'monitor-1', input: 17 })
    await vi.waitFor(() => expect(nativeCalls).toHaveLength(2))
    expect(
      await send({ action: 'switch', displayId: 'monitor-1', input: 17 }),
    ).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    delaySwitch!({ ok: true, data: { accepted: true, message: 'Sent' } })
    await first
  })
  it('never applies an unconfirmed standard-fallback input from a shortcut', async () => {
    state.status.displays[0]!.inputDetection = 'standard'
    onCommand('switch-peer')
    await vi.waitFor(() =>
      expect(saved[OPERATION_KEY]).toMatchObject({ state: 'failed' }),
    )
    expect(nativeCalls).toEqual([{ action: 'status' }])
  })
  it('ignores messages from other extension identities', () => {
    const callback = vi.fn()
    expect(
      onMessage(
        { type: 'native', request: { action: 'status' } },
        { id: 'other' },
        callback,
      ),
    ).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(nativeCalls).toHaveLength(0)
  })
})

it('requires explicit confirmation before sharing installation, pairing or capture', async () => {
  for (const action of ['sharingInstall', 'sharingIdentity', 'sharingStop'] as const) {
    expect(await send({ action })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  }
  expect(nativeCalls).toHaveLength(0)
})

it('waits for confirmed input focus before switching the display', async () => {
  const config = { role: 'server' as const, peer: { id: 'ms-' + 'a'.repeat(16), fingerprint: 'a'.repeat(64) }, address: '', port: 24800, followDisplay: true, displayId: 'monitor-1', input: 15 }
  const start = send({ action: 'sharingStart', config }, true)
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingStart'))
  repairReply({ ok: true, data: { running: true } })
  await start
  const switching = send({ action: 'switch', displayId: 'monitor-1', input: 17 }, true)
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingStatus'))
  repairReply({ ok: true, data: { running: true, connected: true } })
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingSwitch'))
  expect(nativeCalls.some(call => call.action === 'switch')).toBe(false)
  repairReply({ ok: false, error: { code: 'SHARING_FAILED', message: 'Input did not switch' } })
  expect(await switching).toMatchObject({ ok: false })
  expect(nativeCalls.some(call => call.action === 'switch')).toBe(false)
  const retry = send({ action: 'switch', displayId: 'monitor-1', input: 17 }, true)
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingStatus'))
  repairReply({ ok: true, data: { running: true, connected: true } })
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingSwitch'))
  repairReply({ ok: true, data: { accepted: true } })
  expect(await retry).toMatchObject({ ok: true })
  expect(nativeCalls.at(-1)?.action).toBe('switch')
})

it('one-time join saves the peer and automatically starts the receiver', async () => {
  const peer = { ...state.settings.peer!, sharing: { id: 'ms-' + 'b'.repeat(16), fingerprint: 'b'.repeat(64) } }
  const joined = send({ action: 'sharingPairJoin', code: 'MS2.test', profile: peer }, true)
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingPairJoin'))
  repairReply({ ok: true, data: { peer, address: '192.168.1.2', port: 24800 } })
  await vi.waitFor(() => expect(nativeCalls.at(-1)?.action).toBe('sharingStart'))
  expect(nativeCalls.at(-1)).toMatchObject({ config: { role: 'client', address: '192.168.1.2', peer: peer.sharing } })
  repairReply({ ok: true, data: { running: true } })
  expect(await joined).toMatchObject({ ok: true })
  expect(saved[SETTINGS_KEY]).toMatchObject({ peer })
  expect(saved['monoswitch.sharingResume']).toMatchObject({ role: 'client' })
})
