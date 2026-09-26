// Pure `git diff` (unified format) parser -> per-file structured hunks for the changes panel DiffView.
// Hunk lines keep their leading marker (' ', '+', '-', '\'), matching StructuredPatchHunk / diffLines.ts.
import type { StructuredPatchHunk } from '../../shared/types';

export interface ParsedFileDiff {
  /** New path (old path for a deleted file). */
  path: string;
  /** Previous path of a rename. */
  oldPath?: string;
  binary: boolean;
  hunks: StructuredPatchHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decode git's C-style quoted path (`"a/t\303\251st"`); unquoted input is returned unchanged. */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next !== undefined && next in escapes) {
      bytes.push(escapes[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Strip the `a/` / `b/` prefix from a `---` / `+++` path; null for /dev/null. */
function stripPrefix(raw: string): string | null {
  // `--- a/path\t` may carry a trailing tab when the name contains spaces.
  const value = unquote(raw.replace(/\t$/, ''));
  if (value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
}

/** Paths from `diff --git a/X b/Y` (used only when no ---/+++ lines follow, e.g. binary or pure rename). */
function headerPaths(rest: string): { a: string; b: string } | null {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(rest);
    if (!m) return null;
    return { a: unquote(m[1]).replace(/^a\//, ''), b: unquote(m[2]).replace(/^b\//, '') };
  }
  // Same name on both sides (the common case): "a/<p> b/<p>" has length 2*len(p)+5.
  if ((rest.length - 5) % 2 === 0) {
    const len = (rest.length - 5) / 2;
    const a = rest.slice(2, 2 + len);
    if (rest.startsWith('a/') && rest.slice(2 + len) === ` b/${a}`) return { a, b: a };
  }
  const split = rest.lastIndexOf(' b/');
  if (split < 0) return null;
  return { a: rest.slice(0, split).replace(/^a\//, ''), b: unquote(rest.slice(split + 1)).replace(/^b\//, '') };
}

export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = text.split('\n');
  let current: (ParsedFileDiff & { fromPath: string | null; toPath: string | null; renameFrom?: string; renameTo?: string }) | null =
    null;
  let hunk: StructuredPatchHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const finish = (): void => {
    if (!current) return;
    const path = current.renameTo ?? current.toPath ?? current.fromPath ?? current.path;
    const oldPath = current.renameFrom ?? (current.fromPath && current.toPath && current.fromPath !== current.toPath ? current.fromPath : undefined);
    const file: ParsedFileDiff = { path, binary: current.binary, hunks: current.hunks };
    if (oldPath !== undefined && oldPath !== path) file.oldPath = oldPath;
    files.push(file);
    current = null;
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finish();
      const paths = headerPaths(line.slice('diff --git '.length));
      current = {
        path: paths?.b ?? '',
        binary: false,
        hunks: [],
        fromPath: paths?.a ?? null,
        toPath: paths?.b ?? null,
      };
      continue;
    }
    if (!current) continue;

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      if (marker === '+') {
        hunk.lines.push(line);
        newLeft -= 1;
        continue;
      }
      if (marker === '-') {
        hunk.lines.push(line);
        oldLeft -= 1;
        continue;
      }
      if (marker === ' ' || line === '') {
        // An empty line only shows up here when a tool stripped the trailing space of an empty context line.
        hunk.lines.push(line === '' ? ' ' : line);
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (marker === '\\') {
        hunk.lines.push(line);
        continue;
      }
    }
    if (hunk && line.startsWith('\\')) {
      // "\ No newline at end of file" after the last counted line.
      hunk.lines.push(line);
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      current.hunks.push(hunk);
      continue;
    }
    if (hunk) continue;

    if (line.startsWith('--- ')) current.fromPath = stripPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) current.toPath = stripPrefix(line.slice(4));
    else if (line.startsWith('rename from ')) current.renameFrom = unquote(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) current.renameTo = unquote(line.slice('rename to '.length));
    else if (line.startsWith('new file mode')) current.fromPath = null;
    else if (line.startsWith('deleted file mode')) current.toPath = null;
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true;
  }
  finish();
  return files;
}
