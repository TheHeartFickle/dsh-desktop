/**
 * 功能层：在进程内读 npm tarball。
 *
 * 上游的 `scripts/release/tarball.ts` 用外部 `tar` 进程读 tarball（`capture('tar', ['-tzf'|'-xOzf', …])`）。
 * `pack.ts` 对每个成员、`prepare-package-set.ts` 对每个 tarball 都调一次，于是单次构建要创建数百个
 * 子进程。实测这些进程的启动成本在 55ms–2.5s 之间大幅抖动（同一命令同一环境，`tar --version` 时快时慢），
 * 无法当作稳定判据：`release:pack` 与 `prepare:packages` 因此各花约 9 分钟。
 *
 * 本层把「读一个 tarball」变成进程内调用：用 `tar` 库（已是 `apps/desktop` 声明的依赖）直接读，
 * 不再 spawn。对外只暴露「manifest 对象」与「条目路径列表」两个稳定出参，
 * 调用方拿到的内容与原先外部命令的 stdout 等价（后者按行切分、过滤空行）。
 */
import { list, x } from 'tar'

/** 抽不出 `package/package.json` 时抛出；内容不可解析时由调用方 `JSON.parse` 报错。 */
async function readPackedManifestText(tarball) {
  let manifestText
  await x({
    file: tarball,
    onReadEntry(entry) {
      if (entry.path !== 'package/package.json') {
        entry.resume()
        return
      }
      const chunks = []
      entry.on('data', chunk => chunks.push(chunk))
      entry.on('end', () => {
        manifestText = Buffer.concat(chunks).toString('utf8')
      })
    },
  })
  if (manifestText === undefined) throw new Error(`${tarball} has no package/package.json`)
  return manifestText
}

/**
 * 读 tarball 里的 `package/package.json`，等价于 `tar -xOzf <tarball> package/package.json`。
 * @param {string} tarball tarball 绝对路径。
 * @returns {Promise<Record<string, unknown>>} 解析后的 manifest。
 */
export async function readTarballManifest(tarball) {
  const value = JSON.parse(await readPackedManifestText(tarball))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${tarball} has no package manifest`)
  }
  const { name } = value
  if (typeof name !== 'string' || name === '') throw new Error(`${tarball} has no package name`)
  return value
}

/**
 * 列 tarball 里的全部条目路径，等价于 `tar -tzf <tarball>` 再按行切分、过滤空行。
 * @param {string} tarball tarball 绝对路径。
 * @returns {Promise<string[]>} 条目路径列表。
 */
export async function listTarballEntries(tarball) {
  const entries = []
  await list({
    file: tarball,
    onReadEntry(entry) {
      entries.push(entry.path)
      entry.resume()
    },
  })
  return entries
}
