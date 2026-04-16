/**
 * Tunable timing constants used by the UI layer. Keeping them here makes it
 * obvious what's hand-tuned and easy to adjust without hunting through code.
 *
 * Network/protocol timings (debounce, session coalesce, Slack batch) live in
 * the watcher modules where they are more tightly coupled to behaviour.
 */

/** Delay after `openLinkText` before the editor's API is reliably populated. */
export const EDITOR_READY_MS = 200;

/** How often the inbox view re-renders to refresh "2m ago" timestamps. */
export const INBOX_TIMESTAMP_REFRESH_MS = 30_000;
