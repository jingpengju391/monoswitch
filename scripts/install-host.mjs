import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { extensionId, hostManifest, installPaths } from './host-config.mjs'
import { uninstallDevelopmentHost } from './uninstall-host.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const { values } = parseArgs({ options: {
    browser: { type: 'string', default: 'chrome' },
    binary: { type: 'string' },
    'extension-id': { type: 'string' },
    uninstall: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  } })
  const locations = installPaths({ platform: process.platform, home: homedir(), env: process.env, browser: values.browser })
  if (values.uninstall) {
    const result = await uninstallDevelopmentHost({ locations, platform: process.platform, dryRun: values['dry-run'] })
    if (values['dry-run']) return console.log(JSON.stringify(result, null, 2))
    for (const warning of result.warnings) console.log(warning)
    console.log(result.removeManifest ? '已移除开发版程序的浏览器注册。扩展可在 chrome://extensions 中移除。' : '未移除任何开发版注册。')
    console.log(`共享程序保留于：${locations.directory}`)
    return
  }
  let manifest
  for (const candidate of ['extension/public/manifest.json', 'extension/manifest.json']) {
    try { manifest = JSON.parse(await readFile(join(root, candidate), 'utf8')); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!manifest) throw new Error('找不到扩展 manifest.json。请在完整项目或发行包内运行。')
  const id = values['extension-id'] || extensionId(manifest.key)
  const config = hostManifest(locations.binary, id)
  const source = values.binary
    ? resolve(values.binary)
    : join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'monoswitch-host.exe' : 'monoswitch-host')
  if (values['dry-run']) return console.log(JSON.stringify({ source, ...locations, config }, null, 2))
  if (!(await stat(source).catch(() => null))?.isFile()) throw new Error(`找不到编译后的程序：${source}\n请先运行 npm run build，或用 --binary 指定本系统的发行版程序。`)
  await mkdir(locations.directory, { recursive: true })
  await mkdir(dirname(locations.manifest), { recursive: true })
  if (resolve(source) !== resolve(locations.binary)) await copyFile(source, locations.binary)
  if (process.platform !== 'win32') await chmod(locations.binary, 0o755)
  await writeFile(locations.manifest, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  if (locations.registry) run('reg.exe', ['add', locations.registry, '/ve', '/t', 'REG_SZ', '/d', locations.manifest, '/f'])
  console.log(`已为 ${values.browser} 安装 MonoSwitch 本地程序。`)
  console.log(`扩展 ID：${id}`)
  console.log(`注册文件：${locations.manifest}`)
  console.log('请加载 extension/dist，打开扩展并点击刷新。两台电脑都需要安装。')
  console.log('此步骤只注册程序，不安装系统依赖，也不会切换显示器。')
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} 执行失败`)
}

main().catch(error => { console.error(`操作失败：${error.message}`); process.exitCode = 1 })
