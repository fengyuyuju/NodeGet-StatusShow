import { useEffect, useState } from 'react'
import { taskQuery } from '../api/methods'
import { TCP_PING_PERIOD_MS } from '../utils/latency'
import type { BackendPool } from '../api/pool'
import type { TaskQueryResult } from '../types'

export type LatencyRange = '1h' | '6h' | '12h' | '1d' | '7d'

export const LATENCY_RANGES: { key: LatencyRange; label: string; ms: number }[] = [
  { key: '1h', label: '1H', ms: 60 * 60 * 1000 },
  { key: '6h', label: '6H', ms: 6 * 60 * 60 * 1000 },
  { key: '12h', label: '12H', ms: 12 * 60 * 60 * 1000 },
  { key: '1d', label: '1D', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
]

const REFRESH_MS = 10_000
const QUERY_TIMEOUT_MS = 20_000
const MIN_QUERY_LIMIT = 5000
const QUERY_LIMIT_HEADROOM = 1.5

export function computeQueryLimit(windowMs: number): number {
  const expectedRows = Math.floor(windowMs / TCP_PING_PERIOD_MS) + 1
  return Math.max(MIN_QUERY_LIMIT, Math.ceil(expectedRows * QUERY_LIMIT_HEADROOM))
}

function clean(rows: TaskQueryResult[] | undefined): TaskQueryResult[] {
  return (rows ?? [])
    .filter(r => r.cron_source && r.cron_source !== '未知')
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function useNodeLatency(
  pool: BackendPool | null,
  source: string | null,
  uuid: string | null,
  range: LatencyRange = '1h',
  sourceCount = 1,
) {
  const [data, setData] = useState<TaskQueryResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setData([])

    if (!pool || !source || !uuid) return
    const entry = pool.entries.find(e => e.name === source)
    if (!entry) return

    const windowMs = LATENCY_RANGES.find(r => r.key === range)?.ms ?? LATENCY_RANGES[0].ms
    const limit = computeQueryLimit(windowMs) * sourceCount

    let cancelled = false
    let inFlight = false

    const fetchOnce = async () => {
      if (inFlight) return
      inFlight = true
      const now = Date.now()
      const window: [number, number] = [now - windowMs, now]
      setLoading(true)

      try {
        const rows = await taskQuery(
          entry.client,
          [{ uuid }, { timestamp_from_to: window }, { type: 'tcp_ping' }, { limit }],
          QUERY_TIMEOUT_MS,
        )

        if (cancelled) return
        setData(clean(rows))
      } catch {
        if (!cancelled) setData([])
      } finally {
        inFlight = false
        if (!cancelled) setLoading(false)
      }
    }

    fetchOnce()
    const timer = setInterval(fetchOnce, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pool, source, uuid, range, sourceCount])

  return { data, loading }
}
