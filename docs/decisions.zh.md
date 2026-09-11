# 重大决策与原因

> 本文是 `docs/` 三份设计文档之一：[当前设计](design.zh.md) ｜ **重大决策与原因** ｜ [探索内容与复刻命令](reproduce.zh.md)；
> 上游背景见 [desktop-guide.zh.md](desktop-guide.zh.md)。

| # | 决策 | 原因 |
|---|---|---|
| 1 | **放弃自研壳，改用官方 `apps/desktop`** | 自研壳跟随用户全局 Node/dsh → 环境漂移 → 插件兼容故障反复出现（实例：`DSH-better-sidebar` 依赖 `@deepseek-ai/dsh-settings` 里已被移除的 `settingsNamespace` 导出，其构建产物 `lib/index.js` 仍带这条 import，后端起不来。复核方式：在插件源码里 `grep -rn settingsNamespace`，再对照 `packages/settings/settings` 的导出）。官方用内置固定版本 dsh 从根上消除该问题 |
| 2 | **上游源码不进入本仓库跟踪** | 它内含独立 `.git`，各机器自行 clone；本仓库只同步"我们的定制"。若误 `git add` 会提交成 gitlink 空引用（`.gitignore` 里的 `deepseek-harness` 已挡住） |
| 3 | **三层架构（适配 / 实现 / patch）** | 官方高速迭代。分层后：官方**接口**变 → 只改适配层；**需求**变 → 只改实现层；官方**源码接线**变 → 只改 patch 层。实现层在需求不变时可长期零改动 |
| 4 | **补丁"纯增量插入"** | 不删减官方源码，补丁只做接线。失败形态因此收敛为"插入点找不到了"，而不是"官方逻辑被覆盖"，跟版成本低 |
| 5 | **补丁携带 `baseCommit` 元数据** | 应用前把工作区 `checkout` 到该提交，补丁必然干净落地；避免"在漂移的 HEAD 上打补丁" |
| 6 | **阶段 4/5 用补丁，不做 dsh 插件** | 插件加载时机不对：备份/回退必须发生在 Host **启动之前**、并在 Host **启动失败时**执行，而 dsh 插件跑在 Host 进程内——Host 起不来插件就不会加载，构成循环依赖 |
| 7 | **删掉"仓库内专属 pnpm store"** | 它会导致需要一条硬编码全局路径的"预热命令"，全局 store 一变就得手改。改为**删掉上游的 store 覆盖**，让 pnpm 用默认（读全局 `store-dir`）→ 真正无感 |
| 8 | **构建缓存经 junction 重定向到 `.cache/`** | 缓存集中、不被 git 跟踪、且**不随 dsh 源码被重新 clone 或移动而丢失**（早期缓存正是随 `.desktop-build` 一起丢掉的） |
| 9 | **失败时不弹 Windows 原生框** | 上游在基线 `c291e7961a` 上已刻意避免原生弹窗：`apps/desktop` 里没有 `dialog.showErrorBox` 调用、没有 electron-log 依赖，测试反而断言 `showErrorBox` 不被调用，错误出口是启动页 + `desktopErrorState`。本地定制沿用同一策略——诊断一律在窗口内展示 |
| 10 | **长任务输出必须重定向到文件** | 巨量 stdout 会灌满 agent 的 subprocess 管道并阻塞 loop（**实测卡死两次**） |
| 11 | **启动桌面端必须显式隔离 `DSH_HOME`** | 官方设计上桌面端与 CLI 共享 `$DSH_HOME`；共用真实 home 会与运行中的 agent 会话互相阻塞（**实测**）。且外层若已注入 `DSH_HOME`，dev 启动器的隔离默认值会被静默覆盖 |
| 12 | **包缓存放在 D 盘而非 E 盘** | 两块盘是不同物理 SSD（C/D 为 KIOXIA，E 为 ZHITAI），跨盘会失去硬链接、退化为复制。目标是"D 盘根目录看不到 store"，因此选同盘的 `D:\Users\Nuper\.pnpm-store`，两个目标同时满足 |
