# Superharness — Mobile HTTP & SSE API Contract (Sync Protocol v1)

This contract aligns the native iOS companion (`ios/`) with `src/main/services/controlServer.ts` on the Linux desktop host (`MOBILE_PROTOCOL_VERSION = 1`).

All requests send `Authorization: Bearer <token>` and `Accept: application/json` (except SSE `text/event-stream` and `/api/media` binary streams).

## 1. Sync Protocol v1 Endpoints (Live on Desktop & iOS)

| Method & Path | Purpose | Request / Response |
|---|---|---|
| `GET /api/health` | Fast health & protocol probe | `{ ok, protocolVersion: 1, seq, uptimeMs }` |
| `GET /api/bootstrap` | Cold-start & resync snapshot | `{ protocolVersion: 1, seq, harnesses, sessions, state, usage?, catalog? }` |
| `GET /api/events?clientId=<id>` | Real-time SSE stream | Accepts `Last-Event-ID: <seq>` (or `?lastEventId=`) for replay from server 200-event ring buffer; emits `id: <seq>` on every frame, `: ping` keepalives every 25s, and cleans up `mobile:<clientId>` watch binding on disconnect |
| `POST /api/watch` | Bind active phone thread to desktop `inotify` watcher (~65ms) | Body `{ clientId, sessionId: string \| null, limit?: 80 }` -> `{ ok, paneId, sessionId }` |
| `GET /api/media?path=<encoded>` | Authenticated local screenshot/video streaming | Streams `.png/.jpg/.webp/.gif/.svg/.mp4/.m4v/.webm/.mov` with `Content-Type` and `Cache-Control: private, max-age=300` |
| `GET /api/harnesses` | List detected harnesses | `{ harnesses: HarnessDetection[] }` |
| `GET /api/sessions?q=&harness=&live=&includeMaster=` | List unified sessions | `{ count, harnesses, sessions: UnifiedSession[] }` |
| `GET /api/transcript?sessionId=&limit=80` | Fetch session transcript | `SessionTranscriptResult` (includes `liveActivity`) |
| `GET /api/usage?force=false` | Fetch quota & spend telemetry | `UsageSnapshot` |
| `GET /api/catalog?force=false` | Fetch models, reasoning effort, and projects | `HarnessCatalog` |
| `POST /api/send` | Send or queue message | Body `{ sessionId, message, attachments? }` -> `SendMessageResult` |
| `POST /api/abort` | Abort active run | Body `{ sessionId }` -> `{ ok: boolean }` |
| `POST /api/start` | Start new session | Body `StartSessionRequest` -> `{ ok, sessionId?, error? }` |
| `POST /api/organize` | Pin, pin top, folder, reorder folders, rename, tag, hide | Body `{ actions: OrganizeAction[] }` -> `{ ok, folders }` |
| `POST /api/archive` | Archive session | Body `{ sessionId, killTmux? }` -> `{ ok, method?, error? }` |
| `POST /api/settings` | Patch settings | Body `Partial<SuperHarnessSettings>` |
| `POST /api/control-harness` | Start/stop remote control | Body `{ harness, action }` |
| `POST /api/attachments` | Upload base64 image attachment | Body `{ dataUrl, filename? }` -> `ImageAttachment` |
| `GET /api/files/preview?path=&startLine=&endLine=` | Preview workspace file | `FilePreviewData` |

## 2. SSE Events & Replay Semantics (`GET /api/events`)

- **Monotonic sequence IDs**: Every broadcast includes `id: <seq>` (`eventSeq`). The iOS `SSEClient` persists the latest received `id` across reconnects (seeded from `/api/bootstrap.seq`) and sends `Last-Event-ID: <seq>` on reconnect.
- **Replay & `resync_required`**:
  - If `lastSeq` is within the server's 200-event buffer, missed frames (`seq > lastSeq`) are replayed in order immediately after `connected`.
  - If `lastSeq + 1 < oldestBufferedSeq` (buffer gap), the server emits `event: resync_required` with `{ reason: "buffer_gap", lastSeq, currentSeq }`.
  - On `resync_required` or when iOS returns to foreground (`scenePhase == .active`), `AppStore.resync()` refreshes `/api/bootstrap`, reloads the active transcript, and re-registers `POST /api/watch`.
- **Event types**:
  - `connected`: `{ ok: true, protocolVersion: 1, seq }`
  - `resync_required`: `{ reason, lastSeq, currentSeq }`
  - `stream`: `StreamEvent`
  - `transcript`: `SessionTranscriptResult`
  - `sessions`: `{ harnesses, sessions }`
  - `usage`: `UsageSnapshot`
  - `state`: `SuperHarnessState`

## 3. Graceful Degradation
The iOS client remains backward-compatible with older hosts that do not yet expose Sync Protocol v1 endpoints:
- `GET /api/health` 404 falls back to `GET /api/harnesses`
- `GET /api/bootstrap` 404 falls back to `GET /api/harnesses` + `GET /api/sessions`
- `POST /api/watch`, `GET /api/usage`, `GET /api/catalog`, `POST /api/abort`, `POST /api/archive`, and `POST /api/attachments` degrade cleanly on 404.
