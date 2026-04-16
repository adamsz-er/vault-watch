/**
 * Content script that runs on app.slack.com.
 * Watches for vault-watch payloads in Slack messages and forwards to service worker.
 */

const PAYLOAD_PREFIX = 'vault-watch:v1:';
const processedPayloads = new Set<string>();

function scanForPayloads(root: Node): void {
  if (!(root instanceof HTMLElement)) return;

  // Look for text nodes containing our payload prefix
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent || '';
    const idx = text.indexOf(PAYLOAD_PREFIX);
    if (idx === -1) continue;

    const payload = text.slice(idx + PAYLOAD_PREFIX.length).trim();
    if (!payload || processedPayloads.has(payload)) continue;

    processedPayloads.add(payload);

    // Send to service worker for decryption
    chrome.runtime.sendMessage({
      type: 'VAULT_WATCH_PAYLOAD',
      payload,
    });
  }
}

// Initial scan
scanForPayloads(document.body);

// Watch for new messages via MutationObserver
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      scanForPayloads(node);
    }
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// Cleanup on page unload
window.addEventListener('unload', () => {
  observer.disconnect();
});
