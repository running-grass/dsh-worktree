/**
 * Cordis plugin entry and Typert Remote owner for dsh-worktree.
 *
 * This module is the only one that imports DSH packages: it resolves the
 * `$DSH_HOME` paths, owns the service registration the Gateway discovers, and
 * forwards the `worktree/*` invocations declared in `typert.host.js` to
 * {@link WorktreeService}, which holds all of the behaviour and stays testable
 * without a DSH install.
 *
 * The Remote surface is positional: the Gateway calls a method with the
 * manifest's parameters in order, and every method here takes the single
 * `request` object the manifest declares.
 *
 * @module dsh-worktree
 */
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { WorktreeService } from './service.js'

/** Cordis plugin name. */
export const name = 'worktree'

/** Deployment-varying bounds; an invalid value fails plugin load. */
export const Config = z.object({
  /** Root every created worktree lives below; defaults to `$DSH_HOME/worktrees`. */
  worktreesRoot: z.string(),
  /** Milliseconds one git command may run before it is terminated. */
  timeoutMs: z.natural().default(30_000),
  /** Bytes of stdout retained per git command. */
  outputMaxBytes: z.natural().default(8 * 1024 * 1024),
})

/** The worktree host service and `worktree` Remote namespace owner. */
export default class Worktree extends TypertRemoteService {
  static inject = ['subprocess', 'workspaceRegistry']

  static Config = Config

  /**
   * @param {object} ctx - host context carrying the subprocess and Workspace services.
   * @param {object} [config] - deployment bounds.
   */
  constructor(ctx, config = {}) {
    super(ctx, 'worktree')
    const resolved = Config(config)
    this.impl = new WorktreeService(ctx, {
      worktreesRoot: resolved.worktreesRoot ?? dshHomePath('worktrees'),
      stateFile: dshHomePath('worktree.state.json'),
      timeoutMs: resolved.timeoutMs ?? 30_000,
      outputMaxBytes: resolved.outputMaxBytes ?? 8 * 1024 * 1024,
      logger: ctx.logger ?? console,
    })
    ctx.effect(() => () => { void this.impl.dispose() }, 'dsh-worktree lifecycle')
  }

  /**
   * Git state of one Workspace's repository.
   * @param {{workspaceId: string}} request - Workspace to read.
   * @returns {Promise<object>} repository and branch facts.
   */
  status(request) {
    return this.impl.status(request)
  }

  /**
   * Every worktree of one Workspace's repository.
   * @param {{workspaceId: string}} request - Workspace naming the repository.
   * @returns {Promise<{worktrees: object[]}>} worktree rows.
   */
  list(request) {
    return this.impl.list(request)
  }

  /**
   * Branch inventory of one Workspace's repository.
   * @param {{workspaceId: string}} request - Workspace naming the repository.
   * @returns {Promise<object>} branch names.
   */
  branches(request) {
    return this.impl.branches(request)
  }

  /**
   * Create a worktree and register it as a Workspace.
   * @param {{workspaceId: string, baseBranch?: string}} request - parent Workspace and base revision.
   * @returns {Promise<{workspaceId: string, path: string, branch: string}>} the created worktree.
   */
  create(request) {
    return this.impl.create(request)
  }

  /**
   * Remove one worktree, its Workspace registration, and its record.
   * @param {{workspaceId: string, force?: boolean}} request - worktree to remove.
   * @returns {Promise<{removed: boolean}>} removal receipt.
   */
  remove(request) {
    return this.impl.remove(request)
  }

  /**
   * Prune worktree administration for directories that no longer exist.
   * @param {{workspaceId: string}} request - Workspace naming the repository.
   * @returns {Promise<{pruned: boolean}>} whether a repository was pruned.
   */
  prune(request) {
    return this.impl.prune(request)
  }

  /**
   * Rename one worktree's branch.
   * @param {{workspaceId: string, branch: string}} request - worktree and desired branch.
   * @returns {Promise<{branch: string}>} the branch actually installed.
   */
  renameBranch(request) {
    return this.impl.renameBranch(request)
  }
}