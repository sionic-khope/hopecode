import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scratchDir } from '../../src/main/paths';
import { createScratchDir, removeScratchDir, scratchGitCeiling } from '../../src/main/scratch/scratchDirs';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'scratch-'));
  previous = process.env['HOPECODE_HOME'];
  process.env['HOPECODE_HOME'] = tmp;
});
afterEach(() => {
  if (previous === undefined) delete process.env['HOPECODE_HOME'];
  else process.env['HOPECODE_HOME'] = previous;
  rmSync(tmp, { recursive: true, force: true });
});

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('scratchDirs', () => {
  it('creates <root>/<id> with 0700, no .git, root also 0700', () => {
    const dir = createScratchDir(ID);
    expect(dir).toBe(join(scratchDir(), ID));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(scratchDir()).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(dir.startsWith(join(tmp, 'home'))).toBe(true);
  });

  it('create is idempotent and repairs permissions', () => {
    const dir = createScratchDir(ID);
    writeFileSync(join(dir, 'keep'), 'x');
    expect(createScratchDir(ID)).toBe(dir);
    expect(existsSync(join(dir, 'keep'))).toBe(true);
  });

  it('removes the folder recursively; absent is false', () => {
    const dir = createScratchDir(ID);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f'), 'x');
    expect(removeScratchDir(ID)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removeScratchDir(ID)).toBe(false);
    expect(existsSync(scratchDir())).toBe(true);
  });

  it.each(['', '..', '.', '../x', 'a/b', '/etc', 'a\0b', 'x'.repeat(65), 'a b'])('rejects invalid id %j', (id) => {
    expect(() => createScratchDir(id)).toThrow(/invalid/);
    expect(() => removeScratchDir(id)).toThrow(/invalid/);
  });

  it('rejects non-string ids', () => {
    expect(() => removeScratchDir(undefined as unknown as string)).toThrow(/invalid/);
  });

  it('does not follow a symlink: target survives and symlink is refused', () => {
    createScratchDir('keep');
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious'), 'x');
    symlinkSync(outside, join(scratchDir(), ID));
    expect(() => removeScratchDir(ID)).toThrow(/symlink/);
    expect(() => createScratchDir(ID)).toThrow(/not a plain directory/);
    expect(existsSync(join(outside, 'precious'))).toBe(true);
  });

  it('refuses a regular file at the thread path', () => {
    createScratchDir('keep');
    writeFileSync(join(scratchDir(), ID), 'x');
    expect(() => removeScratchDir(ID)).toThrow(/not a directory/);
  });

  it('refuses a symlinked scratch root (create and remove)', () => {
    const outside = join(tmp, 'elsewhere');
    mkdirSync(join(outside, ID), { recursive: true });
    mkdirSync(join(scratchDir(), '..'), { recursive: true });
    symlinkSync(outside, scratchDir());
    expect(() => createScratchDir('new')).toThrow(/scratch root is not a plain directory/);
    expect(() => removeScratchDir(ID)).toThrow(/scratch root is not a plain directory/);
    expect(existsSync(join(outside, ID))).toBe(true);
    expect(existsSync(join(outside, 'new'))).toBe(false);
  });

  it('git ceiling is the scratch root', () => {
    expect(scratchGitCeiling()).toBe(scratchDir());
  });
});
