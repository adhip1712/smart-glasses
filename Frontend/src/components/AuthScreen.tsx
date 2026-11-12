import { useEffect, useState, type FormEvent } from 'react'
import { Capacitor } from '@capacitor/core'
import { API_URL, apiFetch, readJson, setSession, type AuthUser } from '../services/api'

type Props = { onAuthenticated: () => void }

export default function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [backendUrl, setBackendUrl] = useState(() => {
    try { return window.localStorage.getItem('visionary.backend_url') || '' } catch { return '' }
  })
  const [providerError, setProviderError] = useState('')
  const [backendSaveError, setBackendSaveError] = useState('')
  const isNative = Capacitor.isNativePlatform()
  const [providers, setProviders] = useState<{id:string;name:string;configured:boolean}[]>([
    { id: 'google', name: 'Google', configured: false },
    { id: 'facebook', name: 'Facebook', configured: false },
    { id: 'apple', name: 'Apple', configured: false },
    { id: 'microsoft', name: 'Microsoft', configured: false },
    { id: 'github', name: 'GitHub', configured: false },
  ])

  useEffect(() => {
    let active = true
    apiFetch('/api/auth/providers', { headers: { Accept: 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('Provider status unavailable'); return r.json() })
      .then(data => {
        if (active && Array.isArray(data.providers)) {
          const status = new Map(data.providers.map((p: {id:string;name:string;configured:boolean}) => [p.id, p]))
          setProviders(current => current.map(p => ({ ...p, ...(status.get(p.id) || {}) })))
          setProviderError('')
        } else if (active) {
          setProviderError('The backend returned an invalid provider status.')
        }
      })
      .catch(() => {
        if (active && isNative) setProviderError('The app cannot reach its Visionary Nexus backend. Connect it below to load the real provider status.')
      })
    const params = new URLSearchParams(window.location.search)
    if (params.get('oauth_error')) setError('Sign-in was cancelled or could not be completed. Please try again.')
    return () => { active = false }
  }, [isNative])

  async function connectBackend() {
    setBackendSaveError('')
    let candidate = backendUrl.trim()
    while (candidate.endsWith('/')) candidate = candidate.slice(0, -1)
    if (!(candidate.startsWith('http://') || candidate.startsWith('https://'))) {
      setBackendSaveError('Enter a complete API address beginning with http:// or https://.')
      return
    }
    try {
      const response = await fetch(candidate + '/api/auth/providers', {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error('The backend returned HTTP ' + response.status + '.')
      const data = await response.json()
      if (!Array.isArray(data.providers)) throw new Error('This address did not return the Visionary Nexus provider endpoint.')
      window.localStorage.setItem('visionary.backend_url', candidate)
      window.location.reload()
    } catch (err) {
      setBackendSaveError(err instanceof Error
        ? err.message + ' Check the address, server status, and that your phone can reach it.'
        : 'Could not reach this backend address.')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const response = await apiFetch(mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, display_name: displayName }),
      })
      const data = await readJson<{ access_token?: string; user?: AuthUser; detail?: string }>(response)
      if (!response.ok || !data?.access_token || !data.user) {
        throw new Error(data?.detail || 'Authentication failed. Please try again.')
      }
      setSession(data.access_token, data.user)
      onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to Visionary Nexus.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vn-auth-screen min-h-screen w-full flex items-center justify-center bg-black px-5 py-10 text-white">
      <div className="vn-auth-card w-full max-w-md rounded-3xl border border-white bg-white p-7 shadow-none">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center">
            <svg viewBox="0 0 240 220" className="h-full w-full overflow-visible" role="img" aria-label="Visionary Nexus symbol">
              <defs>
                <filter id="vn-auth-neon-glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feColorMatrix in="blur" type="matrix"
                    values="0 0 0 0 0  0 0 0 0 0.65  0 0 0 0 1  0 0 0 0.9 0" result="blueGlow" />
                  <feMerge><feMergeNode in="blueGlow" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <g filter="url(#vn-auth-neon-glow)" fill="none" stroke="#08bfff"
                 strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
                {[0, 120, 240].map((angle) => (
                  <g key={angle} transform={`rotate(${angle} 120 110)`}>
                    <path d="M120 31 C120 52 136 58 151 68 C169 80 174 99 163 116 C153 132 137 137 123 143" />
                  </g>
                ))}
              </g>
              <g fill="#08c5ff" filter="url(#vn-auth-neon-glow)">
                {[0, 120, 240].map((angle) => (
                  <circle key={angle} cx="120" cy="31" r="11"
                    transform={`rotate(${angle} 120 110)`} />
                ))}
              </g>
            </svg>
          </div>
          <div className="text-xl font-semibold tracking-[0.22em]">VISIONARY NEXUS</div>
          <div className="mt-2 text-[10px] tracking-[0.45em] text-cyan-300/70">SMART GLASSES</div>
          <p className="mt-5 text-sm text-slate-400">{mode === 'login' ? 'Sign in to continue to your workspace.' : 'Create your Visionary Nexus account.'}</p>
        </div>

        {isNative && (providerError || !API_URL) && (
          <div className="mb-6 rounded-xl border border-white/15 bg-black/20 p-4">
            <div className="text-xs font-semibold tracking-widest text-white">CONNECT TO BACKEND</div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              The mobile app needs your Visionary Nexus API address before it can check Google and GitHub sign-in.
            </p>
            <input
              type="url"
              value={backendUrl}
              onChange={e => setBackendUrl(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://your-visionary-api-domain"
              className="mt-3 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-3 text-xs text-white outline-none focus:border-cyan-400/60"
            />
            <button type="button" onClick={connectBackend}
              className="mt-2 w-full rounded-lg bg-white px-3 py-3 text-xs font-bold tracking-wider text-black transition hover:bg-slate-200">
              TEST & SAVE BACKEND
            </button>
            {backendSaveError && <p role="alert" className="mt-2 text-[11px] text-red-300">{backendSaveError}</p>}
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              For temporary testing on the same Wi-Fi, enter your computer's LAN address with port 8001. For use away from your computer, use the deployed cloud API address.
            </p>
          </div>
        )}

        <div className="mb-6 grid grid-cols-2 rounded-xl border border-white/10 bg-black/20 p-1">
          <button type="button" onClick={() => { setMode('login'); setError('') }}
            className={`rounded-lg py-2.5 text-xs tracking-widest transition ${mode === 'login' ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-white'}`}>SIGN IN</button>
          <button type="button" onClick={() => { setMode('register'); setError('') }}
            className={`rounded-lg py-2.5 text-xs tracking-widest transition ${mode === 'register' ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-white'}`}>SIGN UP</button>
        </div>

        <div className="mb-5 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {providers.map(provider => (
              <button key={provider.id} type="button" disabled={!provider.configured}
                onClick={() => { window.location.href = API_URL + '/api/auth/oauth/' + provider.id + '/start' }}
                title={provider.configured ? provider.name : provider.name + ' setup required'}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-xs font-semibold text-slate-200 transition hover:border-cyan-400/50 hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-40">
                {provider.name}{!provider.configured && <span className="mt-1 block text-[9px] font-normal text-slate-500">SETUP REQUIRED</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-2 text-[10px] tracking-widest text-slate-500">
            <span className="h-px flex-1 bg-white/10" /><span>OR USE EMAIL</span><span className="h-px flex-1 bg-white/10" />
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {mode === 'register' && (
            <label className="block text-xs text-slate-400">DISPLAY NAME
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={80}
                autoComplete="name" placeholder="Your name"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/60" />
            </label>
          )}
          <label className="block text-xs text-slate-400">EMAIL
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email" placeholder="you@example.com"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/60" />
          </label>
          <label className="block text-xs text-slate-400">PASSWORD
            <input type="password" required minLength={mode === 'register' ? 10 : 1} maxLength={128}
              value={password} onChange={e => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'register' ? 'At least 10 characters' : 'Your password'}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/60" />
          </label>
          {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}
          <button disabled={busy} className="w-full rounded-xl bg-cyan-400 py-3.5 text-xs font-bold tracking-[0.2em] text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-50">
            {busy ? 'PLEASE WAIT...' : mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
          </button>
        </form>
        <p className="mt-5 text-center text-[10px] leading-relaxed text-slate-500">Your account is stored by the Visionary Nexus backend. Passwords are hashed before storage.</p>
      </div>
    </div>
  )
}
