/**
 * `tarball.mjs` 的类型声明。
 *
 * 与实现同期维护：调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译。
 */

/**
 * 读 tarball 里的 `package/package.json`，等价于 `tar -xOzf <tarball> package/package.json`。
 * @param tarball - tarball 绝对路径。
 * @returns 解析后的 manifest；抽不到该条目、内容不是对象、或缺 `name` 时抛错。
 */
export function readTarballManifest(tarball: string): Promise<Record<string, unknown>>

/**
 * 列 tarball 里的全部条目路径，等价于 `tar -tzf <tarball>` 再按行切分、过滤空行。
 * @param tarball - tarball 绝对路径。
 * @returns 条目路径列表。
 */
export function listTarballEntries(tarball: string): Promise<string[]>
