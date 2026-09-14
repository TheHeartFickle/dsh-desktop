# 当前设计

> 本文是 `docs/` 三份设计文档之一：**当前设计**（是什么、怎么做） ｜ [重大决策与原因](decisions.zh.md)（为什么） ｜
> [探索内容与复刻命令](reproduce.zh.md)（怎么跑、怎么验证、实测到什么）；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

在官方 `deepseek-harness` 桌面端之上叠加本地定制。定制 = **独立文件**（适配层 + 功能层）+ **git patch 接线**（只做任务调度，不实现功能）；
本仓库的构建脚本按配置把文件复制到指定位置、打上 patch，再进入源仓库执行它自己的构建指令。

## 1. 三层

```
patch 层 ──调度已封装能力──▶ 功能层(func) ──调用──▶ 适配层 ──固定接口──▶ 官方实现
```

| 层 | 目录 | 职责 | 形态 | 何时修改 |
|---|---|---|---|---|
| **适配层** | `src/adaptator/` | 把官方**内部接口**固定成稳定接口：官方内部实现的变动在这一层被吸收，向上返回所需的数据结构 | **独立文件** | 官方内部实现变动时（接口的拼接） |
| **功能层** | `src/features/` | 功能实现（例：启动前的配置同步页面），以函数封装，只依赖适配层 | **独立文件** | **需求**变动时（否则不修改） |
| **patch 层** | `src/patch/`（每个目标源文件一个 `<name>.<extension>.patch`） | **不实现功能**：只做任务调度与导出修改 —— 把已封装好的能力按顺序接进官方流程，并按官方状态决定何时调度 | git patch | 每次接线 |

**工作模型**：源仓库流程启动 → patch 调度的 `func` 生效（例如同步配置、展示加载动画）→ `func` 退出 →
控制流回到源仓库原本设计的流程（例如服务器启动）。

**patch 层的边界**（按变更内容判定，不按行数）：

| patch 层可以有 | patch 层不能有 |
|---|---|
| import 功能层函数；**接线状态**（例如「本次回退是否已处理」的标记）；按顺序串接多个调用；按官方状态决定**何时**调度 | **功能本身**：判断该不该跳过、要不要回退、复制哪些文件、提示什么文案、日志行长什么样 |

判据是「这段代码在决定**什么**，还是在决定**何时/按什么顺序**」。前者属功能层，后者属 patch 层。
所以 patch 可以远多于一行（`main.ts.patch` 现有 +109 行），但它调度的每个判断都来自功能层。

**透明原则**：流程不在乎它处理的是什么。**配置文件、构建脚本、功能代码对这套流程完全透明** ——
不会因为「这是构建脚本」「这是配置文件」就产生特殊分支或特殊处理。

## 2. 构建流程

流程完全由 `build.config.json` 驱动，构建脚本只是执行器：

```
1. 读配置
2. 校验源仓库存在且是 git 仓库；配置声明的提交不存在 → 报错退出
3. 清理工作区，checkout 到配置指定的提交
4. 按配置的复制映射，把文件复制到指定位置
5. 按顺序应用配置列出的 git patch（场景 4 的接线）
6. 进入源仓库，执行配置里声明的构建指令
```

要点：

- **第 2 步**：提交不存在必须显式失败退出，不允许「用当前 HEAD 凑合」。
- **第 3 步**：清理只针对工作区（丢弃未提交改动与未跟踪文件），**不碰 ref、不碰远程、不改历史** ——
  源仓库任何时候都能 `checkout` 到指定提交。上一次构建留下的改动因此不会干扰本次构建，
  流程内不需要「还原」这个独立概念。
- **第 4 步**：复制目标写在配置里，复制到哪就是哪；不为「保护源仓库整洁」而藏文件或改名。
- **第 5 步**：patch 不实现功能，只做任务调度与导出修改；补丁失配时 `git apply` 直接报错，无需额外的断言机制。
- **第 6 步**：构建指令写在配置里，脚本不硬编码任何上游脚本名或参数。

配置的路径基准：`upstream` 相对仓库根；`copy[].from`、`patches[].file` 相对 `src/`；
`copy[].to`、`patches[].target`、`build[].cwd` 相对源仓库根。`npm_execpath`、`DSH_UPSTREAM_CHECKOUT`
与 `DSH_LOCAL_BUILD_KEY` 不写进配置 —— 它们由构建脚本解析或算出后注入，属环境事实而非业务配置。

`build[].ignoreTargets` 声明"哪些注入目标不参与这条构建指令的输入"（当前是 `apps/desktop/renderer`
与 `apps/desktop/local`）：**没被声明的注入物一律算输入**，因此新增 copy/patch 只会让该阶段的缓存多失效
一次，不会出现"输入变了却命中"。缓存契约见 [构建脚本时间优化](#41-构建脚本时间优化已实施)。

## 3. 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 隔离环境下跑通开发态 | ✅ |
| 2 | 打包 Windows 产物 | ✅ |
| 3 | 自研壳归档 | ✅ |
| 4 | 加载动画：三层实现 + dev 模式视觉验证 | ✅ |
| 4 | 复制 web 配置 / 配置快照回退 / 回退提示 | ✅ |
| 5 | 诊断规则模块（按阶段分组、规则互不可见） | ✅ |
| — | 打包产物启动冒烟（诊断文件记录启动阶段） | ✅ |

阶段 4/5 须走三层架构，**不可做成 dsh 插件**（原因见 [decisions.zh.md](decisions.zh.md) 第 6 条）；
各项怎么验证见 [reproduce.zh.md](reproduce.zh.md) 的[验证方式](reproduce.zh.md#6-验证方式)。

## 4. 功能设计

### 4.1 构建脚本时间优化（已实施）

| 项 | 内容 |
|---|---|
| 问题 | 源仓库的构建体系没有阶段级跳过：`release:pack` 对 266 个包逐个 `pnpm pack`（串行 0.54s/个）；`prepare:runtime` 每轮重解压；`prepare:dsh` 在干净临时目录里重装 506 个包；`electron-builder` 全量重装配。只有 `tsc -b` 自带增量（project references + `.tsbuildinfo`）。**另有一项与缓存无关的开销**：`scripts/release/tarball.ts` 读 tarball 走外部 `tar` 进程（`capture('tar', […])` → `spawnSync`），而 `pack.ts` 对每个成员、`prepare-package-set.ts` 对每个 tarball 各调一次 —— 单次构建数百个进程，成本与 tarball 大小无关（详见 reproduce 的[构建缓存的实现与实测](reproduce.zh.md#4-构建缓存的实现与实测)） |
| 目标 | 重复构建的时间显著下降；只改页面/资源类文件时，不重跑编译与打包 |
| 判据 | ① 连续两次构建，第二次明显快于第一次 ② 只改页面/资源类文件后的构建不触发全量编译 ③ 产物内容正确、可正常启动 |
| 约束 | 遵守透明原则：**不得**靠外部传入「跳过哪个阶段」的标志；**不得**在流程里为某类文件或某个阶段开特例；优化对「处理的是什么」保持透明 |

**实现形态**：功能层 `src/features/build-cache.mjs` 提供 `contentKey(inputs)`、`reuse(options)` 与
`reusePackedDirectory(options)`（三处 `pnpm pack` 共用的「缓存 packed 目录 + 发布到输出目录」语义），
判断逻辑全在这一层；patch 层只把调用插进上游流程，一处一个目标源文件。

外部 `tar` 那项另由功能层 `src/features/tarball.mjs` 承担：它把「读一个 tarball」实现为进程内调用
（`readTarballManifest` / `listTarballEntries`，等价于原来的 `tar -xOzf` / `tar -tzf` 输出），
patch 只把两处调用换成它。放在功能层的原因是「怎么读 tarball」是实现判断，patch 里只允许出现调用。

**缓存契约**（四条，越界即 bug）：

1. 键只允许比真实输入**更宽**（最多白重做），不允许更窄（命中而输入已变 = 陈旧产物）。**不用 mtime**：
   流程每轮 `git reset --hard`、复制、打补丁都会刷新 mtime，mtime 判据必然失效。往键里塞目录时，
   那个目录**不能包含本阶段自己写出的产物**（`.desktop-build`、`dist`、`*.tsbuildinfo`），否则键自我引用。
2. **上游 pin 由功能层混进每个键**（流程注入 `DSH_UPSTREAM_CHECKOUT`）：产物属于某个确定的官方版本，
   换提交后所有缓存自动失效，不需要人去删目录。
3. 命中不等于产物没问题：能记摘要的产物在 marker 里记下字节数与 sha256，命中时逐条复核；整棵大树
   （如 `dsh/node_modules`）不逐字节复核，交给调用方传的 `verify` 句柄（`prepare:dsh` 传的就是上游
   `verifyDesktopRuntime`，它按描述符核对整棵树）。
4. marker 落在源仓库自己的被忽略构建目录（`apps/desktop/.desktop-build/targets/<target>/local-cache/`
   与 `packed/.pack-cache/<name>/`），不搬家；每个决策都往构建日志打一行
   `build-cache: <stage> hit|miss (<原因>)`。删掉这两处即回到冷缓存，不需要别的开关。

接线点清单与实测数据见 [reproduce.zh.md](reproduce.zh.md) 的[构建缓存的实现与实测](reproduce.zh.md#4-构建缓存的实现与实测)；为什么这么选、否掉了哪些做法，
见 [decisions.zh.md](decisions.zh.md) 第 12、15–20、22 条。

### 4.2 阶段 4/5 功能

| 能力 | 设计要点 |
|---|---|
| 加载动画 | 沿用自研壳的鲸鱼动画（`assets/icon.png` → `renderer/loading-art.png`），等待后端时展示，官方 `render()` 判定失败时收起。**已按三层落地**：适配层 `adaptator/renderer/startup-page.js` 固定「插到官方页面哪个位置」，功能层 `features/renderer/loading-art.{js,css}` 负责画面与可见性，patch 只插 `<link>`、两个 `<script>` 和 `render()` 里一行 `dshLoadingArt.sync(failed)`。受 CSP 约束（`script-src 'self'; style-src 'self'; img-src 'self' data:`）：样式是同源 CSS 文件、图片是同源 PNG，无内联脚本/样式；渲染进程没有模块上下文（官方 `startup.js` 是经典脚本），所以两层以经典脚本 + 全局对象组装（决策 21） |
| 复制 web 配置（已实施） | 触发条件：`profiles/desktop` 不存在且 `profiles/web` 含第三方插件。复制的是**配置语义而非目录**：`dependencies`、`dsh.profile.bundles` 里的第三方条目、`overrides`，以及 `pnpm-workspace.yaml` 的 `allowBuilds`（缺它，带 lifecycle script 的插件装不上）。web profile 里的 `.dsh-market`、`update.ps1` 之类本地产物不搬。**校验时机**：先复制 + 安装，再在 desktop runtime 的解析语境里校验，失败即回退 |
| 配置快照/回退（已实施） | 备份 profile 里**用户可变**的文件：`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`cordis.patch.yml`（可缺失）。**不备份** `desktop.cordis.yml`——它是 `desktop-host` 每次启动都重写的常量根配置；`node_modules` 由 lockfile 重建，同样不备份。时机：启动前快照 → 状态 `ready` 后提交为 last-good → 失败则回退并重试**一次** → 二次失败交官方恢复页（避免死循环）。回退必须是三步：还原文件 → 重建依赖 → **刷新宿主包链接**（第一方包是链进 profile 的，只还原文件不足以恢复可启动态） |
| 回退提示（已实施） | 主进程在 `navigateMain(applicationUrl)` 成功后用 `executeJavaScript` 注入自绘 toast；不依赖 dsh 前端 DOM，也不改 `desktop-host` |
| 诊断规则（已实施） | 按阶段分组、规则互不可见，沿用「首因原则」。原设计的环境层（Node/npm）与依赖层（dsh 安装）在官方架构下**直接消失**（运行时内置、版本固定），换来的新失败面决定阶段划分：① 壳与 Host 启动（内置 Node 归档、Host 进程与管道握手）② profile 与插件图（装包、`allowBuilds`、`validateDesktopPluginGraph`）③ 包管理缓存（pnpm store 可用性与跨盘、lockfile 冲突）④ 配置层（`cordis.patch.yml` 行 id 失效、快照回退）⑤ 内置 dsh 与插件版本不匹配 |

**实现形态**：功能层 `src/features/profile-recovery.mjs`（复制 / 快照 / 回退 / 提示）与
`src/features/diagnostics.mjs`（诊断规则）承载全部判断；patch 只把调用插进官方 `apps/desktop/src/main.ts`
与宿主能力（官方 `DesktopProjectManager` 新增一个「无条件重建 profile」入口）。接线点：

| 时机 | 调用 |
|---|---|
| `reconcileBackend()` 之前 | `webProfileCopyPlan` →（有变化才）快照 → 写入 → 重装并刷新宿主链接 → desktop runtime 里探针 `import()` |
| 探针失败 | 立刻回退到本次启动前的快照并重装，第一次失败交官方恢复页（不重试） |
| Host 启动失败（复制成功后） | 回退一次 → 重装 → 重试启动一次；第二次再失败交官方恢复页 |
| `showStartupError()` | `diagnoseStartupFailure` 命中的阶段标题 + 下一步 + 原始错误串 |
| 回退后成功进入应用页 | `executeJavaScript` 注入一次自绘 toast |

**复制的是配置语义而非目录**（决策 23）：`package.json` 的 `dependencies`/`overrides`/第三方
`dsh.profile.bundles` 条目，以及 `pnpm-workspace.yaml` 的 `allowBuilds` 段（按行合并，不整文件照搬）。
`.dsh-market`、`update.ps1`、`cordis.yml`、`node_modules` 等 web 专用本地产物不搬。

**两条边界**（写在这里，免得被读成「所有情况都管」）：
1. web profile 的 `cordis.patch.yml` 不复制：它是该 profile 自己的 patch 层，且可能引用 web 目录里的相对文件
   （例如 `rewind-common.gitignore`），搬过去会指向不存在的路径。
2. 快照只覆盖 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`cordis.patch.yml` 四个用户可变文件；
   `desktop.cordis.yml` 每个启动都被官方重写、`node_modules` 由 lockfile 重建，都不进快照。

#### 插件兼容性校验的能力边界（对应上表「复制 web 配置」的校验时机）

一次子进程 `import()` 只能证明「这个模块能被加载」。边界必须写清，否则容易被读成「校验通过 = 能起来」：

| 失效形态 | 能否抓到 | 例 |
|---|---|---|
| 静态 import 里缺失的具名导出 | ✅ 抛 `SyntaxError` | 插件顶层 `import { settingsNamespace }` |
| 模块加载期抛错 | ✅ | 顶层读取不存在的文件 |
| 运行时服务/API 变化 | ❌ 只有真正 boot 才暴露 | 插件在 `apply(ctx)` 里用签名已变的 `ctx.*` |
| 配置 schema 变化、`cordis.patch.yml` 行 id 失效 | ❌ | 行 id 被官方改名 |
| peer 版本导致的行为差异 | ❌ | `validateDesktopPluginGraph` 只保证依赖解析到位 |

**校验必须在 desktop runtime 的解析语境里做。** 桌面端用内置固定版本 dsh，web/CLI profile 用用户全局版本，
两者可以不同——这正是决策 1 的立足点。在 web 的 `node_modules` 里跑 `import()`，结论不能外推到 desktop。
因此校验时机取「先复制 + 安装，再校验，失败即回退」。

> `validateDesktopPluginGraph` 仍要做：它保证依赖图健全（host link、包逃逸、重复包、缺失依赖、peer 声明、
> 版本范围），与 API 兼容性校验互补，缺一不可。
