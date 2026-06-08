import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Eye, EyeOff, Maximize2, Minimize2, Scissors } from 'lucide-react'
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from './ui/card'
import { cn } from '../utils/cn'
import {
  buildLatencyChart,
  buildMergedLatencyChart,
  computePeakClipCap,
  computeLatencyStats,
  computeMergedLatencyStats,
  TIMEOUT_COLOR,
  type ChartSeries,
  type ChartSeriesPoint,
  type LatencyStats,
} from '../utils/latency'
import { LATENCY_RANGES, type LatencyRange } from '../hooks/useNodeLatency'
import type { LatencyType, TaskQueryResult } from '../types'

export interface LatencyBlockProps {
  title: string
  rows?: TaskQueryResult[]
  type?: LatencyType
  merged?: Partial<Record<LatencyType, TaskQueryResult[]>>
  loading: boolean
  range: LatencyRange
  onRangeChange: (r: LatencyRange) => void
  chartClass?: string
  statsClass?: string
  titleSlot?: ReactNode
  sourceLabel?: string
}

type SortField = 'p50' | 'p95' | 'p99' | 'jitter' | 'lossRate'
type SortDir = 'asc' | 'desc'

const ms = (v: number) => v.toFixed(1)
const displayName = (name: string) => name.includes(':') ? name.slice(name.indexOf(':') + 1) : name

const QUALITY_SEGMENTS = [
  { max: 50, color: '#26a91e' },
  { max: 100, color: '#43dd3e' },
  { max: 200, color: '#bef663' },
  { max: 250, color: '#f6ed44' },
  { max: Infinity, color: '#f69833' },
] as const
const LOSS_Q_COLOR = '#e6170f'
const CANVAS_H = 16
const HEIGHT_CAP = 400

interface BarChunk { avg: number | null; loss: number }

function downsampleBars(bars: Array<number | null>, maxBars: number): BarChunk[] {
  if (bars.length <= maxBars) {
    return bars.map(v => v == null ? { avg: null, loss: 1 } : { avg: v, loss: 0 })
  }
  const chunkSize = bars.length / maxBars
  const result: BarChunk[] = []
  for (let i = 0; i < maxBars; i++) {
    const start = Math.round(i * chunkSize)
    const end = Math.round((i + 1) * chunkSize)
    const chunk = bars.slice(start, end)
    const valid = chunk.filter((v): v is number => v != null)
    const loss = (chunk.length - valid.length) / chunk.length
    result.push({
      avg: valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : null,
      loss,
    })
  }
  return result
}

export function LatencyBlock({ title, rows, type, merged, loading, range, onRangeChange, chartClass, statsClass, titleSlot, sourceLabel = '来源' }: LatencyBlockProps) {
  const { series } = useMemo(() => merged ? buildMergedLatencyChart(merged) : buildLatencyChart(rows!, type!), [merged, rows, type])
  const baseStats = useMemo(() => merged ? computeMergedLatencyStats(merged) : computeLatencyStats(rows!, type!), [merged, rows, type])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [peakClipping, setPeakClipping] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('p50')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [maximized, setMaximized] = useState(false)
  const empty = series.every(s => s.points.length === 0)
  const emptyLabel = merged ? '延迟' : type

  const xDomain = useMemo((): [number, number] => {
    const ms = LATENCY_RANGES.find(r => r.key === range)?.ms ?? LATENCY_RANGES[0].ms
    const now = Date.now()
    return [now - ms, now]
  }, [range, series])

  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMaximized(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [maximized])

  const chartData = useMemo(() => {
    const set = new Set<number>()
    for (const s of series) {
      for (const p of s.normalLine) set.add(p.t)
      for (const p of s.timeoutLine) set.add(p.t)
    }
    set.add(xDomain[0])
    set.add(xDomain[1])
    return [...set].sort((a, b) => a - b).map(t => ({ t, _ref: 0 }))
  }, [series, xDomain])

  const xTicks = useMemo(() => {
    if (chartData.length === 0) return []
    const min = xDomain[0]
    const max = xDomain[1]
    if (min === max) return [min]
    if (range === '7d') {
      const ticks: number[] = []
      const d = new Date(min)
      d.setHours(0, 0, 0, 0)
      if (d.getTime() < min) d.setDate(d.getDate() + 1)
      while (d.getTime() <= max) {
        ticks.push(d.getTime())
        d.setDate(d.getDate() + 1)
      }
      if (ticks.length >= 2) return ticks
    }
    const count = 6
    const step = (max - min) / (count - 1)
    const ticks: number[] = []
    for (let i = 0; i < count; i++) ticks.push(min + step * i)
    return ticks
  }, [chartData, range])

  const { displaySeries, caps } = useMemo(() => {
    if (!peakClipping) return { displaySeries: series, caps: new Map<string, number | null>() }
    const capMap = new Map<string, number | null>()
    const clipped = series.map(s => {
      const values = s.points
        .map(pt => pt.value)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      const cap = computePeakClipCap(values)
      capMap.set(s.name, cap)
      if (cap == null) return s
      const clip = (pts: ChartSeriesPoint[]) =>
        pts.map(p => p.value != null && p.value > cap ? { ...p, value: cap } : p)
      return {
        ...s,
        points: s.points.map(p => p.value != null && p.value > cap ? { ...p, value: cap } : p),
        normalLine: clip(s.normalLine),
        timeoutLine: clip(s.timeoutLine),
      }
    })
    return { displaySeries: clipped, caps: capMap }
  }, [series, peakClipping])

  const stats = useMemo(() => {
    const base = baseStats

    const sorted = [...base]
    sorted.sort((a, b) => {
      let av: number, bv: number
      if (sortField === 'p50') {
        av = a.p50 ?? Infinity
        bv = b.p50 ?? Infinity
      } else if (sortField === 'p95') {
        av = a.p95 ?? Infinity
        bv = b.p95 ?? Infinity
      } else if (sortField === 'p99') {
        av = a.p99 ?? Infinity
        bv = b.p99 ?? Infinity
      } else if (sortField === 'jitter') {
        av = a.jitter ?? Infinity
        bv = b.jitter ?? Infinity
      } else {
        av = a.lossRate
        bv = b.lossRate
      }
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return sorted
  }, [baseStats, sortField, sortDir])

  const [nameColWidth, setNameColWidth] = useState(80)

  const measureAllRef = useCallback((container: HTMLDivElement | null) => {
    if (!container) return
    let maxWidth = 80
    for (const child of container.children) {
      maxWidth = Math.max(maxWidth, (child as HTMLElement).offsetWidth)
    }
    setNameColWidth(Math.max(80, Math.min(240, Math.ceil(maxWidth) + 8)))
  }, [stats])

  const seriesPointsMap = useMemo(() => {
    const m = new Map<string, ChartSeriesPoint[]>()
    for (const s of series) m.set(s.name, s.points)
    return m
  }, [series])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const { yDomain, yTicks, clippedCount } = useMemo(() => {
    const visibleDisplay = displaySeries.filter(s =>
      hovered ? s.name === hovered : !hidden.has(s.name),
    )
    if (visibleDisplay.length === 0) {
      return { yDomain: [0, 100] as [number, number], yTicks: [0, 25, 50, 75, 100], clippedCount: 0 }
    }
    let clippedCount = 0
    if (peakClipping) {
      const rawVisible = hovered
        ? series.filter(s => s.name === hovered)
        : series.filter(s => !hidden.has(s.name))
      for (const s of rawVisible) {
        const cap = caps.get(s.name)
        if (cap == null) continue
        for (const pt of s.points) {
          if (pt.value != null && pt.value > cap) clippedCount++
        }
      }
    }
    let min = Infinity
    let max = -Infinity
    for (const s of visibleDisplay) {
      for (const pt of s.points) {
        const v = pt.value
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (v < min) min = v
          if (v > max) max = v
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { yDomain: [0, 100] as [number, number], yTicks: [0, 25, 50, 75, 100], clippedCount: 0 }
    }
    const rawRange = max - min || 1
    let yDomain: [number, number]
    let yTicks: number[]
    if (max - min < 0.001) {
      const pad = Math.max(10, min * 0.1)
      const lo = Math.max(0, min - pad)
      const hi = max + pad
      yDomain = [lo, hi]
      const step = (hi - lo) / 3
      yTicks = [lo, lo + step, lo + 2 * step, hi]
    } else {
      yDomain = [min, max]
      const step = rawRange / 3
      yTicks = [min, min + step, min + 2 * step, max]
    }
    return { yDomain, yTicks, clippedCount }
  }, [displaySeries, series, caps, hidden, hovered, peakClipping])

  const rangeRef = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useEffect(() => {
    const el = rangeRef.current
    if (!el) return
    const btn = el.querySelector<HTMLElement>('[data-active="true"]')
    if (!btn) return
    const cr = el.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    setIndicator({ left: br.left - cr.left, width: br.width })
  }, [range])

  const isTouchRef = useRef(false)
  useEffect(() => {
    isTouchRef.current = window.matchMedia('(pointer: coarse)').matches
  }, [])

  const handleListMouseMove = (e: React.MouseEvent) => {
    if (isTouchRef.current) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-source]')
    setHovered(row?.dataset.source ?? null)
  }

  const toggle = (name: string) =>
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const toolbarRow = (
    <div className="flex flex-wrap items-center justify-end gap-2 mb-3">
      {titleSlot ? (
        <>
          <div className="hidden md:block text-xs uppercase tracking-wide text-muted-foreground mr-auto">
            {title}
          </div>
          <div className="md:hidden mr-auto">{titleSlot}</div>
        </>
      ) : (
        <div className="text-xs uppercase tracking-wide text-muted-foreground mr-auto">
          {title}
        </div>
      )}
      <div className="flex gap-1 items-center">
        <div className="bg-muted p-1 rounded-md">
          <button
            onClick={() => setHidden(new Set())}
            className="inline-flex items-center justify-center px-2 py-1 rounded-sm transition-colors text-muted-foreground hover:text-foreground"
            title="全部显示"
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="bg-muted p-1 rounded-md">
          <button
            onClick={() => setHidden(new Set(series.map(s => s.name)))}
            className="inline-flex items-center justify-center px-2 py-1 rounded-sm transition-colors text-muted-foreground hover:text-foreground"
            title="全部隐藏"
          >
            <EyeOff className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className={cn('p-1 rounded-md transition-colors', peakClipping ? 'bg-primary' : 'bg-muted')}>
          <button
            type="button"
            onClick={() => setPeakClipping(v => !v)}
            aria-pressed={peakClipping}
            aria-label="切换延迟峰值裁剪显示"
            className={cn(
              'inline-flex items-center justify-center px-2 py-1 rounded-sm transition-colors',
              peakClipping ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            title="峰值裁剪：裁剪极端延迟波动以观察主体趋势"
          >
            <Scissors className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="w-px h-4 bg-border mx-1" aria-hidden="true" />
        <div ref={rangeRef} className="relative bg-muted p-1 rounded-md flex gap-0.5 items-center">
          <div
            aria-hidden
            className="absolute top-1 rounded-sm bg-background shadow transition-all duration-200 ease-out"
            style={{ left: indicator.left, width: indicator.width, height: 'calc(100% - 0.5rem)' }}
          />
          {LATENCY_RANGES.map(r => (
            <button
              key={r.key}
              data-active={range === r.key}
              onClick={() => onRangeChange(r.key)}
              className={cn(
                'relative z-10 px-2 py-1 text-[11px] rounded-sm transition-colors',
                range === r.key
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="w-px h-4 bg-border mx-1" aria-hidden="true" />
        <div className="bg-muted p-1 rounded-md">
          <button
            onClick={() => setMaximized(v => !v)}
            className="inline-flex items-center justify-center px-2 py-1 rounded-sm transition-colors text-muted-foreground hover:text-foreground"
            title={maximized ? '缩小' : '最大化图表'}
            aria-label={maximized ? '缩小图表' : '最大化图表'}
          >
            {maximized
              ? <Minimize2 className="w-3.5 h-3.5" />
              : <Maximize2 className="w-3.5 h-3.5" />
            }
          </button>
        </div>
      </div>
    </div>
  )

  const chartArea = (
    <div className={cn('relative', maximized ? 'h-[33.33vh] shrink-0' : chartClass || 'h-60')}>
      {empty ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {loading ? '加载中…' : `暂无 ${emptyLabel} 数据`}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="t"
              type="number"
              domain={xDomain}
              scale="time"
              allowDuplicatedCategory={false}
              tickFormatter={t =>
                range === '7d'
                  ? `${new Date(t).getMonth() + 1}-${String(new Date(t).getDate()).padStart(2, '0')}`
                  : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
              }
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
              ticks={xTicks}
              interval={0}
              allowDataOverflow
            />
            <YAxis
              key={`${yDomain[0]}-${yDomain[1]}`}
              tickFormatter={v => {
                const r = Math.round(v)
                return Math.abs(v - r) < 0.001 ? `${r}` : v.toFixed(1)
              }}
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
              width={32}
              domain={yDomain}
              ticks={yTicks}
              allowDataOverflow
              minTickGap={24}
            />
            <Line
              dataKey="_ref"
              stroke="transparent"
              strokeWidth={0}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            {displaySeries.flatMap(s => {
              const isVisible = hovered
                ? s.name === hovered
                : !hidden.has(s.name)
              if (!isVisible) return []
              return [
                <Line
                  key={`${s.name}-normal`}
                  data={s.normalLine}
                  type="linear"
                  dataKey="value"
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={1}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />,
                <Line
                  key={`${s.name}-timeout`}
                  data={s.timeoutLine}
                  type="linear"
                  dataKey="value"
                  name={`${s.name}__timeout`}
                  stroke={TIMEOUT_COLOR}
                  strokeWidth={1}
                  strokeOpacity={0.3}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />,
                ...(s.normalLine.length <= 1 && s.timeoutLine.length === 0 && s.points.some(p => typeof p.value === 'number' && Number.isFinite(p.value))
                  ? [
                      <Line
                        key={`${s.name}-dots`}
                        data={s.points.filter(p => typeof p.value === 'number' && Number.isFinite(p.value))}
                        type="linear"
                        dataKey="value"
                        name={`${s.name}__dots`}
                        stroke={s.color}
                        strokeWidth={0}
                        dot={{ r: 2.5, fill: s.color, stroke: s.color }}
                        activeDot={false}
                        isAnimationActive={false}
                      />,
                    ]
                  : []),
              ]
            })}
            {/* Tooltip last = cursor renders on top of all lines */}
            <Tooltip
              content={<LatencyTooltip hidden={hidden} series={displaySeries} range={range} />}
              cursor={<CursorDots yDomain={yDomain} series={displaySeries} hidden={hidden} hovered={hovered} />}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
      {loading && (
        <div className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </div>
  )

  const tableBg = maximized ? 'bg-background' : 'bg-card'

  const statsTable = (
    <div className={cn('mt-3 border-t pt-3 pb-1.5 overflow-x-auto', maximized ? 'flex-1 min-h-0 overflow-y-auto' : statsClass)}>
      <div className={cn('flex items-center gap-1 pl-0 pr-2 pb-1 text-[11px] text-muted-foreground whitespace-nowrap min-w-[530px]', tableBg)}>
        <span className={cn('sticky left-0 shrink-0 pl-2 pr-3 -mr-1 z-10', tableBg)} style={{ width: nameColWidth }}>
          {sourceLabel}
        </span>
        <span className="flex-1 max-w-[450px] min-w-[120px] ml-auto">
          质量
        </span>
        <SortHeader
          label="P50"
          field="p50"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-[52px]"
        />
        <SortHeader
          label="P95"
          field="p95"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-[52px]"
        />
        <SortHeader
          label="P99"
          field="p99"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-[52px]"
        />
        <SortHeader
          label="抖动"
          field="jitter"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-10"
        />
        <SortHeader
          label="丢包率"
          field="lossRate"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-10"
        />
      </div>
      {stats.length > 0 && (
        <div
          ref={measureAllRef}
          aria-hidden="true"
          className="flex flex-col text-xs"
          style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: 'max-content' }}
        >
          {stats.map(s => (
            <span key={s.name} className="flex items-center pl-2 pr-3 -mr-1 whitespace-nowrap font-semibold">{displayName(s.name)}</span>
          ))}
        </div>
      )}
      {stats.length > 0 ? (
        <div onMouseMove={handleListMouseMove} onMouseLeave={() => setHovered(null)}>
          {stats.map(s => (
            <LatencyStatsRow
              key={s.name}
              stat={s}
              points={seriesPointsMap.get(s.name) ?? []}
              hidden={hidden.has(s.name)}
              onToggle={() => toggle(s.name)}
              tableBg={tableBg}
              nameColWidth={nameColWidth}
            />
          ))}
        </div>
      ) : (
        <div className="py-6 text-center text-xs text-muted-foreground">
          {loading ? '加载中…' : `暂无 ${emptyLabel} 数据`}
        </div>
      )}
    </div>
  )

  if (maximized) {
    return createPortal(
      <div className="fixed inset-0 z-[60] bg-background/70 backdrop-blur animate-in fade-in duration-200 flex items-center justify-center p-4" onClick={() => setMaximized(false)}>
        <div className="max-h-[90vh] w-full flex flex-col bg-background border border-border rounded-lg px-5 pb-4 pt-3 overflow-hidden" onClick={e => e.stopPropagation()}>
          {toolbarRow}
          {chartArea}
          {statsTable}
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <Card className="p-3 sm:p-5">
      {toolbarRow}
      {chartArea}
      {statsTable}
    </Card>
  )
}

function QualityCanvas({ bars }: { bars: Array<number | null> }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const w = canvas.offsetWidth
      if (!w) return
      canvas.width = w
      canvas.height = CANVAS_H
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, w, CANVAS_H)
      if (!bars.length) return
      const maxBars = Math.floor(w)
      const display = downsampleBars(bars, maxBars)
      const n = display.length
      for (let i = 0; i < n; i++) {
        const x = Math.round((i / n) * w)
        const bw = Math.round(((i + 1) / n) * w) - x
        if (bw <= 0) continue
        const c = display[i]
        if (c.avg != null) {
          const seg = QUALITY_SEGMENTS.find(s => c.avg < s.max) ?? QUALITY_SEGMENTS[QUALITY_SEGMENTS.length - 1]
          const h = Math.min(CANVAS_H, Math.max(1, Math.round((c.avg / HEIGHT_CAP) * CANVAS_H)))
          ctx.fillStyle = seg.color
          ctx.fillRect(x, CANVAS_H - h, bw, h)
        }
        if (c.loss > 0) {
          const h = Math.max(1, Math.round(c.loss * CANVAS_H))
          ctx.fillStyle = LOSS_Q_COLOR
          ctx.fillRect(x, CANVAS_H - h, bw, h)
        }
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [bars])

  return <canvas ref={ref} className="block h-4 w-full" />
}

function LatencyStatsRow({
  stat,
  points,
  hidden,
  onToggle,
  tableBg,
  nameColWidth,
}: {
  stat: LatencyStats
  points: ChartSeriesPoint[]
  hidden: boolean
  onToggle: () => void
  tableBg: string
  nameColWidth: number
}) {
  const { name, color, p50, p95, p99, jitter, lossRate } = stat
  const bars = useMemo(() => points.map(p => p.value), [points])

  return (
    <div
      onClick={onToggle}
      data-source={name}
      className={cn(
        'flex items-center gap-1 pl-0 pr-2 py-1 text-xs cursor-pointer select-none transition-opacity group hover:bg-muted min-w-[530px]',
        tableBg,
        hidden && 'opacity-35',
      )}
    >
      <span className={cn('sticky left-0 shrink-0 flex items-center pl-2 pr-3 -mr-1 z-10', tableBg, 'group-hover:bg-muted')} style={{ width: nameColWidth }}>
        <span className="truncate font-semibold" style={{ color }}>{displayName(name)}</span>
      </span>
      <span className="flex-1 max-w-[450px] min-w-[120px] ml-auto">
        <QualityCanvas bars={bars} />
      </span>
      <span className="w-[52px] text-right tabular-nums font-mono">
        {p50 != null ? ms(p50) : '—'}
      </span>
      <span className="w-[52px] text-right tabular-nums font-mono">
        {p95 != null ? ms(p95) : '—'}
      </span>
      <span className="w-[52px] text-right tabular-nums font-mono">
        {p99 != null ? ms(p99) : '—'}
      </span>
      <span className="w-10 text-right tabular-nums font-mono">
        {jitter != null ? ms(jitter) : '—'}
      </span>
      <span
        className={cn(
          'w-10 text-right tabular-nums font-mono',
          lossRate >= 5 && 'text-red-500 font-medium',
        )}
      >
        {lossRate.toFixed(1)}
      </span>
    </div>
  )
}

interface SortHeaderProps {
  label: string
  field: SortField
  current: SortField
  dir: SortDir
  onClick: (field: SortField) => void
  className?: string
}

function SortHeader({ label, field, current, dir, onClick, className }: SortHeaderProps) {
  const active = current === field
  const Icon = dir === 'desc' ? ArrowDown : ArrowUp

  return (
    <button
      onClick={() => onClick(field)}
      className={cn(
        'flex items-center justify-end gap-0.5 text-right cursor-pointer select-none hover:text-foreground transition-colors',
        active && 'text-foreground',
        className,
      )}
    >
      {active && <Icon className="h-3 w-3" />}
      <span>{label}</span>
    </button>
  )
}

/**
 * Binary search for the interpolated value of a series at a given timestamp.
 * `normalLine` is sorted by `t`. Returns the value and whether the cursor is inside a gap.
 */
function lookupSeriesValue(normalLine: ChartSeriesPoint[], targetT: number): { value: number | null; inGap: boolean } {
  const n = normalLine.length
  if (n === 0) return { value: null, inGap: false }

  // Binary search for insertion point
  let lo = 0
  let hi = n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const mt = normalLine[mid].t
    if (mt < targetT) lo = mid + 1
    else if (mt > targetT) hi = mid - 1
    else {
      // Exact timestamp match
      const v = normalLine[mid].value
      if (v == null || !Number.isFinite(v)) return { value: null, inGap: true }
      return { value: v, inGap: false }
    }
  }
  // After binary search: hi = last index with t < targetT, lo = first index with t > targetT

  // Walk backward to nearest valid point
  let loIdx = hi
  while (loIdx >= 0 && (normalLine[loIdx].value == null || !Number.isFinite(normalLine[loIdx].value!))) loIdx--
  if (loIdx < 0) return { value: null, inGap: false }

  // Walk forward to nearest valid point
  let hiIdx = lo
  while (hiIdx < n && (normalLine[hiIdx].value == null || !Number.isFinite(normalLine[hiIdx].value!))) hiIdx++

  // Check for gap (null points between loIdx and hiIdx)
  let inGap = false
  for (let i = loIdx + 1; i < hiIdx; i++) {
    if (normalLine[i].value == null) { inGap = true; break }
  }
  if (inGap) return { value: null, inGap: true }

  const loPt = normalLine[loIdx]
  if (loPt.t === targetT) {
    return { value: loPt.value!, inGap: false }
  }
  if (hiIdx >= n) {
    return { value: null, inGap: false }
  }

  const hiPt = normalLine[hiIdx]
  const frac = (targetT - loPt.t) / (hiPt.t - loPt.t)
  return { value: loPt.value! + (hiPt.value! - loPt.value!) * frac, inGap: false }
}

interface CursorDotsProps {
  yDomain: [number, number]
  series: ChartSeries[]
  hidden: Set<string>
  hovered: string | null
  points?: { x: number; y: number }[]
  payload?: { payload?: { t: number } }[]
  top?: number
  height?: number
}

function CursorDots(props: CursorDotsProps) {
  const { yDomain, series, hidden, hovered, points: cursorPts, payload, top, height } = props
  if (!cursorPts?.length) return null
  const x = cursorPts[0].x
  const label = payload?.[0]?.payload?.t
  if (x == null || label == null) return null

  const t = Number(top)
  const h = Number(height)
  const yMin = yDomain[0]
  const yRange = yDomain[1] - yMin || 1
  const toY = (v: number) => t + h * (1 - (v - yMin) / yRange)

  const circles: React.ReactNode[] = []
  for (const s of series) {
    if (hovered ? s.name !== hovered : hidden.has(s.name)) continue
    const { value, inGap } = lookupSeriesValue(s.normalLine, label)
    if (inGap || value == null) continue
    const cy = toY(value)
    if (!Number.isFinite(cy)) continue
    circles.push(
      <circle key={s.name} cx={x} cy={cy} r={5} fill={s.color} stroke="#fff" strokeWidth={1} />,
    )
  }

  return (
    <g pointerEvents="none">
      <line x1={x} y1={t} x2={x} y2={t + h} stroke="hsl(var(--border))" strokeDasharray="3 3" />
      {circles}
    </g>
  )
}

interface LatencyTooltipProps {
  active?: boolean
  label?: number
  hidden: Set<string>
  series: ChartSeries[]
  range: LatencyRange
}

function LatencyTooltip({ active, label, hidden, series, range }: LatencyTooltipProps) {
  if (!active || label == null) return null

  const rows: { name: string; color: string; value: number | null; isTimeout: boolean }[] = []
  for (const s of series) {
    if (hidden.has(s.name)) continue
    const normal = lookupSeriesValue(s.normalLine, label)
    if (!normal.inGap && normal.value != null) {
      rows.push({ name: s.name, color: s.color, value: normal.value, isTimeout: false })
    } else if (normal.inGap) {
      const timeout = lookupSeriesValue(s.timeoutLine, label)
      rows.push({ name: s.name, color: s.color, value: null, isTimeout: !timeout.inGap && timeout.value != null })
    } else {
      const timeout = lookupSeriesValue(s.timeoutLine, label)
      rows.push({ name: s.name, color: s.color, value: null, isTimeout: !timeout.inGap && timeout.value != null })
    }
  }
  if (rows.length === 0) return null
  rows.sort((a, b) => {
    const av = a.value, bv = b.value
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return av - bv
  })

  return (
    <div
      style={{
        background: 'hsl(var(--popover))',
        border: '1px solid hsl(var(--border))',
        borderRadius: 6,
        fontSize: 11,
        padding: '8px 10px',
      }}
    >
      <div className="text-muted-foreground mb-1">
        {range === '7d'
          ? `${new Date(label).getMonth() + 1}-${String(new Date(label).getDate()).padStart(2, '0')} ${new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}`
          : new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}
      </div>
      {rows.map(r => (
        <div key={r.name} className="flex items-center gap-2">
          <span className="flex-1 truncate font-semibold" style={{ color: r.color }}>{displayName(r.name)}</span>
          <span
            className={cn(
              'font-mono tabular-nums',
              r.value == null && !r.isTimeout && 'text-muted-foreground',
              r.isTimeout && 'text-red-500',
            )}
          >
            {r.value != null ? ms(r.value) : r.isTimeout ? '超时' : '-'}
          </span>
        </div>
      ))}
    </div>
  )
}
