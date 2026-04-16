import { App } from 'obsidian';
import type { InboxItem } from '../types';

/**
 * Inbox item actions -- navigate to file, mark read, etc.
 */
export class InboxActions {
  constructor(private app: App) {}

  /**
   * Open the file associated with an inbox item.
   */
  async openFile(item: InboxItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.event.filePath);
    if (file) {
      await this.app.workspace.openLinkText(item.event.filePath, '', false);
    } else {
      // File may have been deleted or renamed
      console.warn(`[vault-watch] File not found: ${item.event.filePath}`);
    }
  }
}
