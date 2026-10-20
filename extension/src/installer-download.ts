import { computed, ref } from 'vue'
import type { Installer } from './installers'

interface DownloadState {
  phase: 'idle' | 'downloading' | 'ready' | 'interrupted' | 'missing'
  id: number | null
  error: string
}

export function createInstallerDownload(installer: Installer, api = chrome) {
  const state = ref<DownloadState>({ phase: 'idle', id: null, error: '' })
  const downloadedFilename = ref('')
  const installCommand = computed(() => {
    const path = downloadedFilename.value
    if (installer.os !== 'linux' || !installer.file.endsWith('.run') || state.value.phase !== 'ready'
      || !path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) return ''
    // Quote the actual Chrome download path as one POSIX shell argument.
    const quoted = `'${path.replaceAll("'", "'\\''")}'`
    return `chmod u+x -- ${quoted} && ${quoted}`
  })
  const url = `${api.runtime.getURL(installer.file)}?sha256=${installer.sha256}`
  const filename = installer.os === 'linux' && installer.file.endsWith('.run')
    ? 'Install MonoSwitch.run'
    : installer.file.slice(installer.file.lastIndexOf('/') + 1)
  let revision = 0
  let disposed = false

  function missing(id: number | null, error = '安装器已被删除，请重新下载。') {
    revision++
    downloadedFilename.value = ''
    state.value = { phase: 'missing', id, error }
  }

  function matches(item: chrome.downloads.DownloadItem): boolean {
    return item.url === url && item.byExtensionId === api.runtime.id
  }

  function update(item: chrome.downloads.DownloadItem | undefined, id: number): void {
    downloadedFilename.value = item && matches(item) ? item.filename ?? '' : ''
    if (!item || !matches(item)) {
      missing(null, '找不到当前安装器，请重新下载。')
    } else if (item.state === 'interrupted') {
      state.value = { phase: 'interrupted', id, error: '下载已中断，请重试。' }
    } else if (item.state === 'complete') {
      if (item.exists) state.value = { phase: 'ready', id, error: '' }
      else missing(id)
    } else {
      state.value = { phase: 'downloading', id, error: '' }
    }
  }

  async function refresh(id: number): Promise<void> {
    const request = ++revision
    try {
      const [item] = await api.downloads.search({ id })
      if (disposed || request !== revision || state.value.id !== id) return
      update(item, id)
    } catch {
      if (!disposed && request === revision) {
        state.value = { phase: 'interrupted', id, error: '无法读取下载状态，请重试。' }
      }
    }
  }

  async function restore(): Promise<void> {
    if (disposed || state.value.phase === 'downloading' || installer.extensionId !== api.runtime.id) return
    const request = ++revision
    try {
      // Chrome's history survives even if the popup closes before download()
      // resolves. Only the newest copy of our exact bundled installer counts.
      const items = await api.downloads.search({ url, orderBy: ['-startTime'], limit: 0 })
      if (disposed || request !== revision) return
      const item = items.find(matches)
      if (!item) return
      update(item, item.id)
    } catch {
      if (!disposed && request === revision) {
        state.value = { phase: 'interrupted', id: null, error: '无法读取下载记录，请重试。' }
      }
    }
  }

  async function download(force = false): Promise<void> {
    if (disposed || state.value.phase === 'downloading' || (state.value.phase === 'ready' && !force)) return
    if (installer.extensionId !== api.runtime.id) {
      state.value.error = '安装器与当前扩展不匹配，请重新加载扩展。'
      return
    }
    const request = ++revision
    downloadedFilename.value = ''
    state.value = { phase: 'downloading', id: null, error: '' }
    let id: number
    try {
      id = await api.downloads.download({ url, filename, saveAs: false })
    } catch {
      if (!disposed && request === revision) {
        state.value = { phase: 'interrupted', id: null, error: '下载未能开始，请重试。' }
      }
      return
    }
    if (disposed || request !== revision) return
    state.value.id = id
    await refresh(id)
  }

  function open(): Promise<boolean> {
    if (disposed || state.value.phase !== 'ready' || state.value.id === null) {
      return Promise.resolve(false)
    }
    const id = state.value.id
    state.value.error = ''
    const failed = async () => {
      if (disposed || state.value.id !== id) return false
      // Opening may discover a deletion before Chrome updates its exists cache.
      await refresh(id)
      if (!disposed && state.value.id === id && state.value.phase === 'ready') {
        state.value.error = '无法直接打开，请在文件夹中找到安装器并手动打开。'
      }
      return false
    }
    try {
      // Stay in the click's call stack: downloads.open requires a user gesture.
      return api.downloads.open(id).then(() => true, failed)
    } catch {
      return failed()
    }
  }

  function show(): void {
    if (disposed || state.value.id === null) return
    try {
      api.downloads.show(state.value.id)
    } catch {
      state.value.error = '无法显示文件夹，请在浏览器下载记录中找到安装器。'
    }
  }

  function changed(delta: chrome.downloads.DownloadDelta): void {
    if (disposed || delta.id !== state.value.id) return
    if (delta.filename) downloadedFilename.value = ''
    if (delta.exists?.current === false) missing(delta.id)
    else if (delta.state?.current === 'interrupted') {
      revision++
      state.value = { phase: 'interrupted', id: delta.id, error: '下载已中断，请重试。' }
    } else if (delta.state || delta.exists || delta.url || delta.finalUrl || delta.error || delta.filename) {
      void refresh(delta.id)
    }
  }

  function erased(id: number): void {
    if (!disposed && id === state.value.id) missing(null, '下载记录已删除，请重新下载。')
  }

  api.downloads.onChanged.addListener(changed)
  api.downloads.onErased.addListener(erased)

  return {
    state,
    installCommand,
    restore,
    download,
    open,
    show,
    dispose() {
      disposed = true
      downloadedFilename.value = ''
      revision++
      api.downloads.onChanged.removeListener(changed)
      api.downloads.onErased.removeListener(erased)
    },
  }
}
