export type TableStatus = 'free' | 'occupied'
export type TableShape = 'square' | 'round' | 'rect'

export interface Hall {
  id: string
  name: string
  width: number
  height: number
  sort_order: number
}

export interface DiningTable {
  id: string
  hall_id: string
  label: string
  seats: number
  shape: TableShape
  x: number
  y: number
  width: number
  height: number
  status: TableStatus
}

export type NewTable = Omit<DiningTable, 'id'>
export type TablePatch = Partial<Omit<DiningTable, 'id' | 'hall_id'>>
export type HallPatch = Partial<Omit<Hall, 'id'>>
