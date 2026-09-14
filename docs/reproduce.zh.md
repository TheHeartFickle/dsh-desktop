# 探索内容与复刻命令

> 本文是 `docs/` 三份设计文档之一：[当前设计](design.zh.md)（是什么、怎么做） ｜
> [重大决策与原因](decisions.zh.md)（为什么） ｜ **探索内容与复刻命令**（怎么跑、怎么验证、实测到什么）；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 源仓库 | `deepseek-harness/`（仓库根下的 clone，独立 `.git`，可 checkout 到任意提交） |
| 已验证基线 | commit `c291e7961a515f6d7af9304e7fd1d257929aef26`，版本 `0.1.5-rc.2` |
| tag 差异 | `dsh-v0.1.5-rc.2` 指向另一提交 `fb2c4b9e69`，与基线差 1379 文件 |
| Node | `C:\Program Files\nodejs\node.exe` v24.13.0（满足 `engines: ^22.19.0 \|\| >=24.0.0`） |
| pnpm | 全局 npm 装的是 **11.22.0**，但源仓库 `package.json` 声明 `packageManager: pnpm@11.7.0`，pnpm 自管理会切到 **11.7.0**（实际使用的版本）。**store 必须与该版本匹配**（见 R9） |
| pnpm store | `D:\.pnpm-store\v11` |
| 包缓存选盘 | C/D 为 KIOXIA、E 为 ZHITAI，跨盘会失去硬链接；store 与仓库同置于 D 盘 |
| Electron | 44.0.0（`apps/desktop/node_modules/electron`，随上游 lockfile 变化） |
| 镜像 | `~/.npmrc` 里配置了 `registry=https://registry.npmmirror.com`（注意上游构建会屏蔽它，见 R10） |
| 打包需要 | `DSH_DESKTOP_APP_ID`（反向域名）；`--unsigned` 模式下不需要签名证书 |
| 冒烟取证 | `DSH_DESKTOP_DIAGNOSTIC_FILE`：设置后主进程把启动阶段（`phase=starting / ready / error`、`phase=application-page`）追加进该文件；未设置时完全不写（见 R21/R22） |

> 源仓库的依赖（`node_modules`）与构建产物都**不随本仓库同步**：新机器 clone 后需先安装依赖，再按第 3 节构建。

## 2. 关键踩坑与常用手段

### 2.1 构建与环境

| # | 现象 | 根因与对策 |
|---|---|---|
| R1 | `pnpm run dev:desktop` 报 `Error [TransformError]: spawn EPERM (esbuild/lib/main.js:2268)` | 构建脚本全经 `tsx`，tsx 依赖 esbuild 启动 helper 子进程（命名管道）。**对策**：受限环境用 `node --experimental-transform-types <script.ts>` 替代；见第 5 节 tsx shim |
| R2 | 隔离失效、污染真实 `~/.dsh` | dev 启动器用 `process.env.DSH_HOME ?? 隔离目录`，外层已注入 `DSH_HOME` 时会静默走真实 home。**对策**：启动前显式赋值 |
| R3 | 桌面端一启动，agent loop 卡死 | 与运行中的 agent 会话共用 `$DSH_HOME`。**对策**：验证时一律用独立 home |
| R4 | 直接跑 `electron.exe <APP_ROOT>` 显示官方恢复页 | 跳过了 `prepareDevelopmentProject()`——它每次都删除并重建 `.desktop-build/development/project` 并写入运行元数据。**对策**：走完整启动器 |
| R5 | 长任务把 agent loop 卡死 | 巨量 stdout 灌满 subprocess 管道（**实测卡死两次**）。**对策**：`*> 日志文件` 或后台 + 只读日志尾部 |
| R6 | 插件树加载失败导致后端起不来、日志刷屏 | 上游 smoke 检查要求已被 `node-addon-system` 取代的 `fs-ext`。**对策**：patch 层容忍其缺失（功能层封装判断，patch 只插入调用） |
| R7 | `pnpm config set … --global` 静默不生效 | 它触发无关的 global-bin PATH 检查而中断。**对策**：用 `--location=global` |
| R8 | `pnpm run X -- --unsigned` 参数传错；`pnpm exec tsx …` 报 `invoke this script through a pnpm package command` | pnpm 把 `--` 当字面参数传入；且 `pnpm exec` 不设置 `npm_execpath`，而 `package-target.ts` 的 `runPnpm()` 强制要求它 |
| R9 | `pnpm install` 报 `unable to open database file` | **pnpm 版本与 store 不匹配**：store 的 `index.db` 由某个大版本建立，另一个版本打不开。本机全局 pnpm 是 11.22.0，源仓库却声明 `pnpm@11.7.0`（自管理切换），两者共用同一个 `store-dir` 就冲突。**对策**：让 store 与「实际调用的 pnpm 版本」一致——本机按 11.7.0 重建；旧 store 备份在 `.pnpm-store.bak-1121` |
| R10 | `prepare:dsh` 报 `ERR_PNPM_META_FETCH_FAIL … registry.npmjs.org … timeout` | `apps/desktop/scripts/prepare-dsh.ts` 的 `runPnpm()` **硬编码** `registry.npmjs.org`，并过滤掉 `npm_*`/`pnpm_*`/`corepack_*`/`DSH_DESKTOP_*` 环境变量、把 `XDG_CONFIG_HOME` 指向临时目录——本机任何镜像配置都进不去。**对策**：patch 层把 registry 改为读 `DSH_LOCAL_NPM_REGISTRY`（不设时仍是官方地址，行为不变） |
| R11 | 构建报 `spawn EPERM`（esbuild helper），继而 `spawnSync git` 也 EPERM | 受限沙箱禁止命名管道与管道式子进程。**对策**：tsx shim 只能绕过 esbuild 一个点，**受限沙箱下无法完成构建**，必须在可 spawn 子进程的环境运行 |
| R12 | 每次构建 10 分钟以上，失败后重跑仍从头开始 | 源仓库构建体系没有阶段级跳过：`scripts/build.ts` 无条件顺序跑 `build:native-system` / `build:lib` / `build:web`；`release:pack` 对全部包逐个 `pnpm pack`；`prepare:*` 重建产物目录；`electron-builder` 全量重打包。只有 `tsc -b` 自带增量。**已实现缓存与并行打包，见 [design.zh.md](design.zh.md) 第 5.1 节与本文第 4 节** |
| R13 | 构建报 `tar (child): Cannot connect to D: resolve failed` | 在 **Git Bash** 里跑构建时，PATH 里的 MSYS `tar` 把 Windows 路径 `D:\...` 当成 `host:path`。**对策**（按可用环境二选一）：① 用 PowerShell / CMD 跑；② 只能用 Git Bash 时，把 Windows 版 tar 前置到 PATH —— `mkdir -p .cache/pathshim && ln -sf /c/Windows/System32/tar.exe .cache/pathshim/tar.exe`，然后 `PATH="$(pwd)/.cache/pathshim:$PATH" node scripts/build.mjs`（`.cache/` 已被忽略，实测可用）。**注意**：本仓库 agent 环境的 pwsh 工具受沙箱限制，node 在里面无法 spawn 子进程（`spawnSync git EPERM`，即 R11），所以本机实际走的是 ② |

### 2.2 构建缓存与产物

| # | 现象 | 根因与对策 |
|---|---|---|
| R14 | 同一成员 `pnpm pack` 两次，tarball 的 sha256 不同 | 上游打包**不是字节可复现**的：差异只在打包后 manifest 的键顺序（tar/gzip 头与文件清单一致）。缓存判据由此确定 —— 见 [decisions.zh.md](decisions.zh.md) 第 16 条 |
| R15 | 缓存明明该命中却每轮报 `miss (no-marker)` | marker 一度放在**源仓库根**的 `.desktop-build/local-cache/`，而 `.gitignore` 只忽略 `apps/desktop/.desktop-build/` —— 根目录那份被第 3 步 `git clean -fd` 每轮删掉。**对策**：marker 一律落在 `apps/desktop/.desktop-build/targets/<target>/local-cache/`（被忽略，构建流程的各阶段都不会清它；上游 `pnpm clean` 会清整个 `.desktop-build/`，属预期的冷缓存重置） |
| R16 | 想确认某次构建到底重做了什么 / 想强制全量重做 | 每个缓存决策都往构建日志（`.cache/build/build.log`）打一行 `build-cache: <stage> hit\|miss (<原因>)`。marker 有两处：`apps/desktop/.desktop-build/targets/<target>/local-cache/*.json`（`build-official`、`prepare-dsh-<target>`、`package-dir-<target>`）与 `.../packed/.pack-cache/<family>/*`（tarball 成员；私有 Host 与 native entry 另有 `<name>/packed/` 与 `tarball.json`）。删掉这两处即回到冷缓存；改 `src/build.config.json` 的 `checkout` 会自动让全部缓存失效 |
| R17 | 源码一行没改，`prepare:dsh` 却每轮 `miss (key-changed)` | 有两个 `pnpm pack` **不经 `release:pack`**、因此没进成员缓存：私有 Host（`apps/desktop-host`）与 native entry（`native/system/packages/entry`）——前者由 `package-target.ts` 直接 pack，后者在 `rmSync` 后 pack。而 `pnpm pack` 字节不可复现（R14）→ 它们的 `integrity` 每轮都变 → `prepare:packages` 生成的 package set 变 → `prepare:dsh` 的键跟着变。**对策**：两处也走同一套缓存（缓存 packed 出来的目录，再拷进输出目录）。定位方法：构建前后各算一遍逐项 `contentKey`，变化的那一项就是元凶（`prepare:packages` 本身是确定的：同一输入重跑 242 个文件 0 差异） |
| R18 | 改哪类文件会触发全量重编译？ | 编译阶段的键 = pin + 该构建指令 + 工具链清单 + **参与编译的注入物**；`src/build.config.json` 的 `ignoreTargets` 当前声明 `apps/desktop/renderer` 与 `apps/desktop/local` 不参与。因此改页面/资源（`assets/icon.png`、`src/features/renderer/`、`startup.{html,js}.patch`）只让 `--dir` 装配重做；改其他 patch（包括 `src/features/*.mjs` 本身）会让编译阶段重跑一次。**新增注入物默认算编译输入**：想让它不参与，必须在 `ignoreTargets` 里显式写上 |

### 2.3 启动页与渲染进程

| # | 现象 | 根因与对策 |
|---|---|---|
| R19 | 加载动画的 PNG 能从 shell 资源里显示吗？ | `apps/desktop/src/main.ts` 的 MIME 表只有 `.css/.html/.js/.svg`，`loading-art.png` 实际按 `application/octet-stream` 返回；但资源没有 `X-Content-Type-Options: nosniff`，Chromium 对 `<img>` 走内容嗅探 → 实测解码正常（`naturalWidth/Height` = 512×512）。**上游将来若给 shell 资源加 nosniff，这里会破** |
| R20 | 想验证加载动画真的显示、样式没被 CSP 挡住 | dev 模式（3.3）自带主进程 inspector，从它看最省事：`fetch('http://127.0.0.1:9229/json/list')` 取 `webSocketDebuggerUrl` 连上，`Runtime.evaluate` 里用 `process.mainModule.require('electron')` 拿 `BrowserWindow`，再 `webContents.executeJavaScript()` 读 `#loading-art` 的 `naturalWidth`、`getComputedStyle().animationName`、隔 0.7s 再读 `transform`（两次不同即在动），`capturePage().toPNG()` 存图。**启动页地址是 `dsh-app://shell/startup.html`**（scheme 由 `main.ts` 的 `SCHEME` 决定，`shell://` 是错的）；别用 `webContents.loadURL` 抢导航 —— 应用自身在推进导航时会把它中断（`ERR_FAILED (-2)`），要看就自己 `new BrowserWindow()`（此时没有 preload，`startup.js` 报 `Cannot read properties of undefined (reading 'locale')`，属预期） |
| R21 | 打包产物（GUI 子系统进程）不产出任何 stdout | win-unpacked 的 exe 没有控制台：`ELECTRON_ENABLE_LOGGING=1` 也不进重定向文件（实测两趟都是 2 字节空日志）。**对策**：改用 `DSH_DESKTOP_DIAGNOSTIC_FILE` 让主进程把启动阶段写进文件；`scripts/smoke-packaged.mjs` 就是按这个判据判通过的 |
| R22 | 打包产物的启动冒烟怎么判「真的到了应用页」 | 判据两条：① 诊断文件出现 `phase=application-page`（主进程推进到应用页的直接事实；Host 起不来时页面停在 `dsh-app://shell/startup.html`，不会有这一行）② profile 自包含（`package.json`、`pnpm-workspace.yaml`、`node_modules`、`desktop-runtime-state.json` 都在）。**实测**：冷启动（空 home）~6.4s 到 ready、~7s 到应用页；复用同一 home 的温启动 ~2.5s。本机（Node v24.13.0）复跑又测得：冷启动 ~5.4s 到 ready、~5.8s 到应用页，温启动 ~5.2s（与机器负载相关）。命令：`node scripts/smoke-packaged.mjs [超时秒数]`，日志落 `.cache/runs/packaged-smoke.log`、诊断落 `$DSH_HOME/diagnostic.log` |
| R23 | 打包产物报「找不到模块」才算到应用页 | `tsdown` 会把 `../local/features/*.mjs` 重写成 `lib/local/features/*.mjs`，所以 ① `tsdown.config.ts` 要把**运行期**用到的功能层文件列进 `deps.neverBundle`（当前是 `profile-recovery.mjs`、`diagnostics.mjs`、`diagnostics-log.mjs` 三个）② `electron-builder.config.mjs` 的 `files` 要加 `local/features/*.mjs`。少任何一条，打包产物会因为解析不到功能层而直接落到启动页。**已知状态**：功能层还有两个只被构建脚本 import 的文件（`build-cache.mjs`、`tarball.mjs`），不在 `neverBundle` 里；实测 `tarball.mjs` 会作为独立文件出现在 `app.asar`（`\local\features\tarball.mjs`），`build-cache.mjs` 不出现。二者都不被运行期代码 import，所以只是多带约 3KB，不影响启动。**这个坑踩过两次**：新增**运行期**功能层文件时必须同步登记 `neverBundle`，否则 `build:lib` 报 `[UNRESOLVED_IMPORT] Could not resolve '../local/features/<name>.mjs' in lib/types/main.js`（`tarball.mjs` 只被构建脚本 import，不受影响；`diagnostics-log.mjs` 被 `main.ts` import，漏登记就失败） |
| R24 | 阶段 4 的复制/回退怎么在无 web profile 的机器上验证 | web profile 不存在时功能层直接跳过（返回 null），所以 `$DSH_HOME/profiles/web` 缺失的机器上行为等价于「没定制」。要验证复制路径得自造 web profile 夹具（`package.json` + `pnpm-workspace.yaml`），`src/features/profile-recovery.test.mjs` 覆盖了配置语义与重试边界，接线层由官方 `apps/desktop/tests/main-startup.spec.ts` 的 4 个新用例覆盖 |
| R25 | 想看「启动失败时页面上显示什么」，但打包产物没有控制台 | 上游启动页把文案写进 `<pre id="error">` 的 `textContent`（`startup.js`：`failed ? state.message : ''`），与主进程 `pageError.message` 同源。诊断文件在 `phase=error` 那行**附上这份文案**，所以读文件等价于读页面。**不要走 inspector**：`DSH_DESKTOP_MAIN_INSPECT_PORT` 等调试端口只对**未打包** Electron 生效，打包产物起不了 inspector（实测 9229 未监听） |
| R26 | 跑诊断验证时，第二次启动应用直接退出 | `apps/desktop/src/single-instance.ts` 用 `requestSingleInstanceLock()`，拿不到锁就 `application.quit()` 并聚焦已有窗口。**锁挂在 Electron 默认 user-data 目录上（应用没设置 `userData`），与 `DSH_HOME` 无关 —— 换 home 绕不过去。** 因此一轮只能观察一个失败场景：先关掉旧实例，再跑 `node scripts/verify-diagnosis.mjs --profile <none\|manifest\|state\|unknown>`。该脚本**不终止任何进程**，观察完需自行关窗口 |

## 3. 复刻命令

### 3.1 一次性准备

```bash
cd <仓库根>
# 1) 源仓库 clone（内含独立 .git，本仓库不跟踪）
git clone <source-repo-url> deepseek-harness
# 2) 安装依赖（版本与 store 必须一致，见 R9）
cd deepseek-harness && pnpm install --frozen-lockfile
```

### 3.2 构建（按 design 第 3 节的配置驱动流程）

```bash
cd <仓库根>
node scripts/build.mjs           # 读配置 → 校验提交 → 清理并 checkout → 复制 → 打 patch → 执行构建指令
```

流程的每一步都以 `src/build.config.json` 为准：

| 步 | 依据配置字段 | 说明 |
|---|---|---|
| 校验并 checkout | `checkout` | 提交不存在即报错退出 |
| 复制定制文件 | `copy[{from,to}]` | 适配层与功能层的独立文件复制到目标位置 |
| 打 patch | `patches[]` | 把已封装能力调度进官方流程（不实现功能），见决策 4 |
| 构建 | `build[{cwd,command}]` | 在源仓库执行，命令与参数不在脚本里硬编码 |

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

**未覆盖的部分**：`prepare:packages` 与 `prepare:runtime`（各 ≈6s）都不接缓存 —— 前者在修复外部
`tar` 之后已从 577s 回到秒级，因此不需要缓存这一层；后者按决策 22 维持不接。

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
| 适配层（进程内） | 现有文件：`smoke.mjs`（把上游 payload smoke 的形态固定下来 —— 检查项清单 `SMOKE_CHECKS` 与跳过文案格式 `formatSmokeSkipLine`，由功能层 `smoke-tolerance.mjs` 消费）。**没有独立测试文件**：本层只被 `smoke-tolerance.test.mjs` 带着覆盖到（该测试在自己的注释里把「功能层 import 适配层」列为隐式契约）。所以本层尚无独立守卫 —— 官方接口变更不会由本层的测试先失败；补测方式即「结构断言测试：喂官方样例、断言解析/包装结果」 |
| 功能层（进程内） | 纯函数单测（`node --test`，显式路径），不依赖 Electron 与官方代码 |
| 功能层（tarball 读取） | 拿 `packed/` 里的真实 tarball 逐一双跑「外部 `tar -tzf` / `tar -xOzf`」与进程内 `listTarballEntries` / `readTarballManifest`，断言条目列表与 manifest 完全一致（实测 277/277），再比 `desktop-packages.json` 的 sha256 不变 |
| 功能层（诊断文件） | `src/features/diagnostics-log.test.mjs`（6 例：行格式、detail 在同一行、换行压平、空串与 undefined 等价、追加写盘可逐行解析、写盘失败不抛） |
| 适配层 / 功能层（渲染进程） | `src/features/renderer/loading-art.test.mjs`：用 `node:vm` + 假 DOM 按接线顺序跑两个经典脚本，断言插入位置、可见性切换、「只创建 `img` 且无内联样式」；不依赖 jsdom 与官方代码 |
| patch 层 | `git apply --check` + 完整构建 + 隔离 `DSH_HOME` 启动冒烟；改了启动页再跑官方 `apps/desktop/tests/startup-renderer.spec.ts`（`node_modules/.bin/vitest run <路径>`，实测 8/8 通过） |
| 加载动画（视觉） | dev 模式 + R20 的 inspector 读法：`naturalWidth` 证明图片解码、`animationName`/两次 `transform` 证明 CSS 动画在跑、`styleElements`/`style` 属性为 0 证明没碰内联样式 |
| 阶段 4（复制 / 快照 / 回退） | `src/features/profile-recovery.test.mjs`（16 例：配置语义合并、allowBuilds 按行合并、幂等、快照/回退三步、探针失败与重试边界）+ 官方 `apps/desktop/tests/main-startup.spec.ts` 的 4 个新用例（接线顺序、放弃复制、回退一次后停手、诊断上页） |
| 阶段 5（诊断规则，功能层） | `src/features/diagnostics.test.mjs`（7 例：每条规则命中上游真实错误串、阶段不串、覆盖表一致、未命中返回 null、AggregateError 展开、不可恢复提示、格式化保留原始串） |
| 阶段 5（诊断链，端到端） | `node scripts/verify-diagnosis.mjs --profile <none\|manifest\|state\|unknown>`：破坏 profile 后起产物，读诊断文件里 `phase=error` 那行的内容（等价于启动页 `<pre id="error">`，见 R25），断言「命中规则 → 阶段标题 + 下一步 + 原始串」与「未命中 → 退回原始串」。**受单实例锁限制，一轮一个场景（R26）**；脚本不终止进程 |
| 打包产物（冒烟） | `node scripts/smoke-packaged.mjs`：见 R22/R23，冷启动与温启动各实测通过 |
| 整体闭环 | 按配置执行完整流程后，产物可正常启动；源仓库仍能 `checkout` 到配置指定的提交 |
| 构建时间优化 | 连续两次构建，第二次显著更快；只改页面/资源类文件时不触发全量编译（见 design 第 5.1 节）。**另外看缓存决策行**：稳态必须 `build-cache: … hit` 全命中、0 miss —— 曾经出现过「全命中但仍要 20 分钟」的情况，原因是外部 `tar` 进程（见第 4 节），所以「命中率」与「耗时」要同时看 |
