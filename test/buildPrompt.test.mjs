// Unit tests for the pure buildPrompt() helper extracted from runner.js's
// "Build prompt" section. Uses only Node's built-in test runner + assert
// module — no new dependencies, matching runner_format.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPrompt } from '../src/runner.js'

test('buildPrompt uses request/task/prompt fallback chain', () => {
  assert.equal(buildPrompt(null, { request: 'do it' }), 'do it')
  assert.equal(buildPrompt(null, { task: 'do it' }), 'do it')
  assert.equal(buildPrompt(null, { prompt: 'do it' }), 'do it')
})

test('buildPrompt falls back to JSON.stringify(input) when no request/task/prompt', () => {
  const input = { foo: 'bar' }
  assert.equal(buildPrompt(null, input), JSON.stringify(input))
})

test('buildPrompt adds extra keys as sections, string values verbatim', () => {
  const prompt = buildPrompt(null, { request: 'do it', ticket: 'PROJ-123' })
  assert.equal(prompt, 'do it\n\n## ticket\nPROJ-123')
})

test('buildPrompt JSON-pretty-prints non-string extra values', () => {
  const prompt = buildPrompt(null, { request: 'do it', meta: { a: 1 } })
  assert.equal(prompt, `do it\n\n## meta\n${JSON.stringify({ a: 1 }, null, 2)}`)
})

test('buildPrompt excludes underscore-prefixed keys and alias keys from extra sections', () => {
  const prompt = buildPrompt(null, {
    request: 'do it',
    task: 'alias should be excluded',
    prompt: 'alias should be excluded',
    _internal: 'should be excluded',
  })
  assert.equal(prompt, 'do it')
})

test('buildPrompt excludes null/undefined extra values', () => {
  const prompt = buildPrompt(null, { request: 'do it', empty: null })
  assert.equal(prompt, 'do it')
})

test('buildPrompt appends clarification_context as its own section after extras', () => {
  const prompt = buildPrompt(null, {
    request: 'do it',
    ticket: 'PROJ-123',
    clarification_context: 'answers: yes',
  })
  assert.equal(
    prompt,
    'do it\n\n## ticket\nPROJ-123\n\n## Clarification context\nanswers: yes'
  )
})

test('buildPrompt JSON-pretty-prints a dict clarification_context', () => {
  const ctx = { q1: 'a1' }
  const prompt = buildPrompt(null, { request: 'do it', clarification_context: ctx })
  assert.equal(
    prompt,
    `do it\n\n## Clarification context\n${JSON.stringify(ctx, null, 2)}`
  )
})

test('buildPrompt prefixes system_prompt + blank line when set', () => {
  const prompt = buildPrompt('You are helpful.', { request: 'do it' })
  assert.equal(prompt, 'You are helpful.\n\ndo it')
})

test('buildPrompt omits system_prompt prefix when falsy', () => {
  const prompt = buildPrompt('', { request: 'do it' })
  assert.equal(prompt, 'do it')
})
