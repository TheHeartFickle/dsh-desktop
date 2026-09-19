# DeepSeek Harness Desktop

在官方 dsh 桌面端（上游 `apps/desktop`）之上叠加本地定制。

定制 = **独立文件**（适配层 + 功能层）+ **git patch 接线**（只做任务调度，不实现功能）。本仓库的构建脚本按 `src/build.config.json`
把文件复制到指定位置、打上 patch，再进入源仓库执行它自己的构建指令。

- 源仓库**不进入本仓库跟踪**：`deepseek-harness/` 内含独立 `.git`，各机器各有一份；缺了由 `build.mjs` 按配置自动取回
- 源仓库必须始终能解析出配置声明的 `tag` 并 `checkout` 过去（配置里存 tag，提交号由 `build.mjs` 现算）—— 这是唯一硬约束；工作区状态不被保护（见 [docs/decisions.zh.md](docs/decisions.zh.md) 第 2/5 条）
- 配置文件、构建脚本、功能代码对这套流程**完全透明**，不为任何一类文件开特例

## 构建

```bash
cd <仓库根>
node scripts/build.mjs   # 读配置 → 解析 tag → 清理并 checkout → 复制 → 打 patch → 执行构建指令 → 产物复制进 release/
```

产物写在源仓库的构建目录里（`apps/desktop/.desktop-build/targets/<target>/…`），构建成功后由 `build.mjs` 按配置
的 `build[].artifacts{from,to}` **复制**进本仓库的 `release/<target>/`（当前是 `release/win-x64/win-unpacked/`，
`release/` 不进版本控制）——源仓库里保留原件（缓存阶段下一轮照常命中），本仓库这边才有稳定位置。

源仓库与它的依赖都不随本仓库同步：`build.mjs` 发现 `deepseek-harness/` 缺失时按 `src/build.config.json` 的
`upstreamUrl` 自动 clone，发现依赖缺失时自动 `pnpm install --frozen-lockfile`，发现官方打包本地设置
（`apps/desktop/.env.windows`）缺失时按官方模板生成并把 `DSH_DESKTOP_APP_ID` 写成配置的 `appId`（已有则不动，
要真签名就在那个文件里填凭据——它被官方 gitignore）。环境相关的坑（Git Bash 里的 `tar`、
Electron 二进制镜像、`DSH_HOME` 必须隔离）见 [docs/reproduce.zh.md](docs/reproduce.zh.md)。
只要把定制落到源仓库、暂不构建，用 `npm run apply`（前五步，到此为止）。

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
