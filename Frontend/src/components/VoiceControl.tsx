import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { correctDictation, isTextEntry } from '../services/dictation'

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
  const [status, setStatus] = useState('')
  const [language, setLanguage] = useState('en-IN')
  const [liveTranscript, setLiveTranscript] = useState('')
  const recognitionRef = useRef<any>(null)
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
    try { recognitionRef.current?.abort() } catch { /* browser may already have closed it */ }
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

  const toggle = () => {
    if (listening) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      try { recognitionRef.current?.stop() } catch { /* recognition may already have stopped */ }
      setListening(false)
      setStatus('Finishing your dictation…')
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setStatus('Voice input needs a supported browser such as Chrome.')
      return
    }

    const active = document.activeElement
    const activeTextTarget = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && isTextEntry(active)
    targetRef.current = activeTextTarget
      ? active as HTMLInputElement | HTMLTextAreaElement
      : lastTextTargetRef.current?.isConnected
        ? lastTextTargetRef.current
        : null

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
        <button type="button" onClick={toggle} aria-label={listening ? 'Stop voice input' : 'Start voice command or dictation'} title="Voice command / dictation" className={listening ? 'flex items-center gap-2 rounded-full border border-red-400/50 bg-red-500/20 px-4 py-3 text-sm font-medium text-red-100' : 'flex items-center gap-2 rounded-full border border-cyan-400/40 bg-slate-950 px-4 py-3 text-sm font-medium text-cyan-100 hover:bg-cyan-400/10'}>
          <span aria-hidden="true">{listening ? '■' : '🎙'}</span>
          {listening ? 'Stop' : 'Voice'}
        </button>
      </div>
    </div>
  )
}
