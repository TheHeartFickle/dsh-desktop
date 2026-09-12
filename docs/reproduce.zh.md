# 探索内容与复刻命令

> 本文是 `docs/` 三份设计文档之一：[当前设计](design.zh.md) ｜ [重大决策与原因](decisions.zh.md) ｜ **探索内容与复刻命令**；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 源仓库 | `desktop/deepseek-harness`（独立 `.git`，可 checkout 到任意提交） |
| 已验证基线 | commit `c291e7961a515f6d7af9304e7fd1d257929aef26`，版本 `0.1.5-rc.2` |
| tag 差异 | `dsh-v0.1.5-rc.2` 指向另一提交 `fb2c4b9e69`，与基线差 1379 文件 |
| Node | `C:\Program Files\nodejs\node.exe` v22.19.0（满足 `engines: ^22.19.0 \|\| >=24.0.0`） |
| pnpm | 全局 npm 装的是 **11.21.0**，但源仓库 `package.json` 声明 `packageManager: pnpm@11.7.0`，pnpm 自管理会切到 **11.7.0**（实际使用的版本）。**store 必须与该版本匹配**（见 R9） |
| pnpm store | `D:\Users\Nuper\.pnpm-store\v11` |
| 包缓存选盘 | C/D 为 KIOXIA、E 为 ZHITAI，跨盘会失去硬链接；store 与仓库同置于 D 盘 |
| Electron | 44.0.0（`apps/desktop/node_modules/electron`，随上游 lockfile 变化） |
| 镜像 | `~/.npmrc` 里配置了 `registry=https://registry.npmmirror.com`（注意上游构建会屏蔽它，见 R10） |
| 打包需要 | `DSH_DESKTOP_APP_ID`（反向域名）；`--unsigned` 模式下不需要签名证书 |

> 源仓库的依赖（`node_modules`）与构建产物都**不随本仓库同步**：新机器 clone 后需先安装依赖，再按第 3 节构建。

## 2. 关键踩坑

| # | 现象 | 根因与对策 |
|---|---|---|
| R1 | `pnpm run dev:desktop` 报 `Error [TransformError]: spawn EPERM (esbuild/lib/main.js:2268)` | 构建脚本全经 `tsx`，tsx 依赖 esbuild 启动 helper 子进程（命名管道）。**对策**：受限环境用 `node --experimental-transform-types <script.ts>` 替代；见第 4 节 tsx shim |
| R2 | 隔离失效、污染真实 `~/.dsh` | dev 启动器用 `process.env.DSH_HOME ?? 隔离目录`，外层已注入 `DSH_HOME` 时会静默走真实 home。**对策**：启动前显式赋值 |
| R3 | 桌面端一启动，agent loop 卡死 | 与运行中的 agent 会话共用 `$DSH_HOME`。**对策**：验证时一律用独立 home |
| R4 | 直接跑 `electron.exe <APP_ROOT>` 显示官方恢复页 | 跳过了 `prepareDevelopmentProject()`——它每次都删除并重建 `.desktop-build/development/project` 并写入运行元数据。**对策**：走完整启动器 |
| R5 | 长任务把 agent loop 卡死 | 巨量 stdout 灌满 subprocess 管道（**实测卡死两次**）。**对策**：`*> 日志文件` 或后台 + 只读日志尾部 |
| R6 | 插件树加载失败导致后端起不来、日志刷屏 | 上游 smoke 检查要求已被 `node-addon-system` 取代的 `fs-ext`。**对策**：patch 层容忍其缺失（功能层封装判断，patch 只插入调用） |
| R7 | `pnpm config set … --global` 静默不生效 | 它触发无关的 global-bin PATH 检查而中断。**对策**：用 `--location=global` |
| R8 | `pnpm run X -- --unsigned` 参数传错；`pnpm exec tsx …` 报 `invoke this script through a pnpm package command` | pnpm 把 `--` 当字面参数传入；且 `pnpm exec` 不设置 `npm_execpath`，而 `package-target.ts` 的 `runPnpm()` 强制要求它 |
| R9 | `pnpm install` 报 `unable to open database file` | **pnpm 版本与 store 不匹配**：store 的 `index.db` 由某个大版本建立，另一个版本打不开。本机全局 pnpm 是 11.21.0，源仓库却声明 `pnpm@11.7.0`（自管理切换），两者共用同一个 `store-dir` 就冲突。**对策**：让 store 与「实际调用的 pnpm 版本」一致——本机按 11.7.0 重建；旧 store 备份在 `.pnpm-store.bak-1121` |
| R10 | `prepare:dsh` 报 `ERR_PNPM_META_FETCH_FAIL … registry.npmjs.org … timeout` | `apps/desktop/scripts/prepare-dsh.ts` 的 `runPnpm()` **硬编码** `registry.npmjs.org`，并过滤掉 `npm_*`/`pnpm_*`/`corepack_*`/`DSH_DESKTOP_*` 环境变量、把 `XDG_CONFIG_HOME` 指向临时目录——本机任何镜像配置都进不去。**对策**：patch 层把 registry 改为读 `DSH_LOCAL_NPM_REGISTRY`（不设时仍是官方地址，行为不变） |
| R11 | 构建报 `spawn EPERM`（esbuild helper），继而 `spawnSync git` 也 EPERM | 受限沙箱禁止命名管道与管道式子进程。**对策**：tsx shim 只能绕过 esbuild 一个点，**受限沙箱下无法完成构建**，必须在可 spawn 子进程的环境运行 |
| R12 | 每次构建 10 分钟以上，失败后重跑仍从头开始 | 源仓库构建体系没有阶段级跳过：`scripts/build.ts` 无条件顺序跑 `build:native-system` / `build:lib` / `build:web`；`release:pack` 对全部包逐个 `pnpm pack`；`prepare:*` 重建产物目录；`electron-builder` 全量重打包。只有 `tsc -b` 自带增量。**已实现缓存与并行打包，见 [design.zh.md](design.zh.md) 第 5.1 节** |
| R13 | 构建报 `tar (child): Cannot connect to D: resolve failed` | 在 **Git Bash** 里跑构建时，PATH 里的 MSYS `tar` 把 Windows 路径 `D:\...` 当成 `host:path`。**对策**（按可用环境二选一）：① 用 PowerShell / CMD 跑；② 只能用 Git Bash 时，把 Windows 版 tar 前置到 PATH —— `mkdir -p .cache/pathshim && ln -sf /c/Windows/System32/tar.exe .cache/pathshim/tar.exe`，然后 `PATH="$(pwd)/.cache/pathshim:$PATH" node scripts/build.mjs`（`.cache/` 已被忽略，实测可用）。**注意**：本仓库 agent 环境的 pwsh 工具受沙箱限制，node 在里面无法 spawn 子进程（`spawnSync git EPERM`，即 R11），所以本机实际走的是 ② |
| R14 | 同一成员 `pnpm pack` 两次，tarball 的 sha256 不同 | 上游打包**不是字节可复现**的：差异只在打包后 manifest 的键顺序（tar/gzip 头与文件清单一致）。缓存判据由此确定 —— 见 [decisions.zh.md](decisions.zh.md) 第 16 条 |
| R15 | 缓存明明该命中却每轮报 `miss (no-marker)` | marker 一度放在**源仓库根**的 `.desktop-build/local-cache/`，而 `.gitignore` 只忽略 `apps/desktop/.desktop-build/` —— 根目录那份被第 3 步 `git clean -fd` 每轮删掉。**对策**：marker 一律落在 `apps/desktop/.desktop-build/targets/<target>/local-cache/`（被忽略，构建流程的各阶段都不会清它；上游 `pnpm clean` 会清整个 `.desktop-build/`，属预期的冷缓存重置） |
| R16 | 想确认某次构建到底重做了什么 / 想强制全量重做 | 每个缓存决策都往构建日志（`.cache/build/build.log`）打一行 `build-cache: <stage> hit\|miss (<原因>)`。marker 有两处：`apps/desktop/.desktop-build/targets/<target>/local-cache/*.json`（`build-official`、`prepare-dsh-<target>`、`package-dir-<target>`）与 `.../packed/.pack-cache/<family>/*`（tarball 成员；私有 Host 与 native entry 另有 `<name>/packed/` 与 `tarball.json`）。删掉这两处即回到冷缓存；改 `src/build.config.json` 的 `checkout` 会自动让全部缓存失效 |
| R17 | 源码一行没改，`prepare:dsh` 却每轮 `miss (key-changed)` | 有两个 `pnpm pack` **不经 `release:pack`**、因此没进成员缓存：私有 Host（`apps/desktop-host`）与 native entry（`native/system/packages/entry`）——前者由 `package-target.ts` 直接 pack，后者在 `rmSync` 后 pack。而 `pnpm pack` 字节不可复现（R14）→ 它们的 `integrity` 每轮都变 → `prepare:packages` 生成的 package set 变 → `prepare:dsh` 的键跟着变。**对策**：两处也走同一套缓存（缓存 packed 出来的目录，再拷进输出目录）。定位方法：构建前后各算一遍逐项 `contentKey`，变化的那一项就是元凶（`prepare:packages` 本身是确定的：同一输入重跑 242 个文件 0 差异） |
| R18 | 改哪类文件会触发全量重编译？ | 编译阶段的键 = pin + 该构建指令 + 工具链清单 + **参与编译的注入物**；`src/build.config.json` 的 `ignoreTargets` 当前声明 `apps/desktop/renderer` 与 `apps/desktop/local` 不参与。因此改页面/资源（`assets/icon.png`、`src/features/renderer/`、`startup.{html,js}.patch`）只让 `--dir` 装配重做；改其他 patch（包括 `src/features/*.mjs` 本身）会让编译阶段重跑一次。**新增注入物默认算编译输入**：想让它不参与，必须在 `ignoreTargets` 里显式写上 |
| R19 | 加载动画的 PNG 能从 shell 资源里显示吗？ | `apps/desktop/src/main.ts` 的 MIME 表只有 `.css/.html/.js/.svg`，`loading-art.png` 实际按 `application/octet-stream` 返回；但资源没有 `X-Content-Type-Options: nosniff`，Chromium 对 `<img>` 走内容嗅探 → 实测解码正常（`naturalWidth/Height` = 512×512）。**上游将来若给 shell 资源加 nosniff，这里会破** |
| R20 | 想验证加载动画真的显示、样式没被 CSP 挡住 | dev 模式（3.3）自带主进程 inspector，从它看最省事：`fetch('http://127.0.0.1:9229/json/list')` 取 `webSocketDebuggerUrl` 连上，`Runtime.evaluate` 里用 `process.mainModule.require('electron')` 拿 `BrowserWindow`，再 `webContents.executeJavaScript()` 读 `#loading-art` 的 `naturalWidth`、`getComputedStyle().animationName`、隔 0.7s 再读 `transform`（两次不同即在动），`capturePage().toPNG()` 存图。**启动页地址是 `dsh-app://shell/startup.html`**（scheme 由 `main.ts` 的 `SCHEME` 决定，`shell://` 是错的）；别用 `webContents.loadURL` 抢导航 —— 应用自身在推进导航时会把它中断（`ERR_FAILED (-2)`），要看就自己 `new BrowserWindow()`（此时没有 preload，`startup.js` 报 `Cannot read properties of undefined (reading 'locale')`，属预期） |

## 3. 复刻命令

### 3.1 一次性准备

```bash
cd D:/Project/DeepSeek-Harness/desktop
# 1) 源仓库 clone（内含独立 .git，本仓库不跟踪）
git clone <source-repo-url> deepseek-harness
# 2) 安装依赖（版本与 store 必须一致，见 R9）
cd deepseek-harness && pnpm install --frozen-lockfile
```

### 3.2 构建（按 design 第 3 节的配置驱动流程）

```bash
cd D:/Project/DeepSeek-Harness/desktop
node scripts/build.mjs           # 读配置 → 校验提交 → 清理并 checkout → 复制 → 打 patch → 执行构建指令
```

流程的每一步都以 `src/build.config.json` 为准：

| 步 | 依据配置字段 | 说明 |
|---|---|---|
| 校验并 checkout | `checkout` | 提交不存在即报错退出 |
| 复制定制文件 | `copy[{from,to}]` | 适配层与功能层的独立文件复制到目标位置 |
| 打 patch | `patches[]` | 行插入，接入官方流程 |
| 构建 | `build[{cwd,command}]` | 在源仓库执行，命令与参数不在脚本里硬编码 |

构建期间必须注意：输出重定向到文件（R5）、设置 `DSH_DESKTOP_APP_ID` 与 `npm_execpath`（R8）、
镜像通过 `DSH_LOCAL_NPM_REGISTRY` 传入（R10）、在可 spawn 子进程的环境运行（R11）、
用 Git Bash 跑时先把 Windows 版 tar 前置到 PATH（R13）。

### 3.3 开发态启动（验证隔离时用）

```powershell
cd D:\Project\DeepSeek-Harness\desktop\deepseek-harness\apps\desktop
$env:DSH_HOME = "D:\Project\DeepSeek-Harness\desktop\.cache\dev-home"   # 必须显式隔离（R2/R3）
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
node --experimental-transform-types scripts/dev.ts --skip-build
```

结论：dev 模式**不会**创建 `$DSH_HOME/profiles/desktop`，而是直接用 `.desktop-build/development/project`。
实测（2026-09-12）：隔离 home 下 dev 模式能起到真实 UI（`dsh-app://app/index.html`），`.cache/dev-home` 由流程按需生成。
dev 模式自带两个 inspector：主进程 `--inspect=127.0.0.1:9229`、渲染进程 `--remote-debugging-port=9222`（端口被占时后者静默失败，见 R20）。

## 4. tsx shim（仅受限沙箱环境）

构建脚本全经 `tsx`，而受限沙箱禁止 esbuild 的 helper 子进程（R1）。可把 tsx 换成 Node 原生 TS 转发：

```bash
cd D:/Project/DeepSeek-Harness/desktop/deepseek-harness
printf '#!/bin/sh\nexec node --experimental-transform-types "$@"\n'         > node_modules/.bin/tsx
printf '@echo off\r\nnode --experimental-transform-types %%*\r\n'           > node_modules/.bin/tsx.CMD
printf '#!/usr/bin/env pwsh\n& node --experimental-transform-types @args\n' > node_modules/.bin/tsx.ps1
chmod +x node_modules/.bin/tsx node_modules/.bin/tsx.ps1
pnpm exec tsx --version   # 应输出 v22.19.0（Node 版本），而非 tsx v4.x
```

还原（通过重新安装依赖即可回归原版）：

```bash
cd D:/Project/DeepSeek-Harness/desktop/deepseek-harness
pnpm install --frozen-lockfile
```

> **shim 的能力边界**：它只替换 `tsx` 一个入口。受限沙箱还会拒绝其它管道式子进程
> （实测 `spawnSync git` 同样 EPERM），所以**受限沙箱下无法完成构建**，必须在可 spawn 子进程的环境运行（R11）。

## 5. 验证方式

| 对象 | 方式 |
|---|---|
| 适配层（进程内） | 结构断言测试：给官方样例，验证解析/包装结果；官方内部实现变更时测试先失败 |
| 功能层（进程内） | 纯函数单测（`node --test`，显式路径），不依赖 Electron 与官方代码 |
| 适配层 / 功能层（渲染进程） | `src/features/renderer/loading-art.test.mjs`：用 `node:vm` + 假 DOM 按接线顺序跑两个经典脚本，断言插入位置、可见性切换、「只创建 `img` 且无内联样式」；不依赖 jsdom 与官方代码 |
| patch 层 | `git apply --check` + 完整构建 + 隔离 `DSH_HOME` 启动冒烟；改了启动页再跑官方 `apps/desktop/tests/startup-renderer.spec.ts`（`node_modules/.bin/vitest run <路径>`，实测 8/8 通过） |
| 加载动画（视觉） | dev 模式 + R20 的 inspector 读法：`naturalWidth` 证明图片解码、`animationName`/两次 `transform` 证明 CSS 动画在跑、`styleElements`/`style` 属性为 0 证明没碰内联样式 |
| 整体闭环 | 按配置执行完整流程后，产物可正常启动；源仓库仍能 `checkout` 到配置指定的提交 |
| 构建时间优化 | 连续两次构建，第二次显著更快；只改页面/资源类文件时不触发全量编译（见 design 第 5.1 节） |
