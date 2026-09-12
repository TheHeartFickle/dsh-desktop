/**
 * 适配层：隔离上游 payload smoke 的形态。
 *
 * 官方文件：`apps/desktop/tests/fixtures/runtime-payload-smoke.mjs`——由 `scripts/prepare-dsh.ts`
 * 以「打包后的 runtime 目录」为参数直接执行，只判退出码，stdout 透传为构建日志（stderr 只在失败时进错误信息）。
 * 官方改动检查项清单或跳过文案格式时，只改本文件。
 */

/** 官方检查项，顺序即上游 fixture 中的调用顺序 */
export const SMOKE_CHECKS = Object.freeze(['fs-ext', 'koffi', 'sharp', 'html', 'pty'])

/**
 * 按官方格式生成一行跳过提示（含换行，可直接写 stdout）。
 * @param {string} checkId 检查项标识，须在 SMOKE_CHECKS 内
 * @param {string} detail 跳过原因
 * @returns {string}
 */
export function formatSmokeSkipLine(checkId, detail) {
  return `runtime-payload-smoke: ${checkId} absent (${detail}); skipped\n`
}
