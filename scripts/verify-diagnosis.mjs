#!/usr/bin/env node
/**
 * 诊断链验证（reproduce 第 6 节「阶段 5（诊断链，端到端）」）。
 *
 * 验什么：启动失败时，**启动页上究竟显示什么**。
 *   - 命中诊断规则 → 阶段标题 + 下一步 + 原始错误串（`diagnoseStartupFailure` → `formatDiagnosis`）
 *   - 未命中规则   → 退回原始错误串（诊断只做加法，不挡真相，决策 25）
 *
 * 为什么读文件就等于读页面：官方启动页把文案写进 `<pre id="error">` 的 `textContent`：
 *   `document.querySelector('#error').textContent = failed ? state.message : ''`
 * 而 `state.message` 就是 `showStartupError` 赋给 `pageError` 的那份文案。本仓库的 diag 接线把
 * 「阶段 + 该阶段文案」写进 `DSH_DESKTOP_DIAGNOSTIC_FILE`，所以 `phase=error` 那行的内容
 * 即等价于 `<pre id="error">` 的内容。
 *
 * 为什么每轮一个场景：Electron 单实例锁（`apps/desktop/src/single-instance.ts`）让第二次启动
 * 直接 `application.quit()` 并聚焦已有窗口，所以一轮内只能观察一个失败场景。
 *
 * **本脚本不终止任何进程**（有意如此）：观察完即退出，应用窗口留给使用者关闭。
 *
 * 用法（每跑一个场景前需关掉上一个窗口）：
 *   node scripts/verify-diagnosis.mjs --profile none      # 只启动一次，建立健康 profile（第一步）
 *   node scripts/verify-diagnosis.mjs --profile manifest  # profile manifest 损坏 → 应命中 config 阶段
 *   node scripts/verify-diagnosis.mjs --profile state     # runtime state 损坏 → 应命中 config 阶段
 *   node scripts/verify-diagnosis.mjs --profile unknown   # 未命中任何规则 → 应退回原始错误串
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const UNPACKED = join(REPO_ROOT, 'deepseek-harness', 'apps', 'desktop', '.desktop-build',
  'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked')
const EXECUTABLE = join(UNPACKED, 'DeepSeek Harness.exe')
const HOME = join(REPO_ROOT, '.cache', 'diagnosis-home')
const DIAGNOSTIC = join(HOME, 'diagnostic.log')
const PROFILE = join(HOME, 'profiles', 'desktop')

const SCENARIOS = {
  none: { label: '不破坏（建立健康 profile）', stage: 'application-page' },
  manifest: {
    label: 'profile manifest 损坏',
    stage: 'error-detail',
    hit: true,
    file: join(PROFILE, 'package.json'),
    content: JSON.stringify({ name: 'broken' }, undefined, 2),
    expect: ['profile 配置失败', 'invalid desktop profile manifest'],
  },
  state: {
    label: 'runtime state 损坏',
    stage: 'error-detail',
    hit: true,
    file: join(PROFILE, 'desktop-runtime-state.json'),
    content: JSON.stringify({ schemaVersion: 999 }, undefined, 2),
    expect: ['profile 配置失败', 'invalid runtime state'],
  },
  unknown: {
    label: '未命中任何规则',
    stage: 'error-detail',
    hit: false,
    file: join(PROFILE, 'pnpm-workspace.yaml'),
    content: 'not: a: valid: yaml: here\n',
    expect: [],
  },
}

const args = process.argv.slice(2)
const scenarioName = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'none'
const scenario = SCENARIOS[scenarioName]
if (scenario === undefined) {
  console.error(`verify-diagnosis: 未知场景 ${JSON.stringify(scenarioName)}；可选 ${Object.keys(SCENARIOS).join(' / ')}`)
  process.exit(1)
}
if (!existsSync(EXECUTABLE)) {
  console.error(`verify-diagnosis: 打包产物不存在: ${EXECUTABLE}（先跑 node scripts/build.mjs）`)
  process.exit(1)
}

const sleep = ms => new Promise(settle => setTimeout(settle, ms))
const readDiagnostic = () => existsSync(DIAGNOSTIC) ? readFileSync(DIAGNOSTIC, 'utf8') : ''

/**
 * 等诊断文件出现某阶段。阶段名后必须是行尾或空格 —— 否则 `error` 会被 `error-detail` 子串提前命中。
 * @param phase - 阶段名。
 * @param timeoutMs - 超时毫秒数。
 * @returns 诊断文件全文与是否命中（等待与断言共用同一次匹配，避免两处正则不一致造成假失败）。
 */
async function waitForPhase(phase, timeoutMs) {
  const pattern = new RegExp(`phase=${phase}(?: |$)`, 'm')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = readDiagnostic()
    if (pattern.test(text)) return { text, found: true }
    await sleep(500)
  }
  return { text: readDiagnostic(), found: false }
}

mkdirSync(HOME, { recursive: true })

if (scenarioName !== 'none') {
  if (!existsSync(PROFILE)) {
    console.error(`verify-diagnosis: profile 不存在（${PROFILE}）。先跑一次 --profile none 建立它。`)
    process.exit(1)
  }
  writeFileSync(scenario.file, scenario.content)
  console.log(`已人为破坏：${scenario.file.replace(REPO_ROOT, '.')}`)
  if (existsSync(DIAGNOSTIC)) writeFileSync(DIAGNOSTIC, '')
}

console.log(`场景：${scenario.label}`)
console.log(`DSH_HOME：${HOME}（完全隔离，不碰真实 home）`)
console.log(`等待阶段：phase=${scenario.stage}`)
console.log('启动产物…（本脚本不终止它；观察完请自行关闭窗口）')

const child = spawn(EXECUTABLE, [], {
  cwd: UNPACKED,
  env: {
    ...process.env,
    DSH_HOME: HOME,
    DSH_DESKTOP_DIAGNOSTIC_FILE: DIAGNOSTIC,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  },
  stdio: 'ignore',
  detached: true,
})
child.unref()
child.on('error', error => console.error('verify-diagnosis: 启动失败', error))

const { text, found } = await waitForPhase(scenario.stage, 180000)
const lines = text.trim() === '' ? [] : text.trim().split(/\r?\n/u)
const errorLine = lines.find(line => /phase=error(?: |$)/u.test(line)) ?? ''

console.log('\n=== 诊断文件 ===')
for (const line of lines) console.log(`  ${line}`)

const checks = []
const check = (name, passed) => {
  checks.push({ name, passed })
  console.log(`  ${passed ? '✅' : '❌'} ${name}`)
}

console.log('\n=== 判据 ===')
if (scenarioName === 'none') {
  check('到达应用页（profile 已建立）', found)
} else {
  const rendered = errorLine.replace(/^.*?phase=error(?: |$)/u, '').trim()
  console.log('\n启动页文案（`phase=error` 行的内容，等价于 `<pre id="error">`）：')
  console.log(rendered === '' ? '  （空）' : rendered.split('\n').map(line => `  ${line}`).join('\n'))

  check('失败时进入 error 阶段（诊断链已跑）', found)
  check('`phase=error` 行带上了启动页文案', rendered !== '')
  if (scenario.hit) {
    check('启动页出现阶段标题「profile 配置失败」', rendered.includes('profile 配置失败'))
    check('启动页给出可执行的下一步', /重置 Desktop|禁用全部第三方插件|重试启动|重新安装/u.test(rendered))
    check('启动页保留原始错误串（诊断只做加法）', scenario.expect.every(token => rendered.includes(token)))
  } else {
    check('未命中规则时退回原始错误串（不出现诊断标题）', !rendered.includes('profile 配置失败') && rendered !== '')
  }
}

const failed = checks.filter(entry => !entry.passed)
console.log(`\nverify-diagnosis: ${failed.length === 0 ? '通过' : `失败 ${failed.length} 项`}`)
console.log('提醒：应用窗口仍在运行，请自行关闭后再跑下一个场景。')
process.exit(failed.length === 0 ? 0 : 1)
