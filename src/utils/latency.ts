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

export const TIMEOUT_COLOR = '#ef4444'

export function generateSpectrumColor(index: number, _total: number): string {
  return DISTINCT_COLORS[index % DISTINCT_COLORS.length]
}

function normalizeTs(ts: number) {
  return ts < 1_000_000_000_000 ? ts * 1000 : ts
}

function pickValue(row: TaskQueryResult, type: LatencyType): number | null {
  const v = row.task_event_result?.[type]
  return row.success && typeof v === 'number' ? v : null
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
  const data: ChartSeriesPoint[] = []
  let prevEndT: number | null = null
  let needGap = false
  for (const seg of segs) {
    if (seg.type !== type) {
      if (prevEndT != null) needGap = true
      prevEndT = null
      continue
    }
    if (prevEndT == null) {
      if (needGap && data.length > 0) {
        const gapT = (data[data.length - 1].t + seg.a.t) / 2
        data.push({ t: gapT, value: null })
      }
      needGap = false
      data.push({ t: seg.a.t, value: seg.a.value })
    } else if (type === 'timeout') {
      data.push({ t: prevEndT, value: null })
      data.push({ t: seg.a.t, value: seg.a.value })
    }
    data.push({ t: seg.b.t, value: seg.b.value })
    prevEndT = seg.b.t
  }
  return data
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
      if (typeof points[i].value === 'number') validIdx.push(i)
    }

    const segs: Segment[] = []
    for (let k = 0; k < validIdx.length - 1; k++) {
      const i = validIdx[k]
      const j = validIdx[k + 1]
      segs.push({
        type: j - i === 1 ? 'normal' : 'timeout',
        a: points[i],
        b: points[j],
      })
    }

    return {
      name,
      color: generateSpectrumColor(idx, total),
      points,
      normalLine: buildLineData(segs, 'normal'),
      timeoutLine: buildLineData(segs, 'timeout'),
    }
  })

  return { series }
}

export interface LatencyStats {
  name: string
  color: string
  avg: number | null
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
    if (!vals.length) return { name, color, avg: null, p99: null, jitter: null, lossRate }

    const avg = vals.reduce((s, v) => s + v, 0) / vals.length
    const jitter =
      vals.length >= 2
        ? vals.slice(1).reduce((s, v, i) => s + Math.abs(v - vals[i]), 0) / (vals.length - 1)
        : null
    const p99 = percentile([...vals].sort((a, b) => a - b), 0.99)

    return { name, color, avg, p99, jitter, lossRate }
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
