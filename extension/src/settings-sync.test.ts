import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../shared/protocol'
import { createSettingsSync } from './settings-sync'
import { fixtures } from './test-fixtures'
import { DEFAULT_SETTINGS } from './state'

describe('settings synchronization across open pages', () => {
  it('updates an already-open popup without echo writes or restoring its old peer', async () => {
    const original = fixtures().settings
    const pages: ReturnType<typeof createSettingsSync>[] = []
    let stored = original
    const write = vi.fn(async (value: Settings) => {
      stored = value
      for (const page of pages) page.applyStored(value)
    })
    const options = createSettingsSync(write, vi.fn())
    const popup = createSettingsSync(write, vi.fn())
    pages.push(options, popup)
    for (const page of pages) page.initialize(original)

    options.settings.value.peer = {
      ...original.peer!,
      name: 'New peer',
      input: 18,
    }
    await options.flush()
    expect(popup.settings.value.peer).toMatchObject({
      name: 'New peer',
      input: 18,
    })
    // Switching in the popup only flushes pending edits; no stale snapshot is saved.
    await popup.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(stored.peer!.input).toBe(18)
    for (const page of pages) page.stop()
  })

  it('keeps input 18 when an older input 16 acknowledgement arrives before a rename', async () => {
    const writes: { value: Settings; finish: () => void }[] = []
    let page: ReturnType<typeof createSettingsSync>
    let stored = fixtures().settings
    const write = vi.fn((value: Settings) => new Promise<void>((resolve) => {
      writes.push({ value, finish: () => {
        stored = value
        page.applyStored(value)
        resolve()
      } })
    }))
    page = createSettingsSync(write, vi.fn())
    page.initialize(stored)

    page.settings.value.localInput = 16
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    page.settings.value.localInput = 18
    writes[0]!.finish()
    expect(page.settings.value.localInput).toBe(18)
    page.settings.value.localName = 'Renamed'
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.value).toMatchObject({ localInput: 18, localName: 'Renamed' })

    let flushed = false
    const flush = page.flush().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    writes[1]!.finish()
    await flush
    expect(stored).toMatchObject({ localInput: 18, localName: 'Renamed' })
    expect(write).toHaveBeenCalledTimes(2)
    page.stop()
  })

  it('ignores a late own acknowledgement but accepts an external return to the same value', async () => {
    const writes: Settings[] = []
    const page = createSettingsSync(async value => { writes.push(value) }, vi.fn())
    page.initialize(fixtures().settings)
    page.settings.value.localInput = 16
    await page.flush()
    page.settings.value.localInput = 18
    await page.flush()

    page.applyStored(writes[1])
    page.applyStored(writes[0])
    expect(page.settings.value.localInput).toBe(18)
    page.applyStored({ ...fixtures().settings, localInput: 16, _sync: { writer: 'other-page', revision: 1 } })
    expect(page.settings.value.localInput).toBe(16)
    await page.flush()
    expect(writes).toHaveLength(2)
    page.stop()
  })

  it('coalesces a display and input change into one complete saved configuration', async () => {
    const write = vi.fn(async () => {})
    const page = createSettingsSync(write, vi.fn())
    page.initialize(fixtures().settings)
    page.settings.value.displayId = 'another-monitor'
    page.settings.value.localInput = null
    await page.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ displayId: 'another-monitor', localInput: null }))
    page.stop()
  })

  it('rejects flush when the newest queued write fails and saves it on the next edit', async () => {
    const writes: {
      value: Settings
      finish: () => void
      fail: (error: Error) => void
    }[] = []
    let page: ReturnType<typeof createSettingsSync>
    let stored = fixtures().settings
    const onError = vi.fn()
    page = createSettingsSync(
      value => new Promise<void>((resolve, reject) => {
        writes.push({
          value,
          finish: () => {
            stored = value
            page.applyStored(value)
            resolve()
          },
          fail: reject,
        })
      }),
      onError,
    )
    page.initialize(stored)
    page.settings.value.localInput = 16
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    page.settings.value.localInput = 18
    writes[0]!.finish()
    await vi.waitFor(() => expect(writes).toHaveLength(2))

    const failed = expect(page.flush()).rejects.toThrow('Storage unavailable')
    writes[1]!.fail(new Error('Storage unavailable'))
    await failed
    expect(onError).toHaveBeenCalledTimes(1)
    expect(stored.localInput).toBe(16)
    expect(page.settings.value.localInput).toBe(18)

    page.settings.value.localName = 'Retry'
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    writes[2]!.finish()
    await page.flush()
    expect(stored).toMatchObject({ localInput: 18, localName: 'Retry' })
    page.stop()
  })

  it('preserves the complete remote monitor/input update without triggering local edits', async () => {
    const write = vi.fn(async () => {})
    const page = createSettingsSync(write, vi.fn())
    page.initialize(fixtures().settings)
    page.applyStored({
      ...fixtures().settings,
      displayId: 'another-monitor',
      localInput: 18,
    })
    await page.flush()
    expect(page.settings.value).toMatchObject({
      displayId: 'another-monitor',
      localInput: 18,
    })
    expect(write).not.toHaveBeenCalled()
    page.stop()
  })

  it('receives deletions and rejects malformed stored profiles without rewriting storage', async () => {
    const write = vi.fn(async () => {})
    const page = createSettingsSync(write, vi.fn())
    page.initialize(fixtures().settings)
    page.applyStored({ peer: { input: 999 } })
    expect(page.settings.value.peer).toBeNull()
    page.applyStored(undefined)
    expect(page.settings.value).toEqual(DEFAULT_SETTINGS)
    await page.flush()
    expect(write).not.toHaveBeenCalled()
    page.stop()
  })

  it('flush waits for genuine edits and surfaces save failure before a switch', async () => {
    let rejectWrite!: (error: Error) => void
    const write = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject
        }),
    )
    const onError = vi.fn()
    const page = createSettingsSync(write, onError)
    page.initialize(fixtures().settings)
    page.settings.value.localName = 'Unsaved name'
    const pending = page.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const expectation = expect(pending).rejects.toThrow('Storage unavailable')
    rejectWrite(new Error('Storage unavailable'))
    await expectation
    expect(onError).toHaveBeenCalledTimes(1)
    page.stop()
  })
})
