import { Notice } from 'obsidian';

/**
 * Show a user-facing failure toast and log the underlying error to the
 * console with a consistent `[vault-watch]` prefix.
 *
 * Use for failures the user should know about (a push didn't go through,
 * a file move failed). For silent/recoverable issues, just `console.error`
 * directly — wrapping every log adds noise without value.
 *
 * @param userMessage  Short, user-friendly toast text. Caller can include
 *                     specifics ("Move failed: <reason>") or stay generic.
 * @param err          The thrown value. Always logged so the developer
 *                     console has the full stack.
 */
export function notifyError(userMessage: string, err: unknown): void {
  console.error('[vault-watch]', userMessage, err);
  new Notice(userMessage);
}
