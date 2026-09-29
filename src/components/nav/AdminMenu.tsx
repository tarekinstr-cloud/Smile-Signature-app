import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'

export interface AdminMenuItem {
  id: string
  label: string
  onSelect?: () => void
  /** Greyed out: a feature that does not exist yet. */
  disabled?: boolean
  /** Shown with a check mark (current mode or page). */
  checked?: boolean
}

export interface AdminMenuGroup {
  id: string
  label: string
  /** A drop-down menu, or… */
  items?: AdminMenuItem[]
  /** …a direct command when the group has a single destination. */
  onSelect?: () => void
  /** Underlined: the page on screen belongs to this group. */
  current?: boolean
}

/**
 * Line 1 of the navigation: desktop-style administration menus (Fichier, Édition, Gestion du Stock…), aligned to the
 * start. On narrow screens (tablet portrait, phone) the menus fold into one "Menus" button opening a panel.
 */
export default function AdminMenu({ groups, end }: { groups: AdminMenuGroup[]; end?: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState<string | null>(null)
  const [compact, setCompact] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open && !compact) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(null)
        setCompact(false)
      }
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null)
        setCompact(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open, compact])

  const pick = (fn?: () => void) => {
    setOpen(null)
    setCompact(false)
    fn?.()
  }

  const itemButton = (it: AdminMenuItem) => (
    <button key={it.id} role="menuitem" className="admin-item" disabled={it.disabled} aria-checked={it.checked}
      onClick={() => pick(it.onSelect)}>
      <span className="check" aria-hidden>{it.checked ? '✓' : ''}</span>
      {it.label}
    </button>
  )

  return (
    <div className="adminbar" ref={ref}>
      <button className="admin-compact-btn" aria-expanded={compact} aria-haspopup="menu" onClick={() => { setOpen(null); setCompact(!compact) }}>
        ☰ {t.navMenus}
      </button>
      <nav className="admin-menus" aria-label={t.navAdmin}>
        {groups.map((g) =>
          g.items ? (
            <div key={g.id} className="admin-group">
              <button className={`admin-top${g.current ? ' current' : ''}`} aria-haspopup="menu" aria-expanded={open === g.id}
                onClick={() => setOpen(open === g.id ? null : g.id)}
                onPointerEnter={(e) => e.pointerType === 'mouse' && open && open !== g.id && setOpen(g.id)}>
                {g.label}
              </button>
              {open === g.id && (
                <div className="admin-dropdown" role="menu" aria-label={g.label}>
                  {g.items.map(itemButton)}
                </div>
              )}
            </div>
          ) : (
            <button key={g.id} className={`admin-top${g.current ? ' current' : ''}`} aria-current={g.current ? 'page' : undefined}
              onClick={() => pick(g.onSelect)} onPointerEnter={(e) => e.pointerType === 'mouse' && open && setOpen(null)}>
              {g.label}
            </button>
          ),
        )}
      </nav>
      <div className="spacer" />
      {end}
      {compact && (
        <div className="admin-panel" role="menu" aria-label={t.navAdmin}>
          {groups.map((g) => (
            <div key={g.id} className="admin-panel-group">
              {g.items ? (
                <>
                  <div className="admin-panel-title">{g.label}</div>
                  {g.items.map(itemButton)}
                </>
              ) : (
                itemButton({ id: g.id, label: g.label, onSelect: g.onSelect, checked: g.current })
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
