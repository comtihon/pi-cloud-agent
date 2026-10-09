// Workspace persistence (GCS) and the per-repo workspace hooks.
//
// Everything here is async and spawns argv arrays — never a shell string and
// never execSync: the agent's stdin/stdout loop must keep answering ACP while
// a multi-GB workspace is tarred, and the bucket/path come from the client's
// payload, so shell metacharacters must stay data.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planWorkspaceHooks } from './tools.js'
import { log } from './log.js'

const ARCHIVE_NAME = 'workspace.tar.gz'

/**
 * Run a command; resolve `{ code, stdout, stderr }`. Never rejects: a missing
 * binary resolves with code 127 and the spawn error as stderr.
 */
export function run(command, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    let timer
    const finish = (code) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    let proc
    try {
      proc = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      stderr = err.message
      finish(127)
      return
    }
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
        stderr += `\n${command} timed out after ${timeoutMs / 1000}s`
        finish(124)
      }, timeoutMs)
    }
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', (err) => { stderr += err.message; finish(127) })
    proc.on('close', (code) => finish(code ?? 1))
  })
}

async function gsutil(...args) {
  const r = await run('gsutil', args)
  if (r.code === 0) {
    log('gsutil', args.join(' '), 'ok')
    return true
  }
  log('gsutil', args.join(' '), 'failed:', r.stderr.trim().slice(0, 500))
  return false
}

function gcsUriFor(extra = {}) {
  const bucket = extra.s3_bucket || ''
  const path = extra.s3_path || ''
  if (!bucket || !path) return null
  return `gs://${bucket}/${path}/${ARCHIVE_NAME}`
}

/**
 * Materialise every `<NAME>_JSON` env var (a GCP service-account key passed
 * by value) to a temp file and point `<NAME>` at it, then activate gcloud with
 * GOOGLE_APPLICATION_CREDENTIALS so gsutil works for the workspace transfer.
 */
export async function activateGcloudServiceAccount(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.endsWith('_JSON') || !env[key]) continue
    const original = key.slice(0, -'_JSON'.length)
    try {
      const dir = await mkdtemp(join(tmpdir(), 'gcp-cred-'))
      const file = join(dir, `${original}.json`)
      await writeFile(file, env[key], { mode: 0o600 })
      env[original] = file
    } catch (err) {
      log(`failed to materialize ${key} to a temp file:`, err.message)
    }
  }
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS
  if (!keyFile) return false
  const r = await run('gcloud', ['auth', 'activate-service-account', `--key-file=${keyFile}`], { env, timeoutMs: 30_000 })
  if (r.code === 0) {
    log('gcloud service account activated')
    return true
  }
  log('gcloud activate-service-account failed:', r.stderr.trim().slice(0, 500))
  return false
}

/** Restore `workspaceDir` from `gs://<s3_bucket>/<s3_path>/workspace.tar.gz`. */
export async function downloadWorkspace(extra, workspaceDir) {
  const uri = gcsUriFor(extra)
  if (!uri) return false
  if (!(await gsutil('ls', uri))) {
    log('no workspace archive at', uri)
    return false
  }
  const tmp = await mkdtemp(join(tmpdir(), 'ws-restore-'))
  const archive = join(tmp, ARCHIVE_NAME)
  try {
    if (!(await gsutil('cp', uri, archive))) return false
    // Stale files from an earlier run on this pod must not survive a restore.
    await rm(workspaceDir, { recursive: true, force: true })
    await mkdir(workspaceDir, { recursive: true })
    const r = await run('tar', ['xzf', archive, '-C', workspaceDir])
    if (r.code !== 0) {
      log('workspace extract failed:', r.stderr.trim().slice(0, 500))
      return false
    }
    log('workspace restored from', uri)
    return true
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** Archive `workspaceDir` and upload it; resolves the gs:// URI or null. */
export async function uploadWorkspace(extra, workspaceDir) {
  const uri = gcsUriFor(extra)
  if (!uri) return null
  if (!existsSync(workspaceDir)) return null
  const tmp = await mkdtemp(join(tmpdir(), 'ws-upload-'))
  const archive = join(tmp, ARCHIVE_NAME)
  try {
    const r = await run('tar', ['czf', archive, '-C', workspaceDir, '.'])
    if (r.code !== 0) {
      log('workspace archive failed:', r.stderr.trim().slice(0, 500))
      return null
    }
    if (!(await gsutil('cp', archive, uri))) return null
    log('workspace uploaded to', uri)
    return uri
  } finally {
    await unlink(archive).catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Run each registered tool's `workspace_hook` once per top-level repo of the
 * workspace that holds its `requires_files`. Best effort: never throws.
 */
export async function runWorkspaceHooks(tools, workspaceDir) {
  let entries
  try {
    entries = await readdir(workspaceDir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(workspaceDir, e.name))
  const jobs = planWorkspaceHooks(tools, dirs)
  return Promise.all(jobs.map(async (job) => {
    const r = await run(job.command, job.args, { cwd: job.cwd, timeoutMs: job.timeoutMs })
    if (r.code === 0) log(`${job.command} workspace hook ok for ${job.cwd}`)
    else log(`${job.command} workspace hook exited ${r.code} for ${job.cwd}: ${r.stderr.trim().slice(0, 500)}`)
    return { ...job, code: r.code }
  }))
}
