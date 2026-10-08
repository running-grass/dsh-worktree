/**
 * The packaging contract: the bundle patch row, the loader-facing manifest
 * fields, and the published file set. The patch is small and fixed, so it is
 * asserted as text rather than pulled through a YAML dependency.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

test('the bundle patch declares exactly one worktree row', async () => {
  const patch = await read('cordis.patch.yml')
  const ids = [...patch.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map(match => match[1])
  assert.deepEqual(ids, ['worktree'])
  assert.match(patch, /^\s*name:\s*dsh-worktree\s*$/m)
  assert.match(patch, /^\s*timeoutMs:\s*30000\s*$/m)
  assert.match(patch, /^\s*outputMaxBytes:\s*8388608\s*$/m)
  // The worktrees root is deliberately not pinned here: the plugin defaults it
  // to $DSH_HOME/worktrees. Only the config key matters, not the prose above.
  assert.doesNotMatch(patch, /^\s*worktreesRoot:/m)
})

test('the manifest wires the loader to the host entry, the client half, and the Typert face', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.equal(manifest.name, 'dsh-worktree')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './index.js')
  assert.deepEqual(manifest.exports['.'], './index.js')
  assert.deepEqual(manifest.exports['./client'], './client.js')
  assert.deepEqual(manifest.exports['./typert'], './typert.host.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.equal(manifest.scripts.test, 'node --test "test/*.test.mjs"')
})

test('every published runtime file is listed', async () => {
  const manifest = JSON.parse(await read('package.json'))
  for (const name of [
    'index.js', 'service.js', 'git.js', 'branch.js', 'state.js',
    'typert.host.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE',
  ]) {
    assert.ok(manifest.files.includes(name), `${name} must be published`)
  }
})

test('the host manifest and the service expose the same Remote methods', async () => {
  const { TYPERT } = await import('../typert.host.js')
  assert.equal(TYPERT.package, 'dsh-worktree')
  assert.equal(TYPERT.face, 'host')
  const methods = TYPERT.invocations.map(invocation => invocation.method)
  assert.deepEqual(methods, ['status', 'list', 'branches', 'create', 'remove', 'prune', 'renameBranch'])
  for (const invocation of TYPERT.invocations) {
    assert.equal(invocation.service, 'worktree')
    assert.equal(invocation.namespace, 'worktree')
    assert.equal(invocation.invocation.kind, 'direct')
    assert.equal(invocation.id, `dsh-worktree#worktree/${invocation.method}`)
    assert.equal(invocation.parameters.length, 1)
    assert.equal(invocation.parameters[0].name, 'request')
    assert.equal(invocation.result.mode, 'strict')
    assert.equal(typeof invocation.result.create, 'function')
    assert.equal(typeof invocation.result.schema.parse, 'function')
  }
})