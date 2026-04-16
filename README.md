# Vault Watch

Notification and inbox system for shared Obsidian vaults synced via Relay. Get alerted to meaningful vault changes through Obsidian, Slack, and Chrome — with zero infrastructure and end-to-end encryption.

## Install (Obsidian Plugin)

### Option A: BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `adamsz-er/vault-watch`
4. Click **Add Plugin**
5. Enable "Vault Watch" in Community Plugins

BRAT checks for updates automatically on Obsidian startup. You can also manually check: BRAT settings → **Check for updates**.

### Option B: Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/adamsz-er/vault-watch/releases/latest)
2. Create folder: `<your-vault>/.obsidian/plugins/vault-watch/`
3. Copy the 3 files into that folder
4. Restart Obsidian → enable "Vault Watch" in Community Plugins

## Updating

### BRAT
Updates are automatic. BRAT checks on every Obsidian restart and pulls the latest release. To force a check: BRAT settings → **Check for updates**.

### Manual
Download the latest `main.js`, `manifest.json`, and `styles.css` from [releases](https://github.com/adamsz-er/vault-watch/releases/latest), replace the files in `.obsidian/plugins/vault-watch/`, and restart Obsidian.

## Setup (first time)

1. Open Settings → Vault Watch
2. Enter your **Member ID** (e.g. `adam`) and **Display Name**
3. Set **Vault Name** (auto-detected if left blank)
4. Click **Setup** — this generates encryption keys and registers you
5. The other team member does the same on their machine

## Slack Integration (optional)

1. Create a [Slack Incoming Webhook](https://api.slack.com/messaging/webhooks) for your `#vault-watch` channel
2. Paste the webhook URL in Vault Watch settings
3. Enable Slack notifications

## Chrome Extension (optional)

1. Build: `cd vault-watch-chrome && npm install && npm run build`
2. Go to `chrome://extensions` → enable Developer Mode → **Load unpacked** → select `vault-watch-chrome/`
3. Click the extension icon → paste your private key JSON (copy from Obsidian plugin settings → "Export private key")

The Chrome extension reads encrypted payloads from Slack messages and shows notifications + an inbox popup.

## Features

- **Automatic change detection** — watches for file create, edit, delete, rename
- **3-layer anti-spam** — per-file debounce → session coalescing → Slack batching
- **Smart diff** — ignores whitespace, CRDT artifacts; summarizes meaningful changes
- **E2E encrypted** — TweetNaCl sealed box (X25519 + Ed25519), zero-knowledge relay
- **@mention autocomplete** — type `@` to mention team members, triggers high-priority alerts
- **Tag-based priority** — `#urgent` and `#priority` tags trigger immediate notifications (inline + frontmatter)
- **Toast notifications** — in-app Obsidian toasts when changes arrive (8s for high priority, 5s normal)
- **Push to Vault Watch** — right-click any file or folder → "Push to Vault Watch" to manually share
- **Reply from inbox** — click Reply on any notification to open the file with `@sender` pre-inserted
- **Unread badge** — red badge with count on the ribbon icon, icon turns red when unread
- **New member alerts** — toast notification when a new team member joins Vault Watch
- **Quick reactions** — react with emoji (thumbs up, checkmark, eyes, alert) from inbox cards, sender gets notified
- **Notification sound** — audio ping for incoming notifications (two-tone for high priority), configurable volume
- **Do Not Disturb** — toggle via command palette or settings to suppress all toasts and sounds
- **Snooze** — "Snooze 1h" on any inbox card, notification reappears after the timer
- **Search inbox** — filter notifications by sender, file name, or content
- **Members tab** — see all registered members in the vault with initials, display name, and join date
- **Status bar** — clickable unread count always visible at bottom of Obsidian, turns red when unread
- **Keyboard shortcuts** — `Ctrl+Shift+N` open inbox, `Ctrl+Shift+J` next unread
- **Inbox sidebar** — filterable inbox (All / Mentions / Changes) with unread badges
- **Slack integration** — Block Kit messages with encrypted payload + "Open in Obsidian" deep link
- **Chrome extension** — extracts encrypted payloads from Slack, desktop notifications, popup inbox

## Architecture

```
Vault Events → Debounce → Session Coalesce → Diff Analyze → Encrypt → Outbox (synced via Relay)
                                                                    → Slack Webhook (encrypted payload)
                                                                    → Chrome Extension (reads from Slack DOM)
```

The vault IS the message bus. No servers. No databases.
