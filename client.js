// Browser half of dsh-worktree.
//
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
// There is no build step, so every component is React.createElement.
//
// It mounts the `worktree` Remote and fills three slots DSH already declares:
//
//   conversation.input.left     the worktree control (create + manage)
//   conversation.composer.dock  the current branch badge
//   shell.overlay               the worktree manager dialog
//
// Slots this plugin cannot fill are named in design.md: the New Session hero
// seat, the workspace row's quick menu, and the sidebar's worktree nesting all
// need a declaration inside DSH's own ui-conversation / ui-workspace packages.

window.__ModuleLoader__.load({
  id: 'dsh-worktree',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    const h = React.createElement;
    const NS = 'worktree';
    const inject = ['slots', 'locale', 'remote'];

    const zh = {
      control: 'worktree',
      controlTitle: '在当前仓库中创建 git worktree',
      base: '起始分支',
      baseDefault: '默认分支',
      create: '新建 worktree 并开会话',
      creating: '正在创建…',
      manage: '管理 worktree…',
      loading: '读取中…',
      badgeTitle: '当前分支：{branch}',
      badgeTitleWorktree: 'worktree 分支：{branch}',
      dialogTitle: '管理 worktree',
      dialogSubtitle: '{title} 仓库的 worktree',
      close: '关闭',
      refresh: '刷新',
      prune: '清理失效记录',
      pruned: '已清理 git 中失效的 worktree 记录',
      empty: '这个仓库还没有 worktree',
      mainTag: '主工作区',
      missingTag: '目录已丢失',
      dirtyTag: '有未提交改动',
      sessionsTag: '{n} 个会话',
      open: '打开',
      remove: '移除',
      confirmRemove: '确认移除',
      forceRemove: '强制移除',
      cancel: '取消',
      removed: '已移除 {branch}',
      failed: '操作失败：{message}',
    };

    const en = {
      control: 'worktree',
      controlTitle: 'Create a git worktree in the current repository',
      base: 'Base branch',
      baseDefault: 'Default branch',
      create: 'Create worktree and start session',
      creating: 'Creating…',
      manage: 'Manage worktrees…',
      loading: 'Loading…',
      badgeTitle: 'Current branch: {branch}',
      badgeTitleWorktree: 'Worktree branch: {branch}',
      dialogTitle: 'Manage worktrees',
      dialogSubtitle: 'Worktrees of {title}',
      close: 'Close',
      refresh: 'Refresh',
      prune: 'Prune stale records',
      pruned: 'Pruned the worktree records git no longer knows',
      empty: 'This repository has no worktrees yet',
      mainTag: 'Main worktree',
      missingTag: 'Directory missing',
      dirtyTag: 'Uncommitted changes',
      sessionsTag: '{n} sessions',
      open: 'Open',
      remove: 'Remove',
      confirmRemove: 'Confirm removal',
      forceRemove: 'Force removal',
      cancel: 'Cancel',
      removed: 'Removed {branch}',
      failed: 'Operation failed: {message}',
    };

    // ---- Remote contribution -------------------------------------------------
    //
    // Result codecs are pass-through parsers: the Host validates every payload
    // against the zod schemas in typert.host.js before it crosses the wire, and
    // this side only needs descriptor shapes to mount and call. Every codec is
    // strict and carries a create() factory, which the loader requires.
    const METHODS = ['status', 'list', 'branches', 'create', 'remove', 'prune', 'renameBranch'];

    const passthrough = () => ({ parse(value) { return value; } });
    const strictCodec = () => {
      const schema = passthrough();
      return { mode: 'strict', typeSymbol: 'json', schema, create: () => schema };
    };
    const descriptor = (method) => ({
      id: `dsh-worktree#worktree/${method}`,
      service: 'worktree',
      namespace: 'worktree',
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strictCodec() }],
      result: strictCodec(),
    });

    const TYPERT_REMOTE = {
      package: 'dsh-worktree',
      descriptors: METHODS.map(descriptor),
    };

    // ---- small observable ----------------------------------------------------
    //
    // A bare source handed to the renderer through an inject face's `hooks`
    // compartment; the renderer binds it into a `use<Name>` selector hook. This
    // is the only reactive channel this plugin uses, so no store import and no
    // subscription machinery inside the components.
    function createSource(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot() { return value; },
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    // ---- shared styles -------------------------------------------------------
    const controlStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px',
      borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, fontFamily: 'inherit',
      cursor: 'pointer', whiteSpace: 'nowrap',
    };
    const menuStyle = {
      position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40, minWidth: 260,
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.24)', fontSize: 13,
    };
    const primaryButtonStyle = {
      padding: '6px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-business-primary, #3b82f6)',
      background: 'var(--dsw-alias-state-business-primary, #3b82f6)', color: '#fff',
      fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
    };
    const ghostButtonStyle = {
      padding: '6px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
      fontFamily: 'inherit', cursor: 'pointer',
    };
    const bareButtonStyle = {
      padding: '2px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
      fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
    };
    const backdropStyle = {
      position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
    const panelStyle = {
      width: 'min(680px, calc(100vw - 48px))', maxHeight: 'min(620px, calc(100vh - 64px))',
      display: 'flex', flexDirection: 'column', gap: 12, padding: 18, borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-primary)', fontSize: 13, overflow: 'auto',
    };
    const rowStyle = {
      display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
    };
    const tagStyle = {
      display: 'inline-block', padding: '1px 6px', borderRadius: 6, fontSize: 11,
      border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)',
    };
    const errorStyle = { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 };
    const hintStyle = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 };

    /** Format one dictionary entry with `{name}` placeholders. */
    function format(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        params !== undefined && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }

    /** Message of a thrown value, for inline error lines. */
    function reasonOf(reason) {
      if (reason === null || reason === undefined) return 'unknown';
      return String(reason.message || reason);
    }

    // Pure presentation decisions, kept out of the components so they are
    // testable without a renderer.

    /** Whether the branch badge has anything to show for one status. */
    function badgeVisible(status) {
      return status !== null && status !== undefined && status.git === true && status.branch !== null;
    }

    /** Whether the worktree control applies to one status. */
    function controlVisible(status) {
      return status !== null && status !== undefined && status.git === true;
    }

    /** Base-revision options: the default first, then local branches, then remotes. */
    function baseOptions(branches, t) {
      if (branches === null || branches === undefined) return [];
      const options = [{ value: '', label: t('baseDefault') }];
      for (const name of branches.local || []) options.push({ value: name, label: name });
      for (const name of branches.remote || []) options.push({ value: name, label: name });
      return options;
    }

    /** Tag labels describing one manager row, in fixed order. */
    function rowTagLabels(entry, t) {
      const labels = [];
      if (entry.main) labels.push(t('mainTag'));
      if (entry.exists !== true) labels.push(t('missingTag'));
      if (entry.dirty === true) labels.push(t('dirtyTag'));
      if (entry.sessionCount > 0) labels.push(format(t('sessionsTag'), { n: entry.sessionCount }));
      return labels;
    }

    // ---- components ----------------------------------------------------------

    /**
     * Branch badge in the composer dock. Renders nothing outside a git
     * repository, and its click opens the manager dialog for the repository.
     */
    function BranchBadge(props) {
      const { sessionId, useWorkspaces, loadStatus, openManager, t } = props;
      const workspace = useWorkspaces(snapshot =>
        snapshot.items.find(item => item.sessionIds.includes(sessionId)));
      const [status, setStatus] = React.useState(null);
      const workspaceId = workspace === undefined ? undefined : workspace.workspaceId;
      React.useEffect(() => {
        let alive = true;
        setStatus(null);
        if (workspaceId === undefined) return () => { alive = false; };
        loadStatus(workspaceId).then(
          (value) => { if (alive) setStatus(value); },
          () => { if (alive) setStatus(null); },
        );
        return () => { alive = false; };
      }, [workspaceId, sessionId]);
      if (!badgeVisible(status)) return null;
      const title = format(status.isWorktree ? t('badgeTitleWorktree') : t('badgeTitle'), { branch: status.branch });
      return h('button', {
        type: 'button',
        style: controlStyle,
        title,
        'aria-label': title,
        onClick: () => openManager({ workspaceId, title: workspace.title }),
      }, `⎇ ${status.branch}`);
    }

    /**
     * Worktree control in the composer tool row: pick a base revision, create a
     * worktree, and start a session in it; or open the manager dialog.
     */
    function WorktreeControl(props) {
      const { sessionId, useWorkspaces, loadStatus, loadBranches, createWorktree, openManager, t } = props;
      const workspace = useWorkspaces(snapshot =>
        snapshot.items.find(item => item.sessionIds.includes(sessionId)));
      const workspaceId = workspace === undefined ? undefined : workspace.workspaceId;
      const [status, setStatus] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [branches, setBranches] = React.useState(null);
      const [base, setBase] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        setStatus(null);
        if (workspaceId === undefined) return () => { alive = false; };
        loadStatus(workspaceId).then(
          (value) => { if (alive) setStatus(value); },
          () => { if (alive) setStatus(null); },
        );
        return () => { alive = false; };
      }, [workspaceId, sessionId]);

      React.useEffect(() => {
        if (!open || workspaceId === undefined || branches !== null) return undefined;
        let alive = true;
        loadBranches(workspaceId).then(
          (value) => {
            if (!alive) return;
            setBranches(value);
            setBase(value.default || value.current || '');
          },
          () => { if (alive) setBranches({ local: [], remote: [], default: null, current: null }); },
        );
        return () => { alive = false; };
      }, [open, workspaceId, branches]);

      if (!controlVisible(status)) return null;

      const submit = () => {
        if (busy || workspaceId === undefined) return;
        setBusy(true);
        setError(null);
        createWorktree(workspaceId, base === '' ? undefined : base).then(
          () => { setBusy(false); setOpen(false); },
          (reason) => { setBusy(false); setError(format(t('failed'), { message: reasonOf(reason) })); },
        );
      };

      const options = baseOptions(branches, t).map(option => h(
        'option',
        { key: option.value === '' ? '__default__' : option.value, value: option.value },
        option.label,
      ));

      return h('span', { style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          style: controlStyle,
          title: t('controlTitle'),
          'aria-label': t('controlTitle'),
          'aria-expanded': open,
          onClick: () => { setOpen(value => !value); setError(null); },
        }, `⎇ ${t('control')}`),
        open && h('div', { style: menuStyle },
          h('label', { style: hintStyle }, t('base')),
          h('select', {
            value: base,
            disabled: branches === null || busy,
            style: { padding: '4px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2)', fontFamily: 'inherit' },
            onChange: event => { setBase(event.target.value); },
          }, options),
          h('button', {
            type: 'button',
            style: primaryButtonStyle,
            disabled: busy,
            onClick: submit,
          }, busy ? t('creating') : t('create')),
          h('button', {
            type: 'button',
            style: ghostButtonStyle,
            onClick: () => {
              setOpen(false);
              openManager({ workspaceId, title: workspace.title });
            },
          }, t('manage')),
          error !== null && h('p', { style: errorStyle }, error),
        ),
      );
    }

    /**
     * Manager dialog in the shell overlay: every worktree of one repository,
     * with open / remove / prune.
     */
    function WorktreeManagerDialog(props) {
      const { useManagerTarget, closeManager, listWorktrees, removeWorktree, pruneWorktrees, openWorkspace, t } = props;
      const target = useManagerTarget();
      const [rows, setRows] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const targetId = target === null ? undefined : target.workspaceId;

      const refresh = React.useCallback(() => {
        if (targetId === undefined) return;
        setRows(null);
        listWorktrees(targetId).then(
          (value) => { setRows(value.worktrees); },
          (reason) => { setRows([]); setError(format(t('failed'), { message: reasonOf(reason) })); },
        );
      }, [targetId]);

      React.useEffect(() => {
        setError(null);
        setNotice(null);
        setPending(null);
        refresh();
      }, [targetId, refresh]);

      if (target === null) return null;

      const run = (operation, done) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        operation.then(
          (value) => { setBusy(false); setPending(null); done(value); refresh(); },
          (reason) => { setBusy(false); setError(format(t('failed'), { message: reasonOf(reason) })); },
        );
      };

      const row = (entry) => {
        const key = entry.workspaceId === null ? `path:${entry.path}` : `ws:${entry.workspaceId}`;
        const tags = rowTagLabels(entry, t).map(label => h('span', { key: label, style: tagStyle }, label));
        const confirming = pending !== null && pending === entry.workspaceId;
        return h('div', { key, style: rowStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('strong', null, entry.branch === null ? '—' : `⎇ ${entry.branch}`),
            ...tags,
          ),
          h('div', { style: { ...hintStyle, wordBreak: 'break-all' } }, entry.path),
          entry.workspaceId !== null && h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('button', {
              type: 'button', style: bareButtonStyle, disabled: busy,
              onClick: () => { openWorkspace(entry.workspaceId); closeManager(); },
            }, t('open')),
            !entry.main && !confirming && h('button', {
              type: 'button', style: bareButtonStyle, disabled: busy,
              onClick: () => { setPending(entry.workspaceId); },
            }, t('remove')),
            !entry.main && confirming && h('button', {
              type: 'button', style: bareButtonStyle, disabled: busy,
              onClick: () => run(removeWorktree(entry.workspaceId, false), () => {
                setNotice(format(t('removed'), { branch: entry.branch === null ? entry.path : entry.branch }));
              }),
            }, t('confirmRemove')),
            !entry.main && confirming && h('button', {
              type: 'button', style: bareButtonStyle, disabled: busy,
              onClick: () => run(removeWorktree(entry.workspaceId, true), () => {
                setNotice(format(t('removed'), { branch: entry.branch === null ? entry.path : entry.branch }));
              }),
            }, t('forceRemove')),
            !entry.main && confirming && h('button', {
              type: 'button', style: bareButtonStyle, disabled: busy,
              onClick: () => { setPending(null); },
            }, t('cancel')),
          ),
        );
      };

      return h('div', {
        style: backdropStyle,
        role: 'presentation',
        onClick: event => { if (event.target === event.currentTarget) closeManager(); },
      },
      h('div', { style: panelStyle, role: 'dialog', 'aria-label': t('dialogTitle') },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('strong', { style: { fontSize: 15 } }, t('dialogTitle')),
          h('p', { style: hintStyle }, format(t('dialogSubtitle'), { title: target.title })),
        ),
        rows === null && h('p', { style: hintStyle }, t('loading')),
        rows !== null && rows.length === 0 && h('p', { style: hintStyle }, t('empty')),
        ...(rows === null ? [] : rows.map(row)),
        notice !== null && h('p', { style: hintStyle }, notice),
        error !== null && h('p', { style: errorStyle }, error),
        h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' } },
          h('button', {
            type: 'button', style: ghostButtonStyle, disabled: busy,
            onClick: () => run(pruneWorktrees(target.workspaceId), () => { setNotice(t('pruned')); }),
          }, t('prune')),
          h('button', {
            type: 'button', style: ghostButtonStyle, disabled: busy,
            onClick: refresh,
          }, t('refresh')),
          h('button', {
            type: 'button', style: primaryButtonStyle, onClick: closeManager,
          }, t('close')),
        ),
      ));
    }

    // ---- plugin --------------------------------------------------------------

    function apply(ctx) {
      const mountReady = ctx.remote.$mount(TYPERT_REMOTE);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-worktree: dictionaries');
      // One manager target shared by the composer control and the overlay
      // dialog: the control sets it, the dialog reads it through its bound hook.
      const managerTarget = createSource(null);

      const api = async () => {
        await mountReady;
        const remote = ctx.get('remote.worktree');
        if (!remote) throw new Error('the worktree remote is unavailable');
        return remote;
      };
      const unwrap = (result) => {
        if (result && result.ok === false) {
          throw new Error(`${result.error.code}: ${result.error.message}`);
        }
        return result && result.ok === true ? result.value : result;
      };

      const loadStatus = async (workspaceId) => unwrap(await (await api()).status({ workspaceId }));
      const loadBranches = async (workspaceId) => unwrap(await (await api()).branches({ workspaceId }));
      const listWorktrees = async (workspaceId) => unwrap(await (await api()).list({ workspaceId }));
      const pruneWorktrees = async (workspaceId) => unwrap(await (await api()).prune({ workspaceId }));
      const removeWorktree = async (workspaceId, force) => unwrap(await (await api()).remove(
        force ? { workspaceId, force: true } : { workspaceId },
      ));

      const createWorktree = async (workspaceId, baseBranch) => {
        const created = unwrap(await (await api()).create(
          baseBranch === undefined ? { workspaceId } : { workspaceId, baseBranch },
        ));
        // Merge the new Workspace row into the client projection before
        // navigating: ui-workspace resolves a target workspace from that
        // projection, so startSession() would not find it otherwise. The
        // unary call is idempotent — the Host resolves the directory the
        // creation just registered.
        const workspaces = ctx.get('workspaces');
        if (workspaces && typeof workspaces.create === 'function') {
          try {
            await workspaces.create({ path: created.path });
          } catch {
            // The follow stream still delivers the row; navigation may wait.
          }
        }
        const uiWorkspace = ctx.get('uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
          uiWorkspace.startSession(created.workspaceId);
        }
        return created;
      };

      const openWorkspace = (workspaceId) => {
        const uiWorkspace = ctx.get('uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.openWorkspace === 'function') {
          void uiWorkspace.openWorkspace(workspaceId);
        }
      };
      const openManager = (target) => { managerTarget.set(target); };
      const closeManager = () => { managerTarget.set(null); };

      const shared = { loadStatus, loadBranches, listWorktrees, removeWorktree, pruneWorktrees, createWorktree, openWorkspace, openManager, closeManager };

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'worktree-control',
        order: 40,
        locale: NS,
        inject: () => ({ ...shared }),
      }, WorktreeControl));

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'worktree-branch',
        order: 60,
        locale: NS,
        inject: () => ({ ...shared }),
      }, BranchBadge));

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'worktree-manager',
        locale: NS,
        inject: () => ({ ...shared, hooks: { managerTarget } }),
      }, WorktreeManagerDialog));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    // Render-path and contract test hooks (unused by the runtime).
    exports.__test = {
      TYPERT_REMOTE, METHODS, descriptor, createSource, format, reasonOf,
      badgeVisible, controlVisible, baseOptions, rowTagLabels,
      BranchBadge, WorktreeControl, WorktreeManagerDialog, zh, en,
    };
    return module.exports;
  },
});