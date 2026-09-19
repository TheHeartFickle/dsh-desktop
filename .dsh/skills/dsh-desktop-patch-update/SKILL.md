---
name: dsh-desktop-patch-update
description: 把 dsh-desktop 的本地定制移植到新的上游 deepseek-harness 提交——换 build.config.json 的 tag（提交号由构建脚本现算）、重做失配的 patch，官方接口真的被改/删时只在适配层内部消化（**功能层零改动**；确需动它就停下上报用户）。当用户说「更新到某 tag/提交」「patch 打不上了」「上游升级后定制失效/失配」「换 pin」「git apply 失败」，或要新增/修改一处接线补丁时，必须使用本 skill。
whenToUse: 也适用于：判断一处变更该落在适配层 / 功能层 / patch 层哪一层；排查某个定制在上游升级后是否还有载体；判断某次上游升级是否属于破坏性变更。
---

# 把定制移植到新的上游提交

`dsh-desktop` 在官方 `deepseek-harness` 桌面端之上叠加本地定制。**这个仓库不生产上游代码**，只产出
「独立文件 + 接线补丁 + 一份构建配置」。

**改动范围按需展开，不要默认三层全动**：

| 上游这次动了什么 | 该动哪里 |
|---|---|
| 只是代码搬了位置 / 上下文漂了（**绝大多数升级属于这类**） | `src/patch/`（重新生成）+ `src/build.config.json`（换 `tag`）。**适配层与功能层零改动** |
| 改掉了定制所接的官方**接口/出口/结构/错误串** | 适配层**内部**吸收（出参的名字、入参、字段、语义一个字不动）；patch 跟着官方那段代码重新生成。**功能层零改动** |
| 定制的**需求**变了，或**用户判定**某条适配层 API 已腐败并批准 | 才动功能层（并同步它的 `.d.mts` 与单测） |

先读这四份，它们是本仓库的结论来源（本 skill 只讲怎么干活，不重复它们的结论）：

- `docs/design.zh.md` — 当前是什么、怎么做
- `docs/decisions.zh.md` — 为什么这么选
- `docs/reproduce.zh.md` — 环境事实、踩坑、验证命令
- `AGENTS.md` — 硬约束，**与实测冲突时以实测为准，并把 AGENTS.md 改对**

## 1. 形状：三层 + 一份配置

```
src/patch/  ──调度已封装能力──▶  src/features/  ──调用──▶  src/adaptator/  ──固定接口──▶  官方
```

| 层 | 目录 | 形态 | 上游变动时怎么办 |
|---|---|---|---|
| 适配层 | `src/adaptator/` | 独立文件（`.mjs` + `.d.mts`） | **官方接口/出口/结构/错误串变** → 只改这里。出参**一经定下即冻结**（先按功能层的需要设计好），只在适配层内部改映射实现 |
| 功能层 | `src/features/` | 独立文件（`.mjs` + `.d.mts`） | **需求变** → 只改这里。**上游升级时功能层的改动数必须为 0**；要动它只有一种情况：**用户判定**某条适配层 API 已腐败并批准（见 Step 4） |
| patch 层 | `src/patch/<name>.<ext>.patch` | git patch | **接线位置变** → 重新生成；只做任务调度与导出修改，**不实现功能**（判断、文案、回退怎么做都在功能层） |

**适配层的验收标准就是「功能层零改动」。** 适配层不是转发层，它存在的唯一理由是把官方的内部形状收敛成
功能层要的那个概念：官方换了字段名、选择器、错误文案、数据结构形态，都在这里被吸收，功能层看到的东西
一个字不变。所以「又要改功能层」不是一次正常升级的一部分，而是**适配层没吸干净的信号**（Step 4 有排查顺序）。

### 1.1 设计适配层 API：先定出参，再写映射

顺序不能反——**先写清功能层要的概念，再去找官方现在用什么表达它**：

1. 写下功能层要做的判断 / 要展示的东西（「这次失败属于哪个阶段」「还在加载还是已经结束」「清单里有哪些插件」）。
2. 据此定出参的名字、字段与语义。官方用几种方式表达同一件事，就在这里合并成一种；能收敛成一个枚举或
   布尔，就不要把官方的多个取值原样透出去。
3. 再写映射实现，把官方当前的字段名 / 选择器 / 错误串 / 结构翻译成这个出参。
4. 出参写进 `.d.mts`。它是**契约**，不是实现的副产品——**一经定下即冻结**：官方下次重写内部实现时，
   改的是第 3 步，第 2 步一个字不动。**改它需要用户判定，不是你能自己决定的事**（Step 4）。

**判据不是「出参像不像官方」，而是「官方改了内部实现，功能层要不要动」。**

- **会变的、不许透出去**：官方错误文案、内部路径、选择器、枚举取值、官方字段名。官方换个串功能层就得改，
  那是把内部实现漏上去了。门限的 A3/A4 盯的就是这一类。
- **语义稳定的、可以照抄**：官方的设计可能本来就是最佳实践。如果功能层要的概念恰好就是官方那个最小结构，
  **照抄这个形状比另造一个同构的孪生结构更好**——少一个概念、少一层翻译。例：功能层的 `startupErrorState`
  与官方 `desktopErrorState` 同形（「失败阶段 + 要显示的文本」），而官方那个实现由 patch 经 `fallback` 注入，
  功能层不 import 官方。借官方形状没有错，错的是借了**会变**的东西。
- 借的时候在该模块的注释或 `decisions.zh.md` 里写一句「它为什么稳定」，否则下一个人看不出这是判断还是偷懒。

正例：`src/adaptator/diagnostics-signals.mjs` 只交出「阶段 + 规则 id」两个功能层自己的概念，官方那十几条
错误文案一条都不出去——因为文案会变。**反面例子不是「形状像官方」，而是「功能层拿到了官方错误文案，自己
去做字符串匹配」。**

`src/build.config.json` 是**唯一接线事实**：`tag`（上游 tag，构建时解析成提交）、`appId`（打包用的反向域名）、
`releaseEnv`（官方打包本地设置文件与它的模板，缺则生成）、`copy`（独立文件落到上游哪）、`patches`
（补丁清单与目标）、`build`（构建指令与环境）。构建脚本 `scripts/build.mjs` 里出现上游脚本名、路径、
tag/提交号、镜像地址就是 bug。**上游目录名也别写死**：它由配置的 `upstream` 字段声明，下面的命令都从配置里读。

路径基准：`copy[].from` 与 `patches[].file` 相对 `src/`；`copy[].to`、`patches[].target`、`build[].cwd`
相对上游仓库根。patch 里 import 功能层用 `../local/features/<name>.mjs`（`src/features/` 会被复制到
`apps/desktop/local/features/`）；上游 `scripts/` 下的目标文件要写 `../apps/desktop/local/features/...`。

这套分层由门限机械执行：`npm run check:layers`（**构建第 0 步也会跑**）。功能层里出现官方内部实现、
patch 里长出功能逻辑、独立文件漏登记 `copy`、patch 的 target 不存在，都会被判红。规则表、豁免机制与盲区见
`docs/design.zh.md` §4.3；门限自己有负样本单测。**门限红了改设计，不要改门限去迁就现状。**

## 2. 流程

### Step 0 — 盘点环境事实（不要跳过）

**路径一律现算，不要写死**：这个仓库会在多处开发、也会被 clone 到别的机器与目录。下面两句以「当前
所在的仓库根」和「配置声明的上游目录」为准，换机器、换目录都不用改；从仓库任意子目录里跑也对。

```powershell
# 仓库根（下面记作 $R）：从当前目录往上找 src/build.config.json，找不到就报错
$R = (Get-Location).Path
while (-not (Test-Path (Join-Path $R 'src/build.config.json'))) {
  $parent = Split-Path -Parent $R
  if ($parent -eq $R -or $parent -eq '') { throw '不在 dsh-desktop 仓库里（往上找不到 src/build.config.json）' }
  $R = $parent
}
$config = Get-Content (Join-Path $R 'src/build.config.json') -Raw | ConvertFrom-Json
$U = Join-Path $R $config.upstream      # 上游 clone 目录名由配置声明，不写死

git -C $U --no-pager log --oneline -1
git -C $U --no-pager status --short     # 必须干净；不干净先搞清是谁留下的
$config.tag                             # 版本事实就是这一个 tag，提交号由构建脚本现算
```

> 若某条 git 命令报 `detected dubious ownership in repository`（clone 的属主与当前用户不一致），
> **这是本机环境问题，不是流程的一部分**，按需加一次性的
> `-c safe.directory=<该仓库绝对路径>`（推荐，不动全局配置），或
> `git config --global --add safe.directory <路径>` 写进全局配置。
> **不要用 `-c safe.directory='*'`** —— 那会把这项安全检查在整个调用里关掉。

**沙箱能力先探明**（决定后面能验证到哪一步）：`node <file>` 能跑；`node --test <glob>` 与 `vitest`
会 spawn 子进程、在本机受限沙箱里必然 `EPERM`；`git` 可用，但 **受限沙箱里 PowerShell 的原生命令重定向与
管道是坏的**（`git … > f`、`git … 2>&1`、`git … | Select-String` 都会报 `拒绝访问` /
`StandardOutputEncoding…`，连 `2>$null` 都不行）。绕法：让 git 自己写文件（`--output=<path>`）、
或 `cmd /c "… > file 2>&1"`。

### Step 1 — 换 tag（配置里存的就是 tag，不存提交号）

**提交号不是配置的一部分**：`src/build.config.json` 的 `tag` 是唯一的版本事实，构建脚本每次现算它指向哪个提交
（`git rev-parse --verify '<tag>^{commit}'`）再 checkout。所以「升级」就是把这一个字段换成目标 tag；顺手在配置里
写死提交号等于绕过 tag——下次没人知道它从哪来，tag 被重指也看不出。

```powershell
git -C $U --no-pager tag -l 'dsh-v*'                # 上游 tag 形如 dsh-v0.1.6-alpha.2
git -C $U rev-parse ("$($config.tag)^{commit}")     # 配置里这个 tag 解析到哪个提交
git -C $U describe --tags HEAD                      # 当前工作区落在哪（确认上一轮的位置）
```

上游 clone 若没有目标 tag，先把它取回来（`git -C $U fetch --tags`）——**构建脚本不会替你 fetch**，配置的
tag 解析不到时它直接报错退出（不会退回当前 HEAD）。**不要动上游的 ref / 远程 / 历史。**

### Step 2 — 先拿失配清单，再动手

```powershell
$config = Get-Content (Join-Path $R 'src/build.config.json') -Raw | ConvertFrom-Json
foreach ($entry in $config.patches) {
  & git -C $U apply --check (Join-Path $R 'src' $entry.file)
  "{0,-42} exit={1}" -f $entry.file, $LASTEXITCODE
}
```

`exit=0` 只说明**上下文还对得上**，不说明语义还对——上游可以把同一段代码搬到别的函数里、
用 `--verbose` 看它落在哪（`git apply --check --verbose` 会打印每个 hunk 的偏移与落点）。

### Step 3 — 逐个 patch 判定「载体还在吗」

对每个失配的 patch，先问这三个问题，答案决定怎么做：

| 问题 | 如果是 | 做法 |
|---|---|---|
| 官方那段代码还在吗？ | 还在，只是位置/上下文变了 | **重新生成** patch（见 §3 技法） |
| 官方把这段能力删了/换成别的形态了吗？ | 删了，但本地定制还成立 | **重挂**：适配层内部把那条消失的能力吸收出来，patch 在官方新的等价位置上重新接线；**功能层零改动** |
| 定制本身还有意义吗？ | 上游已经接管了这件事，或改动对象不存在了 | **退场**：删 patch、删对应的功能层/适配层文件、从 `build.config.json` 摘掉条目，并在 `decisions.zh.md` 记一条原因 |

**第三行是本次移植里最容易做错的地方。** 为了「保住旧实现」而在上游重新发明一个载体，是典型的过度改动。
判据只有一句：**这段定制还有没有一个真实载体**。没有就退场，并写清为什么。

### Step 4 — 官方接口变了也只在适配层里消化；功能层零改动

**两条不可协商的规则：**

1. `git apply --check` 全绿 = 这轮活干完了，适配层与功能层一行都不用动。大多数上游升级就是「代码搬了
   位置」，Step 3 的「重新生成」已经覆盖，**不要顺手去改那两层**。
2. **官方改掉了定制所接的接口 / 出口 / 结构 / 错误串，功能层仍然零改动。** 这不是「尽量」，是验收标准。

**为什么做得到：适配层对功能层的出参是「设计出来」的契约。**
写适配层之前先回答「功能层要判断什么、要展示什么」，据此定出参的名字、字段与语义；官方用几个串、几个
状态、几层结构表达同一件事，都在适配层里收敛成那**一个概念**。例：功能层要判断「这次失败属于哪个阶段」，
适配层给的是 `{stage, rule}`（`diagnostics-signals.mjs`）——官方那 13 条错误文案一条都不进功能层。
**注意别把这条读成「不许像官方」**：官方那个最小结构如果语义稳定、正好就是功能层要的概念，照抄它更好
（§1.1）。真正的转发层是「官方现在返回什么就原样往上抛什么」，包括把官方错误文案直接交给功能层。

| 官方这次变成什么 | 改哪层 | 本仓库的实例（`0.1.5-rc.2` → `0.1.6-alpha.2`） |
|---|---|---|
| 官方把代码搬了位置 / 上下文漂了，能力没变 | **patch 层**（重新生成） | 本轮多数 patch |
| 官方**接口/出口/结构/错误串**变了，定制要的信息还在 | **只改适配层的映射实现**，出参的名字、字段与语义一个字不改；patch 跟着官方那段代码重新生成，但**不许借重新生成把判断挪进 patch** | 启动页被删、等待界面换成前端 BootPage → 适配层改为跟随 `data-dsh-boot` / `data-dsh-boot-spinner` 并新增 `onFailed`，patch 在注入处订阅后接到功能层原有的 `sync(failed)`——**功能层零改动**（下表那条记录写了它一度被改错、又按规则改回） |
| 官方**删掉**了定制依赖的某项能力，但定制本身仍成立 | **适配层**把那条消失的能力吸收成同样的函数，patch 接到原来的位置；**功能层零改动** | 主进程的 pnpm / profile 包操作被整体删除 → 新增 `src/adaptator/profile-packages.mjs` 的 `installProfilePackages`，patch 把它作为 `onRepair` 喂给功能层 |
| 定制已经没有载体（上游接管了，或对象不存在） | **退场**：删 patch + 删对应独立文件 + 摘掉 `copy` 条目 + 在 `decisions.zh.md` 记原因 | `fs-ext` 容忍层（官方删了 `checkFsExt`）、MIME `.png`（官方自己映射了）、精确版本放宽 patch |

> ⚠️ **本仓库里的一处实例**：`0.1.6-alpha.2` 那次移植**一度**让功能层自己去订阅新的适配层 API
> （`dshStartupPage.placeArt(art, busy => sync(!busy))`），当时旧契约是官方 `render()` 调
> `dshLoadingArt.sync(failed)`、适配层只给 `placeArt(element)`。那是反例（Step 4 第 2 条），**已按规则改回**：
> 适配层新增 `onFailed(listener)`，**patch 在注入处订阅**并接到功能层原有的 `sync(failed)`，功能层的
> `placeArt(element)` / `sync(failed)` / `dshLoadingArt` 一个字节没动（决策 38）。改动它要同时动适配层 API
> 与功能层，属**用户裁决**范围——这正是「停下上报」而不是「顺手改掉」的例子。

**适配层对功能层的 API 一经定下即冻结。** 官方接口 / 出口 / 结构 / 错误串怎么变，都在适配层**内部**消化：
改映射实现、把官方新的表达方式合并进既有语义、必要时在适配层内部把实现整体重写；对外的**名字、入参、
出参字段与语义**不动。功能层用到的 API 必须是稳定的——这正是适配层存在的意义。

**「加新 API」也算改接口，别从这儿绕：**

- **可以**：适配层内部新增能力，由 **patch 直接调用**，再喂进功能层**既有**的接口。例：官方删掉主进程的
  profile 包操作后，新增 `src/adaptator/profile-packages.mjs` 的 `installProfilePackages`，patch 把它作为
  `onRepair` 交给功能层原有的 `rollbackProfile`——功能层的 API 面一个字没变。
- **不可以**：让功能层开始依赖一个**新的**适配层 API。那等于换了功能层用的接口，和改旧 API 一样要用户裁决。

**唯一的口子在用户手里，不在你手里：**

- **agent 不得自行修改适配层对外的 API。** 没有「我判断它已经腐败了」这条路——判定 API 腐败是**用户的权力**。
- 如果确实发现在现有 API 下表达不了（可能，但很少），**停下来上报用户**，给三样东西：
  ① **事实**——哪条 API、哪几轮、每轮被迫在适配层内部塞了什么官方特例、为什么现有出参表达不了；
  ② **候选方案**——改哪个字段 / 换成什么概念 / 功能层要跟着动哪几行；
  ③ **影响面**——功能层、`.d.mts`、单测、接线各要改什么。
  每在适配层内部塞一次官方特例，就顺手在 `docs/session/progress.md` 记一行：那是**上报材料**，
  不是自动升级的许可证。
- **只有用户判定这条 API 腐败之后**，才允许适配层 API 与功能层**一次一起改**；改完在 `decisions.zh.md`
  写清四件事——用户判定、哪几轮证据、原设计为什么不再成立、新契约是什么。

**注意区分两件事**：适配层保持**对外契约**稳定 ≠ 保留对**旧上游**的兼容。适配层只对着当前 pin 实现，
不写多版本分支、不留回退路径（AGENTS.md「不保留兼容性」）。

**一旦发现「得动功能层」，按这个顺序排查——前两条是 bug，不是升级：**

1. **适配层把会变的东西透传上去了**。出参里出现官方错误文案、内部路径、选择器、枚举取值，或直接暴露
   官方字段名（官方一改功能层就得动），就是适配层没干完活。让它转成功能层要的概念，功能层不动。
   例：`diagnostics-signals.mjs` 就是把「官方会说什么错」挡在功能层外的翻译层——功能层拿到的是阶段信号，
   不是官方文本。
   **但「出参恰好和官方某个结构同形」不是问题**：官方的设计可能本来就是最佳实践，照抄一个语义稳定的结构
   比另造孪生结构更好；判据是「官方改了功能层要不要动」，见 §1.1。
2. **只是触发方向 / 调用时机变了**（谁调谁、在哪调）→ 那是**接线**，不是契约变化：patch 层可以 import
   两侧、持有接线状态、串接多个调用、按官方状态决定何时调度（AGENTS.md 硬约束 2）。做法是**适配层多给一个
   由 patch 订阅**的能力，patch 把它接到功能层**原来那个**入口上，功能层一行不改。
   例：官方原本自己调 `dshLoadingArt.sync(failed)`，这次这个调用没了 → 适配层把 boot 状态收敛成
   `onFailed(cb)`，patch 写 `dshStartupPage.onFailed(dshLoadingArt.sync)`；功能层仍是
   `placeArt(art)` + `sync(failed)`，一个字没动。
   **反例（这一步最容易走错）**：让**功能层自己去订阅**新的适配层 API —— 例如把功能层改成
   `placeArt(art, busy => sync(!busy))`。那已经是改了功能层用的接口，等于换掉了它的契约，
   按上面「加新 API」那条走用户裁决，不是你能顺手做的。
3. 两条都不是，且这条 API 在现有设计下**确实**表达不了 → **停下上报用户**（按上面的三样东西），
   **不要自己改 API，也不要顺手改功能层**。

**结论：一次 pin 升级里功能层的改动数必须为 0。** 唯一的例外是「用户判定某条适配层 API 腐败、批准一起改」，
而且必须带着用户判定与多轮证据写进 `decisions.zh.md`。除此之外，功能层一行都不动——做不到就是适配层没写对。

其它同步项：

- `.mjs` 与 `.d.mts` **成对且同步改**：上游 `tsc -b` 是 strict，声明文件缺失或不一致会直接报错。
- 新增独立文件必须同步写进 `build.config.json` 的 `copy`（`copy` 按目录复制时，目录内的新文件自动生效）。
- 落在适配层的每一处改动，都要能在 `decisions.zh.md` 里写出一条原因，而且是「官方哪个**接口/出口/结构/
  错误串**确实变了」这种原因；写不出原因，说明它本来该是 patch。
- 落在**功能层**的改动只有两个来源：**需求变**，或**用户判定某条适配层 API 腐败后批准**。两个都不沾，
  说明这轮分层判断错了——回去改设计（多半是接线该放 patch，或官方知识该下沉适配层），**不要改功能层**。

### Step 5 — 登记配置

改了就要在 `src/build.config.json` 里对齐，这些字段都可能动：

- `tag` → 新的上游 tag（提交号由脚本解析，不写进配置）
- `copy[]` → 新增/移动的独立文件（含渲染进程资源与 `assets/` 下覆盖上游的成品资源，例如应用图标 `assets/dsh-impact.png` → `apps/desktop/resources/icon-windows.png`；也包括必须与某个官方运行时包同装同发的文件，例如 `adaptator/acl-console-guard.mjs` → `packages/sandbox/sandbox-windows-acl/acl-console-guard.mjs`，后者还要写进那个包的 `files`——决策 44）
- `patches[]` → 新增/删除/改名的补丁，`target` 必须指向**真实存在**的那个文件（改名/搬家的目标最容易漏）
- `releaseEnv[]` → 官方打包本地设置文件与它的模板路径（上游改名/搬家时跟着改；官方若不再需要这类文件，就把它删空）
- `build[].artifacts{from,to}` → 这条构建指令的产物在哪、搬进本仓库的哪（上游换了产物目录名/目标名时跟着改；
  `smoke-packaged.mjs` 也读这个字段）
- `build[].ignoreTargets` → 只有「不参与该构建指令」的注入目标才写；**不写就算输入**（这是缓存契约，宁多算不漏算）
- **官方源码 import 的运行期独立文件**还要在 patch 里登记三处（决策 40 / R23）：`tsdown` 主进程那条配置的
  `deps.neverBundle`（保持运行期外部引用）、`tsdown` 沙箱 preload 那条配置的 `alias`（preload 必须内联）、
  `electron-builder` 的 `files`（`local/**/*.mjs` 带进产物）。少任何一处，`build:lib` 就报
  `[UNRESOLVED_IMPORT]`，或者产物起来后找不到模块——`apply --check` 与门限都看不出这一类

### Step 6 — 验证（按能拿到的最强证据，逐级往上报）

```powershell
# ① 分层门限：最便宜、先跑。它红了说明规范已经被破坏，先修设计再谈别的
node (Join-Path $R 'scripts/check-layers.mjs')

# ② patch 层：逐个 + 联合
$config = Get-Content (Join-Path $R 'src/build.config.json') -Raw | ConvertFrom-Json
foreach ($entry in $config.patches) { & git -C $U apply --check (Join-Path $R 'src' $entry.file); "$($entry.file) exit=$LASTEXITCODE" }
foreach ($entry in $config.patches) { & git -C $U apply (Join-Path $R 'src' $entry.file) }
& git -C $U --no-pager diff --stat      # 改到的文件必须恰好是配置里那批
foreach ($entry in $config.patches) { & git -C $U checkout -- $entry.target }

# ③ 功能层与门限自身：直跑测试文件（绕开 node --test 的子进程隔离）
foreach ($f in Get-ChildItem (Join-Path $R 'src/features') -Recurse -Filter *.test.mjs) { node $f.FullName }
node (Join-Path $R 'scripts/check-layers.test.mjs')

# ④ 类型：把独立文件按 copy 映射摆到上游，再让上游自己的 tsc 检查
node (Join-Path $U 'node_modules/typescript/bin/tsc') -b (Join-Path $U 'apps/desktop/tsconfig.json')     # 覆盖 patch 后的 src 与注入的 .d.mts
cd $U; cmd /c "node node_modules\typescript\bin\tsc -b tsconfig.host.json > %TEMP%\tsc-host.txt 2>&1"
Get-Content "$env:TEMP\tsc-host.txt" | Select-String 'apps/desktop/(src|scripts|tests)/'   # 只看自己改的文件
```

- **门限红了改设计，不要改门限。** 判据、级别、豁免与盲区见 `docs/design.zh.md` §4.3。把违规塞进
  `src/layer-allowlist.json` 只有在「论证过它是稳定契约而非官方内部实现」时才成立，且必须写 `reason`
  （没写 reason 的例外不放行，失效条目本身算违规）。改 `check-layers.mjs` 去迁就现状是最后手段，
  且必须同时补负样本单测。
- `tsc -b tsconfig.host.json` 在**本机**会报几百行错——全部来自未安装的可选依赖（`zod`、`yaml`、
  `chokidar`、`cos-nodejs-sdk-v5` …）。判据是「**自己改的文件零报错**」，不是「整库零报错」。
- 沙箱里 `cmd /c "… > file 2>&1"` 是唯一可用的重定向方式（PowerShell 自己那条路是坏的）。
- **能跑构建就跑构建**：`node scripts/build.mjs`（第 0 步就是门限），打包产物冒烟
  `node scripts/smoke-packaged.mjs`，改了接线再跑上游用例
  `node_modules/.bin/vitest run apps/desktop/tests/main-startup.spec.ts`。
  跑不了就**在回复里写明「未验证」**，并列出跑了什么、没跑什么——不要用「看起来对」代替。

### Step 7 — 清理现场

上游工作区必须回到干净：`git -C $U status --short` 为空（`git diff` 生成 patch 后
逐个 `git checkout -- <那一个文件>`；**不要** `git reset --hard` / `git clean` / `git stash`）。
再同步文档（`design` 的状态与接线表、`decisions` 的原因、`reproduce` 的基线与验证方式、
`docs/session/progress.md` 追加一段过程记录）。

## 3. 技法：怎么产出一个可靠的 patch

**不要手写 hunk。** 直接改上游文件，用 git 自己产出 diff：

```powershell
# 1) 用编辑工具改上游那份文件
# 2) 生成 patch。注意 `--output=(Join-Path …)` 在 PowerShell 里是**字面量**，不会被求值：
#    必须用字符串拼接。
$patch = Join-Path $R 'src/patch/<name>.patch'
git -C $U --no-pager diff ("--output=" + $patch) -- <上游相对路径>
# 3) 还原上游文件
git -C $U checkout -- <上游相对路径>
# 4) 校验
git -C $U apply --check $patch
```

- 旧 patch 就算带 offset 能打上，也**重新生成一遍**：偏移说明上下文已经漂了，下次上游再动一点就会失配。
- `git apply --check` 通过 ≠ 语义正确。生成后**读一遍 patch**，确认它修改的还是你想修改的那个函数。
- 一次只改一个目标文件再 diff（`-- <path>` 限定），避免把别人的在途改动带进 patch。

## 4. 判定表：一处变更该落在哪层

| 你在改什么 | 落在哪层 |
|---|---|
| 官方把某段代码搬了位置 / 上下文漂了，能力本身没变 | **patch 层（重新生成）——默认就走这一行，上面两层不动** |
| profile 清单、`copy[]`、patch 清单要增删 | `src/build.config.json` |
| 需要官方多给一个出参 / 一个薄出口 | patch 层（不算功能） |
| 官方换了选择器 / 字段名 / 内部路径 / 错误串，定制要的信息还在 | 适配层 |
| 官方**删掉**了定制依赖的能力，但定制仍成立 | 适配层吸收（patch 把它接回原位）；**功能层不动** |
| 官方不再自己调用功能层的入口，或触发方向 / 调用时机变了 | **patch 层**：patch 订阅适配层给出的信号，接到功能层**原来那个**入口上，功能层不动（让功能层自己去订阅一个新的适配层 API 就算改接口，见 Step 4 第 2 条的反例） |
| 定制本身的行为、判断、文案要变（需求变） | 功能层（+ `.d.mts` + 单测）。**需求变是唯一不需要外部裁决的情况** |
| 「适配层对功能层的出参要改」 | **禁止自行修改**（API 定下即冻结）。先按 Step 4 排查：多半是适配层把会变的东西透传了（修适配层），或只是接线方向变了（修 patch）。**确实表达不了时停下上报用户**，由用户判定该 API 是否腐败 |
| 定制已无载体 | 退场（删 patch + 删独立文件 + 摘 `copy` + 记 `decisions.zh.md`） |
| 新增一个独立文件 | 适配层/功能层 + `build.config.json` 的 `copy` |
| 渲染进程资源（图片/CSS/经典脚本） | 适配层或功能层 + `copy` 映射到官方渲染目录 |
| 本地品牌资源（应用图标等） | 只加 `copy`：`assets/` 下的成品文件覆盖上游目标（例：`assets/dsh-impact.png` → `apps/desktop/resources/icon-windows.png`）。转换在上游之外做一次，仓库里只留成品 |
| 某能力必须与官方某个**运行时包同装同发**（例：ACL runner 的控制台守卫要落在它旁边并由它 `--import`） | `copy` 的第二类目标：复制进那个官方包的目录，**并把文件名写进该包 `package.json` 的 `files`**（否则 `pnpm pack` 不会带进运行时）——决策 44 / R34 |

## 5. 收尾检查清单

- [ ] `npm run check:layers` 硬规则 0 违规（构建第 0 步会强制这一条）；告警逐条确认过
- [ ] `tag` 在上游解析得出提交（`git rev-parse --verify '<tag>^{commit}'` 通过；解析不到就先 `fetch --tags`——构建脚本会因此直接失败）
- [ ] `patches[]` 的每一项逐个 `apply --check` 全 0；联合 apply 后改到的文件恰好等于配置里那批
- [ ] 每个 patch 的 `target` 都真实存在，且是**语义上**该改的那个文件（搬过家的目标最容易错）
- [ ] **功能层的改动数为 0**，且**适配层对外的 API（名字/入参/出参字段与语义）一个字没改**——这是本仓库的
      硬标准。确实做不到时，本轮**停下上报用户**，不要在报告里悄悄把 API 或功能层改了
- [ ] 适配层的每处改动都有一条「官方接口/出口/结构/错误串确实变了」的证据（源码里删掉/改名的符号、
      实测 `hits=0` 的错误串、变了的结构），且改动都在**映射实现内部**
- [ ] 若本轮为了维持出参不变而在适配层内部塞了官方特例，已在 `docs/session/progress.md` 记一行
      （哪条 API、塞了什么、原设计为什么表达不了）——那是上报材料
- [ ] 退场的定制：patch、适配层/功能层文件、`copy` 条目、文档里的描述都清干净了，`decisions.zh.md` 有原因
- [ ] 独立文件 `.mjs` 与 `.d.mts` 同步；新文件已登记 `copy`
- [ ] 本轮新增/搬迁**运行期**独立文件时，`tsdown` 的 `neverBundle`（主进程）与 `alias`（沙箱 preload）以及
      `electron-builder` 的 `files` 三处都登记过，且 `node node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE host`
      能过（只跑 `apply` 看不出这类问题）
- [ ] 功能层单测与 `scripts/check-layers.test.mjs` 全绿（跑不了的用例写明原因）
- [ ] `tsc -b` 对**自己改的文件**零报错
- [ ] 上游工作区干净；回复里写清「验证了什么 / 未验证什么」

## 6. 反模式

- 上游接口真的变了，却只让 `git apply` 通过、不管适配层 —— 编译过、线上崩。
- 反过来：**`apply --check` 已经全绿，还去改适配层或功能层** —— 这是过度改动，本轮绝大多数升级都属于这类。
- **自己判定适配层 API「已经腐败」就把它改了**（哪怕攒了几轮特例记录）—— 判定权在用户，不在 agent。
  你只能：在适配层内部消化 → 实在做不到就停下上报（事实 / 候选方案 / 影响面）。
- **一发现「得动功能层」就直接动** —— 先按 Step 4 排查：适配层是不是把会变的东西（官方文案、内部路径、
  枚举取值、官方字段名）透传上去了？是不是只是接线方向变了？把「会变的东西」留给自己、把功能层要的
  概念交出去，才是适配层该干的事。（出参**恰好和官方某个稳定结构同形**不是问题。）
- **把「接线方向变了 / 官方不再调我们了」当成改功能层的理由** —— 接线是 patch 的活：patch 订阅适配层给出的
  信号，接到功能层**原来那个**入口上。让功能层去依赖一个新的适配层 API，和改旧 API 一样要用户裁决。
- **门限红了就把它改绿**：往 `src/layer-allowlist.json` 塞条目、或改 `check-layers.mjs` 放宽规则。
  正确的是改设计（把官方知识下沉到适配层）。例外必须写 `reason` 且能被复核。
- 上游删了载体，就顺手在上游重新造一个类似的页面/入口 —— 违反最小改动，且没人维护。
- 把判断逻辑、文案写进 patch —— 下次上游一动就要重写策略，分层白做。
- 手写 hunk 或对着 `--check` 反复试 —— 直接改文件再 `git diff --output`。
- 在上游 `deepseek-harness/` 里留下改动（构建每轮都会 `git reset --hard` + `git clean -fd`，留着也没用）。
- 用 `git reset --hard` / `git clean` / `git stash` 清理 —— 会连带毁掉在途改动，只允许按文件 `git checkout --`。
- 报「已修复」而不说清哪些是实测、哪些没跑。
