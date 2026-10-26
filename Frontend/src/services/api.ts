// Shared backend access for every Visionary Nexus screen.
// The backend host is derived from the page location so the frontend works on
// any laptop LAN address; VITE_API_URL can override it for special setups.

const configured = (import.meta.env.VITE_API_URL as string | undefined) || ''

// Use same-origin /api requests by default. Vite proxies these to FastAPI on
// port 8000, avoiding a second hard-coded backend port and working on any LAN IP.
// Set VITE_API_URL only when the frontend is hosted separately from the API.
export const API_URL = configured ? configured.replace(/\/+$/, '') : ''

const TOKEN_KEY = 'visionary_token'
const USER_KEY = 'visionary_user'

export interface AuthUser {
  id: number
  email: string
  display_name: string | null
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setSession(token: string | null, user: AuthUser | null): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token)
    } else {
      window.localStorage.removeItem(TOKEN_KEY)
    }
    if (user) {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      window.localStorage.removeItem(USER_KEY)
    }
  } catch {
    // Storage can be unavailable in private mode; the app still works anonymously.
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** fetch() with the JWT attached when one is stored. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {})
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  Object.entries(authHeaders()).forEach(([key, value]) => headers.set(key, value))
  return fetch(`${API_URL}${path}`, { ...init, headers })
}

/** Parse a JSON body without throwing on empty responses. */
export async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}
