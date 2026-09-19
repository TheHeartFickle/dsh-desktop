# AGENTS.md

> ⚠️ **本文件也会腐败，它不是最终依据**：与代码、脚本、构建/测试输出、实测冲突时，**以实际表现为准**，并把本文件改对；**不要拿本文件去否定实测结果**。
> 本文件只放 agent 必须遵守的硬约束；细节是二手的，别在这里重述：设计读 [docs/design.zh.md](docs/design.zh.md)，原因读 [docs/decisions.zh.md](docs/decisions.zh.md)，环境、踩坑与验证命令读 [docs/reproduce.zh.md](docs/reproduce.zh.md)。

## 这个仓库是什么

在官方 `deepseek-harness` 桌面端之上叠加本地定制。本仓库**不生产上游代码**，只产出「独立文件 + 接线补丁 + 一份构建配置」。`deepseek-harness/` 是源仓库 clone（独立 `.git`，不进入本仓库跟踪），构建时先 `git reset --hard` + `git clean -fd` 再 checkout 到配置里 tag 解析出的提交 —— **源仓库里的任何改动每次构建都会被丢弃**。唯一硬约束：源仓库任何时候都能解析出 `src/build.config.json` 声明的 tag 并 checkout 过去（**配置存 tag，提交号由构建脚本现算**）。

仓库根的 Markdown 只有 `README.md` 与 `AGENTS.md`。项目文档在 `docs/`（`design.zh.md` 是什么／怎么做、`decisions.zh.md` 为什么、`reproduce.zh.md` 环境与验证、`desktop-guide.zh.md` 上游背景）；**过程记录在 `docs/session/`**（`task_plan.md`、`findings.md`、`progress.md`、`todo-list.md`）。两者性质不同：前者描述项目，后者描述「我们怎么走到这一步」，结论以 `docs/` 四份为准。

## 硬约束

1. **依赖方向不可逆**：`src/patch/ → src/features/ → src/adaptator/ → 官方`。禁止适配层 import 功能层；禁止功能层 import 补丁或另一个功能层（要组合就在 patch 里顺序调）；禁止功能层直接探测官方内部结构（选择器、字段名、内部路径）——需要官方信息，先在适配层加稳定出参。
2. **只有 patch 层改官方代码，且 patch 层不实现功能**：patch 只做**任务调度与导出修改** —— 可以 import、持有接线状态、串接多个调用、按官方状态决定何时调度；但**判断逻辑与文案一律放功能层**（该不该跳过、要不要回退、提示什么，都不在 patch 里）（决策 4/14）。
3. **改哪层由变更类型决定**：官方内部实现变 → 适配层（**适配层对功能层的 API 一经定下即冻结**：名字、入参、出参字段与语义都不动，官方接口/出口/结构/错误串怎么变都在适配层**内部**消化）；需求变 → 功能层；接线位置变 → patch 层。**一次 pin 升级里功能层零改动**；判定某条适配层 API 腐败、需要连同功能层一起改，是**用户的权力**，agent 只能停下上报（决策 37）。跨层改通常说明分层判断错了。
4. **独立文件必须登记**：适配层/功能层新增文件必须同步写进 `src/build.config.json` 的 `copy`，否则运行时解析不到。功能层 `.mjs` 与 `.d.mts` 成对且同步改（上游 `tsc -b` 是 strict）。
5. **配置是唯一接线事实**：上游 tag、复制映射、patch 列表、构建指令与 env 只写在 `src/build.config.json`；`scripts/build.mjs` 里出现上游脚本名、路径、tag、镜像地址即 bug（提交号由脚本从 tag 现算，同样不落配置）（决策 5）。
6. **渲染进程的独立文件是经典脚本**：它们由 shell 从 `dsh-app://app/local/` 自己提供、与 boot gate 一起注入 index，必须早于官方 BootPage 构造就位，所以经 `dshStartupPage` / `dshLoadingArt` 两个全局对象组装，**接线由 patch 在注入处写死**（两个脚本之后再补一行内联语句；该 index 没有 CSP，官方 boot gate 同在 `<head>` 内联注入）；两个独立文件自身禁用 ESM、内联脚本/样式、外部资源（决策 21/38）。
7. **宿主启动前/失败时的功能不能做成 dsh 插件**：插件跑在 Host 进程内，Host 起不来插件就不会加载（决策 6）。

## 不要做

- 不要直接改 `deepseek-harness/` 里的文件；不要在仓库根跑 `pnpm`（store 版本冲突）；不要用 `tsx` 直跑源仓库脚本。
- 不要把长任务输出留在管道里；启动桌面端必须显式隔离 `DSH_HOME`；失败出口跟随官方（原生恢复对话框），本地只往上加诊断文案（决策 9/10/11）。
- 不要给缓存加「跳过哪个阶段」的外部开关，也不要拿 mtime 当判据（决策 12/15）；不要动源仓库的 ref / 远程 / 历史，也不要发明藏文件、改名、junction、产物重定向（决策 2/8）。
- 不要新增依赖（根 `package.json` 无依赖，脚本只用 Node 内置模块）；不要碰 `archive/desktop-legacy/`。
- **不要把过程记录平铺在仓库根**。planning-with-files 之类的 skill 默认把 `task_plan.md` / `findings.md` / `progress.md` 写在「项目根」，本仓库不这么放：写到 `docs/session/`，并沿用既有文件名（那三份加上 `todo-list.md` 已经在那里）。仓库根只允许 `README.md` 与 `AGENTS.md` 两份 Markdown。
- 不要把「设计规范」写成待办：分层规范、编码约定这类东西没有「完成」状态，列成任务会在清单里留下永远做不完的假条目。

## 验证

按改动所在层取**最窄**的证据，命令与判据见 [docs/reproduce.zh.md](docs/reproduce.zh.md) 的[验证方式](docs/reproduce.zh.md#6-验证方式)（功能层 `node --test "src/**/*.test.mjs"`；patch 层 `git apply --check`；接线与整体走构建 + `scripts/smoke-packaged.mjs`）。

**分层规范由门限机械执行**：`npm run check:layers`（构建第 0 步也会跑，红了就构建不了）。它判红的情形包括
功能层里出现官方内部实现、patch 里长出功能逻辑、独立文件漏登记 `copy`、patch 的 target 不存在。规则清单、
豁免机制与盲区见 [docs/design.zh.md](docs/design.zh.md#43-三层腐败门限工程保障)；门限自身有负样本单测
（`scripts/check-layers.test.mjs`，挂在 `npm test` 里）。**门限红了要改设计，不要改门限去迁就现状**。

- 不可验证时（源仓库缺失、受限沙箱无法 spawn 子进程）在回复里写明**未验证**，不要用「看起来对」代替。
- 收尾只报实际跑过的命令与结果。
