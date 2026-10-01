// Vertical metrics of an sfnt (TTF / OTF) font. Some overlay fonts (e.g. game pixel fonts) ship oversized hhea ascent +
// descent (~2em), which blows up `line-height: normal` and clips glyphs inside fixed-height chips. Such a face is
// registered with its OS/2 typo metrics as overrides; a font whose hhea box is already sane keeps its own metrics
// (typo metrics of CJK fonts are often tighter than the Hangul glyphs).

export interface FontMetricOverrides {
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
}

/** hhea ascent + descent above this many em counts as oversized. */
const MAX_HHEA_EM = 1.5;

const SFNT_TAGS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

/** null for anything that is not a plain sfnt with a usable OS/2 table (woff/woff2 stay as they are). */
export function typoMetricOverrides(buf: ArrayBuffer): FontMetricOverrides | null {
  if (buf.byteLength < 12) return null;
  const v = new DataView(buf);
  if (!SFNT_TAGS.has(v.getUint32(0))) return null;
  const numTables = v.getUint16(4);
  let head = -1;
  let os2 = -1;
  let hhea = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.byteLength) return null;
    const tag = v.getUint32(rec);
    const offset = v.getUint32(rec + 8);
    if (tag === 0x68656164 /* head */) head = offset;
    if (tag === 0x4f532f32 /* OS/2 */) os2 = offset;
    if (tag === 0x68686561 /* hhea */) hhea = offset;
  }
  if (head < 0 || os2 < 0 || head + 20 > buf.byteLength || os2 + 74 > buf.byteLength) return null;
  const upm = v.getUint16(head + 18);
  if (upm > 0 && hhea >= 0 && hhea + 10 <= buf.byteLength) {
    const box = v.getInt16(hhea + 4) - v.getInt16(hhea + 6);
    if (box > 0 && box / upm <= MAX_HHEA_EM) return null;
  }
  const ascender = v.getInt16(os2 + 68);
  const descender = v.getInt16(os2 + 70);
  const lineGap = v.getInt16(os2 + 72);
  if (upm <= 0 || ascender <= 0 || descender > 0 || ascender - descender <= 0) return null;
  const pct = (n: number) => `${Math.round((n / upm) * 1000) / 10}%`;
  return { ascentOverride: pct(ascender), descentOverride: pct(-descender), lineGapOverride: pct(Math.max(0, lineGap)) };
}
