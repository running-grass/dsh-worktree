# dsh-worktree

DeepSeek Harness (DSH) 插件：**用 git worktree 开会话**。会话前选一个起始分支，插件创建 worktree、把它注册成一个工作区，并在里面开新会话；会话标题生成后，worktree 的占位分支名会自动改成标题的 slug。

DSH 的会话 cwd 在创建后不可变，所以「在另一个目录里干活」只能通过新会话实现。这个插件把整条链路接了起来：`git worktree add` → 注册 Workspace → 在该 Workspace 开会话 → 标题就绪后 `git branch -m`。

## 功能

| 位置 | 控件 | 行为 |
|---|---|---|
| composer 工具行左侧 | `⎇ worktree` | 选起始分支 → 新建 worktree 并开新会话；或打开管理弹窗 |
| composer 卡片下方 | `⎇ <branch>` | 显示当前会话所在仓库的分支；点击打开管理弹窗 |
| 框架浮层 | 管理 worktree 弹窗 | 列出该仓库的全部 worktree，支持打开 / 移除 / 清理失效记录 |

非 git 仓库里三处控件都不渲染。

## 安装

```sh
dsh plugin --profile web add github:running-grass/dsh-worktree
```

重启 DSH（插件变更需要重启进程才会加载新的 JS 模块）。

### 手工安装（等价步骤）

在 `$DSH_HOME/profiles/web/package.json` 里加依赖，并把包名加进 `dsh.profile.bundles`：

```json
{
  "dependencies": { "dsh-worktree": "github:running-grass/dsh-worktree" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-worktree"] } }
}
```

> 前置：Host 侧需要可用的 `git`。插件通过 `ctx.subprocess` 调用它，启动时解析一次；解析不到就整体静默（控件不出现），不会报错。

## 分支命名

DSH 的会话标题是从首条用户消息生成的，**创建 worktree 时标题还不存在**。所以命名分两步：

1. 创建时用占位分支 `wip/<8位十六进制>`，目录 `~/.dsh/worktrees/<repo>/wip-<8位十六进制>`。
2. 标题生成后，插件把它 slug 化成简短分支名并执行 `git branch -m`，同时把工作区标题改成同名。

slug 规则：NFKD 折叠变音符 → 小写 → 非 `[a-z0-9]` 折叠成 `-` → 去首尾 `-` → 截断 48 字符 → 与仓库已有分支重名时追加 `-2`、`-3`。

**纯非 ASCII 标题**（例如「修复解析器」）slug 为空，此时**保持占位分支不动**并记一条 warn。这是刻意的：不发明与标题无关的名字，也不随机命名。

## 磁盘位置与状态

- worktree 目录：`$DSH_HOME/worktrees/<repo>/<branch>`（`worktreesRoot` 可配置；分支名里的 `/` 在目录名中替换为 `-`）。
- 状态文件：`$DSH_HOME/worktree.state.json`，记录 `workspaceId → { path, repoRoot, branch, provisional, createdAt }`。

状态文件只是缓存：git 与 DSH 的 Workspace registry 优先级更高，启动时会丢弃工作区注册或目录已消失的条目。

**分支重命名不会移动目录。** 目录名取自创建时的分支名，之后保持原样。

## 工作原理

```
[host] dsh-worktree（index.js → service.js）
   ├─ ctx.subprocess          git worktree add -b <new> <path> <base>
   │                          显式指定起点，绝不用主工作区当前的 HEAD
   ├─ ctx.workspaceRegistry   create(path, branch) → 新目录登记为 Workspace
   ├─ sessionProjections      'title' 投影就绪 → slug → git branch -m → setTitle
   └─ $DSH_HOME/worktree.state.json

[client] client.js（lazy-CJS 浏览器半部）
   ├─ conversation.input.left     worktree 控件
   ├─ conversation.composer.dock  分支徽章
   └─ shell.overlay               管理弹窗
```

Host 与浏览器两半的 Typert manifest 都是手写的（`typert.host.js` + `client.js` 里的 `TYPERT_REMOTE`），没有构建步骤：`package.json` 的 `exports["./typert"]` 被 typert-loader 读取，`dsh.client` 让浏览器半部进 roster。

`service.js` 不 import 任何 DSH 包，所以 `node --test` 能用鸭子类型的 ctx 直接驱动它；`index.js` 是唯一的 DSH 依赖面，负责解析 `$DSH_HOME` 路径并暴露 `worktree/*` 的 7 个直接调用。

### Remote 契约

| 方法 | 请求 | 结果 |
|---|---|---|
| `status` | `{ workspaceId }` | `{ git, repoRoot, mainRoot, branch, isWorktree, dirty }` |
| `list` | `{ workspaceId }` | `{ worktrees: [{ workspaceId, path, branch, title, main, exists, registered, dirty, sessionCount }] }` |
| `branches` | `{ workspaceId }` | `{ current, default, local, remote }` |
| `create` | `{ workspaceId, baseBranch? }` | `{ workspaceId, path, branch }` |
| `remove` | `{ workspaceId, force? }` | `{ removed }` |
| `prune` | `{ workspaceId }` | `{ pruned }` |
| `renameBranch` | `{ workspaceId, branch }` | `{ branch }` |

`create` 的 base 解析顺序：显式 `baseBranch` → `refs/remotes/origin/HEAD` → 存在的 `main` / `master` → 仓库当前分支。显式给了但解析不到会直接报错，不会静默退回 HEAD。

## 已知限制

- **侧边栏不会把 worktree 收进父工作区**。worktree 会作为**顶层**工作区出现，标题是分支名。分组逻辑在 DSH 的 `ui-workspace` 内部派生（`packages/client/ui-workspace/src/client/tree.ts`），外部插件改不了。
- **工作区行的快捷菜单里没有「管理 worktree」**。工作区菜单项在 DSH 里是硬编码的（`rows/Rows.tsx`），没有对应 slot；本插件把入口放在 composer 工具行和管理弹窗里。
- **没有会话前的 hero 座位**。DSH 只给 agent preset 声明了 hero 座位；本插件用 composer 工具行的 `conversation.input.left`，在空白会话里同样可以「发首条消息之前」选择。
- **不能选择已有 worktree**，只能新建分支 + worktree。
- **只支持一层**：worktree 的工作区不能再创建 worktree。
- **分支重命名不迁移目录**。
- **纯非 ASCII 标题**保持占位分支（见上）。
- **独立插件只能占用上游已声明的 slot**：注册到未声明的 slot 会直接抛错（`ui-slots/src/index.ts` 的 "slot is not declared"）。

上面三条能力缺口需要 DSH 侧改动，方案记在 [design.md](design.md)。

## 开发

```sh
npm install     # 只装 zod
npm test        # node --test，61 项，不需要 DSH 检出
```

测试分层：`branch` / `state` 是纯函数；`git` 用真实临时仓库驱动 `GitRunner`；`plugin` 用鸭子类型 ctx + 真实仓库驱动 `service.js`；`patch` 守住打包契约；`client` 通过 stub module loader 加载浏览器半部，验证 Remote descriptor、字典键、三处注册与注入面。组件渲染不在测试覆盖内（没有构建步骤和 React 运行时），需在浏览器里人工验证。

## 许可

MIT