const CONNECT_TIMEOUT_MS = 8000
const RECONNECT_DELAY_MS = 2000
const CALL_TIMEOUT_MS = 10000

const DEBUG = import.meta.env.DEV
const log = (name: string, ...args: unknown[]) => {
  if (DEBUG) console.log(`%c[rpc ${name}]`, 'color:#06b6d4', ...args)
}
const warn = (name: string, ...args: unknown[]) => {
  if (DEBUG) console.warn(`[rpc ${name}]`, ...args)
}

let seq = 0
const nextId = () => `${++seq}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

interface Pending {
  method: string
  sentAt: number
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcClient {
  private url: string
  private token: string
  private name: string
  private ws: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private outbox: string[] = []
  private closed = false
  private openedResolve: (() => void) | null = null
  opened!: Promise<void>

  constructor(url: string, token: string, name?: string) {
    this.url = url
    this.token = token
    this.name = name || url

    this.resetOpened()
    this.connect()
  }

  private resetOpened() {
    this.opened = new Promise<void>(resolve => {
      this.openedResolve = resolve
    })
  }

  private connect() {
    if (this.closed) return
    const t0 = performance.now()
    log(this.name, 'connecting →', this.url)

    const ws = new WebSocket(this.url)
    this.ws = ws
    let opened = false

    const timer = setTimeout(() => {
      if (opened) return
      warn(this.name, `connect timeout after ${CONNECT_TIMEOUT_MS}ms`)
      ws.close()
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      opened = true
      clearTimeout(timer)
      log(this.name, `open in ${(performance.now() - t0).toFixed(0)}ms (flush ${this.outbox.length})`)
      this.openedResolve?.()
      this.openedResolve = null
      for (const m of this.outbox) ws.send(m)
      this.outbox = []
    }

    ws.onmessage = e => {
      const data = typeof e.data === 'string' ? e.data : String(e.data)
      let msg: { id?: string | number | null; result?: unknown; error?: { code?: number; message?: string } }
      try { msg = JSON.parse(data) } catch { return }
      if (msg.id == null) return
      const id = String(msg.id)
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      const dt = (performance.now() - p.sentAt).toFixed(0)
      if (msg.error) {
        warn(this.name, `← ${p.method} (${dt}ms) error`, msg.error)
        p.reject(new Error(msg.error.message || 'rpc error'))
      } else {
        log(this.name, `← ${p.method} ${dt}ms ${data.length}B (pending=${this.pending.size})`)
        p.resolve(msg.result)
      }
    }

    ws.onclose = ev => {
      clearTimeout(timer)
      this.ws = null
      if (!opened) {
        warn(this.name, `close before open code=${ev.code}`)
      } else {
        log(this.name, `close code=${ev.code} pending=${this.pending.size}`)
        if (!this.openedResolve && !this.closed) this.resetOpened()
      }
      if (!this.closed) setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
    }

    ws.onerror = () => warn(this.name, 'ws error')
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeout = CALL_TIMEOUT_MS,
  ): Promise<T> {
    await this.opened
    const id = nextId()
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: { token: this.token, ...params },
      id,
    })
    const queued = this.ws?.readyState !== WebSocket.OPEN
    log(this.name, `→ ${method} ${queued ? '(queued)' : ''} ${payload.length}B`)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        warn(this.name, `× ${method} timeout ${timeout}ms`)
        reject(new Error(`${method} 超时`))
      }, timeout)
      this.pending.set(id, {
        method,
        sentAt: performance.now(),
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      if (queued) this.outbox.push(payload)
      else this.ws!.send(payload)
    })
  }

  close() {
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('connection closed'))
    }
    this.pending.clear()
    this.outbox = []
    this.ws?.close()
    this.ws = null
  }
}
