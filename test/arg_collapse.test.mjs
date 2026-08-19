import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeToolCallArgs, trackLargeToolCallArgs, trackLargeAssistantContent, cacheFrontierIndex } from '../src/runner.js'

test('summarizeToolCallArgs: write with path', () => {
  const s = summarizeToolCallArgs('write', JSON.stringify({ path: '/tmp/a.py', content: 'x' }))
  assert.match(s, /wrote \/tmp\/a\.py \(\d+ chars\)/)
})

test('summarizeToolCallArgs: edit with edits array of 2', () => {
  const s = summarizeToolCallArgs('edit', JSON.stringify({ path: '/tmp/b.py', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] }))
  assert.match(s, /edited \/tmp\/b\.py \(2 edit\(s\)\)/)
})

test('summarizeToolCallArgs: edit with stringified edits array', () => {
  const s = summarizeToolCallArgs('edit', JSON.stringify({ path: '/tmp/b.py', edits: '[{"oldText":"a","newText":"b"}]' }))
  assert.match(s, /edited \/tmp\/b\.py \(1 edit\(s\)\)/)
})

test('summarizeToolCallArgs: edit legacy path with no edits → 1 edit(s)', () => {
  const s = summarizeToolCallArgs('edit', JSON.stringify({ path: '/tmp/b.py', oldText: 'a', newText: 'b' }))
  assert.match(s, /edited \/tmp\/b\.py \(1 edit\(s\)\)/)
})

test('summarizeToolCallArgs: bash plain command', () => {
  const s = summarizeToolCallArgs('bash', JSON.stringify({ command: 'ls -la' }))
  assert.match(s, /ls -la/)
  assert.match(s, /chars total/)
})

test('summarizeToolCallArgs: bash heredoc mentions /tmp/x.py', () => {
  const s = summarizeToolCallArgs('bash', JSON.stringify({ command: 'cat > /tmp/x.py <<EOF\nprint(1)\nEOF' }))
  assert.match(s, /\/tmp\/x\.py/)
})

test('summarizeToolCallArgs: bash redirect mentions log.txt', () => {
  const s = summarizeToolCallArgs('bash', JSON.stringify({ command: 'echo hi >> log.txt' }))
  assert.match(s, /log\.txt/)
})

test('summarizeToolCallArgs: unknown fn generic', () => {
  const s = summarizeToolCallArgs('frobnicate', JSON.stringify({ a: 1 }))
  assert.match(s, /frobnicate call/)
})

test('summarizeToolCallArgs: invalid-JSON argsString generic fallback', () => {
  const s = summarizeToolCallArgs('write', 'not json {{{')
  assert.match(s, /write call/)
})

test('trackLargeToolCallArgs: large args tracked', () => {
  const map = new Map()
  const big = 'x'.repeat(50)
  const msg = { tool_calls: [{ id: 'a1', function: { name: 'write', arguments: big } }] }
  trackLargeToolCallArgs(msg, 0, map, 10)
  assert.equal(map.size, 1)
  assert.equal(map.get('a1').fnName, 'write')
  assert.equal(map.get('a1').roundTripCreated, 0)
})

test('trackLargeToolCallArgs: small args skipped', () => {
  const map = new Map()
  const msg = { tool_calls: [{ id: 'a1', function: { name: 'write', arguments: 'x' } }] }
  trackLargeToolCallArgs(msg, 0, map, 10)
  assert.equal(map.size, 0)
})

test('trackLargeToolCallArgs: duplicate id skipped', () => {
  const map = new Map()
  const big = 'x'.repeat(50)
  const msg = { tool_calls: [{ id: 'a1', function: { name: 'write', arguments: big } }] }
  trackLargeToolCallArgs(msg, 0, map, 10)
  trackLargeToolCallArgs(msg, 5, map, 10)
  assert.equal(map.size, 1)
  assert.equal(map.get('a1').roundTripCreated, 0)  // not overwritten
})

test('trackLargeAssistantContent: large string content tracked', () => {
  const map = new Map()
  let n = 0
  const msg = { role: 'assistant', content: 'x'.repeat(50) }
  trackLargeAssistantContent(msg, 3, map, 10, () => `asst-${++n}`)
  assert.equal(map.size, 1)
  const entry = [...map.values()][0]
  assert.equal(entry.msg, msg)
  assert.equal(entry.roundTripCreated, 3)
  assert.equal([...map.keys()][0], 'asst-1')
})

test('trackLargeAssistantContent: content ≤ threshold skipped', () => {
  const map = new Map()
  const msg = { role: 'assistant', content: 'short' }
  trackLargeAssistantContent(msg, 0, map, 10, () => 'asst-1')
  assert.equal(map.size, 0)
})

test('trackLargeAssistantContent: non-string content skipped', () => {
  const map = new Map()
  const msg = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50) }] }
  trackLargeAssistantContent(msg, 0, map, 10, () => 'asst-1')
  assert.equal(map.size, 0)
})

test('trackLargeAssistantContent: same msg not double-tracked', () => {
  const map = new Map()
  let n = 0
  const msg = { role: 'assistant', content: 'x'.repeat(50) }
  trackLargeAssistantContent(msg, 0, map, 10, () => `asst-${++n}`)
  trackLargeAssistantContent(msg, 1, map, 10, () => `asst-${++n}`)
  assert.equal(map.size, 1)
})

test('cacheFrontierIndex: legacy 2-arg call works', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 't1', content: 'x' },
  ]
  assert.equal(cacheFrontierIndex(messages, ['t1']), 1)
})

test('cacheFrontierIndex: assistant msg with pending arg id mid-array', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [{ id: 'a1', function: { name: 'write', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a1', content: 'ok' },
  ]
  assert.equal(cacheFrontierIndex(messages, [], ['a1']), 1)
})

test('cacheFrontierIndex: pending tool result AND pending assistant args → min index', () => {
  const messages = [
    { role: 'tool', tool_call_id: 't1', content: 'x' },
    { role: 'assistant', tool_calls: [{ id: 'a1', function: { name: 'write', arguments: '{}' } }] },
  ]
  assert.equal(cacheFrontierIndex(messages, ['t1'], ['a1']), 0)
})

test('cacheFrontierIndex: assistant without tool_calls ignored', () => {
  const messages = [
    { role: 'assistant', content: 'hi' },
    { role: 'tool', tool_call_id: 't1', content: 'x' },
  ]
  assert.equal(cacheFrontierIndex(messages, ['t1'], ['a1']), 1)
})

test('cacheFrontierIndex: empty pendingArgIds → messages.length', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [{ id: 'a1', function: { name: 'write', arguments: '{}' } }] },
  ]
  assert.equal(cacheFrontierIndex(messages, [], []), messages.length)
})

test('cacheFrontierIndex: pending msg-ref mid-array → its index', () => {
  const asst = { role: 'assistant', content: 'x'.repeat(50) }
  const messages = [
    { role: 'user', content: 'hi' },
    asst,
    { role: 'user', content: 'more' },
  ]
  assert.equal(cacheFrontierIndex(messages, [], [], [asst]), 1)
})

test('cacheFrontierIndex: min index across all three pending kinds', () => {
  const asst = { role: 'assistant', content: 'x'.repeat(50) }
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'a1', function: { name: 'write', arguments: '{}' } }] },
    asst,
    { role: 'tool', tool_call_id: 't1', content: 'x' },
  ]
  assert.equal(cacheFrontierIndex(messages, ['t1'], ['a1'], [asst]), 0)
})

test('cacheFrontierIndex: empty 4th arg → messages.length', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'reasoning' },
  ]
  assert.equal(cacheFrontierIndex(messages, [], [], []), messages.length)
})
