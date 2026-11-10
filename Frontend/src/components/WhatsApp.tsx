import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { apiFetch, readJson } from '../services/api'

type Contact = { name: string; phone: string }
type ContactPicker = { select: (properties: string[], options?: { multiple?: boolean }) => Promise<Array<{ name?: string[]; tel?: string[] }>> }

const STORAGE_KEY = 'visionary_whatsapp_contacts'

function normalizePhone(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

function readContacts(): Contact[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string>
    return Object.entries(value).map(([name, phone]) => ({ name, phone: String(phone) }))
      .filter(contact => contact.name.trim() && contact.phone.trim())
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function saveLocal(contacts: Contact[]) {
  const map: Record<string, string> = {}
  contacts.forEach(contact => { map[contact.name] = contact.phone })
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

function mergeContacts(existing: Contact[], incoming: Contact[]): Contact[] {
  const byPhone = new Map<string, Contact>()
  existing.forEach(contact => byPhone.set(normalizePhone(contact.phone), contact))
  incoming.forEach(contact => {
    const phone = normalizePhone(contact.phone)
    const name = contact.name.trim()
    if (name && phone.length >= 8 && phone.length <= 15) byPhone.set(phone, { name, phone })
  })
  return [...byPhone.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function parseVCard(text: string): Contact[] {
  const cards = text.replace(/\r/g, '').split(/BEGIN:VCARD/i).slice(1)
  return cards.map(card => {
    const name = card.match(/^FN[^:]*:(.*)$/im)?.[1]?.trim()
      || card.match(/^N[^:]*:(.*)$/im)?.[1]?.replace(/;/g, ' ').trim() || ''
    const phone = card.match(/^TEL[^:]*:(.*)$/im)?.[1]?.trim() || ''
    return { name, phone: normalizePhone(phone) }
  }).filter(contact => contact.name && contact.phone.length >= 8 && contact.phone.length <= 15)
}

function parseCSV(text: string): Contact[] {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  if (!rows.length) return []
  const split = (line: string) => {
    const cells: string[] = []
    let current = '', quoted = false
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"' && line[i + 1] === '"' && quoted) { current += '"'; i++ }
      else if (char === '"') quoted = !quoted
      else if (char === ',' && !quoted) { cells.push(current.trim()); current = '' }
      else current += char
    }
    cells.push(current.trim())
    return cells
  }
  const header = split(rows[0]).map(value => value.toLowerCase())
  const nameIndex = header.findIndex(value => /^(name|full name|display name)$/.test(value))
  const phoneIndex = header.findIndex(value => /^(phone|phone number|mobile|mobile number|tel)$/.test(value))
  const hasHeader = nameIndex >= 0 && phoneIndex >= 0
  return rows.slice(hasHeader ? 1 : 0).map(line => {
    const cells = split(line)
    return {
      name: cells[hasHeader ? nameIndex : 0] || '',
      phone: normalizePhone(cells[hasHeader ? phoneIndex : 1] || ''),
    }
  }).filter(contact => contact.name && contact.phone.length >= 8 && contact.phone.length <= 15)
}

export default function WhatsApp({ initialDraft = null, onDraftConsumed }: {
  initialDraft?: { recipient: string; message: string } | null
  onDraftConsumed?: () => void
}) {
  const [contacts, setContacts] = useState<Contact[]>(readContacts)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [notice, setNotice] = useState('Loading your synced contacts…')
  const [busy, setBusy] = useState(false)
  const [businessReady, setBusinessReady] = useState(false)
  const [businessMessage, setBusinessMessage] = useState('')
  const [businessRecipient, setBusinessRecipient] = useState('')
  const [recipientOptedIn, setRecipientOptedIn] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [sendNotice, setSendNotice] = useState('')
  const [draftRecipient, setDraftRecipient] = useState('')
  const [draftMessage, setDraftMessage] = useState('')
  const [draftNotice, setDraftNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => contacts.filter(contact =>
    contact.name.toLowerCase().includes(query.toLowerCase()) || contact.phone.includes(query)
  ), [contacts, query])

  const resolvedRecipient = useMemo(() => {
    const raw = draftRecipient.trim()
    const value = raw.toLowerCase()
    if (!value) return undefined
    const exact = contacts.find(contact => contact.name.toLowerCase() === value || normalizePhone(contact.phone) === normalizePhone(raw))
    if (exact) return exact
    const matches = contacts.filter(contact => contact.name.toLowerCase().includes(value))
    if (matches.length === 1) return matches[0]
    const digits = normalizePhone(raw)
    if (digits.length >= 8 && digits.length <= 15) return { name: raw, phone: digits }
    return undefined
  }, [contacts, draftRecipient])

  useEffect(() => {
    if (!initialDraft) return
    setDraftRecipient(initialDraft.recipient || '')
    setDraftMessage(initialDraft.message || '')
    setDraftNotice('Voice command prepared. Check the recipient and message before opening WhatsApp.')
    onDraftConsumed?.()
  }, [initialDraft?.recipient, initialDraft?.message, onDraftConsumed])

  useEffect(() => {
    let active = true
    apiFetch('/api/whatsapp/status').then(async response => {
      const data = await readJson<{ business?: { configured?: boolean; message?: string } }>(response)
      if (active && response.ok) setBusinessReady(Boolean(data?.business?.configured))
    }).catch(() => { if (active) setBusinessReady(false) })
    apiFetch('/api/whatsapp/contacts').then(async response => {
      const data = await readJson<{ contacts?: Contact[] }>(response)
      if (!active) return
      if (response.ok && Array.isArray(data?.contacts)) {
        const synced = mergeContacts([], data.contacts)
        if (synced.length) {
          setContacts(synced)
          saveLocal(synced)
          setNotice(`Loaded ${synced.length} contacts from your account.`)
        } else {
          const legacy = readContacts()
          if (legacy.length) {
            setContacts(legacy)
            const upload = await apiFetch('/api/whatsapp/contacts', {
              method: 'PUT',
              body: JSON.stringify({ contacts: legacy }),
            })
            if (upload.ok) setNotice(`Migrated ${legacy.length} contacts saved on this browser to your account.`)
            else setNotice('Showing your existing local contacts. Cloud sync could not be completed.')
          } else {
            setContacts([])
            setNotice('No synced contacts yet. Import contacts from your phone or computer.')
          }
        }
      } else if (response.status === 401) {
        setNotice('Sign in to sync contacts between your phone and computer. Local contacts remain available on this device.')
      } else {
        setNotice('Could not load cloud contacts. You can still import contacts on this device.')
      }
    }).catch(() => setNotice('Offline: showing contacts saved on this device.'))
    return () => { active = false }
  }, [])

  async function persist(next: Contact[], successMessage: string) {
    const normalized = mergeContacts([], next)
    setContacts(normalized)
    saveLocal(normalized)
    try {
      const response = await apiFetch('/api/whatsapp/contacts', {
        method: 'PUT',
        body: JSON.stringify({ contacts: normalized }),
      })
      const data = await readJson<{ detail?: string; count?: number }>(response)
      if (response.ok) setNotice(`${successMessage} ${data?.count ?? normalized.length} contacts synced to your account.`)
      else if (response.status === 401) setNotice(`${successMessage} Saved on this device. Sign in to sync across devices.`)
      else setNotice(data?.detail || 'Saved locally, but cloud sync failed.')
    } catch {
      setNotice('Saved on this device. Cloud sync is unavailable right now.')
    }
  }

  const saveContact = (event: FormEvent) => {
    event.preventDefault()
    const cleanName = name.trim()
    const cleanPhone = normalizePhone(phone)
    if (!cleanName || cleanPhone.length < 8 || cleanPhone.length > 15) {
      setNotice('Enter a contact name and a valid international number with country code.')
      return
    }
    const next = contacts.filter(contact => normalizePhone(contact.phone) !== normalizePhone(
      contacts.find(item => item.name === editing)?.phone || (editing ? '' : cleanPhone)
    ))
    next.push({ name: cleanName, phone: cleanPhone })
    void persist(next, 'Contact saved.')
    setName('')
    setPhone('')
    setEditing(null)
  }

  const editContact = (contact: Contact) => {
    setEditing(contact.name)
    setName(contact.name)
    setPhone(contact.phone)
    setNotice('')
  }

  const removeContact = (contact: Contact) => {
    if (!window.confirm(`Remove ${contact.name} from Visionary Nexus contacts?`)) return
    void persist(contacts.filter(item => normalizePhone(item.phone) !== normalizePhone(contact.phone)), 'Contact removed.')
  }

  const openExternal = (url: string) => {
    // Open synchronously from the click. If a new tab is blocked, navigate this tab.
    const opened = window.open(url, '_blank')
    if (opened) opened.opener = null
    else window.location.assign(url)
  }

  const openChat = (contact: Contact) => {
    openExternal(`https://wa.me/${normalizePhone(contact.phone)}`)
  }

  const openPreparedDesktopMessage = () => {
    if (!draftRecipient.trim() || !draftMessage.trim()) {
      setDraftNotice('Enter a recipient and message first.')
      return
    }
    const phone = resolvedRecipient?.phone ? normalizePhone(resolvedRecipient.phone) : ''
    const url = phone
      ? `whatsapp://send?phone=${phone}&text=${encodeURIComponent(draftMessage.trim())}`
      : `whatsapp://send?text=${encodeURIComponent(draftMessage.trim())}`
    setDraftNotice('Trying WhatsApp Desktop. If it does not open, use Open WhatsApp with message.')
    openExternal(url)
  }

  const openPreparedWebMessage = () => {
    if (!draftRecipient.trim() || !draftMessage.trim()) {
      setDraftNotice('Enter a recipient and message first.')
      return
    }
    const phone = resolvedRecipient?.phone ? normalizePhone(resolvedRecipient.phone) : ''
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(draftMessage.trim())}`
      : `https://wa.me/?text=${encodeURIComponent(draftMessage.trim())}`
    setDraftNotice(phone
      ? `Opening WhatsApp for ${resolvedRecipient?.name}. Review the message and press Send there.`
      : `Opening WhatsApp's chat chooser with your message. Select ${draftRecipient.trim()}, review it, and press Send there.`)
    openExternal(url)
  }

  async function sendBusinessMessage(event: FormEvent) {
    event.preventDefault()
    const recipient = normalizePhone(businessRecipient)
    const message = businessMessage.trim()
    if (!businessReady) {
      setSendNotice('WhatsApp Business Cloud API is not configured on the backend yet.')
      return
    }
    if (recipient.length < 8 || recipient.length > 15 || !message) {
      setSendNotice('Choose a contact and enter a message before sending.')
      return
    }
    if (!recipientOptedIn) {
      setSendNotice('You must confirm that this recipient has agreed to receive WhatsApp messages.')
      return
    }
    setSendBusy(true)
    setSendNotice('Sending through the official WhatsApp Business API…')
    try {
      const response = await apiFetch('/api/whatsapp/business/send', {
        method: 'POST',
        body: JSON.stringify({ to: recipient, message, opt_in_confirmed: true }),
      })
      const data = await readJson<{ success?: boolean; message_id?: string; detail?: string }>(response)
      if (response.ok && data?.success) {
        setSendNotice(`WhatsApp accepted the message for ${recipient}. Delivery confirmation may arrive separately.`)
        setBusinessMessage('')
      } else {
        setSendNotice(data?.detail || 'WhatsApp could not accept this message. Check the Business API setup and messaging rules.')
      }
    } catch {
      setSendNotice('Could not reach Visionary Nexus backend. Check that the backend is online.')
    } finally {
      setSendBusy(false)
    }
  }

  async function importFromPhone() {
    const picker = (navigator as Navigator & { contacts?: ContactPicker }).contacts
    if (!picker?.select) {
      setNotice('This browser does not support the phone contact picker. Export contacts as a .vcf file from your Contacts app, then import that file here.')
      return
    }
    setBusy(true)
    try {
      const selected = await picker.select(['name', 'tel'], { multiple: true })
      const imported = selected.flatMap(item => {
        const contactName = item.name?.[0]?.trim() || ''
        return (item.tel || []).map(number => ({ name: contactName, phone: normalizePhone(number) }))
      }).filter(contact => contact.name && contact.phone.length >= 8 && contact.phone.length <= 15)
      if (!imported.length) {
        setNotice('No contacts with valid phone numbers were selected.')
      } else {
        await persist(mergeContacts(contacts, imported), `Imported ${imported.length} selected phone contacts.`)
      }
    } catch (error) {
      if (error instanceof Error && !/cancel|abort/i.test(error.name + error.message)) {
        setNotice('Contact access was unavailable. You can import a .vcf file instead.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      const text = await file.text()
      const imported = /\.vcf$/i.test(file.name) || /BEGIN:VCARD/i.test(text)
        ? parseVCard(text)
        : parseCSV(text)
      if (!imported.length) setNotice('No valid name and international phone-number pairs were found in that file.')
      else await persist(mergeContacts(contacts, imported), `Imported ${imported.length} contacts from ${file.name}.`)
    } catch {
      setNotice('Could not read that file. Try exporting contacts as VCF or CSV.')
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  return (
    <section className="space-y-6 p-4 md:p-7 vn-figma-communications vn-figma-whatsapp">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs tracking-[0.2em] text-emerald-300/80 uppercase">Communication</div>
          <h1 className="mt-2 text-3xl font-semibold text-white">WhatsApp</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">Import contacts from your phone or computer and sync them securely to your Visionary Nexus account.</p>
        </div>
        <a href="https://web.whatsapp.com/" target="_blank" rel="noreferrer"
          className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2.5 text-sm text-emerald-200 hover:bg-emerald-400/20">
          Open WhatsApp Web →
        </a>
      </div>

      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5">
        <h2 className="text-lg font-medium text-white">Import and sync contacts</h2>
        <p className="mt-1 text-sm text-slate-400">Choose contacts explicitly on a supported Android browser, or import a VCF/CSV export. Sign in on both devices to share the same contact list.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => void importFromPhone()}
            className="rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? 'Importing…' : 'Choose from phone'}
          </button>
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
            className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50">
            Import VCF / CSV
          </button>
          <input ref={fileRef} type="file" accept=".vcf,.csv,text/vcard,text/csv" className="hidden" onChange={importFile} />
        </div>
        <p className="mt-3 text-xs text-slate-500">Android contact picker availability depends on the browser. If it is unavailable, export a .vcf file from the Contacts app and import it here.</p>
      </div>

      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-5">
        <h2 className="text-lg font-medium text-white">Prepare a personal WhatsApp message</h2>
        <p className="mt-1 text-sm text-slate-400">Enter a contact name or phone number and review the message. Saved contacts are matched automatically; if a name is not saved, WhatsApp opens its chat chooser with your message ready. You press Send inside WhatsApp.</p>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm text-slate-300">Recipient
            <input list="visionary-whatsapp-recipient-list" value={draftRecipient} onChange={event => setDraftRecipient(event.target.value)} placeholder="Contact name or international phone number"
              className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400/60" />
            <datalist id="visionary-whatsapp-recipient-list">
              {contacts.map(contact => <option key={contact.phone} value={contact.name}>{`+${contact.phone}`}</option>)}
            </datalist>
            {resolvedRecipient && <span className="mt-1 block text-xs text-emerald-300">Matched: {resolvedRecipient.name} · +{resolvedRecipient.phone}</span>}
          </label>
          <label className="block text-sm text-slate-300">Message
            <textarea value={draftMessage} onChange={event => setDraftMessage(event.target.value)} rows={4} maxLength={4096}
              placeholder="Type a message or use a voice command…"
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400/60" />
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={openPreparedDesktopMessage} disabled={!draftRecipient.trim() || !draftMessage.trim()}
              className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
              Try WhatsApp Desktop
            </button>
            <button type="button" onClick={openPreparedWebMessage} disabled={!draftRecipient.trim() || !draftMessage.trim()}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50">
              Open WhatsApp with message
            </button>
          </div>
          {draftNotice && <p className="text-sm text-slate-300" role="status">{draftNotice}</p>}
          <p className="text-xs text-slate-500">Nothing is sent by Visionary Nexus. Check the recipient and message in WhatsApp, then click Send yourself.</p>
        </div>
      </div>

      {false && (<div className="rounded-2xl border border-emerald-400/20 bg-slate-900/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium text-white">WhatsApp Business automatic sending</h2>
            <p className="mt-1 text-sm text-slate-400">Send from your connected Business number to recipients using regular personal WhatsApp.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs ${businessReady ? 'bg-emerald-400/10 text-emerald-200' : 'bg-amber-400/10 text-amber-200'}`}>
            {businessReady ? 'API configured' : 'Setup required'}
          </span>
        </div>
        <form onSubmit={sendBusinessMessage} className="mt-4 space-y-3">
          <label className="block text-sm text-slate-300">Recipient
            <select value={businessRecipient} onChange={event => setBusinessRecipient(event.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400/60">
              <option value="">Choose a saved contact</option>
              {contacts.map(contact => <option key={contact.phone} value={contact.phone}>{contact.name} (+{contact.phone})</option>)}
            </select>
          </label>
          <label className="block text-sm text-slate-300">Message
            <textarea value={businessMessage} onChange={event => setBusinessMessage(event.target.value)} rows={4} maxLength={4096}
              placeholder="Write your WhatsApp message…"
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400/60" />
          </label>
          <label className="flex items-start gap-3 text-xs text-slate-400">
            <input type="checkbox" checked={recipientOptedIn} onChange={event => setRecipientOptedIn(event.target.checked)} className="mt-0.5 accent-emerald-400" />
            <span>I confirm this recipient has explicitly agreed to receive WhatsApp messages from this Business number.</span>
          </label>
          <button type="submit" disabled={sendBusy || !businessReady || !contacts.length}
            className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
            {sendBusy ? 'Sending…' : 'Send with WhatsApp Business'}
          </button>
          {sendNotice && <p className="text-sm text-slate-300" role="status">{sendNotice}</p>}
          {!businessReady && <p className="text-xs text-slate-500">Add the Meta access token and phone-number ID to the backend environment, then restart the backend. Never put these credentials in frontend code.</p>}
          <p className="text-xs text-slate-500">Meta requires recipient opt-in. Outside the 24-hour customer-service window, approved message templates may be required. A successful response means Meta accepted the request, not that delivery is guaranteed.</p>
        </form>
      </div>

      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
          <h2 className="text-lg font-medium text-white">{editing ? 'Edit contact' : 'Add a contact'}</h2>
          <p className="mt-1 text-xs text-slate-400">Use the full international number, including country code. Example: 919876543210.</p>
          <form onSubmit={saveContact} className="mt-5 space-y-4">
            <label className="block text-sm text-slate-300">Contact name
              <input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Adhik"
                className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400/60" />
            </label>
            <label className="block text-sm text-slate-300">WhatsApp number
              <input value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" placeholder="91XXXXXXXXXX"
                className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400/60" />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400">{editing ? 'Update contact' : 'Save contact'}</button>
              {editing && <button type="button" onClick={() => { setEditing(null); setName(''); setPhone('') }} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-300">Cancel</button>}
            </div>
          </form>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-medium text-white">Saved contacts</h2>
            <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-slate-300">{contacts.length}</span>
          </div>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search contacts..."
            className="mt-4 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-emerald-400/60" />
          <div className="mt-4 space-y-2">
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
                {contacts.length ? 'No contacts match your search.' : 'No contacts yet. Import from your phone or computer.'}
              </div>
            ) : filtered.map(contact => (
              <div key={contact.phone} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/5 bg-slate-950/70 p-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 font-semibold text-emerald-300">{contact.name.charAt(0).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{contact.name}</div>
                  <div className="text-xs text-slate-400">+{contact.phone}</div>
                </div>
                <button onClick={() => openChat(contact)} className="rounded-lg bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/25">Open chat</button>
                <button onClick={() => editContact(contact)} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5">Edit</button>
                <button onClick={() => removeContact(contact)} className="rounded-lg border border-rose-400/20 px-3 py-2 text-xs text-rose-300 hover:bg-rose-400/10">Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4 text-sm text-slate-300" role="status">
        <strong className="text-emerald-200">Sync status:</strong> {notice}
        <p className="mt-2 text-xs text-slate-500">Only contacts you select or import are stored. Your contact list is tied to your signed-in Visionary Nexus account. This does not extract contacts from WhatsApp itself or read your WhatsApp conversations.</p>
      </div>
    </section>
  )
}
