import { useEffect, useState } from 'react'
import SpotifyMusic from './SpotifyMusic'
import YouTubeMusic from './YouTubeMusic'

export default function Music() {
  const [showSpotify, setShowSpotify] = useState(false)

  useEffect(() => {
    const routeYouTubeCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string; activeTab?: string }>).detail
      if (detail?.provider === 'youtube') setShowSpotify(false)
    }
    window.addEventListener('visionary:voice-command', routeYouTubeCommand)
    return () => window.removeEventListener('visionary:voice-command', routeYouTubeCommand)
  }, [])

  return (
    <>
      <div style={{ display: showSpotify ? 'none' : 'block' }} aria-hidden={showSpotify}>
        <YouTubeMusic onSpotify={() => setShowSpotify(true)} />
      </div>
      {showSpotify && <SpotifyMusic initialShowSoundCloud={false} />}
    </>
  )
}
