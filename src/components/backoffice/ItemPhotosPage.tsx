import { useCallback, useEffect, useRef, useState } from 'react'
import { repo } from '../../lib/repo'
import { compressPhoto } from '../../lib/image'
import { useI18n } from '../../lib/i18n'
import type { MenuItem } from '../../lib/types'
import { errorText, useLoad } from './useLoad'

/**
 * Paramètres > Photos des articles: a photo for each item, shown on its button in the order screen. The picture is
 * resized (512 px) and compressed (WebP, or JPEG) on this device before it is sent, so a phone photo of several MB
 * becomes a few tens of KB.
 */
export default function ItemPhotosPage() {
  const { t } = useI18n()
  const load = useCallback(() => repo.getMenu({ includeHidden: true }), [])
  const { data: menu, error, setError, reload } = useLoad(load)
  useEffect(() => repo.subscribeOrders(reload), [reload])
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const target = useRef<MenuItem | null>(null)

  function choose(item: MenuItem) {
    target.current = item
    input.current?.click()
  }

  async function pick(file: File | undefined) {
    const item = target.current
    if (input.current) input.current.value = ''
    if (!file || !item) return
    if (!file.type.startsWith('image/')) return setError(t.bgNotImage)
    setBusy(item.id)
    setNotice(null)
    try {
      setError(null)
      const img = await compressPhoto(file)
      await repo.setItemPhoto(item.id, img.blob)
      setNotice(t.photoSaved(item.name, Math.max(1, Math.round(img.blob.size / 1024)), img.width, img.height))
      await reload()
    } catch (e) {
      setError(e instanceof Error && e.message === 'image' ? t.bgNotImage : errorText(e))
    }
    setBusy(null)
  }

  async function remove(item: MenuItem) {
    setBusy(item.id)
    setNotice(null)
    try {
      setError(null)
      await repo.setItemPhoto(item.id, null)
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(null)
  }

  const cats = menu?.categories ?? []
  const items = (menu?.items ?? [])
    .filter((i) => !category || i.category_id === category)
    .sort((a, b) => {
      const ca = cats.findIndex((c) => c.id === a.category_id)
      const cb = cats.findIndex((c) => c.id === b.category_id)
      return ca - cb || a.sort_order - b.sort_order
    })
  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" onClick={() => setNotice(null)}>{notice}</div>}
      <p className="muted small">{t.itemPhotosHint}</p>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {!menu ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <section className="panel">
          <div className="bo-toolbar">
            <label>
              {t.categoryFilter}{' '}
              <select className="auto-width" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">{t.allCategories}</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <span className="muted small">{t.photoCount(items.filter((i) => i.photo_url).length, items.length)}</span>
          </div>
          {!items.length && <p className="muted">{t.noItemsYet}</p>}
          <ul className="photo-grid">
            {items.map((item) => (
              <li key={item.id} className={item.active ? 'photo-card' : 'photo-card muted'}>
                <div className="photo-box">
                  {item.photo_url ? <img src={item.photo_url} alt="" loading="lazy" /> : <span aria-hidden>📷</span>}
                </div>
                <strong><bdi>{item.name}</bdi></strong>
                <div className="row-actions">
                  <button onClick={() => choose(item)} disabled={!!busy}>{busy === item.id ? t.saving : item.photo_url ? t.photoChange : t.photoAdd}</button>
                  {item.photo_url && <button className="danger" onClick={() => remove(item)} disabled={!!busy} aria-label={t.photoRemoveFor(item.name)}>✕</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
