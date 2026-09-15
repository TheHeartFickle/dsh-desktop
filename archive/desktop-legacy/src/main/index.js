import { app, dialog } from 'electron'
import {
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
// which injects window.__DSH_BOOT__, requires the random per-run ?token= that
// it prints on its own stdout, and serves client plugin bundles. This
// shell does NOT bundle the backend — it loads a loading screen, makes sure a
// usable Node.js runtime and the `dsh` package exist on the user's system
// (installing either one when missing or too old, downloading through the
// system proxy when one is available), starts `dsh web` on demand, parses the
// token URL from its stdout, then loads that URL once the backend answers
// with a real boot manifest.

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

  const nodeDet = await node.ensureNode()
  if (!nodeDet.ok) return fail(nodeDet.reason)

  const dshDet = await dsh.ensureDsh(nodeDet)
  if (!dshDet.ok) return fail(dshDet.reason)

  // token 只会打印在后端自己的 stdout 上，外部已运行的后端拿不到 token；
  // 因此总是拉起自己的后端：3080 空闲优先固定端口，被占用则用 --port 0
  // 随机端口，从其输出解析出带 token 的地址再连接。
  const started = await backend.startBackend(dshDet, nodeDet, () => { backendChild = null })
  backendChild = started.child
  const url = await backend.waitForBackend(started.urlReady, BACKEND_TIMEOUT_MS)
  if (!url) {
    return fail(`后端未能就绪（已退出或 ${BACKEND_TIMEOUT_MS / 1000}s 超时），详见上方日志。`)
  }
  log(`后端就绪: ${url}`)
  await showLoadingOverlayAndLoad(url)
}

// Cover the dsh page with the whale-girl loading page until its boot screen
// has been replaced by the real UI, then drop the overlay.
async function showLoadingOverlayAndLoad(url) {
  try {
    loadingView = await windowManager.showLoadingOverlay(mainWindow)
    // The overlay needs one compositor beat after addChildView before its first
    // frame is on screen; navigating the main window right away would let the
    // navigation flash (old page torn down, new page still blank) show through
    // the not-yet-composited view.
    await new Promise((r) => setTimeout(r, 120))

    // 后端刚就绪时仍有竞态：loadURL 可能遇到 ERR_FAILED。这里重试一次，避免
    // 未捕获的 rejection 把窗口留在空白状态。
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await mainWindow.loadURL(url)
        lastError = null
        break
      } catch (err) {
        lastError = err
        logWarn(`加载后端页面失败（第 ${attempt} 次）: ${err.message}`)
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1000))
      }
    }
    if (lastError) throw lastError

    let ready = await windowManager.waitForDshUi(mainWindow, UI_READY_TIMEOUT_MS)
    if (!ready) {
      // 页面已加载但真实 UI 没挂载也可能是瞬时问题；自动刷新一次再等。
      logWarn('DSH 页面未在预期时间内挂载，自动刷新重试...')
      await mainWindow.loadURL(url)
      ready = await windowManager.waitForDshUi(mainWindow, UI_READY_TIMEOUT_MS)
      if (!ready) throw new Error('DSH 页面在自动刷新后仍未挂载')
    }

    await windowManager.hideLoadingOverlay(mainWindow, loadingView)
    mainWindow.webContents.focus()
    loadingView = null
  } catch (err) {
    logError(`加载后端页面失败: ${err.message}`)
    await windowManager.hideLoadingOverlay(mainWindow, loadingView).catch(() => {})
    loadingView = null
    fail(`加载后端页面失败:\n${err.message}`)
  }
}
