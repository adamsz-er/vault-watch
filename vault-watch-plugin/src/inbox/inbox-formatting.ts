/**
 * Pure presentation helpers used by the inbox view. Kept side-effect-free
 * so they can be tested or reused (e.g. by the Chrome popup).
 */

/** Up-to-2-character initials for avatar bubbles. Empty/whitespace → "?". */
export function getInitials(name: string): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/** CSS class for the color-coded left border / dot indicating event type. */
export function eventColorClass(type: string): string {
  switch (type) {
    case 'mention':       return 'vw-type-mention';
    case 'file_created':  return 'vw-type-created';
    case 'file_deleted':  return 'vw-type-deleted';
    case 'share':         return 'vw-type-share';
    case 'reaction':      return 'vw-type-reaction';
    default:              return 'vw-type-edit';
  }
}

/** Localised "Apr 17, 2026" form. */
export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Compact "now / 2m / 3h / 5d / Apr 17, 2026" relative time.
 * Falls through to absolute date past one week.
 */
export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'now';
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return formatDate(ts);
}

/** Drops the placeholder summary strings that just repeat the verb. */
export function formatItemSummary(summary: string | undefined): string {
  if (!summary) return '';
  if (summary === 'Created' || summary === 'Deleted' || summary === 'Renamed') return '';
  return summary;
}
