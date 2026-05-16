import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowLeft, ArrowUp, Eye, EyeOff, Maximize2, Minimize2, Scissors } from 'lucide-react'
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Flag } from './Flag'
import { StatusDot } from './StatusDot'
import { bytes, pct, relativeAge, uptime } from '../utils/format'
import { deriveUsage, displayName, distroLogo, osLabel, virtLabel } from '../utils/derive'
import { cycleProgress, hasCost, remainingDays, remainingValue } from '../utils/cost'
import { cn, strokeColor } from '../utils/cn'
import {
  buildLatencyChart,
  computePeakClipCap,
  computeLatencyStats,
  TIMEOUT_COLOR,
  type ChartSeries,
  type ChartSeriesPoint,
  type LatencyStats,
} from '../utils/latency'
import { useNodeLatency, LATENCY_RANGES, type LatencyRange } from '../hooks/useNodeLatency'
import type { BackendPool } from '../api/pool'
import type { HistorySample, LatencyType, Node, NodeMeta, TaskQueryResult } from '../types'

const TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  fontSize: 11,
}

interface Props {
  node: Node | null
  onClose: () => void
  showSource?: boolean
  pool: BackendPool | null
}

export function NodeDetail({ node, onClose, showSource, pool }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  const [latencyRange, setLatencyRange] = useState<LatencyRange>('1d')

  useEffect(() => {
    if (!node) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [node, onClose])

  const nodeUuid = node?.uuid
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setStuck(false)
    const onScroll = () => {
      const h = headerRef.current?.offsetHeight ?? 60
      setStuck(el.scrollTop > h)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [nodeUuid])

  const { pingData, tcpData, loading: latencyLoading } = useNodeLatency(
    pool,
    node?.source ?? null,
    node?.uuid ?? null,
    latencyRange,
  )

  if (!node) return null

  const u = deriveUsage(node)
  const d = node.dynamic
  const s = node.static?.system
  const cpu = node.static?.cpu
  const tags = node.meta?.tags ?? []
  const virt = virtLabel(node)
  const logo = distroLogo(node)
  const swap =
    d?.total_swap && d.used_swap != null ? (d.used_swap / d.total_swap) * 100 : undefined
  const loadAvg =
    d?.load_one != null && d?.load_five != null && d?.load_fifteen != null
      ? `${d.load_one.toFixed(2)} / ${d.load_five.toFixed(2)} / ${d.load_fifteen.toFixed(2)}`
      : null
  const history = node.history || []

  return (
    <div
      ref={scrollRef}
      className="fixed inset-0 z-50 bg-background overflow-y-auto animate-in fade-in duration-150"
    >
      <div
        ref={headerRef}
        className={`sticky top-0 z-10 transition-[background-color,backdrop-filter,border-color] duration-200 ${
          stuck
            ? 'border-b border-border/40 backdrop-blur bg-background/70'
            : 'border-b border-transparent'
        }`}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="返回" className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <StatusDot online={node.online} />
          {logo && (
            <img src={logo} alt="" className="w-5 h-5 shrink-0 object-contain" loading="lazy" />
          )}
          <span className="font-semibold truncate min-w-0">{displayName(node)}</span>
          <Flag code={node.meta?.region} className="shrink-0" />
          <span className="hidden md:inline truncate text-xs font-mono text-muted-foreground">
            {node.uuid}
          </span>
          <div className="ml-auto flex flex-wrap gap-1.5 shrink-0">
            {node.meta?.region && <Badge variant="secondary">{node.meta.region}</Badge>}
            {showSource && (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {node.source}
              </Badge>
            )}
            {virt && <Badge variant="secondary">{virt}</Badge>}
            {tags.map(t => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        <Section title="资源">
          <div className="flex flex-wrap justify-around gap-4 sm:gap-6">
            <Ring label="CPU" value={u.cpu} sub={loadAvg ?? undefined} />
            <Ring
              label="内存"
              value={u.mem}
              sub={u.memTotal ? `${bytes(u.memUsed)} / ${bytes(u.memTotal)}` : undefined}
            />
            <Ring
              label="磁盘"
              value={u.disk}
              sub={u.diskTotal ? `${bytes(u.diskUsed)} / ${bytes(u.diskTotal)}` : undefined}
            />
            {swap != null && (
              <Ring
                label="Swap"
                value={swap}
                sub={`${bytes(d?.used_swap)} / ${bytes(d?.total_swap)}`}
              />
            )}
          </div>
        </Section>

        <Section title={history.length > 1 ? `近 ${history.length * 2} 秒趋势` : '近 0 秒趋势'}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Spark
              data={history}
              dataKey="cpu"
              label="CPU %"
              stroke="#3b82f6"
              domain={[0, 100]}
              format={pct}
            />
            <Spark
              data={history}
              dataKey="mem"
              label="内存 %"
              stroke="#10b981"
              domain={[0, 100]}
              format={pct}
            />
            <Spark
              data={history}
              dataKey="netIn"
              label="下行"
              stroke="#8b5cf6"
              format={v => `${bytes(v)}/s`}
            />
            <Spark
              data={history}
              dataKey="netOut"
              label="上行"
              stroke="#f59e0b"
              format={v => `${bytes(v)}/s`}
            />
          </div>
        </Section>

        <LatencyBlock
          title="TCP Ping"
          rows={tcpData}
          type="tcp_ping"
          loading={latencyLoading}
          range={latencyRange}
          onRangeChange={setLatencyRange}
        />
        <LatencyBlock
          title="Ping"
          rows={pingData}
          type="ping"
          loading={latencyLoading}
          range={latencyRange}
          onRangeChange={setLatencyRange}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Section title="系统">
            <KV k="主机名" v={s?.system_host_name} />
            <KV k="操作系统" v={osLabel(node)} />
            <KV k="内核" v={s?.system_kernel || s?.system_kernel_version} />
            <KV k="CPU 架构" v={s?.arch || s?.cpu_arch} />
            <KV k="虚拟化" v={virt} />
            <KV k="CPU 型号" v={cpu?.brand || cpu?.per_core?.[0]?.brand} />
            <KV
              k="核心"
              v={
                cpu?.physical_cores != null
                  ? `${cpu.physical_cores} 物理 / ${cpu.logical_cores} 逻辑`
                  : cpu?.per_core?.length
                    ? `${cpu.per_core.length} 核`
                    : null
              }
            />
          </Section>

          <Section title="网络与负载">
            <KV k="累计接收" v={d?.total_received != null ? bytes(d.total_received) : null} />
            <KV k="累计发送" v={d?.total_transmitted != null ? bytes(d.total_transmitted) : null} />
            <KV k="磁盘读" v={d?.read_speed != null ? `${bytes(d.read_speed)}/s` : null} />
            <KV k="磁盘写" v={d?.write_speed != null ? `${bytes(d.write_speed)}/s` : null} />
            <KV k="进程数" v={d?.process_count} />
            <KV
              k="TCP / UDP"
              v={
                d?.tcp_connections != null || d?.udp_connections != null
                  ? `${d?.tcp_connections ?? '—'} / ${d?.udp_connections ?? '—'}`
                  : null
              }
            />
            <KV k="运行时长" v={uptime(d?.uptime)} />
            <KV k="数据更新" v={relativeAge(d?.timestamp)} />
          </Section>

          {hasCost(node.meta) && <CostSection meta={node.meta} />}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">{title}</div>
      {children}
    </Card>
  )
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  if (v == null || v === '') return null
  return (
    <div className="flex justify-between gap-3 text-sm py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono text-right truncate">{v}</span>
    </div>
  )
}

function Ring({ label, value, sub }: { label: string; value?: number; sub?: string }) {
  const r = 40
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value ?? 0))
  const hasValue = Number.isFinite(value)

  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      <div className="relative w-24 h-24 sm:w-28 sm:h-28">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle
            cx="50" cy="50" r={r}
            fill="none" strokeWidth={8}
            className="stroke-secondary"
          />
          {hasValue && (
            <circle
              cx="50" cy="50" r={r}
              fill="none" strokeWidth={8}
              className={strokeColor(value)}
              strokeDasharray={c}
              strokeDashoffset={c - (c * v) / 100}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 400ms ease' }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-base sm:text-lg font-semibold">
          {pct(value)}
        </div>
      </div>
      <div className="text-sm font-medium">{label}</div>
      {sub && (
        <div className="text-xs font-mono text-muted-foreground truncate max-w-full" title={sub}>
          {sub}
        </div>
      )}
    </div>
  )
}

interface SparkProps {
  data: HistorySample[]
  dataKey: keyof HistorySample
  label: string
  stroke: string
  domain?: [number, number]
  format: (v: number) => string
}

function Spark({ data, dataKey, label, stroke, domain, format }: SparkProps) {
  const last = Number(data.at(-1)?.[dataKey] ?? 0)
  const id = `g-${dataKey}`
  return (
    <div className="rounded-md border bg-card/50 p-3">
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{format(last)}</span>
      </div>
      <div className="h-20">
        {data.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" hide />
              <YAxis hide domain={domain ?? ['auto', 'auto']} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={t => new Date(t).toLocaleTimeString()}
                formatter={(v: number) => [format(v), label]}
              />
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={stroke}
                strokeWidth={1.5}
                fill={`url(#${id})`}
                isAnimationActive={false}
                dot={false}
                activeDot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

interface LatencyBlockProps {
  title: string
  rows: TaskQueryResult[]
  type: LatencyType
  loading: boolean
  range: LatencyRange
  onRangeChange: (r: LatencyRange) => void
}

type SortField = 'avg' | 'p95' | 'p99' | 'jitter' | 'lossRate'
type SortDir = 'asc' | 'desc'

const ms = (v: number) => `${v.toFixed(1)} ms`

function LatencyBlock({ title, rows, type, loading, range, onRangeChange }: LatencyBlockProps) {
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

  const rangeLabel = LATENCY_RANGES.find(r => r.key === range)?.label ?? range

  const handleListMouseMove = (e: React.MouseEvent) => {
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
        {title} · 近 {rangeLabel}
      </div>
      <div className="flex gap-1 items-center">
        <button
          onClick={() => setHidden(new Set())}
          className="p-1 rounded transition-colors bg-muted text-muted-foreground hover:bg-muted/80"
          title="全部显示"
        >
          <Eye className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setHidden(new Set(series.map(s => s.name)))}
          className="p-1 rounded transition-colors bg-muted text-muted-foreground hover:bg-muted/80"
          title="全部隐藏"
        >
          <EyeOff className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setPeakClipping(v => !v)}
          aria-pressed={peakClipping}
          aria-label="切换延迟峰值裁剪显示"
          className={cn(
            'p-1 rounded transition-colors',
            peakClipping
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80',
          )}
          title="峰值裁剪：裁剪极端延迟波动以观察主体趋势"
        >
          <Scissors className="w-3 h-3" />
        </button>
        <div className="w-px h-3 bg-border mx-1.5" aria-hidden="true" />
        {LATENCY_RANGES.map(r => (
          <button
            key={r.key}
            onClick={() => onRangeChange(r.key)}
            className={cn(
              'px-2 py-0.5 text-[11px] rounded transition-colors',
              range === r.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            {r.label}
          </button>
        ))}
        <div className="w-px h-3 bg-border mx-1.5" aria-hidden="true" />
        <button
          onClick={() => setMaximized(v => !v)}
          className="p-1 rounded transition-colors bg-muted text-muted-foreground hover:bg-muted/80"
          title={maximized ? '缩小' : '最大化图表'}
          aria-label={maximized ? '缩小图表' : '最大化图表'}
        >
          {maximized
            ? <Minimize2 className="w-3 h-3" />
            : <Maximize2 className="w-3 h-3" />
          }
        </button>
      </div>
    </div>
  )

  const chartArea = (
    <div className={cn('relative', maximized ? 'h-[33.33vh] shrink-0' : 'h-60')}>
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
    <div className={cn('mt-3 border-t pt-3', maximized && 'flex-1 min-h-0 overflow-y-auto')}>
      <div className="flex items-center px-2 pb-1 text-[11px] text-muted-foreground">
        <span className="flex-1">
          来源
        </span>
        <SortHeader
          label="平均延迟"
          field="avg"
          current={sortField}
          dir={sortDir}
          onClick={handleSort}
          className="w-20"
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
        'flex items-center px-2 py-1 rounded-md text-xs cursor-pointer select-none transition-opacity hover:bg-muted/60',
        hidden && 'opacity-35',
      )}
    >
      <span className="flex items-center gap-2 flex-1 min-w-0">
        <span
          className="inline-block w-4 h-0.5 rounded-full shrink-0"
          style={{ background: color }}
        />
        <span className="truncate">{name}</span>
      </span>
      <span className="w-20 text-right tabular-nums font-mono">
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
        {lossRate.toFixed(1)}%
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

function CostSection({ meta }: { meta: NodeMeta }) {
  const days = remainingDays(meta.expireTime)
  const value = remainingValue(meta)
  const progress = cycleProgress(meta)
  const unit = meta.priceUnit || '$'

  let daysLabel: string
  let daysClass = ''
  if (days == null) daysLabel = '未设置'
  else if (days < 0) {
    daysLabel = `已过期 ${Math.abs(days)} 天`
    daysClass = 'text-red-500'
  } else if (days <= 7) {
    daysLabel = `${days} 天`
    daysClass = 'text-red-500'
  } else if (days <= 30) {
    daysLabel = `${days} 天`
    daysClass = 'text-orange-500'
  } else {
    daysLabel = `${days} 天`
  }

  const barColor =
    days == null || days < 0
      ? 'bg-muted-foreground/40'
      : days <= 7
        ? 'bg-red-500'
        : days <= 30
          ? 'bg-orange-500'
          : 'bg-emerald-500'

  return (
    <Section title="费用">
      <KV k="月费" v={meta.price > 0 ? `${unit}${meta.price} / ${meta.priceCycle} 天` : null} />
      <KV k="到期" v={meta.expireTime || null} />
      <KV k="剩余" v={<span className={daysClass}>{daysLabel}</span>} />
      <KV k="剩余价值" v={meta.price > 0 ? `${unit}${value.toFixed(2)}` : null} />

      {meta.expireTime && days != null && (
        <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', barColor)}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </Section>
  )
}
