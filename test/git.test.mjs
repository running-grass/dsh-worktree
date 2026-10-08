/**
 * The git layer against real throwaway repositories: repository detection,
 * branch reads, worktree creation with an explicit base, dirty detection, and
 * branch renaming.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  GitRunner,
  addWorktree,
  branchExists,
  currentBranch,
  defaultBranch,
  isDirty,
  isRepository,
  listBranches,
  listWorktrees,
  mainWorktreeRoot,
  parseWorktreeList,
  pruneWorktrees,
  removeWorktree,
  renameBranch,
  resolveGit,
  workTreeRoot,
} from '../git.js'
import { createRepository, createSubprocess, exists, removeDirectory, sh } from './helpers.mjs'

const LIMITS = { timeoutMs: 30_000, outputMaxBytes: 8 * 1024 * 1024 }

/** Resolve git and build a runner over the stub subprocess. */
async function runner() {
  const subprocess = createSubprocess()
  const executable = await resolveGit(subprocess, new AbortController().signal)
  assert.ok(executable, 'git must be installed for these tests')
  return new GitRunner(subprocess, executable, LIMITS)
}

test('resolveGit answers null when the executable cannot be resolved', async () => {
  const subprocess = { async resolveExecutable() { throw new Error('missing') } }
  assert.equal(await resolveGit(subprocess, new AbortController().signal), null)
})

test('parseWorktreeList reads porcelain output in git order', () => {
  const entries = parseWorktreeList([
    'worktree /src/project',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /home/me/.dsh/worktrees/project/fix-parser',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/fix/parser',
    '',
    'worktree /src/detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\n'))
  assert.deepEqual(entries.map(entry => [entry.path, entry.branch, entry.detached]), [
    ['/src/project', 'main', false],
    ['/home/me/.dsh/worktrees/project/fix-parser', 'fix/parser', false],
    ['/src/detached', null, true],
  ])
})

test('repository reads answer for a real repository', async (t) => {
  const repository = await createRepository()
  t.after(() => removeDirectory(repository))
  const git = await runner()
  const signal = new AbortController().signal

  assert.equal(await isRepository(git, repository, signal), true)
  assert.equal(await workTreeRoot(git, repository, signal), repository)
  assert.equal(await currentBranch(git, repository, signal), 'main')
  assert.equal(await defaultBranch(git, repository, signal), 'main')
  assert.equal(await mainWorktreeRoot(git, repository, signal), repository)
  assert.equal(await branchExists(git, repository, 'main', signal), true)
  assert.equal(await branchExists(git, repository, 'absent', signal), false)
  assert.equal(await isDirty(git, repository, signal), false)

  const branches = await listBranches(git, repository, signal)
  assert.deepEqual(branches.local, ['main'])
  assert.deepEqual(branches.remote, [])
})

test('repository reads answer for a directory outside any repository', async (t) => {
  const plain = await mkdtemp(join(tmpdir(), 'dsh-worktree-plain-'))
  t.after(() => removeDirectory(plain))
  const git = await runner()
  const signal = new AbortController().signal
  assert.equal(await isRepository(git, plain, signal), false)
  assert.equal(await isDirty(git, plain, signal), null)
})

test('addWorktree creates a worktree on an explicit base, and removeWorktree deletes it', async (t) => {
  const repository = await createRepository()
  t.after(() => removeDirectory(repository))
  const git = await runner()
  const signal = new AbortController().signal
  const directory = join(repository, '..', `wt-${process.pid}-basic`)

  // A second commit on `main` proves the start point is the named revision:
  // the new branch must carry the newer commit, not a stale HEAD of another
  // worktree.
  await writeFile(join(repository, 'second.txt'), 'second\n', 'utf8')
  sh('git', ['add', 'second.txt'], repository)
  sh('git', ['commit', '-m', 'second'], repository)

  await addWorktree(git, { repoRoot: repository, path: directory, branch: 'feature/one', base: 'main' }, signal)
  t.after(() => removeDirectory(directory))

  assert.equal(await currentBranch(git, directory, signal), 'feature/one')
  assert.equal(await exists(directory, 'second.txt'), true)

  const worktrees = await listWorktrees(git, repository, signal)
  assert.deepEqual(worktrees.map(entry => entry.path), [repository, directory])
  assert.equal(await mainWorktreeRoot(git, directory, signal), repository)

  await removeWorktree(git, { repoRoot: repository, path: directory }, signal)
  assert.equal(await exists(directory), false)
  assert.equal((await listWorktrees(git, repository, signal)).length, 1)
})

test('addWorktree rejects an unknown base revision', async (t) => {
  const repository = await createRepository()
  t.after(() => removeDirectory(repository))
  const git = await runner()
  const signal = new AbortController().signal
  await assert.rejects(
    addWorktree(git, {
      repoRoot: repository,
      path: join(repository, '..', `wt-${process.pid}-bad-base`),
      branch: 'feature/bad',
      base: 'no-such-revision',
    }, signal),
    /git worktree add -b feature\/bad failed/,
  )
})

test('removeWorktree refuses a dirty worktree without force', async (t) => {
  const repository = await createRepository()
  t.after(() => removeDirectory(repository))
  const git = await runner()
  const signal = new AbortController().signal
  const directory = join(repository, '..', `wt-${process.pid}-dirty`)
  await addWorktree(git, { repoRoot: repository, path: directory, branch: 'feature/dirty', base: 'main' }, signal)
  t.after(() => removeDirectory(directory))

  await writeFile(join(directory, 'untracked.txt'), 'x\n', 'utf8')
  assert.equal(await isDirty(git, directory, signal), true)
  await assert.rejects(
    removeWorktree(git, { repoRoot: repository, path: directory }, signal),
    /git worktree remove .* failed/,
  )
  await removeWorktree(git, { repoRoot: repository, path: directory, force: true }, signal)
  assert.equal(await exists(directory), false)
})

test('renameBranch renames the branch checked out in a worktree', async (t) => {
  const repository = await createRepository()
  t.after(() => removeDirectory(repository))
  const git = await runner()
  const signal = new AbortController().signal
  const directory = join(repository, '..', `wt-${process.pid}-rename`)
  await addWorktree(git, { repoRoot: repository, path: directory, branch: 'wip/1a2b3c4d', base: 'main' }, signal)
  t.after(() => removeDirectory(directory))

  await renameBranch(git, { path: directory, branch: 'fix-parser' }, signal)
  assert.equal(await currentBranch(git, directory, signal), 'fix-parser')
  const branches = await listBranches(git, repository, signal)
  assert.deepEqual(branches.local.sort(), ['fix-parser', 'main'])
})

test('pruneWorktrees drops administration for a directory removed outside git', async (t) => {
  const repository = await createRepository()
  t.after(() => removeDirectory(repository))
  const git = await runner()
  const signal = new AbortController().signal
  const directory = join(repository, '..', `wt-${process.pid}-prune`)
  await addWorktree(git, { repoRoot: repository, path: directory, branch: 'wip/prune', base: 'main' }, signal)
  await removeDirectory(directory)

  await pruneWorktrees(git, repository, signal)
  assert.equal((await listWorktrees(git, repository, signal)).length, 1)
})