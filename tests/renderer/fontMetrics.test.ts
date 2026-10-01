// Overlay fonts register with their OS/2 typo metrics so an oversized hhea/win ascent cannot blow up line boxes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { typoMetricOverrides } from '../../src/renderer/theme/fontMetrics';

const FONTS = join(__dirname, '../../src/renderer/assets/fonts');
const buf = (name: string) => {
  const b = readFileSync(join(FONTS, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** Minimal sfnt: head (unitsPerEm) + OS/2 (typo metrics) + hhea (ascent / descent, default an oversized 2em box). */
function sfnt(upm: number, asc: number, desc: number, gap: number, hAsc = upm * 1.3, hDesc = -upm * 0.7): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(12 + 48 + 54 + 78 + 36));
  out.setUint32(0, 0x00010000);
  out.setUint16(4, 3);
  const head = 12 + 48;
  const os2 = head + 54;
  const hhea = os2 + 78;
  out.setUint32(44, 0x68686561);
  out.setUint32(52, hhea);
  out.setInt16(hhea + 4, Math.round(hAsc));
  out.setInt16(hhea + 6, Math.round(hDesc));
  out.setUint32(12, 0x68656164);
  out.setUint32(20, head);
  out.setUint32(28, 0x4f532f32);
  out.setUint32(36, os2);
  out.setUint16(head + 18, upm);
  out.setInt16(os2 + 68, asc);
  out.setInt16(os2 + 70, desc);
  out.setInt16(os2 + 72, gap);
  return out.buffer;
}

describe('typoMetricOverrides', () => {
  it('reads the typo metrics as percentages of the em', () => {
    expect(typoMetricOverrides(sfnt(2048, 1536, -512, 0))).toEqual({
      ascentOverride: '75%',
      descentOverride: '25%',
      lineGapOverride: '0%',
    });
  });

  it('a font with a sane hhea box keeps its own metrics', () => {
    expect(typoMetricOverrides(sfnt(1000, 675, -150, 0, 975, -225))).toBeNull();
    // Real bundled TTF: parses without throwing (null or overrides depending on its hhea box).
    expect(() => typoMetricOverrides(buf('Silkscreen-Regular.ttf'))).not.toThrow();
  });

  it('null for non-sfnt data, truncated tables or nonsense metrics', () => {
    expect(typoMetricOverrides(new TextEncoder().encode('wOF2xxxxxxxxxxxx').buffer as ArrayBuffer)).toBeNull();
    expect(typoMetricOverrides(new ArrayBuffer(4))).toBeNull();
    expect(typoMetricOverrides(sfnt(2048, 0, 0, 0))).toBeNull();
    expect(typoMetricOverrides(sfnt(0, 1536, -512, 0))).toBeNull();
  });
});
