/**
 * The state document: tolerant parsing, pruning, and the atomic write.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { STATE_VERSION, emptyState, parseState, pruneState, readState, writeState } from '../state.js'

const entry = {
  path: '/home/me/.dsh/worktrees/project/wip-1a2b3c4d',
  repoRoot: '/src/project',
  branch: 'wip/1a2b3c4d',
  provisional: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

test('emptyState carries the current version and no entries', () => {
  assert.deepEqual(emptyState(), { version: STATE_VERSION, worktrees: {} })
})

test('parseState reads a well-formed document', () => {
  const parsed = parseState(JSON.stringify({ version: STATE_VERSION, worktrees: { 'ws-1': entry } }))
  assert.deepEqual(parsed.worktrees['ws-1'], entry)
})

test('parseState tolerates malformed input and unknown versions', () => {
  assert.deepEqual(parseState('not json'), emptyState())
  assert.deepEqual(parseState('null'), emptyState())
  assert.deepEqual(parseState('[]'), emptyState())
  assert.deepEqual(parseState(JSON.stringify({ version: 99, worktrees: { 'ws-1': entry } })), emptyState())
  assert.deepEqual(parseState(JSON.stringify({ version: STATE_VERSION, worktrees: [] })), emptyState())
})

test('parseState drops entries that do not match the record schema', () => {
  const parsed = parseState(JSON.stringify({
    version: STATE_VERSION,
    worktrees: {
      good: entry,
      'no-path': { repoRoot: '/src/project', branch: 'x' },
      'empty-path': { ...entry, path: '' },
      'no-branch': { path: '/x', repoRoot: '/src/project' },
      nullish: null,
      array: [],
    },
  }))
  assert.deepEqual(Object.keys(parsed.worktrees), ['good'])
})

test('parseState defaults a missing createdAt and a non-boolean provisional', () => {
  const parsed = parseState(JSON.stringify({
    version: STATE_VERSION,
    worktrees: { 'ws-1': { path: '/x', repoRoot: '/src', branch: 'b', provisional: 'yes' } },
  }))
  assert.equal(parsed.worktrees['ws-1'].provisional, false)
  assert.equal(parsed.worktrees['ws-1'].createdAt, new Date(0).toISOString())
})

test('pruneState keeps only entries the predicate accepts', () => {
  const state = { version: STATE_VERSION, worktrees: { a: entry, b: entry, c: entry } }
  const pruned = pruneState(state, workspaceId => workspaceId !== 'b')
  assert.deepEqual(Object.keys(pruned.worktrees), ['a', 'c'])
  assert.deepEqual(Object.keys(state.worktrees), ['a', 'b', 'c'])
})

test('readState reads a missing file as empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-worktree-state-'))
  try {
    assert.deepEqual(await readState(join(directory, 'absent.json')), emptyState())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writeState round-trips and leaves no temporary file behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-worktree-state-'))
  const file = join(directory, 'nested', 'worktree.state.json')
  try {
    await writeState(file, { version: STATE_VERSION, worktrees: { 'ws-1': entry } })
    assert.deepEqual(await readState(file), { version: STATE_VERSION, worktrees: { 'ws-1': entry } })
    const leftovers = (await readdir(join(directory, 'nested'))).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})