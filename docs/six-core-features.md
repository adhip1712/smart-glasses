# Six Core Assistant Features

This change adds an additive personal-intelligence layer to Visionary Nexus. It is intentionally separate from existing device provisioning, music playback, authentication, and camera routes.

## Feature coverage

1. **Universal App Control** — reuses the shared app capability registry and AI intent classifier; the Intelligence workspace exposes the supported app launcher. Private account actions still require provider authorization.
2. **Long-Term Memory** — user-entered memories are stored per authenticated account, can be listed/deleted, and up to 20 recent notes are supplied as context to general AI responses. Saving is explicit; there is no silent extraction.
3. **Real-Time Vision** — reuses the existing camera/YOLO pipeline. Scene summaries are based on current detections, and the user can send those detection labels to the AI assistant. This is not raw-image multimodal analysis.
4. **Personal Assistant** — reminders can be created, listed, and marked complete. Reminder records are persistent and account-scoped. Background scheduling, push alerts, and calendar synchronization are not enabled in this phase.
5. **Advanced Voice** — surfaces test/stop speech controls and detected browser voice availability while preserving the existing wake-word and dictation services. Recognition quality remains dependent on the browser/provider.
6. **Device Intelligence** — adds a read-only health summary for registered device heartbeat, battery, signal, firmware, and camera readiness. Existing device lifecycle routes are unchanged.

## API

- `GET/POST/DELETE /api/assistant/memories`
- `GET/POST/PATCH/DELETE /api/assistant/reminders`
- `GET/POST /api/assistant/workflows` (saved drafts only; no runner)
- `GET /api/assistant/device-health`

All `/api/assistant/*` endpoints require a signed-in account. User-owned memories, reminders, and workflow drafts are filtered by the authenticated account ID.

## Safety and rollout

- Email and messaging actions remain draft/review flows; this feature does not auto-send.
- Workflow drafts are never executed.
- Reminder creation does not claim that a notification has been scheduled.
- Existing backend routes and response shapes are left intact.
- Merge/deploy to production only after preview verification.