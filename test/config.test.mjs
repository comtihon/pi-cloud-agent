// agent_config / ACP mcpServers → env, tools, mcp.json, settings.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { applyAgentEnv, createEnvState } from '../src/config/env.js'
import {
  buildMcpConfig,
  CLI_TOOLS_SERVER,
  pairsToObject,
  selectPrestart,
  waitForPort,
  writeCliToolsConfig,
  writePiConfig,
} from '../src/config/mcp.js'
import { customModelLimits, resolveModelConfig } from '../src/config/model.js'

// ── mcpServers → mcp.json ───────────────────────────────────────────────────

const ACP_SERVERS = [
  { name: 'jira', command: 'uvx', args: ['mcp-atlassian'], env: [{ name: 'JIRA_URL', value: 'https://j' }, { name: 'JIRA_TOKEN', value: 't' }] },
  { type: 'http', name: 'datasources', url: 'http://carrier/mcp', headers: [{ name: 'Authorization', value: 'Bearer grant.jwt' }, { name: 'X-Run', value: 'r1' }] },
  { type: 'sse', name: 'legacy', url: 'http://legacy/sse', headers: [] },
  { type: 'http', name: 'basic', url: 'http://b/mcp', headers: [{ name: 'authorization', value: 'Basic abc' }] },
  { name: 'broken' },
  { type: 'http', name: 'nourl' },
]

test('buildMcpConfig: stdio → command/args/env object over the base env', () => {
  const { mcpServers } = buildMcpConfig(ACP_SERVERS, { baseEnv: { PATH: '/bin', JIRA_URL: 'old' } })
  assert.deepEqual(mcpServers.jira, {
    command: 'uvx',
    args: ['mcp-atlassian'],
    env: { PATH: '/bin', JIRA_URL: 'https://j', JIRA_TOKEN: 't' },
  })
})

test('buildMcpConfig: http Authorization: Bearer → bearerToken, other headers kept', () => {
  const { mcpServers } = buildMcpConfig(ACP_SERVERS)
  assert.deepEqual(mcpServers.datasources, {
    url: 'http://carrier/mcp',
    auth: 'bearer',
    bearerToken: 'grant.jwt',
    headers: { 'X-Run': 'r1' },
  })
  assert.deepEqual(mcpServers.legacy, { url: 'http://legacy/sse' })
  // A non-bearer Authorization header is passed through untouched.
  assert.deepEqual(mcpServers.basic, { url: 'http://b/mcp', headers: { authorization: 'Basic abc' } })
})

test('buildMcpConfig: malformed entries are skipped', () => {
  const { mcpServers } = buildMcpConfig(ACP_SERVERS)
  assert.equal(mcpServers.broken, undefined)
  assert.equal(mcpServers.nourl, undefined)
  assert.deepEqual(buildMcpConfig(null), { mcpServers: {} })
})

test('buildMcpConfig: a pre-started stdio server becomes its local URL', () => {
  const { mcpServers } = buildMcpConfig(ACP_SERVERS, { prestarted: { jira: { url: 'http://127.0.0.1:9999/mcp' } } })
  assert.deepEqual(mcpServers.jira, { url: 'http://127.0.0.1:9999/mcp' })
})

test('buildMcpConfig: cli tools add the carrier-cli-tools stdio server', () => {
  const { mcpServers } = buildMcpConfig([], { cliTools: { command: '/usr/bin/node', args: ['x.js', '--config', 'c.json'] }, baseEnv: { A: '1' } })
  assert.deepEqual(mcpServers[CLI_TOOLS_SERVER], { command: '/usr/bin/node', args: ['x.js', '--config', 'c.json'], env: { A: '1' } })
})

test('selectPrestart: needs a matching carrier entry without prestart_http:false', () => {
  const acp = [
    { name: 'a', command: 'a-mcp', args: [], env: [] },
    { name: 'b', command: 'b-mcp', args: [], env: [] },
    { name: 'c', command: 'c-mcp', args: [], env: [] },
    { type: 'http', name: 'd', url: 'http://d' },
  ]
  const carrier = [
    { name: 'a', transport: 'stdio', command: ['a-mcp'] },
    { name: 'b', transport: 'stdio', command: ['b-mcp'], prestart_http: false },
    { name: 'd', transport: 'http', url: 'http://d' },
  ]
  assert.deepEqual(selectPrestart(acp, carrier).map((s) => s.name), ['a'])
  assert.deepEqual(selectPrestart(acp, undefined), [])
})

test('pairsToObject accepts ACP pairs or a plain object', () => {
  assert.deepEqual(pairsToObject([{ name: 'A', value: 1 }, { value: 'x' }]), { A: '1' })
  assert.deepEqual(pairsToObject({ B: '2' }), { B: '2' })
  assert.deepEqual(pairsToObject(undefined), {})
})

test('waitForPort: true once something listens, false when the process is dead', async () => {
  const srv = createServer().listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  const { port } = srv.address()
  assert.equal(await waitForPort(port, { timeoutMs: 2000 }), true)
  srv.close()
  const dead = spawn(process.execPath, ['-e', ''])
  await new Promise((r) => dead.once('exit', r))
  assert.equal(await waitForPort(port, { proc: dead, timeoutMs: 2000 }), false)
})

test('writePiConfig writes settings.json packages and an owner-only mcp.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-'))
  await writePiConfig(dir, buildMcpConfig(ACP_SERVERS))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), { packages: ['npm:pi-mcp-adapter', 'npm:pi-post-compact'] })
  const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
  assert.equal(mcp.mcpServers.datasources.bearerToken, 'grant.jwt')
  assert.equal(statSync(join(dir, 'mcp.json')).mode & 0o077, 0)
})

test('writeCliToolsConfig: only when a registered tool has cli_tools; no env written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-'))
  assert.equal(await writeCliToolsConfig(dir, [{ name: 'envonly', env: { K: 'v' } }]), null)
  const entry = await writeCliToolsConfig(dir, [
    { name: 'grapher', command: 'grapher', env: { SECRET: 's' }, cli_tools: { grapher_query: { args: ['q', '{question}'] } } },
  ])
  assert.equal(entry.command, process.execPath)
  assert.match(entry.args[0], /cli-tools-mcp\.js$/)
  const cfg = JSON.parse(readFileSync(entry.args[2], 'utf8'))
  assert.equal(cfg[0].name, 'grapher')
  assert.equal(cfg[0].env, undefined)
})

// ── agent_config → env / tools ──────────────────────────────────────────────

const AGENT_CONFIG = {
  system_prompt: 'be terse',
  model: 'kimi-k2',
  tools: [
    { name: 'tracker', env: { TRACKER_TOKEN: 'tt' } },
    { name: 'gh', command: 'gh', env: { GH_TOKEN: 'g' } },
    { name: 'missing', command: 'not-installed', env: { MISSING_KEY: 'm' } },
  ],
  blocked_commands: ['kubectl'],
  credentials: { OPENROUTER_API_KEY: 'sk-or', OTHER: 'o' },
  env_vars: { STEP_VAR: 'sv', META_LLM_MODEL: 'small' },
  extra: { llm_base_url: 'https://openrouter/api/v1', llm_api_key_env: 'OPENROUTER_API_KEY' },
}

test('applyAgentEnv: tools, credentials, env_vars, LLM key and blocked stubs', () => {
  const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'preset' }
  const state = createEnvState()
  const binDir = mkdtempSync(join(tmpdir(), 'blocked-'))
  const r = applyAgentEnv(AGENT_CONFIG, { env, state, exists: (c) => c === 'gh', originalPath: '/usr/bin', binDir })
  assert.deepEqual(r.registered.map((t) => t.name), ['tracker', 'gh'])
  assert.deepEqual(r.skipped.map((t) => t.name), ['missing'])
  assert.equal(env.TRACKER_TOKEN, 'tt')
  assert.equal(env.GH_TOKEN, 'g')
  assert.equal(env.MISSING_KEY, undefined)
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or')
  assert.equal(env.STEP_VAR, 'sv')
  assert.equal(env.META_LLM_MODEL, 'small')
  assert.equal(env.OPENAI_API_KEY, 'sk-or')
  assert.equal(env.ANTHROPIC_API_KEY, 'preset', 'an existing key is not overwritten')
  assert.equal(env.OPENAI_BASE_URL, 'https://openrouter/api/v1')
  assert.equal(env.PATH, `${binDir}:/usr/bin`)
  assert.ok(existsSync(join(binDir, 'kubectl')))
})

test('applyAgentEnv: the next session undoes the previous one (warm pod)', () => {
  const env = { PATH: '/usr/bin', OTHER: 'pod-original' }
  const state = createEnvState()
  const binDir = mkdtempSync(join(tmpdir(), 'blocked-'))
  applyAgentEnv(AGENT_CONFIG, { env, state, exists: () => true, originalPath: '/usr/bin', binDir })
  assert.equal(env.OTHER, 'o')
  applyAgentEnv({ tools: [], credentials: {} }, { env, state, originalPath: '/usr/bin', binDir })
  assert.equal(env.TRACKER_TOKEN, undefined)
  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(env.OPENROUTER_API_KEY, undefined)
  assert.equal(env.STEP_VAR, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENAI_BASE_URL, undefined)
  assert.equal(env.OTHER, 'pod-original', 'a key the pod started with is restored, not deleted')
  assert.equal(env.PATH, '/usr/bin')
})

// ── model ───────────────────────────────────────────────────────────────────

class FakeAuth {
  static inMemory() { return new FakeAuth() }
  constructor() { this.keys = {} }
  setRuntimeApiKey(p, k) { this.keys[p] = k }
}
class FakeRegistry {
  static inMemory() { return new FakeRegistry() }
  constructor() { this.models = [{ id: 'claude-x', provider: 'anthropic' }] }
  registerProvider(name, cfg) { for (const m of cfg.models) this.models.push({ ...m, provider: name, baseUrl: cfg.baseUrl }) }
  find(p, id) { return this.models.find((m) => m.provider === p && m.id === id) }
  getAll() { return this.models }
}

test('resolveModelConfig: custom endpoint takes contextWindow/maxTokens from extra', () => {
  const { model } = resolveModelConfig(
    { ...AGENT_CONFIG, extra: { ...AGENT_CONFIG.extra, context_window: 262144, max_tokens: 32768 } },
    { AuthStorage: FakeAuth, ModelRegistry: FakeRegistry },
  )
  assert.equal(model.provider, 'custom-llm')
  assert.equal(model.contextWindow, 262144)
  assert.equal(model.maxTokens, 32768)
  assert.deepEqual(customModelLimits({}), { contextWindow: 128000, maxTokens: 16384 })
})

test('resolveModelConfig: built-in model gets the runtime key; fallback is anthropic', () => {
  const r1 = resolveModelConfig({ model: 'claude-x', credentials: { ANTHROPIC_API_KEY: 'k' } }, { AuthStorage: FakeAuth, ModelRegistry: FakeRegistry })
  assert.equal(r1.model.id, 'claude-x')
  assert.equal(r1.authStorage.keys.anthropic, 'k')
  const r2 = resolveModelConfig({ credentials: { ANTHROPIC_API_KEY: 'k2' } }, { AuthStorage: FakeAuth, ModelRegistry: FakeRegistry })
  assert.equal(r2.model, undefined)
  assert.equal(r2.authStorage.keys.anthropic, 'k2')
})
