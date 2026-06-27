import { ArrowDown, ArrowUp, Clock, type LucideIcon } from 'lucide-react'
import { Badge } from './ui/badge'
import { Card } from './ui/card'
import { Progress } from './ui/progress'
import { Flag } from './Flag'
import { StatusDot } from './StatusDot'
import { bytes, pct, relativeAge, uptime } from '../utils/format'
import { cpuLabel, deriveUsage, displayName, osLabel, trafficBar, trafficUsed, virtLabel } from '../utils/derive'
import { cn, loadColor } from '../utils/cn'
import type { Node } from '../types'
import type { ReactNode } from 'react'

export function NodeCard({ node }: { node: Node }) {
  const u = deriveUsage(node)
  const traffic = trafficUsed(node)
  const bar = trafficBar(node)
  const tags = Array.isArray(node.meta?.tags) ? node.meta.tags : []
  const os = osLabel(node)
  const virt = virtLabel(node)
  const cpu = cpuLabel(node)

  return (
      <a href={`#${encodeURIComponent(node.uuid)}`} className="block">
        <Card
            className={cn(
                'p-4 transition hover:border-primary/50 hover:shadow-md flex flex-col gap-3',
                !node.online && 'opacity-60',
            )}
        >
          <div className="flex items-center gap-2">
            <StatusDot online={node.online} />
            <Flag code={node.meta?.region} className="shrink-0" />
            <span className="font-semibold flex-1 min-w-0 truncate" title={displayName(node)}>
            {displayName(node)}
          </span>
          </div>

          {(os || virt) && (
              <div className="font-mono text-xs text-muted-foreground truncate">
                {[os, virt].filter(Boolean).join(' · ')}
              </div>
          )}

          <div className="flex flex-col gap-2.5">
            <Metric label="CPU" value={u.cpu} sub={cpu || null} subTitle={cpu || undefined} />
            <Metric
                label="内存"
                value={u.mem}
                sub={u.memTotal ? `${bytes(u.memUsed)} / ${bytes(u.memTotal)}` : null}
            />
            <Metric
                label="磁盘"
                value={u.disk}
                sub={u.diskTotal ? `${bytes(u.diskUsed)} / ${bytes(u.diskTotal)}` : null}
            />
            <div>
              <Metric
                  label="流量"
                  value={bar?.percent}
                  valueText={bar?.text}
              />
              <div className="font-mono text-[11px] text-muted-foreground flex justify-between mt-1">
                <span className="truncate">{bar?.hint}</span>
                <span className="inline-flex items-center gap-1 shrink-0">
                  <ArrowUp className="h-3 w-3" />{intBytes(traffic.upload)}
                  {' '}
                  <ArrowDown className="h-3 w-3" />{intBytes(traffic.download)}
                </span>
              </div>
            </div>
          </div>

          <div className="pt-2.5 border-t border-dashed font-mono text-xs text-muted-foreground space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3" />{intBytes(u.netOut || 0)}/s</span>
              <span className="inline-flex items-center gap-1"><ArrowDown className="h-3 w-3" />{intBytes(u.netIn || 0)}/s</span>
            </div>
            <div className="flex items-center gap-3">
              <Stat icon={Clock}>{uptime(u.uptime)}</Stat>
              <span className="ml-auto">{relativeAge(u.ts)}</span>
            </div>
          </div>

          {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map(t => (
                    <Badge key={t} variant="outline" className="text-[10px]">
                      {t}
                    </Badge>
                ))}
              </div>
          )}
        </Card>
      </a>
  )
}

function Stat({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
      <span className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3" />
        {children}
    </span>
  )
}

function Metric({
                  label,
                  value,
                  sub,
                  subTitle,
                  valueText,
                }: {
  label: string
  value: number | undefined
  sub?: string | null
  subTitle?: string
  valueText?: string
}) {
  return (
      <div className="min-w-0">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono">{valueText ?? pct(value)}</span>
        </div>
        <Progress value={value} indicatorClassName={loadColor(value)} className="mt-1 h-1.5" />
        {sub && (
            <div
                className="font-mono text-[11px] text-muted-foreground mt-1 truncate"
                title={subTitle}
            >
              {sub}
            </div>
        )}
      </div>
  )
}

function intBytes(n: number) {
  if (n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${Math.round(v)} ${units[i]}`
}
