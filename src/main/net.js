import fs from 'node:fs'
import { net, session } from 'electron'
import { firstProxy } from './net-utils.js'

// Chromium resolves the OS proxy (WinINET, incl. PAC) for us; net.request
// rides that by default. We surface it for the log and reuse the first proxy
// for the npm subprocess (which does not speak to the Chromium stack).
export function createNet({ log, logWarn }) {
  async function discoverProxy(target) {
    try {
      return await session.defaultSession.resolveProxy(target)
    } catch {
      return 'DIRECT'
    }
  }

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
      logWarn(`走系统代理下载失败: ${err.message}，切换直连重试`)
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

  return {
    discoverProxy,
    httpGetText,
    downloadToFile,
    downloadWithProxy,
    proxyEnvFor,
  }
}
