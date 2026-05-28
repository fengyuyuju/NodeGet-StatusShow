import { ArrowDown, ArrowUp } from 'lucide-react'
import { Card } from './ui/card'
import { Progress } from './ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Flag } from './Flag'
import { StatusDot } from './StatusDot'
import { bytes, pct, relativeAge } from '../utils/format'
import { deriveUsage, displayName } from '../utils/derive'
import { cn, loadColor } from '../utils/cn'
import { remainingDays } from '../utils/cost'
import type { Node, Sort, SortDir } from '../types'

interface Props {
  nodes: Node[]
  onOpen?: (uuid: string) => void
  sort: Sort
  sortDir: SortDir
  onSort: (key: Sort) => void
}

const columns: { key: Sort; label: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: '内存' },
  { key: 'disk', label: '磁盘' },
  { key: 'netOut', label: '网速' },
  { key: 'netIn', label: '流量' },
  { key: 'expire', label: '到期' },
]

export function NodeTable({ nodes, onOpen, sort, sortDir, onSort }: Props) {
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            {columns.map(col => (
              <TableHead
                key={col.key}
                className={cn('cursor-pointer select-none', sort === col.key && 'text-foreground')}
                onClick={() => onSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sort === col.key && (
                    sortDir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
                  )}
                </span>
              </TableHead>
            ))}
            <TableHead>更新</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map(n => {
            const u = deriveUsage(n)
            return (
              <TableRow
                key={n.uuid}
                onClick={() => onOpen?.(n.uuid)}
                className={cn('cursor-pointer', !n.online && 'opacity-60')}
              >
                <TableCell>
                  <StatusDot online={n.online} />
                </TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2 min-w-0">
                    <Flag code={n.meta?.region} className="shrink-0" />
                    <span className="truncate">{displayName(n)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <CellBar value={u.cpu} />
                </TableCell>
                <TableCell>
                  <CellBar
                    value={u.mem}
                    hint={u.memTotal ? `${bytes(u.memUsed)} / ${bytes(u.memTotal)}` : null}
                  />
                </TableCell>
                <TableCell>
                  <CellBar
                    value={u.disk}
                    hint={u.diskTotal ? `${bytes(u.diskUsed)} / ${bytes(u.diskTotal)}` : null}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs leading-tight whitespace-nowrap">
                  <div className="flex items-center gap-1"><ArrowUp className="h-3 w-3 text-emerald-500 shrink-0" />{bytes(u.netOut || 0)}/s</div>
                  <div className="flex items-center gap-1"><ArrowDown className="h-3 w-3 text-blue-500 shrink-0" />{bytes(u.netIn || 0)}/s</div>
                </TableCell>
                <TableCell className="font-mono text-xs leading-tight whitespace-nowrap">
                  <div className="flex items-center gap-1"><ArrowUp className="h-3 w-3 text-emerald-500 shrink-0" />{bytes(n.dynamic?.total_transmitted || 0)}</div>
                  <div className="flex items-center gap-1"><ArrowDown className="h-3 w-3 text-blue-500 shrink-0" />{bytes(n.dynamic?.total_received || 0)}</div>
                </TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  <ExpireDays meta={n.meta} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {relativeAge(u.ts)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function CellBar({ value, hint }: { value: number | undefined; hint?: string | null }) {
  return (
    <div className="relative min-w-[110px]" title={hint || ''}>
      <Progress value={value} indicatorClassName={loadColor(value)} className="h-1.5" />
      <span className="absolute inset-0 flex items-center justify-center font-mono text-xs font-medium">{pct(value)}</span>
    </div>
  )
}

function ExpireDays({ meta }: { meta: Node['meta'] }) {
  const days = remainingDays(meta.expireTime)
  if (days == null) return <span className="text-muted-foreground">—</span>
  if (days < 0) return <span className="text-red-500">已过期 {Math.abs(days)} 天</span>
  if (days <= 7) return <span className="text-red-500">{days} 天</span>
  if (days <= 30) return <span className="text-orange-500">{days} 天</span>
  return <span>{days} 天</span>
}
