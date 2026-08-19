// Unit tests for the pure message-formatting helpers extracted from
// runner.js's tool_execution_start/end event handling. Uses only Node's
// built-in test runner + assert module — no new dependencies.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatToolStartMessage,
  formatToolEndMessage,
  toolReasonLabel,
  summarizeResult,
  wantsExactResult,
  looksLikeFinalJson,
  cacheFrontierIndex,
} from '../src/runner.js'

test('formatToolStartMessage includes real args from event.args', () => {
  const event = { toolName: 'jira_search', args: { query: 'PROJ-123' } }
  const msg = formatToolStartMessage(event)
  assert.match(msg, /jira → search/)
  assert.match(msg, /"query":"PROJ-123"/)
  assert.doesNotMatch(msg, /\(…\)/)
})

test('formatToolStartMessage truncates args at 4000 chars with a marker', () => {
  const bigValue = 'x'.repeat(5000)
  const event = { toolName: 'jira_search', args: { query: bigValue } }
  const msg = formatToolStartMessage(event)
  assert.match(msg, /…\[truncated\]/)
  // The JSON-encoded args string itself should be capped at 4000 chars
  // before the truncation marker is appended. A reason label may now be
  // appended after the closing paren, so match up to the FIRST ')'.
  const argsMatch = msg.match(/\((.*?)\)/s)
  assert.ok(argsMatch, 'expected args portion in parens')
  const argsStr = argsMatch[1]
  assert.equal(argsStr.length, 4000 + '…[truncated]'.length)
})

test('formatToolStartMessage falls back to "Running <tool>(...)" when no server prefix', () => {
  const event = { toolName: 'standalonetool', args: { a: 1 } }
  const msg = formatToolStartMessage(event)
  assert.match(msg, /^Running standalonetool\(/)
})

test('formatToolEndMessage reflects event.result on success', () => {
  const event = { toolName: 'jira_search', result: { ok: true }, isError: false }
  const msg = formatToolEndMessage(event)
  assert.match(msg, /^✓ jira → search done:/)
  assert.match(msg, /"ok":true/)
})

test('formatToolEndMessage differs when isError is true', () => {
  const okEvent = { toolName: 'jira_search', result: { ok: true }, isError: false }
  const errEvent = { toolName: 'jira_search', result: { message: 'boom' }, isError: true }

  const okMsg = formatToolEndMessage(okEvent)
  const errMsg = formatToolEndMessage(errEvent)

  assert.match(okMsg, /^✓ .* done:/)
  assert.match(errMsg, /^✗ .* failed:/)
  assert.notEqual(okMsg, errMsg)
})

test('formatToolEndMessage summarizes a long multi-line string result instead of raw-truncating', () => {
  const bigValue = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const event = { toolName: 'tool', result: bigValue, isError: false }
  const msg = formatToolEndMessage(event)
  assert.match(msg, /\d+ lines, \d+ chars/)
  assert.doesNotMatch(msg, /…\[truncated\]/)
})

test('formatToolEndMessage still caps and truncates a summary that exceeds 4000 chars', () => {
  // Few lines (<=6) but each huge — summarizeResult shows all of them in
  // full (no per-line truncation), so the built summary itself can exceed
  // 4000 chars and must be caught by the final cap.
  const hugeLine = 'z'.repeat(2000)
  const result = [hugeLine, hugeLine, hugeLine].join('\n')
  const event = { toolName: 'tool', result, isError: false }
  const msg = formatToolEndMessage(event)
  assert.match(msg, /…\[truncated\]/)
})

test('formatToolEndMessage shows short results verbatim', () => {
  const event = { toolName: 'jira_search', result: { ok: true, id: 5 }, isError: false }
  const msg = formatToolEndMessage(event)
  assert.match(msg, /"ok":true/)
  assert.match(msg, /"id":5/)
})

test('toolReasonLabel returns "cloning repo" for a bash git-clone command', () => {
  assert.equal(toolReasonLabel(null, 'bash', { command: 'git clone https://example.com/repo.git' }), 'cloning repo')
})

test('toolReasonLabel returns null for an unrecognized bash-less unknown tool with no server', () => {
  assert.equal(toolReasonLabel(null, 'mysteryTool', {}), null)
})

test('summarizeResult on a short object returns it verbatim', () => {
  const result = { ok: true, id: 5 }
  const summary = summarizeResult(result)
  assert.equal(summary, JSON.stringify(result))
})

test('summarizeResult on a long plain string returns a line/char-count summary', () => {
  const longStr = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const summary = summarizeResult(longStr)
  assert.match(summary, /\d+ lines, \d+ chars/)
})

test('wantsExactResult true for "cat file.txt" with no pipe, false with a jq pipe', () => {
  assert.equal(wantsExactResult({ toolName: 'bash', args: { command: 'cat file.txt' } }), true)
  assert.equal(wantsExactResult({ toolName: 'bash', args: { command: 'cat file.txt | jq .' } }), false)
})

describe('looksLikeFinalJson', () => {
  test('bare {...} at position 0 → true', () => {
    assert.equal(looksLikeFinalJson('{"plan":"x"}'), true)
  })

  test('leading whitespace then bare {...} → true', () => {
    assert.equal(looksLikeFinalJson('   \n  {"plan":"x"}'), true)
  })

  test('```json fenced JSON at position 0 → true', () => {
    assert.equal(looksLikeFinalJson('```json\n{"plan":"x"}\n```'), true)
  })

  test('bare ``` fenced (no json tag) at position 0 → true', () => {
    assert.equal(looksLikeFinalJson('```\n{"plan":"x"}\n```'), true)
  })

  test('prose followed by a fenced JSON block → true (production bug case)', () => {
    const text = 'I have full context. Producing final plan.\n\n```json\n{\n  "plan": "..."\n}\n```'
    assert.equal(looksLikeFinalJson(text), true)
  })

  test('prose followed by a bare trailing JSON object with no fence → true', () => {
    const text = 'Here is the final output:\n\n{\n  "plan": "..."\n}'
    assert.equal(looksLikeFinalJson(text), true)
  })

  test('prose followed by an unclosed/truncated ```json fence ending in } → true', () => {
    const text = 'Producing final plan.\n\n```json\n{\n  "plan": "..."\n}'
    assert.equal(looksLikeFinalJson(text), true)
  })

  test('pure prose with no JSON at all → false', () => {
    assert.equal(looksLikeFinalJson('Cloning all three repos now.'), false)
  })

  test('empty string → false', () => {
    assert.equal(looksLikeFinalJson(''), false)
  })

  test('inline {placeholder} mid-sentence with no closing } → false', () => {
    assert.equal(looksLikeFinalJson('Replace {placeholder} with the real value and continue.'), false)
  })

  test('two fenced blocks where the LAST one is JSON → true', () => {
    const text = 'First:\n\n```bash\nls -la\n```\n\nThen:\n\n```json\n{"plan":"x"}\n```'
    assert.equal(looksLikeFinalJson(text), true)
  })

  test('two fenced blocks where first is JSON but LAST is bash (no trailing }) → false', () => {
    const text = 'Plan:\n\n```json\n{"plan":"x"}\n```\n\nThen run:\n\n```bash\nls -la\n```'
    assert.equal(looksLikeFinalJson(text), false)
  })
})

describe('cacheFrontierIndex', () => {
  test('empty messages array → 0', () => {
    assert.equal(cacheFrontierIndex([], ['a']), 0)
  })

  test('no tool-role messages → messages.length', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    assert.equal(cacheFrontierIndex(messages, ['a']), messages.length)
  })

  test('a pending id on a tool message mid-array → that message index', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'x' },
      { role: 'tool', tool_call_id: 'c1', content: 'raw' },
      { role: 'assistant', content: 'y' },
    ]
    assert.equal(cacheFrontierIndex(messages, ['c1']), 2)
  })

  test('tool message whose id is NOT pending → messages.length', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'resolved', content: 'summary' },
    ]
    assert.equal(cacheFrontierIndex(messages, ['other']), messages.length)
  })

  test('multiple pending ids at different positions → earliest index', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'a', content: 'x' },
      { role: 'tool', tool_call_id: 'b', content: 'y' },
      { role: 'tool', tool_call_id: 'c', content: 'z' },
    ]
    assert.equal(cacheFrontierIndex(messages, new Set(['c', 'b'])), 1)
  })

  test('non-tool-role message with matching tool_call_id → ignored', () => {
    const messages = [
      { role: 'assistant', tool_call_id: 'c1', content: 'not a tool result' },
      { role: 'user', content: 'hi' },
    ]
    assert.equal(cacheFrontierIndex(messages, ['c1']), messages.length)
  })
})
