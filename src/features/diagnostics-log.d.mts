/**
 * `diagnostics-log.mjs` 的类型声明。
 *
 * 与实现同期维护：调用点由源仓库自己的 `tsc -b`（strict + noImplicitAny）编译。
 */

/**
 * 生成一行诊断记录：`<ISO 时间> phase=<阶段>[ <细节>]`，以换行结尾。
 * @param phase - 阶段名。
 * @param detail - 该阶段的补充内容；空串与 undefined 都不追加；内部换行会被压成空格。
 * @returns 可直接写入文件的一行（含换行）。
 */
export function formatDiagnosticLine(phase: string, detail?: string): string

/**
 * 以追加方式写一行诊断记录。写失败只告警，不向上抛。
 * @param file - 目标文件路径。
 * @param phase - 阶段名。
 * @param detail - 该阶段的补充内容。
 */
export function appendDiagnosticLine(file: string, phase: string, detail?: string): void
