import React, {
  useEffect,
  useRef,
  useState,
} from "react"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

// =========================================================
// BROWSER SPEECH RECOGNITION TYPES
// =========================================================

declare global {
  interface Window {
    SpeechRecognition: any
    webkitSpeechRecognition: any
  }
}

// =========================================================
// TYPES
// =========================================================

type Message = {
  id: number
  role: "user" | "ai" | "assistant"
  content: string
}

type ChatTab = {
  id: number
  title: string
}

type MusicTrack = {
  id?: string
  name?: string
  artist?: string
  album?: string
  duration?: number
  image?: string
  audio?: string
  url?: string
  genre?: string
  score?: number
  videoId?: string
  provider?: string
}

type MusicSearchResult = {
  tracks: MusicTrack[]
  needsConfirmation: boolean
  notice?: string
}

type YouTubeConnectionState =
  | "NOT_CONFIGURED"
  | "READY"
  | "ERROR"

type NavigationResult = {
  success?: boolean
  destination?: string
  distance_km?: number
  duration_minutes?: number
  steps?: Array<{
    instruction?: string
    type?: string
    modifier?: string
    distance_meters?: number
  }>
  message?: string
}

// =========================================================
// API
// =========================================================

// Relative by default: the Vite dev/preview server proxies /api to the
// backend (see vite.config.ts), which also keeps the app usable when the
// browser is not running inside the sandbox.
const API_URL =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_API_URL ??
  ""

// =========================================================
// COMPONENT
// =========================================================

const AIAssistant: React.FC<{ onNavigate?: (destination: string) => void }> = ({ onNavigate }) => {
  // =======================================================
  // CHAT STATE
  // =======================================================

  const [tabs, setTabs] = useState<ChatTab[]>([])
  const [activeTab, setActiveTab] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isThinking, setIsThinking] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [tabsLoading, setTabsLoading] = useState(true)

  // =======================================================
  // MUSIC STATE
  // =======================================================

  const [musicPlaying, setMusicPlaying] = useState(false)
  const [youtubeConfigured, setYoutubeConfigured] = useState(false)
  const [musicProvider, setMusicProvider] = useState("none")
  const [youtubeStatus, setYoutubeStatus] =
    useState<YouTubeConnectionState>("NOT_CONFIGURED")
  const [youtubeError, setYoutubeError] = useState("")
  const [youtubePlayerReady, setYoutubePlayerReady] = useState(false)
  const [currentTrack, setCurrentTrack] =
    useState<MusicTrack | null>(null)

  const [musicTracks, setMusicTracks] =
    useState<MusicTrack[]>([])

  const [musicCurrentIndex, setMusicCurrentIndex] =
    useState(-1)

  // =======================================================
  // REFS
  // =======================================================

  const inputRef = useRef<HTMLInputElement>(null)

  const audioRef =
    useRef<HTMLAudioElement | null>(null)

  const youtubePlayerRef =
    useRef<any>(null)

  const youtubeApiReadyRef =
    useRef<Promise<void> | null>(null)

  const youtubePlayerContainerId =
    "visionary-youtube-player"

  const musicTracksRef =
    useRef<MusicTrack[]>([])

  const musicCurrentIndexRef =
    useRef(-1)

  // =======================================================
  // SHORT TITLE
  // =======================================================

  const createShortTitle = (text: string) => {
    const cleaned = text
      .replace(/\s+/g, " ")
      .trim()

    if (!cleaned) {
      return "New Chat"
    }

    if (cleaned.length <= 30) {
      return cleaned
    }

    return cleaned.slice(0, 27).trimEnd() + "..."
  }

  // Infer broad topics locally so unrelated prompts open separate chats.
  // Short follow-ups such as "how?", "why?" and "explain" intentionally
  // return null and stay in the current conversation.
  const inferTopic = (value: string): string | null => {
    const text = value.toLowerCase().replace(/[^a-z0-9+*/×÷.-]+/g, " ").trim()
    if (!text || /^(how|why|what do you mean|explain|tell me more|continue|and then|example|give an example|can you explain|what about)\??$/.test(text)) {
      return null
    }

    const rules: Array<[string, RegExp]> = [
      ["math", /\b(math|mathematics|calculate|calculation|equation|algebra|geometry|fraction|percentage|multiply|multiplication|divide|addition|subtract|square root|\d+\s*[x×*÷/]\s*\d+|\d+\s*[+\-]\s*\d+)\b/i],
      ["ai", /\b(ai|artificial intelligence|machine learning|neural network|large language model|chatgpt|llm)\b/i],
      ["coding", /\b(code|coding|programming|python|javascript|typescript|react|fastapi|api|debug|bug|compiler|database|sql|github|git)\b/i],
      ["weather", /\b(weather|temperature|forecast|rain|humidity)\b/i],
      ["navigation", /\b(navigate|navigation|directions|route|map|distance|how do i get to|take me to)\b/i],
      ["music", /\b(music|song|singer|album|playlist|apple music|youtube music|play track)\b/i],
      ["science", /\b(science|physics|chemistry|biology|force|energy|atom|molecule|electricity|gravity|photosynthesis)\b/i],
      ["history", /\b(history|historical|revolution|empire|maratha|peshwa|renaissance|french revolution|gandhi|independence)\b/i],
      ["geography", /\b(geography|country|capital|continent|river|mountain|climate|population|map)\b/i],
      ["english", /\b(english|grammar|essay|poem|poetry|literature|synonym|antonym|pronunciation|meaning of)\b/i],
      ["school", /\b(homework|exam|textbook|class 8|grade 8|worksheet|question paper|mcq|syllabus)\b/i],
      ["sports", /\b(football|soccer|cricket|basketball|tennis|player|team|match|boots)\b/i],
      ["travel", /\b(travel|trip|hotel|flight|scuba|diving|tourism|vacation|dam(an|a)n|diu)\b/i],
      ["food", /\b(food|recipe|cook|cooking|restaurant|lunch|dinner|breakfast|ingredients)\b/i],
    ]

    for (const [topic, pattern] of rules) {
      if (pattern.test(text)) return topic
    }

    if (/^\d+(?:\s*[x×*÷/+\-]\s*\d+)+$/.test(text)) return "math"
    if (/^(what is|who is|where is|when did|define)\s+.+/.test(text)) {
      const subject = text.replace(/^(what is|who is|where is|when did|define)\s+/, "").split(" ").slice(0, 3).join(" ")
      return subject || null
    }
    return null
  }

  const firstUserPrompt = (items: Message[]) =>
    items.find(item => item.role === "user")?.content || ""

  // ReactMarkdown does not render LaTeX math by itself. Convert common
  // math commands to readable Unicode before Markdown parsing, while leaving
  // fenced code examples untouched.
  const formatAssistantMath = (content: string): string =>
    content
      .split(/(```[\s\S]*?```)/g)
      .map((part, index) => {
        if (index % 2 === 1) return part

        return part
          .replace(/\\times\b/g, "\u00D7")
          .replace(/\\div\b/g, "\u00F7")
          .replace(/\\cdot\b/g, "\u00B7")
          .replace(/\\pm\b/g, "\u00B1")
          .replace(/\\leq?\b/g, "\u2264")
          .replace(/\\geq?\b/g, "\u2265")
          .replace(/\\neq\b/g, "\u2260")
          .replace(/\\approx\b/g, "\u2248")
          .replace(/\\infty\b/g, "\u221E")
          .replace(/\\sqrt\s*\{([^{}]+)\}/g, "\u221A($1)")
          .replace(/\\left\b/g, "")
          .replace(/\\right\b/g, "")
          .replace(/\\[([]/g, "")
          .replace(/\\[)\]]/g, "")
          .replace(/\$([^$\n]+)\$/g, "$1")
      })
      .join("")

  // =======================================================
  // LOAD TABS
  // =======================================================

  const loadTabs = async () => {
    try {
      setTabsLoading(true)

      const response = await fetch(
        `${API_URL}/api/conversations`
      )

      if (!response.ok) {
        throw new Error(
          `Failed to load conversations: ${response.status}`
        )
      }

      const data = await response.json()

      const conversations = Array.isArray(data)
        ? data
        : data.conversations || []

      const loadedTabs: ChatTab[] =
        conversations.map((conversation: any) => ({
          id: conversation.id,
          title: conversation.title || "New Chat",
        }))

      setTabs(loadedTabs)

      const savedTab =
        localStorage.getItem("visionary_active_tab")

      const savedTabId =
        savedTab ? Number(savedTab) : null

      const savedExists =
        savedTabId !== null &&
        loadedTabs.some(
          tab => tab.id === savedTabId
        )

      if (savedExists) {
        setActiveTab(savedTabId)
        await loadMessages(savedTabId!)
      } else if (loadedTabs.length > 0) {
        const firstTab = loadedTabs[0]

        setActiveTab(firstTab.id)

        localStorage.setItem(
          "visionary_active_tab",
          String(firstTab.id)
        )

        await loadMessages(firstTab.id)
      } else {
        await createNewTab()
      }
    } catch (error) {
      console.error(
        "Failed to load tabs:",
        error
      )
    } finally {
      setTabsLoading(false)
    }
  }

  // =======================================================
  // CREATE NEW TAB
  // =======================================================

  const createNewTab = async () => {
    try {
      const response = await fetch(
        `${API_URL}/api/conversations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: "New Chat",
          }),
        }
      )

      if (!response.ok) {
        throw new Error(
          `Failed to create chat: ${response.status}`
        )
      }

      const data = await response.json()

      if (data.success === false) {
        throw new Error(
          data.message ||
          "Failed to create chat"
        )
      }

      const newTab: ChatTab = {
        id: data.id,
        title: data.title || "New Chat",
      }

      setTabs(previous => [
        ...previous,
        newTab,
      ])

      setActiveTab(newTab.id)

      localStorage.setItem(
        "visionary_active_tab",
        String(newTab.id)
      )

      setMessages([])

      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)

      return newTab.id
    } catch (error) {
      console.error(
        "Failed to create chat:",
        error
      )

      return null
    }
  }

  // =======================================================
  // LOAD MESSAGES
  // =======================================================

  const loadMessages = async (
    conversationId: number
  ) => {
    try {
      const response = await fetch(
        `${API_URL}/api/conversations/${conversationId}/messages`
      )

      if (!response.ok) {
        throw new Error(
          `Failed to load messages: ${response.status}`
        )
      }

      const data = await response.json()

      const rawMessages = Array.isArray(data)
        ? data
        : data.messages || []

      const loadedMessages: Message[] =
        rawMessages.map((message: any) => ({
          id: message.id,
          role:
            message.role === "assistant" ||
            message.role === "ai"
              ? "ai"
              : "user",
          content: message.content,
        }))

      setMessages(loadedMessages)
    } catch (error) {
      console.error(
        "Failed to load messages:",
        error
      )

      setMessages([])
    }
  }

  // =======================================================
  // SWITCH TAB
  // =======================================================

  const switchTab = async (
    conversationId: number
  ) => {
    if (conversationId === activeTab) {
      return
    }

    setActiveTab(conversationId)

    localStorage.setItem(
      "visionary_active_tab",
      String(conversationId)
    )

    setMessages([])

    await loadMessages(conversationId)

    setTimeout(() => {
      inputRef.current?.focus()
    }, 100)
  }

  // =======================================================
  // DELETE TAB
  // =======================================================

  const deleteTab = async (
    conversationId: number
  ) => {
    try {
      const response = await fetch(
        `${API_URL}/api/conversations/${conversationId}`,
        {
          method: "DELETE",
        }
      )

      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
          "Failed to delete chat"
        )
      }

      const deletedIndex = tabs.findIndex(
        tab => tab.id === conversationId
      )

      const remainingTabs = tabs.filter(
        tab => tab.id !== conversationId
      )

      setTabs(remainingTabs)

      if (conversationId === activeTab) {
        if (remainingTabs.length > 0) {
          const newIndex = Math.min(
            deletedIndex,
            remainingTabs.length - 1
          )

          const newActiveTab =
            remainingTabs[
              Math.max(0, newIndex)
            ]

          setActiveTab(newActiveTab.id)

          localStorage.setItem(
            "visionary_active_tab",
            String(newActiveTab.id)
          )

          await loadMessages(
            newActiveTab.id
          )
        } else {
          setActiveTab(null)
          setMessages([])

          localStorage.removeItem(
            "visionary_active_tab"
          )

          await createNewTab()
        }
      }
    } catch (error) {
      console.error(
        "Failed to delete tab:",
        error
      )
    }
  }

  // =======================================================
  // TAB COMMANDS
  // =======================================================

  const handleTabCommand = (
    command: string
  ): boolean => {
    let text = command
      .trim()
      .toLowerCase()
      .replace(/[?.!,]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()

    if (!text) {
      return false
    }

    text = text
      .replace(/^can you\s+/, "")
      .replace(/^can u\s+/, "")
      .replace(/^could you\s+/, "")
      .replace(/^could u\s+/, "")
      .replace(/^please\s+/, "")
      .trim()

    // -------------------------------------------------------
    // DELETE
    // -------------------------------------------------------

    if (
      text === "delete tab" ||
      text === "delete this tab" ||
      text === "delete current tab" ||
      text === "delete chat" ||
      text === "delete this chat" ||
      text === "delete current chat" ||
      text === "remove tab" ||
      text === "remove this tab" ||
      text === "remove current tab" ||
      text === "remove chat" ||
      text === "remove this chat" ||
      text === "remove current chat" ||
      text === "close tab" ||
      text === "close this tab" ||
      text === "close chat" ||
      text === "close this chat"
    ) {
      if (activeTab !== null) {
        void deleteTab(activeTab)
      }

      return true
    }

    // -------------------------------------------------------
    // NEW CHAT
    // -------------------------------------------------------

    if (
      text === "new chat" ||
      text === "new tab" ||
      text === "create new chat" ||
      text === "create new tab" ||
      text === "start new chat" ||
      text === "start a new chat"
    ) {
      void createNewTab()
      return true
    }

    // -------------------------------------------------------
    // NEXT TAB
    // -------------------------------------------------------

    if (
      text === "next tab" ||
      text === "next chat" ||
      text === "go to next tab" ||
      text === "switch to next tab"
    ) {
      if (tabs.length === 0) {
        return true
      }

      const currentIndex =
        tabs.findIndex(
          tab => tab.id === activeTab
        )

      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + 1) % tabs.length

      void switchTab(
        tabs[nextIndex].id
      )

      return true
    }

    // -------------------------------------------------------
    // PREVIOUS TAB
    // -------------------------------------------------------

    if (
      text === "previous tab" ||
      text === "previous chat" ||
      text === "last tab" ||
      text === "go to previous tab" ||
      text === "switch to previous tab"
    ) {
      if (tabs.length === 0) {
        return true
      }

      const currentIndex =
        tabs.findIndex(
          tab => tab.id === activeTab
        )

      const previousIndex =
        currentIndex <= 0
          ? tabs.length - 1
          : currentIndex - 1

      void switchTab(
        tabs[previousIndex].id
      )

      return true
    }

    // -------------------------------------------------------
    // NUMBERED TAB
    // -------------------------------------------------------

    const numberMatch = text.match(
      /^(?:switch to|go to|open)\s+(?:chat|tab)\s+(\d+)$/
    )

    if (numberMatch) {
      const number = Number(
        numberMatch[1]
      )

      const target =
        tabs[number - 1]

      if (target) {
        void switchTab(target.id)
      }

      return true
    }

    // -------------------------------------------------------
    // SHORT NUMBER
    // -------------------------------------------------------

    const shortNumberMatch = text.match(
      /^(?:chat|tab)\s+(\d+)$/
    )

    if (shortNumberMatch) {
      const number = Number(
        shortNumberMatch[1]
      )

      const target =
        tabs[number - 1]

      if (target) {
        void switchTab(target.id)
      }

      return true
    }

    // -------------------------------------------------------
    // TITLE SEARCH
    // -------------------------------------------------------

    let search = text

    search = search.replace(
      /^switch\s+to\s+/,
      ""
    )

    search = search.replace(
      /^go\s+to\s+/,
      ""
    )

    search = search.replace(
      /^open\s+/,
      ""
    )

    search = search.replace(
      /^the\s+/,
      ""
    )

    search = search.replace(
      /^tab\s+/,
      ""
    )

    search = search.replace(
      /^chat\s+/,
      ""
    )

    search = search.replace(
      /\s+(?:tab|chat)$/,
      ""
    )

    search = search.trim()

    const isSwitchCommand =
      text.startsWith("switch ") ||
      text.startsWith("go ") ||
      text.startsWith("open ")

    if (
      isSwitchCommand &&
      search
    ) {
      let target: ChatTab | undefined

      target = tabs.find(
        tab =>
          tab.title
            .toLowerCase()
            .trim() === search
      )

      if (!target) {
        target = tabs.find(
          tab =>
            tab.title
              .toLowerCase()
              .includes(search)
        )
      }

      if (!target) {
        target = tabs.find(
          tab =>
            search.includes(
              tab.title
                .toLowerCase()
                .replace(/\.{3}$/, "")
                .trim()
            )
        )
      }

      if (target) {
        void switchTab(target.id)
      }

      return true
    }

    return false
  }

  // =======================================================
  // LOCAL MESSAGE
  // =======================================================

  const addLocalMessage = (
    content: string
  ) => {
    setMessages(previous => [
      ...previous,
      {
        id:
          Date.now() +
          Math.random(),
        role: "ai",
        content,
      },
    ])
  }

  // =======================================================
  // AUDIO SETUP
  // =======================================================

  const setupAudio = () => {
    if (audioRef.current) {
      return audioRef.current
    }

    const audio = new Audio()

    audio.preload = "auto"

    audio.onplay = () => {
      setMusicPlaying(true)
    }

    audio.onpause = () => {
      setMusicPlaying(false)
    }

    audio.onended = () => {
      const endedTrack = musicTracksRef.current[musicCurrentIndexRef.current]
      setMusicPlaying(false)

      // iTunes only supplies a preview clip. Do not silently skip to another
      // song when that preview ends, because it looks like playback was cut off.
      if (endedTrack?.provider === "apple-itunes") {
        addLocalMessage("The Apple catalogue preview has ended. Full-length playback is not available from this preview source.")
        return
      }

      void playNextTrack()
    }

    audio.onerror = () => {
      setMusicPlaying(false)

      console.error(
        "Music playback error."
      )
    }

    audioRef.current = audio

    return audio
  }

  // =======================================================
  // YOUTUBE STATUS
  // =======================================================

  const getYoutubeStatusLabel = () => {
    if (youtubeStatus === "ERROR") {
      return youtubeError || "Music provider unavailable."
    }
    if (musicProvider === "audius") return "Audius · free full-track streaming"
    if (musicProvider === "apple-itunes") return "Apple catalogue · preview clips"
    if (musicProvider === "navidrome") return "Navidrome · full-track library"
    if (musicProvider === "mock") return "Demo music mode"
    if (musicProvider === "youtube" && youtubeStatus === "READY") return "YouTube playback ready"
    return "Music provider not configured"
  }

  const loadYouTubeIframeApi = async () => {
    if (typeof window === "undefined") {
      throw new Error("YouTube playback is only available in the browser.")
    }

    if ((window as any).YT && (window as any).YT.Player) {
      return
    }

    if (!youtubeApiReadyRef.current) {
      youtubeApiReadyRef.current = new Promise<void>((resolve, reject) => {
        const existingScript = document.querySelector(
          "script[src*='youtube.com/iframe_api']"
        ) as HTMLScriptElement | null

        if (existingScript) {
          existingScript.addEventListener("load", () => resolve(), { once: true })
          existingScript.addEventListener("error", () => reject(new Error("Could not load the YouTube IFrame API.")), { once: true })
          return
        }

        const script = document.createElement("script")
        script.src = "https://www.youtube.com/iframe_api"
        script.async = true
        ;(window as any).onYouTubeIframeAPIReady = () => resolve()
        script.onerror = () => reject(new Error("Could not load the YouTube IFrame API."))
        document.head.appendChild(script)
      })
    }

    await youtubeApiReadyRef.current
  }

  const ensureYoutubePlayer = async () => {
    await loadYouTubeIframeApi()

    if (youtubePlayerRef.current) {
      return youtubePlayerRef.current
    }

    let playerHost = document.getElementById(youtubePlayerContainerId) as HTMLDivElement | null

    if (!playerHost) {
      playerHost = document.createElement("div")
      playerHost.id = youtubePlayerContainerId
      // YouTube's IFrame player requires a viewport of at least 200x200.
      // A display:none / 0x0 player can stop playback shortly after starting.
      // Keep it off-screen but valid-sized so audio can continue normally.
      playerHost.style.position = "fixed"
      playerHost.style.left = "-10000px"
      playerHost.style.top = "0"
      playerHost.style.width = "200px"
      playerHost.style.height = "200px"
      playerHost.style.opacity = "0"
      playerHost.style.pointerEvents = "none"
      document.body.appendChild(playerHost)
    }

    youtubePlayerRef.current = new (window as any).YT.Player(playerHost.id, {
      height: "200",
      width: "200",
      playerVars: {
        playsinline: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          setYoutubeConfigured(true)
          setYoutubeStatus("READY")
          setYoutubePlayerReady(true)
        },
        onStateChange: (event: any) => {
          const state = event.data
          const YT = (window as any).YT

          if (state === YT.PlayerState.PLAYING) {
            setMusicPlaying(true)
          } else if (
            state === YT.PlayerState.PAUSED ||
            state === YT.PlayerState.ENDED ||
            state === YT.PlayerState.UNSTARTED
          ) {
            setMusicPlaying(false)
          }
        },
        onError: () => {
          setMusicPlaying(false)
          setYoutubeStatus("ERROR")
          setYoutubeError("The selected YouTube video cannot be played in the embedded player.")
        },
      },
    })

    return youtubePlayerRef.current
  }

  const checkYoutubeConfig = async () => {
    try {
      const response = await fetch(`${API_URL}/api/music/config`)
      const data = await response.json()

      if (!response.ok || !data.success || !data.configured) {
        setYoutubeConfigured(false)
        setMusicProvider("none")
        setYoutubeStatus("NOT_CONFIGURED")
        setYoutubeError(data.message || "Music provider is not configured.")
        return
      }

      const provider = String(data.provider || "none").toLowerCase()
      setMusicProvider(provider)
      setYoutubeConfigured(provider === "youtube")
      setYoutubeStatus("READY")
      setYoutubeError("")
    } catch (error) {
      console.error("YOUTUBE CONFIG CHECK FAILED:", error)
      setYoutubeConfigured(false)
      setYoutubeStatus("ERROR")
      setYoutubeError("Unable to check the YouTube music configuration.")
    }
  }

  const playYoutubeTrack = async (
    track: MusicTrack,
    index: number,
    tracks: MusicTrack[]
  ) => {
    if (!track.videoId) {
      throw new Error("This YouTube result is not playable in the embedded player.")
    }

    const player = await ensureYoutubePlayer()

    if (!player || !player.loadVideoById) {
      throw new Error("YouTube playback is not available in this browser.")
    }

    updateMusicQueue(tracks, index)
    setCurrentTrack(track)
    setMusicPlaying(false)

    try {
      player.loadVideoById(track.videoId)
      addLocalMessage(
        `Loading **${track.name || "Unknown track"}** by **${track.artist || "Unknown artist"}** on YouTube.`
      )

      window.setTimeout(() => {
        try {
          player.playVideo()
        } catch {
          // Let the browser handle gesture-based playback rules.
        }
      }, 200)
    } catch (error) {
      console.error("YOUTUBE PLAY FAILED:", error)
      throw new Error("YouTube playback requires a user gesture. Click the page and try again.")
    }
  }

  // =======================================================
  // SEARCH MUSIC
  // =======================================================

  const searchMusic = async (
    query: string
  ): Promise<MusicSearchResult> => {
    const response = await fetch(
      `${API_URL}/api/music/search`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          query,
        }),
      }
    )

    const data = await response.json()

    if (!response.ok) {
      throw new Error(
        data.message ||
        data.detail ||
        "Music search failed."
      )
    }

    if (data.success === false) {
      throw new Error(
        data.message ||
        "Music search failed."
      )
    }

    return {
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
      needsConfirmation: Boolean(data.needs_confirmation),
      notice: typeof data.notice === "string" ? data.notice : undefined,
    }
  }

  // =======================================================
  // UPDATE MUSIC QUEUE
  // =======================================================

  const updateMusicQueue = (
    tracks: MusicTrack[],
    index: number
  ) => {
    musicTracksRef.current = tracks

    musicCurrentIndexRef.current =
      index

    setMusicTracks(tracks)

    setMusicCurrentIndex(index)
  }

  // =======================================================
  // PLAY TRACK
  // =======================================================

  const playTrack = async (
    track: MusicTrack,
    index: number,
    tracks: MusicTrack[],
    prefix = "Playing"
  ) => {
    if (!track.audio) {
      throw new Error(
        "This track does not have a playable preview."
      )
    }

    const audio = setupAudio()

    audio.pause()

    try {
      audio.currentTime = 0
    } catch {
      // Ignore
    }

    audio.src = track.audio

    audio.load()

    updateMusicQueue(
      tracks,
      index
    )

    setCurrentTrack(track)

    try {
      await audio.play()
    } catch (error) {
      console.error(
        "Audio play error:",
        error
      )

      throw new Error(
        "The browser blocked audio playback. Click the page once and try again."
      )
    }

    addLocalMessage(
      `${prefix} **${
        track.name ||
        "Unknown track"
      }** by **${
        track.artist ||
        "Unknown artist"
      }**.`
    )
  }

  // =======================================================
  // PLAY MUSIC SONG
  // =======================================================

  const playMusicSong = async (
    query: string
  ) => {
    const cleanQuery =
      query.trim()

    if (!cleanQuery) {
      addLocalMessage(
        "Tell me which song you want to play."
      )

      return
    }

    setIsThinking(true)

    try {
      console.log(
        "MUSIC SEARCH:",
        cleanQuery
      )

      const searchResult =
        await searchMusic(
          cleanQuery
        )
      const tracks = searchResult.tracks

      console.log(
        "MUSIC RESULTS:",
        searchResult
      )

      if (searchResult.needsConfirmation) {
        const suggestions = tracks.slice(0, 5).map((candidate, index) =>
          `${index + 1}. ${candidate.name || "Untitled"} — ${candidate.artist || "Unknown artist"}`
        ).join("\n")
        addLocalMessage(
          `${searchResult.notice || "I couldn't identify the exact song."}\n\n${suggestions}\n\nTell me the exact title or artist and I’ll play that match.`
        )
        return
      }

      if (tracks.length === 0) {
        addLocalMessage(
          `I couldn't find a playable result for "${cleanQuery}".`
        )
        return
      }

      const playableTracks = tracks.filter(track => Boolean(track.videoId || track.audio))
      if (playableTracks.length === 0) {
        addLocalMessage(`I found "${cleanQuery}", but the provider returned no playable audio.`)
        return
      }

      // Don't auto-play a merely related result. The requested song title and,
      // when supplied, artist must be represented in the result metadata.
      const ignoredWords = new Set(["play", "please", "song", "music", "track", "the", "a", "an", "by", "on", "for", "me"])
      const artistMatch = cleanQuery.match(/\bby\s+(.+)$/i)
      const titleQuery = artistMatch ? cleanQuery.slice(0, artistMatch.index).trim() : cleanQuery
      const requestedTitleTokens = titleQuery.toLowerCase().match(/[a-z0-9]+/g)?.filter(token => !ignoredWords.has(token)) || []
      const requestedArtistTokens = artistMatch
        ? (artistMatch[1].toLowerCase().match(/[a-z0-9]+/g)?.filter(token => !ignoredWords.has(token)) || [])
        : []
      const requestedTokens = [...requestedTitleTokens, ...requestedArtistTokens]
      const matchingTracks = playableTracks.filter(candidate => {
        const titleTokens = new Set((candidate.name || "").toLowerCase().match(/[a-z0-9]+/g) || [])
        const artistTokens = new Set((candidate.artist || "").toLowerCase().match(/[a-z0-9]+/g) || [])
        if (requestedArtistTokens.length > 0) {
          return requestedTitleTokens.every(token => titleTokens.has(token)) &&
            requestedArtistTokens.every(token => artistTokens.has(token))
        }
        return requestedTitleTokens.every(token => titleTokens.has(token)) ||
          requestedTitleTokens.every(token => artistTokens.has(token))
      })

      if (requestedTokens.length > 0 && matchingTracks.length === 0) {
        addLocalMessage(
          `I found related results for "${cleanQuery}", but none matched the requested title and artist closely enough. I won't play an unrelated track. Try adding the exact artist or song title.`
        )
        return
      }

      const selectedTracks = matchingTracks.length ? matchingTracks : playableTracks
      const track = selectedTracks[0]
      if (track.videoId) {
        if (!youtubeConfigured) {
          addLocalMessage("This result needs the YouTube provider, but it is not configured.")
          return
        }
        await playYoutubeTrack(track, 0, selectedTracks)
        return
      }

      if (track.audio) {
        const isPreview = track.provider === "apple-itunes"
        await playTrack(track, 0, selectedTracks, isPreview ? "Playing preview:" : "Playing:")
        if (isPreview) {
          const fullTrackLink = track.url ? ` [Open the full track in Apple Music](${track.url})` : ""
          addLocalMessage(`Apple's iTunes catalogue only provides a short preview here, so it may stop after about 20–30 seconds. Full-length playback requires a streaming source or subscription.${fullTrackLink}`)
        }
        return
      }
    } catch (error) {
      console.error(
        "MUSIC PLAY FAILED:",
        error
      )

      addLocalMessage(
        error instanceof Error
          ? error.message
          : "Music playback failed."
      )
    } finally {
      setIsThinking(false)
    }
  }

  // =======================================================
  // PAUSE
  // =======================================================

  const pauseMusic = () => {
    const youtubePlayer = youtubePlayerRef.current

    if (youtubePlayer && typeof youtubePlayer.pauseVideo === "function") {
      youtubePlayer.pauseVideo()
      addLocalMessage("Music paused.")
      return
    }

    const audio =
      audioRef.current

    if (
      !audio ||
      !currentTrack
    ) {
      addLocalMessage(
        "No music is currently loaded."
      )

      return
    }

    if (audio.paused) {
      addLocalMessage(
        "Music is already paused."
      )

      return
    }

    audio.pause()

    addLocalMessage(
      "Music paused."
    )
  }

  // =======================================================
  // RESUME
  // =======================================================

  const resumeMusic = async () => {
    const youtubePlayer = youtubePlayerRef.current

    if (youtubePlayer && typeof youtubePlayer.playVideo === "function") {
      try {
        youtubePlayer.playVideo()
        addLocalMessage(
          `Resumed **${currentTrack?.name || "music"}**.`
        )
        return
      } catch (error) {
        console.error(
          "YOUTUBE RESUME FAILED:",
          error
        )
      }
    }

    const audio =
      audioRef.current

    if (
      !audio ||
      !currentTrack
    ) {
      addLocalMessage(
        "There is no music to resume."
      )

      return
    }

    try {
      await audio.play()

      addLocalMessage(
        `Resumed **${currentTrack.name || "music"}**.`
      )
    } catch (error) {
      console.error(
        "RESUME FAILED:",
        error
      )

      addLocalMessage(
        "I couldn't resume the music."
      )
    }
  }

  // =======================================================
  // NEXT TRACK
  // =======================================================

  const playNextTrack = async () => {
    const tracks =
      musicTracksRef.current

    const currentIndex =
      musicCurrentIndexRef.current

    if (tracks.length === 0) {
      addLocalMessage(
        "There is no music queue."
      )

      return
    }

    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + 1) % tracks.length

    const track =
      tracks[nextIndex]

    if (!track) {
      addLocalMessage(
        "There is no next track in the queue."
      )
      return
    }

    if (youtubeConfigured && track.videoId) {
      try {
        await playYoutubeTrack(track, nextIndex, tracks)
        return
      } catch (error) {
        console.error("NEXT YOUTUBE TRACK FAILED:", error)
      }
    }

    if (!track.audio) {
      addLocalMessage(
        "The next track is not playable in the current player."
      )

      return
    }

    try {
      await playTrack(
        track,
        nextIndex,
        tracks,
        "Playing next:"
      )
    } catch (error) {
      console.error(
        "NEXT TRACK FAILED:",
        error
      )

      addLocalMessage(
        "I couldn't play the next track."
      )
    }
  }

  // =======================================================
  // PREVIOUS TRACK
  // =======================================================

  const playPreviousTrack = async () => {
    const tracks =
      musicTracksRef.current

    const currentIndex =
      musicCurrentIndexRef.current

    if (tracks.length === 0) {
      addLocalMessage(
        "There is no music queue."
      )

      return
    }

    const previousIndex =
      currentIndex <= 0
        ? tracks.length - 1
        : currentIndex - 1

    const track =
      tracks[previousIndex]

    if (!track) {
      addLocalMessage(
        "There is no previous track in the queue."
      )
      return
    }

    if (youtubeConfigured && track.videoId) {
      try {
        await playYoutubeTrack(track, previousIndex, tracks)
        return
      } catch (error) {
        console.error("PREVIOUS YOUTUBE TRACK FAILED:", error)
      }
    }

    if (!track.audio) {
      addLocalMessage(
        "The previous track is not playable in the current player."
      )

      return
    }

    try {
      await playTrack(
        track,
        previousIndex,
        tracks,
        "Playing previous:"
      )
    } catch (error) {
      console.error(
        "PREVIOUS TRACK FAILED:",
        error
      )

      addLocalMessage(
        "I couldn't play the previous track."
      )
    }
  }
  // =======================================================
  // NAVIGATION
  // =======================================================

  const getNavigation = async (
    destination: string
  ) => {
    const safeDestination = destination.trim()

    if (!safeDestination) {
      addLocalMessage("I couldn't find that destination.")
      return
    }

    setIsThinking(true)

    try {
      const response = await fetch(
        `${API_URL}/api/navigation/route`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            destination: safeDestination,
            latitude: 12.9716,
            longitude: 77.5946,
          }),
        }
      )

      const data: NavigationResult = await response.json()

      if (!response.ok || data.success === false) {
        throw new Error(data.message || "Unable to retrieve route right now.")
      }

      const distance = data.distance_km ?? "unknown"
      const duration = data.duration_minutes ?? "unknown"
      const destinationName = data.destination || safeDestination

      let routeText = `### Route to ${destinationName}\n\n`
      routeText += `**Distance:** ${distance} km\n\n`
      routeText += `**Estimated travel time:** ${duration} minutes`

      if (Array.isArray(data.steps) && data.steps.length > 0) {
        routeText += "\n\n**Directions:**\n"
        data.steps.slice(0, 4).forEach((step, index) => {
          const instruction = step.instruction || "Continue"
          routeText += `${index + 1}. ${instruction}\n`
        })
      }

      addLocalMessage(routeText)
    } catch (error) {
      console.error("NAVIGATION REQUEST FAILED:", error)
      addLocalMessage(
        error instanceof Error ? error.message : "I couldn't find that destination."
      )
    } finally {
      setIsThinking(false)
    }
  }

  // =======================================================
  // WEATHER
  // =======================================================

  const getWeather = async (
    city: string
  ) => {
    setIsThinking(true)

    try {
      const response = await fetch(
        `${API_URL}/api/weather/${encodeURIComponent(
          city
        )}`
      )

      const data =
        await response.json()

      if (!response.ok) {
        throw new Error(
          data.message ||
          data.detail ||
          "Weather request failed."
        )
      }

      if (data.success === false) {
        throw new Error(
          data.message ||
          "Weather request failed."
        )
      }

      const temperature =
        data.temperature_c ??
        "unknown"

      const condition =
        data.condition ||
        "unknown"

      let weatherText =
        `### Weather in ${
          data.location ||
          city
        }\n\n`

      weatherText +=
        `**Temperature:** ${temperature}°C\n\n`

      weatherText +=
        `**Condition:** ${condition}`

      if (
        data.humidity !== undefined
      ) {
        weatherText +=
          `\n\n**Humidity:** ${data.humidity}%`
      }

      if (
        data.wind_kph !== undefined
      ) {
        weatherText +=
          `\n\n**Wind:** ${data.wind_kph} km/h`
      }

      addLocalMessage(
        weatherText
      )
    } catch (error) {
      console.error(
        "WEATHER REQUEST FAILED:",
        error
      )

      addLocalMessage(
        error instanceof Error
          ? error.message
          : "Weather request failed."
      )
    } finally {
      setIsThinking(false)
    }
  }

  // =======================================================
  // SPECIAL COMMAND ROUTER
  // =======================================================

  const handleSpecialCommand =
    async (
      command: string
    ): Promise<boolean> => {
      const normalized =
        command
          .toLowerCase()
          .trim()
          .replace(/[?.!,]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()

      // ===================================================
      // PLAY
      // ===================================================

      const playMatch =
        normalized.match(
          /^(?:play|play song|play the song|play music|listen to)\s+(.+)$/
        )

      if (playMatch) {
        await playMusicSong(
          playMatch[1].trim()
        )

        return true
      }

      const musicSearchMatch =
        normalized.match(
          /^(?:search for|find|look for|look up)\s+(.+)$/
        )

      if (musicSearchMatch) {
        await playMusicSong(
          musicSearchMatch[1].trim()
        )

        return true
      }

      // ===================================================
      // PAUSE
      // ===================================================

      if (
        normalized === "pause" ||
        normalized === "pause music" ||
        normalized === "stop music"
      ) {
        pauseMusic()

        return true
      }

      // ===================================================
      // RESUME
      // ===================================================

      if (
        normalized === "resume" ||
        normalized === "resume music" ||
        normalized === "continue music"
      ) {
        await resumeMusic()

        return true
      }

      // ===================================================
      // NEXT
      // ===================================================

      if (
        normalized === "next" ||
        normalized === "next song" ||
        normalized === "next track" ||
        normalized === "skip" ||
        normalized === "skip song"
      ) {
        await playNextTrack()

        return true
      }

      // ===================================================
      // PREVIOUS
      // ===================================================

      if (
        normalized === "previous" ||
        normalized === "previous song" ||
        normalized === "previous track" ||
        normalized === "last song"
      ) {
        await playPreviousTrack()

        return true
      }

      // ===================================================
      // WEATHER
      // ===================================================

      const weatherMatch =
        normalized.match(
          /^(?:what(?:'s| is)?\s+the\s+)?weather(?:\s+(?:in|at|for)\s+(.+))?(?:\s+tomorrow|\s+today)?$/
        )

      if (weatherMatch) {
        const city =
          weatherMatch[1]?.trim()

        if (!city) {
          const forecastMatch =
            normalized.match(
              /(?:weather|temperature|forecast)\s+(?:tomorrow|today)$/
            )

          if (forecastMatch) {
            await getWeather("Bengaluru")
            return true
          }

          addLocalMessage(
            'Tell me the city, for example: **weather in Bengaluru**.'
          )

          return true
        }

        await getWeather(city)

        return true
      }

      // ===================================================
      // WEATHER PHRASES
      // ===================================================

      const weatherPhrase =
        normalized.match(
          /(?:weather|temperature|forecast)\s+(?:in|at|for)\s+(.+)$/
        )

      if (weatherPhrase) {
        await getWeather(
          weatherPhrase[1].trim()
        )

        return true
      }

      const navigationMatch =
        normalized.match(
          /^(?:navigate|navigation|route|directions|take me to|how do i get to|find directions to)\s+(?:to\s+)?(.+)$/
        )

      if (navigationMatch) {
        const destination = navigationMatch[1].trim()
        await getNavigation(destination)
        return true
      }

      return false
    }

  // =======================================================
  // SEND MESSAGE
  // =======================================================

  const sendMessage = async (
    customMessage?: string
  ) => {
    let message = (
      customMessage !== undefined
        ? customMessage
        : input
    ).trim()

    if (!message) {
      return
    }

    // Chat-control commands should not become conversation messages.
    const isTabCommand = handleTabCommand(message)
    if (isTabCommand) return

    // Start intent detection/polishing while conversation routing runs. These
    // requests are independent, so awaiting them sequentially added avoidable latency.
    const intentPromise = fetch(`${API_URL}/api/intent/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }).catch(error => {
      console.warn("AI feature intent routing unavailable; using normal command handling.", error)
      return null
    })

    // Ask the backend AI to compare this prompt with the actual conversation
    // history. If semantic routing is unavailable, use conservative local topic
    // inference so unrelated subjects still get separate persistent chats.
    // Ambiguous follow-ups deliberately stay in the current conversation.
    let conversationId = activeTab
    let localTopicChange = false
    const checkLocalTopicChange = () => {
      const currentTopic = inferTopic(firstUserPrompt(messages))
      const incomingTopic = inferTopic(message)
      localTopicChange = Boolean(currentTopic && incomingTopic && currentTopic !== incomingTopic)
    }

    if (conversationId !== null) {
      try {
        const routeResponse = await fetch(`${API_URL}/api/conversations/route`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            conversation_id: conversationId,
          }),
        })

        if (routeResponse.ok) {
          const routing = await routeResponse.json()
          if (routing?.decision === "new_chat") {
            const newConversationId = await createNewTab()
            if (newConversationId === null) return
            conversationId = newConversationId
          } else if (["ai_unavailable", "routing_error"].includes(String(routing?.reason || ""))) {
            checkLocalTopicChange()
          }
        } else {
          console.warn("Conversation routing unavailable; using local topic inference.")
          checkLocalTopicChange()
        }
      } catch (error) {
        console.warn("Conversation routing failed; using local topic inference.", error)
        checkLocalTopicChange()
      }
    }

    if (localTopicChange && conversationId === activeTab) {
      const newConversationId = await createNewTab()
      if (newConversationId === null) return
      conversationId = newConversationId
    }

    if (conversationId === null) {
      conversationId = await createNewTab()
      if (conversationId === null) return
    }

    const userMessage: Message = {
      id: Date.now() + Math.random(),
      role: "user",
      content: message,
    }

    setMessages(previous => [...previous, userMessage])
    setInput("")

    // Ask the AI to decide whether this message is a navigation action or
    // ordinary conversation. Place mentions alone must not switch screens.
    try {
      const intentResponse = await intentPromise
      if (intentResponse?.ok) {
        const featureIntent = await intentResponse.json()
        if (featureIntent?.intent === "navigation" && featureIntent.destination) {
          onNavigate?.(String(featureIntent.destination))
          return
        }

        // Reuse the intent-classification call to polish typed paragraphs and
        // voice transcripts without adding another slow AI request. Never
        // replace a long original with a suspiciously short result.
        const polished = typeof featureIntent?.polished_text === "string"
          ? featureIntent.polished_text.trim()
          : ""
        const isCommandIntent = featureIntent?.intent && featureIntent.intent !== "general"
        const preservesLongInput = message.length < 160 || polished.length >= message.length * 0.72
        if (!isCommandIntent && polished && preservesLongInput && polished !== message) {
          message = polished
          setMessages(previous => previous.map(item =>
            item.id === userMessage.id ? { ...item, content: polished } : item
          ))
        }
      }
    } catch (error) {
      console.warn("AI feature intent routing unavailable; using normal command handling.", error)
    }

    // Keep existing handlers for explicit music/weather/device commands.
    const isSpecialCommand = await handleSpecialCommand(message)
    if (isSpecialCommand) return

    // ===================================================
    // AI
    // ===================================================

    setIsThinking(true)

    try {
      const response = await fetch(
        `${API_URL}/api/ask`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            message,
            conversation_id:
              conversationId,
          }),
        }
      )

      const data =
        await response.json()

      if (!response.ok) {
        throw new Error(
          data.error ||
          data.detail ||
          "AI request failed"
        )
      }

      const assistantMessage:
        Message = {
        id:
          Date.now() +
          Math.random(),
        role: "ai",
        content:
          data.response ||
          "I did not receive a response.",
      }

      setMessages(previous => [
        ...previous,
        assistantMessage,
      ])

      if (
        data.conversation_title
      ) {
        setTabs(previous =>
          previous.map(tab =>
            tab.id ===
            conversationId
              ? {
                  ...tab,
                  title:
                    data.conversation_title,
                }
              : tab
          )
        )
      }
    } catch (error) {
      console.error(
        "AI REQUEST FAILED:",
        error
      )

      setMessages(previous => [
        ...previous,
        {
          id:
            Date.now() +
            Math.random(),
          role: "ai",
          content:
            "Sorry, I couldn't connect to the AI backend.",
        },
      ])
    } finally {
      setIsThinking(false)

      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }

  // =======================================================
  // VOICE
  // =======================================================

  const sendVoiceMessage = async (
    voiceMessage: string
  ) => {
    const message =
      voiceMessage.trim()

    if (!message) {
      return
    }

    await sendMessage(message)
  }

  const handleVoiceCommand = async (
    spokenText: string
  ) => {
    console.log(
      "VOICE COMMAND:",
      spokenText
    )

    setInput(spokenText)

    await sendVoiceMessage(
      spokenText
    )
  }

  // Receive commands from the single global Voice button after the app
  // determines that the utterance is a question or general AI request.
  useEffect(() => {
    const receiveVoiceCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; activeTab?: string }>).detail
      if (detail?.activeTab === 'ai' && detail.text?.trim()) {
        void handleVoiceCommand(detail.text.trim())
      }
    }
    window.addEventListener('visionary:voice-command', receiveVoiceCommand)
    return () => window.removeEventListener('visionary:voice-command', receiveVoiceCommand)
  })

  // =======================================================
  // MICROPHONE
  // =======================================================

  const toggleListening = () => {
    // Route the assistant's microphone through the shared Dictation Studio so
    // both voice buttons use the same selected language, live interim preview,
    // silence handling, and multilingual proofreading path.
    window.dispatchEvent(new CustomEvent("visionary:start-dictation"))
  }

  useEffect(() => {
    const syncDictationState = (event: Event) => {
      const detail = (event as CustomEvent<{ listening?: boolean }>).detail
      setIsListening(Boolean(detail?.listening))
    }
    window.addEventListener("visionary:dictation-state", syncDictationState)
    return () => window.removeEventListener("visionary:dictation-state", syncDictationState)
  }, [])

  // =======================================================
  // KEYBOARD
  // =======================================================

  const handleKeyDown = (
    event:
      React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault()

      void sendMessage()
    }
  }

  // =======================================================
  // INITIAL LOAD
  // =======================================================

  useEffect(() => {
    void checkYoutubeConfig()
    void loadTabs()

    return () => {
      if (audioRef.current) {
        audioRef.current.pause()

        audioRef.current.src = ""

        audioRef.current = null
      }
    }
  }, [])

  // =======================================================
  // UI
  // =======================================================

  return (
    <div className="w-full h-full flex flex-col">

      {/* HEADER */}

      <div className="flex items-center justify-between px-6 py-4">

        <div>
          <h1 className="text-xl font-semibold">
            AI Assistant
          </h1>

          <p className="text-xs opacity-60">
            VISIONARY NEXUS
          </p>
        </div>

        <div className="flex items-center gap-3">

          {/* MUSIC STATUS */}

          <div className="px-3 py-2 rounded-xl text-xs border border-white/10 bg-white/5 max-w-[260px] text-right">
            <div className="font-medium">
              {musicPlaying ? "Music Playing" : "Music Ready"}
            </div>
            <div className="opacity-70 mt-0.5 truncate">
              {getYoutubeStatusLabel()}
            </div>
            <button
              type="button"
              onClick={() => void checkYoutubeConfig()}
              className="mt-2 rounded-md border border-white/10 bg-white/10 px-2 py-1 text-[10px] font-medium text-white disabled:opacity-50 hover:bg-white/15 transition-all"
            >
              {youtubePlayerReady ? "YouTube Ready" : "Check YouTube"}
            </button>
          </div>

          {/* ONLINE STATUS */}

          <div className="flex items-center gap-2">

            <div
              className={`
                w-2
                h-2
                rounded-full
                ${
                  isListening
                    ? "bg-red-500"
                    : "bg-green-500"
                }
              `}
            />

            <span className="text-xs opacity-70">
              {isListening
                ? "LISTENING"
                : "ONLINE"}
            </span>

          </div>

        </div>
      </div>

      {/* CURRENT MUSIC */}

      {currentTrack && (
        <div className="px-6 pb-3">
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 flex items-center gap-3">
            {currentTrack.image && (
              <img
                src={currentTrack.image}
                alt={currentTrack.name || "Album artwork"}
                className="w-14 h-14 object-cover rounded-lg border border-white/10"
              />
            )}

            <div className="text-xs opacity-80 min-w-0 flex-1">
              <div className="font-medium text-sm text-white truncate">
                {musicPlaying ? "Now playing: " : "Loaded: "}
                {currentTrack.name || "Unknown track"}
              </div>

              {currentTrack.artist && (
                <div className="opacity-70 mt-1 truncate">{currentTrack.artist}</div>
              )}

              {currentTrack.album && (
                <div className="opacity-60 mt-1 truncate">{currentTrack.album}</div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void playPreviousTrack()}
                className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10 transition-all"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => {
                  if (musicPlaying) {
                    pauseMusic()
                    return
                  }

                  void resumeMusic()
                }}
                className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10 transition-all"
              >
                {musicPlaying ? "Pause" : "Resume"}
              </button>
              <button
                type="button"
                onClick={() => void playNextTrack()}
                className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10 transition-all"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TABS */}

      <div className="px-6">

        <div className="flex items-center gap-2 overflow-x-auto pb-3">

          {tabsLoading ? (
            <div className="text-xs opacity-50">
              Loading chats...
            </div>
          ) : (
            <>
              {tabs.map(
                (tab, index) => {
                  const isActive =
                    tab.id === activeTab

                  return (
                    <div
                      key={tab.id}
                      className={`
                        flex-shrink-0
                        flex
                        items-center
                        rounded-xl
                        border
                        overflow-hidden
                        ${
                          isActive
                            ? "border-white/30 bg-white/15"
                            : "border-white/10 bg-white/5"
                        }
                      `}
                    >

                      <button
                        type="button"
                        onClick={() =>
                          void switchTab(
                            tab.id
                          )
                        }
                        title={tab.title}
                        className="
                          px-4
                          py-2
                          text-sm
                          hover:bg-white/10
                          transition-all
                        "
                      >
                        <span className="mr-2 opacity-40">
                          {index + 1}
                        </span>

                        {tab.title}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          void deleteTab(
                            tab.id
                          )
                        }
                        title="Delete this chat"
                        className="
                          px-3
                          py-2
                          text-sm
                          opacity-40
                          hover:opacity-100
                          hover:bg-red-500/20
                          hover:text-red-300
                          transition-all
                        "
                      >
                        ×
                      </button>

                    </div>
                  )
                }
              )}

              <button
                type="button"
                onClick={() =>
                  void createNewTab()
                }
                className="
                  flex-shrink-0
                  px-4
                  py-2
                  rounded-xl
                  text-sm
                  border
                  border-white/10
                  bg-white/5
                  hover:bg-white/10
                  transition-all
                "
              >
                + New Chat
              </button>
            </>
          )}

        </div>

      </div>

      {/* MESSAGES */}

      <div className="flex-1 overflow-y-auto px-6 py-4">

        {messages.length === 0 &&
        !isThinking ? (

          <div className="h-full flex flex-col items-center justify-center text-center">

            <div className="w-20 h-20 rounded-full flex items-center justify-center border border-white/20 bg-white/5 mb-5">

              <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center">

                <span className="text-xl">
                  AI
                </span>

              </div>

            </div>

            <h2 className="text-lg font-medium">
              VISIONARY NEXUS
            </h2>

            <p className="text-sm opacity-50 mt-2">
              How can I help you?
            </p>

            <p className="text-xs opacity-35 mt-4">
              Try "play spooky",
              "play daylight",
              "weather in Bengaluru",
              "pause", "resume",
              or "next song".
            </p>

          </div>

        ) : (

          <div className="space-y-5">

            {messages.map(
              message => {
                const isUser =
                  message.role ===
                  "user"

                return (
                  <div
                    key={message.id}
                    className={`
                      flex
                      ${
                        isUser
                          ? "justify-end"
                          : "justify-start"
                      }
                    `}
                  >

                    <div
                      className={`
                        max-w-[80%]
                        rounded-2xl
                        px-4
                        py-3
                        text-sm
                        leading-relaxed
                        ${
                          isUser
                            ? "bg-white/15"
                            : "bg-white/5 border border-white/10"
                        }
                      `}
                    >

                      {!isUser && (
                        <div className="text-[10px] opacity-40 mb-2">
                          VISIONARY NEXUS
                        </div>
                      )}

                      <div className="ai-markdown">

                        {isUser ? (
                          <div className="whitespace-pre-wrap">
                            {message.content}
                          </div>
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[
                              remarkGfm,
                            ]}
                          >
                            {formatAssistantMath(message.content)}
                          </ReactMarkdown>
                        )}

                      </div>

                    </div>

                  </div>
                )
              }
            )}

            {/* THINKING */}

            {isThinking && (
              <div className="flex justify-start">

                <div className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3">

                  <div className="flex items-center gap-1">

                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse" />

                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse" />

                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse" />

                  </div>

                </div>

              </div>
            )}

          </div>
        )}

      </div>

      {/* VOICE WAVEFORM */}

      <div className="px-6">

        <div className="h-8 flex items-center justify-center gap-1">

          {isListening ? (
            <>
              {Array.from({
                length: 18,
              }).map(
                (_, index) => (
                  <div
                    key={index}
                    className="
                      w-1
                      rounded-full
                      bg-white/60
                      animate-pulse
                    "
                    style={{
                      height:
                        `${
                          8 +
                          (index * 7) %
                            18
                        }px`,
                      animationDelay:
                        `${
                          index * 50
                        }ms`,
                    }}
                  />
                )
              )}
            </>
          ) : (
            <div className="text-[10px] opacity-25">
              READY
            </div>
          )}

        </div>

      </div>

      {/* INPUT */}

      <div className="p-6">

        <div className="
          flex
          items-center
          gap-2
          rounded-2xl
          border
          border-white/10
          bg-white/5
          p-2
        ">

          {/* MIC */}

          <button
            type="button"
            onClick={toggleListening}
            className={`
              flex-shrink-0
              w-10
              h-10
              rounded-xl
              flex
              items-center
              justify-center
              transition-all
              ${
                isListening
                  ? "bg-red-500/20"
                  : "bg-white/5 hover:bg-white/10"
              }
            `}
            title="Voice input"
          >
            <span className="text-sm">
              {isListening
                ? "■"
                : "MIC"}
            </span>
          </button>

          {/* TEXT INPUT */}

          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={input}
            rows={1}
            onChange={event => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask VISIONARY NEXUS... (Shift+Enter for a new line)"
            disabled={isThinking}
            className="
              flex-1
              min-h-10
              max-h-40
              resize-y
              bg-transparent
              outline-none
              text-sm
              placeholder:opacity-30
            "
          />

          {/* SEND */}

          <button
            type="button"
            onClick={() =>
              void sendMessage()
            }
            disabled={
              !input.trim() ||
              isThinking
            }
            className="
              flex-shrink-0
              px-4
              py-2.5
              rounded-xl
              bg-white/10
              hover:bg-white/15
              disabled:opacity-30
              disabled:cursor-not-allowed
              transition-all
              text-sm
            "
          >
            Send
          </button>

        </div>

        <div className="mt-2 text-center">

          <span className="text-[10px] opacity-25">
            Voice: "play spooky" ·
            "pause" · "resume" ·
            "next song" ·
            "previous song" ·
            "weather in Bengaluru"
          </span>

        </div>

      </div>

    </div>
  )
}

export default AIAssistant
