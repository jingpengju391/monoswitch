import { ref } from 'vue'
import { english } from './locales/en'

export type Locale = 'zh-CN' | 'en'
export const LANGUAGE_KEY = 'monoswitch.language'
export function detectLocale(language: string): Locale {
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}
export const locale = ref<Locale>(detectLocale(globalThis.navigator?.language ?? 'en'))
const extension = () => typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id)
function valid(value: unknown): value is Locale { return value === 'zh-CN' || value === 'en' }
function apply(value: Locale) {
  locale.value = value
  document.documentElement.lang = value
  document.title = value === 'en' ? 'MonoSwitch · One display, two computers' : 'MonoSwitch · 一屏，两台电脑'
}

export async function initLocale() {
  try {
    const stored = extension()
      ? (await chrome.storage.local.get(LANGUAGE_KEY))[LANGUAGE_KEY]
      : localStorage.getItem(LANGUAGE_KEY)
    apply(valid(stored) ? stored : locale.value)
  } catch { apply(locale.value) }
  if (extension()) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && LANGUAGE_KEY in changes) {
      const value = changes[LANGUAGE_KEY].newValue
      apply(valid(value) ? value : detectLocale(navigator.language))
    }
  })
  else window.addEventListener('storage', event => {
    if (event.key === LANGUAGE_KEY) apply(valid(event.newValue) ? event.newValue : detectLocale(navigator.language))
  })
}

export async function setLocale(value: string) {
  if (!valid(value)) return
  apply(value)
  try {
    if (extension()) await chrome.storage.local.set({ [LANGUAGE_KEY]: value })
    else localStorage.setItem(LANGUAGE_KEY, value)
  } catch { /* Keep the selected language for the current page. */ }
}

// Translate presentation only. Profiles, hardware names and protocol data stay unchanged.
export function t(value: unknown): string {
  if (value == null) return ''
  const text = String(value)
  if (locale.value === 'zh-CN') return text
  const key = text.replace(/\s+/gu, ' ').trim()
  if (english[key]) return english[key]
  if (/^切换到 /u.test(text)) return `Switch to ${text.slice(4)}`
  if (/^\d+ 台显示器已检测$/u.test(text)) return `${text.split(' ')[0]} display(s) detected`
  if (/^输入源 \d+$/u.test(text)) return text.replace('输入源', 'Input')
  if (text.endsWith('无效。')) return `Invalid ${t(text.slice(0, -3))}.`
  return text
}

// Preserve backend diagnostics while translating known application messages.
const diagnosticPattern = new RegExp(Object.keys(english).sort((a, b) => b.length - a.length)
  .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu')
export function diagnostic(value: unknown): string {
  const text = t(value)
  return locale.value === 'en' ? text.replace(diagnosticPattern, key => english[key]!) : text
}
