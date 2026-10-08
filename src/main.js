// pi-carrier-agent: an ACP agent on stdin/stdout, built on the pi SDK.
//
// stdout is the protocol. Anything else that writes to it — pi, an
// extension, a library's console.log — would corrupt a frame, so the real
// stdout writer is captured for the protocol and every other write to
// process.stdout / console.log is redirected to stderr.

import { readFileSync } from 'node:fs'

import { JsonRpcConnection } from './acp/protocol.js'
import { createAgent } from './acp/agent.js'
import { createCarrierSetup } from './config/index.js'
import { uploadWorkspace } from './workspace.js'
import { log } from './log.js'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export async function main() {
  const protocolWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb)
  console.log = console.error
  console.info = console.error
  console.debug = console.error

  const connection = new JsonRpcConnection({
    input: process.stdin,
    write: (line) => protocolWrite(line),
    log,
    idPrefix: 'agent-',
  })

  const setup = createCarrierSetup()
  const agent = createAgent({
    connection,
    version: VERSION,
    deps: {
      setup,
      // Loaded lazily: the pi SDK is heavy and not needed for `initialize`.
      createSession: async (opts) => (await import('./pi-session.js')).createPiSession(opts),
      uploadWorkspace,
      defaultCwd: process.env.PI_CARRIER_DEFAULT_CWD || '/workspace',
    },
  })

  let exiting = false
  const shutdown = (code) => {
    if (exiting) return
    exiting = true
    try { agent.dispose() } catch (err) { log('dispose failed:', err.message) }
    process.exit(code)
  }
  connection.onClose(() => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  process.on('unhandledRejection', (err) => log('unhandled rejection:', err))
  process.on('uncaughtException', (err) => log('uncaught exception:', err))

  log(`pi-carrier-agent ${VERSION} ready (pid ${process.pid})`)
  connection.start()
}
