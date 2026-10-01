import type { Hall } from '../lib/types'
import { repo } from '../lib/repo'
import { useI18n } from '../lib/i18n'
import { usePermissions } from '../lib/permissions'
import BackgroundPicker from './BackgroundPicker'

/**
 * Fond de salle. The hall's height is set to the picture's proportions (never cutting off a table), so the picture is
 * not cropped and the tables keep their place on it. Used in Modifier le plan and in Paramètres > Modifier fond d'écran.
 */
export default function HallBackgroundPicker({ hall, onChanged }: { hall: Hall; onChanged?(): void }) {
  const { t } = useI18n()
  const { can } = usePermissions()
  return (
    <BackgroundPicker url={hall.background_url} onChanged={onChanged}
      onRemove={() => repo.setHallBackground(hall.id, null)}
      onSave={async (img) => {
        await repo.setHallBackground(hall.id, img.blob)
        if (!can('edit')) return
        const tables = await repo.listTables(hall.id)
        const lowest = tables.reduce((m, x) => Math.max(m, x.y + x.height), 0)
        const height = Math.min(5000, Math.max(200, lowest, Math.round((hall.width * img.height) / img.width)))
        if (height === hall.height) return
        await repo.updateHall(hall.id, { height })
        return t.bgHeightAdjusted(height)
      }} />
  )
}
