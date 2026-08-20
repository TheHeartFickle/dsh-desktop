import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

// dsh web 后端探测、拉起与停止。
export function createBackend({ log, logWarn, config }) {
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
        setTimeout(tick, config.POLL_INTERVAL_MS)
      }
      tick()
    })
  }

  function startBackend(dsh, node, onExit) {
    let child
    if (process.env.DSH_WEB_CMD) {
      child = spawn(config.backendCommand(), { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      child = spawn(node.nodeExe, [dsh.dshBin, 'web', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
    }
    pipeChildOutput(child, 'dsh')
    child.on('error', () => onExit())
    child.on('exit', () => onExit())
    return child
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
        if (line.trim()) logWarn(`[${prefix}] ${line}`)
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
