import type { InboxItem } from '../types';

export interface ChatThread {
  root: InboxItem;
  replies: InboxItem[];
}

/**
 * Group chat messages into threads. Messages without `threadRootId` (legacy)
 * or with `threadRootId === event.id` are roots. Others attach to their root.
 *
 * Orphan replies (whose root hasn't arrived yet) are promoted to roots so
 * they still render.
 *
 * Input is assumed to be sorted ascending by `event.ts`. Output roots are
 * ordered by root timestamp ascending; replies within a thread are
 * ordered by timestamp ascending.
 */
export function groupIntoThreads(items: InboxItem[]): ChatThread[] {
  const byId = new Map<string, InboxItem>();
  for (const i of items) byId.set(i.id, i);

  const threads = new Map<string, ChatThread>();

  for (const item of items) {
    const rootId = item.event.threadRootId ?? item.id;
    if (rootId === item.id) {
      if (!threads.has(item.id)) {
        threads.set(item.id, { root: item, replies: [] });
      }
    }
  }

  for (const item of items) {
    const rootId = item.event.threadRootId;
    if (!rootId || rootId === item.id) continue;
    const thread = threads.get(rootId);
    if (thread) {
      thread.replies.push(item);
    } else {
      // Orphan reply — promote to root so it still renders
      threads.set(item.id, { root: item, replies: [] });
    }
  }

  const result = Array.from(threads.values());
  result.sort((a, b) => a.root.event.ts - b.root.event.ts);
  for (const t of result) {
    t.replies.sort((a, b) => a.event.ts - b.event.ts);
  }
  return result;
}
