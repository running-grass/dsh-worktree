/**
 * Pure branch and directory naming: the whole naming policy of dsh-worktree,
 * with no I/O and no cordis context, so it is table-testable.
 *
 * The policy has two halves. A worktree is created with a placeholder branch
 * because the session title that names it does not exist yet (DSH generates
 * session titles from the first user message); once the title lands the branch
 * is renamed through {@link slugifyTitle}. The placeholder is therefore an
 * accepted intermediate state, never an error.
 *
 * @module dsh-worktree/branch
 */

/** Prefix every placeholder branch carries until the session title lands. */
export const PROVISIONAL_PREFIX = 'wip/'

/** Inclusive character cap for a derived slug. */
export const MAX_SLUG_LENGTH = 48

/**
 * Derive a brief ASCII branch slug from a generated session title.
 *
 * The fold drops diacritics, lowercases, collapses every run outside
 * `[a-z0-9]` into a single dash, and trims/caps the result. A title written
 * only in non-ASCII (a Chinese session title, for instance) yields `''`: the
 * caller keeps the placeholder branch rather than inventing a name.
 *
 * @param {unknown} title - generated session title.
 * @param {number} [maxLength] - inclusive character cap.
 * @returns {string} the slug, or `''` when no ASCII alphanumerics survive.
 */
export function slugifyTitle(title, maxLength = MAX_SLUG_LENGTH) {
  if (typeof title !== 'string') return ''
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, maxLength)
    .replace(/-+$/, '')
}

/**
 * Filesystem segment for one branch. Git allows slashes in branch names while
 * the worktree directory must stay one level below the repository segment, so
 * `fix/parser` becomes `fix-parser`.
 *
 * @param {unknown} branch - branch name.
 * @returns {string} a non-empty single path segment.
 */
export function sanitizeDirName(branch) {
  const segment = String(branch ?? '')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return segment === '' ? 'worktree' : segment
}

/**
 * Whether a branch is still the placeholder created before the title existed.
 * @param {unknown} branch - branch name.
 * @returns {boolean} true while the branch carries {@link PROVISIONAL_PREFIX}.
 */
export function isProvisionalBranch(branch) {
  return typeof branch === 'string' && branch.startsWith(PROVISIONAL_PREFIX)
}

/**
 * Placeholder branch for one worktree. Deterministic from the caller's hex so
 * tests can pin it; the caller owns the randomness.
 *
 * @param {string} hex - short random hex.
 * @returns {string} the placeholder branch name.
 */
export function provisionalBranch(hex) {
  return `${PROVISIONAL_PREFIX}${hex}`
}

/**
 * First slug not already taken, appending `-2`, `-3`, ... while occupied.
 *
 * @param {string} slug - desired slug.
 * @param {ReadonlySet<string>} taken - branch names already present in the repository.
 * @returns {string} a branch name absent from `taken`.
 */
export function disambiguate(slug, taken) {
  if (!taken.has(slug)) return slug
  let n = 2
  while (taken.has(`${slug}-${n}`)) n += 1
  return `${slug}-${n}`
}

/**
 * Stable short hash of a path, used only to separate two repositories that
 * share a directory name.
 *
 * @param {unknown} value - value to hash.
 * @returns {string} six lowercase hex characters.
 */
export function shortHash(value) {
  let hash = 0x811c9dc5
  for (const char of String(value ?? '')) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * Directory segment naming one repository below the worktrees root: the
 * repository's own directory name, with a short path hash appended when
 * another repository already claimed that name.
 *
 * @param {string} repoRoot - absolute repository top-level directory.
 * @param {ReadonlySet<string>} taken - directory segments already used by other repositories.
 * @returns {string} a single path segment.
 */
export function repoDirSegment(repoRoot, taken = new Set()) {
  const base = String(repoRoot ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const segment = sanitizeDirName(base === '' ? 'repo' : base)
  return taken.has(segment) ? `${segment}-${shortHash(repoRoot)}` : segment
}

/**
 * Absolute directory for one new worktree: `<worktreesRoot>/<repo>/<branch>`.
 *
 * @param {string} worktreesRoot - configured root, normally `$DSH_HOME/worktrees`.
 * @param {string} repoRoot - absolute repository top-level directory.
 * @param {string} branch - branch the worktree is created on.
 * @param {ReadonlySet<string>} taken - directory segments other repositories already used.
 * @returns {string} the worktree directory.
 */
export function worktreeDirectory(worktreesRoot, repoRoot, branch, taken = new Set()) {
  return `${worktreesRoot}/${repoDirSegment(repoRoot, taken)}/${sanitizeDirName(branch)}`
}