import { Vault, TFile, TFolder } from 'obsidian';
import type { MemberRegistry, Member, PublicKeyBundle } from '../types';
import { MEMBERS_FILE, KEYS_DIR, VAULT_WATCH_DIR, INBOX_DIR, OUTBOX_DIR } from '../types';
import { serializePublicKeys, deserializePublicKeys } from '../crypto/keys';

export class MemberRegistryManager {
  private registry: MemberRegistry = { v: 1, members: [] };

  constructor(private vault: Vault) {}

  getMembers(): Member[] {
    return this.registry.members;
  }

  getMember(id: string): Member | undefined {
    return this.registry.members.find(m => m.id === id);
  }

  async initialize(): Promise<void> {
    await this.ensureDirectoryStructure();
    await this.loadRegistry();
  }

  async loadRegistry(): Promise<void> {
    const file = this.vault.getAbstractFileByPath(MEMBERS_FILE);
    if (file instanceof TFile) {
      try {
        const content = await this.vault.read(file);
        this.registry = JSON.parse(content) as MemberRegistry;
      } catch {
        console.warn('[vault-watch] Could not parse members.json, starting fresh');
        this.registry = { v: 1, members: [] };
      }
    }
  }

  async registerMember(member: Member, pubKeys: PublicKeyBundle): Promise<void> {
    // Remove existing entry if re-registering
    this.registry.members = this.registry.members.filter(m => m.id !== member.id);
    this.registry.members.push(member);

    await this.saveRegistry();
    await this.publishPublicKeys(pubKeys);
    await this.ensureMemberInbox(member.id);
  }

  async updateMember(id: string, updates: Partial<Member>): Promise<void> {
    const member = this.getMember(id);
    if (!member) throw new Error(`Member ${id} not found`);

    Object.assign(member, updates);
    await this.saveRegistry();
  }

  async loadPublicKeys(memberId: string): Promise<PublicKeyBundle | null> {
    const path = `${KEYS_DIR}/${memberId}.pub`;
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        const content = await this.vault.read(file);
        return deserializePublicKeys(content);
      } catch {
        return null;
      }
    }
    return null;
  }

  async getAllPublicKeys(): Promise<Map<string, PublicKeyBundle>> {
    const keys = new Map<string, PublicKeyBundle>();
    const folder = this.vault.getAbstractFileByPath(KEYS_DIR);

    if (folder instanceof TFolder) {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'pub') {
          try {
            const content = await this.vault.read(child);
            const bundle = deserializePublicKeys(content);
            keys.set(bundle.memberId, bundle);
          } catch {
            // Skip corrupted key files
          }
        }
      }
    }

    return keys;
  }

  private async saveRegistry(): Promise<void> {
    const content = JSON.stringify(this.registry, null, 2);
    const file = this.vault.getAbstractFileByPath(MEMBERS_FILE);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(MEMBERS_FILE, content);
    }
  }

  private async publishPublicKeys(bundle: PublicKeyBundle): Promise<void> {
    const path = `${KEYS_DIR}/${bundle.memberId}.pub`;
    const content = serializePublicKeys(bundle);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private async ensureMemberInbox(memberId: string): Promise<void> {
    const inboxPath = `${INBOX_DIR}/${memberId}`;
    const folder = this.vault.getAbstractFileByPath(inboxPath);
    if (!folder) {
      // Create a placeholder to ensure the directory exists
      await this.vault.create(`${inboxPath}/.gitkeep`, '');
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    const dirs = [VAULT_WATCH_DIR, KEYS_DIR, OUTBOX_DIR, INBOX_DIR];

    for (const dir of dirs) {
      const folder = this.vault.getAbstractFileByPath(dir);
      if (!folder) {
        // Create directories by creating a placeholder file
        // (Obsidian auto-creates parent directories)
        try {
          await this.vault.create(`${dir}/.gitkeep`, '');
        } catch {
          // Directory may already exist from another create
        }
      }
    }
  }
}
