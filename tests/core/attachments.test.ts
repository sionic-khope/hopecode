import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACH_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_ATTACH_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  acpPromptBlocks,
  admitAttachments,
  claudePromptContent,
  classifyAttachment,
  decodeText,
  defaultPromptCaps,
  extOf,
  fileUri,
  liteCaps,
  sizeProblem,
  sniffMagic,
  unsupportedReason,
} from '../../src/core/attachments';
import type { ChatImage, PromptFile } from '../../src/shared/types';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)));

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'rest');
const GIF = bytes('GIF89a', 'rest');
const WEBP = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ');
const PDF = bytes('%PDF-1.7\n');
const TEXT = new TextEncoder().encode('# 제목\nhello\n');

describe('MIME detection: extension + magic bytes', () => {
  it('sniffs PNG / JPEG / GIF / WebP / PDF signatures', () => {
    expect(sniffMagic(PNG)).toBe('image/png');
    expect(sniffMagic(JPEG)).toBe('image/jpeg');
    expect(sniffMagic(GIF)).toBe('image/gif');
    expect(sniffMagic(WEBP)).toBe('image/webp');
    expect(sniffMagic(PDF)).toBe('application/pdf');
    expect(sniffMagic(TEXT)).toBeNull();
    expect(sniffMagic(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffMagic(new Uint8Array())).toBeNull();
  });

  it('accepts a file only when the extension and the content agree', () => {
    expect(classifyAttachment('shot.PNG', PNG)).toEqual({ ok: true, kind: 'image', mediaType: 'image/png' });
    expect(classifyAttachment('photo.jpg', JPEG)).toEqual({ ok: true, kind: 'image', mediaType: 'image/jpeg' });
    expect(classifyAttachment('a.gif', GIF)).toMatchObject({ ok: true, mediaType: 'image/gif' });
    expect(classifyAttachment('a.webp', WEBP)).toMatchObject({ ok: true, mediaType: 'image/webp' });
    expect(classifyAttachment('spec.pdf', PDF)).toEqual({ ok: true, kind: 'pdf', mediaType: 'application/pdf' });
    expect(classifyAttachment('notes.md', TEXT)).toEqual({ ok: true, kind: 'text', mediaType: 'text/markdown' });
    expect(classifyAttachment('Dockerfile', TEXT)).toMatchObject({ ok: true, kind: 'text' });
    // Renamed files: the magic bytes win.
    expect(classifyAttachment('fake.png', JPEG)).toMatchObject({ ok: false });
    expect(classifyAttachment('fake.pdf', TEXT)).toMatchObject({ ok: false });
    expect(classifyAttachment('fake.txt', PNG)).toMatchObject({ ok: false });
    expect(classifyAttachment('binary.txt', bytes('abc', [0], 'def'))).toMatchObject({ ok: false });
    expect(classifyAttachment('latin1.txt', bytes([0xe9, 0x74, 0xe9]))).toMatchObject({ ok: false });
    // Unknown / unsupported types.
    expect(classifyAttachment('icon.svg', bytes('<svg/>'))).toMatchObject({ ok: false, reason: '.svg 파일은 첨부할 수 없습니다' });
    expect(classifyAttachment('app.exe', bytes('MZ'))).toMatchObject({ ok: false });
    expect(classifyAttachment('noext', TEXT)).toMatchObject({ ok: false, reason: '형식을 알 수 없는 파일입니다' });
  });

  it('extOf / decodeText edge cases', () => {
    expect(extOf('a/b/c.TAR.GZ')).toBe('gz');
    expect(extOf('.gitignore')).toBe('gitignore');
    expect(extOf('trailing.')).toBe('');
    expect(decodeText(bytes([0xef, 0xbb, 0xbf], 'hi'))).toBe('hi');
  });
});

describe('size and count caps', () => {
  it('per-kind size limits (images keep the API 5 MB base64 limit)', () => {
    expect(MAX_IMAGE_ATTACH_BYTES * (4 / 3)).toBe(5 * 1024 * 1024);
    expect(sizeProblem('image', MAX_IMAGE_ATTACH_BYTES)).toBeNull();
    expect(sizeProblem('image', MAX_IMAGE_ATTACH_BYTES + 1)).toMatch(/이미지는/);
    expect(sizeProblem('pdf', MAX_PDF_BYTES + 1)).toMatch(/PDF는 20 MB/);
    expect(sizeProblem('text', MAX_TEXT_BYTES + 1)).toMatch(/텍스트 파일은 512 KB/);
    expect(sizeProblem('text', 0)).toBe('빈 파일입니다');
  });

  it('admits in order up to the count and total size caps', () => {
    const item = (name: string, size: number) => ({ name, size });
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => item(`f${i}`, 1));
    const counted = admitAttachments([item('old', 1)], many);
    expect(counted.accepted).toHaveLength(MAX_ATTACHMENTS - 1);
    expect(counted.rejected.map((r) => r.name)).toEqual(['f9', 'f10', 'f11']);
    expect(counted.rejected[0]!.reason).toMatch(/10개까지/);

    const big = admitAttachments([item('old', MAX_ATTACH_TOTAL_BYTES - 10)], [item('a', 5), item('b', 6), item('c', 5)]);
    expect(big.accepted.map((a) => a.name)).toEqual(['a', 'c']);
    expect(big.rejected).toEqual([{ name: 'b', reason: expect.stringMatching(/합계 20 MB/) }]);
  });
});

describe('capabilities: what each agent may take', () => {
  const image = { kind: 'image' as const, linkable: false };
  const pdf = { kind: 'pdf' as const, linkable: true };
  const pastedText = { kind: 'text' as const, linkable: false };
  const fileText = { kind: 'text' as const, linkable: true };

  it('Claude takes images, PDFs and text', () => {
    for (const a of [image, pdf, pastedText, fileText]) expect(unsupportedReason('claude-code', null, a, 'Claude Code')).toBeNull();
  });

  it('ACP defaults before a session: Codex image + embeddedContext, Hermes text links only; PDFs never', () => {
    expect(defaultPromptCaps('claude-code')).toBeNull();
    expect(unsupportedReason('codex', null, image, 'Codex')).toBeNull();
    expect(unsupportedReason('codex', null, pastedText, 'Codex')).toBeNull();
    expect(unsupportedReason('codex', null, pdf, 'Codex')).toBe('Codex은(는) PDF 첨부를 지원하지 않습니다');
    expect(unsupportedReason('hermes', null, image, 'Hermes')).toMatch(/이미지 첨부를 지원하지 않습니다/);
    expect(unsupportedReason('hermes', null, fileText, 'Hermes')).toBeNull();
    expect(unsupportedReason('hermes', null, pastedText, 'Hermes')).toMatch(/텍스트 파일/);
  });

  it('a session’s reported capabilities replace the defaults', () => {
    const reported = liteCaps({ image: true, embeddedContext: true, _meta: {} });
    expect(reported).toEqual({ image: true, audio: false, embeddedContext: true });
    expect(unsupportedReason('hermes', reported, image, 'Hermes')).toBeNull();
    expect(unsupportedReason('codex', liteCaps({}), image, 'Codex')).toMatch(/이미지/);
    expect(liteCaps(undefined)).toEqual({ image: false, audio: false, embeddedContext: false });
  });
});

describe('prompt blocks', () => {
  const img: ChatImage = { mediaType: 'image/png', data: 'AAAA' };
  const pdfFile: PromptFile = { kind: 'pdf', name: 'spec.pdf', mediaType: 'application/pdf', size: 9, data: 'JVBERi0=' };
  const textFile: PromptFile = { kind: 'text', name: 'notes.md', mediaType: 'text/markdown', size: 6, data: 'hello\n', path: '/tmp/my dir/notes.md' };
  const pastedText: PromptFile = { kind: 'text', name: 'clip.txt', mediaType: 'text/plain', size: 3, data: 'abc' };

  it('Claude: plain string without attachments; image, document (base64 PDF / plain text) blocks, then the text', () => {
    expect(claudePromptContent('hi')).toBe('hi');
    expect(claudePromptContent('hi', [img], [pdfFile, textFile])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'spec.pdf' },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello\n' }, title: 'notes.md' },
      { type: 'text', text: 'hi' },
    ]);
  });

  it('ACP with image + embeddedContext: image and resource (text) blocks; PDFs are dropped', () => {
    const { blocks, dropped } = acpPromptBlocks('hi', [img], [textFile, pastedText, pdfFile], { image: true, audio: false, embeddedContext: true });
    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource', resource: { uri: 'file:///tmp/my%20dir/notes.md', mimeType: 'text/markdown', text: 'hello\n' } },
      { type: 'resource', resource: { uri: 'attachment:///clip.txt', mimeType: 'text/plain', text: 'abc' } },
      { type: 'text', text: 'hi' },
    ]);
    expect(dropped).toEqual(['spec.pdf']);
  });

  it('ACP without capabilities: resource_link for files on disk, the rest dropped', () => {
    const { blocks, dropped } = acpPromptBlocks('hi', [img], [textFile, pastedText], { image: false, audio: false, embeddedContext: false });
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'file:///tmp/my%20dir/notes.md', name: 'notes.md', mimeType: 'text/markdown', size: 6 },
      { type: 'text', text: 'hi' },
    ]);
    expect(dropped).toEqual(['이미지 1', 'clip.txt']);
    expect(fileUri('/a/#b?.txt')).toBe('file:///a/%23b%3F.txt');
  });
});
