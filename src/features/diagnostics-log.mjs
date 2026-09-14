/**
 * 功能层：启动诊断文件的写入。
 *
 * 为什么单独成层：patch 层只做任务调度与导出修改，**不实现功能**。而「诊断行长什么样、怎么写盘、
 * 失败怎么办」属于功能实现 —— 与 `build-cache.mjs`（格式化 + 写 marker）、`profile-recovery.mjs`
 * （格式化 + 写 profile 文件）同类。所以实现放这里，patch 层只保留「从哪个环境变量取文件路径、
 * 在哪些时机调用」这类接线。
 *
 * 消费方：`apps/desktop/src/main.ts` 的 `publishBackend`（每次后端状态变化）与 `showStartupError`
 * （失败入口）。打包产物是 GUI 进程、没有控制台，该文件是它唯一的对外可读输出。
 */

import { appendFileSync } from 'node:fs'

/**
 * 生成一行诊断记录：`<ISO 时间> phase=<阶段>[ <细节>]`，以换行结尾。
 *
 * `detail` 里的换行会被压成空格，保证一条记录一行 —— 否则调用方无法按行解析。
 * @param {string} phase 阶段名，例如 `starting` / `ready` / `application-page` / `error`。
 * @param {string} [detail] 该阶段的补充内容；空串与 undefined 都不追加。
 * @returns {string} 可直接写入文件的一行（含换行）。
 */
export function formatDiagnosticLine(phase, detail) {
  const suffix = detail === undefined || detail === '' ? '' : ` ${detail.replaceAll('\n', ' ')}`
  return `${new Date().toISOString()} phase=${phase}${suffix}\n`
}

/**
 * 以追加方式写一行诊断记录。写失败只告警，**不向上抛** —— 诊断本身不能成为新的失败源。
 * @param {string} file 目标文件路径。
 * @param {string} phase 阶段名。
 * @param {string} [detail] 该阶段的补充内容。
 * @returns {void}
 */
export function appendDiagnosticLine(file, phase, detail) {
  try {
    appendFileSync(file, formatDiagnosticLine(phase, detail))
  } catch (error) {
    console.error('dsh desktop: diagnostic file is not writable', error)
  }
}
