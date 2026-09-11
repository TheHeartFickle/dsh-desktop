# DeepSeek Harness Desktop

在官方 dsh 桌面端（上游 `apps/desktop`）之上叠加本地定制的仓库。

- 上游源码**不进入本仓库跟踪**：`deepseek-harness/` 内含独立 `.git`，各机器自行 clone
- 定制以**分层源码 + 补丁**临时注入，构建后还原，上游工作区始终能 `git checkout` 到任意提交
- 上游不接受 issue/PR，不合适之处由本地补丁长期承担

## 快速开始

```bash
cd D:/Project/DeepSeek-Harness/desktop
# 前置：deepseek-harness/ 下已有 dsh 上游 clone（独立 .git，本仓库不跟踪）

npm run check      # 只校验：上游是否干净、补丁能否干净应用
npm run apply      # 应用：checkout 基线 → 重定向缓存 → 注入分层源码 → 打补丁 → 生效断言
# ...构建 / 打包（命令见 docs/reproduce.zh.md 第 4 节）...
npm run restore    # 还原；结束后上游 git status 必须为空
```

## 目录结构

```text
deepseek-harness/          dsh 上游源码（内含独立 .git，不跟踪）
.cache/desktop-build/      构建产物与 Node 归档（junction 落在仓库内，不跟踪）
src/upstream/              适配层：隔离官方接口变动
src/features/              实现层：阶段 4/5 功能，只依赖适配层
scripts/apply-local.mjs    应用定制
scripts/restore-local.mjs  还原上游
scripts/upstream-patches/  patch 层：manifest.json + *.patch + 操作手册
archive/desktop-legacy/    已归档的早期自研壳（保留历史）
assets/                    加载动画等静态资源
docs/                      设计与决策文档
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.zh.md](docs/design.zh.md) | 当前设计：三层架构、工作流、缓存策略、阶段 4/5 要点 |
| [docs/decisions.zh.md](docs/decisions.zh.md) | 重大决策与原因 |
| [docs/reproduce.zh.md](docs/reproduce.zh.md) | 环境事实、关键踩坑、复刻命令 |
| [docs/desktop-guide.zh.md](docs/desktop-guide.zh.md) | 官方桌面端探索记录（上游背景） |
| [scripts/upstream-patches/README.md](scripts/upstream-patches/README.md) | 补丁清单、生效断言、缓存策略、tsx shim |
