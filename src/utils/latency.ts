import type { LatencyType, TaskQueryResult } from '../types'

const DISTINCT_COLORS = [
  '#3b82f6', // 蓝
  '#f97316', // 橙
  '#22c55e', // 绿
  '#a855f7', // 紫
  '#06b6d4', // 青
  '#eab308', // 黄
  '#ec4899', // 粉
  '#14b8a6', // 青绿
  '#8b5cf6', // 蓝紫
  '#f59e0b', // 琥珀
  '#10b981', // 翠绿
  '#6366f1', // 靛蓝
  '#84cc16', // 酸橙
  '#d946ef', // 品红
  '#0ea5e9', // 天蓝
]

export const TIMEOUT_COLOR = '#e6170f'

export const TYPE_LABEL: Record<LatencyType, string> = {
  ping: 'Ping',
  tcp_ping: 'TCP Ping',
}

export function generateSpectrumColor(index: number, _total: number): string {
  return DISTINCT_COLORS[index % DISTINCT_COLORS.length]
}

const SNAP_INTERVAL = 20000

function normalizeTs(ts: number) {
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts
  return Math.floor(ms / SNAP_INTERVAL) * SNAP_INTERVAL
}

function pickValue(row: TaskQueryResult, type: LatencyType): number | null {
  const v = row.task_event_result?.[type]
  return row.success && typeof v === 'number' && Number.isFinite(v) ? v : null
}

function seriesNames(rows: TaskQueryResult[]) {
  const set = new Set<string>()
  for (const r of rows) set.add(r.cron_source || '未知')
  return [...set].sort((a, b) => a.localeCompare(b))
}

export interface ChartSeriesPoint {
  t: number
  value: number | null
}

export interface ChartSeries {
  name: string
  color: string
  points: ChartSeriesPoint[]
  normalLine: ChartSeriesPoint[]
  timeoutLine: ChartSeriesPoint[]
}

interface Segment {
  type: 'normal' | 'timeout'
  a: ChartSeriesPoint
  b: ChartSeriesPoint
}

function buildLineData(segs: Segment[], type: 'normal' | 'timeout'): ChartSeriesPoint[] {
  const out: ChartSeriesPoint[] = []
  let prevEndT: number | null = null
  let needGap = false
  for (const seg of segs) {
    if (seg.type !== type) {
      if (prevEndT != null) needGap = true
      prevEndT = null
      continue
    }
    if (prevEndT == null) {
      if (needGap && out.length > 0) {
        out.push({ t: (out[out.length - 1].t + seg.a.t) / 2, value: null })
      }
      needGap = false
      out.push({ t: seg.a.t, value: seg.a.value })
    } else if (type === 'timeout') {
      out.push({ t: prevEndT, value: null })
      out.push({ t: seg.a.t, value: seg.a.value })
    }
    if (seg.b.t !== seg.a.t || seg.b.value !== seg.a.value) {
      out.push({ t: seg.b.t, value: seg.b.value })
    }
    prevEndT = seg.b.t
  }
  return out
}

export function buildLatencyChart(rows: TaskQueryResult[], type: LatencyType) {
  const names = seriesNames(rows)
  const total = names.length
  const bySource = new Map<string, ChartSeriesPoint[]>()
  for (const n of names) bySource.set(n, [])

  for (const r of rows) {
    const name = r.cron_source || '未知'
    bySource.get(name)?.push({
      t: normalizeTs(r.timestamp),
      value: pickValue(r, type),
    })
  }

  const series: ChartSeries[] = names.map((name, idx) => {
    const points = (bySource.get(name) ?? []).sort((a, b) => a.t - b.t)

    const validIdx: number[] = []
    for (let i = 0; i < points.length; i++) {
      if (typeof points[i].value === 'number' && Number.isFinite(points[i].value)) validIdx.push(i)
    }

    const segs: Segment[] = []

    if (validIdx.length > 0) {
      const first = validIdx[0]
      if (first > 0) {
        segs.push({
          type: 'timeout',
          a: { t: points[0].t, value: 0 },
          b: { t: points[first].t, value: 0 },
        })
      }

      for (let k = 0; k < validIdx.length - 1; k++) {
        const i = validIdx[k]
        const j = validIdx[k + 1]
        segs.push({
          type: j - i === 1 ? 'normal' : 'timeout',
          a: points[i],
          b: points[j],
        })
      }

      if (validIdx.length === 1) {
        const p = points[validIdx[0]]
        segs.push({ type: 'normal', a: p, b: p })
      }

      const last = validIdx[validIdx.length - 1]
      if (last < points.length - 1) {
        segs.push({
          type: 'timeout',
          a: { t: points[last].t, value: 0 },
          b: { t: points[points.length - 1].t, value: 0 },
        })
      }
    } else if (points.length > 0) {
      const t0 = points[0].t
      const t1 = points[points.length - 1].t
      segs.push({
        type: 'timeout',
        a: { t: t0, value: 0 },
        b: { t: t1 === t0 ? t0 + SNAP_INTERVAL : t1, value: 0 },
      })
    }

    const normalLine = downsampleSeries(buildLineData(segs, 'normal'))
    const timeoutLine = downsampleSeries(buildLineData(segs, 'timeout'))
    return {
      name,
      color: generateSpectrumColor(idx, total),
      points,
      normalLine,
      timeoutLine,
    }
  })

  return { series }
}

const MAX_CHART_POINTS = 400

export function downsampleSeries(data: ChartSeriesPoint[], threshold: number = MAX_CHART_POINTS): ChartSeriesPoint[] {
  if (data.length <= threshold) return data

  const segments: { points: ChartSeriesPoint[]; length: number }[] = []
  let cur: ChartSeriesPoint[] = []
  for (const pt of data) {
    if (pt.value == null) {
      if (cur.length > 0) {
        segments.push({ points: cur, length: cur.length })
        cur = []
      }
    } else {
      cur.push(pt)
    }
  }
  if (cur.length > 0) segments.push({ points: cur, length: cur.length })

  const totalLen = segments.reduce((s, seg) => s + seg.length, 0)
  const out: ChartSeriesPoint[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const target = Math.max(2, Math.round(threshold * seg.length / totalLen))
    const stride = seg.length / target
    const sampled: ChartSeriesPoint[] = [seg.points[0]]
    for (let j = 1; j < seg.length - 1; j++) {
      if (Math.round(j / stride) !== Math.round((j - 1) / stride)) {
        sampled.push(seg.points[j])
      }
    }
    if (seg.length > 1) sampled.push(seg.points[seg.length - 1])
    out.push(...sampled)
    if (i < segments.length - 1) {
      const mid = (sampled[sampled.length - 1].t + segments[i + 1].points[0].t) / 2
      out.push({ t: mid, value: null })
    }
  }
  return out
}

export interface LatencyStats {
  name: string
  color: string
  avg: number | null
  p50: number | null
  p95: number | null
  p99: number | null
  jitter: number | null
  lossRate: number
}

export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length
  if (n === 1) return sortedAsc[0]
  const rank = p * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  return sortedAsc[lo] + (rank - lo) * (sortedAsc[hi] - sortedAsc[lo])
}

const PEAK_CLIP_MIN_POINTS = 6

export function computePeakClipCap(values: number[]): number | null {
  const sorted = values
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (sorted.length < PEAK_CLIP_MIN_POINTS) return null

  const max = sorted[sorted.length - 1]
  const p99 = percentile(sorted, 0.99)

  return max > p99 ? p99 : null
}

export function computeLatencyStats(rows: TaskQueryResult[], type: LatencyType): LatencyStats[] {
  const names = seriesNames(rows)
  const total = names.length
  const stats = names.map<LatencyStats>((name, i) => {
    const list = rows.filter(r => (r.cron_source || '未知') === name)
    const vals: number[] = []
    for (const r of list) {
      const v = pickValue(r, type)
      if (v != null) vals.push(v)
    }

    const color = generateSpectrumColor(i, total)
    const lossRate = list.length ? ((list.length - vals.length) / list.length) * 100 : 0
    if (!vals.length) return { name, color, avg: null, p50: null, p95: null, p99: null, jitter: null, lossRate }

    const avg = vals.reduce((s, v) => s + v, 0) / vals.length
    const jitter =
      vals.length >= 2
        ? vals.slice(1).reduce((s, v, i) => s + Math.abs(v - vals[i]), 0) / (vals.length - 1)
        : null
    const sorted = [...vals].sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.50)
    const p95 = percentile(sorted, 0.95)
    const p99 = percentile(sorted, 0.99)

    return { name, color, avg, p50, p95, p99, jitter, lossRate }
  })

  return stats.sort((a, b) => {
    const av = a.avg ?? Infinity
    const bv = b.avg ?? Infinity
    if (av !== bv) return av - bv
    const aj = a.jitter ?? Infinity
    const bj = b.jitter ?? Infinity
    if (aj !== bj) return aj - bj
    return a.lossRate - b.lossRate
  })
}

export function buildMergedLatencyChart(dataMap: Partial<Record<LatencyType, TaskQueryResult[]>>) {
  const types = (Object.keys(dataMap) as LatencyType[]).filter(t => dataMap[t]?.length)
  const perType = new Map<LatencyType, ChartSeries[]>()
  let totalSeries = 0
  for (const type of types) {
    const { series } = buildLatencyChart(dataMap[type]!, type)
    perType.set(type, series)
    totalSeries += series.length
  }

  let idx = 0
  const allSeries: ChartSeries[] = []
  for (const type of types) {
    for (const s of perType.get(type) ?? []) {
      allSeries.push({ ...s, name: `${type}:${s.name}`, color: generateSpectrumColor(idx, totalSeries) })
      idx++
    }
  }
  return { series: allSeries }
}

export function computeMergedLatencyStats(dataMap: Partial<Record<LatencyType, TaskQueryResult[]>>): LatencyStats[] {
  const types = (Object.keys(dataMap) as LatencyType[]).filter(t => dataMap[t]?.length)
  const entries: { type: LatencyType; name: string }[] = []
  for (const type of types) {
    for (const name of seriesNames(dataMap[type]!)) {
      entries.push({ type, name })
    }
  }

  const total = entries.length
  const allStats = entries.map(({ type, name: sourceName }, idx) => {
    const rows = dataMap[type]!
    const list = rows.filter(r => (r.cron_source || '未知') === sourceName)
    const vals: number[] = []
    for (const r of list) {
      const v = pickValue(r, type)
      if (v != null) vals.push(v)
    }

    const name = `${type}:${sourceName}`
    const color = generateSpectrumColor(idx, total)
    const lossRate = list.length ? ((list.length - vals.length) / list.length) * 100 : 0
    if (!vals.length) return { name, color, avg: null, p50: null, p95: null, p99: null, jitter: null, lossRate }

    const avg = vals.reduce((s, v) => s + v, 0) / vals.length
    const jitter = vals.length >= 2
      ? vals.slice(1).reduce((s, v, i) => s + Math.abs(v - vals[i]), 0) / (vals.length - 1)
      : null
    const sorted = [...vals].sort((a, b) => a - b)
    return { name, color, avg, p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), jitter, lossRate }
  })

  return allStats.sort((a, b) => {
    const av = a.avg ?? Infinity, bv = b.avg ?? Infinity
    if (av !== bv) return av - bv
    const aj = a.jitter ?? Infinity, bj = b.jitter ?? Infinity
    if (aj !== bj) return aj - bj
    return a.lossRate - b.lossRate
  })
}
