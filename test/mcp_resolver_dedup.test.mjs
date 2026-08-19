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
  assert.ok(!s.includes('jira'))
})

test('buildMcpUsageExample: first entry wins, uses search example, never mentions jira', () => {
  const s = buildMcpUsageExample(['semble: search', 'semble: find_related'])
  assert.ok(s.includes('search'))
  assert.ok(s.includes('authentication flow'))
  assert.ok(!s.includes('jira'))
  assert.ok(!s.includes('find_related'))
})

test('buildMcpUsageExample: jira tool uses jira example correctly', () => {
  const s = buildMcpUsageExample(['jira: jira_get_issue'])
  assert.ok(s.includes('jira_get_issue'))
  assert.ok(s.includes('issue_key'))
  assert.ok(s.includes('C130-1234'))
})

test('buildMcpUsageExample: unknown tool → generic-but-real-tool-name fallback', () => {
  const s = buildMcpUsageExample(['unknownserver: some_custom_tool'])
  assert.ok(s.includes('some_custom_tool'))
  assert.ok(s.includes('{...}'))
  assert.ok(!s.includes('jira'))
})
