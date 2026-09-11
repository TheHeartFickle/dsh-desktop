# 探索内容与复刻命令

> 本文是 `docs/` 三份设计文档之一：[当前设计](design.zh.md) ｜ [重大决策与原因](decisions.zh.md) ｜ **探索内容与复刻命令**；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 上游仓库 | `desktop/deepseek-harness`（独立 `.git`，可 checkout 到任意提交） |
| 已验证基线 | commit `c291e7961a…`，版本 `0.1.5-rc.2`（tag `dsh-v0.1.5-rc.2` 指向另一提交 `fb2c4b9e69`，两者差 1379 文件） |
| Node | `C:\Program Files\nodejs\node.exe` v22.19.0（满足 `engines: ^22.19.0 \|\| >=24.0.0`） |
| pnpm | 11.21.0；全局 store `D:\Users\Nuper\.pnpm-store\v11` |
| Electron | 43.4.0（`apps/desktop/node_modules/electron`） |
| 打包需要 | `DSH_DESKTOP_APP_ID`（反向域名）；`--unsigned` 模式下不需要签名证书 |

## 2. 关键踩坑

| # | 现象 | 根因与对策 |
|---|---|---|
| R1 | `pnpm run dev:desktop` 报 `Error [TransformError]: spawn EPERM (esbuild/lib/main.js:2268)` | 构建脚本全经 `tsx`，tsx 依赖 esbuild 启动 helper 子进程（命名管道），受限沙箱拒绝。**对策**：用 `node --experimental-transform-types <script.ts>` 替代；仅受限环境需要 tsx shim（见第 7 节） |
| R2 | 隔离失效、污染真实 `~/.dsh` | dev 启动器用 `process.env.DSH_HOME ?? 隔离目录`，外层已注入 `DSH_HOME` 时会静默走真实 home。**对策**：启动前显式赋值 |
| R3 | 桌面端一启动，agent loop 卡死 | 与运行中的 agent 会话共用 `$DSH_HOME`。**对策**：验证时一律用独立 home |
| R4 | 直接跑 `electron.exe <APP_ROOT>` 显示官方恢复页 | 跳过了 `prepareDevelopmentProject()`——它每次都删除并重建 `.desktop-build/development/project` 并写入运行元数据。**对策**：走完整启动器 |
| R5 | 长任务把 agent loop 卡死 | 巨量 stdout 灌满 subprocess 管道。**对策**：`*> 日志文件` 或后台 + `-RedirectStandardOutput`，只读日志尾部 |
| R6 | 插件树加载失败导致后端起不来、日志刷屏 | 上游 smoke 检查要求已被 `node-addon-system` 取代的 `fs-ext`。**对策**：`0002` 补丁容忍其缺失 |
| R7 | `pnpm config set … --global` 静默不生效 | 它触发无关的 global-bin PATH 检查而中断。**对策**：用 `--location=global` |
| R8 | `pnpm run X -- --unsigned` 参数传错；`pnpm exec tsx …` 报 `invoke this script through a pnpm package command` | pnpm 把 `--` 当字面参数传入；且 `pnpm exec` 不设置 `npm_execpath`，而 `package-target.ts` 的 `runPnpm()` 强制要求它。**对策**：见第 4 节的直接调用方式 |

## 3. 应用与还原（日常入口）

```bash
cd D:/Project/DeepSeek-Harness/desktop
node scripts/apply-local.mjs --check    # 校验
node scripts/apply-local.mjs            # 应用（自动 checkout 基线 + 重定向缓存 + 注入 + 打补丁）
node scripts/restore-local.mjs          # 还原（上游必须恢复为空 git status）
```

## 4. 打包 Windows 产物

```powershell
cd D:\Project\DeepSeek-Harness\desktop\deepseek-harness\apps\desktop
$env:DSH_DESKTOP_APP_ID = 'ai.deepseek.dsh.desktop'   # 验证用占位标识，正式发布前需确认
$env:npm_execpath = 'C:\Users\Nuper\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs'

# 输出重定向到文件（R5）；--dir 出免安装目录，--unsigned 免签名
node --experimental-transform-types scripts/package-target.ts win-x64 --dir --unsigned *> D:\Project\DeepSeek-Harness\desktop\.cache\desktop-build\diagnostics\package.log
```

产物：`desktop/.cache/desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/DeepSeek Harness.exe`

**已完整越过的流水线**：`build:official` → `release:pack dsh` → `pack desktop-host` → `release:pack vendor`
→ `build native-system` → `prepare:runtime` → `prepare:packages`（241 包）→ `prepare:dsh`（smoke 通过）→ `electron-builder --dir`

## 5. 开发态启动（验证隔离时用）

```powershell
cd D:\Project\DeepSeek-Harness\desktop\deepseek-harness\apps\desktop
$env:DSH_HOME = "D:\Project\DeepSeek-Harness\desktop\.cache\dev-home"   # 必须显式隔离（R2/R3）
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
node --experimental-transform-types scripts/dev.ts --skip-build
```

结论：dev 模式**不会**创建 `$DSH_HOME/profiles/desktop`，而是直接用 `.desktop-build/development/project`。

## 6. 验证方式

| 对象 | 方式 |
|---|---|
| 适配层 | 结构断言测试：给官方样例，验证解析/包装结果；官方变更时测试先失败 |
| 实现层 | 纯函数单测（`node:test`），不依赖 Electron 与官方代码 |
| patch 层 | `git apply --check` + 完整构建 + 隔离 `DSH_HOME` 启动冒烟 |
| 整体闭环 | `apply → 构建 → 启动验证 → restore`，结束后上游 `git status` 必须为空 |

## 7. tsx shim（仅受限沙箱环境）

构建脚本全经 `tsx`，而受限沙箱禁止 esbuild 的 helper 子进程（R1）。可把 tsx 换成 Node 原生 TS 转发：

```bash
cd D:/Project/DeepSeek-Harness/desktop/deepseek-harness
printf '#!/bin/sh\nexec node --experimental-transform-types "$@"\n'         > node_modules/.bin/tsx
printf '@echo off\r\nnode --experimental-transform-types %%*\r\n'           > node_modules/.bin/tsx.CMD
printf '#!/usr/bin/env pwsh\n& node --experimental-transform-types @args\n' > node_modules/.bin/tsx.ps1
chmod +x node_modules/.bin/tsx node_modules/.bin/tsx.ps1
pnpm exec tsx --version   # 应输出 v22.19.0（Node 版本），而非 tsx v4.x
```

还原（备份在本仓库内）：

```bash
cd D:/Project/DeepSeek-Harness/desktop/deepseek-harness
cp ../scripts/upstream-patches/tsx-backup/tsx     node_modules/.bin/tsx
cp ../scripts/upstream-patches/tsx-backup/tsx.CMD node_modules/.bin/tsx.CMD
cp ../scripts/upstream-patches/tsx-backup/tsx.ps1 node_modules/.bin/tsx.ps1
```

> 无沙箱限制的机器（家里 / 公司）不需要 shim。
