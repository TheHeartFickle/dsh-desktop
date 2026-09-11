# 上游构建补丁（本地定制，不属于 dsh 上游）

## 为什么存在

`deepseek-harness/`（dsh 上游 monorepo）位于**本仓库内**（`desktop/deepseek-harness/`），内含独立 `.git`，
但**不进入本仓库跟踪**（各机器自行 clone）。构建时通过补丁临时注入定制、构建后还原，
保证上游工作区始终能 `git checkout` 到任意提交。

## 推荐用法：走脚本，不要手工打补丁

```bash
cd D:/Project/DeepSeek-Harness/desktop

node scripts/apply-local.mjs --check   # 只校验：上游是否干净、补丁能否干净应用
node scripts/apply-local.mjs           # 应用（见下方六步）
# ...构建 / 打包...
node scripts/restore-local.mjs         # 还原：丢弃改动 → 切回原 ref → 删注入 → 移除缓存重定向
```

`apply-local.mjs` 依次完成：

1. 校验上游工作区干净（有未提交改动则拒绝）
2. 记录当前 ref，并 `checkout` 到 `manifest.json` 声明的 `baseCommit`
3. 把上游 `apps/desktop/.desktop-build` 重定向为 **junction** → `<repo>/.cache/desktop-build`
4. 按层复制：`src/upstream` → `.local-desktop/upstream/`，`src/features` → `.local-desktop/features/`
5. 先对全部补丁执行 `git apply --check`，通过后再逐个应用
6. 写入 `.state.json` 后执行每个补丁的 `assert` 生效断言

第 4 步按层各占一个子目录是刻意的：摊平进同一目录时，两层同名文件（例如各自的 `README.md`）
会静默互相覆盖，适配层的契约文件可能凭空消失。

## 补丁清单

| 文件 | 目标 | 原因 |
|---|---|---|
| `0001-pnpm-default-store.patch` | `apps/desktop/scripts/prepare-dsh.ts` | 上游把 pnpm store 与 metadata 缓存指向 `mkdtemp` 出来的临时目录，导致**每次重建都重新下载全部 tarball**。补丁**删掉这些覆盖**，让 pnpm 用它自己的默认（读全局 `store-dir`） |
| `0002-skip-removed-fs-ext-smoke.patch` | `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs` | smoke 的 `checkFsExt()` 要求一个已被 `@deepseek-ai/node-addon-system` 取代的 `fs-ext`：没有任何工作区包声明它、`packages/` 下也无引用（只有 `apps/desktop` 的 `allowBuilds` 与产物策略里留有历史条目）。当前 HEAD 打包 Windows 必然在此失败 |
| `tsx-backup/` | `node_modules/.bin/tsx` / `tsx.CMD` / `tsx.ps1` | 仅**受限沙箱环境**需要：沙箱禁止 esbuild 的 helper 子进程（`spawn EPERM`），而 tsx 依赖它 |

> 上游**不接受 issue/PR**，因此这些不匹配由本地补丁长期承担。

## 生效断言

插入类补丁失配时 `git apply` 会报错；**删除类补丁不会**——官方换了写法之后补丁仍能干净应用，
却不再起作用（例如别处又冒出一份 store 覆盖），构建静默回落。因此每个补丁在 `manifest.json`
的 `assert` 里声明：

| 字段 | 含义 |
|---|---|
| `require` | 应用后**必须存在**的片段（补丁插入的标记） |
| `forbid` | 应用后**必须消失**的片段（补丁删除的内容） |

`apply-local.mjs` 在写完 `.state.json` 之后执行断言，断言失败也能用 `restore-local.mjs` 还原。
跟进官方更新后，先看断言是否仍然通过，再看构建。

## 缓存

### 包缓存：用 pnpm 自己的默认，不在本仓库内

`0001` 删掉覆盖后，pnpm 使用它自己的默认 store，位置由**全局配置**决定：

```bash
pnpm store path     # 查看当前生效的 store，例如 D:\Users\Nuper\.pnpm-store\v11
```

**因此全局 store 位置变化时，构建自动跟随——无需预热、无需修改任何命令**（实测：
即使上游传 `--config.userconfig=<空文件>` 做隔离，pnpm 仍能读到用户级 `~/.npmrc` 的 `store-dir`）。

### 构建产物：仍在仓库内，且不被跟踪

`.cache/desktop-build/` 继续承载上游的构建产物与下载：

| 内容 | 位置 |
|---|---|
| 内置 Node 归档 | `.cache/desktop-build/downloads/` |
| 构建产物 | `.cache/desktop-build/targets/` |
| 构建日志 | `.cache/desktop-build/diagnostics/` |

## tsx shim（仅受限沙箱环境需要）

**症状**：`pnpm run dev:desktop` / `package:*` 报
`Error [TransformError]: spawn EPERM at ensureServiceIsRunning (esbuild/lib/main.js:2268:29)`。

**安装**：

```bash
cd D:/Project/DeepSeek-Harness/desktop/deepseek-harness
printf '#!/bin/sh\nexec node --experimental-transform-types "$@"\n'         > node_modules/.bin/tsx
printf '@echo off\r\nnode --experimental-transform-types %%*\r\n'           > node_modules/.bin/tsx.CMD
printf '#!/usr/bin/env pwsh\n& node --experimental-transform-types @args\n' > node_modules/.bin/tsx.ps1
chmod +x node_modules/.bin/tsx node_modules/.bin/tsx.ps1
pnpm exec tsx --version    # 应输出 v22.19.0（Node 版本），而不是 tsx v4.x
```

**还原**：

```bash
cd D:/Project/DeepSeek-Harness/desktop/deepseek-harness
cp ../scripts/upstream-patches/tsx-backup/tsx     node_modules/.bin/tsx
cp ../scripts/upstream-patches/tsx-backup/tsx.CMD node_modules/.bin/tsx.CMD
cp ../scripts/upstream-patches/tsx-backup/tsx.ps1 node_modules/.bin/tsx.ps1
```

> 没有沙箱限制的机器（家里 / 公司）**不需要** shim。

## 打包命令（应用补丁之后）

```powershell
cd D:\Project\DeepSeek-Harness\desktop\deepseek-harness\apps\desktop
$env:DSH_DESKTOP_APP_ID = 'ai.deepseek.dsh.desktop'
$env:npm_execpath = 'C:\Users\Nuper\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs'

# 长任务务必重定向输出（否则巨量 stdout 会阻塞 agent loop）
node --experimental-transform-types scripts/package-target.ts win-x64 --dir --unsigned *> D:\Project\DeepSeek-Harness\desktop\.cache\desktop-build\diagnostics\package.log
```

产物：`desktop/.cache/desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/`

**两个调用坑**：`pnpm run package:win:x64:dir -- --unsigned` 会把 `--` 当字面参数；
`pnpm exec tsx …` 不设置 `npm_execpath`（而 `package-target.ts` 的 `runPnpm()` 强制要求它）。
详见 `docs/reproduce.zh.md` 第 2 节（R8）。
