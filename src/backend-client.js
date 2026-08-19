/**
 * BackendClient — JS port of agent_server/backend_client.py.
 *
 * Used by runner.js to communicate back to the langgraph-backend via HTTP.
 */

export class BackendClient {
  constructor(callbackUrl, runId, addOutput, setStatus) {
    this.base = `${callbackUrl.replace(/\/$/, '')}/api/v1/runs/${runId}/agent`
    this.runId = runId
    this._addOutput = addOutput
    this._setStatus = setStatus
  }

  sendProgress(message) {
    this._addOutput('progress', { message })
  }

  sendOutput(output) {
    this._addOutput('final', output)
    this._setStatus('done')
  }

  /**
   * POST question to backend then long-poll /agent/input for the answer.
   * Retries on 408/5xx/network errors. Deadline is ~10 minutes.
   *
   * @param {string} question
   * @param {string[]|null} options
   * @returns {Promise<string>}
   */
  async askQuestion(question, options = null) {
    // Step 1: post the question so the frontend can display it.
    await fetch(`${this.base}/question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, options }),
      signal: AbortSignal.timeout(10_000),
    })

    // Step 2: long-poll for the answer.
    const deadline = Date.now() + 600_000
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${this.base}/input`, {
          signal: AbortSignal.timeout(65_000),
        })
        if (resp.status === 200) {
          const data = await resp.json()
          return data.answer
        }
        if (resp.status === 408 || resp.status >= 500) {
          await sleep(2000)
          continue
        }
        throw new Error(`Unexpected status ${resp.status} from /agent/input`)
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          await sleep(1000)
          continue
        }
        throw err
      }
    }
    throw new Error('askQuestion timed out after 10 minutes')
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
