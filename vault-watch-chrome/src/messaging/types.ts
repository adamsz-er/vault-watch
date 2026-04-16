/**
 * Discriminated union of every message exchanged between the content script,
 * the service worker, and the popup. Centralising these prevents
 * sender↔receiver shape drift — change the type here and the compiler
 * surfaces every call site that needs updating.
 *
 * Convention: messages are named TYPE_NOUN (verb-first).
 */

export type VaultWatchMessage =
  | { type: 'VAULT_WATCH_PAYLOAD'; payload: string }
  | { type: 'GET_UNREAD_COUNT' };

export type VaultWatchResponse =
  | { type: 'VAULT_WATCH_PAYLOAD'; ok: boolean; error?: string }
  | { type: 'GET_UNREAD_COUNT'; count: number };

/**
 * Type-safe wrapper around chrome.runtime.sendMessage. Resolves with the
 * matching response shape for the message kind that was sent.
 */
export function sendMessage<M extends VaultWatchMessage>(
  message: M
): Promise<Extract<VaultWatchResponse, { type: M['type'] }>> {
  return chrome.runtime.sendMessage(message);
}
