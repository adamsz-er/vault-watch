# Vault Watch — screenshots

The PNGs in this directory are **component mockups**, not captures of a running Obsidian vault. They're rendered from static HTML pages in `docs/mockups/` that import the actual plugin `styles.css`, so the visual output is pixel-identical to the live UI — just with synthetic dummy content (fake people Alice & Bob, fake files like "Q2 Roadmap.md") so we can publish them without leaking anyone's real vault data.

## Why mockups instead of real screenshots

- **No privacy leakage.** Real captures would expose actual file names, member names, and note contents.
- **Perfect composition.** We can show exactly the cards / lanes / event types we want to demo, including grouped cards, mentions, reactions, and high-priority tags, without waiting for the right activity to happen organically.
- **Reproducible.** Anyone can re-render any screenshot with the same command (see below).

The components themselves — every card, dot color, chip, lane, footer button — are styled by the real `vault-watch-plugin/styles.css`, so the screenshots stay in sync with the actual UI as styles evolve.

## Re-rendering

Source HTML lives in [`docs/mockups/`](../mockups/). To regenerate:

```bash
# 1. Serve the repo locally so the relative ../../vault-watch-plugin/styles.css link resolves
python3 -m http.server 8765 --bind 127.0.0.1 &

# 2. Re-render any one mockup with headless Chrome
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=420,640 \
  --screenshot=docs/screenshots/inbox-sidebar.png \
  http://127.0.0.1:8765/docs/mockups/inbox-sidebar.html
```

Window sizes used for each:

| Filename | Window size |
|---|---|
| `inbox-sidebar.png` | 420 × 640 |
| `tasks-view.png` | 900 × 500 |
| `chrome-popup.png` | 420 × 640 |
| `slack-message.png` | 820 × 260 |
| `toast.png` | 720 × 260 |
| `hero.png` | 1400 × 520 |

## Authoring guidelines

- Keep dummy content **generic and presentable**. Use Alice/Bob, never real names. File names should look like real product work but be made up.
- Match the **real DOM structure** in `vault-watch-plugin/src/inbox/inbox-view.ts` — class names like `.vw-card`, `.vw-dot`, `.vw-task-lane`, etc. The mockup pages link to the real `styles.css`, so anything class-based renders identically.
- For new mockups: one HTML file per screenshot, link both `_obsidian-theme.css` (Obsidian variable defaults) and the real `styles.css`.
- When a real Obsidian capture would be more honest (e.g. a workflow diagram, a settings panel), prefer that — these mockups are for the polished marketing-style README only.
