// GUI apps do not inherit the user's login shell PATH, so we capture it once at startup
// (plan 4.2 shellEnv.ts). `childEnv()` is the ONLY entry point SDK Query / pty / login / auth
// status may use — it always goes through core/childEnv.buildChildEnv.
import { execFile } from 'node:child_process';
import { buildChildEnv } from '../core/childEnv';
import { FALLBACK_PATH_ENTRIES, SHELL_ENV_TIMEOUT_MS } from '../shared/constants';
import type { ChildEnvInject } from '../shared/types';
import type { ShellEnv } from './contracts';

function toStringRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function fallbackEnv(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const base = toStringRecord(processEnv);
  const home = base['HOME'] ?? '';
  const existing = base['PATH'] ? base['PATH'].split(':') : [];
  for (const raw of FALLBACK_PATH_ENTRIES) {
    const entry = raw.startsWith('~') ? home + raw.slice(1) : raw;
    if (entry && !existing.includes(entry)) existing.push(entry);
  }
  base['PATH'] = existing.join(':');
  return base;
}

function parseEnvNulls(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of raw.split('\u0000')) {
    if (!entry) continue;
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    result[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return result;
}

function captureLoginShellEnv(processEnv: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const shell = processEnv['SHELL'] ?? '/bin/zsh';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', 'env -0'],
      { timeout: SHELL_ENV_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(fallbackEnv(processEnv));
          return;
        }
        const parsed = parseEnvNulls(stdout.toString());
        resolve(parsed['PATH'] ? parsed : fallbackEnv(processEnv));
      },
    );
  });
}

/** `createShellEnv()` captures the login shell env lazily via `init()`. */
export function createShellEnv(processEnv: NodeJS.ProcessEnv = process.env): ShellEnv {
  let cached: Record<string, string> | null = null;

  const shellEnv: ShellEnv = {
    async init() {
      cached = await captureLoginShellEnv(processEnv);
    },
    baseEnv() {
      return cached ?? fallbackEnv(processEnv);
    },
    childEnv(inject: ChildEnvInject) {
      return buildChildEnv(shellEnv.baseEnv(), inject);
    },
  };

  return shellEnv;
}
