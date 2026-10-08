/**
 * Hand-written Typert host manifest for the `worktree` Remote.
 *
 * The typert loader imports this through `package.json` `exports["./typert"]`
 * and registers it into `ctx.typert.local`, which the Host gateway uses to
 * claim and dispatch `worktree/*` in strict mode. Every invocation therefore
 * needs a strict codec on each parameter and on the result, and each strict
 * codec needs a `create()` factory (the loader rejects descriptors without
 * one, which fails the whole plugin activation).
 *
 * Each method takes exactly one object request, so the parameter list is one
 * `request` entry: the gateway calls the service positionally.
 *
 * @module dsh-worktree/typert.host
 */
import { z } from 'zod'

const worktreeEntrySchema = z.object({
  workspaceId: z.string().nullable(),
  path: z.string(),
  branch: z.string().nullable(),
  title: z.string(),
  main: z.boolean(),
  exists: z.boolean(),
  registered: z.boolean(),
  dirty: z.boolean().nullable(),
  sessionCount: z.number(),
})

const statusResultSchema = z.object({
  git: z.boolean(),
  repoRoot: z.string().nullable(),
  mainRoot: z.string().nullable(),
  branch: z.string().nullable(),
  isWorktree: z.boolean(),
  dirty: z.boolean().nullable(),
})

const listResultSchema = z.object({ worktrees: z.array(worktreeEntrySchema) })

const branchesResultSchema = z.object({
  current: z.string().nullable(),
  default: z.string().nullable(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
})

const createResultSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  branch: z.string(),
})

const removeResultSchema = z.object({ removed: z.boolean() })
const pruneResultSchema = z.object({ pruned: z.boolean() })
const renameResultSchema = z.object({ branch: z.string() })

const requestSchemas = {
  status: z.object({ workspaceId: z.string() }),
  list: z.object({ workspaceId: z.string() }),
  branches: z.object({ workspaceId: z.string() }),
  create: z.object({ workspaceId: z.string(), baseBranch: z.string().optional() }),
  remove: z.object({ workspaceId: z.string(), force: z.boolean().optional() }),
  prune: z.object({ workspaceId: z.string() }),
  renameBranch: z.object({ workspaceId: z.string(), branch: z.string() }),
}

/** One strict codec: strict mode plus the factory the loader requires. */
const strict = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, schema, create: () => schema })

/** One direct invocation taking a single object request. */
const invocation = (method, resultSchema, typeSymbol) => ({
  id: `dsh-worktree#worktree/${method}`,
  service: 'worktree',
  namespace: 'worktree',
  method,
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: strict(`dsh-worktree#${typeSymbol}`, requestSchemas[method]),
  }],
  result: strict('json', resultSchema),
})

export const TYPERT = {
  package: 'dsh-worktree',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', statusResultSchema, 'WorktreeStatusRequest'),
    invocation('list', listResultSchema, 'WorktreeListRequest'),
    invocation('branches', branchesResultSchema, 'WorktreeBranchesRequest'),
    invocation('create', createResultSchema, 'WorktreeCreateRequest'),
    invocation('remove', removeResultSchema, 'WorktreeRemoveRequest'),
    invocation('prune', pruneResultSchema, 'WorktreePruneRequest'),
    invocation('renameBranch', renameResultSchema, 'WorktreeRenameBranchRequest'),
  ],
  model: { services: [], events: [], objects: [] },
}