# 实现层（features）

**职责**：阶段 4/5 的功能实现，以函数形式封装，纯逻辑优先、尽量可单测。

## 修改时机

**只在需求变化时修改本层。** 官方接口变动由适配层吸收，接线位置变动由 patch 层适配——本层都不该受影响。
这是三层架构的核心价值：官方快速迭代时，业务实现保持稳定。

## 边界

- 只依赖 `src/upstream/` 暴露的稳定 API
- **不直接接触官方文件**（不 import 官方源码、不读写官方路径）
- 不依赖 Electron 运行时（便于用 `node:test` 单测）

## 注入位置与导入约定

应用补丁时本目录整体复制到上游的 `.local-desktop/features/`。引用适配层统一写成
`../upstream/<module>.mjs`（同一注入根下的兄弟目录）；不要写仓库内的 `src/upstream` 路径，
那份源码在构建期并不存在于上游工作区。

## 规划模块

| 模块 | 对应需求 | 主要导出 |
|---|---|---|
| `loading-animation.mjs` | 双击即出窗口，加载动画等待后端 | `renderLoadingAnimation(host)` |
| `copy-web-config.mjs` | 首次启动询问是否复制 web 配置 | `detectWebPlugins()`, `verifyCompatibility()`, `buildCopyPlan()` |
| `config-snapshot.mjs` | 启动成功快照、失败回退（5 个配置文件） | `snapshot()`, `commit()`, `rollback()` |
| `rollback-notice.mjs` | 进入 UI 后提示"已回退" | `buildNotice()`, `injectNotice()` |
| `diagnose/` | 诊断规则模块（按阶段分组、互不可见） | `diagnose(stage, evidence)` |

设计说明见 `docs/design.zh.md` 第 2、3 节。
