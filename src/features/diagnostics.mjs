/**
 * 功能层：启动失败的诊断（阶段 5）。
 *
 * 官方已有的错误出口是「`reportFatal` → 原生恢复对话框 + `desktopErrorState(error).message`」。本层在它
 * 之上补一层人能读懂的判断：把原始错误串归到**一个**阶段，并给出该阶段可执行的下一步。
 *
 * 分工：**「官方会说什么错」是适配层的知识**（`src/adaptator/diagnostics-signals.mjs` 的有序信号表），
 * 本层只负责「这个阶段该说什么」——标题、下一步、格式化、诊断文件。官方改文案时本层不动；官方新增一种
 * 失败面时，先加适配层的信号，再在本层的 `STAGE` 里补文案。
 *
 * 三条约束（与 `docs/design.zh.md` 的「阶段 4/5 功能」一致）：
 * 1. **按阶段分组**：组内是同一个失败面的规则，阶段标题即该失败面。
 * 2. **规则互不可见**：每条规则只看错误串与上下文，不引用其他规则、不做跨阶段归因。
 * 3. **首因原则**：只报第一个命中的阶段；没有命中就返回 null，调用方照常显示原始错误。
 *
 * 为什么信号基于上游**实际**错误串：官方架构固定了运行时的版本与安装路径，环境层与依赖层已经消失，
 * 剩下的失败面集中在这些错误串上；凭空造规则只会误诊。失配时返回 null（退回原始错误），不会猜。
 */

import { appendFileSync } from 'node:fs'
import { matchStageSignal, STAGE_SIGNALS } from '../adaptator/diagnostics-signals.mjs'

/** 诊断所需的上下文，全部来自调用方已经解析好的事实。 */
const STAGE = Object.freeze({
  host: {
    title: '壳与 Host 启动失败',
    hint: '应用的 Host 进程没有起来，或与壳之间的握手失败。先重启应用；若反复出现，重新安装应用（运行时由安装包自带，不需要单独升级 Node）。',
  },
  graph: {
    title: 'profile 与插件图失败',
    hint: '桌面 profile 里安装的插件与内置 dsh 不兼容，或依赖解析不完整。在启动失败对话框里选择「禁用第三方插件、备份 profile patch 并重启」，再更新或移除最近安装的插件。',
  },
  install: {
    title: '插件安装失败',
    hint: 'profile 声明的依赖没有取到：包不在 registry 上、规格无法解析，或 git／本地来源在这台机器上取不到。移除或更换该插件后重启；若这是从 web profile 迁移过来的插件，可以先用「禁用第三方插件、备份 profile patch 并重启」回到干净 profile。',
  },
  store: {
    title: '包管理缓存失败',
    hint: '内置 pnpm 读写自己的 store / cache 目录失败（常见原因：磁盘空间不足、目录被杀软或同步工具占用、跨盘硬链接不可用）。腾出空间或排除杀软扫描后重启应用。',
  },
  config: {
    title: 'profile 配置失败',
    hint: 'profile 的配置文件损坏或引用了不存在的行 id。用「禁用第三方插件、备份 profile patch 并重启」把出问题的 patch 行旁置；共享的任务与设置不会被删除。',
  },
  version: {
    title: '内置 dsh 与插件版本不匹配',
    hint: '至少一个插件要求的内置 dsh 版本与应用自带的版本不同。更新该插件到与应用匹配的版本；若不兼容，先禁用它。',
  },
})

/**
 * 用诊断信号解释一次启动失败：官方文本 → 稳定信号（适配层）→ 人能读懂的标题与下一步（本层）。
 * @param error - 捕获到的失败（Error、AggregateError 或任意值，按官方 `desktopErrorState` 的同一读法）。
 * @param context - 已解析的路径事实；用于附加可执行的下一步（当前只用 `profileRecovery`）。
 * @returns 命中的阶段诊断；没有命中返回 null。
 */
export function diagnoseStartupFailure(error, context = {}) {
  const text = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => (item instanceof Error ? item.message : String(item)))].join('\n')
    : error instanceof Error ? error.message : String(error)
  const signal = matchStageSignal(text)
  if (signal === null) return null
  const stageInfo = STAGE[signal.stage]
  return {
    stage: signal.stage,
    rule: signal.rule,
    title: stageInfo.title,
    hint: context.profileRecovery === false
      ? `${stageInfo.hint}（本次启动无法从应用内修复 profile，可能需要重新安装应用）`
      : stageInfo.hint,
    message: text,
  }
}

/**
 * 把诊断结果拼进官方错误出口用的消息文本。
 * @param diagnosis - `diagnoseStartupFailure` 的返回值。
 * @returns 阶段标题 + 下一步 + 原始错误串（原始串保留，避免诊断出错时把人挡在真相之外）。
 */
export function formatDiagnosis(diagnosis) {
  return `${diagnosis.title}\n${diagnosis.hint}\n\n---\n${diagnosis.message}`
}

/** 阶段 → 规则 id（顺序与适配层信号表一致），供单测覆盖与文档校对。 */
export const DIAGNOSTIC_RULES = Object.freeze(
  STAGE_SIGNALS.reduce((grouped, signal) => {
    grouped[signal.stage] = [...(grouped[signal.stage] ?? []), signal.rule]
    return grouped
  }, {}),
)

/** 主进程记录启动阶段用的环境变量；只有被显式设置时才写文件。 */
export const DIAGNOSTIC_FILE_ENV = 'DSH_DESKTOP_DIAGNOSTIC_FILE'

/** 到达应用页这一阶段的标记名（冒烟脚本按 `phase=<名>` 匹配，改动即破坏判据）。 */
export const APPLICATION_PAGE_PHASE = 'application-page'

/**
 * `message=` 的截断上限：够放下官方 `state.message`（内含 Host stderr 尾巴），又不至于把文件灌满。
 */
const MAX_DETAIL_CHARS = 2000

/**
 * 把一次启动阶段追加进诊断文件。
 *
 * 打包产物是 GUI 进程、没有 stdout（R21），冒烟只能看这个文件：所以**行格式、要读哪个环境变量、
 * 写失败怎么兜底**全在本层，patch 只负责在阶段变化时调一次。
 *
 * 失败阶段还要带上官方那段文本（`state.message`）：进程卡死时人看不到对话框，**只有文件里的这一行**能说明
 * 到底哪里失败；文本折成一行并截断，冒烟按 `phase=<名>` 匹配，所以加尾巴不影响判据。
 * @param environment - 进程环境（传 `process.env`）。
 * @param phase - 官方状态名；到达应用页时用 `APPLICATION_PAGE_PHASE`。
 * @param detail - 该阶段的附带文本；失败时传官方 `state.message`，其余阶段不传。
 */
export function recordStartupPhase(environment, phase, detail) {
  const file = environment[DIAGNOSTIC_FILE_ENV]
  if (file === undefined || file === '') return
  const text = typeof detail === 'string' ? detail.replaceAll(/\s+/gu, ' ').trim() : ''
  const suffix = text === '' ? '' : ` message=${text.slice(0, MAX_DETAIL_CHARS)}`
  try {
    appendFileSync(file, `${new Date().toISOString()} phase=${phase}${suffix}\n`)
  } catch (error) {
    console.error('dsh desktop: diagnostic file is not writable', error)
  }
}

/**
 * 官方致命错误出口要显示的文本：命中诊断就用「阶段标题 + 下一步 + 原始串」，没有命中就照官方原样显示
 * （诊断只做加法，不挡真相）。
 *
 * 官方那个 `desktopErrorState` 由调用方经 `fallback` 注入 —— 功能层不依赖官方实现（依赖方向不可逆）。
 * @param error - 捕获到的失败。
 * @param options - `profileRecovery` 事实，以及官方的兜底读取器。
 * @returns 与官方 `desktopErrorState` 同形的错误状态。
 */
export function startupErrorState(error, options) {
  const diagnosis = diagnoseStartupFailure(error, { profileRecovery: options.profileRecovery })
  return diagnosis === null ? options.fallback(error) : { phase: 'error', message: formatDiagnosis(diagnosis) }
}
