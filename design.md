# dsh-worktree 设计记录

这份文件记录**已确定的决策**、**被否掉的方案**，以及**必须落在 DSH 侧、本仓库做不到的三件事**。实现细节见 README.md 与源码注释。

## 目标

在 DSH 的 Web GUI 里支持 git worktree 工作流：

1. 会话开始前选择「在新的 worktree 中运行」，可选起始分支（默认仓库默认分支）。
2. 会话开始后，分支名自动取自 DSH 生成的会话标题。
3. 侧边栏把 worktree 合并到父工作区下，并显示分支名。
4. 对话区底部显示当前 git 分支名。
5. 工作区快捷菜单里有「管理 worktree」，弹窗里做管理。

## 已确定的决策

| 决策 | 值 | 理由 |
|---|---|---|
| worktree 根目录 | `$DSH_HOME/worktrees/<repo>/<branch>` | 与仓库工作树分离，便于集中清理；`<repo>` 同名冲突时追加路径短 hash |
| 创建方式 | 只新建分支 + worktree | 不提供「选择已有 worktree」；避免复用别人正在用的目录 |
| 起始点 | `git worktree add -b <new> <path> <base>`，base 显式解析 | 绝不隐式使用主工作区当前 HEAD |
| base 默认 | `refs/remotes/origin/HEAD` → `main`/`master` → 当前分支 | 显式给了但解析不到时直接报错，不静默退回 |
| 分支名来源 | DSH 自动生成的会话标题 | 不随机命名，不使用工作区名 |
| 创建时机 | 用户确认时立即创建 worktree | 会话 cwd 创建后不可变，必须先有目录才能开会话 |
| 占位分支 | `wip/<8位十六进制>` | 标题在创建时尚不存在；重命名失败时 worktree 仍可用 |
| 分支重命名 | 标题就绪后 `git branch -m`，不移动目录 | 目录名是路径标识，迁移会牵连会话 cwd |
| 纯非 ASCII 标题 | 保持占位分支 + warn | 不发明与标题无关的名字 |
| 存储 | 插件自己的 `$DSH_HOME/worktree.state.json` | 目标 DSH 版本的 Workspace 记录没有 worktree 字段；不改动 DSH 持久化 |
| worktree 的 DSH 身份 | 注册成**普通 Workspace**（`ctx.workspaceRegistry.create`） | 会话 cwd 归属靠 canonical path 相等；只有注册成 Workspace，会话才被正常记账并出现在侧边栏 |
| 不做 | 会话内 `/worktree` 命令、自动 merge/rebase、继承未提交改动 | 会话切换语义与 cwd 不可变冲突；merge 属于用户决策 |

## 被否掉的方案

- **不注册 Workspace，直接 `session.create({ cwd })`。** 否决：`SessionCommandController.create` 只有在给出 `workspaceId` 时才 `attachSession`，用 `cwd` 创建的会话不会进入任何 workspace，于是落在侧边栏的 "Ungrouped" 桶里。
- **修改 DSH 的 `WorkspaceRecord` 加 `parentWorkspaceId`/`branch`。** 否决（本轮）：storage-domain 的 `single` 布局在版本不匹配时直接抛 `version-mismatch`（`packages/storage/storage-json/src/format.ts` 的 `version !== descriptor.version`），而 `compatibleVersions` 只对 `per-record` 布局生效；bump 版本会让现有用户的 workspace 状态不可读。这个改动应在上游 DSH 里连同迁移与确认记录一起做。
- **在侧边栏用「按路径嵌套」把 worktree 收进父工作区。** 否决：worktree 在 `~/.dsh/worktrees/...` 下，不在仓库目录内，路径归属推断不到父工作区；而且嵌套只在 `workspace-tree` 分组模式下生效。
- **插件里自建 hero 座位 / 工作区菜单项。** 不可行：slot 必须由父入口的 `children` 声明，注册到未声明的 slot 会抛 `slot "..." is not declared`。

## 必须落在 DSH 侧的三件事

以下三条**本仓库无法实现**，需要改 DSH 本体（`running-grass/deepseek-harness` fork 或上游 PR）：

### 1. 侧边栏把 worktree 合并到父工作区

- `packages/workspace/workspace/src/spec.ts`：`workspaceRecord` 增加可选的成对字段 `parentWorkspaceId` / `branch`；因涉及持久化类型变更，需要按 `docs/cookbook/reviewing-persistence-type-changes.md` 补确认记录（保持 `workspaceDomainSpec.version` 不变或另做迁移）。
- `packages/workspace/workspace/src/types.ts`、`entity.ts`、`index.ts`：`Workspace` 增加 `worktree` 只读投影与 `setBranch`。
- `packages/api/workspace-controller/src/types.ts`、`feed.ts`：`WorkspaceView` 透出 `worktree`。
- `packages/client/ui-workspace/src/client/tree.ts` 与 `rows/WorkspaceBrowser.tsx`：`GroupNode` 增加 `parentKey` / `branch`，`SessionTree` 的 `parents` 映射优先取 `workspace.worktree.parentWorkspaceId`，并在所有分组模式下生效；行 label 显示分支名。

### 2. 工作区快捷菜单的「管理 worktree」

- `packages/client/ui-workspace/src/client/contract/slots.ts`：新增 `sidebar.workspaces.workspace.menu.item`（`kind: 'list'`, `scope: 'root'`），owner props 带 `{ workspaceId, displayTitle, branch? }` 与菜单开合 hookContext，与既有 `sidebar.workspaces.session.menu.item` 对称。
- `src/client/index.ts`：在 `sidebar.workspaces` 的 `children` 里声明该 list。
- `src/client/rows/Rows.tsx`：`ProjectRowItem` 在原生 rename/delete 之外渲染该 slot。
- 之后本插件把「管理 worktree」注册进这个 slot 即可，无需其它改动。

### 3. 会话前的 hero 座位

- `packages/client/ui-conversation/src/client/contract/slots.ts`：新增 `conversation.hero.worktree`（`kind: 'single'`, `scope: 'session-maybe'`），与 `conversation.hero.agentPreset` 对称。
- `src/client/apply.ts` 的 `conversation.content` children 与 `skeleton/ConversationContent.tsx` 的渲染点各加一行。
- 之后本插件把当前 composer 工具行的控件搬过去即可。

三条都做完后，本插件只需改 `client.js` 的注册目标与 `list` 的父工作区解析（改用 `WorkspaceView.worktree`），Host 侧与 `service.js` 不变。

## 与 DSH 现有结论的关系

`packages/experimental/agent-team/README.md` 把「自动创建 worktree」列为**已否决**的 Team 行为，理由是 worktree 的创建、分支命名、忽略文件、构建产物与清理都是部署选择。本插件不违反那条结论：这里的 worktree 由**用户显式触发**，命名来自会话标题，位置来自配置，并且只服务于「在这个目录里开一个会话」，不参与 Team 的分工与合并。

## 测试策略与缺口

覆盖：命名与目录策略（纯函数）、状态文件（含容错解析与原子写）、git 层（真实临时仓库：显式起点、脏目录拒绝、分支重命名、prune）、服务层（创建/登记/列表/标题重命名/移除准入/重启对账）、打包契约、浏览器半部的 Remote descriptor 与三处注册。

未覆盖：**组件渲染**。仓库没有构建步骤，React 只是 peer 依赖，因此组件用 `React.createElement` 写成、在浏览器里人工验证；`client.js` 把纯展示判断（`badgeVisible` / `controlVisible` / `baseOptions` / `rowTagLabels`）抽成纯函数并导出到 `__test`，由测试覆盖这些判断本身。

另一个未验证项：**真实 DSH 加载**。Typert manifest、`dsh.client` roster 行与 `cordis.patch.yml` 都按 DSH 0.2.1-alpha.1 的既有插件（`dsh-opencode-go-pool`）形状手写，但只有把它装进 web profile 并重启 DSH 才算真正验证过。