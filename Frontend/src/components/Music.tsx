import { useState } from 'react'
import SpotifyMusic from './SpotifyMusic'
import YouTubeMusic from './YouTubeMusic'

export default function Music() {
  const [showSpotify, setShowSpotify] = useState(false)
  return showSpotify
    ? <SpotifyMusic initialShowSoundCloud={false} />
    : <YouTubeMusic onSpotify={() => setShowSpotify(true)} />
}
