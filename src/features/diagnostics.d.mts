/**
 * `diagnostics.mjs` 的类型声明。
 *
 * 与实现同期维护：调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译。
 */

/** 一次启动失败的诊断结果。 */
export interface DesktopDiagnosis {
  /** 命中的阶段：`host` / `graph` / `install` / `store` / `config` / `version`。 */
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

/** 主进程记录启动阶段用的环境变量名。 */
export const DIAGNOSTIC_FILE_ENV: string

/** 到达应用页这一阶段的标记名。 */
export const APPLICATION_PAGE_PHASE: string

/**
 * 把一次启动阶段追加进诊断文件（行格式与写失败兜底都在本层）。
 * @param environment - 进程环境。
 * @param phase - 官方状态名，或 `APPLICATION_PAGE_PHASE`。
 * @param detail - 该阶段的附带文本；失败阶段传官方 `state.message`，其余阶段不传。
 */
export function recordStartupPhase(
  environment: Record<string, string | undefined>,
  phase: string,
  detail?: string,
): void

/**
 * 官方致命错误出口要显示的文本：命中诊断用诊断文本，否则用 `fallback` 给出的官方状态。
 * @param error - 捕获到的失败。
 * @param options - `profileRecovery` 事实与官方兜底读取器。
 */
export function startupErrorState<T>(
  error: unknown,
  options: { readonly profileRecovery: boolean; readonly fallback: (error: unknown) => T },
): T | { readonly phase: 'error'; readonly message: string }
