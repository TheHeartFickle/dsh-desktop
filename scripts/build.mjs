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
 * `--apply-only`（`npm run apply`）在第 5 步之后停下：只把功能层、适配层与 patch 落到源仓库，
 * 不执行第 6 步的构建指令。前五步与完整构建逐字相同，所以它是「先摆好现场，再自己跑构建或调试」的入口。
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
/** 只做第 1–5 步（复制 + 打 patch），不执行配置里的构建指令。 */
const APPLY_ONLY = process.argv.includes('--apply-only')
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

/** 读构建日志尾部若干行，失败时给人看。 */
function tailLog(lines = 25) {
  if (!existsSync(LOG_PATH)) return ''
  return readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
}

/**
 * 跑一条辅助命令（git clone / pnpm install），输出追加进构建日志：长输出不进管道（决策 10）。
 * @param command - 可执行文件。
 * @param args - 参数列表。
 * @param options - 传给 `spawnSync` 的其余选项（`cwd` 等）。
 */
function runTool(command, args, options = {}) {
  const fd = openSync(LOG_PATH, 'a')
  const result = spawnSync(command, args, { ...options, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  const code = result.status ?? 1
  if (result.error !== undefined || code !== 0) {
    fail(`${command} ${args.join(' ')} 失败（退出码 ${code}）\n--- 日志尾部 ---\n${tailLog()}`)
  }
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

// 日志先初始化：取源仓库与装依赖的输也要落盘（长输出不进管道，见决策 10）
mkdirSync(LOG_DIR, { recursive: true })
rmSync(LOG_PATH, { force: true })
step(`构建日志 ${relative(REPO_ROOT, LOG_PATH)}`)

// ---------------------------------------------------------------- 2. 取源仓库并校验提交

if (!existsSync(join(upstream, '.git'))) {
  // 源仓库不随本仓库跟踪：新机器 clone 本仓库后，这里按配置给的地址把它取回来。
  if (typeof config.upstreamUrl !== 'string' || config.upstreamUrl === '') {
    fail(`源仓库不是 git 仓库: ${upstream}（配置缺 upstreamUrl，无法自动取回）`)
  }
  step(`源仓库缺失，从 ${config.upstreamUrl} 取回`)
  runTool('git', ['clone', config.upstreamUrl, upstream], { cwd: REPO_ROOT })
}
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

// 依赖也由流程保证：新机器上这一步把上游依赖装上，之后才谈得上构建
if (!existsSync(join(upstream, 'node_modules'))) {
  step('源仓库依赖缺失，执行 pnpm install --frozen-lockfile')
  runTool(process.execPath, [resolvePnpmEntry(), 'install', '--frozen-lockfile'], { cwd: upstream })
}

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

// ---------------------------------------------------------------- 到此为止（--apply-only）

if (APPLY_ONLY) {
  step(`--apply-only：已复制并打上全部 patch，按配置跳过构建指令 ${config.build.map(entry => entry.command.join(' ')).join('、')}`)
  console.log('build: 完成')
  process.exit(0)
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
step(`pnpm 入口 ${pnpmEntry}`)

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
