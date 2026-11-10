import { useEffect, useMemo, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Contacts } from '@capacitor-community/contacts'
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
  const [notice, setNotice] = useState('Choose a saved contact or import contacts from your Android phone.')
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [phoneContactCount, setPhoneContactCount] = useState(0)
  const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

  useEffect(() => {
    let active = true
    apiFetch('/api/whatsapp/contacts').then(async response => {
      const data = await readJson<{ contacts?: Contact[] }>(response)
      if (active && response.ok && Array.isArray(data?.contacts)) {
        const cloud = data.contacts.filter(item => item?.name && digits(item.phone || '').length >= 8)
        if (cloud.length) setContacts(current => {
          const merged = new Map(current.map(item => [digits(item.phone), item]))
          cloud.forEach(item => merged.set(digits(item.phone), item))
          return [...merged.values()]
        })
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

  const importPhoneContacts = async () => {
    if (!isNativeAndroid) {
      setNotice('Phone contact import is available in the installed Visionary Nexus Android app, not the desktop browser.')
      return
    }
    setLoadingContacts(true)
    try {
      let permission = await Contacts.checkPermissions()
      if (permission.contacts !== 'granted' && permission.contacts !== 'limited') {
        permission = await Contacts.requestPermissions()
      }
      if (permission.contacts !== 'granted' && permission.contacts !== 'limited') {
        setNotice('Contacts permission was not granted. You can enable it in Android Settings → Apps → Visionary Nexus → Permissions.')
        return
      }
      const result = await Contacts.getContacts({ projection: { name: true, phones: true } })
      const imported: Contact[] = result.contacts.flatMap(contact => {
        const name = contact.name?.display?.trim() ||
          [contact.name?.given, contact.name?.family].filter(Boolean).join(' ').trim()
        if (!name) return []
        return (contact.phones || [])
          .map(phone => ({ name, phone: phone.number || '' }))
          .filter(item => digits(item.phone).length >= 8)
      })
      const unique = new Map<string, Contact>()
      imported.forEach(item => {
        const key = digits(item.phone)
        if (key && !unique.has(key)) unique.set(key, item)
      })
      const list = [...unique.values()]
      setContacts(current => {
        const merged = new Map(current.map(item => [digits(item.phone), item]))
        list.forEach(item => merged.set(digits(item.phone), item))
        return [...merged.values()]
      })
      setPhoneContactCount(list.length)
      setNotice(list.length
        ? `Loaded ${list.length} phone contacts. They stay on this device and are not uploaded to Visionary Nexus servers.`
        : 'No contacts with phone numbers were found on this phone.')
    } catch (error) {
      console.error('Android contacts import failed', error)
      setNotice('Could not read phone contacts. Check the Contacts permission in Android Settings and try again.')
    } finally {
      setLoadingContacts(false)
    }
  }

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
      setNotice('No unique saved contact matched. Import phone contacts or choose a contact from the list.')
      return
    }
    const phone = digits(match.phone)
    if (channel === 'phone') {
      setNotice(`Opening the phone dialler for ${match.name}. Review the number and tap Call on your phone.`)
      window.location.href = `tel:+${phone}`
      return
    }
    setNotice(`Opening ${match.name} in WhatsApp. In the chat, use WhatsApp's voice-call button to start the call.`)
    const desktopUrl = `whatsapp://send?phone=${phone}`
    const webUrl = `https://wa.me/${phone}`
    const opened = window.open(desktopUrl, '_blank')
    if (!opened) window.open(webUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <section className="space-y-6 p-4 md:p-7 vn-figma-communications vn-figma-calling">
      <header>
        <div className="text-xs tracking-[0.2em] uppercase text-cyan-300/80">Communication</div>
        <h1 className="mt-2 text-3xl font-semibold text-white">Calling</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-400">Find contacts on your Android phone and prepare normal phone calls or WhatsApp voice calls.</p>
      </header>

      <div className="max-w-3xl rounded-2xl border border-cyan-400/20 bg-slate-900/60 p-5">
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={importPhoneContacts} disabled={!isNativeAndroid || loadingContacts}
              className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40">
              {loadingContacts ? 'Reading phone contacts…' : 'Import contacts from Android'}
            </button>
            <span className="text-xs text-slate-400">
              {isNativeAndroid ? 'Contacts are read only after you grant permission.' : 'Requires the installed Android app.'}
            </span>
          </div>
          {phoneContactCount > 0 && <p className="text-xs text-slate-400">{phoneContactCount} contacts loaded from this phone for this app session.</p>}
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
              placeholder="Search by contact name or phone number" className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none focus:border-white/60" />
            <datalist id="visionary-calling-contacts">
              {contacts.map(contact => <option key={contact.phone} value={contact.name}>{`+${digits(contact.phone)}`}</option>)}
            </datalist>
            {match && <p className="mt-2 text-xs text-cyan-300">Matched: {match.name} · +{digits(match.phone)}</p>}
          </div>
          <button type="button" onClick={prepareCall} disabled={!match}
            className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40">
            {channel === 'whatsapp' ? 'Open WhatsApp voice call' : 'Open phone dialler'}
          </button>
          <p role="status" className="text-sm text-slate-300">{notice}</p>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-xs leading-relaxed text-slate-400">
            Visionary Nexus does not place calls automatically. It opens the dialler or WhatsApp chat so you can verify the recipient and start the call yourself. Phone contacts are read on-device after permission and are not uploaded.
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500">Existing Visionary Nexus contacts remain available. Android phone contacts are loaded only when you press Import contacts from Android.</p>
    </section>
  )
}
