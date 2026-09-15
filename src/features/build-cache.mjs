/**
 * 功能层：内容寻址的构建缓存。
 *
 * 上游每个阶段都是"重跑一遍"：`pack.ts` 全量重打 266 个 tarball，`build:official` 全量重编译，
 * `prepare:dsh` 在干净临时目录里重装 506 个包，`electron-builder` 全量重装配。重复构建时这些输入一个
 * 字节都没变，重跑纯属浪费。本层把"要不要重做"变成一个可由内容算出的问题：
 *
 *   key = 该阶段输入内容的内容键 + 上游 pin；命中且缓存产物复核通过 → 跳过；否则重做。
 *
 * 分流判断（key 怎么算、产物怎么校验、什么条件下算命中）全部在本层；patch 只负责把
 * `contentKey` / `reuse` / `reusePackedDirectory` 的调用插进上游流程，并把产物路径与校验句柄传进来。
 *
 * 三条必须守住的语义：
 * 1. **漏项只允许朝"多算"方向**：key 覆盖的输入可以比实际更宽（白白重做），但不能更窄
 *    （命中却输入已变 = 陈旧产物）。拿不准时把整个目录塞进 `contentKey` —— 但那个目录
 *    **不能包含本阶段自己写出的产物**（`.desktop-build`、`dist`、`*.tsbuildinfo`），否则键自我引用、
 *    永不命中；`node_modules` 与 `.git` 是唯一自动跳过的目录名。
 * 2. **命中不等于产物没问题**：能记摘要的产物在 marker 里记下字节数与 sha256，命中时逐条复核；
 *    复核不起的（例如整棵 `node_modules`）由调用方传 `verify` 句柄（如上游 `verifyDesktopRuntime`）。
 * 3. **缓存按上游 pin 分区**：`DSH_UPSTREAM_CHECKOUT` 由构建流程注入并混进每个键 —— 换提交后
 *    所有缓存自动失效，不需要人去删目录。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 遍历时始终跳过的目录名：它们不是构建输入，且体量巨大。 */
const ALWAYS_IGNORED = new Set(['node_modules', '.git'])

function walk(absolute, prefix, files) {
  for (const name of readdirSync(absolute).sort()) {
    if (ALWAYS_IGNORED.has(name)) continue
    const child = join(absolute, name)
    const childRelative = join(prefix, name)
    const childStats = statSync(child)
    if (childStats.isDirectory()) walk(child, childRelative, files)
    else if (childStats.isFile()) files.push({ absolute: child, relative: childRelative })
  }
}

/** 展开输入路径为 `{ absolute, relative }` 列表；目录递归、按名字排序、跳过 `node_modules` 与 `.git`。 */
function expand(inputs, base) {
  const files = []
  for (const input of inputs) {
    const absolute = resolve(base, input)
    if (!existsSync(absolute)) continue
    const stats = statSync(absolute)
    if (stats.isFile()) files.push({ absolute, relative: input })
    else walk(absolute, input, files)
  }
  files.sort((left, right) => (left.absolute < right.absolute ? -1 : left.absolute > right.absolute ? 1 : 0))
  return files
}

/**
 * 算一组输入的内容键：路径 + 内容逐字节进哈希。
 * @param {readonly string[]} inputs 输入路径（文件或目录），相对 `base`。
 * @param {{ base?: string, extra?: string }} [options] `base` 默认为 `process.cwd()`；
 *   `extra` 用来把一组输入共用的前置键（例如整仓依赖解析结果）混进来，避免每个成员重复哈希它。
 * @returns {string} 十六进制内容键；输入为空时返回空清单的键（仍是一个确定值）。
 */
export function contentKey(inputs, options = {}) {
  const base = options.base ?? process.cwd()
  const hash = createHash('sha256')
  if (options.extra !== undefined) hash.update(`${options.extra}\u0000`)
  for (const file of expand(inputs, base)) {
    hash.update(`${file.relative.replaceAll('\\', '/')}\u0000`)
    hash.update(readFileSync(file.absolute))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/** 把一组产物的字节数与 sha256 记成 marker 里的条目（路径缺失即视为没有该产物）。 */
function digest(outputs) {
  return expand(outputs, process.cwd()).map(file => ({
    path: file.absolute,
    bytes: statSync(file.absolute).size,
    sha256: createHash('sha256').update(readFileSync(file.absolute)).digest('hex'),
  }))
}

/** 上游 pin 参与每个键：产物属于某个确定的官方版本，换提交后所有缓存必须失效。 */
function scopedKey(key) {
  const checkout = process.env.DSH_UPSTREAM_CHECKOUT
  return checkout === undefined || checkout === '' ? key : `${key}\u0000${checkout}`
}

/** 读 marker；不存在或不是合法 JSON 一律当"没有缓存"，不抛错。 */
function readMarker(marker) {
  if (!existsSync(marker)) return null
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && typeof parsed.key === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** 复核 marker 里记录的产物摘要；任一条目缺失、字节数或 sha256 不符即视为产物不可信。 */
function outputsIntact(outputs) {
  for (const entry of outputs) {
    if (!existsSync(entry.path)) return false
    if (statSync(entry.path).size !== entry.bytes) return false
    if (createHash('sha256').update(readFileSync(entry.path)).digest('hex') !== entry.sha256) return false
  }
  return true
}

/**
 * 跑调用方给的校验句柄：返回真值算通过，抛错或返回假值都算未通过（句柄由调用方提供，
 * 例如上游自带的产物校验函数；本层只负责把结论折算成命中或重做）。
 */
async function verifyPassed(verify) {
  try {
    return Boolean(await verify())
  } catch {
    // 句柄自己的失败原因不重要：拿不到"产物可信"的结论就必须重做。
    return false
  }
}

function log(stage, outcome) {
  process.stdout.write(`build-cache: ${stage} ${outcome}\n`)
}

/**
 * 内容键命中就跳过 `produce`，否则执行 `produce` 并写下新的 marker。
 *
 * 命中需要同时满足：marker 存在、key 相同、marker 记录的产物摘要全部复核通过、
 * 调用方给的 `verify`（可选）为真。任何一条不满足都重做 —— 宁可多算，不可漏算。
 * `key` 省略或为空串表示"这一阶段不可缓存"（例如上游脚本被独立运行时拿不到流程算出的键）：
 * 直接重做，且不写 marker。
 * @param {{
 *   stage: string,
 *   key: string | undefined,
 *   marker: string,
 *   produce: () => unknown,
 *   outputs?: readonly string[],
 *   verify?: () => unknown,
 * }} options `outputs` 传绝对路径（或能按 `process.cwd()` 解析的相对路径）；
 *   `verify` 返回真值算通过，抛错或返回假值算未通过，可以是异步的。
 * @returns {Promise<boolean>} 命中的返回 `true`（已跳过 `produce`），重做的返回 `false`。
 */
export async function reuse(options) {
  const { stage, key, marker, produce, outputs, verify } = options
  const cacheable = key !== undefined && key !== ''
  const effectiveKey = cacheable ? scopedKey(key) : ''
  const previous = cacheable ? readMarker(marker) : null
  let reason
  if (!cacheable) reason = 'no-key'
  else if (previous === null) reason = 'no-marker'
  else if (previous.key !== effectiveKey) reason = 'key-changed'
  else if (Array.isArray(previous.outputs) && !outputsIntact(previous.outputs)) reason = 'outputs-changed'
  else if (verify !== undefined && !(await verifyPassed(verify))) reason = 'verify-failed'
  if (reason === undefined) {
    log(stage, 'hit')
    return true
  }
  log(stage, `miss (${reason})`)
  mkdirSync(dirname(marker), { recursive: true })
  await produce()
  if (cacheable) {
    writeFileSync(marker, `${JSON.stringify({
      stage,
      key: effectiveKey,
      outputs: outputs === undefined ? undefined : digest(outputs),
    }, undefined, 2)}\n`)
  }
  return false
}

/**
 * 缓存一个「pack 出来的目录」，并在每次运行时把它发布到真正的输出目录。
 *
 * 上游有三处各自 `pnpm pack`（release packer 的成员、私有 Host、native entry）：`pnpm pack` 的字节
 * 不可复现，而下游（package set → `prepare:dsh`）按 tarball 内容定键，所以三处必须用同一套语义 ——
 * 未命中时先清空 `packedDirectory` 再交给 `produce` 打包，命中时直接用缓存目录；两种情况都把
 * `packedDirectory` 里的文件原样拷进 `destination`。
 *
 * `destination` 可能由多个生产者共写（例如 release packer 与私有 Host 都写 `packed/dsh`），所以本函数
 * 只覆盖同名文件，不清空它 —— 需要"输出目录里只有本次产物"的生产者自己先清。
 * @param {{
 *   stage: string,
 *   key: string,
 *   cacheDirectory: string,
 *   packedDirectory: string,
 *   destination: string,
 *   produce: () => unknown,
 * }} options `produce` 只需把 tarball 写进 `packedDirectory`。
 * @returns {Promise<void>} 发布完成后返回。
 */
export async function reusePackedDirectory(options) {
  const { stage, key, cacheDirectory, packedDirectory, destination, produce } = options
  await reuse({
    stage,
    key,
    marker: join(cacheDirectory, 'tarball.json'),
    outputs: [packedDirectory],
    produce: async () => {
      rmSync(packedDirectory, { recursive: true, force: true })
      mkdirSync(packedDirectory, { recursive: true })
      await produce()
    },
  })
  mkdirSync(destination, { recursive: true })
  for (const packed of readdirSync(packedDirectory)) {
    copyFileSync(join(packedDirectory, packed), join(destination, packed))
  }
}
