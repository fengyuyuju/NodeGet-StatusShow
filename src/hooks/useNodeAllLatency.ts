import { useEffect, useState } from 'react'
import { taskQuery } from '../api/methods'
import type { BackendPool } from '../api/pool'
import type { TaskQueryResult } from '../types'
import { LATENCY_RANGES, computeQueryLimit, type LatencyRange } from './useNodeLatency'

const REFRESH_MS = 300_000
const QUERY_TIMEOUT_MS = 20_000

interface BackendError {
  source: string
  error: unknown
}

function clean(rows: TaskQueryResult[] | undefined): TaskQueryResult[] {
  return (rows ?? [])
    .filter(r => r.cron_source && r.cron_source !== '未知')
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function useNodeAllLatency(
  pool: BackendPool | null,
  uuid: string | null,
  range: LatencyRange,
  sourceCount = 1,
) {
  const [data, setData] = useState<TaskQueryResult[]>([])
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<BackendError[]>([])

  useEffect(() => {
    setData([])
    setErrors([])
    setLoading(false)

    if (!pool || !uuid) return

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
        const result = await pool.fanout(
          taskQuery,
          [{ uuid }, { timestamp_from_to: window }, { type: 'tcp_ping' }, { limit }],
          QUERY_TIMEOUT_MS,
        )

        if (cancelled) return

        setData(result.ok.flatMap(({ rows }) => clean(rows)).sort((a, b) => a.timestamp - b.timestamp))
        setErrors(result.errors)
      } catch (err) {
        if (!cancelled) {
          setData([])
          setErrors([{ source: 'fanout', error: err instanceof Error ? err.message : String(err) }])
        }
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
  }, [pool, uuid, range, sourceCount])

  return { data, loading, errors }
}
