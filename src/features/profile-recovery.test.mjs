/**
 * 实现层单测：`node --test "src/features/*.test.mjs"`
 *
 * 四个方向都要覆盖：复制只搬 web 的第三方插件语义（内置层与本地依赖不许被搬走或被改坏）、
 * 快照回退必须回到「文件 == 快照」且快照里没有的文件要删掉、迁移记账决定这次要不要迁移、
 * 提示脚本能在假 DOM 里真的插入一个元素。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import {
  applyWebProfileCopy, copyFailureMessage, installProbeFailures, isPristineProfile, readMigrationRecord,
  recordMigrationFailure, rollbackProfile, ROLLBACK_RETRY_FAILURE, ROLLBACK_NOTICE_EN, ROLLBACK_NOTICE_ZH,
  ROLLBACK_RETRY_NOTICE, snapshotProfile, startupNoticeScript, webProfileCopyChanged, webProfileCopyPlan,
  webProfileMigration, writeMigrationRecord,
} from './profile-recovery.mjs'

const BUILTIN_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'profile-recovery-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, body) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), body)
}

function webProfile(root, options = {}) {
  const dependencies = options.dependencies ?? { 'dsh-better-sidebar': '^0.18.1', dshmarket: '^1.45.0' }
  const bundles = options.bundles ?? [...BUILTIN_BUNDLES, ...Object.keys(dependencies).filter(name => name !== 'dshmarket')]
  write(root, 'web/package.json', JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    overrides: options.overrides ?? {},
    dsh: { profile: { bundles } },
  }, undefined, 2) + '\n')
  write(root, 'web/pnpm-workspace.yaml', options.workspace ?? 'packages:\n  - .\n\nnodeLinker: hoisted\nallowBuilds:\n  node-pty: true\n')
  return join(root, 'web')
}

test('webProfileCopyPlan：空 desktop profile 搬来第三方依赖与 bundles，内置层仍在最前', t => {
  const root = scratch(t)
  const desktop = join(root, 'desktop')
  const web = webProfile(root)
  const plan = webProfileCopyPlan({ desktopProfile: desktop, webProfile: web })
  assert.deepEqual(plan.plugins, ['dsh-better-sidebar'])
  assert.deepEqual(plan.manifest.dsh.profile.bundles, [...BUILTIN_BUNDLES, 'dsh-better-sidebar'])
  assert.deepEqual(plan.manifest.dependencies, { 'dsh-better-sidebar': '^0.18.1' })
  assert.equal(plan.manifest.name, 'dsh-profile-desktop')
  assert.equal(plan.manifest.private, true)
  // 装了但没进 bundles 的插件不搬（web 的 dshmarket 就是这种状态）
  assert.equal(plan.manifest.dependencies.dshmarket, undefined)
  assert.match(plan.workspace, /allowBuilds:/u)
})

test('webProfileCopyPlan：web profile 目录不存在时返回 null（不是错误）', t => {
  const root = scratch(t)
  assert.equal(
    webProfileCopyPlan({ desktopProfile: join(root, 'desktop'), webProfile: join(root, 'web') }),
    null,
  )
})

test('webProfileCopyPlan：web 没有第三方插件时返回 null', t => {
  const root = scratch(t)
  write(root, 'web/package.json', JSON.stringify({ dsh: { profile: { bundles: BUILTIN_BUNDLES } } }))
  write(root, 'web/pnpm-workspace.yaml', 'packages:\n  - .\n')
  assert.equal(webProfileCopyPlan({ desktopProfile: join(root, 'desktop'), webProfile: join(root, 'web') }), null)
})

test('webProfileCopyPlan：已有 desktop 清单时保留它自己的依赖，不把 web 的本地依赖覆盖进去', t => {
  const root = scratch(t)
  const desktop = join(root, 'desktop')
  write(root, 'desktop/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.2' },
    dsh: { profile: { bundles: BUILTIN_BUNDLES } },
  }))
  const plan = webProfileCopyPlan({ desktopProfile: desktop, webProfile: webProfile(root) })
  assert.deepEqual(plan.manifest.dependencies, { 'dsh-better-sidebar': '^0.18.1', '@deepseek-ai/dsh': '0.1.5-rc.2' })
  assert.equal(plan.manifest.name, '@deepseek-ai/dsh-desktop-runtime')
  assert.deepEqual(plan.manifest.dsh.profile.bundles, [...BUILTIN_BUNDLES, 'dsh-better-sidebar'])
})

test('webProfileCopyPlan：desktop 的 overrides 优先，web 的补充其余键', t => {
  const root = scratch(t)
  const desktop = join(root, 'desktop')
  write(root, 'desktop/package.json', JSON.stringify({
    private: true,
    dsh: { profile: { bundles: BUILTIN_BUNDLES } },
    overrides: { 'dsh-context': '1.0.0' },
  }))
  const web = webProfile(root, { overrides: { 'dsh-context': '2.0.0', 'dsh-whale-widget': '0.2.10' } })
  const plan = webProfileCopyPlan({ desktopProfile: desktop, webProfile: web })
  assert.deepEqual(plan.manifest.overrides, { 'dsh-context': '1.0.0', 'dsh-whale-widget': '0.2.10' })
})

test('webProfileCopyPlan：清单缺少内置 bundles 前缀时显式报错（不静默搬走内置层）', t => {
  const root = scratch(t)
  write(root, 'web/package.json', JSON.stringify({ dependencies: { 'dsh-better-sidebar': '1.0.0' }, dsh: { profile: { bundles: ['dsh-better-sidebar'] } } }))
  write(root, 'web/pnpm-workspace.yaml', 'packages:\n  - .\n')
  assert.throws(() => webProfileCopyPlan({ desktopProfile: join(root, 'desktop'), webProfile: join(root, 'web') }), /built-in desktop bundles/u)
})

test('webProfileCopyPlan：只合并 web 的 allowBuilds，desktop 自己的工作区设置与已有条目不丢', t => {
  const root = scratch(t)
  const desktop = join(root, 'desktop')
  write(root, 'desktop/pnpm-workspace.yaml', [
    'packages:',
    '  - .',
    '',
    'strictDepBuilds: true',
    '',
    'allowBuilds:',
    '  node-pty: false',
    '',
  ].join('\n'))
  const web = webProfile(root, {
    workspace: [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'allowBuilds:',
      '  node-pty: true',
      '  "dsh-better-sidebar@git+https://github.com/x/y.git": true',
      '',
    ].join('\n'),
  })
  const plan = webProfileCopyPlan({ desktopProfile: desktop, webProfile: web })
  assert.match(plan.workspace, /strictDepBuilds: true/u)
  assert.match(plan.workspace, /  node-pty: false/u)
  assert.match(plan.workspace, /"dsh-better-sidebar@git\+https:\/\/github\.com\/x\/y\.git": true/u)
  assert.ok(!plan.workspace.includes('node-pty: true'))
})

test('applyWebProfileCopy：落盘后重复计算不再需要写入（幂等）', t => {
  const root = scratch(t)
  const desktop = join(root, 'desktop')
  const web = webProfile(root)
  const plan = webProfileCopyPlan({ desktopProfile: desktop, webProfile: web })
  mkdirSync(desktop, { recursive: true })
  applyWebProfileCopy(desktop, plan)
  assert.equal(readFileSync(join(desktop, 'pnpm-workspace.yaml'), 'utf8'), plan.workspace)
  const second = webProfileCopyPlan({ desktopProfile: desktop, webProfile: web })
  assert.equal(webProfileCopyChanged({ desktopProfile: desktop, plan: second }), false)
})

test('webProfileCopyChanged：web 侧新增插件后必须判定为需要写入', t => {
  const root = scratch(t)
  const desktop = join(root, 'desktop')
  const web = webProfile(root)
  const plan = webProfileCopyPlan({ desktopProfile: desktop, webProfile: web })
  mkdirSync(desktop, { recursive: true })
  applyWebProfileCopy(desktop, plan)
  const grown = webProfile(root, {
    dependencies: { 'dsh-better-sidebar': '^0.18.1', 'dsh-context': '^0.47.0' },
    bundles: [...BUILTIN_BUNDLES, 'dsh-better-sidebar', 'dsh-context'],
  })
  const next = webProfileCopyPlan({ desktopProfile: desktop, webProfile: grown })
  assert.equal(webProfileCopyChanged({ desktopProfile: desktop, plan: next }), true)
  assert.deepEqual(next.manifest.dsh.profile.bundles, [...BUILTIN_BUNDLES, 'dsh-better-sidebar', 'dsh-context'])
})

test('snapshotProfile：profile 缺必备文件时报错', t => {
  const root = scratch(t)
  mkdirSync(join(root, 'profile'), { recursive: true })
  assert.throws(() => snapshotProfile({ profile: join(root, 'profile') }), /is missing/u)
})

test('snapshotProfile：记录存在的文件，缺席的可选文件不进快照', t => {
  const root = scratch(t)
  const profile = join(root, 'profile')
  write(root, 'profile/package.json', '{"private":true}\n')
  write(root, 'profile/pnpm-workspace.yaml', 'packages:\n  - .\n')
  write(root, 'profile/pnpm-lock.yaml', 'lockfileVersion: 9\n')
  const snapshot = snapshotProfile({ profile })
  assert.deepEqual(Object.keys(snapshot.files).sort(), ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
  assert.equal(snapshot.files['cordis.patch.yml'], undefined)
})

test('rollbackProfile：还原被改的文件、删除快照外的文件，并调用一次重建', async t => {
  const root = scratch(t)
  const profile = join(root, 'profile')
  write(root, 'profile/package.json', '{"private":true}\n')
  write(root, 'profile/pnpm-workspace.yaml', 'packages:\n  - .\n')
  const snapshot = snapshotProfile({ profile })
  write(root, 'profile/package.json', '{"private":true,"dependencies":{"x":"1.0.0"}}\n')
  write(root, 'profile/pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write(root, 'profile/cordis.patch.yml', '[]\n')
  let repairs = 0
  const result = await rollbackProfile({ profile, snapshot, onRepair: () => { repairs += 1 } })
  assert.deepEqual(result.restored, ['package.json'])
  assert.deepEqual(result.removed, ['pnpm-lock.yaml', 'cordis.patch.yml'])
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), snapshot.files['package.json'])
  assert.equal(existsSync(join(profile, 'pnpm-lock.yaml')), false)
  assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false)
  assert.equal(repairs, 1)
})

test('rollbackProfile：重建失败时报可诊断的错误，而不是静默成功', async t => {
  const root = scratch(t)
  const profile = join(root, 'profile')
  write(root, 'profile/package.json', '{"private":true}\n')
  write(root, 'profile/pnpm-workspace.yaml', 'packages:\n  - .\n')
  const snapshot = snapshotProfile({ profile })
  await assert.rejects(
    () => rollbackProfile({ profile, snapshot, onRepair: () => { throw new Error('host links unavailable') } }),
    /rollback could not rebuild the profile \(host links unavailable\)/u,
  )
})

test('installProbeFailures：插件没装进 desktop profile 时逐个报路径问题', t => {
  const root = scratch(t)
  const failures = installProbeFailures({
    profile: join(root, 'profile'),
    plugins: ['dsh-better-sidebar', '@nanmicoder/dsh-auto-mode'],
    node: process.execPath,
  })
  assert.deepEqual(failures, [
    'dsh-better-sidebar: not installed in the desktop profile',
    '@nanmicoder/dsh-auto-mode: not installed in the desktop profile',
  ])
})

test('installProbeFailures：能加载的插件返回空列表，加载期抛错的插件报出原因', t => {
  const root = scratch(t)
  const profile = join(root, 'profile')
  write(root, 'profile/node_modules/ok-plugin/package.json', '{"name":"ok-plugin","version":"1.0.0","type":"module","main":"index.js"}\n')
  write(root, 'profile/node_modules/ok-plugin/index.js', 'export default 1\n')
  write(root, 'profile/node_modules/broken-plugin/package.json', '{"name":"broken-plugin","version":"1.0.0","type":"module","main":"index.js"}\n')
  write(root, 'profile/node_modules/broken-plugin/index.js', 'throw new Error("missing settingsNamespace export")\n')
  const failures = installProbeFailures({ profile, plugins: ['ok-plugin', 'broken-plugin'], node: process.execPath })
  assert.deepEqual(failures, ['broken-plugin: missing settingsNamespace export'])
})

test('startupNoticeScript：在假 DOM 里插入带信号与文案的元素，重复注入时替换旧的', t => {
  const root = scratch(t)
  write(root, 'profile/package.json', '{"private":true}\n')
  write(root, 'profile/pnpm-workspace.yaml', 'packages:\n  - .\n')
  const script = startupNoticeScript({ signal: 'rolled-back', text: '上次启动失败，已回滚到上次可用的配置。' })
  const elements = []
  const create = (tag) => {
    const element = {
      tagName: tag, style: { cssText: '' }, dataset: {}, children: [],
      setAttribute() {}, remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) },
    }
    elements.push(element)
    return element
  }
  const document = {
    body: { children: [], appendChild(child) { child.parent = this; this.children.push(child) } },
    createElement: create,
    getElementById: (id) => document.body.children.find(child => child.id === id) ?? null,
  }
  const context = { document, setTimeout: () => 0, requestAnimationFrame: (callback) => callback() }
  vm.runInNewContext(script, context)
  const injected = document.body.children[0]
  assert.equal(injected.id, 'dsh-desktop-notice')
  assert.equal(injected.dataset.signal, 'rolled-back')
  assert.equal(injected.textContent, '上次启动失败，已回滚到上次可用的配置。')
  assert.match(injected.style.cssText, /position:fixed/u)
  vm.runInNewContext(script, context)
  const remaining = document.body.children.filter(child => child.id === 'dsh-desktop-notice')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].removed, undefined)
})

test('探针失败文案与回退日志文案由本层决定（patch 里不许出现文案）', () => {
  assert.equal(
    copyFailureMessage(['broken-plugin: missing settingsNamespace export', 'other-plugin: no loadable entry']),
    'dsh desktop: copied web profile plugins could not be loaded:\n'
      + 'broken-plugin: missing settingsNamespace export\nother-plugin: no loadable entry',
  )
  assert.equal(ROLLBACK_RETRY_NOTICE, 'dsh desktop: rolled the profile back to the pre-copy configuration; retrying once')
  assert.equal(ROLLBACK_RETRY_FAILURE, 'dsh desktop: retry after profile rollback failed')
})

test('用户可见的回退提示也在本层（官方 locale 表只做接线）', () => {
  assert.equal(ROLLBACK_NOTICE_EN.startsWith('The previous start failed.'), true)
  assert.equal(ROLLBACK_NOTICE_ZH.startsWith('上次启动失败'), true)
})

/** 官方 `createPluginProfile` 建出来的空 profile（迁移窗口内的形态）。 */
function pristineDesktop(root) {
  write(root, 'desktop/package.json', JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    version: '0.0.0',
    dependencies: {},
    dsh: { profile: { bundles: BUILTIN_BUNDLES } },
  }, undefined, 2))
  write(root, 'desktop/pnpm-workspace.yaml', 'packages:\n  - .\n')
  return join(root, 'desktop')
}

test('isPristineProfile：官方空形态为真，装了插件为假', t => {
  const root = scratch(t)
  const desktop = pristineDesktop(root)
  assert.equal(isPristineProfile({ profile: desktop }), true)
  write(root, 'desktop/package.json', JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    version: '0.0.0',
    dependencies: { 'dsh-better-sidebar': '^0.18.1' },
    dsh: { profile: { bundles: [...BUILTIN_BUNDLES, 'dsh-better-sidebar'] } },
  }))
  assert.equal(isPristineProfile({ profile: desktop }), false)
})

test('webProfileMigration：空 profile + web 有插件 → migrate', t => {
  const root = scratch(t)
  const migration = webProfileMigration({
    desktopProfile: pristineDesktop(root),
    webProfile: webProfile(root),
  })
  assert.equal(migration.action, 'migrate')
  assert.deepEqual(migration.plan.plugins, ['dsh-better-sidebar'])
})

test('webProfileMigration：web 没有第三方插件 → settle（窗口结束，之后不再检查）', t => {
  const root = scratch(t)
  write(root, 'web/package.json', JSON.stringify({ dsh: { profile: { bundles: BUILTIN_BUNDLES } } }))
  write(root, 'web/pnpm-workspace.yaml', 'packages:\n  - .\n')
  assert.equal(webProfileMigration({
    desktopProfile: pristineDesktop(root),
    webProfile: join(root, 'web'),
  }).action, 'settle')
})

test('webProfileMigration：profile 已被用户接管 → settle，不覆盖用户自己的插件', t => {
  const root = scratch(t)
  const desktop = pristineDesktop(root)
  write(root, 'desktop/package.json', JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    version: '0.0.0',
    dependencies: { 'desktop-only': '1.0.0' },
    dsh: { profile: { bundles: [...BUILTIN_BUNDLES, 'desktop-only'] } },
  }))
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: webProfile(root) }).action, 'settle')
})

test('webProfileMigration：只有 retry 记账时继续迁移，done/abandoned 则跳过', t => {
  const root = scratch(t)
  const desktop = pristineDesktop(root)
  const web = webProfile(root)
  writeMigrationRecord({ profile: desktop, status: 'retry', failures: 1 })
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: web }).action, 'migrate')
  writeMigrationRecord({ profile: desktop, status: 'done' })
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: web }).action, 'skip')
  writeMigrationRecord({ profile: desktop, status: 'abandoned' })
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: web }).action, 'skip')
})

test('记账落在 profile 内，连续失败到上限转 abandoned', t => {
  const root = scratch(t)
  const desktop = pristineDesktop(root)
  assert.equal(readMigrationRecord({ profile: desktop }), null)
  assert.equal(recordMigrationFailure({ profile: desktop }).status, 'retry')
  assert.equal(recordMigrationFailure({ profile: desktop }).status, 'retry')
  const last = recordMigrationFailure({ profile: desktop })
  assert.equal(last.status, 'abandoned')
  assert.equal(last.failures, 3)
  assert.ok(existsSync(join(desktop, '.dsh-web-migration.json')))
  assert.equal(JSON.parse(readFileSync(join(desktop, '.dsh-web-migration.json'), 'utf8')).status, 'abandoned')
})

test('readMigrationRecord：坏 JSON 当作没有记账（迁移回到可重试）', t => {
  const root = scratch(t)
  const desktop = pristineDesktop(root)
  write(root, 'desktop/.dsh-web-migration.json', '{ not json')
  assert.equal(readMigrationRecord({ profile: desktop }), null)
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: webProfile(root) }).action, 'migrate')
})

test('记账文件随 profile 消失：官方重置后重新回到可迁移', t => {
  const root = scratch(t)
  const desktop = pristineDesktop(root)
  writeMigrationRecord({ profile: desktop, status: 'done' })
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: webProfile(root) }).action, 'skip')
  rmSync(desktop, { recursive: true, force: true })
  // 官方重置后 profile 会被重新建出来，此时没有任何记账
  assert.equal(isPristineProfile({ profile: pristineDesktop(root) }), true)
  assert.equal(webProfileMigration({ desktopProfile: desktop, webProfile: webProfile(root) }).action, 'migrate')
})
