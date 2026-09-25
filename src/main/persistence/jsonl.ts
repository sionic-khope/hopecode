// Small JSONL append/read/compact utility shared by threadLog.ts and usageHistory.ts.
// Not part of contracts.ts (internal to the persistence lane); append is a raw fs append
// (fast path), compact rewrites the file atomically (tmp + rename) to drop old entries.
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Chat logs / usage history are private to the user (L7). */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

export async function mkdirPrivate(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Startup repair (best-effort, errors ignored) for data written before the private modes existed:
 * `dataDir` and each `subdirs` entry -> 0700, `state.json*` in dataDir and `*.jsonl` in the subdirs -> 0600.
 */
export async function restrictPrivateModes(dataDir: string, subdirs: readonly string[]): Promise<void> {
  const quiet = (path: string, mode: number) => chmod(path, mode).catch(() => {});
  const list = (dir: string) => readdir(dir).catch((): string[] => []);
  await quiet(dataDir, PRIVATE_DIR_MODE);
  for (const name of await list(dataDir)) {
    if (name === 'state.json' || name.startsWith('state.json.')) await quiet(join(dataDir, name), PRIVATE_FILE_MODE);
  }
  for (const sub of subdirs) {
    const dir = join(dataDir, sub);
    await quiet(dir, PRIVATE_DIR_MODE);
    for (const name of await list(dir)) {
      if (name.endsWith('.jsonl')) await quiet(join(dir, name), PRIVATE_FILE_MODE);
    }
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await mkdirPrivate(dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
}

export async function readAllJsonl<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip a corrupt/partial trailing line rather than failing the whole read
    }
  }
  return out;
}

export async function writeJsonlAtomic<T>(filePath: string, values: readonly T[]): Promise<void> {
  await mkdirPrivate(dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const content = values.map((v) => JSON.stringify(v)).join('\n') + (values.length ? '\n' : '');
  await writeFile(tmp, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await rename(tmp, filePath);
}

export async function compactJsonl<T>(filePath: string, keep: (value: T) => boolean): Promise<void> {
  const all = await readAllJsonl<T>(filePath);
  const kept = all.filter(keep);
  if (kept.length === all.length) return;
  await writeJsonlAtomic(filePath, kept);
}
