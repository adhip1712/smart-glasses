export type ParsedCallIntent = { recipient: string; channel: 'phone' | 'whatsapp' }

export function parseCallIntent(raw: string): ParsedCallIntent | null {
  const text = raw.trim().replace(/^[,\s]+|[.!?]+$/g, '')
  if (!text) return null
  const patterns = [
    /^(?:hey\s+)?(?:vision[ ,]+)?(?:whatsapp\s+call|call|cal)\s+(.+?)(?:\s+on\s+whatsapp)?$/i,
    /^(?:(?:i\s+(?:want|would\s+like|need)\s+to)\s+)?(?:speak|talk)\s+(?:to|with)\s+(.+?)(?:\s+on\s+whatsapp)?$/i,
    /^(?:can|could)\s+i\s+(?:speak|talk)\s+(?:to|with)\s+(.+?)(?:\s+on\s+whatsapp)?$/i,
    /^(?:connect\s+me\s+to|put\s+me\s+through\s+to)\s+(.+)$/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match?.[1]) continue
    const recipient = match[1].replace(/\s+on\s+whatsapp$/i, '').replace(/[?.!,]+$/g, '').trim()
    if (!recipient) continue
    return { recipient, channel: /whatsapp/i.test(text) ? 'whatsapp' : 'phone' }
  }
  return null
}
