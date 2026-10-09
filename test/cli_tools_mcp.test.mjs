// carrier-cli-tools stdio MCP server (src/cli-tools-mcp.js), spawned for real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLineSplitter, encodeFrame } from '../src/acp/protocol.js'
import { cliToolDescriptor, listCliTools } from '../src/cli-tools-mcp.js'

const SCRIPT = fileURLToPath(new URL('../src/cli-tools-mcp.js', import.meta.url))

const ECHOER = {
  name: 'echoer',
  command: 'echo',
  description: 'echo things',
  cli_tools: {
    echo_say: {
      description: 'Say something',
      args: ['said:', '{text}', '{suffix|!}'],
      required: ['text'],
      optional: { loud: ['--loud={loud}'] },
    },
    echo_in_repo: {
      args: ['in-repo'],
      cwd: '{repo}',
      requires_files: ['marker'],
    },
  },
}
const FAILER = { name: 'failer', command: 'false', cli_tools: { fail_now: { args: [] } } }

test('descriptor: schema derived from the template placeholders', () => {
  const d = cliToolDescriptor(ECHOER, 'echo_say', ECHOER.cli_tools.echo_say)
  assert.equal(d.name, 'echo_say')
  assert.equal(d.description, 'Say something')
  assert.deepEqual(Object.keys(d.inputSchema.properties).sort(), ['loud', 'suffix', 'text'])
  assert.deepEqual(d.inputSchema.required, ['text'])
  const r = cliToolDescriptor(ECHOER, 'echo_in_repo', ECHOER.cli_tools.echo_in_repo)
  assert.deepEqual(r.inputSchema.required, ['repo'])
  assert.deepEqual(listCliTools([ECHOER, FAILER, ECHOER]).map((t) => t.name), ['echo_say', 'echo_in_repo', 'fail_now'])
})

function startServer(tools) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-tools-'))
  const cfg = join(dir, 'tools.json')
  writeFileSync(cfg, JSON.stringify(tools))
  const proc = spawn(process.execPath, [SCRIPT, '--config', cfg], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const splitter = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  })
  proc.stdout.on('data', (d) => splitter.push(d))
  let id = 0
  const call = (method, params) => new Promise((resolve) => {
    const myId = ++id
    pending.set(myId, resolve)
    proc.stdin.write(encodeFrame({ jsonrpc: '2.0', id: myId, method, params }))
  })
  return { proc, call, dir }
}

test('stdio MCP: initialize, tools/list, tools/call', async () => {
  const { proc, call, dir } = startServer([ECHOER, FAILER])
  try {
    const init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.result.protocolVersion, '2025-03-26')
    assert.deepEqual(init.result.capabilities.tools, { listChanged: false })
    assert.equal(init.result.serverInfo.name, 'carrier-cli-tools')
    proc.stdin.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }))

    const list = await call('tools/list', {})
    assert.deepEqual(list.result.tools.map((t) => t.name), ['echo_say', 'echo_in_repo', 'fail_now'])

    const ok = await call('tools/call', { name: 'echo_say', arguments: { text: 'hi there', loud: 'yes' } })
    assert.equal(ok.result.isError, false)
    assert.equal(ok.result.content[0].text, 'said: hi there ! --loud=yes')

    const missing = await call('tools/call', { name: 'echo_say', arguments: {} })
    assert.equal(missing.result.isError, true)
    assert.match(missing.result.content[0].text, /missing required arg\(s\): text/)

    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const noMarker = await call('tools/call', { name: 'echo_in_repo', arguments: { repo } })
    assert.match(noMarker.result.content[0].text, /required file not found/)
    writeFileSync(join(repo, 'marker'), '')
    const inRepo = await call('tools/call', { name: 'echo_in_repo', arguments: { repo } })
    assert.equal(inRepo.result.content[0].text, 'in-repo')

    const failed = await call('tools/call', { name: 'fail_now', arguments: {} })
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /exited \(code 1\)/)

    const unknown = await call('tools/call', { name: 'nope', arguments: {} })
    assert.equal(unknown.error.code, -32602)
    const bad = await call('resources/list', {})
    assert.equal(bad.error.code, -32601)
  } finally {
    proc.kill()
  }
})
