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
所以 patch 可以远多于一行（`main.ts.patch` 现有 +149 行），但它调度的每个判断都来自功能层。

**透明原则**：流程不在乎它处理的是什么。**配置文件、构建脚本、功能代码对这套流程完全透明** ——
不会因为「这是构建脚本」「这是配置文件」就产生特殊分支或特殊处理。

**适配层的出参是先设计出来的契约，且一经定下即冻结。** 写适配层之前先回答「功能层要判断什么、要展示什么」，
据此定出参的名字、字段与语义，再去写「官方现在用什么表达它」的映射；出参写进 `.d.mts`，官方换实现时只改
映射那一层，**对外的 API 一个字不动**。判据不是「出参像不像官方」，而是**官方改了内部实现，功能层要不要动**：
会变的东西（官方错误文案、内部路径、选择器、枚举取值、官方字段名）不许透出去；而**语义稳定的结构可以照抄**
——官方的设计可能本来就是最佳实践，复用比另造一个同构的孪生结构更好。借的形要写一句「它为什么稳定」
（决策 36）。**判定某条 API 已腐败、需要动它是用户的权力**：agent 只能在适配层内部消化，实在表达不了就
停下上报，由用户裁决后才允许适配层 API 与功能层一起改（决策 37）。

## 2. 构建流程

流程完全由 `build.config.json` 驱动，构建脚本只是执行器：

```
1. 读配置
2. 取源仓库；把配置声明的 tag 解析成提交（解析不到 → 报错退出）
3. 清理工作区，checkout 到解析出的提交；按配置从官方模板补齐**缺失的**打包本地设置
4. 按配置的复制映射，把文件复制到指定位置
5. 按顺序应用配置列出的 git patch（场景 4 的接线）
6. 进入源仓库，执行配置里声明的构建指令；该指令声明的产物（`build[].artifacts`）在成功后**复制进本仓库**
```

要点：

- **第 2 步**：**配置里存的是 tag，不是提交号**——升级只换一个 tag，提交号由这一步现算
  （`git rev-parse --verify '<tag>^{commit}'`）。解析不到必须显式失败退出：不自动 `fetch`（那会动源仓库的 ref），
  也不允许「用当前 HEAD 凑合」；报错里直接给出取回命令。
- **第 3 步**：清理只针对工作区（丢弃未提交改动与未跟踪文件），**不碰 ref、不碰远程、不改历史** ——
  源仓库任何时候都能把配置声明的 tag 解析出提交并 `checkout` 过去。上一次构建留下的改动因此不会干扰本次构建，
  流程内不需要「还原」这个独立概念。
- **第 3 步（后半）**：官方打包脚本只从 `apps/desktop/.env.windows` 读发布设置，还会把进程环境里的同名变量
  滤掉，所以该文件必须存在、且是值的唯一来源；它被官方 gitignore，`git clean -fd` 不会删。配置的
  `releaseEnv[{template,file}]` 声明模板与目标，流程只在该文件**不存在**时按官方模板生成，并把
  `DSH_DESKTOP_APP_ID` 写成配置的 `appId`——用户填过凭据的文件永不被覆盖（决策 39）。
- **第 4 步**：复制目标写在配置里，复制到哪就是哪；不为「保护源仓库整洁」而藏文件或改名。除各层的 `.mjs`/`.d.mts`
  与渲染进程资源外，`copy` 也是本地品牌资源的入口：`assets/dsh-impact.png` 覆盖官方的
  `apps/desktop/resources/icon-windows.png`，由官方打包脚本带进产物与 exe 图标。
- **第 5 步**：patch 不实现功能，只做任务调度与导出修改；补丁失配时 `git apply` 直接报错，无需额外的断言机制。
- **第 6 步**：构建指令写在配置里，脚本不硬编码任何上游脚本名或参数。**产物写到哪由上游构建脚本决定，本仓库
  不改它的输出路径**；配置的 `build[].artifacts{from,to}` 只声明「这条指令的产物在哪、复制到本仓库的哪」，成功后
  把那份产物**复制**进本仓库——源仓库里留着原件，以产物为输出的缓存阶段下一轮照常命中（决策 41）。

配置的路径基准：`upstream` 相对仓库根；`copy[].from`、`patches[].file` 相对 `src/`；
`copy[].to`、`patches[].target`、`build[].cwd` 相对源仓库根。`npm_execpath`、`DSH_UPSTREAM_CHECKOUT`、
`DSH_DESKTOP_APP_ID` 与 `DSH_LOCAL_BUILD_KEY` 不写进配置 —— 它们由构建脚本解析或算出后注入，属环境事实
而非业务配置。

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
| 4 | web 配置迁移 / 配置快照回退 / 回退提示 | ✅ |
| 5 | 诊断规则模块（按阶段分组、规则互不可见） | ✅ |
| — | 打包产物启动冒烟（诊断文件记录启动阶段） | ✅ |
| 6 | 移植到上游 `dsh-v0.1.6-alpha.2`（`ddefc45fbc`）：接线全部重挂、两项定制随上游退场 | ✅ |

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
2. **上游 pin 由功能层混进每个键**（流程注入 `DSH_UPSTREAM_CHECKOUT`，值是 tag 解析出的**提交**）：产物属于
   某个确定的官方版本，换 tag（或 tag 被重指到别的提交）后所有缓存自动失效，不需要人去删目录。
3. 命中不等于产物没问题：能记摘要的产物在 marker 里记下字节数与 sha256，命中时逐条复核；整棵大树
   （如 `dsh/node_modules`）不逐字节复核，交给调用方传的 `verify` 句柄（`prepare:dsh` 传的就是上游
   `verifyDesktopRuntime`，它按描述符核对整棵树）。
4. marker 落在源仓库自己的被忽略构建目录（`apps/desktop/.desktop-build/targets/<target>/local-cache/`
   与 `packed/.pack-cache/<name>/`），不搬家；每个决策都往构建日志打一行
   `build-cache: <stage> hit|miss (<原因>)`。删掉这两处即回到冷缓存，不需要别的开关。

接线点清单与实测数据见 [reproduce.zh.md](reproduce.zh.md) 的[构建缓存的实现与实测](reproduce.zh.md#4-构建缓存的实现与实测)；为什么这么选、否掉了哪些做法，
见 [decisions.zh.md](decisions.zh.md) 第 12、15–20、22 条。

### 4.2 启动路径功能规范（用户可感知）

适用范围：**打包产物上用户看得见的启动路径行为**。工程保障（构建缓存、smoke 容忍）见 §4.1 与
[reproduce.zh.md](reproduce.zh.md)；上游本身的能力边界见 [desktop-guide.zh.md](desktop-guide.zh.md)。
每条给出「规范」（应有行为）与「判据」（怎么证明它成立）；实现形态与接线点见本节末。

| # | 规范 | 判据 |
|---|---|---|
| ① 加载动画 | 等待后端时展示鲸鱼动画（沿用自研壳的 `assets/icon.png` → `renderer/local/loading-art.png`）。**载体是官方网络前端的 BootPage**（`0.1.6-alpha.2` 起上游删掉了 `renderer/startup.html`，启动等待改由前端 BootPage 承担）：适配层用官方的 `data-dsh-boot` / `data-dsh-boot-spinner` 标记跟随它，并把「官方已不再等待」收敛成 `onFailed`；功能层只在官方「仍在加载」时展示、官方切到失败报告或应用挂载后收起，**本次 pin 升级里功能层零改动**（`placeArt(element)` / `sync(failed)` 一个字节没动）。接线由 patch 在注入处写死：两个同源脚本之后再补一行内联语句 `dshStartupPage.onFailed(dshLoadingArt.sync)`。资源由 shell 从 `dsh-app://app/local/` 以正确 MIME 返回，**不依赖 Chromium 的内容嗅探**。两个独立文件全部同源（CSS + 图片 + 经典脚本），自身无内联脚本/样式（决策 21） | `#loading-art` 解码成功（`naturalWidth > 0`）且 CSS 动画在跑；官方启动页出现前它不展示、加载标记消失后收起、启动页被移除时随之离开文档；渲染进程测试断言「只创建 `img`、无内联样式」 |
| ② web 配置迁移 | **严格一次性**：只在 desktop profile 还是官方空形态、且没有写下了结记账时迁移 `profiles/web` 的第三方插件；此后 web 的增删都不再影响 desktop。迁移的是**配置语义而非目录**：`package.json` 的 `dependencies` 第三方条目与 `overrides`、`dsh.profile.bundles` 第三方条目、`pnpm-workspace.yaml` 的 `allowBuilds` 段（按行合并）；**依赖 spec 照搬**（range / `github:` 都保留），由 patch 放宽官方 `projectManifest` 的精确版本校验。不搬 `.dsh-market`、`update.ps1`、`cordis.yml`、`cordis.patch.yml`、`node_modules` | 首次启动（web 有插件）→ 插件进入 desktop、Host 就绪、记 `done`；第二次启动不迁移；profile 已被用户自己装过 → 不迁移；官方重置后记账消失、重新走一次 |
| ③ 迁移的成功与失败处置 | `done` = Host 就绪且本次未回退；装包/探针失败 = 临时性 → 回退、不写下了结记账、下次重试，**连续 3 次**转 `abandoned`；Host boot 失败 = 该批插件在本机起不来 → 回退、重试一次、记 `abandoned`（不再重试）。记账文件在 profile 内 | 三条路径都有接线用例；记账随官方重置一起消失；重试与放弃都不写 patch 层文案 |
| ④ 配置快照与回退 | 快照 profile 里用户可变的四个文件：`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`cordis.patch.yml`（可缺失）。**不备份** `desktop.cordis.yml` 与 `node_modules`（后者由适配层的 `installProfilePackages` 重建）。只在**本次要迁移**时、写入前拍一次——迁移前的 profile 就是上一次可启动的配置，不设「`ready` 后提交 last-good」。回退两步：还原文件 → 重建依赖（`pnpm install --no-frozen-lockfile --ignore-scripts`）；**没有迁移的那次启动不回退**（交官方致命出口，决策 24） | 回退后文件与快照逐字节一致、且能重新启动（依赖已按快照的清单重建）；没迁移的启动失败不触发回退 |
| ⑤ 回退提示 | 回退后若成功进入应用页，注入一次自绘 toast，说明「已回滚到本次启动之前的配置（含从 web profile 复制来的插件）」；不依赖 dsh 前端 DOM，也不改 `desktop-host` | 回退且成功 → 出现一次、约 9s 消失；没有回退时不出现 |
| ⑥ 启动失败诊断 | 在官方错误出口（`reportFatal` → 原生恢复对话框 + `desktopErrorState(error).message`）之上加一层：把失败归到**一个**阶段，给「标题 + 下一步」，并**保留原始错误串**。按阶段分组、规则互不可见、沿用「首因原则」；未命中返回 null（对话框照官方原样显示 `detail`）。阶段划分：版本不匹配 / 壳与 Host 启动 / 配置层 / profile 与插件图 / **插件安装失败** / 包管理缓存。规则只基于上游**源码里的真实错误串**，不凭空造 | 每条规则都有对应的上游错误串样例；未命中时对话框显示官方原文；`ERR_PNPM_FETCH_404` 落到「插件安装失败」而不是「包管理缓存失败」 |

**明确的边界（不做）**：

- 不镜像 web 的插件启停；web 之后新增的插件也不自动迁移——要用就在应用内的插件管理里装（上游已删掉桌面插件窗口，不再有独立窗口）
- 依赖 spec 照搬的代价：非精确版本（`^`/`github:`）的解析结果由 pnpm 决定，不保证与 web 侧装到的版本一致
- 探针通过 ≠ 能起来：运行时服务/API 变化只有真正 boot 才暴露（见下方能力边界表）
- 迁移的插件必须与内置 dsh 相容：实测真实 web profile 的插件会因缺 peer（`react`）或版本不匹配（要求 `@deepseek-ai/schemastery@3.18.1`、运行时 `3.18.2`）在图校验阶段失败；按 ③ 的规则重试到上限后记 `abandoned`，profile 回退到迁移前（R24/R27/R28）

**实现形态**：功能层 `src/features/profile-recovery.mjs`（迁移判断与记账 / 快照 / 回退 / 提示）与
`src/features/diagnostics.mjs`（诊断规则）承载全部判断；patch 只把调用插进官方 `apps/desktop/src/main.ts`。
**profile 包操作在适配层**（`src/adaptator/profile-packages.mjs` 的 `installProfilePackages`）：`0.1.6-alpha.2`
把 profile 的包管理整体搬进了 Host，Electron 主进程里已无 pnpm 能力（`DesktopProjectManager` 只剩
`disableAllPlugins` / `applyRelease`）——**官方出口的消失属于「官方内部实现变动」，由适配层吸收**，
功能层的需求（④ 的重建依赖）没有变。patch 把适配层这个函数作为 `onRepair` 喂给功能层，功能层只认回调。
profile 目录的建立仍走官方能力：patch 给 `DesktopProjectManager` 加了 `ensureProfileDirectory`，复用官方
`createPluginProfile`。打包态与 dev 的分界也在接线层：**只有打包运行才迁移**（`!development`）。接线点：

| 时机 | 调用 |
|---|---|
| `navigateMain(applicationUrl)` 之后、`backend.start()` 之前 | `ensureProfileDirectory` → `webProfileMigration` 按 `skip` / `settle` / `migrate` 调度：`settle` 记 `done` 并结束；`migrate` 才走快照 → 写入 → `installProfilePackages` → desktop runtime 里探针 `import()` |
| 迁移写入后的任何失败（装包、探针） | 回退到写入前的快照并重装 → 记一次失败（连续 3 次转 `abandoned`）→ 交官方致命出口（不重试）。装包失败发生在 `backend.start()` 之前，所以与探针失败走同一分支 |
| Host 启动失败（复制成功后） | 回退一次 → 重装 → 记 `abandoned` → 原地重试一次启动；第二次再失败交官方致命出口 |
| Host 就绪 | 本次迁移未被回退时记 `done`（一次性窗口关闭） |
| `reportFatal()` | `startupErrorState` 命中的阶段标题 + 下一步 + 原始错误串，作为原生恢复对话框的 `detail` |
| 回退后成功进入应用页 | `executeJavaScript` 注入一次自绘 toast |

**迁移的是配置语义而非目录**（决策 23）：`package.json` 的 `dependencies`/`overrides`/第三方
`dsh.profile.bundles` 条目，以及 `pnpm-workspace.yaml` 的 `allowBuilds` 段（按行合并，不整文件照搬）。
`.dsh-market`、`update.ps1`、`cordis.yml`、`node_modules` 等 web 专用本地产物不搬。
web profile 的 `cordis.patch.yml` 也不搬：它是该 profile 自己的 patch 层，且可能引用 web 目录里的相对文件
（例如 `rewind-common.gitignore`），搬过去会指向不存在的路径。

快照只覆盖 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`cordis.patch.yml` 四个用户可变文件；
`desktop.cordis.yml` 每个启动都被官方重写、`node_modules` 由 lockfile 重建，都不进快照。

#### 插件兼容性校验的能力边界（对应 ② 的校验时机）

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

### 4.3 三层腐败门限（工程保障）

分层规范（AGENTS.md 硬约束 1–4、上面的 patch 层边界）靠自觉执行是**不够**的：「功能层里混进官方内部实现」
「patch 层里长出功能逻辑」这两类腐败**不会让任何测试失败**——它们只是让下一次上游升级从「重新生成 patch」
恶化为「重写两层」。所以规范落成一条能跑、会红的门限：`npm run check:layers`（**构建第 0 步也会跑**，
红了就构建不了），实现见 `scripts/check-layers.mjs`。

**规则只取可机械判定的信号**，不做「这段代码像不像功能逻辑」的主观判断。id 与实现一一对应：

| id | 判据 | 级别 |
|---|---|---|
| A1 | 功能层 import 了官方/Electron（`electron`、`@deepseek-ai/*`） | 硬 |
| A2 | 功能层相对 import 越过了适配层 | 硬 |
| A3 | 功能层的**正则**会命中上游源码里的某一行（且命中不落在更长的标识符内部） | 硬 |
| A4 | 功能层的**字面量**与上游源码里的字面量完全相同 | 硬 |
| B1 | patch 新增行里有用户可见文案（中文字面量） | 硬 |
| B2 | patch 新增行里自己实现能力（`child_process`/`crypto`/`spawn`/`mkdtemp`/`createHash`） | 硬 |
| B3 | patch 新增行里有策略、阈值或匹配（正则、`.test`/`.match`、与字面量的数值比较） | 硬 |
| C1 | src 下的独立文件没登记进 `build.config.json` 的 `copy` | 硬 |
| C2 | 配置里的 patch 文件、或它的上游 target 不存在 | 硬 |
| C3 | 适配层 import 了功能层（依赖方向倒置） | 硬 |
| A5 | 功能层 import 了第三方包（确认它是上游本来就有的依赖） | 告警 |
| B4 | patch 新增的函数体偏大或带分支 | 告警 |
| B5 | patch 新增行里有像英文产品文案的字符串 | 告警 |

**故意不判的**：B4 不做成硬规则——硬约束 2 明确允许 patch「持有接线状态、按官方状态决定何时调度」，
把控制流判死会让门限立刻变成噪声源；字面量与上游的**部分**重合也不算（`tarball.mjs` 自己写的
`${tarball} has no package manifest` 与官方同义，重合只是巧合）；npm/pnpm/Node 的生态通用名
（`node_modules`、`package.json`、`pnpm-lock.yaml`、`node:*`）不算「官方内部名」——官方只是碰巧也在用同一套
生态约定，dsh 自己的名字（`@deepseek-ai/dsh-base`、`cordis.patch.yml`）仍然算耦合。

**三条让它可信的机制**：

1. **报告必须带证据**：A3/A4 打印命中的那行上游源码，C2 打印缺失路径。没有证据的报告等于噪声。
2. **白名单必须可校验**：`src/layer-allowlist.json` 每条 `{file, literal, reason}`；**没写 reason 的例外不放行**，
   **已经失效的条目本身算违规**。否则白名单半年后就是垃圾场。
3. **门限自己也有负样本单测**：`scripts/check-layers.test.mjs` 对每条硬规则各造一个好/坏样本，
   并断言「本仓库当前状态必须通过」。**门限红了要改设计，不要改门限去迁就现状。**

**盲区（抓不到，别指望）**：功能层**复刻**官方一段算法；patch 里靠多次调度拼出新行为；英文文案只能弱启发式；
「这段判断到底算不算需求」不可判定。上游 clone 不在场时 A3/A4 与 C2 的上游存在性检查整段跳过（打印提示），
其余规则照跑。

这个门限的第一个收益就是它自己逼出来的重构：适配层因此多出 `diagnostics-signals.mjs`（官方错误文本 →
稳定信号）与 `profile-layout.mjs`（profile 磁盘布局），功能层里那两类官方知识被清了出去。
