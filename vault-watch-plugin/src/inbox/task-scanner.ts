import { App, TFile, TFolder } from 'obsidian';
import type {
  InboxTask,
  InboxTaskLane,
  InboxTasksSettings,
  Member,
  Priority,
  VaultWatchSettings,
} from '../types';

const TASK_EXTENSIONS = new Set(['md', 'canvas']);

/**
 * Scans configured inbox roots and exposes the result as InboxTask[].
 * Re-scans on vault events inside a configured root (debounced).
 */
export class TaskScanner {
  private tasks: InboxTask[] = [];
  private changeCallbacks: (() => void)[] = [];
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private laneCache = new Map<string, InboxTaskLane | null>();

  constructor(
    private app: App,
    private settings: VaultWatchSettings,
    private getMembers: () => Member[]
  ) {}

  getTasks(): InboxTask[] {
    return this.tasks;
  }

  /**
   * All lanes discovered across configured roots, merged, sorted by rank.
   * Useful for UI column rendering.
   */
  getLanes(): InboxTaskLane[] {
    const byName = new Map<string, InboxTaskLane>();
    for (const t of this.tasks) {
      if (t.lane && !byName.has(t.lane.name)) byName.set(t.lane.name, t.lane);
    }
    return [...byName.values()].sort((a, b) => a.rank - b.rank);
  }

  onChange(cb: () => void): void {
    this.changeCallbacks.push(cb);
  }

  offChange(cb: () => void): void {
    this.changeCallbacks = this.changeCallbacks.filter(c => c !== cb);
  }

  /** Full rescan of all configured roots. */
  async scan(): Promise<void> {
    const cfg = this.settings.inboxTasks;
    if (!cfg.enabled || cfg.roots.length === 0) {
      this.tasks = [];
      this.notifyChange();
      return;
    }

    this.laneCache.clear();
    const collected: InboxTask[] = [];
    for (const root of cfg.roots) {
      const folder = this.app.vault.getAbstractFileByPath(root);
      if (folder instanceof TFolder) {
        this.walk(folder, root, collected);
      }
    }
    this.tasks = collected;
    this.notifyChange();
  }

  /** Called from plugin.ts on vault events — reschedule a debounced rescan if path is in a root. */
  onVaultEvent(path: string, oldPath?: string): void {
    if (!this.pathInAnyRoot(path) && !(oldPath && this.pathInAnyRoot(oldPath))) return;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.scan();
    }, 250);
  }

  /** Auto-detect candidate inbox roots by fuzzy-matching common names. */
  detectCandidateRoots(): string[] {
    const candidates: string[] = [];
    const root = this.app.vault.getRoot();
    const rx = /inbox/i;
    for (const child of root.children) {
      if (child instanceof TFolder && rx.test(child.name)) {
        candidates.push(child.path);
      }
    }
    return candidates;
  }

  /** Compute the lane path for a given root+personFolder+laneName. */
  buildLanePath(root: string, personFolder: string | null, laneName: string): string {
    const parts = [root];
    if (personFolder) parts.push(personFolder);
    parts.push(laneName);
    return parts.join('/');
  }

  // ─── Internals ───

  private pathInAnyRoot(path: string): boolean {
    for (const root of this.settings.inboxTasks.roots) {
      if (path === root || path.startsWith(root + '/')) return true;
    }
    return false;
  }

  private walk(folder: TFolder, root: string, out: InboxTask[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (!TASK_EXTENSIONS.has(child.extension)) continue;
        const task = this.buildTask(child, root);
        if (task) out.push(task);
      } else if (child instanceof TFolder) {
        this.walk(child, root, out);
      }
    }
  }

  private buildTask(file: TFile, root: string): InboxTask | null {
    // Derive structural path parts relative to root.
    const rel = file.path.slice(root.length + 1); // strip "root/"
    const segments = rel.split('/');
    // segments: [...folders, filename]
    const folderSegments = segments.slice(0, -1);

    let personFolder: string | null = null;
    let assignee: string | null = null;
    let lane: InboxTaskLane | null = null;

    // Heuristic: first folder segment is the person folder (if it matches a member),
    // and any segment that matches the status pattern is the lane. We prefer the
    // deepest status segment as the lane (closest to the file).
    if (folderSegments.length > 0) {
      const first = folderSegments[0];
      const member = this.matchMember(first);
      if (member) {
        personFolder = first;
        assignee = member.id;
      }
    }

    for (let i = folderSegments.length - 1; i >= 0; i--) {
      const seg = folderSegments[i];
      const parsed = this.parseLane(seg);
      if (parsed) {
        lane = parsed;
        break;
      }
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter || {};
    const title = (typeof fm.title === 'string' && fm.title.trim()) ? fm.title.trim() : file.basename;

    let priority: Priority | undefined;
    if (fm.priority === 'high' || fm.priority === 'normal' || fm.priority === 'low') {
      priority = fm.priority;
    }

    const tags = new Set<string>();
    const fmTags = fm.tags ?? fm.tag;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) if (typeof t === 'string') tags.add(t.replace(/^#/, ''));
    } else if (typeof fmTags === 'string') {
      for (const t of fmTags.split(/[,\s]+/)) if (t) tags.add(t.replace(/^#/, ''));
    }
    if (cache?.tags) {
      for (const t of cache.tags) tags.add(t.tag.replace(/^#/, ''));
    }

    return {
      path: file.path,
      title,
      root,
      assignee,
      personFolder,
      lane,
      priority,
      tags: [...tags],
      mtime: file.stat.mtime,
      ext: file.extension,
    };
  }

  private parseLane(name: string): InboxTaskLane | null {
    if (this.laneCache.has(name)) return this.laneCache.get(name) ?? null;
    let rx: RegExp;
    try {
      rx = new RegExp(this.settings.inboxTasks.statusPattern);
    } catch {
      rx = /^(\d+)\s*-\s*(.+)$/;
    }
    const m = rx.exec(name);
    if (!m) {
      this.laneCache.set(name, null);
      return null;
    }
    const rank = parseInt(m[1], 10);
    const labelRaw = (m[2] || '').trim();
    const lane: InboxTaskLane = {
      name,
      rank: Number.isFinite(rank) ? rank : 0,
      label: labelRaw,
    };
    this.laneCache.set(name, lane);
    return lane;
  }

  private matchMember(folderName: string): Member | null {
    const cfg = this.settings.inboxTasks;
    const members = this.getMembers();
    // Explicit map wins
    for (const [memberId, folder] of Object.entries(cfg.personFolderMap)) {
      if (folder === folderName) {
        const m = members.find(x => x.id === memberId);
        if (m) return m;
      }
    }
    // Fuzzy match by id or displayName
    const lower = folderName.toLowerCase();
    return (
      members.find(m => m.id.toLowerCase() === lower) ||
      members.find(m => m.displayName.toLowerCase() === lower) ||
      members.find(m => m.displayName.toLowerCase().split(/\s+/)[0] === lower) ||
      null
    );
  }

  private notifyChange(): void {
    for (const cb of this.changeCallbacks) cb();
  }
}
