// Pure geometry helpers for UsageChart's SVG line chart (no library -- spec: "SVG 직접 그리기, 라이브러리
// 추가 금지"). Kept dependency-free and framework-free so it is trivially unit tested
// (tests/renderer/usageChartScale.test.ts) without mounting the component.
import type { UsageSample } from '../../../shared/types';

export interface ChartGeometry {
  width: number;
  height: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
}

/** Matches UsageChart's default SVG viewBox. */
export const DEFAULT_CHART_GEOMETRY: ChartGeometry = {
  width: 280,
  height: 96,
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 2,
  paddingRight: 2,
};

export type ChartRange = '24h' | '7d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CHART_RANGE_MS: Record<ChartRange, number> = {
  '24h': HOUR_MS * 24,
  '7d': DAY_MS * 7,
};

export type UsageSeriesKey = 'fiveHour' | 'sevenDay' | 'fable';

/** [from, to] window ending at `now` for the given range. */
export function chartDomain(now: number, range: ChartRange): readonly [number, number] {
  return [now - CHART_RANGE_MS[range], now];
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Maps an epoch-ms timestamp to an x pixel within the geometry's plot area (clamped to the domain). */
export function scaleX(at: number, domain: readonly [number, number], geometry: ChartGeometry = DEFAULT_CHART_GEOMETRY): number {
  const [from, to] = domain;
  const span = to - from;
  const innerWidth = geometry.width - geometry.paddingLeft - geometry.paddingRight;
  if (span <= 0) return geometry.paddingLeft;
  return geometry.paddingLeft + clamp01((at - from) / span) * innerWidth;
}

/** Maps a 0..100 percent to a y pixel (0% at the bottom, 100% at the top; clamped). */
export function scaleY(percent: number, geometry: ChartGeometry = DEFAULT_CHART_GEOMETRY): number {
  const innerHeight = geometry.height - geometry.paddingTop - geometry.paddingBottom;
  return geometry.paddingTop + (1 - clamp01(percent / 100)) * innerHeight;
}

export interface ChartPoint {
  x: number;
  y: number;
  at: number;
  percent: number;
}

/**
 * Samples with a non-null value for `key`, restricted to the domain and sorted by time, converted to
 * pixel coordinates. Samples outside the domain are dropped (not clamped) so the line only spans data
 * that actually falls in the visible window.
 */
export function seriesPoints(
  samples: readonly UsageSample[],
  key: UsageSeriesKey,
  domain: readonly [number, number],
  geometry: ChartGeometry = DEFAULT_CHART_GEOMETRY,
): ChartPoint[] {
  const [from, to] = domain;
  return samples
    .filter((s): s is UsageSample & Record<UsageSeriesKey, number> => s[key] !== null && s.at >= from && s.at <= to)
    .sort((a, b) => a.at - b.at)
    .map((s) => ({
      x: scaleX(s.at, domain, geometry),
      y: scaleY(s[key], geometry),
      at: s.at,
      percent: s[key],
    }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** SVG path `d` for a polyline through the points (`''` for 0 points; a 1-point "path" is just the point itself). */
export function seriesLinePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x)} ${round2(p.y)}`).join(' ');
}

/** Fixed horizontal gridlines (spec has no requirement beyond "추이 표시"; 0/50/100 keeps it legible). */
export const CHART_Y_TICKS: readonly number[] = [0, 50, 100];

export interface ChartYTick {
  percent: number;
  y: number;
}

export function yTickPositions(geometry: ChartGeometry = DEFAULT_CHART_GEOMETRY): ChartYTick[] {
  return CHART_Y_TICKS.map((percent) => ({ percent, y: scaleY(percent, geometry) }));
}
