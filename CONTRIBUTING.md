# Contributing to Vault Watch

Thanks for taking a look. Vault Watch is a small two-component project — an
Obsidian plugin and a Chrome MV3 extension that share a vault-as-message-bus
architecture (see [ARCHITECTURE.md](./ARCHITECTURE.md) for the design).

## Setup

```bash
git clone https://github.com/adamsz-er/vault-watch.git
cd vault-watch

# Plugin
cd vault-watch-plugin
npm install
npm run dev          # esbuild watch mode

# Chrome extension (separate terminal)
cd vault-watch-chrome
npm install
npm run dev
```

To test the plugin live, symlink or copy the plugin output into an Obsidian
vault's plugin folder:

```bash
cd vault-watch-plugin
cp main.js manifest.json styles.css \
   "/path/to/your/vault/.obsidian/plugins/vault-watch/"
```

Reload Obsidian (`Ctrl/Cmd+R` in the developer console) after rebuilding.

For the Chrome extension: `chrome://extensions` → Developer mode → **Load
unpacked** → pick `vault-watch-chrome/`.

## Before sending a PR

- Run `npm run typecheck` and `npm run build` in any subdir you touched —
  both must be clean.
- Manually verify the feature in Obsidian (and Chrome, if applicable).
  There is no automated UI test harness yet.
- Keep commits focused. Use Conventional Commits style if you can
  (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`).

## Testing

Vault Watch currently has **no automated tests** — this is the highest-leverage
contribution opportunity. The crypto layer (`src/crypto/`), the coalescer
(`src/watcher/coalescer.ts`), and the diff analyzer (`src/watcher/diff-analyzer.ts`)
are the most valuable to cover first because they are pure functions with
clear inputs and outputs.

## Code style

- TypeScript strict mode (no `any` unless unavoidable, with a comment).
- Prefer pure functions and small files. Anything over ~400 lines is
  worth splitting.
- Vault writes MUST go through Obsidian's `app.vault.create / .modify / .delete`
  APIs — never raw `fs.writeFile` — or Relay's CRDT layer will corrupt state.
  Same goes for moves: use `app.vault.rename`.

## Reporting bugs

Open an issue at <https://github.com/adamsz-er/vault-watch/issues> with:
- Obsidian version, plugin version, OS
- What you did, what you expected, what happened
- Relevant console output (View → Toggle Developer Tools)
- Whether Slack/Chrome integrations were involved

## Security

If you find a vulnerability — especially anything that weakens the E2E
encryption guarantees — please email the maintainer privately rather than
opening a public issue. Coordinated disclosure helps everyone using the
plugin.
