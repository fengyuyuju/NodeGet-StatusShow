import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Eye, EyeOff, Maximize2, Minimize2, Scissors } from 'lucide-react'
import {
  Customized,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from './ui/card'
import { cn } from '../utils/cn'
import {
  buildLatencyChart,
  computePeakClipCap,
  computeLatencyStats,
  TCP_PING_PERIOD_MS,
  TIMEOUT_COLOR,
  type ChartSeries,
  type ChartSeriesPoint,
  type LatencyStats,
} from '../utils/latency'
import { LATENCY_RANGES, type LatencyRange } from '../hooks/useNodeLatency'
import type { TaskQueryResult } from '../types'

export interface LatencyBlockProps {
  title: string
  rows: TaskQueryResult[]
  loading: boolean
  range: LatencyRange
  onRangeChange: (r: LatencyRange) => void
  chartClass?: string
  statsClass?: string
  cardClassName?: string
  titleSlot?: ReactNode
  sourceLabel?: string
}

type SortField = 'p50' | 'p95' | 'p99' | 'jitter' | 'lossRate'
type SortDir = 'asc' | 'desc'

// 截断小数到整数，不四舍五入（保留个位数即可）
const ms = (v: number) => String(Math.floor(v))

function tickFormat(ticks: number[]): (v: number) => string {
  for (let i = 1; i < ticks.length; i++) {
    if (Math.round(ticks[i]) === Math.round(ticks[i - 1])) {
      return (v: number) => v.toFixed(1)
    }
  }
  return (v: number) => `${Math.round(v)}`
}

const QUALITY_SEGMENTS = [
  { max: 50, color: '#26a91e' },
  { max: 100, color: '#43dd3e' },
  { max: 200, color: '#bef663' },
  { max: 250, color: '#f6ed44' },
  { max: Infinity, color: '#f69833' },
] as const
const CANVAS_H = 16
const HEIGHT_CAP = 400

// 自适应点数预算：按屏幕实际像素决定点数，让图表展现最多可分辨细节
const POINTS_PER_PIXEL = 1 / 2.5     // 每 2.5px 一个点：更密即亚像素噪声
const BUDGET_STEP = 50               // 量化步长，抑制 resize 高频重建
const FALLBACK_BUDGET = 400          // 初始 0 宽回退（首次 paint 前的默认）

function computeLatencyPointBudget(widthPx: number, _sourceCount: number): number {
  if (widthPx <= 0) return FALLBACK_BUDGET
  // 仅按视觉密度（像素）约束，不再按源数压低——多源时由 LTTB 各自保形
  return Math.max(2, Math.floor(Math.floor(widthPx * POINTS_PER_PIXEL) / BUDGET_STEP) * BUDGET_STEP)
}

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

export function LatencyBlock({ title, rows, loading, range, onRangeChange, chartClass, statsClass, cardClassName, titleSlot, sourceLabel = '来源' }: LatencyBlockProps) {
  const [maximized, setMaximized] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  // 直接存预算而非宽度：resize 时只在量化预算变化时才触发重渲染，避免逐像素抖动
  const [chartPointBudget, setChartPointBudget] = useState(FALLBACK_BUDGET)

  const sourceCount = useMemo(() => new Set(rows.map(r => r.cron_source || '未知')).size, [rows])

  // 最大化切换时 chartArea 移入/移出 portal，DOM 节点重挂载，需重绑 observer
  useLayoutEffect(() => {
    const host = chartRef.current
    if (!host) return
    const apply = (w: number) => {
      const width = Math.floor(w)
      // 过滤 0 宽：portal 切换瞬间会闪现 0，保留下沉到 computeLatencyPointBudget 的 FALLBACK
      if (width <= 0) return
      const next = computeLatencyPointBudget(width, sourceCount)
      setChartPointBudget(prev => prev === next ? prev : next)
    }
    apply(host.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => apply(entries[0]?.contentRect.width ?? 0))
    ro.observe(host)
    return () => ro.disconnect()
  }, [maximized, sourceCount])

  const { series } = useMemo(() => buildLatencyChart(rows, chartPointBudget), [rows, chartPointBudget])
  const baseStats = useMemo(() => computeLatencyStats(rows), [rows])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [peakClipping, setPeakClipping] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('p50')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const empty = series.every(s => s.points.length === 0)
  const emptyLabel = '延迟'

  // plotBox 由 <Customized> 探针从 Recharts 内部读取绘图区几何，供鼠标像素↔t 反算
  const [plotBox, setPlotBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  // 用 ref 持有几何相等判断的 setter，保证 probe 组件拿到的回调 identity 永远稳定，
  // 避免 inline 函数每次渲染变新 identity 导致 Customized remount → setState → 无限循环
  const plotBoxRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const handleOffset = useCallback((o: { left: number; top: number; width: number; height: number }) => {
    const prev = plotBoxRef.current
    if (prev && prev.left === o.left && prev.top === o.top && prev.width === o.width && prev.height === o.height) return
    plotBoxRef.current = o
    setPlotBox(o)
  }, [])

  // tooltip overlay 走 ref 直接操作 DOM：hoverX 不进 React state，避免触发 Recharts 重渲染。
  // updateOverlayRef 每次渲染重新赋值（捕获最新 displaySeries/hidden/hovered/plotBox），rAF 读它总是最新闭包
  const overlayRootRef = useRef<HTMLDivElement>(null)
  const cursorGroupRef = useRef<SVGGElement>(null)
  const circlesRef = useRef<SVGGElement>(null)
  const tooltipBoxRef = useRef<HTMLDivElement>(null)
  const timeLabelRef = useRef<HTMLDivElement>(null)
  const valuesRef = useRef<HTMLDivElement>(null)
  const lastClientXRef = useRef<number | null>(null)
  const lastTRef = useRef<number | null>(null)
  const updateOverlayRef = useRef<(() => void) | null>(null)

  const xDomain = useMemo((): [number, number] => {
    const ms = LATENCY_RANGES.find(r => r.key === range)?.ms ?? LATENCY_RANGES[0].ms
    const now = Date.now()
    return [now - ms, now]
  }, [range, rows])

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

  // chartData 仅作 X 轴骨架（透明 _ref 线占位），恒为 2 点。
  // tooltip 定位改由外层鼠标像素反算 t 完成，与 Recharts activeIndex 解耦，不再随数据量膨胀
  const chartData = useMemo(() => [
    { t: xDomain[0], _ref: 0 },
    { t: xDomain[1], _ref: 0 },
  ], [xDomain])

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
        gapLine: clip(s.gapLine),
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
      if (av === bv) return 0
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

  const { yDomain, yTicks } = useMemo(() => {
    const visibleDisplay = displaySeries.filter(s =>
      hovered ? s.name === hovered : !hidden.has(s.name),
    )
    if (visibleDisplay.length === 0) {
      return { yDomain: [0, 100] as [number, number], yTicks: [0, 25, 50, 75, 100] }
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
      return { yDomain: [0, 100] as [number, number], yTicks: [0, 25, 50, 75, 100] }
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
    return { yDomain, yTicks }
  }, [displaySeries, hidden, hovered])

  // overlay 更新闭包：每次渲染重新赋值，捕获最新的 displaySeries/hidden/hovered/plotBox/domains。
  // rAF 与可见性同步 effect 都通过 updateOverlayRef.current 调用，永远拿到最新闭包，无 stale 风险
  updateOverlayRef.current = () => {
    const clientX = lastClientXRef.current
    const pb = plotBox
    const root = overlayRootRef.current
    const cursorG = cursorGroupRef.current
    const tipBox = tooltipBoxRef.current
    if (clientX == null || !pb || !chartRef.current || !root || !cursorG || !tipBox || !timeLabelRef.current || !valuesRef.current || !circlesRef.current) return

    const rect = chartRef.current.getBoundingClientRect()
    const hoverX = clientX - rect.left
    const clampedX = Math.max(pb.left, Math.min(hoverX, pb.left + pb.width))
    const rawT = pb.width > 0 ? xDomain[0] + ((clampedX - pb.left) / pb.width) * (xDomain[1] - xDomain[0]) : xDomain[0]
    const t = Math.floor(rawT / TCP_PING_PERIOD_MS) * TCP_PING_PERIOD_MS
    // cursor 锁定到 snap 后数据点的像素，避免在两点间水平飘移脱离折线顶点
    const x = pb.width > 0 ? pb.left + ((t - xDomain[0]) / (xDomain[1] - xDomain[0])) * pb.width : pb.left
    const flip = x > pb.left + pb.width / 2

    root.style.display = 'block'
    cursorG.style.display = 'block'
    cursorG.style.transform = `translateX(${x}px)`
    tipBox.style.left = `${x + (flip ? -16 : 16)}px`
    tipBox.style.transform = flip ? 'translateX(-100%)' : 'none'

    // 仅在数据点切换时重算内容（lookupSeriesValue 较重）；同点内移动只改位置
    if (lastTRef.current === t) return
    lastTRef.current = t

    const yMin = yDomain[0]
    const yRange = (yDomain[1] - yMin) || 1
    const toY = (v: number) => pb.top + pb.height * (1 - (v - yMin) / yRange)

    // hovered 时只展示该源；否则展示所有源（含被隐藏的），无值显 -，超时显红色"超时"
    const visibleSeries = hovered ? displaySeries.filter(s => s.name === hovered) : displaySeries
    const rows: { name: string; color: string; value: number | null; isTimeout: boolean; noData: boolean; cy: number | null }[] = []
    for (const s of visibleSeries) {
      const normalVal = lookupSeriesValue(s.normalLine, t)
      if (normalVal != null) {
        const cy = toY(normalVal)
        rows.push({ name: s.name, color: s.color, value: normalVal, isTimeout: false, noData: false, cy: Number.isFinite(cy) ? cy : null })
        continue
      }
      const timeoutVal = lookupSeriesValue(s.timeoutLine, t)
      if (timeoutVal != null) {
        rows.push({ name: s.name, color: s.color, value: null, isTimeout: true, noData: false, cy: null })
      } else {
        rows.push({ name: s.name, color: s.color, value: null, isTimeout: false, noData: true, cy: null })
      }
    }

    const circlesEl = circlesRef.current
    const valuesEl = valuesRef.current
    circlesEl.textContent = ''
    valuesEl.textContent = ''
    tipBox.style.display = 'none'

    // 空数据区（所有源都无值）：隐藏竖线，避免无意义的孤立 cursor
    cursorG.style.display = rows.length === 0 ? 'none' : 'block'
    if (rows.length === 0) return

    tipBox.style.display = 'block'
    timeLabelRef.current.textContent = range === '7d'
      ? `${new Date(t).getMonth() + 1}-${String(new Date(t).getDate()).padStart(2, '0')} ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}`
      : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

    // 有值升序 → 超时 → 无数据
    const sorted = [...rows].sort((a, b) => {
      const ra = a.noData ? 2 : a.isTimeout ? 1 : 0
      const rb = b.noData ? 2 : b.isTimeout ? 1 : 0
      if (ra !== rb) return ra - rb
      if (ra === 0) return (a.value ?? 0) - (b.value ?? 0)
      return 0
    })
    for (const r of sorted) {
      if (r.cy != null) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        c.setAttribute('cx', '0')
        c.setAttribute('cy', String(r.cy))
        c.setAttribute('r', '5')
        c.setAttribute('fill', r.color)
        c.setAttribute('stroke', '#fff')
        c.setAttribute('stroke-width', '1')
        circlesEl.appendChild(c)
      }
      const nameSpan = document.createElement('span')
      nameSpan.className = 'truncate font-semibold'
      nameSpan.style.color = r.color
      nameSpan.textContent = r.name
      const valSpan = document.createElement('span')
      valSpan.className = cn('font-mono tabular-nums text-right', r.noData && 'text-muted-foreground', r.isTimeout && 'text-red-500')
      valSpan.textContent = r.value != null ? ms(r.value) : r.isTimeout ? '超时' : '-'
      valuesEl.appendChild(nameSpan)
      valuesEl.appendChild(valSpan)
    }
  }

  // 可见性/数据变化时若 overlay 正显示，立即重建（鼠标静止时切换 series 也能刷新）。
  // 清空 lastTRef 强制绕过 updateOverlay 内的同点跳过逻辑，确保几何/可见性变更后内容必刷新
  useEffect(() => {
    if (lastClientXRef.current == null) return
    lastTRef.current = null
    updateOverlayRef.current?.()
  }, [displaySeries, hidden, hovered, yDomain, xDomain, range, plotBox])

  const rafRef = useRef<number | null>(null)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    lastClientXRef.current = e.clientX
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      updateOverlayRef.current?.()
    })
  }, [])

  const handleMouseLeave = useCallback(() => {
    lastClientXRef.current = null
    lastTRef.current = null
    if (overlayRootRef.current) overlayRootRef.current.style.display = 'none'
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }, [])

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])

  // 刻度固定按 3 位数字宽度（取最宽的 "888"）预留，宽度不随数据抖动：
  // LineChart 左外边距 = 8（= 列表名字列 pl-2）、YAxis width = 3 位文本宽 + 8，
  // 3 位刻度左缘即落在 8px，恰好与列表名字左缘对齐（tickSize/tickMargin 常量被消去）。
  const [yAxisWidth, setYAxisWidth] = useState(44)

  useLayoutEffect(() => {
    const host = chartRef.current
    if (!host) return
    const SVGNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(SVGNS, 'svg')
    const probe = document.createElementNS(SVGNS, 'text')
    probe.setAttribute('font-size', '11')
    probe.textContent = '888'
    svg.appendChild(probe)
    svg.setAttribute('aria-hidden', 'true')
    svg.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;pointer-events:none'
    host.appendChild(svg)
    const next = Math.ceil(probe.getBBox().width) + 8
    svg.remove()
    setYAxisWidth(prev => (prev === next ? prev : next))
  }, [])

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
        <div className="hidden md:block w-px h-4 bg-border mx-1" aria-hidden="true" />
        <div className="hidden md:block bg-muted p-1 rounded-md">
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
    <div
      ref={chartRef}
      className={cn('relative', maximized ? 'h-[33.33vh] shrink-0' : chartClass || 'h-60')}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {empty ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {loading ? '加载中…' : `暂无 ${emptyLabel} 数据`}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
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
              tickFormatter={tickFormat(yTicks)}
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
              width={yAxisWidth}
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
                  key={`${s.name}-gap`}
                  data={s.gapLine}
                  type="linear"
                  dataKey="value"
                  name={`${s.name}__gap`}
                  stroke={s.color}
                  strokeWidth={1}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />,
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
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />,
              ]
            })}
            <Customized component={OffsetProbe} onOffset={handleOffset} />
          </LineChart>
        </ResponsiveContainer>
      )}
      {plotBox && (
        <div ref={overlayRootRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 50, display: 'none' }}>
          <svg className="absolute inset-0 w-full h-full">
            <g ref={cursorGroupRef}>
              <line x1={0} y1={plotBox.top} x2={0} y2={plotBox.top + plotBox.height} stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <g ref={circlesRef} />
            </g>
          </svg>
          <div
            ref={tooltipBoxRef}
            className="absolute"
            style={{
              top: plotBox.top,
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 11,
              padding: '8px 10px',
            }}
          >
            <div ref={timeLabelRef} className="text-muted-foreground mb-1" />
            <div ref={valuesRef} className="grid items-center gap-x-3 gap-y-0" style={{ gridTemplateColumns: 'auto minmax(4ch, max-content)' }} />
          </div>
        </div>
      )}
      {loading && (
        <div className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </div>
  )

  const isFlat = !!cardClassName && cardClassName.includes('latency-flat')
  const tableBg = maximized ? 'bg-background' : (isFlat ? 'md:bg-card' : 'bg-card')
  const stickyBg = maximized ? 'bg-background' : 'bg-card'

  const statsTable = (
    <div className={cn('mt-3 border-t pt-3 pb-1.5 overflow-x-auto', maximized ? 'flex-1 min-h-0 overflow-y-auto' : statsClass)}>
      <div className={cn('flex items-center gap-1 pl-0 pr-2 pb-1 text-[11px] text-muted-foreground whitespace-nowrap min-w-[530px]', tableBg)}>
        <span className={cn('sticky left-0 shrink-0 pl-2 pr-3 -mr-1 z-10', stickyBg)} style={{ width: nameColWidth }}>
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
            <span key={s.name} className="flex items-center pl-2 pr-3 -mr-1 whitespace-nowrap font-semibold">{s.name}</span>
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
              stickyBg={stickyBg}
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
    <Card className={cn('p-3 sm:p-5', cardClassName)}>
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
          ctx.fillStyle = TIMEOUT_COLOR
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
  stickyBg,
  nameColWidth,
}: {
  stat: LatencyStats
  points: ChartSeriesPoint[]
  hidden: boolean
  onToggle: () => void
  tableBg: string
  stickyBg: string
  nameColWidth: number
}) {
  const { name, color, p50, p95, p99, jitter, lossRate } = stat
  const bars = useMemo(() => points.map(p => p.value), [points])
  const dimCls = cn('transition-opacity', hidden && 'opacity-35')

  return (
    <div
      onClick={onToggle}
      data-source={name}
      className={cn(
        'flex items-center gap-1 pl-0 pr-2 py-1 text-xs cursor-pointer select-none group md:hover:bg-muted min-w-[530px]',
        tableBg,
      )}
    >
      <span className={cn('sticky left-0 shrink-0 flex items-center pl-2 pr-3 -mr-1 z-10', stickyBg, 'md:group-hover:bg-muted')} style={{ width: nameColWidth }}>
        <span className={cn('truncate font-semibold', dimCls)} style={{ color }}>{name}</span>
      </span>
      <span className={cn('flex-1 max-w-[450px] min-w-[120px] ml-auto', dimCls)}>
        <QualityCanvas bars={bars} />
      </span>
      <span className={cn('w-[52px] text-right tabular-nums font-mono', dimCls)}>
        {p50 != null ? ms(p50) : '—'}
      </span>
      <span className={cn('w-[52px] text-right tabular-nums font-mono', dimCls)}>
        {p95 != null ? ms(p95) : '—'}
      </span>
      <span className={cn('w-[52px] text-right tabular-nums font-mono', dimCls)}>
        {p99 != null ? ms(p99) : '—'}
      </span>
      <span className={cn('w-10 text-right tabular-nums font-mono', dimCls)}>
        {jitter != null ? jitter.toFixed(1) : '—'}
      </span>
      <span
        className={cn(
          'w-10 text-right tabular-nums font-mono',
          lossRate >= 5 && 'text-red-500 font-medium',
          dimCls,
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
 * The line is sorted by `t`; null points split disconnected segments.
 */
function lookupSeriesValue(line: ChartSeriesPoint[], targetT: number): number | null {
  const n = line.length
  if (n === 0) return null

  // Binary search for insertion point
  let lo = 0
  let hi = n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const mt = line[mid].t
    if (mt < targetT) lo = mid + 1
    else if (mt > targetT) hi = mid - 1
    else {
      const v = line[mid].value
      if (v != null && Number.isFinite(v)) return v
      // 同一时间戳可能并存 null 断点与 finite 值（timeoutLine 段间断点），优先取 finite
      for (let i = mid - 1; i >= 0 && line[i].t === targetT; i--) {
        const lv = line[i].value
        if (lv != null && Number.isFinite(lv)) return lv
      }
      for (let i = mid + 1; i < n && line[i].t === targetT; i++) {
        const rv = line[i].value
        if (rv != null && Number.isFinite(rv)) return rv
      }
      return null
    }
  }
  // After binary search: hi = last index with t < targetT, lo = first index with t > targetT

  // Walk backward to nearest valid point
  let loIdx = hi
  while (loIdx >= 0 && (line[loIdx].value == null || !Number.isFinite(line[loIdx].value!))) loIdx--
  if (loIdx < 0) return null

  // Walk forward to nearest valid point
  let hiIdx = lo
  while (hiIdx < n && (line[hiIdx].value == null || !Number.isFinite(line[hiIdx].value!))) hiIdx++
  if (hiIdx >= n) return null

  // Null points split disconnected segments and should not be interpolated across.
  for (let i = loIdx + 1; i < hiIdx; i++) {
    if (line[i].value == null) return null
  }

  // 跟随实际数据：snap 到最近的真实点，不做线性插值（插值会显示不存在的假值）
  const loPt = line[loIdx]
  const hiPt = line[hiIdx]
  const distLo = targetT - loPt.t
  const distHi = hiPt.t - targetT
  return distLo <= distHi ? loPt.value : hiPt.value
}

// Customized 探针：模块级稳定 identity，读取 Recharts 内部绘图区几何。
// 必须稳定，否则每次父渲染换 identity → Customized remount → setState → 无限循环
interface OffsetProbeProps {
  offset?: { left: number; top: number; width: number; height: number }
  onOffset?: (o: { left: number; top: number; width: number; height: number }) => void
}
const OffsetProbe = ({ offset, onOffset }: OffsetProbeProps) => {
  useLayoutEffect(() => {
    if (offset && onOffset) onOffset(offset)
  }, [offset?.left, offset?.top, offset?.width, offset?.height, onOffset])
  return null
}

