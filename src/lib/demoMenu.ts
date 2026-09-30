import type { Category, ItemOption, MenuItem, OptionGroup } from './types'
import { newId } from './id'

/** Demo menu for local mode; mirrors the sample rows in the menu_orders migration. */
export function demoMenu() {
  const categories: Category[] = []
  const items: MenuItem[] = []
  const groups: Omit<OptionGroup, 'options'>[] = []
  const options: ItemOption[] = []

  type G = [name: string, min: number, max: number, opts: [string, number][]]
  const data: [string, string, [string, number, G[]?][]][] = [
    ['مشروبات ساخنة', '#b45309', [
      ['قهوة سوداء', 12],
      ['قهوة بالحليب', 15, [['الحجم', 1, 1, [['عادي', 0], ['كبير', 5]]], ['السكر', 0, 1, [['بدون سكر', 0], ['سكر قليل', 0]]]]],
      ['أتاي بالنعناع', 10],
      ['كابوتشينو', 20],
    ]],
    ['عصائر', '#16a34a', [
      ['عصير برتقال', 15, [['الحجم', 1, 1, [['عادي', 0], ['كبير', 7]]]]],
      ['عصير أفوكا', 25],
      ['بانافي', 20],
    ]],
    ['فطور', '#f59e0b', [['فطور مغربي', 45], ['أومليت', 30]]],
    ['أطباق', '#dc2626', [
      ['طاجين دجاج', 70],
      ['برغر', 55, [['الطهي', 1, 1, [['متوسط', 0], ['مطهو جيداً', 0]]], ['إضافات', 0, 3, [['جبن إضافي', 5], ['بيض', 5], ['بطاطس', 10]]]]],
      ['سلطة سيزر', 45],
    ]],
    ['حلويات', '#db2777', [['تشيز كيك', 35], ['كريب شوكولا', 30]]],
  ]

  data.forEach(([name, color, its], ci) => {
    const category_id = newId()
    categories.push({ id: category_id, name, color, sort_order: ci, active: true })
    its.forEach(([itemName, price, gs = []], ii) => {
      const item_id = newId()
      items.push({ id: item_id, category_id, name: itemName, price, sort_order: ii, active: true })
      gs.forEach(([gName, min_select, max_select, opts], gi) => {
        const group_id = newId()
        groups.push({ id: group_id, item_id, name: gName, min_select, max_select, sort_order: gi })
        opts.forEach(([oName, price_delta], oi) => options.push({ id: newId(), group_id, name: oName, price_delta, sort_order: oi }))
      })
    })
  })

  return { categories, items, groups, options }
}
