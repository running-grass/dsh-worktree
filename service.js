/**
 * The git-worktree service: all of dsh-worktree's behaviour, with no import
 * from DSH and no cordis base class, so `node --test` can drive it with a
 * duck-typed context. `index.js` wraps this class in the Cordis plugin and
 * Typert Remote surface.
 *
 * Responsibilities:
 *
 *   1. Create git worktrees below `$DSH_HOME/worktrees/<repo>/<branch>` with
 *      an explicit base revision — never the main worktree's checked-out HEAD.
 *   2. Register each new directory as a real Workspace through the registry, so
 *      the session that runs there is accounted normally. That registration is
 *      what makes this plugin usable without a change inside DSH itself.
 *   3. Record what it created, because the targeted DSH Workspace registry
 *      carries no worktree flag. Git and the registry outrank that record.
 *   4. Rename a worktree's placeholder branch once DSH has generated a title
 *      for the worktree's first session, because the title is the naming source
 *      and it does not exist at creation time.
 *
 * @module dsh-worktree/service
 */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'

import {
  GitRunner,
  addWorktree,
  currentBranch,
  defaultBranch,
  isDirty,
  isRepository,
  listBranches,
  listWorktrees,
  mainWorktreeRoot,
  pruneWorktrees,
  removeWorktree,
  renameBranch as renameWorktreeBranch,
  resolveGit,
  workTreeRoot,
} from './git.js'
import {
  disambiguate,
  isProvisionalBranch,
  provisionalBranch,
  repoDirSegment,
  slugifyTitle,
  worktreeDirectory,
} from './branch.js'
import { emptyState, pruneState, readState, writeState } from './state.js'

/** Projection key DSH's session-title service publishes into. */
const TITLE_PROJECTION = 'title'

/** Whether a path currently is a directory. */
async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The worktree service. Every git command and every registry write passes
 * through one serial queue, so two concurrent creations cannot race on the same
 * placeholder branch or directory.
 */
export class WorktreeService {
  /**
   * @param {object} ctx - host context carrying `subprocess` and `workspaceRegistry`.
   * @param {{worktreesRoot: string, stateFile: string, timeoutMs: number, outputMaxBytes: number, logger?: object}} options - resolved deployment facts.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.logger = options.logger ?? ctx.logger ?? console
    this.worktreesRoot = options.worktreesRoot
    this.stateFile = options.stateFile
    this.limits = { timeoutMs: options.timeoutMs, outputMaxBytes: options.outputMaxBytes }

    this.state = emptyState()
    /** Worktree workspace id by canonical Workspace path, for the event hot path. */
    this.pathIndex = new Map()
    this.git = null
    this.jobTail = Promise.resolve()
    this.lifetime = new AbortController()
    this.ready = this.start()
  }

  // ---- startup -------------------------------------------------------------

  /** Resolve git, load state, reconcile it, and arm the title watcher. */
  async start() {
    try {
      const executable = await resolveGit(this.ctx.subprocess, this.lifetime.signal)
      if (executable === null) {
        this.logger.warn?.('dsh-worktree: git is unavailable, so the worktree surface stays inert')
        return
      }
      this.git = new GitRunner(this.ctx.subprocess, executable, this.limits)
      this.state = await readState(this.stateFile)
      await this.reconcile()
      this.installTitleWatcher()
    } catch (error) {
      this.logger.warn?.(`dsh-worktree: start failed: ${String(error)}`)
    }
  }

  /** Stop the lifetime and wait for the startup probe. */
  async dispose() {
    this.lifetime.abort(new Error('dsh-worktree disposed'))
    await this.ready.catch(() => {})
  }

  /** Drop state entries whose Workspace registration or directory is gone. */
  async reconcile() {
    const registered = new Set(this.ctx.workspaceRegistry.list().map(workspace => String(workspace.id)))
    const keep = new Set()
    for (const [workspaceId, entry] of Object.entries(this.state.worktrees)) {
      if (!registered.has(workspaceId)) continue
      if (!await directoryExists(entry.path)) continue
      keep.add(workspaceId)
    }
    const kept = pruneState(this.state, workspaceId => keep.has(workspaceId))
    if (Object.keys(kept.worktrees).length !== Object.keys(this.state.worktrees).length) {
      this.state = kept
      await this.persist()
    }
    this.refreshPathIndex()
  }

  /**
   * Rebuild the canonical-path index. The registry's path is canonicalized,
   * which is the spelling a session header carries.
   */
  refreshPathIndex() {
    const index = new Map()
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      const workspaceId = String(workspace.id)
      if (this.state.worktrees[workspaceId] !== undefined) index.set(workspace.path, workspaceId)
    }
    this.pathIndex = index
  }

  /**
   * Rename a worktree branch once its session's title is known. Installed only
   * when the session-projection registry is composed; without it DSH generates
   * no title this service can read, and the placeholder branch stays.
   */
  installTitleWatcher() {
    this.ctx.inject?.('sessionProjections', (scope) => {
      scope.on('session/event', (session) => { this.onSessionEvent(session) })
    })
  }

  /**
   * Hot path: one synchronous index lookup gates every asynchronous rename, so
   * an unrelated session event costs a map miss.
   * @param {object} session - the session that logged the event.
   */
  onSessionEvent(session) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    const workspaceId = this.pathIndex.get(cwd)
    if (workspaceId === undefined) return
    const record = this.worktreeRecord(workspaceId)
    if (record === undefined || !isProvisionalBranch(record.branch)) return
    const title = this.readTitle(session)
    if (title === null) return
    const slug = slugifyTitle(title)
    if (slug === '') {
      this.logger.warn?.(
        `dsh-worktree: workspace '${workspaceId}' keeps provisional branch '${record.branch}': `
        + 'the generated session title yields no ASCII slug',
      )
      return
    }
    // Returned rather than swallowed so tests can await the rename; the event
    // listener that calls this ignores the result, and the rename never rejects.
    return this.renameFromTitle(workspaceId, slug)
  }

  /** The generated session title from DSH's title projection, or null. */
  readTitle(session) {
    try {
      const state = this.ctx.sessionProjections?.stateOf?.(session, TITLE_PROJECTION)
      return typeof state === 'string' && state !== '' ? state : null
    } catch {
      return null
    }
  }

  /**
   * Rename one worktree's placeholder branch to `slug`, disambiguated against
   * the repository's other branches, and retitle its Workspace to match. A
   * failure is logged and never reaches the session.
   *
   * @param {string} workspaceId - worktree Workspace identity.
   * @param {string} slug - desired branch slug.
   * @returns {Promise<void>} resolution after the rename settled.
   */
  async renameFromTitle(workspaceId, slug) {
    try {
      await this.enqueue(async () => {
        const git = await this.runner()
        const signal = this.lifetime.signal
        // Re-read inside the queue: another queued job may have renamed first.
        const record = this.worktreeRecord(workspaceId)
        if (record === undefined || !isProvisionalBranch(record.branch)) return
        const workspace = this.ctx.workspaceRegistry.get(workspaceId)
        if (workspace === undefined) return
        const taken = await this.takenBranches(git, record.repoRoot, signal)
        taken.delete(record.branch)
        const target = disambiguate(slug, taken)
        if (target !== record.branch) {
          await renameWorktreeBranch(git, { path: record.path, branch: target }, signal)
        }
        this.setRecord(workspaceId, { ...record, branch: target, provisional: false })
        await this.persist()
        this.refreshPathIndex()
        if (workspace.title !== target) await workspace.setTitle(target)
      })
    } catch (error) {
      this.logger.warn?.(`dsh-worktree: renaming the branch of workspace '${workspaceId}' failed: ${String(error)}`)
    }
  }

  // ---- queue and state -----------------------------------------------------

  /** Resolve the git runner once startup settled, or fail loudly. */
  async runner() {
    await this.ready
    if (this.git === null) throw new Error('git is unavailable in this deployment')
    return this.git
  }

  /** One registry workspace by id, or a clear failure. */
  workspace(workspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error(`workspace '${workspaceId}' is not registered`)
    return workspace
  }

  /** The state entry recording this Workspace as a plugin-created worktree. */
  worktreeRecord(workspaceId) {
    return this.state.worktrees[workspaceId]
  }

  setRecord(workspaceId, entry) {
    this.state = { version: this.state.version, worktrees: { ...this.state.worktrees, [workspaceId]: entry } }
  }

  dropRecord(workspaceId) {
    const worktrees = { ...this.state.worktrees }
    delete worktrees[workspaceId]
    this.state = { version: this.state.version, worktrees }
  }

  persist() {
    return writeState(this.stateFile, this.state)
  }

  /**
   * Serialize one job behind every earlier job.
   * @param {() => Promise<unknown>} job - the operation to run.
   * @returns {Promise<unknown>} the job's result.
   */
  enqueue(job) {
    const result = this.jobTail.then(job, job)
    this.jobTail = result.then(() => undefined, () => undefined)
    return result
  }

  // ---- git helpers ---------------------------------------------------------

  /** Every local and remote branch short name, for collision checks. */
  async takenBranches(git, cwd, signal) {
    const names = await listBranches(git, cwd, signal)
    const taken = new Set(names.local)
    for (const remote of names.remote) {
      const short = remote.replace(/^[^/]+\//, '')
      if (short !== '') taken.add(short)
    }
    return taken
  }

  /** Whether a revision resolves to a commit. */
  async revisionExists(git, cwd, revision, signal) {
    const result = await git.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd, signal })
    return result.exitCode === 0
  }

  /**
   * The base revision for a new worktree: the caller's explicit choice when
   * given, otherwise the repository's default branch. `HEAD` is a last resort
   * for a repository whose default branch cannot be resolved.
   */
  async resolveBase(git, cwd, requested, signal) {
    if (typeof requested === 'string' && requested.trim() !== '') {
      const base = requested.trim()
      if (!await this.revisionExists(git, cwd, base, signal)) {
        throw new Error(`base revision '${base}' does not exist in this repository`)
      }
      return base
    }
    return await defaultBranch(git, cwd, signal) ?? 'HEAD'
  }

  /** Repository directory segments other repositories already claimed. */
  repoRootsInUse(mainRoot) {
    const segments = new Set()
    for (const record of Object.values(this.state.worktrees)) {
      if (record.repoRoot === mainRoot) continue
      segments.add(repoDirSegment(record.repoRoot))
    }
    return segments
  }

  /** Sessions of one Workspace that still report running work. */
  async activeSessions(workspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) return []
    const active = []
    for (const sessionId of workspace.sessionIds) {
      const activity = await this.ctx.waterfall(
        'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
      )
      if (activity.length > 0) active.push({ sessionId, activity })
    }
    return active
  }

  // ---- Remote surface ------------------------------------------------------

  /**
   * Git state of the repository a Workspace lives in. `isWorktree` is true when
   * the Workspace directory is a linked worktree rather than the repository's
   * main working tree.
   *
   * @param {{workspaceId: string}} request - Workspace whose repository is read.
   * @returns {Promise<object>} repository and branch facts.
   */
  async status(request) {
    const git = await this.runner()
    const signal = this.lifetime.signal
    const workspace = this.workspace(request.workspaceId)
    if (!await isRepository(git, workspace.path, signal)) {
      return { git: false, repoRoot: null, mainRoot: null, branch: null, isWorktree: false, dirty: null }
    }
    const root = await workTreeRoot(git, workspace.path, signal)
    const mainRoot = await mainWorktreeRoot(git, workspace.path, signal)
    return {
      git: true,
      repoRoot: root,
      mainRoot,
      branch: await currentBranch(git, root, signal),
      isWorktree: root !== mainRoot || this.worktreeRecord(request.workspaceId) !== undefined,
      dirty: await isDirty(git, root, signal),
    }
  }

  /**
   * Every worktree of the repository, main worktree first, joined with the
   * Workspace registration and the service's own record for each directory.
   *
   * @param {{workspaceId: string}} request - Workspace naming the repository.
   * @returns {Promise<{worktrees: object[]}>} worktree rows.
   */
  async list(request) {
    const git = await this.runner()
    const signal = this.lifetime.signal
    const workspace = this.workspace(request.workspaceId)
    if (!await isRepository(git, workspace.path, signal)) return { worktrees: [] }
    const registry = this.ctx.workspaceRegistry.list()
    const byPath = new Map(registry.map(item => [item.path, item]))
    const sessions = new Map(registry.map(item => [String(item.id), item.sessionIds.length]))
    const rows = []
    for (const [index, entry] of (await listWorktrees(git, workspace.path, signal)).entries()) {
      const registered = byPath.get(entry.path)
      const record = registered === undefined ? undefined : this.worktreeRecord(String(registered.id))
      rows.push({
        workspaceId: registered === undefined ? null : String(registered.id),
        path: entry.path,
        branch: entry.branch ?? record?.branch ?? null,
        title: registered === undefined ? '' : registered.title,
        main: index === 0,
        exists: await directoryExists(entry.path),
        registered: registered !== undefined,
        dirty: await isDirty(git, entry.path, signal),
        sessionCount: registered === undefined ? 0 : sessions.get(String(registered.id)) ?? 0,
      })
    }
    // A worktree directory removed outside git keeps its Workspace and record
    // until it is cleaned up: list it so the manager dialog can do that.
    for (const [workspaceId, record] of Object.entries(this.state.worktrees)) {
      if (rows.some(row => row.workspaceId === workspaceId)) continue
      const registered = this.ctx.workspaceRegistry.get(workspaceId)
      if (registered === undefined) continue
      const exists = await directoryExists(record.path)
      rows.push({
        workspaceId,
        path: record.path,
        branch: record.branch,
        title: registered.title,
        main: false,
        exists,
        registered: true,
        dirty: exists ? await isDirty(git, record.path, signal) : null,
        sessionCount: sessions.get(workspaceId) ?? 0,
      })
    }
    return { worktrees: rows }
  }

  /**
   * Branch inventory of the repository, for the base-revision picker.
   * @param {{workspaceId: string}} request - Workspace naming the repository.
   * @returns {Promise<object>} current, default, local, and remote branch names.
   */
  async branches(request) {
    const git = await this.runner()
    const signal = this.lifetime.signal
    const workspace = this.workspace(request.workspaceId)
    if (!await isRepository(git, workspace.path, signal)) {
      return { current: null, default: null, local: [], remote: [] }
    }
    const names = await listBranches(git, workspace.path, signal)
    return {
      current: await currentBranch(git, workspace.path, signal),
      default: await defaultBranch(git, workspace.path, signal),
      local: names.local,
      remote: names.remote,
    }
  }

  /**
   * Create a worktree on a fresh placeholder branch and register its directory
   * as a Workspace. The branch is renamed from the session title later.
   *
   * @param {{workspaceId: string, baseBranch?: string}} request - parent Workspace and optional base revision.
   * @returns {Promise<{workspaceId: string, path: string, branch: string}>} the created worktree.
   */
  create(request) {
    return this.enqueue(async () => {
      const git = await this.runner()
      const signal = this.lifetime.signal
      const parent = this.workspace(request.workspaceId)
      if (this.worktreeRecord(request.workspaceId) !== undefined) {
        throw new Error(
          `workspace '${request.workspaceId}' is already a worktree; only one worktree level is supported`,
        )
      }
      if (!await isRepository(git, parent.path, signal)) {
        throw new Error(`workspace '${parent.path}' is not inside a git repository`)
      }
      const mainRoot = await mainWorktreeRoot(git, parent.path, signal)
      const base = await this.resolveBase(git, mainRoot, request.baseBranch, signal)
      const taken = await this.takenBranches(git, mainRoot, signal)
      let branch = provisionalBranch(randomUUID().replace(/-/g, '').slice(0, 8))
      if (taken.has(branch)) branch = disambiguate(branch, taken)
      const directory = worktreeDirectory(this.worktreesRoot, mainRoot, branch, this.repoRootsInUse(mainRoot))

      await addWorktree(git, { repoRoot: mainRoot, path: directory, branch, base }, signal)
      const workspace = await this.ctx.workspaceRegistry.create(directory, branch)
      this.setRecord(String(workspace.id), {
        path: directory,
        repoRoot: mainRoot,
        branch,
        provisional: true,
        createdAt: new Date().toISOString(),
      })
      await this.persist()
      this.refreshPathIndex()
      return { workspaceId: String(workspace.id), path: workspace.path, branch }
    })
  }

  /**
   * Remove one service-created worktree, its Workspace registration, and its
   * record. Without `force` a worktree whose sessions still report running work
   * is refused; git separately refuses a dirty directory unless `force` is set.
   *
   * @param {{workspaceId: string, force?: boolean}} request - worktree to remove.
   * @returns {Promise<{removed: boolean}>} removal receipt.
   */
  remove(request) {
    return this.enqueue(async () => {
      const git = await this.runner()
      const signal = this.lifetime.signal
      this.workspace(request.workspaceId)
      const record = this.worktreeRecord(request.workspaceId)
      if (record === undefined) {
        throw new Error(`workspace '${request.workspaceId}' is not a worktree created by this plugin`)
      }
      const force = request.force === true
      if (!force) {
        const active = await this.activeSessions(request.workspaceId)
        if (active.length > 0) {
          throw new Error(
            `worktree '${record.branch}' still has ${active.length} session(s) with running work; `
            + 'stop them first or force the removal',
          )
        }
      }
      if (await directoryExists(record.path)) {
        await removeWorktree(git, { repoRoot: record.repoRoot, path: record.path, force }, signal)
      } else {
        // The directory is already gone; only git's administration remains.
        await pruneWorktrees(git, record.repoRoot, signal)
      }
      this.dropRecord(request.workspaceId)
      await this.persist()
      this.refreshPathIndex()
      await this.ctx.workspaceRegistry.delete(request.workspaceId)
      return { removed: true }
    })
  }

  /**
   * Prune worktree administration for directories that no longer exist.
   * @param {{workspaceId: string}} request - Workspace naming the repository.
   * @returns {Promise<{pruned: boolean}>} whether a repository was pruned.
   */
  prune(request) {
    return this.enqueue(async () => {
      const git = await this.runner()
      const signal = this.lifetime.signal
      const workspace = this.workspace(request.workspaceId)
      if (!await isRepository(git, workspace.path, signal)) return { pruned: false }
      await pruneWorktrees(git, await mainWorktreeRoot(git, workspace.path, signal), signal)
      return { pruned: true }
    })
  }

  /**
   * Rename one worktree's branch explicitly, disambiguated against the
   * repository's other branches, and retitle its Workspace to match.
   *
   * @param {{workspaceId: string, branch: string}} request - worktree and desired branch.
   * @returns {Promise<{branch: string}>} the branch actually installed.
   */
  renameBranch(request) {
    return this.enqueue(async () => {
      const git = await this.runner()
      const signal = this.lifetime.signal
      const workspace = this.workspace(request.workspaceId)
      const record = this.worktreeRecord(request.workspaceId)
      if (record === undefined) {
        throw new Error(`workspace '${request.workspaceId}' is not a worktree created by this plugin`)
      }
      const wanted = String(request.branch ?? '').trim()
      if (wanted === '') throw new Error('a branch name is required')
      const taken = await this.takenBranches(git, record.repoRoot, signal)
      taken.delete(record.branch)
      const target = disambiguate(wanted, taken)
      if (target !== record.branch) {
        await renameWorktreeBranch(git, { path: record.path, branch: target }, signal)
      }
      this.setRecord(request.workspaceId, { ...record, branch: target, provisional: isProvisionalBranch(target) })
      await this.persist()
      this.refreshPathIndex()
      if (workspace.title !== target) await workspace.setTitle(target)
      return { branch: target }
    })
  }
}