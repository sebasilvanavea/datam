import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

const Card = forwardRef(function Card({ className, ...props }, ref) {
  return <div ref={ref} className={cn('rounded-2xl border border-slate-800/90 bg-slate-900/75 p-5 shadow-xl backdrop-blur', className)} {...props} />
})

function CardHeader({ className, ...props }) {
  return <div className={cn('mb-4 space-y-1', className)} {...props} />
}

function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-lg font-semibold text-current', className)} {...props} />
}

function CardDescription({ className, ...props }) {
  return <p className={cn('text-sm text-slate-500', className)} {...props} />
}

const CardContent = forwardRef(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn('', className)} {...props} />
})

export { Card, CardHeader, CardTitle, CardDescription, CardContent }
