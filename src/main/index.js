import { app, dialog } from 'electron'
import {
  targetUrl,
  backendCommand,
  LOADING_BG,
  BACKEND_TIMEOUT_MS,
  UI_READY_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} from './config.js'
import { createLogger } from './logger.js'
import { createNet } from './net.js'
import { createNode } from './node.js'
import { createDsh } from './dsh.js'
import { createBackend } from './backend.js'
import { createWindowManager, LOADING_PATH } from './window.js'

// Desktop shell for the DeepSeek Harness Web GUI.
//
// The Web GUI is not a standalone static site: it is served by `dsh web`,
// which injects window.__DSH_BOOT__ and serves client plugin bundles. This
// shell does NOT bundle the backend — it loads a loading screen, makes sure a
// usable Node.js runtime and the `dsh` package exist on the user's system
// (installing either one when missing or too old, downloading through the
// system proxy when one is available), starts `dsh web` on demand, then loads
// the real page once the backend answers with a real boot manifest.

const logger = createLogger()
const { log, logWarn, logError } = logger

const net = createNet({ log, logWarn })
const node = createNode({ log, logWarn, net })
const dsh = createDsh({ log, logWarn, node, net })
const backend = createBackend({ log, logWarn, config: { POLL_INTERVAL_MS, backendCommand } })
const windowManager = createWindowManager({ config: { LOADING_BG }, logger })

let mainWindow = null
let backendChild = null
let loadingView = null

logger.setLogTargets(() => [mainWindow?.webContents, loadingView?.webContents])

function fail(message) {
  logError(`错误: ${message}`)
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
  app.on('before-quit', () => {
    if (backendChild) backend.stopBackend(backendChild)
  })
}

// ---- entry -----------------------------------------------------------------
async function main() {
  mainWindow = windowManager.createWindow()
  mainWindow.on('closed', () => { mainWindow = null })
  await mainWindow.loadFile(LOADING_PATH)

  log('DeepSeek Harness 桌面端启动中…')
  const logPath = logger.currentLogPath()
  if (logPath) log(`日志文件: ${logPath}`)
  const url = targetUrl()

  // Reuse an already-running backend (e.g. started by hand) — never spawn a
  // second one onto the same port, and never touch the environment for it.
  if (await backend.probeOnce(url)) {
    log(`检测到已在运行的后端，直接连接: ${url}`)
    await showLoadingOverlayAndLoad(url)
    return
  }

  const nodeDet = await node.ensureNode()
  if (!nodeDet.ok) return fail(nodeDet.reason)

  const dshDet = await dsh.ensureDsh(nodeDet)
  if (!dshDet.ok) return fail(dshDet.reason)

  log(`启动后端: ${backendCommand()}`)
  backendChild = backend.startBackend(dshDet, nodeDet, () => { backendChild = null })
  const ready = await backend.waitForBackend(url, BACKEND_TIMEOUT_MS)
  if (!ready) {
    return fail(`后端未在 ${BACKEND_TIMEOUT_MS / 1000}s 内就绪，详见上方日志。`)
  }
  await showLoadingOverlayAndLoad(url)
}

// Cover the dsh page with the whale-girl loading page until its boot screen
// has been replaced by the real UI, then drop the overlay.
async function showLoadingOverlayAndLoad(url) {
  loadingView = await windowManager.showLoadingOverlay(mainWindow)
  // The overlay needs one compositor beat after addChildView before its first
  // frame is on screen; navigating the main window right away would let the
  // navigation flash (old page torn down, new page still blank) show through
  // the not-yet-composited view.
  await new Promise((r) => setTimeout(r, 120))
  await mainWindow.loadURL(url)
  await windowManager.waitForDshUi(mainWindow, UI_READY_TIMEOUT_MS)
  await windowManager.hideLoadingOverlay(mainWindow, loadingView)
  loadingView = null
}
