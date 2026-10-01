import { useSyncExternalStore } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { setDemoPermissionCheck, supabase } from './repo'
import { tr } from './i18n'
import { USER_ROLES, type UserRole } from './types'

/**
 * What an account may open or do beyond the service screen (plan de salle, commandes, encaissement, à emporter,
 * livraison), which every account has. Same keys as the database (migrations 20260930000000_permissions.sql, 20260930010000_reservations.sql,
 * 20260930030000_delivery_zones.sql, 20260930050000_payroll.sql, 20260930060000_devices.sql, 20260930070000_supplier_purchases.sql, 20260930080000_stock_locations.sql, 20260930090000_stock_state.sql, 20260930100000_recipes.sql, 20260930110000_cash_register.sql, 20260930120000_expenses_profit.sql, 20260930140000_control.sql and 20261001000000_supplier_invoice_cancel.sql).
 */
export const SECTION_PERMISSIONS = ['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'stats', 'weekly_stats', 'expenses', 'profit', 'cancelled_orders', 'cancelled_invoices', 'price_log', 'settings', 'edit', 'recipes', 'backup', 'ticket', 'reservations', 'delivery_zones'] as const
export const ACTION_PERMISSIONS = ['cancel_order', 'offer', 'discount', 'inventory', 'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'cancel_invoice', 'purchase_cancel'] as const
export const PERMISSIONS = [...SECTION_PERMISSIONS, ...ACTION_PERMISSIONS] as const
export type Permission = (typeof PERMISSIONS)[number]

/** Checked box for each role and permission. */
export type RolePermissions = Record<UserRole, Record<Permission, boolean>>
/** An exception for one user: replaces the value of the user's role. */
export interface UserOverride {
  user_id: string
  permission: Permission
  allowed: boolean
}
export interface PermissionTable {
  roles: RolePermissions
  users: UserOverride[]
}

/** Before any change: Admin has everything, Employé only the service screen (as before the permissions page). */
export function defaultRoles(): RolePermissions {
  const all = (allowed: boolean) => Object.fromEntries(PERMISSIONS.map((p) => [p, allowed])) as Record<Permission, boolean>
  return { admin: all(true), employe: all(false) }
}

/** What an account ends up with: its own exceptions first, then its role. */
export function effective(table: PermissionTable, userId: string, role: UserRole): Permission[] {
  return PERMISSIONS.filter((p) => table.users.find((o) => o.user_id === userId && o.permission === p)?.allowed ?? table.roles[role][p])
}

/**
 * Reading and changing the permissions (page Permissions). Supabase tables role_permissions and user_permissions,
 * or localStorage in demo mode. Only an Admin (role) can change them; the database checks it again.
 */
export interface PermissionsService {
  /** Permissions of the signed-in account. */
  mine(userId: string, role: UserRole): Promise<Permission[]>
  load(): Promise<PermissionTable>
  setRole(role: UserRole, permission: Permission, allowed: boolean): Promise<void>
  /** null removes the exception: the user follows the role again. */
  setUser(userId: string, permission: Permission, allowed: boolean | null): Promise<void>
}

const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p)
const missing = (message: string) =>
  /role_permissions|user_permissions|my_permissions/.test(message) && /does not exist|schema cache|Could not find/i.test(message)

function permissionsError(message: string): Error {
  const t = tr()
  if (missing(message)) return new Error(t.errMigrationPermissions)
  if (/row-level security|permission denied/i.test(message)) return new Error(t.errNotAdmin)
  return new Error(message)
}

function supabasePermissions(sb: SupabaseClient): PermissionsService {
  return {
    async mine(_userId, role) {
      const res = await sb.rpc('my_permissions')
      // Database without the permissions migration: the rights the roles had before it.
      if (res.error) return missing(res.error.message) ? PERMISSIONS.filter((p) => defaultRoles()[role][p]) : []
      return ((res.data as string[] | null) ?? []).filter(isPermission)
    },
    async load() {
      const [roles, users] = await Promise.all([
        sb.from('role_permissions').select('role, permission, allowed'),
        sb.from('user_permissions').select('user_id, permission, allowed'),
      ])
      if (roles.error) throw permissionsError(roles.error.message)
      if (users.error) throw permissionsError(users.error.message)
      const table: PermissionTable = { roles: defaultRoles(), users: [] }
      for (const r of roles.data as { role: string; permission: string; allowed: boolean }[]) {
        if (USER_ROLES.includes(r.role as UserRole) && isPermission(r.permission)) table.roles[r.role as UserRole][r.permission] = r.allowed
      }
      table.users = (users.data as UserOverride[]).filter((o) => isPermission(o.permission))
      return table
    },
    async setRole(role, permission, allowed) {
      const res = await sb.from('role_permissions').upsert({ role, permission, allowed })
      if (res.error) throw permissionsError(res.error.message)
    },
    async setUser(userId, permission, allowed) {
      const res = allowed === null
        ? await sb.from('user_permissions').delete().eq('user_id', userId).eq('permission', permission)
        : await sb.from('user_permissions').upsert({ user_id: userId, permission, allowed })
      if (res.error) throw permissionsError(res.error.message)
    },
  }
}

const LOCAL_KEY = 'smile.permissions.v1'

function localPermissions(): PermissionsService {
  const read = (): PermissionTable => {
    const table: PermissionTable = { roles: defaultRoles(), users: [] }
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? 'null') as Partial<PermissionTable> | null
      for (const role of USER_ROLES) {
        for (const p of PERMISSIONS) {
          const v = saved?.roles?.[role]?.[p]
          if (typeof v === 'boolean') table.roles[role][p] = v
        }
      }
      table.users = (saved?.users ?? []).filter((o) => isPermission(o.permission))
    } catch {
      // Nothing saved (or storage blocked): the default permissions.
    }
    return table
  }
  const write = (table: PermissionTable) => localStorage.setItem(LOCAL_KEY, JSON.stringify(table))
  return {
    async mine(userId, role) {
      return effective(read(), userId, role)
    },
    async load() {
      return read()
    },
    async setRole(role, permission, allowed) {
      const table = read()
      table.roles[role][permission] = allowed
      write(table)
    },
    async setUser(userId, permission, allowed) {
      const table = read()
      table.users = table.users.filter((o) => !(o.user_id === userId && o.permission === permission))
      if (allowed !== null) table.users.push({ user_id: userId, permission, allowed })
      write(table)
    },
  }
}

export const permissions: PermissionsService = supabase ? supabasePermissions(supabase) : localPermissions()

// ───────────── Permissions of the signed-in account, for the navigation and buttons ─────────────

let granted: ReadonlySet<Permission> = new Set()
let signedIn: { id: string; role: UserRole } | null = null
const listeners = new Set<() => void>()
// Demo mode: the local order store checks the same rights as the database triggers.
setDemoPermissionCheck((p) => granted.has(p as Permission))

/** Loads the permissions of the account that just signed in (null after sign out). */
export async function loadMyPermissions(user: { id: string; role: UserRole } | null) {
  signedIn = user
  granted = new Set(user ? await permissions.mine(user.id, user.role).catch(() => []) : [])
  listeners.forEach((l) => l())
}

/** Reloads them after a change on the Permissions page (the Admin may have changed their own rights). */
export const reloadMyPermissions = () => loadMyPermissions(signedIn)

/** can('stock'): whether the signed-in account has this permission. Re-renders when the permissions change. */
export function usePermissions() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => granted,
  )
  return { can: (p: Permission) => current.has(p) }
}
