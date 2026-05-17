import { useEffect, useMemo, useRef, useState } from 'react'
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
  computePeakClipCap,
  computeLatencyStats,
  TIMEOUT_COLOR,
  type ChartSeries,
  type ChartSeriesPoint,
  type LatencyStats,
} from '../utils/latency'
import { LATENCY_RANGES, type LatencyRange } from '../hooks/useNodeLatency'
import type { LatencyType, TaskQueryResult } from '../types'

export interface LatencyBlockProps {
  title: string
  rows: TaskQueryResult[]
  type: LatencyType
  loading: boolean
  range: LatencyRange
  onRangeChange: (r: LatencyRange) => void
  chartClass?: string
  statsClass?: string
}

type SortField = 'avg' | 'p95' | 'p99' | 'jitter' | 'lossRate'
type SortDir = 'asc' | 'desc'

const ms = (v: number) => v.toFixed(1)

export function LatencyBlock({ title, rows, type, loading, range, onRangeChange, chartClass, statsClass }: LatencyBlockProps) {
  const { series } = useMemo(() => buildLatencyChart(rows, type), [rows, type])
  const baseStats = useMemo(() => computeLatencyStats(rows, type), [rows, type])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [peakClipping, setPeakClipping] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('avg')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [maximized, setMaximized] = useState(false)
  const empty = series.every(s => s.points.length === 0)

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
      for (const p of s.points) set.add(p.t)
    }
    return [...set].sort((a, b) => a - b).map(t => ({ t, _ref: 0 }))
  }, [series])

  const xTicks = useMemo(() => {
    const times = chartData.map(d => d.t)
    if (times.length === 0) return []
    const min = times[0]
    const max = times[times.length - 1]
    if (min === max) return [min]
    const count = 6
    const step = (max - min) / (count - 1)
    const ticks: number[] = []
    for (let i = 0; i < count; i++) ticks.push(min + step * i)
    return ticks
  }, [chartData])

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
    const base = peakClipping
      ? displaySeries.map(s => {
          const rawStat = baseStats.find(bs => bs.name === s.name)!
          const vals = s.points
            .map(p => p.value)
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
          let avg: number | null = null
          let jitter: number | null = null
          if (vals.length) {
            avg = vals.reduce((sum, v) => sum + v, 0) / vals.length
            if (vals.length >= 2) {
              jitter = vals.slice(1).reduce((sum, v, i) => sum + Math.abs(v - vals[i]), 0) / (vals.length - 1)
            }
          }
          return {
            ...rawStat,
            avg,
            jitter,
          } satisfies LatencyStats
        })
      : baseStats

    const sorted = [...base]
    sorted.sort((a, b) => {
      let av: number, bv: number
      if (sortField === 'avg') {
        av = a.avg ?? Infinity
        bv = b.avg ?? Infinity
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
  }, [baseStats, displaySeries, peakClipping, sortField, sortDir])

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
    const range = max - min || 1
    const step = range / 3
    const yTicks = [min, min + step, min + 2 * step, max]
    const yDomain: [number, number] = [min, max]
    return { yDomain, yTicks, clippedCount }
  }, [displaySeries, series, caps, hidden, hovered, peakClipping])

  const timeoutMarks = useMemo(() => {
    const visible = hovered
      ? series.filter(s => s.name === hovered)
      : series.filter(s => !hidden.has(s.name))
    const set = new Set<number>()
    for (const s of visible) {
      for (const p of s.points) {
        if (p.value == null) set.add(p.t)
      }
    }
    return [...set].sort((a, b) => a - b).map(t => ({ t, y: yDomain[0] }))
  }, [series, yDomain, hidden, hovered])

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
      <div className="text-xs uppercase tracking-wide text-muted-foreground mr-auto">
        {title}
      </div>
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
          {loading ? '加载中…' : `暂无 ${type} 数据`}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
              ticks={xTicks}
              interval={0}
            />
            <YAxis
              key={`${yDomain[0]}-${yDomain[1]}`}
              tickFormatter={v => `${Math.round(v)}ms`}
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
              width={48}
              domain={yDomain}
              ticks={yTicks}
              allowDataOverflow
              minTickGap={24}
            />
            <Tooltip
              content={<LatencyTooltip hidden={hidden} series={series} />}
            />
            <Line
              dataKey="_ref"
              stroke="transparent"
              strokeWidth={0}
              dot={false}
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
                  type="monotone"
                  dataKey="value"
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />,
                <Line
                  key={`${s.name}-timeout`}
                  data={s.timeoutLine}
                  type="monotone"
                  dataKey="value"
                  name={`${s.name}__timeout`}
                  stroke={s.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.2}
                  dot={false}
                  isAnimationActive={false}
                />,
              ]
            })}
            {timeoutMarks.length > 0 && (
              <Line
                data={timeoutMarks}
                dataKey="y"
                stroke="none"
                dot={(props: any) => {
                  const { cx, cy } = props
                  if (cx == null || cy == null) return null
                  return (
                    <polygon
                      points={`${cx},${cy - 5} ${cx - 3.5},${cy + 1} ${cx + 3.5},${cy + 1}`}
                      fill={TIMEOUT_COLOR}
                      opacity={0.8}
                    />
                  )
                }}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      )}
      {loading && (
        <div className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </div>
  )

  const statsTable = (
    <div className={cn('mt-3 border-t pt-3 overflow-x-auto', maximized ? 'flex-1 min-h-0 overflow-y-auto' : statsClass)}>
      <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] text-muted-foreground whitespace-nowrap">
        <span className="sticky left-0 pr-3 z-10 min-w-[140px]">
          来源
        </span>
        <SortHeader
          label="平均值"
          field="avg"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-20 ml-auto"
        />
        <SortHeader
          label="P95"
          field="p95"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-20"
        />
        <SortHeader
          label="P99"
          field="p99"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-20"
        />
        <SortHeader
          label="抖动"
          field="jitter"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-16"
        />
        <SortHeader
          label="丢包率"
          field="lossRate"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-14"
        />
      </div>
      {stats.length > 0 ? (
        <div onMouseMove={handleListMouseMove} onMouseLeave={() => setHovered(null)}>
          {stats.map(s => (
            <LatencyStatsRow
              key={s.name}
              stat={s}
              hidden={hidden.has(s.name)}
              onToggle={() => toggle(s.name)}
            />
          ))}
        </div>
      ) : (
        <div className="py-6 text-center text-xs text-muted-foreground">
          {loading ? '加载中…' : `暂无 ${type} 数据`}
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

function LatencyStatsRow({
  stat,
  hidden,
  onToggle,
}: {
  stat: LatencyStats
  hidden: boolean
  onToggle: () => void
}) {
  const { name, color, avg, p95, p99, jitter, lossRate } = stat

  return (
    <div
      onClick={onToggle}
      data-source={name}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs cursor-pointer select-none transition-opacity group hover:bg-muted/60',
        hidden && 'opacity-35',
      )}
    >
      <span className="flex items-center gap-2 sticky left-0 pr-3 min-w-[140px]">
        <span
          className="inline-block w-4 h-0.5 rounded-full shrink-0"
          style={{ background: color }}
        />
        <span className="truncate">{name}</span>
      </span>
      <span className="w-20 text-right tabular-nums font-mono ml-auto">
        {avg != null ? ms(avg) : '—'}
      </span>
      <span className="w-20 text-right tabular-nums font-mono">
        {p95 != null ? ms(p95) : '—'}
      </span>
      <span className="w-20 text-right tabular-nums font-mono">
        {p99 != null ? ms(p99) : '—'}
      </span>
      <span className="w-16 text-right tabular-nums font-mono">
        {jitter != null ? ms(jitter) : '—'}
      </span>
      <span
        className={cn(
          'w-14 text-right tabular-nums font-mono',
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

interface LatencyTooltipProps {
  active?: boolean
  label?: number
  hidden: Set<string>
  series: ChartSeries[]
}

function LatencyTooltip({ active, label, hidden, series }: LatencyTooltipProps) {
  if (!active || label == null) return null

  const rows: { name: string; color: string; value: number | null }[] = []
  for (const s of series) {
    if (hidden.has(s.name)) continue
    let found = false
    let value: number | null = null
    for (let i = s.points.length - 1; i >= 0; i--) {
      if (s.points[i].t <= label) {
        const v = s.points[i].value
        value = typeof v === 'number' && Number.isFinite(v) ? v : null
        found = true
        break
      }
    }
    if (found) rows.push({ name: s.name, color: s.color, value })
  }
  if (rows.length === 0) return null
  rows.sort((a, b) => {
    if (a.value == null && b.value == null) return 0
    if (a.value == null) return 1
    if (b.value == null) return -1
    return a.value - b.value
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
        {new Date(label).toLocaleTimeString()}
      </div>
      {rows.map(r => (
        <div key={r.name} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: r.color }}
          />
          <span className="flex-1 truncate">{r.name}</span>
          <span
            className={cn(
              'font-mono tabular-nums',
              r.value == null && 'text-muted-foreground',
            )}
          >
            {r.value == null ? '超时' : ms(r.value)}
          </span>
        </div>
      ))}
    </div>
  )
}
