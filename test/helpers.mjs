/**
 * Shared test fixtures: a subprocess stub shaped like `ctx.subprocess`, a real
 * throwaway git repository, and a duck-typed host context for the service.
 *
 * Not a test file itself: `node --test "test/*.test.mjs"` never runs it.
 *
 * @module dsh-worktree/test/helpers
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Run one git command to completion and return trimmed stdout. */
export function sh(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * A `ctx.subprocess` stub over node:child_process. It honours the spec fields
 * the GitRunner uses (`argv`, `cwd`, `env`, `stdio.stdin.data`) and exposes the
 * `done` / `collected.stdout|stderr` surface the runner reads.
 */
export function createSubprocess() {
  return {
    async resolveExecutable(command) {
      const found = execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim()
      if (found === '') throw new Error(`cannot resolve ${command}`)
      return found
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      if (child.stdout) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => { stdout += chunk })
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', chunk => { stderr += chunk })
      }
      const stdin = spec.stdio && spec.stdio.stdin
      if (stdin && typeof stdin === 'object' && typeof stdin.data === 'string') child.stdin.end(stdin.data)
      else child.stdin.end()
      const done = new Promise((resolve) => {
        child.on('close', code => resolve({ exitCode: code }))
        child.on('error', () => resolve({ exitCode: null }))
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
      }
    },
  }
}

/** Whether each of these values exists. */
export async function exists(...paths) {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(join(...paths))
    return true
  } catch {
    return false
  }
}

/**
 * A real git repository in a temp directory, on branch `main`, with one
 * commit. The returned path is canonicalized, which is what git reports back.
 */
export async function createRepository() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-repo-')))
  sh('git', ['init', '-b', 'main'], directory)
  sh('git', ['config', 'user.email', 'test@example.com'], directory)
  sh('git', ['config', 'user.name', 'Worktree Test'], directory)
  await writeFile(join(directory, 'README.md'), '# fixture\n', 'utf8')
  sh('git', ['add', 'README.md'], directory)
  sh('git', ['commit', '-m', 'initial commit'], directory)
  return directory
}

/** Remove a fixture directory tree. */
export async function removeDirectory(directory) {
  await rm(directory, { recursive: true, force: true })
}

/**
 * A workspace-registry stub with the surface the service uses: `list`, `get`,
 * `create`, `delete`, and `resolveByPath`. Registration is idempotent by path,
 * like the real registry.
 */
export function createRegistry() {
  const entities = new Map()
  let counter = 0
  return {
    entities,
    list() {
      return [...entities.values()]
    },
    get(id) {
      return entities.get(String(id))
    },
    async create(path, title) {
      for (const entity of entities.values()) {
        if (entity.path === path) return entity
      }
      const id = `ws-${++counter}`
      const entity = {
        id,
        path,
        title: title ?? path.split('/').pop(),
        sessionIds: [],
        async setTitle(next) { entity.title = next },
        async attachSession(sessionId) { entity.sessionIds = [sessionId, ...entity.sessionIds] },
        async insertSessionBefore() {},
        async detachSession() {},
        async status() { return 'ok' },
      }
      entities.set(id, entity)
      return entity
    },
    async delete(id) {
      return entities.delete(String(id))
    },
    async resolveByPath(path) {
      for (const entity of entities.values()) {
        if (entity.path === path) return entity
      }
      return undefined
    },
  }
}

/**
 * A duck-typed host context for {@link WorktreeService}. `activities` decides
 * what the `workspace/session-activity` waterfall reports per session.
 */
export function createContext({ activities = () => [] } = {}) {
  const registry = createRegistry()
  return {
    logger: { warn() {}, info() {} },
    subprocess: createSubprocess(),
    workspaceRegistry: registry,
    sessionProjections: undefined,
    effect() {},
    inject() {},
    on() {},
    waterfall: async (_event, request) => activities(request.sessionId),
    get() { return undefined },
  }
}