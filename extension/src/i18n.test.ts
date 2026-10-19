import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, diagnostic, locale, t } from './i18n'

afterEach(() => { locale.value = 'zh-CN' })
describe('language selection and translation', () => {
  it.each(['zh-CN', 'zh-TW', 'zh-HK', 'ZH-cn'])('selects Chinese for %s', language => {
    expect(detectLocale(language)).toBe('zh-CN')
  })
  it.each(['en-US', 'en-GB', 'fr-FR', ''])('uses English for %s', language => {
    expect(detectLocale(language)).toBe('en')
  })
  it('switches existing messages immediately without rewriting stored data', () => {
    const message = '下载组件'
    locale.value = 'en'
    expect(t(message)).toBe('Download component')
    expect(t('切换到 办公电脑')).toBe('Switch to 办公电脑')
    expect(t('2 台显示器已检测')).toBe('2 display(s) detected')
    expect(t('电脑名称无效。')).toBe('Invalid Computer name.')
    expect(t('输入源 17')).toBe('Input 17')
    expect(t(null)).toBe('')
    locale.value = 'zh-CN'
    expect(t(message)).toBe(message)
  })
  it('translates backend messages while preserving diagnostic details', () => {
    locale.value = 'en'
    expect(diagnostic('显示器控制程序未完成请求。 No /dev/i2c devices exist.'))
      .toBe('The display control program did not complete the request. No /dev/i2c devices exist.')
    expect(t('DELL S2722QC')).toBe('DELL S2722QC')
  })
})
