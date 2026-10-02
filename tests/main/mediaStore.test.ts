import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChatReducerState, reduceSdkMessage, type SdkMessageLike } from '../../src/core/chatReducer';
import { buildChatTree, findSubagentNode } from '../../src/core/subagents';
import { FIXTURE_PNG_BASE64 } from '../../src/main/fixtures/fakeQuery';
import { createMediaStore, isMediaRef } from '../../src/main/images/mediaStore';
import { imageHandlers, type ImageActions } from '../../src/main/ipc/imageHandlers';
import { createThreadLog } from '../../src/main/persistence/threadLog';
import type { ChatItem, Thread, ToolItem } from '../../src/shared/types';

const PNG = FIXTURE_PNG_BASE64;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopecode-media-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const toolWithImage = (id: string, data = PNG): ToolItem => ({
  type: 'tool',
  id,
  toolUseId: `tu-${id}`,
  name: 'mcp__playwright__browser_take_screenshot',
  input: {},
  result: 'Page URL: https://example.com/',
  images: [{ mediaType: 'image/png', data }],
  createdAt: 1,
});

describe('media store', () => {
  it('stores an image once per content (0600 file), reads it back and re-checks the bytes', async () => {
    const media = createMediaStore(join(root, 'media'));
    const ref = await media.put('t1', { mediaType: 'image/png', data: PNG });
    expect(isMediaRef(ref)).toBe(true);
    expect(await media.put('t1', { mediaType: 'image/png', data: PNG })).toBe(ref);
    const file = join(root, 'media', 't1', ref);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const read = await media.read('t1', ref);
    expect(read.mediaType).toBe('image/png');
    expect(read.buffer.toString('base64')).toBe(PNG);

    // Tampered file (no longer a PNG) and bad refs are refused.
    writeFileSync(file, '<svg/>');
    await expect(media.read('t1', ref)).rejects.toThrow(/displayable/);
    await expect(media.read('t1', '../t2/x.png')).rejects.toThrow(/invalid/);
    await expect(media.read('t1', `${'a'.repeat(64)}.svg`)).rejects.toThrow(/invalid/);
    await expect(media.read('../x', ref)).rejects.toThrow();
  });

  it('refuses to store SVG / mislabeled images', async () => {
    const media = createMediaStore(join(root, 'media'));
    await expect(media.put('t1', { mediaType: 'image/png', data: btoa('<svg/>') })).rejects.toThrow();
  });

  it('thread log keeps refs, never base64; the item handed in stays inline; remove deletes the media folder', async () => {
    const media = createMediaStore(join(root, 'media'));
    const log = createThreadLog(join(root, 'threads'), { media });
    const item = toolWithImage('a');
    await log.append('t1', item);
    await log.append('t1', { type: 'assistant-text', id: 'b', text: '', images: [{ mediaType: 'image/png', data: btoa('<svg/>') }], createdAt: 2 });
    expect(item.images![0]!.data).toBe(PNG);

    const raw = readFileSync(join(root, 'threads', 't1.jsonl'), 'utf8');
    expect(raw).not.toContain(PNG.slice(0, 40));
    const [tool, text] = await log.read('t1');
    const image = (tool as ToolItem).images![0]!;
    expect(image).toMatchObject({ mediaType: 'image/png', data: '' });
    expect(isMediaRef(image.ref)).toBe(true);
    // An invalid image is dropped, not kept inline.
    expect(text).not.toHaveProperty('images');

    await log.remove('t1');
    expect(readdirSync(join(root, 'media'))).toEqual([]);
  });
});

describe('image:read / image:copy / image:save with a media ref', () => {
  it('serves the stored image to the thread that owns it', async () => {
    const media = createMediaStore(join(root, 'media'));
    const ref = await media.put('t1', { mediaType: 'image/png', data: PNG });
    const copied: Buffer[] = [];
    const saved: [Buffer, string][] = [];
    const actions: ImageActions = {
      reveal() {},
      copy(buffer) {
        copied.push(buffer);
      },
      async save(buffer, name) {
        saved.push([buffer, name]);
        return true;
      },
    };
    const threads: Record<string, Thread> = { t1: { id: 't1', cwd: root } as Thread, t2: { id: 't2', cwd: root } as Thread };
    const h = imageHandlers((_c, id) => threads[id as string]!, actions, media);
    await expect(h['image:read']({ threadId: 't1', ref })).resolves.toEqual({ dataUrl: `data:image/png;base64,${PNG}` });
    await expect(h['image:read']({ threadId: 't2', ref })).rejects.toThrow();
    await h['image:copy']({ threadId: 't1', ref });
    expect(copied[0]!.toString('base64')).toBe(PNG);
    await expect(h['image:save']({ threadId: 't1', ref })).resolves.toEqual({ saved: true });
    expect(saved[0]![1]).toMatch(/^deltax-[0-9a-f]{12}\.png$/);
  });
});

describe('subagent transcript collection (SDK parent_tool_use_id) survives the log', () => {
  it('child text / tools / screenshot of a Task subagent come back nested under its card after a restart', async () => {
    const msg = (m: Record<string, unknown>) => m as unknown as SdkMessageLike;
    let state = createChatReducerState('t1');
    const items: ChatItem[] = [];
    const feed = (m: SdkMessageLike, at: number) => {
      const r = reduceSdkMessage(state, m, at);
      state = r.state;
      for (const e of r.events) if (e.type === 'item-upsert') items.push(e.item);
    };
    feed(msg({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'task', name: 'Task', input: { subagent_type: 'Explore', description: '조사', prompt: 'Look around.' } }] } }), 1);
    feed(msg({ type: 'assistant', parent_tool_use_id: 'task', message: { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'shot', name: 'mcp__playwright__browser_take_screenshot', input: {} }] } }), 2);
    feed(
      msg({
        type: 'user',
        parent_tool_use_id: 'task',
        message: { content: [{ type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] },
      }),
      3,
    );
    feed(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'task', content: 'done: one page' }] } }), 4);

    const log = createThreadLog(join(root, 'threads'), { media: createMediaStore(join(root, 'media')) });
    for (const item of items) await log.append('t1', item);
    // "Restart": a fresh log instance over the same folders.
    const reread = await createThreadLog(join(root, 'threads'), { media: createMediaStore(join(root, 'media')) }).read('t1');
    const node = findSubagentNode(buildChatTree(reread), 'task');
    expect(node).not.toBeNull();
    expect(node!.summary).toMatchObject({ subagentType: 'Explore', state: 'done', childToolCount: 1 });
    expect(node!.item.input.prompt).toBe('Look around.');
    expect(node!.item.result).toBe('done: one page');
    expect(node!.children.map((c) => c.item.type)).toEqual(['assistant-text', 'tool']);
    const shot = node!.children[1]!.item as ToolItem;
    expect(shot.images![0]!.ref).toMatch(/\.png$/);
    expect(findSubagentNode(buildChatTree(reread), 'nope')).toBeNull();
  });
});

describe('media store caps and user images (security review M3 / L4 / L3)', () => {
  /** Distinct valid PNGs (1×1 header + padding). */
  const png = (bytes: number, tag: number) => {
    const b = Buffer.alloc(bytes);
    Buffer.from(PNG, 'base64').copy(b);
    b[bytes - 1] = tag;
    return b.toString('base64');
  };

  it('refuses a write once the thread folder would pass its cap (measured from disk the first time)', async () => {
    const dir = join(root, 'media');
    const first = createMediaStore(dir, () => {}, { maxThreadBytes: 2500 });
    await first.put('t1', { mediaType: 'image/png', data: png(1000, 1) });
    // A fresh store (app restart) counts what is already on disk.
    const media = createMediaStore(dir, () => {}, { maxThreadBytes: 2500 });
    await media.put('t1', { mediaType: 'image/png', data: png(1000, 2) });
    await expect(media.put('t1', { mediaType: 'image/png', data: png(1000, 3) })).rejects.toThrow(/full/);
    // The same content again writes nothing and is fine; another thread has its own budget.
    await expect(media.put('t1', { mediaType: 'image/png', data: png(1000, 2) })).resolves.toMatch(/\.png$/);
    await expect(media.put('t2', { mediaType: 'image/png', data: png(1000, 3) })).resolves.toMatch(/\.png$/);
    await media.removeThread('t1');
    await expect(media.put('t1', { mediaType: 'image/png', data: png(1000, 3) })).resolves.toMatch(/\.png$/);
  });

  it('user attachment images go to the store too; an older log with base64 user images still reads', async () => {
    const media = createMediaStore(join(root, 'media'));
    const log = createThreadLog(join(root, 'threads'), { media });
    const user: ChatItem = { type: 'user', id: 'u1', text: 'see', images: [{ mediaType: 'image/png', data: PNG }], createdAt: 1 };
    await log.append('t1', user);
    const raw = readFileSync(join(root, 'threads', 't1.jsonl'), 'utf8');
    expect(raw).not.toContain(PNG.slice(0, 40));
    const [stored] = await log.read('t1');
    expect(stored).toMatchObject({ type: 'user', images: [{ mediaType: 'image/png', data: '', ref: expect.stringMatching(/\.png$/) }] });

    // Legacy line written before this change: base64 inline, read back unchanged.
    writeFileSync(join(root, 'threads', 't2.jsonl'), `${JSON.stringify(user)}\n`);
    expect((await log.read('t2'))[0]).toEqual(user);
  });

  it('image:copy / image:save refuse inline images whose bytes are not the declared type', async () => {
    const thread = { id: 't1', cwd: root } as Thread;
    const actions: ImageActions = { reveal: () => {}, copy: () => {}, save: async () => true };
    const h = imageHandlers(() => thread, actions, createMediaStore(join(root, 'media')));
    const gif = btoa('GIF89a\u0001\u0000\u0001\u0000');
    await expect(h['image:copy']({ threadId: 't1', image: { mediaType: 'image/png', data: gif } })).rejects.toThrow(/invalid image/);
    await expect(h['image:save']({ threadId: 't1', image: { mediaType: 'image/png', data: gif } })).rejects.toThrow(/invalid image/);
    await expect(h['image:save']({ threadId: 't1', image: { mediaType: 'image/gif', data: gif } })).resolves.toEqual({ saved: true });
  });
});
