import type { InboxItem } from '../types';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Collapse consecutive inbox items into groups when they share a file and
 * arrived within the grouping window. Mentions and reactions never fold —
 * they need to stand out individually.
 *
 * Input must be sorted newest-first; output preserves that ordering and the
 * relative order within each group.
 */
export function groupInboxItems(items: InboxItem[], windowMs: number = HOUR_MS): InboxItem[][] {
  if (items.length === 0) return [];
  const groups: InboxItem[][] = [];
  let current: InboxItem[] = [items[0]];

  for (let i = 1; i < items.length; i++) {
    const prev = current[current.length - 1];
    const curr = items[i];

    const sameFile = prev.event.filePath === curr.event.filePath;
    const closeInTime = prev.receivedAt - curr.receivedAt < windowMs;
    const standsAlone = (e: InboxItem) => e.event.type === 'mention' || e.event.type === 'reaction';
    const folds = !standsAlone(curr) && !standsAlone(prev);

    if (sameFile && closeInTime && folds) {
      current.push(curr);
    } else {
      groups.push(current);
      current = [curr];
    }
  }

  groups.push(current);
  return groups;
}
