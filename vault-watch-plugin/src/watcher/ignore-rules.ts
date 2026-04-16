import type { VaultWatchSettings } from '../types';

export class IgnoreRules {
  private patterns: string[];

  constructor(private settings: VaultWatchSettings) {
    this.patterns = [...settings.ignorePaths];
  }

  updatePatterns(paths: string[]): void {
    this.patterns = paths;
  }

  shouldIgnore(filePath: string): boolean {
    // Only watch markdown files
    if (!filePath.endsWith('.md')) return true;

    for (const pattern of this.patterns) {
      if (pattern.endsWith('/')) {
        // Directory pattern
        if (filePath.startsWith(pattern) || filePath.includes('/' + pattern)) {
          return true;
        }
      } else if (pattern.startsWith('*.')) {
        // Extension pattern
        if (filePath.endsWith(pattern.slice(1))) {
          return true;
        }
      } else {
        // Exact prefix or contains
        if (filePath.startsWith(pattern) || filePath === pattern) {
          return true;
        }
      }
    }

    // If watchPath is set, only watch files under it
    if (this.settings.watchPath && !filePath.startsWith(this.settings.watchPath)) {
      return true;
    }

    return false;
  }
}
