import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, WebContentsView, shell } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'index.cjs')
export const LOADING_PATH = path.join(__dirname, '..', 'renderer', 'loading.html')
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.ico')

export function createWindowManager({ config, logger }) {
  function createWindow() {
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'DeepSeek Harness',
      icon: ICON_PATH,
      backgroundColor: config.LOADING_BG(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 彻底移除菜单栏，避免按 Alt 时自动显示被隐藏的工具栏。
    win.removeMenu()
    win.on('page-title-updated', (event) => event.preventDefault())
    win.once('ready-to-show', () => win.show())
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    // Tab 默认拦截，避免 Chromium 切换控件焦点；只有命令菜单（斜杠命令框）打开时，
    // 才把 Tab 当作回车发送给页面用于选中高亮项，否则吞掉这次 Tab。
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key.toLowerCase() === 'tab' && !input.control && !input.meta && !input.alt) {
        event.preventDefault()
        win.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-composer-card] [role="listbox"][aria-activedescendant]'))`
        ).then((open) => {
          if (!open) return
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        }).catch(() => {})
      }
    })

    // Flush any lines logged before the loading page finished loading.
    win.webContents.on('did-finish-load', () => {
      for (const line of logger.getLogBuffer()) {
        win.webContents.send('desktop:log', line)
      }
    })

    return win
  }

  // The dsh web page renders its own boot spinner until the client shell has
  // settled. Keep the whale-girl loading page on top of that boot screen and
  // remove it only once the real UI replaced it, so the user sees a single
  // loading animation.
  async function showLoadingOverlay(mainWindow) {
    const loadingView = new WebContentsView({
      webPreferences: {
        preload: PRELOAD_PATH,
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
    fitLoadingOverlay(mainWindow, loadingView)
    mainWindow.on('resize', () => fitLoadingOverlay(mainWindow, loadingView))
    const loaded = new Promise((r) => loadingView.webContents.once('did-finish-load', r))
    loadingView.webContents.loadFile(LOADING_PATH)
    await loaded
      // did-finish-load only means the document is parsed; wait one short beat
      // so the page has actually painted before the main window navigates away
      // underneath.
      .then(() => new Promise((r) => setTimeout(r, 100)))
    for (const line of logger.getLogBuffer()) {
      loadingView.webContents.send('desktop:log', line)
    }
    return loadingView
  }

  function fitLoadingOverlay(mainWindow, loadingView) {
    if (!loadingView || !loadingView.webContents || loadingView.webContents.isDestroyed()) return
    const b = mainWindow.getContentBounds()
    loadingView.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  }

  async function hideLoadingOverlay(mainWindow, loadingView) {
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
  }

  // Resolve once the dsh page has fully settled: its boot screen is gone AND
  // the real UI has actually rendered content (the mounted shell carries
  // substantial visible text — the empty/blank interim has none). One poll hit
  // suffices: after the real UI mounts it never reverts to blank, so repeated
  // stability checks would only delay the reveal. The boot container carries
  // hashed CSS-module classes like "_boot_…"; match the stable "_boot_"
  // fragment. Timeout falls back to revealing whatever the page shows rather
  // than blocking forever.
  function waitForDshUi(mainWindow, timeoutMs) {
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

  return {
    createWindow,
    showLoadingOverlay,
    fitLoadingOverlay,
    hideLoadingOverlay,
    waitForDshUi,
  }
}
