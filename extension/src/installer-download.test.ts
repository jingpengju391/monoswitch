import { describe, expect, it, vi } from 'vitest'
import { createInstallerDownload } from './installer-download'
import type { Installer } from './installers'

const installer: Installer = {
  os: 'linux', arch: 'x86_64', file: 'installers/monoswitch-linux.run',
  size: 100, sha256: 'a'.repeat(64), version: '0.1.0', extensionId: 'test-extension',
}
const url = `chrome-extension://${installer.extensionId}/${installer.file}?sha256=${installer.sha256}`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function mockChrome() {
  const items = new Map<number, chrome.downloads.DownloadItem>()
  const changes = new Set<(delta: chrome.downloads.DownloadDelta) => void>()
  const erasures = new Set<(id: number) => void>()
  let nextId = 1
  const item = (id: number, overrides: Partial<chrome.downloads.DownloadItem> = {}) => ({
    id, url, byExtensionId: installer.extensionId, state: 'in_progress', exists: true,
    filename: '/downloads/monoswitch-linux.run',
    ...overrides,
  }) as chrome.downloads.DownloadItem
  const downloads = {
    download: vi.fn(async (_options: chrome.downloads.DownloadOptions) => {
      const id = nextId++
      items.set(id, item(id))
      return id
    }),
    search: vi.fn(async ({ id, url: matchUrl }: chrome.downloads.DownloadQuery) => {
      if (id !== undefined) {
        const found = items.get(id)
        return found ? [found] : []
      }
      return [...items.values()].filter(value => value.url === matchUrl).sort((a, b) => b.id - a.id)
    }),
    open: vi.fn(async (_id: number) => {}),
    show: vi.fn((_id: number) => {}),
    onChanged: {
      addListener: (callback: (delta: chrome.downloads.DownloadDelta) => void) => { changes.add(callback) },
      removeListener: (callback: (delta: chrome.downloads.DownloadDelta) => void) => { changes.delete(callback) },
    },
    onErased: {
      addListener: (callback: (id: number) => void) => { erasures.add(callback) },
      removeListener: (callback: (id: number) => void) => { erasures.delete(callback) },
    },
  }
  const api = { runtime: { id: installer.extensionId, getURL: (file: string) => `chrome-extension://${installer.extensionId}/${file}` }, downloads } as unknown as typeof chrome
  return {
    api, downloads, items, item, changes, erasures,
    changed: (delta: chrome.downloads.DownloadDelta) => { for (const callback of changes) callback(delta) },
    erased: (id: number) => { items.delete(id); for (const callback of erasures) callback(id) },
    saved(id = 42, overrides: Partial<chrome.downloads.DownloadItem> = {}) {
      items.set(id, item(id, { state: 'complete', ...overrides }))
    },
  }
}

describe('installer downloads', () => {
  it('stays idle without a saved download and never opens automatically', async () => {
    const mock = mockChrome()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value).toEqual({ phase: 'idle', id: null, error: '' })
    expect(await control.open()).toBe(false)
    control.show()
    expect(mock.downloads.search).toHaveBeenCalledExactlyOnceWith({ url, orderBy: ['-startTime'], limit: 0 })
    expect(mock.downloads.open).not.toHaveBeenCalled()
    expect(mock.downloads.show).not.toHaveBeenCalled()
    control.dispose()
  })

  it('deduplicates clicks and waits for complete plus exists before becoming ready', async () => {
    const mock = mockChrome()
    const started = deferred<number>()
    mock.downloads.download.mockReturnValueOnce(started.promise)
    const control = createInstallerDownload(installer, mock.api)
    const first = control.download()
    const second = control.download()
    expect(control.state.value.phase).toBe('downloading')
    expect(mock.downloads.download).toHaveBeenCalledExactlyOnceWith({ url, filename: 'Install MonoSwitch.run', saveAs: false })
    mock.items.set(7, mock.item(7))
    started.resolve(7)
    await Promise.all([first, second])
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 7 })
    mock.items.set(7, mock.item(7, { state: 'complete' }))
    mock.changed({ id: 7, state: { current: 'complete' } })
    await vi.waitFor(() => expect(control.state.value.phase).toBe('ready'))
    await control.download()
    expect(mock.downloads.download).toHaveBeenCalledTimes(1)
    expect(mock.downloads.open).not.toHaveBeenCalled()
    control.dispose()
  })

  it('restores the current extension installer after reopening the page', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(mock.downloads.search).toHaveBeenCalledWith({ url, orderBy: ['-startTime'], limit: 0 })
    expect(control.state.value).toEqual({ phase: 'ready', id: 42, error: '' })
    expect(mock.downloads.download).not.toHaveBeenCalled()
    expect(mock.downloads.open).not.toHaveBeenCalled()
    control.dispose()
  })

  it('recovers the newest matching download if the popup closed before receiving its ID', async () => {
    const mock = mockChrome()
    mock.items.set(41, mock.item(41, { state: 'complete' }))
    mock.items.set(42, mock.item(42, { state: 'complete' }))
    mock.items.set(43, mock.item(43, { state: 'complete', byExtensionId: 'other-extension' }))
    mock.items.set(44, mock.item(44, { state: 'complete', url: `${url}.old` }))
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value).toEqual({ phase: 'ready', id: 42, error: '' })
    expect(mock.downloads.download).not.toHaveBeenCalled()
    expect(mock.downloads.open).not.toHaveBeenCalled()
    control.dispose()
  })

  it('restores a newer retry instead of an older interrupted download', async () => {
    const mock = mockChrome()
    mock.saved(41, { state: 'interrupted' })
    mock.items.set(42, mock.item(42))
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 42 })
    control.dispose()
  })

  it('does not reuse an older package with the same version and filename but a different hash', async () => {
    const mock = mockChrome()
    mock.saved(42, { url: `chrome-extension://${installer.extensionId}/${installer.file}?sha256=${'b'.repeat(64)}` })
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value).toEqual({ phase: 'idle', id: null, error: '' })
    expect(mock.downloads.search).toHaveBeenCalledExactlyOnceWith({ url, orderBy: ['-startTime'], limit: 0 })
    await control.download()
    expect(mock.downloads.download).toHaveBeenCalledExactlyOnceWith({ url, filename: 'Install MonoSwitch.run', saveAs: false })
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 1 })
    control.dispose()
  })

  it.each([
    { url: 'https://example.com/installer.run' },
    { byExtensionId: 'another-extension' },
  ])('ignores history belonging to a different download: %j', async overrides => {
    const mock = mockChrome()
    mock.saved(42, overrides)
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value).toMatchObject({ phase: 'idle', id: null })
    expect(await control.open()).toBe(false)
    expect(mock.downloads.open).not.toHaveBeenCalled()
    control.dispose()
  })

  it('ignores old installer records and mismatched extension registrations', async () => {
    const mock = mockChrome()
    mock.saved(42, { url: `${url}.old` })
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value.phase).toBe('idle')
    expect(mock.downloads.search).toHaveBeenCalledExactlyOnceWith({ url, orderBy: ['-startTime'], limit: 0 })
    control.dispose()
    const mismatched = createInstallerDownload({ ...installer, extensionId: 'other' }, mock.api)
    await mismatched.download()
    expect(mock.downloads.download).not.toHaveBeenCalled()
    expect(mismatched.state.value.error).toContain('不匹配')
    mismatched.dispose()
  })

  it('restores missing files and interrupted downloads as retryable states', async () => {
    for (const overrides of [{ state: 'complete', exists: false }, { state: 'interrupted' }] as const) {
      const mock = mockChrome()
      mock.saved(42, overrides)
      const control = createInstallerDownload(installer, mock.api)
      await control.restore()
      expect(control.state.value.phase).toBe(overrides.state === 'complete' ? 'missing' : 'interrupted')
      await control.download()
      expect(control.state.value).toMatchObject({ phase: 'downloading', id: 1 })
      control.dispose()
    }
  })

  it('handles interruption and removal events and allows another download', async () => {
    const mock = mockChrome()
    const control = createInstallerDownload(installer, mock.api)
    await control.download()
    mock.changed({ id: 1, state: { current: 'interrupted' } })
    expect(control.state.value.phase).toBe('interrupted')
    await control.download()
    expect(control.state.value.id).toBe(2)
    mock.changed({ id: 1, exists: { current: false } })
    expect(control.state.value.phase).toBe('downloading')
    mock.items.set(2, mock.item(2, { state: 'complete' }))
    mock.changed({ id: 2, state: { current: 'complete' } })
    await vi.waitFor(() => expect(control.state.value.phase).toBe('ready'))
    mock.changed({ id: 2, exists: { current: false } })
    expect(control.state.value.phase).toBe('missing')
    expect(await control.open()).toBe(false)
    mock.erased(2)
    expect(control.state.value).toMatchObject({ phase: 'missing', id: null })
    await control.download()
    expect(control.state.value.id).toBe(3)
    control.dispose()
  })

  it('calls open synchronously in the click stack and offers show only when requested', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    const pending = control.open()
    expect(mock.downloads.open).toHaveBeenCalledExactlyOnceWith(42)
    expect(mock.downloads.search).toHaveBeenCalledTimes(1)
    expect(await pending).toBe(true)
    expect(mock.downloads.show).not.toHaveBeenCalled()
    control.show()
    expect(mock.downloads.show).toHaveBeenCalledExactlyOnceWith(42)
    control.dispose()
  })

  it('keeps the folder fallback available when opening rejects or throws', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    mock.downloads.open.mockRejectedValueOnce(new Error('No user gesture'))
    expect(await control.open()).toBe(false)
    expect(control.state.value).toMatchObject({ phase: 'ready', id: 42 })
    expect(control.state.value.error).toContain('文件夹')
    mock.downloads.open.mockImplementationOnce(() => { throw new Error('Blocked') })
    expect(await control.open()).toBe(false)
    control.show()
    expect(mock.downloads.show).toHaveBeenCalledWith(42)
    control.dispose()
  })

  it('rechecks a failed open and makes a deleted installer downloadable again', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    mock.items.set(42, mock.item(42, { state: 'complete', exists: false }))
    mock.downloads.open.mockRejectedValueOnce(new Error('File deleted'))
    const pending = control.open()
    expect(mock.downloads.open).toHaveBeenCalledWith(42)
    expect(mock.downloads.search).toHaveBeenCalledTimes(1)
    expect(await pending).toBe(false)
    expect(control.state.value.phase).toBe('missing')
    await control.download()
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 1 })
    control.dispose()
  })

  it('reports a download start failure and retries on the next click', async () => {
    const mock = mockChrome()
    mock.downloads.download.mockRejectedValueOnce(new Error('Download blocked'))
    const control = createInstallerDownload(installer, mock.api)
    await control.download()
    expect(control.state.value).toMatchObject({ phase: 'interrupted', id: null })
    expect(control.state.value.error).toContain('重试')
    await control.download()
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 1 })
    control.dispose()
  })

  it('makes a failed status query retryable instead of staying busy forever', async () => {
    const mock = mockChrome()
    mock.downloads.search.mockRejectedValueOnce(new Error('Search unavailable'))
    const control = createInstallerDownload(installer, mock.api)
    await control.download()
    expect(control.state.value.phase).toBe('interrupted')
    expect(control.state.value.error).toContain('重试')
    await control.download()
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 2 })
    control.dispose()
  })

  it('does not let a delayed restore replace a new download', async () => {
    const mock = mockChrome()
    const old = deferred<chrome.downloads.DownloadItem[]>()
    mock.downloads.search.mockReturnValueOnce(old.promise)
    const control = createInstallerDownload(installer, mock.api)
    const restoring = control.restore()
    await control.download()
    old.resolve([mock.item(42, { state: 'complete' })])
    await restoring
    expect(control.state.value).toMatchObject({ phase: 'downloading', id: 1 })
    control.dispose()
  })

  it('does not revive an erased download from an older pending search', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    const old = deferred<chrome.downloads.DownloadItem[]>()
    mock.downloads.search.mockReturnValueOnce(old.promise)
    mock.changed({ id: 42, state: { current: 'complete' } })
    mock.erased(42)
    old.resolve([mock.item(42, { state: 'complete' })])
    await old.promise
    expect(control.state.value).toMatchObject({ phase: 'missing', id: null })
    control.dispose()
  })

  it('removes both listeners on disposal and ignores pending results', async () => {
    const mock = mockChrome()
    mock.saved()
    const old = deferred<chrome.downloads.DownloadItem[]>()
    mock.downloads.search.mockReturnValueOnce(old.promise)
    const control = createInstallerDownload(installer, mock.api)
    const restoring = control.restore()
    await vi.waitFor(() => expect(mock.downloads.search).toHaveBeenCalled())
    control.dispose()
    expect(mock.changes.size).toBe(0)
    expect(mock.erasures.size).toBe(0)
    old.resolve([mock.item(42, { state: 'complete' })])
    await restoring
    expect(control.state.value.phase).toBe('idle')
    expect(await control.open()).toBe(false)
  })
})

describe('Linux installation command', () => {
  it('never attempts to execute a Linux ZIP as a binary', async () => {
    const mock = mockChrome()
    const zipped = { ...installer, file: 'installers/monoswitch-linux.zip' }
    mock.saved(42, { url: `chrome-extension://${installer.extensionId}/${zipped.file}?sha256=${installer.sha256}`, filename: '/downloads/monoswitch-linux.zip' })
    const control = createInstallerDownload(zipped, mock.api)
    await control.restore()
    expect(control.state.value.phase).toBe('ready')
    expect(control.installCommand.value).toBe('')
    control.dispose()
  })
  it('uses the completed download path including Chrome filename changes', async () => {
    const mock = mockChrome()
    const control = createInstallerDownload(installer, mock.api)
    expect(control.installCommand.value).toBe('')
    await control.download()
    expect(control.installCommand.value).toBe('')
    mock.items.set(1, mock.item(1, { state: 'complete', filename: '/custom downloads/monoswitch-linux (2).run' }))
    mock.changed({ id: 1, state: { current: 'complete' } })
    await vi.waitFor(() => expect(control.installCommand.value).toBe("chmod u+x -- '/custom downloads/monoswitch-linux (2).run' && '/custom downloads/monoswitch-linux (2).run'"))
    control.dispose()
    expect(control.installCommand.value).toBe('')
  })

  it('restores the actual path and safely quotes spaces, apostrophes and shell expressions', async () => {
    const mock = mockChrome()
    mock.saved(42, { filename: "/tmp/My downloads/O'Brien $HOME `whoami` $(touch nope).run" })
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.installCommand.value).toBe("chmod u+x -- '/tmp/My downloads/O'\\''Brien $HOME `whoami` $(touch nope).run' && '/tmp/My downloads/O'\\''Brien $HOME `whoami` $(touch nope).run'")
    control.dispose()
  })

  it.each([
    undefined, '', 'relative.run', 'C:\\Downloads\\setup.run',
    '/tmp/setup\u0000.run', '/tmp/setup\n.run', '/tmp/setup\r.run',
    '/tmp/setup\t.run', '/tmp/setup\u007f.run',
  ])('does not generate a command from an unsafe or missing path: %j', async filename => {
    const mock = mockChrome()
    mock.saved(42, { filename })
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.state.value.phase).toBe('ready')
    expect(control.installCommand.value).toBe('')
    control.dispose()
  })

  it.each(['windows', 'macos'] as const)('does not offer a Linux command for %s', async os => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload({ ...installer, os }, mock.api)
    await control.restore()
    expect(control.state.value.phase).toBe('ready')
    expect(control.installCommand.value).toBe('')
    control.dispose()
  })

  it.each([
    { state: 'in_progress' }, { state: 'interrupted' }, { state: 'complete', exists: false },
  ] as const)('does not offer a command until the file is ready: %j', async overrides => {
    const mock = mockChrome()
    mock.saved(42, overrides)
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.installCommand.value).toBe('')
    control.dispose()
  })

  it('clears a changed filename until Chrome returns the current path', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.installCommand.value).toContain('/downloads/monoswitch-linux.run')
    const refreshed = deferred<chrome.downloads.DownloadItem[]>()
    mock.downloads.search.mockReturnValueOnce(refreshed.promise)
    mock.changed({ id: 42, filename: { current: '/moved/setup.run' } })
    expect(control.installCommand.value).toBe('')
    refreshed.resolve([mock.item(42, { state: 'complete', filename: '/moved/setup.run' })])
    await vi.waitFor(() => expect(control.installCommand.value).toBe("chmod u+x -- '/moved/setup.run' && '/moved/setup.run'"))
    control.dispose()
  })

  it('removes stale commands after deletion and restores a new downloaded path', async () => {
    const mock = mockChrome()
    mock.saved()
    const control = createInstallerDownload(installer, mock.api)
    await control.restore()
    expect(control.installCommand.value).not.toBe('')
    mock.changed({ id: 42, exists: { current: false } })
    expect(control.installCommand.value).toBe('')
    mock.erased(42)
    expect(control.installCommand.value).toBe('')
    await control.download()
    mock.items.set(1, mock.item(1, { state: 'complete', filename: '/new location/setup.run' }))
    mock.changed({ id: 1, state: { current: 'complete' } })
    await vi.waitFor(() => expect(control.installCommand.value).toBe("chmod u+x -- '/new location/setup.run' && '/new location/setup.run'"))
    mock.changed({ id: 1, state: { current: 'interrupted' } })
    expect(control.installCommand.value).toBe('')
    control.dispose()
  })
})
