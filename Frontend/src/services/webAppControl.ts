export type WebAppId =
  | "youtube" | "spotify" | "x" | "gmail" | "google-maps"
  | "google" | "wikipedia" | "reddit" | "github" | "twitch"

type WebAppDefinition = {
  label: string
  aliases: string[]
  home: string
  search: (query: string) => string
  vocabulary: string[]
}

const WEB_APPS: Record<WebAppId, WebAppDefinition> = {
  youtube: {
    label: "YouTube", aliases: ["youtube", "yt"],
    home: "https://www.youtube.com/",
    search: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    vocabulary: ["videos", "channels", "playlists", "subscriptions", "shorts"],
  },
  spotify: {
    label: "Spotify", aliases: ["spotify"],
    home: "https://open.spotify.com/",
    search: q => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    vocabulary: ["tracks", "songs", "artists", "albums", "playlists", "queue"],
  },
  x: {
    label: "X", aliases: ["x", "twitter"],
    home: "https://x.com/",
    search: q => `https://x.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["posts", "tweets", "reposts", "likes", "replies"],
  },
  gmail: {
    label: "Gmail", aliases: ["gmail", "google mail"],
    home: "https://mail.google.com/",
    search: q => `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`,
    vocabulary: ["emails", "inbox", "labels", "drafts"],
  },
  "google-maps": {
    label: "Google Maps", aliases: ["google maps", "maps"],
    home: "https://maps.google.com/",
    search: q => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    vocabulary: ["places", "routes", "directions", "nearby"],
  },
  google: {
    label: "Google", aliases: ["google", "search"],
    home: "https://www.google.com/",
    search: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["web pages", "images", "news", "results"],
  },
  wikipedia: {
    label: "Wikipedia", aliases: ["wikipedia", "wiki"],
    home: "https://www.wikipedia.org/",
    search: q => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
    vocabulary: ["articles", "topics", "references"],
  },
  reddit: {
    label: "Reddit", aliases: ["reddit"],
    home: "https://www.reddit.com/",
    search: q => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
    vocabulary: ["communities", "posts", "comments"],
  },
  github: {
    label: "GitHub", aliases: ["github"],
    home: "https://github.com/",
    search: q => `https://github.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["repositories", "code", "issues", "pull requests"],
  },
  twitch: {
    label: "Twitch", aliases: ["twitch"],
    home: "https://www.twitch.tv/",
    search: q => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
    vocabulary: ["streams", "channels", "categories"],
  },
}

export type WebAppCommand = {
  app: WebAppId
  query: string
  action: "open" | "search"
}

export function parseWebAppCommand(command: string): WebAppCommand | null {
  const clean = command.trim()
  const searchFirst = clean.match(/^(?:please\s+)?(?:search|find)\s+(.+?)\s+(?:on|in)\s+(.+?)\s*[.!?]*$/i)
  const appFirst = clean.match(/^(?:please\s+)?(?:open|launch|go to|visit)\s+(?:the\s+)?(.+?)(?:\s+(?:and\s+)?(?:search|find)\s+(?:for\s+)?(.+?))?\s*[.!?]*$/i)
  const rawApp = (searchFirst?.[2] || appFirst?.[1] || "").trim().toLowerCase()
  if (!rawApp) return null
  const app = (Object.entries(WEB_APPS).find(([, definition]) =>
    definition.aliases.includes(rawApp)
  )?.[0] || null) as WebAppId | null
  if (!app) return null
  const query = (searchFirst?.[1] || appFirst?.[2] || "").trim()
  return { app, query, action: query ? "search" : "open" }
}

export function getWebAppDefinition(app: WebAppId): WebAppDefinition {
  return WEB_APPS[app]
}

export function buildWebAppUrl(command: WebAppCommand): string {
  const definition = WEB_APPS[command.app]
  return command.query ? definition.search(command.query) : definition.home
}

/**
 * Opens a destination in a browser tab reserved synchronously from the user's
 * interaction. A website cannot inspect or click inside another origin; this
 * helper deliberately reports navigation handoff, not verified page actions.
 */
export function openWebDestination(url: string, reservedWindow?: Window | null): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  if (reservedWindow && !reservedWindow.closed) {
    reservedWindow.location.replace(parsed.href)
    return true
  }
  const opened = window.open(parsed.href, "_blank", "noopener,noreferrer")
  return Boolean(opened)
}

export function getWebAppCapabilityContext(): string {
  return Object.entries(WEB_APPS).map(([id, app]) =>
    `${id}: ${app.label}; vocabulary: ${app.vocabulary.join(", ")}`
  ).join("\n")
}
