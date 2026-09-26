import { describe, expect, it } from 'vitest';
import { SPRITES, SPRITE_GRID, SPRITE_PALETTE, hashString, spriteForType, spriteRects } from '../../src/renderer/components/Subagents/sprites';

describe('subagent pixel sprites', () => {
  it('ships 6-8 distinct characters on a 12x12 grid with known palette keys', () => {
    expect(SPRITES.length).toBeGreaterThanOrEqual(6);
    expect(SPRITES.length).toBeLessThanOrEqual(8);
    expect(new Set(SPRITES.map((s) => s.id)).size).toBe(SPRITES.length);
    for (const sprite of SPRITES) {
      expect(sprite.rows).toHaveLength(SPRITE_GRID);
      for (const row of sprite.rows) {
        expect(row).toHaveLength(SPRITE_GRID);
        for (const key of row) expect(key === '.' || key in SPRITE_PALETTE).toBe(true);
      }
    }
  });

  it('selects the same character for the same subagent type (deterministic, case/space-insensitive)', () => {
    for (const type of ['Explore', 'code-reviewer', 'general-purpose', 'Plan', 'executor']) {
      expect(spriteForType(type)).toBe(spriteForType(type));
      expect(spriteForType(` ${type.toUpperCase()} `)).toBe(spriteForType(type));
    }
    expect(hashString('Explore')).toBe(hashString('Explore'));
    expect(spriteForType('explore').id).toBe(SPRITES[hashString('explore') % SPRITES.length]!.id);
  });

  it('spreads common agent types over several characters', () => {
    const ids = new Set(['Explore', 'code-reviewer', 'general-purpose', 'Plan', 'verifier', 'test-engineer'].map((t) => spriteForType(t).id));
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });

  it('merges pixel runs into rects that cover exactly the opaque pixels', () => {
    for (const sprite of SPRITES) {
      const opaque = sprite.rows.join('').replace(/\./g, '').length;
      const covered = spriteRects(sprite).reduce((n, r) => n + r.w, 0);
      expect(covered).toBe(opaque);
    }
  });
});
