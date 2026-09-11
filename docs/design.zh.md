# 当前设计

> 本文是 `docs/` 三份设计文档之一：**当前设计** ｜ [重大决策与原因](decisions.zh.md) ｜ [探索内容与复刻命令](reproduce.zh.md)；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

在官方 `deepseek-harness` 桌面端之上叠加本地定制：**官方源码保持可 `git checkout` 的干净状态**，
定制以补丁形式临时注入，构建后还原。

## 1. 形态

放弃早期自研壳，直接使用官方 `apps/desktop`（自带私有固定版本 dsh + 独占 `profiles/desktop`），
在其上叠加本地定制。上游不接受 issue/PR，因此不合适之处由本地补丁长期承担。

## 2. 三层架构

```
patch 层 ──插入调用──▶ 实现层 ──调用──▶ 适配层 ──适配──▶ 官方源码
```

| 层 | 目录 | 职责 | 何时修改 |
|---|---|---|---|
| **适配层** | `src/upstream/` | 隔离官方接口变动：把路径、签名、数据结构、生命周期固定成稳定 API，**让实现层的依赖面固定** | 官方**接口**变动时 |
| **实现层** | `src/features/` | 固定功能实现（阶段 4/5 能力），只依赖适配层 | **需求**变动时（否则零改动） |
| **patch 层** | `scripts/upstream-patches/` | 把功能接进官方源码（优先插入调用；删除/替换须声明 `kind` 与生效断言） | 每次跟进官方提交时 |

**补丁原则：优先纯增量**——能只插入调用，就不改动官方原有逻辑；确需删除或替换时，在
`manifest.json` 的 `kind` 里显式声明（`remove-override` / `modify`），并同步声明 `assert` 生效断言。
理由：插入类补丁失配会被 `git apply` 明确拒绝，而删除类补丁在官方换了写法之后可能
**干净应用却不再生效**（构建静默回落），只有断言能兜住这种静默失效。

跟进官方更新时，**只有 patch 层需要改**（这正是三层的意义）。

## 3. 目录结构

```
desktop/                          ← 本仓库（GitHub 同步）
  deepseek-harness/               ← dsh 上游源码（内含独立 .git；不跟踪，各机器自行 clone）
  .cache/                         ← 构建产物缓存（不跟踪；上游 .desktop-build 经 junction 落这里）
                                    注意：pnpm 包缓存在全局 store，不在此目录
  src/
    upstream/                     ← 适配层
    features/                     ← 实现层
  scripts/
    upstream-patches/             ← patch 层
      manifest.json               ← 元数据：baseCommit / baseVersion / 补丁清单
      *.patch
      tsx-backup/                 ← 环境适配（仅受限沙箱需要）
      README.md                   ← 操作手册
    apply-local.mjs               ← 应用
    restore-local.mjs             ← 还原
  archive/desktop-legacy/         ← 旧自研壳（git mv 保留历史）
  docs/
```

## 4. 工作流

```bash
cd D:/Project/DeepSeek-Harness/desktop
node scripts/apply-local.mjs --check   # 只校验：上游干净 + 补丁能否干净应用到基线（不改动上游）
node scripts/apply-local.mjs           # 应用
# ...构建 / 打包...
node scripts/restore-local.mjs         # 还原
```

`--check` 不改动上游：它把补丁涉及的文件从 `baseCommit` 导出到临时目录再校验。因此即使上游 HEAD
已经漂移（例如已跟进到新版本），结论仍然是「补丁能否干净应用到基线」——与真实应用一致。

`apply-local.mjs` 依次完成：

1. 校验上游工作区干净（有未提交改动则拒绝）
2. 记录当前 ref，`checkout` 到 `manifest.json` 的 `baseCommit`
3. 把上游 `apps/desktop/.desktop-build` 重定向为 **junction** → `<repo>/.cache/desktop-build`，并把注入目录写进上游 `.git/info/exclude`
4. 按层复制：`src/upstream` → `.local-desktop/upstream/`，`src/features` → `.local-desktop/features/`
5. 先对全部补丁 `git apply --check`，通过后再逐个应用
6. 写入 `.state.json` → 执行各补丁的 `assert` 生效断言 → 检查 pnpm store 前提（只警告，不阻塞）

关于第 3 步的 `exclude`：注入目录不是上游的文件，写进 `.git/info/exclude` 后，apply 期间上游
`git status` 保持干净（只显示补丁改动的两个文件），避免人工 `git clean` / `checkout` 误伤注入物。

关于第 4 步：**两层必须各占一个子目录**。它们若摊平进同一个目录，两层的同名文件
（例如各自的 `README.md`）会静默互相覆盖，`upstream` 层的契约文件可能直接丢失。
分层后实现层统一以 `../upstream/<module>.mjs` 引用适配层。

第 6 步先落状态再断言：断言失败时补丁已经写进上游，必须保证 `restore-local.mjs` 能还原。

`restore-local.mjs` 做逆操作：丢弃补丁改动 → 删除补丁新增的未跟踪文件 → 切回原 ref →
删除注入目录 → 移除 `.git/info/exclude` 条目与 junction → 校验干净。

## 5. 缓存策略

| 缓存 | 位置 | 机制 |
|---|---|---|
| pnpm 包 | **pnpm 全局 store**（`pnpm store path`） | 补丁删掉了上游对 store 位置的覆盖，pnpm 用它自己的默认 → 全局位置一变，构建自动跟随，**无需预热、无硬编码**。前提：`store-dir` 必须配在 pnpm 全局配置（`--location=global`）——上游的 `--config.userconfig=<空文件>` 会屏蔽 `~/.npmrc`；`apply` 时会检查并警告 |
| 内置 Node 归档 | `.cache/desktop-build/downloads/` | 上游 `prepare-runtime.ts` 自带 `if (!existsSync(archive))` 判断 |
| 构建产物 | `.cache/desktop-build/targets/` | 经 junction 落在仓库内，不随源码移动丢失 |

## 6. 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 隔离环境下跑通开发态 | ✅ |
| 2 | 打包 Windows 产物（已实机验证进入真实 UI） | ✅ |
| 3 | 自研壳归档 | ✅ |
| 4 | 加载动画 / 复制 web 配置确认 / 配置快照回退 / 回退提示 | ⬜ 待实施 |
| 5 | 诊断规则模块（按阶段分组、规则互不可见） | ⬜ 待实施 |

阶段 4/5 须走三层架构，**不可做成 dsh 插件**（原因见 [decisions.zh.md](decisions.zh.md) 第 6 条）。

## 7. 阶段 4/5 设计要点（待实施）

| 能力 | 设计要点 |
|---|---|
| 加载动画 | 沿用自研壳的鲸鱼动画（`assets/`），叠加/替换官方 `renderer/startup.*` 的视觉层。**受 CSP 约束**：`startup.html` 声明的是 `script-src 'self'; style-src 'self'; img-src 'self' data:`，所以只能由补丁改这两个文件本身，不能内联脚本/样式、不能取外部资源；鲸鱼图用 `data:` URI 内联，也就不必向上游新增资源文件 |
| 复制 web 配置 | 触发条件：`profiles/desktop` 不存在且 `profiles/web` 含第三方插件。复制的是**配置语义而非目录**：`dependencies`、`dsh.profile.bundles` 里的第三方条目、`overrides`，以及 `pnpm-workspace.yaml` 的 `allowBuilds`（缺它，带 lifecycle script 的插件装不上）。web profile 里的 `.dsh-market`、`update.ps1` 之类本地产物不搬。校验方式与时机见第 8 节 |
| 配置快照/回退 | 备份 profile 里**用户可变**的文件：`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`cordis.patch.yml`（可缺失）。**不备份** `desktop.cordis.yml`——它是 `desktop-host` 每次启动都重写的常量根配置，文件名也与 CLI profile 的 `cordis.yml` 不同；`node_modules` 由 lockfile 重建，同样不备份。时机：启动前快照 → 状态 `ready` 后提交为 last-good → 失败则回退并重试**一次** → 二次失败交官方恢复页（避免死循环）。回退必须是三步：还原文件 → 重建依赖 → **刷新宿主包链接**（第一方包是链进 profile 的，只还原文件不足以恢复可启动态） |
| 回退提示 | 主进程在 `navigateMain(applicationUrl)` 成功后用 `executeJavaScript` 注入自绘 toast；不依赖 dsh 前端 DOM，也不改 `desktop-host` |
| 诊断规则 | 按阶段分组、规则互不可见，沿用"首因原则"。原设计的环境层（Node/npm）与依赖层（dsh 安装）在官方架构下**直接消失**（运行时内置、版本固定），但换来了新的失败面，阶段要据此重排：① 壳与 Host 启动（内置 Node 归档、Host 进程与管道握手）② profile 与插件图（装包、`allowBuilds`、`validateDesktopPluginGraph`）③ 包管理缓存（pnpm store 可用性与跨盘、lockfile 冲突）④ 配置层（`cordis.patch.yml` 行 id 失效、快照回退）⑤ 内置 dsh 与插件版本不匹配 |

## 8. 插件兼容性校验的能力边界

一次子进程 `import()` 只能证明「这个模块能被加载」。边界必须写清，否则容易被读成「校验通过 = 能起来」：

| 失效形态 | 能否抓到 | 例 |
|---|---|---|
| 静态 import 里缺失的具名导出 | ✅ 抛 `SyntaxError` | `settingsNamespace`（插件顶层 import） |
| 模块加载期抛错 | ✅ | 顶层读取不存在的文件 |
| 运行时服务/API 变化 | ❌ 只有真正 boot 才暴露 | 插件在 `apply(ctx)` 里用签名已变的 `ctx.*` |
| 配置 schema 变化、`cordis.patch.yml` 行 id 失效 | ❌ | 行 id 被官方改名 |
| peer 版本导致的行为差异 | ❌ | `validateDesktopPluginGraph` 只保证依赖解析到位 |

**校验必须在 desktop runtime 的解析语境里做。** 桌面端用内置固定版本 dsh，web/CLI profile 用用户全局版本，两者可以不同——这正是决策 1 的立足点。在 web 的 `node_modules` 里跑 `import()`，结论不能外推到 desktop。
因此只有两种可行时机，实现前必须先定：

1. 以 desktop runtime 的 `node_modules` 作为解析根做校验（不依赖 profile 复制）；
2. 先复制 + 安装，再校验，失败即回退。

> `validateDesktopPluginGraph` 仍要做：它保证依赖图健全（host link、包逃逸、重复包、缺失依赖、peer 声明、版本范围），与 API 兼容性校验互补，缺一不可。
