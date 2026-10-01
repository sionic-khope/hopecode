// HOPECODE_SMOKE Codex check against a stand-in adapter: a shell wrapper that answers `--version` and otherwise runs the
// fixture ACP agent (tests/fixtures/acp/fakeAcpAgent.mjs). No real codex-acp / codex runs, no network.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAcpSmoke, SMOKE_CODEX_CONFIG_TOML, type CodexSmokeDeps } from '../../src/main/agents/codexSmoke';
import type { CodexEngine } from '../../src/main/agents/agentBinaries';

const FAKE_AGENT = resolve(__dirname, '../fixtures/acp/fakeAcpAgent.mjs');
const ENGINE: CodexEngine = { path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', version: '0.159.2' };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Adapter stand-in; `profile` hermes makes initialize report another agent name. Records the env it got. */
function adapter(profile: 'codex' | 'hermes' = 'codex'): { bin: string; envFile: string } {
  dir = mkdtempSync(join(tmpdir(), 'hopecode-codex-smoke-'));
  const bin = join(dir, 'codex-acp');
  const envFile = join(dir, 'env.txt');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "@agentclientprotocol/codex-acp 0.0.0-fixture"; exit 0; fi',
      `env > '${envFile}'`,
      `cat "$CODEX_HOME/config.toml" > '${envFile}.config'`,
      `pwd -P > '${envFile}.cwd'`,
      `FAKE_ACP_PROFILE=${profile} exec '${process.execPath}' '${FAKE_AGENT}'`,
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { bin, envFile };
}

function run(over: Partial<CodexSmokeDeps> & { bin?: string | null; engine?: CodexEngine | null }) {
  const lines: string[] = [];
  const deps: CodexSmokeDeps = {
    binaries: { resolveCodexAcp: () => over.bin ?? null, resolveCodex: async () => (over.engine === undefined ? ENGINE : over.engine) },
    appVersion: '0.0.0-test',
    log: (line) => lines.push(line),
    error: (line) => lines.push(`ERR ${line}`),
    ...(over.requiredDir ? { requiredDir: over.requiredDir } : {}),
  };
  return { result: codexAcpSmoke(deps), lines };
}

const smokeHomes = () => readdirSync(tmpdir()).filter((n) => n.startsWith('hopecode-smoke-codex-'));

describe('codexAcpSmoke', () => {
  it('adapter --version, engine, offline initialize (read-only, temp HOME / CODEX_HOME) -> pass', async () => {
    const before = smokeHomes();
    const { bin, envFile } = adapter();
    const { result, lines } = run({ bin });
    expect(await result).toBe(true);
    expect(lines.join('\n')).toContain('version: @agentclientprotocol/codex-acp 0.0.0-fixture');
    expect(lines.join('\n')).toContain(`codex engine ok (${ENGINE.path}) codex-cli 0.159.2`);
    expect(lines.join('\n')).toContain('initialize ok (@agentclientprotocol/codex-acp');
    const env = readFileSync(envFile, 'utf8');
    expect(env).toContain(`CODEX_PATH=${ENGINE.path}`);
    expect(env).toContain('INITIAL_AGENT_MODE=read-only');
    expect(env).toMatch(/^CODEX_HOME=.*hopecode-smoke-codex-.*\/\.codex$/m);
    expect(env).not.toMatch(/^HOME=\/Users\//m);
    // Codex credential stores forced to `file` in the temp CODEX_HOME (no login Keychain lookups).
    expect(readFileSync(`${envFile}.config`, 'utf8')).toBe(SMOKE_CODEX_CONFIG_TOML);
    expect(SMOKE_CODEX_CONFIG_TOML).toContain('cli_auth_credentials_store = "file"');
    expect(SMOKE_CODEX_CONFIG_TOML).toContain('mcp_oauth_credentials_store = "file"');
    expect(readFileSync(`${envFile}.cwd`, 'utf8')).toContain('hopecode-smoke-codex-');
    // The temporary HOME is removed afterwards.
    expect(smokeHomes()).toEqual(before);
  });

  it('no Codex engine on this Mac: a warning, still a pass, no initialize', async () => {
    const { bin, envFile } = adapter();
    const { result, lines } = run({ bin, engine: null });
    expect(await result).toBe(true);
    expect(lines.some((l) => l.includes('WARN codex engine not found'))).toBe(true);
    expect(lines.some((l) => l.includes('initialize ok'))).toBe(false);
    expect(existsSync(envFile)).toBe(false);
  });

  it('fails: adapter missing, outside the packaged bin dir, or initialize reports another agent', async () => {
    expect(await run({ bin: null }).result).toBe(false);
    const { bin } = adapter();
    expect(await run({ bin, requiredDir: '/App/Contents/Resources/bin' }).result).toBe(false);
    rmSync(dir!, { recursive: true, force: true });
    const other = adapter('hermes');
    const { result, lines } = run({ bin: other.bin });
    expect(await result).toBe(false);
    expect(lines.some((l) => l.includes('returned agent hermes-agent'))).toBe(true);
  });
});
