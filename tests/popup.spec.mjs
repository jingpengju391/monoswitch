import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extensionId } from '../scripts/host-config.mjs'

// An ordinary page viewport cannot reproduce Chrome's popup auto-sizing.
test('real toolbar popup requests its width and detached mode closes the source tab', async () => {
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
    const cdp = await context.newCDPSession(page)
    await page.evaluate(() => chrome.action.openPopup())
    let target
    await expect.poll(async () => {
      target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.includes('index.html?popup=1'))
      return Boolean(target)
    }).toBe(true)
    // Toolbar views appear as CDP targets, not normal Playwright pages.
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
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
    const smallPagePromise = context.waitForEvent('page')
    await page.getByRole('button', { name: '打开小窗口', exact: true }).click()
    const smallPage = await smallPagePromise
    await expect(smallPage).toHaveURL(/popup=1&window=1/)
    await expect.poll(() => page.isClosed()).toBe(true)
    await expect(smallPage.locator('.detached-page')).toBeVisible()
    expect(await smallPage.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(900)
  } finally {
    await context?.close()
    xvfb.kill()
    await rm(profile, { recursive: true, force: true })
  }
})
