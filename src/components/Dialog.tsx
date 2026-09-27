import { useCallback, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '../lib/i18n'

interface Request {
  title: string
  /** When set, the dialog shows a text field and resolves with its value. */
  input?: { placeholder?: string }
  confirmLabel: string
  danger?: boolean
}

/** In-app replacement for window.prompt / window.confirm, which some hosts (installed PWAs, embedded previews) block. */
export function useDialog() {
  const { t } = useI18n()
  const [req, setReq] = useState<Request | null>(null)
  const [value, setValue] = useState('')
  const resolver = useRef<((v: string | null) => void) | null>(null)

  const open = useCallback((r: Request) => {
    setValue('')
    setReq(r)
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = (result: string | null) => {
    resolver.current?.(result)
    resolver.current = null
    setReq(null)
  }

  const askText = (title: string, confirmLabel = t.add) => open({ title, input: {}, confirmLabel })
  const confirm = async (title: string, confirmLabel = t.delete) =>
    (await open({ title, confirmLabel, danger: true })) !== null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (req?.input) {
      const v = value.trim()
      if (v) close(v)
    } else {
      close('ok')
    }
  }

  const element = req && (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(null)}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && close(null)}>
        <h2 id="dialog-title">{req.title}</h2>
        {req.input && <input id="dialog-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
        <div className="dialog-actions">
          <button type="button" onClick={() => close(null)}>{t.cancel}</button>
          <button type="submit" className={req.danger ? 'danger solid' : 'primary'} autoFocus={!req.input}
            disabled={!!req.input && !value.trim()}>
            {req.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )

  return { element, askText, confirm }
}
