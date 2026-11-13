# Six Core Assistant Features

This additive personal-intelligence layer is kept separate from existing device provisioning, music playback, authentication, camera, and navigation APIs.

## Feature coverage

1. **Universal App Control** — natural-language routing and the shared capability registry now recognise Gmail, Calendar, YouTube, Maps, WhatsApp, Spotify, Outlook, Drive, GitHub, Notion, Slack, Teams, Discord, Trello, Zoom, and Figma. App launching works with the user's existing browser session. Reading or changing private app data still requires a dedicated provider OAuth/API integration.
2. **Long-Term Memory** — explicitly saved, account-scoped notes can be listed and deleted. General AI responses retrieve up to eight notes with lexical relevance ranking (or four recent notes as a fallback), with a bounded context budget. Memory notes are context, not instructions.
3. **Real-Time Vision** — existing YOLO detections remain available. A new authenticated `/api/assistant/vision/analyze` endpoint accepts a user-selected/captured image, calls the existing OpenAI/Groq vision helper, and processes the image in memory without writing it to disk. Raw-image understanding requires `OPENAI_API_KEY` or `GROQ_API_KEY` and a compatible configured vision model. Continuous automatic image upload is not enabled.
4. **Personal Assistant** — reminders are persistent and account-scoped. When the user grants browser notification permission and keeps the Intelligence workspace open, the frontend checks due reminders every 15 seconds, shows a browser notification, and speaks the reminder. This is foreground monitoring, not a background push service; alerts are not guaranteed while the site is closed or suspended. Workflow definitions remain drafts and are not executed.
5. **Advanced Voice** — preserves browser SpeechRecognition when available. Browsers without it can record audio through MediaRecorder and send it to the authenticated `/api/voice/transcribe` endpoint, using the selected language. Cloud transcription still requires the configured STT provider; multilingual quality depends on that provider.
6. **Device Intelligence** — displays registered device heartbeat, battery, signal, firmware and camera readiness, and refreshes telemetry every 10 seconds while the Intelligence workspace is open. The existing single-device lifecycle is unchanged.

## API

- `GET/POST/DELETE /api/assistant/memories`
- `GET/POST/PATCH/DELETE /api/assistant/reminders`
- `GET/POST /api/assistant/workflows` (saved drafts only; no runner)
- `POST /api/assistant/vision/analyze` (authenticated, explicit user-supplied image)
- `GET /api/assistant/device-health`

All `/api/assistant/*` endpoints require a signed-in account. User-owned memories, reminders and workflow drafts are filtered by the authenticated account ID.

## Safety and rollout

- Email and messaging actions remain draft/review flows; this feature does not auto-send.
- Workflow drafts are never executed.
- Reminder notifications only run while the Intelligence workspace is open; background push requires a push subscription service and VAPID configuration.
- App launch does not grant Visionary Nexus private account access. OAuth/provider credentials and user consent are required for private actions.
- Vision photos are only submitted after an explicit user action and are not retained by this endpoint.
- Existing backend routes and response shapes are left intact.
- Merge/deploy to production only after preview verification.