import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react'
import { LatencyBlock } from './LatencyBlock'
import { Flag } from './Flag'
import { useLatencySources, type CrontabSource } from '../hooks/useLatencySources'
import { useSourceLatency } from '../hooks/useSourceLatency'
import { useNodeAllLatency } from '../hooks/useNodeAllLatency'
import { type LatencyRange } from '../hooks/useNodeLatency'
import { displayName } from '../utils/derive'
import { cn } from '../utils/cn'
import type { BackendPool } from '../api/pool'
import type { Node, TaskQueryResult } from '../types'

interface Props {
  nodes: Map<string, Node>
  pool: BackendPool | null
  onBack: () => void
}

const MOBILE_DROPDOWN_GAP = 4

function mergePingTcp(pingRows: TaskQueryResult[], tcpRows: TaskQueryResult[]): TaskQueryResult[] {
  const tcpMapped = tcpRows.map(r => ({
    ...r,
    task_event_result: { ...r.task_event_result, ping: r.task_event_result?.tcp_ping },
  }))
  return [...pingRows, ...tcpMapped].sort((a, b) => a.timestamp - b.timestamp)
}

function remapByTarget(rows: TaskQueryResult[], nodes: Map<string, Node>): TaskQueryResult[] {
  return rows.map(r => {
    const node = nodes.get(r.uuid)
    return { ...r, cron_source: node ? displayName(node) : r.uuid.slice(0, 8) }
  })
}

export function LatencySummary({ nodes, pool, onBack }: Props) {
  const [active, setActive] = useState<'source' | 'node'>('node')
  const [selectedSource, setSelectedSource] = useState<CrontabSource | null>(null)
  const [selectedNodeUuid, setSelectedNodeUuid] = useState<string | null>(null)
  const [range, setRange] = useState<LatencyRange>('1d')
  const headerRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  const [openDropdown, setOpenDropdown] = useState(false)
  const dropdownBtnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!openDropdown || !panelRef.current || !headerRef.current) return
    const updateTop = () => {
      if (!headerRef.current || !panelRef.current) return
      panelRef.current.style.top = `${headerRef.current.getBoundingClientRect().bottom + MOBILE_DROPDOWN_GAP}px`
    }
    updateTop()
    window.addEventListener('resize', updateTop)
    document.addEventListener('scroll', updateTop, true)
    return () => {
      window.removeEventListener('resize', updateTop)
      document.removeEventListener('scroll', updateTop, true)
    }
  }, [openDropdown])

  useEffect(() => {
    if (!openDropdown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDropdown(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openDropdown])

  useEffect(() => {
    const onScroll = () => {
      const h = headerRef.current?.offsetHeight ?? 60
      setStuck(window.scrollY > h)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const { sources, loading: sourcesLoading } = useLatencySources(pool)

  const nodeList = useMemo(
    () =>
      [...nodes.values()]
        .filter(n => !n.meta?.hidden)
        .sort((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0) || displayName(a).localeCompare(displayName(b))),
    [nodes],
  )

  const activeNodeUuid = active === 'node'
    ? (selectedNodeUuid && nodeList.some(n => n.uuid === selectedNodeUuid) ? selectedNodeUuid : nodeList[0]?.uuid ?? null)
    : null

  const sourceLatency = useSourceLatency(
    pool,
    active === 'source' ? selectedSource?.name ?? null : null,
    range,
    selectedSource?.uuidCount ?? 1,
  )

  const nodeSourceCount = activeNodeUuid
    ? sources.filter(s => s.uuids.has(activeNodeUuid)).length || 1
    : 1

  const nodeLatency = useNodeAllLatency(
    pool,
    activeNodeUuid,
    range,
    nodeSourceCount,
  )

  const loading = active === 'source' ? sourceLatency.loading : nodeLatency.loading
  const errors = active === 'source' ? sourceLatency.errors : nodeLatency.errors

  const sourceRows = useMemo(
    () => {
      const rows = mergePingTcp(sourceLatency.pingData, sourceLatency.tcpData)
      if (sources.length === 0) return remapByTarget(rows, nodes)
      const activeUuids = selectedSource?.uuids
      if (!activeUuids) return remapByTarget(rows, nodes)
      return remapByTarget(rows.filter(r => activeUuids.has(r.uuid)), nodes)
    },
    [sourceLatency.pingData, sourceLatency.tcpData, selectedSource, nodes, sources.length],
  )

  const nodeMerged = useMemo(() => {
    if (sources.length === 0 || !activeNodeUuid)
      return { ping: nodeLatency.pingData, tcp_ping: nodeLatency.tcpData }
    const activeSourceNames = new Set<string>()
    for (const s of sources) if (s.uuids.has(activeNodeUuid)) activeSourceNames.add(s.name)
    if (!activeSourceNames.size) return { ping: [] as TaskQueryResult[], tcp_ping: [] as TaskQueryResult[] }
    return {
      ping: nodeLatency.pingData.filter(r => activeSourceNames.has(r.cron_source ?? '')),
      tcp_ping: nodeLatency.tcpData.filter(r => activeSourceNames.has(r.cron_source ?? '')),
    }
  }, [nodeLatency.pingData, nodeLatency.tcpData, activeNodeUuid, sources])

  const selectedNode = activeNodeUuid ? nodes.get(activeNodeUuid) ?? null : null
  const currentTitle = active === 'source'
    ? (selectedSource?.name ?? '')
    : (selectedNode ? displayName(selectedNode) : '')

  const pickSource = (s: CrontabSource) => {
    setActive('source')
    setSelectedSource(s)
  }

  const pickNode = (uuid: string) => {
    setActive('node')
    setSelectedNodeUuid(uuid)
  }

  const currentIndex = active === 'node'
    ? nodeList.findIndex(n => n.uuid === activeNodeUuid)
    : sources.findIndex(s => s.name === selectedSource?.name)

  const maxIndex = (active === 'node' ? nodeList.length : sources.length) - 1

  const isFirstNode = active === 'node' && currentIndex <= 0
  const isLastSource = active === 'source' && currentIndex >= maxIndex

  const goToPrev = () => {
    if (active === 'source') {
      if (currentIndex > 0) {
        pickSource(sources[currentIndex - 1])
      } else if (nodeList.length > 0) {
        pickNode(nodeList[nodeList.length - 1].uuid)
      }
    } else if (currentIndex > 0) {
      pickNode(nodeList[currentIndex - 1].uuid)
    }
  }

  const goToNext = () => {
    if (active === 'node') {
      if (currentIndex < maxIndex) {
        pickNode(nodeList[currentIndex + 1].uuid)
      } else if (sources.length > 0) {
        pickSource(sources[0])
      }
    } else if (currentIndex < maxIndex) {
      pickSource(sources[currentIndex + 1])
    }
  }

  const mobileDropdown = (
    <div className="inline-flex items-center gap-1">
      <button
        ref={dropdownBtnRef}
        onClick={() => setOpenDropdown(!openDropdown)}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-border bg-card hover:bg-accent transition-colors w-[120px]"
      >
        {active === 'node' && selectedNode?.meta?.region && (
          <Flag code={selectedNode.meta.region} className="w-3.5 h-2 shrink-0" />
        )}
        <span className="truncate">
          {active === 'node'
            ? (selectedNode ? displayName(selectedNode) : '选择')
            : (selectedSource?.name || '选择')
          }
        </span>
        <ChevronDown className={cn('h-3 w-3 transition-transform ml-auto shrink-0', openDropdown && 'rotate-180')} />
      </button>
      <button
        onClick={goToPrev}
        disabled={isFirstNode}
        className="inline-flex items-center justify-center h-[26px] w-[26px] rounded border border-border bg-card hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="上一个"
      >
        <svg width="8" height="6" viewBox="0 0 8 6"><path d="M4 0l4 6H0z" fill="currentColor" /></svg>
      </button>
      <button
        onClick={goToNext}
        disabled={isLastSource}
        className="inline-flex items-center justify-center h-[26px] w-[26px] rounded border border-border bg-card hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="下一个"
      >
        <svg width="8" height="6" viewBox="0 0 8 6"><path d="M4 6l4-6H0z" fill="currentColor" /></svg>
      </button>
      {openDropdown && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setOpenDropdown(false)} />
          <div ref={panelRef} className="fixed left-1 right-1 z-[80] bg-popover border border-border rounded-md shadow-lg p-2 max-h-[70vh] overflow-y-auto space-y-2" style={{ top: 0 }}>
            <div>
              <div className="text-[10px] text-muted-foreground px-1 mb-1">节点</div>
              <div className="grid grid-cols-4 gap-0.5">
                {nodeList.map(n => (
                  <button
                    key={n.uuid}
                    onClick={() => { pickNode(n.uuid); setOpenDropdown(false) }}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full border transition-colors text-left',
                      active === 'node' && n.uuid === activeNodeUuid
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-foreground/80 border-border hover:bg-accent',
                    )}
                  >
                    <Flag code={n.meta?.region} className="w-3.5 h-2 shrink-0" />
                    <span className="truncate">{displayName(n)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground px-1 mb-1">任务</div>
              {sourcesLoading ? (
                <div className="flex items-center justify-center text-[11px] text-muted-foreground py-2">
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> 加载中…
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-0.5">
                  {sources.map(s => (
                    <button
                      key={s.name}
                      onClick={() => { pickSource(s); setOpenDropdown(false) }}
                      className={cn(
                        'inline-flex items-center px-2 py-1 text-[11px] rounded-full border transition-colors text-left',
                        active === 'source' && s.name === selectedSource?.name
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card text-foreground/80 border-border hover:bg-accent',
                    )}
                    >
                      <span className="truncate">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  )

  return (
    <div className="flex-1">
      <div
        ref={headerRef}
        className={`sticky top-0 z-10 transition-[background-color,backdrop-filter,border-color] duration-200 ${
          stuck
            ? 'border-b border-border/40 backdrop-blur bg-background/70'
            : 'border-b border-transparent'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors"
            aria-label="返回"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="font-semibold">网络状况</h1>
        </div>
      </div>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 pt-1 pb-3 md:py-3 space-y-0 md:space-y-4">
        {/* Desktop: nodes */}
        <div className="hidden md:flex flex-wrap gap-2">
          {nodeList.map(n => (
            <button
              key={n.uuid}
              onClick={() => pickNode(n.uuid)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-colors',
                active === 'node' && n.uuid === activeNodeUuid
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-foreground/80 border-border hover:bg-accent',
              )}
            >
              <Flag code={n.meta?.region} className="w-4 h-2.5" />
              <span className="truncate max-w-[150px]">{displayName(n)}</span>
            </button>
          ))}
        </div>

        <hr className="hidden md:block border-border/50" />

        {/* Desktop: sources */}
        <div className="hidden md:flex flex-wrap gap-2">
          {sourcesLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> 加载中…
            </div>
          ) : sources.map(s => (
            <button
              key={s.name}
              onClick={() => pickSource(s)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-colors',
                active === 'source' && s.name === selectedSource?.name
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-foreground/80 border-border hover:bg-accent',
              )}
            >
              <span className="truncate max-w-[200px]">{s.name}</span>
            </button>
          ))}
        </div>

        <div className="space-y-6">
          {errors.length > 0 && (
            <div className="rounded-md border border-orange-500/30 bg-orange-500/5 px-4 py-3 text-sm text-orange-600 dark:text-orange-400">
              <span className="font-medium">部分后端查询失败：</span>
              <ul className="list-disc pl-5 mt-1 space-y-0.5">
                {errors.map((e, i) => (
                  <li key={i}>
                    <b>{e.source}</b>：{e.error instanceof Error ? e.error.message : String(e.error)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {active === 'source' ? (
            <LatencyBlock
              title={currentTitle}
              titleSlot={mobileDropdown}
              sourceLabel="来源"
              rows={sourceRows}
              type="ping"
              loading={loading}
              range={range}
              onRangeChange={setRange}
            />
          ) : (
            <LatencyBlock
              title={currentTitle}
              titleSlot={mobileDropdown}
              sourceLabel="任务"
              merged={nodeMerged}
              loading={loading}
              range={range}
              onRangeChange={setRange}
            />
          )}
        </div>
      </main>
    </div>
  )
}
