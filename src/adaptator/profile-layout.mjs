/**
 * 适配层：profile 的磁盘布局。
 *
 * 官方文件：`packages/boot/app-boot/src/profile.ts`（`initProfile` 写下的三份文件）与
 * `apps/desktop/src/project-manager.ts`（内置 bundle 清单）。功能层要做「把 web 的配置语义搬进 desktop
 * profile」，但它**不该知道 profile 长什么样**：文件名、内置 bundle 名都是官方/生态的实现细节，官方换名字
 * 时只改本文件，功能层的判断与合并逻辑不动。
 *
 * 「配置语义」指 `dependencies`/`overrides`/第三方 bundles 与 `pnpm-workspace.yaml` 的 `allowBuilds` 段，
 * 不指整个目录——见 docs/design.zh.md §4.2 ②。
 */

/** profile 里用户可变的文件；不在此表的（`desktop.cordis.yml`、`node_modules`）由官方每次启动重建。 */
export const PROFILE_FILES = Object.freeze({
  manifest: 'package.json',
  workspace: 'pnpm-workspace.yaml',
  lockfile: 'pnpm-lock.yaml',
  patch: 'cordis.patch.yml',
})

/** 官方为 desktop profile 内置的 bundle 层；第三方插件排在它们之后。 */
export const BUILTIN_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
