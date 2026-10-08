// Diagnostics go to stderr only: stdout carries the ACP protocol.
export function log(...args) {
  try {
    process.stderr.write(`[pi-carrier-agent] ${args.map(fmt).join(' ')}\n`)
  } catch { /* stderr closed */ }
}

function fmt(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  try { return JSON.stringify(v) } catch { return String(v) }
}
