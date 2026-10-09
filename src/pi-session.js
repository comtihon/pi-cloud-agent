// The real session factory: an in-process pi AgentSession.
//
// - The carrier system prompt is appended to pi's own system prompt through
//   the resource loader (`appendSystemPromptOverride`), so it is a real system
//   prompt — sent as `system`, rebuilt every turn, after pi's tool guidance and
//   AGENTS.md context — not text prefixed to the user's message.
// - A shared event bus is handed to the resource loader so this process can
//   hear extension events (pi-post-compact's `post-compact:stats`).
// - The pi session file lives in `sessionDir` (inside the workspace), so it is
//   archived with the workspace and `session/load` works after a pod restart.

import {
  AuthStorage,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

import { resolveModelConfig } from './config/model.js'
import { log } from './log.js'

/**
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.agentDir
 * @param {string} opts.sessionDir
 * @param {string} [opts.sessionFile]   reopen this file (session/load)
 * @param {object} opts.agentConfig     carrier agent_config (model, system_prompt, ...)
 * @param {object} opts.uiContext       pi ExtensionUIContext
 * @returns {Promise<{session: any, events: {on: Function}, dispose: Function}>}
 */
export async function createPiSession({ cwd, agentDir, sessionDir, sessionFile, agentConfig = {}, uiContext }) {
  const { authStorage, modelRegistry, model } = resolveModelConfig(agentConfig, { AuthStorage, ModelRegistry })
  const systemPrompt = typeof agentConfig.system_prompt === 'string' ? agentConfig.system_prompt.trim() : ''

  const events = createEventBus()
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus: events,
    appendSystemPromptOverride: (base) => (systemPrompt ? [...base, systemPrompt] : base),
  })
  await resourceLoader.reload()

  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir)

  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    resourceLoader,
    sessionManager,
    settingsManager,
  })
  if (modelFallbackMessage) log(modelFallbackMessage)
  for (const e of extensionsResult?.errors || []) log(`extension ${e.path} failed to load:`, e.error)

  await session.bindExtensions({
    mode: 'rpc',
    uiContext,
    onError: (err) => log('extension error:', err?.error || err?.message || err),
  })

  // pi-mcp-adapter registers its tools asynchronously after bindExtensions;
  // keep every registered tool active as they appear (up to 15 s).
  const activateAll = () => {
    try {
      if (typeof session._refreshToolRegistry === 'function') session._refreshToolRegistry()
      const names = session.getAllTools().map((t) => t.name)
      session.setActiveToolsByName(names)
      return names.length
    } catch (err) {
      log('tool activation failed:', err.message)
      return 0
    }
  }
  const initial = activateAll()
  let ticks = 0
  const poll = setInterval(() => {
    ticks++
    const n = activateAll()
    if (n > initial || ticks >= 15) {
      clearInterval(poll)
      log(`active tools: ${n}`)
    }
  }, 1000)
  poll.unref?.()

  return {
    session,
    events,
    dispose() {
      clearInterval(poll)
      try { session.dispose() } catch (err) { log('dispose failed:', err.message) }
    },
  }
}
