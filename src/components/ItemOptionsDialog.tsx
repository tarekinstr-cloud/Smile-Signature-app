import { useState, type FormEvent } from 'react'
import type { ChosenOption, MenuItem, OptionGroup } from '../lib/types'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'

interface Props {
  item: MenuItem
  groups: OptionGroup[]
  /** Options to start from (adding a variant of a line already in the order). */
  initial?: ChosenOption[]
  onCancel(): void
  onAdd(options: ChosenOption[], quantity: number, note: string | null): void
}

/** Picks an item's options (size, extras…), quantity and note before adding it to the order. */
export default function ItemOptionsDialog({ item, groups, initial, onCancel, onAdd }: Props) {
  const { t } = useI18n()
  // Required single-choice groups start on their first option so the common case is one tap.
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      groups.map((g) => {
        if (initial) {
          const ids = g.options.filter((o) => initial.some((c) => c.group === g.name && c.name === o.name)).map((o) => o.id)
          if (ids.length || g.min_select === 0) return [g.id, ids]
        }
        return [g.id, g.min_select >= 1 && g.max_select === 1 && g.options[0] ? [g.options[0].id] : []]
      }),
    ),
  )
  const [quantity, setQuantity] = useState(1)
  const [note, setNote] = useState('')

  function toggle(g: OptionGroup, optionId: string) {
    setPicked((p) => {
      const cur = p[g.id] ?? []
      if (g.max_select === 1) return { ...p, [g.id]: cur[0] === optionId && g.min_select === 0 ? [] : [optionId] }
      if (cur.includes(optionId)) return { ...p, [g.id]: cur.filter((x) => x !== optionId) }
      if (cur.length >= g.max_select) return p
      return { ...p, [g.id]: [...cur, optionId] }
    })
  }

  const chosen: ChosenOption[] = groups.flatMap((g) =>
    g.options.filter((o) => picked[g.id]?.includes(o.id)).map((o) => ({ group: g.name, name: o.name, price_delta: o.price_delta })),
  )
  const missing = groups.filter((g) => (picked[g.id]?.length ?? 0) < g.min_select)
  const unit = item.price + chosen.reduce((s, o) => s + o.price_delta, 0)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (missing.length) return
    onAdd(chosen, quantity, note.trim() || null)
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog options-dialog" role="dialog" aria-modal="true" aria-labelledby="opt-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="opt-title">{item.name} <span className="muted small">{money(item.price)}</span></h2>
        {groups.map((g) => (
          <fieldset key={g.id} className="opt-group">
            <legend>
              {g.name}{' '}
              <span className="muted small">
                {g.min_select >= 1 ? t.required : t.optional}
                {g.max_select > 1 && ` · ${t.upTo(g.max_select)}`}
              </span>
            </legend>
            <div className="opt-list">
              {g.options.map((o) => {
                const on = picked[g.id]?.includes(o.id)
                return (
                  <button key={o.id} type="button" className={on ? 'opt on' : 'opt'} aria-pressed={on} onClick={() => toggle(g, o.id)}>
                    {o.name}
                    {o.price_delta !== 0 && <span className="small"> {o.price_delta > 0 ? '+' : ''}{o.price_delta}</span>}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}
        <label>
          {t.note}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.notePlaceholder} />
        </label>
        <div className="stepper big">
          <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label={t.decrease}>−</button>
          <span>{quantity}</span>
          <button type="button" onClick={() => setQuantity((q) => q + 1)} aria-label={t.increase}>+</button>
        </div>
        {missing.length > 0 && <p className="error small">{t.choose} {missing.map((g) => g.name).join(t.listSep)}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={missing.length > 0}>{t.add} · {money(unit * quantity)}</button>
        </div>
      </form>
    </div>
  )
}
