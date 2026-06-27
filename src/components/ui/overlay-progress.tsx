import { Progress } from './progress'
import { loadColor } from '../../utils/cn'

/**
 * 进度条 + 居中叠值，卡片与表格共用。
 * 描边用 card 底色，使数值在彩色填充段上仍可读——这也是卡片「对齐表格样式」的唯一来源。
 */
export function OverlayProgress({ value, text }: { value: number | undefined; text: string }) {
  return (
    <div className="relative">
      <Progress value={value} indicatorClassName={loadColor(value)} className="h-1.5" />
      <span
        className="absolute inset-0 flex items-center justify-center font-mono text-[10px] font-medium"
        style={{
          textShadow:
            '-1px -1px 0 hsl(var(--card)), 1px -1px 0 hsl(var(--card)), -1px 1px 0 hsl(var(--card)), 1px 1px 0 hsl(var(--card))',
        }}
      >
        {text}
      </span>
    </div>
  )
}
