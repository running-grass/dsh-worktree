/**
 * Durable plugin state: which Workspaces this plugin created as git worktrees,
 * and the branch each one records.
 *
 * The document lives at `$DSH_HOME/worktree.state.json` rather than inside a
 * DSH storage domain, so the plugin needs no persistence change in DSH itself.
 * It is a cache over git, never the authority: `git worktree list` and the
 * Workspace registry both outrank it, and {@link reconcile} drops entries
 * whose Workspace or directory is gone.
 *
 * @module dsh-worktree/state
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Stored document version. A document with another version reads as empty. */
export const STATE_VERSION = 1

/**
 * Empty state document.
 * @returns {{version: number, worktrees: Record<string, object>}} the empty state.
 */
export function emptyState() {
  return { version: STATE_VERSION, worktrees: {} }
}

/** One stored entry, or `undefined` when the record does not match the schema. */
function parseEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const { path, repoRoot, branch, createdAt } = entry
  if (typeof path !== 'string' || path === '') return undefined
  if (typeof repoRoot !== 'string' || repoRoot === '') return undefined
  if (typeof branch !== 'string' || branch === '') return undefined
  return {
    path,
    repoRoot,
    branch,
    provisional: entry.provisional === true,
    createdAt: typeof createdAt === 'string' && createdAt !== '' ? createdAt : new Date(0).toISOString(),
  }
}

/**
 * Parse a stored document. A malformed document, an unknown version, or one
 * bad entry never fails the read: unknown entries are dropped.
 *
 * @param {string} text - raw file content.
 * @returns {{version: number, worktrees: Record<string, object>}} the parsed state.
 */
export function parseState(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return emptyState()
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return emptyState()
  if (document.version !== STATE_VERSION) return emptyState()
  const worktrees = {}
  const raw = document.worktrees
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [workspaceId, entry] of Object.entries(raw)) {
      const parsed = parseEntry(entry)
      if (parsed !== undefined) worktrees[workspaceId] = parsed
    }
  }
  return { version: STATE_VERSION, worktrees }
}

/**
 * Read the state file; a missing or unreadable file reads as empty.
 * @param {string} file - absolute state file path.
 * @returns {Promise<object>} the parsed state.
 */
export async function readState(file) {
  try {
    return parseState(await readFile(file, 'utf8'))
  } catch {
    return emptyState()
  }
}

/**
 * Write the state file atomically: a sibling temp file is renamed over the
 * target, so a crash never leaves a half-written document.
 *
 * @param {string} file - absolute state file path.
 * @param {object} state - state document to persist.
 * @returns {Promise<void>} resolution after the rename.
 */
export async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.worktree.state.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Drop entries that no longer describe a live worktree. Called once at plugin
 * start with the Workspace registry's current ids and the directories that
 * still exist.
 *
 * @param {object} state - current state document.
 * @param {(workspaceId: string) => boolean} keep - predicate: should this entry survive?
 * @returns {object} the pruned state document.
 */
export function pruneState(state, keep) {
  const worktrees = {}
  for (const [workspaceId, entry] of Object.entries(state.worktrees)) {
    if (keep(workspaceId, entry)) worktrees[workspaceId] = entry
  }
  return { version: STATE_VERSION, worktrees }
}