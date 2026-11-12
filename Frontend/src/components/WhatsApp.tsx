
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { apiFetch, readJson } from '../services/api'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { PhoneContacts } from '../services/phoneContacts'
import { normalizeContactName } from '../services/whatsappIntent'

type Contact = { name: string; phone: string }
type ContactPicker = { select: (properties: string[], options?: { multiple?: boolean }) => Promise<Array<{ name?: string[]; tel?: string[] }>> }

const WhatsAppLauncher = registerPlugin<{ openChat(options: { phone: string; message?: string }): Promise<void> }>('WhatsAppLauncher')
const WhatsAppContactShare = registerPlugin<{ readSharedContact(): Promise<{ vcard: string }> }>('WhatsAppContactShare')
const STORAGE_KEY = 'visionary_phone_contacts_v2'
const PHONE_CONTACTS_CLEARED_KEY = 'visionary_phone_contacts_cleared_v2'
const PENDING_WHATSAPP_CONTACTS_KEY = 'visionary_pending_whatsapp_contacts_v1'

function normalizePhone(value: string): string {
  let digits = value.replace(/[^0-9]/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  if (digits.length === 10) digits = '91' + digits
  return digits
}

function readContacts(): Contact[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string>
    return Object.entries(value).map(([name, phone]) => ({ name, phone: normalizePhone(String(phone)) }))
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
  window.localStorage.setItem('visionary_calling_contacts_v2', JSON.stringify(contacts))
  window.dispatchEvent(new Event('visionary-contacts-updated'))
}

function mergeContacts(existing: Contact[], incoming: Contact[]): Contact[] {
  const byPhone = new Map<string, Contact>()
  existing.forEach(contact => byPhone.set(normalizePhone(contact.phone), contact))
  incoming.forEach(contact => {
    const phone = normalizePhone(contact.phone)
    const name = contact.name.trim()
    if (name && phone.length >= 10 && phone.length <= 15) byPhone.set(phone, { name, phone })
  })
  return [...byPhone.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function parseVCard(text: string): Contact[] {
  const cards = text.replace(/\r/g, '').split(/BEGIN:VCARD/i).slice(1)
  return cards.map(card => {
    const name = card.match(/^FN[^:]*:(.*)$/im)?.[1]?.trim()
      || card.match(/^N[^:]*:(.*)$/im)?.[1]?.replace(/;/g, ' ').trim() || 'V'
    const phone = card.match(/^TEL[^:]*:(.*)$/im)?.[1]?.trim() || 'V'
    return { name, phone: normalizePhone(phone) }
  }).filter(contact => contact.name && contact.phone.length >= 10 && contact.phone.length <= 15)
}

function parseWhatsAppExport(text: string): Contact[] {
  const found = new Map<string, Contact>()
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const separator = line.indexOf(' - ')
    if (separator < 0) continue
    const message = line.slice(separator + 3)
    const colon = message.indexOf(': ')
    if (colon < 0) continue
    const sender = message.slice(0, colon).trim()
    if (!/^[+()\d.\s-]{10,}$/.test(sender)) continue
    const phone = normalizePhone(sender)
    if (phone.length < 10 || phone.length > 15) continue
    found.set(phone, { name: '+' + phone, phone })
  }
  return [...found.values()].sort((a, b) => a.phone.localeCompare(b.phone))
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
      name: cells[hasHeader ? nameIndex : 0] || 'V',
      phone: normalizePhone(cells[hasHeader ? phoneIndex : 1] || 'V'),
    }
  }).filter(contact => contact.name && contact.phone.length >= 10 && contact.phone.length <= 15)
}

export default function WhatsApp({ initialDraft = null, onDraftConsumed }: {
  initialDraft?: { recipient: string; message: string } | null
  onDraftConsumed?: () => void
}) {
  const [contacts, setContacts] = useState<Contact[]>(readContacts)
  const [contactsLoaded, setContactsLoaded] = useState(false)
  const [chatCandidates, setChatCandidates] = useState<Contact[]>([])
  const [selectedChatPhones, setSelectedChatPhones] = useState<string[]>([])
  const [pendingSharedContacts, setPendingSharedContacts] = useState<Contact[]>(() => {
    try { return mergeContacts([], JSON.parse(window.localStorage.getItem(PENDING_WHATSAPP_CONTACTS_KEY) || '[]') as Contact[]) } catch { return [] }
  })
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [notice, setNotice] = useState('Loading contacts on this device...')
  const [busy, setBusy] = useState(false)
  const [importAllContacts, setImportAllContacts] = useState(false)
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
    normalizeContactName(contact.name).includes(normalizeContactName(query)) || contact.phone.includes(query)
  ), [contacts, query])

  const resolvedRecipient = useMemo(() => {
    const raw = draftRecipient.trim()
    const value = normalizeContactName(raw)
    if (!value) return undefined
    const exact = contacts.find(contact => normalizeContactName(contact.name) === value || normalizePhone(contact.phone) === normalizePhone(raw))
    if (exact) return exact
    const matches = contacts.filter(contact => normalizeContactName(contact.name).includes(value))
    if (matches.length === 1) return matches[0]
    const digits = normalizePhone(raw)
    if (digits.length >= 10 && digits.length <= 15) return { name: raw, phone: digits }
    return undefined
  }, [contacts, draftRecipient])

  useEffect(() => {
    if (!initialDraft || !contactsLoaded) return
    const recipientText = (initialDraft.recipient || 'V').trim()
    const messageText = (initialDraft.message || 'V').trim()
    setDraftRecipient(recipientText)
    setDraftMessage(messageText)
    onDraftConsumed?.()

    const normalizedName = normalizeContactName(recipientText)
    const exact = contacts.find(contact =>
      normalizeContactName(contact.name) === normalizedName ||
      normalizePhone(contact.phone) === normalizePhone(recipientText)
    )
    const partialMatches = exact ? [] : contacts.filter(contact =>
      normalizeContactName(contact.name).includes(normalizedName)
    )
    const matched = exact || (partialMatches.length === 1 ? partialMatches[0] : undefined)
    const phoneNumber = matched?.phone ? normalizePhone(matched.phone) : ''

    if (!phoneNumber) {
      setDraftNotice(recipientText ? 'Opening WhatsApp chat chooser. Select ' + recipientText + ', review the message, then press Send.' : 'Opening WhatsApp. Select a recipient, review the message, then press Send.')
    } else {
      setDraftNotice('Opening WhatsApp chat for ' + matched!.name + '. Review the message there and press Send.')
    }
    if (Capacitor.getPlatform() === 'android') {
      WhatsAppLauncher.openChat({ phone: phoneNumber, message: messageText }).catch(error => {
        console.error('Native WhatsApp launch failed:', error)
        setDraftNotice('Could not open WhatsApp. Check that WhatsApp is installed and try again.')
      })
    } else {
      const url = phoneNumber ? 'https://wa.me/' + phoneNumber + (messageText ? '?text=' + encodeURIComponent(messageText) : '') : 'https://wa.me/' + (messageText ? '?text=' + encodeURIComponent(messageText) : '')
      const opened = window.open(url, '_blank')
      if (opened) opened.opener = null
      else window.location.assign(url)
    }
  }, [initialDraft?.recipient, initialDraft?.message, contactsLoaded, contacts, onDraftConsumed])

  async function collectSharedWhatsAppContent() {
    if (Capacitor.getPlatform() !== 'android') return
    try {
      const shared = await WhatsAppContactShare.readSharedContact()
      const content = String(shared.vcard || '')
      if (!content.trim()) return
      if (/BEGIN:VCARD/i.test(content)) {
        const imported = parseVCard(content)
        if (!imported.length) {
          setNotice('The shared contact card did not contain a valid phone number.')
          return
        }
        setPendingSharedContacts(current => {
          const next = mergeContacts(current, imported)
          window.localStorage.setItem(PENDING_WHATSAPP_CONTACTS_KEY, JSON.stringify(next))
          return next
        })
        setNotice('Added ' + imported.length + ' shared contact(s) to the import queue. Share more contacts, then save them together.')
        return
      }
      const candidates = parseWhatsAppExport(content)
      setChatCandidates(candidates)
      setSelectedChatPhones(candidates.map(contact => contact.phone))
      setNotice(candidates.length
        ? 'Received the WhatsApp chat export. Review the sender phone numbers below, then save the ones you want.'
        : 'Received the shared file, but it contains no sender labels formatted as phone numbers. WhatsApp may export saved names instead.')
    } catch (error) {
      console.error('Could not read shared WhatsApp content:', error)
    }
  }

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return
    void collectSharedWhatsAppContent()
    const handleResume = () => { void collectSharedWhatsAppContent() }
    window.addEventListener('focus', handleResume)
    document.addEventListener('visibilitychange', handleResume)
    return () => {
      window.removeEventListener('focus', handleResume)
      document.removeEventListener('visibilitychange', handleResume)
    }
  }, [])

  useEffect(() => {
    let active = true
    window.localStorage.removeItem('visionary_whatsapp_contacts')
    window.localStorage.removeItem('visionary_calling_contacts')
    setContacts(readContacts())
    setNotice('Reading contacts saved directly to this phone or SIM...')
    if (Capacitor.getPlatform() === 'android' && window.localStorage.getItem(PHONE_CONTACTS_CLEARED_KEY) !== '1') {
      PhoneContacts.importContacts({ all: true }).then(result => {
        if (!active) return
        const fromPhone = mergeContacts([], (result.contacts || []).map(contact => ({ name: String(contact.name || '').trim(), phone: normalizePhone(String(contact.phone || '')) })).filter(contact => contact.name && contact.phone.length >= 10 && contact.phone.length <= 15))
        setContacts(fromPhone)
        saveLocal(fromPhone)
        setNotice('Showing ' + fromPhone.length + ' contacts saved directly to this phone or SIM. Online-account contacts are excluded.')
        setContactsLoaded(true)
      }).catch(error => {
        console.error('Could not sync Android phone contacts', error)
        if (active) {
          setNotice('Could not read local phone/SIM contacts. Check Visionary Nexus Contacts permission in Android Settings.')
          setContactsLoaded(true)
        }
      })
    } else {
      setNotice(Capacitor.getPlatform() === 'android'
        ? 'Visionary Nexus phone/SIM contacts are cleared on this device. Import again to reload eligible contacts.'
        : 'Each phone uses its own contacts, regardless of which account signs in.')
      setContactsLoaded(true)
    }
    apiFetch('/api/whatsapp/status').then(async response => {
      const data = await readJson<{ business?: { configured?: boolean; message?: string } }>(response)
      if (active && response.ok) setBusinessReady(Boolean(data?.business?.configured))
    }).catch(() => { if (active) setBusinessReady(false) })
    if (Capacitor.getPlatform() !== 'android') setContactsLoaded(true)
    return () => { active = false }
  }, [])

  async function persist(next: Contact[], successMessage: string) {
    const normalized = mergeContacts([], next)
    setContacts(normalized)
    saveLocal(normalized)
    setNotice(successMessage + ' ' + normalized.length + ' contacts saved on this device only.')
  }
  const saveContact = (event: FormEvent) => {
    event.preventDefault()
    const cleanName = name.trim()
    const cleanPhone = normalizePhone(phone)
    if (!cleanName || cleanPhone.length < 10 || cleanPhone.length > 15) {
      setNotice('Enter a contact name and a valid phone number (10-digit Indian numbers automatically get +91).')
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

  const deleteAllContacts = () => {
    if (!contacts.length) return
    if (!window.confirm(`Delete all ${contacts.length} saved contacts from this phone? This cannot be undone.`)) return
    window.localStorage.setItem(PHONE_CONTACTS_CLEARED_KEY, '1')
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem('visionary_calling_contacts_v2')
    window.dispatchEvent(new Event('visionary-contacts-updated'))
    setContacts([])
    setEditing(null)
    setName('')
    setPhone('')
    setNotice('All Visionary Nexus contacts were deleted from this device.')
  }

  const openExternal = (url: string) => {
    // Android WebView should navigate directly so WhatsApp App Links can open the installed app.
    if (/Android/i.test(navigator.userAgent)) { window.location.assign(url); return }
    const opened = window.open(url, '_blank')
    if (opened) opened.opener = null
    else window.location.assign(url)
  }

  const launchWhatsApp = async (phoneNumber: string, message = '') => {
    const phone = normalizePhone(phoneNumber)
    if (Capacitor.getPlatform() === 'android') {
      try {
        await WhatsAppLauncher.openChat({ phone, message })
        return
      } catch (error) {
        console.error('Native WhatsApp launch failed:', error)
        setDraftNotice('WhatsApp could not be opened. Check that the WhatsApp app is installed and updated.')
        return
      }
    }
    const url = phone
      ? 'https://wa.me/' + phone + (message ? '?text=' + encodeURIComponent(message) : '')
      : 'https://wa.me/' + (message ? '?text=' + encodeURIComponent(message) : '')
    openExternal(url)
  }

  const openChat = (contact: Contact) => {
    void launchWhatsApp(contact.phone)
  }

  const openPreparedDesktopMessage = () => {
    if (!draftRecipient.trim() || !draftMessage.trim()) {
      setDraftNotice('Enter a recipient and message first.')
      return
    }
    const phone = resolvedRecipient?.phone ? normalizePhone(resolvedRecipient.phone) : ''
    setDraftNotice('Opening WhatsApp. Review the recipient and message there, then press Send.')
    void launchWhatsApp(phone, draftMessage.trim())
  }

  const openPreparedWebMessage = () => {
    if (!draftRecipient.trim() || !draftMessage.trim()) {
      setDraftNotice('Enter a recipient and message first.')
      return
    }
    const phone = resolvedRecipient?.phone ? normalizePhone(resolvedRecipient.phone) : ''
    setDraftNotice(phone
      ? `Opening WhatsApp for ${resolvedRecipient?.name}. Review the message and press Send there.`
      : `Opening WhatsApp's chat chooser with your message. Select ${draftRecipient.trim()}, review it, and press Send there.`)
    void launchWhatsApp(phone, draftMessage.trim())
  }

  async function sendBusinessMessage(event: FormEvent) {
    event.preventDefault()
    const recipient = normalizePhone(businessRecipient)
    const message = businessMessage.trim()
    if (!businessReady) {
      setSendNotice('WhatsApp Business Cloud API is not configured on the backend yet.')
      return
    }
    if (recipient.length < 10 || recipient.length > 15 || !message) {
      setSendNotice('Choose a contact and enter a message before sending.')
      return
    }
    if (!recipientOptedIn) {
      setSendNotice('You must confirm that this recipient has agreed to receive WhatsApp messages.')
      return
    }
    setSendBusy(true)
    setSendNotice('Sending through the official WhatsApp Business API...')
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
        setSendNotice(data?.detail || 'V')
      }
    } catch {
      setSendNotice('Could not reach Visionary Nexus backend. Check that the backend is online.')
    } finally {
      setSendBusy(false)
    }
  }

  async function importFromPhone() {
    setBusy(true)
    try {
      if (Capacitor.getPlatform() === 'android') {
        window.localStorage.removeItem(PHONE_CONTACTS_CLEARED_KEY)
        const result = await PhoneContacts.importContacts({ all: importAllContacts })
        const imported = (result.contacts || []).map(contact => ({
          name: String(contact.name || 'V').trim(),
          phone: normalizePhone(String(contact.phone || 'V')),
        })).filter(contact => contact.name && contact.phone.length >= 10 && contact.phone.length <= 15)
        if (!imported.length) setNotice('No contacts are saved directly to this phone or SIM. Contacts stored only in Google or another online account are intentionally excluded.')
        else await persist(mergeContacts(contacts, imported), 'Imported ' + imported.length + (importAllContacts ? ' phone' : ' selected') + ' contacts.')
        return
      }
      const picker = (navigator as Navigator & { contacts?: ContactPicker }).contacts
      if (!picker?.select) {
        setNotice('This browser cannot access Android phone/SIM storage. Use the installed Android app to import local contacts.')
        return
      }
      const selected = await picker.select(['name', 'tel'], { multiple: true })
      const imported = selected.flatMap(item => {
        const contactName = item.name?.[0]?.trim() || 'V'
        return (item.tel || []).map(number => ({ name: contactName, phone: normalizePhone(number) }))
      }).filter(contact => contact.name && contact.phone.length >= 10 && contact.phone.length <= 15)
      if (!imported.length) setNotice('No contacts with valid phone numbers were selected.')
      else await persist(mergeContacts(contacts, imported), 'Imported ' + imported.length + ' selected phone contacts.')
    } catch (error) {
      if (error instanceof Error && !/cancel|abort/i.test(error.name + error.message)) {
        setNotice(error.message || 'V')
      }
    } finally {
      setBusy(false)
    }
  }
  async function importFromWhatsApp() {
    setBusy(true)
    try {
      if (Capacitor.getPlatform() !== 'android') {
        setNotice('WhatsApp contact sharing into Visionary Nexus is available in the installed Android app.')
        return
      }
      const shared = await WhatsAppContactShare.readSharedContact()
      const vcard = String(shared.vcard || '')
      if (!vcard.trim()) {
        setNotice('First open WhatsApp, open the contact details, choose Share contact, and select Visionary Nexus. Then tap Import shared WhatsApp contact.')
        return
      }
      const imported = parseVCard(vcard)
      if (!imported.length) {
        setNotice('WhatsApp did not share a readable contact card. Try Share contact again and choose the VCF/contact-card option.')
        return
      }
      await persist(mergeContacts(contacts, imported), 'Imported ' + imported.length + ' contact' + (imported.length === 1 ? '' : 's') + ' from WhatsApp.')
    } catch (error) {
      console.error('WhatsApp shared contact import failed:', error)
      setNotice('Could not read the shared WhatsApp contact. Try sharing the contact again.')
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
      if (/\.txt$/i.test(file.name) && !/BEGIN:VCARD/i.test(text)) {
        const candidates = parseWhatsAppExport(text)
        setChatCandidates(candidates)
        setSelectedChatPhones(candidates.map(contact => contact.phone))
        setNotice(candidates.length
          ? 'Found ' + candidates.length + ' phone-number sender(s) in the exported chat. Review them below before saving.'
          : 'No sender phone numbers were found. WhatsApp exports usually show saved contact names instead of numbers, so those names cannot safely be converted into callable contacts.')
      } else {
        const imported = /\.vcf$/i.test(file.name) || /BEGIN:VCARD/i.test(text)
          ? parseVCard(text)
          : parseCSV(text)
        if (!imported.length) setNotice('No valid name and international phone-number pairs were found in that file.')
        else await persist(mergeContacts(contacts, imported), 'Imported ' + imported.length + ' contacts from ' + file.name + '.')
      }
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  async function syncContactsToAndroid() {
    if (Capacitor.getPlatform() !== 'android') {
      setNotice('Phone address-book sync is available in the installed Android app.')
      return
    }
    if (!contacts.length) {
      setNotice('There are no Visionary Nexus contacts to sync yet.')
      return
    }
    setBusy(true)
    try {
      const result = await PhoneContacts.saveToAddressBook({ contacts })
      setNotice('Phone address book updated: ' + result.added + ' added, ' + result.skipped + ' already present or skipped. Check the Contacts app.')
    } catch (error) {
      console.error('Android address-book sync failed:', error)
      setNotice(error instanceof Error ? error.message : 'Could not sync contacts to the phone address book.')
    } finally {
      setBusy(false)
    }
  }

  async function savePendingSharedContacts() {
    if (!pendingSharedContacts.length) return
    const count = pendingSharedContacts.length
    await persist(mergeContacts(contacts, pendingSharedContacts), 'Saved ' + count + ' WhatsApp-shared contact(s) together.')
    setPendingSharedContacts([])
    window.localStorage.removeItem(PENDING_WHATSAPP_CONTACTS_KEY)
  }

  function removePendingSharedContact(phoneNumber: string) {
    setPendingSharedContacts(current => {
      const next = current.filter(contact => contact.phone !== phoneNumber)
      window.localStorage.setItem(PENDING_WHATSAPP_CONTACTS_KEY, JSON.stringify(next))
      return next
    })
  }

  async function saveSelectedChatContacts() {
    const selected = chatCandidates.filter(contact => selectedChatPhones.includes(contact.phone))
    if (!selected.length) {
      setNotice('Select at least one phone number to save.')
      return
    }
    await persist(mergeContacts(contacts, selected), 'Saved ' + selected.length + ' phone-number sender(s) from the WhatsApp chat export.')
    setChatCandidates([])
    setSelectedChatPhones([])
  }

  return (
    <section className="w-full max-w-none space-y-5 p-3 sm:p-5 lg:p-7 vn-figma-communications vn-figma-whatsapp">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs tracking-[0.2em] text-white/60 uppercase">Communication</div>
          <h1 className="mt-2 text-3xl font-semibold text-white">WhatsApp</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">Import contacts from this phone. Contacts remain private to this device.</p>
        </div>
        <a href="https://web.whatsapp.com/" target="_blank" rel="noreferrer"
          className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10">
          Open WhatsApp Web ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â€
        </a>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5 shadow-[0_18px_55px_rgba(0,0,0,0.22)]">
        <h2 className="text-lg font-medium text-white">Import and sync contacts</h2>
        <p className="mt-1 text-sm text-slate-400">Share WhatsApp contacts into a temporary queue, then save them all together. You can also choose contacts from this phone or import a VCF/CSV file.</p>
        <label className="mt-4 flex items-center gap-3 text-sm text-slate-300">
          <input type="checkbox" checked={importAllContacts} onChange={event => setImportAllContacts(event.target.checked)} className="h-4 w-4 accent-white" />
          <span>Import all contacts (leave unchecked to choose specific contacts)</span>
        </label>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => void importFromPhone()}
            className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/85 disabled:opacity-50">
            {busy ? 'Importing...' : (importAllContacts ? 'Import all phone contacts' : 'Choose contacts')}
          </button>
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
            className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50">
            Import VCF / CSV
          </button>
          <button type="button" disabled={busy || !contacts.length} onClick={() => void syncContactsToAndroid()}
            className="rounded-xl border border-white/25 px-4 py-2.5 text-sm text-white hover:bg-white/10 disabled:opacity-50">
            Sync saved contacts to phone address book
          </button>
          <input ref={fileRef} type="file" accept=".vcf,.csv,.txt,text/vcard,text/csv,text/plain" className="hidden" onChange={importFile} />
        </div>
        <p className="mt-3 text-xs text-slate-500">To export a chat: open the WhatsApp chat, tap ? ? More ? Export chat ? Without media, then choose Save to Files. Import the resulting .txt file here. Only phone numbers used as message-sender labels are extracted; message bodies are never scanned.</p>
      </div>

      {pendingSharedContacts.length > 0 && (
        <div className="rounded-2xl border border-white/15 bg-white/[0.045] p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium text-white">WhatsApp import queue</h2>
              <p className="mt-1 text-sm text-slate-400">{pendingSharedContacts.length} contact(s) collected. Share more contacts from WhatsApp; they will be added here without saving one by one.</p>
            </div>
            <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white">{pendingSharedContacts.length} ready</span>
          </div>
          <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
            {pendingSharedContacts.map(contact => (
              <div key={contact.phone} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 p-3 text-sm text-white">
                <div className="min-w-0">
                  <div className="truncate font-medium">{contact.name}</div>
                  <div className="text-xs text-white/55">+{contact.phone}</div>
                </div>
                <button type="button" onClick={() => removePendingSharedContact(contact.phone)} className="shrink-0 rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/75">Remove</button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void savePendingSharedContacts()} className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/85 disabled:opacity-50">Save all {pendingSharedContacts.length} contacts</button>
            <button type="button" onClick={() => { setPendingSharedContacts([]); window.localStorage.removeItem(PENDING_WHATSAPP_CONTACTS_KEY) }} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white">Clear queue</button>
          </div>
        </div>
      )}

      {chatCandidates.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
          <h2 className="text-lg font-medium text-white">Review numbers from WhatsApp export</h2>
          <p className="mt-1 text-sm text-slate-400">These are sender labels that were explicitly formatted as phone numbers. Saved names in an export usually do not include their phone numbers, so they cannot be inferred.</p>
          <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
            {chatCandidates.map(contact => (
              <label key={contact.phone} className="flex items-center gap-3 rounded-lg border border-white/10 p-3 text-sm text-white">
                <input type="checkbox" checked={selectedChatPhones.includes(contact.phone)}
                  onChange={event => setSelectedChatPhones(current => event.target.checked
                    ? [...current, contact.phone]
                    : current.filter(phone => phone !== contact.phone))}
                  className="h-4 w-4 accent-white" />
                <span>{contact.name}</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => void saveSelectedChatContacts()}
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/85">Save selected contacts</button>
            <button type="button" onClick={() => { setChatCandidates([]); setSelectedChatPhones([]) }}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white">Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5 shadow-[0_18px_55px_rgba(0,0,0,0.22)]">
        <h2 className="text-lg font-medium text-white">Prepare a personal WhatsApp message</h2>
        <p className="mt-1 text-sm text-slate-400">Enter a contact name or phone number and review the message. Saved contacts are matched automatically; if a name is not saved, WhatsApp opens its chat chooser with your message ready. You press Send inside WhatsApp.</p>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm text-slate-300">Recipient
            <input list="visionary-whatsapp-recipient-list" value={draftRecipient} onChange={event => setDraftRecipient(event.target.value)} placeholder="Contact name or international phone number"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/60" />
            <datalist id="visionary-whatsapp-recipient-list">
              {contacts.map(contact => <option key={contact.phone} value={contact.name}>{`+${contact.phone}`}</option>)}
            </datalist>
            {resolvedRecipient && <span className="mt-1 block text-xs text-white">Matched: {resolvedRecipient.name} Ãƒâ€šÃ‚Â· +{resolvedRecipient.phone}</span>}
          </label>
          <label className="block text-sm text-slate-300">Message
            <textarea value={draftMessage} onChange={event => setDraftMessage(event.target.value)} rows={4} maxLength={4096}
              placeholder="Type a message or use a voice command..."
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/60" />
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={openPreparedDesktopMessage} disabled={!draftRecipient.trim() || !draftMessage.trim()}
              className="rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50">
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

      {false && (<div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium text-white">WhatsApp Business automatic sending</h2>
            <p className="mt-1 text-sm text-slate-400">Send from your connected Business number to recipients using regular personal WhatsApp.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs ${businessReady ? 'bg-white/5 text-white' : 'bg-amber-400/10 text-amber-200'}`}>
            {businessReady ? 'API configured' : 'Setup required'}
          </span>
        </div>
        <form onSubmit={sendBusinessMessage} className="mt-4 space-y-3">
          <label className="block text-sm text-slate-300">Recipient
            <select value={businessRecipient} onChange={event => setBusinessRecipient(event.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/60">
              <option value="">Choose a saved contact</option>
              {contacts.map(contact => <option key={contact.phone} value={contact.phone}>{contact.name} (+{contact.phone})</option>)}
            </select>
          </label>
          <label className="block text-sm text-slate-300">Message
            <textarea value={businessMessage} onChange={event => setBusinessMessage(event.target.value)} rows={4} maxLength={4096}
              placeholder="Write your WhatsApp message..."
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/60" />
          </label>
          <label className="flex items-start gap-3 text-xs text-slate-400">
            <input type="checkbox" checked={recipientOptedIn} onChange={event => setRecipientOptedIn(event.target.checked)} className="mt-0.5 accent-white" />
            <span>I confirm this recipient has explicitly agreed to receive WhatsApp messages from this Business number.</span>
          </label>
          <button type="submit" disabled={sendBusy || !businessReady || !contacts.length}
            className="rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50">
            {sendBusy ? 'Sending...' : 'Send with WhatsApp Business'}
          </button>
          {sendNotice && <p className="text-sm text-slate-300" role="status">{sendNotice}</p>}
          {!businessReady && <p className="text-xs text-slate-500">Add the Meta access token and phone-number ID to the backend environment, then restart the backend. Never put these credentials in frontend code.</p>}
          <p className="text-xs text-slate-500">Meta requires recipient opt-in. Outside the 24-hour customer-service window, approved message templates may be required. A successful response means Meta accepted the request, not that delivery is guaranteed.</p>
        </form>
      </div>

      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
          <h2 className="text-lg font-medium text-white">{editing ? 'Edit contact' : 'Add a contact'}</h2>
          <p className="mt-1 text-xs text-slate-400">Enter a 10-digit Indian mobile number or an international number. The +91 country code is added automatically for Indian numbers.</p>
          <form onSubmit={saveContact} className="mt-5 space-y-4">
            <label className="block text-sm text-slate-300">Contact name
              <input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Adhik"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/60" />
            </label>
            <label className="block text-sm text-slate-300">WhatsApp number
              <input value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" placeholder="9876543210 or +919876543210"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/60" />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85">{editing ? 'Update contact' : 'Save contact'}</button>
              {editing && <button type="button" onClick={() => { setEditing(null); setName(''); setPhone('') }} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-300">Cancel</button>}
            </div>
          </form>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-white">Your contacts</h2>
              <p className="mt-1 text-xs text-white/45">Stored only on this device</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">{contacts.length}</span>
              <button type="button" onClick={deleteAllContacts} disabled={!contacts.length}
                className="rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-white/70 transition hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-30">
                Delete all
              </button>
            </div>
          </div>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search contacts..."
            className="mt-4 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-sm text-white outline-none focus:border-white/60" />
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
                {contacts.length ? 'No contacts match your search.' : 'No contacts yet. Import from your phone or computer.'}
              </div>
            ) : filtered.map(contact => (
              <div key={contact.phone} className="vn-whatsapp-contact-row flex items-center gap-2 min-w-0 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left hover:bg-white/10">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 text-sm font-semibold text-white">{contact.name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() || 'V'}</div>
                <div className="min-w-0 flex-1">
                  <div className="block w-full text-sm font-medium text-white whitespace-normal break-words">{contact.name}</div>
                  <div className="block text-xs text-white/50">+{contact.phone}</div>
                </div>
                <button onClick={() => openChat(contact)} className="rounded-md border border-white/10 px-2 py-1.5 text-[11px] text-white/80 hover:bg-white/10">Open chat</button>
                <button onClick={() => editContact(contact)} className="rounded-md border border-white/10 px-2 py-1.5 text-[11px] text-white/65 hover:bg-white/10">Edit</button>
                <button onClick={() => removeContact(contact)} className="rounded-md border border-white/10 px-2 py-1.5 text-[11px] text-white/65 hover:bg-white/10">Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4 text-sm text-slate-300" role="status">
        <strong className="text-white">Device contact status:</strong> {notice}
        <p className="mt-2 text-xs text-slate-500">Only contacts you select or import are stored. Your contact list is stored locally on this device and is not synced to your Visionary Nexus account. This does not extract contacts from WhatsApp itself or read your WhatsApp conversations.</p>
      </div>
    </section>
  )
}
