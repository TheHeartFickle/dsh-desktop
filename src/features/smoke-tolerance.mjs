/**
 * 实现层：payload smoke 的检查项容忍策略。
 *
 * 背景：`fs-ext` 已被 `@deepseek-ai/node-addon-system` 取代——没有任何工作区包声明它，
 * `packages/` 下也无引用，但上游 smoke 仍要求它，于是当前 HEAD 打包 Windows 必然在此失败。
 * 官方修好之前由本层显式声明「允许跳过」，而不是让补丁直接删掉官方的检查代码：
 * 上游一旦恢复提供该包，`loadOrSkip` 就走正常路径，检查自动恢复。
 */
import { SMOKE_CHECKS, formatSmokeSkipLine } from '../adaptator/smoke.mjs'

/** 检查项 → 跳过原因；不在此表内的检查项缺失即视为失败 */
const TOLERATED_CHECKS = Object.freeze({
  'fs-ext': 'superseded by node-addon-system',
})

/**
 * 该检查项被容忍跳过时返回可直接写 stdout 的提示行，否则返回 null。
 * 未知 checkId 一律返回 null：补丁里的标识写错时应当照常失败，而不是静默跳过。
 * @param {string} checkId
 * @returns {string | null}
 */
export function smokeSkipLine(checkId) {
  if (!SMOKE_CHECKS.includes(checkId)) return null
  const detail = TOLERATED_CHECKS[checkId]
  return detail === undefined ? null : formatSmokeSkipLine(checkId, detail)
}

/**
 * 按官方方式加载一个 runtime 模块；加载失败但该检查项被容忍时，输出跳过提示并返回 null。
 * 补丁只负责接线（把 `requireRuntime('fs-ext')` 换成 `loadOrSkip('fs-ext', requireRuntime)`），
 * 调用方拿到 null 后直接 return，即跳过该检查。
 * @param {string} checkId
 * @param {(id: string) => unknown} load 官方的 requireRuntime
 * @returns {unknown | null}
 */
export function loadOrSkip(checkId, load) {
  try {
    return load(checkId)
  } catch (error) {
    const skipLine = smokeSkipLine(checkId)
    if (skipLine === null) throw error
    process.stdout.write(skipLine)
    return null
  }
}
