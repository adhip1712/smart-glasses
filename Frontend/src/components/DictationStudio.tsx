import { useState } from 'react'

export default function DictationStudio() {
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)

  const copyText = async () => {
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="min-h-screen p-5 md:p-8 lg:p-10">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-cyan-300">
            VOICE WORKSPACE
          </div>
          <h1 className="font-display text-2xl font-bold tracking-wide text-white md:text-3xl">Dictation Studio</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
            Speak naturally in your chosen language. Interim speech appears live, then the AI proofreading endpoint
            polishes grammar and punctuation while preserving your meaning and language.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="rounded-2xl border border-cyan-400/15 bg-slate-950/70 p-4 shadow-2xl md:p-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <label htmlFor="dictation-studio-text" className="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
                Your dictation
              </label>
              <span className="font-mono text-[10px] text-white/35">{text.trim() ? text.trim().split(/\s+/).length : 0} words</span>
            </div>
            <textarea
              id="dictation-studio-text"
              value={text}
              onChange={event => { setText(event.target.value); setCopied(false) }}
              placeholder="Click here to focus this editor, then use the floating Voice button to start speaking…"
              rows={15}
              className="w-full resize-y rounded-xl border border-white/10 bg-black/30 p-4 text-sm leading-7 text-white outline-none transition placeholder:text-white/25 focus:border-cyan-400/40"
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => { setText(''); setCopied(false) }} className="rounded-lg border border-white/10 px-4 py-2.5 text-xs font-semibold text-white/65 transition hover:bg-white/5">
                Clear
              </button>
              <button type="button" onClick={() => void copyText()} disabled={!text.trim()} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-40">
                {copied ? 'Copied' : 'Copy text'}
              </button>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">How to use</h2>
              <ol className="space-y-3 text-sm leading-6 text-white/60">
                <li><span className="mr-2 text-cyan-300">01</span>Choose your speech language using the selector beside the floating Voice button.</li>
                <li><span className="mr-2 text-cyan-300">02</span>Click inside the editor, then press <strong className="text-white/85">Voice</strong>.</li>
                <li><span className="mr-2 text-cyan-300">03</span>Speak naturally. Live interim words show above the microphone controls.</li>
                <li><span className="mr-2 text-cyan-300">04</span>Pause or press Stop. The text is polished and inserted here when the backend supports it.</li>
              </ol>
            </div>
            <div className="rounded-2xl border border-purple-400/15 bg-purple-400/[0.04] p-5">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-purple-200">Designed to preserve meaning</h2>
              <p className="text-sm leading-6 text-white/55">
                Proofreading should fix clarity, grammar, and punctuation—not summarize your words, answer your prompt,
                or translate it into another language.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}
