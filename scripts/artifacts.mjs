import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { zipSync } from 'fflate'

export const hash = data => createHash('sha256').update(data).digest('hex')

export function targetPlatform(target) {
  const os = target.includes('windows') ? 'windows' : target.includes('apple-darwin') ? 'macos' : target.includes('linux') ? 'linux' : null
  const arch = target.startsWith('x86_64-') ? 'x86_64' : target.startsWith('aarch64-') ? 'aarch64' : null
  if (!os || !arch) throw new Error(`不支持的目标：${target}`)
  return { os, arch }
}

export async function verifyBinary(file, os, arch) {
  const handle = await open(file, 'r')
  let found
  try {
    const header = Buffer.alloc(64)
    if ((await handle.read(header, 0, 64, 0)).bytesRead < 64) throw new Error('可执行文件不完整')
    if (header.subarray(0, 6).equals(Buffer.from([0x7f, 69, 76, 70, 2, 1]))) {
      found = ['linux', { 62: 'x86_64', 183: 'aarch64' }[header.readUInt16LE(18)]]
    } else if (header.toString('ascii', 0, 2) === 'MZ') {
      const pe = Buffer.alloc(6)
      await handle.read(pe, 0, 6, header.readUInt32LE(60))
      if (pe.readUInt32LE(0) === 0x4550) found = ['windows', { 0x8664: 'x86_64', 0xaa64: 'aarch64' }[pe.readUInt16LE(4)]]
    } else if (header.readUInt32LE(0) === 0xfeedfacf) {
      found = ['macos', { 0x1000007: 'x86_64', 0x100000c: 'aarch64' }[header.readUInt32LE(4)]]
    }
  } finally { await handle.close() }
  if (found?.[0] !== os || found?.[1] !== arch) throw new Error(`${file} 的二进制格式 ${found} 与 ${os}/${arch} 不符`)
}

export async function makeInstaller({ root, binary, os, arch, version, extensionId }) {
  await verifyBinary(binary, os, arch)
  const directory = join(root, 'extension', 'public', 'installers')
  await mkdir(directory, { recursive: true })
  const name = `monoswitch-setup-v${version}-${os}-${arch}${os === 'windows' ? '.exe' : os === 'linux' ? '.run' : '.zip'}`
  const destination = join(directory, name)
  if (os === 'macos') {
    // Finder expands the .app; preserve the executable bit in the ZIP metadata.
    const app = 'Install MonoSwitch.app/Contents'
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>Install MonoSwitch</string><key>CFBundleIdentifier</key><string>io.monoswitch.setup</string><key>CFBundleExecutable</key><string>monoswitch-setup</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/></dict></plist>`
    await writeFile(destination, zipSync({
      [`${app}/Info.plist`]: [Buffer.from(plist), { os: 3, attrs: (0o100644 << 16) >>> 0 }],
      [`${app}/MacOS/monoswitch-setup`]: [await readFile(binary), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
    }))

  } else {
    await copyFile(binary, destination)
  }
  const data = await readFile(destination)
  const item = { os, arch, version, extensionId, file: `installers/${name}`, size: data.length, sha256: hash(data) }
  await writeFile(join(directory, `${os}-${arch}.meta.json`), `${JSON.stringify(item, null, 2)}\n`)
  return item
}

export async function writeCatalog(root, version, extensionId) {
  const directory = join(root, 'extension', 'public', 'installers')
  await mkdir(directory, { recursive: true })
  const installers = []
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.meta.json')) continue
    const item = JSON.parse(await readFile(join(directory, name), 'utf8'))
    if (item.version !== version || item.extensionId !== extensionId) continue
    if (!/^installers\/monoswitch-setup-v[\d.]+-(windows|linux|macos)-(x86_64|aarch64)\.(exe|run|zip)$/.test(item.file)) throw new Error(`安装包路径不合法：${item.file}`)
    const contents = await readFile(join(directory, basename(item.file)))
    if (contents.length !== item.size || hash(contents) !== item.sha256) throw new Error(`安装包校验失败：${name}`)
    installers.push(item)
  }
  await writeFile(join(directory, 'catalog.json'), `${JSON.stringify({ version, extensionId, installers }, null, 2)}\n`)
  return installers
}

export async function archiveDirectory(directory, destination) {
  const files = {}
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name)
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(full, `${name}/`)
      else if (entry.isFile()) files[name] = [await readFile(full), { os: 3, attrs: ((await stat(full)).mode << 16) >>> 0 }]
    }
  }
  await walk(directory)
  await writeFile(destination, zipSync(files))
}
