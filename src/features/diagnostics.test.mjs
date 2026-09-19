/**
 * 实现层单测：`node --test "src/features/*.test.mjs"`
 *
 * 关键方向：
 * 1. 每条规则能被它对应的**上游真实错误串**命中（规则失配时退回 null，不猜）；
 * 2. 规则互不可见：一个阶段的错误只由该阶段解释，不串到别的阶段；
 * 3. 未命中返回 null，调用方照常显示原始错误。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { matchStageSignal } from '../adaptator/diagnostics-signals.mjs'
import {
  APPLICATION_PAGE_PHASE, DIAGNOSTIC_FILE_ENV, DIAGNOSTIC_RULES, diagnoseStartupFailure, formatDiagnosis,
  recordStartupPhase, startupErrorState,
} from './diagnostics.mjs'

/** 每条规则一个上游真实错误串（来源见 diagnostics.mjs 注释里列的源码文件）。 */
const SAMPLES = [
  ['version', 'dsh-version-mismatch', 'dsh-better-sidebar requires @deepseek-ai/dsh@0.1.9, found 0.1.6-alpha.2'],
  ['host', 'host-process-failed', 'dsh desktop host exited with 1'],
  ['host', 'host-unavailable', 'Desktop Host is unavailable'],
  ['host', 'host-preparation-failed', 'dsh: host preparation failed: ENOENT: no such file or directory'],
  ['host', 'package-manager-unavailable', 'desktop profile: pnpm install could not run (spawn EPERM)'],
  ['host', 'runtime-install-failed', 'primary runtime: installation path is a filesystem link: C:\\x\\dsh-primary-runtime'],
  ['host', 'window-load-failed', 'Desktop page failed to load: dsh-app://app/ (-6: ERR_CONNECTION_REFUSED)'],
  ['config', 'patch-line-missing', "dsh: failed to parse patches C:\\x\\cordis.patch.yml: cordis.patch.yml line id 'session-manager' not found"],
  ['config', 'profile-lock', 'desktop project: another profile operation is active'],
  ['config', 'profile-files-invalid', 'dsh: profile manifest C:\\x\\.dsh\\profiles\\desktop\\package.json must hold a JSON object'],
  ['config', 'profile-cleanup-refused', 'desktop profile cleanup: package parent is not a real directory: C:\\x'],
  ['graph', 'graph-unresolved', 'dsh: cannot resolve profile bundle "dsh-better-sidebar" from the dsh installation or C:\\x\\.dsh\\profiles\\desktop'],
  ['graph', 'graph-fallback-blocked', 'dsh: C:\\x\\.dsh\\profiles\\node_modules exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback'],
  ['graph', 'plugin-load-failed', 'dsh: plugin tree failed to load: dsh-better-sidebar (dsh-better-sidebar): pending (waiting for service: webServer)'],
  ['install', 'package-fetch-failed', 'desktop profile: pnpm install exited with 1: ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dsh-not-here: Not Found - 404'],
  ['store', 'store-unwritable', 'desktop profile: pnpm install exited with 1: ERR_PNPM_NO_SPACE Unable to write to store'],
]

test('每条规则都能被对应的上游真实错误串命中', () => {
  for (const [stage, rule, message] of SAMPLES) {
    const diagnosis = diagnoseStartupFailure(new Error(message))
    assert.ok(diagnosis !== null, `no diagnosis for ${rule}`)
    assert.equal(diagnosis.stage, stage, `${rule} landed in ${diagnosis.stage}`)
    assert.equal(diagnosis.rule, rule)
    assert.ok(diagnosis.hint.length > 10, `${rule} hint too short`)
    assert.equal(diagnosis.message, message)
  }
})

test('规则互不可见：每个样例只由自己阶段的规则解释，且不会落到别的阶段', () => {
  for (const [stage, rule, message] of SAMPLES) {
    const diagnosis = diagnoseStartupFailure(new Error(message))
    assert.equal(diagnosis.stage, stage)
    assert.equal(diagnosis.rule, rule)
    // 顺序即判据：整张信号表按顺序跑一遍，先命中的必须仍是该样例自己的规则 ——
    // 样例若同时贴合更靠前的阶段，就会被那条规则先截胡（首因原则下的串阶段）。
    const first = matchStageSignal(message)
    assert.equal(first?.stage, stage, `${rule} 被更靠前的 ${String(first?.rule)} 截胡`)
    assert.equal(first?.rule, rule)
  }
})

test('覆盖表与实际规则表一致（新增规则必须同时补样例）', () => {
  const covered = new Set(SAMPLES.map(([stage, rule]) => `${stage}/${rule}`))
  const declared = new Set(Object.entries(DIAGNOSTIC_RULES).flatMap(([stage, rules]) => rules.map(rule => `${stage}/${rule}`)))
  assert.deepEqual([...declared].sort(), [...covered].sort())
})

test('未命中规则时返回 null，调用方照常显示原始错误', () => {
  assert.equal(diagnoseStartupFailure(new Error('dsh desktop: rejected IPC from an unowned renderer')), null)
  assert.equal(diagnoseStartupFailure(new Error('Runtime resources missing')), null)
  assert.equal(diagnoseStartupFailure('plain string failure'), null)
  assert.equal(diagnoseStartupFailure(undefined), null)
})

test('AggregateError 按官方 desktopErrorState 的同一读法展开后再判断', () => {
  const failure = new AggregateError(
    [new Error('Runtime resources missing'), new Error('Desktop Host authentication failed')],
    'desktop backend startup and cleanup failed',
  )
  const diagnosis = diagnoseStartupFailure(failure)
  assert.equal(diagnosis?.stage, 'host')
  assert.equal(diagnosis.rule, 'host-unavailable')
  assert.match(diagnosis.message, /desktop backend startup and cleanup failed/u)
  assert.match(diagnosis.message, /Desktop Host authentication failed/u)
})

test('无法从应用内修复 profile 时，提示里补上「可能需要重新安装」', () => {
  const message = 'dsh: cannot resolve profile bundle "x" from the dsh installation'
  const diagnosis = diagnoseStartupFailure(new Error(message), { profileRecovery: false })
  assert.match(diagnosis.hint, /可能需要重新安装应用/u)
  const recoverable = diagnoseStartupFailure(new Error(message), { profileRecovery: true })
  assert.ok(!recoverable.hint.includes('可能需要重新安装应用'))
})

test('formatDiagnosis 保留原始错误串，便于对照日志', () => {
  const original = 'dsh: cannot resolve profile bundle "dsh-better-sidebar" from the dsh installation or C:\\x\\.dsh\\profiles\\desktop'
  const diagnosis = diagnoseStartupFailure(new Error(original))
  const text = formatDiagnosis(diagnosis)
  assert.match(text, /profile 与插件图失败/u)
  assert.match(text, /cannot resolve profile bundle/u)
  assert.ok(text.startsWith(diagnosis.title))
})

test('诊断文件的行格式、环境变量名与写失败兜底都在本层', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostics-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostic.log')

  recordStartupPhase({}, 'starting')                       // 没设环境变量：完全不写
  assert.equal(existsSync(file), false)

  recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: file }, 'starting')
  recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: file }, APPLICATION_PAGE_PHASE)
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z phase=starting$/)
  assert.equal(lines[1].endsWith(`phase=${APPLICATION_PAGE_PHASE}`), true)

  // 失败阶段带上官方文本：折成一行、可截断；冒烟按 `phase=<名>` 匹配，所以加尾巴不影响判据。
  recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: file }, 'error', 'first line\nsecond   line')
  const failure = readFileSync(file, 'utf8').trimEnd().split('\n')[2]
  assert.equal(failure.endsWith('phase=error message=first line second line'), true)
  recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: file }, 'error', '   ')
  assert.equal(readFileSync(file, 'utf8').trimEnd().split('\n')[3].endsWith('phase=error'), true)
  recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: file }, 'error', 'x'.repeat(4000))
  assert.equal(readFileSync(file, 'utf8').trimEnd().split('\n')[4].length < 2100, true)

  const logged = []
  const original = console.error
  console.error = (...args) => { logged.push(args) }        // 写不进去（路径是目录）只记日志、不抛
  try { recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: root }, 'starting') } finally { console.error = original }
  assert.equal(logged.length, 1)
})

test('错误出口：命中诊断走诊断文本，没命中退回官方原样', () => {
  const fallback = error => ({ phase: 'error', message: `官方: ${String(error)}` })
  const options = { profileRecovery: true, fallback }
  const hit = startupErrorState(new Error('dsh: cannot resolve profile bundle "x" from the dsh installation'), options)
  assert.equal(hit.phase, 'error')
  assert.match(hit.message, /profile 与插件图失败/)
  assert.match(hit.message, /cannot resolve profile bundle/)

  const missed = startupErrorState(new Error('完全没见过的失败'), options)
  assert.equal(missed.message, '官方: Error: 完全没见过的失败')
})
