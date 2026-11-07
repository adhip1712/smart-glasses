import { useEffect, useMemo, useState } from 'react'
import { apiFetch, readJson } from '../services/api'

type Contact = { name: string; phone: string }
type CallRequest = { recipient: string; channel: 'phone' | 'whatsapp' }

const CONTACTS_KEY = 'visionary_whatsapp_contacts'
const digits = (value: string) => value.replace(/[^0-9]/g, '')

function localContacts(): Contact[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTACTS_KEY) || '{}') as Record<string, string>
    return Object.entries(parsed).map(([name, phone]) => ({ name, phone: String(phone) }))
      .filter(contact => contact.name.trim() && digits(contact.phone).length >= 8)
  } catch {
    return []
  }
}

export default function Calling({ initialRequest = null, onRequestConsumed }: {
  initialRequest?: CallRequest | null
  onRequestConsumed?: () => void
}) {
  const [contacts, setContacts] = useState<Contact[]>(localContacts)
  const [recipient, setRecipient] = useState('')
  const [channel, setChannel] = useState<'phone' | 'whatsapp'>('phone')
  const [notice, setNotice] = useState('Choose a saved contact to prepare a call.')

  useEffect(() => {
    let active = true
    apiFetch('/api/whatsapp/contacts').then(async response => {
      const data = await readJson<{ contacts?: Contact[] }>(response)
      if (active && response.ok && Array.isArray(data?.contacts)) {
        const cloud = data.contacts.filter(item => item?.name && digits(item.phone || '').length >= 8)
        if (cloud.length) {
          setContacts(cloud)
          const map: Record<string, string> = {}
          cloud.forEach(item => { map[item.name] = item.phone })
          localStorage.setItem(CONTACTS_KEY, JSON.stringify(map))
        }
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!initialRequest) return
    setRecipient(initialRequest.recipient)
    setChannel(initialRequest.channel)
    setNotice(`${initialRequest.channel === 'whatsapp' ? 'WhatsApp' : 'Phone'} call prepared for ${initialRequest.recipient}. Confirm the contact, then continue.`)
    onRequestConsumed?.()
  }, [initialRequest?.recipient, initialRequest?.channel, onRequestConsumed])

  const match = useMemo(() => {
    const query = recipient.trim().toLowerCase()
    if (!query) return null
    const exact = contacts.find(contact => contact.name.toLowerCase() === query || digits(contact.phone) === digits(query))
    if (exact) return exact
    const matches = contacts.filter(contact => contact.name.toLowerCase().includes(query))
    return matches.length === 1 ? matches[0] : null
  }, [contacts, recipient])

  const prepareCall = () => {
    if (!match) {
      setNotice('No unique saved contact matched. Choose a contact or add their number in the WhatsApp tab.')
      return
    }
    const phone = digits(match.phone)
    if (channel === 'phone') {
      setNotice(`Requesting a phone call to ${match.name}. Windows needs a calling app or connected phone to handle this request.`)
      window.location.href = `tel:+${phone}`
      return
    }
    setNotice(`Opening ${match.name} in WhatsApp Desktop. In the chat, press the voice-call button to start the call.`)
    const desktopUrl = `whatsapp://send?phone=${phone}`
    const webUrl = `https://wa.me/${phone}`
    const opened = window.open(desktopUrl, '_blank')
    if (!opened) window.open(webUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <section className="space-y-6 p-4 md:p-7">
      <header>
        <div className="text-xs tracking-[0.2em] uppercase text-cyan-300/80">Communication</div>
        <h1 className="mt-2 text-3xl font-semibold text-white">Calling</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-400">Prepare normal phone calls or WhatsApp voice calls using your saved contacts.</p>
      </header>

      <div className="max-w-3xl rounded-2xl border border-cyan-400/20 bg-slate-900/60 p-5">
        <div className="grid gap-4">
          <div>
            <label className="block text-sm text-slate-300" htmlFor="calling-channel">Call type</label>
            <select id="calling-channel" value={channel} onChange={event => setChannel(event.target.value as 'phone' | 'whatsapp')}
              className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white">
              <option value="phone">Normal phone call</option>
              <option value="whatsapp">WhatsApp voice call</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-300" htmlFor="calling-recipient">Contact</label>
            <input id="calling-recipient" list="visionary-calling-contacts" value={recipient} onChange={event => setRecipient(event.target.value)}
              placeholder="Enter a saved contact name" className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400/60" />
            <datalist id="visionary-calling-contacts">
              {contacts.map(contact => <option key={contact.phone} value={contact.name}>{`+${contact.phone}`}</option>)}
            </datalist>
            {match && <p className="mt-2 text-xs text-cyan-300">Matched: {match.name} · +{digits(match.phone)}</p>}
          </div>
          <button type="button" onClick={prepareCall} disabled={!match}
            className="rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">
            {channel === 'whatsapp' ? 'Open WhatsApp voice call' : 'Request phone call'}
          </button>
          <p role="status" className="text-sm text-slate-300">{notice}</p>
          <div className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-xs leading-relaxed text-slate-400">
            WhatsApp Desktop does not provide a supported public link that starts a voice call directly. Visionary Nexus opens the chat; you start the call using WhatsApp's call button. Normal phone calls need Windows to have a registered calling app or a connected phone. Your PC is not currently connected to Phone Link, so a normal call may not be available yet.
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500">Contacts are read from your existing Visionary Nexus WhatsApp contact list. Manage or import contacts in the WhatsApp tab.</p>
    </section>
  )
}
