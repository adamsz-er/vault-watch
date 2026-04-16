/**
 * Match a vault-relative path against a glob pattern.
 *
 * Supported syntax (intentionally narrow — keep call sites predictable):
 *
 *   `dir/`        → matches any path inside `dir/` at the root or as a sub-path
 *   `*.ext`       → wildcard within a single segment (no `/`)
 *   `**`          → matches across segments (`/`)
 *   `?`           → matches a single character (no `/`)
 *
 * Characters that have regex meaning are escaped before substitution. If the
 * generated regex is invalid for any reason, falls back to a substring test
 * so a malformed user pattern never crashes filtering.
 *
 * @param path     The vault-relative path under test.
 * @param pattern  The glob to match against. Empty/whitespace-only returns false.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;

  if (p.endsWith('/')) {
    return path.startsWith(p) || path.includes('/' + p);
  }

  const rx = '^' + p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*')
    .replace(/\?/g, '.') + '$';

  try {
    return new RegExp(rx).test(path);
  } catch {
    return path.includes(p);
  }
}
