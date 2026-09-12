/**
 * 实现层单测：`node --test "src/features/*.test.mjs"`
 *
 * 覆盖缓存的两个方向：命中时必须真的跳过（否则优化无效），任何一处输入或产物异常时必须重做
 * （否则会产出陈旧产物 —— 这是本层唯一不能出错的方向）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contentKey, reuse, reusePackedDirectory } from './build-cache.mjs'

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'build-cache-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, body) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), body)
}

/** 测试用 marker 路径；实现层不决定 marker 落在哪，由各个 patch 传被忽略目录下的绝对路径。 */
function markerPath(root, stage) {
  return join(root, '.desktop-build', 'local-cache', `${stage}.json`)
}

test('contentKey：同样的内容算出同样的键，与输入顺序无关', t => {
  const root = scratch(t)
  write(root, 'a.txt', 'a')
  write(root, 'b/c.txt', 'c')
  assert.equal(contentKey(['a.txt', 'b'], { base: root }), contentKey(['b', 'a.txt'], { base: root }))
})

test('contentKey：路径不同、内容相同也要算出不同的键（避免张冠李戴）', t => {
  const root = scratch(t)
  write(root, 'a.txt', 'same')
  write(root, 'b.txt', 'same')
  assert.notEqual(contentKey(['a.txt'], { base: root }), contentKey(['b.txt'], { base: root }))
})

test('contentKey：内容变化必须换键', t => {
  const root = scratch(t)
  write(root, 'a.txt', 'a')
  const before = contentKey(['a.txt'], { base: root })
  write(root, 'a.txt', 'b')
  assert.notEqual(before, contentKey(['a.txt'], { base: root }))
})

test('contentKey：共用前置键（extra）参与哈希，输入相同也换键', t => {
  const root = scratch(t)
  write(root, 'a.txt', 'a')
  assert.notEqual(
    contentKey(['a.txt'], { base: root, extra: 'lockfile-1' }),
    contentKey(['a.txt'], { base: root, extra: 'lockfile-2' }),
  )
  assert.equal(
    contentKey(['a.txt'], { base: root, extra: 'lockfile-1' }),
    contentKey(['a.txt'], { base: root, extra: 'lockfile-1' }),
  )
})

test('contentKey：node_modules 与 .git 不是构建输入', t => {
  const root = scratch(t)
  write(root, 'pkg/index.js', 'x')
  const before = contentKey(['pkg'], { base: root })
  write(root, 'pkg/node_modules/dep/index.js', 'y')
  write(root, 'pkg/.git/HEAD', 'z')
  assert.equal(before, contentKey(['pkg'], { base: root }))
})

test('contentKey：缺失路径按空处理，不抛错', t => {
  const root = scratch(t)
  assert.equal(contentKey(['nope'], { base: root }), contentKey([], { base: root }))
})

test('reuse：首次没有 marker 时执行 produce 并写下 marker，第二次命中并跳过', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  const key = 'k1'
  assert.equal(await reuse({ stage: 'demo', key, marker, produce: () => { produced += 1 } }), false)
  assert.equal(produced, 1)
  assert.ok(existsSync(marker))
  assert.equal(await reuse({ stage: 'demo', key, marker, produce: () => { produced += 1 } }), true)
  assert.equal(produced, 1)
})

test('reuse：produce 是异步的也要等它写完再记 marker', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let finished = false
  await reuse({
    stage: 'demo',
    key: 'k',
    marker,
    outputs: [join(root, 'out.txt')],
    produce: async () => {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      write(root, 'out.txt', 'v1')
      finished = true
    },
  })
  assert.equal(finished, true)
  const recorded = JSON.parse(readFileSync(marker, 'utf8'))
  assert.equal(recorded.outputs.length, 1)
  assert.equal(recorded.outputs[0].bytes, 2)
  assert.equal(recorded.outputs[0].path, join(root, 'out.txt'))
})

test('reuse：key 变了必须重做', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  await reuse({ stage: 'demo', key: 'k1', marker, produce: () => { produced += 1 } })
  assert.equal(await reuse({ stage: 'demo', key: 'k2', marker, produce: () => { produced += 1 } }), false)
  assert.equal(produced, 2)
})

test('reuse：上游 pin 变化时全部失效（pin 由本层混入，不需要调用方拼）', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  const options = { stage: 'demo', key: 'k', marker, produce: () => { produced += 1 } }
  const saved = process.env.DSH_UPSTREAM_CHECKOUT
  try {
    process.env.DSH_UPSTREAM_CHECKOUT = 'commit-a'
    assert.equal(await reuse(options), false)
    assert.equal(await reuse(options), true)
    process.env.DSH_UPSTREAM_CHECKOUT = 'commit-b'
    assert.equal(await reuse(options), false)
  } finally {
    if (saved === undefined) delete process.env.DSH_UPSTREAM_CHECKOUT
    else process.env.DSH_UPSTREAM_CHECKOUT = saved
  }
  assert.equal(produced, 2)
})

test('reuse：产物被改动过（摘要不符）必须重做', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  const produce = () => {
    produced += 1
    write(root, 'out.txt', 'v1')
  }
  const options = { stage: 'demo', key: 'k', marker, outputs: [join(root, 'out.txt')], produce }
  await reuse(options)
  assert.equal(await reuse(options), true)
  write(root, 'out.txt', 'truncated')
  assert.equal(await reuse(options), false)
  assert.equal(produced, 2)
})

test('reuse：产物缺了一个也必须重做', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  const produce = () => {
    produced += 1
    write(root, 'out/a.txt', 'a')
  }
  const options = { stage: 'demo', key: 'k', marker, outputs: [join(root, 'out')], produce }
  await reuse(options)
  rmSync(join(root, 'out', 'a.txt'))
  assert.equal(await reuse(options), false)
  assert.equal(produced, 2)
})

test('reuse：verify 不通过必须重做（大目录交给上游自带校验的情况）', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  let verified = false
  const options = { stage: 'demo', key: 'k', marker, produce: () => { produced += 1 }, verify: () => verified }
  assert.equal(await reuse(options), false)
  assert.equal(await reuse(options), false)
  verified = true
  assert.equal(await reuse(options), true)
  assert.equal(produced, 2)
})

test('reuse：verify 抛错（校验函数自己失败）也按未通过处理', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  let throwNow = false
  const options = {
    stage: 'demo',
    key: 'k',
    marker,
    produce: () => { produced += 1 },
    verify: () => {
      if (throwNow) throw new Error('verify blew up')
      return true
    },
  }
  assert.equal(await reuse(options), false)
  assert.equal(await reuse(options), true)
  throwNow = true
  assert.equal(await reuse(options), false)
  assert.equal(produced, 2)
})

test('reuse：verify 可以是异步的', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  let verified = false
  const options = {
    stage: 'demo',
    key: 'k',
    marker,
    produce: () => { produced += 1 },
    verify: async () => verified,
  }
  assert.equal(await reuse(options), false)
  verified = true
  assert.equal(await reuse(options), true)
  assert.equal(produced, 1)
})

test('reuse：produce 往 marker 同目录写产物时，目录必须先建好', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  const produced = join(root, '.desktop-build', 'local-cache', 'artifact.tgz')
  const options = {
    stage: 'demo',
    key: 'k',
    marker,
    outputs: [produced],
    produce: () => writeFileSync(produced, 'bytes'),
  }
  assert.equal(await reuse(options), false)
  assert.equal(await reuse(options), true)
})

test('reuse：没有键（独立运行上游脚本拿不到流程算的键）时永远重做且不写 marker', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  let produced = 0
  const options = { stage: 'demo', key: undefined, marker, produce: () => { produced += 1 } }
  assert.equal(await reuse(options), false)
  assert.equal(await reuse(options), false)
  assert.equal(produced, 2)
  assert.equal(existsSync(marker), false)
})

test('reuse：marker 内容损坏时按没有缓存处理，不抛错', async t => {
  const root = scratch(t)
  const marker = markerPath(root, 'demo')
  mkdirSync(join(root, '.desktop-build', 'local-cache'), { recursive: true })
  writeFileSync(marker, '{ this is not json')
  let produced = 0
  assert.equal(await reuse({ stage: 'demo', key: 'k', marker, produce: () => { produced += 1 } }), false)
  assert.equal(produced, 1)
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).key, 'k')
})

test('reusePackedDirectory：未命中时 pack 进缓存目录再发布，命中时直接用缓存目录发布', async t => {
  const root = scratch(t)
  const cacheDirectory = join(root, '.pack-cache', 'demo')
  const packedDirectory = join(cacheDirectory, 'packed')
  const destination = join(root, 'out')
  let produced = 0
  const options = {
    stage: 'demo',
    key: 'k',
    cacheDirectory,
    packedDirectory,
    destination,
    produce: () => {
      produced += 1
      writeFileSync(join(packedDirectory, 'a.tgz'), `tarball-${produced}`)
    },
  }
  await reusePackedDirectory(options)
  assert.equal(readFileSync(join(destination, 'a.tgz'), 'utf8'), 'tarball-1')
  rmSync(destination, { recursive: true, force: true })
  await reusePackedDirectory(options)
  assert.equal(produced, 1)
  assert.equal(readFileSync(join(destination, 'a.tgz'), 'utf8'), 'tarball-1')
})
