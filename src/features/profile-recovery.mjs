/**
 * 功能层：desktop profile 的配置迁移与快照回退（阶段 4 的「复制 web 配置 / 配置快照回退 / 回退提示」）。
 *
 * 本层只做判断与文件操作，不直接决定「何时调用」：调用点由 patch 插进官方 `main.ts` 的启动流程。
 *
 * 三件事：
 * 1. `webProfileCopyPlan()` —— 首次启动把 web profile 的**配置语义**搬进 desktop profile（纯计算）。
 * 2. `snapshotProfile()` / `rollbackProfile()` —— 动配置前留快照，启动失败时按「还原文件 → 重建依赖 →
 *    刷新宿主包链接」三步回退；`rollbackProfile` 的第三步由调用方通过 `onRepair` 提供（官方已经有了
 *    这个能力，见 `desktop/scripts/ensure-packages` 的接线），本层不重写包管理器逻辑。
 * 3. `startupNoticeScript()` —— 回退提示的 DOM/CSS（经典脚本字符串），由主进程 `executeJavaScript` 注入。
 *
 * 为什么复制的是「配置语义」而不是目录：web profile 目录里混着 `.dsh-market`、`update.ps1`、
 * `cordis.yml`、`node_modules` 这类 web 专有产物；照搬目录会把它们一起带进 desktop。这里只搬
 * `package.json` 的 `dependencies`/`overrides`/第三方 bundles 与 `pnpm-workspace.yaml` 全文。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 快照覆盖与完整性判据都基于这张表；不在此表的文件一律不碰（`desktop.cordis.yml` 由每个启动重写，`node_modules` 由 lockfile 重建）。 */
const PROFILE_FILES = Object.freeze({
  manifest: 'package.json',
  workspace: 'pnpm-workspace.yaml',
  lockfile: 'pnpm-lock.yaml',
  patch: 'cordis.patch.yml',
})

/** 内置 bundles：desktop profile 的清单必须以它们开头（与官方 `DESKTOP_PROFILE_BUNDLES` 同义）。 */
const BUILTIN_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

/** `pnpm-workspace.yaml` 里需要从 web profile 合并的构建授权段。 */
const ALLOW_BUILDS = 'allowBuilds'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(fs, path) {
  if (!existsSync(path)) return undefined
  const stats = statSync(path)
  if (!stats.isFile()) throw new Error(`desktop profile: ${path} is not a regular file`)
  return readFileSync(path, 'utf8')
}

function readManifest(fs, path, subject) {
  const text = readText(fs, path)
  if (text === undefined) return undefined
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`desktop profile: ${subject} is not valid JSON (${error.message})`)
  }
  if (!isRecord(value)) throw new Error(`desktop profile: ${subject} must be a JSON object`)
  return value
}

function requireManifest(fs, path, subject) {
  const value = readManifest(fs, path, subject)
  if (value === undefined) throw new Error(`desktop profile: ${subject} is missing ${path}`)
  return value
}

function stringList(value, subject) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new Error(`desktop profile: ${subject} must be a list of package names`)
  }
  return value
}

/** 从清单里取 `dsh.profile.bundles`；同时校验它以内置 bundles 开头，避免把内置层当成第三方插件搬走。 */
function bundlesOf(manifest, subject) {
  const profile = isRecord(manifest.dsh) ? manifest.dsh.profile : undefined
  if (!isRecord(profile)) throw new Error(`desktop profile: ${subject} declares no dsh.profile`)
  const bundles = stringList(profile.bundles, `${subject} dsh.profile.bundles`)
  if (!BUILTIN_BUNDLES.every((bundle, index) => bundles[index] === bundle)) {
    throw new Error(`desktop profile: ${subject} must begin with the built-in desktop bundles`)
  }
  return { bundles, plugins: bundles.slice(BUILTIN_BUNDLES.length) }
}

function dependenciesOf(manifest, subject) {
  if (manifest.dependencies === undefined) return {}
  if (!isRecord(manifest.dependencies) || Object.values(manifest.dependencies).some(spec => typeof spec !== 'string')) {
    throw new Error(`desktop profile: ${subject} dependencies must map package names to version specs`)
  }
  return manifest.dependencies
}

function overridesOf(manifest, subject) {
  if (manifest.overrides === undefined) return undefined
  if (!isRecord(manifest.overrides) || Object.values(manifest.overrides).some(spec => typeof spec !== 'string')) {
    throw new Error(`desktop profile: ${subject} overrides must map package names to version specs`)
  }
  return manifest.overrides
}

/**
 * 把 web profile 的配置语义合进 desktop profile 的清单。
 * @param desktop - 现有 desktop 清单。
 * @param web - web 清单。
 * @returns 合并后的清单与第三方插件清单。
 */
function mergeManifest(desktop, web) {
  const desktopBundles = bundlesOf(desktop, 'existing desktop profile')
  const webBundles = bundlesOf(web, 'web profile')
  const webDependencies = dependenciesOf(web, 'web profile')
  const desktopDependencies = dependenciesOf(desktop, 'existing desktop profile')

  // 第三方插件 = web 声明的依赖里被列进 bundles 的那些；`dshmarket` 之类「装了但没启用」的不搬。
  const plugins = webBundles.plugins.filter(name => Object.hasOwn(webDependencies, name))
  const bundles = [...BUILTIN_BUNDLES, ...plugins]

  // desktop 已有的依赖优先：绝不因为这次迁移动 desktop 自己的解析结果。
  const dependencies = {}
  for (const [name, spec] of Object.entries(webDependencies)) {
    if (plugins.includes(name)) dependencies[name] = spec
  }
  for (const [name, spec] of Object.entries(desktopDependencies)) {
    dependencies[name] = spec
  }

  const webOverrides = overridesOf(web, 'web profile')
  const desktopOverrides = overridesOf(desktop, 'existing desktop profile')
  const overrides = { ...webOverrides, ...desktopOverrides }

  return {
    manifest: {
      ...desktop,
      name: typeof desktop.name === 'string' ? desktop.name : `dsh-profile-desktop`,
      private: true,
      version: typeof desktop.version === 'string' ? desktop.version : '0.0.0',
      dependencies,
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
      dsh: {
        ...(isRecord(desktop.dsh) ? desktop.dsh : {}),
        profile: {
          ...(isRecord(desktop.dsh) && isRecord(desktop.dsh.profile) ? desktop.dsh.profile : {}),
          bundles,
        },
      },
    },
    plugins,
  }
}

/**
 * 以 desktop 自己的 `pnpm-workspace.yaml` 为基底，补进 web profile 声明而 desktop 还没有的构建授权。
 *
 * 不整文件照搬：desktop 的工作区有自己的设置（`strictDepBuilds` 等），照搬会连带换掉它们；这里只按行
 * 追加 `allowBuilds` 段里缺的条目，其余原文不动（含块标量、列表值等本层不解析的写法）。
 * @param branch - `allowBuilds` 的原始列表项行，如 `'  node-pty: true'`。
 * @param base - desktop 现有的工作区文本，或 undefined。
 * @returns 合并后的工作区文本。
 */
function mergeWorkspace(branch, base) {
  if (base === undefined) return `packages:\n  - .\n\n${ALLOW_BUILDS}:\n${branch.join('\n')}\n`
  const lines = base.split('\n')
  const header = lines.findIndex(line => /^allowBuilds\s*:/u.test(line))
  const keysOf = entries => entries.map(entry => entry.replace(/^\s+/u, '').split(':', 1)[0])
  const present = new Set(header === -1 ? [] : keysOf(lines.slice(header + 1).filter(line => /^\s+\S/u.test(line))))
  const added = branch.filter(line => !present.has(line.replace(/^\s+/u, '').split(':', 1)[0]))
  if (added.length === 0) return base
  if (header === -1) return `${base.trimEnd()}\n\n${ALLOW_BUILDS}:\n${added.join('\n')}\n`
  let end = header + 1
  while (end < lines.length && (/^\s+\S/u.test(lines[end]) || lines[end] === '')) end += 1
  return [...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n')
}

/**
 * 计算「复制 web 配置」这一次写入；web profile 没有第三方插件时返回 null。
 *
 * 覆盖两种情形：desktop profile 还没有清单（首次启动/官方重置之后），以及 desktop 已有清单但用户的 web
 * profile 又变了（插件增删）。两者都由调用方对比写入前后的文件决定要不要重装与校验。
 * @param options - `desktopProfile`、`webProfile` 目录，以及可注入的 `errors` 与 `fs`（测试用）。
 * @returns `{ manifest, workspace, plugins }` 或 null。
 */
export function webProfileCopyPlan(options) {
  const fs = options.fs ?? {}
  const desktopProfile = options.desktopProfile
  const webProfile = options.webProfile
  // 没有 web profile 就没有可搬的配置：这是默认状态，不是错误。
  if (!existsSync(webProfile)) return null
  const webManifest = requireManifest(fs, join(webProfile, PROFILE_FILES.manifest), 'web profile')
  const webBundles = bundlesOf(webManifest, 'web profile')
  if (webBundles.plugins.length === 0) return null
  const webWorkspace = readText(fs, join(webProfile, PROFILE_FILES.workspace))
  if (webWorkspace === undefined) throw new Error(`desktop profile: web profile is missing ${PROFILE_FILES.workspace}`)
  const existing = readManifest(fs, join(desktopProfile, PROFILE_FILES.manifest), 'existing desktop profile')
  const merged = mergeManifest(existing ?? { dsh: { profile: { bundles: [...BUILTIN_BUNDLES] } } }, webManifest)
  const workspace = mergeWorkspace(allowBuildLines(webWorkspace), readText(fs, join(desktopProfile, PROFILE_FILES.workspace)))
  return { manifest: merged.manifest, workspace, plugins: merged.plugins }
}

/** 取出一份 `pnpm-workspace.yaml` 里 `allowBuilds` 段的原始条目行。 */
function allowBuildLines(text) {
  const lines = text.split('\n')
  const header = lines.findIndex(line => /^allowBuilds\s*:/u.test(line))
  if (header === -1) return []
  const entries = []
  for (const line of lines.slice(header + 1)) {
    if (!/^\s+\S/u.test(line)) break
    entries.push(line)
  }
  return entries
}

/**
 * 判断计划与 desktop 当前文件是否已有差异；没有差异时调用方应跳过复制与重装。
 * @param options - `desktopProfile`、`plan` 与可注入的 `fs`。
 * @returns 需要写入时返回 `true`。
 */
export function webProfileCopyChanged(options) {
  const fs = options.fs ?? {}
  const desktopProfile = options.desktopProfile
  const plan = options.plan
  const current = readText(fs, join(desktopProfile, PROFILE_FILES.manifest))
  let parsed
  try {
    parsed = current === undefined ? undefined : JSON.parse(current)
  } catch {
    return true
  }
  if (JSON.stringify(parsed) !== JSON.stringify(plan.manifest)) return true
  return readText(fs, join(desktopProfile, PROFILE_FILES.workspace)) !== plan.workspace
}

/**
 * 写下一份复制计划：`package.json` 与 `pnpm-workspace.yaml` 都先写临时文件再改名，避免半份文件。
 * @param desktopProfile - 目标 desktop profile 目录。
 * @param plan - `webProfileCopyPlan` / `webProfileCopyDelta` 的返回值。
 * @param options - 可注入的 `fs`（测试用）。
 */
export function applyWebProfileCopy(desktopProfile, plan, options = {}) {
  const fs = options.fs ?? {}
  const writeAtomic = (path, body) => {
    const temporary = `${path}.tmp-${process.pid}`
    writeFileSync(temporary, body, { mode: 0o600 })
    try {
      renameSync(temporary, path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
  writeAtomic(join(desktopProfile, PROFILE_FILES.manifest), `${JSON.stringify(plan.manifest, undefined, 2)}\n`)
  writeAtomic(join(desktopProfile, PROFILE_FILES.workspace), plan.workspace)
}

function missingFiles(fs, profile) {
  return ['manifest', 'workspace']
    .map(key => join(profile, PROFILE_FILES[key]))
    .filter(path => !existsSync(path))
}

/**
 * 拍下 profile 的可变文件快照。
 * @param options - `profile` 与可注入的 `fs`。
 * @returns `{ files }`：相对文件名 → 字节内容；不含不存在的文件（回退时按缺席删除）。
 */
export function snapshotProfile(options) {
  const fs = options.fs ?? {}
  const profile = options.profile
  const missing = missingFiles(fs, profile)
  if (missing.length > 0) throw new Error(`desktop profile: ${profile} is missing ${missing.join(', ')}`)
  const files = {}
  for (const name of Object.values(PROFILE_FILES)) {
    const text = readText(fs, join(profile, name))
    if (text !== undefined) files[name] = text
  }
  return { files }
}

/**
 * 回退到快照并重建 profile：还原文件（快照里没有的删除）→ 交调用方重建依赖与宿主链接。
 * @param options - `profile`、`snapshot`、`onRepair`（官方重建能力）、可注入的 `fs` 与 `errors`。
 * @returns `{ restored, removed }` 两个文件名列表。
 */
export async function rollbackProfile(options) {
  const fs = options.fs ?? {}
  const profile = options.profile
  const snapshot = options.snapshot
  const errors = options.errors ?? {}
  const rollbackError = errors.rollbackError ?? (message => new Error(message))
  const restored = []
  const removed = []
  for (const name of Object.values(PROFILE_FILES)) {
    const path = join(profile, name)
    const text = snapshot.files[name]
    if (text === undefined) {
      if (existsSync(path)) {
        unlinkSync(path)
        removed.push(name)
      }
      continue
    }
    if (readText(fs, path) !== text) {
      writeFileSync(path, text, { mode: 0o600 })
      restored.push(name)
    }
  }
  try {
    await options.onRepair()
  } catch (error) {
    throw rollbackError(`desktop profile: rollback could not rebuild the profile (${error instanceof Error ? error.message : String(error)})`)
  }
  return { restored, removed }
}

/** 探针脚本（在 desktop runtime 的 Node 里跑）：逐个 `import()` 声明启用的插件。 */
const PROBE = `
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [profile, names] = process.argv.slice(2)
const failures = []
for (const name of JSON.parse(names)) {
  const path = join(profile, 'node_modules', ...name.split('/'))
  if (!existsSync(path)) { failures.push(name + ': not installed in the desktop profile'); continue }
  try {
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(path, 'package.json'), 'utf8'))
    const entry = typeof manifest.main === 'string' && manifest.main !== '' ? join(path, manifest.main) : join(path, 'index.js')
    if (!existsSync(entry)) { failures.push(name + ': installed package has no loadable entry (' + entry + ')'); continue }
    await import(pathToFileURL(entry).href)
  } catch (error) {
    failures.push(name + ': ' + (error && error.message ? error.message : String(error)))
  }
}
process.stdout.write(JSON.stringify(failures))
`

/**
 * 在 desktop runtime 的解析语境里校验：每个声明启用的插件都必须装进 desktop profile、且能被加载。
 *
 * 边界：`import()` 只能证明「模块能加载」与「声明的具名导出存在」。运行时服务/API 变化、配置 schema 变化、
 * `cordis.patch.yml` 行 id 失效都抓不到——那些只有真正 boot 才暴露，由快照回退兜底。
 * @param options - `profile`、`plugins`、`node`（desktop runtime 的 Node 可执行文件）。
 * @returns 失败描述列表；为空即通过。
 */
export function installProbeFailures(options) {
  const { profile, plugins, node } = options
  if (plugins.length === 0) return []
  const directory = mkdtempSync(join(tmpdir(), 'dsh-profile-probe-'))
  const script = join(directory, 'probe.mjs')
  try {
    writeFileSync(script, PROBE)
    const result = spawnSync(node, [script, profile, JSON.stringify(plugins)], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined) return [...plugins.map(name => `${name}: probe could not run (${result.error.message})`)]
    if (result.status !== 0) {
      const detail = (result.stderr ?? '').trim().split('\n').slice(-5).join('\n')
      return plugins.map(name => `${name}: probe exited with ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`)
    }
    try {
      const failures = JSON.parse(result.stdout)
      return Array.isArray(failures) ? failures.filter(entry => typeof entry === 'string') : []
    } catch (error) {
      return plugins.map(name => `${name}: probe produced invalid output (${error.message})`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 回退提示的经典脚本：官方应用页里注入一次自绘 toast。
 *
 * 不依赖 dsh 前端 DOM、也不改 `desktop-host`：只 `createElement` 一个容器，CSS 全在函数内部。
 * @param options - `signal` 调用时机（`rolled-back` 为回退后成功启动）与 `text` 提示文案。
 * @returns 交给 `webContents.executeJavaScript` 的自执行表达式。
 */
export function startupNoticeScript(options) {
  const text = String(options.text)
  const signal = String(options.signal)
  return `(() => {
  const prefix = 'dsh-desktop-notice'
  const previous = document.getElementById(prefix)
  if (previous !== null) previous.remove()
  const notice = document.createElement('div')
  notice.id = prefix
  notice.dataset.signal = ${JSON.stringify(signal)}
  notice.setAttribute('role', 'status')
  notice.textContent = ${JSON.stringify(text)}
  notice.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);max-width:min(560px,86vw);z-index:2147483647;padding:12px 18px;border-radius:10px;background:rgba(24,26,32,.94);color:#f5f6f8;font:14px/1.5 system-ui;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .18s ease'
  document.body.appendChild(notice)
  requestAnimationFrame(() => { notice.style.opacity = '1' })
  setTimeout(() => {
    notice.style.opacity = '0'
    setTimeout(() => { notice.remove() }, 400)
  }, 9000)
  return true
})()`
}

/**
 * 复制的配置在探针阶段被判不可用时的失败文案。
 *
 * 「哪个插件没起来、要不要放弃这份配置」在 `installProbeFailures` 与调用方那里已经判完；本函数只决定
 * 这句话长什么样 —— 文案属于本层，patch 里不许出现。
 * @param failures - `installProbeFailures` 返回的失败描述列表。
 * @returns 交给官方错误出口的消息。
 */
export function copyFailureMessage(failures) {
  return `dsh desktop: copied web profile plugins could not be loaded:\n${failures.join('\n')}`
}

/** 回退一次并重试启动时写进日志的那一行。 */
export const ROLLBACK_RETRY_NOTICE = 'dsh desktop: rolled the profile back to the pre-copy configuration; retrying once'

/** 回退后的重试本身失败时写进日志的前缀。 */
export const ROLLBACK_RETRY_FAILURE = 'dsh desktop: retry after profile rollback failed'

/**
 * 回退后给用户看的那句提示。官方 locale 表的 `webProfileRolledBack` 条目就是它 —— patch 只做赋值接线，
 * 「提示什么」在本层。
 */
export const ROLLBACK_NOTICE_EN = 'The previous start failed. Desktop restored the configuration from before this start (including the plugins copied from your web profile).'

/** `ROLLBACK_NOTICE_EN` 的中文版。 */
export const ROLLBACK_NOTICE_ZH = '上次启动失败，已回滚到本次启动之前的配置（含从 web profile 复制来的插件）。'
