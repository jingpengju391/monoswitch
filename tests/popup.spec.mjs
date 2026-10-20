import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extensionId } from '../scripts/host-config.mjs'

// An ordinary page viewport cannot reproduce Chrome's popup auto-sizing.
test('real toolbar popup keeps its width and remains open after closing the source tab', async () => {
  const tools = process.env.MONOSWITCH_INPUT_TEST_TOOLS
  test.skip(process.platform !== 'linux' || !tools || !existsSync(join(tools, 'usr/bin/Xvfb')), 'Requires isolated Xvfb under MONOSWITCH_INPUT_TEST_TOOLS')
  const profile = await mkdtemp(join(tmpdir(), 'monoswitch-popup-'))
  const xvfb = spawn(join(tools, 'usr/bin/Xvfb'), ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
    env: { ...process.env, LD_LIBRARY_PATH: join(tools, 'usr/lib') }, stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  })
  let context
  try {
    const display = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Xvfb did not start')), 5000)
      xvfb.stdio[3].once('data', data => { clearTimeout(timer); resolve(data.toString().trim()) })
      xvfb.once('exit', () => { clearTimeout(timer); reject(new Error('Xvfb exited')) })
      xvfb.once('error', error => { clearTimeout(timer); reject(error) })
    })
    const path = resolve('extension/dist')
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    const id = extensionId(manifest.key)
    context = await chromium.launchPersistentContext(profile, {
      headless: false, channel: 'chromium', viewport: null, locale: 'zh-CN',
      executablePath: process.env.MONOSWITCH_BROWSER || undefined,
      env: { ...process.env, DISPLAY: `:${display}` },
      args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
    })
    const page = await context.newPage()
    await page.goto(`chrome-extension://${id}/index.html`)
    await page.bringToFront()
    const cdp = await context.browser().newBrowserCDPSession()
    await page.evaluate(() => chrome.action.openPopup())
    let target
    await expect.poll(async () => {
      target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.includes('index.html?popup=1'))
      return Boolean(target)
    }).toBe(true)
    // Toolbar views appear as CDP targets, not normal Playwright pages.
    let { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
    let serial = 0
    async function rpc(method, params = {}) {
      const id = ++serial
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', onmessage); reject(new Error(`Timed out: ${method}`)) }, 5000)
        const onmessage = event => {
          if (event.sessionId !== sessionId) return
          const msg = JSON.parse(event.message)
          if (msg.id !== id) return
          clearTimeout(timer)
          cdp.off('Target.receivedMessageFromTarget', onmessage)
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        }
        cdp.on('Target.receivedMessageFromTarget', onmessage)
      })
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
      return response
    }
    let size
    await expect.poll(async () => {
      const result = await rpc('Runtime.evaluate', {
        expression: 'JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,ready:!!document.querySelector(".setup-card")})', returnByValue: true,
      })
      size = JSON.parse(result.result.value)
      return size.ready && size.width >= 780
    }).toBe(true)
    expect(size.width).toBeLessThanOrEqual(800)
    expect(size.scrollWidth).toBeLessThanOrEqual(size.width)
    expect(size.height).toBeLessThanOrEqual(600)
    await mkdir('docs/screenshots', { recursive: true })
    await writeFile('docs/screenshots/toolbar-popup.png', Buffer.from((await rpc('Page.captureScreenshot')).data, 'base64'))
    await cdp.send('Target.closeTarget', { targetId: target.targetId })
    // Use the actual page button, not a mocked windows API. Closing an inactive
    // source tab must leave the toolbar view attached to the same browser window.
    const before = await page.evaluate(async () => (await chrome.windows.getAll()).length)
    await page.getByRole('button', { name: '打开小窗口', exact: true }).click()
    await expect.poll(() => page.isClosed()).toBe(true)
    await expect.poll(async () => {
      target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('index.html?popup=1'))
      return Boolean(target)
    }).toBe(true)
    ;({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }))
    const countWindows = await rpc('Runtime.evaluate', { expression: '(async () => (await chrome.windows.getAll()).length)()', awaitPromise: true, returnByValue: true })
    expect(countWindows.result.value).toBe(before)
    expect(context.pages().some(p => p.url().includes('window=1'))).toBe(false)
    const width = await rpc('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true })
    expect(width.result.value).toBeGreaterThanOrEqual(780)
    // Also cover a browser window whose only tab is the full extension page.
    await cdp.send('Target.closeTarget', { targetId: target.targetId })
    const onlyPage = await context.newPage()
    await onlyPage.goto(`chrome-extension://${id}/index.html`)
    for (const other of context.pages()) if (other !== onlyPage) await other.close()
    await onlyPage.getByRole('button', { name: '打开小窗口', exact: true }).click()
    await expect.poll(() => onlyPage.isClosed()).toBe(true)
    await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(t => t.url.endsWith('index.html?popup=1'))).toBe(true)
    expect((await cdp.send('Target.getTargets')).targetInfos.some(t => t.type === 'page' && t.url === 'chrome://newtab/')).toBe(true)
  } finally {
    await context?.close()
    xvfb.kill()
    await rm(profile, { recursive: true, force: true })
  }
})
