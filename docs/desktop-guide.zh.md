# DeepSeek Harness 桌面端：使用方式与本地排障记录

本文记录对 dsh 官方桌面端（上游仓库中的 `apps/desktop`）的探索结论，以及一次其本地构建失败的完整排查过程，供本项目开发参考。

> ⚠️ **本文写于旧基线 `c291e7961a`（`0.1.5-rc.2`），部分内容已被上游改动推翻，尚未整体重写。**
> 已知失效处：启动页 `renderer/startup.html` / `startup.js` / `startup.css` 已被删除（等待界面改由网络前端
> BootPage 承担）；桌面插件窗口 `renderer/plugin-manager.html` 已被删除（插件管理改在应用内）；失败出口由
> 启动页改成原生恢复对话框；`src/host-protocol.ts`、`src/profile-packages.ts` 的图校验实现已被重构/删除；
> profile 清单不再校验精确版本。**当前基线与定制结论以 [design.zh.md](design.zh.md)、
> [decisions.zh.md](decisions.zh.md)、[reproduce.zh.md](reproduce.zh.md) 为准**，本文只作上游背景参考。

文中所有路径都相对**上游仓库根目录**（如 `apps/desktop`、`docs/`、`.agents/`），不是本仓库内的路径。官方方案的完整文档见文末「上游参考文档」。

## 1. 桌面端是什么

| 路径 | 角色 |
|---|---|
| `apps/desktop/` | Electron 壳：主进程、preload、启动页、插件管理窗口、打包脚本 |
| `apps/desktop-host/` | 私有 Host：在内置上游 Node 进程中启动 dsh 后端与客户端资源 |
| `apps/desktop-host/config/desktop.cordis.patch.yml` | 桌面组合相对 Web 组合的差异补丁 |
| `apps/desktop/README.zh.md` | 唯一一份完整文档：架构决策、开发、打包、更新 |

桌面端是一个包裹 dsh Web UI 的 Electron 壳，**不打开任何监听端口**。内置的上游 Node.js 子进程启动已安装的 dsh 项目，带版本的分帧字节管道承载 Fetch 请求与流式响应，Node IPC 只承载子进程生命周期控制，`dsh-app://` 提供与后端版本匹配的客户端资源。

桌面端没有独立的用户文档。`docs/user/guide/index.zh.md` 讲的「使用 Web UI」就是桌面端的界面指南，因为桌面端复用的正是同一套 Web 前端。

## 2. 运行模型

桌面组合与 Web 组合的差异全部落在 `desktop.cordis.patch.yml`：

- 禁用 `webserver`、`web-startup`、`web-runtime`：桌面端不开端口，没有 Web 服务
- 禁用 `client-hmr`：打包应用不做热更新
- 禁用 `open-in-app`、`ui-open-in-app`：该功能依赖 HTTP 路由
- 禁用 `directory-picker`，插入 `directory-picker-native` 与 `ui-directory-picker-native`：改用原生目录选择器
- `connection` 注入 `credentials`

关键实现：`src/main.ts`（主进程）、`src/host-process.ts`（Host 子进程）、`src/host-protocol.ts`（分帧管道协议）、`src/project-manager.ts`（profile 与插件事务）。

## 3. 终端用户怎么用

启动顺序（`src/main.ts`、`src/locale.ts`；**下面是 `0.1.6-alpha.2` 的实情**）：

1. 主窗口先加载 `dsh-app://app/`，网络前端的 BootPage 负责「还在等后端」的界面（本地在这上面挂加载动画）
2. 首次启动创建 `$DSH_HOME/profiles/desktop` 清单，然后启动一次实际后端
3. 后端就绪后同一份文档继续挂载真实 Web UI
4. 之后与 Web 形态一致：**设置 → 模型**填 API key → **选择工作区** → 开始任务

失败时弹**原生恢复对话框**：退出 / 重启 / 禁用第三方插件并备份 profile patch（外加重新安装的建议）。

应用菜单（`src/main.ts`）：

| 菜单项 | 快捷键 | 说明 |
|---|---|---|
| 检查更新… | — | 启动 10 秒后自动检查一次；可用时弹确认框「安装并重启」 |

插件管理不再是桌面端的一个窗口，改在应用内完成。

### 数据与隔离

- **共享**：`$DSH_HOME`（默认 `~/.dsh`）下的会话、设置、凭据、工作区、存储
- **独占**：`$DSH_HOME/profiles/desktop` 及其包管理器状态（`$DSH_HOME/desktop/pnpm/store`）
- 可执行包、插件激活、锁文件、`node_modules` 与 CLI 完全隔离；CLI 不能启动或修改 desktop profile
- 内置第一方包通过目录软链接（macOS/Linux）或 junction（Windows）链接进 profile
- Electron 在访问任何 profile 前获取进程生命周期单实例锁

## 4. 开发者怎么跑

```sh
pnpm install
pnpm run dev:desktop     # 构建壳/Host/客户端/Web 前端 + 一次性 npm 项目 + 启动 Electron
pnpm run start:desktop   # 跳过构建，用已有产物启动
```

开发态刻意隔离，不污染真实 Harness 数据：

| 内容 | 位置 |
|---|---|
| Harness 状态 | `apps/desktop/.desktop-build/development/home` |
| 一次性 npm 项目 | `apps/desktop/.desktop-build/development/project` |
| Electron 用户数据 | `apps/desktop/.desktop-build/development/electron-user-data` |

调试端口默认 Main 9229、Renderer 9222、Host 9230，Renderer DevTools 自动打开。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT`、`DSH_DESKTOP_HOST_INSPECT_PORT` 可替换端口；`DSH_DESKTOP_OPEN_DEVTOOLS=0` 保持调试窗口关闭。

未打包的 Electron 进程还支持 `DSH_DESKTOP_NODE_BINARY`、`DSH_DESKTOP_PNPM_ENTRY`、`DSH_DESKTOP_DSH_DIR` 指定运行时资源；打包应用忽略这些变量。

## 5. 打包与发布

```sh
pnpm run package:desktop:win:x64:unsigned   # Windows 本机测试，无需签名
pnpm run package:desktop:mac:arm64          # 需要签名身份、Team ID、公证凭据
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

补充命令：

- `:dir` 变体（如 `package:desktop:win:x64:dir`）生成可直接运行的应用目录而非安装包
- `prepare:desktop` 在准备完成后停止，用于诊断宿主目标资源，不是两段式构建的前半段
- `pnpm --dir apps/desktop run verify:mac-signature -- <path>` 重复校验 macOS 应用签名

要点：

- 所有目标都需要 `DSH_DESKTOP_APP_ID`（反向域名）
- macOS 额外需要 `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`、`DSH_DESKTOP_MACOS_TEAM_ID` 与完整 notarytool 凭据
- Windows 发布签名需要 `DSH_DESKTOP_WINDOWS_*` 四个输入（EV 证书、SignTool、SafeNet 容器、Token PIN）
- 自动更新由 electron-updater 承担，目标路径 `_/harness/desktop/stable/<target>/`；`DSH_DESKTOP_AUTO_UPDATE_ENV` 选 `test` 或 `production`
- **Linux 不是受支持的桌面发布目标**
- Electron 与 `@deepseek-ai/dsh` 永远同版本，升级 dsh 必须发 Desktop 版本

每个目标的产物落在 `apps/desktop/.desktop-build/targets/<target>/`，Node.js 归档缓存在 `.desktop-build/downloads` 共享。

## 6. 本次排障：dev:desktop 构建失败

### 现象

`pnpm install` 后执行 `pnpm run dev:desktop`，在根构建的 tsdown 阶段失败：

```
Error: [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
```

### 根因一：已删除包留下的残留目录

`packages/*/*` 下有 9 个目录没有 `package.json`，每个只剩一个 `node_modules`：

```
packages/client/runtime                 packages/host/apiproxy
packages/code-runtime/code-runtime-python  packages/session/session-persistence-sqlite
packages/examples/acp-demo              packages/subagent/tool-subagent-report
packages/examples/agent-spine-demo      packages/test-support/acp-snapshot
packages/examples/jsonrpc-demo
```

它们来自历史重构中删掉的包（对应提交 `refactor(api): remove ApiProxy package`、`refactor(client): migrate consumers and remove Runtime`）。因为 `node_modules/` 被 gitignore，`git status` 保持干净。

失败机制：

1. 根 `tsdown.config.ts` 用 `workspace: ['vendor/*', 'packages/*/*', 'apps/cli', 'apps/desktop', 'apps/desktop-host']` 展开构建目标，glob 匹配的是**目录本身**，不要求 `package.json`
2. 这些目录没有自己的 `tsdown.config.ts`，tsdown 的 `loadConfigFile` 返回 `[{}]` 并把 `cwd` 设为该目录
3. 合并父配置后，`entry` 变成根配置的 glob `lib/types/{index,invariant,startup}.js`，相对该目录解析
4. 目录里只有 `node_modules`，glob 无匹配 → `Cannot find entry`

报错标签 `[@deepseek-ai/dsh-root]` 具有误导性：tsdown 的 `resolveUserConfig` 通过 `readPackageJson(cwd)` 取名字，而它会**向上查找**，从这些残留目录找到了仓库根的 `package.json`。所以报错看起来像根包的问题，实际来自残留目录。

CI 不复现的原因：干净 checkout 上这些目录不存在（git 不跟踪空目录，其内容只有被忽略的 `node_modules`）。

### 根因二：悬空符号链接

清掉残留目录后暴露出第二层问题，发生在 `apps/desktop` 的 `tsc -b && tsdown`：

```
ENOENT: no such file or directory, stat '...\node_modules\.pnpm\node_modules\@deepseek-ai\dsh-acp-demo'
```

`node_modules/.pnpm/node_modules/@deepseek-ai/` 下共有 11 个悬空链接：9 个指向刚删除的残留目录，另外 2 个（`node-addon-landlock-run-linux-arm64`、`-x64` 指向 `native/landlock-run/packages/linux-*`）是更早一次 install 遗留的死链接。这些链接的时间戳明显早于最近一次 `pnpm install`，说明 pnpm 不会清理它们。

### 修复

1. 删除 9 个残留包目录
2. 删除 11 个悬空符号链接

`pnpm install` 单独跑无法解决：残留目录没有 `package.json`，pnpm 不把它们视为包，因此不清理；而 tsdown 的 glob 会匹配到目录本身。

### 复发时的处理

仓库自带 `pnpm run clean`（`scripts/clean.ts`）。它遍历 `packages/<group>/<pkg>`，跳过有 `package.json` 的活包，对无清单的目录**仅当剩余条目全部属于 `node_modules` / `lib` / `.typecheck` / `*.tsbuildinfo` 时才删除**，遇到未知文件会拒绝执行而不是误删。

代价：`clean` 同时会删除 `lib/`、`.desktop-build`、`*.tsbuildinfo`，之后 `dev:desktop` 需要全量重建（数分钟）。

## 7. 已知限制

- Web 的「在本地应用中打开…」在 Desktop 被禁用：该功能依赖 HTTP 路由，而 Desktop 不提供 `webServer`
- 发布签名、公证、更新托管、跨版本已安装产物验证都需要生产发布环境
- 依赖包含 lifecycle script 的桌面插件，只有包名进入经过评审的 `allowBuilds` 列表后才能安装
- 桌面壳与 CLI 共享 `$DSH_HOME` 下的会话、设置、凭据、工作区与存储，但可执行包、插件激活、锁文件与包管理器状态彼此隔离
- 开发模式（未打包）不提供插件管理与自动更新，这两项只在打包应用中可用

## 上游参考文档

下表路径均相对上游仓库根目录。

| 内容 | 位置 |
|---|---|
| 桌面端完整文档：架构决策、开发、打包、更新 | `apps/desktop/README.zh.md` |
| 打包与更新的理由、替代方案、安全约束 | `.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md` |
| Web UI 使用指南（桌面端复用同一界面） | `docs/user/guide/index.zh.md` |
| 桌面组合相对 Web 组合的差异补丁 | `apps/desktop-host/config/desktop.cordis.patch.yml` |
| 构建残留清理实现（[本次排障](#6-本次排障devdesktop-构建失败)提到的 `clean`） | `scripts/clean.ts` |
| 客户端 UI 文案字典（菜单、启动页、插件窗口） | `apps/desktop/src/locale.ts` |
