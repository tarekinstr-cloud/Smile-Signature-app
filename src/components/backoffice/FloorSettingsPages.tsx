import { useCallback, useEffect, useState } from 'react'
import { repo } from '../../lib/repo'
import { useI18n } from '../../lib/i18n'
import HallBackgroundPicker from '../HallBackgroundPicker'
import BackgroundPicker from '../BackgroundPicker'
import { errorText, useLoad } from './useLoad'
import type { FloorConfig } from '../../lib/types'

/** Paramètres > Modifier fond d'écran: the background picture of each hall. */
export function WallpaperPage() {
  const { t } = useI18n()
  const load = useCallback(() => repo.listHalls(), [])
  const { data: halls, error, setError, reload } = useLoad(load)
  useEffect(() => repo.subscribe(reload), [reload])
  // À emporter and Livraison views: their pictures are in the configuration.
  const loadConfig = useCallback(() => repo.getFloorConfig(), [])
  const { data: config, reload: reloadConfig } = useLoad(loadConfig)
  useEffect(() => repo.subscribeConfig(reloadConfig), [reloadConfig])
  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <p className="muted small">{t.bgHint}</p>
      {!halls ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : !halls.length ? (
        <p className="muted">{t.noHalls}</p>
      ) : (
        <div className="bg-halls">
          {halls.map((h) => (
            <section key={h.id} className="panel">
              <h2><bdi>{h.name}</bdi></h2>
              <HallBackgroundPicker hall={h} onChanged={reload} />
            </section>
          ))}
          {(['takeaway', 'delivery'] as const).map((area) => (
            <section key={area} className="panel">
              <h2>{area === 'takeaway' ? t.takeawayBtn : t.deliveryBtn}</h2>
              <BackgroundPicker url={config?.[`${area}_background_url`]} onChanged={reloadConfig}
                onSave={(img) => repo.setAreaBackground(area, img.blob)} onRemove={() => repo.setAreaBackground(area, null)} />
            </section>
          ))}
        </div>
      )}
    </main>
  )
}

/** Paramètres > Configurations: thresholds of the waiting timer shown under each table. */
export function ConfigPage() {
  const { t } = useI18n()
  const load = useCallback(() => repo.getFloorConfig(), [])
  const { data, error, setError, reload } = useLoad(load)
  const [warn, setWarn] = useState('')
  const [alert, setAlert] = useState('')
  const [takeawayGuests, setTakeawayGuests] = useState('')
  const [deliveryGuests, setDeliveryGuests] = useState('')
  const [pager, setPager] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!data) return
    setWarn(String(data.timer_warn_min))
    setAlert(String(data.timer_alert_min))
    setTakeawayGuests(String(data.takeaway_default_guests))
    setDeliveryGuests(String(data.delivery_default_guests))
    setPager(data.pager_enabled)
  }, [data])
  useEffect(() => repo.subscribeConfig(reload), [reload])

  async function save() {
    setSaved(false)
    try {
      const c: FloorConfig = {
        timer_warn_min: Number(warn), timer_alert_min: Number(alert),
        takeaway_default_guests: Number(takeawayGuests), delivery_default_guests: Number(deliveryGuests), pager_enabled: pager,
      }
      await repo.updateFloorConfig(c)
      setSaved(true)
      reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <main className="content bo-content settings-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <h2>{t.cfgTimerTitle}</h2>
        <p className="muted small">{t.cfgTimerHint}</p>
        <div className="config-row">
          <label>
            {t.cfgWarn}
            <input type="number" inputMode="numeric" min={1} max={599} value={warn} onChange={(e) => { setWarn(e.target.value); setSaved(false) }} />
          </label>
          <label>
            {t.cfgAlert}
            <input type="number" inputMode="numeric" min={2} max={600} value={alert} onChange={(e) => { setAlert(e.target.value); setSaved(false) }} />
          </label>
          <button className="primary" onClick={save} disabled={!data}>{t.save}</button>
        </div>
        <p className="small">
          <span className="table-timer ok">⏱ {t.cfgLegendOk(Number(warn) || 0)}</span>{' '}
          <span className="table-timer warn">⏱ {t.cfgLegendWarn(Number(warn) || 0, Number(alert) || 0)}</span>{' '}
          <span className="table-timer alert">⏱ {t.cfgLegendAlert(Number(alert) || 0)}</span>
        </p>
        {saved && <p className="banner ok small">{t.cfgSaved}</p>}
      </section>
      <section className="panel">
        <h2>{t.cfgGuestsTitle}</h2>
        <p className="muted small">{t.cfgGuestsHint}</p>
        <div className="config-row">
          <label>
            {t.cfgTakeawayGuests}
            <input type="number" inputMode="numeric" min={1} max={99} value={takeawayGuests} onChange={(e) => { setTakeawayGuests(e.target.value); setSaved(false) }} />
          </label>
          <label>
            {t.cfgDeliveryGuests}
            <input type="number" inputMode="numeric" min={1} max={99} value={deliveryGuests} onChange={(e) => { setDeliveryGuests(e.target.value); setSaved(false) }} />
          </label>
          <button className="primary" onClick={save} disabled={!data}>{t.save}</button>
        </div>
      </section>
      <section className="panel">
        <h2>{t.cfgPagerTitle}</h2>
        <label className="check">
          <input type="checkbox" checked={pager} onChange={(e) => { setPager(e.target.checked); setSaved(false) }} />
          {t.cfgPagerLabel}
        </label>
        <p className="muted small">{t.cfgPagerHint}</p>
        <div><button className="primary" onClick={save} disabled={!data}>{t.save}</button></div>
      </section>
    </main>
  )
}
