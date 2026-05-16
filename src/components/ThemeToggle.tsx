import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'

const ORDER = ['light', 'dark', 'system'] as const
const META = {
  light: { icon: Sun, label: '浅色模式' },
  dark: { icon: Moon, label: '深色模式' },
  system: { icon: Monitor, label: '跟随系统' },
} as const

export function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  const { icon: Icon, label } = META[preference]
  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]

  return (
    <div className="bg-muted p-1 rounded-md">
      <button
        type="button"
        onClick={() => setPreference(next)}
        aria-label={`切换到${META[next].label}`}
        title={label}
        className="relative z-10 inline-flex items-center justify-center px-3 py-1 text-sm font-medium rounded-sm transition-colors text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-4 w-4" />
      </button>
    </div>
  )
}
