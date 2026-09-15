/**
 * 适配层单测：固定上游 payload smoke 的形态。
 *
 * 上游文件是 `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs`（由 `scripts/prepare-dsh.ts`
 * 用打包后的 runtime 目录直接执行，只判退出码）。本层把它的检查项清单与顺序、以及跳过提示的行
 * 格式固定下来：官方改动这两样时应当先在这里失败，而不是等到打包后的 smoke 才发现。
 *
 * 对账直接读上游 fixture（`deepseek-harness/` 不在场时跳过）。只把当前值抄一遍的测试没有守卫力：
 * 官方新增或重排检查项时它照样通过。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SMOKE_CHECKS, formatSmokeSkipLine } from './smoke.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPSTREAM_FIXTURE = join(REPOSITORY_ROOT, 'deepseek-harness', 'apps', 'desktop', 'tests', 'fixtures', 'runtime-payload-smoke.mjs')

/** 上游 fixture 的 `check*()` 函数与检查项标识的对应关系。 */
const UPSTREAM_FUNCTIONS = Object.freeze({
  checkFsExt: 'fs-ext',
  checkKoffi: 'koffi',
  checkSharp: 'sharp',
  checkHtml: 'html',
  checkPty: 'pty',
})

/**
 * 按出现顺序取出上游 fixture 里的 `check*()` 调用（函数定义行不算）。
 * @param text - 上游 fixture 全文。
 * @returns 调用到的函数名列表。
 */
function upstreamChecks(text) {
  return text.split('\n')
    .filter(line => !/^\s*(?:async\s+)?function\s/u.test(line))
    .flatMap(line => line.match(/(?:await\s+)?(check[A-Z][A-Za-z]*)\(/u)?.slice(1) ?? [])
}

test('检查项清单不可变，调用方不能就地改写', () => {
  assert.ok(Object.isFrozen(SMOKE_CHECKS))
})

test('检查项清单与顺序以上游 fixture 为准', t => {
  if (!existsSync(UPSTREAM_FIXTURE)) {
    t.skip('上游 clone 不在场：clone 到 deepseek-harness/ 后此断言生效')
    return
  }
  const upstream = upstreamChecks(readFileSync(UPSTREAM_FIXTURE, 'utf8'))
  assert.ok(upstream.length > 0, '未能从上游 fixture 提取 check*() 调用：官方改了形态，需人工核对本层')
  assert.deepEqual(upstream.map(name => UPSTREAM_FUNCTIONS[name] ?? `未知检查项 ${name}`), [...SMOKE_CHECKS])
})

test('跳过提示是能直接写 stdout 的一行：前缀 + 标识 + 原因 + 换行', () => {
  assert.equal(
    formatSmokeSkipLine('fs-ext', 'superseded by node-addon-system'),
    'runtime-payload-smoke: fs-ext absent (superseded by node-addon-system); skipped\n',
  )
})

test('标识原样出现，不做改写', () => {
  for (const checkId of SMOKE_CHECKS) {
    const line = formatSmokeSkipLine(checkId, 'reason')
    assert.ok(line.startsWith('runtime-payload-smoke: '))
    assert.ok(line.includes(` ${checkId} absent (`))
    assert.ok(line.endsWith('); skipped\n'))
  }
})
