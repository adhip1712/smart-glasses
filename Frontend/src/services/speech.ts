import { API_URL } from './api'

/**
 * Speech output for Visionary Nexus.
 * Prefer server-generated ElevenLabs audio; use browser speech only as a fallback.
 * Provider credentials are never sent to the frontend.
 */
let speechRun = 0
let activeAudio: HTMLAudioElement | null = null

type SpeechOptions = {
  onStart?: () => void
  onEnd?: () => void
  onError?: (error: string) => void
}

function cleanSpeechText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#*_>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitSpeech(text: string, maxLength = 1400): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1)
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '))
    if (cut < maxLength * 0.45) cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
    if (cut < maxLength * 0.45) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = maxLength
    else if (/[.?!]/.test(remaining[cut])) cut += 1
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks.filter(Boolean)
}

function playBrowserSpeech(text: string, run: number, onStarted: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (run !== speechRun) return resolve()
    if (typeof window === 'undefined' || !('speechSynthesis' in window) ||
        typeof SpeechSynthesisUtterance === 'undefined') {
      return reject(new Error('Speech output is unavailable in this browser.'))
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = navigator.language || 'en-US'
    utterance.rate = 1
    utterance.pitch = 1
    utterance.volume = 1
    utterance.onstart = onStarted
    utterance.onend = () => resolve()
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted' || run !== speechRun) resolve()
      else reject(new Error(event.error || 'Browser speech failed.'))
    }
    window.speechSynthesis.resume()
    window.speechSynthesis.speak(utterance)
  })
}

async function speakWithCloud(text: string, run: number, onStarted: () => void): Promise<boolean> {
  // Local neural TTS can be slow on first load or on CPU-only machines.
  // Never make the user wait minutes: after 4 seconds, use browser speech.
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(API_URL + '/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    window.clearTimeout(timeout)
    if (!response.ok) return false
    const result = await response.json()
    if (!result?.success || !result.audio_base64 || run !== speechRun) return false

    const audio = new Audio('data:' + (result.content_type || 'audio/mpeg') + ';base64,' + result.audio_base64)
    audio.preload = 'auto'
    activeAudio = audio
    await new Promise<void>((resolve, reject) => {
      audio.onplaying = onStarted
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('Generated audio could not be played.'))
      audio.play().then(() => undefined).catch(reject)
    })
    if (activeAudio === audio) activeAudio = null
    return true
  } catch {
    window.clearTimeout(timeout)
    if (activeAudio) {
      activeAudio.pause()
      activeAudio = null
    }
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

export function speakText(value: string, options: SpeechOptions = {}): boolean {
  const text = cleanSpeechText(value)
  if (!text) return false

  const run = ++speechRun
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel()
  }
  if (activeAudio) {
    activeAudio.pause()
    activeAudio.src = ''
    activeAudio = null
  }

  const chunks = splitSpeech(text)
  void (async () => {
    let didStart = false
    const notifyStarted = () => {
      if (didStart) return
      didStart = true
      options.onStart?.()
    }
    try {
      // Browser speech starts without waiting for a backend request or model
      // inference. Opt into local Kokoro only with VITE_USE_LOCAL_TTS=true.
      const useLocalTts = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_USE_LOCAL_TTS === 'true'
      for (const chunk of chunks) {
        if (run !== speechRun) return
        if (useLocalTts) {
          const localPlayed = await speakWithCloud(chunk, run, notifyStarted)
          if (run !== speechRun) return
          if (localPlayed) continue
        }
        await playBrowserSpeech(chunk, run, notifyStarted)
      }
      if (run === speechRun) options.onEnd?.()
    } catch (error) {
      if (run !== speechRun) return
      options.onError?.(error instanceof Error ? error.message : 'Speech playback failed.')
    }
  })()
  return true
}

export function stopSpeaking(): void {
  speechRun += 1
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel()
  }
  if (activeAudio) {
    activeAudio.pause()
    activeAudio.src = ''
    activeAudio = null
  }
}
