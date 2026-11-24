export type AppKnowledgeOutcome = "intent" | "launched" | "action_completed" | "launch_failed"

export type AppKnowledgeRecord = {
  app: string
  category: string
  aliases: string[]
  observedActions: string[]
  successfulActions: string[]
  launches: number
  lastOutcome: AppKnowledgeOutcome
  lastUsedAt: string
}

export type AppKnowledgeSnapshot = {
  version: 1
  records: AppKnowledgeRecord[]
  preferredApps: Record<string, string>
}

const STORAGE_KEY = "visionary-app-knowledge-v1"
const MAX_RECORDS = 40
const MAX_ALIASES = 12
const MAX_ACTIONS = 20

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80)
}

function readSnapshot(): AppKnowledgeSnapshot {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null")
    if (parsed?.version === 1 && Array.isArray(parsed.records)) {
      return {
        version: 1,
        records: parsed.records.filter((item: any) =>
          item && typeof item.app === "string" && typeof item.category === "string",
        ).slice(0, MAX_RECORDS),
        preferredApps: parsed.preferredApps && typeof parsed.preferredApps === "object"
          ? parsed.preferredApps
          : {},
      }
    }
  } catch {
    // Storage may be unavailable or contain an older/corrupt value.
  }
  return { version: 1, records: [], preferredApps: {} }
}

function writeSnapshot(snapshot: AppKnowledgeSnapshot): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Keep app control working when storage is disabled or full.
  }
}

export function inferAppCategory(message: string, action = ""): string {
  const text = (message + " " + action).toLowerCase()
  if (/music|song|playlist|artist|phonk|spotify|youtube music/.test(text)) return "music"
  if (/game|gaming|play a game|chess/.test(text)) return "games"
  if (/tweet|repost|social|post|reply|timeline|instagram|linkedin|pinterest|reddit|\bx\b/.test(text)) return "social"
  if (/mail|email|inbox|gmail|outlook/.test(text)) return "email"
  if (/message|chat|whatsapp|text|discord/.test(text)) return "messaging"
  if (/map|route|navigation|directions/.test(text)) return "navigation"
  if (/video|youtube|stream|watch|twitch/.test(text)) return "video"
  if (/browser|website|web page|site/.test(text)) return "web"
  if (/document|write|note|file|spreadsheet|drive|notion|canva/.test(text)) return "productivity"
  if (/khan academy|stack overflow|lesson|course|tutorial/.test(text)) return "learning"
  return "general"
}

export function rememberAppKnowledge(input: {
  app: string
  category?: string
  aliases?: string[]
  action?: string
  outcome: AppKnowledgeOutcome
}): void {
  if (typeof window === "undefined") return
  const app = normalize(input.app)
  if (!app) return
  const category = normalize(input.category || "general").toLowerCase()
  const action = normalize(input.action || "open").toLowerCase().replace(/[^a-z0-9_ -]/g, "")
  const snapshot = readSnapshot()
  const key = app.toLowerCase()
  const existing = snapshot.records.find(item => item.app.toLowerCase() === key)
  const record: AppKnowledgeRecord = existing || {
    app,
    category,
    aliases: [],
    observedActions: [],
    successfulActions: [],
    launches: 0,
    lastOutcome: input.outcome,
    lastUsedAt: new Date().toISOString(),
  }
  record.app = app
  record.category = category
  record.aliases = Array.from(new Set([
    ...record.aliases,
    ...(input.aliases || []).map(normalize).filter(Boolean),
  ])).slice(0, MAX_ALIASES)
  if (action) {
    record.observedActions = Array.from(new Set([...record.observedActions, action])).slice(-MAX_ACTIONS)
    if (input.outcome === "launched" || input.outcome === "action_completed") {
      record.successfulActions = Array.from(new Set([...record.successfulActions, action])).slice(-MAX_ACTIONS)
    }
  }
  if (input.outcome === "launched") record.launches += 1
  record.lastOutcome = input.outcome
  record.lastUsedAt = new Date().toISOString()
  snapshot.records = [record, ...snapshot.records.filter(item => item.app.toLowerCase() !== key)]
    .slice(0, MAX_RECORDS)
  writeSnapshot(snapshot)
}

export function setPreferredApp(category: string, app: string): void {
  if (typeof window === "undefined") return
  const cleanCategory = normalize(category).toLowerCase()
  const cleanApp = normalize(app)
  if (!cleanCategory || !cleanApp) return
  const snapshot = readSnapshot()
  snapshot.preferredApps[cleanCategory] = cleanApp
  writeSnapshot(snapshot)
}

export function getPreferredApp(category: string): string {
  if (typeof window === "undefined") return ""
  return readSnapshot().preferredApps[normalize(category).toLowerCase()] || ""
}

export function getMostRecentApp(category: string): string {
  if (typeof window === "undefined") return ""
  const normalizedCategory = normalize(category).toLowerCase()
  return readSnapshot().records.find(item => item.category.toLowerCase() === normalizedCategory)?.app || ""
}

export function getAppKnowledgeContext(preferredMusicApp = ""): string {
  if (typeof window === "undefined") return ""
  const snapshot = readSnapshot()
  const records = snapshot.records.slice(0, 15).map(item => ({
    app: item.app,
    category: item.category,
    aliases: item.aliases,
    observed_actions: item.observedActions,
    successful_actions: item.successfulActions,
    launches: item.launches,
    last_outcome: item.lastOutcome,
  }))
  const context = {
    preferred_apps: {
      ...snapshot.preferredApps,
      ...(preferredMusicApp ? { music: preferredMusicApp } : {}),
    },
    known_apps: records,
  }
  return JSON.stringify(context).slice(0, 6000)
}

export function clearAppKnowledge(): void {
  if (typeof window === "undefined") return
  try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* no-op */ }
}
