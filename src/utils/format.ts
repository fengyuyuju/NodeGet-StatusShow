const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * 统一 1024 进制字节格式化（全项目唯一来源）。
 * TB 量级取整会丢失可观精度，故保留 2 位小数；其余单位取整。
 */
export function bytes(n?: number | null) {
  if (!n || n <= 0) return '0 B'
  let i = 0
  let v = n
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++ }
  return `${i === 4 ? v.toFixed(2) : Math.round(v)} ${BYTE_UNITS[i]}`
}

export function pct(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(1)}%`
}

export function uptime(seconds?: number | null) {
  if (!seconds || seconds <= 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  if (d > 0) return `${d}天 ${h}小时`
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}小时 ${m}分`
}

export function relativeAge(ts?: number | null, now = Date.now()) {
  if (!ts) return '从未'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return `${Math.round(s / 3600)} 小时前`
}
