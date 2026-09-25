import { useMemo } from 'react';
import type { UsageSample } from '../../../shared/types';
import { formatPercent } from '../../../core/format';
import { Segmented, type SegmentedOption } from '../common';
import {
  CHART_RANGE_MS,
  DEFAULT_CHART_GEOMETRY,
  chartDomain,
  seriesLinePath,
  seriesPoints,
  yTickPositions,
  type ChartRange,
} from './usageChartScale';
import './AccountsPage.css';

export interface UsageChartProps {
  samples: UsageSample[];
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  now: number;
}

/** Points per series needed before the trend line is drawn. */
const MIN_TREND_POINTS = 3;

const RANGE_OPTIONS: readonly SegmentedOption<ChartRange>[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
];

interface SeriesSpec {
  key: 'fiveHour' | 'sevenDay' | 'fable';
  label: string;
  varName: string;
}

const SERIES: readonly SeriesSpec[] = [
  { key: 'fiveHour', label: '5h', varName: '--accent' },
  { key: 'sevenDay', label: 'wk', varName: '--ok' },
  { key: 'fable', label: 'fable', varName: '--warn' },
];

/** Latest non-null value for a series, for the legend's trailing percent. */
function latestValue(samples: readonly UsageSample[], key: SeriesSpec['key']): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = samples[i][key];
    if (v !== null) return v;
  }
  return null;
}

/**
 * Dependency-free SVG line chart of a single account's 5h/wk/fable usage trend (spec: "SVG 직접 그리기,
 * 라이브러리 추가 금지"). Geometry comes from usageChartScale.ts (unit tested separately); this component
 * only wires samples -> paths and renders them.
 */
export function UsageChart({ samples, range, onRangeChange, now }: UsageChartProps) {
  const domain = useMemo(() => chartDomain(now, range), [now, range]);
  const ticks = useMemo(() => yTickPositions(), []);
  const series = useMemo(
    () =>
      SERIES.map((spec) => {
        const points = seriesPoints(samples, spec.key, domain);
        return { spec, points, d: seriesLinePath(points) };
      }),
    [samples, domain],
  );
  const hasAnyData = series.some((s) => s.points.length > 0);
  // With 1-2 samples a line chart is just stray dots: show the latest values as bars until a trend exists.
  const collecting = hasAnyData && Math.max(...series.map((s) => s.points.length)) < MIN_TREND_POINTS;
  const rangeMs = CHART_RANGE_MS[range];

  return (
    <div className="hc-chart">
      <div className="hc-chart__head">
        <div className="hc-chart__legend">
          {SERIES.map((spec) => {
            const v = latestValue(samples, spec.key);
            return (
              <span key={spec.key} className="hc-chart__legend-item">
                <span className="hc-chart__legend-dot" style={{ background: `var(${spec.varName})` }} aria-hidden />
                {spec.label} <span className="hc-chart__legend-value">{formatPercent(v)}</span>
              </span>
            );
          })}
        </div>
        <Segmented aria-label="Usage chart range" size="sm" options={RANGE_OPTIONS} value={range} onChange={onRangeChange} />
      </div>

      {collecting ? (
        <div className="hc-chart__collecting">
          {SERIES.map((spec) => {
            const v = latestValue(samples, spec.key);
            return v === null ? null : (
              <div key={spec.key} className="hc-chart__bar-row">
                <span className="hc-chart__bar-label">{spec.label}</span>
                <span className="hc-chart__bar-track">
                  <span
                    className="hc-chart__bar-fill"
                    style={{ width: `${Math.min(100, Math.max(0, v))}%`, background: `var(${spec.varName})` }}
                  />
                </span>
              </div>
            );
          })}
          <div className="hc-chart__collecting-note">Collecting data… the trend appears after a few samples.</div>
        </div>
      ) : hasAnyData ? (
        <svg
          className="hc-chart__svg"
          viewBox={`0 0 ${DEFAULT_CHART_GEOMETRY.width} ${DEFAULT_CHART_GEOMETRY.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Usage trend over the last ${rangeMs / 3_600_000} hours`}
        >
          {ticks.map((tick) => (
            <line
              key={tick.percent}
              className="hc-chart__gridline"
              x1={0}
              x2={DEFAULT_CHART_GEOMETRY.width}
              y1={tick.y}
              y2={tick.y}
            />
          ))}
          {series.map(({ spec, points, d }) =>
            d ? (
              <path
                key={spec.key}
                className="hc-chart__line"
                d={d}
                style={{ stroke: `var(${spec.varName})` }}
                fill="none"
              />
            ) : null,
          )}
          {series.map(({ spec, points }) => {
            const last = points[points.length - 1];
            return last ? (
              <circle
                key={spec.key}
                className="hc-chart__dot"
                cx={last.x}
                cy={last.y}
                r={1.6}
                style={{ fill: `var(${spec.varName})` }}
              />
            ) : null;
          })}
        </svg>
      ) : (
        <div className="hc-chart__empty">No usage data yet</div>
      )}
    </div>
  );
}
