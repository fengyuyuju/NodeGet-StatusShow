import { useEffect, useRef, useState } from 'react'
import { Activity, Search as SearchIcon, X } from 'lucide-react'
import { Search } from './Search'
import { ViewToggle } from './ViewToggle'
import { ThemeToggle } from './ThemeToggle'
import { SortMenu } from './SortMenu'
import { Button } from './ui/button'
import type { Sort, View } from '../types'

interface Props {
  siteName: string
  logo?: string
  query: string
  onQuery: (v: string) => void
  view: View
  onView: (v: View) => void
  sort: Sort
  onSort: (v: Sort) => void
  page: 'home' | 'latency'
  onOpenLatency: () => void
}

export function Navbar({ siteName, logo, query, onQuery, view, onView, sort, onSort, page, onOpenLatency }: Props) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [stuck, setStuck] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    const onScroll = () => {
      const h = headerRef.current?.offsetHeight ?? 60
      setStuck(window.scrollY > h)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      ref={headerRef}
      className={`sticky top-0 z-10 transition-[background-color,backdrop-filter,border-color] duration-200 ${
        stuck
          ? 'border-b border-border/40 backdrop-blur bg-background/70'
          : 'border-b border-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-2 px-4 sm:px-6 py-3">
        <a
          href="./"
          className="flex items-center gap-2 min-w-0 shrink-0 hover:opacity-80 transition-opacity"
        >
          {logo && <img src={logo} alt="" className="w-6 h-6 rounded shrink-0" />}
          <span className="font-semibold tracking-wide truncate">{siteName}</span>
        </a>
        <div className="flex items-stretch gap-1.5 sm:gap-2.5 shrink-0">
          <div className="hidden">
            <Search value={query} onChange={onQuery} />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="hidden"
            onClick={() => setSearchOpen(o => !o)}
            aria-label={searchOpen ? '关闭搜索' : '搜索'}
          >
            {searchOpen ? <X className="h-4 w-4" /> : <SearchIcon className="h-4 w-4" />}
          </Button>
          <div className="bg-muted p-1 rounded-md flex items-center">
            <button
              type="button"
              onClick={() => {
                if (page === 'home') onOpenLatency()
              }}
              aria-label="延迟汇总"
              aria-pressed={page === 'latency'}
              title="延迟汇总"
              className={`relative z-10 inline-flex items-center justify-center px-3 py-1 text-sm font-medium rounded-sm transition-colors ${
                page === 'latency'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Activity className="h-4 w-4" />
            </button>
          </div>
          {page === 'home' && (
            <>
              <ViewToggle value={view} onChange={onView} />
              <SortMenu value={sort} onChange={onSort} />
            </>
          )}
          <ThemeToggle />
        </div>
      </div>

      <div className="hidden">
        <div className="px-4 pt-1 pb-3">
          <Search ref={inputRef} value={query} onChange={onQuery} className="w-full" />
        </div>
      </div>
    </header>
  )
}
