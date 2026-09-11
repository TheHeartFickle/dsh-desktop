export function parseVersion(raw) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: String(raw).trim() }
}

// dsh engines (deepseek-harness/package.json): node ^22.19.0 || >=24.0.0.
// 23.x is deliberately unsupported by the range, so it does not satisfy.
export function satisfiesNode(v) {
  if (v.major === 22) return v.minor >= 19
  return v.major >= 24
}
