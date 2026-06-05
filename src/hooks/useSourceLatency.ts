import { useEffect, useState } from 'react'
import { taskQuery } from '../api/methods'
import type { BackendPool } from '../api/pool'
import type { TaskQueryResult } from '../types'
import { LATENCY_RANGES, computeQueryLimit, type LatencyRange } from './useNodeLatency'

const REFRESH_MS = 10_000
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

export function useSourceLatency(
  pool: BackendPool | null,
  cronSource: string | null,
  range: LatencyRange,
) {
  const [pingData, setPingData] = useState<TaskQueryResult[]>([])
  const [tcpData, setTcpData] = useState<TaskQueryResult[]>([])
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<BackendError[]>([])

  useEffect(() => {
    setPingData([])
    setTcpData([])
    setErrors([])
    setLoading(false)

    if (!pool || !cronSource) return

    const windowMs = LATENCY_RANGES.find(r => r.key === range)?.ms ?? LATENCY_RANGES[0].ms
    const pingLimit = computeQueryLimit(windowMs, 'ping')
    const tcpLimit = computeQueryLimit(windowMs, 'tcp_ping')

    let cancelled = false
    let inFlight = false

    const fetchOnce = async () => {
      if (inFlight) return
      inFlight = true
      const now = Date.now()
      const window: [number, number] = [now - windowMs, now]
      setLoading(true)

      try {
        const [ping, tcp] = await Promise.all([
          pool.fanout(
            taskQuery,
            [{ cron_source: cronSource }, { timestamp_from_to: window }, { type: 'ping' }, { limit: pingLimit }],
            QUERY_TIMEOUT_MS,
          ),
          pool.fanout(
            taskQuery,
            [{ cron_source: cronSource }, { timestamp_from_to: window }, { type: 'tcp_ping' }, { limit: tcpLimit }],
            QUERY_TIMEOUT_MS,
          ),
        ])

        if (cancelled) return

        setPingData(
          ping.ok.flatMap(({ rows }) => clean(rows)).sort((a, b) => a.timestamp - b.timestamp),
        )
        setTcpData(
          tcp.ok.flatMap(({ rows }) => clean(rows)).sort((a, b) => a.timestamp - b.timestamp),
        )
        setErrors([...ping.errors, ...tcp.errors])
      } catch (err) {
        if (!cancelled) {
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
  }, [pool, cronSource, range])

  return { pingData, tcpData, loading, errors }
}
