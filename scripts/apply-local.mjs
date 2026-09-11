#!/usr/bin/env node
/**
 * 把本仓库的分层定制注入官方工作区。
 *
 * 流程：
 *   1. 校验上游工作区干净（有未提交改动则拒绝，避免误伤）
 *   2. 记录上游当前 ref，checkout 到 manifest.baseCommit
 *   3. 重定向 .desktop-build 到仓库缓存，并把注入目录写进上游 .git/info/exclude
 *   4. 按层复制 src/upstream、src/features 到 manifest.injectionDir
 *   5. 按 manifest 顺序 git apply 每个补丁
 *   6. 落状态后执行生效断言与缓存前提检查
 *
 * --check 不改动上游：先把补丁涉及的文件从 baseCommit 导出到临时目录，再在那里校验，
 * 因此即使上游 HEAD 已经漂移，结论也与真实应用一致。
 *
 * 逆操作见 restore-local.mjs；两者必须成对使用（构建结束后务必还原）。
 *
 * 用法：
 *   node scripts/apply-local.mjs [--upstream <路径>] [--check]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PATCH_DIR = join(HERE, 'upstream-patches')
const STATE_FILE = join(PATCH_DIR, '.state.json')
/** 写入上游 .git/info/exclude 的标记行；restore-local.mjs 按同样的字符串移除 */
const INJECTION_EXCLUDE_MARKER = '# dsh-desktop-local-injection（apply-local.mjs 管理，勿手工编辑）'

function fail(message) {
  console.error(`apply-local: ${message}`)
  process.exit(1)
}

function git(upstream, args) {
  return execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim()
}

function parseArgs(argv) {
  // dsh 源码位于本仓库内：<repo>/deepseek-harness（内含独立 .git，可 checkout 到指定提交）
  const options = { upstream: join(REPO_ROOT, 'deepseek-harness'), check: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--upstream') { options.upstream = resolve(argv[++i] ?? '') }
    else if (argv[i] === '--check') { options.check = true }
    else fail(`未知参数 ${argv[i]}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const upstream = options.upstream
const manifest = JSON.parse(readFileSync(join(PATCH_DIR, 'manifest.json'), 'utf8'))

if (!existsSync(join(upstream, '.git'))) fail(`上游不是 git 仓库: ${upstream}`)
if (existsSync(STATE_FILE)) {
  fail(`检测到未还原的注入状态（${STATE_FILE}），请先运行 restore-local.mjs 再执行本次操作`)
}

// 1. 上游必须干净，否则 checkout/还原都可能误伤
const dirty = git(upstream, ['status', '--porcelain'])
if (dirty !== '') fail(`上游工作区有未提交改动，请先处理:\n${dirty}`)

// 2. 切到补丁针对的提交
const originalRef = git(upstream, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD'
  ? git(upstream, ['rev-parse', 'HEAD'])
  : git(upstream, ['rev-parse', '--abbrev-ref', 'HEAD'])
const head = git(upstream, ['rev-parse', 'HEAD'])
console.log(`apply-local: 上游 HEAD = ${head}`)
console.log(`apply-local: 补丁基线 = ${manifest.baseCommit} (${manifest.baseVersion})`)

if (head !== manifest.baseCommit) {
  if (options.check) {
    console.log('apply-local: 当前 HEAD 不是基线，--check 将在基线树上校验（不切换工作区）')
  } else {
    console.log(`apply-local: 切到补丁基线（原 ref: ${originalRef}）`)
    git(upstream, ['checkout', manifest.baseCommit])
  }
} else {
  console.log('apply-local: 已位于补丁基线')
}

// 3. 把上游构建目录重定向到仓库内的缓存区
//    上游把构建产物、pnpm store、Node 归档统一放在 APP_ROOT/.desktop-build；
//    用 junction 指向 <repo>/.cache/desktop-build 后，缓存随仓库集中管理、不被 git 跟踪，
//    也不会因为 dsh 源码被重新 clone 或移动而丢失。
const buildRoot = join(upstream, 'apps', 'desktop', '.desktop-build')
const cacheBuildRoot = join(REPO_ROOT, '.cache', 'desktop-build')
if (!options.check) ensureBuildRootLink(buildRoot, cacheBuildRoot)

// 4. 注入源码（按层保留子目录：摊平会让两层同名的路径/模块互相覆盖）
const injectionDir = join(upstream, manifest.injectionDir)
const layers = ['upstream', 'features']
if (!options.check) {
  ensureInjectionExcluded()
  rmSync(injectionDir, { recursive: true, force: true })
  for (const layer of layers) {
    const source = join(REPO_ROOT, 'src', layer)
    if (!existsSync(source)) fail(`缺少源码目录: ${source}`)
    cpSync(source, join(injectionDir, layer), { recursive: true })
  }
  console.log(`apply-local: 已注入 → ${manifest.injectionDir}/{${layers.join(',')}}`)
}

// 5. 应用补丁（先全部 dry-run，再实际写入，避免半途失败留下混合状态）
if (options.check) {
  checkPatchesAgainstBaseline()
  console.log(`apply-local: --check 通过（基线 ${manifest.baseVersion}；未写入任何改动）`)
  process.exit(0)
}

for (const patch of manifest.patches) {
  const patchPath = join(PATCH_DIR, patch.file)
  if (!existsSync(patchPath)) fail(`补丁不存在: ${patch.file}`)
  try {
    git(upstream, ['apply', '--check', patchPath])
  } catch (error) {
    fail(`补丁无法干净应用（需在 patch 层适配）: ${patch.file}\n${error.stderr ?? error.message}`)
  }
  git(upstream, ['apply', patchPath])
  console.log(`apply-local: 已应用 ${patch.file}`)
}

// 6. 先落状态：补丁已写入上游，此后任何失败都必须能用 restore-local.mjs 还原
writeFileSync(STATE_FILE, `${JSON.stringify({
  upstream,
  originalRef,
  baseCommit: manifest.baseCommit,
  injectionDir: manifest.injectionDir,
  targets: manifest.patches.flatMap(patch => patch.targets),
}, null, 2)}\n`)

// 7. 校验补丁确实生效（删除类补丁可能干净应用却不再起作用）
assertPatchesApplied()

// 8. 缓存前提检查：store 若只配在 npmrc 里，会被上游的 --config.userconfig 屏蔽，只警告不阻塞
warnPnpmStorePreconditions()
console.log(`apply-local: 完成。构建结束后请运行 restore-local.mjs 还原。`)

/**
 * 在 baseCommit 的树上做只读校验：把补丁涉及的文件从该提交导出到临时目录，再在那里
 * 执行 git apply --check。这样 --check 的结论与真实应用一致（应用前必然 checkout 到基线），
 * 又完全不触碰上游工作区。
 */
function checkPatchesAgainstBaseline() {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-patch-check-'))
  try {
    for (const patch of manifest.patches) {
      const patchPath = join(PATCH_DIR, patch.file)
      if (!existsSync(patchPath)) fail(`补丁不存在: ${patch.file}`)
      for (const target of patch.targets ?? []) {
        let content
        try {
          // 基线里没有该文件 = 补丁新增它，交给 git apply 自己创建。
          // 无 encoding：保留原始字节（换行不被 trim）；stdin/stderr 抑制：文件不存在时不刷屏。
          content = execFileSync('git', ['-C', upstream, 'show', `${manifest.baseCommit}:${target}`], { stdio: ['ignore', 'pipe', 'ignore'] })
        } catch { continue }
        const destination = join(scratch, target)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, content)
      }
      try {
        execFileSync('git', ['apply', '--check', patchPath], { cwd: scratch, stdio: 'pipe' })
      } catch (error) {
        fail(`补丁无法干净应用到基线 ${manifest.baseVersion}（需在 patch 层适配）: ${patch.file}\n${error.stderr?.toString().trim() ?? error.message}`)
      }
      console.log(`apply-local: 基线校验通过 ${patch.file}`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * 把注入目录写进上游 .git/info/exclude，让 apply 期间上游 git status 保持干净，
 * 避免人工 git clean/checkout 误伤注入物。restore-local.mjs 会移除这两行。
 */
function ensureInjectionExcluded() {
  const infoDir = join(upstream, '.git', 'info')
  const excludePath = join(infoDir, 'exclude')
  mkdirSync(infoDir, { recursive: true })
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (current.split('\n').includes(`${manifest.injectionDir}/`)) return
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  writeFileSync(excludePath, `${current}${separator}${INJECTION_EXCLUDE_MARKER}\n${manifest.injectionDir}/\n`)
  console.log('apply-local: 已把注入目录加入上游 .git/info/exclude')
}

/**
 * 上游构建用 --config.userconfig=<空文件> 屏蔽 ~/.npmrc，因此 0001 补丁让 pnpm 走默认 store 之后，
 * 只有 pnpm 的全局配置（pnpm config set --location=global）才保证生效。若全局没有 store-dir，
 * store 会回落到默认位置（可能跨盘，丢硬链接）。这里只警告，不阻塞构建。
 */
function warnPnpmStorePreconditions() {
  let globalStore
  try {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    globalStore = execFileSync(pnpm, ['config', 'get', 'store-dir', '--location=global'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return // 找不到 pnpm 或读取失败：静默跳过，不阻塞
  }
  if (globalStore === '' || globalStore === 'undefined') {
    console.warn('apply-local: 警告——pnpm 全局配置里没有 store-dir。')
    console.warn('apply-local: 上游构建会用 --config.userconfig=<空文件> 屏蔽 ~/.npmrc，store 可能回落到默认位置（跨盘会失去硬链接）。')
    console.warn('apply-local: 建议：pnpm config set store-dir <路径> --location=global')
  }
}

/**
 * 校验补丁应用后的实际效果。
 * 插入类补丁失配时 git apply 会报错；但删除类补丁在官方换了写法之后可能「干净应用却不再生效」，
 * 因此每个补丁在 manifest 的 assert 里声明必须存在的片段（require）与必须消失的片段（forbid）。
 */
function assertPatchesApplied() {
  for (const patch of manifest.patches) {
    const rule = patch.assert
    if (rule === undefined) continue
    const target = join(upstream, rule.file)
    if (!existsSync(target)) fail(`生效断言找不到目标文件: ${rule.file}`)
    const text = readFileSync(target, 'utf8')
    for (const snippet of rule.require ?? []) {
      if (!text.includes(snippet)) fail(`补丁未生效（缺少预期片段）: ${patch.file} → ${rule.file}: ${snippet}`)
    }
    for (const snippet of rule.forbid ?? []) {
      if (text.includes(snippet)) fail(`补丁未生效（应被移除的片段仍在）: ${patch.file} → ${rule.file}: ${snippet}`)
    }
    console.log(`apply-local: 已校验生效 ${patch.file}`)
  }
}

/**
 * 让上游的 .desktop-build 指向仓库内的缓存目录。
 * 上游把构建产物、pnpm store、Node 归档都放在 APP_ROOT/.desktop-build；重定向后
 * 缓存统一落在 <repo>/.cache/desktop-build，既集中管理又不会被 git 跟踪。
 * @param linkPath - 上游期望的构建目录（将成为 junction）
 * @param targetPath - 仓库内的真实缓存目录
 */
function ensureBuildRootLink(linkPath, targetPath) {
  mkdirSync(targetPath, { recursive: true })
  const stat = lstatSync(linkPath, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) {
    if (realpathSync.native(linkPath) !== realpathSync.native(targetPath)) {
      fail(`${linkPath} 已指向其他位置，请先手工处理`)
    }
    console.log('apply-local: 构建目录已指向仓库缓存')
    return
  }
  if (stat?.isDirectory()) {
    // 已有普通目录：先把内容迁入缓存区，避免丢弃既有构建产物
    const kept = []
    for (const entry of readdirSync(linkPath)) {
      const to = join(targetPath, entry)
      if (existsSync(to)) { kept.push(entry); continue }
      cpSync(join(linkPath, entry), to, { recursive: true })
    }
    rmSync(linkPath, { recursive: true, force: true })
    console.log('apply-local: 已把既有 .desktop-build 迁入仓库缓存')
    // 同名条目不能静默丢弃：缓存区版本更可能是长期缓存，保留它但必须报出来
    if (kept.length > 0) {
      console.log(`apply-local: 以下条目在缓存区已存在，保留缓存区版本、未覆盖: ${kept.join(', ')}`)
    }
  }
  symlinkSync(targetPath, linkPath, 'junction')
  console.log('apply-local: 构建目录已重定向 → .cache/desktop-build')
}
