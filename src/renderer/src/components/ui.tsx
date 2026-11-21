import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { IconX } from './Icons'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'
export function Button({ variant = 'primary', className = '', busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const v = {
    primary: 'bg-crimson hover:bg-[#ff5c69] text-white',
    ghost: 'bg-transparent hover:bg-ink-700 text-bone',
    outline: 'bg-ink-800 hover:bg-ink-700 text-bone ring-1 ring-inset ring-ink-500',
    danger: 'bg-transparent hover:bg-crimson/15 text-crimson ring-1 ring-inset ring-crimson/50'
  }[variant]
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`clip-btn inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 ${v} ${className}`}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  )
}

export function Card({ className = '', children, title, action }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`relative border border-ink-700 bg-ink-850/80 ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-ink-700 px-5 py-3">
          <h2 className="display flex items-center gap-2 text-xs font-bold text-mute">
            <span className="inline-block h-3 w-1 bg-crimson" />
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start justify-between gap-6 py-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-mute">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 transition ${checked ? 'bg-crimson' : 'bg-ink-600'}`}
      >
        <span className={`absolute top-1 h-4 w-4 bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
      </button>
    </label>
  )
}

export function Badge({ children, tone = 'default', className = '' }: { children: ReactNode; tone?: 'default' | 'red' | 'teal' | 'amber' | 'mute'; className?: string }) {
  const t = {
    default: 'bg-ink-700 text-bone',
    red: 'bg-crimson/15 text-crimson ring-1 ring-inset ring-crimson/40',
    teal: 'bg-teal/10 text-teal ring-1 ring-inset ring-teal/40',
    amber: 'bg-amber/10 text-amber ring-1 ring-inset ring-amber/40',
    mute: 'bg-ink-800 text-mute ring-1 ring-inset ring-ink-600'
  }[tone]
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold tracking-wide ${t} ${className}`}>{children}</span>
}

export function Notice({ tone = 'amber', title, children }: { tone?: 'amber' | 'red' | 'teal' | 'mute'; title?: ReactNode; children: ReactNode }) {
  const t = { amber: 'border-amber/60 bg-amber/5', red: 'border-crimson/70 bg-crimson/5', teal: 'border-teal/60 bg-teal/5', mute: 'border-ink-500 bg-ink-800/60' }[tone]
  return (
    <div className={`border-l-4 px-4 py-3 text-sm leading-relaxed ${t}`}>
      {title && <div className="mb-1 font-bold">{title}</div>}
      <div className="text-bone/85">{children}</div>
    </div>
  )
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={`clip-corner max-h-[90vh] w-full overflow-auto border border-ink-600 bg-ink-850 ${wide ? 'max-w-4xl' : 'max-w-lg'}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-700 px-6 py-4">
          <h3 className="display text-sm font-bold">{title}</h3>
          <button onClick={onClose} className="text-mute hover:text-bone" aria-label="閉じる">
            <IconX />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

export const inputCls =
  'w-full bg-ink-900 px-3 py-2 text-sm text-bone ring-1 ring-inset ring-ink-600 placeholder:text-ink-500 focus:outline-none focus:ring-crimson'

interface Toast {
  id: number
  tone: 'ok' | 'err' | 'info'
  text: string
}
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => undefined)
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, tone, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'err' ? 7000 : 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto border-l-4 bg-ink-800 px-4 py-3 text-sm shadow-2xl ring-1 ring-ink-600 ${t.tone === 'ok' ? 'border-teal' : t.tone === 'err' ? 'border-crimson' : 'border-bone/60'}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
