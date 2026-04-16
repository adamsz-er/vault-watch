import type { EventType } from '../types';

/**
 * Past-tense verb describing what the sender did to the file.
 * Used in inbox card phrases ("Alice <verb> file.md") and in Slack
 * messages — keep both call sites in sync via this single mapping.
 */
export function getEventVerb(type: EventType | string): string {
  switch (type) {
    case 'file_created': return 'created';
    case 'file_deleted': return 'deleted';
    case 'file_renamed': return 'renamed';
    case 'mention':      return 'mentioned you in';
    case 'share':        return 'shared';
    case 'reaction':     return 'reacted to';
    case 'task_assigned': return 'assigned you';
    default:             return 'edited';
  }
}
