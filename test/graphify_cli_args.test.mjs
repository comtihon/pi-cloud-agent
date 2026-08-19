// Unit tests for the pure helpers backing the graphify CLI shim in runner.js.
// Uses only Node's built-in test runner + assert module — no new dependencies.
// Only the exported pure functions are covered here; the subprocess spawn
// (_runGraphifyCli / _freshenGraphifyGraphs) has no test infrastructure and is
// an accepted gap, matching mcp_resolver_dedup.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGraphifyCliArgs,
  isGraphifyToolCall,
  buildMcpUsageExample,
} from '../src/runner.js'

test('buildGraphifyCliArgs: graphify_query happy path', () => {
  const r = buildGraphifyCliArgs('graphify_query', { question: 'how does X work', repo: '/workspace/repo' })
  assert.equal(r.error, undefined)
  assert.equal(r.repo, '/workspace/repo')
  assert.deepEqual(r.cliArgs, ['query', 'how does X work', '.'])
})

test('buildGraphifyCliArgs: graphify_explain happy path', () => {
  const r = buildGraphifyCliArgs('graphify_explain', { concept: 'tool gating', repo: '/workspace/repo' })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.cliArgs, ['explain', 'tool gating'])
})

test('buildGraphifyCliArgs: graphify_path happy path', () => {
  const r = buildGraphifyCliArgs('graphify_path', { from: 'A', to: 'B', repo: '/workspace/repo' })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.cliArgs, ['path', 'A', 'B'])
})

test('buildGraphifyCliArgs: missing repo → error', () => {
  const r = buildGraphifyCliArgs('graphify_query', { question: 'q' })
  assert.ok(r.error)
  assert.equal(r.cliArgs, undefined)
})

test('buildGraphifyCliArgs: graphify_query missing question → error', () => {
  const r = buildGraphifyCliArgs('graphify_query', { repo: '/workspace/repo' })
  assert.ok(r.error)
  assert.ok(r.error.includes('question'))
})

test('buildGraphifyCliArgs: graphify_explain missing concept → error', () => {
  const r = buildGraphifyCliArgs('graphify_explain', { repo: '/workspace/repo' })
  assert.ok(r.error)
  assert.ok(r.error.includes('concept'))
})

test('buildGraphifyCliArgs: graphify_path missing from/to → error', () => {
  const rNoTo = buildGraphifyCliArgs('graphify_path', { from: 'A', repo: '/workspace/repo' })
  assert.ok(rNoTo.error)
  const rNoFrom = buildGraphifyCliArgs('graphify_path', { to: 'B', repo: '/workspace/repo' })
  assert.ok(rNoFrom.error)
})

test('buildGraphifyCliArgs: unknown tool → error', () => {
  const r = buildGraphifyCliArgs('graphify_bogus', { repo: '/workspace/repo' })
  assert.ok(r.error)
  assert.ok(r.error.includes('unknown graphify tool'))
})

test('isGraphifyToolCall: server === "graphify" → true', () => {
  assert.equal(isGraphifyToolCall('graphify', 'anything'), true)
})

test('isGraphifyToolCall: known graphify tool names → true', () => {
  assert.equal(isGraphifyToolCall(undefined, 'graphify_query'), true)
  assert.equal(isGraphifyToolCall(undefined, 'graphify_explain'), true)
  assert.equal(isGraphifyToolCall(undefined, 'graphify_path'), true)
})

test('isGraphifyToolCall: unrelated tool name (semble search) → false', () => {
  assert.equal(isGraphifyToolCall(undefined, 'search'), false)
  assert.equal(isGraphifyToolCall(undefined, 'find_related'), false)
})

test('buildMcpUsageExample: graphify_query example present and correct', () => {
  const s = buildMcpUsageExample(['graphify: graphify_query'])
  assert.ok(s.includes('graphify_query'))
  assert.ok(s.includes('how does the mcp tool loop work'))
  assert.ok(!s.includes('jira'))
})
