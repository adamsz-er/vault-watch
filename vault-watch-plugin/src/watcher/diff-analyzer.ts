import type { ChangeAnalysis, ChangeClassification } from '../types';

interface DiffLine {
  type: 'add' | 'remove' | 'same';
  content: string;
}

export class DiffAnalyzer {
  // CRDT sync artifacts to filter out
  private static readonly SYNC_PATTERNS = [
    /^<!-- relay-merge/,
    /^<!-- crdt-/,
    /^%%conflict%%/,
    /^> \[!sync\]/,
  ];

  analyze(oldContent: string, newContent: string): ChangeAnalysis {
    if (oldContent === newContent) {
      return this.trivial('No changes detected');
    }

    const diff = this.computeLineDiff(oldContent, newContent);
    const addedLines = diff.filter(d => d.type === 'add').map(d => d.content);
    const removedLines = diff.filter(d => d.type === 'remove').map(d => d.content);

    // Check for sync artifacts first
    if (this.isSyncArtifact(addedLines, removedLines)) {
      return {
        changeType: 'sync_artifact',
        summary: 'CRDT sync merge',
        affectedHeadings: [],
        charDelta: 0,
        isSignificant: false,
        mentionedMembers: [],
        addedTags: [],
      };
    }

    // Calculate char delta
    const charDelta = newContent.length - oldContent.length;

    // Check for trivial changes (whitespace/formatting only)
    if (this.isTrivial(addedLines, removedLines, charDelta)) {
      return this.trivial('Whitespace or formatting changes');
    }

    // Extract mentions from added content
    const mentionedMembers = this.extractMentions(addedLines);

    // Extract tags from body + frontmatter
    const inlineTags = this.extractInlineTags(addedLines, removedLines);
    const frontmatterTags = this.extractFrontmatterTags(oldContent, newContent);
    const addedTags = [...new Set([...inlineTags, ...frontmatterTags])];

    // Determine classification
    const classification = this.classify(addedLines, removedLines, mentionedMembers, addedTags);

    // Get affected headings for context
    const affectedHeadings = this.findAffectedHeadings(oldContent, newContent, diff);

    // Build summary
    const summary = this.buildSummary(classification, addedLines, removedLines, affectedHeadings);

    // Get excerpt of added content
    const addedText = addedLines.filter(l => l.trim().length > 0).join('\n');
    const addedExcerpt = addedText.length > 200 ? addedText.slice(0, 200) + '...' : addedText;

    return {
      changeType: classification,
      summary,
      affectedHeadings,
      charDelta,
      addedExcerpt: addedExcerpt || undefined,
      isSignificant: true,
      mentionedMembers,
      addedTags,
    };
  }

  private classify(
    added: string[],
    removed: string[],
    mentions: string[],
    tags: string[]
  ): ChangeClassification {
    if (mentions.length > 0) return 'mention_added';
    if (tags.length > 0) return 'tag_added';

    const addedHeadings = added.filter(l => /^#{1,6}\s/.test(l));
    const removedHeadings = removed.filter(l => /^#{1,6}\s/.test(l));
    if (addedHeadings.length > 0 || removedHeadings.length > 0) return 'heading_changed';

    const addedTasks = added.filter(l => /^- \[[ x]\]/.test(l.trim()));
    const removedTasks = removed.filter(l => /^- \[[ x]\]/.test(l.trim()));
    if (addedTasks.length > 0 && removedTasks.length > 0) return 'task_toggled';

    if (added.length > 0 && removed.length === 0) return 'content_added';
    if (removed.length > 0 && added.length === 0) return 'content_removed';
    if (added.length > 0) return 'content_added';

    return 'trivial';
  }

  private buildSummary(
    classification: ChangeClassification,
    added: string[],
    removed: string[],
    headings: string[]
  ): string {
    const headingContext = headings.length > 0
      ? ` under "${headings[0]}"`
      : '';

    const nonEmptyAdded = added.filter(l => l.trim().length > 0);
    const nonEmptyRemoved = removed.filter(l => l.trim().length > 0);

    switch (classification) {
      case 'content_added':
        return `Added ${nonEmptyAdded.length} line${nonEmptyAdded.length !== 1 ? 's' : ''}${headingContext}`;
      case 'content_removed':
        return `Removed ${nonEmptyRemoved.length} line${nonEmptyRemoved.length !== 1 ? 's' : ''}${headingContext}`;
      case 'heading_changed':
        return `Changed heading${headingContext}`;
      case 'task_toggled':
        return `Toggled task${headingContext}`;
      case 'mention_added':
        return `Added mention${headingContext}`;
      case 'tag_added':
        return `Added tag${headingContext}`;
      default:
        return `Modified${headingContext}`;
    }
  }

  private extractMentions(lines: string[]): string[] {
    const mentions: string[] = [];
    const mentionRe = /@(\w+)/g;
    for (const line of lines) {
      let match;
      while ((match = mentionRe.exec(line)) !== null) {
        if (!mentions.includes(match[1])) {
          mentions.push(match[1]);
        }
      }
    }
    return mentions;
  }

  private extractInlineTags(addedLines: string[], removedLines: string[]): string[] {
    const getTags = (lines: string[]) => {
      const tags: string[] = [];
      const tagRe = /#(\w[\w/-]*)/g;
      for (const line of lines) {
        // Skip headings (lines starting with #)
        if (/^#{1,6}\s/.test(line)) continue;
        let match;
        while ((match = tagRe.exec(line)) !== null) {
          tags.push(match[1]);
        }
      }
      return tags;
    };

    const added = getTags(addedLines);
    const removed = getTags(removedLines);
    return added.filter(t => !removed.includes(t));
  }

  /**
   * Parse frontmatter tags and return newly added ones.
   * Handles both formats:
   *   tags: [urgent, review]
   *   tags:
   *     - urgent
   *     - review
   */
  private extractFrontmatterTags(oldContent: string, newContent: string): string[] {
    const oldTags = this.parseFrontmatterTags(oldContent);
    const newTags = this.parseFrontmatterTags(newContent);
    return newTags.filter(t => !oldTags.includes(t));
  }

  private parseFrontmatterTags(content: string): string[] {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return [];

    const fm = fmMatch[1];

    // Inline array: tags: [foo, bar] or tags: [foo, "bar baz"]
    const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      return inlineMatch[1]
        .split(',')
        .map(t => t.trim().replace(/^["']|["']$/g, ''))
        .filter(t => t.length > 0);
    }

    // List format:
    // tags:
    //   - foo
    //   - bar
    const listMatch = fm.match(/^tags:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (listMatch) {
      return listMatch[1]
        .split('\n')
        .map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
        .filter(t => t.length > 0);
    }

    // Single value: tags: urgent
    const singleMatch = fm.match(/^tags:\s+(\S+)/m);
    if (singleMatch) {
      return [singleMatch[1].replace(/^["']|["']$/g, '')];
    }

    return [];
  }

  private findAffectedHeadings(
    oldContent: string,
    newContent: string,
    diff: DiffLine[]
  ): string[] {
    // Find all headings in new content
    const headings: { level: number; text: string; lineIdx: number }[] = [];
    const newLines = newContent.split('\n');
    for (let i = 0; i < newLines.length; i++) {
      const match = newLines[i].match(/^(#{1,6})\s+(.+)/);
      if (match) {
        headings.push({ level: match[1].length, text: match[2].trim(), lineIdx: i });
      }
    }

    // Find which lines changed
    const changedLineIndices: number[] = [];
    let newLineIdx = 0;
    for (const d of diff) {
      if (d.type === 'add') {
        changedLineIndices.push(newLineIdx);
        newLineIdx++;
      } else if (d.type === 'same') {
        newLineIdx++;
      }
      // 'remove' lines don't exist in new content
    }

    // Map changed lines to their nearest preceding heading
    const affected = new Set<string>();
    for (const lineIdx of changedLineIndices) {
      let nearestHeading = '';
      for (const h of headings) {
        if (h.lineIdx <= lineIdx) {
          nearestHeading = h.text;
        }
      }
      if (nearestHeading) affected.add(nearestHeading);
    }

    return Array.from(affected);
  }

  private isSyncArtifact(added: string[], removed: string[]): boolean {
    const allLines = [...added, ...removed];
    if (allLines.length === 0) return false;

    return allLines.every(line =>
      DiffAnalyzer.SYNC_PATTERNS.some(p => p.test(line)) ||
      line.trim().length === 0
    );
  }

  private isTrivial(added: string[], removed: string[], charDelta: number): boolean {
    if (Math.abs(charDelta) < 10) {
      // Small change -- check if it's only whitespace
      const addedContent = added.map(l => l.replace(/\s/g, '')).join('');
      const removedContent = removed.map(l => l.replace(/\s/g, '')).join('');
      if (addedContent === removedContent) return true;
    }
    return false;
  }

  private trivial(summary: string): ChangeAnalysis {
    return {
      changeType: 'trivial',
      summary,
      affectedHeadings: [],
      charDelta: 0,
      isSignificant: false,
      mentionedMembers: [],
      addedTags: [],
    };
  }

  /**
   * Simple line-level diff using LCS (Myers-like).
   * Returns a list of add/remove/same operations.
   */
  computeLineDiff(oldText: string, newText: string): DiffLine[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Simple LCS-based diff
    const lcs = this.lcs(oldLines, newLines);
    const result: DiffLine[] = [];

    let oi = 0;
    let ni = 0;
    let li = 0;

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi < oldLines.length && ni < newLines.length &&
          oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
        result.push({ type: 'same', content: oldLines[oi] });
        oi++; ni++; li++;
      } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        result.push({ type: 'remove', content: oldLines[oi] });
        oi++;
      } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        result.push({ type: 'add', content: newLines[ni] });
        ni++;
      }
    }

    return result;
  }

  private lcs(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;

    // For very large files, skip detailed diff
    if (m > 5000 || n > 5000) {
      return [];
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find LCS
    const result: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--; j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return result;
  }
}
