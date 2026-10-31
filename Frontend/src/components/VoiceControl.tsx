import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { correctDictation, isTextEntry } from '../services/dictation'
import { stopSpeaking } from '../services/speech'

interface VoiceControlProps {
  onCommand: (text: string) => void
}

const SPEECH_LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'kn-IN', label: 'Kannada' },
  { code: 'ta-IN', label: 'Tamil' },
  { code: 'te-IN', label: 'Telugu' },
  { code: 'ml-IN', label: 'Malayalam' },
  { code: 'mr-IN', label: 'Marathi' },
  { code: 'bn-IN', label: 'Bengali' },
  { code: 'gu-IN', label: 'Gujarati' },
  { code: 'pa-IN', label: 'Punjabi' },
  { code: 'ur-IN', label: 'Urdu' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'fr-FR', label: 'French' },
  { code: 'de-DE', label: 'German' },
  { code: 'pt-BR', label: 'Portuguese' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'ko-KR', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
]

function normalizeWakeText(value: string) {
  return value.toLowerCase().replace(/[.,!?;:]/g, ' ').split(' ').filter(Boolean).join(' ')
}

function editDistanceOne(a: string, b: string) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else { i++; j++ }
  }
  if (i < a.length || j < b.length) edits++
  return edits <= 1
}

function findWakePhrase(transcript: string, wakeWord: string, sensitivity: string) {
  const text = normalizeWakeText(transcript)
  const phrase = normalizeWakeText(wakeWord || 'Vision')
  // Match the configured phrase as whole words, never as a substring (e.g. "vision" in "television").
  if (!phrase) return -1
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`).exec(text)
  if (match) return match.index + (match[0].startsWith(' ') ? 1 : 0)
  if (sensitivity !== 'high') return -1
  const words = text.split(' ')
  const target = phrase.split(' ')
  for (let index = 0; index <= words.length - target.length; index += 1) {
    const candidate = words.slice(index, index + target.length)
    const matches = candidate.every((word, offset) =>
      word === target[offset] || (target[offset].length >= 5 && editDistanceOne(word, target[offset])),
    )
    if (matches) return words.slice(0, index).join(' ').length + (index ? 1 : 0)
  }
  return -1
}

function insertIntoField(target: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? target.value.length
  const before = target.value.slice(0, start)
  const after = target.value.slice(end)
  const separator = before && !/\\s$/.test(before) ? ' ' : ''
  const insertion = separator + text
  const next = before + insertion + after
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set
  if (setter) setter.call(target, next)
  else target.value = next
  target.dispatchEvent(new Event('input', { bubbles: true }))
  const caret = before.length + insertion.length
  target.setSelectionRange(caret, caret)
  target.focus()
}

export default function VoiceControl({ onCommand }: VoiceControlProps) {
  const [listening, setListening] = useState(false)
  const [wakeListening, setWakeListening] = useState(false)
  const [wakeWord, setWakeWord] = useState('Vision')
  const [wakeSensitivity, setWakeSensitivity] = useState('high')
  const [status, setStatus] = useState('')
  const [language, setLanguage] = useState('en-IN')
  const [liveTranscript, setLiveTranscript] = useState('')
  const recognitionRef = useRef<any>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const wakeRecognitionRef = useRef<any>(null)
  const wakeListeningRef = useRef(false)
  const wakeRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeWordRef = useRef('Vision')
  const wakeSensitivityRef = useRef('high')
  const toggleRef = useRef<(() => void) | null>(null)
  const targetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const lastTextTargetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const transcriptRef = useRef('')
  const interimRef = useRef('')
  const languageRef = useRef(language)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    languageRef.current = language
  }, [language])

  useEffect(() => {
    wakeWordRef.current = wakeWord
    wakeSensitivityRef.current = wakeSensitivity
  }, [wakeWord, wakeSensitivity])

  useEffect(() => {
    let alive = true
    apiFetch('/api/settings').then(readJson<{ wake_word?: string; wake_word_sensitivity?: string }>)
      .then(settings => {
        if (!alive) return
        if (settings?.wake_word) setWakeWord(settings.wake_word)
        if (settings?.wake_word_sensitivity) setWakeSensitivity(settings.wake_word_sensitivity)
      }).catch(() => {
        try {
          const settings = JSON.parse(localStorage.getItem('visionary-wake-settings') || '{}')
          if (settings.wake_word) setWakeWord(settings.wake_word)
          if (settings.wake_word_sensitivity) setWakeSensitivity(settings.wake_word_sensitivity)
        } catch { /* use defaults */ }
      })
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ wake_word?: string; wake_word_sensitivity?: string }>).detail
      if (detail?.wake_word) setWakeWord(detail.wake_word)
      if (detail?.wake_word_sensitivity) setWakeSensitivity(detail.wake_word_sensitivity)
    }
    window.addEventListener('visionary:wake-settings-updated', update)
    return () => { alive = false; window.removeEventListener('visionary:wake-settings-updated', update) }
  }, [])

  useEffect(() => {
    const rememberTextTarget = (event: FocusEvent) => {
      const target = event.target
      if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && isTextEntry(target)) {
        lastTextTargetRef.current = target
      }
    }
    document.addEventListener('focusin', rememberTextTarget)
    return () => document.removeEventListener('focusin', rememberTextTarget)
  }, [])

  useEffect(() => {
    const startDictationFromAssistant = () => {
      const remembered = lastTextTargetRef.current
      if (remembered?.isConnected) targetRef.current = remembered
      toggleRef.current?.()
    }
    window.addEventListener('visionary:start-dictation', startDictationFromAssistant)
    return () => window.removeEventListener('visionary:start-dictation', startDictationFromAssistant)
  }, [])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('visionary:dictation-state', { detail: { listening } }))
  }, [listening])

  useEffect(() => () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    if (wakeRestartRef.current) clearTimeout(wakeRestartRef.current)
    wakeListeningRef.current = false
    try { recognitionRef.current?.abort() } catch { /* browser may already have closed it */ }
    try { mediaRecorderRef.current?.stop() } catch { /* recorder may already have stopped */ }
    mediaStreamRef.current?.getTracks().forEach(track => track.stop())
    try { wakeRecognitionRef.current?.abort() } catch { /* browser may already have closed it */ }
  }, [])

  const processTranscript = async (rawTranscript: string, selectedLanguage: string) => {
    const raw = rawTranscript.replace(/\\s+/g, ' ').trim()
    setLiveTranscript('')
    if (!raw) {
      setStatus('Could not hear that clearly. Try again.')
      return
    }
    const target = targetRef.current
    if (target && target.isConnected) {
      setStatus('Polishing dictation with AI…')
      let transcript = selectedLanguage.startsWith('en-') ? correctDictation(raw) : raw
      try {
        const response = await apiFetch('/api/dictation/polish', {
          method: 'POST',
          body: JSON.stringify({
            text: raw,
            language: SPEECH_LANGUAGES.find(item => item.code === selectedLanguage)?.label || selectedLanguage,
          }),
        })
        const data = await readJson<{ success?: boolean; polished_text?: string; fallback?: boolean }>(response)
        const polished = data?.polished_text?.trim() || ''
        const likelyOmission = raw.length >= 180 && polished.length < raw.length * 0.72
        // Keep the local correction/original transcript if the model appears to have dropped content.
        if (polished && !data?.fallback && !likelyOmission) transcript = polished
      } catch (error) {
        console.warn('AI dictation polishing unavailable; using local correction.', error)
      }
      if (!target.isConnected) return
      insertIntoField(target, transcript)
      setStatus('Dictation inserted. Review it before submitting.')
    } else {
      onCommand(raw)
      setStatus('Understanding your request…')
    }
  }

  const stopWakeListening = () => {
    wakeListeningRef.current = false
    setWakeListening(false)
    if (wakeRestartRef.current) clearTimeout(wakeRestartRef.current)
    wakeRestartRef.current = null
    try { wakeRecognitionRef.current?.abort() } catch { /* browser may already have closed it */ }
    setStatus('Wake-word listening stopped.')
  }

  const startWakeListening = () => {
    stopSpeaking()
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setStatus('Wake-word listening needs a supported browser such as Chrome.')
      return
    }
    if (listening) {
      try { recognitionRef.current?.stop() } catch { /* already stopped */ }
      setListening(false)
    }
    wakeListeningRef.current = true
    setWakeListening(true)
    setStatus(`Listening for “${wakeWordRef.current}”. Keep Visionary Nexus open.`)
    const recognition = new SpeechRecognition()
    recognition.lang = languageRef.current
    recognition.continuous = true
    recognition.interimResults = true
    wakeRecognitionRef.current = recognition
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results as any[]).map(result => String(result?.[0]?.transcript || '')).join(' ')
      const at = findWakePhrase(transcript, wakeWordRef.current, wakeSensitivityRef.current)
      if (at < 0) return
      const normalized = normalizeWakeText(transcript)
      const phrase = normalizeWakeText(wakeWordRef.current)
      const exactAt = normalized.indexOf(phrase, at)
      const command = exactAt >= 0 ? normalized.slice(exactAt + phrase.length).trim() : normalized.slice(at).split(' ').slice(phrase.split(' ').length).join(' ').trim()
      const last = event.results[event.results.length - 1]
      if (command.length > 1 && last?.isFinal) {
        setStatus(`Wake word detected. Running: ${command}`)
        try { recognition.stop() } catch { /* auto-restart after onend */ }
        onCommand(command)
      } else {
        setStatus(`Wake word detected. Say your command…`)
      }
    }
    recognition.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        wakeListeningRef.current = false
        setWakeListening(false)
        setStatus('Microphone permission is blocked. Allow microphone access in your browser.')
      }
    }
    recognition.onend = () => {
      if (wakeListeningRef.current) {
        wakeRestartRef.current = setTimeout(() => startWakeListening(), 450)
      }
    }
    try { recognition.start() } catch {
      wakeListeningRef.current = false
      setWakeListening(false)
      setStatus('Microphone is busy. Try again in a moment.')
    }
  }

  const toggleWakeListening = () => {
    if (wakeListeningRef.current) stopWakeListening()
    else startWakeListening()
  }

  const toggle = () => {
    stopSpeaking()
    if (wakeListeningRef.current) stopWakeListening()
    if (listening) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        setStatus('Transcribing your recording…')
        recorder.stop()
      } else {
        try { recognitionRef.current?.stop() } catch { /* recognition may already have stopped */ }
        setListening(false)
        setStatus('Finishing your dictation…')
      }
      return
    }

    const active = document.activeElement
    const activeTextTarget = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && isTextEntry(active)
    targetRef.current = activeTextTarget
      ? active as HTMLInputElement | HTMLTextAreaElement
      : lastTextTargetRef.current?.isConnected
        ? lastTextTargetRef.current
        : null

    // Prefer server-side Whisper for text-field dictation. Commands and wake-word
    // listening still use browser recognition to avoid changing their behavior.
    if (targetRef.current && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined') {
      const selectedLanguage = languageRef.current
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          mediaStreamRef.current = stream
          audioChunksRef.current = []
          const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
          const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
          mediaRecorderRef.current = recorder
          recorder.ondataavailable = event => { if (event.data.size > 0) audioChunksRef.current.push(event.data) }
          recorder.onerror = () => setStatus('Audio recording failed. Check microphone access and try again.')
          recorder.onstop = async () => {
            const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
            audioChunksRef.current = []
            stream.getTracks().forEach(track => track.stop())
            mediaStreamRef.current = null
            mediaRecorderRef.current = null
            setListening(false)
            if (!blob.size) { setStatus('No audio was captured. Try again.'); return }
            setStatus('Transcribing with Whisper…')
            const form = new FormData()
            form.append('audio', blob, blob.type.includes('mp4') ? 'dictation.m4a' : 'dictation.webm')
            form.append('language', selectedLanguage)
            try {
              const response = await apiFetch('/api/voice/transcribe', { method: 'POST', body: form })
              const result = await readJson<{ success?: boolean; text?: string; engine?: string; message?: string }>(response)
              if (response.ok && result?.success && result.text?.trim()) {
                setStatus(`Transcribed with ${result.engine || 'cloud speech recognition'}; polishing…`)
                await processTranscript(result.text, selectedLanguage)
              } else {
                const BrowserRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
                if (BrowserRecognition) {
                  setStatus('Whisper unavailable; falling back to browser recognition…')
                  const fallback = new BrowserRecognition()
                  fallback.lang = selectedLanguage
                  fallback.continuous = false
                  fallback.interimResults = false
                  fallback.onresult = (event: any) => {
                    const transcript = Array.from(event.results as any[]).map(item => String(item?.[0]?.transcript || '')).join(' ').trim()
                    void processTranscript(transcript, selectedLanguage)
                  }
                  fallback.onerror = () => setStatus(result?.message || 'Both transcription methods failed. Check microphone and backend settings.')
                  fallback.start()
                } else {
                  setStatus(result?.message || 'Cloud transcription is unavailable. Check the backend STT configuration.')
                }
              }
            } catch (error) {
              console.warn('Cloud transcription request failed.', error)
              const BrowserRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
              if (BrowserRecognition) {
                setStatus('Cloud transcription failed; falling back to browser recognition…')
                const fallback = new BrowserRecognition()
                fallback.lang = selectedLanguage
                fallback.continuous = false
                fallback.interimResults = false
                fallback.onresult = (event: any) => {
                  const transcript = Array.from(event.results as any[]).map(item => String(item?.[0]?.transcript || '')).join(' ').trim()
                  void processTranscript(transcript, selectedLanguage)
                }
                fallback.onerror = () => setStatus('Both transcription methods failed. Check microphone and backend settings.')
                fallback.start()
              } else {
                setStatus('Cloud transcription failed. Check the backend connection and try again.')
              }
            }
          }
          recorder.start(250)
          setListening(true)
          setStatus('Recording dictation for Whisper… tap Stop when finished.')
        } catch (error) {
          console.warn('Microphone recording unavailable.', error)
          setStatus('Microphone access failed. Allow microphone access and try again.')
          setListening(false)
        }
      })()
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setStatus('Voice input needs a supported browser with microphone access.')
      return
    }

    transcriptRef.current = ''
    interimRef.current = ''
    setLiveTranscript('')
    const selectedLanguage = languageRef.current
    const recognition = new SpeechRecognition()
    recognition.lang = selectedLanguage
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onstart = () => {
      setListening(true)
      setStatus(targetRef.current ? 'Listening — speak naturally; pauses are okay.' : 'Listening for your request…')
    }

    recognition.onresult = (event: any) => {
      const finalPieces: string[] = []
      const interimPieces: string[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        const phrase = String(result?.[0]?.transcript || '').trim()
        if (!phrase) continue
        if (result.isFinal) finalPieces.push(phrase)
        else interimPieces.push(phrase)
      }
      transcriptRef.current = finalPieces.join(' ').replace(/\\s+/g, ' ').trim()
      interimRef.current = interimPieces.join(' ').replace(/\\s+/g, ' ').trim()
      setLiveTranscript([transcriptRef.current, interimRef.current].filter(Boolean).join(' '))
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = setTimeout(() => {
        try { recognition.stop() } catch { /* recognition may already have stopped */ }
      }, 2600)
      setStatus(targetRef.current ? 'Capturing dictation…' : 'Listening for your request…')
    }

    recognition.onerror = (event: any) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      setStatus(event.error === 'not-allowed' ? 'Microphone permission is blocked.' : 'Voice recognition stopped. Try again.')
      setListening(false)
    }

    recognition.onend = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
      setListening(false)
      const transcript = [transcriptRef.current, interimRef.current].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim()
      transcriptRef.current = ''
      interimRef.current = ''
      void processTranscript(transcript, selectedLanguage)
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      setListening(false)
      setStatus('Microphone is busy. Try again in a moment.')
    }
  }

  toggleRef.current = toggle

  return (
    <div className="fixed bottom-5 right-5 z-50 flex max-w-[min(92vw,28rem)] flex-col items-end gap-2">
      {liveTranscript && (
        <div role="status" aria-live="polite" className="w-full max-h-32 overflow-y-auto rounded-xl border border-cyan-400/20 bg-slate-950/95 px-3 py-2 text-sm text-white/90 shadow-xl">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-cyan-300/70">Live transcript</span>
          {liveTranscript}
        </div>
      )}
      {status && <div role="status" className="rounded-xl border border-cyan-400/20 bg-slate-950/95 px-3 py-2 text-xs text-white/80 shadow-xl">{status}</div>}
      <div className="flex items-center gap-2 rounded-full border border-cyan-400/20 bg-slate-950/95 p-1.5 shadow-xl">
        <label className="sr-only" htmlFor="visionary-speech-language">Dictation language</label>
        <select
          id="visionary-speech-language"
          value={language}
          disabled={listening}
          onChange={event => setLanguage(event.target.value)}
          className="max-w-40 bg-transparent px-2 py-2 text-xs text-white outline-none disabled:opacity-50"
          title="Speech and proofreading language"
        >
          {SPEECH_LANGUAGES.map(item => <option key={item.code} value={item.code} className="bg-slate-900 text-white">{item.label}</option>)}
        </select>
        <button type="button" onClick={toggleWakeListening} aria-pressed={wakeListening} aria-label={wakeListening ? 'Stop wake word listening' : 'Start wake word listening'} title={`Wake word: ${wakeWord}`} className={wakeListening ? 'flex items-center gap-2 rounded-full border border-purple-400/50 bg-purple-500/20 px-3 py-3 text-xs font-medium text-purple-100' : 'flex items-center gap-2 rounded-full border border-purple-400/30 bg-slate-950 px-3 py-3 text-xs font-medium text-purple-100 hover:bg-purple-400/10'}>
          {wakeListening ? 'Wake On' : 'Wake'}
        </button>
        <button type="button" onClick={toggle} aria-label={listening ? 'Stop voice input' : 'Start voice command or dictation'} title="Voice command / dictation" className={listening ? 'flex items-center gap-2 rounded-full border border-red-400/50 bg-red-500/20 px-4 py-3 text-sm font-medium text-red-100' : 'flex items-center gap-2 rounded-full border border-cyan-400/40 bg-slate-950 px-4 py-3 text-sm font-medium text-cyan-100 hover:bg-cyan-400/10'}>
          <span aria-hidden="true">{listening ? '■' : '🎙'}</span>
          {listening ? 'Stop' : 'Voice'}
        </button>
      </div>
    </div>
  )
}
