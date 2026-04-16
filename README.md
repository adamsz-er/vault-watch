# Vault Watch

Notification and inbox system for shared Obsidian vaults synced via Relay. Get alerted to meaningful vault changes through Obsidian, Slack, and Chrome — with zero infrastructure and end-to-end encryption.

## Install (Obsidian Plugin)

### Option A: BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `adamsz-er/vault-watch`
4. Click **Add Plugin**
5. Enable "Vault Watch" in Community Plugins

BRAT handles updates automatically.

### Option B: Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/adamsz-er/vault-watch/releases/latest)
2. Create folder: `<your-vault>/.obsidian/plugins/vault-watch/`
3. Copy the 3 files into that folder
4. Restart Obsidian → enable "Vault Watch" in Community Plugins

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

## How It Works

- Watches for file changes in your vault (create, edit, delete, rename)
- 3-layer anti-spam: per-file debounce → session coalescing → Slack batching
- Meaningful change detection (ignores whitespace, CRDT artifacts)
- E2E encrypted with TweetNaCl (X25519 + Ed25519)
- Notifications delivered via vault relay (outbox files synced by Relay) + Slack
- `@mention` autocomplete for team members
- Inbox sidebar in Obsidian with unread badges

## Architecture

```
Vault Events → Debounce → Session Coalesce → Diff Analyze → Encrypt → Outbox (synced via Relay)
                                                                    → Slack Webhook (encrypted payload)
                                                                    → Chrome Extension (reads from Slack DOM)
```

The vault IS the message bus. No servers. No databases.
