import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, chmod, symlink, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const source = await readFile(new URL('../shared/linux-setup.sh', import.meta.url), 'utf8')

// Exercise the complete privileged recipe in an unprivileged filesystem with
// fake package/module/udev commands. Never invoke sudo, pkexec or host mutations.
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'monoswitch-system-test-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const name of ['mkdir', 'flock']) await symlink(`/usr/bin/${name}`, join(bin, name))
    const helper = `#!/bin/sh
name=\${0##*/}
printf '%s\\n' "\$name \$*" >> "\$TEST_LOG"
case "\$name" in
  pacman|apt-get|dnf|zypper)
    printf '#!/bin/sh\\nexit 0\\n' > "\$TEST_BIN/ddcutil"
    /usr/bin/chmod u+x "\$TEST_BIN/ddcutil" ;;
  modprobe) [ "\$FAIL_MODULE" != 1 ] || exit 9 ;;
esac
`
    for (const name of ['pacman', 'apt-get', 'dnf', 'zypper', 'modprobe', 'udevadm']) {
      await writeFile(join(bin, name), helper)
      await chmod(join(bin, name), 0o755)
    }
    const script = source.replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH='${bin}'`)
      .replaceAll('/etc/', `${root}/etc/`).replaceAll('/usr/lib/', `${root}/usr/lib/`)
      .replaceAll('/run/monoswitch', `${root}/run/monoswitch`)
    const execute = (manager, fail = '') => spawnSync('/bin/sh', ['-c', script, 'test', manager], {
      encoding: 'utf8', env: { TEST_BIN: bin, TEST_LOG: join(root, 'calls'), FAIL_MODULE: fail },
    })
    await run({ root, bin, execute, log: () => readFile(join(root, 'calls'), 'utf8') })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('Linux setup installs only the required package, persists module and grants video-session access', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ root, execute, log }) => {
    const result = execute('pacman')
    assert.equal(result.status, 0, result.stderr)
    assert.match(await log(), /pacman -S --needed --noconfirm ddcutil/)
    assert.equal(await readFile(join(root, 'etc/modules-load.d/monoswitch-i2c.conf'), 'utf8'), 'i2c-dev\n')
    assert.match(await readFile(join(root, 'etc/udev/rules.d/60-monoswitch-i2c.rules'), 'utf8'), /ATTRS\{class\}=="0x03\*", TAG\+="uaccess"/)
    assert.match(await log(), /udevadm trigger --action=add --subsystem-match=i2c-dev/)
    assert.equal(execute('pacman').status, 0)
    assert.equal((await log()).match(/pacman /g).length, 1, 'a second setup must not reinstall the package')
  })
})

test('Linux setup stops on module failure and does not claim reboot persistence', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ root, execute, log }) => {
    assert.equal(execute('pacman', '1').status, 9)
    await assert.rejects(access(join(root, 'etc/modules-load.d/monoswitch-i2c.conf')))
    assert.doesNotMatch(await log(), /udevadm/)
  })
})

test('Linux setup refuses unsupported package installation and preserves existing distribution rules', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ root, execute }) => {
    assert.equal(execute('unknown').status, 2)
    await mkdir(join(root, 'usr/lib/udev/rules.d'), { recursive: true })
    const rule = join(root, 'usr/lib/udev/rules.d/60-ddcutil-i2c.rules')
    await writeFile(rule, 'existing distribution rule')
    assert.equal(execute('apt').status, 0)
    assert.equal(await readFile(rule, 'utf8'), 'existing distribution rule')
    await assert.rejects(access(join(root, 'etc/udev/rules.d/60-monoswitch-i2c.rules')))
  })
})
