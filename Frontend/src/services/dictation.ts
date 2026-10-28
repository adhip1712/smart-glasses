export function correctDictation(input: string): string {
  let text = input.replace(/\s+/g, ' ').trim()
  const fixes: Array<[RegExp, string]> = [
    [/\bplay list\b/gi, 'playlist'],
    [/\bplaylists?\s+is\b/gi, 'playlist is'],
    [/\bprevios\b/gi, 'previous'],
    [/\bprevius\b/gi, 'previous'],
    [/\bnexts?\s+song\b/gi, 'next song'],
    [/\bpaus\b/gi, 'pause'],
    [/\bresum\b/gi, 'resume'],
    [/\bdelte\b/gi, 'delete'],
    [/\bremov\b/gi, 'remove'],
    [/\bnavagation\b/gi, 'navigation'],
    [/\bweather forcast\b/gi, 'weather forecast'],
    [/\bsmart glases\b/gi, 'smart glasses'],
    [/\bsmart glass's\b/gi, 'smart glasses'],
    [/\bwi fi\b/gi, 'Wi-Fi'],
    [/\bwi-fi\b/gi, 'Wi-Fi'],
  ]
  for (const [pattern, replacement] of fixes) text = text.replace(pattern, replacement)
  if (!text) return text
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (/^(what|who|where|when|why|how|can|could|would|is|are|do|does|did)\b/i.test(text) && !/[.!?]$/.test(text)) {
    text += '?'
  }
  return text
}

export function isTextEntry(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly
  if (target instanceof HTMLInputElement) {
    return !target.disabled && !target.readOnly && ['text', 'search', 'email', 'url', 'tel', ''].includes(target.type)
  }
  return target.isContentEditable
}
