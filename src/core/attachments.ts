// Composer attachments (images, PDFs, text / code files): type detection, limits, per-agent support and the prompt
// blocks each runtime receives. Pure (no Node / DOM APIs), shared by main (validation, prompts) and the renderer
// (what the composer may hold before sending).
//
// Claude limits (Messages API, sent through the Agent SDK's `message.content`): an image block is at most 5 MB
// (the encoded payload, so 3.75 MB of raw bytes), a request at most 32 MB, a PDF document block 32 MB / 100 pages.
// The caps below keep a full message (10 attachments, 20 MB raw ≈ 27 MB base64) under the request limit.
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AcpPromptCaps, AgentKind, AttachmentKind, ChatImage, PromptFile } from '../shared/types';

const MIB = 1024 * 1024;

/** Attachments per message. */
export const MAX_ATTACHMENTS = 10;
/** Raw bytes of every attachment of one message together. */
export const MAX_ATTACH_TOTAL_BYTES = 20 * MIB;
/** Raw image bytes whose base64 stays within the API's 5 MB image limit; larger PNG / JPEG are scaled down. */
export const MAX_IMAGE_ATTACH_BYTES = (5 * MIB * 3) / 4;
export const MAX_PDF_BYTES = 20 * MIB;
export const MAX_TEXT_BYTES = 512 * 1024;
/** Nothing larger is ever read from disk or accepted over IPC. */
export const MAX_ATTACH_READ_BYTES = 20 * MIB;

export type ImageMediaType = ChatImage['mediaType'];

const IMAGE_EXT: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Text / code extensions accepted as text attachments (media type shown on the chip; Claude gets text/plain). */
const TEXT_EXT: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  rst: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/plain',
  less: 'text/plain',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  mts: 'text/plain',
  cts: 'text/plain',
  py: 'text/x-python',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  kts: 'text/plain',
  swift: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cc: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  m: 'text/plain',
  mm: 'text/plain',
  cs: 'text/plain',
  php: 'text/plain',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  fish: 'text/plain',
  sql: 'text/plain',
  graphql: 'text/plain',
  gql: 'text/plain',
  vue: 'text/plain',
  svelte: 'text/plain',
  lua: 'text/plain',
  pl: 'text/plain',
  r: 'text/plain',
  dart: 'text/plain',
  scala: 'text/plain',
  ex: 'text/plain',
  exs: 'text/plain',
  erl: 'text/plain',
  hs: 'text/plain',
  clj: 'text/plain',
  ml: 'text/plain',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  gitignore: 'text/plain',
};

/** Extension-less file names accepted as text. */
const TEXT_NAMES: ReadonlySet<string> = new Set(['dockerfile', 'makefile', 'license', 'readme', 'gemfile', 'procfile']);

/** Lower-case extension without the dot (`''` when none; `.gitignore` -> `gitignore`). */
export function extOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot < 0 || dot === base.length - 1 ? '' : base.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  return sig.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** Media type from the file's magic bytes (images and PDF), or null. */
export function sniffMagic(bytes: Uint8Array): ImageMediaType | 'application/pdf' | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return null;
}

/** UTF-8 text without NUL bytes, or null (binary / another encoding). A leading BOM is dropped. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

export type Classified = { ok: true; kind: AttachmentKind; mediaType: string } | { ok: false; reason: string };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MIB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MIB).toFixed(n < 10 * MIB ? 1 : 0)} MB`;
}

/** Size cap of one attachment of `kind` (images: before scaling down). */
export function kindLimit(kind: AttachmentKind): number {
  return kind === 'image' ? MAX_IMAGE_ATTACH_BYTES : kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
}

/**
 * Type of an attachment from its name AND content: the extension picks the kind, the magic bytes must agree
 * (a `.png` that is not a PNG, a `.txt` that is binary and an unknown extension are refused). Size is checked
 * separately (images may still be scaled down).
 */
export function classifyAttachment(name: string, bytes: Uint8Array): Classified {
  const ext = extOf(name);
  const magic = sniffMagic(bytes);
  const image = IMAGE_EXT[ext];
  if (image) {
    return magic === image ? { ok: true, kind: 'image', mediaType: image } : { ok: false, reason: `내용이 .${ext} 이미지가 아닙니다` };
  }
  if (ext === 'pdf') {
    return magic === 'application/pdf' ? { ok: true, kind: 'pdf', mediaType: 'application/pdf' } : { ok: false, reason: '내용이 PDF가 아닙니다' };
  }
  const textType = TEXT_EXT[ext] ?? (ext === '' && TEXT_NAMES.has(name.split('/').pop()!.toLowerCase()) ? 'text/plain' : undefined);
  if (textType) {
    if (magic !== null || decodeText(bytes) === null) return { ok: false, reason: 'UTF-8 텍스트 파일이 아닙니다' };
    return { ok: true, kind: 'text', mediaType: textType };
  }
  return { ok: false, reason: ext ? `.${ext} 파일은 첨부할 수 없습니다` : '형식을 알 수 없는 파일입니다' };
}

/** Why an attachment of `kind` and `size` is too large, or null. */
export function sizeProblem(kind: AttachmentKind, size: number): string | null {
  if (size === 0) return '빈 파일입니다';
  const limit = kindLimit(kind);
  if (size <= limit) return null;
  const what = kind === 'image' ? '이미지는' : kind === 'pdf' ? 'PDF는' : '텍스트 파일은';
  return `${what} ${formatBytes(limit)}까지 첨부할 수 있습니다`;
}

/**
 * Count / total-size admission: keeps `incoming` in order while the message stays within MAX_ATTACHMENTS and
 * MAX_ATTACH_TOTAL_BYTES; the rest come back with a reason.
 */
export function admitAttachments<T extends { size: number; name: string }>(
  current: readonly { size: number }[],
  incoming: readonly T[],
): { accepted: T[]; rejected: { name: string; reason: string }[] } {
  let count = current.length;
  let total = current.reduce((sum, a) => sum + a.size, 0);
  const accepted: T[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const item of incoming) {
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ name: item.name, reason: `한 메시지에 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다` });
    } else if (total + item.size > MAX_ATTACH_TOTAL_BYTES) {
      rejected.push({ name: item.name, reason: `첨부는 합계 ${formatBytes(MAX_ATTACH_TOTAL_BYTES)}까지입니다` });
    } else {
      accepted.push(item);
      count += 1;
      total += item.size;
    }
  }
  return { accepted, rejected };
}

/**
 * Prompt capabilities assumed for an ACP agent before its session reports them (draft, a thread whose session never
 * opened). Codex: what the bundled codex-acp advertises (image + embeddedContext). Hermes: nothing beyond text.
 * Claude Code runs on the SDK and takes every kind (null).
 */
export function defaultPromptCaps(agent: AgentKind): AcpPromptCaps | null {
  if (agent === 'claude-code') return null;
  if (agent === 'codex') return { image: true, audio: false, embeddedContext: true };
  return { image: false, audio: false, embeddedContext: false };
}

/** ACP `PromptCapabilities` reduced to booleans (absent = false, as the protocol defines). */
export function liteCaps(raw: unknown): AcpPromptCaps {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { image: r.image === true, audio: r.audio === true, embeddedContext: r.embeddedContext === true };
}

/**
 * Why `agent` cannot take an attachment, or null. `caps` = the session's reported prompt capabilities (null for
 * Claude). ACP: images need `image`; text needs `embeddedContext` (resource block) or a file on disk
 * (`linkable`: resource_link); PDFs and other binaries are refused (no ACP capability covers them).
 */
export function unsupportedReason(
  agent: AgentKind,
  caps: AcpPromptCaps | null,
  a: { kind: AttachmentKind; linkable: boolean },
  agentName: string,
): string | null {
  if (agent === 'claude-code') return null;
  const c = caps ?? defaultPromptCaps(agent) ?? { image: false, audio: false, embeddedContext: false };
  if (a.kind === 'image') return c.image ? null : `${agentName}은(는) 이미지 첨부를 지원하지 않습니다`;
  if (a.kind === 'pdf') return `${agentName}은(는) PDF 첨부를 지원하지 않습니다`;
  return c.embeddedContext || a.linkable ? null : `${agentName}은(는) 붙여넣은 텍스트 파일을 받을 수 없습니다`;
}

/** Claude Messages API user content blocks (the subset the composer sends). */
export type ClaudePromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string } | { type: 'text'; media_type: 'text/plain'; data: string };
      title: string;
    };

/** SDK user content: plain text, or images, then documents (PDF base64 / plain text), then the typed text. */
export function claudePromptContent(text: string, images: readonly ChatImage[] = [], files: readonly PromptFile[] = []): string | ClaudePromptBlock[] {
  if (images.length === 0 && files.length === 0) return text;
  return [
    ...images.map((img): ClaudePromptBlock => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    ...files.map(
      (f): ClaudePromptBlock => ({
        type: 'document',
        source: f.kind === 'pdf' ? { type: 'base64', media_type: 'application/pdf', data: f.data } : { type: 'text', media_type: 'text/plain', data: f.data },
        title: f.name,
      }),
    ),
    { type: 'text', text },
  ];
}

/** `file://` URI of an absolute POSIX path (each segment percent-encoded). */
export function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * ACP `session/prompt` blocks for `caps`: images as image blocks, text files as an embedded `resource` (text) with
 * embeddedContext or a `resource_link` to the file otherwise, then the typed text. Whatever the agent cannot take
 * comes back in `dropped` (names) so the runner can say so.
 */
export function acpPromptBlocks(
  text: string,
  images: readonly ChatImage[],
  files: readonly PromptFile[],
  caps: AcpPromptCaps,
): { blocks: ContentBlock[]; dropped: string[] } {
  const blocks: ContentBlock[] = [];
  const dropped: string[] = [];
  images.forEach((img, i) => {
    if (caps.image) blocks.push({ type: 'image', mimeType: img.mediaType, data: img.data });
    else dropped.push(`이미지 ${i + 1}`);
  });
  for (const f of files) {
    if (f.kind !== 'text') {
      dropped.push(f.name);
    } else if (caps.embeddedContext) {
      const uri = f.path ? fileUri(f.path) : `attachment:///${encodeURIComponent(f.name)}`;
      blocks.push({ type: 'resource', resource: { uri, mimeType: f.mediaType, text: f.data } });
    } else if (f.path) {
      blocks.push({ type: 'resource_link', uri: fileUri(f.path), name: f.name, mimeType: f.mediaType, size: f.size });
    } else {
      dropped.push(f.name);
    }
  }
  blocks.push({ type: 'text', text });
  return { blocks, dropped };
}
