import { describe, expect, it } from 'vitest';
import { meterFill, meterLevel } from '../../src/core/meter';

describe('meterLevel', () => {
  it('is ok below the warn threshold', () => {
    expect(meterLevel(0)).toBe('ok');
    expect(meterLevel(69.9)).toBe('ok');
  });

  it('is warn between 70 and 89.9', () => {
    expect(meterLevel(70)).toBe('warn');
    expect(meterLevel(89.9)).toBe('warn');
  });

  it('is crit at 90 and above', () => {
    expect(meterLevel(90)).toBe('crit');
    expect(meterLevel(100)).toBe('crit');
  });
});

describe('meterFill', () => {
  it('clamps negative values to 0', () => {
    expect(meterFill(-5)).toBe(0);
  });

  it('clamps values above 100 to 1', () => {
    expect(meterFill(150)).toBe(1);
  });

  it('scales percent to 0..1', () => {
    expect(meterFill(47)).toBeCloseTo(0.47);
  });
});
