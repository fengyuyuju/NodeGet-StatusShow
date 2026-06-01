import { useEffect, useRef, useState } from 'react'
import { ArrowUpDown, Check } from 'lucide-react'
import type { Sort } from '../types'

const OPTIONS: { value: Sort; label: string }[] = [
  { value: 'default', label: '默认' },
  { value: 'name', label: '名称' },
  { value: 'region', label: '地区' },
  { value: 'cpu', label: 'CPU 占用' },
  { value: 'mem', label: '内存占用' },
  { value: 'disk', label: '磁盘占用' },
  { value: 'netIn', label: '下行速度' },
  { value: 'netOut', label: '上行速度' },
  { value: 'uptime', label: '在线时长' },
]

export function SortMenu({ value, onChange }: { value: Sort; onChange: (v: Sort) => void }) {
  const [open, setOpen] = useState(false)
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const outsideFlag = useRef(false)
  const current = OPTIONS.find(o => o.value === value) ?? OPTIONS[0]

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
        <ArrowUpDown className="h-4 w-4" />
      </button>
      {show && (
        <div
          data-state={open ? 'open' : 'closed'}
          onAnimationEnd={() => {
            if (!open) setShow(false)
          }}
          className="absolute top-full right-0 mt-1 origin-top-right z-20 rounded-md border bg-popover shadow-md py-1 fill-mode-forwards data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          {OPTIONS.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className="w-full flex items-center justify-between gap-1 px-2.5 py-1.5 text-sm hover:bg-accent"
            >
              <span className="w-3.5 shrink-0 inline-flex items-center justify-center">{o.value === value && <Check className="h-3.5 w-3.5" />}</span>
              <span className="whitespace-nowrap">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
