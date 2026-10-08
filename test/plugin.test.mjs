/**
 * The worktree service against real repositories and a duck-typed context:
 * creation, registration, listing, the title-driven branch rename, removal
 * admission, and state reconciliation.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { WorktreeService } from '../service.js'
import { createContext, createRepository, exists, removeDirectory } from './helpers.mjs'

/** Build a service over a fresh repository, an empty worktrees root, and a stub registry. */
async function setup({ activities } = {}) {
  const repository = await createRepository()
  const worktreesRoot = await mkdtemp(join(tmpdir(), 'dsh-worktree-root-'))
  const stateFile = join(worktreesRoot, 'worktree.state.json')
  const ctx = createContext(activities === undefined ? {} : { activities })
  const parent = await ctx.workspaceRegistry.create(repository, 'project')
  const service = new WorktreeService(ctx, {
    worktreesRoot,
    stateFile,
    timeoutMs: 30_000,
    outputMaxBytes: 8 * 1024 * 1024,
    logger: { warn() {} },
  })
  await service.ready
  return {
    repository,
    worktreesRoot,
    stateFile,
    ctx,
    parent,
    service,
    async cleanup() {
      await service.dispose()
      await removeDirectory(repository)
      await removeDirectory(worktreesRoot)
    },
  }
}

test('status reports the repository of a plain workspace', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const status = await fixture.service.status({ workspaceId: String(fixture.parent.id) })
  assert.deepEqual(status, {
    git: true,
    repoRoot: fixture.repository,
    mainRoot: fixture.repository,
    branch: 'main',
    isWorktree: false,
    dirty: false,
  })
})

test('branches lists locals and resolves the default branch', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const branches = await fixture.service.branches({ workspaceId: String(fixture.parent.id) })
  assert.equal(branches.current, 'main')
  assert.equal(branches.default, 'main')
  assert.deepEqual(branches.local, ['main'])
  assert.deepEqual(branches.remote, [])
})

test('status and branches answer inert outside a git repository', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const plain = await mkdtemp(join(tmpdir(), 'dsh-worktree-plain-'))
  t.after(() => removeDirectory(plain))
  const workspace = await fixture.ctx.workspaceRegistry.create(plain, 'plain')

  assert.deepEqual(await fixture.service.status({ workspaceId: String(workspace.id) }), {
    git: false, repoRoot: null, mainRoot: null, branch: null, isWorktree: false, dirty: null,
  })
  assert.deepEqual(await fixture.service.branches({ workspaceId: String(workspace.id) }), {
    current: null, default: null, local: [], remote: [],
  })
  await assert.rejects(
    fixture.service.create({ workspaceId: String(workspace.id) }),
    /is not inside a git repository/,
  )
})

test('create makes a worktree on a placeholder branch and registers it', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })

  assert.match(created.branch, /^wip\/[0-9a-f]{8}$/)
  assert.equal(
    created.path,
    join(fixture.worktreesRoot, fixture.repository.split('/').pop(), created.branch.replace('/', '-')),
  )
  assert.equal(await exists(created.path, 'README.md'), true)

  const workspace = fixture.ctx.workspaceRegistry.get(created.workspaceId)
  assert.equal(workspace.title, created.branch)
  assert.equal(workspace.path, created.path)

  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.worktrees[created.workspaceId].provisional, true)
  assert.equal(stored.worktrees[created.workspaceId].repoRoot, fixture.repository)
  assert.equal(stored.worktrees[created.workspaceId].branch, created.branch)
})

test('create honours an explicit base revision and rejects an unknown one', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({
    workspaceId: String(fixture.parent.id),
    baseBranch: 'main',
  })
  assert.equal(await exists(created.path, 'README.md'), true)
  await assert.rejects(
    fixture.service.create({ workspaceId: String(fixture.parent.id), baseBranch: 'absent' }),
    /base revision 'absent' does not exist/,
  )
})

test('create refuses a worktree of a worktree', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  await assert.rejects(
    fixture.service.create({ workspaceId: created.workspaceId }),
    /already a worktree; only one worktree level is supported/,
  )
})

test('status marks a created worktree and list joins git with the registry', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })

  const status = await fixture.service.status({ workspaceId: created.workspaceId })
  assert.equal(status.git, true)
  assert.equal(status.isWorktree, true)
  assert.equal(status.branch, created.branch)

  const listed = await fixture.service.list({ workspaceId: String(fixture.parent.id) })
  assert.equal(listed.worktrees.length, 2)
  const [main, worktree] = listed.worktrees
  assert.equal(main.path, fixture.repository)
  assert.equal(main.main, true)
  assert.equal(main.workspaceId, String(fixture.parent.id))
  assert.equal(worktree.path, created.path)
  assert.equal(worktree.main, false)
  assert.equal(worktree.workspaceId, created.workspaceId)
  assert.equal(worktree.branch, created.branch)
  assert.equal(worktree.registered, true)
  assert.equal(worktree.sessionCount, 0)
})

test('renameBranch renames the branch, the record, and the workspace title', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })

  const renamed = await fixture.service.renameBranch({ workspaceId: created.workspaceId, branch: 'fix/parser' })
  assert.equal(renamed.branch, 'fix/parser')
  assert.equal(fixture.ctx.workspaceRegistry.get(created.workspaceId).title, 'fix/parser')
  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.equal(stored.worktrees[created.workspaceId].branch, 'fix/parser')
  assert.equal(stored.worktrees[created.workspaceId].provisional, false)
  assert.equal((await fixture.service.status({ workspaceId: created.workspaceId })).branch, 'fix/parser')
})

test('renameBranch disambiguates and refuses a blank name', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  await assert.rejects(
    fixture.service.renameBranch({ workspaceId: created.workspaceId, branch: '   ' }),
    /a branch name is required/,
  )
  const first = await fixture.service.renameBranch({ workspaceId: created.workspaceId, branch: 'main' })
  // `main` is taken by the repository, so the first free suffix wins.
  assert.equal(first.branch, 'main-2')
  const second = await fixture.service.renameBranch({ workspaceId: created.workspaceId, branch: 'main' })
  assert.equal(second.branch, 'main-2')
})

test('the generated session title renames a placeholder branch', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  fixture.ctx.sessionProjections = { stateOf: () => 'Fix the Parser Bug!' }

  await fixture.service.onSessionEvent({ header: { cwd: created.path } })
  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.equal(stored.worktrees[created.workspaceId].branch, 'fix-the-parser-bug')
  assert.equal(stored.worktrees[created.workspaceId].provisional, false)
  assert.equal((await fixture.service.status({ workspaceId: created.workspaceId })).branch, 'fix-the-parser-bug')
})

test('a title with no ASCII slug leaves the placeholder branch alone', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  const warnings = []
  fixture.service.logger = { warn: message => warnings.push(String(message)) }
  fixture.ctx.sessionProjections = { stateOf: () => '修复解析器' }

  await fixture.service.onSessionEvent({ header: { cwd: created.path } })
  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.equal(stored.worktrees[created.workspaceId].branch, created.branch)
  assert.equal(stored.worktrees[created.workspaceId].provisional, true)
  assert.ok(warnings.some(message => message.includes('no ASCII slug')))
})

test('the title watcher ignores unrelated sessions and unreadable titles', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  fixture.ctx.sessionProjections = { stateOf: () => null }

  await fixture.service.onSessionEvent({ header: { cwd: created.path } })
  await fixture.service.onSessionEvent({ header: { cwd: '/somewhere/else' } })
  await fixture.service.onSessionEvent({ header: {} })
  await fixture.service.onSessionEvent({})

  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.equal(stored.worktrees[created.workspaceId].branch, created.branch)
})

test('remove deletes the worktree, its registration, and its record', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  const removed = await fixture.service.remove({ workspaceId: created.workspaceId })
  assert.deepEqual(removed, { removed: true })
  assert.equal(await exists(created.path), false)
  assert.equal(fixture.ctx.workspaceRegistry.get(created.workspaceId), undefined)
  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.deepEqual(stored.worktrees, {})
  assert.equal((await fixture.service.list({ workspaceId: String(fixture.parent.id) })).worktrees.length, 1)
})

test('remove refuses a worktree whose session still reports running work unless forced', async (t) => {
  const fixture = await setup({ activities: sessionId => (sessionId === 's-busy' ? [{ kind: 'turn' }] : []) })
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  await fixture.ctx.workspaceRegistry.get(created.workspaceId).attachSession('s-busy')

  await assert.rejects(
    fixture.service.remove({ workspaceId: created.workspaceId }),
    /still has 1 session\(s\) with running work/,
  )
  assert.deepEqual(
    await fixture.service.remove({ workspaceId: created.workspaceId, force: true }),
    { removed: true },
  )
})

test('remove refuses a workspace this plugin did not create', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  await assert.rejects(
    fixture.service.remove({ workspaceId: String(fixture.parent.id) }),
    /is not a worktree created by this plugin/,
  )
})

test('remove tolerates a worktree directory deleted outside git', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  await removeDirectory(created.path)
  assert.deepEqual(await fixture.service.remove({ workspaceId: created.workspaceId }), { removed: true })
  assert.equal((await fixture.service.list({ workspaceId: String(fixture.parent.id) })).worktrees.length, 1)
})

test('prune reports whether a repository was pruned', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  assert.deepEqual(
    await fixture.service.prune({ workspaceId: String(fixture.parent.id) }),
    { pruned: true },
  )
  const plain = await mkdtemp(join(tmpdir(), 'dsh-worktree-plain-'))
  t.after(() => removeDirectory(plain))
  const workspace = await fixture.ctx.workspaceRegistry.create(plain, 'plain')
  assert.deepEqual(await fixture.service.prune({ workspaceId: String(workspace.id) }), { pruned: false })
})

test('a restart drops records whose workspace registration is gone', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const created = await fixture.service.create({ workspaceId: String(fixture.parent.id) })
  await fixture.ctx.workspaceRegistry.delete(created.workspaceId)

  const restarted = new WorktreeService(fixture.ctx, {
    worktreesRoot: fixture.worktreesRoot,
    stateFile: fixture.stateFile,
    timeoutMs: 30_000,
    outputMaxBytes: 8 * 1024 * 1024,
    logger: { warn() {} },
  })
  await restarted.ready
  const stored = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.deepEqual(stored.worktrees, {})
  await restarted.dispose()
})

test('an unknown workspace id fails loudly on every verb', async (t) => {
  const fixture = await setup()
  t.after(() => fixture.cleanup())
  const missing = { workspaceId: 'ws-absent' }
  await assert.rejects(fixture.service.status(missing), /is not registered/)
  await assert.rejects(fixture.service.branches(missing), /is not registered/)
  await assert.rejects(fixture.service.list(missing), /is not registered/)
  await assert.rejects(fixture.service.prune(missing), /is not registered/)
  await assert.rejects(fixture.service.create(missing), /is not registered/)
  await assert.rejects(fixture.service.remove(missing), /is not registered/)
  await assert.rejects(fixture.service.renameBranch({ ...missing, branch: 'x' }), /is not registered/)
})