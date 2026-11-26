# Super Harness — Architecture

## 1. Core Principles

Running multiple local AI coding harnesses simultaneously — **OpenAI Codex** (Desktop app + `app-server` daemon + CLI), **Claude** (Desktop + Code CLI + `tmux --remote-control`), **Google Antigravity** (Desktop + CLI), and **Meta Muse** (terminal TUI + headless `muse exec`) — creates fragmented windows, inconsistent tool/diff rendering, and no shared orchestration plane.

**Super Harness** solves this as a **non-destructive multiplexing chrome + control plane**:
- Native harnesses remain the source of truth for their own transcripts, auth, sandboxes, and daemons.
- Every harness integration lives behind a single cohesive **`HarnessDriver`** interface (`src/main/adapters/types.ts`) — keeping all harness-specific paths, SQLite schemas, JSONL formats, FS watch targets, and dispatch protocols cleanly encapsulated without unnecessary layers of abstraction.
- All transcripts normalize into one **`UnifiedMessage[]` / `UnifiedBlock[]`** model and render through a shared obsidian design system (`src/renderer/ui/`).

---

## 2. Cohesive `HarnessDriver` Abstraction

All four built-in drivers are registered once in `src/main/adapters/index.ts`:

| Capability | OpenAI Codex (`codexAdapter.ts`) | Claude (`claudeAdapter.ts`) | Google Antigravity (`antigravityAdapter.ts`) | Meta Muse (`museAdapter.ts`) |
|---|---|---|---|---|
| **Discovery** | `~/.codex/state_5.sqlite` + `.codex-global-state.json` + `ps` | `~/.claude/sessions/*.json` + `~/.config/Claude/claude-code-sessions/*` + `~/.claude/projects/*/*.jsonl` | `conversation_summaries.db` + `~/.gemini/antigravity{,-cli}/brain/*` | `~/.local/share/muse/session-index.db` (`sessions` table, epoch-µs timestamps) + `muse sessions --json` live registry; date-shard FS walk fallback |
| **Transcripts** | Indexed `ORDER BY rollout_ordinal DESC LIMIT` on `thread_history_1.sqlite` + tail-read JSONL fallback + `queue_1.sqlite` | Progressive UTF-8 tail-read JSONL with pre-`JSON.parse` telemetry filtering + `queue-operation` + `tmux capture-pane` | Progressive UTF-8 tail-read `transcript.jsonl` (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `ask_question`) | Progressive UTF-8 tail-read event-log `session.jsonl` (`retained_frame` unwrap; `runtime.user_intent.accepted`, `runtime.session` run events: committed text/reasoning-summaries/tool calls+results, `todo_snapshot_updated`, `terminal`; encrypted reasoning has empty text and is skipped) |
| **Live Watch** | `state_5.sqlite`, `thread_history_1.sqlite(-wal)`, `queue_1.sqlite(-wal)`, today's rollout dir | `~/.claude/sessions/*.json`, project `.jsonl` dirs | `~/.gemini/antigravity{,-cli}/brain` & active `transcript.jsonl` | `session-index.db` in the Muse data dir, today's `sessions/YYYY/MM/DD` shard, active `session.jsonl` |
| **Dispatch** | `codex exec resume --remote unix:// --json` (daemon) or `-i` (standalone CLI) | Direct `tmux send-keys` (live tmux) or `claude --resume -p --output-format stream-json` | Official Agent Client Protocol (`agy acp --app-data-dir <dir>`) via `AgyAcpPool` | `muse session-message send` (live terminal session) or `muse exec --json --session-id <uuid> --yolo` headless continuation (deltas via `run.output.delta`) |
| **Archive** | `codex archive <id>` | Claude Desktop `isArchived: true` or `tmux kill-session` | Super Harness local archive | Super Harness local archive (no native archive command) |

Because every driver implements `HarnessDriver`, the three main-process coordinators remain completely harness-agnostic:
- **`HarnessRegistry`** (`src/main/adapters/registry.ts`): Parallel discovery, metadata override decoration, and fingerprint-keyed `TranscriptCache`.
- **`LiveSyncService`** (`src/main/services/liveSync.ts`): Inotify directory/file watching driven purely by each driver's `getGlobalWatchDirs()` and `getSessionWatchFiles()`.
- **`HarnessDispatcher`** (`src/main/services/dispatcher.ts`): Generic child-process streaming, abort/shutdown lifecycle, and native-or-local archive orchestration.

---

## 3. Performance Architecture

Switching between conversations — including 500 MB+ Claude JSONL files and multi-GB Codex SQLite databases — is engineered for sub-frame perceived latency:

1. **Progressive UTF-8-safe tail reader (`src/main/utils/tailReader.ts`)**: Reads backward from EOF in expanding byte windows (never loading whole multi-hundred-MB files into a V8 string), snapping to raw `0x0A` newline bytes before UTF-8 decoding so multi-byte characters and JSON lines never split across chunk boundaries.
2. **Pre-`JSON.parse` filtering**: Skips high-volume non-rendered telemetry/snapshot lines before calling `JSON.parse`.
3. **Pooled read-only SQLite (`src/main/utils/sqlite.ts`)**: Reuses read-only `node:sqlite` handles with idle eviction, querying Codex's `idx_thread_items_page` in reverse (`ORDER BY rollout_ordinal DESC LIMIT ?`).
4. **Two-tier LRU caching + prefetch**:
   - **Main process (`src/main/services/transcriptCache.ts`)**: Fingerprint-validated LRU (64 sessions / 40 MB budget) with concurrent in-flight request deduplication (~0.01 ms warm hit).
   - **Renderer (`src/renderer/utils/transcriptCache.ts`)**: Stale-while-revalidate LRU cache (32 sessions) for 0-flash switching, warmed by 75 ms sidebar hover prefetch and idle bootstrap prefetch.
   - **Markdown LRU (`src/renderer/utils/format.ts`)**: 600-entry LRU cache around `marked.parse` + `<script>` stripping.
   - **Render isolation**: Memoized `Sidebar`, `SessionHeader`, `SessionComposer`, `LiveStepsBar`, `UserMessageView`, `AssistantMessageView`, and `CoalescedBlockView` prevent composer keystrokes from re-rendering message rows or the sidebar.

---

## 4. Master Orchestrator & Control Plane

- **Loopback Control HTTP Server** (`src/main/services/controlServer.ts`): Binds exclusively to `127.0.0.1:<ephemeral-port>` with a per-launch random Bearer token and SSE event stream.
- **Bundled MCP Server** (`src/mcp/server.ts`): Exposes `sh_list_harnesses`, `sh_list_sessions`, `sh_read_session`, `sh_send_message`, `sh_start_session`, `sh_control_harness`, `sh_organize`, and `sh_update_settings` to whichever harness backs the Master Orchestrator.

---

## 5. Renderer Structure & Design System

- **Tokens & Primitives (`src/renderer/ui/`)**: Semantic CSS variables (`tokens.css`) and reusable components (`Button`, `IconButton`, `Badge`, `Input`, `Select`, `Textarea`, `Menu`, `PopoverSurface`, `Modal`, `Drawer`, `CollapsibleCard`, `DisclosureRow`, `ProgressBar`, `StatTile`, `SegmentedControl`, `SectionHeader`, `NavRow`, `Switch`, `SettingsGroup`, `SettingsRow`) documented in Storybook 8.
- **Cohesive Feature Views (`src/renderer/components/`)**:
  - `Sidebar` + `SidebarContextMenu` + pure `utils/sidebarGrouping.ts`
  - `SessionPane` + `SessionHeader` + `LiveStepsBar` + `QueuedMessagesTray` + `SessionComposer`
  - `CoalescedBlockView` (`UserMessageView`, `AssistantMessageView`, `CollapsedTraceGroup`)
  - `DraftSessionPane`, `SettingsModal`, `HarnessUsageHoverCard`, `FilePreviewDrawer`, `HarnessLogo`
