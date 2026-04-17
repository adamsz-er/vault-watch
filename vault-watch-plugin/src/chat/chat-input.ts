import { App } from 'obsidian';
import type { Member } from '../types';
import { listDocRefs, filterDocRefs, DocRefEntry } from './doc-ref-picker';

export interface ChatSubmission {
  body: string;                     // plaintext with @id / #path tokens
  mentionedMembers: string[];
  docRefs: string[];
}

interface ChatInputOptions {
  app: App;
  getMembers: () => Member[];
  onSubmit: (submission: ChatSubmission) => Promise<void> | void;
  placeholder?: string;
}

type Trigger = { char: '@' | '#'; startOffset: number; node: Text; query: string };

export class ChatInput {
  private wrap: HTMLDivElement;
  private editor: HTMLDivElement;
  private popover: HTMLElement | null = null;
  private activeTrigger: Trigger | null = null;
  private suggestionIndex = 0;
  private suggestionItems: Array<Member | DocRefEntry> = [];
  private docRefsCache: DocRefEntry[] | null = null;

  constructor(private opts: ChatInputOptions) {
    this.wrap = document.createElement('div');
    this.wrap.className = 'vw-chat-input-wrap';
    this.editor = document.createElement('div');
    this.render();
  }

  /** Attach the input DOM to a parent. Safe to call repeatedly — moves the DOM. */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.wrap);
  }

  getWrap(): HTMLElement {
    return this.wrap;
  }

  private render(): void {
    this.wrap.empty();

    this.editor = this.wrap.createEl('div', {
      cls: 'vw-chat-input',
      attr: {
        contenteditable: 'true',
        role: 'textbox',
        'aria-multiline': 'true',
        'data-placeholder': this.opts.placeholder || 'Message — @ to mention, # to link a note',
      },
    });

    this.editor.addEventListener('input', () => this.handleInput());
    this.editor.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.editor.addEventListener('blur', () => {
      // Delay so clicks on popover land before closing
      setTimeout(() => this.closePopover(), 150);
    });

    const hint = this.wrap.createDiv({ cls: 'vw-chat-input-hint' });
    hint.createSpan({ text: 'Enter to send · Shift+Enter for newline' });
  }

  setPlaceholder(text: string): void {
    this.editor.setAttr('data-placeholder', text);
  }

  focus(): void {
    this.editor.focus();
  }

  clear(): void {
    this.editor.empty();
    this.closePopover();
  }

  /**
   * Insert a doc-ref chip at the current caret (or at the end if the editor isn't focused).
   * No-op if the same path is already chipped in the editor.
   */
  insertDocRef(path: string, label: string, kind: 'file' | 'folder' = 'file'): void {
    if (this.editor.querySelector(`.vw-chat-chip-ref[data-path="${CSS.escape(path)}"]`)) {
      this.focus();
      return;
    }

    this.focus();
    const chip = this.createChip('#', { path, label, kind });
    const space = document.createTextNode('\u00A0');

    const sel = window.getSelection();
    let range: Range;
    const existingRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (existingRange && this.editor.contains(existingRange.startContainer)) {
      range = existingRange;
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(this.editor);
      range.collapse(false);
    }

    range.insertNode(space);
    range.insertNode(chip);

    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
  }

  destroy(): void {
    this.closePopover();
  }

  // ─── Submission ───

  private async submit(): Promise<void> {
    const submission = this.serialize();
    if (!submission.body.trim()) return;
    await this.opts.onSubmit(submission);
    this.clear();
  }

  private serialize(): ChatSubmission {
    const mentionedMembers = new Set<string>();
    const docRefs = new Set<string>();
    let body = '';

    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        body += node.textContent || '';
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.hasClass('vw-chat-chip-mention')) {
        const id = el.getAttr('data-member-id');
        if (id) {
          mentionedMembers.add(id);
          body += `@${id}`;
        }
        return;
      }
      if (el.hasClass('vw-chat-chip-ref')) {
        const path = el.getAttr('data-path');
        if (path) {
          docRefs.add(path);
          body += `#${path}`;
        }
        return;
      }
      if (el.tagName === 'BR') {
        body += '\n';
        return;
      }
      if (el.tagName === 'DIV' && body.length > 0 && !body.endsWith('\n')) {
        body += '\n';
      }
      el.childNodes.forEach(walk);
    };

    this.editor.childNodes.forEach(walk);

    return {
      body: body.trim(),
      mentionedMembers: Array.from(mentionedMembers),
      docRefs: Array.from(docRefs),
    };
  }

  // ─── Trigger detection ───

  private handleInput(): void {
    const trigger = this.detectTrigger();
    if (!trigger) {
      this.closePopover();
      return;
    }
    this.activeTrigger = trigger;
    this.openPopover(trigger);
  }

  private detectTrigger(): Trigger | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    if (!this.editor.contains(node)) return null;

    const textNode = node as Text;
    const text = textNode.textContent || '';
    const caret = range.startOffset;

    // Walk back from caret, collecting word chars, until we hit trigger or invalid
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@' || ch === '#') {
        // Must be at start-of-node or preceded by whitespace
        const prev = i === 0 ? ' ' : text[i - 1];
        if (!/\s/.test(prev)) return null;
        return {
          char: ch as '@' | '#',
          startOffset: i,
          node: textNode,
          query: text.slice(i + 1, caret),
        };
      }
      // Allow typical search chars including `/` and space for # (paths); for @ only word chars
      if (ch === '\n') return null;
      i--;
    }
    return null;
  }

  // ─── Popover / suggestions ───

  private openPopover(trigger: Trigger): void {
    this.suggestionItems = this.getSuggestions(trigger);
    this.suggestionIndex = 0;

    if (!this.popover) {
      this.popover = document.body.createDiv({ cls: 'vw-popover vw-chat-popover' });
    }
    this.popover.empty();
    this.renderSuggestions();
    this.positionPopover();
  }

  private getSuggestions(trigger: Trigger): Array<Member | DocRefEntry> {
    if (trigger.char === '@') {
      const q = trigger.query.toLowerCase();
      const members = this.opts.getMembers();
      return members.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q)
      ).slice(0, 8);
    } else {
      if (!this.docRefsCache) this.docRefsCache = listDocRefs(this.opts.app);
      return filterDocRefs(this.docRefsCache, trigger.query, 10);
    }
  }

  private renderSuggestions(): void {
    if (!this.popover) return;
    this.popover.empty();
    if (this.suggestionItems.length === 0) {
      this.popover.createDiv({ cls: 'vw-chat-suggest-empty', text: 'No matches' });
      return;
    }
    this.suggestionItems.forEach((item, idx) => {
      const row = this.popover!.createDiv({
        cls: `vw-chat-suggest-row ${idx === this.suggestionIndex ? 'is-active' : ''}`,
      });
      if (this.activeTrigger?.char === '@') {
        const m = item as Member;
        row.createSpan({ text: m.displayName, cls: 'vw-chat-suggest-primary' });
        row.createSpan({ text: `@${m.id}`, cls: 'vw-chat-suggest-secondary' });
      } else {
        const e = item as DocRefEntry;
        row.createSpan({
          text: e.kind === 'folder' ? '📁' : '📄',
          cls: 'vw-chat-suggest-icon',
        });
        row.createSpan({ text: e.label, cls: 'vw-chat-suggest-primary' });
        row.createSpan({ text: e.path, cls: 'vw-chat-suggest-secondary' });
      }
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus on editor
        this.selectSuggestion(idx);
      });
    });
  }

  private positionPopover(): void {
    if (!this.popover) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const popRect = this.popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8));
    // Place above the caret when there's room, else below
    const fitsAbove = rect.top - popRect.height - 6 > 8;
    const top = fitsAbove ? rect.top - popRect.height - 6 : rect.bottom + 6;
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  private closePopover(): void {
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
    this.activeTrigger = null;
    this.suggestionItems = [];
  }

  private selectSuggestion(idx: number): void {
    const trigger = this.activeTrigger;
    const item = this.suggestionItems[idx];
    if (!trigger || !item) return;

    const textNode = trigger.node;
    const fullText = textNode.textContent || '';
    const beforeTrigger = fullText.slice(0, trigger.startOffset);
    const afterQuery = fullText.slice(trigger.startOffset + 1 + trigger.query.length);

    // Split the text node: keep `beforeTrigger`, insert chip, then `afterQuery`
    const chip = this.createChip(trigger.char, item);
    const parent = textNode.parentNode;
    if (!parent) return;

    const beforeNode = document.createTextNode(beforeTrigger);
    const spaceNode = document.createTextNode('\u00A0');
    const afterNode = document.createTextNode(afterQuery);

    parent.insertBefore(beforeNode, textNode);
    parent.insertBefore(chip, textNode);
    parent.insertBefore(spaceNode, textNode);
    parent.insertBefore(afterNode, textNode);
    parent.removeChild(textNode);

    // Move caret to after the space
    const range = document.createRange();
    range.setStart(spaceNode, spaceNode.textContent!.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    this.closePopover();
  }

  private createChip(char: '@' | '#', item: Member | DocRefEntry): HTMLSpanElement {
    const chip = document.createElement('span');
    chip.setAttr('contenteditable', 'false');
    if (char === '@') {
      const m = item as Member;
      chip.className = 'vw-chat-chip vw-chat-chip-mention';
      chip.setAttr('data-member-id', m.id);
      chip.textContent = `@${m.displayName}`;
    } else {
      const e = item as DocRefEntry;
      chip.className = `vw-chat-chip vw-chat-chip-ref is-${e.kind}`;
      chip.setAttr('data-path', e.path);
      chip.setAttr('title', e.path);
      chip.textContent = `${e.kind === 'folder' ? '📁' : '📄'} ${e.label}`;
    }
    return chip;
  }

  // ─── Keyboard ───

  private handleKeydown(e: KeyboardEvent): void {
    if (this.activeTrigger && this.popover) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.suggestionIndex = (this.suggestionIndex + 1) % Math.max(1, this.suggestionItems.length);
        this.renderSuggestions();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.suggestionIndex = (this.suggestionIndex - 1 + this.suggestionItems.length) % Math.max(1, this.suggestionItems.length);
        this.renderSuggestions();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (this.suggestionItems.length > 0) {
          e.preventDefault();
          this.selectSuggestion(this.suggestionIndex);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closePopover();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.submit();
    }
  }
}
