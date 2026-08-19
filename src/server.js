/**
 * pi-agent HTTP server.
 *
 * Mirrors the FastAPI server in agent_server/server.py but in Node/ESM/Express.
 * Endpoints: GET /health, GET /status, GET /poll, POST /start, POST /terminate
 */

import express from 'express'
import { startRun } from './runner.js'
import { BackendClient } from './backend-client.js'

const app = express()
app.use(express.json())

// --- In-memory state ---
let agentStatus = 'idle'   // 'idle' | 'running' | 'done' | 'failed'
let currentRunId = null
let currentAbort = null
const outputs = []         // { id, type, content, sent }
let outputSeq = 0

function addOutput(type, content) {
  outputs.push({ id: String(++outputSeq), type, content, sent: false })
}

function setStatus(s) {
  agentStatus = s
}

// Poll status map: internal -> backend protocol
const STATUS_MAP = {
  idle: 'idle',
  running: 'working',
  done: 'finished',
  failed: 'failed',
}

// --- Endpoints ---

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.get('/status', (_req, res) =>
  res.json({ status: agentStatus, run_id: currentRunId })
)

app.get('/poll', (_req, res) => {
  // Progress outputs are consumed once; 'final' outputs are re-sent on every
  // poll. Marking final sent on first delivery lost it when the delivering
  // response went to an already-timed-out socket (a poll queued behind an
  // event-loop-blocking execSync, e.g. the gsutil workspace upload) — the
  // backend then saw status=finished with no final output and failed the
  // step. Re-sending is safe: the backend caches the first final it sees.
  const unsent = outputs.filter(o => !o.sent)
  unsent.forEach(o => { if (o.type !== 'final') o.sent = true })
  const finals = outputs.filter(o => o.type === 'final')
  const batch = [...unsent.filter(o => o.type !== 'final'), ...finals]
  res.json({
    status: STATUS_MAP[agentStatus] || 'idle',
    run_id: currentRunId,
    outputs: batch.map(({ id, type, content }) => ({ id, type, content })),
  })
})

app.post('/start', async (req, res) => {
  const body = req.body

  // Idempotency: same run_id already processed
  if (currentRunId === body.run_id && agentStatus !== 'idle') {
    return res.status(202).json({ run_id: body.run_id, status: 'already_processed' })
  }

  // Busy check
  if (agentStatus === 'running') {
    return res.status(409).json({ detail: 'Agent is already running' })
  }

  // Reset state for new run
  agentStatus = 'running'
  currentRunId = body.run_id
  outputs.length = 0
  outputSeq = 0
  currentAbort = null

  res.status(202).json({ run_id: body.run_id, status: 'started' })

  // Fire-and-forget
  const client = new BackendClient(body.callback_url, body.run_id, addOutput, setStatus)
  startRun(body, client, (abort) => { currentAbort = abort }).catch(err => {
    console.error('[pi-agent] run failed:', err)
    addOutput('final', { error: String(err) })
    agentStatus = 'failed'
  })
})

app.post('/terminate', (_req, res) => {
  if (currentAbort) currentAbort()
  res.json({ status: 'terminating' })
  setTimeout(() => process.exit(0), 100)
})

const port = parseInt(process.env.AGENT_PORT || '8000', 10)
app.listen(port, () => console.error(`pi-agent listening on port ${port}`))
