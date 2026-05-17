import { Globe, LayoutGrid, Table } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { View } from '../types'

const ITEMS: { value: View; label: string; icon: typeof LayoutGrid }[] = [
  { value: 'cards', label: '卡片', icon: LayoutGrid },
  { value: 'table', label: '表格', icon: Table },
  { value: 'map', label: '地图', icon: Globe },
]

export function ViewToggle({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const btn = el.querySelector<HTMLElement>('[data-active="true"]')
    if (!btn) return
    const cr = el.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    setIndicator({ left: br.left - cr.left, width: br.width })
  }, [value])

  return (
    <div ref={ref} className="relative bg-muted p-1 rounded-md flex gap-0.5 items-center">
      <div
        aria-hidden
        className="absolute top-1 rounded-sm bg-background shadow transition-all duration-200 ease-out"
        style={{ left: indicator.left, width: indicator.width, height: 'calc(100% - 0.5rem)' }}
      />
      {ITEMS.map(({ value: v, label, icon: Icon }) => (
        <Btn key={v} active={value === v} onClick={() => onChange(v)}>
          <Icon className="h-4 w-4" />
          <span className="hidden sm:inline">{label}</span>
        </Btn>
      ))}
    </div>
  )
}

function Btn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-active={active}
      onClick={onClick}
      aria-pressed={active}
      className={`relative z-10 inline-flex items-center justify-center gap-1.5 px-3 py-1 text-sm font-medium rounded-sm transition-colors ${
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
