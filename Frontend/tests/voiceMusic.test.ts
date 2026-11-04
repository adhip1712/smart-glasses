import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeWakeUtterance,
  findSavedPlaylist,
  parseMusicCommand,
  resolveYouTubePlayback,
  openNamedYouTubeWindow,
  youtubeSearchUrl,
  publishMusicCommand,
  consumePendingMusicCommand,
} from '../src/services/voiceMusic.ts'

test('wake word alone arms the next utterance', () => {
  assert.deepEqual(consumeWakeUtterance('Vision.', 'Vision', 'high'), {
    matched: true,
    command: '',
    armed: true,
  })
})

test('wake word and command in one utterance preserve the song query', () => {
  assert.deepEqual(consumeWakeUtterance('Okay, VISION! Play Montagem Elder.', 'Vision', 'high'), {
    matched: true,
    command: 'Play Montagem Elder.',
    armed: false,
  })
  assert.deepEqual(parseMusicCommand('Play Montagem Elder.'), {
    action: 'play',
    query: 'Montagem Elder',
  })
})

test('wake word in one utterance accepts a command in the next', () => {
  const wake = consumeWakeUtterance('Vision', 'Vision', 'high')
  assert.equal(wake.armed, true)
  assert.deepEqual(consumeWakeUtterance('Play Sem Demora', 'Vision', 'high', wake.armed), {
    matched: false,
    command: 'Play Sem Demora',
    armed: false,
  })
})

test('wake matching tolerates case, punctuation, and normal spacing', () => {
  assert.equal(consumeWakeUtterance('okay... vision, pause', 'Vision', 'high').command, 'pause')
  assert.equal(consumeWakeUtterance('television, play phonk', 'Vision', 'high').matched, false)
})

test('typed music commands preserve the original search query', () => {
  assert.deepEqual(parseMusicCommand('Play my Phonk playlist'), {
    action: 'play',
    query: 'my Phonk playlist',
  })
  assert.deepEqual(parseMusicCommand('Search for Sem Demora on YouTube'), {
    action: 'search',
    query: 'Sem Demora',
  })
  assert.deepEqual(parseMusicCommand('I want to listen to something'), { action: 'open', query: '' })
  assert.deepEqual(parseMusicCommand('listen to some music'), { action: 'open', query: '' })
  assert.equal(parseMusicCommand('I like listening to music while I work.'), null)
})

test('exact saved playlist names win over partial playlist matches', () => {
  const playlists = [{ name: 'Phonk Mix' }, { name: 'Phonk' }]
  assert.deepEqual(findSavedPlaylist('my Phonk playlist', playlists), { name: 'Phonk' })
  assert.deepEqual(findSavedPlaylist('Phonk Mix playlist', playlists), { name: 'Phonk Mix' })
})

test('YouTube search success resolves to a valid watch page', async () => {
  const resolution = await resolveYouTubePlayback(
    'Sem Demora',
    [{ id: 'dQw4w9WgXcQ', name: 'Sem Demora' }],
    false,
    async () => [],
  )
  assert.equal(resolution.source, 'youtube-api')
  assert.equal(resolution.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1')
})

test('quota exhaustion uses alternative YouTube results before navigating', async () => {
  let fallbackCalls = 0
  const resolution = await resolveYouTubePlayback(
    'phonk',
    [],
    true,
    async () => {
      fallbackCalls++
      return [{ id: 'M7lc1UVf-VE', name: 'Phonk' }]
    },
  )
  assert.equal(fallbackCalls, 1)
  assert.equal(resolution.source, 'alternative')
  assert.equal(resolution.url, 'https://www.youtube.com/watch?v=M7lc1UVf-VE&autoplay=1')
})

test('invalid or missing video IDs never become watch URLs', async () => {
  const resolution = await resolveYouTubePlayback(
    'Song & Artist',
    [{ id: 'bad-id', name: 'Song' }, { name: 'Missing ID' }],
    false,
    async () => [],
  )
  assert.equal(resolution.selected, null)
  assert.equal(resolution.url, youtubeSearchUrl('Song & Artist'))
  assert.equal(resolution.url, 'https://www.youtube.com/results?search_query=Song%20%26%20Artist')
})

test('alternative search failure falls back to YouTube search results', async () => {
  const resolution = await resolveYouTubePlayback('unknown song', [], true, async () => {
    throw new Error('All Piped and Invidious instances failed')
  })
  assert.equal(resolution.source, 'youtube-search')
  assert.equal(resolution.url, youtubeSearchUrl('unknown song'))
  assert.match(String(resolution.alternativeError), /instances failed/)
})


test('music command handoff stays queued until the music listener consumes it', () => {
  const originalWindow = (globalThis as any).window
  let dispatched: any = null
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: (event: any) => { dispatched = event; return true } },
  })
  try {
    const command = publishMusicCommand({
      activeTab: 'music', provider: 'youtube', intent: 'music',
      action: 'play', query: 'phonk', text: 'play phonk',
    })
    assert.equal(dispatched.type, 'visionary:youtube-command')
    assert.equal(dispatched.detail.commandId, command.commandId)
    assert.deepEqual(consumePendingMusicCommand(), command)
    assert.equal(consumePendingMusicCommand(), null)
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('named YouTube window is reused and its URL is updated in place', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const openedUrls: string[] = []
  const openedTargets: string[] = []
  const tab = { closed: false, location: { href: '' } }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      open: (url: string, target: string) => {
        openedUrls.push(url)
        openedTargets.push(target)
        return tab
      },
    },
  })

  try {
    assert.equal(openNamedYouTubeWindow(youtubeSearchUrl('Montagem Elder')), true)
    assert.equal(openNamedYouTubeWindow('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true)
    assert.equal(openNamedYouTubeWindow('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true)
    assert.equal(openedUrls.length, 1)
    assert.equal(openedTargets[0], 'visionary-nexus-youtube')
    assert.equal(tab.location.href, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  } finally {
    tab.closed = true
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('a blocked YouTube popup reports failure for the UI fallback', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { open: () => null },
  })
  try {
    assert.equal(openNamedYouTubeWindow(youtubeSearchUrl('phonk')), false)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})


test('an unrelated AI voice event cannot clear a queued YouTube command', () => {
  const originalWindow = (globalThis as any).window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: () => true } })
  try {
    const command = publishMusicCommand({ activeTab: 'music', provider: 'youtube', intent: 'music', action: 'play', query: 'phonk', text: 'play phonk' })
    // An event without this command's ID must not clear the pending handoff.
    assert.equal(consumePendingMusicCommand()?.commandId, command.commandId)
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})
