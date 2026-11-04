import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { correctDictation, isTextEntry } from '../services/dictation'
import { stopSpeaking } from '../services/speech'
import { consumeWakeUtterance } from '../services/voiceMusic'

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
  const onCommandRef = useRef(onCommand)
  const listeningRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const wakeRecognitionRef = useRef<any>(null)
  const wakeListeningRef = useRef(false)
  const wakeArmedRef = useRef(false)
  const wakeRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeStableRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeRetryCountRef = useRef(0)
  const wakeStartingRef = useRef(false)
  const startWakeListeningRef = useRef<(() => void) | null>(null)
  const wakeWordRef = useRef('Vision')
  const wakeSensitivityRef = useRef('high')
  const toggleRef = useRef<(() => void) | null>(null)
  const targetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const submitToAIRef = useRef(false)
  const lastTextTargetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const transcriptRef = useRef('')
  const interimRef = useRef('')
  const lastWakeResultIndexRef = useRef(-1)
  const languageRef = useRef(language)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    onCommandRef.current = onCommand
  }, [onCommand])

  useEffect(() => {
    languageRef.current = language
  }, [language])

  useEffect(() => {
    listeningRef.current = listening
  }, [listening])

  const updateListening = (value: boolean) => {
    listeningRef.current = value
    setListening(value)
  }

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
    const startDictationFromAssistant = (event: Event) => {
      const submitToAI = Boolean((event as CustomEvent<{ submitToAI?: boolean }>).detail?.submitToAI)
      submitToAIRef.current = submitToAI
      const remembered = lastTextTargetRef.current
      if (submitToAI) targetRef.current = null
      else if (remembered?.isConnected) targetRef.current = remembered
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
    if (wakeStableRef.current) clearTimeout(wakeStableRef.current)
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
      setStatus('Polishing dictation with AI...')
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
      onCommandRef.current(raw)
      setStatus('Understanding your request...')
    }
  }

  const stopWakeListening = (showStatus = true) => {
    wakeListeningRef.current = false
    setWakeListening(false)
    if (wakeRestartRef.current) clearTimeout(wakeRestartRef.current)
    if (wakeStableRef.current) clearTimeout(wakeStableRef.current)
    wakeRestartRef.current = null
    wakeStableRef.current = null
    wakeStartingRef.current = false
    try { wakeRecognitionRef.current?.abort() } catch { /* browser may already have closed it */ }
    wakeRecognitionRef.current = null
    if (showStatus) setStatus('Wake-word listening stopped.')
  }

  const startWakeListening = () => {
    if (!wakeListeningRef.current || wakeStartingRef.current || wakeRecognitionRef.current) return
    stopSpeaking()
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      wakeListeningRef.current = false
      setWakeListening(false)
      setStatus('Wake-word listening needs a supported browser such as Chrome.')
      return
    }
    if (listeningRef.current || mediaRecorderRef.current?.state === 'recording') {
      wakeListeningRef.current = false
      setWakeListening(false)
      setStatus('Stop voice input before starting wake-word listening.')
      return
    }
    if (recognitionRef.current) {
      try { recognitionRef.current?.stop() } catch { /* already stopped */ }
      updateListening(false)
    }
    wakeStartingRef.current = true
    setStatus(`Listening for "${wakeWordRef.current}". Keep Visionary Nexus open.`)
    const recognition = new SpeechRecognition()
    recognition.lang = languageRef.current
    recognition.continuous = true
    recognition.interimResults = true
    wakeRecognitionRef.current = recognition
    lastWakeResultIndexRef.current = -1
    recognition.onstart = () => {
      wakeStartingRef.current = false
      setWakeListening(true)
      if (wakeStableRef.current) clearTimeout(wakeStableRef.current)
      wakeStableRef.current = setTimeout(() => {
        wakeRetryCountRef.current = 0
        wakeStableRef.current = null
      }, 15000)
      setStatus(`Listening for "${wakeWordRef.current}". Keep Visionary Nexus open.`)
    }
    recognition.onresult = (event: any) => {
      let lastFinalIndex = -1
      for (let index = 0; index < event.results.length; index += 1) {
        if (event.results[index]?.isFinal) lastFinalIndex = index
      }
      if (lastFinalIndex < 0 || lastFinalIndex <= lastWakeResultIndexRef.current) return

      const lastFinal = event.results[lastFinalIndex]
      if (wakeArmedRef.current) {
        const command = consumeWakeUtterance(
          String(lastFinal?.[0]?.transcript || ''),
          wakeWordRef.current,
          wakeSensitivityRef.current,
          true,
        ).command
        lastWakeResultIndexRef.current = lastFinalIndex
        if (command) {
          wakeArmedRef.current = false
          setStatus(`Wake word detected. Running: ${command}`)
          try { recognition.stop() } catch { /* auto-restart after onend */ }
          onCommandRef.current(command)
        }
        return
      }

      const transcript = Array.from(event.results as any[])
        .map(result => String(result?.[0]?.transcript || ''))
        .join(' ')
      const wake = consumeWakeUtterance(
        transcript,
        wakeWordRef.current,
        wakeSensitivityRef.current,
      )
      lastWakeResultIndexRef.current = lastFinalIndex
      if (!wake.matched) return
      if (wake.command) {
        wakeArmedRef.current = false
        setStatus(`Wake word detected. Running: ${wake.command}`)
        try { recognition.stop() } catch { /* auto-restart after onend */ }
        onCommandRef.current(wake.command)
      } else {
        wakeArmedRef.current = wake.armed
        setStatus('Wake word detected. Now say your command.')
      }
    }
    recognition.onerror = (event: any) => {
      const error = String(event?.error || '')
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        wakeListeningRef.current = false
        setWakeListening(false)
        setStatus('Microphone permission is blocked. Allow microphone access in your browser.')
      } else if (error === 'audio-capture') {
        wakeListeningRef.current = false
        setWakeListening(false)
        setStatus('No microphone is available. Connect a microphone and try again.')
      } else if (error !== 'aborted' && wakeListeningRef.current) {
        setStatus(`Wake-word recognition interrupted (${error || 'unknown error'}). Reconnecting...`)
      }
    }
    recognition.onend = () => {
      if (wakeRecognitionRef.current === recognition) wakeRecognitionRef.current = null
      wakeStartingRef.current = false
      if (wakeStableRef.current) clearTimeout(wakeStableRef.current)
      wakeStableRef.current = null
      setWakeListening(false)
      if (wakeListeningRef.current) {
        if (wakeRestartRef.current) clearTimeout(wakeRestartRef.current)
        if (wakeRetryCountRef.current >= 5) {
          wakeListeningRef.current = false
          setStatus('Wake-word listening paused after repeated browser interruptions. Tap Wake to retry.')
          return
        }
        wakeRetryCountRef.current += 1
        const delay = Math.min(400 * (2 ** (wakeRetryCountRef.current - 1)), 8000)
        wakeRestartRef.current = setTimeout(() => {
          wakeRestartRef.current = null
          startWakeListeningRef.current?.()
        }, delay)
      }
    }
    try {
      recognition.start()
    } catch (error) {
      console.warn('Could not start wake-word recognition.', error)
      if (wakeRecognitionRef.current === recognition) wakeRecognitionRef.current = null
      wakeStartingRef.current = false
      wakeListeningRef.current = false
      setWakeListening(false)
      setStatus('Microphone is busy. Try again in a moment.')
    }
  }

  startWakeListeningRef.current = startWakeListening

  const toggleWakeListening = () => {
    const shouldEnable = !wakeListeningRef.current
    try { localStorage.setItem('visionary-wake-enabled', shouldEnable ? 'true' : 'false') } catch { /* storage may be unavailable */ }
    if (shouldEnable) {
      wakeListeningRef.current = true
      wakeRetryCountRef.current = 0
      startWakeListening()
    }
    else stopWakeListening()
  }

  // Restore the user's wake-word preference after a page refresh.
  useEffect(() => {
    let enabled = false
    try { enabled = localStorage.getItem('visionary-wake-enabled') === 'true' } catch { /* storage may be unavailable */ }
    if (enabled) {
      wakeListeningRef.current = true
      startWakeListening()
    }
  }, [])

  useEffect(() => {
    const resumeAfterTabSwitch = () => {
      if (
        document.visibilityState === 'visible' &&
        wakeListeningRef.current &&
        !wakeRecognitionRef.current &&
        !wakeStartingRef.current &&
        !wakeRestartRef.current
      ) {
        startWakeListeningRef.current?.()
      }
    }
    document.addEventListener('visibilitychange', resumeAfterTabSwitch)
    return () => document.removeEventListener('visibilitychange', resumeAfterTabSwitch)
  }, [])

  const toggle = () => {
    stopSpeaking()
    if (wakeListeningRef.current) stopWakeListening()
    if (listening) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        setStatus('Transcribing your recording...')
        recorder.stop()
      } else {
        try { recognitionRef.current?.stop() } catch { /* recognition may already have stopped */ }
        updateListening(false)
        setStatus('Finishing your dictation...')
      }
      return
    }

    const active = document.activeElement
    const activeTextTarget = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && isTextEntry(active)
    if (submitToAIRef.current) {
      targetRef.current = null
      submitToAIRef.current = false
    } else {
      targetRef.current = activeTextTarget
        ? active as HTMLInputElement | HTMLTextAreaElement
        : lastTextTargetRef.current?.isConnected
          ? lastTextTargetRef.current
          : null
    }

    
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
            updateListening(false)
            if (!blob.size) { setStatus('No audio was captured. Try again.'); return }
            setStatus('Transcribing with Whisper...')
            const form = new FormData()
            form.append('audio', blob, blob.type.includes('mp4') ? 'dictation.m4a' : 'dictation.webm')
            form.append('language', selectedLanguage)
            try {
              const response = await apiFetch('/api/voice/transcribe', { method: 'POST', body: form })
              const result = await readJson<{ success?: boolean; text?: string; engine?: string; message?: string }>(response)
              if (response.ok && result?.success && result.text?.trim()) {
                setStatus(`Transcribed with ${result.engine || 'cloud speech recognition'}; polishing...`)
                await processTranscript(result.text, selectedLanguage)
              } else {
                const BrowserRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
                if (BrowserRecognition) {
                  setStatus('Whisper unavailable; falling back to browser recognition...')
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
                setStatus('Cloud transcription failed; falling back to browser recognition...')
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
          updateListening(true)
          setStatus('Recording dictation for Whisper... tap Stop when finished.')
        } catch (error) {
          console.warn('Microphone recording unavailable.', error)
          setStatus('Microphone access failed. Allow microphone access and try again.')
          updateListening(false)
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
      updateListening(true)
      setStatus(targetRef.current ? 'Listening - speak naturally; pauses are okay.' : 'Listening for your request...')
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
      setStatus(targetRef.current ? 'Capturing dictation...' : 'Listening for your request...')
    }

    recognition.onerror = (event: any) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      setStatus(event.error === 'not-allowed' ? 'Microphone permission is blocked.' : 'Voice recognition stopped. Try again.')
      updateListening(false)
    }

    recognition.onend = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
      updateListening(false)
      const transcript = [transcriptRef.current, interimRef.current].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim()
      transcriptRef.current = ''
      interimRef.current = ''
      void processTranscript(transcript, selectedLanguage)
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      updateListening(false)
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
          <span aria-hidden="true">{listening ? 'Stop' : 'Mic'}</span>
          {listening ? 'Stop' : 'Voice'}
        </button>
      </div>
    </div>
  )
}
