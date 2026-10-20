import { expect, test, chromium } from '@playwright/test'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { extensionId, hostManifest } from '../scripts/host-config.mjs'

async function mockInstallerDownloads(page, { os = 'linux', arch = 'x86-64', openFails = false, clipboardFails = false, archive = false } = {}) {
  const target = { linux: 'linux', win: 'windows', mac: 'macos' }[os]
  const targetArch = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const file = `installers/monoswitch-setup-v0.1.0-${target}-${targetArch}${archive ? '.zip' : { linux: '.run', win: '.exe', mac: '.zip' }[os]}`
  await page.route('**/installers/catalog.json', route => route.fulfill({
    json: {
      version: '0.1.0', extensionId: 'test-extension',
      installers: [{ os: target, arch: targetArch, file, size: 128, sha256: 'a'.repeat(64), version: '0.1.0', extensionId: 'test-extension' }],
    },
  }))
  await page.addInitScript(({ os, arch, openFails, clipboardFails }) => {
    const storage = {}
    const storageListeners = new Set()
    const changedListeners = new Set()
    const erasedListeners = new Set()
    const downloads = []
    const calls = { download: [], open: [], show: [], clipboard: [] }
    Object.defineProperty(navigator, 'clipboard', { value: {
      async writeText(text) {
        if (clipboardFails) throw new Error('Clipboard unavailable')
        calls.clipboard.push(text)
      },
    } })
    const event = listeners => ({
      addListener(listener) { listeners.add(listener) },
      removeListener(listener) { listeners.delete(listener) },
    })
    Object.assign(window.chrome, {
      runtime: {
        id: 'test-extension',
        getPlatformInfo: async () => ({ os, arch }),
        getManifest: () => ({ version: '0.1.0' }),
        getURL: path => new URL(path, location.origin).href,
        sendMessage: async () => ({ ok: false, error: { code: 'HOST_UNAVAILABLE', message: '本地组件尚未安装。' } }),
      },
      storage: {
        local: {
          async get(keys) {
            if (keys == null) return structuredClone(storage)
            const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
            return Object.fromEntries(names.filter(key => key in storage).map(key => [key, structuredClone(storage[key])]))
          },
          async set(values) {
            const changes = {}
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: storage[key], newValue: structuredClone(value) }
              storage[key] = structuredClone(value)
            }
            for (const listener of storageListeners) listener(changes, 'local')
          },
        },
        onChanged: event(storageListeners),
      },
      commands: { getAll: async () => [] },
      downloads: {
        async download(options) {
          calls.download.push(structuredClone(options))
          const id = downloads.length + 1
          downloads.push({
            id, byExtensionId: 'test-extension', url: options.url, finalUrl: options.url,
            filename: `/isolated-downloads/${options.filename || new URL(options.url).pathname.split('/').pop()}`, state: 'in_progress',
            startTime: new Date(id * 1000).toISOString(),
            exists: true, danger: 'safe', bytesReceived: 0, totalBytes: 128, fileSize: 128,
            mime: 'application/octet-stream', paused: false, canResume: false,
          })
          return id
        },
        async search(query) {
          const matches = downloads.filter(item =>
            (query.id === undefined || item.id === query.id) && (query.url === undefined || item.url === query.url))
          if (query.orderBy?.includes('-startTime')) matches.sort((left, right) => right.startTime.localeCompare(left.startTime))
          return structuredClone(query.limit ? matches.slice(0, query.limit) : matches)
        },
        async open(id) {
          calls.open.push(id)
          if (openFails) throw new Error('Test OS refuses to launch this downloaded file')
        },
        show(id) { calls.show.push(id) },
        onChanged: event(changedListeners),
        onErased: event(erasedListeners),
      },
    })
    window.__monoswitchDownloads = {
      calls,
      change(state) {
        const item = downloads.at(-1)
        const previous = item.state
        item.state = state
        if (state === 'interrupted') item.error = 'NETWORK_FAILED'
        else delete item.error
        if (state === 'complete') item.bytesReceived = item.totalBytes
        const delta = { id: item.id, state: { previous, current: state } }
        if (item.error) delta.error = { current: item.error }
        for (const listener of changedListeners) listener(delta)
      },
    }
  }, { os, arch, openFails, clipboardFails })
}

test('browser preview honestly shows missing component', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '连接你的显示器' })).toBeVisible()
  await expect(page.getByText('演示模式 · 不会控制真实显示器')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /切换到/ })).toHaveCount(0)
})

test('installed backend still shows its actionable setup hint when detection fails', async ({ page }) => {
  const hint = '请启动 BetterDisplay，并开启 CLI / Notification 集成。'
  await page.addInitScript(({ hint }) => {
    Object.assign(window.chrome, {
      runtime: {
        id: 'test-extension',
        getPlatformInfo: async () => ({ os: 'mac', arch: 'arm64' }),
        getURL: path => new URL(path, location.href).href,
        sendMessage: async () => ({
          ok: true,
          data: {
            version: '0.1.0',
            platform: { os: 'macos', arch: 'aarch64', hostname: 'Test Mac' },
            backend: { name: 'BetterDisplay', available: true, hint },
            displays: [],
            warnings: ['显示器控制程序未完成请求。'],
          },
        }),
      },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {}, removeListener() {} },
      },
      commands: { getAll: async () => [] },
    })
  }, { hint })
  await page.goto('/?settings=1')
  await expect(page.getByText('系统信息由本地服务自动识别')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: hint })).toBeVisible()
  await expect(page.getByText('显示器控制程序未完成请求。')).toBeVisible()
})

test('compact control panel, explicit demo and safe switch feedback', async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 700 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/?demo=1&popup=1')
  await expect(page.getByText('Manjaro Linux', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '切换到 MacBook Pro' }).click()
  await expect(page.getByText('这是界面演示，没有发送显示器切换指令。')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
  await page.getByRole('button', { name: '关闭提示' }).click()
  await mkdir('docs/screenshots', { recursive: true })
  await page.screenshot({ path: 'docs/screenshots/control-popup.png', fullPage: true })
  await page.getByRole('button', { name: '打开完整页面', exact: true }).click()
  await expect(page.locator('.popup-page')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '切换到 MacBook Pro' })).toBeVisible()
  await expect(page).toHaveURL(/\?demo=1$/)
  await page.getByRole('button', { name: '打开小窗口', exact: true }).click()
  await expect(page.locator('.popup-page')).toBeVisible()
  await expect(page.getByRole('button', { name: '切换到 MacBook Pro' })).toBeVisible()
})

test('local configuration is generated automatically instead of exposing manual exchange', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 1000 })
  await page.goto('/?settings=1&demo=1')
  await page.getByText('更多选项', { exact: true }).click()
  await expect(page.getByRole('textbox', { name: '本机导出配置' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '复制配置' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '切换到 MacBook Pro' })).toBeEnabled()
  await page.screenshot({ path: 'docs/screenshots/settings.png', fullPage: true })
})

test('onboarding waits for download completion and retries interrupted downloads', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 900 })
  await mockInstallerDownloads(page)
  await page.goto('/?settings=1')
  await page.getByRole('button', { name: '下载组件', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '打开安装器', exact: true })).toHaveCount(0)
  await page.evaluate(() => window.__monoswitchDownloads.change('interrupted'))
  const retry = page.getByRole('button', { name: '重新下载', exact: true })
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.__monoswitchDownloads.calls.download.length)).toBe(2)
  await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
  await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '打开安装器', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '在文件夹中显示', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.__monoswitchDownloads.calls.open)).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mkdir('docs/screenshots', { recursive: true })
  await page.screenshot({ path: 'docs/screenshots/onboarding-narrow.png', fullPage: true })
  await page.setViewportSize({ width: 1180, height: 900 })
  await page.screenshot({ path: 'docs/screenshots/onboarding-ready.png', fullPage: true })
})

test('opening an installer keeps onboarding waiting until the host actually connects', async ({ page }) => {
  await mockInstallerDownloads(page, { os: 'win' })
  await page.goto('/?settings=1')
  await page.getByRole('button', { name: '下载组件', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled()
  await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
  // Only the mocked Chrome API resolves here; no installer is launched by the operating system.
  await page.getByRole('button', { name: '打开安装器', exact: true }).click()
  await expect(page.getByRole('button', { name: '再次打开', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: '安装完成后，自动连接', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '正在等待组件连接，无需反复刷新' })).toBeVisible()
  await expect(page.getByText('系统信息由本地服务自动识别')).toHaveCount(0)
  expect(await page.evaluate(() => window.__monoswitchDownloads.calls.open)).toEqual([1])
  expect(await page.evaluate(() => window.__monoswitchDownloads.calls.download.length)).toBe(1)
})

test('macOS archive guides users to run the extracted installer without terminal commands', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 })
  await mockInstallerDownloads(page, { os: 'mac', archive: true })
  await page.goto('/?settings=1')
  await page.getByRole('button', { name: '下载组件', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled()
  await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
  await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '解压安装包', exact: true }).click()
  await expect(page.getByText('解压后双击 Install MonoSwitch，按提示授权。成功后安装器会自动删除。')).toBeVisible()
  await expect(page.getByText('系统信息由本地服务自动识别')).toHaveCount(0)
  await page.screenshot({ path: 'docs/screenshots/onboarding-ready.png', fullPage: true })
})

test('automatic system setup is explicit and only reports success after native completion', async ({ page }) => {
  await mockInstallerDownloads(page, { archive: true })
  await page.addInitScript(() => {
    let status = {
      version: '0.1.0', platform: { os: 'linux', arch: 'x86_64', hostname: 'test', distribution: 'Manjaro' },
      backend: { name: 'ddcutil', available: false }, displays: [], warnings: [],
      systemSetup: { needsRepair: true, canRepair: true, issues: ['安装显示器控制组件', '设置开机自动启用'] },
    }
    window.__repairCalls = []
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'system-setup-state') return { running: false }
      if (message.request?.action === 'repair') {
        window.__repairCalls.push(message)
        return new Promise(resolve => { window.__finishRepair = () => {
          status = { ...status, backend: { name: 'ddcutil', available: true }, systemSetup: { needsRepair: false, canRepair: true, issues: [] } }
          resolve({ ok: true, data: status })
        } })
      }
      return { ok: true, data: status }
    }
  })
  await page.goto('/?settings=1')
  await expect(page.getByRole('heading', { name: '自动配置显示器控制' })).toBeVisible()
  expect(await page.evaluate(() => window.__repairCalls)).toEqual([])
  await page.getByRole('button', { name: '自动配置', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在自动配置…', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.__repairCalls)).toEqual([{ type: 'native', request: { action: 'repair' }, confirmed: true }])
  await page.evaluate(() => window.__finishRepair())
  await expect(page.getByRole('status').filter({ hasText: '系统配置完成，已重新检测显示器。' })).toBeVisible()
  await expect(page.getByRole('button', { name: '自动配置', exact: true })).toHaveCount(0)
})

for (const clipboardFails of [false, true]) {
  test(`Linux installation exposes an executable command with clipboard failure ${clipboardFails}`, async ({ page }) => {
    await mockInstallerDownloads(page, { clipboardFails })
    await page.goto('/?settings=1')
    await page.getByRole('button', { name: '下载组件', exact: true }).click()
    await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled()
    await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
    const command = page.getByLabel('Linux 安装命令', { exact: true })
    const path = '/isolated-downloads/Install MonoSwitch.run'
    await expect(command).toHaveText(`chmod u+x -- '${path}' && '${path}'`)
    await page.getByRole('button', { name: '复制安装命令', exact: true }).click()
    if (clipboardFails) {
      await expect(page.getByRole('alert').filter({ hasText: '复制失败' })).toBeVisible()
      await expect(command).toBeVisible()
    } else {
      await expect(page.getByRole('status').filter({ hasText: '已复制，请在终端粘贴并回车' })).toBeVisible()
      expect(await page.evaluate(() => window.__monoswitchDownloads.calls.clipboard)).toEqual([await command.textContent()])
      const copied = page.getByRole('button', { name: '已复制', exact: true })
      await expect(copied).toBeVisible()
      await expect(copied.locator('svg path')).toHaveAttribute('d', 'm5 12 4 4L19 6')
      await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toBeVisible({ timeout: 4000 })

    }
    // Copying is not executing: keep waiting until the host really responds.
    await expect(page.getByRole('status').filter({ hasText: '正在等待组件连接' })).toBeVisible()
    await expect(page.getByText('系统信息由本地服务自动识别')).toHaveCount(0)
    await page.getByRole('button', { name: '在文件夹中显示', exact: true }).click()
    expect(await page.evaluate(() => window.__monoswitchDownloads.calls.show)).toEqual([1])
    expect(await page.evaluate(() => window.__monoswitchDownloads.calls.open)).toEqual([])
  })
}

for (const platform of [
  { os: 'win', arch: 'x86-64', button: '打开安装器' },
  { os: 'mac', arch: 'arm64', button: '解压安装包' },
]) {
  test(`onboarding offers a folder fallback when ${platform.os} refuses to open an installer`, async ({ page }) => {
    await mockInstallerDownloads(page, { ...platform, openFails: true })
    await page.goto('/?settings=1')
    await page.getByRole('button', { name: '下载组件', exact: true }).click()
    await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled()
    await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
    const open = page.getByRole('button', { name: platform.button, exact: true })
    await expect(open).toBeEnabled()
    // This call is mocked. The test never asks the operating system to launch a file.
    await open.click()
    await expect(page.getByRole('alert').filter({ hasText: /打开|文件夹/ })).toBeVisible()
    await expect(open).toBeEnabled()
    await page.getByRole('button', { name: '在文件夹中显示', exact: true }).click()
    expect(await page.evaluate(() => window.__monoswitchDownloads.calls.open)).toEqual([1])
    expect(await page.evaluate(() => window.__monoswitchDownloads.calls.show)).toEqual([1])
    expect(await page.evaluate(() => window.__monoswitchDownloads.calls.download.length)).toBe(1)
  })
}

test('packaged extension connects to real Rust native host in isolated Chrome profile', async () => {
  test.skip(process.platform !== 'linux', 'Linux browser-profile integration; native API backends have separate platform checks')
  const profile = await mkdtemp(join(tmpdir(), 'monoswitch-browser-'))
  const extension = resolve('extension/dist')
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'))
  const id = extensionId(manifest.key)
  const host = resolve('native/target/release/monoswitch-host')
  const nativeDir = join(profile, 'NativeMessagingHosts')
  await mkdir(nativeDir)
  await writeFile(join(nativeDir, 'io.monoswitch.host.json'), JSON.stringify(hostManifest(host, id)))
  let context
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      locale: 'zh-CN',
      executablePath: process.env.MONOSWITCH_BROWSER || undefined,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    const page = await context.newPage()
    await page.goto(`chrome-extension://${id}/index.html?settings=1`)
    const response = await page.evaluate(async () => chrome.runtime.sendMessage({ type: 'native', request: { action: 'status' } }))
    expect(response.ok, JSON.stringify(response)).toBe(true)
    expect(response.data.platform.os).toBe('linux')
    expect(response.data.platform.hostname).toBeTruthy()
    expect(response.data.displays).toBeInstanceOf(Array)
    await expect(page.getByText('系统信息由本地服务自动识别')).toBeVisible()
    await expect(page.getByText('演示模式 · 不会控制真实显示器')).toHaveCount(0)
    const secondPage = await context.newPage()
    await secondPage.goto(`chrome-extension://${id}/index.html?settings=1`)
    await expect(secondPage.getByText('系统信息由本地服务自动识别')).toBeVisible()
    await page.getByText('更多选项', { exact: true }).click()
    await secondPage.getByText('更多选项', { exact: true }).click()
    await page.getByLabel('电脑名称', { exact: true }).fill('桌面 A')
    await expect(secondPage.getByLabel('电脑名称', { exact: true })).toHaveValue('桌面 A')
    await secondPage.getByLabel('电脑名称', { exact: true }).fill('桌面 B')
    await expect(page.getByLabel('电脑名称', { exact: true })).toHaveValue('桌面 B')
    await secondPage.getByLabel('Language / 语言', { exact: true }).selectOption('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByLabel('Computer name', { exact: true })).toHaveValue('桌面 B')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByLabel('Computer name', { exact: true })).toHaveValue('桌面 B')
    expect(await page.evaluate(async () => (await chrome.storage.local.get('monoswitch.language'))['monoswitch.language'])).toBe('en')

  } finally {
    await context?.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test('onboarding downloads matching installer and detects its installed host', async () => {
  test.skip(process.platform !== 'linux', 'Runs Linux installer only, fully inside temporary directories')
  test.setTimeout(45_000)
  const profile = await mkdtemp(join(tmpdir(), 'monoswitch-onboarding-'))
  const downloadsDirectory = join(profile, "downloads 'quoted' $files")
  await mkdir(downloadsDirectory)
  await mkdir(join(profile, 'Default'))
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadsDirectory, prompt_for_download: false, directory_upgrade: true },
  }))
  const extension = resolve('extension/dist')
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'))
  const id = extensionId(manifest.key)
  const catalog = JSON.parse(await readFile(join(extension, 'installers/catalog.json'), 'utf8'))
  const linuxInstaller = catalog.installers.find(item => item.os === 'linux' && item.arch === 'x86_64')
  expect(linuxInstaller).toBeDefined()
  let context
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      locale: 'zh-CN',
      executablePath: process.env.MONOSWITCH_BROWSER || undefined,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      acceptDownloads: true,
      downloadsPath: downloadsDirectory,
    })
    const page = await context.newPage()
    await page.goto(`chrome-extension://${id}/index.html?settings=1`)
    const downloadButton = page.getByRole('button', { name: '下载组件', exact: true })
    await expect(downloadButton).toBeVisible()
    await page.screenshot({ path: 'docs/screenshots/onboarding.png', fullPage: true })
    await downloadButton.click()
    await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '在文件夹中显示', exact: true })).toBeVisible()
    const items = await page.evaluate(() => chrome.downloads.search({}))
    expect(items).toHaveLength(1)
    const completed = items[0]
    expect(completed.state).toBe('complete')
    expect(completed.url).toBe(`chrome-extension://${id}/${linuxInstaller.file}?sha256=${linuxInstaller.sha256}`)
    const archive = completed.filename
    // Playwright may replace the saved filename with a GUID in downloadsPath.
    expect((await readFile(archive)).subarray(0, 4)).toEqual(Buffer.from([0x7f, 69, 76, 70]))
    const isolatedPath = relative(downloadsDirectory, archive)
    expect(isolatedPath).not.toBe('')
    expect(isolatedPath.startsWith('..') || isAbsolute(isolatedPath)).toBe(false)
    expect((await readFile(archive)).length).toBeGreaterThan(0)
    expect((await stat(archive)).mode & 0o111).toBe(0)
    // The ready installer survives reopening the extension; it must not download again.
    await page.reload()
    await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toBeVisible()
    expect(await page.evaluate(() => chrome.downloads.search({}))).toMatchObject([{ id: completed.id, state: 'complete' }])
    const popup = await context.newPage()
    await popup.setViewportSize({ width: 600, height: 600 })
    await popup.goto(`chrome-extension://${id}/index.html`)
    await expect(popup.getByRole('button', { name: '复制安装命令', exact: true })).toBeVisible()
    await popup.screenshot({ path: 'docs/screenshots/onboarding-popup.png', fullPage: true })
    await popup.close()
    // Simulate the explicit execute permission granted by the user.
    const installer = archive
    await chmod(installer, 0o700)
    expect((await stat(installer)).mode & 0o100).toBe(0o100)
    const isolated = join(profile, 'installed')
    const installed = JSON.parse(execFileSync(installer, ['--quiet', '--isolated-dir', isolated], { encoding: 'utf8' }))
    expect((await stat(installer)).mode & 0o100).toBe(0o100)
    expect(installed.ok).toBe(true)
    expect(installed.data.extensionId).toBe(id)
    const nativeDir = join(profile, 'NativeMessagingHosts')
    await mkdir(nativeDir, { recursive: true })
    // An isolated installer has its own HOME layout; point the test browser to that registration.
    await copyFile(join(isolated, '.config', 'chromium', 'NativeMessagingHosts', 'io.monoswitch.host.json'), join(nativeDir, 'io.monoswitch.host.json'))
    await expect(page.getByText('系统信息由本地服务自动识别')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: '下载组件', exact: true })).toHaveCount(0)
    const status = JSON.parse(execFileSync(installed.data.binary, ['--status'], { encoding: 'utf8' }))
    expect(status.data.platform.os).toBe('linux')
    execFileSync(installer, ['--quiet', '--isolated-dir', isolated, '--uninstall'])
  } finally {
    await context?.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test.describe('English and Chinese interface', () => {
  test.use({ locale: 'en-US' })
  test('follows browser language, persists selection, and synchronizes pages', async ({ page, context }) => {
    await page.goto('/?demo=1&settings=1')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('button', { name: 'Switch to MacBook Pro', exact: true })).toBeVisible()
    await page.getByText('More options', { exact: true }).click()
    await page.getByLabel('Computer name', { exact: true }).fill('我的工作电脑')
    const other = await context.newPage()
    await other.goto('/?demo=1&settings=1')
    await page.getByLabel('Language / 语言', { exact: true }).selectOption('zh-CN')
    await expect(page.getByRole('button', { name: '切换到 MacBook Pro', exact: true })).toBeVisible()
    await expect(other.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.getByLabel('电脑名称', { exact: true })).toHaveValue('我的工作电脑')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.getByLabel('Language / 语言', { exact: true }).selectOption('en')
    await expect(page.getByRole('button', { name: 'Switch to MacBook Pro', exact: true })).toBeVisible()
    await page.screenshot({ path: 'docs/screenshots/settings-en.png', fullPage: true })
    await other.close()
  })
  test('translates installer progress', async ({ page }) => {
    await mockInstallerDownloads(page)
    await page.goto('/?settings=1')
    await expect(page.getByRole('heading', { name: 'Connect your display', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Download component', exact: true }).click()
    await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
    await expect(page.getByRole('button', { name: 'Copy install command', exact: true })).toBeVisible()
    await expect(page.getByLabel('Linux installation command')).toContainText('chmod u+x')
    await expect(page.locator('body')).not.toContainText('正在等待组件连接')
    await page.screenshot({ path: 'docs/screenshots/onboarding-en.png', fullPage: true })
  })
})

test('keyboard sharing pairs once with a code and explains when switching is ready', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 1000 })
  await page.addInitScript(() => {
    const identity = { id: 'ms-' + 'a'.repeat(16), fingerprint: 'a'.repeat(64) }
    const peer = { version: 1, name: 'Windows PC', platform: { os: 'windows', arch: 'x86_64', hostname: 'remote' }, input: 17, monitor: { name: 'Dell' }, sharing: { id: 'ms-' + 'b'.repeat(16), fingerprint: 'b'.repeat(64) } }
    const storage = { 'monoswitch.settings': { displayId: 'test', localName: 'Manjaro', localInput: 15, peer } }
    const sharing = { installed: true, running: false, connected: false, active: false, identity: null }
    const calls = []
    window.__sharingCalls = calls
    Object.assign(window.chrome, {
      runtime: { id: 'test-extension', getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }), getURL: path => new URL(path, location.href).href,
        sendMessage: async message => {
          const request = message.request
          if (!request) return { ok: true, data: {} }
          calls.push(JSON.parse(JSON.stringify(message)))
          if (request.action === 'status') return { ok: true, data: { version: '0.1.0', platform: { os: 'linux', arch: 'x86_64', hostname: 'Manjaro' }, backend: { name: 'ddcutil', available: true }, systemSetup: { needsRepair: false, canRepair: true, issues: [] }, warnings: [], displays: [{ id: 'test', name: 'Dell', currentInput: 15, canSwitch: true, inputDetection: 'reported', inputs: [{ value: 15, label: 'DP' }, { value: 17, label: 'HDMI' }] }] } }
          if (request.action === 'sharingPairHost') Object.assign(sharing, { identity, pairingCode: 'MS2.test-invitation' })
          if (request.action === 'sharingPairJoin') Object.assign(sharing, { running: true, connected: true, active: true, pairingCode: null })
          if (request.action === 'sharingStop') Object.assign(sharing, { running: false, connected: false, pairingCode: null })
          return { ok: true, data: structuredClone(sharing) }
        } },
      storage: { local: { get: async () => structuredClone(storage), set: async value => Object.assign(storage, value) }, onChanged: { addListener() {}, removeListener() {} } },
      commands: { getAll: async () => [] },
    })
  })
  await page.goto('/?settings=1')
  await page.getByRole('button', { name: '生成配对码', exact: true }).click()
  await expect(page.getByRole('heading', { name: '等待另一台输入配对码' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '一次性配对码', exact: true })).toHaveValue('MS2.test-invitation')
  await page.getByRole('button', { name: '取消配对' }).click()
  const connect = page.getByRole('button', { name: '连接并开启共享', exact: true })
  await expect(connect).toBeDisabled()
  await page.getByRole('textbox', { name: '另一台电脑的配对码' }).fill('MS2.peer-code')
  await connect.click()
  await expect(page.getByText('已连接，可以切换', { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => window.__sharingCalls)
  expect(calls.find(call => call.request.action === 'sharingPairJoin')).toMatchObject({ confirmed: true, request: { code: 'MS2.peer-code', profile: { name: 'Manjaro', platform: { os: 'linux', hostname: 'Manjaro' }, input: 15, monitor: { name: 'Dell' } } } })
  await page.screenshot({ path: 'docs/screenshots/sharing-connected.png', fullPage: true })
  await expect(page.locator('.local-settings')).not.toHaveAttribute('open')
  await expect(page.locator('.advanced-options')).not.toHaveAttribute('open')
  await expect(page.getByRole('button', { name: '停止键鼠共享', exact: true })).not.toBeVisible()
  await page.getByText('连接管理', { exact: true }).click()
  await page.getByRole('button', { name: '停止键鼠共享', exact: true }).click()
  await expect(page.getByRole('button', { name: '生成配对码', exact: true })).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/sharing-settings.png', fullPage: true })
  await page.getByRole('combobox', { name: /语言|Language/ }).selectOption('en')
  await expect(page.getByRole('heading', { name: 'Keyboard and mouse sharing' })).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/sharing-settings-en.png', fullPage: true })
})

test('installed users can reopen downloads without old host dismissing the page', async ({ page }) => {
  await mockInstallerDownloads(page)
  await page.addInitScript(() => {
    chrome.runtime.sendMessage = async () => ({ ok: true, data: {
      version: '0.1.0', platform: { os: 'linux', arch: 'x86_64', hostname: 'Installed' },
      backend: { name: 'ddcutil', available: true }, displays: [], warnings: [],
      systemSetup: { needsRepair: false, canRepair: true, issues: [] },
    } })
  })
  await page.goto('/?settings=1')
  await page.getByText('更多选项', { exact: true }).click()
  await page.getByRole('button', { name: '重新下载组件', exact: true }).click()
  await page.getByRole('button', { name: '下载组件', exact: true }).click()
  await page.evaluate(() => window.__monoswitchDownloads.change('complete'))
  await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新检测', exact: true }).click()
  await expect(page.getByRole('button', { name: '复制安装命令', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新下载', exact: true }).click()
  expect(await page.evaluate(() => window.__monoswitchDownloads.calls.download.length)).toBe(2)
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByText('更多选项', { exact: true }).click()
  await expect(page.getByRole('button', { name: '重新下载组件', exact: true })).toBeVisible()
})

test('one page keeps daily controls visible and secondary setup collapsed at narrow widths', async ({ page }) => {
  for (const width of [320, 440, 680, 960, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/?demo=1')
    await expect(page.getByRole('button', { name: '切换到 MacBook Pro', exact: true })).toBeVisible()
    await expect(page.locator('.local-settings')).not.toHaveAttribute('open')
    await expect(page.locator('.advanced-options')).not.toHaveAttribute('open')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByLabel('Language / 语言').selectOption('en')
    await expect(page.getByRole('button', { name: 'Switch to MacBook Pro', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const layout = await page.locator('.workspace-grid').evaluate(el => {
      const sharing = el.querySelector('.sharing-panel').getBoundingClientRect()
      const settings = el.querySelector('.settings-stack').getBoundingClientRect()
      return { width: el.getBoundingClientRect().width, sideBySide: settings.left >= sharing.right }
    })
    expect(layout.width).toBeGreaterThan(width * 0.8)
    expect(layout.sideBySide).toBe(width >= 960)
    await page.getByLabel('Language / 语言').selectOption('zh-CN')
    if (width === 1440) await page.screenshot({ path: 'docs/screenshots/control-wide.png', fullPage: true })
  }
  await page.goto('/?demo=1&settings=1')
  await expect(page.getByRole('button', { name: '切换到 MacBook Pro', exact: true })).toBeVisible()
  await expect(page.locator('.advanced-options')).not.toHaveAttribute('open')
})

for (const fails of [false, true]) {
  test(`small window closes only its source tab after successful creation: failure ${fails}`, async ({ page }) => {
    await mockInstallerDownloads(page)
    await page.addInitScript(() => {
      window.__windowCalls = []
      chrome.tabs = {
        getCurrent: async () => ({ id: 42 }),
        remove: async id => window.__windowCalls.push({ action: 'close', id }),
      }
      chrome.windows = {
        create: options => new Promise((resolve, reject) => {
          window.__windowCalls.push({ action: 'open', options })
          window.__finishWindow = fails => fails ? reject(new Error('blocked')) : resolve({ id: 7 })
        }),
      }
    })
    await page.goto('/')
    await page.getByRole('button', { name: '打开小窗口', exact: true }).click()
    await expect(page.getByRole('button', { name: '打开小窗口', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => window.__windowCalls.map(call => call.action))).toEqual(['open'])
    await page.evaluate(fails => window.__finishWindow(fails), fails)
    if (fails) {
      await expect(page.getByRole('alert')).toContainText('无法打开小窗口')
      expect(await page.evaluate(() => window.__windowCalls.map(call => call.action))).toEqual(['open'])
    } else {
      await expect.poll(() => page.evaluate(() => window.__windowCalls.at(-1))).toEqual({ action: 'close', id: 42 })
      expect(await page.evaluate(() => window.__windowCalls[0].options.url)).toContain('index.html?popup=1&window=1')
    }
  })
}
