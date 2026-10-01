import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_IMAGE_BASE64,
  acpToolImages,
  imageCaption,
  imagesOfBlocks,
  mcpText,
  toAgentImage,
  toolLabel,
} from '../../src/core/agentImages';
import { FIXTURE_PNG_BASE64 } from '../../src/main/fixtures/fakeQuery';

const PNG = FIXTURE_PNG_BASE64;
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46));
const GIF = btoa('GIF89a\u0001\u0000\u0001\u0000');
const WEBP = btoa('RIFF\u001a\u0000\u0000\u0000WEBPVP8 ');
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
