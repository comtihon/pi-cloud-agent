#!/usr/bin/env node
// carrier-cli-tools — a tiny stdio MCP server exposing every `cli_tools`
// entry of the tools carrier granted, so the model can call them like any
// other MCP tool through pi-mcp-adapter.
//
// A CLI tool is a command template from carrier's AGENT_TOOLS registry:
//
//   cli_tools: { <tool_name>: { args: ["query", "{question}", "."],
//                               required: ["question"],
//                               optional: { depth: ["--depth", "{depth}"] },
//                               cwd: "{repo}", requires_files: [...],
//                               description, timeout_seconds } }
//
// Nothing about any specific tool is known here: the input schema is derived
// from the template's placeholders, and the argv from filling them in.
//
// Run:  node src/cli-tools-mcp.js --config <tools.json>
//       (tools.json = the registered tools array: [{name, command, cli_tools}])

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { JsonRpcConnection, RpcError, ERR_INVALID_PARAMS } from './acp/protocol.js'
import { buildCliInvocation, findCliTool } from './tools.js'

export const SERVER_NAME = 'carrier-cli-tools'
const DEFAULT_PROTOCOL = '2024-11-05'

/** Placeholder names (`{name}` / `{name|fallback}`) used anywhere in a template. */
function placeholders(values) {
  const names = new Set()
  for (const v of values) {
    for (const m of String(v).matchAll(/\{([^{}|]+)(?:\|[^{}]*)?\}/g)) names.add(m[1].trim())
  }
  return names
}

/** MCP tool descriptor for one CLI-tool template. */
export function cliToolDescriptor(tool, name, spec = {}) {
  const required = new Set(Array.isArray(spec.required) ? spec.required : [])
  const fromArgs = placeholders([
    ...(Array.isArray(spec.args) ? spec.args : []),
    ...(Array.isArray(spec.requires_files) ? spec.requires_files : []),
  ])
  const optional = spec.optional && typeof spec.optional === 'object' ? spec.optional : {}
  const cwdNames = spec.cwd ? placeholders([spec.cwd]) : new Set()
  // A templated cwd is mandatory: buildCliInvocation refuses to run without it.
  for (const n of cwdNames) required.add(n)

  const properties = {}
  for (const n of [...fromArgs, ...cwdNames, ...required]) {
    properties[n] = { type: 'string' }
  }
  for (const [n, fragment] of Object.entries(optional)) {
    properties[n] = { type: 'string', description: `optional (${[].concat(fragment).join(' ')})` }
    for (const p of placeholders([].concat(fragment))) if (!properties[p]) properties[p] = { type: 'string' }
  }
  for (const n of cwdNames) properties[n].description = 'directory to run in (e.g. a repo under the workspace)'

  const command = tool.command || tool.name
  return {
    name,
    description: spec.description || tool.description || `Runs \`${command} ${[].concat(spec.args || []).join(' ')}\``,
    inputSchema: {
      type: 'object',
      properties,
      required: [...required].filter((n) => properties[n]),
    },
  }
}

/** Every CLI tool of the registered tools, first definition of a name wins. */
export function listCliTools(tools) {
  const seen = new Set()
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    for (const [name, spec] of Object.entries(tool?.cli_tools || {})) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(cliToolDescriptor(tool, name, spec))
    }
  }
  return out
}

/**
 * Run one CLI tool call to completion. Resolves `{ text, isError }`; never
 * rejects. argv comes from the template, so no shell is involved.
 */
export function runCliTool(tool, toolName, spec, toolArgs, { env = process.env } = {}) {
  const built = buildCliInvocation(spec, toolArgs || {})
  if (built.error) return Promise.resolve({ text: `${built.error} (tool: ${toolName})`, isError: true })
  const { argv, cwd } = built
  const command = tool.command || tool.name
  const timeoutMs = (spec.timeout_seconds || 60) * 1000

  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (text, isError) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ text, isError })
    }
    let proc
    try {
      proc = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ text: `Error running ${command}: ${e.message}`, isError: true })
      return
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already exited */ }
      finish(`Error: ${command} ${argv[0] ?? ''} timed out after ${timeoutMs / 1000}s`, true)
    }, timeoutMs)
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('error', (e) => finish(`Error running ${command}: ${e.message}`, true))
    proc.on('close', (code) => {
      if (code === 0) finish(out.trim() || '(no output)', false)
      else finish(`Error: ${command} ${argv[0] ?? ''} exited (code ${code})\n${(err || out).trim().slice(0, 2000)}`, true)
    })
  })
}

/**
 * Wire the MCP methods onto a JSON-RPC connection.
 * `run` is injectable for tests; it defaults to spawning the real command.
 */
export function createCliToolsServer({ input, write, tools, run = runCliTool, version = '0.0.0' }) {
  const conn = new JsonRpcConnection({ input, write, log: (...a) => process.stderr.write(`[${SERVER_NAME}] ${a.join(' ')}\n`) })
  const descriptors = listCliTools(tools)

  conn.onRequest('initialize', (params) => ({
    protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version },
  }))
  conn.onNotification('notifications/initialized', () => {})
  conn.onNotification('notifications/cancelled', () => {})
  conn.onRequest('ping', () => ({}))
  conn.onRequest('tools/list', () => ({ tools: descriptors }))
  conn.onRequest('tools/call', async (params) => {
    const name = params?.name
    const found = name ? findCliTool(tools, null, name) : null
    if (!found) throw new RpcError(ERR_INVALID_PARAMS, `Unknown tool: ${name}`)
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    const { text, isError } = await run(found.tool, found.toolName, found.spec, args)
    return { content: [{ type: 'text', text }], isError }
  })
  return conn
}

function main() {
  const i = process.argv.indexOf('--config')
  const file = i > 0 ? process.argv[i + 1] : process.env.CARRIER_CLI_TOOLS_FILE
  let tools = []
  try {
    tools = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    process.stderr.write(`[${SERVER_NAME}] cannot read tools config ${file}: ${err.message}\n`)
  }
  createCliToolsServer({
    input: process.stdin,
    write: (line) => process.stdout.write(line),
    tools,
  }).start()
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
