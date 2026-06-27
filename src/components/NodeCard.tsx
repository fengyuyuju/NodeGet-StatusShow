import { ArrowDown, ArrowUp, Clock, type LucideIcon } from 'lucide-react'
import { Badge } from './ui/badge'
import { Card } from './ui/card'
import { OverlayProgress } from './ui/overlay-progress'
import { Flag } from './Flag'
import { StatusDot } from './StatusDot'
import { bytes, pct, relativeAge, uptime } from '../utils/format'
import { cpuLabel, deriveUsage, distroLogo, displayName, trafficBar, trafficUsed } from '../utils/derive'
import { cn } from '../utils/cn'
import type { Node } from '../types'
import type { ReactNode } from 'react'

export function NodeCard({ node }: { node: Node }) {
  const u = deriveUsage(node)
  const traffic = trafficUsed(node)
  const bar = trafficBar(node)
  const tags = Array.isArray(node.meta?.tags) ? node.meta.tags : []
  const cpu = cpuLabel(node)
  const logo = distroLogo(node)

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
            {logo && (
              <img src={logo} alt="" className="w-5 h-5 shrink-0 object-contain" loading="lazy" />
            )}
          </div>

          <div className="flex flex-col gap-3.5">
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
                  sub={bar?.hint}
              />
              <div className="font-mono text-[11px] text-muted-foreground flex justify-between mt-1">
                <span className="inline-flex items-center gap-1">
                  <ArrowUp className="h-3 w-3" />{bytes(traffic.upload)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <ArrowDown className="h-3 w-3" />{bytes(traffic.download)}
                </span>
              </div>
            </div>
          </div>

          <div className="pt-2.5 border-t border-dashed font-mono text-xs text-muted-foreground space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3" />{bytes(u.netOut || 0)}/s</span>
              <span className="inline-flex items-center gap-1"><ArrowDown className="h-3 w-3" />{bytes(u.netIn || 0)}/s</span>
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
        <div className="flex justify-between gap-2 text-xs">
          <span className="text-muted-foreground shrink-0">{label}</span>
          {sub && (
            <span className="font-mono text-muted-foreground truncate min-w-0 text-right" title={subTitle}>
              {sub}
            </span>
          )}
        </div>
        <div className="mt-1.5">
          <OverlayProgress value={value} text={valueText ?? pct(value)} />
        </div>
      </div>
  )
}
