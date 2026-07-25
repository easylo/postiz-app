import { FC, useMemo } from 'react';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Views gained, laid out as day of week against hour of day.
 *
 * The bucketing happens here rather than on the server because the reading only
 * means anything in the viewer's own timezone, and `new Date` already knows it.
 * The server sends the raw UTC series precisely so this stays exact for the
 * timezones offset by half an hour.
 */
export const HeatmapGrid: FC<{
  points: Array<{ at: string; value: number }>;
}> = ({ points }) => {
  const grid = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => new Array(24).fill(0));

    for (const point of points) {
      const at = new Date(point.at);
      cells[at.getDay()][at.getHours()] += point.value;
    }

    return cells;
  }, [points]);

  const max = useMemo(
    () => Math.max(...grid.flat(), 1),
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
            {row.map((value, hour) => (
              <div
                key={hour}
                title={`${DAYS[day]} ${hour}:00 — ${value.toLocaleString()}`}
                className="flex-1 h-[18px] rounded-[3px] bg-[#612bd3]"
                // Opacity rather than a colour scale: it keeps the empty cells
                // readable against both themes without a second palette.
                style={{ opacity: value === 0 ? 0.06 : 0.15 + (value / max) * 0.85 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
