// ACP `mcpServers` (+ carrier hints) → pi-mcp-adapter's mcp.json, and the
// pi settings.json that loads the extension packages.
//
// ACP shapes (already converted by carrier):
//   stdio     {name, command, args: [], env: [{name, value}]}
//   http/sse  {type: "http"|"sse", name, url, headers: [{name, value}]}
// pi-mcp-adapter shapes:
//   stdio     {command, args, env: {K: V}}
//   http      {url, headers?, auth?: "bearer", bearerToken?}   (SSE is the
//             adapter's automatic fallback for a url entry)
//
// carrier's own `mcp_servers` (in `_meta.carrier`) is consulted for one hint
// only: `prestart_http`. A stdio server whose carrier entry does not say
// `prestart_http: false` is started here as a local streamable-HTTP server
// before the session, so the adapter connects instantly instead of racing a
// 15-30 s subprocess boot.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectPrestartServers } from '../tools.js'
import { log } from '../log.js'

export const CLI_TOOLS_SERVER = 'carrier-cli-tools'
// `npm:` sources resolve to $PI_CODING_AGENT_DIR/npm/node_modules/<name> (baked
// into the image). A bare name would be read as a path relative to the agent
// dir and silently load nothing.
export const PI_PACKAGES = ['npm:pi-mcp-adapter', 'npm:pi-post-compact']
const CLI_TOOLS_SCRIPT = fileURLToPath(new URL('../cli-tools-mcp.js', import.meta.url))

/** [{name, value}] → {name: value} (also accepts an object as-is). */
export function pairsToObject(pairs) {
  if (!pairs) return {}
  if (!Array.isArray(pairs)) return typeof pairs === 'object' ? { ...pairs } : {}
  const out = {}
  for (const p of pairs) if (p && p.name) out[p.name] = p.value == null ? '' : String(p.value)
  return out
}

/** "stdio" | "http" | "sse" | null for one ACP McpServer. */
export function acpServerKind(s) {
  if (!s || !s.name) return null
  if (s.type === 'http' || s.type === 'sse') return s.url ? s.type : null
  if (s.url) return 'http'
  if (s.command) return 'stdio'
  return null
}

/**
 * Build pi-mcp-adapter's `{mcpServers}` from ACP servers.
 *
 * @param {object[]} acpServers
 * @param {object} [opts]
 * @param {Record<string,{url:string}>} [opts.prestarted] stdio servers already running as HTTP
 * @param {{command:string,args:string[]}|null} [opts.cliTools] the carrier-cli-tools server, if any
 * @param {object} [opts.baseEnv] env every stdio server starts from
 */
export function buildMcpConfig(acpServers, { prestarted = {}, cliTools = null, baseEnv = {} } = {}) {
  const servers = {}
  for (const s of Array.isArray(acpServers) ? acpServers : []) {
    const kind = acpServerKind(s)
    if (!kind) continue
    if (kind === 'stdio' && prestarted[s.name]) {
      servers[s.name] = { url: prestarted[s.name].url }
      continue
    }
    if (kind === 'stdio') {
      servers[s.name] = {
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: { ...baseEnv, ...pairsToObject(s.env) },
      }
      continue
    }
    const headers = pairsToObject(s.headers)
    const entry = { url: s.url }
    const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
    if (authKey) {
      const m = /^\s*bearer\s+(.+)$/i.exec(headers[authKey])
      if (m) {
        entry.auth = 'bearer'
        entry.bearerToken = m[1].trim()
        delete headers[authKey]
      }
    }
    if (Object.keys(headers).length) entry.headers = headers
    servers[s.name] = entry
  }
  if (cliTools) {
    servers[CLI_TOOLS_SERVER] = {
      command: cliTools.command,
      args: cliTools.args,
      env: { ...baseEnv },
    }
  }
  return { mcpServers: servers }
}

/**
 * Which ACP stdio servers to pre-start as HTTP: those whose carrier entry
 * (matched by name) exists and does not opt out with `prestart_http: false`.
 */
export function selectPrestart(acpServers, carrierServers) {
  const hostable = new Set(selectPrestartServers(carrierServers).map((s) => s.name))
  return (Array.isArray(acpServers) ? acpServers : []).filter(
    (s) => acpServerKind(s) === 'stdio' && hostable.has(s.name),
  )
}

/** The CLI-tools MCP server entry for the registered tools, or null. */
export async function writeCliToolsConfig(dir, registered) {
  const withCli = (Array.isArray(registered) ? registered : []).filter(
    (t) => t && t.cli_tools && Object.keys(t.cli_tools).length > 0,
  )
  if (withCli.length === 0) return null
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${CLI_TOOLS_SERVER}.json`)
  // Templates only — tool credentials reach the server through its env.
  const slim = withCli.map(({ name, command, description, cli_tools: cliTools }) => ({ name, command, description, cli_tools: cliTools }))
  await writeFile(file, JSON.stringify(slim, null, 2), { mode: 0o600 })
  return { command: process.execPath, args: [CLI_TOOLS_SCRIPT, '--config', file] }
}

/** Write settings.json (extension packages) and mcp.json into the pi agent dir. */
export async function writePiConfig(agentDir, mcpConfig, { packages = PI_PACKAGES } = {}) {
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages }, null, 2))
  // Holds stdio env (credentials) — owner-only.
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })
  const summary = Object.fromEntries(Object.entries(mcpConfig.mcpServers || {}).map(([n, c]) => [
    n, c.url ? { url: c.url, auth: c.auth || null } : { command: c.command, args: c.args, env_keys: Object.keys(c.env || {}).length },
  ]))
  log('mcp.json written:', summary)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1000, () => done(false))
  })
}

/** Poll until `port` accepts connections, the process dies, or time runs out. */
export async function waitForPort(port, { proc, timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) return false
    if (await canConnect(port)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * Start each stdio server as `<command> <args> --transport streamable-http
 * --port N` and wait for its port. A server that dies or never listens is
 * left out, so mcp.json falls back to the plain stdio entry for it.
 * Resolves `{name: {proc, port, url}}`.
 */
export async function prestartServers(servers, { baseEnv = process.env, timeoutMs = 30_000 } = {}) {
  const started = {}
  await Promise.all(servers.map(async (s) => {
    let port
    try { port = await freePort() } catch (err) {
      log(`prestart ${s.name}: no free port:`, err.message)
      return
    }
    const args = [...(s.args || []).map(String), '--transport', 'streamable-http', '--port', String(port)]
    let proc
    try {
      proc = spawn(s.command, args, {
        env: { ...baseEnv, ...pairsToObject(s.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      log(`prestart ${s.name} failed:`, err.message)
      return
    }
    proc.on('error', (err) => log(`prestart ${s.name} error:`, err.message))
    proc.stdout.on('data', (d) => log(`[${s.name}]`, String(d).trim().slice(0, 300)))
    proc.stderr.on('data', (d) => log(`[${s.name}:err]`, String(d).trim().slice(0, 300)))
    const t0 = Date.now()
    if (await waitForPort(port, { proc, timeoutMs })) {
      log(`prestarted ${s.name} as HTTP on :${port} in ${Date.now() - t0}ms`)
      started[s.name] = { proc, port, url: `http://127.0.0.1:${port}/mcp` }
    } else {
      log(`prestart ${s.name} did not come up; falling back to stdio`)
      try { proc.kill() } catch { /* gone */ }
    }
  }))
  return started
}

export function stopPrestarted(started) {
  for (const s of Object.values(started || {})) {
    try { s.proc.kill() } catch { /* already gone */ }
  }
}
