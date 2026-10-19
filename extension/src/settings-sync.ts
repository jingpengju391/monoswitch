import { ref, watch } from 'vue'
import type { Settings } from '../../shared/protocol'
import { DEFAULT_SETTINGS, readSettings } from './state'

interface SavedSettings extends Settings {
  _sync: { writer: string; revision: number }
}

/** Synchronize pages while keeping old acknowledgements out of newer edits. */
export function createSettingsSync(
  write: (settings: Settings) => Promise<void>,
  onError: () => void,
) {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
  const writer = crypto.randomUUID()
  let revision = 0
  let initialized = false
  let applyingStored = false
  let saving = false
  let queued: SavedSettings | null = null
  let pending: Promise<void> = Promise.resolve()

  const stop = watch(
    settings,
    () => {
      if (!initialized || applyingStored) return
      queued = {
        ...readSettings(JSON.parse(JSON.stringify(settings.value))),
        _sync: { writer, revision: ++revision },
      }
      // Keep just the newest waiting snapshot. The active write still finishes
      // first, so flush also covers edits made while that write was in flight.
      if (saving) return
      saving = true
      pending = pending.catch(() => {}).then(async () => {
        try {
          while (queued) {
            const next = queued
            queued = null
            await write(next)
          }
        } finally {
          saving = false
        }
      })
      void pending.catch(onError)
    },
    { deep: true, flush: 'sync' },
  )

  function applyStored(value: unknown): void {
    const stamp = (value as Partial<SavedSettings> | null)?._sync
    // Chrome broadcasts storage changes to the writing page too. A delayed
    // acknowledgement must not replace edits made since that snapshot.
    if (stamp?.writer === writer && stamp.revision < revision) return
    applyingStored = true
    try {
      settings.value = readSettings(value)
    } finally {
      applyingStored = false
    }
  }

  return {
    settings,
    applyStored,
    initialize(value: unknown) {
      applyStored(value)
      initialized = true
    },
    flush: () => pending,
    stop,
  }
}
