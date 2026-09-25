// Copy a session transcript between account config dirs before resume (plan 4.2 session/transcriptSync.ts).
// The cwd encoding of `projects/<encoded-cwd>/` is not re-implemented: the source is found by
// globbing `<from>/projects/*/<sid>.jsonl` and the same relative path is used under `<to>`.
import { cp, copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface TranscriptSyncResult {
  /** false when no `<sid>.jsonl` exists under the source config dir (caller starts a new session). */
  found: boolean;
  /** Relative paths (under projects/) that were copied. */
  copied: string[];
}

export type SyncTranscriptFn = (
  sessionId: string,
  fromConfigDir: string,
  toConfigDir: string,
) => Promise<TranscriptSyncResult>;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export const syncTranscript: SyncTranscriptFn = async (sessionId, fromConfigDir, toConfigDir) => {
  const fromProjects = join(fromConfigDir, 'projects');
  const toProjects = join(toConfigDir, 'projects');
  const copied: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(fromProjects);
  } catch {
    return { found: false, copied };
  }

  for (const dir of projectDirs) {
    const srcFile = join(fromProjects, dir, `${sessionId}.jsonl`);
    if (!(await isFile(srcFile))) continue;

    const destDir = join(toProjects, dir);
    await mkdir(destDir, { recursive: true });
    const destFile = join(destDir, `${sessionId}.jsonl`);
    const tmp = `${destFile}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(srcFile, tmp);
    await rename(tmp, destFile);
    copied.push(join(dir, `${sessionId}.jsonl`));

    const srcSidDir = join(fromProjects, dir, sessionId);
    if (await isDirectory(srcSidDir)) {
      await cp(srcSidDir, join(destDir, sessionId), { recursive: true, force: true });
      copied.push(join(dir, sessionId));
    }
  }

  return { found: copied.length > 0, copied };
};
