import { useEffect, useState } from 'react'
import { crontabGet, type CrontabEntry } from '../api/methods'
import type { BackendPool } from '../api/pool'

export interface CrontabSource {
  name: string
  id: number
  uuidCount: number
  uuids: Set<string>
}

function extractSources(entries: CrontabEntry[]): CrontabSource[] {
  const map = new Map<string, CrontabSource>()
  for (const e of entries) {
    if (!e.enable || !e.cron_type?.agent) continue
    const uuids = e.cron_type.agent[0]
    const task = e.cron_type.agent[1]?.task as Record<string, unknown> | undefined
    if (!task || !Array.isArray(uuids) || uuids.length === 0) continue

    if (typeof task.tcp_ping !== 'string') continue

    const existing = map.get(e.name)
    if (existing) {
      for (const u of uuids) existing.uuids.add(u)
      existing.uuidCount = existing.uuids.size
    } else {
      map.set(e.name, {
        name: e.name,
        id: e.id,
        uuidCount: uuids.length,
        uuids: new Set(uuids),
      })
    }
  }
  return [...map.values()].sort((a, b) => a.id - b.id)
}

export function useLatencySources(pool: BackendPool | null) {
  const [sources, setSources] = useState<CrontabSource[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setSources([])

    if (!pool) return

    let cancelled = false

    const fetchSources = async () => {
      setLoading(true)
      try {
        const result = await pool.fanout(crontabGet)

        if (cancelled) return
        const allEntries = result.ok.flatMap(({ rows }) => rows ?? [])
        setSources(extractSources(allEntries))
      } catch {
        if (!cancelled) setSources([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSources()
    return () => { cancelled = true }
  }, [pool])

  return { sources, loading }
}
