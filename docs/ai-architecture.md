# Visionary Nexus AI architecture

## Request pipeline

1. FastAPI retains the submitted `original_text` and normalizes whitespace.
2. `CommandCorrectionProvider` attempts local spelling correction. If a configured provider raises, the local fallback runs.
3. Deterministic classification runs on `normalized_text`; registered `CommandRouter` handlers execute supported actions without an AI request.
4. Ambiguous destructive requests ask for clarification and do not mutate data.
5. General conversation turns go to the server-side `AIProvider`, currently `GroqAIProvider`.
6. Conversation records retain the original text in `content` and `original_text`, and the corrected text in `normalized_text`. Existing SQLite databases receive additive nullable columns on startup.

Both text values are included in ask responses and conversation message-history responses. Past records without the new values continue to use their existing `content`.

## Provider status

- Groq is the primary general-purpose AI provider. Its key is read only by FastAPI from `GROQ_API_KEY`; `GROQ_TEXT_MODEL` can select the text model. The existing text model remains the default.
- Grammarly's official developer docs currently list writing-score, AI-detection, plagiarism, analytics, and administrative APIs. The documented Writing Score API returns scores, not corrected replacement text for command normalization. No Grammarly correction provider or credential is configured until Grammarly documents an appropriate API.
- Wispr Flow's official material available for this project describes its end-user dictation product and help center, not a public transcription API. `VoiceInputProvider` is an interface only; no undocumented Wispr endpoint or key is used.
- Camera status, capture, and analyze endpoints retain their existing request/response contracts. Actual image analysis is not wired to Groq because the current supported image-input model/API capability was not verifiable from the official model documentation during this implementation.

## Extending

Implement `CommandCorrectionProvider` when a supported correction service becomes available, `AIProvider` for another general-purpose AI service, and `VoiceInputProvider` for a supported speech-to-text service. Register deterministic command handlers with `CommandRouter` rather than adding provider credentials to the frontend.

The local fallback uses the installed word-frequency dictionary plus Visionary Nexus command vocabulary. It is deliberately conservative for unknown words and preserves the original text for review. Domain vocabulary can be extended when adding new command names.

## Official documentation checked

- [Grammarly API developer documentation](https://developer.grammarly.com/)
- [Grammarly Writing Score API](https://developer.grammarly.com/writing-score-api.html)
- [Grammarly API request/authentication guide](https://developer.grammarly.com/your-first-api-request.html)
- [Groq vision documentation](https://console.groq.com/docs/vision)
- [Groq models documentation](https://console.groq.com/docs/models)
- [Wispr Flow help center](https://docs.wisprflow.ai/)

The Groq documentation pages were reachable by URL but blocked from content retrieval in this environment, so this change intentionally does not claim or implement vision-model support.
