// ACP agent handlers: carrier's contract on top of pi AgentSessions.
//
// Everything that touches pi, the filesystem or GCS is injected through
// `deps`, so the protocol behaviour can be tested with a stub session.

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { RpcError, ERR_INTERNAL } from './protocol.js'
import {
  historyUpdates,
  promptFromBlocks,
  textChunk,
  toolCallUpdate,
  toolResultUpdate,
} from './updates.js'
import { log as defaultLog } from '../log.js'

export const AGENT_NAME = 'pi-carrier-agent'
export const PROTOCOL_VERSION = 1
export const POST_COMPACT_STATS_EVENT = 'post-compact:stats'
export const DEFAULT_CWD = '/workspace'
export const SESSION_DIR_NAME = '.pi-sessions'

// Extensions style status text with ctx.ui.theme.fg(color, text) / bold(text)
// etc. There is no terminal here, so any theme method returns the last
// string argument as-is.
const PLAIN_THEME = new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : (...args) => {
    for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === 'string') return args[i]
    return ''
  }),
})

/** pi StopReason → ACP StopReason (errors are handled by the caller). */
export function mapStopReason(stopReason, { cancelled = false, errorMessage = '' } = {}) {
  if (cancelled || stopReason === 'aborted') return 'cancelled'
  if (stopReason === 'length') return 'max_tokens'
  if (stopReason === 'error' && /refus|content[ _-]?(filter|policy)|safety/i.test(errorMessage || '')) return 'refusal'
  return 'end_turn'
}

function tokens(session) {
  try {
    const t = session.getSessionStats()?.tokens
    if (t) return { input: t.input || 0, output: t.output || 0, total: t.total || 0 }
  } catch { /* stats unavailable */ }
  return null
}

function lastAssistant(session) {
  const messages = session.messages || session.agent?.state?.messages || []
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'assistant') return messages[i]
  return null
}

/** Find a pi session file for `sessionId` in `sessionDir` (or use `hint`). */
export function locateSessionFile(sessionDir, sessionId, hint) {
  if (hint && existsSync(hint)) return hint
  let files
  try { files = readdirSync(sessionDir) } catch { return null }
  const match = files.filter((f) => f.endsWith(`_${sessionId}.jsonl`)).sort().pop()
  return match ? join(sessionDir, match) : null
}

/**
 * @param {object} opts
 * @param {import('./protocol.js').JsonRpcConnection} opts.connection
 * @param {string} opts.version
 * @param {object} opts.deps
 * @param {{apply: Function, dispose?: Function, registeredTools?: object[], agentDir: string}} opts.deps.setup
 * @param {(o: object) => Promise<{session: any, events?: any, dispose?: Function}>} opts.deps.createSession
 * @param {(extra: object, cwd: string) => Promise<string|null>} opts.deps.uploadWorkspace
 * @param {string} [opts.deps.defaultCwd]
 */
export function createAgent({ connection, version, deps, log = defaultLog }) {
  const {
    setup,
    createSession,
    uploadWorkspace,
    defaultCwd = DEFAULT_CWD,
    sessionDirFor = (cwd) => join(cwd, SESSION_DIR_NAME),
  } = deps
  const sessions = new Map()
  // session/new and session/load mutate process-wide state (env, mcp.json,
  // the workspace): one at a time.
  let setupChain = Promise.resolve()
  const serialized = (fn) => {
    const run = setupChain.then(fn, fn)
    setupChain = run.catch(() => {})
    return run
  }

  const sendUpdate = (sessionId, update) => connection.notify('session/update', { sessionId, update })

  // ── Questions: pi extension UI → client requests ─────────────────────────
  async function askClient(st, method, params, signal) {
    const turnSignal = st.turn?.abort.signal
    const signals = [signal, turnSignal].filter(Boolean)
    if (signals.some((s) => s.aborted)) return null
    let onAbort
    const aborted = new Promise((resolve) => {
      onAbort = () => resolve(null)
      for (const s of signals) s.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([connection.request(method, params), aborted])
    } catch (err) {
      log(`${method} failed:`, err.message)
      return null
    } finally {
      for (const s of signals) s.removeEventListener('abort', onAbort)
    }
  }

  async function requestPermission(st, title, options, signal) {
    const res = await askClient(st, 'session/request_permission', {
      sessionId: st.id,
      toolCall: { toolCallId: `ask-${randomUUID()}`, title },
      options,
    }, signal)
    const outcome = res?.outcome
    return outcome?.outcome === 'selected' ? outcome.optionId : null
  }

  async function freeText(st, question, signal) {
    const res = await askClient(st, '_carrier/ask', { sessionId: st.id, question }, signal)
    if (!res || res.cancelled) return undefined
    return typeof res.answer === 'string' ? res.answer : undefined
  }

  function makeUiContext(st) {
    return {
      async select(title, options, opts) {
        const list = Array.isArray(options) ? options : []
        const id = await requestPermission(st, title, list.map((name, i) => ({
          optionId: `option-${i}`, name: String(name), kind: 'allow_once',
        })), opts?.signal)
        const i = id ? Number(id.slice('option-'.length)) : NaN
        return Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : undefined
      },
      async confirm(title, message, opts) {
        const question = [title, message].filter(Boolean).join('\n')
        const id = await requestPermission(st, question, [
          { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
          { optionId: 'no', name: 'No', kind: 'reject_once' },
        ], opts?.signal)
        return id === 'yes'
      },
      async input(title, _placeholder, opts) { return freeText(st, title, opts?.signal) },
      async editor(title, _prefill) { return freeText(st, title) },
      notify(message, type) { log(`[${type || 'info'}] ${message}`) },
      onTerminalInput() { return () => {} },
      setStatus() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setWidget() {},
      setFooter() {},
      setHeader() {},
      setTitle() {},
      async custom() { return undefined },
      pasteToEditor() {},
      setEditorText() {},
      getEditorText() { return '' },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() { return undefined },
      // Headless: every styling call returns its text unchanged.
      theme: PLAIN_THEME,
      getAllThemes() { return [] },
      getTheme() { return undefined },
      setTheme() { return { success: false, error: 'Theme switching not supported' } },
      getToolsExpanded() { return false },
      setToolsExpanded() {},
    }
  }

  // ── pi events → session/update ───────────────────────────────────────────
  function sendUsage(st) {
    try {
      const u = st.session.getContextUsage?.()
      if (u && Number.isFinite(u.contextWindow)) {
        const used = u.tokens ?? 0
        if (st.lastUsage && st.lastUsage.used === used && st.lastUsage.size === u.contextWindow) return
        st.lastUsage = { used, size: u.contextWindow }
        sendUpdate(st.id, { sessionUpdate: 'usage_update', used, size: u.contextWindow })
      }
    } catch { /* usage unavailable */ }
  }

  function attach(st, created) {
    st.session = created.session
    st.disposeSession = created.dispose || (() => created.session.dispose?.())
    st.id = created.session.sessionId
    const mapOpts = () => ({ serverNames: st.serverNames, registeredTools: setup.registeredTools || [] })

    st.unsubscribe = created.session.subscribe((event) => {
      try {
        switch (event.type) {
          case 'message_update': {
            const e = event.assistantMessageEvent
            if (e?.type === 'text_delta' && e.delta) {
              if (st.turn) st.turn.text += e.delta
              sendUpdate(st.id, textChunk('agent_message_chunk', e.delta))
            } else if (e?.type === 'thinking_delta' && e.delta) {
              sendUpdate(st.id, textChunk('agent_thought_chunk', e.delta))
            }
            break
          }
          case 'message_start':
            if (event.message?.role === 'assistant' && st.turn) st.turn.text = ''
            break
          case 'message_end':
            if (event.message?.role === 'assistant') sendUsage(st)
            break
          case 'tool_execution_start':
            sendUpdate(st.id, toolCallUpdate(event, mapOpts()))
            break
          case 'tool_execution_end':
            sendUpdate(st.id, toolResultUpdate(event))
            break
          case 'auto_retry_start':
            log(`retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`)
            break
          case 'compaction_end':
            log(`compaction (${event.reason}) ${event.aborted ? 'aborted' : 'done'}`)
            sendUsage(st)
            break
          default:
            break
        }
      } catch (err) {
        log('event mapping failed:', err.message)
      }
    })

    st.offStats = created.events?.on?.(POST_COMPACT_STATS_EVENT, (payload) => {
      const u = payload?.metaUsage
      if (!st.turn || !u) return
      const acc = st.turn.metaUsage || (st.turn.metaUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
      const inp = u.prompt_tokens ?? u.input_tokens ?? 0
      const out = u.completion_tokens ?? u.output_tokens ?? 0
      acc.input_tokens += inp
      acc.output_tokens += out
      acc.total_tokens += u.total_tokens ?? (inp + out)
    }) || null
    sessions.set(st.id, st)
    return st
  }

  async function openSession(applied, { cwd, agentConfig, sessionFile }) {
    const st = { id: null, cwd, agentConfig, serverNames: applied?.mcpServerNames || [], turn: null }
    const created = await createSession({
      cwd,
      agentDir: setup.agentDir,
      sessionDir: sessionDirFor(cwd),
      sessionFile,
      agentConfig,
      uiContext: makeUiContext(st),
    })
    return attach(st, created)
  }

  function closeSession(st) {
    try { st.unsubscribe?.() } catch { /* ignore */ }
    try { st.offStats?.() } catch { /* ignore */ }
    try { st.disposeSession?.() } catch { /* ignore */ }
    sessions.delete(st.id)
  }

  function requireSession(sessionId) {
    const st = sessions.get(sessionId)
    if (!st) throw new RpcError(ERR_INTERNAL, `Unknown session: ${sessionId}`)
    return st
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  connection.onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      mcpCapabilities: { http: true, sse: true },
      _meta: { carrier: { version, ask: true } },
    },
    agentInfo: { name: AGENT_NAME, version },
    authMethods: [],
  }))

  connection.onRequest('session/new', (params) => serialized(async () => {
    const cwd = params.cwd || defaultCwd
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : []
    const agentConfig = params._meta?.carrier || {}
    const applied = await setup.apply({ cwd, mcpServers, agentConfig, restore: true })
    const st = await openSession(applied, { cwd, mcpServers, agentConfig })
    log(`session ${st.id} created (cwd ${cwd}, run ${agentConfig.run_id ?? '-'}, task ${agentConfig.task_id ?? '-'})`)
    return { sessionId: st.id, _meta: { carrier: { session_file: st.session.sessionFile ?? null } } }
  }))

  connection.onRequest('session/load', (params) => serialized(async () => {
    const sessionId = params.sessionId
    if (!sessionId) throw new RpcError(ERR_INTERNAL, 'sessionId is required')
    let st = sessions.get(sessionId)
    if (!st) {
      const cwd = params.cwd || defaultCwd
      const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : []
      const agentConfig = params._meta?.carrier || {}
      const hint = agentConfig.session_file
      const sessionDir = sessionDirFor(cwd)
      let file = locateSessionFile(sessionDir, sessionId, hint)
      // Not on local disk (pod was replaced): restore the workspace first —
      // the session file is archived with it.
      const applied = await setup.apply({ cwd, mcpServers, agentConfig, restore: !file })
      file = file || locateSessionFile(sessionDir, sessionId, hint)
      if (!file) throw new RpcError(ERR_INTERNAL, `Session not found: ${sessionId}`)
      st = await openSession(applied, { cwd, mcpServers, agentConfig, sessionFile: file })
      if (st.id !== sessionId) {
        // Index under the requested id too, so later calls resolve.
        sessions.set(sessionId, st)
      }
    }
    for (const update of historyUpdates(st.session.messages, {
      serverNames: st.serverNames,
      registeredTools: setup.registeredTools || [],
    })) sendUpdate(sessionId, update)
    sendUsage(st)
    return { _meta: { carrier: { session_file: st.session.sessionFile ?? null } } }
  }))

  connection.onRequest('session/prompt', async (params) => {
    const st = requireSession(params.sessionId)
    if (st.turn) throw new RpcError(ERR_INTERNAL, 'A prompt is already running in this session')
    const { text, images } = promptFromBlocks(params.prompt)
    const turn = { cancelled: false, abort: new AbortController(), metaUsage: null, text: '' }
    st.turn = turn
    try {
      const before = tokens(st.session)
      let error = null
      try {
        await st.session.prompt(text, images.length ? { images } : undefined)
      } catch (err) {
        error = err
      }
      sendUsage(st)

      const after = tokens(st.session)
      const usage = after
        ? {
            input_tokens: after.input - (before?.input || 0),
            output_tokens: after.output - (before?.output || 0),
            total_tokens: after.total - (before?.total || 0),
          }
        : { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

      const last = lastAssistant(st.session)
      const stopReason = mapStopReason(last?.stopReason, {
        cancelled: turn.cancelled,
        errorMessage: last?.errorMessage || error?.message,
      })
      if (!error && !turn.cancelled && last?.stopReason === 'error' && stopReason !== 'refusal') {
        error = new Error(last.errorMessage || 'model request failed')
      }
      if (turn.cancelled) error = null

      let finalText = ''
      try { finalText = st.session.getLastAssistantText?.() || '' } catch { /* none */ }
      if (!finalText) finalText = turn.text

      let workspacePath = null
      try {
        workspacePath = await uploadWorkspace(st.agentConfig.extra || {}, st.cwd)
      } catch (err) {
        log('workspace upload failed:', err.message)
      }

      const meta = {
        carrier: {
          usage,
          meta_usage: turn.metaUsage,
          workspace_path: workspacePath || null,
          final_text: finalText,
        },
      }
      if (error && stopReason !== 'refusal') {
        throw new RpcError(ERR_INTERNAL, error.message || String(error), { _meta: meta })
      }
      return { stopReason, _meta: meta }
    } finally {
      st.turn = null
    }
  })

  connection.onNotification('session/cancel', async (params) => {
    const st = sessions.get(params.sessionId)
    if (!st || !st.turn) return
    st.turn.cancelled = true
    st.turn.abort.abort()
    try { await st.session.abort() } catch (err) { log('abort failed:', err.message) }
  })

  return {
    sessions,
    dispose() {
      for (const st of new Set(sessions.values())) closeSession(st)
      setup.dispose?.()
    },
  }
}
