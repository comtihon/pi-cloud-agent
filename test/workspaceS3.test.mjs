// Unit test for downloadWorkspace()'s stale-file cleanup (Bug 4 fix).
// Uses only Node's built-in test runner + assert module — no new
// dependencies, no mocking framework — matching runner_format.test.mjs.
//
// downloadWorkspace() shells out to the real `gsutil` binary directly (no
// injectable exec function). Since there's no real GCS access here, we
// intercept `gsutil` by prepending a temp directory containing a fake
// `gsutil` shell script to PATH for the duration of the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadWorkspace } from '../src/workspaceS3.js'

test('downloadWorkspace clears stale local files before extracting the archive', () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'workspace-'))
  const fixtureDir = mkdtempSync(join(tmpdir(), 'fixture-'))
  const binDir = mkdtempSync(join(tmpdir(), 'fakebin-'))

  const originalPath = process.env.PATH

  try {
    // Simulate leftover state from a prior call on this pod.
    writeFileSync(join(workspaceDir, 'stale.txt'), 'old content')

    // Build a real fixture tarball containing only keep.txt — the "real"
    // S3 snapshot, distinct from what's locally present.
    writeFileSync(join(fixtureDir, 'keep.txt'), 'fresh content')
    const fixtureArchive = join(fixtureDir, 'workspace.tar.gz')
    execSync(`tar czf ${fixtureArchive} -C ${fixtureDir} keep.txt`, { stdio: 'pipe' })

    // Fake `gsutil`: `ls` succeeds (archive exists), `cp` copies the fixture
    // archive to the requested local destination instead of hitting GCS.
    const gsutilScript = `#!/bin/sh
if [ "$1" = "ls" ]; then
  exit 0
elif [ "$1" = "cp" ]; then
  cp "${fixtureArchive}" "$3"
  exit 0
else
  exit 1
fi
`
    const gsutilPath = join(binDir, 'gsutil')
    writeFileSync(gsutilPath, gsutilScript)
    chmodSync(gsutilPath, 0o755)

    process.env.PATH = `${binDir}:${originalPath}`

    const ok = downloadWorkspace({ s3_bucket: 'fake-bucket', s3_path: 'fake-path' }, workspaceDir)

    assert.equal(ok, true)
    assert.equal(existsSync(join(workspaceDir, 'stale.txt')), false)
    assert.equal(existsSync(join(workspaceDir, 'keep.txt')), true)
    assert.equal(readFileSync(join(workspaceDir, 'keep.txt'), 'utf8'), 'fresh content')
  } finally {
    process.env.PATH = originalPath
    rmSync(workspaceDir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
})

// Regression: the bucket/path in `extra` come straight off the /start request
// payload. They used to be joined into a shell string, so a bucket containing
// shell metacharacters executed. execFileSync passes an argv array instead, so
// the metacharacters must reach gsutil as literal argument text.
test('downloadWorkspace does not let a malicious bucket name reach a shell', () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'workspace-'))
  const binDir = mkdtempSync(join(tmpdir(), 'fakebin-'))
  const canary = join(mkdtempSync(join(tmpdir(), 'canary-')), 'pwned')
  const argLog = join(binDir, 'args.log')

  const originalPath = process.env.PATH
  try {
    // Fake gsutil records the argv it was handed, then fails so the caller
    // stops early. If a shell ever interprets the bucket, the canary appears.
    const fakeGsutil = join(binDir, 'gsutil')
    writeFileSync(fakeGsutil, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argLog}\nexit 1\n`)
    chmodSync(fakeGsutil, 0o755)
    process.env.PATH = `${binDir}:${originalPath}`

    const malicious = `bkt; touch ${canary}; #`
    const result = downloadWorkspace({ s3_bucket: malicious, s3_path: 'p' }, workspaceDir)

    assert.equal(result, false, 'the fake gsutil fails, so restore reports failure')
    assert.equal(existsSync(canary), false, 'injected command must never run')

    // The metacharacters must have arrived as one literal argument.
    const args = readFileSync(argLog, 'utf-8').split('\n').filter(Boolean)
    assert.ok(
      args.some((a) => a === `gs://${malicious}/p/workspace.tar.gz`),
      `bucket must reach gsutil verbatim as a single argv entry, got: ${JSON.stringify(args)}`,
    )
  } finally {
    process.env.PATH = originalPath
    rmSync(workspaceDir, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
})
