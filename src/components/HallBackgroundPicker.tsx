import { useRef, useState } from 'react'
import type { Hall } from '../lib/types'
import { repo } from '../lib/repo'
import { compressImage } from '../lib/image'
import { useI18n } from '../lib/i18n'
import { usePermissions } from '../lib/permissions'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Fond de salle: choose a picture (photo, 3D render of the real room), compressed here before it is stored, or remove
 * it. The hall's height is set to the picture's proportions (never cutting off a table), so the picture is not
 * cropped and the tables keep their place on it. Used in Modifier le plan and in Paramètres > Modifier fond d'écran.
 */
export default function HallBackgroundPicker({ hall, onChanged }: { hall: Hall; onChanged?(): void }) {
  const { t } = useI18n()
  const { can } = usePermissions()
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
      // Online: up to 1920 px; the demo keeps it in the browser's small storage, so smaller.
      const img = await compressImage(file, repo.mode === 'local' ? 1280 : 1920, repo.mode === 'local' ? 0.7 : 0.82)
      await repo.setHallBackground(hall.id, img.blob)
      let note = t.bgSaved(Math.max(1, Math.round(img.blob.size / 1024)))
      if (can('edit')) {
        const tables = await repo.listTables(hall.id)
        const lowest = tables.reduce((m, x) => Math.max(m, x.y + x.height), 0)
        const height = Math.min(5000, Math.max(200, lowest, Math.round((hall.width * img.height) / img.width)))
        if (height !== hall.height) {
          await repo.updateHall(hall.id, { height })
          note += ` ${t.bgHeightAdjusted(height)}`
        }
      }
      setNotice(note)
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
      await repo.setHallBackground(hall.id, null)
      onChanged?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-picker">
      <div className="bg-preview" style={hall.background_url ? { backgroundImage: `url("${hall.background_url.replace(/"/g, '%22')}")` } : undefined}>
        {!hall.background_url && <span className="muted small">{t.bgNone}</span>}
      </div>
      <div className="bg-actions">
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>🖼 {busy ? t.bgUploading : hall.background_url ? t.bgReplace : t.bgChoose}</button>
        {hall.background_url && <button type="button" className="danger" onClick={remove} disabled={busy}>{t.bgRemove}</button>}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {error && <p className="banner error small">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}
    </div>
  )
}
