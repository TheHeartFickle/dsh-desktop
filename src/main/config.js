import { nativeTheme } from 'electron'

export const DEFAULT_URL = 'http://127.0.0.1:3080'
export const BACKEND_TIMEOUT_MS = 60_000
export const UI_READY_TIMEOUT_MS = 30_000
export const POLL_INTERVAL_MS = 400

export const targetUrl = () => process.env.DSH_WEB_URL || DEFAULT_URL
export const backendCommand = () => process.env.DSH_WEB_CMD || 'dsh web --no-open'

// 与 loading.html 的背景色一致（跟随系统主题）。窗口/覆盖层在内容合成前的
// 间隙会显示该背景色，保证任何瞬时空白都呈现为加载页底色而非默认白/黑。
export const LOADING_BG = () => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f8fa')
