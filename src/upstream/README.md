# 适配层（adapter）

**职责**：隔离官方 `deepseek-harness` 的接口变动，把它的路径、函数签名、数据结构、生命周期固定成稳定 API，
从而让上层的**实现层依赖面保持固定**。

## 修改时机

**只在官方接口变动时修改本层。** 需求变化改实现层，接线位置变化改 patch 层——都不该动这里。

## 注入位置

应用补丁时本目录整体复制到上游的 `.local-desktop/upstream/`，**作为独立一层保留**，
不与 `src/features` 混进同一个目录（摊平会让两层同名文件互相覆盖）。
实现层以 `../upstream/<module>.mjs` 引用本层。

## 边界

- 允许：感知官方文件内容、目录布局、函数签名、数据形态
- 禁止：包含产品行为判断（"要不要回退""提示什么文案"属于实现层）

## 规划模块

| 模块 | 隔离的官方变化 |
|---|---|
| `paths.mjs` | `scripts/desktop-build-paths.mjs`、`src/paths.ts` 的目录布局 |
| `profile.mjs` | profile 清单结构（`package.json` 的 `dsh.profile.bundles`、依赖条目）与初始化时机 |
| `startup.mjs` | 启动页 `renderer/startup.{html,js,css}` 的结构与 `starting`/`ready`/`error` 状态机 |
| `lifecycle.mjs` | 主进程启动序列：`reconcileBackend()` → `backend.start()` → `navigateMain(applicationUrl)` |
| `errors.mjs` | 错误出口的数据形态（`desktopErrorState`、`AggregateError` 嵌套） |
| `store.mjs` | pnpm store 与 metadata 缓存的位置与生命周期（`scripts/prepare-dsh.ts`） |
| `smoke.mjs` | payload smoke 的检查项清单与容忍策略 |

设计说明见 `docs/design.zh.md` 第 2、3 节。
