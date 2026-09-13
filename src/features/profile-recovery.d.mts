/**
 * `profile-recovery.mjs` 的类型声明。
 *
 * 注入到源仓库后，调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译，
 * 没有声明文件就是 TS7016「隐式 any」。声明与实现必须同步改。
 */

/** `webProfileCopyPlan` 的可选项。 */
export interface WebProfileCopyOptions {
  /** desktop profile 目录。 */
  readonly desktopProfile: string
  /** web profile 目录。 */
  readonly webProfile: string
  /** 注入点，测试用；生产路径读真实 `node:fs`。 */
  readonly fs?: unknown
  readonly errors?: unknown
}

/** 一次「复制 web 配置」写入的内容。 */
export interface WebProfileCopyPlan {
  /** 合并后的 desktop 清单（已含 web 的第三方 dependencies 与 bundles）。 */
  readonly manifest: Record<string, unknown>
  /** 合并后的 `pnpm-workspace.yaml` 文本。 */
  readonly workspace: string
  /** 声明启用的第三方插件，按 bundles 顺序。 */
  readonly plugins: readonly string[]
}

/** profile 里被快照的文件：相对文件名 → 字节内容。 */
export interface ProfileSnapshot {
  readonly files: Readonly<Record<string, string>>
}

/**
 * 计算复制内容；web profile 没有第三方插件时返回 null。
 * @param options - 目录与可注入依赖。
 * @returns 计划或 null。
 */
export function webProfileCopyPlan(options: WebProfileCopyOptions): WebProfileCopyPlan | null

/**
 * 判断计划与 desktop 当前文件是否已有差异。
 * @param options - 目录与计划。
 * @returns 需要写入时为 `true`。
 */
export function webProfileCopyChanged(options: { readonly desktopProfile: string; readonly plan: WebProfileCopyPlan; readonly fs?: unknown }): boolean

/**
 * 写下一份复制计划（先写临时文件再改名）。
 * @param desktopProfile - 目标 profile 目录。
 * @param plan - 计划。
 * @param options - 可注入依赖。
 */
export function applyWebProfileCopy(desktopProfile: string, plan: WebProfileCopyPlan, options?: { readonly fs?: unknown }): void

/**
 * 拍下 profile 的可变文件快照。
 * @param options - profile 目录。
 * @returns 快照；不含不存在的可选文件。
 */
export function snapshotProfile(options: { readonly profile: string; readonly fs?: unknown }): ProfileSnapshot

/**
 * 还原快照并重建 profile（还原文件 → 重建依赖 → 刷新宿主包链接）。
 * @param options - profile、快照与 `onRepair`（交给宿主的重建能力）。
 * @returns 还原/删除的文件名。
 */
export function rollbackProfile(options: {
  readonly profile: string
  readonly snapshot: ProfileSnapshot
  readonly onRepair: () => Promise<void>
  readonly fs?: unknown
  readonly errors?: unknown
}): Promise<{ readonly restored: readonly string[]; readonly removed: readonly string[] }>

/**
 * 在 desktop runtime 的 Node 里逐个 `import()` 插件，返回失败描述。
 * @param options - profile、插件名与 runtime 的 Node 可执行文件。
 * @returns 失败描述列表；为空即通过。
 */
export function installProbeFailures(options: {
  readonly profile: string
  readonly plugins: readonly string[]
  readonly node: string
}): readonly string[]

/**
 * 回退提示的经典脚本（交给 `webContents.executeJavaScript`）。
 * @param options - 提示信号与文案。
 * @returns 自执行表达式。
 */
export function startupNoticeScript(options: { readonly signal: string; readonly text: string }): string
