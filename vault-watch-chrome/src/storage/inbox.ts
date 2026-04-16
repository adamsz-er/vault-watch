export interface ChromeInboxItem {
  id: string;
  sender: string;
  type: string;
  fileTitle: string;
  filePath: string;
  vault: string;
  summary: string;
  mentionedMembers: string[];
  priority: string;
  receivedAt: number;
  read: boolean;
}

const STORAGE_KEY = 'vault_watch_inbox';
const MAX_ITEMS = 200;

export async function getInboxItems(): Promise<ChromeInboxItem[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] || []) as ChromeInboxItem[];
}

export async function addInboxItem(item: ChromeInboxItem): Promise<void> {
  const items = await getInboxItems();

  // Dedup
  if (items.some(i => i.id === item.id)) return;

  items.unshift(item);

  // Trim old items
  if (items.length > MAX_ITEMS) {
    items.length = MAX_ITEMS;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

export async function markRead(id: string): Promise<void> {
  const items = await getInboxItems();
  const item = items.find(i => i.id === id);
  if (item) {
    item.read = true;
    await chrome.storage.local.set({ [STORAGE_KEY]: items });
  }
}

export async function markAllRead(): Promise<void> {
  const items = await getInboxItems();
  for (const item of items) {
    item.read = true;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

export async function getUnreadCount(): Promise<number> {
  const items = await getInboxItems();
  return items.filter(i => !i.read).length;
}

export async function clearAll(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

// Key storage
const KEY_STORAGE = 'vault_watch_keys';

export interface StoredKeys {
  memberId: string;
  privateKeyX25519: string;
  privateKeyEd25519: string;
}

export async function getStoredKeys(): Promise<StoredKeys | null> {
  const result = await chrome.storage.local.get(KEY_STORAGE);
  return result[KEY_STORAGE] || null;
}

export async function storeKeys(keys: StoredKeys): Promise<void> {
  await chrome.storage.local.set({ [KEY_STORAGE]: keys });
}
