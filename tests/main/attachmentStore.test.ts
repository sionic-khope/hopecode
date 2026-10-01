import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore, safeName } from '../../src/main/attachments/attachmentStore';
import { MAX_ATTACH_READ_BYTES, MAX_ATTACHMENTS, MAX_IMAGE_ATTACH_BYTES, MAX_TEXT_BYTES } from '../../src/core/attachments';
import { FIXTURE_PNG_BASE64 } from '../../src/main/fixtures/fakeQuery';

const PNG = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hopecode-attach-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('AttachmentStore.fromPath', () => {
  it('reads an image, a PDF and a text file through their real path; the renderer gets ids and a preview', async () => {
    const store = new AttachmentStore();
    const img = await store.fromPath(file('shot.png', PNG));
    expect(img).toMatchObject({ kind: 'image', name: 'shot.png', mediaType: 'image/png', size: PNG.length, linkable: true });
    expect(img.image).toEqual({ mediaType: 'image/png', data: FIXTURE_PNG_BASE64 });

    const pdf = await store.fromPath(file('spec.pdf', PDF));
    expect(pdf).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf', linkable: true });
    expect(pdf).not.toHaveProperty('image');

    // A symlink resolves to its target (realpath): the name and the checks follow the real file.
    const real = file('notes.md', '# hi\n');
    const link = join(dir, 'link.md');
    symlinkSync(real, link);
    const text = await store.fromPath(link);
    expect(text).toMatchObject({ kind: 'text', name: 'notes.md', mediaType: 'text/markdown', size: 5 });

    const resolved = store.resolve([img.id, pdf.id, text.id])!;
    expect(resolved.images).toEqual([{ mediaType: 'image/png', data: FIXTURE_PNG_BASE64 }]);
    expect(resolved.files).toEqual([
      { kind: 'pdf', name: 'spec.pdf', mediaType: 'application/pdf', size: PDF.length, data: PDF.toString('base64'), path: expect.stringMatching(/spec\.pdf$/) },
      { kind: 'text', name: 'notes.md', mediaType: 'text/markdown', size: 5, data: '# hi\n', path: expect.stringMatching(/notes\.md$/) },
    ]);
  });

  it('refuses relative paths, folders, special files, missing files, mismatched content and oversized files', async () => {
    const store = new AttachmentStore();
    const reason = (p: unknown) => store.fromPath(p).then(() => 'ok', (e: { reason?: string }) => e.reason);
    expect(await reason('relative/a.png')).toBe('잘못된 경로입니다');
    expect(await reason(`${dir}/a\0.png`)).toBe('잘못된 경로입니다');
    expect(await reason(42)).toBe('잘못된 경로입니다');
    mkdirSync(join(dir, 'folder.png'));
    expect(await reason(join(dir, 'folder.png'))).toBe('폴더는 첨부할 수 없습니다');
    execFileSync('mkfifo', [join(dir, 'pipe.txt')]);
    expect(await reason(join(dir, 'pipe.txt'))).toBe('일반 파일만 첨부할 수 있습니다');
    expect(await reason(join(dir, 'missing.png'))).toBe('파일을 찾을 수 없습니다');
    expect(await reason(file('renamed.png', PDF))).toBe('내용이 .png 이미지가 아닙니다');
    // Larger than anything main reads: refused from stat, before any read.
    const huge = file('huge.pdf', PDF);
    truncateSync(huge, MAX_ATTACH_READ_BYTES + 1);
    expect(await reason(huge)).toMatch(/20 MB보다 큽니다/);
    const longText = file('long.txt', 'a'.repeat(MAX_TEXT_BYTES + 1));
    expect(await reason(longText)).toMatch(/텍스트 파일은 512 KB/);
  });

  it('scales an oversized image down with the injected resizer, or refuses it', async () => {
    const bigPng = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_ATTACH_BYTES)]);
    const path = file('big.png', bigPng);
    const refused = new AttachmentStore();
    await expect(refused.fromPath(path)).rejects.toMatchObject({ reason: expect.stringMatching(/이미지는 3\.8 MB/) });

    const calls: [number, string, number][] = [];
    const store = new AttachmentStore({
      resizeImage: (bytes, mediaType, max) => {
        calls.push([bytes.length, mediaType, max]);
        return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mediaType: 'image/jpeg' };
      },
    });
    const info = await store.fromPath(path);
    expect(calls).toEqual([[bigPng.length, 'image/png', MAX_IMAGE_ATTACH_BYTES]]);
    expect(info).toMatchObject({ kind: 'image', mediaType: 'image/jpeg', size: 7, resized: true });
    expect(info.image?.mediaType).toBe('image/jpeg');
  });
});

describe('AttachmentStore.fromBytes / collect / resolve', () => {
  it('pasted bytes: typed by name + magic, not linkable, name sanitized', () => {
    const store = new AttachmentStore();
    expect(store.fromBytes('image.png', new Uint8Array(PNG))).toMatchObject({ kind: 'image', linkable: false });
    expect(store.fromBytes('../../etc/notes.txt', new TextEncoder().encode('hi'))).toMatchObject({ name: 'notes.txt', kind: 'text' });
    expect(() => store.fromBytes('a.png', 'AAAA')).toThrow(/잘못된 파일/);
    expect(() => store.fromBytes('a.png', new TextEncoder().encode('not png'))).toThrow(/이미지가 아닙니다/);
    expect(safeName('a\u0007b\n.txt')).toBe('ab.txt');
    expect(safeName('')).toBe('pasted');
  });

  it('collect keeps going after a bad file and caps the count', async () => {
    const store = new AttachmentStore();
    const names = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => (i === 1 ? 'bad.exe' : `f${i}.txt`));
    const res = await store.collect(names, (n) => n, (n) => store.fromBytes(n, new TextEncoder().encode('x')));
    expect(res.attachments).toHaveLength(MAX_ATTACHMENTS - 1);
    expect(res.rejected).toEqual([
      { name: 'bad.exe', reason: '.exe 파일은 첨부할 수 없습니다' },
      { name: `f${MAX_ATTACHMENTS}.txt`, reason: expect.stringMatching(/10개까지/) },
    ]);
  });

  it('resolve refuses unknown, duplicate and too many ids', () => {
    const store = new AttachmentStore();
    const a = store.fromBytes('a.txt', new TextEncoder().encode('a'));
    expect(store.resolve([])).toEqual({ images: [], files: [], infos: [] });
    expect(store.resolve([a.id, 'nope'])).toBeNull();
    expect(store.resolve([a.id, a.id])).toBeNull();
    expect(store.resolve(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `id${i}`))).toBeNull();
  });
});
