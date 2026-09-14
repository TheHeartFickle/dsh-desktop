# 任务计划：dsh-desktop 环境复刻 + 全链路验证

## 目标

用户确认（2026-09-14）：

- **轨道 A**：出「环境复刻 + 全链路验证」清单 —— 把文档自述的阶段 1–5 结论在本机复现成可验证事实
- 粒度：**每条 todo 带可执行命令 + 验证判据**

> ⚠️ 最初还把「新增功能（三层落地）」列为「轨道 B」，那是**错的**：「三层落地」是 design 的[三层](../design.zh.md#1-三层)规定的
> **设计规范**，不是一件功能、也不是可完成的交付物。该轨道已删除（见 [todo-list.md](todo-list.md)「关于三层落地」）。

交付物：`todo-list.md`（清单本体）。

## 探索结论（已验证事实）

| 项 | 结论 | 取证方式 |
|---|---|---|
| 仓库状态 | 干净，HEAD = `0af4544`，2026-09-13 | `git status` / `git log` |
| 文档自述阶段 | 阶段 1–5 全部 ✅ | design 的[当前状态](../design.zh.md#3-当前状态) |
| 功能层单测 | **57/57 通过**（约 615ms），无需 Electron / 官方代码 | `node --test "src/**/*.test.mjs"` |
| 上游源仓库 | 已 clone 到 `deepseek-harness/`，HEAD = 基线 `c291e7961a` | `git -C deepseek-harness rev-parse HEAD` |
| 上游地址 | `github.com/deepseek-ai/deepseek-harness.git`（仓库内原本只有占位符，已查明） | `git remote -v` |
| 构建/冒烟 | **本机可执行**：bash 工具能 spawn 子进程（R11 只约束文档作者的 pwsh 沙箱，见 findings 5.3） | 实跑构建 EXIT=0 |
| 构建入口 | `scripts/build.mjs` 完全由 `src/build.config.json` 驱动 | 读源码 + 配置 |
| 文档路径漂移 | 文档写 `D:/Project/DeepSeek-Harness/desktop`，实际在 `D:/git-project/dsh-desktop` | grep 全文 |
| 仓库远程 | `origin = github.com/TheHeartFickle/dsh-desktop.git` | `git remote -v` |

## 三层结构的可验证边界（决定清单里哪些条目能闭环）

| 层 | 本机可验证 | 需上游 clone |
|---|---|---|
| 适配层 `src/adaptator/` | 否（当前仅 `renderer/startup-page.js` + `smoke.mjs`） | ✅ |
| 功能层 `src/features/` | ✅ 纯函数单测（`node --test`） | 否 |
| patch 层 `src/patch/` | 否（需 `git apply --check` 打在真实上游文件上） | ✅ |
| 渲染进程 | ✅ `loading-art.test.mjs`（`node:vm` + 假 DOM） | 否 |
| 打包产物冒烟 | 否 | ✅ |

## 阶段

| # | 阶段 | 状态 | 验证 |
|---|---|---|---|
| 1 | 读文档 + 跑通本机可跑的测试 | complete | 51/51 pass（当时；现 57） |
| 2 | 探测环境事实（上游是否在场、构建能否执行） | complete | 上游缺失已确认 |
| 3 | 产出 3 份规划文件 | complete | 三份文件存在 |
| 4 | 向用户确认目标与粒度 | complete | 用户选 A+B，粒度=带命令+判据 |
| 5 | 产出 `todo-list.md`（轨道 A 可执行条目） | complete | 本条即交付 |
| 6 | 轨道 A 执行：环境事实核对 | complete | 0.2/0.3/0.5 通过；0.4 有版本差异（Node v24.13.0） |
| 7 | 轨道 A 执行：本机可独立验证项 | complete | 1.1 = 当时 51 pass；2.1 = 当时 13 个 patch 全通过（现已 14 个）；5.3 = 5 处路径已修 |
| 8 | 轨道 A 执行：装依赖 | complete | ✅ `pnpm install` EXIT=0，31.3s（第二会话误判为网络阻塞，已修正） |
| 9 | 轨道 A 执行：构建 + 冒烟 + 闭环 | complete | ✅ 3.1 EXIT=0；3.2 产物 sha256 跨 3 次一致；4.1/4.2 通过；5.1 HEAD 完整 |
| 10 | 定位 `prepare:dsh` 的 `key-changed`（todo 3.3） | complete | **定论**：缓存稳定（同一方法连跑两次 280 hit / 0 miss）。那次 miss 是一次性异常；根因见 findings 的[外部 tar 进程](findings.md#5-外部-tar-进程曾让稳态构建退化成-20-分钟已修复) |
| 11 | 定位稳态 20 分钟的根因并修复 | complete | **根因**：`tarballFiles` / `packedManifest` 逐次 spawn 外部 `tar`。**修复**：功能层 `tarball.{mjs,d.mts}` 进程内读；**稳态 1180s → 49–53s** |
| 12 | 文档按实测修订（todo 5.2） | complete | design 第 4.1/4.2 节、reproduce 第 4/6 节已改；未改 decisions 17/22 与历史性能表（依据仍成立） |
| 13 | ~~诊断文件记录启动页文案~~ | **作废** | 为 4.3 而下沉的功能层 `diagnostics-log` 与 `error-detail` 已全部删除 |
| 14 | ~~诊断链端到端验证（todo 4.3）~~ | **作废** | `scripts/verify-diagnosis.mjs` 已删除 |
| 15 | ~~轨道 B：新增功能~~ | **作废** | 「三层落地」是设计规范而非功能，不该列为轨道；已从清单删除 |

## 文档与实测的偏差（均已定论）

| # | 文档结论 | 本机实测 | 定论 |
|---|---|---|---|
| 1 | 稳态构建 **0.85 min** | 修复前 **1180s**；修复后 **49–53s** | 文档数字**本来是对的**；本机复现不到的原因是外部 `tar` 进程（已修复）。design/reproduce 已改 |
| 2 | 温启动 **~2.5s** 到 ready | **5.18s** | 机器相关，仍成立；reproduce 已补实测值 |
| 3 | 冷启动 ~6.4s 到 ready | **5.37s**（更快） | 同上 |
| 4 | `prepare:dsh`/`--dir` miss「未逐项定位」 | 连续两次 280 hit / 0 miss | **不是系统性摆动**，是一次性异常；findings 里「键摆动」那节已作废 |

## 阻塞点

| 阻塞 | 状态 | 缺了会怎样 |
|---|---|---|
| P1 上游 clone | ✅ 已解决 | 上游 = `github.com/deepseek-ai/deepseek-harness.git`，HEAD 即基线 |
| 网络 | ✅ 非阻塞（原判断已证伪） | 之前判为硬阻塞是误判，见 findings 5.4 |
| electron v44 下载 | ✅ 已解决 | `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` |
| 单实例锁（跑诊断验证时） | ⚠️ 需先关旧实例 | 与 `DSH_HOME` 无关，换 home 绕不过；见 R26 |
| ~~P2「新增功能」需求~~ | **作废** | 「三层落地」是规范不是功能，无需求可给；见上行 |

## 风险点

| 风险 | 影响 | 缓解 |
|---|---|---|
| pnpm 版本 / store 不匹配 | R9 | 仓库根 pnpm **11.22.0** 与 `U` 内 **11.7.0** 共用同一 store。**只在 `U` 内执行 pnpm** |
| 在 Git Bash 里跑构建 | R13 | 已验证成立（GNU tar 1.35）：**必须**前置 Windows tar（`.cache/pathshim/tar.exe`） |
| Electron 去 GitHub 下载 | 构建失败 `ETIMEDOUT 20.205.243.166:443` | 已验证解法：`ELECTRON_MIRROR` 指向 npmmirror |
| 长任务 stdout 灌满管道 | R5 卡死 loop | 已照做：所有构建输出重定向到 `.cache/build/*.log` |
| 冒烟未隔离 `DSH_HOME` | R2/R3 阻塞 agent | `smoke-packaged.mjs` 内建隔离（`.cache/smoke-home`），已验证 |
| **批量终止进程** | **本会话已犯三次，每次都伤到 agent** | **禁止任何形式的批量终止**（`taskkill //IM`、`Stop-Process -Name`、以及「先按名字筛 PID 再杀」）。无法可靠区分该杀与不该杀，所以一律不做 |
| 规划文件入库历史 | 四份会话文档已移到 `docs/session/`（不再平铺在仓库根），但**仍未被 git 跟踪** | 是否 `git add` 入库待决定 |

## 会话已产生的文件改动

| 文件 | 改动 | 状态 |
|---|---|---|
| `README.md` | 路径漂移修正 | 已改未提交 |
| `docs/design.zh.md` | 5.1 补外部 `tar` 问题与 `tarball.mjs`；5.2 补启动过程可观测性；目录结构补新文件 | 已改未提交 |
| reproduce | 路径修正；[构建缓存的实现与实测](../reproduce.zh.md#4-构建缓存的实现与实测)新增「外部 `tar` 进程」段；[验证方式](../reproduce.zh.md#6-验证方式)表重排并补诊断链；R23 修正、新增 R25/R26 | 已改未提交 |
| `src/build.config.json` | `patches` 13 → 14（新增 `prepare-package-set.ts.patch`） | 已改未提交 |
| `src/patch/pack.ts.patch` | 合并原缓存 hunk + 进程内 `listTarballEntries` | 已改未提交 |
| `src/patch/main.ts.patch` | ~~诊断文案相关改动~~ 已回退到 `0af4544` 版本 | 已改未提交 |
| `src/features/tarball.mjs` / `.d.mts` | 新增：进程内读 tarball | 未跟踪 |
| `src/patch/prepare-package-set.ts.patch` | 新增：manifest/条目改走功能层 | 未跟踪 |
| `docs/session/{task_plan,findings,progress,todo-list}.md` | 会话工作文档（已从仓库根移入该目录） | 未跟踪（是否入库待定） |
| `AGENTS.md` | 另一会话写入 | 未跟踪（本会话未碰） |
| `deepseek-harness/` | 上游 clone + 依赖 + 构建产物 | 被忽略 |

## 错误记录

| 错误 | 尝试 | 处置 |
|---|---|---|
| `pnpm install` `ECONNRESET` | 3 次（标准 / `--reporter` / `--offline`） | **误判为网络硬阻塞**；实为瞬时抖动，第 4 次 EXIT=0 |
| 用恒定 25s 超时当「网络不通」证据 | — | 方法论错误：超时由我自己的 `--max-time 25` 制造，不能作为证据 |
| `taskkill //F //IM node.exe` | 第 1 次 | **严重错误**：杀掉全部 node 进程含 agent |
| `Stop-Process -Name 'DeepSeek Harness'` | 第 2 次 | **同类错误**：换工具不换性质，「按名字匹配」仍是批量终止 |
| 先按名字筛 PID 再 `taskkill //PID` | 第 3 次 | **同类错误**：筛选条件（`grep -i DeepSeek`）本身就是猜的，仍误杀 agent。**结论：任何形式的批量终止一律不做** |
| `find` 未找到 exe | 1 次 | 路径层级猜错；实际在 `unsigned-artifacts/win-unpacked/` |
| 用 mtime 推断「prepare:runtime 占 10 分钟」 | — | 单跑实测仅 8s → 推断被推翻，已作废该结论 |
| 官方 `startup-renderer.spec.ts` 跑不起来 | 1 次 | `tsconfig.base.json` 缺失（上游配置问题，非我引入），属次要 |
| sed 忘加 `-i`，误以为已改文档 | `git diff --stat` 为空暴露 | 重跑带 `-i`，diff 确认 5 处 |
| todo 2.1 循环里列了 14 个 patch 目标（实际 13） | 实测输出 `ok=13` | 修正 todo-list.md 为按配置遍历 |
| 首次「checkout+patch 字节确定性」测试 | 树已是「补丁已应用」态，13 个 patch 全 apply 失败 | 测试无效；改 `git checkout -- .` 恢复干净态后重测 |
| `node scripts/build.mjs --dry-run` | `build.mjs` **没有 dry-run**，真跑起构建又被 `\| head -3` 的 SIGPIPE 掐断 | 上游留在「复制完、未打补丁」中间态；下轮构建自愈 |
| 按字符串 splice 生成 patch | 两次把补丁插坏（`corrupt patch`、锚点差一行） | 改为「`git apply` 原 patch → 改文件 → `git diff` 重新生成」 |
| 两个 patch 改 `pack.ts` 同一区域 | `git apply` 冲突 | 按「同文件一个 patch」合并为单一 patch |
| `prepare-package-set.ts` 的 `tarballFiles` 判断错 | 构建报 `TS6133: declared but never read` | 该 import 改后成孤儿，修 patch 一并删除 |
| 外部 `tar` 耗时测量 | 同一操作测出 178ms ↔ 2463ms，不可复现 | 作废外部 profiler 读数；改用构建代码内插桩（`[PROF] 570436ms`）作为唯一依据 |
