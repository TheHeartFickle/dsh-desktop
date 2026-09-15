import fs from 'node:fs'
import path from 'node:path'
import electronLog from 'electron-log/main'

const LOG_MAX_SIZE = 10 * 1024 * 1024
const LOG_RETENTION_DAYS = 7
const LOG_BUFFER_LIMIT = 500

// 与 loading.html 的日志框一致：主进程 console、preload 桥、日期文件三路输出。
export function createLogger() {
  const logBuffer = []
  let logFileDir = null
  let logTargets = () => []

  function dateStamp(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  function currentLogPath(date = new Date()) {
    if (!logFileDir) return null
    return path.join(logFileDir, `dsh-${dateStamp(date)}.log`)
  }

  function archiveLogFile(file) {
    const currentPath = file.toString()
    const parsed = path.parse(currentPath)
    let index = 1
    while (fs.existsSync(path.join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`))) {
      index += 1
    }
    try {
      fs.renameSync(currentPath, path.join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`))
    } catch (err) {
      console.error('无法轮转日志文件:', err)
    }
  }

  function cleanupOldLogs() {
    if (!logFileDir) return
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - (LOG_RETENTION_DAYS - 1))
    let names
    try {
      names = fs.readdirSync(logFileDir)
    } catch {
      return
    }
    for (const name of names) {
      const m = /^dsh-(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?\.log$/.exec(name)
      if (!m) continue
      const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(logFileDir, name))
        } catch {
          // 清理失败不阻塞启动
        }
      }
    }
  }

  try {
    logFileDir = path.join(path.dirname(process.execPath), 'logs')
    fs.mkdirSync(logFileDir, { recursive: true })
    electronLog.transports.file.maxSize = LOG_MAX_SIZE
    electronLog.transports.file.resolvePathFn = (_vars, message) => currentLogPath(message?.date || new Date())
    electronLog.transports.file.archiveLogFn = archiveLogFile
    electronLog.transports.console.level = false
    electronLog.initialize()
    electronLog.errorHandler.startCatching()
    cleanupOldLogs()
  } catch (err) {
    console.error('无法初始化日志文件:', err)
  }

  function writeLog(line, level = 'info') {
    const text = String(line)
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
    if (logFileDir) {
      if (level === 'error') electronLog.error(text)
      else if (level === 'warn') electronLog.warn(text)
      else electronLog.info(text)
    }
    logBuffer.push(text)
    if (logBuffer.length > LOG_BUFFER_LIMIT) {
      logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT)
    }
    for (const wc of logTargets()) {
      if (wc && !wc.isDestroyed()) wc.send('desktop:log', text)
    }
  }

  const log = (line) => writeLog(line, 'info')
  const logWarn = (line) => writeLog(line, 'warn')
  const logError = (line) => writeLog(line, 'error')

  return {
    log,
    logWarn,
    logError,
    currentLogPath,
    getLogBuffer: () => logBuffer.slice(),
    setLogTargets: (fn) => { logTargets = fn },
  }
}
