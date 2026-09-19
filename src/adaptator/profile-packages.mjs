/**
 * 适配层：把官方「重建 profile 依赖」这件事固定成稳定能力。
 *
 * 官方文件：`apps/desktop/src/project-manager.ts`（旧基线上有 `runPnpm` / `ensureProfilePackages`，
 * 由主进程直接跑内置 pnpm）。**`0.1.6-alpha.2` 起这些出口被整体删除**：profile 的包操作随 Host 走，
 * Electron 主进程里已经没有 pnpm 能力，而迁移与回退都必须在 Host 启动之前把 profile 依赖按清单重建。
 *
 * 所以这条消失的官方能力由本层吸收，向上给出一个稳定函数：调用方（patch 层）只需在需要重建时调它，
 * 不需要知道用哪个可执行文件、传哪些 pnpm 参数、要配哪些环境变量；官方将来若重新给出主进程侧出口，
 * 只改本文件即可。功能层不碰这里，它只通过 `rollbackProfile({ onRepair })` 拿到一个回调。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** profile 是官方形态的 pnpm 项目，这两份配置缺一不可（与官方 `initProfile` 写下的文件一致）。 */
const PROFILE_MANIFEST = 'package.json'
const PROFILE_WORKSPACE = 'pnpm-workspace.yaml'

/**
 * 让 profile 的已装包与清单一致：在 profile 里重跑一次 pnpm install。
 *
 * **不跑 `--frozen-lockfile`**：迁移写下的清单由本仓库手写，lockfile 必然不同步，而 pnpm 的 frozen
 * 是 CI 默认、会直接拒绝安装；**带 `--ignore-scripts`**：插件脚本由官方在插件安装流程里按需授权构建。
 * 运行形态与官方 Host 的包操作一致：Electron 以 `ELECTRON_RUN_AS_NODE` 跑内置 pnpm，并把 node launcher
 * 目录前置到 PATH，供 pnpm 自己拉起子进程。
 * @param options - `profile`，以及官方 runtime 描述里的 `node`（Electron 可执行文件）、`pnpm`（pnpm 入口）、
 *   `nodeBin`（node launcher 目录）。
 * @returns 安装完成时 resolve；失败抛出带 pnpm 诊断的 Error。
 */
export function installProfilePackages(options) {
  const { profile, node, pnpm, nodeBin } = options
  if (!existsSync(join(profile, PROFILE_MANIFEST)) || !existsSync(join(profile, PROFILE_WORKSPACE))) {
    throw new Error('desktop profile: profile is missing its configuration files')
  }
  const registry = options.registry ?? process.env.DSH_LOCAL_NPM_REGISTRY ?? ''
  const result = spawnSync(node, ['--expose-internals', pnpm, 'install', '--no-frozen-lockfile', '--ignore-scripts'], {
    cwd: profile,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: node,
      PATH: nodeBin === undefined ? process.env.PATH ?? '' : `${nodeBin}${delimiter}${process.env.PATH ?? ''}`,
      ...(registry === '' ? {} : { NPM_CONFIG_REGISTRY: registry }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    throw new Error(`desktop profile: pnpm install could not run (${result.error.message})`)
  }
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n')
    throw new Error(`desktop profile: pnpm install exited with ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`)
  }
}
