import http from 'node:http'
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

// dsh web 后端探测、拉起与停止。
const DEFAULT_BACKEND_PORT = 3080

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

export function createBackend({ log, logWarn, config }) {
  function probeOnce(url) {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        let body = ''
        res.on('data', (d) => { body += d })
        res.on('end', () => {
          // 就绪 = 服务在应答且 token 被接受：2xx 直出页面；3xx 是 dsh 验证
          // token 后种 cookie 的重定向（实测 303 → /）；401 才是 token 无效。
          // 地址来自 dsh 自己的 stdout，无需再做旧版 __DSH_BOOT__ 指纹校验。
          resolve(res.statusCode >= 200 && res.statusCode < 400)
        })
      })
      req.on('error', () => resolve(false))
      req.setTimeout(3000, () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  // dsh web 每次启动随机生成 token 并只打印在自己的输出里
  // （形如 `dsh web: http://127.0.0.1:3080/?token=...`），这里把它抓出来。
  const TOKEN_URL_RE = /https?:\/\/\S*[?&]token=\S+/


  async function waitForBackend(urlReady, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    const url = await Promise.race([
      urlReady,
      new Promise((r) => setTimeout(() => r(null), timeoutMs)),
    ])
    if (!url) return null
    while (Date.now() < deadline) {
      if (await probeOnce(url)) return url
      await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MS))
    }
    return null
  }

  async function startBackend(dsh, node, onExit) {
    let child
    let command
    if (process.env.DSH_WEB_CMD) {
      command = config.backendCommand()
      child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      const port = (await isPortFree(DEFAULT_BACKEND_PORT)) ? DEFAULT_BACKEND_PORT : 0
      command = `dsh web --no-open --port ${port}`
      child = spawn(node.nodeExe, [dsh.dshBin, 'web', '--no-open', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    }
    log(`启动后端: ${command}`)
    let urlResolve
    const urlReady = new Promise((r) => { urlResolve = r })
    pipeChildOutput(child, 'dsh', urlResolve)
    child.on('error', () => onExit())
    child.on('exit', () => onExit())
    // 进程退出且从未输出过 token URL 时（启动失败），不必等满超时：立即结束
    // 等待，让上层带着上方日志报错。URL 已拿到时这是空操作。
    child.on('close', () => urlResolve(null))
    return { child, urlReady }
  }

  function pipeChildOutput(child, prefix, onUrl) {
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) log(`[${prefix}] ${line}`)
        const url = line.match(TOKEN_URL_RE)
        if (url) onUrl(url[0])
      }
    })
    child.stderr.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) logWarn(`[${prefix}] ${line}`)
        const url = line.match(TOKEN_URL_RE)
        if (url) onUrl(url[0])
      }
    })
  }
  function stopBackend(child) {
    if (!child || !child.pid) return
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }

  return {
    probeOnce,
    waitForBackend,
    startBackend,
    stopBackend,
  }
}
