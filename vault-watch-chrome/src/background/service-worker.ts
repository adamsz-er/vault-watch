import { unseal, parseCompactPayload } from '../crypto/decrypt';
import {
  addInboxItem,
  getUnreadCount,
  getStoredKeys,
  type ChromeInboxItem,
} from '../storage/inbox';

// Listen for payloads from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'VAULT_WATCH_PAYLOAD') {
    handlePayload(message.payload).then(() => sendResponse({ ok: true }));
    return true; // async response
  }

  if (message.type === 'GET_UNREAD_COUNT') {
    getUnreadCount().then(count => sendResponse({ count }));
    return true;
  }
});

async function handlePayload(rawPayload: string): Promise<void> {
  const keys = await getStoredKeys();
  if (!keys) {
    console.warn('[vault-watch] No keys configured. Open extension settings.');
    return;
  }

  try {
    const sealed = parseCompactPayload(rawPayload);
    const plaintext = unseal(sealed, keys.privateKeyX25519);
    const data = JSON.parse(plaintext);

    // Could be a single event or batch array
    const events = Array.isArray(data) ? data : [data];

    for (const event of events) {
      const item: ChromeInboxItem = {
        id: event.id,
        sender: event.sender?.name || event.sender?.id || 'Unknown',
        type: event.type,
        fileTitle: event.fileTitle,
        filePath: event.filePath,
        vault: event.vault,
        summary: event.change?.summary || '',
        mentionedMembers: event.mentionedMembers || [],
        priority: event.priority,
        receivedAt: Date.now(),
        read: false,
      };

      await addInboxItem(item);

      // Desktop notification for high-priority / mentions
      if (event.priority === 'high' || event.mentionedMembers?.includes(keys.memberId)) {
        await showNotification(item);
      }
    }

    // Update badge
    await updateBadge();
  } catch (err) {
    console.error('[vault-watch] Failed to process payload:', err);
  }
}

async function showNotification(item: ChromeInboxItem): Promise<void> {
  const title = item.type === 'mention'
    ? `${item.sender} mentioned you`
    : `${item.sender} edited "${item.fileTitle}"`;

  chrome.notifications.create(item.id, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: 'Vault Watch',
    message: `${title}\n${item.summary}`,
    priority: 2,
  });
}

async function updateBadge(): Promise<void> {
  const count = await getUnreadCount();
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#7c3aed' : '#888' });
}

// Notification click -> open in Obsidian
chrome.notifications.onClicked.addListener(async (notificationId) => {
  // notificationId is the inbox item id; we could look it up and open the file
  chrome.notifications.clear(notificationId);
});

// Update badge on startup
updateBadge();
