import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, satisfiesNode } from '../src/main/version.js'

test('parseVersion 解析常见 Node 版本号', () => {
  assert.deepEqual(parseVersion('v22.19.0'), { major: 22, minor: 19, patch: 0, raw: 'v22.19.0' })
  assert.deepEqual(parseVersion('24.1.2'), { major: 24, minor: 1, patch: 2, raw: '24.1.2' })
})

test('parseVersion 对无效输入返回 null', () => {
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(''), null)
})

test('satisfiesNode 匹配 dsh 引擎范围', () => {
  assert.equal(satisfiesNode({ major: 22, minor: 19, patch: 0 }), true)
  assert.equal(satisfiesNode({ major: 22, minor: 18, patch: 9 }), false)
  assert.equal(satisfiesNode({ major: 23, minor: 0, patch: 0 }), false)
  assert.equal(satisfiesNode({ major: 24, minor: 0, patch: 0 }), true)
  assert.equal(satisfiesNode({ major: 25, minor: 0, patch: 0 }), true)
})
