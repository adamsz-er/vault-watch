import type { Member } from '../types';

export class MentionParser {
  constructor(private getMembers: () => Member[]) {}

  /**
   * Parse @mentions from content, returning matched member IDs.
   */
  parseMentions(content: string): string[] {
    const members = this.getMembers();
    const mentionRe = /@(\w+)/g;
    const mentioned: string[] = [];
    let match;

    while ((match = mentionRe.exec(content)) !== null) {
      const name = match[1].toLowerCase();
      const member = members.find(
        m => m.id.toLowerCase() === name || m.displayName.toLowerCase() === name
      );
      if (member && !mentioned.includes(member.id)) {
        mentioned.push(member.id);
      }
    }

    return mentioned;
  }
}
