import { registerPlugin } from '@capacitor/core'

export type PhoneContact = { name: string; phone: string }
export type AddressBookRollbackMatch = { rawId: number; name: string; phone: string }

type PhoneContactsPlugin = {
  importContacts(options: { all: boolean }): Promise<{ contacts: PhoneContact[] }>
  saveToAddressBook(options: { contacts: PhoneContact[] }): Promise<{ added: number; skipped: number }>
  previewAddressBookRollback(options: { contacts: PhoneContact[] }): Promise<{ matches: AddressBookRollbackMatch[] }>
  deleteAddressBookCopies(options: { matches: AddressBookRollbackMatch[] }): Promise<{ deleted: number; skipped: number }>
}

// Register once and share the same native bridge between WhatsApp and Calling.
export const PhoneContacts = registerPlugin<PhoneContactsPlugin>('PhoneContacts')
