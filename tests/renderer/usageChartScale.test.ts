import { describe, expect, it } from 'vitest';
import type { UsageSample } from '../../src/shared/types';
import {
  CHART_RANGE_MS,
  CHART_Y_TICKS,
  DEFAULT_CHART_GEOMETRY,
  chartDomain,
  scaleX,
  scaleY,
  seriesLinePath,
  seriesPoints,
  yTickPositions,
  type ChartGeometry,
} from '../../src/renderer/components/Accounts/usageChartScale';

const GEO: ChartGeometry = DEFAULT_CHART_GEOMETRY;

function sample(partial: Partial<UsageSample> & { at: number }): UsageSample {
  return { fiveHour: null, sevenDay: null, fable: null, ...partial };
}

describe('chartDomain', () => {
  it('returns [now - rangeMs, now] for 24h', () => {
    const now = 1_000_000;
    expect(chartDomain(now, '24h')).toEqual([now - CHART_RANGE_MS['24h'], now]);
  });

  it('returns [now - rangeMs, now] for 7d, wider than 24h', () => {
    const now = 1_000_000;
    const [from7d] = chartDomain(now, '7d');
    const [from24h] = chartDomain(now, '24h');
    expect(from7d).toBeLessThan(from24h);
    expect(CHART_RANGE_MS['7d']).toBe(7 * CHART_RANGE_MS['24h']);
  });
});

describe('scaleX', () => {
  it('maps the domain start to the left padding', () => {
    const domain: [number, number] = [0, 1000];
    expect(scaleX(0, domain)).toBe(GEO.paddingLeft);
  });

  it('maps the domain end to width - right padding', () => {
    const domain: [number, number] = [0, 1000];
    expect(scaleX(1000, domain)).toBeCloseTo(GEO.width - GEO.paddingRight, 5);
  });

  it('maps the midpoint to the horizontal center of the plot area', () => {
    const domain: [number, number] = [0, 1000];
    const innerWidth = GEO.width - GEO.paddingLeft - GEO.paddingRight;
    expect(scaleX(500, domain)).toBeCloseTo(GEO.paddingLeft + innerWidth / 2, 5);
  });

  it('clamps timestamps outside the domain instead of extrapolating', () => {
    const domain: [number, number] = [0, 1000];
    expect(scaleX(-500, domain)).toBe(GEO.paddingLeft);
    expect(scaleX(5000, domain)).toBeCloseTo(GEO.width - GEO.paddingRight, 5);
  });

  it('degenerate zero-width domain collapses to the left padding', () => {
    expect(scaleX(42, [42, 42])).toBe(GEO.paddingLeft);
  });
});

describe('scaleY', () => {
  it('maps 0% to the bottom of the plot area', () => {
    expect(scaleY(0)).toBeCloseTo(GEO.height - GEO.paddingBottom, 5);
  });

  it('maps 100% to the top of the plot area', () => {
    expect(scaleY(100)).toBeCloseTo(GEO.paddingTop, 5);
  });

  it('maps 50% to the vertical center of the plot area', () => {
    const innerHeight = GEO.height - GEO.paddingTop - GEO.paddingBottom;
    expect(scaleY(50)).toBeCloseTo(GEO.paddingTop + innerHeight / 2, 5);
  });

  it('clamps out-of-range percents', () => {
    expect(scaleY(-20)).toBeCloseTo(GEO.height - GEO.paddingBottom, 5);
    expect(scaleY(150)).toBeCloseTo(GEO.paddingTop, 5);
  });
});

describe('seriesPoints', () => {
  const domain: [number, number] = [1000, 2000];

  it('drops samples with a null value for the requested key', () => {
    const samples = [sample({ at: 1500, fiveHour: 40 }), sample({ at: 1600, fiveHour: null })];
    expect(seriesPoints(samples, 'fiveHour', domain)).toHaveLength(1);
  });

  it('drops samples outside the domain', () => {
    const samples = [sample({ at: 500, fiveHour: 10 }), sample({ at: 1500, fiveHour: 40 }), sample({ at: 2500, fiveHour: 90 })];
    const points = seriesPoints(samples, 'fiveHour', domain);
    expect(points).toHaveLength(1);
    expect(points[0].at).toBe(1500);
  });

  it('sorts by time regardless of input order', () => {
    const samples = [sample({ at: 1800, fiveHour: 80 }), sample({ at: 1200, fiveHour: 20 })];
    const points = seriesPoints(samples, 'fiveHour', domain);
    expect(points.map((p) => p.at)).toEqual([1200, 1800]);
  });

  it('converts percent/at into pixel x/y using scaleX/scaleY', () => {
    const samples = [sample({ at: 1500, sevenDay: 50 })];
    const points = seriesPoints(samples, 'sevenDay', domain);
    expect(points[0].x).toBeCloseTo(scaleX(1500, domain), 5);
    expect(points[0].y).toBeCloseTo(scaleY(50), 5);
    expect(points[0].percent).toBe(50);
  });

  it('returns an empty array when there are no samples', () => {
    expect(seriesPoints([], 'fable', domain)).toEqual([]);
  });

  it('reads independently per series key on the same sample', () => {
    const samples = [sample({ at: 1500, fiveHour: 10, sevenDay: null, fable: 30 })];
    expect(seriesPoints(samples, 'fiveHour', domain)).toHaveLength(1);
    expect(seriesPoints(samples, 'sevenDay', domain)).toHaveLength(0);
    expect(seriesPoints(samples, 'fable', domain)).toHaveLength(1);
  });
});

describe('seriesLinePath', () => {
  it('returns an empty string for no points', () => {
    expect(seriesLinePath([])).toBe('');
  });

  it('starts with M for the first point and L for the rest', () => {
    const d = seriesLinePath([
      { x: 0, y: 10, at: 0, percent: 0 },
      { x: 5, y: 20, at: 1, percent: 10 },
      { x: 10, y: 30, at: 2, percent: 20 },
    ]);
    expect(d).toBe('M0 10 L5 20 L10 30');
  });

  it('renders a lone point as a single M segment', () => {
    expect(seriesLinePath([{ x: 1.005, y: 2.004, at: 0, percent: 0 }])).toBe('M1 2');
  });
});

describe('yTickPositions', () => {
  it('returns one entry per CHART_Y_TICKS value, in order', () => {
    const ticks = yTickPositions();
    expect(ticks.map((t) => t.percent)).toEqual([...CHART_Y_TICKS]);
  });

  it('ticks are monotonically decreasing in y as percent increases (SVG y grows downward)', () => {
    const ticks = yTickPositions();
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].y).toBeLessThan(ticks[i - 1].y);
    }
  });
});
