# DeepSeek Harness Desktop

在官方 dsh 桌面端（上游 `apps/desktop`）之上叠加本地定制。

定制 = **独立文件**（适配层 + 功能层）+ **git patch 接线**（只做任务调度，不实现功能）。本仓库的构建脚本按 `src/build.config.json`
把文件复制到指定位置、打上 patch，再进入源仓库执行它自己的构建指令。

- 源仓库**不进入本仓库跟踪**：`deepseek-harness/` 内含独立 `.git`，各机器自行 clone
- 源仓库必须始终能 `checkout` 到配置指定的提交 —— 这是唯一硬约束；工作区状态不被保护（见 [docs/decisions.zh.md](docs/decisions.zh.md) 第 2 条）
- 配置文件、构建脚本、功能代码对这套流程**完全透明**，不为任何一类文件开特例

## 构建

```bash
cd <仓库根>
# 前置：deepseek-harness/ 下已有源仓库 clone，且依赖已安装（pnpm install --frozen-lockfile）

node scripts/build.mjs   # 读配置 → 校验提交 → 清理并 checkout → 复制 → 打 patch → 执行构建指令
```

## 目录结构

```text
deepseek-harness/           源仓库 clone（内含独立 .git，不跟踪）
src/build.config.json       构建配置：checkout 提交、复制映射、patch 列表、构建指令
src/adaptator/              适配层：把官方内部接口固定成稳定接口（renderer/ 为渲染进程部分）
src/features/               功能层：功能实现（独立文件；renderer/ 为渲染进程部分）
src/patch/                  patch 层：每个目标源文件一个 patch
scripts/build.mjs           构建入口
scripts/smoke-packaged.mjs  打包产物启动冒烟（隔离 DSH_HOME + 诊断文件判据）
scripts/verify-diagnosis.mjs 诊断链验证（破坏 profile 后核对启动页文案；不终止进程）
scripts/make-icons.py       资产生成（与构建流程无关）
assets/                     静态资源
archive/desktop-legacy/     已归档的早期自研壳
docs/                       设计与决策文档
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.zh.md](docs/design.zh.md) | 当前设计（是什么、怎么做）：三层职责、构建流程、当前状态、功能设计 |
| [docs/decisions.zh.md](docs/decisions.zh.md) | 重大决策与原因（为什么） |
| [docs/reproduce.zh.md](docs/reproduce.zh.md) | 环境事实、踩坑与常用手段、构建缓存的实现与实测、复刻与验证命令 |
| [docs/desktop-guide.zh.md](docs/desktop-guide.zh.md) | 官方桌面端探索记录（上游背景） |

> 另有探索过程的会话记录，放在 [docs/session/](docs/session/)：
> [task_plan.md](docs/session/task_plan.md)（任务计划）、[findings.md](docs/session/findings.md)（发现集）、
> [progress.md](docs/session/progress.md)（会话日志）、[todo-list.md](docs/session/todo-list.md)（待办与实测进度）。
> 它们是过程记录，**不是项目文档**；结论以 `docs/` 四份为准。
