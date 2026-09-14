/**
 * 功能层单测：`node --test src/features/diagnostics-log.test.mjs`
 *
 * 覆盖诊断行的格式契约：调用方（`main.ts` 的 `publishBackend` 与 `showStartupError`）与
 * 读取方（`scripts/smoke-packaged.mjs`、`scripts/verify-diagnosis.mjs`）都按「一条记录一行」解析，
 * 所以格式一旦变松（例如 detail 的换行没被压平），两边的判据都会静默失效。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendDiagnosticLine, formatDiagnosticLine } from './diagnostics-log.mjs'

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z phase=starting\n$/

test('只有阶段名时是「时间戳 + phase=阶段」一行', () => {
  assert.match(formatDiagnosticLine('starting'), LINE)
})

test('带 detail 时在同一行追加，中间正好一个空格', () => {
  const line = formatDiagnosticLine('error', 'profile 配置失败')
  assert.match(line, / phase=error profile 配置失败\n$/)
  assert.equal(line.split('\n').length, 2)
})

test('detail 里的换行被压成空格，保证一条记录一行', () => {
  const line = formatDiagnosticLine('error', '第一行\n第二行\n第三行')
  assert.equal(line.split('\n').length, 2)
  assert.match(line, / phase=error 第一行 第二行 第三行\n$/)
  assert.ok(!line.slice(0, -1).includes('\n'))
})

test('空串 detail 不追加（与 undefined 一致）', () => {
  assert.equal(formatDiagnosticLine('ready', ''), formatDiagnosticLine('ready'))
})

test('appendDiagnosticLine 以追加方式写盘，多条记录可逐行解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-log-'))
  try {
    const file = join(dir, 'diagnostic.log')
    appendDiagnosticLine(file, 'starting')
    appendDiagnosticLine(file, 'error', '坏在\n这里')
    const lines = readFileSync(file, 'utf8').split('\n').filter(line => line !== '')
    assert.equal(lines.length, 2)
    assert.match(lines[0], / phase=starting$/)
    assert.match(lines[1], / phase=error 坏在 这里$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写盘失败只告警，不向上抛（诊断本身不能成为新的失败源）', () => {
  assert.doesNotThrow(() => appendDiagnosticLine(join(tmpdir(), 'no-such-dir-9f3a', 'x.log'), 'ready'))
})
