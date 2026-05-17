import { useEffect, useRef, useState } from 'react'
import { Check, Globe, LayoutGrid, Table } from 'lucide-react'
import type { View } from '../types'

const ITEMS: { value: View; label: string; icon: typeof LayoutGrid }[] = [
  { value: 'cards', label: '卡片', icon: LayoutGrid },
  { value: 'table', label: '表格', icon: Table },
  { value: 'map', label: '地图', icon: Globe },
]

export function ViewToggle({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const [open, setOpen] = useState(false)
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const outsideFlag = useRef(false)
  const current = ITEMS.find(i => i.value === value) ?? ITEMS[0]
  const { icon: Icon } = current

  useEffect(() => {
    if (open) setShow(true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        outsideFlag.current = true
        setOpen(false)
      }
    }
    const onClickCapture = (e: MouseEvent) => {
      if (outsideFlag.current) {
        e.stopPropagation()
        e.preventDefault()
        outsideFlag.current = false
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('click', onClickCapture, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('click', onClickCapture, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative bg-muted p-1 rounded-md flex items-center">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative z-10 inline-flex items-center justify-center gap-1.5 px-3 py-1 text-sm font-medium rounded-sm transition-colors text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-4 w-4" />
        <span className="hidden sm:inline">{current.label}</span>
      </button>
      {show && (
        <div
          data-state={open ? 'open' : 'closed'}
          onAnimationEnd={() => {
            if (!open) setShow(false)
          }}
          className="absolute top-full left-0 mt-1 origin-top-left z-20 rounded-md border bg-popover shadow-md py-1 fill-mode-forwards data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          {ITEMS.map(({ value: v, label, icon: ItemIcon }) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                onChange(v)
                setOpen(false)
              }}
              className="w-full flex items-center justify-between gap-1 px-2.5 py-1.5 text-sm hover:bg-accent"
            >
              <span className="w-3.5 shrink-0 inline-flex items-center justify-center">{v === value && <Check className="h-3.5 w-3.5" />}</span>
              <span className="inline-flex items-center gap-2">
                <ItemIcon className="h-4 w-4" />
                <span className="whitespace-nowrap">{label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
