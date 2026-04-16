# Architecture

Vault Watch turns a shared Obsidian vault into a notification system. There is
**no server, no database, and no central account** — the vault itself is the
message bus, synced by [Obsidian Relay](https://obsidian.md/sync) (a CRDT layer).
Slack and a companion Chrome extension are optional fan-out channels; both
receive only encrypted payloads.

This document explains the data flow, the threat model, and why a few of the
non-obvious design choices were made.

## High-level flow

```
┌──────────────┐    ┌───────────────────────────────────────┐    ┌──────────────┐
│ Obsidian     │    │  vault-watch-plugin                   │    │ Obsidian     │
│ (Member A)   │    │                                       │    │ (Member B)   │
│              │    │ Vault events                          │    │              │
│   .md edit ──┼───▶│   ↓ debounce 2s (per file)            │    │  Relay sync  │
│              │    │   ↓ session coalesce 30s              │    │   ↓          │
│              │    │   ↓ diff analyze (ignore whitespace)  │    │  read inbox  │
│              │    │   ↓ encrypt (sealed box → recipient)  │    │   ↓ toast    │
│              │    │   ↓ write outbox file                 │    │   ↓ inbox UI │
│              │    │       ↓                               │    │              │
│              │    │   ┌───┴────────────────────────┐      │    │              │
│              │    │   ↓ Relay CRDT sync            ↓      │    │              │
│              │    │  Slack webhook (encrypted)  inbox/    │    │              │
│              │    │   ↓                          (peer)   │    │              │
│              │    │  Chrome ext reads from                │    │              │
│              │    │  Slack DOM, decrypts, notifies        │    │              │
│              │    └───────────────────────────────────────┘    │              │
└──────────────┘                                                  └──────────────┘
```

## Storage layout in the vault

```
Z_Meta/vault-watch/
├── members/                # one JSON file per member (id, name, joined)
├── keys/                   # public keys only — *.pub files (X25519 + Ed25519)
├── outbox/                 # sender's pending events (one JSON per event)
└── inbox/<member-id>/      # delivered events for each recipient
```

A plugin instance writes to `outbox/`; Relay syncs that directory to every
peer's vault; each peer's plugin reads `inbox/<own-id>/`.

**Private keys** live in `vault-watch-plugin/data.json` — Obsidian's per-plugin
data directory, which is local to each device and **never** synced through
Relay. `data.json` is in `.gitignore` to defend against accidental commits.

## Cryptography

| Purpose            | Algorithm                              | Library    |
|--------------------|----------------------------------------|------------|
| Recipient encrypt  | NaCl sealed box (X25519 + XSalsa20-Poly1305) | TweetNaCl |
| Sender identity    | Ed25519 detached signature             | TweetNaCl |
| Key encoding       | base64 (tweetnacl-util)                | TweetNaCl |

Each event is encrypted **separately for each recipient** using their public
X25519 key. The sealed-box construction generates a one-shot ephemeral key
pair per message, so the ciphertext leaks no metadata about the sender beyond
what's in the signed payload.

The signed payload contains: sender id, vault id, file path, event type,
timestamp, and the diff/summary. Recipients verify the Ed25519 signature
against the sender's published `.pub` file before showing anything.

## Threat model

### What an attacker (or curious provider) **can** see

| Channel         | Visible to provider                                                  |
|-----------------|-----------------------------------------------------------------------|
| Obsidian Relay  | Encrypted blobs in `Z_Meta/vault-watch/`, file sizes, sync timestamps |
| Slack webhook   | "Vault activity" message; encrypted payload in a context block        |
| Chrome ext      | Nothing it doesn't already see in Slack DOM                           |

### What an attacker **cannot** see (without member private keys)

- File names, file contents, diffs, sender identity within an event
- Member roster (members list is also stored in the vault and synced via Relay,
  but member display names are public to other members by design)

### What is **out of scope**

- Compromise of an individual member's device (private key extraction)
- Slack workspace admins reading webhook URLs (use a dedicated channel)
- Side-channel timing analysis of Relay sync patterns
- A malicious Vault Watch plugin update — install only from the official repo

## Anti-spam: 3-layer coalescing

Notifications are aggressively coalesced because Obsidian fires file events
constantly during normal editing.

| Layer | Window | Behavior |
|-------|--------|----------|
| Per-file debounce  | 2s trailing  | Multiple edits to the same file collapse |
| Session coalesce   | 30s          | Cumulative diff across edits in a burst  |
| Slack batch        | 5 min        | One Slack message per batch (high-priority bypasses) |

Tag-based escalation: anything containing `#urgent` or `#priority` (inline or
in frontmatter) bypasses Slack batching and produces a high-priority toast
on receipt. `@mentions` of a member always escalate for that recipient.

## Why "the vault is the message bus"

Two design constraints drove this:

1. **Zero infrastructure.** Adding a server means uptime, billing, secrets
   management, and someone to email when it breaks. Everything Vault Watch
   needs (durable storage, peer sync, conflict resolution) is already
   provided by Relay — there's no reason to duplicate it.
2. **Hard-to-leak secrets.** Private keys never leave a device. Public keys
   are published into the vault directly. There is no central account
   database to compromise.

The cost: latency is bounded by Relay sync (typically 1–5s, occasionally
longer). For an inbox/notifications use case this is fine; for chat-grade
realtime you would want a proper transport.

## Code map

| Concern                  | Module                                         |
|--------------------------|------------------------------------------------|
| Plugin lifecycle         | `vault-watch-plugin/src/core/plugin.ts`        |
| Settings UI              | `vault-watch-plugin/src/core/settings.ts`      |
| Vault file watching      | `vault-watch-plugin/src/watcher/`              |
| Diff analysis & coalesce | `vault-watch-plugin/src/watcher/coalescer.ts`, `diff-analyzer.ts` |
| Encryption / signatures  | `vault-watch-plugin/src/crypto/`               |
| Member registry          | `vault-watch-plugin/src/members/registry.ts`   |
| Outbox/inbox via Relay   | `vault-watch-plugin/src/relay/vault-relay.ts`  |
| Slack webhook            | `vault-watch-plugin/src/relay/slack-webhook.ts` |
| Inbox sidebar UI         | `vault-watch-plugin/src/inbox/inbox-view.ts`   |
| Inbox state machine      | `vault-watch-plugin/src/inbox/inbox-store.ts`  |
| Folder-backed tasks      | `vault-watch-plugin/src/inbox/task-scanner.ts`, `task-actions.ts` |
| Chrome service worker    | `vault-watch-chrome/src/background/`           |
| Slack DOM scraping       | `vault-watch-chrome/src/content/slack-extractor.ts` |
| Chrome popup             | `vault-watch-chrome/src/popup/`                |
