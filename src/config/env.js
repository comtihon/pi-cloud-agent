// agent_config → the agent process environment.
//
// The carrier decides which tools this agent may use and ships each one's
// credentials with it; this image only decides which of them it can run
// (tools.js). Credentials, step env_vars and the LLM key land on the process
// env, so pi's subprocess tools (bash, git, gsutil, MCP servers) inherit them.
//
// The process outlives a session (warm pods, several session/new on one
// connection), so everything applied here is recorded in `state` and undone
// before the next session's config lands: a revoked tool or rotated secret
// never leaks into the next run.

import { applyToolEnv, blockCommands, registerTools, DISABLED_BIN_DIR } from '../tools.js'

// PATH as seen at load — every session starts from it, before the commands
// this agent was not granted are shadowed on top of it.
const ORIGINAL_PATH = process.env.PATH || ''

export function createEnvState() {
  return { toolKeys: [], applied: new Map() }
}

/**
 * Apply `agent_config` to `env`. Returns `{ registered, skipped, blocked }`.
 *
 * @param {object} agentConfig  carrier agent_config
 * @param {object} opts
 * @param {object} [opts.env]          target env (default process.env)
 * @param {object} opts.state          from createEnvState(), reused across calls
 * @param {Function} [opts.exists]     command-on-PATH check (tests stub it)
 * @param {string} [opts.originalPath] clean PATH to shadow on top of
 * @param {string} [opts.binDir]       where blocked-command stubs go
 */
export function applyAgentEnv(agentConfig = {}, {
  env = process.env,
  state,
  exists,
  originalPath = ORIGINAL_PATH,
  binDir = DISABLED_BIN_DIR,
} = {}) {
  if (!state) throw new Error('applyAgentEnv: state is required')
  const {
    tools = [],
    blocked_commands: blocked = [],
    credentials = {},
    env_vars: envVars = {},
    extra = {},
  } = agentConfig || {}

  // Undo the previous session's credentials/env_vars (restore what the pod
  // started with, or drop the key).
  for (const [key, original] of state.applied) {
    if (original === undefined) delete env[key]
    else env[key] = original
  }
  state.applied = new Map()
  const set = (key, value) => {
    if (value == null) return
    if (!state.applied.has(key)) state.applied.set(key, env[key])
    env[key] = String(value)
  }

  // ── Tools: allowed ∧ installed, per-tool env, blocked-command stubs ──
  const { registered, skipped } = registerTools(tools, exists ? { exists } : undefined)
  state.toolKeys = applyToolEnv(registered, state.toolKeys, env)
  env.PATH = blockCommands(blocked, { originalPath, binDir })

  // ── Credentials + step env_vars ──
  for (const [k, v] of Object.entries(credentials || {})) set(k, v)
  for (const [k, v] of Object.entries(envVars || {})) set(k, v)

  // ── LLM key / endpoint ──
  const keyEnvName = extra?.llm_api_key_env || 'ANTHROPIC_API_KEY'
  const apiKey = credentials?.[keyEnvName]
  if (apiKey) {
    if (!env.ANTHROPIC_API_KEY) set('ANTHROPIC_API_KEY', apiKey)
    if (!env.OPENAI_API_KEY) set('OPENAI_API_KEY', apiKey)
  }
  if (extra?.llm_base_url) set('OPENAI_BASE_URL', extra.llm_base_url)

  return {
    registered,
    skipped,
    blocked: (Array.isArray(blocked) ? blocked : []).filter(Boolean),
  }
}
