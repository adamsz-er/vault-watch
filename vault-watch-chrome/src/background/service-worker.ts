import { unseal, parseCompactPayload } from '../crypto/decrypt';
import {
  addInboxItem,
  getInboxItems,
  getUnreadCount,
  getStoredKeys,
  type ChromeInboxItem,
} from '../storage/inbox';

// Listen for payloads from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'VAULT_WATCH_PAYLOAD') {
    handlePayload(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[vault-watch] Payload error:', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === 'GET_UNREAD_COUNT') {
    getUnreadCount()
      .then(count => sendResponse({ count }))
      .catch(() => sendResponse({ count: 0 }));
    return true;
  }
});

async function handlePayload(rawPayload: string): Promise<void> {
  const keys = await getStoredKeys();
  if (!keys) {
    console.warn('[vault-watch] No keys configured. Open extension settings.');
    return;
  }

  const sealed = parseCompactPayload(rawPayload);
  const plaintext = unseal(sealed, keys.privateKeyX25519);
  const data = JSON.parse(plaintext);

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

    if (event.priority === 'high' || event.mentionedMembers?.includes(keys.memberId)) {
      await showNotification(item);
    }
  }

  await updateBadge();
}

async function showNotification(item: ChromeInboxItem): Promise<void> {
  const title = item.type === 'mention'
    ? `${item.sender} mentioned you`
    : `${item.sender} edited "${item.fileTitle}"`;

  try {
    chrome.notifications.create(item.id, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'Vault Watch',
      message: `${title}\n${item.summary}`,
      priority: 2,
    });
  } catch (err) {
    console.error('[vault-watch] Notification failed:', err);
  }
}

async function updateBadge(): Promise<void> {
  const count = await getUnreadCount();
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#7c3aed' : '#888' });
}

// Notification click -> open in Obsidian
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);

  // Look up the item and open in Obsidian
  const items = await getInboxItems();
  const item = items.find(i => i.id === notificationId);
  if (item) {
    const url = `obsidian://open?vault=${encodeURIComponent(item.vault)}&file=${encodeURIComponent(item.filePath)}`;
    chrome.tabs.create({ url });
  }
});

// Update badge on startup
updateBadge();
