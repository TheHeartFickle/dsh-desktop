#!/usr/bin/env node
/**
 * 构建入口：读 `src/build.config.json`，按六步执行。
 *
 *   1. 读配置
 *   2. 校验源仓库存在且是 git 仓库；校验 checkout 提交存在（不存在 → 报错退出）
 *   3. 清理工作区（丢弃未提交改动与未跟踪文件，不动 ref / 远程 / 历史）→ checkout 到指定提交
 *   4. 按 copy 映射复制文件到源仓库指定位置
 *   5. 按 patches 顺序应用 git patch（先 --check 再 apply）
 *   6. 按 build 列表在源仓库执行构建指令
 *
 * 本脚本不含任何源仓库脚本名、路径、提交号、镜像地址的硬编码 —— 这些都在配置里。
 * 路径基准：`upstream` 相对仓库根；`copy[].from`、`patches[].file` 相对 `src/`；
 * `copy[].to`、`patches[].target`、`build[].cwd` 相对源仓库根。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const SRC_DIR = join(REPO_ROOT, 'src')
const CONFIG_PATH = join(SRC_DIR, 'build.config.json')
const LOG_DIR = join(REPO_ROOT, '.cache', 'build')
const LOG_PATH = join(LOG_DIR, 'build.log')

function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}

function git(args, options = {}) {
  return execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function step(title) {
  console.log(`build: ${title}`)
}

// ---------------------------------------------------------------- 1. 读配置

if (!existsSync(CONFIG_PATH)) fail(`缺少配置 ${CONFIG_PATH}`)
let config
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
} catch (error) {
  fail(`配置不是合法 JSON: ${error.message}`)
}
for (const key of ['upstream', 'checkout', 'copy', 'patches', 'build']) {
  if (config[key] === undefined) fail(`配置缺少字段 ${key}`)
}

const upstream = resolve(REPO_ROOT, config.upstream)

// ---------------------------------------------------------------- 2. 校验源仓库与提交

if (!existsSync(join(upstream, '.git'))) fail(`源仓库不是 git 仓库: ${upstream}`)
try {
  git(['cat-file', '-e', `${config.checkout}^{commit}`])
} catch {
  fail(`配置声明的提交不存在: ${config.checkout}`)
}
step(`源仓库 ${relative(REPO_ROOT, upstream) || '.'}，目标提交 ${config.checkout.slice(0, 12)}`)

// ---------------------------------------------------------------- 3. 清理并 checkout

git(['reset', '--hard', 'HEAD'])
git(['clean', '-fd'])
git(['checkout', config.checkout])
step(`已清理工作区并 checkout 到 ${config.checkout.slice(0, 12)}`)

// ---------------------------------------------------------------- 4. 复制

/** 极简 glob：只支持 `*` 通配（配置里用的都是 `*.test.mjs` 这类），避免为此引入依赖。 */
function matchesAny(name, patterns) {
  return (patterns ?? []).some(pattern => {
    const escaped = pattern.replaceAll('.', '\\.').replaceAll('*', '.*')
    return new RegExp(`^${escaped}$`, 'u').test(name)
  })
}

for (const entry of config.copy) {
  const from = resolve(SRC_DIR, entry.from)
  const to = resolve(upstream, entry.to)
  if (!existsSync(from)) fail(`copy.from 不存在: ${entry.from}`)
  mkdirSync(dirname(to), { recursive: true })
  const stats = statSync(from)
  if (stats.isDirectory()) {
    cpSync(from, to, {
      recursive: true,
      force: true,
      filter: source => !matchesAny(source.split(/[\\/]/u).pop() ?? '', entry.exclude),
    })
  } else {
    cpSync(from, to, { force: true })
  }
  step(`已复制 ${entry.from} → ${entry.to}`)
}

// ---------------------------------------------------------------- 5. 打 patch

for (const entry of config.patches) {
  const patchPath = resolve(SRC_DIR, entry.file)
  if (!existsSync(patchPath)) fail(`patch 不存在: ${entry.file}`)
  if (!existsSync(join(upstream, entry.target))) fail(`patch 目标不存在: ${entry.target}`)
  try {
    git(['apply', '--check', patchPath])
  } catch (error) {
    fail(`patch 无法应用（需按源仓库改动适配）: ${entry.file}\n${error.stderr?.toString().trim() ?? error.message}`)
  }
  git(['apply', patchPath])
  step(`已应用 ${entry.file} → ${entry.target}`)
}

// ---------------------------------------------------------------- 6. 构建

/** 解析与源仓库 packageManager 声明一致的 pnpm 入口（package-target 之类脚本要求 npm_execpath）。 */
function resolvePnpmEntry() {
  const declared = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8')).packageManager ?? ''
  const version = declared.replace(/^pnpm@/u, '')
  const candidates = [
    join(process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'node', 'corepack'),
      'v1', 'pnpm', version, 'bin', 'pnpm.cjs'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ]
  const entry = candidates.find(candidate => candidate !== '' && existsSync(candidate))
  if (entry === undefined) fail(`找不到 pnpm 入口（源仓库声明 ${declared}），请安装对应的 pnpm`)
  return entry
}

/**
 * 算一条构建指令的输入键：pin + 该指令本身 + 工具链清单 + 参与该指令的注入物内容。
 *
 * 注入物默认**全部**算输入；配置里用 `ignoreTargets` 显式忽略的路径不算（例如页面/资源文件不参与编译）。
 * 因此漏项只可能朝"多算"方向：新加的 copy/patch 只要没被声明忽略，就会让键变化、白白重做一次，
 * 而不会出现"输入变了却命中"的陈旧产物。
 */
function buildStageKey(entry) {
  const ignored = entry.ignoreTargets ?? []
  const ignoredBy = target => ignored.some(prefix => target === prefix || target.startsWith(`${prefix}/`))
  const hash = createHash('sha256')
  const absorbFile = (absolute, label) => {
    hash.update(`${label.replaceAll('\\', '/')}\u0000${readFileSync(absolute)}\u0000`)
  }
  const absorbTree = (absolute, prefix) => {
    for (const name of readdirSync(absolute).sort()) {
      const child = join(absolute, name)
      const childStats = statSync(child)
      if (childStats.isDirectory()) absorbTree(child, `${prefix}/${name}`)
      else if (childStats.isFile()) absorbFile(child, `${prefix}/${name}`)
    }
  }
  hash.update(`checkout\u0000${config.checkout}\u0000`)
  hash.update(`command\u0000${JSON.stringify([entry.cwd, entry.command, entry.env ?? {}, ignored])}\u0000`)
  for (const manifest of ['package.json', 'pnpm-lock.yaml']) {
    const path = join(upstream, manifest)
    if (existsSync(path)) absorbFile(path, manifest)
  }
  for (const copy of config.copy) {
    if (ignoredBy(copy.to)) continue
    const from = resolve(SRC_DIR, copy.from)
    if (!existsSync(from)) continue
    const stats = statSync(from)
    if (stats.isDirectory()) absorbTree(from, `copy:${copy.to}`)
    else absorbFile(from, `copy:${copy.to}`)
  }
  for (const patch of config.patches) {
    if (ignoredBy(patch.target)) continue
    const file = resolve(SRC_DIR, patch.file)
    if (existsSync(file)) absorbFile(file, `patch:${patch.target}`)
  }
  return hash.digest('hex')
}

const pnpmEntry = resolvePnpmEntry()
mkdirSync(LOG_DIR, { recursive: true })
rmSync(LOG_PATH, { force: true })
step(`构建日志 ${relative(REPO_ROOT, LOG_PATH)}（pnpm 入口 ${pnpmEntry}）`)

for (const entry of config.build) {
  const cwd = resolve(upstream, entry.cwd)
  const [command, ...args] = entry.command
  if (command === undefined) fail('build.command 为空')
  // `npm_execpath`、`DSH_UPSTREAM_CHECKOUT` 与 `DSH_LOCAL_BUILD_KEY` 同属环境事实：由流程按配置解析后
  // 注入，不写进配置。pin 让换提交后所有缓存失效；构建键按"忽略页面/资源注入物"的规则算，供
  // `build:official` 这类阶段判定能否跳过。
  const environment = {
    ...process.env,
    ...entry.env,
    npm_execpath: pnpmEntry,
    DSH_UPSTREAM_CHECKOUT: config.checkout,
    DSH_LOCAL_BUILD_KEY: buildStageKey(entry),
  }
  const fd = openSync(LOG_PATH, 'a')
  const result = spawnSync(command, args, { cwd, env: environment, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  const code = result.status ?? 1
  if (result.error !== undefined || code !== 0) {
    const tail = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n').slice(-25).join('\n') : ''
    fail(`构建指令失败（cwd=${entry.cwd}，退出码 ${code}）\n--- 日志尾部 ---\n${tail}`)
  }
  step(`已执行 ${entry.command.join(' ')}`)
}

console.log('build: 完成')
