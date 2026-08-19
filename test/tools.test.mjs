// Unit tests for the generic tool plumbing: the agent knows nothing about any
// particular tool, so everything here is driven by the tool descriptors the
// carrier sends. Uses only Node's built-in test runner + assert.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  applyToolEnv,
  blockCommands,
  buildCliInvocation,
  cliToolLines,
  commandExists,
  fillTemplate,
  findCliTool,
  matchToolsFromCommand,
  planWorkspaceHooks,
  registerTools,
  selectPrestartServers,
} from '../src/tools.js'

const TRACKER = {
  name: 'tracker',
  env: { TRACKER_URL: 'https://tracker.example', TRACKER_TOKEN: 'secret' },
  bash_match: 'tracker',
}
const GRAPHER = {
  name: 'grapher',
  command: 'grapher',
  cli_tools: {
    grapher_query: {
      args: ['query', '{question}', '.'],
      required: ['question'],
      optional: { depth: ['--depth', '{depth}'] },
      cwd: '{repo}',
    },
  },
}

// ── registration ────────────────────────────────────────────────────────────

test('registerTools: env-only tool is always usable', () => {
  const { registered, skipped } = registerTools([TRACKER], { exists: () => false })
  assert.deepEqual(registered.map(t => t.name), ['tracker'])
  assert.deepEqual(skipped, [])
})

test('registerTools: a tool whose command is missing is skipped', () => {
  const { registered, skipped } = registerTools([GRAPHER], { exists: (c) => c !== 'grapher' })
  assert.deepEqual(registered, [])
  assert.deepEqual(skipped.map(t => t.name), ['grapher'])
})

test('registerTools: allowed ∧ available is what gets registered', () => {
  const { registered } = registerTools([TRACKER, GRAPHER], { exists: (c) => c === 'grapher' })
  assert.deepEqual(registered.map(t => t.name), ['tracker', 'grapher'])
})

// ── env injection ───────────────────────────────────────────────────────────

test('applyToolEnv: installs every granted tool env var', () => {
  const env = {}
  const keys = applyToolEnv([TRACKER], [], env)
  assert.equal(env.TRACKER_TOKEN, 'secret')
  assert.deepEqual(keys.sort(), ['TRACKER_TOKEN', 'TRACKER_URL'])
})

test('applyToolEnv: the previous run keys are purged first (warm pods)', () => {
  const env = { OLD_TOOL_TOKEN: 'stale' }
  applyToolEnv([TRACKER], ['OLD_TOOL_TOKEN'], env)
  assert.equal('OLD_TOOL_TOKEN' in env, false)
  assert.equal(env.TRACKER_TOKEN, 'secret')
})

test('applyToolEnv: revoking every tool leaves nothing behind', () => {
  const env = {}
  const keys = applyToolEnv([TRACKER], [], env)
  applyToolEnv([], keys, env)
  assert.deepEqual(env, {})
})

// ── CLI templates ───────────────────────────────────────────────────────────

test('fillTemplate: placeholder and fallback', () => {
  assert.equal(fillTemplate('{repo}', { repo: '/workspace/x' }), '/workspace/x')
  assert.equal(fillTemplate('{repo|.}', {}), '.')
})

test('buildCliInvocation: happy path', () => {
  const r = buildCliInvocation(GRAPHER.cli_tools.grapher_query, { question: 'how does X work', repo: '/w/r' })
  assert.deepEqual(r.argv, ['query', 'how does X work', '.'])
  assert.equal(r.cwd, '/w/r')
})

test('buildCliInvocation: optional args are appended only when supplied', () => {
  const spec = GRAPHER.cli_tools.grapher_query
  assert.deepEqual(
    buildCliInvocation(spec, { question: 'q', repo: '/w/r', depth: 2 }).argv,
    ['query', 'q', '.', '--depth', '2'],
  )
  assert.deepEqual(buildCliInvocation(spec, { question: 'q', repo: '/w/r' }).argv, ['query', 'q', '.'])
})

test('buildCliInvocation: missing required arg → error', () => {
  const r = buildCliInvocation(GRAPHER.cli_tools.grapher_query, { repo: '/w/r' })
  assert.ok(r.error.includes('question'))
})

test('buildCliInvocation: missing cwd arg → error', () => {
  const r = buildCliInvocation(GRAPHER.cli_tools.grapher_query, { question: 'q' })
  assert.ok(r.error.includes('repo'))
})

test('buildCliInvocation: requires_files that is absent → error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-test-'))
  const spec = { args: ['run'], cwd: '{repo}', requires_files: ['index/state.json'] }
  assert.ok(buildCliInvocation(spec, { repo: dir }).error.includes('required file not found'))

  mkdirSync(join(dir, 'index'), { recursive: true })
  writeFileSync(join(dir, 'index', 'state.json'), '{}')
  assert.deepEqual(buildCliInvocation(spec, { repo: dir }).argv, ['run'])
})

// ── gateway routing ─────────────────────────────────────────────────────────

test('findCliTool: routes by tool name', () => {
  const hit = findCliTool([TRACKER, GRAPHER], undefined, 'grapher_query')
  assert.equal(hit.tool.name, 'grapher')
  assert.equal(hit.toolName, 'grapher_query')
})

test('findCliTool: routes by server name', () => {
  const hit = findCliTool([GRAPHER], 'grapher', 'query')
  assert.equal(hit.toolName, 'grapher_query')
})

test('findCliTool: an unregistered tool does not route', () => {
  assert.equal(findCliTool([TRACKER], undefined, 'grapher_query'), null)
})

test('cliToolLines: lists every registered CLI tool', () => {
  assert.deepEqual(cliToolLines([TRACKER, GRAPHER]), ['grapher: grapher_query'])
})

// ── bash matching ───────────────────────────────────────────────────────────

test('matchToolsFromCommand: uses each tool own bash_match', () => {
  assert.deepEqual(matchToolsFromCommand('tracker list --mine', [TRACKER, GRAPHER]), ['tracker'])
})

test('matchToolsFromCommand: tools without bash_match never match', () => {
  assert.deepEqual(matchToolsFromCommand('grapher query x', [GRAPHER]), [])
})

test('matchToolsFromCommand: no tools → no matches', () => {
  assert.deepEqual(matchToolsFromCommand('git clone https://host/r', []), [])
})

// ── PATH availability ───────────────────────────────────────────────────────

test('commandExists: a tool with no command needs nothing on PATH', () => {
  assert.equal(commandExists(undefined, { runWhich: () => { throw new Error('nope') } }), true)
})

test('commandExists: a lookup that throws means the binary is absent', () => {
  assert.equal(commandExists('nope', { runWhich: () => { throw new Error('not found') } }), false)
  assert.equal(commandExists('yes', { runWhich: () => true }), true)
})

// ── blocked commands ────────────────────────────────────────────────────────

test('blockCommands: nothing blocked leaves PATH untouched', () => {
  assert.equal(blockCommands([], { originalPath: '/usr/bin' }), '/usr/bin')
  assert.equal(blockCommands(undefined, { originalPath: '/usr/bin' }), '/usr/bin')
})

test('blockCommands: a blocked binary is shadowed by an exit-127 stub', () => {
  const binDir = join(mkdtempSync(join(tmpdir(), 'blocked-')), 'bin')
  const path = blockCommands(['forbidden'], { originalPath: '/usr/bin', binDir })
  // The stub directory must come FIRST, or the real binary still wins.
  assert.equal(path, `${binDir}:/usr/bin`)
  const stub = join(binDir, 'forbidden')
  assert.equal(statSync(stub).mode & 0o111, 0o111) // executable
  const r = spawnSync(stub, [], { encoding: 'utf-8' })
  assert.equal(r.status, 127)
  assert.match(r.stderr, /not enabled for this agent/)
})

test('blockCommands: falsy entries are ignored', () => {
  assert.equal(blockCommands([null, '', undefined], { originalPath: '/usr/bin' }), '/usr/bin')
})

// ── MCP pre-start selection (carrier `prestart_http`) ───────────────────────

test('selectPrestartServers: a stdio server is pre-started by default', () => {
  const servers = [{ name: 'alpha', command: ['alpha-mcp'] }]
  assert.deepEqual(selectPrestartServers(servers).map(s => s.name), ['alpha'])
})

test('selectPrestartServers: prestart_http false is left for the stdio path', () => {
  const servers = [
    { name: 'alpha', command: ['alpha-mcp'], prestart_http: true },
    { name: 'beta', command: ['beta-mcp'], prestart_http: false },
  ]
  assert.deepEqual(selectPrestartServers(servers).map(s => s.name), ['alpha'])
})

test('selectPrestartServers: remote and command-less servers are skipped', () => {
  const servers = [
    { name: 'remote', url: 'https://host/mcp' },
    { name: 'empty', command: [] },
    { name: 'nocmd' },
    { name: 'ok', command: ['ok-mcp'] },
  ]
  assert.deepEqual(selectPrestartServers(servers).map(s => s.name), ['ok'])
})

test('selectPrestartServers: a backend predating the flag keeps old behaviour', () => {
  // Absent prestart_http must mean "hostable" — not "skip".
  assert.equal(selectPrestartServers([{ name: 'a', command: ['a'] }]).length, 1)
  assert.deepEqual(selectPrestartServers(null), [])
})

// ── workspace hooks (carrier `workspace_hook`) ──────────────────────────────

function workspaceWith(repos) {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  const dirs = []
  for (const [repo, files] of Object.entries(repos)) {
    const dir = join(root, repo)
    mkdirSync(dir, { recursive: true })
    for (const rel of files) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), 'x')
    }
    dirs.push(dir)
  }
  return { root, dirs }
}

const INDEXER = {
  name: 'indexer',
  command: 'indexer',
  workspace_hook: { args: ['update', '.'], requires_files: ['cache/state.json'], timeout_seconds: 30 },
}

test('planWorkspaceHooks: runs only in repos holding every required file', () => {
  const { dirs } = workspaceWith({ indexed: ['cache/state.json'], plain: [] })
  const jobs = planWorkspaceHooks([INDEXER], dirs)
  assert.equal(jobs.length, 1)
  assert.match(jobs[0].cwd, /indexed$/)
  assert.deepEqual(jobs[0].args, ['update', '.'])
  assert.equal(jobs[0].command, 'indexer')
  assert.equal(jobs[0].timeoutMs, 30000)
})

test('planWorkspaceHooks: a hook never bootstraps a repo that lacks the marker', () => {
  const { dirs } = workspaceWith({ plain: [], other: [] })
  assert.deepEqual(planWorkspaceHooks([INDEXER], dirs), [])
})

test('planWorkspaceHooks: no requires_files → every repo qualifies', () => {
  const { dirs } = workspaceWith({ a: [], b: [] })
  const tool = { name: 't', workspace_hook: { args: ['go'] } }
  assert.equal(planWorkspaceHooks([tool], dirs).length, 2)
})

test('planWorkspaceHooks: tools without a hook, or with empty args, plan nothing', () => {
  const { dirs } = workspaceWith({ a: [] })
  assert.deepEqual(planWorkspaceHooks([TRACKER, GRAPHER], dirs), [])
  assert.deepEqual(planWorkspaceHooks([{ name: 't', workspace_hook: { args: [] } }], dirs), [])
})

test('planWorkspaceHooks: timeout defaults to 120s and command falls back to name', () => {
  const { dirs } = workspaceWith({ a: [] })
  const [job] = planWorkspaceHooks([{ name: 'bare', workspace_hook: { args: ['go'] } }], dirs)
  assert.equal(job.timeoutMs, 120000)
  assert.equal(job.command, 'bare')
})

test('planWorkspaceHooks: one job per (tool, repo) pair', () => {
  const { dirs } = workspaceWith({ a: ['m'], b: ['m'] })
  const t1 = { name: 't1', workspace_hook: { args: ['x'], requires_files: ['m'] } }
  const t2 = { name: 't2', workspace_hook: { args: ['y'], requires_files: ['m'] } }
  const jobs = planWorkspaceHooks([t1, t2], dirs)
  assert.equal(jobs.length, 4)
  assert.deepEqual([...new Set(jobs.map(j => j.tool))].sort(), ['t1', 't2'])
})

test('planWorkspaceHooks: missing workspace dirs are tolerated', () => {
  assert.deepEqual(planWorkspaceHooks([INDEXER], []), [])
  assert.deepEqual(planWorkspaceHooks(null, null), [])
})
