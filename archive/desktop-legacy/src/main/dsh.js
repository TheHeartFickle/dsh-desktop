import fs from 'node:fs'
import path from 'node:path'

// dsh 全局安装定位与按需安装引导。
export function createDsh({ log, logWarn, node, net }) {
  // dsh lives in the global npm root of the resolved node; running its bin.js
  // with that node keeps everything on one runtime, whatever else is on PATH.
  function detectDsh(nodeExe, npmCli) {
    if (!npmCli) return { ok: false, reason: '未找到 npm，无法定位或安装 dsh' }
    const root = node.globalNpmRoot(nodeExe, npmCli)
    if (!root) return { ok: false, reason: '无法确定全局 npm 目录' }
    const dshRoot = path.join(root, '@deepseek-ai', 'dsh')
    const dshBin = path.join(dshRoot, 'lib', 'bin.js')
    if (fs.existsSync(dshBin)) {
      let version
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json'), 'utf8'))
        version = pkg.version
      } catch {
        // 读不到版本不阻断启动，仅影响版本日志
      }
      return { ok: true, dshBin, version }
    }
    return { ok: false }
  }

  async function ensureDsh(node) {
    if (!node.npmCli) {
      return { ok: false, reason: '未找到 npm，无法定位或安装 dsh' }
    }
    const det = detectDsh(node.nodeExe, node.npmCli)
    if (det.ok) {
      log(det.version ? `dsh 可用: v${det.version}` : 'dsh 可用')
      return det
    }
    log('未检测到 dsh，开始引导安装 @deepseek-ai/dsh...')
    const proxyEnv = await net.proxyEnvFor('https://registry.npmjs.org/')
    if (proxyEnv) log(`npm 将通过系统代理下载: ${proxyEnv.HTTPS_PROXY}`)
    const args = ['install', '-g', '@deepseek-ai/dsh', '--no-audit', '--no-fund']
    const installed = await node.runNpm(node, args, proxyEnv)
    if (!installed.ok) return { ok: false, reason: `npm install 失败: ${installed.reason}` }
    const re = detectDsh(node.nodeExe, node.npmCli)
    if (re.ok) return re
    return { ok: false, reason: 'dsh 已安装但未检测到，请重启桌面端' }
  }

  return {
    detectDsh,
    ensureDsh,
  }
}
