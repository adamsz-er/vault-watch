# Changelog

All notable changes to Vault Watch are documented here. The plugin and Chrome
extension are versioned together by Obsidian plugin manifest version.

## [0.8.1] — 2026-04-17

### Added
- **First-run setup modal** auto-opens when an invitee enables the plugin on a
  Relay-shared vault: display name + member ID fields with auto-sync, live
  "taken / available" check against `members/`, and a list of existing members
  so you can't collide. Fixes the common silent-install case where new joiners
  showed up to nobody on the team because they never hit the Setup button.
- **Persistent CTA** in the inbox sidebar when setup is incomplete: full
  "Finish setup to join your team" card with a one-click button; replaces the
  tabs until setup completes.
- **Amber dot** on the ribbon icon while setup is pending (passive nudge).
- **"Open Setup" command** in the palette and a button at the top of the
  Members panel — opens the modal at any time, even after setup is complete
  (useful for re-running or inviting).

## [0.8.0] — 2026-04

### Added
- **Chat tab**: a third sidebar tab beside Inbox + Activity. Single shared channel
  with threaded replies, `@mentions` (high-priority toast for the recipient),
  and `#` deep-links to any vault note or folder. Right-click any note → "Chat
  about this" pre-inserts the `#ref`. End-to-end encrypted (same TweetNaCl
  envelope as notifications). Local history persisted under `inbox/<id>/`;
  chat messages stay out of Inbox / Activity badges.
- **Recipient picker** for Send to Vault Watch: right-click any note → submenu
  to either notify a specific member or assign as a task.

## [0.7.0] — 2026-04

### Added
- Folder-backed **Inbox Tasks** view: any folder structure (e.g. `0 - INBOX/Alice/1 - FOR REVIEW/`)
  becomes a kanban-style view; folders are the state machine. One click renames the file via
  CRDT-safe `app.vault.rename` to advance to the next lane.
- Per-tab unread badges (Inbox / Notifications / Activities / Tasks) with persisted state.
- Inbox routing & sensitivity controls: minimum edit size, hide trivial/sync edits,
  glob-pattern path ignores, per-event-type mutes, escalation toggle.
- Compact footer showing version + "Mark all read" only when relevant.

### Changed
- Repository prepared for public release: MIT LICENSE, expanded `.gitignore`,
  generic placeholders in settings, `data.json` ignored to prevent key leakage.
- Pre-existing TypeScript build errors fixed (tweetnacl synthetic default imports,
  `MentionSuggest` shadowing `EditorSuggest.app`).

## [0.4.1] — 2026

### Fixed
- Dotfile invisibility on macOS Finder: renamed `.vault-watch/` to `vault-watch/`
  (still inside `Z_Meta/`) so the directory is browsable.

## [0.4.0] — 2026

### Added
- UI polish: color-coded left borders per event type, cross-sender grouping
  (multiple changes within 1 hour stack into one card), empty state, smooth
  hover transitions, auto-refresh timestamps every 30s.
- Members tab footer with version stamp.

## [0.3.0] — 2026

### Added
- Quick reactions (👍 ✅ 👀 🚨) from inbox cards; sender gets notified.
- Reply from inbox: opens file with `@sender` pre-inserted.
- New member alerts when someone joins the vault.
- Push to Vault Watch: right-click any file/folder to share manually.
- Notification sound (configurable volume), Do Not Disturb toggle, Snooze 1h,
  inbox search, status bar unread count, keyboard shortcuts
  (`Ctrl+Shift+N` / `Ctrl+Shift+J`).

## [0.2.0]

### Added
- Toast notifications, right-click push, frontmatter tag-based priority.
- Ribbon badge with unread count.

## [0.1.0]

### Added
- Initial implementation: vault watcher, 3-layer coalescing (debounce / session /
  Slack batch), TweetNaCl E2E encryption (X25519 + Ed25519), outbox/inbox files
  synced via Obsidian Relay CRDT, Slack Block Kit integration with encrypted
  payload, Chrome MV3 extension that scrapes payloads from Slack DOM.
