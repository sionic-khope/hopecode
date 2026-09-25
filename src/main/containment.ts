import { isAbsolute, relative, resolve } from 'node:path';

/** true when `child` resolves strictly below `parent` (never equal, never via `..`). */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Guard before recursive deletes (L5): throws unless `child` is inside `parent`. */
export function assertInside(parent: string, child: string, what: string): void {
  if (!isStrictlyInside(parent, child)) throw new Error(`refusing to delete ${what} outside ${parent}: ${child}`);
}
