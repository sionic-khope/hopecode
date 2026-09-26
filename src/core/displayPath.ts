/** Shortens an absolute path for display: relative to `cwd` when inside it, `~/…` when inside `home`. */
export function displayPath(path: string, cwd?: string | null, home?: string | null): string {
  const inside = (root: string | null | undefined): string | null => {
    if (!root) return null;
    const base = root.endsWith('/') ? root.slice(0, -1) : root;
    if (path === base) return '';
    return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
  };
  const rel = inside(cwd);
  if (rel !== null) return rel === '' ? '.' : rel;
  const fromHome = inside(home);
  if (fromHome !== null) return fromHome === '' ? '~' : `~/${fromHome}`;
  return path;
}
