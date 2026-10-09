// Newline-delimited JSON-RPC 2.0 over a pair of byte streams.
//
// Framing splits on "\n" ONLY. node:readline also breaks lines on U+2028 /
// U+2029 (and lone "\r"), which JSON.stringify leaves unescaped inside
// strings — a model writing either character would tear a frame in half.
//
// Used by both ends we own: the ACP agent (stdin/stdout towards the proxy)
// and the carrier CLI-tools MCP server (stdin/stdout towards pi-mcp-adapter).

export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603

/** An error a handler throws to answer with a specific JSON-RPC code. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/**
 * Incremental "\n" splitter. Feed it chunks (Buffer or string); it calls
 * `onLine` for every complete line, without its trailing "\r\n" / "\n".
 * Bytes are decoded only once a line is complete, so a multi-byte UTF-8
 * character split across chunks is never mangled.
 */
export function createLineSplitter(onLine) {
  let pending = Buffer.alloc(0)
  return {
    push(chunk) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      pending = pending.length ? Buffer.concat([pending, buf]) : buf
      let start = 0
      let nl
      while ((nl = pending.indexOf(0x0a, start)) !== -1) {
        let end = nl
        if (end > start && pending[end - 1] === 0x0d) end--
        const line = pending.subarray(start, end).toString('utf8')
        start = nl + 1
        if (line.trim()) onLine(line)
      }
      pending = start ? pending.subarray(start) : pending
    },
    /** Flush a final unterminated line (stream ended without "\n"). */
    end() {
      const line = pending.toString('utf8')
      pending = Buffer.alloc(0)
      if (line.trim()) onLine(line)
    },
  }
}

/** One frame → one line. JSON.stringify never emits a raw "\n". */
export function encodeFrame(message) {
  return JSON.stringify(message) + '\n'
}

/**
 * A bidirectional JSON-RPC peer: dispatches incoming requests/notifications
 * to registered handlers, and sends requests of its own with id correlation.
 *
 *   const conn = new JsonRpcConnection({ input: process.stdin, write })
 *   conn.onRequest('initialize', async (params) => ({...}))
 *   conn.onNotification('session/cancel', (params) => {...})
 *   const result = await conn.request('session/request_permission', {...})
 *   conn.start()
 */
export class JsonRpcConnection {
  /**
   * @param {object} opts
   * @param {NodeJS.ReadableStream} [opts.input]  frames in
   * @param {(line: string) => void} opts.write    frames out (one full line)
   * @param {(...args: any[]) => void} [opts.log]  diagnostics (never stdout)
   * @param {string} [opts.idPrefix]               prefix for outgoing request ids
   */
  constructor({ input, write, log = () => {}, idPrefix = '' }) {
    this.input = input
    this.write = write
    this.log = log
    this.idPrefix = idPrefix
    this.requestHandlers = new Map()
    this.notificationHandlers = new Map()
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    this._closeListeners = []
  }

  onRequest(method, handler) { this.requestHandlers.set(method, handler); return this }
  onNotification(method, handler) { this.notificationHandlers.set(method, handler); return this }
  onClose(listener) { this._closeListeners.push(listener) }

  start() {
    const splitter = createLineSplitter((line) => this.handleLine(line))
    this.input.on('data', (chunk) => splitter.push(chunk))
    this.input.on('end', () => { splitter.end(); this.close() })
    this.input.on('error', (err) => { this.log('input error:', err?.message || err); this.close() })
    return this
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const { reject } of this.pending.values()) reject(new RpcError(ERR_INTERNAL, 'connection closed'))
    this.pending.clear()
    for (const l of this._closeListeners) { try { l() } catch { /* ignore */ } }
  }

  send(message) {
    if (this.closed) return
    try {
      this.write(encodeFrame(message))
    } catch (err) {
      this.log('write failed:', err?.message || err)
    }
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Send a request to the peer; resolves with its `result`, rejects on `error`. */
  request(method, params) {
    if (this.closed) return Promise.reject(new RpcError(ERR_INTERNAL, 'connection closed'))
    const id = this.idPrefix ? `${this.idPrefix}${this.nextId++}` : this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      this.log('unparseable frame:', line.slice(0, 200))
      this.send({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: `Parse error: ${err.message}` } })
      return
    }
    if (Array.isArray(msg)) {
      // Batches are not used by ACP or MCP stdio; answer per element anyway.
      for (const m of msg) this.dispatch(m)
      return
    }
    this.dispatch(msg)
  }

  dispatch(msg) {
    if (!msg || typeof msg !== 'object') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: ERR_INVALID_REQUEST, message: 'Invalid Request' } })
      return
    }
    const hasId = msg.id !== undefined && msg.id !== null
    // Response to one of our requests.
    if (!msg.method && hasId && ('result' in msg || 'error' in msg)) {
      const entry = this.pending.get(msg.id)
      if (!entry) {
        this.log('response for unknown request id', msg.id)
        return
      }
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new RpcError(msg.error.code ?? ERR_INTERNAL, msg.error.message || 'error', msg.error.data))
      else entry.resolve(msg.result)
      return
    }
    if (typeof msg.method !== 'string') {
      if (hasId) this.send({ jsonrpc: '2.0', id: msg.id, error: { code: ERR_INVALID_REQUEST, message: 'Invalid Request' } })
      return
    }
    if (!hasId) {
      const handler = this.notificationHandlers.get(msg.method)
      if (!handler) {
        this.log('ignoring unknown notification', msg.method)
        return
      }
      Promise.resolve()
        .then(() => handler(msg.params ?? {}))
        .catch((err) => this.log(`notification ${msg.method} failed:`, err?.message || err))
      return
    }
    const handler = this.requestHandlers.get(msg.method)
    if (!handler) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` } })
      return
    }
    Promise.resolve()
      .then(() => handler(msg.params ?? {}, msg))
      .then(
        (result) => this.send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result }),
        (err) => {
          const code = Number.isInteger(err?.code) ? err.code : ERR_INTERNAL
          if (code === ERR_INTERNAL) this.log(`${msg.method} failed:`, err?.stack || err)
          const error = { code, message: err?.message || String(err) }
          if (err?.data !== undefined) error.data = err.data
          this.send({ jsonrpc: '2.0', id: msg.id, error })
        },
      )
  }
}
