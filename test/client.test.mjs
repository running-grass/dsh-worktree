/**
 * The browser half: the hand-written Remote contribution, the locale
 * dictionaries, the pure presentation decisions, and the three slot
 * registrations. The module is a lazy-CJS factory, so it is loaded through a
 * stub module loader exactly as the client module system loads it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { loaded = entry },
  },
}

await import('../client.js')

/** The React surface the module touches at load and in tests. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
}

function loadClient() {
  assert.ok(loaded, 'the module must register itself on window.__ModuleLoader__')
  assert.equal(loaded.id, 'dsh-worktree')
  return loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require(${name})`)
  })
}

const client = loadClient()

/** A client context stub collecting the registrations an apply installs. */
function createClientContext() {
  const registrations = []
  const injections = []
  let mounts = 0
  const remoteStub = { status: async () => ({ ok: true, value: {} }) }
  const ctx = {
    remote: { $mount: async () => { mounts += 1 } },
    locale: { register: () => () => {}, bind: () => () => {} },
    effect: fn => { fn() },
    get: name => (name === 'remote.worktree' ? remoteStub : undefined),
    slots: {
      inject(name, callback) { injections.push(name); callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registrations, injections, mountCount: () => mounts }
}

test('the module exports the plugin surface', () => {
  assert.equal(client.NS, 'worktree')
  assert.deepEqual(client.inject, ['slots', 'locale', 'remote'])
  assert.equal(typeof client.apply, 'function')
})

test('the Remote contribution covers every host method', () => {
  const { TYPERT_REMOTE, METHODS } = client.__test
  assert.equal(TYPERT_REMOTE.package, 'dsh-worktree')
  assert.deepEqual(METHODS, ['status', 'list', 'branches', 'create', 'remove', 'prune', 'renameBranch'])
  assert.deepEqual(TYPERT_REMOTE.descriptors.map(entry => entry.method), METHODS)
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.service, 'worktree')
    assert.equal(descriptor.namespace, 'worktree')
    assert.equal(descriptor.id, `dsh-worktree#worktree/${descriptor.method}`)
    assert.deepEqual(descriptor.parameters.map(parameter => parameter.name), ['request'])
    assert.equal(descriptor.parameters[0].codec.mode, 'strict')
    assert.equal(typeof descriptor.parameters[0].codec.create, 'function')
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(typeof descriptor.result.create, 'function')
    assert.equal(typeof descriptor.result.create().parse, 'function')
  }
})

test('both dictionaries carry exactly the same keys', () => {
  const { zh, en } = client.__test
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal(zh.control, 'worktree')
  assert.equal(en.control, 'worktree')
})

test('format substitutes named placeholders and leaves unknown ones alone', () => {
  const { format } = client.__test
  assert.equal(format('a {x} b', { x: 1 }), 'a 1 b')
  assert.equal(format('{a}{b}', { a: '1', b: '2' }), '12')
  assert.equal(format('{missing}', {}), '{missing}')
  assert.equal(format('none', undefined), 'none')
  assert.equal(format('{x}', { x: null }), 'null')
})

test('reasonOf renders a thrown value for an inline error line', () => {
  const { reasonOf } = client.__test
  assert.equal(reasonOf(new Error('boom')), 'boom')
  assert.equal(reasonOf('boom'), 'boom')
  assert.equal(reasonOf(null), 'unknown')
  assert.equal(reasonOf(undefined), 'unknown')
})

test('visibility decisions gate the badge and the control', () => {
  const { badgeVisible, controlVisible } = client.__test
  assert.equal(badgeVisible(null), false)
  assert.equal(badgeVisible(undefined), false)
  assert.equal(badgeVisible({ git: false }), false)
  assert.equal(badgeVisible({ git: true, branch: null }), false)
  assert.equal(badgeVisible({ git: true, branch: 'main' }), true)

  assert.equal(controlVisible(null), false)
  assert.equal(controlVisible({ git: false }), false)
  assert.equal(controlVisible({ git: true, branch: null }), true)
})

test('base options put the default first, then locals, then remotes', () => {
  const { baseOptions } = client.__test
  const t = key => (key === 'baseDefault' ? 'Default branch' : key)
  assert.deepEqual(baseOptions(null, t), [])
  assert.deepEqual(baseOptions({ local: ['main', 'dev'], remote: ['origin/main'] }, t), [
    { value: '', label: 'Default branch' },
    { value: 'main', label: 'main' },
    { value: 'dev', label: 'dev' },
    { value: 'origin/main', label: 'origin/main' },
  ])
  assert.deepEqual(baseOptions({}, t), [{ value: '', label: 'Default branch' }])
})

test('row tags describe one manager row in fixed order', () => {
  const { rowTagLabels } = client.__test
  const t = key => key
  assert.deepEqual(rowTagLabels({ main: true, exists: true, dirty: false, sessionCount: 0 }, t), ['mainTag'])
  assert.deepEqual(rowTagLabels({ main: false, exists: false, dirty: true, sessionCount: 2 }, t), [
    'missingTag', 'dirtyTag', 'sessionsTag',
  ])
  assert.deepEqual(rowTagLabels({ main: false, exists: true, dirty: null, sessionCount: 0 }, t), [])
})

test('createSource publishes to subscribers and stops after unsubscribe', () => {
  const { createSource } = client.__test
  const source = createSource(null)
  const seen = []
  const unsubscribe = source.subscribe(() => seen.push(source.getSnapshot()))
  source.set('a')
  source.set('b')
  unsubscribe()
  source.set('c')
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(source.getSnapshot(), 'c')
})

test('apply mounts the Remote and fills the three declared slots', () => {
  const { ctx, registrations, injections, mountCount } = createClientContext()
  client.apply(ctx)

  assert.equal(mountCount(), 1)
  assert.deepEqual(injections, ['conversation.input.left', 'conversation.composer.dock', 'shell.overlay'])
  assert.deepEqual(registrations.map(entry => entry.options.name), injections)
  assert.deepEqual(registrations.map(entry => entry.options.id), [
    'worktree-control', 'worktree-branch', 'worktree-manager',
  ])
  assert.deepEqual(registrations.map(entry => entry.options.order), [40, 60, undefined])
  assert.equal(registrations[0].component, client.__test.WorktreeControl)
  assert.equal(registrations[1].component, client.__test.BranchBadge)
  assert.equal(registrations[2].component, client.__test.WorktreeManagerDialog)
})

test('injected faces carry the callbacks, and only the overlay carries the shared hook', () => {
  const { ctx, registrations } = createClientContext()
  client.apply(ctx)

  const control = registrations[0].options.inject('session-1')
  for (const name of ['loadStatus', 'loadBranches', 'listWorktrees', 'removeWorktree', 'pruneWorktrees', 'createWorktree', 'openWorkspace', 'openManager', 'closeManager']) {
    assert.equal(typeof control[name], 'function', `${name} must be injected`)
  }
  assert.equal(control.hooks, undefined)

  const overlay = registrations[2].options.inject()
  assert.equal(typeof overlay.hooks.managerTarget.getSnapshot, 'function')
  assert.equal(overlay.hooks.managerTarget.getSnapshot(), null)

  // The shared hook is the channel between the control and the dialog.
  control.openManager({ workspaceId: 'ws-1', title: 'project' })
  assert.deepEqual(overlay.hooks.managerTarget.getSnapshot(), { workspaceId: 'ws-1', title: 'project' })
  control.closeManager()
  assert.equal(overlay.hooks.managerTarget.getSnapshot(), null)
})