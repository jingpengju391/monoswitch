import { HOST_NAME, type NativeRequest, type NativeResponse } from '../../shared/protocol'

/** One ordered native port owns the backend, independent of popup lifetime. */
export function createSharingConnection(api = chrome) {
  let port: chrome.runtime.Port | null = null
  let pending: ((response: NativeResponse<unknown>) => void) | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const failed = (): NativeResponse<never> => ({ ok: false, error: { code: 'SHARING_DISCONNECTED', message: '键鼠共享连接已断开，请重新启动共享。' } })
  function close() {
    const current = port
    port = null
    const callback = pending
    pending = null
    callback?.(failed())
    current?.disconnect()
  }
  function open() {
    if (port) return port
    const current = api.runtime.connectNative(HOST_NAME)
    port = current
    current.onMessage.addListener(response => {
      if (port !== current) return
      const callback = pending
      pending = null
      callback?.(response)
    })
    current.onDisconnect.addListener(() => {
      void api.runtime.lastError
      if (port === current) {
        port = null
        const callback = pending
        pending = null
        callback?.(failed())
      }
    })
    return current
  }
  function request(message: NativeRequest): Promise<NativeResponse<unknown>> {
    const next = queue.then(() => new Promise<NativeResponse<unknown>>(resolve => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (response: NativeResponse<unknown>) => {
        clearTimeout(timeout)
        resolve(response)
        if (message.action === 'sharingStop' || (message.action === 'sharingStart' && !response.ok)) close()
      }
      try {
        const current = open()
        pending = finish
        // Closing a stuck native session also terminates its owned input backend.
        timeout = setTimeout(close, 15_000)
        current.postMessage(message)
      } catch { close(); finish(failed()) }
    }))
    queue = next.catch(() => {})
    return next
  }
  return { request, connected: () => port !== null, close }
}
