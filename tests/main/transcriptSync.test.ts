import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncTranscript } from '../../src/main/session/transcriptSync';

const SID = '11111111-2222-3333-4444-555555555555';
const ENC = '-Users-me-project';

let root: string;
let from: string;
let to: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopecode-sync-'));
  from = join(root, 'accA');
  to = join(root, 'accB');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSession(configDir: string, content: string, sub: Record<string, string> = {}) {
  const dir = join(configDir, 'projects', ENC);
  await mkdir(join(dir, SID, 'subagents'), { recursive: true });
  await writeFile(join(dir, `${SID}.jsonl`), content);
  for (const [name, body] of Object.entries(sub)) await writeFile(join(dir, SID, name), body);
}

describe('syncTranscript', () => {
  it('copies <sid>.jsonl and the sibling <sid>/ dir to the same relative path', async () => {
    await writeSession(from, '{"a":1}\n', { 'tool-result.txt': 'out' });
    await writeFile(join(from, 'projects', ENC, SID, 'subagents', 'agent.jsonl'), 'sub');
    // Unrelated session in the same dir is not copied.
    await writeFile(join(from, 'projects', ENC, 'other.jsonl'), 'x');

    const result = await syncTranscript(SID, from, to);
    expect(result.found).toBe(true);
    expect(await readFile(join(to, 'projects', ENC, `${SID}.jsonl`), 'utf8')).toBe('{"a":1}\n');
    expect(await readFile(join(to, 'projects', ENC, SID, 'tool-result.txt'), 'utf8')).toBe('out');
    expect(await readFile(join(to, 'projects', ENC, SID, 'subagents', 'agent.jsonl'), 'utf8')).toBe('sub');
    await expect(readFile(join(to, 'projects', ENC, 'other.jsonl'))).rejects.toThrow();
  });

  it('overwrites an older copy in the destination', async () => {
    await writeSession(to, 'old\n', { 'tool-result.txt': 'old' });
    await writeSession(from, 'old\nnew\n', { 'tool-result.txt': 'new' });
    await syncTranscript(SID, from, to);
    expect(await readFile(join(to, 'projects', ENC, `${SID}.jsonl`), 'utf8')).toBe('old\nnew\n');
    expect(await readFile(join(to, 'projects', ENC, SID, 'tool-result.txt'), 'utf8')).toBe('new');
  });

  it('finds the session under any encoded cwd dir (glob, no re-encoding)', async () => {
    const dir = join(from, 'projects', '-some-truncated-path-abc123');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${SID}.jsonl`), 'x\n');
    const result = await syncTranscript(SID, from, to);
    expect(result.copied).toEqual([join('-some-truncated-path-abc123', `${SID}.jsonl`)]);
    expect(await readFile(join(to, 'projects', '-some-truncated-path-abc123', `${SID}.jsonl`), 'utf8')).toBe('x\n');
  });

  it('reports found=false when the source has no transcript', async () => {
    expect(await syncTranscript(SID, from, to)).toEqual({ found: false, copied: [] });
    await mkdir(join(from, 'projects', ENC), { recursive: true });
    expect((await syncTranscript(SID, from, to)).found).toBe(false);
  });
});
