export const REPAIR_KEY = 'monoswitch.systemSetup'

export interface RepairProgress {
  running: boolean
  message: string
  failed: boolean
}

export function readRepairProgress(value: unknown): RepairProgress {
  const data = value as Partial<RepairProgress> | null
  return {
    running: data?.running === true,
    message: typeof data?.message === 'string' ? data.message : '',
    failed: data?.failed === true,
  }
}
