import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { app } from 'electron'
import { parseVersion, satisfiesNode } from './version.js'

// Node.js 检测、下载、安装，以及全局 npm 执行（含 UAC 提权重试）。
export function createNode({ log, logWarn, net }) {
  function resolveExe(name) {
    const r = spawnSync('where', [name], { encoding: 'utf8' })
    if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0]
    return name
  }

  function resolveNpmCli(nodeExe) {
    const cli = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return fs.existsSync(cli) ? cli : null
  }

  // Collect every node we can see (PATH plus a previous global install), then
  // keep the first one that satisfies the dsh engine range.
  function detectNode() {
    const candidates = []
    const r = spawnSync('node', ['--version'], { encoding: 'utf8' })
    if (!r.error && r.status === 0) {
      const v = parseVersion(r.stdout)
      if (v) candidates.push({ nodeExe: resolveExe('node'), version: v })
    }
    const globalNode = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')
    if (fs.existsSync(globalNode)) {
      const r2 = spawnSync(globalNode, ['--version'], { encoding: 'utf8' })
      const v = parseVersion(r2.stdout)
      if (v) candidates.push({ nodeExe: globalNode, version: v })
    }
    for (const c of candidates) {
      if (satisfiesNode(c.version)) {
        return { ok: true, nodeExe: c.nodeExe, npmCli: resolveNpmCli(c.nodeExe), version: c.version.raw }
      }
    }
    if (candidates.length > 0) {
      return { ok: false, reason: `检测到 Node.js ${candidates[0].version.raw}，版本过老（需要 ^22.19.0 || >=24.0.0）` }
    }
    return { ok: false, reason: '未检测到 Node.js' }
  }

  function globalNpmRoot(nodeExe, npmCli) {
    const r = spawnSync(nodeExe, [npmCli, 'root', '-g'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  }

  // Installing Node.js globally and `npm install -g dsh` into Program Files both
  // need elevation. Direct spawn is attempted first (covers an already-elevated
  // app), then retried through a UAC prompt via Start-Process -Verb RunAs.
  function runElevated(exe, args, env) {
    return new Promise((resolve) => {
      const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')
      const envAssign = Object.entries(env || {})
        .filter(([k]) => /^(HTTPS?|NO)_PROXY$/i.test(k))
        .map(([k, v]) => `$env:${k} = '${v.replace(/'/g, "''")}'`)
        .join('; ')
      const ps = `${envAssign} $p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' `
        + `-ArgumentList ${argList} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
      const child = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('exit', (code) => resolve({ ok: code === 0, code, out }))
      child.on('error', (err) => resolve({ ok: false, code: -1, out: err.message }))
    })
  }

  function installMsi(msiPath) {
    return new Promise((resolve) => {
      const logFile = `${msiPath}.log`
      const args = ['/i', msiPath, '/qn', '/norestart', '/l*v', logFile]
      log('以静默方式安装 Node.js（可能弹出 UAC 提权确认）...')
      const child = spawn('msiexec', args, { stdio: 'pipe' })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('exit', (code) => {
        if (code === 0 || code === 3010) {
          resolve({ ok: true, code })
          return
        }
        logWarn(`msiexec 直接安装返回 ${code}，尝试提权重试`)
        runElevated('msiexec.exe', args).then((r) => {
          resolve({ ok: r.ok || r.code === 3010, code: r.code, out: r.out })
        })
      })
      child.on('error', (err) => {
        logWarn(`msiexec 启动失败: ${err.message}，尝试提权重试`)
        runElevated('msiexec.exe', args).then((r) => resolve({ ok: r.ok || r.code === 3010, code: r.code, out: r.out }))
      })
    })
  }

  async function fetchLatestNodeLts() {
    log('查询 Node.js 最新 LTS 版本...')
    const text = await net.httpGetText('https://nodejs.org/dist/index.json')
    const list = JSON.parse(text)
    for (const entry of list) {
      if (entry.lts) {
        const msi = entry.files.find((f) => f.endsWith('-x64.msi'))
        if (msi) return { version: entry.version, msi }
      }
    }
    throw new Error('未找到 Node.js LTS 发行物')
  }

  async function ensureNode() {
    log('检测 Node.js 运行时...')
    const det = detectNode()
    if (det.ok) {
      log(`Node.js 可用: ${det.version}`)
      return det
    }
    logWarn(`Node.js 不可用或过老: ${det.reason}`)
    try {
      const info = await fetchLatestNodeLts()
      const url = `https://nodejs.org/dist/${info.version}/${info.msi}`
      const msiPath = path.join(app.getPath('temp'), info.msi)
      log(`下载 Node.js ${info.version} 安装器...`)
      const dl = await net.downloadWithProxy(url, msiPath)
      if (!dl.ok) return { ok: false, reason: `下载安装器失败: ${dl.reason}` }
      const inst = await installMsi(msiPath)
      if (!inst.ok) return { ok: false, reason: `安装失败（code ${inst.code}）` }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
    const re = detectNode()
    if (re.ok) return re
    return { ok: false, reason: 'Node.js 已安装但当前进程未检测到，请重启桌面端' }
  }

  function runNpm(node, args, env) {
    return new Promise((resolve) => {
      log(`运行: ${path.basename(node.nodeExe)} ${path.basename(node.npmCli)} ${args.join(' ')}`)
      const child = spawn(node.nodeExe, [node.npmCli, ...args], { stdio: 'pipe', env: { ...process.env, ...env } })
      pipeChildOutput(child, 'npm')
      child.on('exit', (code) => {
        if (code === 0) {
          resolve({ ok: true })
          return
        }
        logWarn(`npm 直接执行返回 ${code}，尝试提权重试`)
        runElevated(node.nodeExe, [node.npmCli, ...args], env).then((r) => {
          resolve({ ok: r.ok, reason: r.ok ? undefined : `code ${r.code}` })
        })
      })
      child.on('error', (err) => {
        logWarn(`npm 启动失败: ${err.message}，尝试提权重试`)
        runElevated(node.nodeExe, [node.npmCli, ...args], env).then((r) => {
          resolve({ ok: r.ok, reason: r.ok ? undefined : `code ${r.code}` })
        })
      })
    })
  }

  // runNpm 内部需要把子进程输出送到统一日志。
  function pipeChildOutput(child, prefix) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) log(`[${prefix}] ${line}`)
      }
    })
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) logWarn(`[${prefix}] ${line}`)
      }
    })
  }

  return {
    detectNode,
    ensureNode,
    globalNpmRoot,
    runElevated,
    runNpm,
  }
}
