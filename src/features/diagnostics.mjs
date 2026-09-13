/**
 * 功能层：启动失败的诊断规则（阶段 5）。
 *
 * 官方已有的错误出口是「启动页 + `desktopErrorState(error).message`」（决策 9：不弹原生框）。本层在它
 * 之上补一层人能读懂的判断：把原始错误串归到**一个**阶段，并给出该阶段可执行的下一步。
 *
 * 三条约束（与 design 第 5.2 节一致）：
 * 1. **按阶段分组**：组内是同一个失败面的规则，阶段标题即该失败面。
 * 2. **规则互不可见**：每条规则只看错误串与上下文，不引用其他规则、不做跨阶段归因。
 * 3. **首因原则**：只报第一个命中的阶段；没有命中就返回 null，调用方照常显示原始错误。
 *
 * 为什么规则基于上游**实际**错误串：官方架构固定了运行时的版本与安装路径，环境层与依赖层已经消失，
 * 剩下的失败面集中在这些错误串上；凭空造规则只会误诊。规则失配时返回 null（退回原始错误），不会猜。
 */

/** 诊断所需的上下文，全部来自调用方已经解析好的事实。 */
const STAGE = Object.freeze({
  host: {
    title: '壳与 Host 启动失败',
    hint: '应用的 Host 进程没有起来，或与壳之间的管道握手失败。先重启应用；若反复出现，重新安装应用（运行时由安装包自带，不需要单独升级 Node）。',
  },
  graph: {
    title: 'profile 与插件图失败',
    hint: '桌面 profile 里安装的插件与内置 dsh 不兼容，或依赖解析不完整。在「桌面插件」窗口里禁用或更新最近安装的插件；也可以在上次启动失败后用启动页的「禁用全部第三方插件并重试」。',
  },
  store: {
    title: '包管理缓存失败',
    hint: '内置 pnpm 读写自己的 store / cache 目录失败（常见原因：磁盘空间不足、目录被杀软或同步工具占用、跨盘硬链接不可用）。腾出空间或排除杀软扫描后重启应用；仍失败可删除应用的缓存目录再试。',
  },
  config: {
    title: 'profile 配置失败',
    hint: 'profile 的配置文件损坏或引用了不存在的行 id。用启动页的「重置 Desktop 并重试」重建配置；共享的任务与设置不会被删除。',
  },
  version: {
    title: '内置 dsh 与插件版本不匹配',
    hint: '至少一个插件要求的内置 dsh 版本与应用自带的版本不同。更新该插件到与应用匹配的版本；若不兼容，先在「桌面插件」窗口禁用它。',
  },
})

/**
 * 规则表，按阶段分组。
 *
 * 每条 `matches(error, context)` 只判断自己的失败面。**组间顺序也是判据**：越具体的失败面越靠前
 * （版本一致性 → 配置 → 插件图 → 包缓存）：越窄的模式越靠前，避免被「requires …」这类宽模式截胡，宽模式不会把具体失败截胡；组内先命中先返回（首因原则）。
 * 正则全部来自上游源码里的真实错误串（`apps/desktop/src/*.ts`、`apps/desktop-host/src/index.ts`）。
 */
const RULES = Object.freeze({
  version: [
    { id: 'host-protocol-version', matches: /protocol version|protocolVersion/i },
    {
      id: 'dsh-version-mismatch',
      matches: /(?:requires|expected|needs)\s+(?:@deepseek-ai\/dsh|dsh)[^0-9]*[0-9]+\.[0-9]+\.[0-9]+|(?:@deepseek-ai\/dsh|dsh)[^\n]*found\s+[0-9]+\.[0-9]+\.[0-9]+/i,
    },
  ],
  host: [
    { id: 'host-spawn-failed', matches: /expected runtime and profile directories|Control channel|Host is stopping|spawn/i },
    { id: 'host-request-transport', matches: /Electron request|Electron response|Electron canceled|invalid Electron request frame/i },
  ],
  config: [
    { id: 'patch-line-missing', matches: /line id|patch line|cordis\.patch\.yml/i },
    { id: 'config-invalid', matches: /desktop project: invalid desktop profile manifest|desktop profile: invalid runtime state|desktop profile: invalid .*manifest|restored profile is missing its configuration files/i },
    { id: 'profile-mismatch', matches: /does not match this application runtime/i },
  ],
  graph: [
    { id: 'profile-not-installed', matches: /active profile is not installed|package preparation is incomplete/i },
    { id: 'graph-unresolved', matches: /requires missing|outside its owned packages|must declare .* as a peer dependency|requires .*found|missing local plugin|missing or incorrect host link/i },
    { id: 'graph-incomplete-install', matches: /invalid installed package|has no manifest|duplicate or aliased host package|linked private package|linked package container|declares no dsh\.profile|must begin with the built-in desktop bundles/i },
    { id: 'plugin-load-failed', matches: /copied web profile plugins could not be loaded|cannot be loaded/i },
  ],
  store: [
    { id: 'lock-contention', matches: /another package transaction is active|package transaction lock|package transaction lost its lock/i },
    { id: 'store-unwritable', matches: /store|cache|database|EACCES|EPERM|ENOSPC|different disk|cross-device link|EXDEV/i },
  ],
})

/**
 * 用诊断规则解释一次启动失败。
 * @param error - 捕获到的失败（Error、AggregateError 或任意值，按官方 `desktopErrorState` 的同一读法）。
 * @param context - 已解析的路径事实；用于附加可执行的下一步（当前规则只用到 `profileRecovery`）。
 * @returns 命中的阶段诊断；没有命中返回 null。
 */
export function diagnoseStartupFailure(error, context = {}) {
  const text = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => (item instanceof Error ? item.message : String(item)))].join('\n')
    : error instanceof Error ? error.message : String(error)
  for (const [stage, rules] of Object.entries(RULES)) {
    const rule = rules.find(candidate => candidate.matches.test(text))
    if (rule === undefined) continue
    const stageInfo = STAGE[stage]
    return {
      stage,
      rule: rule.id,
      title: stageInfo.title,
      hint: context.profileRecovery === false
        ? `${stageInfo.hint}（本次启动无法从应用内修复 profile，可能需要重新安装应用）`
        : stageInfo.hint,
      message: text,
    }
  }
  return null
}

/**
 * 把诊断结果拼进官方错误出口用的消息文本。
 * @param diagnosis - `diagnoseStartupFailure` 的返回值。
 * @returns 阶段标题 + 下一步 + 原始错误串（原始串保留，避免诊断出错时把人挡在真相之外）。
 */
export function formatDiagnosis(diagnosis) {
  return `${diagnosis.title}\n${diagnosis.hint}\n\n---\n${diagnosis.message}`
}

/** 所有规则 id，供单测覆盖与文档校对。 */
export const DIAGNOSTIC_RULES = Object.freeze(
  Object.fromEntries(Object.entries(RULES).map(([stage, rules]) => [stage, rules.map(rule => rule.id)])),
)
