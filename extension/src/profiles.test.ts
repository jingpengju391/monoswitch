import { describe, expect, it } from 'vitest'
import type { ComputerProfile } from '../../shared/protocol'
import {
  decodeProfile,
  encodeProfile,
  platformLabel,
  validateProfile,
} from './profiles'

const profile: ComputerProfile = {
  version: 1,
  name: '书房电脑 🖥️',
  input: 17,
  platform: {
    os: 'linux',
    arch: 'x86_64',
    hostname: 'studio',
    distribution: 'Manjaro Linux',
  },
  monitor: { name: 'DELL U2723QE', serial: 'ABC123' },
}

describe('portable computer profiles', () => {
  it('round-trips Unicode and reports the actual exported Linux distribution', () => {
    expect(decodeProfile(encodeProfile(profile))).toEqual(profile)
    expect(platformLabel(profile.platform)).toBe('Manjaro Linux')
  })
  it('removes unknown fields at every level', () => {
    expect(
      validateProfile({
        ...profile,
        command: 'do-not-run',
        platform: { ...profile.platform, command: 'do-not-run' },
        monitor: { ...profile.monitor, url: 'file:///etc/passwd' },
      }),
    ).toEqual(profile)
  })
  it.each([0, -1, 256, 17.5, '17', null, false])(
    'rejects invalid input values: %s',
    (input) => {
      expect(() => validateProfile({ ...profile, input })).toThrow('输入源')
    },
  )
  it.each(['MS1.!!!', 'MS1.eyJhIjox', 'broken', 'MS1.' + 'a'.repeat(8193)])(
    'rejects corrupt, missing-version and oversized payloads',
    (text) => {
      expect(() => decodeProfile(text)).toThrow()
    },
  )
  it('rejects unsupported versions, platforms, long names and control characters', () => {
    expect(() => validateProfile({ ...profile, version: 2 })).toThrow('版本')
    expect(() =>
      validateProfile({
        ...profile,
        platform: { ...profile.platform, os: 'unknown' },
      }),
    ).toThrow('操作系统')
    expect(() => validateProfile({ ...profile, name: 'a'.repeat(61) })).toThrow(
      '名称',
    )
    expect(() => validateProfile({ ...profile, name: 'my\ncomputer' })).toThrow(
      '名称',
    )
  })
  it('rejects malformed structures and invalid UTF-8', () => {
    expect(() => validateProfile(null)).toThrow()
    expect(() => validateProfile({ ...profile, monitor: [] })).toThrow()
    expect(() => decodeProfile('MS1.' + btoa('\xff'))).toThrow('损坏')
  })
})

 it('round-trips keyboard identities and rejects altered fingerprints', () => {
  const sharing = { id: 'ms-' + 'a'.repeat(16), fingerprint: 'a'.repeat(64) }
  expect(decodeProfile(encodeProfile({ ...profile, sharing })).sharing).toEqual(sharing)
  expect(() => validateProfile({ ...profile, sharing: { ...sharing, fingerprint: 'b'.repeat(64) } })).toThrow()
  expect(() => validateProfile({ ...profile, sharing: { ...sharing, id: 'bad\\nname' } })).toThrow()
})
