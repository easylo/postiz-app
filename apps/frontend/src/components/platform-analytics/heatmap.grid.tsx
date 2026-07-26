import { FC, useMemo } from 'react';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Opacity rather than a colour scale: it keeps the empty cells readable against
// both themes without a second palette. Shared with the legend below so the
// swatches can never drift from the cells they claim to explain.
const cellOpacity = (value: number, max: number) =>
  value === 0 ? 0.06 : 0.15 + (value / max) * 0.85;

/**
 * Views gained, laid out as day of week against hour of day.
 *
 * The bucketing happens here rather than on the server because the reading only
 * means anything in the viewer's own timezone, and `new Date` already knows it.
 * The server sends the raw UTC series precisely so this stays exact for the
 * timezones offset by half an hour.
 */
export const HeatmapGrid: FC<{
  points: Array<{ at: string; value: number; estimated?: boolean }>;
}> = ({ points }) => {
  const grid = useMemo(() => {
    const cells = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ value: 0, estimated: false }))
    );

    for (const point of points) {
      const at = new Date(point.at);
      const cell = cells[at.getDay()][at.getHours()];
      cell.value += point.value;
      // An hour is inferred as soon as anything inferred landed in it: a sweep
      // that skipped a night spreads that night's gain across hours nobody
      // measured, and drawing them like the rest is how a chart invents an
      // audience at 4am.
      cell.estimated = cell.estimated || !!point.estimated;
    }

    return cells;
  }, [points]);

  // The ramp divides by the peak so it has to floor at 1, but the legend must
  // name the reading that was actually taken — on a quiet week that is 0.
  const peak = useMemo(
    () => Math.max(...grid.flat().map((cell) => cell.value), 0),
    [grid]
  );
  const max = Math.max(peak, 1);
  const anyEstimated = useMemo(
    () => grid.flat().some((cell) => cell.estimated),
    [grid]
  );

  return (
    <div className="px-[16px] pb-[14px] overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="flex gap-[3px] mb-[4px] pl-[36px]">
          {Array.from({ length: 24 }, (_, hour) => (
            <div
              key={hour}
              className="flex-1 text-[10px] text-newTableText text-center"
            >
              {hour % 3 === 0 ? hour : ''}
            </div>
          ))}
        </div>
        {grid.map((row, day) => (
          <div key={day} className="flex items-center gap-[3px] mb-[3px]">
            <div className="w-[36px] text-[11px] text-newTableText">
              {DAYS[day]}
            </div>
            {row.map((cell, hour) => (
              <div
                key={hour}
                title={`${DAYS[day]} ${hour}:00 — ${cell.value.toLocaleString()}${
                  cell.estimated ? ' (estimated)' : ''
                }`}
                // The ring rides the card surface across the 3px gap rather
                // than the fill, so its contrast does not follow the opacity
                // ramp — the same reason the gain tape marks its inferred
                // buckets this way.
                className={`flex-1 h-[18px] rounded-[3px] ${
                  cell.estimated ? 'border-2 border-newTableText' : ''
                }`}
              >
                <div
                  className="w-full h-full rounded-[2px] bg-[#612bd3]"
                  style={{ opacity: cellOpacity(cell.value, max) }}
                />
              </div>
            ))}
          </div>
        ))}
        {/* The cells hide their value behind `title=`, which a touch or keyboard
            user never reaches; the scale states the encoding on the page. */}
        <div className="flex items-center gap-[4px] mt-[8px] pl-[36px] text-[10px] text-newTableText">
          <span className="tabular-nums">0</span>
          {[0, 1, 2, 3].map((step) => (
            <div
              key={step}
              className="w-[20px] h-[10px] rounded-[2px] bg-[#612bd3]"
              style={{ opacity: cellOpacity((peak * step) / 3, max) }}
            />
          ))}
          <span className="tabular-nums">{peak.toLocaleString()}</span>
          {/* Only when the grid actually holds one: a legend for a mark that is
              nowhere on screen teaches the reader to look for a distinction
              that does not exist here. */}
          {anyEstimated && (
            <>
              <span className="w-[10px]" />
              <span className="w-[14px] h-[14px] rounded-[3px] border-2 border-newTableText flex-none" />
              <span>estimated</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
