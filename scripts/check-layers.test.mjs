/**
 * 门限单测：`check-layers.mjs` 自己的负样本。
 *
 * 门限也是代码，也会腐败——一条永远返回「通过」的规则和没有规则是一回事。所以这里对**每条硬规则**都
 * 造一个坏样本断言必须报、再造一个好样本断言必须不报；外加：
 * - 白名单的两种失效（没写 reason、条目已经没有对应违规），以及「没有 reason 的例外不放行」；
 * - 注释里的官方文案不算耦合（否则功能层连解释都不能写）；
 * - 依赖方向的两个方向各测一次；
 * - **本仓库当前状态必须是通过**：门限一旦漂移到与仓库实际不符，这条会先红。
 *
 * 跑法：`node scripts/check-layers.test.mjs`（受限沙箱里 `node --test` 会 spawn 子进程，直接跑本文件）。
 */
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  checkLayers, createProject, declarationName, importSpecifiers, isEcosystemLiteral, isRegistered,
  loadProject, patchRows, renderReport, scanLiterals,
} from './check-layers.mjs'

// 全部用 join() 拼路径：引擎按平台分隔符比较前后缀，测试不能自己混进 `/`。
const ROOT = resolve('check-layers-test-root')
const SRC = join(ROOT, 'src')
const FEATURES = join(SRC, 'features')
const ADAPTOR = join(SRC, 'adaptator')
const CONFIG = join(SRC, 'build.config.json')
const FEATURE_COPY = { from: 'features', to: 'apps/desktop/local/features' }
const featureFile = (...parts) => join(FEATURES, ...parts)
const adaptorFile = (...parts) => join(ADAPTOR, ...parts)
const patchFile = name => join(SRC, 'patch', name)

/** 造一份最小工程视图；`overrides` 覆盖任意字段。 */
function makeProject(overrides = {}) {
  return createProject({
    repoRoot: ROOT,
    srcDir: SRC,
    featuresRoot: FEATURES,
    adaptorRoot: ADAPTOR,
    config: { upstream: 'upstream', copy: [FEATURE_COPY], patches: [] },
    configPath: CONFIG,
    copyEntries: [FEATURE_COPY],
    features: [],
    adaptor: [],
    patches: [],
    allowlist: {},
    upstream: { literals: new Set(), lines: [] },
    exists: () => true,
    ...overrides,
  })
}

/** 只跑一遍门限，返回硬违规的规则 id（按出现顺序）。 */
function hardRules(project) {
  return checkLayers(project).findings.filter(finding => finding.severity === 'hard').map(finding => finding.rule)
}

/** 造一个补丁视图。 */
function makePatch(text, target = 'apps/desktop/src/main.ts') {
  return { file: patchFile('demo.ts.patch'), target, rows: patchRows(text) }
}

// ----------------------------------------------------------------- 纯工具

test('scanLiterals：代码里的字面量算，注释里的不算', () => {
  const literals = scanLiterals('// cordis.patch.yml 是官方文件\nconst a = "keep me"\n/* also "no" */\nconst r = /abc/u\n')
  assert.deepEqual(literals.map(literal => [literal.kind, literal.value]), [['string', 'keep me'], ['regex', 'abc']])
})

test('importSpecifiers：import 与 require 都取得到', () => {
  assert.deepEqual(
    importSpecifiers("import { a } from 'node:fs'\nimport b from 'electron'\nconst c = require('tar')\n"),
    ['node:fs', 'electron', 'tar'],
  )
})

test('isEcosystemLiteral：生态通用名豁免，dsh 自己的名字不豁免', () => {
  assert.equal(isEcosystemLiteral('package.json'), true)
  assert.equal(isEcosystemLiteral('node:child_process'), true)
  assert.equal(isEcosystemLiteral('@deepseek-ai/dsh-base'), false)
  assert.equal(isEcosystemLiteral('cordis.patch.yml'), false)
})

test('patchRows：只收 +/−/空格 行，跳过文件头与 hunk 头', () => {
  const rows = patchRows('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n')
  assert.deepEqual(rows.map(row => [row.added, row.removed, row.text]), [
    [false, true, 'old'], [true, false, 'new'], [false, false, 'context'],
  ])
})

test('declarationName：函数/方法/箭头都认得出，关键字与跨行调用不认', () => {
  assert.equal(declarationName('async function load(): Promise<void> {'), 'load')
  assert.equal(declarationName('  async ensureProfileDirectory(projectDir: string): Promise<void> {'), 'ensureProfileDirectory')
  assert.equal(declarationName('  async applyRelease(production = false): Promise<void> {'), 'applyRelease')
  assert.equal(declarationName('  installProfilePackages({ profile, node }: Options): void {'), 'installProfilePackages')
  assert.equal(declarationName('const rollbackPending = (): boolean => copiedProfile && ok'), 'rollbackPending')
  assert.equal(declarationName('  const rebuild = async (): Promise<void> => {'), 'rebuild')
  assert.equal(declarationName('  if (development && !copiedProfile) await copy()'), undefined)
  assert.equal(declarationName('  await reuse({'), undefined)
  assert.equal(declarationName('  finalize({'), undefined)
  assert.equal(declarationName('  // 注释里的 function fake() {'), undefined)
})

test('isRegistered：目录级 copy 会被 exclude 挡掉，逐文件条目仍能单独覆盖', () => {
  const entries = [
    { from: 'features', to: 'x', exclude: ['*.test.mjs', 'renderer'] },
    { from: 'features/renderer/loading-art.js', to: 'y' },
  ]
  assert.equal(isRegistered(featureFile('build-cache.mjs'), entries, SRC), true)
  assert.equal(isRegistered(featureFile('build-cache.test.mjs'), entries, SRC), false)
  assert.equal(isRegistered(featureFile('renderer', 'loading-art.js'), entries, SRC), true)
  assert.equal(isRegistered(featureFile('renderer', 'loading-art.css'), entries, SRC), false)
})

// ----------------------------------------------------------------- A1 / A2 / A5

test('A1：功能层 import 官方或 Electron → 报', () => {
  for (const specifier of ['electron', '@deepseek-ai/dsh-app-boot']) {
    const project = makeProject({
      features: [{ path: featureFile('a.mjs'), text: `import x from '${specifier}'` }],
    })
    assert.deepEqual(hardRules(project), ['A1'], specifier)
  }
})

test('A1/A2：功能层 import node: 内置或适配层 → 不报；越过适配层 → 报 A2', () => {
  const ok = makeProject({
    features: [{ path: featureFile('a.mjs'), text: "import { join } from 'node:path'\nimport { x } from '../adaptator/thing.mjs'" }],
  })
  assert.deepEqual(hardRules(ok), [])

  const crossed = makeProject({ features: [{ path: featureFile('a.mjs'), text: "import { y } from '../features/b.mjs'" }] })
  assert.deepEqual(hardRules(crossed), ['A2'])
})

test('A5：功能层 import 第三方包只告警，不拦', () => {
  const project = makeProject({ features: [{ path: featureFile('a.mjs'), text: "import { list } from 'tar'" }] })
  const result = checkLayers(project)
  assert.deepEqual(result.findings.map(finding => finding.rule), ['A5'])
  assert.equal(renderReport(result, ROOT).exitCode, 0)
})

// ----------------------------------------------------------------- A3 / A4

test('A4：功能层字面量与上游完全相同 → 报；生态通用名不算', () => {
  const project = makeProject({
    upstream: { literals: new Set(['cordis.patch.yml', 'package.json']), lines: [] },
    features: [{ path: featureFile('a.mjs'), text: "const PATCH = 'cordis.patch.yml'\nconst M = 'package.json'\n" }],
  })
  assert.deepEqual(hardRules(project), ['A4'])
  assert.match(checkLayers(project).findings[0].message, /cordis\.patch\.yml/u)
})

test('A3：功能层的正则会命中上游源码 → 报，并打印命中的那行作为证据', () => {
  const project = makeProject({
    upstream: { literals: new Set(), lines: ["throw new Error('desktop profile cleanup: expected an object')"] },
    features: [{ path: featureFile('a.mjs'), text: 'const RULE = /desktop profile cleanup: /i\n' }],
  })
  const findings = checkLayers(project).findings
  assert.deepEqual(findings.map(finding => finding.rule), ['A3'])
  assert.match(findings[0].message, /desktop profile cleanup: expected an object/u)
})

test('A3：命中落在更长的标识符内部时不算耦合（EPERM vs setDevicePermissionHandler）', () => {
  const project = makeProject({
    upstream: { literals: new Set(), lines: ['this.setDevicePermissionHandler(() => false)'] },
    features: [{ path: featureFile('a.mjs'), text: 'const RULE = /EPERM|ENOSPC/i\n' }],
  })
  assert.deepEqual(hardRules(project), [])
})

test('A3/A4：注释里写官方文案不算耦合', () => {
  const project = makeProject({
    upstream: { literals: new Set(['cordis.patch.yml']), lines: ["throw new Error('desktop profile cleanup: x')"] },
    features: [{
      path: featureFile('a.mjs'),
      text: '// 官方文件是 cordis.patch.yml，失败串形如 desktop profile cleanup: x\nconst ok = 1\n',
    }],
  })
  assert.deepEqual(hardRules(project), [])
})

test('A3/A4：上游 clone 不在场时跳过，不失败', () => {
  const project = makeProject({
    upstream: null,
    features: [{ path: featureFile('a.mjs'), text: 'const RULE = /desktop profile cleanup: /i\n' }],
  })
  const result = checkLayers(project)
  assert.deepEqual(result.findings, [])
  assert.equal(result.notes.length, 1)
})

// ----------------------------------------------------------------- B1–B5

test('B1：patch 新增行里有中文文案 → 报；注释里的中文不算', () => {
  const bad = makeProject({ patches: [makePatch("@@\n+  const msg = '回退到本次启动前的配置'\n")] })
  assert.deepEqual(hardRules(bad), ['B1'])

  const comment = makeProject({ patches: [makePatch('@@\n+  // 功能层决定文案，这里只调用\n+  await run()\n')] })
  assert.deepEqual(hardRules(comment), [])
})

test('B1–B3/B5：测试目标上的补丁不按产品代码要求', () => {
  const project = makeProject({
    patches: [makePatch(
      "@@\n+  expect(text).toContain('profile 与插件图失败')\n+  if (count > 3) throw new Error('too many')\n",
      'apps/desktop/tests/main-startup.spec.ts',
    )],
  })
  assert.deepEqual(hardRules(project), [])
})

test('B2：patch 新增行里出现能力实现 → 报', () => {
  for (const line of [
    "import { spawnSync } from 'node:child_process'",
    "const tmp = mkdtempSync(join(tmpdir(), 'x-'))",
    'await spawn(cmd, args)',
  ]) {
    const project = makeProject({ patches: [makePatch(`@@\n+  ${line}\n`)] })
    assert.deepEqual(hardRules(project), ['B2'], line)
  }
})

test('B3：patch 新增行里出现策略、阈值或匹配 → 报', () => {
  for (const line of [
    'const re = new RegExp(pattern)',
    'if (name.test(value)) return',
    'if (failures >= 3) give up',
    'while (index < 8) step()',
  ]) {
    const project = makeProject({ patches: [makePatch(`@@\n+  ${line}\n`)] })
    assert.ok(hardRules(project).includes('B3'), line)
  }
})

test('B3 不误报：接线形态的比较与调用不算判断', () => {
  const project = makeProject({
    patches: [makePatch(
      "@@\n+  await reuse({ stage: 'build-official', key: process.env.DSH_LOCAL_BUILD_KEY })\n"
      + '+  if (development === undefined) await manager.applyRelease(app.isPackaged)\n',
    )],
  })
  assert.deepEqual(hardRules(project), [])
})

test('B4：新增的胖函数只告警；改签名的既有函数不算新增', () => {
  const fat = `function f() {\n${'  step()\n'.repeat(8)}}\n`
  const softProject = makeProject({ patches: [makePatch(`@@\n${fat.split('\n').map(line => `+${line}`).join('\n')}`)] })
  const softResult = checkLayers(softProject)
  assert.deepEqual(softResult.findings.map(finding => finding.rule), ['B4'])
  assert.equal(renderReport(softResult, ROOT).exitCode, 0)

  const resigned = ' function f() {\n+async function f() {\n   step()\n }\n'
  const renamed = makeProject({ patches: [makePatch(`@@\n${resigned}`)] })
  assert.deepEqual(checkLayers(renamed).findings, [])
})

test('B5：新增行里像英文文案的字符串只告警', () => {
  const project = makeProject({ patches: [makePatch("@@\n+  const text = 'The previous start failed and the profile was restored'\n")] })
  const result = checkLayers(project)
  assert.deepEqual(result.findings.map(finding => finding.rule), ['B5'])
  assert.equal(renderReport(result, ROOT).exitCode, 0)
})

// ----------------------------------------------------------------- C1–C3

test('C1：独立文件没登记 copy → 报；登记了就不报', () => {
  const orphan = makeProject({ copyEntries: [], features: [{ path: featureFile('orphan.mjs'), text: 'export const a = 1\n' }] })
  assert.deepEqual(hardRules(orphan), ['C1'])

  const registered = makeProject({ features: [{ path: featureFile('kept.mjs'), text: 'export const a = 1\n' }] })
  assert.deepEqual(hardRules(registered), [])
})

test('C2：patch 文件不存在、或上游 target 不存在 → 报', () => {
  const missingFile = makeProject({ patches: [{ file: patchFile('gone.ts.patch'), target: 'a.ts', rows: [] }] })
  assert.deepEqual(hardRules(missingFile), ['C2'])

  const missingTarget = makeProject({
    exists: path => !path.endsWith('a.ts'),
    patches: [makePatch('@@\n+  await run()\n', 'apps/desktop/src/a.ts')],
  })
  assert.deepEqual(hardRules(missingTarget), ['C2'])
})

test('C3：适配层 import 功能层 → 报', () => {
  const project = makeProject({
    copyEntries: [{ from: 'adaptator', to: 'apps/desktop/local/adaptator' }],
    adaptor: [{ path: adaptorFile('a.mjs'), text: "import { x } from '../features/b.mjs'" }],
  })
  assert.deepEqual(hardRules(project), ['C3'])
})

// ----------------------------------------------------------------- 白名单

test('白名单：有 reason 才放行；没写 reason 既不放行也算违规', () => {
  const upstream = { literals: new Set(['cordis.patch.yml']), lines: [] }
  const features = [{ path: featureFile('a.mjs'), text: "const PATCH = 'cordis.patch.yml'\n" }]
  const allowlist = entry => ({ A4: [{ file: 'src/features/a.mjs', literal: 'cordis.patch.yml', ...entry }] })

  const allowed = makeProject({ upstream, features, allowlist: allowlist({ reason: 'profile 的磁盘格式是公开契约' }) })
  assert.deepEqual(hardRules(allowed), [])

  const noReason = makeProject({ upstream, features, allowlist: allowlist({ reason: '   ' }) })
  assert.deepEqual(hardRules(noReason), ['A4', 'allowlist'])
})

test('白名单：已经没有对应违规的条目算违规（防止白名单变垃圾场）', () => {
  const project = makeProject({
    upstream: { literals: new Set(['cordis.patch.yml']), lines: [] },
    features: [{ path: featureFile('a.mjs'), text: "const PATCH = 'cordis.patch.yml'\n" }],
    allowlist: {
      A4: [
        { file: 'src/features/a.mjs', literal: 'cordis.patch.yml', reason: '有理由' },
        { file: 'src/features/a.mjs', literal: 'gone-forever', reason: '有理由' },
      ],
    },
  })
  assert.deepEqual(hardRules(project), ['allowlist'])
})

// ----------------------------------------------------------------- 呈现与本仓库现状

test('renderReport：硬违规退出码为 1，只有告警时为 0', () => {
  assert.equal(renderReport(checkLayers(makeProject()), ROOT).exitCode, 0)
  const bad = makeProject({ features: [{ path: featureFile('a.mjs'), text: "import x from 'electron'" }] })
  const rendered = renderReport(checkLayers(bad), ROOT)
  assert.equal(rendered.exitCode, 1)
  assert.match(rendered.text, /\[A1\] 1 处/u)
  assert.match(rendered.text, /src[/\\]features[/\\]a\.mjs/u)
})

test('本仓库当前状态必须通过门限（门限漂移会先在这里红）', () => {
  const result = checkLayers(loadProject())
  const hard = result.findings.filter(finding => finding.severity === 'hard')
  assert.deepEqual(hard.map(finding => `${finding.rule} ${finding.message}`), [])
})
