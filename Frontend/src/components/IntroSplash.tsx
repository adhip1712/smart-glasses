import { useEffect } from 'react'

type Props = {
  onComplete: () => void
  userName?: string
  userId?: number | string
  avatarUrl?: string | null
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'VN'
}

export default function IntroSplash({ onComplete, userName, userId, avatarUrl }: Props) {
  const identity = userName?.trim() || 'Visionary Nexus'
  const isSignedIn = Boolean(userName?.trim() && userId !== undefined && userId !== null)

  useEffect(() => {
    const timer = window.setTimeout(onComplete, 5200)
    return () => window.clearTimeout(timer)
  }, [onComplete])

  return (
    <main className="vn-identity-intro" aria-label="Preparing your Visionary Nexus workspace">
      <div className="vn-intro-grid" aria-hidden="true" />
      <div className="vn-intro-halo vn-intro-halo-one" aria-hidden="true" />
      <div className="vn-intro-halo vn-intro-halo-two" aria-hidden="true" />
      <div className="vn-intro-core">
        <div className="vn-intro-avatar-stage">
          <div className="vn-intro-orbit vn-intro-orbit-one"><i /><i /><i /></div>
          <div className="vn-intro-orbit vn-intro-orbit-two" />
          {avatarUrl ? (
            <img className="vn-intro-avatar-image" src={avatarUrl} alt={identity + ' avatar'} />
          ) : (
            <div className="vn-intro-avatar">{isSignedIn ? initials(identity) : 'VN'}</div>
          )}
          <div className="vn-intro-scan" />
        </div>
        <p className="vn-intro-overline">{isSignedIn ? 'VISIONARY ONE RECOGNIZES' : 'PERSONAL SPATIAL INTERFACE'}</p>
        <h1>{identity}</h1>
        <p className="vn-intro-id">{isSignedIn ? 'PERSONAL NEXUS ID · VN-' + userId : 'SMART GLASSES'}</p>
        <div className="vn-intro-progress"><span /></div>
        <p className="vn-intro-status">Preparing your spatial workspace</p>
      </div>
      <button className="vn-intro-enter" type="button" onClick={onComplete}>ENTER WORKSPACE <span>↗</span></button>
    </main>
  )
}
