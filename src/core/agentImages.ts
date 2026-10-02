// Images an agent hands back (Claude tool_result image blocks, ACP image content, MCP screenshots): validated once
// here so every path shares the same rules — PNG / JPEG / GIF / WebP only (declared type AND magic bytes), never
// SVG, at most MAX_AGENT_IMAGE_BYTES decoded. Pure: renderer-safe, no Buffer.
import type { ChatImage, ChatItem, ToolItem } from '../shared/types';
import { imageDimensions, imagePixelProblem, sniffMagic } from './attachments';
import { t } from '../shared/i18n';

export const AGENT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Largest image (decoded bytes) an agent may put on a chat item. */
export const MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;
/** Same cap as a base64 length. */
export const MAX_AGENT_IMAGE_BASE64 = Math.ceil((MAX_AGENT_IMAGE_BYTES * 4) / 3) + 4;
/** Images kept per chat item. */
export const MAX_IMAGES_PER_ITEM = 8;
/** Decoded bytes of agent images one turn may add to the chat (past it they are dropped with one notice). */
export const MAX_TURN_IMAGE_BYTES = 64 * 1024 * 1024;
/** Images an agent may send as message content (not tool results) in one turn. */
export const MAX_MESSAGE_IMAGES_PER_TURN = 32;
export const imageBudgetNotice = (): string => t('notice.imageBudget');

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Base64 prefix decoded to find an image's pixel size. */
const HEADER_CHARS = 64 * 1024;

/** First bytes of a base64 payload (24 chars: enough for the magic numbers). */
function headBytes(data: string, chars = 24): Uint8Array {
  const head = data.slice(0, chars - (chars % 4));
  try {
    const bin = atob(head);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

/**
 * Agent image -> ChatImage, or null when it is not one we display: unknown / SVG type, empty or oversized payload,
 * not base64, or magic bytes that are not the declared image type. A `data:` URL prefix is accepted and stripped.
 */
export function toAgentImage(mediaType: unknown, data: unknown): ChatImage | null {
  if (typeof mediaType !== 'string' || typeof data !== 'string') return null;
  const type = mediaType.trim().toLowerCase();
  const payload = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  if (!AGENT_IMAGE_TYPES.has(type)) return null;
  if (payload.length === 0 || payload.length > MAX_AGENT_IMAGE_BASE64 || payload.length % 4 === 1) return null;
  if (!BASE64.test(payload)) return null;
  if (sniffMagic(headBytes(payload)) !== type) return null;
  // Pixel size from the header (no decode): a short prefix covers PNG / GIF / WebP and most JPEGs; a JPEG whose
  // frame header sits behind large metadata is read in full. Unknown size or a bitmap bomb is refused.
  let head = headBytes(payload, Math.min(payload.length, HEADER_CHARS));
  if (imageDimensions(head) === null && payload.length > HEADER_CHARS) head = headBytes(payload, payload.length);
  if (imagePixelProblem(head) !== null) return null;
  return { mediaType: type as ChatImage['mediaType'], data: payload };
}

/** Decoded size of a base64 image payload. */
export function imageByteSize(image: Pick<ChatImage, 'data'>): number {
  const d = image.data;
  const pad = d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((d.length * 3) / 4) - pad);
}

/**
 * Per-turn image budget: keeps `images` in order while `used` + their bytes stays within MAX_TURN_IMAGE_BYTES.
 * `dropped` = how many did not fit (the caller says so once per turn).
 */
export function admitTurnImages(images: readonly ChatImage[], used: number): { kept: ChatImage[]; used: number; dropped: number } {
  const kept: ChatImage[] = [];
  let total = used;
  for (const image of images) {
    const size = imageByteSize(image);
    if (total + size > MAX_TURN_IMAGE_BYTES) continue;
    kept.push(image);
    total += size;
  }
  return { kept, used: total, dropped: images.length - kept.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Image blocks of an MCP / ACP content list: `{type:'image', data, mimeType}` (ACP and MCP share this shape). */
export function imagesOfBlocks(blocks: unknown): ChatImage[] {
  const out: ChatImage[] = [];
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    if (out.length >= MAX_IMAGES_PER_ITEM) break;
    if (!isRecord(block) || block.type !== 'image') continue;
    const image = toAgentImage(block.mimeType, block.data);
    if (image) out.push(image);
  }
  return out;
}

/**
 * Images of an ACP tool call: `content: [{type:'content', content:{type:'image', ...}}]` (Codex image generation)
 * and an MCP result passed through as rawOutput (`{result:{content:[...]}}` from codex-acp, or `{content:[...]}`).
 */
export function acpToolImages(content: unknown, rawOutput: unknown): ChatImage[] {
  const blocks: unknown[] = [];
  if (Array.isArray(content)) {
    for (const c of content) if (isRecord(c) && c.type === 'content') blocks.push(c.content);
  }
  const fromContent = imagesOfBlocks(blocks);
  if (fromContent.length > 0) return fromContent;
  return imagesOfBlocks(mcpBlocks(rawOutput));
}

/** Content blocks of an MCP CallToolResult carried in an ACP rawOutput, or []. */
export function mcpBlocks(rawOutput: unknown): unknown[] {
  if (!isRecord(rawOutput)) return [];
  if (Array.isArray(rawOutput.content)) return rawOutput.content;
  if (isRecord(rawOutput.result) && Array.isArray(rawOutput.result.content)) return rawOutput.result.content;
  return [];
}

/** Text blocks of an MCP result (what the tool card shows instead of a JSON dump with base64 in it). */
export function mcpText(rawOutput: unknown): string {
  return mcpBlocks(rawOutput)
    .filter((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/;

/** `mcp__playwright__browser_take_screenshot` -> `playwright · browser_take_screenshot`; ACP `mcp.server.tool` too. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^mcp\.([^.]+)\.(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/**
 * Caption under a tool card's images: the tool (MCP server · tool) and the page URL when the call or its result names
 * one (`input.url`, Playwright's "Page URL: ..." line, ...). Null for plain file reads (the path labels those).
 */
export function imageCaption(item: Pick<ToolItem, 'name' | 'input' | 'result'>): string | null {
  const name = typeof item.input.title === 'string' && /^mcp\./.test(item.input.title) ? item.input.title : item.name;
  if (name === 'Read' || name === 'Edit' || name === 'Write') return null;
  const fromInput = [item.input.url, item.input.uri, item.input.href].find((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v));
  const url = fromInput ?? URL_RE.exec(item.result ?? '')?.[0] ?? null;
  return url ? `${toolLabel(name)} · ${url}` : toolLabel(name);
}

/** Every image a chat item carries (tool results, agent message images, user attachments). */
export function itemImages(item: ChatItem): ChatImage[] {
  if (item.type === 'tool' || item.type === 'assistant-text' || item.type === 'user') return item.images ?? [];
  return [];
}
