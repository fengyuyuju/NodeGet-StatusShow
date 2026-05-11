import { useEffect, useState } from 'react'

type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

const KEY = 'nodeget.theme'
const QUERY = '(prefers-color-scheme: dark)'

function initialPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {}
  return 'system'
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia(QUERY).matches ? 'dark' : 'light'
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  const resolvedTheme: ResolvedTheme = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(QUERY)
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, preference)
    } catch {}
  }, [preference])

  return { preference, resolvedTheme, setPreference }
}
