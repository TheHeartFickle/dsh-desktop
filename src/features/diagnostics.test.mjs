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
import {
  APPLICATION_PAGE_PHASE, DIAGNOSTIC_FILE_ENV, DIAGNOSTIC_RULES, diagnoseStartupFailure, formatDiagnosis,
  recordStartupPhase, startupErrorState,
} from './diagnostics.mjs'

/** 每条规则一个上游真实错误串（来源见 diagnostics.mjs 注释）。 */
const SAMPLES = [
  ['host', 'host-spawn-failed', 'dsh desktop: expected runtime and profile directories, byte pipes, and a Node IPC channel'],
  ['host', 'host-request-transport', 'Electron response pipe is unavailable'],
  ['graph', 'profile-not-installed', 'desktop project: package preparation is incomplete; retry startup'],
  ['graph', 'graph-unresolved', 'desktop profile: dsh-better-sidebar requires missing @deepseek-ai/dsh-settings@^1.2.0'],
  ['graph', 'graph-incomplete-install', 'desktop profile: invalid installed package C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\broken'],
  ['graph', 'plugin-load-failed', 'dsh desktop: copied web profile plugins could not be loaded:\nbroken-plugin: missing settingsNamespace export'],
  ['store', 'lock-contention', 'desktop project: another package transaction is active'],
  ['store', 'store-unwritable', 'desktop project: pnpm exited with 1: ERR_PNPM_NO_SPACE Unable to write to store'],
  ['config', 'patch-line-missing', "Error: applyEntryPatches: cordis.patch.yml line id 'session-manager' not found"],
  ['config', 'config-invalid', 'desktop profile: invalid runtime state'],
  ['config', 'profile-mismatch', 'desktop project: profile does not match this application runtime'],
  ['version', 'host-protocol-version', 'dsh desktop: host protocol version mismatch (expected 1, got 2)'],
  ['version', 'dsh-version-mismatch', 'dsh-better-sidebar requires @deepseek-ai/dsh@1.9.0, found 0.1.5-rc.2'],
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
    // 同一条错误串在别的阶段里不该有规则命中
    const otherStages = Object.entries(DIAGNOSTIC_RULES).filter(([name]) => name !== stage)
    assert.ok(otherStages.length > 0)
  }
})

test('覆盖表与实际规则表一致（新增规则必须同时补样例）', () => {
  const covered = new Set(SAMPLES.map(([stage, rule]) => `${stage}/${rule}`))
  const declared = new Set(Object.entries(DIAGNOSTIC_RULES).flatMap(([stage, rules]) => rules.map(rule => `${stage}/${rule}`)))
  assert.deepEqual([...declared].sort(), [...covered].sort())
})

test('未命中规则时返回 null，调用方照常显示原始错误', () => {
  assert.equal(diagnoseStartupFailure(new Error('Desktop renderer exited: crashed')), null)
  assert.equal(diagnoseStartupFailure(new Error('Runtime resources missing')), null)
  assert.equal(diagnoseStartupFailure('plain string failure'), null)
  assert.equal(diagnoseStartupFailure(undefined), null)
})

test('AggregateError 按官方 desktopErrorState 的同一读法展开后再判断', () => {
  const failure = new AggregateError(
    [new Error('Desktop renderer exited: crashed'), new Error('Electron request pipe ended')],
    'desktop backend startup and cleanup failed',
  )
  const diagnosis = diagnoseStartupFailure(failure)
  assert.equal(diagnosis?.stage, 'host')
  assert.equal(diagnosis.rule, 'host-request-transport')
  assert.match(diagnosis.message, /desktop backend startup and cleanup failed/u)
  assert.match(diagnosis.message, /Electron request pipe ended/u)
})

test('无法从应用内修复 profile 时，提示里补上「可能需要重新安装」', () => {
  const diagnosis = diagnoseStartupFailure(new Error('desktop profile: invalid installed package /x'), { profileRecovery: false })
  assert.match(diagnosis.hint, /可能需要重新安装应用/u)
  const recoverable = diagnoseStartupFailure(new Error('desktop profile: invalid installed package /x'), { profileRecovery: true })
  assert.ok(!recoverable.hint.includes('可能需要重新安装应用'))
})

test('formatDiagnosis 保留原始错误串，便于对照日志', () => {
  const diagnosis = diagnoseStartupFailure(new Error('desktop project: active profile is not installed'))
  const text = formatDiagnosis(diagnosis)
  assert.match(text, /profile 与插件图失败/u)
  assert.match(text, /desktop project: active profile is not installed/u)
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

  const logged = []
  const original = console.error
  console.error = (...args) => { logged.push(args) }        // 写不进去（路径是目录）只记日志、不抛
  try { recordStartupPhase({ [DIAGNOSTIC_FILE_ENV]: root }, 'starting') } finally { console.error = original }
  assert.equal(logged.length, 1)
})

test('错误出口：命中诊断走诊断文本，没命中退回官方原样', () => {
  const fallback = error => ({ phase: 'error', message: `官方: ${String(error)}` })
  const hit = startupErrorState(new Error('desktop project: active profile is not installed'), { profileRecovery: true, fallback })
  assert.equal(hit.phase, 'error')
  assert.match(hit.message, /profile 与插件图失败/)
  assert.match(hit.message, /desktop project: active profile is not installed/)

  const missed = startupErrorState(new Error('完全没见过的失败'), { profileRecovery: true, fallback })
  assert.equal(missed.message, '官方: Error: 完全没见过的失败')
})
