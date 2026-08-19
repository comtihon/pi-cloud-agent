/**
 * runner.js — runs a pi coding agent in-process via the pi SDK
 * (createAgentSession) instead of spawning the pi CLI through RpcClient.
 *
 * Key facts (verified against pi SDK source):
 * - createAgentSession({ cwd, authStorage }) resolves the model automatically
 *   from settings/provider defaults and enables built-in tools
 *   (read, bash, edit, write) by default. No model/tools needed here.
 * - session.subscribe(fn) takes a SYNCHRONOUS listener and returns an
 *   unsubscribe function. Never await inside the listener.
 * - session.prompt(text) is the idle gate: it resolves only when the full
 *   agent turn (tool calls + final message) is complete. No waitForIdle().
 * - session.getSessionStats() and getLastAssistantText() are synchronous.
 * - session.abort() is async; session.dispose() is synchronous (void).
 * - Approvals/clarifications flow through bindExtensions({ uiContext }).
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { spawn, exec, execSync } from 'child_process'
import { promisify } from 'util'
import { createAgentSession, AuthStorage, ModelRegistry, createReadTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent'
import { downloadWorkspace, uploadWorkspace, activateGcloudServiceAccount } from './workspaceS3.js'

// Compaction/collapse policy lives in pi-post-compact, shared with the native
// pi extension path. Only the wire-shape adapters below stay here: this file
// drives its own OpenAI-completions message array inside the mcp-resolver loop
// (see the fetch interception in startRun), which never passes through pi's
// agent loop and therefore never reaches the extension's `context` hook.
//
// It is a plain dependency (`file:vendor/pi-post-compact`), so this import is
// static and cannot silently degrade. The Dockerfile ALSO installs the same
// vendored package into $PI_CODING_AGENT_DIR/npm — that copy is what pi loads
// as an extension for native tool calls, and is unrelated to this import.
import {
  buildActionSummaryInstruction,
  cacheFrontierIndex as _cacheFrontierIndexBy,
  compactOrKeep,
  resolveMetaLlm,
  summarizeToolCallArgs,
  truncateWithNotice,
  ASSISTANT_CONTENT_REASON,
  DEFAULT_MIN_CHARS,
} from 'pi-post-compact'

export { summarizeToolCallArgs }

// Module-level state shared between startRun() and _executeMcpTool()
let _mcpHttpServers = {}   // name → {proc, port, url}
const _origFetch = globalThis.fetch  // saved before interception

// PATH as seen at module load — the "clean" PATH restored whenever graphify is
// enabled. Disabling graphify shadows the binary via a /tmp/disabled-bins stub.
const ORIGINAL_PATH = process.env.PATH || ''
const DISABLED_BIN_DIR = '/tmp/disabled-bins'

// Pure message-building helpers for tool_execution_start/end events.
// Extracted from the session.subscribe() listener in startRun() so they
// can be unit tested without spinning up a full agent session.
export function toolReasonLabel(server, tool, args) {
  if ((tool === 'bash' && !server)) {
    const command = (args && (args.command || args.cmd)) || ''
    if (typeof command === 'string' && command) {
      if (/\bgit\s+clone\b/.test(command)) return 'cloning repo'
      if (/\bgit\b/.test(command)) return 'running git'
      if (/\b(curl|wget)\b/.test(command)) return 'fetching URL'
      if (/\b(cat|less|head|tail)\b/.test(command)) return 'reading file'
      if (/\b(ls|find)\b/.test(command)) return 'listing files'
      if (/\b(npm|pnpm|yarn)\b/.test(command)) return 'running package manager'
      if (/\b(python|python3|node)\b/.test(command)) return 'running script'
      return 'running shell command'
    }
    return 'running shell command'
  }
  if (!server && (tool === 'read' || tool === 'write' || tool === 'edit')) {
    return tool === 'read' ? 'reading file' : tool === 'write' ? 'writing file' : 'editing file'
  }
  if (server) {
    const t = String(tool).toLowerCase()
    if (/get|fetch|search|list/.test(t)) return 'fetching data'
    if (/create|add|post/.test(t)) return 'creating'
    if (/update|edit/.test(t)) return 'updating'
    if (/delete/.test(t)) return 'deleting'
    return `${server} ${tool}`
  }
  return null
}

export function summarizeResult(result) {
  let raw
  try { raw = JSON.stringify(result) } catch { raw = String(result) }
  if (raw == null) raw = ''

  let summary = raw
  if (raw.length <= 500) {
    summary = raw
  } else if (typeof result === 'string') {
    const lines = result.split('\n')
    if (lines.length <= 6) {
      summary = `${lines.length} lines, ${result.length} chars: ${lines.join(' | ')}`
    } else {
      const first = lines.slice(0, 3)
      const last = lines.slice(-3)
      summary = `${lines.length} lines, ${result.length} chars: ${first.join(' | ')} … ${last.join(' | ')}`
    }
  } else if (Array.isArray(result)) {
    const preview = (v) => typeof v === 'string'
      ? (v.length > 80 ? v.slice(0, 80) + '…' : v)
      : Array.isArray(v) ? `[array:${v.length}]` : (v && typeof v === 'object') ? '{object}' : String(v)
    const items = result.slice(0, 8).map(preview)
    summary = `[array:${result.length}] ${items.join(', ')}`
  } else if (result && typeof result === 'object') {
    const preview = (v) => typeof v === 'string'
      ? (v.length > 80 ? v.slice(0, 80) + '…' : v)
      : Array.isArray(v) ? `[array:${v.length}]` : (v && typeof v === 'object') ? '{object}' : String(v)
    const entries = Object.entries(result)
    const shown = entries.slice(0, 8).map(([k, v]) => `${k}: ${preview(v)}`)
    summary = entries.length > 8 ? `(${entries.length} keys) ${shown.join(', ')}, …` : shown.join(', ')
  } else {
    summary = raw
  }

  if (summary.length > 4000) summary = summary.slice(0, 4000) + '…[truncated]'
  return summary
}

export function wantsExactResult(event) {
  const full = event.toolName || 'tool'
  const idx = full.indexOf('_')
  const server = idx > 0 ? full.slice(0, idx) : null
  const tool = idx > 0 ? full.slice(idx + 1) : full
  if (!server && tool === 'bash') {
    const command = (event.args && (event.args.command || event.args.cmd)) || ''
    if (typeof command === 'string' && /\bcat\b/.test(command) && !/\|\s*(jq|grep|head|tail|awk|sed)\b/.test(command)) {
      return true
    }
  }
  const values = Object.values(event.args || {}).filter((v) => typeof v === 'string')
  if (values.some((v) => /\b(raw|verbatim|exact)\b/i.test(v))) return true
  return false
}

// Known MCP tools → realistic example args + reason, used to build a usage
// example for the mcp tool description that reflects the tools actually
// configured for a given run (never hardcoded to a tool that isn't present).
const MCP_TOOL_EXAMPLES = {
  jira_get_issue: { args: { issue_key: 'PROJ-1234' }, reason: 'need ticket description and acceptance criteria' },
  search: { args: { query: 'authentication flow', repo: '/workspace/REPO' }, reason: 'find where auth is implemented before making changes' },
  find_related: { args: { file_path: 'src/auth.py', line: 42, repo: '/workspace/REPO' }, reason: 'find similar code elsewhere in the repo' },
  graphify_query: { args: { question: 'how does the mcp tool loop work', repo: '/workspace/REPO' }, reason: 'get a scoped subgraph answering a codebase question' },
  graphify_explain: { args: { concept: 'tool gating', repo: '/workspace/REPO' }, reason: 'get a focused explanation of one concept' },
  graphify_path: { args: { from: 'ComponentA', to: 'ComponentB', repo: '/workspace/REPO' }, reason: 'find the relationship/path between two named things' },
}

// Build the `mcp({...})` usage example shown in the mcp tool description from
// the real per-run tool list. Picks the FIRST configured tool (toolLines entry
// format: "${server}: ${toolName}") and, when known, uses its realistic example;
// otherwise falls back to a generic example that still uses the real tool name.
// Returns just the mcp(...) call string (the "Usage: " prefix is composed at the
// call site). Empty toolLines → a fully generic example with no concrete tool.
export function buildMcpUsageExample(toolLines) {
  const first = Array.isArray(toolLines) ? toolLines[0] : undefined
  if (!first) {
    return 'mcp({tool:"...", args:"{...}", reason:"why you need this tool call"})'
  }
  const sep = first.indexOf(': ')
  const toolName = sep >= 0 ? first.slice(sep + 2) : first
  const known = MCP_TOOL_EXAMPLES[toolName]
  const args = known ? JSON.stringify(known.args) : '{...}'
  const reason = known ? known.reason : 'why you need this tool call'
  return `mcp({tool:"${toolName}", args:${JSON.stringify(args)}, reason:${JSON.stringify(reason)}})`
}

// Map a bash command string to the addon "tool" names it exercises, used to
// drive the tools-addon gating in the UI (mirrors the MCP server gating).
// Heuristic is intentionally shared verbatim across all agent runtimes.
export function matchToolsFromCommand(command) {
  const cmd = typeof command === 'string' ? command : ''
  const tools = []
  if (/\bgit\b|\bgh\b/.test(cmd)) tools.push('github')
  if (/jira|JIRA_URL|atlassian/i.test(cmd)) tools.push('jira')
  if (/\bgraphify\b/.test(cmd)) tools.push('graphify')
  return tools
}

// Graphify, like semble, has no per-call-repo-switchable HTTP MCP mode usable
// here, so it is exposed as a CLI shim routed through the mcp() gateway. These
// two pure helpers decide whether a call targets graphify and build its argv.
export function isGraphifyToolCall(server, toolName) {
  if (server === 'graphify') return true
  return toolName === 'graphify_query' || toolName === 'graphify_explain' || toolName === 'graphify_path'
}

export function buildGraphifyCliArgs(toolName, toolArgs) {
  const repo = toolArgs && toolArgs.repo
  if (!repo) return { error: 'Error: graphify calls require a "repo" arg, e.g. repo: "/workspace/<repo-name>"' }
  if (toolName === 'graphify_query') {
    if (!toolArgs.question) return { error: 'Error: graphify_query requires a "question" arg' }
    return { repo, cliArgs: ['query', String(toolArgs.question), '.'] }
  }
  if (toolName === 'graphify_explain') {
    if (!toolArgs.concept) return { error: 'Error: graphify_explain requires a "concept" arg' }
    return { repo, cliArgs: ['explain', String(toolArgs.concept)] }
  }
  if (toolName === 'graphify_path') {
    if (!toolArgs.from || !toolArgs.to) return { error: 'Error: graphify_path requires "from" and "to" args' }
    return { repo, cliArgs: ['path', String(toolArgs.from), String(toolArgs.to)] }
  }
  return { error: `Error: unknown graphify tool "${toolName}"` }
}

export function formatToolStartMessage(event) {
  const full = event.toolName || 'tool'
  const idx = full.indexOf('_')
  const server = idx > 0 ? full.slice(0, idx) : null
  const tool = idx > 0 ? full.slice(idx + 1) : full
  let argsStr = ''
  try { argsStr = JSON.stringify(event.args) } catch { argsStr = String(event.args) }
  if (argsStr == null) argsStr = ''
  if (argsStr.length > 4000) argsStr = argsStr.slice(0, 4000) + '…[truncated]'
  const reason = toolReasonLabel(server, tool, event.args)
  return (server ? `🔧 ${server} → ${tool}(${argsStr})` : `Running ${full}(${argsStr})`) + (reason ? ` — ${reason}` : '')
}

export function formatToolEndMessage(event) {
  const full = event.toolName || 'tool'
  const idx = full.indexOf('_')
  const server = idx > 0 ? full.slice(0, idx) : null
  const tool = idx > 0 ? full.slice(idx + 1) : full
  const label = server ? `${server} → ${tool}` : full
  if (event.isError) {
    let resultStr = ''
    try { resultStr = JSON.stringify(event.result) } catch { resultStr = String(event.result) }
    if (resultStr == null) resultStr = ''
    if (resultStr.length > 4000) resultStr = resultStr.slice(0, 4000) + '…[truncated]'
    return `✗ ${label} failed: ${resultStr}`
  }
  if (wantsExactResult(event)) {
    let resultStr = ''
    try { resultStr = JSON.stringify(event.result) } catch { resultStr = String(event.result) }
    if (resultStr == null) resultStr = ''
    if (resultStr.length > 4000) resultStr = resultStr.slice(0, 4000) + '…[truncated]'
    return `✓ ${label} done — exact result requested: ${resultStr}`
  }
  return `✓ ${label} done: ${summarizeResult(event.result)}`
}

// ── Build prompt ─────────────────────────────────────────────────────────
// Pure function: turns { request/task/prompt + extra keys + clarification_context }
// into a single prompt string, optionally prefixed with system_prompt.
const BUILD_PROMPT_SKIP_KEYS = new Set(['request', 'task', 'prompt', 'clarification_context'])

export function buildPrompt(system_prompt, input) {
  const hasRequestKey = input?.request != null || input?.task != null || input?.prompt != null
  const request = input?.request ?? input?.task ?? input?.prompt ?? JSON.stringify(input)

  const sections = []
  if (hasRequestKey) {
    if (input && typeof input === 'object') {
      for (const [k, v] of Object.entries(input)) {
        if (BUILD_PROMPT_SKIP_KEYS.has(k) || k.startsWith('_') || v == null) continue
        sections.push(`## ${k}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
      }
    }

    const clarificationContext = input?.clarification_context
    if (clarificationContext != null) {
      sections.push(
        `## Clarification context\n${typeof clarificationContext === 'string' ? clarificationContext : JSON.stringify(clarificationContext, null, 2)}`
      )
    }
  }

  const body = [request, ...sections].join('\n\n')
  return system_prompt ? `${system_prompt}\n\n${body}` : body
}

// ── Final-JSON detection ─────────────────────────────────────────────────
// Pure function: decides whether `text` should count as the model's final
// JSON output for the nudge loop. The original anchored regex only matched
// JSON at position 0, so prose-prefixed JSON (e.g. "Producing final plan.\n\n
// ```json\n{...}```") failed detection and triggered a wasted nudge round-trip
// at the most expensive point in a run. This also accepts a trailing fenced
// or bare JSON object after prose.
export function looksLikeFinalJson(text) {
  if (!text) return false
  // Bare or fenced JSON at position 0 — preserves original behavior.
  if (/^\s*(```(json)?\s*)?\{/.test(text)) return true
  // Last fenced code block whose content starts with '{'.
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g
  let m
  let last = null
  while ((m = fenceRe.exec(text)) !== null) last = m
  if (last && last[1].trim().startsWith('{')) return true
  // Prose followed by a bare trailing JSON object, or a truncated/unclosed
  // trailing fence whose content still ends in '}'.
  const trimmed = text.trim()
  if (/^\s*\{/m.test(text) && trimmed.endsWith('}')) return true
  return false
}

// ── Cache-frontier bookkeeping (inert / observability only) ──────────────
// Wire-shape adapter over pi-post-compact's cacheFrontierIndex. Given the
// running `messages` array and iterables of tool_call_ids still pending
// collapse — `pendingIds` are tool results pending in _exactOnceTracked (whose
// content mutates in place on a later turn), `pendingArgIds` are assistant
// tool_call ids pending in _argCollapseTracked (whose arguments get replaced by
// a summary stub), and `pendingMsgs` are assistant message OBJECT refs pending
// in _contentCollapseTracked (whose plain-string content collapses in place) —
// return the index of the FIRST message still pending any kind of collapse.
// Everything strictly before that index is stable/cacheable.
// NOTE: this does NOT attach cache_control or alter any request — it is
// log-only bookkeeping for a future caching pass.
export function cacheFrontierIndex(messages, pendingIds, pendingArgIds = [], pendingMsgs = []) {
  const pending = pendingIds instanceof Set ? pendingIds : new Set(pendingIds)
  const pendingArgs = pendingArgIds instanceof Set ? pendingArgIds : new Set(pendingArgIds)
  const pendingMsgSet = pendingMsgs instanceof Set ? pendingMsgs : new Set(pendingMsgs)
  return _cacheFrontierIndexBy(messages, (msg) => {
    if (pendingMsgSet.has(msg)) return true
    if (msg.role === 'tool' && pending.has(msg.tool_call_id)) return true
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)
      && msg.tool_calls.some(tc => pendingArgs.has(tc.id))) return true
    return false
  })
}

// ── Wire-shape collapse trackers ─────────────────────────────────────────
// summarizeToolCallArgs (the stub text) and the collapse timing rules live in
// pi-post-compact. These two only locate collapse candidates in the OpenAI
// chat-completions message shape this loop builds by hand.

// Track assistant messages whose tool_call arguments exceed `threshold` chars,
// so they can be collapsed in place to a summary stub on a later round-trip.
export function trackLargeToolCallArgs(msg, roundTrip, map, threshold) {
  for (const tc of msg?.tool_calls || []) {
    if (typeof tc?.function?.arguments === 'string'
      && tc.function.arguments.length > threshold
      && !map.has(tc.id)) {
      map.set(tc.id, { msg, toolCall: tc, fnName: tc.function.name, roundTripCreated: roundTrip })
    }
  }
}

// Track assistant messages whose plain-string content exceeds threshold, keyed
// by a synthetic id from makeId(), for in-place collapse after one round-trip.
export function trackLargeAssistantContent(msg, roundTrip, map, threshold, makeId) {
  if (!msg || typeof msg.content !== 'string' || msg.content.length <= threshold) return
  for (const e of map.values()) if (e.msg === msg) return  // already tracked
  map.set(makeId(), { msg, roundTripCreated: roundTrip })
}

export async function startRun(body, client, setAbort) {
  const { input, agent_config = {} } = body
  const {
    credentials = {},
    extra = {},
    env_vars = {},
    system_prompt,
    mcp_servers = [],
    tool_access = null,
  } = agent_config

  // ── Bash-level tool gates (github/jira/graphify) ───────────────────────
  // Absent/null tool_access → all enabled (rollout compat). Present → exact
  // (missing key = disabled). A `toolEnabled` helper centralizes the rule.
  const toolEnabled = (name) => (tool_access == null ? true : Boolean(tool_access[name]))
  // Warm-pod hygiene: purge stale gated env vars from a prior run BEFORE we
  // assign fresh credentials, so a now-disabled tool cannot leak old values.
  const _GATED_ENV = {
    github: ['GITHUB_TOKEN', 'MCP_GITHUB_API_KEY'],
    jira: ['JIRA_API_TOKEN', 'MCP_JIRA_API_TOKEN', 'JIRA_URL', 'JIRA_USERNAME'],
  }
  for (const [name, keys] of Object.entries(_GATED_ENV)) {
    if (!toolEnabled(name)) {
      for (const k of keys) delete process.env[k]
    }
  }

  // ── Resolve model + auth from agent_config ─────────────────────────────
  const { authStorage, modelRegistry, model } = resolveModelConfig(agent_config)

  // Also expose credentials/env on process.env so pi's subprocess tools
  // (bash, git, etc.) inherit them.
  Object.assign(process.env, credentials, env_vars)

  if (toolEnabled('github')) {
    // Alias MCP_GITHUB_API_KEY → GITHUB_TOKEN (tools/bash git-clone expect
    // GITHUB_TOKEN by convention). Keep MCP_GITHUB_API_KEY as-is.
    if (credentials.MCP_GITHUB_API_KEY && !process.env.GITHUB_TOKEN) {
      process.env.GITHUB_TOKEN = credentials.MCP_GITHUB_API_KEY
    }
    // Wire git to auth https://github.com clones via GITHUB_TOKEN. Helper reads
    // the token from the env at fetch time — nothing secret is written to disk,
    // warm-pod token rotation is handled, and the command is safe to log.
    if (process.env.GITHUB_TOKEN) {
      try {
        execSync(
          `git config --global --replace-all credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'`,
          { stdio: 'ignore' }
        )
      } catch (e) {
        console.warn(`[runner] git credential helper setup failed: ${e.message}`)
      }
    }
  } else {
    // Disabled: drop any git credential helper so warm-pod reuse can't clone.
    try {
      execSync('git config --global --unset-all credential.helper', { stdio: 'ignore' })
    } catch (e) { /* ignore — helper may not be set */ }
  }

  if (toolEnabled('jira')) {
    // Alias MCP_JIRA_API_TOKEN → JIRA_API_TOKEN (bash fallbacks in agent
    // prompts expect the bare name by convention, matching the GitHub alias
    // above). The backend forwards JIRA_URL/JIRA_USERNAME via `credentials`
    // when the jira tool is enabled (already on process.env from the
    // Object.assign above); the jira `mcp_servers` env below is kept as a
    // fallback for backends that predate that forwarding.
    if (credentials.MCP_JIRA_API_TOKEN && !process.env.JIRA_API_TOKEN) {
      process.env.JIRA_API_TOKEN = credentials.MCP_JIRA_API_TOKEN
    }
    const jiraServer = (Array.isArray(mcp_servers) ? mcp_servers : []).find(s => s?.name === 'jira')
    if (jiraServer?.env) {
      if (jiraServer.env.JIRA_URL && !process.env.JIRA_URL) {
        process.env.JIRA_URL = jiraServer.env.JIRA_URL
      }
      if (jiraServer.env.JIRA_USERNAME && !process.env.JIRA_USERNAME) {
        process.env.JIRA_USERNAME = jiraServer.env.JIRA_USERNAME
      }
    }
  }

  // graphify: shadow the binary on PATH with an exit-127 stub when disabled;
  // restore the clean PATH when enabled (reversible per warm-pod run).
  if (toolEnabled('graphify')) {
    process.env.PATH = ORIGINAL_PATH
  } else {
    try {
      mkdirSync(DISABLED_BIN_DIR, { recursive: true })
      const stubPath = join(DISABLED_BIN_DIR, 'graphify')
      writeFileSync(stubPath, '#!/bin/sh\necho "graphify is disabled for this agent" >&2\nexit 127\n', { mode: 0o755 })
      process.env.PATH = `${DISABLED_BIN_DIR}:${ORIGINAL_PATH}`
      console.log(`[runner] graphify disabled — shadowed on PATH via ${stubPath}`)
    } catch (e) {
      console.warn(`[runner] failed to install graphify stub: ${e.message}`)
    }
  }
  const keyEnvName = extra.llm_api_key_env || 'ANTHROPIC_API_KEY'
  const apiKey = credentials[keyEnvName]
  if (apiKey) {
    process.env[keyEnvName] = apiKey
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || apiKey
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || apiKey
  }
  if (extra.llm_base_url) {
    process.env.OPENAI_BASE_URL = extra.llm_base_url
  }

  // Materialize any *_JSON GCP service-account credentials to temp files and
  // activate gcloud auth so gsutil (workspace S3/GCS restore+backup) works.
  activateGcloudServiceAccount()

  // ── Pre-start stdio MCP servers as HTTP so pi-mcp-adapter connects instantly ──
  // Spawning uvx mcp-atlassian during session_start races with the first model
  // call. Pre-start it here as a local HTTP server so initializeMcp finds it
  // already running — connection is instant vs 15-30s subprocess startup.
  _mcpHttpServers = {}  // reset module-level map for this run
  let _nextPort = 8090
  const _mcpServersForSession = Array.isArray(mcp_servers) ? [...mcp_servers] : []
  for (const s of _mcpServersForSession) {
    if (!s || !s.name || s.url) continue  // skip remote/HTTP servers
    if (!Array.isArray(s.command) || !s.command.length) continue
    // semble's MCP server is stdio-only (run_stdio_async) and its CLI rejects
    // --transport/--port — leave it out of the HTTP pre-start so setupMcp
    // writes it as a stdio entry for pi-mcp-adapter instead.
    if (s.command[0] === 'semble') continue
    const port = _nextPort++
    const env = { ...process.env, ...(s.env || {}) }
    console.log(`[pi-agent] pre-starting ${s.name} as HTTP on port ${port}`)
    try {
      const proc = spawn(s.command[0], [...s.command.slice(1), '--transport', 'streamable-http', '--port', String(port)], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      proc.stdout?.on('data', d => console.log(`[pi-agent:${s.name}]`, d.toString().trim()))
      proc.stderr?.on('data', d => console.log(`[pi-agent:${s.name}:err]`, d.toString().trim().slice(0, 200)))
      proc.on('exit', code => {
        console.log(`[pi-agent] ${s.name} HTTP server exited (code ${code})`)
        // A dead pre-start must not shadow the stdio fallback in setupMcp —
        // otherwise mcp.json points at a URL nothing is listening on.
        if (_mcpHttpServers[s.name]?.proc === proc) delete _mcpHttpServers[s.name]
      })
      _mcpHttpServers[s.name] = { proc, port, url: `http://localhost:${port}/mcp` }
    } catch (e) {
      console.warn(`[pi-agent] failed to pre-start ${s.name}:`, e.message)
    }
  }
  // Wait for HTTP servers to become ready
  if (Object.keys(_mcpHttpServers).length > 0) {
    await new Promise(r => setTimeout(r, 5000))
    console.log('[pi-agent] MCP HTTP servers ready:', Object.keys(_mcpHttpServers).join(', '))
  }

  // ── Diagnostic: log mcp_servers received from backend ────────────────
  console.log('[pi-agent] mcp_servers received:', JSON.stringify(
    (Array.isArray(mcp_servers) ? mcp_servers : []).map(s => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      url: s.url,
      env_keys: Object.keys(s.env || {}),
    }))
  ))

  // mcp tool schema built from pre-warmed cache, injected into API calls so the model can call Jira tools
  let _mcpToolSchema = null
  // read_artifact tool schema — always available (artifact-writing is now
  // unconditional), no dynamic content, so build it once here rather than
  // through the mcp schema's pre-warm-cache dance.
  let _readArtifactToolSchema = {
    type: 'function',
    function: {
      name: 'read_artifact',
      description: 'Fetch back the full raw output of an earlier tool call by its artifact id, when a summarized result was not enough. The artifact id is shown in truncated/summarized tool results as "artifact \\"<id>\\"".',
      parameters: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'The artifact id shown in an earlier truncated or summarized tool result' },
        },
        required: ['artifact_id'],
      },
    },
  }
  let _mcpForcedOnce = false   // force tool_choice=mcp on first API call only
  let _mcpResolving = false    // true when stream=false forced; next response needs tool_call resolution
  let _mcpRetries = 0          // remaining retries when model ignores tool_choice

  // Run-scoped accumulator for the post-compact meta-LLM's own token usage
  // (pi-post-compact's compactToolResult calls, invoked from _maybeCompact
  // below). Unlike _usageAcc (declared per-turn inside the mcp-resolving
  // branch further down), this lives for the whole run so meta cost from
  // every mcp-resolver turn accumulates here instead of leaking into the
  // agent's own token_usage / getSessionStats().
  const _metaUsageAcc = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

  // ── Intercept API calls: inject mcp schema, force first turn, resolve tool_calls ──
  globalThis.fetch = async function(url, opts, ...rest) {
    const urlStr = String(url)
    const isSkipResolver = urlStr.includes('_skip_resolver=1')
    const cleanUrl = isSkipResolver ? urlStr.replace(/[?&]_skip_resolver=1/, '') : urlStr

    if ((urlStr.includes('completions') || urlStr.includes('responses')) && !isSkipResolver) {
      try {
        const body = opts?.body ? JSON.parse(opts.body) : null
        if (body) {
          // Inject mcp tool schema — extension tools don't auto-appear in openai-completions
          if (_mcpToolSchema && Array.isArray(body.tools) && !body.tools.some(t => t?.function?.name === 'mcp')) {
            body.tools = [...body.tools, _mcpToolSchema]
          }
          // read_artifact — unconditional injection (no dependence on mcp_servers).
          if (_readArtifactToolSchema && Array.isArray(body.tools) && !body.tools.some(t => t?.function?.name === 'read_artifact')) {
            body.tools = [...body.tools, _readArtifactToolSchema]
          }
          // Best-effort: ask bash callers for a `reason` too (schema-only, NOT
          // required — bash's schema belongs to the third-party SDK and there's
          // no forced tool_choice mechanism for it like there is for mcp above,
          // so the model may ignore this; compaction of bash results is
          // unconditional regardless, see _runMcpToolLoop's 'bash' branch).
          const _augmentNames = _mcpToolSchema ? ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'] : ['bash']
          if (Array.isArray(body.tools)) {
            for (const _name of _augmentNames) {
              const t = body.tools.find(t => t?.function?.name === _name)
              const props = t?.function?.parameters?.properties
              if (props && !props.reason) props.reason = { type: 'string', description: 'Why you are running this command / what you are looking for (optional)' }
              if (props && !props.exact) props.exact = { type: 'boolean', description: 'true = keep verbatim, only when exact line numbers/content/error text needed (e.g. reading a file you will edit next); default false = summarize' }
            }
          }
          // Strip tools this loop can't execute (read/write/edit/grep/find/ls/graphify/...)
          // from the outgoing request. This mcp-resolver machinery (schema injection,
          // forced tool_choice, _runMcpToolLoop) is NOT gated by model — it activates
          // unconditionally whenever _mcpToolSchema exists (i.e. whenever mcp_servers
          // produced a tool cache), for every model that reaches this fetch interceptor.
          // There is no separate "native SDK tool execution" path running concurrently
          // for a different model in this same request flow, so this filter is safe to
          // apply globally rather than gating it to kimi-k2 specifically. mcp, bash,
          // read_artifact and the native read/edit/write/grep/find/ls tools are all
          // executed by _runMcpToolLoop — keep only those. Idempotent: re-filtering an
          // already-filtered list is a no-op.
          if (_mcpToolSchema && Array.isArray(body.tools)) {
            const _KEEP_TOOLS = new Set(['mcp', 'bash', 'read_artifact', 'read', 'edit', 'write', 'grep', 'find', 'ls'])
            body.tools = body.tools.filter(t => _KEEP_TOOLS.has(t?.function?.name))
          }
          // Force mcp on first turn + disable streaming so response is parseable for tool_call resolution
          if (_mcpToolSchema && !_mcpForcedOnce && Array.isArray(body.tools) && body.tools.some(t => t?.function?.name === 'mcp')) {
            // Use "required" (any tool) — kimi-k2 sometimes ignores named-function forcing
            body.tool_choice = 'required'
            body.stream = false
            // stream_options is only valid alongside stream=true — strict
            // endpoints (Anthropic's OpenAI-compat layer) 400 the whole
            // request if it survives the stream flip. OpenRouter tolerates
            // it, which masked this until an anthropic-provider agent ran.
            delete body.stream_options
            _mcpForcedOnce = true
            _mcpResolving = true
            _mcpRetries = 2  // allow up to 2 retries if model returns stop instead of tool_calls
            console.log('[pi-agent] forcing tool_choice=required + stream=false for first turn')
          }
          opts = { ...opts, body: JSON.stringify(body) }
          const toolNames = (body.tools || []).map(t => t?.function?.name || t?.name || '?')
          console.log('[pi-agent] API call to:', cleanUrl.split('?')[0])
          console.log('[pi-agent] model:', body.model)
          console.log('[pi-agent] tools in request:', toolNames.length, toolNames.length ? toolNames.join(', ') : '(none)')
          console.log('[pi-agent] tool_choice:', JSON.stringify(body.tool_choice))
          if (_mcpToolSchema && toolNames.includes('mcp')) console.log('[pi-agent] mcp tool injected ✓')
        }
      } catch (e) { /* ignore parse errors */ }
    }

    const response = await _origFetch(isSkipResolver ? cleanUrl : url, opts, ...rest)

    // Resolve mcp tool_calls from the non-streaming forced turn
    if (_mcpResolving && (urlStr.includes('completions') || urlStr.includes('responses')) && !isSkipResolver) {
      // Declared outside the try so the catch below can still report whatever
      // usage accumulated before a mid-chain failure, instead of collapsing to
      // zero (see the catch block for why this matters).
      const _usageAcc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      const _addUsage = (u) => {
        if (!u) return
        _usageAcc.prompt_tokens += u.prompt_tokens || 0
        _usageAcc.completion_tokens += u.completion_tokens || 0
        _usageAcc.total_tokens += u.total_tokens || 0
      }
      // `opts` (and any opts.signal) belongs to the SDK's ORIGINAL single
      // request. This resolver loop chains many follow-up fetches (per MCP
      // call, per bash call, nudges, forced summary) on top of that one
      // request — reusing opts.signal verbatim means all of them share the
      // SAME deadline the SDK set for ONE call. Short chains never notice;
      // long chains (many tool calls) eventually run past that shared
      // deadline and whatever fetch happens to be in flight at that moment
      // gets aborted instantly, even though it just started. Give every
      // chained call in this loop its own fresh, bounded timeout instead.
      const CHAINED_CALL_TIMEOUT_MS = Number(process.env.MCP_RESOLVER_CALL_TIMEOUT_MS || 120_000)
      const ARTIFACT_DIR = '/workspace/.tool_artifacts'
      const TOOL_RESULT_MAX_CHARS = Number(process.env.MCP_TOOL_RESULT_MAX_CHARS || 20000)
      const ARG_COLLAPSE_MIN_CHARS = Number(process.env.MCP_ARG_COLLAPSE_MIN_CHARS || 800)
      const _chainedOpts = (body) => ({
        ...opts,
        signal: AbortSignal.timeout(CHAINED_CALL_TIMEOUT_MS),
        body: JSON.stringify(body),
      })
      try {
        const text = await response.text()
        const data = JSON.parse(text)
        const choice = data?.choices?.[0]
        if (!choice) {
          console.log('[pi-agent] mcp-turn returned no choices — status:', response.status, 'body:', text.slice(0, 300))
        }
        console.log('[pi-agent] mcp-turn finish_reason:', choice?.finish_reason)
        console.log('[pi-agent] mcp-turn tool_calls:', JSON.stringify((choice?.message?.tool_calls || []).map(tc => tc?.function?.name)))
        _addUsage(data.usage)

        // Route mcp/bash tool results through pi-post-compact's summarizer
        // before they re-enter the message array — raw, uncapped tool output
        // here previously caused one production run to burn 119,477 prompt
        // tokens vs ~12k expected.
        const MIN_CHARS = Number(process.env.MCP_COMPACT_MIN_CHARS || DEFAULT_MIN_CHARS)
        // modelRegistry here is ModelRegistry.inMemory(authStorage) from
        // resolveModelConfig() in the enclosing startRun() closure — the SDK's own
        // tool_result hook calls the same getApiKeyAndHeaders(model) method on its
        // ctx.modelRegistry, so this is the same shape/contract.
        const _compactDeps = {
          metaLlm: resolveMetaLlm({ cwd: '/workspace' }),
          modelRegistry,
          minChars: MIN_CHARS,
          log: (m) => console.log(`[pi-agent] ${m}`),
        }
        // Compaction policy (threshold, no-shrink guard, never-lose-data fallback)
        // lives in pi-post-compact. This wrapper only adds what is local to this
        // loop: accumulating the meta-LLM's own token cost into _metaUsageAcc
        // (NOT _usageAcc/_addUsage) so it never mixes into the agent's own
        // token_usage. Caveman-style one-sentence output is requested via the
        // `style` option rather than smuggled through `reason`.
        const _maybeCompact = async (raw, { exact, reason, prompt }) => {
          const result = await compactOrKeep(
            raw,
            { exact, reason, prompt, style: 'caveman-one-sentence' },
            _compactDeps,
          )
          const u = result.usage
          if (u) {
            const inp = u.input_tokens ?? u.prompt_tokens ?? 0
            const out = u.output_tokens ?? u.completion_tokens ?? 0
            _metaUsageAcc.input_tokens += inp
            _metaUsageAcc.output_tokens += out
            _metaUsageAcc.total_tokens += u.total_tokens ?? (inp + out)
          }
          return result.text
        }

        // kimi-k2 sometimes ignores tool_choice and returns stop — retry up to _mcpRetries times
        if (choice?.finish_reason !== 'tool_calls' && _mcpRetries > 0) {
          _mcpRetries--
          console.log('[pi-agent] model ignored tool_choice, retrying (', _mcpRetries, 'left)')
          const retryBody = JSON.parse(opts?.body || '{}')
          retryBody.tool_choice = 'required'
          retryBody.stream = false
          delete retryBody.stream_options
          const retryResp = await _origFetch(url, _chainedOpts(retryBody), ...rest)
          const retryText = await retryResp.text()
          const retryData = JSON.parse(retryText)
          _addUsage(retryData.usage)
          const retryChoice = retryData?.choices?.[0]
          if (!retryChoice) {
            console.log('[pi-agent] retry returned no choices — status:', retryResp.status, 'body:', retryText.slice(0, 300))
          }
          console.log('[pi-agent] retry finish_reason:', retryChoice?.finish_reason)
          if (retryChoice?.finish_reason === 'tool_calls') {
            // swap in retry response for the main resolver path below
            data.choices[0] = retryChoice
            choice.finish_reason = retryChoice.finish_reason
            choice.message = retryChoice.message
          }
        }

        _mcpResolving = false

        // Loop: chain MCP calls until model stops — model decides when it has enough data
        const origBody = JSON.parse(opts?.body || '{}')
        const sep = cleanUrl.includes('?') ? '&' : '?'
        let currentChoice = choice
        let currentMessages = [...(origBody.messages || []), ...(choice?.message ? [choice.message] : [])]
        let mcpIterations = 0

        // exact:true results ride raw in context for exactly the ONE follow-up
        // call immediately after they're created (so the model gets to reason
        // over the precise content once), then get retroactively collapsed to a
        // short ACTION summary — not a content summary like exact:false gets.
        // exact:false answers "what does this contain"; this answers "what did
        // I learn" (e.g. reason "find the sort field" -> "sort_key found on
        // line 42"), which compresses much harder since it's one fact, not a
        // description. read_artifact remains the escape hatch if raw is needed
        // again. Content under MIN_CHARS isn't worth collapsing — see below.
        let _roundTrip = 0
        const _exactOnceTracked = new Map()  // tool_call_id -> { msg, reason, roundTripCreated }
        const _argCollapseTracked = new Map()  // tool_call_id -> { msg, toolCall, fnName, roundTripCreated }
        let _asstMsgCounter = 0
        const _contentCollapseTracked = new Map()  // synthetic id -> { msg, roundTripCreated }
        const _trackContent = (msg) => trackLargeAssistantContent(msg, _roundTrip, _contentCollapseTracked, ARG_COLLAPSE_MIN_CHARS, () => `asst-${++_asstMsgCounter}`)
        // Native read/edit/write/grep/find/ls executed inside this loop via SDK
        // tool factories (rooted at /workspace) — keyed by tool name for dispatch.
        const _nativeTools = Object.fromEntries(
          [createReadTool('/workspace'), createEditTool('/workspace'), createWriteTool('/workspace'),
           createGrepTool('/workspace'), createFindTool('/workspace'), createLsTool('/workspace')]
          .map(t => [t.name, t]))
        if (choice?.message) trackLargeToolCallArgs(choice.message, _roundTrip, _argCollapseTracked, ARG_COLLAPSE_MIN_CHARS)
        if (choice?.message) _trackContent(choice.message)

        const _collapseUsedExactResults = async () => {
          for (const [id, e] of _exactOnceTracked) {
            if (_roundTrip <= e.roundTripCreated) continue  // not sent even once yet
            e.msg.content = await _maybeCompact(e.msg.content, {
              exact: false,
              reason: e.reason,
              prompt: buildActionSummaryInstruction(e.reason),
            })
            _exactOnceTracked.delete(id)
            console.log('[pi-agent] collapsed exact tool result to action summary after one use:', id, `(reason: "${e.reason}")`)
          }
        }

        const _collapseUsedLargeArgs = () => {
          for (const [id, e] of _argCollapseTracked) {
            // +1: tools execute in round roundTripCreated+1; results reasoned over by round +2.
            // Collapsing at bare >roundTripCreated would mutate args BEFORE this iteration's
            // JSON.parse executes them.
            if (_roundTrip <= e.roundTripCreated + 1) continue
            const sanitizedId = String(id).replace(/[^A-Za-z0-9_-]/g, '_')
            const original = e.toolCall.function.arguments
            try {
              mkdirSync(ARTIFACT_DIR, { recursive: true })
              writeFileSync(join(ARTIFACT_DIR, `${sanitizedId}-args.txt`), original)
            } catch (err) { console.warn('[pi-agent] args artifact write failed:', sanitizedId, err.message) }
            const summary = summarizeToolCallArgs(e.fnName, original)
            e.toolCall.function.arguments = JSON.stringify({ collapsed: true, summary, artifact_id: `${sanitizedId}-args` })
            _argCollapseTracked.delete(id)
            console.log('[pi-agent] collapsed assistant tool-call args:', id, summary)
          }
        }

        const _collapseUsedAssistantContent = async () => {
          for (const [id, e] of _contentCollapseTracked) {
            // +1 mirrors _collapseUsedLargeArgs: content created round r is first SENT in round r+1's
            // follow-up; collapse only once the model has reasoned over it (round >= r+2).
            if (_roundTrip <= e.roundTripCreated + 1) continue
            const original = e.msg.content
            try {
              mkdirSync(ARTIFACT_DIR, { recursive: true })
              writeFileSync(join(ARTIFACT_DIR, `${id}-content.txt`), original)
            } catch (err) { console.warn('[pi-agent] content artifact write failed:', id, err.message) }
            const summary = await _maybeCompact(original, { exact: false, reason: ASSISTANT_CONTENT_REASON })
            _contentCollapseTracked.delete(id)
            if (summary === original) { console.log('[pi-agent] assistant content collapse skipped (no shrink):', id); continue }
            e.msg.content = `[collapsed: ${summary} — full text: read_artifact "${id}-content"]`
            console.log('[pi-agent] collapsed assistant content:', id, `${original.length} -> ${e.msg.content.length} chars`)
          }
        }

        const _runMcpToolLoop = async () => {
          while (currentChoice?.finish_reason === 'tool_calls') {
            _roundTrip++
            await _collapseUsedExactResults()
            _collapseUsedLargeArgs()
            await _collapseUsedAssistantContent()
            const toolCalls = currentChoice?.message?.tool_calls || []
            if (!toolCalls.length) break

            // Resolve EVERY tool_call in the turn before the follow-up.
            // Handling only the first one left the rest dangling, and strict
            // endpoints (Anthropic's OpenAI-compat layer) 400 the follow-up
            // when an assistant tool_call has no matching tool result.
            let _stoppedOnUnsupported = false
            const toolMessages = []
            let toolLabel
            for (const toolCall of toolCalls) {
            const fnName = toolCall?.function?.name

            let toolResult, reason, exact
            if (fnName === 'mcp') {
              const mcpArgs = JSON.parse(toolCall.function.arguments || '{}')
              toolLabel = mcpArgs.tool || 'mcp'
              // reason is required by _mcpToolSchema (enforced via required + forced
              // tool_choice); exact opts into verbatim output. Strip both before the
              // underlying tool sees the args — mirrors pi-post-compact's own
              // tool_call hook, which strips post_compact from tool input the same way.
              reason = mcpArgs.reason || toolLabel
              exact = mcpArgs.exact === true
              delete mcpArgs.reason
              delete mcpArgs.exact
              const argsPreview = mcpArgs.args ? String(mcpArgs.args) : ''
              console.log('[pi-agent] executing mcp:', toolLabel, 'args:', argsPreview.slice(0, 120), '(iteration', mcpIterations, ')')
              Promise.resolve(client.sendProgress(`🔧 mcp → ${toolLabel}(${argsPreview})`)).catch(() => {})
              toolResult = await _executeMcpTool(mcpArgs)
              console.log('[pi-agent] mcp result preview:', String(toolResult).slice(0, 300))
              Promise.resolve(client.sendProgress(`✓ ${toolLabel} done`)).catch(() => {})
            } else if (fnName === 'bash') {
              // Native SDK tool — normally handled by the SDK's own execution
              // engine, which this custom loop bypasses entirely. Without this,
              // a bash call made mid-loop (e.g. "git clone ...") would be
              // silently dropped, leaving its tool_call unresolved.
              const bashArgs = JSON.parse(toolCall.function.arguments || '{}')
              const command = bashArgs.command || bashArgs.cmd || ''
              toolLabel = 'bash'
              // bash's schema-added `reason`/`exact` are best-effort only (no
              // forced tool_choice for bash like mcp has), but when the model
              // does supply them we honor them the same way the mcp branch does.
              reason = bashArgs.reason || 'bash command output in mcp-resolver loop'
              exact = bashArgs.exact === true
              delete bashArgs.reason
              delete bashArgs.exact
              console.log('[pi-agent] executing bash (mcp-resolver loop):', command.slice(0, 200))
              Promise.resolve(client.sendProgress(`🔧 bash → ${command}`)).catch(() => {})
              const _bashTools = matchToolsFromCommand(command)
              for (const t of _bashTools) {
                Promise.resolve(client.sendProgress(`__tool_start__:${JSON.stringify({ tool: t })}`)).catch(() => {})
              }
              try {
                toolResult = await _executeBashTool(command)
              } finally {
                for (const t of _bashTools) {
                  Promise.resolve(client.sendProgress(`__tool_end__:${JSON.stringify({ tool: t })}`)).catch(() => {})
                }
              }
              console.log('[pi-agent] bash result preview:', String(toolResult).slice(0, 300))
              Promise.resolve(client.sendProgress(`✓ bash done`)).catch(() => {})
            } else if (fnName === 'read_artifact') {
              const readArgs = JSON.parse(toolCall.function.arguments || '{}')
              const rawId = String(readArgs.artifact_id || '')
              const sanitizedId = rawId.replace(/[^A-Za-z0-9_-]/g, '_')
              toolLabel = 'read_artifact'
              reason = `retrieve full artifact ${sanitizedId}`
              exact = true  // never re-summarize an explicit request for raw content
              const artifactPath = join(ARTIFACT_DIR, `${sanitizedId}.txt`)
              try {
                toolResult = existsSync(artifactPath) ? readFileSync(artifactPath, 'utf-8') : `Error: no artifact found with id "${sanitizedId}"`
              } catch (e) {
                toolResult = `Error reading artifact "${sanitizedId}": ${e.message}`
              }
              console.log('[pi-agent] read_artifact:', sanitizedId, '(iteration', mcpIterations, ')')
            } else if (_nativeTools[fnName]) {
              const rawArgs = JSON.parse(toolCall.function.arguments || '{}')
              toolLabel = fnName
              reason = rawArgs.reason || `${fnName} output in mcp-resolver loop`
              // read/write/edit default exact=true (read = verbatim-once via Path B; write/edit results tiny);
              // grep/find/ls default exact=false (summarize). Explicit model choice always wins.
              exact = rawArgs.exact === true
                || (rawArgs.exact === undefined && (fnName === 'read' || fnName === 'write' || fnName === 'edit'))
              delete rawArgs.reason
              delete rawArgs.exact
              const _tool = _nativeTools[fnName]
              const _argPreview = String(rawArgs.path ?? rawArgs.pattern ?? '').slice(0, 120)
              console.log('[pi-agent] executing native', fnName, '→', _argPreview, '(iteration', mcpIterations, ')')
              Promise.resolve(client.sendProgress(`🔧 ${fnName} → ${_argPreview}`)).catch(() => {})
              try {
                const _params = _tool.prepareArguments ? _tool.prepareArguments(rawArgs) : rawArgs
                const _res = await _tool.execute(String(toolCall.id || ''), _params, AbortSignal.timeout(CHAINED_CALL_TIMEOUT_MS))
                toolResult = (_res?.content || [])
                  .map(c => c?.type === 'text' ? (c.text ?? '') : '[image omitted]')
                  .join('\n')
              } catch (e) {
                toolResult = `Error: ${e.message}`
              }
              console.log('[pi-agent]', fnName, 'result preview:', String(toolResult).slice(0, 300))
              Promise.resolve(client.sendProgress(`✓ ${fnName} done`)).catch(() => {})
            } else {
              // Genuinely unknown tool — the native read/edit/write/grep/find/ls
              // tools are handled above. Stop rather than leave a dangling,
              // unresolved tool_call in the conversation.
              console.log('[pi-agent]', fnName, 'not supported inside mcp-resolver loop — stopping')
              _stoppedOnUnsupported = true
              break
            }

            mcpIterations++  // any executed tool call counts — gates the nudge/summary rescue below

            // Raw-to-disk artifact write — unconditional, FULL untruncated output,
            // for every resolved tool call. Best-effort: a disk-write failure must
            // never abort tool-call resolution. read_artifact can fetch this back.
            const _rawResult = String(toolResult)
            const _artifactId = String(toolCall.id || '').replace(/[^A-Za-z0-9_-]/g, '_')
            try {
              mkdirSync(ARTIFACT_DIR, { recursive: true })
              writeFileSync(join(ARTIFACT_DIR, `${_artifactId}.txt`), _rawResult)
              console.log('[pi-agent] tool artifact written:', _artifactId)
            } catch (e) {
              console.warn('[pi-agent] tool artifact write failed:', _artifactId, e.message)
            }

            // Safety cap on what enters context — the FULL output is already on
            // disk above, so head-truncate the in-memory copy and point the model
            // at read_artifact for the rest. Applied BEFORE _maybeCompact so both
            // the exact path and the summarizer input are bounded equally.
            let _forCompact = _rawResult
            _forCompact = truncateWithNotice(
              _forCompact,
              TOOL_RESULT_MAX_CHARS,
              `\n…[truncated, ${_rawResult.length} total chars — full output saved as artifact "${_artifactId}", use read_artifact({artifact_id:"${_artifactId}"}) if you need the rest]`,
            )

            const injected = await _maybeCompact(_forCompact, { exact, reason })
            const _toolMsg = { role: 'tool', tool_call_id: toolCall.id, content: injected }
            toolMessages.push(_toolMsg)
            if (exact === true && injected.length >= MIN_CHARS) {
              _exactOnceTracked.set(toolCall.id, { msg: _toolMsg, reason, roundTripCreated: _roundTrip })
            }
            }  // end for (toolCall of toolCalls)

            if (_stoppedOnUnsupported) break
            currentMessages = [...currentMessages, ...toolMessages]

            const followupBody = { ...origBody, messages: currentMessages }
            delete followupBody.stream
            delete followupBody.stream_options  // invalid without stream — strict endpoints 400
            delete followupBody.tool_choice  // let model decide: more tool calls or final text

            // Inert cache-frontier observability: log how much of the message
            // history is stable (not awaiting exact-result collapse). Does not
            // alter currentMessages, the request body, or control flow.
            const frontierIdx = cacheFrontierIndex(currentMessages, _exactOnceTracked.keys(), _argCollapseTracked.keys(), [..._contentCollapseTracked.values()].map(e => e.msg))
            console.log('[pi-agent] cache frontier:', frontierIdx, 'of', currentMessages.length, 'messages stable')

            console.log('[pi-agent] making follow-up call with', toolLabel, 'result injected')
            const followupResp = await _origFetch(cleanUrl + sep + '_skip_resolver=1', _chainedOpts(followupBody), ...rest)
            const followupText = await followupResp.text()
            const followupData = JSON.parse(followupText)
            _addUsage(followupData.usage)
            currentChoice = followupData?.choices?.[0]
            if (!currentChoice) {
              console.log('[pi-agent] follow-up returned no choices — status:', followupResp.status, 'body:', followupText.slice(0, 300))
            }
            if (currentChoice?.message) {
              currentMessages = [...currentMessages, currentChoice.message]
              trackLargeToolCallArgs(currentChoice.message, _roundTrip, _argCollapseTracked, ARG_COLLAPSE_MIN_CHARS)
              _trackContent(currentChoice.message)
            }
          }
        }

        await _runMcpToolLoop()

        // The model frequently announces an intent ("Cloning all three.") or a
        // status update ("Searching for project repos.") instead of either acting
        // on it or producing the required JSON output — a plain re-prompt under
        // the same conditions just repeats the stall. Quoting the model's own
        // stalled text back and demanding the next concrete step reliably breaks
        // it, so nudge (bounded) before falling back to a synthesized answer.
        let finalText = currentChoice?.message?.content || ''
        // Accept fenced output too — kimi reliably wraps the final object in
        // ```json fences, and nudging it about that just re-emits the same
        // fenced JSON (two wasted LLM calls per run; backend extraction
        // handles fences fine).
        let _nudges = 0
        // If _runMcpToolLoop stopped on an unsupported tool call (edit/write/read/...),
        // currentChoice still has an unresolved tool_call — appending a plain 'user'
        // message on top of that would produce an invalid conversation. Only nudge
        // when the conversation is in a clean, resolved state.
        while (
          mcpIterations > 0 &&
          currentChoice?.finish_reason !== 'tool_calls' &&
          !looksLikeFinalJson(finalText) &&
          _nudges < 2
        ) {
          _nudges++
          console.log('[pi-agent] response is not final JSON (nudge', _nudges, 'of 2):', JSON.stringify(finalText.slice(0, 200)))
          currentMessages = [
            ...currentMessages,
            {
              role: 'user',
              content: finalText
                ? `You just responded: "${finalText.slice(0, 300)}" — that is neither a tool call nor the final JSON output. If there is still a concrete action to take (e.g. clone a repo, run a check), call the appropriate tool now. Otherwise respond with ONLY the required JSON object now.`
                : 'You have not produced any output yet. If there is still a concrete action to take, call the appropriate tool now. Otherwise respond with ONLY the required JSON object now, using whatever you have already found.',
            },
          ]
          const nudgeBody = { ...origBody, messages: currentMessages }
          delete nudgeBody.stream
          delete nudgeBody.stream_options  // invalid without stream — strict endpoints 400
          delete nudgeBody.tool_choice  // let the model choose: act, or finish with JSON
          const nudgeResp = await _origFetch(cleanUrl + sep + '_skip_resolver=1', _chainedOpts(nudgeBody), ...rest)
          const nudgeText = await nudgeResp.text()
          const nudgeData = JSON.parse(nudgeText)
          _addUsage(nudgeData.usage)
          currentChoice = nudgeData?.choices?.[0]
          if (!currentChoice) {
            console.log('[pi-agent] nudge returned no choices — status:', nudgeResp.status, 'body:', nudgeText.slice(0, 300))
          }
          if (currentChoice?.message) {
            currentMessages = [...currentMessages, currentChoice.message]
            trackLargeToolCallArgs(currentChoice.message, _roundTrip, _argCollapseTracked, ARG_COLLAPSE_MIN_CHARS)
            _trackContent(currentChoice.message)
          }

          await _runMcpToolLoop()  // no-op unless the nudge produced a tool call
          finalText = currentChoice?.message?.content || ''
        }

        // Still nothing usable after nudging — force one text-only call, then
        // synthesize a fallback if even that comes back empty (kimi-k2 can
        // collapse to '' when the underlying MCP results were empty/negative).
        if (!finalText && mcpIterations > 0) {
          console.log('[pi-agent] no text in final response — forcing text summary with tool_choice=none')
          const summaryBody = { ...origBody, messages: currentMessages }
          delete summaryBody.stream
          delete summaryBody.stream_options  // invalid without stream — strict endpoints 400
          summaryBody.tool_choice = 'none'
          const summaryResp = await _origFetch(cleanUrl + sep + '_skip_resolver=1', _chainedOpts(summaryBody), ...rest)
          const summaryData = JSON.parse(await summaryResp.text())
          _addUsage(summaryData.usage)
          finalText = summaryData?.choices?.[0]?.message?.content || ''
          console.log('[pi-agent] forced summary length:', finalText.length)

          if (!finalText) {
            const lastToolMsg = [...currentMessages].reverse().find(m => m.role === 'tool')
            finalText = lastToolMsg
              ? `No summary text was generated. Last tool result: ${String(lastToolMsg.content).slice(0, 500)}`
              : 'Agent completed without producing a text summary.'
            console.log('[pi-agent] forced summary was empty — using synthesized fallback')
          }
        }
        console.log('[pi-agent] accumulated usage across resolver calls:', JSON.stringify(_usageAcc))
        const streamChunk = `data: ${JSON.stringify({ choices: [{ delta: { content: finalText }, finish_reason: 'stop' }], usage: _usageAcc })}\n\ndata: [DONE]\n\n`
        return new Response(streamChunk, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      } catch (e) {
        // Previously this just logged and fell through to `return response`
        // below — but `response` here is the ORIGINAL request's Response,
        // whose body was already drained by `response.text()` above. The SDK
        // would read an empty/consumed body, see no content and no usage,
        // and the run would silently "succeed" with an empty result and
        // zero reported tokens — hiding both the real failure and the real
        // (non-zero) cost already accumulated in _usageAcc up to this point.
        // Surface the failure honestly instead: synthesize a completion
        // whose content names the actual error, carrying whatever usage was
        // accumulated before the abort, so the caller sees a diagnosable
        // failure with accurate token accounting rather than "(no output)".
        console.warn('[pi-agent] mcp resolver error:', e.message)
        const errorText = `[mcp-resolver error: ${e.message}]`
        const streamChunk = `data: ${JSON.stringify({ choices: [{ delta: { content: errorText }, finish_reason: 'stop' }], usage: _usageAcc })}\n\ndata: [DONE]\n\n`
        return new Response(streamChunk, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    }

    return response
  }

  let aborted = false
  let lastText = ''
  let unsubscribe = () => {}
  let session

  try {
    // ── Configure MCP before session (settings.json always, mcp.json when servers present) ──
    const agentDir = process.env.PI_CODING_AGENT_DIR || '/root/.pi/agent'
    // Pre-warm MCP tool cache so pi-mcp-adapter proxy mode has tool descriptions
    // available immediately (without requiring a restart cycle on first run).
    await prewarmMcpCache(agentDir, Array.isArray(mcp_servers) ? mcp_servers : [])

    // Build mcp tool schema from pre-warmed cache for injection into API calls
    try {
      const cachePath = join(agentDir, 'mcp-cache.json')
      // Run when there is a warmed mcp cache OR when graphify is enabled — the
      // latter must not depend on the backend sending any mcp_servers config.
      if (existsSync(cachePath) || toolEnabled('graphify')) {
        const cache = existsSync(cachePath)
          ? JSON.parse(readFileSync(cachePath, 'utf-8'))
          : { servers: {} }
        const toolLines = Object.entries(cache.servers || {})
          .flatMap(([server, data]) => (data.tools || []).map(t => `${server}: ${t.name}`))
        if (toolEnabled('graphify')) {
          toolLines.push('graphify: graphify_query', 'graphify: graphify_explain', 'graphify: graphify_path')
        }
        const desc = toolLines.length > 0
          ? `MCP gateway to call external tools. Available tools:\n${toolLines.slice(0, 60).join('\n')}\n\nUsage: ${buildMcpUsageExample(toolLines)}`
          : 'MCP gateway for calling external tools via mcp({tool, args, reason})'
        _mcpToolSchema = {
          type: 'function',
          function: {
            name: 'mcp',
            description: desc,
            parameters: {
              type: 'object',
              properties: {
                tool: {
                  type: 'string',
                  description: toolLines.length > 0
                    ? `Tool name to call (e.g. ${toolLines[0].slice(toolLines[0].indexOf(': ') + 2)})`
                    : 'Tool name to call',
                },
                args: { type: 'string', description: 'Tool arguments as JSON string' },
                server: { type: 'string', description: 'Optional: filter to specific server' },
                search: { type: 'string', description: 'Search available tools by name' },
                describe: { type: 'string', description: 'Describe a specific tool and its parameters' },
                reason: { type: 'string', description: 'Why you need this tool call / what you are looking for' },
                exact: { type: 'boolean', description: 'true = keep verbatim, only when exact line numbers/content/error text needed; default false = summarize' },
              },
              required: ['tool', 'reason'],
            },
          },
        }
        console.log('[pi-agent] mcp tool schema built with', toolLines.length, 'available tools')
      }
    } catch (e) {
      console.warn('[pi-agent] mcp schema build failed:', e.message)
    }

    await setupMcp(agentDir, Array.isArray(mcp_servers) ? mcp_servers : [], _mcpHttpServers)

    // Ensure /workspace exists — session cwd and bash commands require it
    mkdirSync('/workspace', { recursive: true })

    // ── Create the in-process agent session ──────────────────────────────
    const created = await createAgentSession({
      cwd: '/workspace',
      authStorage,
      agentDir,
      modelRegistry,
      model,
    })
    session = created.session

    // Abort hook
    setAbort(async () => {
      aborted = true
      try { await session.abort() } catch { /* already finished */ }
    })

    // ── Bridge extension UI (approvals/clarifications) to the backend ─────
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: makeUIContext(client),
    })

    // Activate MCP tools — poll until mcp-atlassian and other MCP servers have
    // registered their tools (connection + tool listing is async after bindExtensions).
    // Uses _refreshToolRegistry() to re-scan the registry, then activates everything.
    const _activateAllTools = () => {
      try {
        if (typeof session._refreshToolRegistry === 'function') {
          session._refreshToolRegistry()
        }
        if (typeof session.getAllTools === 'function' && typeof session.setActiveToolsByName === 'function') {
          const allTools = session.getAllTools()
          const allNames = allTools.map(t => t.name)
          session.setActiveToolsByName(allNames)
          const builtins = new Set(['read', 'bash', 'edit', 'write'])
          const mcpTools = allNames.filter(n => !builtins.has(n))
          console.log('[pi-agent] activated tools total:', allNames.length, '| MCP:', mcpTools.join(', ') || '(none yet)')
          return allNames.length
        }
      } catch (e) {
        console.warn('[pi-agent] tool activation error:', e.message)
      }
      return 0
    }

    // Initial activation immediately after bindExtensions
    const initialCount = _activateAllTools()

    // Poll for up to 15s for async MCP servers (mcp-atlassian, github) to finish connecting
    // and registering their tools, then re-activate to include them.
    let pollCount = 0
    const _pollInterval = setInterval(() => {
      pollCount++
      const count = _activateAllTools()
      if (count > initialCount || pollCount >= 15) {
        clearInterval(_pollInterval)
        if (count > initialCount) {
          console.log('[pi-agent] MCP tools fully loaded after', pollCount, 's')
        } else {
          console.log('[pi-agent] MCP tool polling done (no new tools after 15s)')
        }
      }
    }, 1000)

    // ── Subscribe to agent events (SYNCHRONOUS listener) ─────────────────
    unsubscribe = session.subscribe((event) => {
      if (aborted) return
      switch (event.type) {
        case 'turn_end': {
          Promise.resolve(client.sendProgress('__mcp_clear__:')).catch((err) =>
            console.error('[pi-agent] sendProgress(mcp_clear):', err))
          const text = extractText(event.message)
          if (text.trim()) {
            lastText = text
            Promise.resolve(client.sendProgress(text)).catch((err) =>
              console.error('[pi-agent] sendProgress(turn_end):', err))
          }
          break
        }
        case 'tool_execution_start': {
          const full = event.toolName || 'tool'
          const idx = full.indexOf('_')
          const server = idx > 0 ? full.slice(0, idx) : null
          const tool = idx > 0 ? full.slice(idx + 1) : full
          const human = formatToolStartMessage(event)
          Promise.resolve(client.sendProgress(human)).catch((err) =>
            console.error('[pi-agent] sendProgress(tool):', err))
          if (server) {
            Promise.resolve(client.sendProgress(`__mcp_start__:${JSON.stringify({ server, tool })}`)).catch((err) =>
              console.error('[pi-agent] sendProgress(mcp_start):', err))
          } else if (tool === 'bash') {
            const cmd = (event.args && event.args.command) || ''
            for (const t of matchToolsFromCommand(cmd)) {
              Promise.resolve(client.sendProgress(`__tool_start__:${JSON.stringify({ tool: t })}`)).catch((err) =>
                console.error('[pi-agent] sendProgress(tool_start):', err))
            }
          }
          break
        }
        case 'tool_execution_end': {
          const human = formatToolEndMessage(event)
          Promise.resolve(client.sendProgress(human)).catch((err) =>
            console.error('[pi-agent] sendProgress(tool_end):', err))
          const _endCmd = (event.args && event.args.command) || ''
          for (const t of matchToolsFromCommand(_endCmd)) {
            Promise.resolve(client.sendProgress(`__tool_end__:${JSON.stringify({ tool: t })}`)).catch((err) =>
              console.error('[pi-agent] sendProgress(tool_end):', err))
          }
          break
        }
      }
    })

    // ── Build prompt ─────────────────────────────────────────────────────
    const prompt = buildPrompt(system_prompt, input)

    const extra = agent_config.extra || {}
    const WORKSPACE_DIR = '/workspace'
    downloadWorkspace(extra, WORKSPACE_DIR)
    if (toolEnabled('graphify')) await _freshenGraphifyGraphs(WORKSPACE_DIR)

    client.sendProgress('Initialising pi coding agent…')
    await session.prompt(prompt)

    if (aborted) {
      client.sendOutput({ result: '(aborted)' })
      return
    }

    // ── Token usage ───────────────────────────────────────────────────────
    let tokenUsage = {}
    try {
      const stats = session.getSessionStats()
      tokenUsage = {
        input_tokens: stats.tokens?.input,
        output_tokens: stats.tokens?.output,
        total_tokens: stats.tokens?.total,
      }
      client.sendProgress(`__token__:${JSON.stringify(tokenUsage)}`)
    } catch (err) {
      console.error('[pi-agent] getSessionStats:', err)
    }

    // ── Final result ──────────────────────────────────────────────────────
    let result = lastText
    try {
      const r = session.getLastAssistantText()
      if (r) result = r
    } catch (err) {
      console.error('[pi-agent] getLastAssistantText:', err)
    }

    const wsPath = uploadWorkspace(extra, WORKSPACE_DIR)
    const output = { result: result || '(no output)', token_usage: tokenUsage }
    if (wsPath) output.workspace_s3_path = wsPath
    // Post-compact meta-LLM usage, tracked separately from the agent's own
    // token_usage above. NOTE: this only covers the mcp-resolver loop's own
    // _maybeCompact calls — the SDK's native tool_result-hook compaction path
    // (pi-post-compact wired directly into createAgentSession, outside this
    // custom fetch interceptor) is not observable from here and remains
    // unmeasured (a known SDK limitation).
    if (_metaUsageAcc.total_tokens) output.meta_token_usage = _metaUsageAcc
    client.sendOutput(output)

  } catch (err) {
    console.error('[pi-agent] run failed:', err)
    try { client.sendOutput({ error: String(err) }) } catch { /* best effort */ }
    // setStatus may not exist on client — call defensively
    if (typeof client.setStatus === 'function') {
      try { client.setStatus('failed') } catch { /* best effort */ }
    }
  } finally {
    try { unsubscribe() } catch { /* ignore */ }
    if (session) {
      try { session.dispose() } catch (err) {
        console.error('[pi-agent] dispose:', err)
      }
    }
    try { globalThis.fetch = _origFetch } catch { /* ignore */ }
    for (const s of Object.values(_mcpHttpServers)) {
      try { s?.proc?.kill() } catch { /* ignore — process may already be dead */ }
    }
    _mcpHttpServers = {}
    for (const k of Object.keys(_mcpSessionIds)) delete _mcpSessionIds[k]
  }
}

/**
 * Resolve LLM model + auth from agent_config.
 *
 * Case 1 — extra.llm_base_url set: register a custom OpenAI-compatible
 *           provider and resolve the model from it.
 * Case 2 — model matches a built-in model id: set that provider's runtime
 *           API key and return the matched model.
 * Case 3 — fallback: set anthropic runtime key, let createAgentSession
 *           auto-select (model = undefined).
 */
function resolveModelConfig(agent_config = {}) {
  const { model: modelStr, credentials = {}, extra = {} } = agent_config
  const keyEnvName = extra.llm_api_key_env || 'ANTHROPIC_API_KEY'
  const apiKey = credentials[keyEnvName]

  const authStorage = AuthStorage.inMemory({})
  const modelRegistry = ModelRegistry.inMemory(authStorage)

  // Case 1: custom OpenAI-compatible endpoint
  if (extra.llm_base_url && modelStr) {
    modelRegistry.registerProvider('custom-llm', {
      baseUrl: extra.llm_base_url,
      apiKey: apiKey || '',
      api: 'openai-completions',
      models: [{
        id: modelStr,
        name: modelStr,
        api: 'openai-completions',  // POST /v1/chat/completions — supports tool calling via OpenRouter
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      }],
    })
    const model = modelRegistry.find('custom-llm', modelStr)
    if (model) return { authStorage, modelRegistry, model }
  }

  // Case 2: model matches a built-in model id
  if (modelStr) {
    const match = modelRegistry.getAll().find((m) => m.id === modelStr)
    if (match) {
      if (apiKey) authStorage.setRuntimeApiKey(match.provider, apiKey)
      return { authStorage, modelRegistry, model: match }
    }
  }

  // Case 3: fallback — anthropic auto-select
  if (apiKey) authStorage.setRuntimeApiKey('anthropic', apiKey)
  return { authStorage, modelRegistry, model: undefined }
}

/**
 * Write pi settings + MCP config to agentDir BEFORE createAgentSession.
 * settings.json always written so pi-mcp-adapter extension is registered.
 * mcp.json written only when servers are present.
 */
async function setupMcp(agentDir, mcpServers, mcpHttpServers = {}) {
  mkdirSync(agentDir, { recursive: true })

  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: ['pi-mcp-adapter', 'pi-post-compact'] }, null, 2),
  )

  // semble is no longer hardcoded here — the backend sends it as a regular
  // stdio entry in mcpServers when the agent's MCP addon enables it, and the
  // generic loop below handles it like any other server.
  const servers = {}
  for (const s of mcpServers) {
    if (!s || !s.name) continue
    if (mcpHttpServers[s.name]) {
      // Use the pre-started HTTP server — pi-mcp-adapter connects instantly
      servers[s.name] = { url: mcpHttpServers[s.name].url }
      console.log(`[pi-agent] setupMcp: ${s.name} → HTTP ${mcpHttpServers[s.name].url}`)
    } else if (s.url) {
      servers[s.name] = {
        url: s.url,
        ...(s.api_key ? { bearerToken: s.api_key } : {}),
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      }
    } else if (Array.isArray(s.command) && s.command.length) {
      servers[s.name] = {
        command: s.command[0],
        args: s.command.slice(1),
        env: { ...process.env, ...(s.env || {}) },
      }
    }
    // skip malformed entries (no url, no command)
  }

  writeFileSync(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: servers }, null, 2),
  )

  // Diagnostic: log what was written to mcp.json (omit full process.env dump)
  const loggable = Object.fromEntries(
    Object.entries(servers).map(([name, cfg]) => [
      name,
      {
        command: cfg.command,
        args: cfg.args,
        url: cfg.url,
        env_keys: Object.keys(cfg.env || {}).filter(k =>
          k.startsWith('JIRA') || k.startsWith('GITHUB') || k.startsWith('CONFLUENCE') ||
          k === 'PATH' || k === 'HOME' || k === 'USER'
        ),
        jira_url_present: 'JIRA_URL' in (cfg.env || {}),
        jira_username_present: 'JIRA_USERNAME' in (cfg.env || {}),
        jira_token_present: 'JIRA_API_TOKEN' in (cfg.env || {}),
      }
    ])
  )
  console.log('[pi-agent] mcp.json written:', JSON.stringify(loggable))
}

function makeUIContext(client) {
  return {
    async confirm(title, message, _opts) {
      const question = [title, message].filter(Boolean).join('\n')
      const answer = await client.askQuestion(question, ['yes', 'no'])
      if (answer == null) return true  // default: allow (non-interactive)
      return /^y/i.test(answer)
    },
    async input(title, _placeholder, _opts) {
      const answer = await client.askQuestion(title, null)
      return answer ?? undefined
    },
    async select(title, options, _opts) {
      const answer = await client.askQuestion(title, options)
      return answer ?? undefined
    },
    async editor(title, _prefill) {
      const answer = await client.askQuestion(title, null)
      return answer ?? undefined
    },
    notify(message, type) {
      Promise.resolve(client.sendProgress(`[${type ?? 'info'}] ${message}`))
        .catch((err) => console.error('[pi-agent] notify:', err))
    },
    // Sync no-op stubs — fill in all methods present in ExtensionUIContext interface
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
    get theme() { return undefined },
    getAllThemes() { return [] },
    getTheme() { return undefined },
    setTheme() { return { success: false, error: 'Theme switching not supported' } },
    getToolsExpanded() { return false },
    setToolsExpanded() {},
  }
}

/**
 * Pre-warm the pi-mcp-adapter metadata cache by connecting to each stdio MCP
 * server via the MCP JSON-RPC protocol, listing its tools, and writing
 * mcp-cache.json so pi-mcp-adapter proxy mode can inject compact tool
 * descriptions into the system prompt on first run (no restart needed).
 * Skipped if cache already exists (warm pod reuse). Errors are non-fatal.
 */
async function prewarmMcpCache(agentDir, mcpServers) {
  const cachePath = join(agentDir, 'mcp-cache.json')

  // Load any existing cache instead of early-returning — warm-pod reuse means a
  // prior run's cache may hold servers that are no longer configured (e.g. a
  // now-disabled MCP), so we reconcile it against the current server set.
  let cache = { version: 1, servers: {} }
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (parsed && typeof parsed.servers === 'object' && parsed.servers) {
        cache = { version: parsed.version || 1, servers: parsed.servers }
      }
    } catch (e) {
      console.warn(`[pi-agent] mcp-cache.json unreadable, rebuilding: ${e.message}`)
    }
  }

  // Current stdio servers (url servers have no subprocess to warm).
  const stdioServers = (Array.isArray(mcpServers) ? mcpServers : []).filter(
    s => s && s.name && !s.url && Array.isArray(s.command) && s.command.length
  )
  const currentNames = new Set(stdioServers.map(s => s.name))

  // Prune cache entries that are no longer in the current stdio server set.
  for (const name of Object.keys(cache.servers)) {
    if (!currentNames.has(name)) {
      delete cache.servers[name]
      console.log(`[pi-agent] pruned stale MCP cache entry: ${name}`)
    }
  }

  // Pre-warm only servers missing from the cache.
  for (const s of stdioServers) {
    if (cache.servers[s.name]) {
      console.log(`[pi-agent] MCP cache hit, skipping pre-warm: ${s.name}`)
      continue
    }
    console.log(`[pi-agent] pre-warming MCP cache for: ${s.name}`)
    try {
      const tools = await _listMcpTools(
        s.command[0],
        s.command.slice(1),
        { ...process.env, ...(s.env || {}) },
      )
      if (tools.length > 0) {
        cache.servers[s.name] = {
          tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          cachedAt: Date.now(),
        }
        console.log(`[pi-agent] pre-warmed ${s.name}: ${tools.length} tools`)
      }
    } catch (e) {
      console.warn(`[pi-agent] pre-warm failed for ${s.name}:`, e.message)
    }
  }

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache, null, 2))
  console.log('[pi-agent] mcp-cache.json written:', Object.keys(cache.servers).join(', ') || '(empty)')
}

/**
 * Spawn an MCP server subprocess and retrieve its tool list via JSON-RPC
 * (initialize + tools/list). Uses proper line-buffered stdout parsing.
 */
function _listMcpTools(command, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`MCP tools/list timed out after 30s for: ${command}`))
    }, 30000)

    let lineBuf = ''
    let initialized = false
    let resolved = false

    const finish = (tools) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { proc.kill() } catch { /* already exited */ }
      resolve(tools)
    }

    // Send MCP initialize request
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'warmup', version: '1.0' },
      },
    }) + '\n')

    proc.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString()
      let nl
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim()
        lineBuf = lineBuf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && !initialized) {
            initialized = true
            // Send tools/list after successful initialize
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
          } else if (msg.id === 2) {
            finish(msg.result?.tools ?? [])
          }
        } catch { /* partial line or non-JSON output */ }
      }
    })

    proc.on('error', (e) => { clearTimeout(timer); if (!resolved) reject(e) })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (!resolved) reject(new Error(`MCP server exited (code ${code}) before tools/list response`))
    })
  })
}

// MCP session ID cache — streamable-http requires initialize before tool calls
const _mcpSessionIds = {}

async function _mcpPost(url, body, sessionId) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const resp = await _origFetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await resp.text()
  const newSessionId = resp.headers?.get?.('mcp-session-id')
  let data
  try { data = JSON.parse(text) } catch {
    const lines = text.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    const last = lines[lines.length - 1]?.slice(6)
    try { data = JSON.parse(last || '{}') } catch { return { raw: text, newSessionId } }
  }
  return { data, newSessionId }
}

async function _ensureMcpSession(serverUrl) {
  if (_mcpSessionIds[serverUrl]) return _mcpSessionIds[serverUrl]
  const { data, newSessionId } = await _mcpPost(serverUrl, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pi-agent', version: '1.0' } },
  }, null)
  const sessionId = newSessionId || data?.result?.sessionId || null
  if (sessionId) {
    _mcpSessionIds[serverUrl] = sessionId
    console.log('[pi-agent] MCP session initialized:', sessionId.slice(0, 20))
  }
  return sessionId
}

/**
 * Run the stdio-only semble CLI directly for the MCP-style "search" /
 * "find_related" tool calls, translating the parsed tool args into the
 * equivalent CLI invocation and returning stdout as the tool-result string.
 *   search        → semble search "<query>" <repo> [--top-k N]
 *   find_related  → semble find-related <file_path> <line> <repo>
 */
function _runSembleCli(toolName, toolArgs) {
  const repo = toolArgs.repo || toolArgs.path || '.'
  let args
  if (toolName === 'search') {
    if (!toolArgs.query) return Promise.resolve('Error: semble search requires a "query" arg')
    args = ['search', String(toolArgs.query), String(repo)]
    if (toolArgs.top_k != null) args.push('--top-k', String(toolArgs.top_k))
  } else {
    // find_related / find-related
    if (!toolArgs.file_path || toolArgs.line == null) {
      return Promise.resolve('Error: semble find-related requires "file_path" and "line" args')
    }
    args = ['find-related', String(toolArgs.file_path), String(toolArgs.line), String(repo)]
  }

  return new Promise((resolve) => {
    let out = '', err = '', done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const proc = spawn('semble', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* already exited */ }; finish(`Error: semble ${args[0]} timed out after 60s`) }, 60000)
    proc.stdout?.on('data', d => { out += d.toString() })
    proc.stderr?.on('data', d => { err += d.toString() })
    proc.on('error', e => finish(`Error running semble: ${e.message}`))
    proc.on('exit', code => {
      if (code === 0) finish(out.trim() || '(no output)')
      else finish(`Error: semble ${args[0]} exited (code ${code})\n${(err || out).trim().slice(0, 2000)}`)
    })
  })
}

// Shell out to the graphify CLI, mirroring _runSembleCli's contract (string
// return, 60s timeout). Requires an existing graphify-out/graph.json in the
// target repo; we never bootstrap a new graph (that needs an LLM backend).
async function _runGraphifyCli(toolName, toolArgs) {
  const built = buildGraphifyCliArgs(toolName, toolArgs)
  if (built.error) return built.error
  const { repo, cliArgs } = built
  const graphPath = join(repo, 'graphify-out', 'graph.json')
  if (!existsSync(graphPath)) {
    return `Error: no graphify graph at ${graphPath} — graphify unavailable for this repo`
  }
  return new Promise((resolve) => {
    let out = '', err = '', done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const proc = spawn('graphify', cliArgs, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* already exited */ }; finish(`Error: graphify ${cliArgs[0]} timed out after 60s`) }, 60000)
    proc.stdout?.on('data', d => { out += d.toString() })
    proc.stderr?.on('data', d => { err += d.toString() })
    proc.on('error', e => finish(`Error running graphify: ${e.message}`))
    proc.on('exit', code => {
      if (code === 0) finish(out.trim() || '(no output)')
      else finish(`Error: graphify ${cliArgs[0]} exited (code ${code})\n${(err || out).trim().slice(0, 2000)}`)
    })
  })
}

// After the workspace is restored, refresh any pre-existing per-repo graphify
// graph (AST-only `graphify update`, no LLM). Best-effort: never throws, never
// blocks the run — missing graphs are skipped, failures are logged and ignored.
async function _freshenGraphifyGraphs(workspaceDir) {
  let entries
  try {
    entries = readdirSync(workspaceDir, { withFileTypes: true })
  } catch (e) {
    console.warn('[pi-agent] graphify freshen: could not read workspace dir:', e.message)
    return
  }
  const dirs = entries.filter(e => e.isDirectory()).map(e => join(workspaceDir, e.name))
  await Promise.allSettled(dirs.map((dir) => new Promise((resolve) => {
    const graphPath = join(dir, 'graphify-out', 'graph.json')
    if (!existsSync(graphPath)) return resolve()
    let done = false
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const proc = spawn('graphify', ['update', '.'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* already exited */ }; console.warn(`[pi-agent] graphify update timed out for ${dir}`); finish() }, 120000)
    let err = ''
    proc.stderr?.on('data', d => { err += d.toString() })
    proc.on('error', e => { console.warn(`[pi-agent] graphify update failed for ${dir}:`, e.message); finish() })
    proc.on('exit', code => { if (code !== 0) console.warn(`[pi-agent] graphify update exited (code ${code}) for ${dir}: ${err.trim().slice(0, 500)}`); finish() })
  })))
}

/**
 * Execute an MCP tool against the pre-started HTTP MCP server.
 * mcpArgs: { tool, args (JSON string), server, search, describe }
 */
async function _executeMcpTool(mcpArgs) {
  if (mcpArgs.search) {
    return `Search not supported in direct mode. Available servers: ${Object.keys(_mcpHttpServers).join(', ')}`
  }
  if (mcpArgs.describe) {
    return `Use tool directly via mcp({tool:"${mcpArgs.describe}", args:"{}"})`
  }

  const toolName = mcpArgs.tool
  if (!toolName) return 'Error: no tool name. Use mcp({tool:"<tool-name>", args:"{...}"}) with one of the tools listed in the mcp tool description.'

  let toolArgs = {}
  if (mcpArgs.args) {
    try { toolArgs = JSON.parse(mcpArgs.args) } catch (e) {
      return `Error: invalid args JSON: ${mcpArgs.args} — ${e.message}`
    }
  }

  // semble's MCP server is stdio-only (its CLI rejects --transport/--port) so it
  // is never pre-started as an HTTP server. When the resolver loop routes a
  // semble tool call through here, there is no HTTP endpoint to hit — shell out
  // to the semble CLI directly and return its stdout, matching the string-return
  // contract of the HTTP path below. Scoped to semble; all other servers unchanged.
  const isSembleCall = mcpArgs.server === 'semble' ||
    (!mcpArgs.server && (toolName === 'search' || toolName === 'find_related' || toolName === 'find-related'))
  if (isSembleCall) {
    return await _runSembleCli(toolName, toolArgs)
  }

  // graphify is likewise CLI-only here (no per-repo HTTP MCP mode); route its
  // calls to the CLI shim, matching the semble branch above.
  if (isGraphifyToolCall(mcpArgs.server, toolName)) {
    return await _runGraphifyCli(toolName, toolArgs)
  }

  const httpServer = Object.values(_mcpHttpServers)[0]
  if (!httpServer) return 'Error: no MCP HTTP server available'

  try {
    // streamable-http requires initialize → session ID before tool calls
    const sessionId = await _ensureMcpSession(httpServer.url)
    const { data, raw } = await _mcpPost(httpServer.url, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
    }, sessionId)
    if (raw) return raw.slice(0, 2000)
    if (data?.error) return `MCP error from ${toolName}: ${JSON.stringify(data.error)}`
    const content = data?.result?.content || []
    if (content.length > 0) return content.map(c => c.text || JSON.stringify(c)).join('\n')
    return JSON.stringify(data?.result || data)
  } catch (e) {
    return `Error calling ${toolName}: ${e.message}`
  }
}

const _execAsync = promisify(exec)

// The mcp-resolver loop below only knew how to execute the 'mcp' tool — if the
// model called 'bash' (e.g. to git clone a repo it just discovered) while
// still inside this loop, the call was silently dropped instead of run. This
// reimplements just enough of the SDK's native bash tool to unblock that path.
async function _executeBashTool(command) {
  if (!command) return 'Error: no command provided'
  try {
    const { stdout, stderr } = await _execAsync(command, {
      cwd: '/workspace',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
    return [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n') || '(no output)'
  } catch (e) {
    return `Error running command: ${e.message}\n${e.stdout || ''}${e.stderr || ''}`
  }
}

function tryParseJson(text) {
  if (!text) return null
  try { return JSON.parse(text.trim()) } catch { /* not pure JSON */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return JSON.parse(fence[1].trim()) } catch { /* invalid */ } }
  const match = text.match(/\{[\s\S]*"context_sufficient"[\s\S]*\}/)
  if (match) { try { return JSON.parse(match[0]) } catch { /* malformed */ } }
  return null
}

function extractText(message) {
  if (!message) return ''
  const c = message.content ?? message
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return ''
}
