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

  // Footer buttons
  document.getElementById('markAllRead')?.addEventListener('click', async () => {
    await markAllRead();
    await renderInbox();
  });

  document.getElementById('settings')?.addEventListener('click', () => {
    showSetup();
  });
}

function showSetup(): void {
  const setupEl = document.getElementById('setup')!;
  const inboxEl = document.getElementById('inbox')!;
  setupEl.style.display = 'block';
  inboxEl.style.display = 'none';

  document.getElementById('saveKeys')?.addEventListener('click', async () => {
    const input = (document.getElementById('keyInput') as HTMLTextAreaElement).value.trim();
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
      alert('Invalid key JSON. Please paste the exact output from Obsidian plugin settings.');
    }
  });
}

async function renderInbox(): Promise<void> {
  const setupEl = document.getElementById('setup')!;
  const inboxEl = document.getElementById('inbox')!;
  setupEl.style.display = 'none';
  inboxEl.style.display = 'block';

  const items = await getInboxItems();
  const unread = await getUnreadCount();

  // Badge
  const badge = document.getElementById('badge')!;
  if (unread > 0) {
    badge.style.display = 'inline';
    badge.textContent = String(unread);
  } else {
    badge.style.display = 'none';
  }

  // Render items
  inboxEl.innerHTML = '';

  if (items.length === 0) {
    inboxEl.innerHTML = '<div class="empty">No notifications yet</div>';
    return;
  }

  for (const item of items.slice(0, 50)) {
    const card = document.createElement('div');
    card.className = `card ${item.read ? '' : 'unread'}`;

    const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(item.vault)}&file=${encodeURIComponent(item.filePath)}`;

    card.innerHTML = `
      <div class="card-header">
        <span class="sender">${escapeHtml(item.sender)}</span>
        <span class="time">${formatTimeAgo(item.receivedAt)}</span>
      </div>
      <div class="action-text">${escapeHtml(formatAction(item))}</div>
      <div class="summary">${escapeHtml(item.summary)}</div>
      ${item.mentionedMembers.length > 0 ? `<span class="mention-badge">${item.mentionedMembers.map(m => '@' + m).join(' ')} mentioned</span>` : ''}
      <a class="open-btn" href="${obsidianUrl}" target="_blank">Open in Obsidian</a>
    `;

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
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  return `${day}d ago`;
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

init();
