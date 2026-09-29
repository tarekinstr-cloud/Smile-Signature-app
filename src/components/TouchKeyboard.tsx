import { useState, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n'

/** A key: what it types, and what it types with Maj (shown small in the corner). */
type CharKey = [normal: string, shifted: string]
type Special = 'tab' | 'shift' | 'caps' | 'back' | 'enter' | 'space' | 'hide'
type Key = CharKey | Special

/** Letters: Maj or Verr. Maj gives the capital. */
const L = (c: string): CharKey => [c, c.toUpperCase()]

/**
 * French AZERTY layout. The top row types digits directly (what a password or a code mostly needs), and the AZERTY
 * symbols of that row with Maj.
 */
const ROWS: Key[][] = [
  [['1', '&'], ['2', 'é'], ['3', '"'], ['4', "'"], ['5', '('], ['6', '-'], ['7', 'è'], ['8', '_'], ['9', 'ç'], ['0', 'à'], [')', '°'], ['=', '+'], 'back'],
  ['tab', ...'azertyuiop'.split('').map(L), ['^', '¨'], ['$', '£']],
  ['caps', ...'qsdfghjklm'.split('').map(L), ['ù', '%'], ['*', 'µ'], 'enter'],
  ['shift', ['<', '>'], ...'wxcvbn'.split('').map(L), [',', '?'], [';', '.'], [':', '/'], ['!', '§'], 'shift'],
  [['@', '#'], 'space', ['.', '€'], ['-', '_'], 'hide'],
]

/** The input's value setter, so React sees the change as if it was typed. */
function setValue(input: HTMLInputElement, value: string, caret: number) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  try {
    input.setSelectionRange(caret, caret)
  } catch {
    // Some input types have no caret (email); the text is still typed at the end.
  }
}

function caretOf(input: HTMLInputElement): [number, number] {
  try {
    const start = input.selectionStart ?? input.value.length
    return [start, input.selectionEnd ?? start]
  } catch {
    return [input.value.length, input.value.length]
  }
}

/** Types text at the caret of an input (replacing the selection). */
export function typeInto(input: HTMLInputElement, text: string) {
  const [start, end] = caretOf(input)
  setValue(input, input.value.slice(0, start) + text + input.value.slice(end), start + text.length)
}

/** Suppr: removes the selection, or the character before the caret. */
export function backspace(input: HTMLInputElement) {
  const [start, end] = caretOf(input)
  if (start !== end) setValue(input, input.value.slice(0, start) + input.value.slice(end), start)
  else if (start > 0) setValue(input, input.value.slice(0, start - 1) + input.value.slice(start), start - 1)
}

/** Tab: the next text field of the same form (back to the first after the last). */
function focusNext(input: HTMLInputElement, back: boolean) {
  const fields = Array.from(input.form?.querySelectorAll<HTMLInputElement>('input:not([type=hidden]):not(:disabled)') ?? [])
  if (fields.length < 2) return
  const i = fields.indexOf(input)
  fields[(i + (back ? -1 : 1) + fields.length) % fields.length].focus()
}

interface Props {
  /** The field being typed in; the keyboard types into it. */
  target: HTMLInputElement | null
  onHide(): void
}

/**
 * On-screen AZERTY keyboard for touch screens without a physical keyboard: digits, symbols, Tab, Maj, Verr. Maj,
 * Suppr and Entrée. Keys never take the focus, so the caret stays in the field and a physical keyboard keeps working.
 */
export default function TouchKeyboard({ target, onHide }: Props) {
  const { t } = useI18n()
  const [shift, setShift] = useState(false)
  const [caps, setCaps] = useState(false)

  function press(k: Key) {
    if (!target) return
    target.focus()
    if (Array.isArray(k)) {
      const letter = k[0] !== k[1] && k[0].toUpperCase() === k[1]
      typeInto(target, (letter ? shift !== caps : shift) ? k[1] : k[0])
      setShift(false)
      return
    }
    switch (k) {
      case 'shift': return setShift(!shift)
      case 'caps': return setCaps(!caps)
      case 'back': return backspace(target)
      case 'space': return typeInto(target, ' ')
      case 'tab': return focusNext(target, shift)
      case 'enter': return target.form?.requestSubmit()
      case 'hide': return onHide()
    }
  }

  // Symbol always shown, word hidden on phones where the keys are narrow.
  const word = (icon: string, text: string) => <>{icon}<span className="kb-word"> {text}</span></>
  const label: Record<Special, ReactNode> = {
    tab: word('⇥', t.kbTab), shift: word('⇧', t.kbShift), caps: word('⇪', t.kbCaps), back: word('⌫', t.kbBack),
    enter: word('↵', t.kbEnter), space: '', hide: '⌨ ▾',
  }
  const upper = shift !== caps

  return (
    // The keyboard is always laid out left to right, like the physical one, also in Arabic.
    <div className="touch-kb" dir="ltr" role="group" aria-label={t.kbLabel} onPointerDown={(e) => e.preventDefault()}>
      {ROWS.map((row, r) => (
        <div key={r} className="kb-row">
          {row.map((k, i) =>
            Array.isArray(k) ? (
              <button key={i} type="button" tabIndex={-1} className="kb-key" data-key={k[0]} onClick={() => press(k)}>
                {k[0] !== k[1] && k[0].toUpperCase() === k[1] ? (
                  upper ? k[1] : k[0]
                ) : (
                  <>
                    <span className="kb-alt">{k[1]}</span>
                    <span className={shift ? 'kb-dim' : ''}>{k[0]}</span>
                  </>
                )}
              </button>
            ) : (
              <button key={i} type="button" tabIndex={-1} className={`kb-key kb-${k}`}
                aria-pressed={k === 'shift' ? shift : k === 'caps' ? caps : undefined}
                aria-label={{ tab: t.kbTab, shift: t.kbShift, caps: t.kbCaps, back: t.kbBack, enter: t.kbEnter, space: t.kbSpace, hide: t.kbHide }[k]}
                onClick={() => press(k)}>
                {label[k]}
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  )
}
