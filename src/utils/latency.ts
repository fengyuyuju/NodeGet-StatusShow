import type { TaskQueryResult } from '../types'

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

export function generateSpectrumColor(index: number, _total: number): string {
  return DISTINCT_COLORS[index % DISTINCT_COLORS.length]
}

// tcp_ping 固定 1 分钟采样：时间戳对齐网格、断线判定与查询额度计算共用此周期
export const TCP_PING_PERIOD_MS = 60_000

function normalizeTs(ts: number) {
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts
  return Math.floor(ms / TCP_PING_PERIOD_MS) * TCP_PING_PERIOD_MS
}

function pickValue(row: TaskQueryResult): number | null {
  const v = row.task_event_result?.tcp_ping
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
  gapLine: ChartSeriesPoint[]
  timeoutLine: ChartSeriesPoint[]
}

interface Segment {
  type: 'normal' | 'timeout' | 'gap'
  a: ChartSeriesPoint
  b: ChartSeriesPoint
}

function buildLineData(segs: Segment[], type: 'normal' | 'gap' | 'timeout'): ChartSeriesPoint[] {
  const out: ChartSeriesPoint[] = []
  let prevEndT: number | null = null
  let needBreak = false
  for (const seg of segs) {
    // zero-length normal marker 仅服务 normalLine 查询，对 gap/timeout 线透明，避免切断连续 gap
    const isMarker = seg.type === 'normal' && seg.a.t === seg.b.t
    if (seg.type !== type) {
      if (!isMarker) {
        if (prevEndT != null) needBreak = true
        prevEndT = null
      }
      continue
    }
    if (prevEndT == null) {
      if (needBreak && out.length > 0) {
        out.push({ t: (out[out.length - 1].t + seg.a.t) / 2, value: null })
      }
      needBreak = false
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

// 同一采样槽（分钟）存在多条记录时（重试/执行漂移），优先保留有效值，避免重复点产生零宽线段
function pickLatestPerSlot(sorted: ChartSeriesPoint[]): ChartSeriesPoint[] {
  const out: ChartSeriesPoint[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].t === sorted[i].t) j++
    let pick = j
    for (let k = j; k >= i; k--) {
      if (sorted[k].value != null) { pick = k; break }
    }
    out.push(sorted[pick])
    i = j + 1
  }
  return out
}

/**
 * 将原始记录按来源归并为分钟采样槽点，并应用统一去重语义。
 *
 * 图表（buildLatencyChart）与统计（computeLatencyStats）共用此入口，
 * 确保重试/执行漂移产生的同槽多条记录只计一次，避免统计口径漂移。
 *
 * @param rows  原始任务查询结果（每条含 timestamp、success、tcp_ping）。
 * @param names 已排序的来源名称，决定输出 Map 的遍历顺序。
 * @returns     每来源对应的 per-slot 去重点序列（按 t 升序，每分钟最多一点）。
 */
function buildPointsBySource(rows: TaskQueryResult[], names: string[]): Map<string, ChartSeriesPoint[]> {
  const bySource = new Map<string, ChartSeriesPoint[]>()
  for (const n of names) bySource.set(n, [])

  for (const r of rows) {
    const name = r.cron_source || '未知'
    bySource.get(name)?.push({ t: normalizeTs(r.timestamp), value: pickValue(r) })
  }

  for (const [name, points] of bySource) {
    bySource.set(name, pickLatestPerSlot(points.sort((a, b) => a.t - b.t)))
  }
  return bySource
}

export function buildLatencyChart(rows: TaskQueryResult[], threshold: number = MAX_CHART_POINTS) {
  const names = seriesNames(rows)
  const total = names.length
  const bySource = buildPointsBySource(rows, names)

  const series: ChartSeries[] = names.map((name, idx) => {
    const points = bySource.get(name) ?? []
    const periodMs = TCP_PING_PERIOD_MS

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

      let prevNormal = false
      for (let k = 0; k < validIdx.length - 1; k++) {
        const i = validIdx[k]
        const j = validIdx[k + 1]
        const sampleAdjacent = j - i === 1
        // 相邻有效点跨采样周期（中间存在漏采槽）即判 gap；gap 由 gapLine 连接呈现，无需再为视觉保底连线
        const noDataGap = sampleAdjacent && points[j].t - points[i].t > periodMs
        const isNormal = sampleAdjacent && !noDataGap
        // 不与任何 normal 段相邻的有效点补 zero-length normal 段，确保 tooltip/cursor 能命中真实值
        if (!prevNormal && !isNormal) {
          segs.push({ type: 'normal', a: points[i], b: points[i] })
        }
        segs.push({
          type: isNormal ? 'normal' : noDataGap ? 'gap' : 'timeout',
          a: points[i],
          b: points[j],
        })
        prevNormal = isNormal
      }
      // 尾部有效点若未被 normal 段覆盖，同样补一点
      if (!prevNormal) {
        const lastValid = points[validIdx[validIdx.length - 1]]
        segs.push({ type: 'normal', a: lastValid, b: lastValid })
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
        b: { t: t1 === t0 ? t0 + TCP_PING_PERIOD_MS : t1, value: 0 },
      })
    }

    const normalLine = downsampleSeries(buildLineData(segs, 'normal'), threshold)
    const gapLine = downsampleSeries(buildLineData(segs, 'gap'), threshold)
    const timeoutLine = downsampleSeries(buildLineData(segs, 'timeout'), threshold)
    return {
      name,
      color: generateSpectrumColor(idx, total),
      points,
      normalLine,
      gapLine,
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
    const budget = Math.max(2, Math.round(threshold * seg.length / totalLen))
    let sampled: ChartSeriesPoint[]

    if (seg.length <= budget) {
      sampled = seg.points
    } else if (budget < 3) {
      // 短段配额被压到 2 时，若段内 ≥3 点，补取中间最高峰，避免首尾直连线吞掉尖峰
      sampled = [seg.points[0], seg.points[seg.length - 1]]
      if (seg.length >= 3) {
        let peakIdx = 1
        for (let j = 2; j < seg.length - 1; j++) {
          if ((seg.points[j].value ?? -Infinity) > (seg.points[peakIdx].value ?? -Infinity)) peakIdx = j
        }
        sampled.splice(1, 0, seg.points[peakIdx])
      }
    } else {
      sampled = [seg.points[0]]
      // LTTB：首尾各占 1 点，中间分 budget-2 桶，每桶选与"上一选中点 + 下一桶均值"构成最大三角形的点。
      // 高压缩比下仍保留整体形态与尖峰，避免 min-max 每桶仅出峰谷导致的长直线失真
      const bucketCount = budget - 2
      const bucketSize = (seg.length - 2) / bucketCount
      let prevIdx = 0

      for (let bucket = 0; bucket < bucketCount; bucket++) {
        const start = 1 + Math.floor(bucket * bucketSize)
        const end = Math.min(seg.length - 1, 1 + Math.floor((bucket + 1) * bucketSize))
        const avgStart = 1 + Math.floor((bucket + 1) * bucketSize)
        const avgEnd = Math.min(seg.length - 1, 1 + Math.floor((bucket + 2) * bucketSize))

        let avgT = seg.points[seg.length - 1].t
        let avgValue = seg.points[seg.length - 1].value ?? 0
        if (avgStart < avgEnd) {
          let sumT = 0
          let sumValue = 0
          for (let j = avgStart; j < avgEnd; j++) {
            sumT += seg.points[j].t
            sumValue += seg.points[j].value ?? 0
          }
          const count = avgEnd - avgStart
          avgT = sumT / count
          avgValue = sumValue / count
        }

        const prev = seg.points[prevIdx]
        const prevValue = prev.value ?? 0
        let pickIdx = start
        let maxArea = -1
        for (let j = start; j < end; j++) {
          const pt = seg.points[j]
          const area = Math.abs(
            (prev.t - avgT) * ((pt.value ?? 0) - prevValue) -
            (prev.t - pt.t) * (avgValue - prevValue),
          )
          if (area > maxArea) {
            maxArea = area
            pickIdx = j
          }
        }

        sampled.push(seg.points[pickIdx])
        prevIdx = pickIdx
      }

      sampled.push(seg.points[seg.length - 1])
    }

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

export function computeLatencyStats(rows: TaskQueryResult[]): LatencyStats[] {
  const names = seriesNames(rows)
  const total = names.length
  const stats = names.map<LatencyStats>((name, i) => {
    const list = rows.filter(r => (r.cron_source || '未知') === name)
    const vals: number[] = []
    for (const r of list) {
      const v = pickValue(r)
      if (v != null) vals.push(v)
    }

    const color = generateSpectrumColor(i, total)
    // 重试即丢包证据：按原始探测次数计，失败探测 / 总探测，不按分钟槽去重
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
