# Super Harness

<img width="2502" height="1583" alt="image" src="https://github.com/user-attachments/assets/dcf71a56-6c54-4fb1-acd2-d8ef1342fbc3" />

A calm, high-performance Electron desktop multiplexer and control plane for local AI coding harnesses — unifying **OpenAI Codex** (Desktop + app-server daemon + CLI), **Claude** (Desktop + Code CLI + `tmux --remote-control`), **Google Antigravity** (Desktop hub language-server native API + CLI via ACP fallback), and **Meta Muse** (native MSP via `muse serve` / `muse attach --stdio`) under one cohesive interface.

## Highlights

- **Non-destructive multiplexing**: Native harnesses remain the source of truth for their own transcripts, auth, sandboxes, and daemons. Super Harness reads their local stores and dispatches back through each harness's official protocol (Codex app-server `turn/start` on the managed daemon, Claude Desktop's stream-json control protocol / tmux typing for live TUIs, Antigravity's hub-LS `SendUserCascadeMessage`, MSP `turn/start` via `muse serve` / `muse attach --stdio`).
- **Coalesced visual grammar**: Thinking traces, shell commands, unified file diffs, MCP tool calls, web searches, interactive/answered questions, image attachments, and queued messages render with one calm obsidian design system.
- **Universal message queue**: Queue follow-up prompts while any harness is working (plus mirror native Codex/Claude queues), with Send-now, Edit, and Delete controls.
- **Instant chat switching**: Progressive UTF-8-safe JSONL tail reader (handles 500 MB+ transcripts in milliseconds), pooled read-only SQLite + indexed Codex tail queries, two-tier LRU transcript caching (main + renderer stale-while-revalidate), hover/idle prefetching, and LRU Markdown rendering.
- **Master Orchestrator + MCP Control Plane**: A pinned orchestrator thread backed by your choice of harness, wired via a loopback-only authenticated Control HTTP Server + bundled stdio MCP server (`src/mcp/server.ts`) to inspect sessions, dispatch prompts, organize folders/pins, and update settings.
- **2-up Split View & live `tmux` mirror**: Monitor and drive two sessions side-by-side or flip any `tmux`-backed Claude thread into a live terminal mirror.
- **Usage & spend telemetry**: Hover any harness tab for live quota bars (Claude/Codex/Muse via `muse usage`), 5h/24h/7d/14d API-equivalent spend, 7-day sparklines, and quick links to account usage pages.
- **Design System + Storybook 8**: Reusable semantic tokens (`src/renderer/ui/tokens.css`), UI primitives (`src/renderer/ui/`), and interactive stories.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and module boundaries.

```
src/
├── main/
│   ├── adapters/       # Cohesive HarnessDriver contract + Codex / Claude / Antigravity / Muse drivers + Registry
│   ├── services/       # Dispatcher, LiveSyncService (inotify), TranscriptCache, UsageService, MasterEngine, ControlServer, AgyAcpPool
│   ├── store/          # Persistent Super Harness settings, folders, pins & overrides (~/.config/super-harness)
│   └── utils/          # Progressive JSONL tailReader, pooled read-only SQLite helper, system/process discovery
├── mcp/                # Standalone stdio MCP server bridging Master Orchestrator -> ControlServer
├── renderer/
│   ├── ui/             # Obsidian design tokens, primitives, and Storybook stories
│   ├── components/     # Sidebar, SessionPane, SessionHeader, SessionComposer, CoalescedBlockView, SettingsModal, etc.
│   └── utils/          # Renderer LRU transcript cache, LRU Markdown renderer, pure sidebarGrouping
└── shared/             # Shared IPC & domain types
tests/                  # Vitest unit, adapter parity, and performance regression suites
```

## Development

```bash
# Install dependencies (use --ignore-scripts if relying on system Electron)
npm install

# Typecheck
npm run typecheck

# Run unit & performance regression test suite
npm test

# Build main + renderer
npm run build

# Launch desktop app
npm start

# Run Storybook 8 (http://localhost:6006)
npm run storybook

# Benchmark live local transcript loading & caching
npm run bench
```

## License

MIT
