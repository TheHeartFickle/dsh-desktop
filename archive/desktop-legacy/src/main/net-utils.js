export function firstProxy(raw) {
  for (const part of String(raw).split(';')) {
    const m = /^\s*(PROXY|HTTPS|HTTP|SOCKS5?)\s+(\S+)\s*$/i.exec(part)
    if (m) return { scheme: m[1].toLowerCase(), hostPort: m[2] }
  }
  return null
}
