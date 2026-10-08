// End-to-end ACP agent over NDJSON streams with the pi session stubbed:
// initialize → session/new → session/prompt (streamed updates + _meta) →
// session/cancel → _carrier/ask + request_permission round trips → session/load.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLineSplitter, encodeFrame, JsonRpcConnection } from '../src/acp/protocol.js'
import { createAgent, mapStopReason } from '../src/acp/agent.js'
import { promptFromBlocks, historyUpdates, toolKind, toolCallUpdate } from '../src/acp/updates.js'

// ── stub pi session ─────────────────────────────────────────────────────────

class StubSession {
  constructor({ uiContext, sessionFile, history = [] }) {
    this.sessionId = 'sess-1'
    this.sessionFile = sessionFile || '/ws/.pi-sessions/2026_sess-1.jsonl'
    this.uiContext = uiContext
    this.listeners = new Set()
    this.messages = [...history]
    this.tokens = { input: 1000, output: 100, total: 1100 }
    this.prompts = []
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(ev) { for (const l of this.listeners) l(ev) }
  getSessionStats() { return { tokens: { ...this.tokens } } }
  getContextUsage() { return { tokens: 4321, contextWindow: 200000, percent: 2 } }
  getLastAssistantText() {
    const m = [...this.messages].reverse().find((x) => x.role === 'assistant')
    return m?.content.filter((c) => c.type === 'text').map((c) => c.text).join('') || undefined
  }
  async abort() { this.aborted = true; this.onAbort?.() }
  dispose() { this.disposed = true }

  finish(text, stopReason = 'stop', usage = { input: 200, output: 30 }) {
    const msg = { role: 'assistant', content: text ? [{ type: 'text', text }] : [], stopReason }
    this.messages.push(msg)
    this.tokens.input += usage.input
    this.tokens.output += usage.output
    this.tokens.total += usage.input + usage.output
    this.emit({ type: 'message_end', message: msg })
  }

  async prompt(text, opts) {
    this.prompts.push({ text, opts })
    this.messages.push({ role: 'user', content: text })
    if (text === 'wait') {
      this.emit({ type: 'message_start', message: { role: 'assistant' } })
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working…' } })
      await new Promise((resolve) => { this.onAbort = resolve })
      this.finish('working…', 'aborted')
      return
    }
    if (text === 'ask') {
      const branch = await this.uiContext.input('Which branch?')
      const pick = await this.uiContext.select('Pick one', ['alpha', 'beta'])
      const ok = await this.uiContext.confirm('Proceed?', 'really')
      this.finish(`branch=${branch} pick=${pick} ok=${ok}`)
      return
    }
    if (text === 'explode') {
      this.finish('', 'error')
      this.messages[this.messages.length - 1].errorMessage = '429 rate limited'
      return
    }
    // Default script: stream text + thinking + a bash call + an MCP call.
    this.emit({ type: 'message_start', message: { role: 'assistant' } })
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } })
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } })
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo !' } })
    this.emit({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'gh pr list' } })
    this.emit({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', result: { content: [{ type: 'text', text: 'x'.repeat(20000) }] }, isError: false })
    this.emit({ type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'mcp', args: { tool: 'jira_search', args: '{}' } })
    this.emit({ type: 'tool_execution_end', toolCallId: 'tc2', toolName: 'mcp', result: { content: [{ type: 'text', text: 'boom' }] }, isError: true })
    this.events.emit('post-compact:stats', { metaUsage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })
    this.finish('Hello !')
  }
}

function eventBus() {
  const handlers = new Map()
  return {
    on(ch, fn) { handlers.set(ch, fn); return () => handlers.delete(ch) },
    emit(ch, data) { handlers.get(ch)?.(data) },
  }
}

// ── harness ─────────────────────────────────────────────────────────────────

function harness(answer = {}) {
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  const conn = new JsonRpcConnection({ input: toAgent, write: (l) => fromAgent.write(l), idPrefix: 'agent-' })
  const applied = []
  const created = []
  const agent = createAgent({
    connection: conn,
    version: '9.9.9',
    log: () => {},
    deps: {
      setup: {
        agentDir: '/tmp/agent',
        registeredTools: [{ name: 'gh', bash_match: '\\bgh\\b' }],
        async apply(p) { applied.push(p); return { mcpServerNames: ['jira', 'datasources'] } },
      },
      async createSession(opts) {
        const session = new StubSession({ ...opts, history: opts.sessionFile ? HISTORY : [] })
        session.events = eventBus()
        created.push({ opts, session })
        return { session, events: session.events, dispose: () => session.dispose() }
      },
      async uploadWorkspace(extra) {
        return extra.s3_bucket ? `gs://${extra.s3_bucket}/${extra.s3_path}/workspace.tar.gz` : null
      },
    },
  })
  conn.start()

  const frames = []
  const waiters = []
  const splitter = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    frames.push(msg)
    // Answer agent → client requests the way carrier would.
    if (msg.method === '_carrier/ask') reply(msg.id, answer.ask ?? { answer: 'main' })
    if (msg.method === 'session/request_permission') {
      const pick = answer.permission?.(msg.params) ?? msg.params.options[0].optionId
      reply(msg.id, { outcome: { outcome: 'selected', optionId: pick } })
    }
    for (const w of waiters.splice(0)) w()
  })
  fromAgent.on('data', (d) => splitter.push(d))

  function reply(id, result) { toAgent.write(encodeFrame({ jsonrpc: '2.0', id, result })) }
  let nextId = 1
  async function request(method, params) {
    const id = nextId++
    toAgent.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    for (;;) {
      const r = frames.find((f) => f.id === id && !f.method)
      if (r) return r
      await new Promise((res) => waiters.push(res))
    }
  }
  function notify(method, params) { toAgent.write(encodeFrame({ jsonrpc: '2.0', method, params })) }
  async function waitFor(pred) {
    for (;;) {
      const f = frames.find(pred)
      if (f) return f
      await new Promise((res) => waiters.push(res))
    }
  }
  const updates = (sessionId) => frames.filter((f) => f.method === 'session/update' && f.params.sessionId === sessionId).map((f) => f.params.update)
  return { agent, request, notify, waitFor, frames, updates, applied, created }
}

const HISTORY = [
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'on it' }, { type: 'toolCall', id: 'h1', name: 'read', arguments: { path: 'a.txt' } }], stopReason: 'toolUse' },
  { role: 'toolResult', toolCallId: 'h1', toolName: 'read', content: [{ type: 'text', text: 'A' }], isError: false },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
]

const AGENT_CONFIG = {
  system_prompt: 'You are terse.',
  model: 'kimi-k2',
  tools: [],
  extra: { s3_bucket: 'bkt', s3_path: 'runs/r1' },
  mcp_servers: [{ name: 'jira', transport: 'stdio', command: ['uvx', 'mcp-atlassian'] }],
  run_id: 'r1',
  task_id: 't1',
}

// ── tests ───────────────────────────────────────────────────────────────────

test('initialize advertises the carrier contract', async () => {
  const h = harness()
  const r = await h.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(r.result, {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      mcpCapabilities: { http: true, sse: true },
      _meta: { carrier: { version: '9.9.9', ask: true } },
    },
    agentInfo: { name: 'pi-carrier-agent', version: '9.9.9' },
    authMethods: [],
  })
  const unknown = await h.request('session/set_mode', {})
  assert.equal(unknown.error.code, -32601)
})

test('session/new → session/prompt streams updates and returns carrier _meta', async () => {
  const h = harness()
  await h.request('initialize', { protocolVersion: 1 })
  const mcpServers = [{ name: 'jira', command: 'uvx', args: ['mcp-atlassian'], env: [] }]
  const created = await h.request('session/new', { cwd: '/ws', mcpServers, _meta: { carrier: AGENT_CONFIG } })
  assert.equal(created.result.sessionId, 'sess-1')
  assert.deepEqual(created.result._meta, { carrier: { session_file: '/ws/.pi-sessions/2026_sess-1.jsonl' } })
  assert.deepEqual(h.applied[0], { cwd: '/ws', mcpServers, agentConfig: AGENT_CONFIG, restore: true })
  const opts = h.created[0].opts
  assert.equal(opts.cwd, '/ws')
  assert.equal(opts.sessionDir, '/ws/.pi-sessions')
  assert.equal(opts.agentConfig.system_prompt, 'You are terse.')

  const image = { type: 'image', data: 'iVBOR', mimeType: 'image/png' }
  const r = await h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'go' }, image] })
  assert.equal(r.error, undefined)
  // The user text is passed as-is — the system prompt is not prefixed.
  assert.deepEqual(h.created[0].session.prompts[0], { text: 'go', opts: { images: [image] } })
  assert.equal(r.result.stopReason, 'end_turn')
  assert.deepEqual(r.result._meta.carrier, {
    usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230 },
    meta_usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
    workspace_path: 'gs://bkt/runs/r1/workspace.tar.gz',
    final_text: 'Hello !',
  })

  const ups = h.updates('sess-1')
  const kinds = ups.map((u) => u.sessionUpdate)
  assert.deepEqual(ups.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text), ['Hel', 'lo !'])
  assert.deepEqual(ups.find((u) => u.sessionUpdate === 'agent_thought_chunk').content, { type: 'text', text: 'hmm' })

  const [bash, mcp] = ups.filter((u) => u.sessionUpdate === 'tool_call')
  assert.equal(bash.toolCallId, 'tc1')
  assert.equal(bash.kind, 'execute')
  assert.equal(bash.status, 'in_progress')
  assert.equal(bash.title, 'bash: gh pr list')
  assert.deepEqual(bash.rawInput, { command: 'gh pr list' })
  assert.deepEqual(bash._meta.carrier.tools, ['gh'])
  assert.equal(mcp.kind, 'fetch')
  assert.equal(mcp._meta.carrier.mcp_server, 'jira')
  assert.equal(mcp.title, 'jira → search')

  const [bashEnd, mcpEnd] = ups.filter((u) => u.sessionUpdate === 'tool_call_update')
  assert.equal(bashEnd.status, 'completed')
  assert.ok(bashEnd.rawOutput.length < 9000, 'rawOutput is truncated')
  assert.match(bashEnd.rawOutput, /truncated/)
  assert.equal(mcpEnd.status, 'failed')
  assert.equal(mcpEnd.rawOutput, 'boom')

  const usage = ups.filter((u) => u.sessionUpdate === 'usage_update')
  assert.ok(usage.length >= 1)
  assert.deepEqual(usage.at(-1), { sessionUpdate: 'usage_update', used: 4321, size: 200000 })
  // Updates precede the response.
  const respIdx = h.frames.findIndex((f) => f.id !== undefined && f.result?.stopReason)
  const lastUpdIdx = h.frames.findLastIndex((f) => f.method === 'session/update')
  assert.ok(lastUpdIdx < respIdx)
  assert.ok(kinds.includes('tool_call_update'))
})

test('session/cancel aborts the running prompt → stopReason cancelled', async () => {
  const h = harness()
  await h.request('session/new', { cwd: '/ws', mcpServers: [], _meta: { carrier: { extra: {} } } })
  const pending = h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'wait' }] })
  await h.waitFor((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk')
  // A second prompt while one runs is refused.
  const busy = await h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] })
  assert.equal(busy.error.code, -32603)
  h.notify('session/cancel', { sessionId: 'sess-1' })
  const r = await pending
  assert.equal(r.result.stopReason, 'cancelled')
  assert.equal(r.result._meta.carrier.workspace_path, null)
  assert.equal(r.result._meta.carrier.meta_usage, null)
  assert.equal(h.created[0].session.aborted, true)
})

test('questions: input → _carrier/ask, select/confirm → session/request_permission', async () => {
  const h = harness({
    permission: (p) => (p.options.length === 2 && p.options[0].optionId === 'yes' ? 'yes' : 'option-1'),
  })
  await h.request('session/new', { cwd: '/ws', mcpServers: [], _meta: { carrier: {} } })
  const r = await h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'ask' }] })
  assert.equal(r.result._meta.carrier.final_text, 'branch=main pick=beta ok=true')

  const ask = h.frames.find((f) => f.method === '_carrier/ask')
  assert.deepEqual(ask.params, { sessionId: 'sess-1', question: 'Which branch?' })
  const [select, confirm] = h.frames.filter((f) => f.method === 'session/request_permission')
  assert.equal(select.params.sessionId, 'sess-1')
  assert.equal(select.params.toolCall.title, 'Pick one')
  assert.match(select.params.toolCall.toolCallId, /^ask-/)
  assert.deepEqual(select.params.options, [
    { optionId: 'option-0', name: 'alpha', kind: 'allow_once' },
    { optionId: 'option-1', name: 'beta', kind: 'allow_once' },
  ])
  assert.equal(confirm.params.toolCall.title, 'Proceed?\nreally')
  assert.deepEqual(confirm.params.options.map((o) => [o.optionId, o.kind]), [['yes', 'allow_once'], ['no', 'reject_once']])
})

test('_carrier/ask {cancelled: true} → the extension sees no answer', async () => {
  const h = harness({ ask: { cancelled: true } })
  await h.request('session/new', { cwd: '/ws', mcpServers: [], _meta: { carrier: {} } })
  const r = await h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'ask' }] })
  assert.match(r.result._meta.carrier.final_text, /^branch=undefined/)
})

test('a model error → -32603 with the carrier _meta in error.data', async () => {
  const h = harness()
  await h.request('session/new', { cwd: '/ws', mcpServers: [], _meta: { carrier: {} } })
  const r = await h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'explode' }] })
  assert.equal(r.error.code, -32603)
  assert.equal(r.error.message, '429 rate limited')
  assert.ok(r.error.data._meta.carrier.usage)
  const unknown = await h.request('session/prompt', { sessionId: 'nope', prompt: [] })
  assert.equal(unknown.error.code, -32603)
})

test('session/load reopens the session file and replays history', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-'))
  mkdirSync(join(ws, '.pi-sessions'))
  const file = join(ws, '.pi-sessions', '2026-01-01T00-00-00_sess-1.jsonl')
  writeFileSync(file, '')
  const h = harness()
  const r = await h.request('session/load', { sessionId: 'sess-1', cwd: ws, mcpServers: [], _meta: { carrier: AGENT_CONFIG } })
  assert.equal(r.error, undefined)
  assert.equal(h.created[0].opts.sessionFile, file)
  assert.equal(h.applied[0].restore, false, 'local session file → no workspace restore')
  const ups = h.updates('sess-1').map((u) => [u.sessionUpdate, u.content?.text ?? u.toolCallId])
  assert.deepEqual(ups.slice(0, 6), [
    ['user_message_chunk', 'do it'],
    ['agent_thought_chunk', 'plan'],
    ['agent_message_chunk', 'on it'],
    ['tool_call', 'h1'],
    ['tool_call_update', 'h1'],
    ['agent_message_chunk', 'done'],
  ])
  // The reloaded session takes prompts.
  const p = await h.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'go' }] })
  assert.equal(p.result.stopReason, 'end_turn')

  const missing = await harness().request('session/load', { sessionId: 'nope', cwd: ws, mcpServers: [], _meta: { carrier: {} } })
  assert.equal(missing.error.code, -32603)
  assert.match(missing.error.message, /Session not found/)
})

// ── pure mapping helpers ────────────────────────────────────────────────────

test('mapStopReason', () => {
  assert.equal(mapStopReason('stop'), 'end_turn')
  assert.equal(mapStopReason('toolUse'), 'end_turn')
  assert.equal(mapStopReason('length'), 'max_tokens')
  assert.equal(mapStopReason('aborted'), 'cancelled')
  assert.equal(mapStopReason('stop', { cancelled: true }), 'cancelled')
  assert.equal(mapStopReason('error', { errorMessage: 'blocked by content filter' }), 'refusal')
})

test('promptFromBlocks: text, image, resource link, embedded text resource', () => {
  const r = promptFromBlocks([
    { type: 'text', text: 'a' },
    { type: 'image', data: 'D', mimeType: 'image/jpeg' },
    { type: 'resource_link', uri: 'file:///x', name: 'x' },
    { type: 'resource', resource: { uri: 'file:///y', text: 'Y' } },
    { type: 'audio', data: 'A' },
  ])
  assert.equal(r.text, 'a\n\n[resource: x file:///x]\n\n<resource uri="file:///y">\nY\n</resource>')
  assert.deepEqual(r.images, [{ type: 'image', data: 'D', mimeType: 'image/jpeg' }])
})

test('toolKind: builtins, direct MCP tools and the proxy tool', () => {
  assert.equal(toolKind('read'), 'read')
  assert.equal(toolKind('write'), 'edit')
  assert.equal(toolKind('grep'), 'search')
  assert.equal(toolKind('jira_create_issue', {}, ['jira']), 'other')
  assert.equal(toolKind('jira_get_issue', {}, ['jira']), 'fetch')
  assert.equal(toolKind('mcp', { tool: 'datasources_list_sources' }, ['datasources']), 'fetch')
  assert.equal(toolKind('mystery'), 'other')
  // pi-mcp-adapter turns '-' in server names into '_' in tool names.
  const t = toolCallUpdate({ toolCallId: 'x', toolName: 'mcp', args: { tool: 'carrier_cli_tools_grapher_query' } }, { serverNames: ['carrier-cli-tools'] })
  assert.deepEqual([t.kind, t.title, t._meta.carrier.mcp_server, t._meta.carrier.mcp_tool], ['fetch', 'carrier-cli-tools → grapher_query', 'carrier-cli-tools', 'grapher_query'])
  assert.equal(historyUpdates(null).length, 0)
})
