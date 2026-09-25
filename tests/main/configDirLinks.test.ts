import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSharedConfig, removeConfigDir, verifyLinks } from '../../src/main/accounts/configDirLinks';

let root: string;
let claude: string; // fake ~/.claude
let acct: string; // account config dir

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopecode-links-'));
  claude = join(root, 'dot-claude');
  acct = join(root, 'accounts', 'a1');
  mkdirSync(claude, { recursive: true });
  mkdirSync(acct, { recursive: true });
  writeFileSync(join(claude, 'CLAUDE.md'), '# user rules');
  writeFileSync(join(claude, 'settings.json'), '{"theme":"light"}');
  mkdirSync(join(claude, 'plugins'));
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), '{}');
  mkdirSync(join(claude, 'hooks'));
  mkdirSync(join(claude, 'skills'));
  // agents/ and output-styles/ intentionally missing
  // per-account things that must never be linked:
  mkdirSync(join(claude, 'projects'));
  writeFileSync(join(claude, '.credentials.json'), '{"secret":1}');
  writeFileSync(join(claude, '.claude.json'), '{}');
  writeFileSync(join(claude, 'settings.local.json'), '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const noWarn = () => {};

describe('linkSharedConfig', () => {
  it('links only existing shared entries as absolute symlinks', async () => {
    const r = await linkSharedConfig(acct, claude, noWarn);
    expect(r.linked.sort()).toEqual(['CLAUDE.md', 'hooks', 'plugins', 'settings.json', 'skills']);
    expect(r.skipped).toEqual([]);
    for (const name of r.linked) {
      expect(lstatSync(join(acct, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(acct, name))).toBe(join(claude, name));
    }
    expect(existsSync(join(acct, 'agents'))).toBe(false);
    expect(existsSync(join(acct, 'output-styles'))).toBe(false);
    expect(readFileSync(join(acct, 'plugins', 'installed_plugins.json'), 'utf8')).toBe('{}');
  });

  it('never links auth files, .claude.json, projects/ or settings.local.json', async () => {
    await linkSharedConfig(acct, claude, noWarn);
    for (const name of ['projects', '.credentials.json', '.claude.json', 'settings.local.json']) {
      expect(existsSync(join(acct, name))).toBe(false);
    }
  });

  it('keeps existing real files in the account dir and warns', async () => {
    writeFileSync(join(acct, 'settings.json'), '{"mine":true}');
    const warnings: string[] = [];
    const r = await linkSharedConfig(acct, claude, (m) => warnings.push(m));
    expect(r.skipped).toEqual(['settings.json']);
    expect(lstatSync(join(acct, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(acct, 'settings.json'), 'utf8')).toBe('{"mine":true}');
    expect(warnings).toHaveLength(1);
  });

  it('is idempotent and leaves the source untouched', async () => {
    await linkSharedConfig(acct, claude, noWarn);
    const again = await linkSharedConfig(acct, claude, noWarn);
    expect(again.skipped).toEqual([]);
    expect(again.linked).toHaveLength(5);
    expect(readFileSync(join(claude, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    expect(lstatSync(join(claude, 'plugins')).isDirectory()).toBe(true);
  });
});

describe('verifyLinks', () => {
  it('reports broken shared links', async () => {
    await linkSharedConfig(acct, claude, noWarn);
    expect(await verifyLinks(acct)).toEqual({ broken: [] });
    rmSync(join(claude, 'CLAUDE.md'));
    expect(await verifyLinks(acct)).toEqual({ broken: ['CLAUDE.md'] });
  });
});

describe('removeConfigDir', () => {
  it('deletes the account dir but keeps shared originals', async () => {
    await linkSharedConfig(acct, claude, noWarn);
    mkdirSync(join(acct, 'projects', 'p'), { recursive: true });
    writeFileSync(join(acct, 'projects', 'p', 's.jsonl'), '{}');
    await removeConfigDir(acct);
    expect(existsSync(acct)).toBe(false);
    expect(readFileSync(join(claude, 'CLAUDE.md'), 'utf8')).toBe('# user rules');
    expect(readFileSync(join(claude, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    expect(existsSync(join(claude, 'plugins', 'installed_plugins.json'))).toBe(true);
    expect(existsSync(join(claude, 'hooks'))).toBe(true);
    expect(existsSync(join(claude, 'skills'))).toBe(true);
  });

  it('unlinks (not follows) when the config dir itself is a symlink; missing dir is a no-op', async () => {
    const link = join(root, 'linked-acct');
    symlinkSync(claude, link);
    await removeConfigDir(link);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(claude, 'CLAUDE.md'))).toBe(true);
    await expect(removeConfigDir(join(root, 'nope'))).resolves.toBeUndefined();
  });
});
