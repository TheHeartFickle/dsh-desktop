#!/usr/bin/env node
/**
 * 门限：三层设计腐败检查（`npm run check:layers`）。
 *
 * 背景：本仓库的分层规范（`AGENTS.md` 硬约束 1–4、`docs/design.zh.md` 的 patch 层边界）靠自觉执行，
 * 而「功能层里混进官方内部实现」「patch 层里长出功能逻辑」这两类腐败**不会让任何测试失败**——它们只是
 * 让下一次上游升级从「重新生成 patch」恶化为「重写两层」。规范必须落成一条能跑、会红的门限。
 *
 * ## 规则（id 与 docs/design.zh.md 的「三层腐败门限」一节一一对应）
 *
 * 硬规则（违规 → exit 1）：
 *   A1 功能层 import 了官方/Electron（`electron`、`@deepseek-ai/*`）
 *   A2 功能层相对 import 越过了适配层
 *   A3 功能层里出现官方会说的错误文案（字面量/正则能在上游源码里找到对应物）
 *   A4 功能层里出现官方内部结构名（同上，去掉 npm/pnpm/Node 的生态通用名）
 *   B1 patch 新增行里有用户可见文案（中文字面量）
 *   B2 patch 新增行里自己实现能力（child_process / crypto / spawn / mkdtemp / createHash）
 *   B3 patch 新增行里有策略、阈值或匹配（正则、.test/.match、与字面量的数值比较）
 *   C1 src 下的独立文件没登记进 build.config.json 的 copy
 *   C2 配置里的 patch 文件、或它的上游 target 不存在
 *   C3 适配层 import 了功能层（依赖方向倒置）
 *
 * 告警（只打印，不影响退出码）：
 *   A5 功能层 import 了第三方包（确认它是上游本来就有的依赖）
 *   B4 patch 新增的函数体偏大或带分支（可能是把功能写进了补丁）
 *   B5 patch 新增行里有英文产品文案（启发式）
 *
 * ## 设计约束
 *
 * - **规则是纯函数**：`(project) => Finding[]`，不读写任何模块级可变状态；一次运行的全部状态都封在
 *   `createProject()` 造出的视图里。因此引擎可以脱离磁盘被单测直接调用（`scripts/check-layers.test.mjs`）。
 * - **报告必须带证据**：A3/A4 打印命中的那行上游源码，C2 打印缺失路径。没有证据的报告等于噪声。
 * - **白名单必须可校验**：`src/layer-allowlist.json` 每条 `{file, literal, reason}` 都要有 reason，
 *   且**失效条目本身算违规**——否则白名单会变成藏污纳垢的地方。
 * - **生态通用名不算官方内部名**：`node_modules`、`package.json`、`pnpm-lock.yaml`、`node:*` 是
 *   npm/pnpm/Node 的约定，官方只是碰巧也用；dsh 自己的名字（`@deepseek-ai/dsh-base`、`cordis.patch.yml`）
 *   仍然算耦合。豁免表集中在 {@link ECOSYSTEM_LITERALS} 一处，逐项可审。
 * - **B4 不做成硬规则**：`AGENTS.md` 硬约束 2 明确允许 patch「持有接线状态、按官方状态决定何时调度」，
 *   把控制流判死会让门限立刻变成噪声源。
 *
 * ## 已知盲区（抓不到，别指望）
 *
 * 功能层**复刻**官方一段算法；patch 里靠多次调度拼出新行为；英文文案只能弱启发式；「这段判断到底算不算
 * 需求」不可判定。上游 clone 不在场时 A3/A4 整段跳过（打印提示），其余规则照跑。
 *
 * 本脚本只用 Node 内置模块、不 spawn 子进程、不联网：受限沙箱里也能跑（docs/reproduce.zh.md R11）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(HERE, '..')

/** 上游里「官方桌面端内部实现」的扫描范围；缺哪个就少扫一块。 */
const UPSTREAM_SCAN_ROOTS = [
  ['apps', 'desktop', 'src'],
  ['apps', 'desktop', 'scripts'],
  ['apps', 'desktop-host', 'src'],
  ['packages', 'boot', 'app-boot', 'src'],
]
const UPSTREAM_SCAN_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js'])
/** 遍历时跳过的目录：产物、依赖、测试夹具。 */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'lib', 'dist', 'tests', '__snapshots__'])
/** 只有够长的字面量才可能是「文案/内部标识」；短串重合没有信息量。 */
const MIN_LITERAL_LENGTH = 12
/**
 * npm / pnpm / Node 自己定义的名字。逐项理由：它们都是**生态约定**，不是 dsh 的内部实现——
 * 任何 Node 项目都会写 `package.json`，任何 pnpm 工作区都有 `pnpm-workspace.yaml`。
 */
const ECOSYSTEM_LITERALS = new Set([
  'node_modules', 'package.json', 'package/package.json', 'index.js', 'index.mjs', 'index.cjs',
  'main.js', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc',
])
/** 官方/Electron 的内部包：功能层碰这些就等于直接依赖官方实现。 */
const UPSTREAM_PACKAGE_PREFIXES = ['electron', '@deepseek-ai/']
/** 能力实现的信号：出现即在 patch 里「干活」。 */
const CAPABILITY_PATTERNS = [
  [/node:child_process/u, '进程调用（node:child_process）'],
  [/node:crypto/u, '哈希/加密（node:crypto）'],
  [/\bspawnSync\s*\(/u, 'spawnSync'],
  [/\bspawn\s*\(/u, 'spawn'],
  [/\bexecFile\w*\s*\(/u, 'execFile'],
  [/\bmkdtempSync\s*\(/u, 'mkdtempSync'],
  [/\bcreateHash\s*\(/u, 'createHash'],
]
/** 判断策略的信号：阈值、匹配都属功能层。 */
const POLICY_PATTERNS = [
  [/\bnew RegExp\s*\(/u, '正则'],
  [/\.test\s*\(/u, '.test()'],
  [/\.match\s*\(/u, '.match()'],
  [/(?:>=|<=|>|<)\s*\d/u, '与字面量的数值比较'],
  [/\d\s*(?:>=|<=|>|<)/u, '与字面量的数值比较'],
]
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
/** 英文产品文案的启发式：够长、带空格、像句子、且不是路径/开关/说明符。 */
const ENGLISH_COPY = /^[A-Z][A-Za-z0-9 ,.'’%()\-]*[a-z][A-Za-z0-9 ,.'’%()\-]*$/u
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'catch', 'do', 'return', 'await', 'typeof', 'new', 'delete', 'void',
  'get', 'set', 'in', 'of', 'case', 'throw', 'yield', 'super', 'this',
])
/** 声明的开头：函数、`const x = (` / `const x = async (`、或裸的 `name(`。 */
const DECLARATION_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\s*)?\(|([\w$]+)\s*\()/u

// ================================================================= 纯工具

/**
 * 一个名字是不是生态通用名（不算 dsh 内部实现）。
 * @param {string} value 字面量。
 * @returns {boolean}
 */
export function isEcosystemLiteral(value) {
  return ECOSYSTEM_LITERALS.has(value) || /^node:[\w/]+$/u.test(value)
}

/**
 * 扫出源码里的字面量：普通字符串与正则字面量，跳过注释。
 *
 * 目的不是完整 JS 词法分析，而是**不把注释和代码搞混**：注释里提到官方错误串不算耦合，代码里才算。
 * 正则用「前一个有效字符」启发式区分除号。
 * @param {string} source 源码文本。
 * @returns {{ kind: 'string' | 'regex', value: string, line: number }[]}
 */
export function scanLiterals(source) {
  const found = []
  let line = 1
  let index = 0
  let previous = ''
  while (index < source.length) {
    const character = source[index]
    if (character === '\n') { line += 1; index += 1; previous = character; continue }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      const startLine = line
      const quote = character
      let cursor = index + 1
      let value = ''
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') { value += source[cursor + 1]; cursor += 2; continue }
        if (inner === quote) break
        if (inner === '\n') line += 1
        value += inner
        cursor += 1
      }
      found.push({ kind: 'string', value, line: startLine })
      index = cursor + 1
      previous = quote
      continue
    }
    if (character === '/' && !/[\w$)\]]/u.test(previous)) {
      const startLine = line
      let cursor = index + 1
      let value = ''
      let inClass = false
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') { value += inner + (source[cursor + 1] ?? ''); cursor += 2; continue }
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) break
        else if (inner === '\n') { value = ''; break }
        value += inner
        cursor += 1
      }
      if (value !== '' && source[cursor] === '/') {
        found.push({ kind: 'regex', value, line: startLine })
        index = cursor + 1
        previous = '/'
        continue
      }
    }
    if (!/\s/u.test(character)) previous = character
    index += 1
  }
  return found
}

/**
 * 抽出一段源码里的 import / require 说明符。
 * @param {string} source 源码文本。
 * @returns {string[]}
 */
export function importSpecifiers(source) {
  const specs = []
  for (const match of source.matchAll(/(?:^|[\s;])import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gu)) specs.push(match[1])
  for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) specs.push(match[1])
  return specs
}

/**
 * 一个 import 说明符解析后是否落在某个目录内。
 * @param {string} fromFile 发起 import 的文件绝对路径。
 * @param {string} specifier 说明符。
 * @param {string} root 目标目录绝对路径。
 * @returns {boolean}
 */
export function resolvesInto(fromFile, specifier, root) {
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(fromFile), specifier)
  return target === root || target.startsWith(root + sep)
}

/**
 * 一个文件是否被某条 `copy` 规则覆盖（逐段套用 `exclude`，与 scripts/build.mjs 的复制语义一致）。
 * @param {string} file 文件绝对路径。
 * @param {{ from: string, exclude?: string[] }[]} copyEntries 配置里的 copy 列表。
 * @param {string} srcDir `src/` 绝对路径。
 * @returns {boolean}
 */
export function isRegistered(file, copyEntries, srcDir) {
  for (const entry of copyEntries) {
    const from = resolve(srcDir, entry.from)
    if (file !== from && !file.startsWith(from + sep)) continue
    const segments = file === from ? [] : relative(from, file).split(sep)
    const excluded = segments.some(segment => (entry.exclude ?? []).some((pattern) => {
      const escaped = pattern.replaceAll('.', '\\.').replaceAll('*', '.*')
      return new RegExp(`^${escaped}$`, 'u').test(segment)
    }))
    if (!excluded) return true
  }
  return false
}

/**
 * 递归列出目录下的文件。
 * @param {string} root 起始目录。
 * @param {(path: string) => boolean} keep 保留判据。
 * @returns {string[]}
 */
export function walkFiles(root, keep) {
  if (!existsSync(root)) return []
  const found = []
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRECTORIES.has(name)) continue
      found.push(...walkFiles(path, keep))
    } else if (keep(path)) {
      found.push(path)
    }
  }
  return found
}

/**
 * 把补丁拆成带标记的行（`+` 新增、`-` 删除、空格上下文）。
 * @param {string} text 补丁全文。
 * @returns {{ line: number, added: boolean, removed: boolean, text: string }[]}
 */
export function patchRows(text) {
  const rows = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ')) continue
    if (raw.startsWith('+')) rows.push({ line: index + 1, added: true, removed: false, text: raw.slice(1) })
    else if (raw.startsWith('-')) rows.push({ line: index + 1, added: false, removed: true, text: raw.slice(1) })
    else if (raw.startsWith(' ')) rows.push({ line: index + 1, added: false, removed: false, text: raw.slice(1) })
  }
  return rows
}

/**
 * 从一行源码里取出被声明的函数/方法名；不是声明或只是关键字时返回 undefined。
 *
 * 参数表与返回类型都可能有括号、`=>`、`<...>`，所以不试图一次正则吃完：先取名字，再看这一行在
 * **最后一个 `)` 之后**是否以 `{` 或 `=>` 收口。没有 `)` 的（`await reuse({` 这类跨行调用）直接不算声明。
 * @param {string} text 一行源码。
 * @returns {string | undefined}
 */
export function declarationName(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return undefined
  const match = DECLARATION_START.exec(trimmed)
  const name = match?.[1] ?? match?.[2] ?? match?.[3]
  if (name === undefined || JS_KEYWORDS.has(name)) return undefined
  const tail = trimmed.slice(match[0].length)
  const closer = tail.lastIndexOf(')')
  if (closer === -1) return undefined
  const rest = tail.slice(closer + 1)
  return rest.includes('{') || rest.includes('=>') ? name : undefined
}

// ================================================================= 工程视图

/**
 * @typedef {object} Finding
 * @property {string} rule 规则 id。
 * @property {'hard' | 'soft'} severity 级别。
 * @property {string} file 文件绝对路径。
 * @property {number} line 行号；0 表示整文件。
 * @property {string} message 结论 + 依据 + 怎么办。
 */

/**
 * 造一份「要检查的工程」视图。全部规则都只读这个对象，运行期没有别的状态。
 * @param {object} input 视图内容。
 * @returns {object} 冻结的工程视图。
 */
export function createProject(input) {
  return Object.freeze({
    repoRoot: input.repoRoot,
    config: input.config,
    configPath: input.configPath,
    srcDir: input.srcDir,
    featuresRoot: input.featuresRoot,
    adaptorRoot: input.adaptorRoot,
    copyEntries: Object.freeze(input.copyEntries ?? []),
    features: Object.freeze(input.features ?? []),
    adaptor: Object.freeze(input.adaptor ?? []),
    patches: Object.freeze(input.patches ?? []),
    allowlist: Object.freeze(input.allowlist ?? {}),
    upstream: input.upstream ?? null,
    exists: input.exists ?? (() => false),
  })
}

/**
 * 从磁盘构造工程视图。
 * @param {string} repoRoot 本仓库根目录。
 * @returns {object} 工程视图。
 */
export function loadProject(repoRoot = DEFAULT_REPO_ROOT) {
  const srcDir = join(repoRoot, 'src')
  const configPath = join(srcDir, 'build.config.json')
  if (!existsSync(configPath)) throw new Error(`缺少配置 ${configPath}`)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const allowlistPath = join(srcDir, 'layer-allowlist.json')
  const sourceFile = path => /\.(?:mjs|d\.mts|js)$/u.test(path) && !path.endsWith('.test.mjs')
  const layerRoot = (name) => {
    const entry = (config.copy ?? []).find(candidate => candidate.from.replace(/\/+$/u, '') === name)
    if (entry === undefined) throw new Error(`配置的 copy 里找不到 ${name} 层`)
    return resolve(srcDir, entry.from)
  }
  const readSources = root => walkFiles(root, sourceFile)
    .map(path => ({ path, text: readFileSync(path, 'utf8') }))

  const upstreamRoot = resolve(repoRoot, config.upstream)
  const upstream = existsSync(upstreamRoot) ? scanUpstream(upstreamRoot) : null

  return createProject({
    repoRoot,
    config,
    configPath,
    srcDir,
    featuresRoot: layerRoot('features'),
    adaptorRoot: layerRoot('adaptator'),
    copyEntries: config.copy,
    features: readSources(layerRoot('features')),
    adaptor: readSources(layerRoot('adaptator')),
    patches: (config.patches ?? []).map(entry => ({
      file: resolve(srcDir, entry.file),
      target: entry.target ?? '',
      rows: existsSync(resolve(srcDir, entry.file))
        ? patchRows(readFileSync(resolve(srcDir, entry.file), 'utf8'))
        : [],
    })),
    allowlist: existsSync(allowlistPath) ? JSON.parse(readFileSync(allowlistPath, 'utf8')) : {},
    upstream,
    exists: existsSync,
  })
}

/**
 * 扫上游源码，得到「官方会说什么」的语料。
 * @param {string} upstreamRoot 上游仓库根目录。
 * @returns {{ literals: Set<string>, lines: string[] }}
 */
export function scanUpstream(upstreamRoot) {
  const literals = new Set()
  const lines = []
  const keep = path => UPSTREAM_SCAN_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))
  for (const parts of UPSTREAM_SCAN_ROOTS) {
    for (const file of walkFiles(join(upstreamRoot, ...parts), keep)) {
      const text = readFileSync(file, 'utf8')
      lines.push(...text.split('\n'))
      for (const literal of scanLiterals(text)) {
        if (literal.kind === 'string' && literal.value.length >= MIN_LITERAL_LENGTH) literals.add(literal.value)
      }
    }
  }
  return { literals, lines }
}

// ================================================================= 规则

/**
 * 查白名单：命中返回该条目，否则 undefined。
 *
 * **没有 `reason` 的条目不放行**——例外必须能被复核；这种条目本身还会被
 * {@link ruleAllowlistFreshness} 单独报一条违规。
 * @param {object} allowlist 白名单内容（规则 id → 条目数组）。
 * @param {string} rule 规则 id。
 * @param {string} fileKey 仓库相对路径（`/` 分隔）。
 * @param {string} literal 被豁免的字面量或正则源。
 * @returns {object | undefined}
 */
function allowlistEntry(allowlist, rule, fileKey, literal) {
  return (allowlist[rule] ?? []).find(entry => entry.file === fileKey && entry.literal === literal
    && typeof entry.reason === 'string' && entry.reason.trim() !== '')
}

/** 规则 A1 / A5：功能层的 import 只能指向 node: 内置、适配层、或上游本来就有的第三方包。 */
function ruleFeatureImports(project) {
  const findings = []
  for (const source of project.features) {
    for (const specifier of importSpecifiers(source.text)) {
      if (specifier.startsWith('node:')) continue
      if (resolvesInto(source.path, specifier, project.adaptorRoot)) continue
      if (UPSTREAM_PACKAGE_PREFIXES.some(prefix => specifier === prefix || specifier.startsWith(prefix))) {
        findings.push({
          rule: 'A1', severity: 'hard', file: source.path, line: 0,
          message: `功能层 import 了官方/Electron 的「${specifier}」：需要官方信息先在适配层加稳定出参`
            + '（AGENTS.md 硬约束 1）',
        })
        continue
      }
      if (specifier.startsWith('.')) {
        findings.push({
          rule: 'A2', severity: 'hard', file: source.path, line: 0,
          message: `功能层的相对 import「${specifier}」越过了适配层：功能层只允许依赖 src/adaptator/`
            + '（AGENTS.md 硬约束 1）',
        })
        continue
      }
      findings.push({
        rule: 'A5', severity: 'soft', file: source.path, line: 0,
        message: `功能层 import 了第三方包「${specifier}」：确认它是上游已经声明的依赖，而不是本仓库新引入的`
          + '（AGENTS.md「不要新增依赖」）',
      })
    }
  }
  return findings
}

/** 规则 C3：适配层不得 import 功能层。 */
function ruleAdaptorImports(project) {
  const findings = []
  for (const source of project.adaptor) {
    for (const specifier of importSpecifiers(source.text)) {
      if (!resolvesInto(source.path, specifier, project.featuresRoot)) continue
      findings.push({
        rule: 'C3', severity: 'hard', file: source.path, line: 0,
        message: `适配层 import 了功能层（${specifier}）：依赖方向不可逆（AGENTS.md 硬约束 1）`,
      })
    }
  }
  return findings
}

/**
 * 规则 A3 / A4：功能层不得知道官方会说什么。
 *
 * 字面量按「与上游字面量完全相等」判（部分重合多是巧合，例如自己写的 `${tarball} has no package manifest`
 * 与官方同义）；正则按「命中上游某一行、且命中不落在更长的标识符内部」判（否则 `EPERM` 会命中
 * `setDevicePermissionHandler`）。
 */
function ruleUpstreamCoupling(project) {
  const findings = []
  const allowlistHits = []
  if (project.upstream === null) return { findings, allowlistHits }
  for (const source of project.features) {
    const fileKey = relative(project.repoRoot, source.path).replaceAll('\\', '/')
    for (const literal of scanLiterals(source.text)) {
      const exempt = id => {
        if (allowlistEntry(project.allowlist, id, fileKey, literal.value) === undefined) return false
        allowlistHits.push(`${id}\u0000${fileKey}\u0000${literal.value}`)
        return true
      }
      if (literal.kind === 'string') {
        if (literal.value.length < MIN_LITERAL_LENGTH) continue
        if (isEcosystemLiteral(literal.value)) continue
        if (!project.upstream.literals.has(literal.value)) continue
        if (exempt('A4')) continue
        findings.push({
          rule: 'A4', severity: 'hard', file: source.path, line: literal.line,
          message: `功能层里的字面量 ${JSON.stringify(literal.value)} 与上游源码里的字面量完全相同`
            + '——这是官方内部实现的知识，应由适配层固定成稳定出参',
        })
        continue
      }
      if (!/[A-Za-z]{4}/u.test(literal.value)) continue
      let regex
      try { regex = new RegExp(literal.value, 'iu') } catch { continue }
      const hit = project.upstream.lines.find((text) => {
        if (!text.includes(' ')) return false
        const match = regex.exec(text)
        if (match === null || match[0] === '') return false
        // 只在模式自己「贴着单词」的那一侧要求边界：`EPERM` 落在 `setDevicePermissionHandler` 内部不算命中，
        // 而 `/desktop profile cleanup: /` 以空格结尾，右侧后面接什么都不影响它是完整片段。
        const before = text[match.index - 1] ?? ' '
        const after = text[match.index + match[0].length] ?? ' '
        if (/^[\w$]/u.test(match[0]) && /[\w$]/u.test(before)) return false
        if (/[\w$]$/u.test(match[0]) && /[\w$]/u.test(after)) return false
        return true
      })
      if (hit === undefined) continue
      if (exempt('A3')) continue
      findings.push({
        rule: 'A3', severity: 'hard', file: source.path, line: literal.line,
        message: `功能层里的正则 /${literal.value}/ 会命中上游源码：${JSON.stringify(hit.trim().slice(0, 80))}`
          + '——官方改文案就会静默失效，应由适配层给出稳定信号',
      })
    }
  }
  return { findings, allowlistHits }
}

/** 规则 B1 / B2 / B3 / B4 / B5：patch 层不得承载文案、能力与判断。 */
function rulePatchLayer(project) {
  const findings = []
  for (const patch of project.patches) {
    if (patch.rows.length === 0) continue
    // 测试目标是夹具：允许引用官方文案与产品文案作为断言，也不按产品代码的标准要求它。
    if (/(?:^|\/)tests?\//u.test(patch.target)) continue
    const added = patch.rows.filter(row => row.added)

    for (const row of added) {
      const trimmed = row.text.trim()
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
      if (isComment) continue
      for (const literal of scanLiterals(row.text)) {
        if (literal.kind !== 'string') continue
        if (CJK.test(literal.value)) {
          findings.push({
            rule: 'B1', severity: 'hard', file: patch.file, line: row.line,
            message: `新增行里有用户可见文案 ${JSON.stringify(literal.value)}——文案属于功能层（AGENTS.md 硬约束 2）`,
          })
        } else if (literal.value.length >= 24 && literal.value.includes(' ') && ENGLISH_COPY.test(literal.value)) {
          findings.push({
            rule: 'B5', severity: 'soft', file: patch.file, line: row.line,
            message: `新增行里有像英文文案的字符串 ${JSON.stringify(literal.value)}——确认它不是产品文案`
              + '（产品文案一律在功能层，通常为中文）',
          })
        }
      }
      for (const [pattern, why] of CAPABILITY_PATTERNS) {
        if (!pattern.test(row.text)) continue
        findings.push({
          rule: 'B2', severity: 'hard', file: patch.file, line: row.line,
          message: `新增行里出现${why}——能力实现属于适配层/功能层，patch 只调度（AGENTS.md 硬约束 2）`,
        })
      }
      for (const [pattern, why] of POLICY_PATTERNS) {
        if (!pattern.test(row.text)) continue
        findings.push({
          rule: 'B3', severity: 'hard', file: patch.file, line: row.line,
          message: `新增行里出现${why}——判断逻辑属于功能层（AGENTS.md 硬约束 2）`,
        })
      }
    }
    findings.push(...fatFunctionWarnings(patch, added))
  }
  return findings
}

/**
 * 规则 B4（告警）：新增的函数体偏大或带分支。
 *
 * 只看**新增**的函数；同一标识符在同一补丁里被删过（改签名）不算新增；表达式体箭头函数只算一行。
 * 体积用「整份补丁的行」跟踪花括号配平、只用新增行计数——否则上下文行里的花括号会让计数失真。
 */
function fatFunctionWarnings(patch, added) {
  const findings = []
  const renamed = new Set(patch.rows.filter(row => row.removed).map(row => declarationName(row.text)).filter(Boolean))
  for (let cursor = 0; cursor < added.length; cursor += 1) {
    const name = declarationName(added[cursor].text)
    if (name === undefined || renamed.has(name)) continue
    const arrow = added[cursor].text.indexOf('=>')
    if (arrow !== -1 && !added[cursor].text.slice(arrow).includes('{')) continue
    const start = patch.rows.indexOf(added[cursor])
    let depth = 0
    let started = false
    let size = 0
    let branching = false
    let closed = false
    for (let scan = start; scan < patch.rows.length; scan += 1) {
      for (const character of patch.rows[scan].text) {
        if (character === '{') { depth += 1; started = true }
        else if (character === '}') depth -= 1
      }
      if (started) {
        if (patch.rows[scan].added) size += 1
        if (/\b(?:if|for|while|switch|catch)\b/u.test(patch.rows[scan].text)) branching = true
      }
      if (started && depth <= 0) { closed = true; break }
    }
    if (!closed) continue
    if (size <= 6 && !branching) continue
    findings.push({
      rule: 'B4', severity: 'soft', file: patch.file, line: added[cursor].line,
      message: `新增函数「${name}」体 ${String(size)} 行${branching ? '且带分支' : ''}——确认它只是「薄出口/接线」，`
        + '否则应下沉到适配层或功能层（硬约束 2 允许接线状态与调度，所以这条只告警）',
    })
  }
  return findings
}

/** 规则 C1：src 下的独立文件必须登记 copy。 */
function ruleRegistration(project) {
  const findings = []
  for (const source of [...project.features, ...project.adaptor]) {
    if (isRegistered(source.path, project.copyEntries, project.srcDir)) continue
    findings.push({
      rule: 'C1', severity: 'hard', file: source.path, line: 0,
      message: '独立文件没有登记进 build.config.json 的 copy（AGENTS.md 硬约束 4）',
    })
  }
  return findings
}

/** 规则 C2：配置里的 patch 文件与它的上游 target 都必须存在。 */
function rulePatchTargets(project) {
  const findings = []
  for (const patch of project.patches) {
    if (patch.rows.length === 0) {
      findings.push({
        rule: 'C2', severity: 'hard', file: project.configPath, line: 0,
        message: `配置里的 patch 不存在或为空：${relative(project.srcDir, patch.file).replaceAll('\\', '/')}`,
      })
      continue
    }
    if (patch.target === '') continue
    const target = join(resolve(project.repoRoot, project.config.upstream), patch.target)
    if (project.upstream === null || project.exists(target)) continue
    findings.push({
      rule: 'C2', severity: 'hard', file: project.configPath, line: 0,
      message: `patch ${relative(project.srcDir, patch.file).replaceAll('\\', '/')} 的 target 在上游不存在：`
        + `${patch.target}（多半是上游把它改名/搬走了，target 没跟着改）`,
    })
  }
  return findings
}

/** 规则 A3/A4 的白名单失效检查：留着的例外必须还有对应的违规，且必须写清理由。 */
function ruleAllowlistFreshness(project, allowlistHits) {
  const findings = []
  const used = new Set(allowlistHits)
  for (const [rule, entries] of Object.entries(project.allowlist)) {
    for (const entry of entries ?? []) {
      // 没写理由的条目在 allowlistEntry 里根本不放行，所以只报这一条，不再叠一条「失效」。
      if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        findings.push({
          rule: 'allowlist', severity: 'hard', file: join(project.srcDir, 'layer-allowlist.json'), line: 0,
          message: `${rule} 的例外「${entry.literal}」没有写 reason：例外必须能被复核，不写理由的例外不放行`,
        })
        continue
      }
      if (used.has(`${rule}\u0000${entry.file}\u0000${entry.literal}`)) continue
      findings.push({
        rule: 'allowlist', severity: 'hard', file: join(project.srcDir, 'layer-allowlist.json'), line: 0,
        message: `${rule} 的例外「${entry.file}: ${entry.literal}」已经没有对应的违规了`
          + '——失效的白名单会掩盖新问题，删掉它',
      })
    }
  }
  return findings
}

// ================================================================= 汇总与呈现

/**
 * 跑一遍全部门限。
 * @param {object} project 工程视图。
 * @returns {{ findings: Finding[], notes: string[] }} 结论。
 */
export function checkLayers(project) {
  const notes = []
  const coupling = ruleUpstreamCoupling(project)
  const findings = [
    ...ruleFeatureImports(project),
    ...ruleAdaptorImports(project),
    ...coupling.findings,
    ...rulePatchLayer(project),
    ...ruleRegistration(project),
    ...rulePatchTargets(project),
    ...ruleAllowlistFreshness(project, coupling.allowlistHits),
  ]
  if (project.upstream === null) {
    notes.push('上游 clone 不在场：已跳过 A3/A4（功能层与官方原文的耦合）与 C2 的上游存在性检查')
  }
  return { findings, notes }
}

/**
 * 把结论渲染成人类可读的文本。
 * @param {{ findings: Finding[], notes: string[] }} result 结论。
 * @param {string} repoRoot 仓库根目录（用于相对化路径）。
 * @returns {{ text: string, exitCode: number }} 输出与退出码。
 */
export function renderReport(result, repoRoot) {
  const hard = result.findings.filter(finding => finding.severity === 'hard')
  const soft = result.findings.filter(finding => finding.severity === 'soft')
  const where = finding => {
    const path = relative(repoRoot, finding.file).replaceAll('\\', '/')
    return finding.line === 0 ? path : `${path}:${String(finding.line)}`
  }
  const lines = []
  for (const note of result.notes) lines.push(`check-layers: 提示：${note}`)
  if (hard.length > 0) {
    lines.push('check-layers: 三层设计腐败（硬规则）')
    const byRule = new Map()
    for (const finding of hard) byRule.set(finding.rule, [...(byRule.get(finding.rule) ?? []), finding])
    for (const [rule, list] of [...byRule].sort()) {
      lines.push('', `[${rule}] ${String(list.length)} 处`)
      for (const finding of list) lines.push(`  ${where(finding)}`, `    ${finding.message}`)
    }
  }
  if (soft.length > 0) {
    lines.push('', 'check-layers: 告警（需人工确认，不影响退出码）')
    for (const finding of soft) lines.push(`  [${finding.rule}] ${where(finding)}`, `    ${finding.message}`)
  }
  lines.push(hard.length === 0
    ? `check-layers: 通过（硬规则 0 违规，告警 ${String(soft.length)} 条）`
    : `check-layers: 失败（硬规则 ${String(hard.length)} 处，告警 ${String(soft.length)} 条）`)
  return { text: lines.join('\n'), exitCode: hard.length === 0 ? 0 : 1 }
}

if (import.meta.main) {
  try {
    const result = checkLayers(loadProject())
    const { text, exitCode } = renderReport(result, DEFAULT_REPO_ROOT)
    // 失败走 stderr（便于 `&&` 链与日志分流），通过走 stdout。
    if (exitCode === 0) console.log(text)
    else console.error(text)
    process.exit(exitCode)
  } catch (error) {
    console.error(`check-layers: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
