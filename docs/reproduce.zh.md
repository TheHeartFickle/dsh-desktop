# 探索内容与复刻命令

> 本文是 `docs/` 三份设计文档之一：[当前设计](design.zh.md)（是什么、怎么做） ｜
> [重大决策与原因](decisions.zh.md)（为什么） ｜ **探索内容与复刻命令**（怎么跑、怎么验证、实测到什么）；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 源仓库 | `deepseek-harness/`（仓库根下的 clone，独立 `.git`，可 checkout 到任意提交） |
| 已验证基线 | commit `ddefc45fbc7f8e46dd73185e68295696d1297887`，tag `dsh-v0.1.6-alpha.2`，版本 `0.1.6-alpha.2` |
| 上一基线 | `c291e7961a515f6d7af9304e7fd1d257929aef26`，版本 `0.1.5-rc.2`；两者差 1548 个提交，`apps/desktop` 下 289 文件 / +20850 −4056 行 |
| Node | `C:\Program Files\nodejs\node.exe` v24.13.0（满足 `engines: ^22.19.0 \|\| >=24.0.0`） |
| pnpm | 全局 npm 装的是 **11.22.0**，但源仓库 `package.json` 声明 `packageManager: pnpm@11.7.0`，pnpm 自管理会切到 **11.7.0**（实际使用的版本）。**store 必须与该版本匹配**（见 R9） |
| pnpm store | `D:\.pnpm-store\v11` |
| 包缓存选盘 | C/D 为 KIOXIA、E 为 ZHITAI，跨盘会失去硬链接；store 与仓库同置于 D 盘 |
| Electron | 44.0.0（`apps/desktop/node_modules/electron`，随上游 lockfile 变化） |
| 镜像 | `~/.npmrc` 里配置了 `registry=https://registry.npmmirror.com`（注意上游构建会屏蔽它，见 R10） |
| 打包需要 | `apps/desktop/.env.windows`（官方的发布设置文件，**唯一来源**；构建按配置的 `releaseEnv` 从官方模板生成，见 R29）；`--unsigned` 模式下不需要签名证书 |
| 冒烟取证 | `DSH_DESKTOP_DIAGNOSTIC_FILE`：设置后主进程把启动阶段（`phase=starting / ready / error`、`phase=application-page`）追加进该文件；未设置时完全不写（见 R21/R22） |

> 源仓库的依赖（`node_modules`）与构建产物都**不随本仓库同步**：新机器 clone 后需先安装依赖，再按[复刻命令](#3-复刻命令)构建。

## 2. 关键踩坑与常用手段

### 2.1 构建与环境

| # | 现象 | 根因与对策 |
|---|---|---|
| R1 | `pnpm run dev:desktop` 报 `Error [TransformError]: spawn EPERM (esbuild/lib/main.js:2268)` | 构建脚本全经 `tsx`，tsx 依赖 esbuild 启动 helper 子进程（命名管道）。**对策**：受限环境用 `node --experimental-transform-types <script.ts>` 替代；见 [tsx shim](#5-tsx-shim仅受限沙箱环境) |
| R2 | 隔离失效、污染真实 `~/.dsh` | dev 启动器用 `process.env.DSH_HOME ?? 隔离目录`，外层已注入 `DSH_HOME` 时会静默走真实 home。**对策**：启动前显式赋值 |
| R3 | 桌面端一启动，agent loop 卡死 | 与运行中的 agent 会话共用 `$DSH_HOME`。**对策**：验证时一律用独立 home |
| R4 | 直接跑 `electron.exe <APP_ROOT>` 显示官方恢复页 | 跳过了 `prepareDevelopmentProject()`——它每次都删除并重建 `.desktop-build/development/project` 并写入运行元数据。**对策**：走完整启动器 |
| R5 | 长任务把 agent loop 卡死 | 巨量 stdout 灌满 subprocess 管道（**实测卡死两次**）。**对策**：`*> 日志文件` 或后台 + 只读日志尾部。构建入口 (`scripts/build.mjs`) 自己按这条实现：子进程输出全量进 `.cache/build/build.log`，**只在 stdout 是终端时**同步回显一份（决策 10）。**因此「构建停在 `build: pnpm 入口 …` 一行不动」是预期而不是卡住**：看进度用 `Get-Content .cache\build\build.log -Tail 20`（`-Wait` 可跟），或读 `apps/desktop/.desktop-build/packaging-runs/<最新>/events.jsonl`（每条阶段 start/end 带 `code`/`timedOut`；`electron-builder` 那段静默最久，判活看 `unsigned-artifacts\win-unpacked` 的大小在涨、以及那个 node 进程的 CPU 在涨）。**光看 `build.log` 的 mtime 会误判**——electron-builder 拷文件和打 asar 时可能几分钟不写一行 |
| R6 | 插件树加载失败导致后端起不来、日志刷屏 | 旧基线上游 smoke 检查要求已被 `node-addon-system` 取代的 `fs-ext`，当时的对策是 patch 层容忍其缺失（功能层 `smoke-tolerance.mjs` 封装判断）。**`0.1.6-alpha.2` 起上游整体删除了 `checkFsExt`**，没有可容忍的检查，该功能层与对应 patch 一并移除（决策 30） |
| R7 | `pnpm config set … --global` 静默不生效 | 它触发无关的 global-bin PATH 检查而中断。**对策**：用 `--location=global` |
| R8 | `pnpm run X -- --unsigned` 参数传错；`pnpm exec tsx …` 报 `invoke this script through a pnpm package command` | pnpm 把 `--` 当字面参数传入；且 `pnpm exec` 不设置 `npm_execpath`，而 `package-target.ts` 的 `runPnpm()` 强制要求它 |
| R9 | `pnpm install` 报 `unable to open database file` | **pnpm 版本与 store 不匹配**：store 的 `index.db` 由某个大版本建立，另一个版本打不开。本机全局 pnpm 是 11.22.0，源仓库却声明 `pnpm@11.7.0`（自管理切换），两者共用同一个 `store-dir` 就冲突。**对策**：让 store 与「实际调用的 pnpm 版本」一致——本机按 11.7.0 重建；旧 store 备份在 `.pnpm-store.bak-1121` |
| R10 | `prepare:dsh` 报 `ERR_PNPM_META_FETCH_FAIL … registry.npmjs.org … timeout` | `apps/desktop/scripts/prepare-dsh.ts` 的 `runPnpm()` **硬编码** `registry.npmjs.org`，并过滤掉 `npm_*`/`pnpm_*`/`corepack_*`/`DSH_DESKTOP_*` 环境变量、把 `XDG_CONFIG_HOME` 指向临时目录——本机任何镜像配置都进不去。**对策**：patch 层把 registry 改为读 `DSH_LOCAL_NPM_REGISTRY`（不设时仍是官方地址，行为不变） |
| R11 | 构建报 `spawn EPERM`（esbuild helper），继而 `spawnSync git` 也 EPERM | 受限沙箱禁止命名管道与管道式子进程。**对策**：tsx shim 只能绕过 esbuild 一个点，**受限沙箱下无法完成构建**，必须在可 spawn 子进程的环境运行 |
| R12 | 每次构建 10 分钟以上，失败后重跑仍从头开始 | 源仓库构建体系没有阶段级跳过：`scripts/build.ts` 无条件顺序跑 `build:native-system` / `build:lib` / `build:web`；`release:pack` 对全部包逐个 `pnpm pack`；`prepare:*` 重建产物目录；`electron-builder` 全量重打包。只有 `tsc -b` 自带增量。**已实现缓存与并行打包，见 design 的[构建脚本时间优化](design.zh.md#41-构建脚本时间优化已实施)与本文的[构建缓存的实现与实测](#4-构建缓存的实现与实测)** |
| R13 | 构建报 `tar (child): Cannot connect to D: resolve failed` | 在 **Git Bash** 里跑构建时，PATH 里的 MSYS `tar` 把 Windows 路径 `D:\...` 当成 `host:path`。**对策**（按可用环境二选一）：① 用 PowerShell / CMD 跑；② 只能用 Git Bash 时，把 Windows 版 tar 前置到 PATH —— `mkdir -p .cache/pathshim && ln -sf /c/Windows/System32/tar.exe .cache/pathshim/tar.exe`，然后 `PATH="$(pwd)/.cache/pathshim:$PATH" node scripts/build.mjs`（`.cache/` 已被忽略，实测可用）。**注意**：本仓库 agent 环境的 pwsh 工具受沙箱限制，node 在里面无法 spawn 子进程（`spawnSync git EPERM`，即 R11），所以本机实际走的是 ② |

### 2.2 构建缓存与产物

| # | 现象 | 根因与对策 |
|---|---|---|
| R14 | 同一成员 `pnpm pack` 两次，tarball 的 sha256 不同 | 上游打包**不是字节可复现**的：差异只在打包后 manifest 的键顺序（tar/gzip 头与文件清单一致）。缓存判据由此确定 —— 见 [decisions.zh.md](decisions.zh.md) 第 16 条 |
| R15 | 缓存明明该命中却每轮报 `miss (no-marker)` | marker 一度放在**源仓库根**的 `.desktop-build/local-cache/`，而 `.gitignore` 只忽略 `apps/desktop/.desktop-build/` —— 根目录那份被第 3 步 `git clean -fd` 每轮删掉。**对策**：marker 一律落在 `apps/desktop/.desktop-build/targets/<target>/local-cache/`（被忽略，构建流程的各阶段都不会清它；上游 `pnpm clean` 会清整个 `.desktop-build/`，属预期的冷缓存重置） |
| R16 | 想确认某次构建到底重做了什么 / 想强制全量重做 | 每个缓存决策都往构建日志（`.cache/build/build.log`）打一行 `build-cache: <stage> hit\|miss (<原因>)`。marker 有两处：`apps/desktop/.desktop-build/targets/<target>/local-cache/*.json`（`build-official`、`prepare-dsh-<target>`、`package-dir-<target>`）与 `.../packed/.pack-cache/<family>/*`（tarball 成员；私有 Host 与 native entry 另有 `<name>/packed/` 与 `tarball.json`）。删掉这两处即回到冷缓存；改 `src/build.config.json` 的 `tag`（或 tag 被重指到别的提交）会自动让全部缓存失效 |
| R17 | 源码一行没改，`prepare:dsh` 却每轮 `miss (key-changed)` | 有两个 `pnpm pack` **不经 `release:pack`**、因此没进成员缓存：私有 Host（`apps/desktop-host`）与 native entry（`native/system/packages/entry`）——前者由 `package-target.ts` 直接 pack，后者在 `rmSync` 后 pack。而 `pnpm pack` 字节不可复现（R14）→ 它们的 `integrity` 每轮都变 → `prepare:packages` 生成的 package set 变 → `prepare:dsh` 的键跟着变。**对策**：两处也走同一套缓存（缓存 packed 出来的目录，再拷进输出目录）。定位方法：构建前后各算一遍逐项 `contentKey`，变化的那一项就是元凶（`prepare:packages` 本身是确定的：同一输入重跑 242 个文件 0 差异） |
| R18 | 改哪类文件会触发全量重编译？ | 编译阶段的键 = pin + 该构建指令 + 工具链清单 + **参与编译的注入物**；`src/build.config.json` 的 `ignoreTargets` 当前声明 `apps/desktop/renderer` 与 `apps/desktop/local` 不参与。因此改页面/资源（`assets/icon.png`、`assets/dsh-impact.png`、`src/features/renderer/`、`src/adaptator/renderer/`）与注入到 `apps/desktop/local/` 的功能层/适配层 `.mjs` 都只让 `--dir` 装配重做（装配键含 `apps/desktop/local`），不触发编译；改其他 patch 目标（如 `apps/desktop/src/main.ts`、`scripts/build.ts`）才会让编译阶段重跑一次。**新增注入物默认算编译输入**：想让它不参与，必须在 `ignoreTargets` 里显式写上 |

### 2.3 启动页与渲染进程

| # | 现象 | 根因与对策 |
|---|---|---|
| R19 | 加载动画的 PNG 能从 shell 资源里显示吗？ | **已修，但载体搬家了**：旧基线 `apps/desktop/src/main.ts` 的 MIME 表只有 `.css/.html/.js/.svg`，`loading-art.png` 按 `application/octet-stream` 返回，只靠 Chromium 对 `<img>` 的内容嗅探才解码正常（实测 `naturalWidth/Height` = 512×512）——上游若给 shell 资源加 `X-Content-Type-Options: nosniff` 就会破，当时 patch 给 MIME 表加了 `.png: 'image/png'`。**`0.1.6-alpha.2` 起 MIME 表随文档服务搬进 `apps/desktop/src/web-document.ts`，`.png: 'image/png'` 已在上游源码里**，本地那条 MIME patch 随之删除（决策 29）；本地只在这个文件上注入 `/local/` 的加载资源与接线 |
| R20 | 想验证加载动画真的显示、样式没被挡住 | 加载动画现在挂在官方 BootPage 上（`0.1.6-alpha.2` 起官方删掉了 `renderer/startup.html`，改用网络前端的 BootPage）。dev 模式（3.3）自带主进程 inspector：`fetch('http://127.0.0.1:9229/json/list')` 取 `webSocketDebuggerUrl` 连上，`Runtime.evaluate` 里用 `process.mainModule.require('electron')` 拿 `BrowserWindow`，再 `webContents.executeJavaScript()` 读 `#loading-art` 的 `naturalWidth`、`getComputedStyle().animationName`、隔 0.7s 再读 `transform`（两次不同即在动），`capturePage().toPNG()` 存图。**应用页地址是 `dsh-app://app/`**，动画资源在 `dsh-app://app/local/`（由 `apps/desktop/src/web-document.ts` 的 `/local/` 分支从 `<app>/renderer/local/` 提供，脚本也由它注入 index）；别用 `webContents.loadURL` 抢导航 —— 应用自身在推进导航时会把它中断（`ERR_FAILED (-2)`），要看就自己 `new BrowserWindow()` |
| R21 | 打包产物（GUI 子系统进程）不产出任何 stdout | win-unpacked 的 exe 没有控制台：`ELECTRON_ENABLE_LOGGING=1` 也不进重定向文件（实测两趟都是 2 字节空日志）。**对策**：改用 `DSH_DESKTOP_DIAGNOSTIC_FILE` 让主进程把启动阶段写进文件；`scripts/smoke-packaged.mjs` 就是按这个判据判通过的。每行是 `<ISO 时间> phase=<阶段>`；**失败阶段还带 ` message=<官方 state.message>`**（折成一行、截断 2000 字符，里面通常就含 Host 的 stderr 尾巴）——进程卡死时对话框根本看不到，只有这一行能说明哪里失败（R30） |
| R22 | 打包产物的启动冒烟怎么判「真的到了应用页」 | 判据两条：① 诊断文件出现 `phase=application-page`（主进程推进到应用页的直接事实；启动失败时不会有这一行）② profile 初始化完整（官方 `initProfile` 写下的 `package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml` 都在）。**不再要求 `node_modules`**：`0.1.6-alpha.2` 起内置 bundles 从应用自带的 installAnchor 解析，空 profile 本来就没有依赖树，宿主包链接与 `desktop-runtime-state.json` 都已不存在。命令：`node scripts/smoke-packaged.mjs [超时秒数]`，日志落 `.cache/runs/packaged-smoke.log`、诊断落 `$DSH_HOME/diagnostic.log`。**本次未跑**（受限沙箱限制，见 R11）。**本轮以非受限权限实跑通过**（2026-09-19，改动后重新构建的产物）：`诊断到达应用页=true profile 自包含=true`、`smoke: 通过` |
| R23 | `build:lib` 报 `[UNRESOLVED_IMPORT] Could not resolve '../local/…'`；打包产物报「找不到模块」才算到应用页 | 根因是**发射后深度变了**：`tsc` 把 `src/` 编到 `lib/types/`，官方源码里那句源码相对的 `../local/…` 在打包输入（`lib/types/*.js`）里就多下探一层，指向不存在的 `lib/local/…`。而 `tsdown` 的入口正是发射后的文件，所以**三处登记缺一不可**：① **主进程**（`lib/main.js`，产物落在 `lib/`）用 `tsdown.config.ts` 的 `deps.neverBundle` 保持**外部引用**——运行期从 `lib/` 解析 `../local/…` 正好是 `apps/desktop/local/…`（当前登记 `features/profile-recovery.mjs`、`features/diagnostics.mjs`、`adaptator/profile-packages.mjs`）；② **沙箱 preload 可见的官方文件**必须**内联**（`sandbox: true` 的 preload 运行期不能 require 文件；`locale.ts` 被 `preload-menu` 拉进图里）——给 preload 那几条配置加 `alias`，把说明符按发射后的位置重新相对化（`'../local/features/profile-recovery.mjs'` → `'../../local/features/profile-recovery.mjs'`）；③ `apps/desktop/scripts/electron-builder-config.mjs` 的 `files` 用 `local/**/*.mjs` 把这些文件带进 `app.asar`（顺带把只被构建脚本 import 的 `build-cache.mjs` / `tarball.mjs` 也带上，约 3KB，无害）。**实测**（本机 `node node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE host`）：漏 ① 报 `… in lib/types/main.js`，漏 ② 报 `… in lib/types/locale.js`；补齐后 host 面 4 个产物全部构建通过，`preload-app.cjs` 里内联的只有那两句文案（其余被 tree-shake，无 `node:` 依赖），`lib/main.js` 保留三条 `../local/…` 外部 import（决策 40） |
| R24 | 阶段 4 的迁移/回退怎么在无 web profile 的机器上验证 | web profile 不存在时功能层判定「无可迁移」并记 `done`（窗口结束），所以 `$DSH_HOME/profiles/web` 缺失的机器上行为等价于「没定制」。要验证迁移路径得自造 web profile 夹具（`package.json` + `pnpm-workspace.yaml`）；`src/features/profile-recovery.test.mjs` 覆盖配置语义、记账与重试边界，接线层由官方 `apps/desktop/tests/main-startup.spec.ts` 的 7 个新用例覆盖。**2026-09-14 在打包产物上实跑通三条**（当时是每轮对账的旧语义，迁移窗口已改为严格一次性）：① 冷启动（home 里只有 `profiles/web`）→ 官方 profile 被建出来 → 迁移 → `pnpm install` → 到应用页；② 插件能装、探针也过、但 Host 起不来（实例：`dsh-whale-widget` 等 `webServer` 服务，桌面端不提供）→ 回退一次 + 重装 → 重试到应用页 + toast；③ 包根本装不出来（不存在的包名）→ `pnpm install` 报 `ERR_PNPM_FETCH_404` → 回退到官方空 profile，应用停在启动页显示诊断，profile 不留砖。**2026-09-15 按严格一次性语义复跑**：冷启动（无 web profile）→ `settle` → 记 `done` → 到应用页；用真实 `~/.dsh/profiles/web`（11 个插件）做夹具 → 迁移在图校验阶段失败（缺 peer / 与内置 dsh 版本不匹配）→ `retry`（第 1、2 次）→ 第 3 次转 `abandoned` → 第 4 次启动跳过迁移、正常到应用页，profile 全程可用（当时暴露的两个缺陷见 R27/R28） |
| R25 | 打包产物上怎么读到启动页真实显示的报错 | `0.1.6-alpha.2` 起启动失败不再有启动页：主进程把失败交给原生恢复对话框（`fatal-recovery.ts`）。GUI 子系统进程没有 stdout（R21），但可以给 exe 传 `--remote-debugging-port=<port>` 读应用页里的报错：`fetch('http://127.0.0.1:<port>/json/list')` 找 `dsh-app://app/` 那个 target，连它的 `webSocketDebuggerUrl`，用 `Runtime.evaluate` 读页面上显示的恢复文案。原生对话框本身不在渲染进程里，读它只能靠肉眼或截图 |
| R26 | 复制过来的 web 插件为什么起不来 | 最典型的一类是**只在 web 组合里成立**的插件：它 `inject` 或等待 `webServer` 这类 Desktop 不提供的服务，于是 Host 报 `plugin tree failed to load … pending (waiting for service: webServer)`。这不是复制链路的缺陷（清单、安装、探针都过了），属于 design 的「插件兼容性校验的能力边界」里「运行时服务/API 变化」那一行——只有真正 boot 才暴露，由快照回退兜底（R24 的第 ② 条）。`docs/desktop-guide.zh.md` 的「已知限制」也记了桌面端不提供 `webServer` |
| R27 | 迁移重试时报 `ERR_PNPM_OUTDATED_LOCKFILE` | 回退的 `onRepair` 会用「空 profile 的 lockfile」收尾；下次重试迁移时，这个 lockfile 与手写清单必然不同步，而 pnpm 的 frozen lockfile（CI 默认）直接拒绝安装。**对策**：`ensureProfilePackages` 的 install 显式带 `--no-frozen-lockfile`——清单本来就不是包管理器写的，lockfile 必须允许更新 |
| R28 | 回退报 `desktop profile: refusing to replace unowned package @deepseek-ai/cosmokit` | 迁移来的插件依赖 runtime 也拥有的 `@deepseek-ai/*` 包（`dsh/desktop-runtime.json` 的 `sharedPackages` 有 241 个），pnpm 会把这些依赖实装成真实目录；官方 `unlinkDesktopHostPackages` 发现「记录在案的链接变成了真实目录」就拒绝替换——于是 install 之后的 `prepareProfile` 和回退都失败，profile 卡在半坏状态。**对策**：`ensureProfilePackages` 不再先 unlink（改为整棵 `node_modules` 删除，缺失路径会通过链接检查），并在 install 后把 `sharedPackages` 对应条目逐个清掉，再交官方 `prepareProfile` 重新链接 |
| R29 | `npm run build` 在打包阶段报 `desktop package: cannot read …\.env.windows; copy …\.env.windows.example and fill in the local settings` | `0.1.6-alpha.2` 起官方打包脚本**只从 `apps/desktop/.env.windows` 读发布设置**，并且会**把进程环境里的同名变量（含 `DSH_DESKTOP_APP_ID`）滤掉**——所以本地 `build[].env` 里塞 appId 是无效的，文件不存在就直接报错退出。该文件被官方 gitignore（`git clean -fd` 不会删）。**对策**：配置加顶层 `appId` 与 `releaseEnv[{template,file}]`；构建第 3 步只在文件**不存在**时按官方模板生成，把 `DSH_DESKTOP_APP_ID` 写成配置值，已存在的一律不动（要真签名就在那里填凭据）。实测：生成的内容喂给官方 `loadDesktopPackageEnvironment` + `validateDesktopPackageEnvironment(…, { unsigned: true })` 通过（appId / autoUpdateEnv / policy origin 全部解析）；`git check-ignore` 确认它被忽略，跨构建保留 |
| R30 | 打包产物启动后**窗口发虚、点不动** | **那是主进程卡死，不是分辨率问题**：窗口不再重绘，Windows/DWM 显示最后一帧（看起来像被拉过的「幽灵窗口」），输入也进不去。判据两条：① 诊断文件（R21）出现 `phase=error message=<官方文本>`；② Windows 事件日志里有 `Application Hang`／WER `AppHangB1`（`Get-WinEvent -FilterHashtable @{LogName='Application'} \| Where-Object Message -match 'Harness'`）。实测（2026-09-19）：`starting → ready → application-page` 只用 3 秒，**22 秒后**记 `phase=error`，同一秒 Windows 记 `AppHangB1`——所以「糊 + 点不动」是同一个原因。**分辨率这条线可以放下**：本机 `HKCU\...\AppCompatFlags\Layers` 里没有该 exe 的覆盖、exe 自带 DPI manifest（`dpiAware`/`requestedExecutionLevel`）、上游全仓没有 `force-device-scale-factor`／`zoomFactor`／`setZoomFactor`，原始截图 1277x843 与窗口 1280x840 的客户区 1:1 |
| R31 | 桌面端**界面完全模糊 + 点不动**，但进程 `Responding=True`、诊断文件只到 `application-page`（没有 error） | 根因是**壳自己的更新弹窗没内容**：`createUpdateOverlay()`（上游 `apps/desktop/src/update-overlay.ts`）一建窗口就给父窗口注入 `body { filter: blur(2px) !important }`，**只在遮罩窗口关闭时才移除**；而它是 `modal: true` 的子窗口，会挡住父窗口的输入。上游协议处理器只服务 `dsh-app://app/*`，`dsh-app://shell/update-dialog.html` → **404 空文档** → 遮罩窗口透明看不见、却是模态 → 「整页模糊 + 完全不能操作」。**判据**（在跑着的产物里实测）：① CDP `Runtime.evaluate` 读 `getComputedStyle(document.body).filter` = `blur(2px)`，且 `CSS.getMatchedStylesForNode` 报 `selector: body` / `origin: injected`（JS 注入，不是 CSS 文件）；② 在应用页里 `fetch('dsh-app://shell/update-dialog.html')` → 404 / 0 字节（`dsh-app://app/local/*` 是 200）；③ CDP target 里存在 `dsh-app://shell/update-dialog.html`，其 `document.body.innerHTML` 为空。**对策**：patch 给协议处理器补 `hostname === 'shell'` 分支，从 `app.getAppPath()/renderer` 提供这些文档（与本地启动资源同目录）。修后实测：`shell/update-dialog.html` 200 / 963 字节、`shell/update-dialog.css` 200、`bodyFilter=none`、截图清晰、`Responding=True`，且不再残留空遮罩窗口 |
| R32 | 启动桌面端就弹「更新需要登录飞书」（源码构建的本地应用） | 打包脚本把 `.env.windows` 解析出的策略写进了 app 清单：`electron-builder-config.mjs` 的 `extraMetadata.dshMandatoryUpdatePolicy`，官方模板里 `DSH_DESKTOP_AUTO_UPDATE_ENV=test` → `authentication: 'feishu-test'`。壳在 `app.isPackaged` 时读这个清单字段（`main.ts`）→ 建 `DesktopPolicyTestAuth` 并 `check('launch')`，需要登录时就弹飞书登录窗（`messages.policyLoginTitle`，`policy-test-auth.ts`）；同一段策略逻辑还会建 R31 那个空遮罩窗口，两者一起出现，用户看到的就是「登录框 + 界面糊住」。**判据**：`resources/app/package.json` 里有 `dshMandatoryUpdatePolicy{origin: https://harness-test.deepseek.com, authentication: feishu-test}`；CDP target 里多出 `dsh-app://shell/update-dialog.html`。**对策**：patch 把该字段从 `extraMetadata` 摘掉（只留 `dshDesktopAppId`）——`resolveDesktopPolicyConfig(undefined)` 返回 `undefined`，强制更新/策略登录整块不进入；策略仍由 `.env.windows` 在 `beforePack` 校验。修后实测：清单无该字段时启动的 CDP target 只有 `dsh-app://app/`、`bodyFilter=none`、`Responding=True` |
| R33 | 打包产物的 exe 图标与本地品牌图不一致 / 想换应用图标 | 图标不走「生成脚本」这条路：应用图标源图是 `assets/dsh-impact.jpg`，转出的 `assets/dsh-impact.png` 由配置的 `copy` 覆盖上游 `apps/desktop/resources/icon-windows.png`，官方 `electron-builder-config.mjs` 两处引用它（`files` 里作为 `icon.png` 带入产物、win 目标作 exe `icon`），所以在 `assets/` 换图即换掉整个应用的图标。判据：构建后产物 `resources/app/icon.png` 与 `assets/dsh-impact.png` 逐字节相同；`scripts/make-icons.py` 生成的 `assets/icon.png` 只用于加载动画（`loading-art.png`），与 exe 图标无关。**换图后「exe 图标对了、桌面还是旧图」是 shell 侧的缓存**：快捷方式由 shell 按自己的图标缓存绘制，重启电脑、重启资源管理器都不一定管用——实测（2026-09-19）同一个快捷方式在「属性」对话框里已是新图、桌面上画的还是旧图（`iconcache_48.db` 的写入时间早于本次构建）。**对策**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-shell-icons.ps1`（按配置定位产物 exe、列出指向它的桌面快捷方式、跑 `ie4uinit.exe -show`、不需要管理员；跑完桌面立刻变新图）。**别走「删 `iconcache_*.db` + 重启 Explorer」那条路**：那些 db 被 shell 的其它进程持有，停掉 Explorer 也删不掉（`Access denied`），而 `ie4uinit -show` 不碰任何文件就能让 shell 重画 |
| R34 | **桌面端里 agent 的每条 shell 命令都以 `0xC0000142` 结束，命令完全跑不了** | 现象：默认（workspace-write）下 `pwsh` 工具对 `1+1`、`echo`、`Set-Content` 一律返回 `(no output)` + 退出码 `3221225794`（`0xC0000142` = `STATUS_DLL_INIT_FAILED`），只有提权成 `danger-full-access`（不套沙箱）才正常；文件读写工具不受影响。**只在桌面端发生**：实测会话 `session-963b1707` 的 `pwsh` 调用全部落在 2026-09-19 11:34–12:51，正是桌面端在跑的时间段（`%APPDATA%\@deepseek-ai\dsh-desktop` 写到 12:52:18），而同一台机器、同一个 pin 的 web 端正常。**根因**：Windows ACL 沙箱把被包装的命令放在 `WRITE_RESTRICTED` 令牌下，而**受限进程不能新建控制台、只能继承一个**；桌面端整条链（Electron 主进程 → `ELECTRON_RUN_AS_NODE` 的 Host → 同样以 `process.execPath` 起的 runner）都是 GUI 子系统进程，**永远没有控制台**，被包装的 `pwsh` 在 DLL 初始化阶段就结束，runner 把该退出码原样镜像回来。`dsh web` 由终端启动，控制台从 `node.exe` 一路继承，所以那边正常。**判据（本机实测，同一 runner、同一 workspace、同一 `pwsh.exe`）**：runner = `node.exe` → 输出 `2`、exit 0；runner = 打包的 `DeepSeek Harness.exe`（`ELECTRON_RUN_AS_NODE=1`）→ `0xC0000142`、stdout/stderr 全空；受限的 `cmd`/`pwsh` 用 `CREATE_NO_WINDOW` 起（等价于没有控制台可继承）同样 `0xC0000142`，改成继承当前控制台则 exit 0。**对策**：让 runner 在派生子进程**之前**自己补一个控制台——runner 不受限，`AllocConsole` 必定成功，之后的受限子进程就能继承它。判断与 Win32 调用在适配层 `src/adaptator/acl-console-guard.mjs`，patch 只把它以 `--import` 接在 runner 前面（node 自己吃掉该参数，runner 的 argv 契约不变）；该文件由 `copy` 复制进 `packages/sandbox/sandbox-windows-acl/`，并由 `sandbox-windows-acl.package.json.patch` 写进该包 `files`，否则 `pnpm pack` 不会把它带进运行时（决策 44）。实测：同一条 Electron 链路加守卫后输出 `2`、exit 0，有控制台的 `node.exe` 链路加守卫后行为不变（空转）。**产物级判据（本轮完整构建实测）**：① 构建目标运行时树 `…/dsh-sandbox-windows-acl/acl-console-guard.mjs` 与源文件逐字节相同（`files` 登记生效、`pnpm pack` 带上了它）；② 打包产物 `resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/{acl-console-guard.mjs,lib/runner.js}` 都在，且 `dsh-sandbox-local/lib/index.js` 里带这条接线（asar 只有 Electron 能读，用打包的 Electron 读出来验的）；③ 用**出货的 seam**（构建目标树）算出 argv = `[node, --import, <guard>, <runner>, --workspace, …]`，argv[2] 指向的文件存在；④ 行为：打包 Electron + **asar 内**的守卫与 runner 跑 `1+1` → 输出 `2`、exit 0，去掉 `--import` 的同一命令 → `0xC0000142`、stdout/stderr 全空。**边界**：守卫拿不到 koffi 或 `AllocConsole` 失败时按原样返回，不写任何 stdio——失败表现仍是原来的 `0xC0000142`，不会多出一种失败类型 |
| R35 | 重新构建时 `prepare:runtime` 报 `TypeError: fetch failed`（`@electron/get` 下载 Electron 失败） | **不是「缓存没命中」**：`.desktop-build/downloads/` 里那份 `electron-v44.0.0-win32-x64.zip` **会被复用**（本机探针实测：`DEBUG=@electron/get:*` 下打印 `Checking the cache …` → `Cache hit`，直接返回缓存路径，没有重下 zip）。真凶是**校验文件每次都重新联网取**：`downloadArtifact` 命中缓存后仍要跑 `validateArtifact`，而它取 `SHASUMS256.txt` 时显式传了 `cacheMode: Bypass`（源码注释：*Never use the cache for loading checksums, load them fresh every time*）；这一步失败就被当成「缓存里那份对不上校验和」，于是 `falling back to re-download` 去重下 **157MB 的 zip**，那一下同样失败，报出来的才是 `fetch failed`。**实测复现**（同一个探针 + 一个不可达代理）：`Cache hit` → `Downloading …/SHASUMS256.txt`（`cacheMode: 3`）→ `Artifact in cache didn't match checksums TypeError: fetch failed` → `falling back to re-download` → `Downloading …/electron-v44.0.0-win32-x64.zip` → `FAILED fetch failed`。所以这一阶段**永远要一次到取件地址的联网**（哪怕 zip 在缓存里），直连 GitHub 不稳时就整段失败。**另一个事实**：`Cache.getCacheDirectory` = `sha256(去掉文件名后的下载 URL)`，缓存条目与**取件 URL 绑定**——换镜像会落到另一个条目（本机现在同时存在 GitHub 键 `16cfa46eff…` 与 npmmirror 键 `76389d15…` 两份 zip）。**对策**：把镜像写进配置的 `build[].env`（与 `DSH_LOCAL_NPM_REGISTRY` 同一处，决策 5）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`——取件 URL 与校验文件都落在可达的镜像上，重建时复用的就是镜像键那份 zip。这与 `DSH_LOCAL_NPM_REGISTRY`（给 pnpm 用）是两回事。**这条不是新发现**：会话记录里早有同一现象与解法（findings 4.3「electron 二进制是独立于 npm 的第二个下载源」给的是 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`，task_plan 的构建前置表也记了「已验证解法：`ELECTRON_MIRROR` 指向 npmmirror」）——本条的增量是把「缓存会命中、真凶是每次现取校验文件」这层机制写明，并把镜像从手写环境变量挪进配置（路径用 `https://npmmirror.com/mirrors/electron/`，实测可用） |
| R36 | 构建在 `prepare:dsh` 失败：`desktop native payload smoke failed` + `spawnSync …\electron\electron.exe ETIMEDOUT`（`signal: 'SIGTERM'`） | 现象是阶段内部失败，**不是**「阶段超时」也**不是**取件失败：`packaging-runs/<run>/events.jsonl` 里 `run prepare:dsh` 记的是 `code:1, timedOut:false`。失败来自阶段内跑的上游夹具 `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs`，它按顺序跑 5 个 payload 检查（139-144 行），**第一个** `checkPnpm()`（22-45 行）用 `execFileSync(process.execPath, ['--expose-internals', <targets>/runtime/pnpm/bin/pnpm.mjs, 'run', 'check'], { timeout: 45_000, env: 只有 SystemRoot/windir/comspec + ELECTRON_RUN_AS_NODE + DSH_DESKTOP_NODE_EXECUTABLE + PATH + 指向 scratch 的 HOME/USERPROFILE/TMP/TEMP/TMPDIR })` 验证「打包后的 pnpm 能不能跑 package script」。**判读要点**：`output[1]` 里的 `Already up to date\n\nDone in 505ms using pnpm v11.7.0` 不是失败点（那是 pnpm `verify-deps-before-run` 的自动安装），失败点是断言要的 `desktop-node-script-ok` 一直没出现——即卡在 `pnpm → runtime/bin/node.cmd → electron check.cjs` 这一段，45 s 到点被 SIGTERM 杀掉（`errno -4039`）。**与本地定制无关的判据**：这条链不经过 ACL 沙箱（不创建 `ctx.sandbox`、不跑 runner，守卫只在 ACL runner 里 `--import`）；同一份代码与配置在 7 分钟前那次构建里 `run prepare:dsh code=0`（`05-53-59`）；产物也不是坏的——`targets/win-x64/electron/` 的 `electron.exe`/`ffmpeg.dll`/`resources.pak` 与下载 zip 里的同名字节逐字节一致（用 `ZipFile` 取条目算 sha256 比对）。**疑点（未验证）**：`prepare:runtime` 每轮重新解压出 244MB 的 `electron.exe`，那条链每次都是「新写出来的可执行文件首次运行」，首次执行被实时扫描/磁盘拖慢时，45 s 预算很脆（当天同一夹具 2 次通过、1 次失败）。**处置**：先重跑（pack/install 阶段命中缓存，只有 `prepare:runtime` ≈80 s 与 electron-builder ≈2 min 要重做）；若每次都挂，就把夹具那一步单独计时复现（用它 22-45 行的配方：scratch 目录里放 `package.json` + `check.cjs`，再按上面的 argv 跑），并考虑把 `…\.desktop-build` 加进实时扫描排除项。**不要用批量终止**（task_plan 的硬规矩） |


## 3. 复刻命令

### 3.1 一次性准备

```bash
cd <仓库根>
# 1) 源仓库 clone（内含独立 .git，本仓库不跟踪）
git clone <source-repo-url> deepseek-harness
# 2) 安装依赖（版本与 store 必须一致，见 R9）
cd deepseek-harness && pnpm install --frozen-lockfile
```

### 3.2 构建（按 design 的[构建流程](design.zh.md#2-构建流程)）

```bash
cd <仓库根>
node scripts/build.mjs           # 读配置 → 解析 tag → 清理并 checkout → 复制 → 打 patch → 执行构建指令
npm run apply                    # 同上，但在「打 patch」之后停下（第 1–5 步），不执行构建指令
```

流程的每一步都以 `src/build.config.json` 为准：

| 步 | 依据配置字段 | 说明 |
|---|---|---|
| 解析 tag 并 checkout | `tag` | 在上游把 tag 解析成提交（`git rev-parse --verify '<tag>^{commit}'`）后 checkout；解析不到即报错退出（不自动 fetch、不退回当前 HEAD） |
| 补齐打包本地设置 | `appId`、`releaseEnv[]` | 目标文件缺失时按官方模板生成，`DSH_DESKTOP_APP_ID` 写成配置的 `appId`；已存在的不动（R29） |
| 搬运产物 | `build[].artifacts{from,to}` | 该条构建指令成功后，把 `from`（相对源仓库根）**复制**到 `to`（相对本仓库根）；`to` 先整体删掉再复制，所以 `release/` 里永远是本次构建的产物，源仓库里的原件保留（以产物为输出的缓存阶段下一轮照常命中）。`smoke-packaged.mjs` 读同一个字段找产物，不写死路径（决策 41） |
| 复制定制文件 | `copy[{from,to}]` | 适配层与功能层的独立文件复制到目标位置；本地品牌资源也走这里：`assets/dsh-impact.png` → `apps/desktop/resources/icon-windows.png`（官方打包脚本把它同时用作产物图标与 exe 图标，所以覆盖它即换掉整个应用的图标） |
| 打 patch | `patches[]` | 把已封装能力调度进官方流程（不实现功能），见决策 4。**例外形态**是 `preload-menu.ts.patch`：它把官方那个模块整体换成只返回空控制器的实现（本仓库不要 Windows 顶栏的「应用 / 编辑」两个入口），`preload-windows.ts` 一行不动。导出名必须留原样——上游 `apps/desktop/tests/preload-menu.client.spec.ts` 仍 import 它，删文件或改导出名会让 `tsc -b tsconfig.host.json` 直接红 |
| 构建 | `build[{cwd,command}]` | 在源仓库执行，命令与参数不在脚本里硬编码 |

换应用图标是纯 `copy` 的事（不必改脚本）：源图是 `assets/dsh-impact.jpg`，转出的 `assets/dsh-impact.png` 覆盖
上游 `apps/desktop/resources/icon-windows.png`——转换在仓库外做一次，仓库里只留转换后的 PNG；
`scripts/make-icons.py` 是另一条线，它从 `assets/whale-girl-source.png` 生成加载动画用的
`assets/icon.png`/`icon.ico`，与 exe 图标无关（R33）。

构建期间必须注意：输出重定向到文件（R5）、设置 `DSH_DESKTOP_APP_ID` 与 `npm_execpath`（R8）、
镜像通过 `DSH_LOCAL_NPM_REGISTRY` 传入（R10）、在可 spawn 子进程的环境运行（R11）、
用 Git Bash 跑时先把 Windows 版 tar 前置到 PATH（R13）。

### 3.3 开发态启动（验证隔离时用）

```powershell
cd <仓库根>\deepseek-harness\apps\desktop
$env:DSH_HOME = "<仓库根>\.cache\dev-home"   # 必须显式隔离（R2/R3）
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
node --experimental-transform-types scripts/dev.ts --skip-build
```

结论：dev 模式**不会**创建 `$DSH_HOME/profiles/desktop`，而是直接用 `.desktop-build/development/project`。
实测（2026-09-12）：隔离 home 下 dev 模式能起到真实 UI（`dsh-app://app/index.html`），`.cache/dev-home` 由流程按需生成。
dev 模式自带两个 inspector：主进程 `--inspect=127.0.0.1:9229`、渲染进程 `--remote-debugging-port=9222`（端口被占时后者静默失败，见 R20）。

> **加入「复制 web 配置」后这条结论一度失效**：`copyWebProfile()` 在 dev 下也被调度，每次启动都会建出
> `$DSH_HOME/profiles/desktop`；若该 home 里恰好有含插件的 `profiles/web`（R2 警告的「外层注入 `DSH_HOME`」
> 场景），还会把配置复制进去，并在 Host 失败时把快照写回 dev 的 `development/project`。现已由
> `main.ts.patch` 的 `development === undefined` 调度条件恢复（回退目标也改为与快照同源的 `paths.profile`），
> 守卫用例见 §6 的 patch 层一行。

## 4. 构建缓存的实现与实测

功能层 `src/features/build-cache.mjs`（随同目录的 `.d.mts` 一起注入，供源仓库 `tsc -b` 编译）承载全部
判断逻辑；patch 一处一个目标源文件：

| 目标源文件 | 插入的调用 | 效果 |
|---|---|---|
| `scripts/build.ts` | 整段编译缓存：键由流程算出（pin + 该指令自身 + 工具链清单 + 参与编译的注入物），`ignoreTargets` 里声明的不算 | 只改页面/资源文件时不再触发全量编译 |
| `scripts/release/pack.ts` | 两件事合在同一个 patch 内：① 成员级 tarball 缓存（键 = 成员目录内容 + 全仓依赖解析键；复用同样要过官方 `validatePayload`；输出目录仍由 `main` 重建）② 成员校验的 `tarballFiles` 改走功能层 `listTarballEntries`（进程内，不再每成员 spawn 一次外部 `tar`） | 成员没变就不重打；消除每成员一次的外部 `tar`，稳态 1180s → 49–53s |
| `apps/desktop/scripts/package-target.ts` | 两次 `release:pack` 传 `--concurrency`（上限 8）；两处不经 `release:pack` 的 pack（私有 Host、native entry）改用 `reusePackedDirectory`；未签名 `--dir` 装配按上游各阶段键 + 配置/清单复用 | 单独测打包：266 个 tarball 145s → 31.7s；那两处 pack 的字节不再每轮变；装配也不再每轮重做 |
| `apps/desktop/scripts/prepare-dsh.ts` | 只把「装包 + 拷贝 `node_modules`」放进缓存；描述符重建、runtime smoke、`verifyDesktopRuntime` 每轮照跑 | 不重装 506 个包 |
| `apps/desktop/scripts/prepare-package-set.ts` | 按 tarball 读 manifest 与列条目改走功能层 `tarball.mjs`（进程内），不再逐次 spawn 外部 `tar` | `prepare:packages` 从 577s 回到秒级 |

**实测**（本机 Windows x64，`win-x64 --dir --unsigned`；波动主要来自机器负载，`electron-builder` 那段实测 28–73s）：

| 构建 | 耗时 | 说明 |
|---|---|---|
| 优化前 | 4.92 min | pack dsh 单段 145s（266 个 tarball 串行）+ 全量编译 + 全量装配 |
| 只接了 pack/dsh 缓存时 | 2.74 → 1.79 min | 冷 → 稳态（历史值，编译与装配还没接） |
| 接上编译与装配缓存后：冷 | 3.40 min | 编译、1 个成员重打、`prepare:dsh` 安装、`--dir` 装配全部 miss |
| 接上编译与装配缓存后：稳态 | **0.85 min** | 277 个 pack 决策（266 dsh + 9 vendor + 私有 Host + native entry）+ `build-official` + `prepare:dsh` + `package-dir` 全部 hit，0 miss |
| 启动页重构后第一次重跑 | 2.2 min | 编译与 277 个 pack 决策全 hit；`prepare:dsh`、`--dir` 装配 miss（`key-changed`，未逐项定位输入差异） |
| 紧接着再跑一次 | 36s | 全部 hit、0 miss（稳态可重复） |

每个成员的内容键要把该成员的目录读一遍；整棵树一次哈希实测约 4s，所以这份键的计算成本可以接受。

稳态连续两次构建的 `DeepSeek Harness.exe`、`resources/app.asar`、`resources/dsh/desktop-runtime.json`
三者 sha256 完全一致 —— 命中路径复用的是同一份字节，不是「重新打包的等价物」。

**外部 `tar` 进程：一个曾让稳态退化成 20 分钟的坑（已修复）**

2026-09-14 在本机复刻时遇到：**缓存 280 项全部 hit、0 miss，稳态仍要 1180s（≈20 min）**，与上表
「稳态 0.85 min」差约 23 倍。先确认过缓存判据本身没问题（同一方法连跑两次都是 280 hit / 0 miss，
产物 sha256 逐字节一致），问题不在缓存。

根因在 `scripts/release/tarball.ts` —— 它读 tarball 走**外部进程**：

```ts
export function tarballFiles(tarball) { return capture('tar', ['-tzf', tarball]).split(…).filter(…) }
export function packedIdentity(tarball) { … capture('tar', ['-xOzf', tarball, 'package/package.json']) … }
```

`capture()` → `attempt()` → **`spawnSync`**（同步、串行），而两处热路径都按「每个成员一次」调它：

| 位置 | 调用 | 次数 |
|---|---|---|
| `scripts/release/pack.ts` `packMember` | `validatePayload(member, tarballFiles(tarball))` | 每成员 1 次（266） |
| `apps/desktop/scripts/prepare-package-set.ts` `packedPackages` | `capture('tar', ['-xOzf', …])` | 每 tarball 1 次（267） |

单次外部 `tar` 的启动成本在本机**大幅抖动**（同一命令同一环境，`tar --version` 实测 55ms ↔ 2217ms），
未命中时 `tar -xOzf` 实测约 2058–2463ms。注意**成本与 tarball 大小无关**：267 个 tarball 总共只有
11.3MB，100% 是进程创建成本。插桩实测 `prepare:packages` 的 576s 里：

```
[PROF] packedPackages+closure: 570436ms
[PROF] tarballFiles(host):       2064ms
[PROF] copy+hash records:         365ms
```

> 决策 17 的 `--concurrency 8` 对这部分**无效**：并发池只并行了 `pnpm pack` 本身，
> 而 `tarballFiles` 是每个成员一次的**同步** `spawnSync`，在并发池内串行执行。

**修复**：新增功能层 `src/features/tarball.mjs`（+ `.d.mts`），用 `tar` 库**进程内**读，暴露两个稳定出参：

```js
readTarballManifest(tarball)   // 等价于 tar -xOzf <t> package/package.json
listTarballEntries(tarball)    // 等价于 tar -tzf <t> 再按行切分、过滤空行
```

`tar` 已是 `apps/desktop/package.json` 声明的 devDependency（`"tar": "^7.5.0"`），**未新增依赖**；
patch 层只把两处调用换掉（接线表见本节开头，新增 `prepare-package-set.ts` 一行、`pack.ts` 一行）。

| 验证 | 结果 |
|---|---|
| 语义等价 | 277 个 tarball 逐一双跑「外部 `tar`」vs「进程内库」→ 条目列表与 manifest **全部一致** |
| 产物等价 | `desktop-packages.json` = **`9b7475f5bcd22fa4…`，与修复前逐字节相同** |
| 产物可用 | `scripts/smoke-packaged.mjs` 隔离 home 冒烟**通过** |
| 稳态耗时 | **1180s → 53s / 49s**（两次复跑，均 280 hit / 0 miss）；与上表 0.85 min 吻合 |

> 修复后 `app.asar` 的 sha256 会变：asar 内**新增 1 个条目** `\local\features\tarball.mjs`
> （`pack.ts` 要 import 它，`tsconfig.host.json` 随之把它纳入编译）。属预期，不是回归。

**未覆盖的部分**：`prepare:packages` 与 `prepare:runtime` 都不接缓存 —— 前者在修复外部
`tar` 之后已从 577s 回到秒级，因此不需要缓存这一层；后者按决策 22 维持不接。**注意 `prepare:runtime`
的真实耗时不是「≈6s」而是实测 76–85 s**（2026-09-19 两次构建：76.7s / 85.0s，见 R36 的 `events.jsonl`
读数）：它每轮 `rmSync` + 重新解压 157MB 的 Electron（外加 primary runtime / pnpm），决策 22 里那个
「收益不值一层维护」的判据是在旧数值下定的。

## 5. tsx shim（仅受限沙箱环境）

构建脚本全经 `tsx`，而受限沙箱禁止 esbuild 的 helper 子进程（R1）。可把 tsx 换成 Node 原生 TS 转发：

```bash
cd deepseek-harness           # 相对仓库根
printf '#!/bin/sh\nexec node --experimental-transform-types "$@"\n'         > node_modules/.bin/tsx
printf '@echo off\r\nnode --experimental-transform-types %%*\r\n'           > node_modules/.bin/tsx.CMD
printf '#!/usr/bin/env pwsh\n& node --experimental-transform-types @args\n' > node_modules/.bin/tsx.ps1
chmod +x node_modules/.bin/tsx node_modules/.bin/tsx.ps1
pnpm exec tsx --version   # 应输出 v24.13.0（Node 版本），而非 tsx v4.x
```

还原（通过重新安装依赖即可回归原版）：

```bash
cd deepseek-harness           # 相对仓库根
pnpm install --frozen-lockfile
```

> **shim 的能力边界**：它只替换 `tsx` 一个入口。受限沙箱还会拒绝其它管道式子进程
> （实测 `spawnSync git` 同样 EPERM），所以**受限沙箱下无法完成构建**，必须在可 spawn 子进程的环境运行（R11）。

## 6. 验证方式

| 对象 | 方式 |
|---|---|
| 适配层（进程内） | `src/adaptator` 无独立测试文件，靠被功能层带测（`diagnostics-signals.mjs` 的顺序与判据由 `features/diagnostics.test.mjs` 的 16 条上游真实错误串覆盖；`profile-layout.mjs` 由 `profile-recovery.test.mjs` 覆盖） |
| 三层腐败门限 | `npm run check:layers`（构建第 0 步也会跑）。规则、级别、豁免与盲区见 design §4.3；**门限自己有负样本单测** `scripts/check-layers.test.mjs`（28 例：每条硬规则一个好/坏样本、白名单两种失效、注释里的官方文案不算耦合、本仓库当前状态必须通过），挂在 `npm test` 里 |
| 功能层（进程内） | 纯函数单测（`node --test`，显式路径），不依赖 Electron 与官方代码 |
| 功能层（tarball 读取） | 拿 `packed/` 里的真实 tarball 逐一双跑「外部 `tar -tzf` / `tar -xOzf`」与进程内 `listTarballEntries` / `readTarballManifest`，断言条目列表与 manifest 完全一致（实测 277/277），再比 `desktop-packages.json` 的 sha256 不变 |
| 适配层 / 功能层（渲染进程） | `src/features/renderer/loading-art.test.mjs`：用 `node:vm` + 假 DOM（含假 `MutationObserver`）按接线顺序跑两个经典脚本，**再照 patch 的接线方式订阅**（`onFailed(dshLoadingArt.sync)`），断言「官方启动页出现前收起、出现后展示、加载标记消失即收起、启动页被移除后跟着离开文档」，以及「只创建 `img` 且无内联样式」；不依赖 jsdom 与官方代码 |
| patch 层 | `git apply --check`（16 个 patch 逐个 + 联合 apply 全通过）+ 完整构建 + 隔离 `DSH_HOME` 启动冒烟；改了接线再跑官方用例：在**源仓库根**执行 `node_modules/.bin/vitest run apps/desktop/tests/main-startup.spec.ts`（**本次未跑**：沙箱里 vite 起不来，见 R11；替代证据是 `tsc -b tsconfig.host.json` 对该文件零报错） |
| 独立文件的打包输入（R23/决策 40） | 在**源仓库根**跑 workspace 面打包：`node node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE host`（用 `--env.` 传 face，等价于上游 `build:lib:host` 的后半段）。判据：exit 0 + `apps/desktop` 四个产物构建完成 + `lib/preload-app.cjs` 里没有 `require('../local/…')` 也没有 `node:` 依赖、`lib/main.js` 保留 `../local/…` 外部 import。**只跑 `apply` 或门限看不出这一类** |
| 加载动画（视觉） | dev 模式 + R20 的 inspector 读法：`naturalWidth` 证明图片解码、`animationName`/两次 `transform` 证明 CSS 动画在跑、`styleElements`/`style` 属性为 0 证明没碰内联样式 |
| 阶段 4（迁移 / 快照 / 回退） | `src/features/profile-recovery.test.mjs`（26 例：配置语义合并、allowBuilds 按行合并、幂等、快照/回退两步、回退文案、**迁移记账与严格一次性**）+ `main-startup.spec.ts.patch` 新增的 7 个用例（迁移接线顺序、settle、skip、放弃复制、回退一次后停手、诊断进原生对话框、dev 不碰 desktop profile）。**本次未跑 vitest**（沙箱限制，见 R11） |
| 阶段 5（诊断规则，功能层） | `src/features/diagnostics.test.mjs`（8 例：每条规则命中上游真实错误串、阶段不串、覆盖表一致、未命中返回 null、AggregateError 展开、格式化保留原始串、诊断文件行格式与写失败兜底、错误出口命中与退回） |
| 打包产物（冒烟） | `node scripts/smoke-packaged.mjs [超时秒数]`：产物位置由配置的 `build[].artifacts.to` 决定（当前 `release/win-x64/win-unpacked/`），见 R22/R23。**本沙箱跑不完**：脚本能按配置找到并启动搬过来的 exe，但 Chromium 起不来（`Lock file can not be created: 拒绝访问`、`mojo platform_channel Check failed: 拒绝访问`——沙箱不给命名管道与锁文件，见 R11），所以「到了应用页」这一条只能在正常环境上判 |
| Windows ACL 沙箱（桌面端能不能跑命令） | **冒烟脚本看不出这一类**：`smoke-packaged.mjs` 只判「到了应用页」，而 R34 的失败发生在应用页之后的每条 shell 命令上。判据两层：① 产物里 `resources/runtime/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/` 必须同时有 `lib/runner.js` 与 `acl-console-guard.mjs`（`files` 登记生效，否则 `pnpm pack` 不会带上）；② 行为——用**产物自带的 Electron**（`ELECTRON_RUN_AS_NODE=1`）跑一次 runner，让它在 workspace-write 下执行 `pwsh -NoProfile -Command 1+1`：输出 `2`、exit 0 才算过，去掉守卫的同一条命令必然是 `0xC0000142` 且 stdout/stderr 全空（对照）。两条都要在**非受限环境**跑：受限沙箱里 runner 的 `OpenProcessToken` 直接被拒（Win32 5）。最终验收仍是真启动桌面端、让 agent 跑一条命令 |
| 整体闭环 | 按配置执行完整流程后，产物可正常启动；源仓库仍能 `checkout` 到配置指定的提交 |
| 构建时间优化 | 连续两次构建，第二次显著更快；只改页面/资源类文件时不触发全量编译（见 design 的[构建脚本时间优化](design.zh.md#41-构建脚本时间优化已实施)）。**另外看缓存决策行**：稳态必须 `build-cache: … hit` 全命中、0 miss —— 曾经出现过「全命中但仍要 20 分钟」的情况，原因是外部 `tar` 进程（见[构建缓存的实现与实测](#4-构建缓存的实现与实测)），所以「命中率」与「耗时」要同时看 |
