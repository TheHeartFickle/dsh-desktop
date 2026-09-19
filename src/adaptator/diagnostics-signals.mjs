/**
 * 适配层：把官方启动失败的**错误文本**固定成稳定信号。
 *
 * 官方文件：`apps/desktop/src/**`、`apps/desktop-host/src/**`、`packages/boot/app-boot/src/profile.ts`
 * ——失败文本由这些源码里的 `throw` / `reportFatal` 产生。功能层要做「把失败归到一个阶段，给出标题与
 * 下一步」，但它**不该知道官方写了哪些串**：那层知识连顺序一起固定在本文件，命中即返回一个信号。
 * 官方改文案时只改本文件；功能层改的是「这个阶段该说什么」。
 *
 * **顺序即判据**：越具体的失败面越靠前（版本一致性 → 壳与 Host 启动 → 配置 → 插件图 → 插件安装 →
 * 包缓存），同组内先命中先返回（首因原则）。**故意不设「pnpm install 失败」这类宽规则**：它会把所有
 * 包管理器失败一网打尽，让下面更具体的错误码规则永远轮不到。
 *
 * `stage` 是两层共享的稳定词表（功能层用它取标题与下一步）；`rule` 是命中的具体规则 id，用于日志与测试。
 * 正则全部来自上游源码里的真实错误串，不凭空造；失配就返回 null，由调用方照官方原样显示。
 */
export const STAGE_SIGNALS = Object.freeze([
  {
    stage: 'version',
    rule: 'dsh-version-mismatch',
    matches: /(?:requires|expected|needs)\s+(?:@deepseek-ai\/dsh|dsh)[^0-9]*[0-9]+\.[0-9]+\.[0-9]+|(?:@deepseek-ai\/dsh|dsh)[^\n]*found\s+[0-9]+\.[0-9]+\.[0-9]+/i,
  },
  {
    stage: 'host',
    rule: 'host-process-failed',
    matches: /dsh desktop host (?:exited|stopped|sent an invalid IPC event|acknowledged an unrequested shutdown|did not exit)/i,
  },
  {
    stage: 'host',
    rule: 'host-unavailable',
    matches: /Desktop Host (?:is unavailable|did not provide boot injections|authentication failed)/i,
  },
  { stage: 'host', rule: 'host-preparation-failed', matches: /host preparation failed/i },
  { stage: 'host', rule: 'package-manager-unavailable', matches: /desktop profile: pnpm install could not run/i },
  { stage: 'host', rule: 'runtime-install-failed', matches: /primary runtime: /i },
  { stage: 'host', rule: 'window-load-failed', matches: /Desktop page failed to load|Desktop renderer exited/i },
  { stage: 'config', rule: 'patch-line-missing', matches: /line id|patch line|cordis\.patch\.yml/i },
  {
    stage: 'config',
    rule: 'profile-lock',
    matches: /desktop project: (?:profile lock is not a regular file|another profile operation is active)/i,
  },
  {
    stage: 'config',
    rule: 'profile-files-invalid',
    matches: /profile manifest .*(?:failed to read|must hold a JSON object)|desktop profile: (?:profile is missing its configuration files|.*is not a regular file|.*is not valid JSON|.*must be a JSON object|invalid legacy package link)/i,
  },
  { stage: 'config', rule: 'profile-cleanup-refused', matches: /desktop profile cleanup: /i },
  { stage: 'graph', rule: 'graph-unresolved', matches: /cannot resolve profile bundle/i },
  { stage: 'graph', rule: 'graph-fallback-blocked', matches: /is not a symlink or dsh-managed module proxy/i },
  {
    stage: 'graph',
    rule: 'plugin-load-failed',
    matches: /plugin tree failed to load|required plugins? did not activate|copied web profile plugins could not be loaded/i,
  },
  // 只收 pnpm 真实报错里出现过的错误码族（`ERR_PNPM_FETCH_404` 为实测样本）；拿到新样本再补具体码。
  { stage: 'install', rule: 'package-fetch-failed', matches: /ERR_PNPM_FETCH_/i },
  {
    stage: 'store',
    rule: 'store-unwritable',
    matches: /ERR_PNPM_NO_SPACE|ERR_PNPM_UNEXPECTED_STORE|database|EACCES|EPERM|ENOSPC|different disk|cross-device link|EXDEV/i,
  },
])

/**
 * 用官方错误文本命中一个稳定信号。
 * @param {string} text 失败的错误文本（`AggregateError` 由调用方按官方 `desktopErrorState` 的读法展开）。
 * @returns {{ stage: string, rule: string, matches: RegExp } | null} 命中的信号；没有命中返回 null。
 */
export function matchStageSignal(text) {
  for (const signal of STAGE_SIGNALS) {
    if (signal.matches.test(text)) return signal
  }
  return null
}
