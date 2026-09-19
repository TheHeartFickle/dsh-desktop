/**
 * `diagnostics-signals.mjs` 的类型声明。
 *
 * 注入到源仓库后，调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译，
 * 没有声明文件就是 TS7016「隐式 any」。声明与实现必须同步改。
 */

/** 一个官方失败信号：阶段 + 规则 id + 判据。 */
export interface StageSignal {
  /** 两层共享的阶段词表：`host` / `graph` / `install` / `store` / `config` / `version`。 */
  readonly stage: string
  /** 命中的具体规则 id，用于日志与测试对照。 */
  readonly rule: string
  /** 匹配官方错误文本的模式。 */
  readonly matches: RegExp
}

/** 有序的官方失败信号表；顺序即判据（越具体越靠前）。 */
export const STAGE_SIGNALS: readonly StageSignal[]

/**
 * 用官方错误文本命中一个稳定信号。
 * @param text - 失败的错误文本。
 * @returns 命中的信号；没有命中返回 null。
 */
export function matchStageSignal(text: string): StageSignal | null
