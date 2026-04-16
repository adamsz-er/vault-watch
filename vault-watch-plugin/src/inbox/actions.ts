import { App, MarkdownView, TFile } from 'obsidian';
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
      console.warn(`[vault-watch] File not found: ${item.event.filePath}`);
    }
  }

  /**
   * Open the file and append a reply block mentioning the sender.
   */
  async replyToItem(item: InboxItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.event.filePath);
    if (!(file instanceof TFile)) {
      console.warn(`[vault-watch] File not found: ${item.event.filePath}`);
      return;
    }

    // Open the file
    await this.app.workspace.openLinkText(item.event.filePath, '', false);

    // Wait for editor to be ready
    await new Promise(r => setTimeout(r, 200));

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;
    const lastLine = editor.lastLine();
    const lastLineContent = editor.getLine(lastLine);

    // Append reply block at end of file
    const reply = `${lastLineContent.trim() ? '\n' : ''}\n> **Reply** @${item.event.sender.id} `;
    editor.replaceRange(reply, { line: lastLine, ch: lastLineContent.length });

    // Move cursor to end of the inserted reply
    const newLastLine = editor.lastLine();
    const newLineContent = editor.getLine(newLastLine);
    editor.setCursor({ line: newLastLine, ch: newLineContent.length });
    editor.focus();
  }
}
