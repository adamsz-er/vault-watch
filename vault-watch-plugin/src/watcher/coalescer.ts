import type {
  EditSession,
  SlackBatch,
  NotificationEvent,
  EventType,
  VaultWatchSettings,
} from '../types';
import { DiffAnalyzer } from './diff-analyzer';
import { EventBuilder } from '../notifications/event-builder';

export interface CoalescerSink {
  dispatchToVault(event: NotificationEvent): Promise<void>;
  sendSlackSingle(event: NotificationEvent): Promise<void>;
  sendSlackBatch(events: NotificationEvent[]): Promise<void>;
}

export class Coalescer {
  private fileSessions = new Map<string, EditSession>();
  private slackBatch: SlackBatch | null = null;
  private diffAnalyzer = new DiffAnalyzer();

  constructor(
    private settings: VaultWatchSettings,
    private eventBuilder: EventBuilder,
    private sink: CoalescerSink,
    private getLastKnownContent: (filePath: string) => string
  ) {}

  onDebouncedChange(filePath: string, content: string, eventType: EventType): void {
    const existing = this.fileSessions.get(filePath);

    if (existing) {
      // Merge into active session
      existing.latestContent = content;
      existing.changeCount++;
      clearTimeout(existing.sessionTimer);

      // Check if this change is high-priority — flush immediately if so
      if (this.isHighPriority(existing.firstContent, content)) {
        this.closeSession(filePath);
        return;
      }

      existing.sessionTimer = setTimeout(
        () => this.closeSession(filePath),
        this.settings.sessionTimeoutMs
      );
    } else {
      // Start new session -- capture first snapshot for cumulative diff
      const firstContent = this.getLastKnownContent(filePath);

      // For file creates or high-priority changes, flush immediately
      if (eventType === 'file_created' || this.isHighPriority(firstContent, content)) {
        // Skip session — dispatch right away
        const analysis = this.diffAnalyzer.analyze(firstContent, content);
        if (analysis.isSignificant) {
          const event = this.eventBuilder.build(filePath, analysis, 1, eventType);
          this.dispatchEvent(event);
        }
        return;
      }

      this.fileSessions.set(filePath, {
        filePath,
        firstContent,
        latestContent: content,
        firstEventTs: Date.now(),
        changeCount: 1,
        sessionTimer: setTimeout(
          () => this.closeSession(filePath),
          this.settings.sessionTimeoutMs
        ),
      });
    }
  }

  /**
   * Quick check if a change contains mentions or urgent tags.
   * Used to bypass session coalescing for realtime delivery.
   */
  private isHighPriority(oldContent: string, newContent: string): boolean {
    const analysis = this.diffAnalyzer.analyze(oldContent, newContent);
    return analysis.mentionedMembers.length > 0 ||
      analysis.addedTags.some(t => t === 'urgent' || t === 'priority');
  }

  onFileDeleted(filePath: string, lastContent: string): void {
    // Cancel any active session for this file
    const session = this.fileSessions.get(filePath);
    if (session) {
      clearTimeout(session.sessionTimer);
      this.fileSessions.delete(filePath);
    }

    const event = this.eventBuilder.buildDeleteEvent(filePath, lastContent);
    this.dispatchEvent(event);
  }

  onFileRenamed(newPath: string, oldPath: string): void {
    // Cancel any active session for old path
    const session = this.fileSessions.get(oldPath);
    if (session) {
      clearTimeout(session.sessionTimer);
      this.fileSessions.delete(oldPath);
    }

    const event = this.eventBuilder.buildRenameEvent(newPath, oldPath);
    this.dispatchEvent(event);
  }

  destroy(): void {
    for (const session of this.fileSessions.values()) {
      clearTimeout(session.sessionTimer);
    }
    this.fileSessions.clear();

    if (this.slackBatch) {
      clearTimeout(this.slackBatch.windowTimer);
      this.slackBatch = null;
    }
  }

  /** Force flush all pending sessions (for plugin unload) */
  async flushAll(): Promise<void> {
    const paths = Array.from(this.fileSessions.keys());
    for (const path of paths) {
      await this.closeSession(path);
    }
    await this.flushSlackBatch();
  }

  private async closeSession(filePath: string): Promise<void> {
    const session = this.fileSessions.get(filePath);
    if (!session) return;
    this.fileSessions.delete(filePath);

    // Diff first snapshot vs final content (cumulative diff)
    const analysis = this.diffAnalyzer.analyze(
      session.firstContent,
      session.latestContent
    );
    if (!analysis.isSignificant) return;

    const event = this.eventBuilder.build(
      filePath,
      analysis,
      session.changeCount
    );

    await this.dispatchEvent(event);
  }

  private async dispatchEvent(event: NotificationEvent): Promise<void> {
    // Vault relay: dispatch immediately
    await this.sink.dispatchToVault(event);

    // Slack relay: add to batch (Layer 3)
    if (this.settings.slackEnabled) {
      this.addToSlackBatch(event);
    }
  }

  private addToSlackBatch(event: NotificationEvent): void {
    if (!this.slackBatch) {
      this.slackBatch = {
        events: [],
        windowTimer: setTimeout(
          () => this.flushSlackBatch(),
          this.settings.slackBatchMs
        ),
        hasHighPriority: false,
      };
    }

    this.slackBatch.events.push(event);

    // High priority = flush immediately
    if (event.priority === 'high') {
      this.slackBatch.hasHighPriority = true;
      this.flushSlackBatch();
    }
  }

  private async flushSlackBatch(): Promise<void> {
    if (!this.slackBatch || this.slackBatch.events.length === 0) {
      if (this.slackBatch) {
        clearTimeout(this.slackBatch.windowTimer);
        this.slackBatch = null;
      }
      return;
    }

    const batch = this.slackBatch;
    this.slackBatch = null;
    clearTimeout(batch.windowTimer);

    try {
      if (batch.events.length === 1) {
        await this.sink.sendSlackSingle(batch.events[0]);
      } else {
        await this.sink.sendSlackBatch(batch.events);
      }
    } catch (err) {
      console.error('[vault-watch] Failed to send Slack batch:', err);
    }
  }
}
