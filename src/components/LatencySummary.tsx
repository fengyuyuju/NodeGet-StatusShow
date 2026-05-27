import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { LatencyBlock } from './LatencyBlock'
import { Flag } from './Flag'
import { useLatencySources, type CrontabSource } from '../hooks/useLatencySources'
import { useSourceLatency } from '../hooks/useSourceLatency'
import { useNodeAllLatency } from '../hooks/useNodeAllLatency'
import { type LatencyRange } from '../hooks/useNodeLatency'
import { displayName } from '../utils/derive'
import type { BackendPool } from '../api/pool'
import type { Node, TaskQueryResult } from '../types'

interface Props {
  nodes: Map<string, Node>
  pool: BackendPool | null
  onBack: () => void
}

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
  )

  const nodeLatency = useNodeAllLatency(
    pool,
    activeNodeUuid,
    range,
  )

  const loading = active === 'source' ? sourceLatency.loading : nodeLatency.loading
  const errors = active === 'source' ? sourceLatency.errors : nodeLatency.errors

  const sourceRows = useMemo(
    () => remapByTarget(mergePingTcp(sourceLatency.pingData, sourceLatency.tcpData), nodes),
    [sourceLatency.pingData, sourceLatency.tcpData, nodes],
  )

  const nodeMerged = useMemo(
    () => ({ ping: nodeLatency.pingData, tcp_ping: nodeLatency.tcpData }),
    [nodeLatency.pingData, nodeLatency.tcpData],
  )

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

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-3 space-y-4">
        <div className="flex flex-wrap gap-2">
          {nodeList.map(n => (
            <button
              key={n.uuid}
              onClick={() => pickNode(n.uuid)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                active === 'node' && n.uuid === activeNodeUuid
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card hover:bg-accent border-border'
              }`}
            >
              <Flag code={n.meta?.region} className="w-4 h-2.5" />
              <span className="truncate max-w-[150px]">{displayName(n)}</span>
            </button>
          ))}
        </div>

        <hr className="border-border/50" />

        <div className="flex flex-wrap gap-2">
          {sourcesLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> 加载中…
            </div>
          ) : sources.map(s => (
            <button
              key={s.name}
              onClick={() => pickSource(s)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                active === 'source' && s.name === selectedSource?.name
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card hover:bg-accent border-border'
              }`}
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
              rows={sourceRows}
              type="ping"
              loading={loading}
              range={range}
              onRangeChange={setRange}
            />
          ) : (
            <LatencyBlock
              title={currentTitle}
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
