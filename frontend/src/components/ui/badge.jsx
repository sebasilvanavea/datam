import { cn } from '../../lib/utils'

function Badge({ className, ...props }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full border border-blue-400/40 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-200', className)}
      {...props}
    />
  )
}

export { Badge }
