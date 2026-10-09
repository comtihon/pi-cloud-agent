// NDJSON framing + JSON-RPC peer (src/acp/protocol.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  createLineSplitter,
  encodeFrame,
  JsonRpcConnection,
  RpcError,
  ERR_METHOD_NOT_FOUND,
  ERR_INTERNAL,
  ERR_PARSE,
} from '../src/acp/protocol.js'

const LS = ' '
const PS = ' '

test('framing: U+2028/U+2029 inside JSON strings do not split a frame', () => {
  const lines = []
  const s = createLineSplitter((l) => lines.push(l))
  const msg = { jsonrpc: '2.0', method: 'x', params: { text: `a${LS}b${PS}c\r` } }
  const frame = encodeFrame(msg)
  // JSON.stringify leaves U+2028 raw — the case readline gets wrong.
  assert.ok(frame.includes(LS))
  s.push(frame)
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), msg)
})

test('framing: frames split across chunks, mid UTF-8 sequence, are reassembled', () => {
  const lines = []
  const s = createLineSplitter((l) => lines.push(l))
  const buf = Buffer.from(encodeFrame({ t: `ü€${LS}😀` }) + encodeFrame({ n: 2 }), 'utf8')
  for (let i = 0; i < buf.length; i += 3) s.push(buf.subarray(i, i + 3))
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ t: `ü€${LS}😀` }, { n: 2 }])
})

test('framing: CRLF, blank lines and a final unterminated line', () => {
  const lines = []
  const s = createLineSplitter((l) => lines.push(l))
  s.push('{"a":1}\r\n\n  \n{"b":2}')
  assert.equal(lines.length, 1)
  s.end()
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }])
})

function pair() {
  const input = new PassThrough()
  const out = []
  const waiters = []
  const conn = new JsonRpcConnection({
    input,
    write: (line) => {
      const msg = JSON.parse(line)
      out.push(msg)
      for (const w of waiters.splice(0)) w()
    },
  })
  const next = async (pred = () => true) => {
    for (;;) {
      const i = out.findIndex(pred)
      if (i >= 0) return out.splice(i, 1)[0]
      await new Promise((r) => waiters.push(r))
    }
  }
  conn.start()
  return { conn, input, next, send: (m) => input.write(encodeFrame(m)) }
}

test('rpc: unknown method → -32601, thrown error → -32603, RpcError keeps its code', async () => {
  const { conn, next, send } = pair()
  conn.onRequest('boom', () => { throw new Error('kaput') })
  conn.onRequest('coded', () => { throw new RpcError(-32002, 'nope', { x: 1 }) })
  conn.onRequest('ok', (p) => ({ echo: p.v }))
  send({ jsonrpc: '2.0', id: 1, method: 'nope/nothing' })
  send({ jsonrpc: '2.0', id: 2, method: 'boom' })
  send({ jsonrpc: '2.0', id: 3, method: 'coded' })
  send({ jsonrpc: '2.0', id: 4, method: 'ok', params: { v: `x${LS}y` } })
  assert.equal((await next((m) => m.id === 1)).error.code, ERR_METHOD_NOT_FOUND)
  const e2 = await next((m) => m.id === 2)
  assert.equal(e2.error.code, ERR_INTERNAL)
  assert.equal(e2.error.message, 'kaput')
  assert.deepEqual((await next((m) => m.id === 3)).error, { code: -32002, message: 'nope', data: { x: 1 } })
  assert.deepEqual((await next((m) => m.id === 4)).result, { echo: `x${LS}y` })
})

test('rpc: parse error answers with id null', async () => {
  const { input, next } = pair()
  input.write('{not json\n')
  const m = await next()
  assert.equal(m.id, null)
  assert.equal(m.error.code, ERR_PARSE)
})

test('rpc: outgoing requests are correlated by id, errors reject', async () => {
  const { conn, next, send } = pair()
  const p1 = conn.request('client/a', { q: 1 })
  const p2 = conn.request('client/b', {})
  const r1 = await next((m) => m.method === 'client/a')
  const r2 = await next((m) => m.method === 'client/b')
  // Answer out of order.
  send({ jsonrpc: '2.0', id: r2.id, error: { code: -1, message: 'denied' } })
  send({ jsonrpc: '2.0', id: r1.id, result: { answer: 42 } })
  assert.deepEqual(await p1, { answer: 42 })
  await assert.rejects(p2, /denied/)
})

test('rpc: notifications reach their handler; unknown ones are ignored', async () => {
  const { conn, send, next } = pair()
  const got = new Promise((resolve) => conn.onNotification('session/cancel', resolve))
  send({ jsonrpc: '2.0', method: 'whatever/unknown', params: {} })
  send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } })
  assert.deepEqual(await got, { sessionId: 's' })
  conn.onRequest('ping', () => ({}))
  send({ jsonrpc: '2.0', id: 9, method: 'ping' })
  assert.deepEqual((await next((m) => m.id === 9)).result, {})
})

test('rpc: closing the input rejects pending requests', async () => {
  const { conn, input } = pair()
  const p = conn.request('client/x', {})
  input.end()
  await assert.rejects(p, /connection closed/)
})
