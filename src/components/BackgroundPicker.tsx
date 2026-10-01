import { useRef, useState } from 'react'
import { repo } from '../lib/repo'
import { compressImage, type CompressedImage } from '../lib/image'
import { useI18n } from '../lib/i18n'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Props {
  /** Current picture, or null (default background). */
  url: string | null | undefined
  /** Saves the compressed picture; may return a note added after « Image enregistrée ». */
  onSave(image: CompressedImage): Promise<string | void>
  onRemove(): Promise<void>
  onChanged?(): void
}

/**
 * Background picture (halls, À emporter, Livraison): choose a photo or 3D render, compressed here before it is stored,
 * or remove it. Online up to 1920 px; the demo keeps it in the browser's small storage, so smaller.
 */
export default function BackgroundPicker({ url, onSave, onRemove, onChanged }: Props) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function pick(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) return setError(t.bgNotImage)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const img = await compressImage(file, repo.mode === 'local' ? 1280 : 1920, repo.mode === 'local' ? 0.7 : 0.82)
      const extra = await onSave(img)
      setNotice(`${t.bgSaved(Math.max(1, Math.round(img.blob.size / 1024)))}${extra ? ` ${extra}` : ''}`)
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error && e.message === 'image' ? t.bgNotImage : errorText(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await onRemove()
      onChanged?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-picker">
      <div className="bg-preview" style={url ? { backgroundImage: `url("${url.replace(/"/g, '%22')}")` } : undefined}>
        {!url && <span className="muted small">{t.bgNone}</span>}
      </div>
      <div className="bg-actions">
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>🖼 {busy ? t.bgUploading : url ? t.bgReplace : t.bgChoose}</button>
        {url && <button type="button" className="danger" onClick={remove} disabled={busy}>{t.bgRemove}</button>}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {error && <p className="banner error small">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}
    </div>
  )
}
