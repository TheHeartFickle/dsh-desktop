/**
 * `smoke-tolerance.mjs` 的类型声明。
 *
 * 与实现同期维护：调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译。
 */

/**
 * 该检查项被容忍跳过时返回可直接写 stdout 的提示行，否则返回 null。
 * 未知 checkId 一律返回 null（补丁里的标识写错时应当照常失败，而不是静默跳过）。
 * @param checkId - 检查项标识。
 * @returns 跳过提示行；该检查项不被容忍或标识未知时返回 null。
 */
export function smokeSkipLine(checkId: string): string | null

/**
 * 按官方方式加载一个 runtime 模块；加载失败但该检查项被容忍时，输出跳过提示并返回 null。
 * @param checkId - 检查项标识。
 * @param load - 官方的 `requireRuntime`。
 * @returns 加载结果；被容忍跳过时返回 null；不被容忍时原样抛错。
 */
export function loadOrSkip(checkId: string, load: (id: string) => unknown): unknown
