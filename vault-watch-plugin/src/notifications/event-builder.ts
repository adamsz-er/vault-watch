import { ulid } from 'ulid';
import type {
  NotificationEvent,
  ChangeAnalysis,
  EventType,
  Priority,
  VaultWatchSettings,
  Member,
} from '../types';

export class EventBuilder {
  constructor(
    private settings: VaultWatchSettings,
    private getMembers: () => Member[]
  ) {}

  build(
    filePath: string,
    analysis: ChangeAnalysis,
    coalescedCount: number,
    eventType: EventType = 'file_changed',
    oldPath?: string
  ): NotificationEvent {
    const members = this.getMembers();
    const otherMembers = members.filter(m => m.id !== this.settings.memberId);

    // Determine recipients: all other members (2-person team)
    const recipients = otherMembers.map(m => m.id);

    // Determine priority
    const priority = this.determinePriority(analysis, otherMembers);

    // Override event type for mentions
    const type = analysis.mentionedMembers.length > 0 ? 'mention' : eventType;

    const fileTitle = this.extractTitle(filePath);

    return {
      id: ulid(),
      v: 1,
      type,
      ts: Date.now(),
      sender: {
        id: this.settings.memberId,
        name: this.settings.displayName,
      },
      vault: this.settings.vaultName,
      filePath,
      fileTitle,
      oldPath,
      change: {
        changeType: analysis.changeType,
        summary: analysis.summary,
        affectedHeadings: analysis.affectedHeadings,
        charDelta: analysis.charDelta,
        addedExcerpt: analysis.addedExcerpt,
        coalescedCount,
      },
      recipients,
      mentionedMembers: analysis.mentionedMembers,
      priority,
      tags: analysis.addedTags.length > 0 ? analysis.addedTags : undefined,
    };
  }

  buildDeleteEvent(filePath: string, lastContent: string): NotificationEvent {
    const members = this.getMembers();
    const recipients = members.filter(m => m.id !== this.settings.memberId).map(m => m.id);

    return {
      id: ulid(),
      v: 1,
      type: 'file_deleted',
      ts: Date.now(),
      sender: {
        id: this.settings.memberId,
        name: this.settings.displayName,
      },
      vault: this.settings.vaultName,
      filePath,
      fileTitle: this.extractTitle(filePath),
      change: {
        changeType: 'content_removed',
        summary: `Deleted "${this.extractTitle(filePath)}"`,
        affectedHeadings: [],
        charDelta: -lastContent.length,
        coalescedCount: 1,
      },
      recipients,
      mentionedMembers: [],
      priority: 'normal',
    };
  }

  buildRenameEvent(newPath: string, oldPath: string): NotificationEvent {
    const members = this.getMembers();
    const recipients = members.filter(m => m.id !== this.settings.memberId).map(m => m.id);

    return {
      id: ulid(),
      v: 1,
      type: 'file_renamed',
      ts: Date.now(),
      sender: {
        id: this.settings.memberId,
        name: this.settings.displayName,
      },
      vault: this.settings.vaultName,
      filePath: newPath,
      fileTitle: this.extractTitle(newPath),
      oldPath,
      change: {
        changeType: 'heading_changed',
        summary: `Renamed "${this.extractTitle(oldPath)}" → "${this.extractTitle(newPath)}"`,
        affectedHeadings: [],
        charDelta: 0,
        coalescedCount: 1,
      },
      recipients,
      mentionedMembers: [],
      priority: 'low',
    };
  }

  private determinePriority(analysis: ChangeAnalysis, otherMembers: Member[]): Priority {
    // High: mentions of other team members
    if (analysis.mentionedMembers.some(m =>
      otherMembers.some(om => om.id === m)
    )) {
      return 'high';
    }

    // High: urgent tags
    if (analysis.addedTags.some(t => t === 'urgent' || t === 'priority')) {
      return 'high';
    }

    // Normal: meaningful content changes
    if (analysis.changeType === 'content_added' || analysis.changeType === 'content_removed') {
      return 'normal';
    }

    // Low: everything else
    return 'low';
  }

  private extractTitle(filePath: string): string {
    const parts = filePath.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace(/\.md$/, '');
  }
}
