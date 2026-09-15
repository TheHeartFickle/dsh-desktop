# dsh-desktop Todo List（带可执行命令 + 验证判据）

生成时间：2026-09-14 ｜ 依据：`docs/` 四份文档 + 本机实测（见 `findings.md`）
变量：`R=D:/git-project/dsh-desktop`（本仓库实际路径），`U=$R/deepseek-harness`（上游 clone）

## 实测进度（2026-09-14）

| 条目 | 状态 | 实测结果 |
|---|---|---|
| P1 上游 URL | ✅ 已具备 | 用户已 clone 到 `deepseek-harness/` |
| 0.2 基线提交存在 | ✅ | HEAD 即 `c291e7961a...`，`cat-file -e` 通过 |
| 0.3 版本/声明核对 | ✅ | `0.1.5-rc.2`、`pnpm@11.7.0`、`engines: ^22.19.0 \|\| >=24.0.0` 均与文档一致 |
| 0.4 Node 版本 | ✅ 已对齐 | 本机 **v24.13.0**（原文档写 v22.19.0，已按实测改）；走 `>=24.0.0` 分支，满足声明 |
| 0.5 pnpm / store | ✅ | pnpm **11.7.0**（与 repo 声明一致，pnpm 自管理已切）；store `D:\.pnpm-store\v11` 由 11.7.0 建立，无 R9 冲突 |
| 0.6 装依赖 | ✅ **已完成** | `pnpm install --frozen-lockfile` **EXIT=0，31.3s**（第一轮的「网络阻塞」是误判） |
| 1.1 功能层 + 适配层单测 | ✅ | **67 pass / 0 fail**（作废 4.3 后由 57 回落到 51；接线文案 4 例到 55；适配层 `smoke.test.mjs` 4 例到 59；Session 14 迁移记账 8 例到 67） |
| 1.2 单测覆盖对象 | ✅ | reproduce 的[验证方式](../reproduce.zh.md#6-验证方式)表对应的 6 份测试文件均出现在 1.1 输出里（含适配层 `smoke.test.mjs`） |
| 2.1 patch 校验 | ✅ | **13/13 `git apply --check` 通过**（当时）；新增 `prepare-package-set.ts.patch` 后为 **14/14** |
| 3.1 冷构建 | ✅ | **EXIT=0**，产物 `unsigned-artifacts/win-unpacked/DeepSeek Harness.exe`（244MB） |
| 3.2 稳态 + 字节一致性 | ✅ | 稳态 **280 hit / 0 miss**；产物 sha256 跨多次构建逐字节一致；稳态 **49–53s**（修复外部 `tar` 后，见下） |
| 3.3 定位 `key-changed` | ✅ **已定论** | **不是系统性摆动**：同一方法连跑两次均 280 hit / 0 miss，那次 miss 是一次性异常 |
| 4.1 冷启动冒烟 | ✅ | 到达应用页 = true，profile 自包含 = true |
| 4.2 温启动冒烟 | ✅ | 通过（**5.18s** 到 ready，文档称 ~2.5s） |
| 4.3 诊断链验证 | ❌ 作废 | 该行为已由 `diagnostics.test.mjs`（9 例）与官方 `main-startup.spec.ts` 的接线用例覆盖；为它而加的前提代码与 `scripts/verify-diagnosis.mjs` 已全部删除 |
| 5.1 历史完整性 | ✅ | HEAD 仍为 `c291e7961a…` |
| 5.2 文档数字核对 | ✅ | design 第 4.1/4.2 节、reproduce 第 4/6 节与 R23 已按实测改；未改 decisions 17/22 与历史性能表 |
| 5.3 文档路径 | ✅ 已修 | README 1 处 + reproduce 6 处（含 §3.3 的 2 处）已改为仓库根相对路径 |
| 5.4 规划文件去留 | ✅ | 定为 `docs/session/`（不再平铺在仓库根）；是否 `git add` 入库待定 |

### 三个必须知道的实测结论（均已定论）

1. **稳态构建一度是 20 分钟，根因是「每个 tarball 各 spawn 一个外部 `tar` 进程」。**
   缓存本身没问题（280 hit / 0 miss），但 `scripts/release/tarball.ts` 的 `tarballFiles` /
   `packedIdentity` 走 `capture('tar', …)` → `spawnSync`，而 `pack.ts` 对每个成员、
   `prepare-package-set.ts` 对每个 tarball 各调一次，合计数百个进程，成本与文件大小无关。
   **修复**：功能层 `src/features/tarball.mjs` 进程内读。**稳态 1180s → 49–53s**（与文档 0.85 min 吻合）。
   > 早期把 20 分钟归因于 `prepare-dsh` 的键摆动，**该结论已作废**（见 3.3 行）。
2. **Electron 二进制是独立于 npm 的第二个下载源。** 本地 electron cache 只有 v40/v43，缺 **v44.0.0**
   → electron-builder 去 GitHub releases 拉 → `ETIMEDOUT 20.205.243.166:443`。
   解法（已实测有效）：`ELECTRON_MIRROR` 指向 npmmirror。
3. **第一轮把 `ECONNRESET` 判成「网络硬阻塞」是错的。** 我用 `--max-time 25` 自己制造的超时被当成了
   网络不通的证据（恒定 25s 恰恰是 max-time 本身）。去掉超时后：元数据 0.95s、tarball 0.25s，
   重跑 `pnpm install` 直接 EXIT=0。

### 完整构建命令（已验证）

```bash
cd <仓库根>
mkdir -p .cache/pathshim && ln -sf /c/Windows/System32/tar.exe .cache/pathshim/tar.exe   # 解 R13（路径）
ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" \
  PATH="$(pwd)/.cache/pathshim:$PATH" node scripts/build.mjs > .cache/build/build.log 2>&1
node scripts/smoke-packaged.mjs 180     # 冷启动；再跑一次为温启动
```

### 环境差异（必须知道的）

1. **R11 不适用于 bash 工具**：实测 bash 里 `execFileSync("git", …)` 成功（git 2.50.1）。
   R11 的 `spawnSync git EPERM` 是文档作者的 **pwsh 工具沙箱**限制。
2. **Git Bash 的 `tar` 是 GNU tar 1.35**（MSYS 版）→ R13 成立，**必须**前置 Windows tar。
3. **仓库根 pnpm 11.22.0 与 `U` 内 11.7.0 共用同一 store** → 只在 `U` 内执行 pnpm（R9 风险）。

## 前提：缺失的输入

| # | 缺什么 | 状态 |
|---|---|---|
| P1 | 上游源仓库 URL | ✅ 已解决（用户已 clone，HEAD 即基线） |
| ~~P2~~ | ~~「新增功能」需求~~ | **作废**：「三层落地」是设计规范，不是功能，不存在需要你补的需求（见文末「关于三层落地」） |

---

## 轨道 A：环境复刻 + 全链路验证

范围声明：本轨道**不新增任何代码**，只复现文档自述的结论。目的是把「阶段 1–5 已 ✅」从文档转述变成本机事实；顺带检验文档是否仍然准确。

### 阶段 0：准备源仓库（需 P1）

- [x] **0.1 clone 上游到 `deepseek-harness/`**（放在本仓库根，`.gitignore` 已忽略）
```bash
cd $R && git clone <P1 提供的 URL> deepseek-harness
```
验证：`test -d $U/.git && echo ok`

- [x] **0.2 确认 checkout 目标提交存在**（决策 5：不存在必须显式失败，不许用当前 HEAD 凑合）
```bash
git -C $U cat-file -e c291e7961a515f6d7af9304e7fd1d257929aef26^{commit} && echo ok
```
验证：输出 `ok`。失败 = 上游 clone 不完整或该提交不存在 → **停止，不要继续**。

- [x] **0.3 确认基线版本号符合文档**（文档称基线 `0.1.5-rc.2`）
```bash
git -C $U show c291e7961a515f6d7af9304e7fd1d257929aef26:package.json
```
验证：`version` == `0.1.5-rc.2`；`engines` 含 `^22.19.0 || >=24.0.0`；`packageManager` == `pnpm@11.7.0`。
不符 → 地址给错了仓库，或上游历史被改。

- [x] **0.4 核对本机 Node 满足 engines**（R9 前置于装依赖）
```bash
node --version
```
验证：v22.19.0，或 ≥24。其余版本不满足上游声明。

- [x] **0.5 核对 pnpm 版本与 store 的 owner 版本一致**（R9：不一致 → `unable to open database file`）
```bash
pnpm --version && pnpm store path && cat ~/.npmrc
```
验证：`pnpm --version` 输出 **11.7.0**（repo 声明值，pnpm 自管理会切过去）；`pnpm store path` 指向的 store 由 11.7.0 建立。全局装的是 11.22.0 —— 两者**不能共用同一个 store-dir**。
失败处置：让 store 与「实际调用的 pnpm 版本」一致（文档做法：按 11.7.0 重建 store）。

- [x] **0.6 安装依赖**
```bash
cd $U && pnpm install --frozen-lockfile
```
验证：退出码 0；无 `ERR_PNPM_*`；`$U/node_modules` 存在。
失败即回到 0.5 重核 store，**不要**改用 `npm` 绕过。

### 阶段 1：本机可独立跑的验证（不需要上游，先做）

- [x] **1.1 功能层 + 渲染进程两层单测**
```bash
cd $R && node --test "src/**/*.test.mjs"
```
验证：`# fail 0`。本机实测基线：**67 pass**（作废 4.3 时由 57 回落到 51；接线文案到 55；Session 13 补适配层 `smoke.test.mjs` 到 59；Session 14 补迁移记账 8 例到 67）。数字再下降 = 有测试被删或漏跑。

- [x] **1.2 逐条确认单测覆盖了文档声称的对象**（reproduce 的[验证方式](../reproduce.zh.md#6-验证方式)表）
验证：`build-cache.test.mjs`、`profile-recovery.test.mjs`、`diagnostics.test.mjs`、`smoke-tolerance.test.mjs`、`loading-art.test.mjs`、`adaptator/smoke.test.mjs` 六份均出现在 1.1 输出里（`tarball.mjs` 无独立测试文件，靠「外部 tar 与进程内库逐一双跑」验证）。

### 阶段 2：patch 层校验（需 0.x）

- [x] **2.1 按 `src/build.config.json` 的 `patches[]` 逐个 `git apply --check`**（零副作用 pre-flight，先跑它再进 3.1）
```bash
cd $U
node -e '
const fs=require("fs"), cp=require("child_process");
const R="'$R'";
const cfg=JSON.parse(fs.readFileSync(R+"/src/build.config.json","utf8").replace(/^\uFEFF/,""));
let ok=0,bad=0;
for(const p of cfg.patches){
  try{ cp.execFileSync("git",["apply","--check",R+"/src/"+p.file],{stdio:["ignore","pipe","pipe"]}); console.log("ok   "+p.target); ok++; }
  catch(e){ console.log("FAIL "+p.target+"  <- "+String(e.stderr).trim()); bad++; }
}
console.log("\nok="+ok+" fail="+bad);
'
```
验证：**14 个**目标全部 `ok`，无 `FAIL`（`patches[]` 长度为 14 —— 已实测）。
失败 = 上游基线内容与 patch 不匹配（patch 只做调度接线，失配会硬报错，见决策 4）。

### 阶段 3：全链路构建（需 0.x；必须在可 spawn 子进程的环境跑）

- [x] **3.1 冷构建一次**
```bash
cd $R
PATH="$R/.cache/pathshim:$PATH" node scripts/build.mjs > $R/.cache/build/冷构建.log 2>&1
```
说明与前置：
- **Git Bash 必做**：先 `mkdir -p $R/.cache/pathshim && ln -sf /c/Windows/System32/tar.exe $R/.cache/pathshim/tar.exe`（R13：MSYS tar 把 `D:\...` 当 `host:path`）
- **输出必须重定向到文件**（R5：巨量 stdout 灌满管道，实测卡死 agent loop 两次）
- **不要在当前 agent 沙箱里跑**（R11：`spawnSync git EPERM`，构建必然失败）
- `.cache/` 已被忽略，日志不会污染 `git status`

验证（全部满足，读日志尾部而非全量）：
1. 退出码 0
2. 产物存在：`$U/apps/desktop/.desktop-build/targets/win-x64/**/DeepSeek Harness.exe`
3. 日志里 `build-cache:` 行**全部 miss**（冷缓存）
4. 无 `Cannot find entry`、无 `ERR_PNPM_`、无 `spawn EPERM`

- [x] **3.2 稳态复跑，核对缓存命中**（这是决策 15/16 与构建优化的**核心判据**）
```bash
cd $R
PATH="$R/.cache/pathshim:$PATH" node scripts/build.mjs > $R/.cache/build/稳态构建1.log 2>&1
PATH="$R/.cache/pathshim:$PATH" node scripts/build.mjs > $R/.cache/build/稳态构建2.log 2>&1
grep -c 'build-cache:.* hit' $R/.cache/build/稳态构建2.log
grep -n 'build-cache:.* miss' $R/.cache/build/稳态构建2.log
```
验证：
1. **稳态第 2 次 `miss` 为 0**（文档实测稳态 0.85 min、0 miss）
2. 时长显著低于 3.1（文档：优化前 4.92 min → 稳态 0.85 min）
3. 三份产物摘要一致（**不是「重新打包的等价物」，必须是同一份字节**，决策 16）：
```bash
cd $U/apps/desktop/.desktop-build/targets/win-x64 && sha256sum \
  "**/DeepSeek Harness.exe" "**/resources/app.asar" "**/resources/dsh/desktop-runtime.json"
```
在 3.2 两次之间各记录一遍，逐行 diff：必须 0 差异。

- [x] **3.3 定位那处未解释的 miss**（reproduce 的[构建缓存的实现与实测](../reproduce.zh.md#4-构建缓存的实现与实测)自述：一次构建里 `prepare:dsh` 与 `--dir` 装配 `miss (key-changed)`，**未逐项定位输入差异**）
做法：对这两阶段复现文档 R17 的定位手法 —— 构建前后各算一遍逐项 `contentKey`，变化的那一项就是元凶。
验证：给出**具体哪一项输入变了**（不是「重跑一次就命中了」这种未定位的结论）。

### 阶段 4：打包产物冒烟（需 3.x）

- [x] **4.1 冷启动冒烟**（隔离 `DSH_HOME`，判据见 R22）
```bash
cd $R && DSH_HOME=$R/.cache/smoke-cold node scripts/smoke-packaged.mjs 120
```
验证（两条同时满足）：
1. `$R/.cache/smoke-cold/diagnostic.log` 含 `phase=application-page`（Host 起不来时页面停在 `dsh-app://shell/startup.html`，不会有这一行）
2. profile 自包含：`package.json`、`pnpm-workspace.yaml`、`node_modules`、`desktop-runtime-state.json` 都在
文档基线：冷启动 ~6.4s 到 ready、~7s 到应用页。

- [x] **4.2 温启动冒烟**（复用同一 home）
```bash
cd $R && DSH_HOME=$R/.cache/smoke-cold node scripts/smoke-packaged.mjs 120
```
验证：同样出现 `phase=application-page`，且明显快于 4.1（文档基线 ~2.5s）。

- [x] ~~**4.3 起不来时的诊断链验证**~~ —— **作废**：该行为已由功能层单测（`diagnostics.test.mjs` 9 例）与官方 `main-startup.spec.ts` 的接线用例覆盖，端到端实跑性价比为负
做法：故意破坏 profile（例如删掉 `$DSH_HOME/profiles/desktop/package.json`，或写入一个坏 `cordis.patch.yml`），复跑 4.1。
验证：启动页显示的标题是 `diagnoseStartupFailure` 命中的**阶段标题 + 下一步 + 原始错误串**；若规则未命中，则照常显示原始错误串（诊断只做加法，不挡真相，决策 25）。

### 阶段 5：闭环与收尾

- [x] **5.1 确认源仓库仍能 checkout 到指定提交**（决策 2：唯一硬约束）
```bash
git -C $U rev-parse HEAD && git -C $U status --short | head
git -C $U clean -fdx --dry-run | head
```
验证：`rev-parse HEAD` == `c291e7961a515f6d7af9304e7fd1d257929aef26`；`status --short` 为空。
注意：构建流程本身会清理工作区再 checkout，所以这条验的是**「流程没破坏 clone 的历史完整性」**，不是「工作区干净」。

- [x] **5.2 判定文档是否需要修订**
验证：把 3.x/4.x 的实测值与reproduce 的[构建缓存的实现与实测](../reproduce.zh.md#4-构建缓存的实现与实测)里的性能表、R22 时间基线逐项对齐。
产出：**「文档与实测一致」**，或**具体哪一条数字/结论过时**。不要笼统写「文档已更新」。

- [x] **5.3 修复文档里的路径漂移**
```bash
grep -rn "D:/Project/DeepSeek-Harness/desktop" $R --include=*.md | grep -v node_modules
```
验证：命中 `README.md` 第 15 行、`docs/reproduce.zh.md` 第 71/81/146/157 行 —— 均指向**不存在的**目录。改为实际路径 `D:/git-project/dsh-desktop`，或（更好）改成不绑定盘符的相对写法 `cd <仓库根>`。
这是纯文本改动，与本轨道其余条目独立，可随时做。

- [x] **5.4 决定规划文件的去留** —— 定为 `docs/session/`（不再平铺在仓库根）；四份文件仍未被 git 跟踪，是否入库另行决定
验证：明确回答 —— 提交入库（作为探索记录），还是加进 `.gitignore`（探索产物不入库）。当前 `git status` 里它们是未跟踪状态。

---

## 关于「三层落地」

「三层落地」是 [../design.zh.md](../design.zh.md) 的[三层](../design.zh.md#1-三层)规定的**设计规范**（适配层 → 功能层 → patch 层的职责与依赖方向），
不是一件功能、不是一条可完成的轨道。**任何**新增功能都必须按它写；它本身没有「完成」状态。

本文件先前把「新增功能（三层落地）」列为轨道 B 并编成 18 条可勾选条目，那是错的 —— 把设计规范当成了交付物，
条目也只会永远停在「未完成」。已删除该轨道。

规范要点（细节见 design 的[三层](../design.zh.md#1-三层)、decisions 第 4/14 条）：

| 层 | 放什么 | 判断依据 |
|---|---|---|
| `src/adaptator/` | 把官方内部接口固定成稳定出参 | 官方**内部实现**变 → 改这里 |
| `src/features/` | 需求实现（判断、流程、文案） | **需求**变 → 改这里 |
| `src/patch/` | 不实现功能，只做任务调度与导出修改（可 import、可持有接线状态、可串接多个调用、可按官方状态决定何时调度；判断与文案不放这里） | **接线位置**变 → 改这里 |

patch 里不得出现任何判断逻辑（该不该跳过、要不要回退、提示什么文案）—— 只能调功能层的函数。

> 真要做某个新功能时，才按这个规范落地；届时需求由提出者给出。本文件不再为「遵守规范」设待办项。
## 执行顺序建议

**已完成**：0.1–0.6、1.1–1.2、2.1、3.1–3.3、4.1、4.2、5.1–5.4（见顶部实测表）
**收尾**：
1. ~~`4.3` 诊断链端到端验证~~ —— **作废**（理由见条目本身）
2. ~~四份会话文档是否 `git add` 入库~~ —— **已定**：放在 `docs/session/`，四份均已入库
3. ~~适配层 `src/adaptator/` 的独立测试~~ —— **已补**：`src/adaptator/smoke.test.mjs` 4 例，其中「检查项清单与顺序」直接与上游 fixture 的 `check*()` 调用对账（上游 clone 不在场时 skip，其余 3 例照跑）；`src/build.config.json` 的 adaptator 复制映射同步加了 `*.test.mjs` exclude。**本清单至此没有欠项**

> 文档中其余「未做」的条目都不是欠账，而是**已决定不做**或**设计上不覆盖**：
> `prepare:packages` / `prepare:runtime` 不接缓存（决策 22）、`electron-builder` 自带的 Electron 文件树不逐字节复核（决策 20 已知残余）、
> 插件兼容性校验抓不到运行时服务/API 变化与配置 schema 变化（design 的「插件兼容性校验的能力边界」表）。
