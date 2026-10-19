import { describe, expect, it } from 'vitest'
import {
  activeDisplay,
  DEFAULT_SETTINGS,
  readOperation,
  readSettings,
  switchBlock,
} from './state'
import { fixtures } from './test-fixtures'

describe('switch readiness', () => {
  it('allows a configured supported target on the same monitor', () => {
    const { status, settings } = fixtures()
    expect(switchBlock(status, settings)).toBeNull()
  })
  it('requires a connected backend, selected monitor, input and peer', () => {
    const { status, settings } = fixtures()
    expect(switchBlock(null, settings)).toContain('本地服务')
    expect(switchBlock(status, { ...settings, displayId: '' })).toContain(
      '显示器',
    )
    expect(switchBlock(status, { ...settings, localInput: null })).toContain(
      '本机',
    )
    expect(switchBlock(status, { ...settings, peer: null })).toContain('导入')
    status.backend.available = false
    expect(switchBlock(status, settings)).toContain('本地服务')
  })
  it('rejects matching input ports and mismatched physical monitors', () => {
    const { status, settings } = fixtures()
    settings.peer!.input = 15
    expect(switchBlock(status, settings)).toContain('不同的输入接口')
    settings.peer!.input = 17
    settings.peer!.monitor.serial = 'DIFFERENT'
    expect(switchBlock(status, settings)).toContain('序列号')
  })
  it('rejects an input absent from monitor-reported capabilities', () => {
    const { status, settings } = fixtures()
    settings.peer!.input = 18
    expect(switchBlock(status, settings, true)).toContain('未报告支持')
  })
  it('requires explicit confirmation on every standard-fallback switch', () => {
    const { status, settings } = fixtures()
    status.displays[0]!.inputDetection = 'standard'
    expect(switchBlock(status, settings)).toContain('确认')
    expect(switchBlock(status, settings, true)).toBeNull()
  })
  it('does not silently select another display when a saved one disappears', () => {
    const { status, settings } = fixtures()
    settings.displayId = 'missing'
    expect(activeDisplay(status, settings)).toBeUndefined()
  })
  it('does not switch unsupported displays even if the input is known', () => {
    const { status, settings } = fixtures()
    status.displays[0]!.canSwitch = false
    expect(switchBlock(status, settings, true)).toContain('暂不支持')
  })
})

describe('saved data validation', () => {
  it('discards malformed imported data and invalid source values', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(
      readSettings({
        peer: {},
        localInput: 999,
        localName: 'office\nroom',
        extra: true,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, localName: 'officeroom' })
  })
  it('recognizes only well-formed operation records', () => {
    expect(readOperation({ state: 'done' })).toBeNull()
    expect(
      readOperation({ state: 'accepted', message: 'Sent', timestamp: 1 }),
    ).toEqual({ state: 'accepted', message: 'Sent', timestamp: 1 })
  })
})
