#!/usr/bin/env node
/**
 * 打包产物启动冒烟：用隔离的 DSH_HOME 启动 win-unpacked，按日志判定 Host 是否就绪，然后收尾。
 *
 * 为什么是一个脚本而不是几条命令：
 * - 打包产物是 GUI 程序，启动后不会自己退出；判定必须来自它写出的文件与日志，不能靠退出码。
 * - 长任务输出必须重定向到文件（docs/decisions.zh.md 决策 10）：这里用 stdio 重定向，不经过管道。
 * - 收尾必须按 pid 树终止：Electron 主进程与 Host 子进程是两棵树，只杀 exe 会留下 Node 子进程。
 *
 * 用法：node scripts/smoke-packaged.mjs [超时秒数]
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const UNPACKED = join(REPO_ROOT, 'deepseek-harness', 'apps', 'desktop', '.desktop-build',
  'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked')
const EXECUTABLE = join(UNPACKED, 'DeepSeek Harness.exe')
const HOME = join(REPO_ROOT, '.cache', 'smoke-home')
const LOG = join(REPO_ROOT, '.cache', 'runs', 'packaged-smoke.log')
const DIAGNOSTIC = join(HOME, 'diagnostic.log')

const timeoutSeconds = Number(process.argv[2] ?? 240)
const deadline = Date.now() + timeoutSeconds * 1000

function fail(message) {
  console.error(`smoke: ${message}`)
  process.exit(1)
}

if (!existsSync(EXECUTABLE)) fail(`打包产物不存在: ${EXECUTABLE}（先跑 node scripts/build.mjs）`)
mkdirSync(dirname(LOG), { recursive: true })
mkdirSync(HOME, { recursive: true })
rmSync(LOG, { force: true })
rmSync(DIAGNOSTIC, { force: true })

/**
 * 判定依据（两条都要满足，见 docs/reproduce.zh.md R22；打包产物是 GUI 子系统进程，没有可用 stdout，
 * 所以只看它写出的文件）：
 * - 诊断文件出现 `phase=application-page`：主进程推进到应用页的直接事实。Host 起不来时页面停在
 *   `dsh-app://shell/startup.html`，不会有这一行。
 * - profile 自包含：包清单、工作区配置、宿主包链接目录、运行时状态文件都在。
 */
const APPLICATION_PAGE_PHASE = 'phase=application-page'
const FATAL_PATTERNS = [
  /Desktop recovery resource could not be loaded/iu,
  /UnhandledPromiseRejection/iu,
  /FATAL ERROR/iu,
]

function profileComplete() {
  const profile = join(HOME, 'profiles', 'desktop')
  return ['package.json', 'pnpm-workspace.yaml', 'node_modules', 'desktop-runtime-state.json']
    .every(entry => existsSync(join(profile, entry)))
}

const fd = openSync(LOG, 'a')
// 直接 spawn 可执行文件：Node 在 Windows 会为含空格的路径加引号（经 cmd 反而被拆开）。
const child = spawn(EXECUTABLE, {
  cwd: UNPACKED,
  env: {
    ...process.env,
    DSH_HOME: HOME,
    DSH_DESKTOP_DIAGNOSTIC_FILE: DIAGNOSTIC,
    ELECTRON_ENABLE_LOGGING: '1',
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  },
  stdio: ['ignore', fd, fd],
})
closeSync(fd)

function log() {
  return existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
}

function tail(text, lines = 30) {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

function killTree() {
  spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
}

function profileEntries() {
  const profile = join(HOME, 'profiles', 'desktop')
  return existsSync(profile) ? readdirSync(profile) : []
}

let pageReached = false
let complete = false
let fatal = ''
while (Date.now() < deadline) {
  const text = log()
  fatal = FATAL_PATTERNS.map(pattern => pattern.exec(text)?.[0] ?? '').find(Boolean) ?? ''
  if (fatal !== '') break
  pageReached = pageReached || (existsSync(DIAGNOSTIC) && readFileSync(DIAGNOSTIC, 'utf8').includes(APPLICATION_PAGE_PHASE))
  complete = complete || profileComplete()
  if (pageReached && complete) break
  if (child.exitCode !== null) break
  await new Promise(settle => setTimeout(settle, 2000))
}

const text = log()
console.log(`smoke: 日志 ${LOG}`)
console.log(`smoke: DSH_HOME=${HOME}`)
console.log(`smoke: 诊断到达应用页=${pageReached} profile 自包含=${complete}`)
console.log(`smoke: profile 条目 [${profileEntries().join(', ')}]`)
killTree()
if (fatal !== '') fail(`日志命中致命模式: ${fatal}\n--- 日志尾部 ---\n${tail(text)}`)
if (!pageReached || !complete) {
  fail(`超时 ${timeoutSeconds}s 未观察到完整启动（退出码 ${String(child.exitCode)}）\n--- 日志尾部 ---\n${tail(text)}`)
}
await new Promise(settle => setTimeout(settle, 2000))
console.log(`smoke: 通过\n--- 日志尾部 ---\n${tail(text)}`)
