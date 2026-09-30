import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import { loadLocalUsers } from './admin'
import type { DeviceSession } from './types'
import { newId } from './id'

/**
 * Appareils connectés (menu Gestion des employés): which tablet or PC is used by whom. Visibility only, no limit.
 * Each browser keeps a device id and an optional name typed on the login screen; while someone is signed in, the app
 * sends a signal every minute. Supabase table device_sessions (migration 20260930060000_devices.sql), or
 * localStorage in demo mode (this device only).
 */
export interface DevicesService {
  /** Every known device, most recently active first. */
  list(): Promise<DeviceSession[]>
  /** Signal that this device is in use by the signed-in account. */
  heartbeat(): Promise<void>
  /** Closes this device's session (Déconnexion). */
  signOut(): Promise<void>
  /** Removes a device from the list; it comes back at its next sign in. */
  remove(id: string): Promise<void>
  subscribe(onChange: () => void): () => void
}

/** Seconds between two signals; a device silent for more than ONLINE_SECONDS is shown as inactive. */
export const HEARTBEAT_SECONDS = 60
export const ONLINE_SECONDS = 150

const DEVICE_KEY = 'smile.device.v1'

interface ThisDevice {
  id: string
  name: string
}

let memory: ThisDevice | null = null

/** This browser's id (created once) and the name given to it. */
export function thisDevice(): ThisDevice {
  if (memory) return memory
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null') as Partial<ThisDevice> | null
    if (saved?.id) return (memory = { id: saved.id, name: saved.name ?? '' })
  } catch {
    // Unreadable: a new id below.
  }
  memory = { id: newId(), name: '' }
  save(memory)
  return memory
}

function save(d: ThisDevice) {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(d))
  } catch {
    // Storage blocked: the id lives for this visit only.
  }
}

/** Name typed on the login screen ("Tablette Caisse"); empty keeps the name already known. */
export function setDeviceName(name: string) {
  memory = { ...thisDevice(), name: name.trim().slice(0, 40) }
  save(memory)
}

/** "Chrome · Android", from the browser's user agent. */
export function describeAgent(agent: string | null): string {
  if (!agent) return ''
  const os = /iPad/.test(agent) ? 'iPad' : /iPhone/.test(agent) ? 'iPhone' : /Android/.test(agent) ? 'Android'
    : /Windows/.test(agent) ? 'Windows' : /Mac OS X|Macintosh/.test(agent) ? 'Mac' : /CrOS/.test(agent) ? 'ChromeOS' : /Linux/.test(agent) ? 'Linux' : ''
  const browser = /Edg\//.test(agent) ? 'Edge' : /SamsungBrowser/.test(agent) ? 'Samsung Internet' : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : ''
  return [browser, os].filter(Boolean).join(' · ')
}

function devicesError(message: string): Error {
  const t = tr()
  if (/device_sessions|list_devices|device_heartbeat|remove_device/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationDevices)
  }
  if (/no_permission|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  return new Error(message)
}

function supabaseDevices(sb: SupabaseClient): DevicesService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw devicesError(res.error.message)
    return res.data
  }
  return {
    async list() {
      return (check(await sb.rpc('list_devices')) as DeviceSession[]).map((d) => ({ ...d, idle_seconds: Number(d.idle_seconds) }))
    },
    async heartbeat() {
      const d = thisDevice()
      check(await sb.rpc('device_heartbeat', { p_device: d.id, p_name: d.name || null, p_agent: navigator.userAgent }))
    },
    async signOut() {
      check(await sb.rpc('device_sign_out', { p_device: thisDevice().id }))
    },
    async remove(id) {
      check(await sb.rpc('remove_device', { p_device: id }))
    },
    subscribe: sharedChannel(sb, 'devices', ['device_sessions']),
  }
}

// ───────────── Demo mode (localStorage) ─────────────

const KEY = 'smile.devices.v1'
const SESSION_KEY = 'smile.session.v1'

type LocalRow = Omit<DeviceSession, 'username' | 'display_name' | 'idle_seconds'>

function localDevices(): DevicesService {
  const listeners = new Set<() => void>()
  const read = (): LocalRow[] => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '[]') as LocalRow[]
    } catch {
      return []
    }
  }
  const write = (rows: LocalRow[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(rows))
    } catch {
      // Not persisted.
    }
    listeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  const me = () => {
    try {
      return localStorage.getItem(SESSION_KEY)
    } catch {
      return null
    }
  }
  return {
    async list() {
      const users = loadLocalUsers()
      const now = Date.now()
      return read()
        .map((r) => {
          const u = users.find((x) => x.id === r.user_id)
          return {
            ...r, username: u?.username ?? '?', display_name: u?.display_name ?? '',
            idle_seconds: Math.max(0, Math.round((now - Date.parse(r.last_seen_at)) / 1000)),
          }
        })
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
    },
    async heartbeat() {
      const userId = me()
      if (!userId) return
      const d = thisDevice()
      const now = new Date().toISOString()
      const rows = read()
      const row = rows.find((r) => r.id === d.id)
      const restart = !row || row.user_id !== userId || row.ended_at !== null
      const next: LocalRow = {
        id: d.id, user_id: userId, device_name: d.name || row?.device_name || null, user_agent: navigator.userAgent,
        started_at: restart ? now : row!.started_at, last_seen_at: now, ended_at: null,
      }
      write([...rows.filter((r) => r.id !== d.id), next])
    },
    async signOut() {
      const now = new Date().toISOString()
      const id = thisDevice().id
      write(read().map((r) => (r.id === id && !r.ended_at ? { ...r, ended_at: now, last_seen_at: now } : r)))
    },
    async remove(id) {
      write(read().filter((r) => r.id !== id))
    },
    subscribe(onChange) {
      const l = () => onChange()
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
}

export const devices: DevicesService = supabase ? supabaseDevices(supabase) : localDevices()

/**
 * While an account is signed in: a signal now, then every minute and whenever the app comes back to the screen.
 * Errors are ignored (database without the migration, network cut): the app keeps working without the list.
 */
export function startPresence(): () => void {
  const beat = () => {
    devices.heartbeat().catch(() => {})
  }
  beat()
  const timer = window.setInterval(beat, HEARTBEAT_SECONDS * 1000)
  const onVisible = () => document.visibilityState === 'visible' && beat()
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
