/** Back-office pages of the menu bar, in menu order. */
export const BACK_OFFICE_PAGES = ['stats', 'stock', 'suppliers', 'staff', 'settings'] as const
export type BackOfficePage = (typeof BACK_OFFICE_PAGES)[number]

export const PAGE_ICONS: Record<BackOfficePage, string> = {
  stats: '📊',
  stock: '📦',
  suppliers: '🚚',
  staff: '👥',
  settings: '⚙️',
}
