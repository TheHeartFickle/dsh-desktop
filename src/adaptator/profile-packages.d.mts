/**
 * `profile-packages.mjs` 的类型声明。
 *
 * 注入到源仓库后，调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译，
 * 没有声明文件就是 TS7016「隐式 any」。声明与实现必须同步改。
 */

/**
 * 让 profile 的已装包与清单一致：在 profile 里重跑一次 pnpm install（非 frozen、忽略脚本）。
 * @param options - profile，以及运行内置 pnpm 所需的官方事实。
 * @returns 安装完成时 resolve；失败抛出带 pnpm 诊断的 Error。
 */
export function installProfilePackages(options: {
  readonly profile: string
  /** Electron 可执行文件，以 `ELECTRON_RUN_AS_NODE` 方式运行 pnpm。 */
  readonly node: string
  /** 内置 pnpm 入口（`pnpm.mjs`）。 */
  readonly pnpm: string
  /** 供 pnpm 子进程使用的 node launcher 目录；省略时不改 PATH。 */
  readonly nodeBin?: string
  /** 覆盖 pnpm 的 registry；省略时读 `DSH_LOCAL_NPM_REGISTRY`，仍未设置则用 pnpm 自身的配置。 */
  readonly registry?: string
}): void
