// Generic tool plumbing.
//
// The agent knows nothing about any particular tool. The carrier sends, per
// run, the tools this agent was granted:
//
//   tools: [{ name, label, description, command, env: {K: V}, bash_match,
//             cli_tools: { <tool_name>: { args, required, optional, cwd,
//                                         requires_files, description } } }]
//   blocked_commands: ["<binary>", ...]
//
// A granted tool is *allowed*; whether it is *usable* depends on this image —
// `command`, when given, must exist on PATH. The agent registers the
// intersection and reports the rest as skipped. Credentials arrive already
// resolved in `env`, so no tool name, env var name or alias is hardcoded here.

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const DISABLED_BIN_DIR = '/tmp/disabled-bins'

/** True when `command` resolves on the current PATH. */
export function commandExists(command, { runWhich = defaultWhich } = {}) {
  if (!command) return true // nothing to check — an env-only tool is always usable
  try {
    return runWhich(command)
  } catch {
    return false
  }
}

function defaultWhich(command) {
  execFileSync('which', [command], { stdio: 'ignore' })
  return true
}

/**
 * Split granted tools into the ones this image can actually run and the ones
 * it cannot (missing binary). Pure — pass a `commandExists` stub in tests.
 */
export function registerTools(tools, { exists = commandExists } = {}) {
  const registered = []
  const skipped = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || !tool.name) continue
    // No command declared → nothing to look for; an env-only tool is usable
    // wherever it is granted.
    if (!tool.command || exists(tool.command)) registered.push(tool)
    else skipped.push(tool)
  }
  return { registered, skipped }
}

/**
 * Put every granted tool's env on process.env, after removing the keys the
 * previous run installed. Warm pods reuse the process, so a tool that was
 * revoked (or a secret that rotated) must not survive into the next run.
 * Returns the keys installed this time, to feed back on the next call.
 */
export function applyToolEnv(tools, previousKeys = [], env = process.env) {
  for (const key of previousKeys) delete env[key]
  const applied = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    for (const [key, value] of Object.entries(tool?.env || {})) {
      if (value == null) continue
      env[key] = String(value)
      applied.push(key)
    }
  }
  return applied
}

/**
 * Shadow each blocked command with an exit-127 stub on a PATH prefix, so a
 * binary the image ships but this agent was not granted cannot be run from
 * bash. Returns the PATH to use (unchanged when nothing is blocked).
 */
export function blockCommands(commands, { originalPath, binDir = DISABLED_BIN_DIR } = {}) {
  const list = (Array.isArray(commands) ? commands : []).filter(Boolean)
  if (list.length === 0) return originalPath
  mkdirSync(binDir, { recursive: true })
  for (const command of list) {
    const stub = join(binDir, command)
    writeFileSync(
      stub,
      `#!/bin/sh\necho "${command} is not enabled for this agent" >&2\nexit 127\n`,
      { mode: 0o755 },
    )
  }
  return `${binDir}:${originalPath}`
}

/** Fill `{name}` / `{name|fallback}` placeholders from the tool-call args. */
export function fillTemplate(template, args) {
  return String(template).replace(/\{([^{}]+)\}/g, (_m, expr) => {
    const [key, fallback = ''] = String(expr).split('|')
    const value = args?.[key.trim()]
    return value == null || value === '' ? fallback : String(value)
  })
}

/**
 * Build the argv and cwd for one CLI-backed tool call from its template.
 * Returns `{ error }` when a required argument is missing.
 */
export function buildCliInvocation(spec, args = {}) {
  const required = Array.isArray(spec?.required) ? spec.required : []
  const missing = required.filter((key) => args[key] == null || args[key] === '')
  if (missing.length > 0) {
    return { error: `Error: missing required arg(s): ${missing.join(', ')}` }
  }
  const argv = (Array.isArray(spec?.args) ? spec.args : []).map((part) => fillTemplate(part, args))
  for (const [argName, fragment] of Object.entries(spec?.optional || {})) {
    if (args[argName] == null || args[argName] === '') continue
    for (const part of fragment) argv.push(fillTemplate(part, args))
  }
  const cwd = spec?.cwd ? fillTemplate(spec.cwd, args) : undefined
  if (spec?.cwd && !cwd) {
    return { error: `Error: this tool requires a "${String(spec.cwd).replace(/[{}]/g, '')}" arg` }
  }
  const requiresFiles = Array.isArray(spec?.requires_files) ? spec.requires_files : []
  for (const relative of requiresFiles) {
    const path = cwd ? join(cwd, fillTemplate(relative, args)) : fillTemplate(relative, args)
    if (!existsSync(path)) {
      return { error: `Error: required file not found: ${path}` }
    }
  }
  return { argv, cwd }
}

/**
 * Find which registered tool serves an mcp() gateway call, by explicit
 * `server` name or by the tool name appearing in some tool's `cli_tools`.
 */
export function findCliTool(registered, server, toolName) {
  for (const tool of Array.isArray(registered) ? registered : []) {
    const cliTools = tool?.cli_tools || {}
    if (server && tool.name === server) {
      const spec = cliTools[toolName] || cliTools[`${tool.name}_${toolName}`]
      if (spec) return { tool, toolName: cliTools[toolName] ? toolName : `${tool.name}_${toolName}`, spec }
    }
    if (!server && cliTools[toolName]) {
      return { tool, toolName, spec: cliTools[toolName] }
    }
  }
  return null
}

/** `server: tool` lines for every CLI tool the registered set exposes. */
export function cliToolLines(registered) {
  const lines = []
  for (const tool of Array.isArray(registered) ? registered : []) {
    for (const name of Object.keys(tool?.cli_tools || {})) lines.push(`${tool.name}: ${name}`)
  }
  return lines
}

/**
 * Which granted tools a bash command exercises, using each tool's own
 * `bash_match` regex. Tools that declare none never match.
 */
export function matchToolsFromCommand(command, tools) {
  const cmd = typeof command === 'string' ? command : ''
  const matched = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool?.bash_match) continue
    try {
      if (new RegExp(tool.bash_match, 'i').test(cmd)) matched.push(tool.name)
    } catch {
      // A malformed regex in config must not break command handling.
    }
  }
  return matched
}

/**
 * Which MCP servers this run should pre-start as local HTTP proxies.
 *
 * Pre-starting a stdio server as HTTP is what makes pi-mcp-adapter connect
 * instantly instead of racing a 15-30s subprocess boot, but it only works when
 * the server's CLI accepts `--transport`/`--port`. The carrier marks the ones
 * whose CLI does not with `prestart_http: false`; those are left to be written
 * as plain stdio entries instead. A server that is already remote (has a
 * `url`) or declares no command has nothing to pre-start either.
 *
 * Pure, so the contract can be tested without spawning anything.
 */
export function selectPrestartServers(mcpServers) {
  return (Array.isArray(mcpServers) ? mcpServers : []).filter((s) => {
    if (!s || !s.name || s.url) return false
    if (!Array.isArray(s.command) || s.command.length === 0) return false
    // Absent means "hostable" — the carrier only sends `false` for the
    // exceptions, so a backend predating the flag keeps the old behaviour.
    return s.prestart_http !== false
  })
}

/**
 * Plan the workspace hooks to run for a restored workspace: one job per
 * (tool, repo) pair where the tool declares a `workspace_hook` and the repo
 * contains every one of its `requires_files`.
 *
 * A hook is for tools that keep a per-repo cache or index — it refreshes what
 * is already there and must never bootstrap, so a repo missing the marker files
 * is skipped rather than initialized. Pure: the caller does the spawning.
 */
export function planWorkspaceHooks(tools, dirs) {
  const jobs = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    const hook = tool?.workspace_hook
    if (!hook || !Array.isArray(hook.args) || hook.args.length === 0) continue
    const required = Array.isArray(hook.requires_files) ? hook.requires_files : []
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      if (required.some((rel) => !existsSync(join(dir, rel)))) continue
      jobs.push({
        tool: tool.name,
        command: tool.command || tool.name,
        args: hook.args,
        cwd: dir,
        timeoutMs: (hook.timeout_seconds || 120) * 1000,
      })
    }
  }
  return jobs
}
