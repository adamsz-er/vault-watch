import { App, TFile, TFolder } from 'obsidian';

export interface DocRefEntry {
  path: string;
  label: string;       // basename or folder name
  kind: 'file' | 'folder';
}

/**
 * Enumerate markdown files and folders in the vault, excluding plugin storage.
 * Returns a flat list suitable for fuzzy-filtering in a picker.
 */
export function listDocRefs(app: App): DocRefEntry[] {
  const entries: DocRefEntry[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (shouldIgnore(file.path)) continue;
    entries.push({ path: file.path, label: file.basename, kind: 'file' });
  }

  const walk = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        if (!shouldIgnore(child.path)) {
          entries.push({ path: child.path, label: child.name, kind: 'folder' });
        }
        walk(child);
      }
    }
  };
  walk(app.vault.getRoot());

  return entries;
}

function shouldIgnore(path: string): boolean {
  return path.startsWith('Z_Meta/vault-watch/')
      || path.startsWith('.obsidian/')
      || path.startsWith('.trash/');
}

/**
 * Score-and-filter entries against a query. Case-insensitive. Higher score = better match.
 * Scoring: prefix on label (100) > substring on label (50) > substring on path (10).
 */
export function filterDocRefs(entries: DocRefEntry[], query: string, limit = 12): DocRefEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return entries.slice(0, limit);

  const scored: { e: DocRefEntry; score: number }[] = [];
  for (const e of entries) {
    const label = e.label.toLowerCase();
    const path = e.path.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 100 - label.length * 0.1;
    else if (label.includes(q)) score = 50 - label.length * 0.1;
    else if (path.includes(q)) score = 10;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.e);
}
