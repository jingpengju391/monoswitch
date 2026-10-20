import type { NativeRequest, NativeResponse, SharingStatus, Settings } from '../../shared/protocol'
import { SETTINGS_KEY, readSettings } from './state'

/** Only accept metadata from the identity already paired in this browser. */
export async function syncNames(
  result: NativeResponse<unknown>,
  request: (message: NativeRequest) => Promise<NativeResponse<unknown>>,
  storage = chrome.storage.local,
): Promise<void> {
  if (!result.ok) return
  const status = result.data as SharingStatus
  // Capability gating keeps older installed hosts working until upgraded.
  if (!status.nameSync || !status.running || !status.peerIdentity) return
  const matches = (settings: Settings) => settings.peer?.sharing?.id === status.peerIdentity?.id
    && settings.peer?.sharing?.fingerprint === status.peerIdentity?.fingerprint
  let settings = readSettings((await storage.get(SETTINGS_KEY))[SETTINGS_KEY])
  if (!matches(settings)) return
  const name = settings.localName.trim()
  if (status.localName !== name) await request({ action: 'sharingSetName', name })
  if (typeof status.peerName !== 'string' || !status.peerName.trim()
    || Array.from(status.peerName).length > 60 || /[\u0000-\u001f\u007f]/u.test(status.peerName)) return
  // Re-read after the native round trip so a concurrent rename or pairing is preserved.
  settings = readSettings((await storage.get(SETTINGS_KEY))[SETTINGS_KEY])
  if (!matches(settings) || settings.peer!.name === status.peerName) return
  await storage.set({ [SETTINGS_KEY]: { ...settings, peer: { ...settings.peer!, name: status.peerName } } })
}
