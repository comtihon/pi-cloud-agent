// Unit tests for the pure helpers backing the mcp-resolver loop in runner.js.
// Uses only Node's built-in test runner + assert module — no new dependencies.
// Only the exported pure functions are covered here; the interceptor-closure
// wiring (artifact write, truncation cap, read_artifact) has no test
// infrastructure and is an accepted gap.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMcpUsageExample,
} from '../src/runner.js'

test('buildMcpUsageExample: empty toolLines → generic fallback, no concrete tool', () => {
  const s = buildMcpUsageExample([])
  assert.equal(s, 'mcp({tool:"...", args:"{...}", reason:"why you need this tool call"})')
  assert.ok(!s.includes('args:{'))
})

test('buildMcpUsageExample: the first entry wins and no other tool leaks in', () => {
  const s = buildMcpUsageExample(['alpha: alpha_search', 'beta: beta_lookup'])
  assert.ok(s.includes('alpha_search'))
  assert.ok(!s.includes('beta_lookup'))
})

test('buildMcpUsageExample: args are a placeholder, never a baked-in example', () => {
  // The agent does not know what any tool's arguments look like, so the example
  // must stay generic no matter which tool a run happens to be granted.
  for (const line of ['tracker: tracker_get_item', 'grapher: grapher_query', 'x: search']) {
    const s = buildMcpUsageExample([line])
    assert.equal(s, `mcp({tool:"${line.split(': ')[1]}", args:"{...}", reason:"why you need this tool call"})`)
  }
})

test('buildMcpUsageExample: a bare entry with no "server: " prefix still works', () => {
  assert.ok(buildMcpUsageExample(['plain_tool']).includes('tool:"plain_tool"'))
})

test('buildMcpUsageExample: unknown tool → generic-but-real-tool-name fallback', () => {
  const s = buildMcpUsageExample(['unknownserver: some_custom_tool'])
  assert.ok(s.includes('some_custom_tool'))
  assert.ok(s.includes('{...}'))
  assert.ok(!s.includes('args:{'))
})
