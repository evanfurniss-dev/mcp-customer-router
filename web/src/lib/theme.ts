import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark'
const STORAGE_KEY = 'mcp-customer-router.theme'
const systemPreference = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()
let storage: Storage | undefined
let preference: Theme | null = null

function parsePreference(value: string | null): Theme | null {
  return value === 'light' || value === 'dark' ? value : null
}

try {
  storage = window.localStorage
  preference = parsePreference(storage.getItem(STORAGE_KEY))
} catch {
  // Use the system theme when browser storage is unavailable.
}

let theme: Theme = preference ?? (systemPreference.matches ? 'dark' : 'light')

function applyTheme(next: Theme) {
  document.documentElement.classList.toggle('dark', next === 'dark')
  document.documentElement.style.colorScheme = next
  if (theme === next) return
  theme = next
  for (const listener of listeners) listener()
}

applyTheme(theme)

function followSystem() {
  if (preference === null) applyTheme(systemPreference.matches ? 'dark' : 'light')
}

function syncStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  if (event.storageArea !== null && event.storageArea !== storage) return
  preference = event.key === null ? null : parsePreference(event.newValue)
  applyTheme(preference ?? (systemPreference.matches ? 'dark' : 'light'))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    systemPreference.addEventListener('change', followSystem)
    window.addEventListener('storage', syncStorage)
    followSystem()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      systemPreference.removeEventListener('change', followSystem)
      window.removeEventListener('storage', syncStorage)
    }
  }
}

function setTheme(next: Theme) {
  preference = next
  applyTheme(next)
  try {
    storage?.setItem(STORAGE_KEY, next)
  } catch {
    // Keep this tab's choice even when it cannot be saved.
  }
}

function getTheme() {
  return theme
}

export function useTheme() {
  return { theme: useSyncExternalStore(subscribe, getTheme), setTheme }
}
