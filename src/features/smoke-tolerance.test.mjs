/**
 * 实现层单测：`node --test src/features/smoke-tolerance.test.mjs`
 *
 * 同时覆盖一层隐式契约：本文件 import 实现层、实现层 import `../adaptator/smoke.mjs`——
 * 该相对路径在仓库内（`src/`）与注入后（源仓库的 `apps/desktop/local/`）指向同一结构，两层必须始终是兄弟目录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadOrSkip, smokeSkipLine } from './smoke-tolerance.mjs'

const SKIP_LINE = 'runtime-payload-smoke: fs-ext absent (superseded by node-addon-system); skipped\n'

test('被容忍的检查项返回官方格式的跳过提示', () => {
  assert.equal(smokeSkipLine('fs-ext'), SKIP_LINE)
})

test('未被容忍的检查项返回 null', () => {
  assert.equal(smokeSkipLine('koffi'), null)
})

test('未知检查项返回 null（补丁里标识写错时不静默跳过）', () => {
  assert.equal(smokeSkipLine('fs-ecxt'), null)
})

test('loadOrSkip：模块可加载时原样返回', () => {
  const module = { seekSync: () => 2 }
  assert.equal(loadOrSkip('fs-ext', () => module), module)
})

test('loadOrSkip：加载失败且被容忍时输出提示并返回 null', t => {
  const write = t.mock.method(process.stdout, 'write', () => true)
  assert.equal(loadOrSkip('fs-ext', () => { throw new Error('MODULE_NOT_FOUND') }), null)
  assert.equal(write.mock.callCount(), 1)
  assert.deepEqual(write.mock.calls[0].arguments, [SKIP_LINE])
})

test('loadOrSkip：加载失败且不被容忍时原样抛错', () => {
  assert.throws(() => loadOrSkip('koffi', () => { throw new Error('MODULE_NOT_FOUND') }), /MODULE_NOT_FOUND/u)
})
