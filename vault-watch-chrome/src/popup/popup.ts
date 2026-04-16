import {
  getInboxItems,
  markRead,
  markAllRead,
  getUnreadCount,
  getStoredKeys,
  storeKeys,
  type ChromeInboxItem,
  type StoredKeys,
} from '../storage/inbox';

async function init(): Promise<void> {
  const keys = await getStoredKeys();

  if (!keys) {
    showSetup();
  } else {
    await renderInbox();
  }

  document.getElementById('markAllRead')?.addEventListener('click', async () => {
    await markAllRead();
    await renderInbox();
  });

  document.getElementById('settings')?.addEventListener('click', () => {
    showSetup();
  });
}

function showSetup(): void {
  const setupEl = document.getElementById('setup');
  const inboxEl = document.getElementById('inbox');
  if (!setupEl || !inboxEl) return;

  setupEl.style.display = 'block';
  inboxEl.style.display = 'none';

  const errorEl = document.getElementById('setupError');
  const showSetupError = (msg: string): void => {
    if (errorEl) errorEl.textContent = msg;
  };

  document.getElementById('saveKeys')?.addEventListener('click', async () => {
    const textarea = document.getElementById('keyInput') as HTMLTextAreaElement | null;
    if (!textarea) return;

    showSetupError('');
    const input = textarea.value.trim();
    try {
      const parsed = JSON.parse(input) as StoredKeys;
      if (!parsed.memberId || !parsed.privateKeyX25519) {
        throw new Error('Missing fields');
      }
      await storeKeys(parsed);
      setupEl.style.display = 'none';
      inboxEl.style.display = 'block';
      await renderInbox();
    } catch {
      showSetupError('Invalid key JSON. Paste the exact output from Obsidian plugin settings → Export private key.');
    }
  });
}

async function renderInbox(): Promise<void> {
  const setupEl = document.getElementById('setup');
  const inboxEl = document.getElementById('inbox');
  const badge = document.getElementById('badge');
  if (!setupEl || !inboxEl || !badge) return;

  setupEl.style.display = 'none';
  inboxEl.style.display = 'block';

  const items = await getInboxItems();
  const unread = await getUnreadCount();

  if (unread > 0) {
    badge.style.display = 'inline';
    badge.textContent = String(unread);
  } else {
    badge.style.display = 'none';
  }

  inboxEl.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No notifications yet';
    inboxEl.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 50)) {
    const card = document.createElement('div');
    card.className = `card ${item.read ? '' : 'unread'}`;

    // Header
    const header = document.createElement('div');
    header.className = 'card-header';

    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = item.sender;
    header.appendChild(sender);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTimeAgo(item.receivedAt);
    header.appendChild(time);

    card.appendChild(header);

    // Action
    const action = document.createElement('div');
    action.className = 'action-text';
    action.textContent = formatAction(item);
    card.appendChild(action);

    // Summary
    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.textContent = item.summary;
    card.appendChild(summary);

    // Mention badge
    if (item.mentionedMembers.length > 0) {
      const mentionBadge = document.createElement('span');
      mentionBadge.className = 'mention-badge';
      mentionBadge.textContent = item.mentionedMembers.map(m => '@' + m).join(' ') + ' mentioned';
      card.appendChild(mentionBadge);
    }

    // Open button
    const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(item.vault)}&file=${encodeURIComponent(item.filePath)}`;
    const openBtn = document.createElement('a');
    openBtn.className = 'open-btn';
    openBtn.textContent = 'Open in Obsidian';
    openBtn.href = obsidianUrl;
    openBtn.target = '_blank';
    card.appendChild(openBtn);

    card.addEventListener('click', async () => {
      if (!item.read) {
        await markRead(item.id);
        card.classList.remove('unread');
        const newUnread = await getUnreadCount();
        badge.textContent = String(newUnread);
        badge.style.display = newUnread > 0 ? 'inline' : 'none';
      }
    });

    inboxEl.appendChild(card);
  }
}

function formatAction(item: ChromeInboxItem): string {
  switch (item.type) {
    case 'file_created': return `Created "${item.fileTitle}"`;
    case 'file_deleted': return `Deleted "${item.fileTitle}"`;
    case 'file_renamed': return `Renamed "${item.fileTitle}"`;
    case 'mention': return `Mentioned you in "${item.fileTitle}"`;
    default: return `Edited "${item.fileTitle}"`;
  }
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  return `${day}d ago`;
}

init();
