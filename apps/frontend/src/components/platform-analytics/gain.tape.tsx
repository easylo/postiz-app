import { FC, ReactNode, useMemo } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export type GainTapePoint = {
  at: string;
  value: number;
  // Set by the server when the point was spread across a gap between two
  // sweeps: the height is real, the hour it lands in is inferred.
  estimated?: boolean;
};

type Unit = 'hour' | 'day';

type Bucket = {
  at: Date;
  value: number;
  measured: boolean;
  estimated: boolean;
};

// Beyond three days an hourly tape stops being one screen — 180 days of
// retention against an hourly sweep is some 4,300 cells — so it folds to days.
const HOURLY_SPAN_LIMIT = 72 * 60 * 60 * 1000;

const startOfBucket = (at: Date, unit: Unit) => {
  const floor = new Date(at);
  floor.setMinutes(0, 0, 0);
  if (unit === 'day') {
    floor.setHours(0);
  }
  return floor;
};

const dayLabel = (at: Date) =>
  at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Ink carries the value because every cell is the same size, and the ramp
// floors at 0.35 so the smallest gain is still a mark rather than a smudge —
// which is exactly why a true zero is not on this ramp and gets its own mark.
// Shared with the scale below so the swatch can never drift from the cell it
// claims to explain.
const cellInk = (value: number, max: number) => 0.35 + (value / max) * 0.65;

// A not-measured cell is hatched rather than merely outlined: measured against
// the card it sits on (`--new-table-header`), `--new-table-border` is 1.19:1 in
// dark and 1.13:1 in light, so the outline alone was invisible and an empty
// hour and a measured zero were the same 18px square to anyone not hovering.
// The hatch is the same idiom as `.repeated-strip` in global.scss.
const MISSING_HATCH =
  'repeating-linear-gradient(45deg, transparent, transparent 3px, var(--new-table-text) 3px, var(--new-table-text) 4px)';

// Spread readings arrive as fractions — a gain of 1 over a 3-hour gap is 0.33
// an hour — and rounding those to integers is what made a real +1 vanish.
const formatGain = (value: number) =>
  (Math.round(value * 100) / 100).toLocaleString();

// A label is centred on its cell, but on the first and last cell that pushes
// the text past the tape's own edge, where the scroll container clips it.
const anchorClass = (index: number, total: number) => {
  if (index === 0) {
    return 'left-0';
  }
  if (index === total - 1) {
    return 'right-0';
  }
  return 'left-1/2 -translate-x-1/2';
};

const LegendItem: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <span className="flex items-center gap-[5px]">
    {children}
    {label}
  </span>
);

/**
 * Views gained per bucket, one cell each, in the order they were read.
 *
 * Deliberately the same markup as `heatmap.grid.tsx` so the two read as one
 * idiom, with one difference that matters: there is no `Math.max(…, 1)` here.
 * A floor of 1 invents a ceiling nobody measured, and it would draw a lone
 * `+1` at full ink, so the five videos in the table would stop being
 * comparable to each other.
 *
 * The tape stays on screen when every cell is a measured zero. A row of dots
 * is the evidence of measurement that tells "flat" apart from "broken", which
 * is the whole reason this is a tape and not a line.
 */
export const GainTape: FC<{ points: GainTapePoint[] }> = ({ points }) => {
  const t = useT();

  const { buckets, unit, max } = useMemo(() => {
    const readings = (points || [])
      .map((point) => ({
        at: new Date(point.at),
        value: Number(point.value) || 0,
        estimated: !!point.estimated,
      }))
      .filter((point) => !isNaN(point.at.getTime()))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    if (!readings.length) {
      return { buckets: [] as Bucket[], unit: 'hour' as Unit, max: 0 };
    }

    const span =
      readings[readings.length - 1].at.getTime() - readings[0].at.getTime();
    const resolved: Unit = span <= HOURLY_SPAN_LIMIT ? 'hour' : 'day';

    // Every bucket between the first and the last reading is created, even the
    // ones no point falls into: an hour the sweep missed has to be drawn as a
    // hole, otherwise the tape quietly closes the gap and claims coverage it
    // never had.
    const list: Bucket[] = [];
    const cursor = startOfBucket(readings[0].at, resolved);
    const last = startOfBucket(readings[readings.length - 1].at, resolved);

    while (cursor.getTime() <= last.getTime()) {
      list.push({
        at: new Date(cursor),
        value: 0,
        measured: false,
        estimated: false,
      });
      // Stepped on the local calendar rather than by adding milliseconds, so
      // the 23- and 25-hour days around a DST change still line up with the
      // wall-clock ticks underneath.
      if (resolved === 'hour') {
        cursor.setHours(cursor.getHours() + 1);
      } else {
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const byTime = new Map(list.map((bucket) => [bucket.at.getTime(), bucket]));

    for (const reading of readings) {
      const bucket = byTime.get(startOfBucket(reading.at, resolved).getTime());
      if (!bucket) {
        continue;
      }
      bucket.value += reading.value;
      bucket.measured = true;
      // One inferred point taints the bucket: half a spread reading is still
      // not a reading, and the ring is what says so.
      bucket.estimated = bucket.estimated || reading.estimated;
    }

    return {
      buckets: list,
      unit: resolved,
      // The domain is [0, max(gain)] and nothing else. When nothing was gained
      // the max is 0 and no cell is filled — which is the true picture.
      max: list.reduce((top, bucket) => Math.max(top, bucket.value), 0),
    };
  }, [points]);

  // One label, on the tallest cell, never one per cell. A tape carrying a
  // number over every mark is a table wearing a chart's clothes.
  const peak = useMemo(
    () => (max > 0 ? buckets.findIndex((bucket) => bucket.value === max) : -1),
    [buckets, max]
  );

  if (!buckets.length) {
    return null;
  }

  const cellTitle = (bucket: Bucket) => {
    const when =
      unit === 'hour'
        ? bucket.at.toLocaleString()
        : bucket.at.toLocaleDateString();

    if (!bucket.measured) {
      return `${when} — ${t('gain_tape_not_measured', 'not measured')}`;
    }

    const amount = `+${formatGain(bucket.value)}`;

    return bucket.estimated
      ? `${when} — ${amount} (${t('gain_tape_estimated', 'estimated')})`
      : `${when} — ${amount}`;
  };

  const tickLabel = (bucket: Bucket, index: number) => {
    if (unit === 'day') {
      return index % 7 === 0 ? dayLabel(bucket.at) : '';
    }

    const hour = bucket.at.getHours();
    // Midnight names the day it opens instead of printing "00": the day is the
    // useful fact there, and the hour is implied by the label being a date.
    if (hour === 0) {
      return dayLabel(bucket.at);
    }

    return hour % 6 === 0 ? String(hour).padStart(2, '0') : '';
  };

  return (
    <div>
      <div className="overflow-x-auto">
        {/* The axis rule and its ticks are siblings in the flow, not an overlay
            on the cells: whatever height this block reports already counts the
            band, so the row hosting the tape can never clip the ticks. */}
        <div
          // 560px is the same floor `heatmap.grid.tsx` uses, but that grid is
          // always 24 columns and this tape can be 73. An 11px pitch leaves
          // ~8px of cell after the gap, which is the width at which a 6px dash
          // still reads as a dash and a 4px hatch still shows more than one
          // stripe; below that the four kinds stop being tellable apart, so a
          // long tape grows and scrolls instead of shrinking its marks.
          style={{ minWidth: Math.max(560, buckets.length * 11) }}
        >
          <div className="flex gap-[3px] h-[14px]">
            {buckets.map((bucket, index) => (
              <div key={index} className="flex-1 relative">
                {index === peak && (
                  <span
                    className={`absolute bottom-0 text-[10px] tabular-nums whitespace-nowrap ${anchorClass(
                      index,
                      buckets.length
                    )}`}
                  >
                    +{formatGain(bucket.value)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* An estimated cell wears a 2px ring in `--new-table-text`, not the
              hairline the comment above already calls unreadable. The ring's
              outer edge always meets the card across the 3px gap, where that
              ink is 6.1:1 in dark (#9c9c9c on #1e1d1d) and 4.0:1 in light
              (#777b7f on #f5f7f9). A mark laid over the fill instead would ride
              the 0.35→1 ink ramp and bottom out at 1.3:1 in light, so the mark
              has to sit where the card is, not where the value is. */}
          <div className="flex gap-[3px]">
            {buckets.map((bucket, index) => (
              <div
                key={index}
                title={cellTitle(bucket)}
                className={`flex-1 h-[18px] rounded-[3px] flex items-center justify-center ${
                  !bucket.measured
                    ? 'border border-newTableBorder'
                    : bucket.estimated
                    ? 'border-2 border-newTableText'
                    : ''
                }`}
                style={
                  bucket.measured
                    ? undefined
                    : { backgroundImage: MISSING_HATCH }
                }
              >
                {!bucket.measured ? null : bucket.value > 0 ? (
                  <div
                    className="w-full h-full rounded-[2px] bg-[#612bd3]"
                    style={{ opacity: cellInk(bucket.value, max) }}
                  />
                ) : (
                  // A dash at full ink, not a half-lit dot: a zero is a
                  // reading like any other, and it has to survive being read
                  // next to a hatched hour that is not a reading at all.
                  <span className="w-[6px] h-[2px] rounded-[1px] bg-newTableText" />
                )}
              </div>
            ))}
          </div>

          <div className="h-[1px] mt-[6px] bg-newTableBorder" />

          <div className="flex gap-[3px] h-[17px]">
            {buckets.map((bucket, index) => (
              <div key={index} className="flex-1 relative">
                <span
                  className={`absolute top-[3px] text-[10px] tabular-nums whitespace-nowrap text-newTableText ${anchorClass(
                    index,
                    buckets.length
                  )}`}
                >
                  {tickLabel(bucket, index)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Every cell but the peak hides its number behind `title=`, which a
          touch or keyboard reader never reaches, so the scale states the
          magnitude on the page. It sits outside the scroll container because a
          73-cell tape would otherwise push it past the right edge. The kinds
          legend below answers a different question — what a cell IS, not how
          much it counts — which is why both are here. */}
      {max > 0 && (
        <div className="flex items-center gap-[4px] mt-[8px] text-[10px] text-newTableText">
          {/* The floor swatch is `cellInk(0, max)`, but a measured zero never
              reaches this ramp — it is drawn as a dash — so 0.35 ink is the
              smallest gain above zero and cannot be labelled "+0". */}
          <span className="tabular-nums">&gt;0</span>
          {[0, 1, 2, 3].map((step) => (
            <div
              key={step}
              className="w-[20px] h-[10px] rounded-[2px] bg-[#612bd3]"
              style={{ opacity: cellInk((max * step) / 3, max) }}
            />
          ))}
          <span className="tabular-nums">+{formatGain(max)}</span>
        </div>
      )}

      {/* Always present, all four kinds. Three of them are shapes rather than
          shades, because a shade alone is unreadable on a light surface. */}
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px] mt-[8px] text-[11px] text-newTableText">
        <LegendItem label={t('gain_tape_legend_gain', 'Views gained')}>
          <span className="w-[14px] h-[12px] rounded-[3px] bg-[#612bd3] flex-none" />
        </LegendItem>
        <LegendItem label={t('gain_tape_legend_zero', 'Measured zero')}>
          <span className="w-[14px] h-[12px] rounded-[3px] flex-none flex items-center justify-center">
            <span className="w-[6px] h-[2px] rounded-[1px] bg-newTableText" />
          </span>
        </LegendItem>
        <LegendItem label={t('gain_tape_legend_estimated', 'Estimated')}>
          {/* Full ink, exactly like the gain swatch above, so the pair differs
              by the ring alone. A dimmed swatch here would teach the reader
              that faint means estimated, when in the tape it means small. */}
          <span className="w-[14px] h-[12px] rounded-[3px] border-2 border-newTableText flex-none flex items-center justify-center">
            <span className="w-full h-full rounded-[2px] bg-[#612bd3]" />
          </span>
        </LegendItem>
        <LegendItem label={t('gain_tape_legend_missing', 'Not measured')}>
          <span
            className="w-[14px] h-[12px] rounded-[3px] border border-newTableBorder flex-none"
            style={{ backgroundImage: MISSING_HATCH }}
          />
        </LegendItem>
      </div>
    </div>
  );
};
