// Injection seams shared by the local-auth detectors (plan 2.9, 2.14): no detector touches the real home,
// Keychain or a binary except through these.
import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';

export type RunCommand = (
  file: string,
  args: string[],
  opts: { env: Record<string, string>; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DetectorDeps {
  runCommand: RunCommand;
  /** Reads a text file (capped); rejects when missing. Never used for writes. */
  readFile: (path: string, maxBytes: number) => Promise<string>;
  homedir: () => string;
  now: () => number;
}

export const execRunCommand: RunCommand = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

export const fsReadCapped = async (path: string, maxBytes: number): Promise<string> => {
  const text = await fsReadFile(path, 'utf8');
  if (Buffer.byteLength(text) > maxBytes) throw new Error('file-too-large');
  return text;
};

export function defaultDetectorDeps(): DetectorDeps {
  return { runCommand: execRunCommand, readFile: fsReadCapped, homedir, now: Date.now };
}

export function baseInfo(
  agent: 'claude-code' | 'codex' | 'hermes',
  source: string,
  now: number,
): import('../../../shared/types').LocalAuthInfo {
  return {
    agent,
    state: 'error',
    method: null,
    email: null,
    plan: null,
    provider: null,
    source,
    version: null,
    detail: null,
    checkedAt: now,
  };
}
