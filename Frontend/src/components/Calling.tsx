import { useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { PhoneContacts } from '../services/phoneContacts'

type Contact = { name: string; phone: string }
type CallRequest = { recipient: string; channel: 'phone' | 'whatsapp' }

const CONTACTS_KEY = 'visionary_phone_contacts_v2'
const CALLING_CONTACTS_KEY = 'visionary_calling_contacts_v2'
const PHONE_CONTACTS_CLEARED_KEY = 'visionary_phone_contacts_cleared_v2'
const digits = (value: string) => value.replace(/[^0-9]/g, '')
const normalizedPhone = (value: string) => { let n = digits(value); if (n.startsWith('00')) n = n.slice(2); if (n.length === 11 && n.startsWith('0')) n = n.slice(1); if (n.length === 10) n = '91' + n; return n }
const internationalDigits = (value: string) => {
  let number = digits(value)
  if (number.length === 10) number = '91' + number
  else if (number.length === 11 && number.startsWith('0')) number = '91' + number.slice(1)
  return number
}
const PhoneDialer = registerPlugin<{ openDialer(options: { number?: string }): Promise<void> }>('PhoneDialer')

function localContacts(): Contact[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTACTS_KEY) || '{}') as Record<string, string>
    const legacy = Object.entries(parsed).map(([name, phone]) => ({ name, phone: String(phone) }))
    const imported = JSON.parse(localStorage.getItem(CALLING_CONTACTS_KEY) || '[]') as Contact[]
    const unique = new Map<string, Contact>()
    legacy.concat(Array.isArray(imported) ? imported : []).forEach(contact => {
      if (contact?.name?.trim() && digits(contact.phone || '').length >= 10) unique.set(normalizedPhone(contact.phone), { ...contact, phone: normalizedPhone(contact.phone) })
    })
    return Array.from(unique.values())
  } catch {
    return []
  }
}

function findContact(contacts: Contact[], rawQuery: string): Contact | null {
  const query = rawQuery.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (!query) return null
  const exact = contacts.find(contact =>
    contact.name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === query ||
    normalizedPhone(contact.phone) === normalizedPhone(rawQuery))
  if (exact) return exact
  const matches = contacts.filter(contact =>
    contact.name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').includes(query))
  if (matches.length === 1) return matches[0]
  // Allow a single speech/transcription typo for longer contact names.
  const close = contacts.filter(contact => {
    const name = contact.name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    if (Math.abs(name.length - query.length) > 1 || query.length < 5) return false
    let i = 0, j = 0, edits = 0
    while (i < name.length && j < query.length) {
      if (name[i] === query[j]) { i++; j++; continue }
      if (++edits > 1) return false
      if (name.length > query.length) i++
      else if (name.length < query.length) j++
      else { i++; j++ }
    }
    return edits + (i < name.length || j < query.length ? 1 : 0) <= 1
  })
  return close.length === 1 ? close[0] : null
}

async function openAndroidDialer(number = '') {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    await PhoneDialer.openDialer({ number })
    return
  }
  window.location.href = number ? `tel:${number}` : 'tel:'
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
  const lastAutoDialKey = useRef('')
  const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

  useEffect(() => {
    const refreshContacts = () => setContacts(localContacts())
    window.addEventListener('visionary-contacts-updated', refreshContacts)
    localStorage.removeItem('visionary_whatsapp_contacts')
    localStorage.removeItem('visionary_calling_contacts')
    if (isNativeAndroid && localStorage.getItem(PHONE_CONTACTS_CLEARED_KEY) !== '1') {
      PhoneContacts.importContacts({ all: true }).then(result => {
        const list = (result.contacts || []).map(item => ({ name: String(item.name || '').trim(), phone: normalizedPhone(String(item.phone || '')) })).filter(item => item.name && item.phone.length >= 10 && item.phone.length <= 15)
        const unique = new Map<string, Contact>()
        list.forEach(item => unique.set(normalizedPhone(item.phone), item))
        const phoneList = [...unique.values()]
        setContacts(phoneList)
        localStorage.setItem(CALLING_CONTACTS_KEY, JSON.stringify(phoneList))
        const map: Record<string, string> = {}
        phoneList.forEach(item => { map[item.name] = item.phone })
        localStorage.setItem(CONTACTS_KEY, JSON.stringify(map))
        window.dispatchEvent(new Event('visionary-contacts-updated'))
        setPhoneContactCount(phoneList.length)
        setNotice('Showing only contacts saved directly to this phone or SIM. Online-account contacts are excluded.')
      }).catch(error => { console.error('Phone contact sync failed', error); setNotice('Allow Contacts permission for Visionary Nexus in Android Settings to show this phone contacts.') })
    } else if (isNativeAndroid) {
      setNotice('Phone contacts are cleared for Visionary Nexus on this device. Use Import contacts from Android to load them again.')
    }
    return () => window.removeEventListener('visionary-contacts-updated', refreshContacts)
  }, [isNativeAndroid])

useEffect(() => {
    if (!initialRequest) return
    setRecipient(initialRequest.recipient)
    setChannel(initialRequest.channel)
    setNotice(`${initialRequest.channel === 'whatsapp' ? 'WhatsApp' : 'Phone'} call requested for ${initialRequest.recipient}.`)
    onRequestConsumed?.()
  }, [initialRequest?.recipient, initialRequest?.channel])

  const match = useMemo(() => findContact(contacts, recipient), [contacts, recipient])

  // An AI/voice call request should open the actual Android dialler immediately.
  // ACTION_DIAL only prepares the call screen; the user still presses Call.
  useEffect(() => {
    if (!initialRequest || initialRequest.channel !== 'phone') return
    const key = `${initialRequest.channel}:${initialRequest.recipient.toLowerCase()}`
    if (lastAutoDialKey.current === key) return
    lastAutoDialKey.current = key
    const resolved = findContact(contacts, initialRequest.recipient)
    setNotice(resolved
      ? `Opening the phone dialler for ${resolved.name}. Review the number and tap Call.`
      : `No Visionary Nexus match for ${initialRequest.recipient}. Opening the phone dialler so you can choose the contact or enter the number.`)
    void openAndroidDialer(resolved ? `+${internationalDigits(resolved.phone)}` : '').catch(error => {
      console.error('Could not open Android dialler', error)
      setNotice('Android could not open the phone dialler. Use the Open phone dialler button below.')
    })
  }, [initialRequest?.recipient, initialRequest?.channel, contacts])

  const importPhoneContacts = async () => {
    if (!isNativeAndroid) {
      setNotice('Phone contact import is available in the installed Visionary Nexus Android app.')
      return
    }
    setLoadingContacts(true)
    try {
      localStorage.removeItem(PHONE_CONTACTS_CLEARED_KEY)
      const result = await PhoneContacts.importContacts({ all: true })
      const imported: Contact[] = (result.contacts || []).map(item => ({ name: String(item.name || '').trim(), phone: normalizedPhone(String(item.phone || '')) })).filter(item => item.name && item.phone.length >= 10 && item.phone.length <= 15)
      const unique = new Map<string, Contact>()
      imported.forEach(item => unique.set(normalizedPhone(item.phone), item))
      const list = [...unique.values()]
      setContacts(list)
      localStorage.setItem(CALLING_CONTACTS_KEY, JSON.stringify(list))
      const whatsappMap: Record<string, string> = {}
      list.forEach(item => { whatsappMap[item.name] = normalizedPhone(item.phone) })
      localStorage.setItem(CONTACTS_KEY, JSON.stringify(whatsappMap))
      window.dispatchEvent(new Event('visionary-contacts-updated'))
      setPhoneContactCount(list.length)
      setNotice(list.length
        ? `Loaded ${list.length} phone contacts. They are stored locally on this device.`
        : 'No contacts are saved directly to this phone or SIM. Online-account contacts are intentionally excluded.')
    } catch (error) {
      console.error('Android contacts import failed', error)
      setNotice('Could not read local phone/SIM contacts. Check the Contacts permission in Android Settings and try again.')
    } finally {
      setLoadingContacts(false)
    }
  }

  const deleteAllContacts = () => {
    if (!contacts.length) return
    if (!window.confirm('Delete all ' + contacts.length + ' contacts from Visionary Nexus on this phone? This will not delete contacts from Android or Google Contacts.')) return
    localStorage.setItem(PHONE_CONTACTS_CLEARED_KEY, '1')
    localStorage.removeItem(CONTACTS_KEY)
    localStorage.removeItem(CALLING_CONTACTS_KEY)
    setContacts([])
    setPhoneContactCount(0)
    window.dispatchEvent(new Event('visionary-contacts-updated'))
    setNotice('All Visionary Nexus contacts were cleared from this device. Android address-book contacts were not changed.')
  }

  const prepareCall = () => {
    if (channel === 'phone') {
      setNotice(match
        ? `Opening the phone dialler for ${match.name}. Review the number and tap Call.`
        : 'Opening the phone dialler. Choose a contact or enter a number; no call will be placed automatically.')
      void openAndroidDialer(match ? `+${internationalDigits(match.phone)}` : '').catch(error => {
        console.error(error)
        setNotice('Could not open the Android phone dialler.')
      })
      return
    }
    if (!match) {
      setNotice('No matching contact. Import phone contacts or select a saved contact first.')
      return
    }
    const phone = internationalDigits(match.phone)
    setNotice(`Opening ${match.name} in WhatsApp. Use WhatsApp's voice-call button to start the call.`)
    window.location.assign('https://wa.me/' + phone)
  }

  return (
    <section className="space-y-5 p-3 sm:p-4 md:p-7 w-full max-w-none vn-figma-communications vn-figma-calling">
      <header>
        <div className="text-xs tracking-[0.2em] uppercase text-white/60">Communication</div>
        <h1 className="mt-2 text-2xl sm:text-3xl font-semibold text-white">Calling</h1>
        <p className="mt-2 text-sm text-white/60">Find contacts and prepare normal phone calls or WhatsApp voice calls.</p>
      </header>

      <div className="w-full max-w-none rounded-2xl border border-white/15 bg-white/[0.04] p-3 sm:p-5">
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={importPhoneContacts} disabled={!isNativeAndroid || loadingContacts}
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40">
              {loadingContacts ? 'Reading contacts...' : 'Import contacts from Android'}
            </button>
            <span className="text-xs text-white/60">
              {isNativeAndroid ? 'Contacts are read only after you grant permission.' : 'Requires the installed Android app.'}
            </span>
          </div>
          {phoneContactCount > 0 && <p className="text-xs text-white/60">{phoneContactCount} phone contacts imported.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-white/80" htmlFor="calling-channel">Call type</label>
              <select id="calling-channel" value={channel} onChange={event => setChannel(event.target.value as 'phone' | 'whatsapp')}
                className="mt-2 w-full min-w-0 rounded-xl border border-white/15 bg-black px-4 py-3 text-white">
                <option value="phone">Normal phone call</option>
                <option value="whatsapp">WhatsApp voice call</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-white/80" htmlFor="calling-recipient">Contact</label>
              <input id="calling-recipient" value={recipient} onChange={event => setRecipient(event.target.value)}
                placeholder="Type a contact name or phone number" className="mt-2 w-full min-w-0 rounded-xl border border-white/15 bg-black px-4 py-3 text-white outline-none focus:border-white/60" />
              {match && <p className="mt-2 text-xs text-white/80">Matched: <strong>{match.name}</strong> Â· {match.phone}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={prepareCall}
              className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-white/90">
              {channel === 'whatsapp' ? 'Open WhatsApp' : 'Open phone dialler'}
            </button>
          </div>
          {contacts.length > 0 && (
            <div className="rounded-xl border border-white/10 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">Saved contacts</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/50">{contacts.length} contacts</span>
                  <button type="button" onClick={deleteAllContacts} disabled={!contacts.length}
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white hover:text-black disabled:opacity-30">Delete all</button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
                {contacts.map(contact => (
                  <button key={contact.phone} type="button"
                    onClick={() => { setRecipient(contact.name); setChannel('phone') }}
                    className="min-w-0 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left hover:bg-white/10">
                    <span className="block w-full text-sm font-medium text-white whitespace-normal break-words">{contact.name}</span>
                    <span className="block text-xs text-white/50">{contact.phone}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <p role="status" className="text-sm text-white/70">{notice}</p>
          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs leading-relaxed text-white/55">
            Visionary Nexus never places a call automatically. Android opens the dialler so you can verify the recipient and press Call yourself. Imported contacts stay on this device.
          </div>
        </div>
      </div>
    </section>
  )
}
