import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from 'obsidian';
import type { Member } from '../types';

export class MentionSuggest extends EditorSuggest<Member> {
  constructor(
    private app: import('obsidian').App,
    private getMembers: () => Member[]
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.slice(0, cursor.ch);

    // Look for @trigger
    const match = sub.match(/@(\w*)$/);
    if (!match) return null;

    return {
      start: { line: cursor.line, ch: cursor.ch - match[0].length },
      end: cursor,
      query: match[1],
    };
  }

  getSuggestions(context: EditorSuggestContext): Member[] {
    const query = context.query.toLowerCase();
    const members = this.getMembers();

    if (!query) return members;

    return members.filter(
      m =>
        m.id.toLowerCase().includes(query) ||
        m.displayName.toLowerCase().includes(query)
    );
  }

  renderSuggestion(member: Member, el: HTMLElement): void {
    el.createEl('span', { text: `@${member.id}`, cls: 'vault-watch-mention-id' });
    el.createEl('span', { text: ` — ${member.displayName}`, cls: 'vault-watch-mention-name' });
  }

  selectSuggestion(member: Member, _evt: MouseEvent | KeyboardEvent): void {
    if (!this.context) return;

    const editor = this.context.editor;
    const start = this.context.start;
    const end = this.context.end;

    editor.replaceRange(`@${member.id} `, start, end);
  }
}
