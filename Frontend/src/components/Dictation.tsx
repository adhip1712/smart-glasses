import { useEffect, useRef, useState } from 'react'

declare global { interface Window { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any } }
type Note = { id: string; title: string; language: string; text: string; rawText: string }
const KEY = 'visionary_dictation_notes_v1'
const languages = [
['en-US','English (US)'],['en-IN','English (India)'],['en-GB','English (UK)'],['kn-IN','Kannada'],['hi-IN','Hindi'],['ta-IN','Tamil'],['te-IN','Telugu'],['ml-IN','Malayalam'],['mr-IN','Marathi'],['bn-IN','Bengali'],['gu-IN','Gujarati'],['pa-IN','Punjabi'],['ur-IN','Urdu'],['or-IN','Odia'],['as-IN','Assamese'],['ne-NP','Nepali'],['si-LK','Sinhala'],['ar-SA','Arabic'],['zh-CN','Chinese (Simplified)'],['zh-TW','Chinese (Traditional)'],['ja-JP','Japanese'],['ko-KR','Korean'],['es-ES','Spanish'],['es-MX','Spanish (Mexico)'],['fr-FR','French'],['fr-CA','French (Canada)'],['de-DE','German'],['it-IT','Italian'],['pt-BR','Portuguese (Brazil)'],['pt-PT','Portuguese (Portugal)'],['ru-RU','Russian'],['uk-UA','Ukrainian'],['nl-NL','Dutch'],['sv-SE','Swedish'],['da-DK','Danish'],['fi-FI','Finnish'],['no-NO','Norwegian'],['pl-PL','Polish'],['cs-CZ','Czech'],['sk-SK','Slovak'],['hu-HU','Hungarian'],['ro-RO','Romanian'],['bg-BG','Bulgarian'],['el-GR','Greek'],['tr-TR','Turkish'],['he-IL','Hebrew'],['fa-IR','Persian'],['id-ID','Indonesian'],['ms-MY','Malay'],['th-TH','Thai'],['vi-VN','Vietnamese'],['fil-PH','Filipino'],['sw-KE','Swahili'],['af-ZA','Afrikaans'],['sq-AL','Albanian'],['am-ET','Amharic'],['hy-AM','Armenian'],['az-AZ','Azerbaijani'],['eu-ES','Basque'],['be-BY','Belarusian'],['bs-BA','Bosnian'],['my-MM','Burmese'],['ca-ES','Catalan'],['hr-HR','Croatian'],['et-EE','Estonian'],['ka-GE','Georgian'],['is-IS','Icelandic'],['ga-IE','Irish'],['kk-KZ','Kazakh'],['km-KH','Khmer'],['lo-LA','Lao'],['lv-LV','Latvian'],['lt-LT','Lithuanian'],['mk-MK','Macedonian'],['mt-MT','Maltese'],['mn-MN','Mongolian'],['ps-AF','Pashto'],['sr-RS','Serbian'],['sl-SI','Slovenian'],['so-SO','Somali'],['uz-UZ','Uzbek'],['cy-GB','Welsh'],['zu-ZA','Zulu']
] as const
function initialNotes(): Note[] {
  try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(value) && value.length) return value } catch {}
  return [{ id: String(Date.now()), title: 'New dictation', language: 'en-US', text: '', rawText: '' }]
}
export default function Dictation() {
  const [notes, setNotes] = useState<Note[]>(initialNotes)
  const [activeId, setActiveId] = useState(() => initialNotes()[0].id)
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [format, setFormat] = useState('natural')
  const [status, setStatus] = useState('Ready. Start speaking or type a note.')
  const recognition = useRef<any>(null)
  const base = useRef('')
  const finals = useRef('')
  const active = notes.find(n => n.id === activeId) || notes[0]
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(notes)) }, [notes])
  useEffect(() => () => { try { recognition.current?.abort() } catch {} }, [])
  const patch = (values: Partial<Note>) => setNotes(prev => prev.map(n => n.id === active.id ? { ...n, ...values } : n))
  const newNote = () => { const n = { id: String(Date.now()) + Math.random().toString(36).slice(2,6), title: 'New dictation', language: active.language, text: '', rawText: '' }; setNotes(p => [...p,n]); setActiveId(n.id); setStatus('New note created.') }
  const start = () => {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Speech) { setStatus('Speech recognition is unavailable in this browser. Try a Chromium browser or type your note.'); return }
    if (listening) return
    try {
      const r = new Speech(); r.lang = active.language; r.continuous = true; r.interimResults = true
      base.current = active.text.trim(); finals.current = ''
      r.onstart = () => { setListening(true); setStatus('Listening… interim words are replaced, not appended repeatedly.') }
      r.onresult = (event: any) => {
        let f = '', interim = ''
        for (let i=0;i<event.results.length;i++) { const item=event.results[i]; if(item.isFinal) f += item[0]?.transcript + ' '; else interim += item[0]?.transcript + ' ' }
        finals.current = f.trim()
        const raw = [base.current, finals.current].filter(Boolean).join(' ').trim()
        patch({ text: [raw, interim.trim()].filter(Boolean).join(' ').trim(), rawText: raw })
      }
      r.onerror = (e: any) => setStatus(e.error === 'not-allowed' ? 'Microphone permission denied. Allow microphone access in browser settings.' : 'Speech recognition error: ' + (e.error || 'unknown'))
      r.onend = () => { const raw=[base.current,finals.current].filter(Boolean).join(' ').trim(); patch({text:raw,rawText:raw}); setListening(false); recognition.current=null; setStatus(raw ? 'Transcript saved. Use AI Improve to edit it.' : 'No finalized speech received. Try again or type your note.') }
      recognition.current = r; r.start()
    } catch(e) { setListening(false); setStatus(e instanceof Error ? e.message : 'Could not start recognition.') }
  }
  const stop = () => { try { recognition.current?.stop() } catch { setListening(false) } }
  const improve = async () => {
    if (!active.text.trim() || busy) return
    setBusy(true); setStatus('AI is understanding and editing your note…')
    try {
      const response = await fetch('/api/dictation/rewrite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:active.text,language:active.language,format})})
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || data.message || 'AI request failed ('+response.status+')')
      const text = String(data.text || '').trim(); if (!text) throw new Error('AI returned an empty note.')
      patch({rawText:active.rawText || active.text,text,title:active.title === 'New dictation' ? (text.split(/[.!?\n]/)[0].slice(0,40) || 'Dictation note') : active.title})
      setStatus('AI improvement complete. Review the result; restore the raw transcript if needed.')
    } catch(e) { setStatus(e instanceof Error ? e.message : 'AI improvement failed. Check backend and GROQ_API_KEY.') }
    finally { setBusy(false) }
  }
  const copy = async () => { try { await navigator.clipboard.writeText(active.text); setStatus('Copied to clipboard.') } catch { setStatus('Clipboard blocked. Select and copy the text manually.') } }
  const download = () => { const a=document.createElement('a'); const url=URL.createObjectURL(new Blob([active.text],{type:'text/plain;charset=utf-8'})); a.href=url; a.download='dictation.txt'; a.click(); URL.revokeObjectURL(url) }
  return <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="font-mono text-[10px] tracking-[0.25em] text-cyan-400 uppercase">Speech · Multilingual AI</div><h1 className="font-display text-2xl font-bold tracking-widest text-white mt-2">DICTATION STUDIO</h1><p className="text-sm text-white/45 mt-2 max-w-2xl">Speak naturally. AI cleans up repetitions, understands corrections from context, and formats notes without a fixed command list.</p></div><button onClick={newNote} className="px-4 py-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-300 text-xs font-display">+ NEW TAB</button></div>
    <div className="flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Dictation notes">{notes.map(n=><button key={n.id} role="tab" aria-selected={n.id===active.id} onClick={()=>setActiveId(n.id)} className={`rounded-lg border px-4 py-2 text-xs whitespace-nowrap ${n.id===active.id?'border-cyan-400/50 bg-cyan-400/10 text-cyan-300':'border-white/10 text-white/50'}`}>{n.title}</button>)}</div>
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-5"><section className="glass rounded-2xl p-4 md:p-6 space-y-4">
      <div className="flex flex-col md:flex-row gap-3 md:items-end md:justify-between"><label className="flex flex-col gap-2 text-[10px] font-mono tracking-widest text-white/45 uppercase">Spoken language<select value={active.language} disabled={listening} onChange={e=>patch({language:e.target.value})} className="min-w-56 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white normal-case tracking-normal">{languages.map(([code,label])=><option key={code} value={code}>{label}</option>)}</select></label><div className="flex flex-wrap gap-2">{listening?<button onClick={stop} className="rounded-lg bg-rose-500/15 border border-rose-400/40 px-4 py-2 text-xs text-rose-300">■ STOP</button>:<button onClick={start} className="rounded-lg bg-cyan-400/15 border border-cyan-400/40 px-4 py-2 text-xs text-cyan-300">● START DICTATION</button>}<button onClick={()=>void improve()} disabled={busy||!active.text.trim()} className="rounded-lg bg-purple-500/15 border border-purple-400/40 px-4 py-2 text-xs text-purple-300 disabled:opacity-40">{busy?'AI WORKING…':'✦ AI IMPROVE'}</button></div></div>
      <label className="flex flex-col gap-2 text-[10px] font-mono tracking-widest text-white/45 uppercase">Output style<select value={format} onChange={e=>setFormat(e.target.value)} className="w-full md:w-64 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white normal-case tracking-normal"><option value="natural">Natural clean writing</option><option value="bullets">Bullet points</option><option value="paragraph">Polished paragraphs</option></select></label>
      <textarea value={active.text} onChange={e=>patch({text:e.target.value})} placeholder="Your speech or typed note appears here…" spellCheck rows={13} className="w-full min-h-72 resize-y rounded-xl border border-white/10 bg-slate-950/70 p-4 text-sm leading-7 text-white placeholder:text-white/25 focus:border-cyan-400/40 focus:outline-none"/>
      <div className="flex flex-wrap gap-2"><button onClick={()=>void copy()} disabled={!active.text} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 disabled:opacity-30">Copy</button><button onClick={download} disabled={!active.text} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 disabled:opacity-30">Download .txt</button><button onClick={()=>patch({text:active.rawText})} disabled={!active.rawText||active.rawText===active.text} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 disabled:opacity-30">Restore raw transcript</button><button onClick={()=>{if(confirm('Clear this note?'))patch({text:'',rawText:'',title:'New dictation'})}} className="rounded-lg border border-rose-400/20 px-3 py-2 text-xs text-rose-300/80">Clear note</button></div><p className="text-xs text-white/40" role="status">{status}</p>
    </section><aside className="glass rounded-2xl p-5 h-fit space-y-4"><div className="font-mono text-[10px] tracking-[0.2em] text-purple-300 uppercase">Context-aware editing</div><h2 className="font-display text-lg font-semibold text-white">Meaning first</h2><ul className="space-y-3 text-sm leading-6 text-white/55 list-disc pl-5"><li>Understands corrections and abandoned thoughts from context, not a giant hard-coded command list.</li><li>Keeps the selected language and script; it does not translate unless asked.</li><li>Removes clear false starts while avoiding guesses about missing facts.</li><li>Bullet mode turns spoken notes into readable points.</li></ul><div className="rounded-lg border border-amber-300/15 bg-amber-300/5 p-3 text-xs leading-5 text-amber-100/60">AI can misinterpret a phrase. The raw transcript is retained so you can restore it and review changes.</div></aside></div>
  </div>
}
