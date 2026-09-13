/**
 * `diagnostics.mjs` 的类型声明。
 *
 * 与实现同期维护：调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译。
 */

/** 一次启动失败的诊断结果。 */
export interface DesktopDiagnosis {
  /** 命中的阶段：`host` / `graph` / `store` / `config` / `version`。 */
  readonly stage: string
  /** 命中的规则 id，用于日志与测试对照。 */
  readonly rule: string
  /** 人能读懂的阶段标题。 */
  readonly title: string
  /** 该阶段可执行的下一步。 */
  readonly hint: string
  /** 原始错误串，保留给日志。 */
  readonly message: string
}

/**
 * 用诊断规则解释一次启动失败。
 * @param error - 捕获到的失败；`AggregateError` 按官方 `desktopErrorState` 的同一读法展开。
 * @param context - 已解析的路径事实；`profileRecovery: false` 时会补「可能需要重新安装」。
 * @returns 命中的阶段诊断；没有命中返回 null。
 */
export function diagnoseStartupFailure(
  error: unknown,
  context?: { readonly profileRecovery?: boolean },
): DesktopDiagnosis | null

/**
 * 把诊断结果拼进官方错误出口用的消息文本（阶段标题 + 下一步 + 原始错误串）。
 * @param diagnosis - 诊断结果。
 * @returns 展示文本。
 */
export function formatDiagnosis(diagnosis: DesktopDiagnosis): string

/** 规则表：阶段 → 规则 id，供单测覆盖与文档校对。 */
export const DIAGNOSTIC_RULES: Readonly<Record<string, readonly string[]>>
