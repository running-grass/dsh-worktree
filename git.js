/**
 * Git access through the subprocess capability: one resolved executable, a
 * scrubbed environment, bounded output, and the worktree commands this plugin
 * needs. Shaped after the workspace-changes runner so both plugins talk to git
 * the same way.
 *
 * Nothing here throws for a nonzero exit unless the caller asks for it with
 * {@link ok}: "not a repository", a missing branch, and a detached HEAD are
 * answers, not failures.
 *
 * @module dsh-worktree/git
 */
import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2000

/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024

/**
 * Resolve the git executable once. On macOS the Xcode stub at `/usr/bin/git`
 * opens an installer dialog instead of running, so it counts as absent until
 * developer tools are selected.
 *
 * @param {object} subprocess - the `ctx.subprocess` capability.
 * @param {AbortSignal} signal - plugin lifetime.
 * @returns {Promise<string|null>} the executable path, or null when git is unavailable.
 */
export async function resolveGit(subprocess, signal) {
  let executable
  try {
    executable = await subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'],
    cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: TERMINATE_GRACE_MS,
    signal,
  })
  const outcome = await probe.done
  if (outcome.exitCode !== 0) return null
  const directory = probe.collected.stdout?.readFrom(0).text.trim() ?? ''
  return directory === '' ? null : resolve(directory, 'usr/bin/git')
}

/**
 * Throw a failed command's stderr.
 * @param {object} result - settled command facts.
 * @param {string} what - command description for the message.
 * @returns {object} the same result when it exited zero.
 */
export function ok(result, what) {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new Error(`${what} failed: ${detail}`)
  }
  return result
}

/** Runs one resolved git executable with scrubbed environment, timeout, and bounded output. */
export class GitRunner {
  /**
   * @param {object} subprocess - the `ctx.subprocess` capability.
   * @param {string} executable - resolved git path.
   * @param {{timeoutMs: number, outputMaxBytes: number}} limits - per-command bounds.
   */
  constructor(subprocess, executable, limits) {
    this.subprocess = subprocess
    this.executable = executable
    this.limits = limits
  }

  /**
   * Run `git <args>` to completion.
   * @param {string[]} args - git arguments; never shell-interpreted.
   * @param {{cwd: string, signal: AbortSignal, env?: object, stdin?: string, maxBytes?: number}} options - spawn facts.
   * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, truncated: boolean}>} exit facts and collected output.
   */
  async run(args, options) {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...options.env,
      },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error(timeout.aborted
        ? `git ${args.join(' ')} timed out after ${this.limits.timeoutMs}ms`
        : `git ${args.join(' ')} was aborted`)
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/**
 * Whether the directory is inside a git work tree.
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory to probe.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean>} true inside a work tree.
 */
export async function isRepository(git, cwd, signal) {
  const result = await git.run(['rev-parse', '--is-inside-work-tree'], { cwd, signal })
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

/**
 * The work tree enclosing a directory. Inside a linked worktree this is that
 * worktree's own directory, which is what a session's cwd resolves to.
 *
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside the work tree.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} the absolute work tree root.
 */
export async function workTreeRoot(git, cwd, signal) {
  return ok(await git.run(['rev-parse', '--show-toplevel'], { cwd, signal }), 'git rev-parse --show-toplevel')
    .stdout.trim()
}

/**
 * The shared git directory of the repository a worktree belongs to.
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside the work tree.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} absolute common git directory.
 */
export async function commonGitDir(git, cwd, signal) {
  const raw = ok(await git.run(['rev-parse', '--git-common-dir'], { cwd, signal }), 'git rev-parse --git-common-dir')
    .stdout.trim()
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

/**
 * The current branch, or null on a detached HEAD.
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory to read.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string|null>} the branch name.
 */
export async function currentBranch(git, cwd, signal) {
  const result = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, signal })
  if (result.exitCode !== 0) return null
  const branch = result.stdout.trim()
  return branch === '' ? null : branch
}

/**
 * The repository's default branch: `origin/HEAD` when it is set, otherwise the
 * first of `main`/`master` that exists, otherwise the current branch.
 *
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside the repository.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string|null>} the default branch name, or null when none resolves.
 */
export async function defaultBranch(git, cwd, signal) {
  const remoteHead = await git.run(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, signal },
  )
  if (remoteHead.exitCode === 0) {
    const name = remoteHead.stdout.trim().replace(/^[^/]+\//, '')
    if (name !== '') return name
  }
  for (const candidate of ['main', 'master']) {
    if (await branchExists(git, cwd, candidate, signal)) return candidate
  }
  return await currentBranch(git, cwd, signal)
}

/**
 * Whether a local branch exists.
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside the repository.
 * @param {string} branch - branch name to look for.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean>} true when `refs/heads/<branch>` resolves.
 */
export async function branchExists(git, cwd, branch, signal) {
  const result = await git.run(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, signal },
  )
  return result.exitCode === 0
}

/**
 * Local and remote branch names, minus the symbolic remote HEAD rows
 * (`<remote>/HEAD`).
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside the repository.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{local: string[], remote: string[]}>} branch names by kind.
 */
export async function listBranches(git, cwd, signal) {
  const heads = ok(
    await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd, signal }),
    'git for-each-ref refs/heads',
  )
  const remotes = ok(
    await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { cwd, signal }),
    'git for-each-ref refs/remotes',
  )
  const names = text => text.split('\n').map(line => line.trim()).filter(line => line !== '')
  return {
    local: names(heads.stdout),
    remote: names(remotes.stdout).filter(name => !name.endsWith('/HEAD')),
  }
}

/**
 * Parse `git worktree list --porcelain` into entries, in git's own order: the
 * main worktree is always first.
 *
 * @param {string} text - porcelain output.
 * @returns {{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean}[]} parsed entries.
 */
export function parseWorktreeList(text) {
  const entries = []
  let current = null
  const push = () => {
    if (current !== null) entries.push(current)
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      push()
      current = { path: line.slice('worktree '.length).trim(), head: null, branch: null, detached: false, bare: false }
      continue
    }
    if (current === null) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim()
    else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
  }
  push()
  return entries
}

/**
 * Every worktree of the repository, main worktree first.
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside any worktree of the repository.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<object[]>} parsed worktree entries.
 */
export async function listWorktrees(git, cwd, signal) {
  const result = ok(await git.run(['worktree', 'list', '--porcelain'], { cwd, signal }), 'git worktree list')
  return parseWorktreeList(result.stdout)
}

/**
 * The main worktree root of the repository enclosing `cwd`. Worktree
 * directories are grouped per repository by this path, and `git worktree add`
 * runs here.
 *
 * @param {GitRunner} git - runner.
 * @param {string} cwd - directory inside any worktree of the repository.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} the main worktree directory.
 */
export async function mainWorktreeRoot(git, cwd, signal) {
  const entries = await listWorktrees(git, cwd, signal)
  const first = entries[0]
  return first === undefined ? await workTreeRoot(git, cwd, signal) : first.path
}

/**
 * Create a worktree on a new branch, with the start point named explicitly.
 * The main worktree's checked-out HEAD is never implied.
 *
 * @param {GitRunner} git - runner.
 * @param {{repoRoot: string, path: string, branch: string, base: string}} request - worktree facts.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolution after git created the worktree.
 */
export async function addWorktree(git, { repoRoot, path, branch, base }, signal) {
  ok(
    await git.run(['worktree', 'add', '-b', branch, path, base], { cwd: repoRoot, signal }),
    `git worktree add -b ${branch}`,
  )
}

/**
 * Remove one worktree. Without `force`, git refuses a worktree that has
 * modifications or untracked files, and that refusal reaches the caller as an
 * error message.
 *
 * @param {GitRunner} git - runner.
 * @param {{repoRoot: string, path: string, force?: boolean}} request - removal facts.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolution after git removed the worktree.
 */
export async function removeWorktree(git, { repoRoot, path, force = false }, signal) {
  ok(
    await git.run(['worktree', 'remove', ...(force ? ['--force'] : []), path], { cwd: repoRoot, signal }),
    `git worktree remove ${path}`,
  )
}

/**
 * Prune worktree administration for directories that no longer exist.
 * @param {GitRunner} git - runner.
 * @param {string} repoRoot - main worktree directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolution after git pruned.
 */
export async function pruneWorktrees(git, repoRoot, signal) {
  ok(await git.run(['worktree', 'prune'], { cwd: repoRoot, signal }), 'git worktree prune')
}

/**
 * Rename the branch checked out in one worktree.
 * @param {GitRunner} git - runner.
 * @param {{path: string, branch: string}} request - worktree directory and new branch name.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolution after git renamed the branch.
 */
export async function renameBranch(git, { path, branch }, signal) {
  ok(await git.run(['branch', '-m', branch], { cwd: path, signal }), `git branch -m ${branch}`)
}

/**
 * Whether a worktree has staged, unstaged, or untracked changes. A directory
 * that is not a work tree answers null rather than failing.
 *
 * @param {GitRunner} git - runner.
 * @param {string} path - worktree directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean|null>} true when dirty, null when unreadable.
 */
export async function isDirty(git, path, signal) {
  const result = await git.run(['status', '--porcelain'], { cwd: path, signal })
  if (result.exitCode !== 0) return null
  return result.stdout.trim() !== ''
}