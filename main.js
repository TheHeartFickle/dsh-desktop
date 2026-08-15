'use strict'

// Desktop shell for the DeepSeek Harness Web GUI.
//
// The Web GUI is not a standalone static site: it is served by `dsh web`,
// which injects window.__DSH_BOOT__ and serves client plugin bundles. This
// shell does NOT bundle the backend — it loads a loading screen, makes sure a
// usable Node.js runtime and the `dsh` package exist on the user's system
// (installing either one when missing or too old, downloading through the
// system proxy when one is available), starts `dsh web` on demand, then loads
// the real page once the backend answers with a real boot manifest.

const { app, BrowserWindow, WebContentsView, nativeTheme, dialog, shell, session, net } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const DEFAULT_URL = 'http://127.0.0.1:3080'
const BACKEND_TIMEOUT_MS = 60_000
const UI_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 400

let mainWindow = null
let backendChild = null
let loadingView = null
const logBuffer = []

const targetUrl = () => process.env.DSH_WEB_URL || DEFAULT_URL
const backendCommand = () => process.env.DSH_WEB_CMD || 'dsh web'

// 与 loading.html 的背景色一致（跟随系统主题）。窗口/覆盖层在内容合成前的
// 间隙会显示该背景色，保证任何瞬时空白都呈现为加载页底色而非默认白/黑。
const LOADING_BG = () => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f8fa')

// ---- logging ---------------------------------------------------------------
// Every line goes to the main-process console and, once the loading page is
// up, to the rounded log box through the preload bridge.
function log(line) {
  const text = String(line)
  console.log(text)
  logBuffer.push(text)
  for (const wc of [mainWindow?.webContents, loadingView?.webContents]) {
    if (wc && !wc.isDestroyed() && !wc.isLoading()) wc.send('desktop:log', text)
  }
}

function fail(message) {
  log(`错误: ${message}`)
  dialog.showErrorBox('DeepSeek Harness', `${message}\n\n启动日志已显示在窗口中，便于排查。`)
  app.quit()
}

// ---- single instance -------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(main)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', stopBackend)
}

// ---- version helpers -------------------------------------------------------
function parseVersion(raw) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: String(raw).trim() }
}

// dsh engines (deepseek-harness/package.json): node ^22.19.0 || >=24.0.0.
// 23.x is deliberately unsupported by the range, so it does not satisfy.
function satisfiesNode(v) {
  if (v.major === 22) return v.minor >= 19
  return v.major >= 24
}

// ---- system proxy discovery ------------------------------------------------
// Chromium resolves the OS proxy (WinINET, incl. PAC) for us; net.request
// rides that by default. We surface it for the log and reuse the first proxy
// for the npm subprocess (which does not speak to the Chromium stack).
async function discoverProxy(target) {
  try {
    return await session.defaultSession.resolveProxy(target)
  } catch {
    return 'DIRECT'
  }
}

function firstProxy(raw) {
  for (const part of String(raw).split(';')) {
    const m = /^\s*(PROXY|HTTPS|HTTP|SOCKS5?)\s+(\S+)\s*$/i.exec(part)
    if (m) return { scheme: m[1].toLowerCase(), hostPort: m[2] }
  }
  return null
}

// ---- downloads -------------------------------------------------------------
function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// Download through the system proxy; if the proxy is configured but cannot
// connect, fall back to a direct connection and restore the system proxy.
async function downloadWithProxy(url, dest) {
  const raw = await discoverProxy(url)
  log(`系统代理解析 ${url}: ${raw}`)
  try {
    await downloadToFile(url, dest)
    log('下载完成')
    return { ok: true }
  } catch (err) {
    const proxy = firstProxy(raw)
    if (!proxy) return { ok: false, reason: err.message }
    log(`走系统代理下载失败: ${err.message}，切换直连重试`)
    await session.defaultSession.setProxy({ mode: 'direct' })
    try {
      await downloadToFile(url, dest)
      log('直连下载完成')
      return { ok: true }
    } catch (directErr) {
      return { ok: false, reason: directErr.message }
    } finally {
      await session.defaultSession.setProxy({ mode: 'system' })
    }
  }
}

async function fetchLatestNodeLts() {
  log('查询 Node.js 最新 LTS 版本...')
  const text = await httpGetText('https://nodejs.org/dist/index.json')
  const list = JSON.parse(text)
  for (const entry of list) {
    if (entry.lts) {
      const msi = entry.files.find((f) => f.endsWith('-x64.msi'))
      if (msi) return { version: entry.version, msi }
    }
  }
  throw new Error('未找到 Node.js LTS 发行物')
}

// ---- elevation -------------------------------------------------------------
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
      log(`msiexec 直接安装返回 ${code}，尝试提权重试`)
      runElevated('msiexec.exe', args).then((r) => {
        resolve({ ok: r.ok || r.code === 3010, code: r.code, out: r.out })
      })
    })
    child.on('error', (err) => {
      log(`msiexec 启动失败: ${err.message}，尝试提权重试`)
      runElevated('msiexec.exe', args).then((r) => resolve({ ok: r.ok || r.code === 3010, code: r.code, out: r.out }))
    })
  })
}

// ---- node / dsh detection --------------------------------------------------
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

// dsh lives in the global npm root of the resolved node; running its bin.js
// with that node keeps everything on one runtime, whatever else is on PATH.
function detectDsh(nodeExe, npmCli) {
  if (!npmCli) return { ok: false, reason: '未找到 npm，无法定位或安装 dsh' }
  const root = globalNpmRoot(nodeExe, npmCli)
  if (!root) return { ok: false, reason: '无法确定全局 npm 目录' }
  const dshBin = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(dshBin)) return { ok: true, dshBin }
  return { ok: false }
}

// ---- ensure environments ---------------------------------------------------
async function ensureNode() {
  log('检测 Node.js 运行时...')
  const det = detectNode()
  if (det.ok) {
    log(`Node.js 可用: ${det.version}`)
    return det
  }
  log(`Node.js 不可用或过老: ${det.reason}`)
  try {
    const info = await fetchLatestNodeLts()
    const url = `https://nodejs.org/dist/${info.version}/${info.msi}`
    const msiPath = path.join(app.getPath('temp'), info.msi)
    log(`下载 Node.js ${info.version} 安装器...`)
    const dl = await downloadWithProxy(url, msiPath)
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

function proxyEnvFor(target) {
  return discoverProxy(target).then((raw) => {
    const proxy = firstProxy(raw)
    if (!proxy) return undefined
    const scheme = proxy.scheme === 'socks5' || proxy.scheme === 'socks' ? 'socks5' : 'http'
    const url = `${scheme}://${proxy.hostPort}`
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
    }
  })
}

async function ensureDsh(node) {
  if (!node.npmCli) {
    return { ok: false, reason: '未找到 npm，无法定位或安装 dsh' }
  }
  const det = detectDsh(node.nodeExe, node.npmCli)
  if (det.ok) {
    log('dsh 可用')
    return det
  }
  log('未检测到 dsh，开始引导安装 @deepseek-ai/dsh...')
  const proxyEnv = await proxyEnvFor('https://registry.npmjs.org/')
  if (proxyEnv) log(`npm 将通过系统代理下载: ${proxyEnv.HTTPS_PROXY}`)
  const args = ['install', '-g', '@deepseek-ai/dsh', '--no-audit', '--no-fund']
  const installed = await runNpm(node, args, proxyEnv)
  if (!installed.ok) return { ok: false, reason: `npm install 失败: ${installed.reason}` }
  const re = detectDsh(node.nodeExe, node.npmCli)
  if (re.ok) return re
  return { ok: false, reason: 'dsh 已安装但未检测到，请重启桌面端' }
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
      log(`npm 直接执行返回 ${code}，尝试提权重试`)
      runElevated(node.nodeExe, [node.npmCli, ...args], env).then((r) => {
        resolve({ ok: r.ok, reason: r.ok ? undefined : `code ${r.code}` })
      })
    })
    child.on('error', (err) => {
      log(`npm 启动失败: ${err.message}，尝试提权重试`)
      runElevated(node.nodeExe, [node.npmCli, ...args], env).then((r) => {
        resolve({ ok: r.ok, reason: r.ok ? undefined : `code ${r.code}` })
      })
    })
  })
}

// ---- backend ---------------------------------------------------------------
function probeOnce(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        // Transport 200 is not enough: the page must carry the boot manifest,
        // otherwise `dsh web` is not the thing answering (bare Vite white page).
        resolve(res.statusCode === 200 && body.includes('__DSH_BOOT__'))
      })
    })
    req.on('error', () => resolve(false))
    req.setTimeout(3000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function waitForBackend(url, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      if (await probeOnce(url)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
  })
}

function startBackend(dsh, node) {
  let child
  if (process.env.DSH_WEB_CMD) {
    child = spawn(backendCommand(), { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    child = spawn(node.nodeExe, [dsh.dshBin, 'web'], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
  backendChild = child
  pipeChildOutput(child, 'dsh')
  child.on('error', () => { backendChild = null })
  child.on('exit', () => { backendChild = null })
}

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
      if (line.trim()) log(`[${prefix}] ${line}`)
    }
  })
}

function stopBackend() {
  if (!backendChild || !backendChild.pid) return
  spawnSync('taskkill', ['/pid', String(backendChild.pid), '/T', '/F'], { stdio: 'ignore' })
  backendChild = null
}

// ---- loading overlay --------------------------------------------------------
// The dsh web page renders its own boot spinner until the client shell has
// settled. Keep the whale-girl loading page on top of that boot screen and
// remove it only once the real UI replaced it, so the user sees a single
// loading animation.
function showLoadingOverlay() {
  if (loadingView) return Promise.resolve()
  loadingView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 透明背景：淡出时露出底层 dsh 页面，而不是 WebContentsView 的白底
  loadingView.setBackgroundColor('#00000000')
  // 先挂载再加载：addChildView 首帧提交的是当前画面（透明 → 露出底层），
  // 内容加载完成后才作为新帧合成，避免"先加载后挂载"产生的空白首帧。
  mainWindow.contentView.addChildView(loadingView)
  fitLoadingOverlay()
  mainWindow.on('resize', fitLoadingOverlay)
  const loaded = new Promise((r) => loadingView.webContents.once('did-finish-load', r))
  loadingView.webContents.loadFile('loading.html')
  return loaded
    // did-finish-load only means the document is parsed; wait one short beat
    // so the page has actually painted before the main window navigates away
    // underneath.
    .then(() => new Promise((r) => setTimeout(r, 100)))
    .then(() => {
      if (!loadingView) return
      for (const line of logBuffer) {
        loadingView.webContents.send('desktop:log', line)
      }
    })
}

function fitLoadingOverlay() {
  if (!loadingView) return
  const b = mainWindow.getContentBounds()
  loadingView.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
}

async function hideLoadingOverlay() {
  if (!loadingView) return
  const wc = loadingView.webContents
  try {
    await wc.executeJavaScript(
      `(function(){ document.body.style.transition = 'opacity 50ms ease-out'; document.body.style.opacity = '0' })()`
    )
  } catch { /* page may already be gone */ }
  await new Promise((r) => setTimeout(r, 60))
  mainWindow.contentView.removeChildView(loadingView)
  loadingView.webContents.close()
  loadingView = null
}

// Resolve once the dsh page has fully settled: its boot screen is gone AND
// the real UI has actually rendered content (the mounted shell carries
// substantial visible text — the empty/blank interim has none). One poll hit
// suffices: after the real UI mounts it never reverts to blank, so repeated
// stability checks would only delay the reveal. The boot container carries
// hashed CSS-module classes like "_boot_…"; match the stable "_boot_"
// fragment. Timeout falls back to revealing whatever the page shows rather
// than blocking forever.
function waitForDshUi(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      try {
        const ready = await mainWindow.webContents.executeJavaScript(`(() => {
          if (document.querySelectorAll('[class*="_boot_"]').length > 0) return false
          const root = document.getElementById('root')
          if (!root || root.children.length === 0) return false
          return (document.body.innerText || '').trim().length > 0
        })()`)
        if (ready) return resolve(true)
      } catch { /* page not ready yet */ }
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 100)
    }
    tick()
  })
}

// ---- window ----------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: LOADING_BG(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.on('page-title-updated', (event) => event.preventDefault())
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => { mainWindow = null })

  // Flush any lines logged before the loading page finished loading.
  win.webContents.on('did-finish-load', () => {
    for (const line of logBuffer) {
      win.webContents.send('desktop:log', line)
    }
  })

  mainWindow = win
}

// ---- entry -----------------------------------------------------------------
async function main() {
  createWindow()
  await mainWindow.loadFile('loading.html')

  log('DeepSeek Harness 桌面端启动中…')
  const url = targetUrl()

  // Reuse an already-running backend (e.g. started by hand) — never spawn a
  // second one onto the same port, and never touch the environment for it.
  if (await probeOnce(url)) {
    log(`检测到已在运行的后端，直接连接: ${url}`)
    await showLoadingOverlayAndLoad(url)
    return
  }

  const node = await ensureNode()
  if (!node.ok) return fail(node.reason)

  const dsh = await ensureDsh(node)
  if (!dsh.ok) return fail(dsh.reason)

  log(`启动后端: ${backendCommand()}`)
  startBackend(dsh, node)
  const ready = await waitForBackend(url, BACKEND_TIMEOUT_MS)
  if (!ready) {
    return fail(`后端未在 ${BACKEND_TIMEOUT_MS / 1000}s 内就绪，详见上方日志。`)
  }
  await showLoadingOverlayAndLoad(url)
}

// Cover the dsh page with the whale-girl loading page until its boot screen
// has been replaced by the real UI, then drop the overlay.
async function showLoadingOverlayAndLoad(url) {
  await showLoadingOverlay()
  // The overlay needs one compositor beat after addChildView before its first
  // frame is on screen; navigating the main window right away would let the
  // navigation flash (old page torn down, new page still blank) show through
  // the not-yet-composited view.
  await new Promise((r) => setTimeout(r, 120))
  await mainWindow.loadURL(url)
  await waitForDshUi(UI_READY_TIMEOUT_MS)
  hideLoadingOverlay()
}
