export type ParsedWhatsAppMessage = { recipient: string; message: string }

export function normalizeContactName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function parseWhatsAppMessageIntent(raw: string): ParsedWhatsAppMessage | null {
  const text = raw.trim().replace(/^[,\s]+|[.!?]+$/g, '').replace(/^(?:hey\s+)?vision[, ]+/i, '').trim()
  if (!text) return null

  const chooseRecipient = text.match(/^(?:please\s+)?(?:send|open)\s+(?:a\s+)?(?:whatsapp\s+)?message\s+to\s+(.+)$/i)
  if (chooseRecipient) return { recipient: chooseRecipient[1].replace(/[?.!,]+$/g, '').trim(), message: '' }

  const tellChooseRecipient = text.match(/^(?:please\s+)?(?:tell|tel|teel|tll)\s+(?:send\s+)?message\s+to\s+(.+)$/i)
  if (tellChooseRecipient) return { recipient: tellChooseRecipient[1].replace(/[?.!,]+$/g, '').trim(), message: '' }

  if (/^(?:please\s+)?(?:tell|tel|teel|tll|send|open)\s+(?:send\s+)?message$/i.test(text)) {
    return { recipient: '', message: '' }
  }

  const tellGreeting = text.match(/^(?:please\s+)?(?:tell|tel|teel|tll)\s+(hi|hello|hey|good morning|good night)\s+to\s+(.+)$/i)
  if (tellGreeting) return { recipient: tellGreeting[2].replace(/[?.!,]+$/g, '').trim(), message: tellGreeting[1] }

  const sendTo = text.match(/^(?:please\s+)?(?:send|message|text)\s+(.+?)\s+to\s+(.+)$/i)
  if (sendTo) {
    const message = sendTo[1].replace(/^[, ]+|[, ]+$/g, '').trim()
    const recipient = sendTo[2].replace(/[?.!,]+$/g, '').trim()
    if (recipient && message) return { recipient, message }
  }

  const tellRecipient = text.match(/^(?:please\s+)?(?:tell|tel|teel|tll)\s+(.+?)\s+(?:to\s+)?(.+)$/i)
  if (tellRecipient) {
    const recipient = tellRecipient[1].replace(/[?.!,]+$/g, '').trim()
    const message = tellRecipient[2].replace(/^[, ]+|[, ]+$/g, '').trim()
    if (recipient && message) return { recipient, message }
  }

  const openChat = text.match(/^(?:please\s+)?(?:tell|tel|teel|tll|whatsapp|message)\s+(.+)$/i)
  if (openChat) {
    const recipient = openChat[1].replace(/[?.!,]+$/g, '').trim()
    if (recipient && !/^(hi|hello|hey|good morning|good night)$/i.test(recipient)) return { recipient, message: '' }
  }
  return null
}
