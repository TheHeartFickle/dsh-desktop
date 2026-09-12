/**
 * `build-cache.mjs` 的类型声明。
 *
 * 注入到源仓库后，调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译，
 * 没有声明文件就是 TS7016「隐式 any」。声明与实现必须同步改。
 */

/** `contentKey` 的可选项。 */
export interface ContentKeyOptions {
  /** 输入路径的基准目录，默认为 `process.cwd()`。 */
  readonly base?: string
  /** 一组输入共用的前置键，先于输入混入哈希。 */
  readonly extra?: string
}

/** `reuse` 的可选项。 */
export interface ReuseOptions {
  /** 阶段名，同名字符串必须在两次构建里稳定。 */
  readonly stage: string
  /** 该阶段输入的内容键；上游 pin 由本层混入。省略或空串 = 不可缓存，永远重做。 */
  readonly key: string | undefined
  /** marker 文件路径；命中时读它，重做后写它。 */
  readonly marker: string
  /** 未命中时真的做事；可以是异步的，`reuse` 会等它结束再记 marker。 */
  readonly produce: () => unknown
  /** 产物路径，其字节数与 sha256 记进 marker 并在命中时复核；整棵大目录改用 `verify`。 */
  readonly outputs?: readonly string[]
  /** 额外校验句柄（例如上游自带的产物校验函数）：返回真值才算命中，抛错或返回假值一律重做。 */
  readonly verify?: () => unknown
}

/** `reusePackedDirectory` 的可选项。 */
export interface ReusePackedDirectoryOptions {
  /** 阶段名，同名字符串必须在两次构建里稳定。 */
  readonly stage: string
  /** 该阶段的输入内容键。 */
  readonly key: string
  /** 缓存目录；marker 为其中的 `tarball.json`。 */
  readonly cacheDirectory: string
  /** 缓存里的 packed 目录，`produce` 把 tarball 写进这里。 */
  readonly packedDirectory: string
  /** 真正要发布到的输出目录。 */
  readonly destination: string
  /** 未命中时真的做事（清空 `packedDirectory` 并 pack 进去）。 */
  readonly produce: () => unknown
}

/**
 * 算一组输入的内容键：路径 + 内容逐字节进哈希，目录递归、跳过 `node_modules` 与 `.git`。
 * @param inputs - 输入路径（文件或目录），相对 `options.base`。
 * @param options - `base` 默认为 `process.cwd()`；`extra` 先于输入混入。
 * @returns 十六进制内容键。
 */
export function contentKey(inputs: readonly string[], options?: ContentKeyOptions): string

/**
 * 内容键命中就跳过 `produce`，否则执行 `produce` 并写下新 marker。
 * 命中需要 marker 存在、key 相同（含上游 pin）、记录的产物摘要全部复核通过、`verify` 返回真值。
 * @param options - 阶段名、键、marker 路径、产出函数，以及可选的产物摘要与校验句柄。
 * @returns 命中返回 `true`（已跳过），重做返回 `false`。
 */
export function reuse(options: ReuseOptions): Promise<boolean>

/**
 * 缓存一个「pack 出来的目录」，并在每次运行时把它发布到真正的输出目录。
 * @param options - 阶段名、键、缓存目录、packed 目录、输出目录与产出函数。
 * @returns 发布完成后返回。
 */
export function reusePackedDirectory(options: ReusePackedDirectoryOptions): Promise<void>
