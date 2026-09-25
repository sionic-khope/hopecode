import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, compactJsonl, readAllJsonl, writeJsonlAtomic } from '../../src/main/persistence/jsonl';

describe('jsonl', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopecode-jsonl-'));
    file = join(dir, 'log.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('readAllJsonl returns [] when the file does not exist', async () => {
    expect(await readAllJsonl(file)).toEqual([]);
  });

  it('append + readAll round-trips values in order', async () => {
    await appendJsonl(file, { a: 1 });
    await appendJsonl(file, { a: 2 });
    expect(await readAllJsonl<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips a corrupt line instead of failing the read', async () => {
    await appendJsonl(file, { a: 1 });
    await appendFile(file, 'not json\n', 'utf8');
    await appendJsonl(file, { a: 2 });
    expect(await readAllJsonl<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('compactJsonl rewrites the file keeping only matching entries', async () => {
    await appendJsonl(file, { at: 1 });
    await appendJsonl(file, { at: 2 });
    await appendJsonl(file, { at: 3 });
    await compactJsonl<{ at: number }>(file, (v) => v.at >= 2);
    expect(await readAllJsonl<{ at: number }>(file)).toEqual([{ at: 2 }, { at: 3 }]);
  });

  it('writeJsonlAtomic leaves no temp file behind', async () => {
    await writeJsonlAtomic(file, [{ a: 1 }]);
    const raw = await readFile(file, 'utf8');
    expect(raw.trim()).toBe(JSON.stringify({ a: 1 }));
  });
});
