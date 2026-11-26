# Super Harness — Native iOS App Architecture (`ios/`)

## 1. Repository & Branch Isolation Rules
- **Branch**: `feat/ios-app` (branched from `origin/main`).
- **Strict boundary**: All iOS work MUST live strictly inside `ios/`. Do **not** modify `src/`, `tests/`, `package.json`, or root config files on this branch — the Linux desktop Super Harness MVP session actively pushes rapid commits to `main`. Keeping all iOS files inside `ios/` guarantees zero merge conflicts and clean `rsync` / `git rebase origin/main` updates.
- **Reference files** (read-only on MacBook, kept fresh via `rsync` from Linux):
  - `ARCHITECTURE.md`
  - `src/shared/types.ts` (canonical data schema)
  - `src/renderer/ui/tokens.css` (canonical obsidian palette & typography tokens)
  - `src/main/services/controlServer.ts` (HTTP + SSE API)
  - `src/renderer/components/` (feature parity reference — adapt UX natively for iOS rather than cloning desktop chrome!)

## 2. Product Philosophy (Native iOS, Same Baseline Feature Set)
Super Harness on iOS is a **true native SwiftUI mobile companion** (iPhone-first, iPad `NavigationSplitView` aware) — **not** a shrunk desktop sidebar:
- **Calm Obsidian Visual Language**: Uses exact tokens from `src/renderer/ui/tokens.css`:
  - Surfaces: code `#101114`, rail `#111215`, canvas `#16171b`, subtle `#181a1f`, popover `#1a1c22`, raised `#1f2128`, bubble `#23252c`
  - Ink: primary `#f1f3f7`, secondary `#c8ccd6`, muted `#8b909e`, faint `#5f6472`
  - Harness Brand Accents: Antigravity `#60a5fa`, Codex `#10a37f`, Claude `#d97757`, Master `#818cf8`
  - Semantic: success `#34d399`, warning `#fbbf24`, danger `#fb7185`
- **Native iOS Ergonomics**:
  - Bottom-reachable composer & primary actions, thumb-friendly swipe actions (Pin / Pin-to-Top / Archive / Hide), pull-to-refresh, native `.searchable`, native sheets (`.presentationDetents`), haptic feedback, `PhotosPicker` for image attachments, and `Charts` for 7-day usage spend.
  - Dual **Live Host Mode** (connects over Tailscale/LAN to Linux Super Harness `ControlServer` HTTP + SSE with Keychain-stored Bearer token) and **Demo Mode** (rich realistic offline fixtures for Master, Antigravity, Codex, and Claude so every view & interaction works immediately in Simulator and previews).

## 3. Baseline Feature Parity Checklist
1. **Unified Session Inbox (`SessionListView`)**:
   - Master Orchestrator row pinned at top
   - Globally pinned chats (`pinnedToTop`) above harness sections
   - Horizontal harness switcher pills (`All`, `Antigravity`, `Codex`, `Claude`) with live primary quota progress bar + quick `+` new-chat button per harness
   - Live working spinners, unread/active badges, search/filter, grouping selector (`Native`, `Harness`, `Project`, `Folders`, `Recent`), swipe actions (Pin, Archive, Hide)
2. **Coalesced Transcript & Live Activity (`SessionDetailView` + `CoalescedBlockViews`)**:
   - Canonical `UnifiedMessage[]` and every `UnifiedBlock` variant: `text` (Markdown + copyable code blocks), `image` (thumbnails + full-screen zoomable lightbox), `thinking` (collapsible disclosure), `command` (terminal card with cwd, exit code badge, duration, expandable output), `file_change` (colorized unified diff viewer), `tool_call` (MCP/function card), `web_search`, interactive `question` (tappable option chips that send answer), and `notice`.
   - Collapsed trace group for consecutive tool/thinking/command steps.
   - Sticky **Live Activity Bar** (`focus`, checklist `steps`, `runningTasks` pills) and **Queued Messages Tray**.
3. **Smart Mobile Composer (`ComposerView`)**:
   - Multi-line auto-expanding text field + `PhotosPicker` image attachment strip.
   - **Stop (`■`) replaces Send (`↑`)** in the same circular slot while `isWorking || isStreaming`; if user starts typing a follow-up while working, smoothly switches to **Queue (`↑`)**, then returns to **Stop** once submitted.
4. **New Session Sheet (`NewSessionSheet`)**:
   - Harness selector (`antigravity`, `codex`, `claude-cli`, `claude-tmux`), Project/CWD picker, Model picker, **Thinking / Reasoning Effort** selector (mirroring desktop commit `67aead5`), optional remote-control / tmux name.
5. **Hero-Limit Usage Quota Sheet (`UsageSheetView`)**:
   - Follows desktop redesign (`2961d79`): hierarchy before decoration — most-constrained limit promoted to bold `28pt` hero headline, `+X% today · on pace for Y%`, vertical **pace tick** on progress bar, exact reset time, progressive disclosure for secondary windows, and boxless 7-day spend trend (`Swift Charts`).
6. **Host Connection & Harness Controls (`HostConnectionSheet`)**:
   - Configure host URL (Tailscale e.g. `http://100.64.0.10:47890` or LAN `http://192.168.1.10:47890`), Bearer token (Keychain), connection health test, Demo Mode toggle, detected harnesses list with `start_remote` / `stop_remote` actions.

## 4. Xcode Project Structure (`ios/`)
Generated reproducibly via `xcodegen generate` from `ios/project.yml`:
```text
ios/
  IOS_ARCHITECTURE.md
  MOBILE_API_CONTRACT.md
  project.yml
  scripts/
    sync-from-linux.sh
  SuperHarness/
    App/SuperHarnessApp.swift
    Theme/DesignTokens.swift
    Models/UnifiedModels.swift
    Networking/
      SuperHarnessClient.swift
      SSEClient.swift
      KeychainStore.swift
      MockSuperHarnessClient.swift
    State/AppStore.swift
    Views/
      RootView.swift
      SessionListView.swift
      SessionDetailView.swift
      ComposerView.swift
      LiveStepsBarView.swift
      QueuedMessagesTrayView.swift
      Blocks/CoalescedBlockViews.swift
      Draft/NewSessionSheet.swift
      Usage/UsageSheetView.swift
      Settings/HostConnectionSheet.swift
    Resources/Assets.xcassets/
  SuperHarnessTests/
    UnifiedModelsTests.swift
    SSEParserTests.swift
    AppStoreTests.swift
```
