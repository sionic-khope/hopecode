import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_IMAGE_BASE64,
  MAX_TURN_IMAGE_BYTES,
  admitTurnImages,
  acpToolImages,
  imageCaption,
  imagesOfBlocks,
  mcpText,
  toAgentImage,
  toolLabel,
} from '../../src/core/agentImages';
import { FIXTURE_PNG_BASE64 } from '../../src/main/fixtures/fakeQuery';

const PNG = FIXTURE_PNG_BASE64;
// SOI, then an SOF0 frame header (1×1): the pixel size is read from it.
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0));
const GIF = btoa('GIF89a\u0001\u0000\u0001\u0000');
// VP8X header: canvas 1×1 (width-1 / height-1 as 24-bit little endian).
const WEBP = btoa('RIFF\u001a\u0000\u0000\u0000WEBPVP8X\u000a\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000');
const SVG = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('toAgentImage (whitelist + magic bytes + size cap)', () => {
  it('accepts PNG / JPEG / GIF / WebP whose bytes match the declared type', () => {
    expect(toAgentImage('image/png', PNG)).toEqual({ mediaType: 'image/png', data: PNG });
    expect(toAgentImage('image/jpeg', JPEG)?.mediaType).toBe('image/jpeg');
    expect(toAgentImage('image/gif', GIF)?.mediaType).toBe('image/gif');
    expect(toAgentImage('IMAGE/WEBP', WEBP)?.mediaType).toBe('image/webp');
    // A data: URL prefix is stripped.
    expect(toAgentImage('image/png', `data:image/png;base64,${PNG}`)).toEqual({ mediaType: 'image/png', data: PNG });
  });

  it('refuses SVG, unknown types, mislabeled bytes, non-base64 and oversized payloads', () => {
    expect(toAgentImage('image/svg+xml', SVG)).toBeNull();
    expect(toAgentImage('image/png', SVG)).toBeNull();
    expect(toAgentImage('image/bmp', PNG)).toBeNull();
    expect(toAgentImage('image/jpeg', PNG)).toBeNull();
    expect(toAgentImage('image/png', 'not base64!')).toBeNull();
    expect(toAgentImage('image/png', '')).toBeNull();
    expect(toAgentImage('image/png', PNG + 'A'.repeat(MAX_AGENT_IMAGE_BASE64))).toBeNull();
    expect(toAgentImage(undefined, PNG)).toBeNull();
  });
});

describe('ACP / MCP image blocks', () => {
  it('reads tool content images first, then an MCP rawOutput (codex-acp `result.content` or plain `content`)', () => {
    const content = [{ type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png' } }];
    expect(acpToolImages(content, undefined)).toHaveLength(1);
    const raw = { result: { content: [{ type: 'text', text: 'Page URL: https://a.test/' }, { type: 'image', data: PNG, mimeType: 'image/png' }] } };
    expect(acpToolImages([], raw)).toEqual([{ mediaType: 'image/png', data: PNG }]);
    expect(acpToolImages(undefined, { content: raw.result.content })).toHaveLength(1);
    expect(mcpText(raw)).toBe('Page URL: https://a.test/');
    expect(imagesOfBlocks([{ type: 'image', data: SVG, mimeType: 'image/svg+xml' }])).toEqual([]);
  });
});

describe('imageCaption', () => {
  it('names the MCP tool and the page URL of a screenshot', () => {
    expect(toolLabel('mcp__playwright__browser_take_screenshot')).toBe('playwright · browser_take_screenshot');
    expect(toolLabel('mcp.playwright.browser_take_screenshot')).toBe('playwright · browser_take_screenshot');
    expect(
      imageCaption({ name: 'mcp__playwright__browser_take_screenshot', input: {}, result: '### Page\n- Page URL: https://example.com/x\n' }),
    ).toBe('playwright · browser_take_screenshot · https://example.com/x');
    expect(imageCaption({ name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' }, result: '' })).toBe(
      'claude-in-chrome · computer',
    );
    // ACP: the card name is the kind label; the MCP title wins.
    expect(imageCaption({ name: 'Bash', input: { title: 'mcp.playwright.browser_take_screenshot', url: 'https://b.test/' } })).toBe(
      'playwright · browser_take_screenshot · https://b.test/',
    );
    expect(imageCaption({ name: 'Read', input: { file_path: 'a.png' } })).toBeNull();
  });
});

describe('toAgentImage pixel cap and the per-turn image budget (security review M1 / M3)', () => {
  it('refuses a PNG whose IHDR declares a decompression bomb, and one with no readable size', () => {
    const head = Buffer.from(PNG, 'base64');
    const bomb = Buffer.from(head);
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    expect(toAgentImage('image/png', bomb.toString('base64'))).toBeNull();
    expect(toAgentImage('image/png', btoa('\x89PNG\r\n\x1a\n'))).toBeNull();
    expect(toAgentImage('image/png', PNG)).not.toBeNull();
  });

  it('admitTurnImages keeps images in order while the budget holds', () => {
    const img = { mediaType: 'image/png' as const, data: 'A'.repeat(4 * 1024 * 1024) }; // 3 MB decoded
    const r = admitTurnImages([img, img], MAX_TURN_IMAGE_BYTES - 4 * 1024 * 1024);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(r.used).toBe(MAX_TURN_IMAGE_BYTES - 1024 * 1024);
  });
});
