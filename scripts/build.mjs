import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { extensionId } from './host-config.mjs'
import { archiveDirectory, hash, makeInstaller, targetPlatform, verifyBinary, writeCatalog } from './artifacts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { target: { type: 'string' }, zig: { type: 'boolean', default: false }, 'bundle-only': { type: 'boolean', default: false } } })

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败 (${result.status})`)
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, 'extension', 'public', 'manifest.json'), 'utf8'))
  const id = extensionId(manifest.key)
  if (!values['bundle-only']) {
    const platform = values.target ? targetPlatform(values.target) : { os: { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform], arch: { x64: 'x86_64', arm64: 'aarch64' }[process.arch] }
    if (!platform.os || !platform.arch) throw new Error('当前平台不受支持')
    const targetArgs = values.target ? ['--target', values.target] : []
    const native = join(root, 'native', 'target', ...(values.target ? [values.target] : []), 'release', platform.os === 'windows' ? 'monoswitch-host.exe' : 'monoswitch-host')
    const setup = join(root, 'setup', 'target', ...(values.target ? [values.target] : []), 'release', platform.os === 'windows' ? 'monoswitch-setup.exe' : 'monoswitch-setup')
    const buildCommand = values.zig ? 'zigbuild' : 'build'
    const buildEnv = platform.os === 'macos' ? { ...process.env, MACOSX_DEPLOYMENT_TARGET: '13.0' } : process.env
    run('cargo', [buildCommand, '--locked', '--release', '--manifest-path', 'native/Cargo.toml', '--target-dir', 'native/target', ...targetArgs], buildEnv)
    await verifyBinary(native, platform.os, platform.arch)
    run('cargo', [buildCommand, '--locked', '--release', '--manifest-path', 'setup/Cargo.toml', '--target-dir', 'setup/target', ...targetArgs], { ...buildEnv, MONOSWITCH_SETUP_BINARY: native, MONOSWITCH_EXTENSION_ID: id })
    await makeInstaller({ root, binary: setup, ...platform, version: manifest.version, extensionId: id })
  }
  const installers = await writeCatalog(root, manifest.version, id)
  // npm itself is a JS entrypoint; using Node avoids invoking npm.cmd via a shell on Windows.
  if (!process.env.npm_execpath) throw new Error('请通过 npm run build 运行此脚本。')
  run(process.execPath, [process.env.npm_execpath, '--prefix', 'extension', 'run', 'build'])
  await mkdir(join(root, 'releases'), { recursive: true })
  for (const item of installers) await copyFile(join(root, 'extension', 'public', item.file), join(root, 'releases', item.file.split('/').at(-1)))
  const archive = join(root, 'releases', `monoswitch-extension-v${manifest.version}.zip`)
  await archiveDirectory(join(root, 'extension', 'dist'), archive)
  const sums = installers.map(item => `${item.sha256}  ${item.file.split('/').at(-1)}`)
  sums.push(`${hash(await readFile(archive))}  monoswitch-extension-v${manifest.version}.zip`)
  await writeFile(join(root, 'releases', 'SHA256SUMS'), `${sums.join('\n')}\n`)
  console.log(`\n扩展 ID：${id}\n发行扩展：${archive}\n已内置 ${installers.length} 个平台安装器。用户无需安装 Node.js 或 Rust。`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
