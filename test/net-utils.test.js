import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstProxy } from '../src/main/net-utils.js'

test('firstProxy 返回第一个可用代理', () => {
  assert.deepEqual(firstProxy('PROXY 127.0.0.1:8080; DIRECT'), { scheme: 'proxy', hostPort: '127.0.0.1:8080' })
  assert.deepEqual(firstProxy('SOCKS5 127.0.0.1:1080'), { scheme: 'socks5', hostPort: '127.0.0.1:1080' })
})

test('firstProxy 无代理时返回 null', () => {
  assert.equal(firstProxy('DIRECT'), null)
  assert.equal(firstProxy(''), null)
})
