import { describe, expect, it, vi } from 'vitest'
import { openToolbarPopup } from './toolbar-popup'

function setup(otherTab = true, fail = false) {
  const calls: string[] = []
  const api = {
    runtime: {
      ContextType: { TAB: 'TAB' },
      getURL: () => 'chrome-extension://test/index.html',
      getContexts: vi.fn(async () => [{ documentUrl: 'chrome-extension://test/index.html' }]),
    },
    tabs: {
      get: vi.fn(async () => ({ id: 42, windowId: 7 })),
      query: vi.fn(async () => otherTab ? [{ id: 42 }, { id: 43 }] : [{ id: 42 }]),
      update: vi.fn(async (id: number) => { calls.push(`activate ${id}`) }),
      create: vi.fn(async () => { calls.push('new tab'); return { id: 44 } }),
      remove: vi.fn(async (id: number) => { calls.push(`remove ${id}`) }),
    },
    action: { openPopup: vi.fn(async () => { calls.push('popup'); if (fail) throw new Error('unsupported') }) },
  }
  return { api, calls, open: () => openToolbarPopup(42, api as never) }
}
describe('toolbar popup transition', () => {
  it('activates the destination before opening the popup, then closes only the source', async () => {
    const s = setup()
    await s.open()
    expect(s.calls).toEqual(['activate 43', 'popup', 'remove 42'])
    expect(s.api.action.openPopup).toHaveBeenCalledWith({ windowId: 7 })
    expect(s.api.tabs.create).not.toHaveBeenCalled()
  })
  it('keeps the browser window alive when the source is its only tab', async () => {
    const s = setup(false)
    await s.open()
    expect(s.calls).toEqual(['new tab', 'popup', 'remove 42'])
    expect(s.api.tabs.create).toHaveBeenCalledWith({ windowId: 7, url: 'chrome://newtab', active: true })
  })
  it.each([false, true])('restores the original page on failure (other tab: %s)', async otherTab => {
    const s = setup(otherTab, true)
    await expect(s.open()).rejects.toThrow('unsupported')
    expect(s.calls).not.toContain('remove 42')
    expect(s.calls).toContain('activate 42')
    if (!otherTab) expect(s.calls.at(-1)).toBe('remove 44')
  })
  it('does not close an unrelated tab even if given its id', async () => {
    const s = setup()
    s.api.runtime.getContexts.mockResolvedValue([])
    await expect(s.open()).rejects.toThrow('Invalid source tab')
    expect(s.calls).toEqual([])
  })
})
