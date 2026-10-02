// The codex-acp compile must never autoload `.env` / `bunfig.toml` from its cwd (a repository opened in deltax).
// Canaries are compiled with the pinned bun on every run; the real build/bin/codex-acp is made by `pretest`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUN,
  checkNoAutoload,
  COMPILE_FLAGS,
  compileArgs,
  OUT,
  sha256File,
  STAMP,
  stampKey,
  stampMatches,
  TARGET,
} from '../../scripts/build-codex-acp.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hopecode-bun-canary-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Like codex-acp: `--version` prints, `cli` runs $CODEX_PATH. */
function canary(name: string, flags: 'hardened' | 'bun-defaults'): string {
  const entry = join(dir, `${name}.mjs`);
  const out = join(dir, name);
  writeFileSync(
    entry,
    [
      "import { spawnSync } from 'node:child_process';",
      "if (process.argv.includes('cli') && process.env.CODEX_PATH) process.stdout.write(spawnSync(process.env.CODEX_PATH, { encoding: 'utf8' }).stdout ?? '');",
      "else console.log('canary 0.0.0');",
      '',
    ].join('\n'),
  );
  const args = flags === 'hardened' ? compileArgs(entry, out) : ['build', entry, '--compile', `--target=${TARGET}`, '--outfile', out];
  execFileSync(BUN, args, { cwd: dir, stdio: 'ignore' });
  return out;
}

describe('build-codex-acp', () => {
  it('compiles with every cwd autoload turned off', () => {
    const args = compileArgs('/e.js', '/o');
    for (const flag of ['--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json']) {
      expect(args).toContain(flag);
      expect(COMPILE_FLAGS).toContain(flag);
    }
  });

  it('the autoload check flags a bun binary built with defaults and passes the hardened one', { timeout: 120_000 }, () => {
    const vulnerable = checkNoAutoload(canary('defaults', 'bun-defaults'));
    expect(vulnerable.ok).toBe(false);
    expect(vulnerable.loaded).toEqual(['HOPECODE_BUNFIG_AUTOLOADED', 'HOPECODE_DOTENV_AUTOLOADED']);
    const hardened = checkNoAutoload(canary('hardened', 'hardened'));
    expect(hardened.loaded).toEqual([]);
    expect(hardened.ok).toBe(true);
    expect(hardened.output).toContain('canary 0.0.0');
  });

  it('build/bin/codex-acp does not autoload cwd config and matches its stamp', { timeout: 60_000 }, () => {
    const res = checkNoAutoload(OUT);
    expect(res.loaded).toEqual([]);
    expect(res.output).toContain('@agentclientprotocol/codex-acp');
    const [key] = readFileSync(STAMP, 'utf8').split('\n');
    expect(key).toContain(`flags=${COMPILE_FLAGS.join(',')}`);
    expect(stampMatches(readFileSync(STAMP, 'utf8'), key!, sha256File(OUT))).toBe(true);
  });

  it('a stamp is reused only with the same key and the same output sha256', () => {
    const key = stampKey('@agentclientprotocol/codex-acp', '2.1.0', '1.4.2');
    expect(stampMatches(`${key}\nsha256=abc\n`, key, 'abc')).toBe(true);
    expect(stampMatches(`${key}\nsha256=abc\n`, key, 'def')).toBe(false);
    expect(stampMatches(`${key}\n`, key, 'abc')).toBe(false);
    // The pre-hardening stamp (no flags, no sha) never matches.
    expect(stampMatches('@agentclientprotocol/codex-acp@2.1.0 bun@1.4.2 bun-darwin-arm64\n', key, 'abc')).toBe(false);
  });
});
