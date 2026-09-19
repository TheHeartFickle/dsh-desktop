/**
 * `profile-layout.mjs` 的类型声明。
 *
 * 注入到源仓库后，调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译，
 * 没有声明文件就是 TS7016「隐式 any」。声明与实现必须同步改。
 */

/** profile 里用户可变的文件：语义名 → 磁盘文件名。 */
export const PROFILE_FILES: {
  readonly manifest: string
  readonly workspace: string
  readonly lockfile: string
  readonly patch: string
}

/** 官方为 desktop profile 内置的 bundle 层。 */
export const BUILTIN_BUNDLES: readonly string[]
