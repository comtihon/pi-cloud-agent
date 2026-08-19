// Tests for bin/git-credential-env, the git credential helper.
//
// git installs it via `credential.helper env` and speaks the credential
// protocol on stdin. It answers from the environment, per host, so that:
//   - no forge is hardcoded — a granted tool just sets the matching variable,
//   - no token is written to disk or passed on a command line,
//   - a tool that was not granted has no variable, so access is simply absent.
// The host comes from git and reflects a remote URL, so it is untrusted input:
// it must never be able to influence what the helper executes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'git-credential-env')

/** Run the helper for `host` with exactly `env` set, as git would. */
function ask(host, env = {}) {
  const r = spawnSync(HELPER, ['get'], {
    input: `protocol=https\nhost=${host}\n\n`,
    env,
    encoding: 'utf-8',
  })
  const fields = {}
  for (const line of r.stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return { status: r.status, fields, stdout: r.stdout }
}

test('the helper ships executable (git must be able to run it)', () => {
  assert.equal(statSync(HELPER).mode & 0o111, 0o111)
})

test('a host-specific token is used, with the default token username', () => {
  const { fields } = ask('example.com', { GIT_TOKEN_EXAMPLE_COM: 'tok' })
  assert.deepEqual(fields, { username: 'x-access-token', password: 'tok' })
})

test('a host-independent GIT_TOKEN is the fallback', () => {
  assert.equal(ask('example.com', { GIT_TOKEN: 'generic' }).fields.password, 'generic')
})

test('the host-specific token wins over the generic one', () => {
  const env = { GIT_TOKEN: 'generic', GIT_TOKEN_EXAMPLE_COM: 'specific' }
  assert.equal(ask('example.com', env).fields.password, 'specific')
})

test('a token for another host is not offered', () => {
  // Credentials granted for one code host must not authenticate to another.
  const { status, stdout } = ask('other.example', { GIT_TOKEN_EXAMPLE_COM: 'tok' })
  assert.equal(stdout, '')
  assert.equal(status, 0)
})

test('the username is overridable per host and globally', () => {
  assert.equal(
    ask('code.example.org', { GIT_TOKEN_CODE_EXAMPLE_ORG: 't', GIT_USERNAME_CODE_EXAMPLE_ORG: 'alice' }).fields.username,
    'alice',
  )
  assert.equal(ask('example.com', { GIT_TOKEN: 't', GIT_USERNAME: 'bob' }).fields.username, 'bob')
})

test('a port in the host is part of the variable name', () => {
  assert.equal(ask('example.com:8443', { GIT_TOKEN_EXAMPLE_COM_8443: 'ported' }).fields.password, 'ported')
})

test('no token configured → silence and a clean exit, never a prompt', () => {
  // This is what revocation looks like: the variable is gone, so the helper
  // declines. It must not fail, or git turns the failure into an error.
  const { status, stdout } = ask('example.com', {})
  assert.equal(stdout, '')
  assert.equal(status, 0)
})

test('an empty token is treated as not configured', () => {
  assert.equal(ask('example.com', { GIT_TOKEN_EXAMPLE_COM: '', GIT_TOKEN: 'real' }).fields.password, 'real')
  assert.equal(ask('example.com', { GIT_TOKEN: '' }).stdout, '')
})

test('a hostile host name cannot inject a command', () => {
  // The host is reduced to [A-Z0-9_] before it is ever expanded, so shell
  // metacharacters in a remote URL are inert.
  for (const host of [
    'a;touch /tmp/pi-cred-pwned;b.com',
    '$(touch /tmp/pi-cred-pwned)',
    '`touch /tmp/pi-cred-pwned`',
    'a"; touch /tmp/pi-cred-pwned; "b',
  ]) {
    const { status } = ask(host, { GIT_TOKEN: 'tok' })
    assert.equal(status, 0)
  }
  assert.throws(() => statSync('/tmp/pi-cred-pwned'), 'helper executed an injected command')
})

test('only the first blank-line-terminated request block is read', () => {
  // git may keep the pipe open; the helper must stop at the blank line rather
  // than letting later input change which host it answers for.
  const r = spawnSync(HELPER, ['get'], {
    input: 'protocol=https\nhost=example.com\n\nhost=evil.example\n',
    env: { GIT_TOKEN_EXAMPLE_COM: 'right', GIT_TOKEN_EVIL_EXAMPLE: 'wrong' },
    encoding: 'utf-8',
  })
  assert.match(r.stdout, /password=right/)
  assert.doesNotMatch(r.stdout, /wrong/)
})
