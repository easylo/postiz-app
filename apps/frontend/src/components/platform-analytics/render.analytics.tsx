import { FC, useCallback, useMemo } from 'react';
import { Integration } from '@prisma/client';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  VideoTable,
  AnalyticsVideoRow,
} from '@gitroom/frontend/components/platform-analytics/video.table';
import { HeatmapGrid } from '@gitroom/frontend/components/platform-analytics/heatmap.grid';

interface AnalyticsDataItem {
  label: string;
  // The API sends totals as strings. Typing them as numbers is what let a
  // string concatenation pass for an addition all the way to the screen.
  data: Array<{ total: string | number; date: string }>;
  average?: boolean;
  gauge?: boolean;
  percentage?: boolean;
  percentageChange?: number;
  // The change in the metric's own unit, the date it was measured from and how
  // many readings back it. All three come from the server, computed from the
  // same two points, so the card never derives a second delta that would
  // disagree with the first.
  absoluteChange?: number;
  changeFrom?: string;
  readings?: number;
  breakdown?: Array<{ key: string; value: number }>;
  videos?: AnalyticsVideoRow[];
  hourly?: Array<{ at: string; value: number }>;
}

// Reading dates arrive as `YYYY-MM-DD`. The day alone is enough on a card: the
// header line above the grid already says which year and which window.
//
// A date the payload never sent, or one dayjs cannot read, resolves to nothing
// rather than to the string `Invalid Date`, which every caller here would
// otherwise paste into a sentence as if it were a day.
const formatDay = (date?: string) => {
  if (!date) {
    return '';
  }

  const parsed = dayjs(date);

  return parsed.isValid() ? parsed.format('D MMM') : '';
};

/**
 * Two decimals below one, one above.
 *
 * An engagement rate moves by 0.07 points and a single decimal rounds that to a
 * tenth it never reached, while `+1,234.0` followers claims a precision a
 * counter of whole people does not have.
 */
const formatMagnitude = (value: number) => {
  const magnitude = Math.abs(value);

  if (Number.isInteger(magnitude)) {
    return magnitude.toLocaleString();
  }

  return magnitude < 1 ? magnitude.toFixed(2) : magnitude.toFixed(1);
};

const signed = (value: number, suffix: string) =>
  `${value > 0 ? '+' : '-'}${formatMagnitude(value)}${suffix}`;

// A reading shown among other readings carries no unit: the headline value
// above it already does, and repeating `%` six times along a trail is noise.
const formatReading = (value: number) =>
  Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);

/**
 * A ranked distribution, one bar each.
 *
 * One hue for the whole list on purpose. The comparison inside it is of
 * magnitude, which is sequential, and handing each list its own colour made hue
 * mean nothing beyond the position the API happened to return the metric in.
 */
const BreakdownList: FC<{
  entries: Array<{ key: string; value: number }>;
}> = ({ entries }) => {
  const max = Math.max(...entries.map((e) => e.value), 1);

  return (
    <div className="flex-1 flex flex-col gap-[10px] px-[16px] py-[12px]">
      {entries.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-[4px]">
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-newTableText truncate pr-[8px]">
              {entry.key}
            </span>
            <span className="font-medium tabular-nums">
              {entry.value.toLocaleString()}
            </span>
          </div>
          <div className="h-[6px] rounded-full bg-newTableBorder overflow-hidden">
            <div
              className="h-full rounded-full bg-[#612bd3]"
              style={{ width: `${(entry.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * The whole sentence about the change, and it always renders.
 *
 * Its predecessor returned nothing when the change was zero, so a metric that
 * genuinely never moved and a metric never read were the same blank space. On a
 * channel whose series are three daily readings long, telling those two apart is
 * most of what a card has to say.
 *
 * On a gauge the absolute change leads and the percentage follows in
 * parentheses: a channel that gained four followers gained four followers,
 * while `+100%` says more about how small the starting point was than about the
 * week.
 *
 * Only the glyph is coloured. `#32d583` at 13px is around 1.9:1 on a light
 * surface and fails contrast outright, so direction comes from the mark and the
 * sign, never from the colour of the number.
 */
const DeltaLine: FC<{ item: AnalyticsDataItem }> = ({ item }) => {
  const t = useT();

  const readings = item.readings ?? item.data?.length ?? 0;

  if (readings === 0) {
    return (
      <span className="text-[13px] text-newTableText">
        {t('analytics_no_readings', 'No readings yet')}
      </span>
    );
  }

  if (readings === 1) {
    const day = formatDay(item.data?.[0]?.date);

    return (
      <span className="text-[13px] text-newTableText">
        {day
          ? `${t('analytics_first_reading', 'First reading')} · ${day}`
          : t('analytics_first_reading', 'First reading')}
      </span>
    );
  }

  // The two kinds of series measured different things, so they say different
  // sentences. A gauge is a level: it moved by an amount, since a reading taken
  // on a day the payload names. An accrued series has neither — the server
  // compares the mean of the window's two halves, and no reading in the window
  // ever sat that far below the last one — so all it can report is the relative
  // move, about the period rather than about a date.
  const change = item.gauge ? item.absoluteChange : item.percentageChange;
  const from = formatDay(item.changeFrom);

  // A missing change is a comparison nobody ran, not a change of zero. These
  // payloads are cached for an hour, so for an hour after a deploy some of them
  // were computed by a server that sent no such field — and defaulting to 0 had
  // the card assert "No change" about metrics it had not measured. A gauge
  // whose date the payload cannot back up is the same case: there is no honest
  // day to point the reader at.
  if (
    change === undefined ||
    !Number.isFinite(change) ||
    (item.gauge && !from)
  ) {
    // The neutral line a series nobody compared gets. Not "First reading":
    // there are several here, they simply were never put side by side.
    return (
      <span className="text-[13px] text-newTableText">
        {t('analytics_change_not_measured', 'Change not measured')}
      </span>
    );
  }

  const when = item.gauge
    ? `${t('analytics_since', 'since')} ${from}`
    : t('analytics_vs_previous_period', 'vs previous period');

  if (change === 0) {
    return (
      <span className="flex items-baseline gap-[6px] text-[13px] text-newTableText">
        <span aria-hidden>–</span>
        <span>{`${t('analytics_no_change', 'No change')} ${when}`}</span>
      </span>
    );
  }

  // The unit the change is already in. A gauge moved in the metric's own unit,
  // and so did an accrued average — the server sends the gap between the two
  // halves' means there, not a ratio between them. Everything else accrues, and
  // its change is relative. `pp` iff the metric is itself a percentage: keying
  // that off `average` is what made a drop of twelve views per video read as
  // twelve points of a rate that does not exist.
  const suffix =
    item.gauge || item.average ? (item.percentage ? 'pp' : '') : '%';

  // The percentage only earns its parentheses when it adds something. On a rate
  // the server puts the same number in both fields, and an accrued series has
  // no absolute at all — `change` there is the relative move itself. The server
  // also reports 0% when the first reading was 0, because a relative change
  // from nothing has no value, and printing `(+0%)` beside a real gain would
  // deny the gain.
  const percentage = item.gauge && !item.percentage ? item.percentageChange : 0;
  const positive = change > 0;

  return (
    <span className="flex flex-wrap items-baseline gap-x-[6px] text-[13px]">
      <span
        aria-hidden
        className={positive ? 'text-[#32d583]' : 'text-[#f97066]'}
      >
        {positive ? '▲' : '▼'}
      </span>
      <span className="font-medium">
        {signed(change, suffix)}
        {percentage ? ` (${signed(percentage, '%')})` : ''}
      </span>
      <span className="text-newTableText">{when}</span>
    </span>
  );
};

/**
 * What the readings themselves look like — and nothing at all in the common
 * case.
 *
 * Under three readings the value and the delta already are the entire series,
 * and a flat one has nothing to add that "No change" has not said. Drawing it
 * regardless, on a forced zero baseline, is how three readings of four
 * followers became a full-height chart.
 */
const SeriesSlot: FC<{ item: AnalyticsDataItem }> = ({ item }) => {
  const values = useMemo(
    () =>
      (item.data || [])
        .map((point) => Number(point.total))
        .filter((value) => !isNaN(value)),
    [item.data]
  );

  if (values.length < 3) {
    return null;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) {
    return null;
  }

  if (values.length < 8) {
    // No dates along the trail: they are identical on every card and are stated
    // once, above the grid. Long trails fold their head rather than wrap twice.
    const shown =
      values.length > 6 ? [values[0], null, ...values.slice(-5)] : values;

    return (
      <span className="text-[12px] leading-[18px] text-newTableText tabular-nums">
        {shown
          .map((value) => (value === null ? '…' : formatReading(value)))
          .join(' → ')}
      </span>
    );
  }

  // The band is [min, max] inset 4px inside the 28px strip, so the stroke and
  // the end dot stay inside the box at both extremes. No zero baseline: a
  // follower count that never approached zero must not be drawn as if it had.
  const y = (value: number) => 4 + (1 - (value - min) / (max - min)) * 20;
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${y(value)}`)
    .join(' ');

  return (
    <div className="flex items-center gap-[8px]">
      <div className="relative flex-1 h-[28px]">
        {/* The viewBox is stretched to whatever width the card gets, which
            would stretch the stroke with it; `non-scaling-stroke` keeps 2px
            meaning 2px at one column and at three. */}
        <svg
          className="w-full h-full overflow-visible"
          viewBox="0 0 100 28"
          preserveAspectRatio="none"
          aria-hidden
        >
          <polyline
            points={points}
            fill="none"
            stroke="#612bd3"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div
          className="absolute w-[8px] h-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#612bd3] ring-2 ring-newTableHeader"
          style={{
            left: '100%',
            top: `${(y(values[values.length - 1]) / 28) * 100}%`,
          }}
        />
      </div>
      {/* The band has no zero in it, so its ends have to be named — otherwise
          the line claims a floor it never touched. */}
      <div className="flex flex-col justify-between h-[28px] text-[10px] leading-none text-newTableText tabular-nums">
        <span>{formatReading(max)}</span>
        <span>{formatReading(min)}</span>
      </div>
    </div>
  );
};

const AnalyticsCard: FC<{
  item: AnalyticsDataItem;
  total: string | number;
  integrationId: string;
}> = ({ item, total, integrationId }) => {
  const content = item.videos?.length ? (
    <div className="px-[16px] pb-[14px]">
      <VideoTable videos={item.videos} integrationId={integrationId} />
    </div>
  ) : item.hourly?.length ? (
    <HeatmapGrid points={item.hourly} />
  ) : item.breakdown?.length ? (
    <BreakdownList entries={item.breakdown} />
  ) : null;

  return (
    // A table needs the full row: three-column cards are far too narrow for it.
    <div
      className={`group relative ${
        item.videos?.length || item.hourly?.length ? 'col-span-full' : ''
      }`}
    >
      <div
        className={`
          flex flex-col h-full
          bg-newTableHeader
          border border-newTableBorder
          rounded-[12px]
          overflow-hidden
          transition-all duration-200
          hover:border-[#612bd3]/50
        `}
      >
        {content ? (
          <>
            <div className="px-[16px] pt-[14px] pb-[8px]">
              <span className="text-[15px] font-medium text-newTableText">
                {item.label}
              </span>
            </div>
            {content}
          </>
        ) : (
          // One layout for every scalar metric — the value, what it did, then
          // the readings behind it. The old fork drew a chart when there were
          // points and a 48px number when there were not, so the same follower
          // count looked like two different kinds of measurement from one day
          // to the next.
          <div className="flex flex-col h-full p-[16px] gap-[6px]">
            <span className="text-[13px] text-newTableText">{item.label}</span>
            {/* Proportional figures: `tabular-nums` is for columns that have to
                line up, not for a display value read on its own. */}
            <span className="text-[32px] leading-[36px] font-semibold tracking-tight">
              {total}
            </span>
            <DeltaLine item={item} />
            <SeriesSlot item={item} />
          </div>
        )}
      </div>
    </div>
  );
};

const EmptyState: FC<{ onRefresh: () => void }> = ({ onRefresh }) => {
  const t = useT();

  return (
    <div className="col-span-full flex flex-col items-center justify-center py-[48px] px-[24px] bg-newTableHeader border border-newTableBorder rounded-[12px]">
      <div className="w-[48px] h-[48px] mb-[16px] rounded-full bg-[#612bd3]/10 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-[#612bd3]"
        >
          <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path d="M12 8v4l2 2" />
        </svg>
      </div>
      <p className="text-[15px] text-newTableText text-center mb-[12px]">
        {t(
          'this_channel_needs_to_be_refreshed',
          'This channel needs to be refreshed to display analytics'
        )}
      </p>
      <button
        onClick={onRefresh}
        className="inline-flex items-center gap-[6px] px-[16px] py-[8px] text-[14px] font-medium text-white bg-[#612bd3] hover:bg-[#5023b8] rounded-[8px] transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
        {t('refresh_channel', 'Refresh Channel')}
      </button>
    </div>
  );
};

export const RenderAnalytics: FC<{
  integration: Integration;
  date: number;
}> = (props) => {
  const { integration, date } = props;
  const fetch = useFetch();

  const load = useCallback(
    async () =>
      (await fetch(`/analytics/${integration.id}?date=${date}`)).json(),
    [integration, date]
  );

  const { data, isLoading, isValidating } = useSWR(
    `/analytics-${integration?.id}-${date}`,
    load,
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      refreshWhenOffline: false,
      revalidateOnMount: true,
      // Changing the date changes the SWR key, and the whole grid used to be
      // replaced by a spinner for the round trip — a refetch that read as a
      // reset. The previous grid stays, dimmed, until the next one is ready.
      keepPreviousData: true,
    }
  );

  const refreshChannel = useCallback(
    (
        integrationData: Integration & {
          identifier: string;
        }
      ) =>
      async () => {
        const { url } = await (
          await fetch(
            `/integrations/social/${integrationData.identifier}?refresh=${integrationData.internalId}`,
            {
              method: 'GET',
            }
          )
        ).json();
        window.location.href = url;
      },
    []
  );

  const t = useT();

  const totals = useMemo(() => {
    return data?.map((p: AnalyticsDataItem) => {
      // The API sends every total as a string. `+` on strings concatenates, so
      // three readings of "4" followers used to render as 444, and a rate came
      // out as NaN once it had more than one point. Coerce before adding.
      const points = (p?.data || [])
        .map((d) => Number(d.total))
        .filter((n) => !isNaN(n));

      if (!points.length) {
        // Nothing was ever read. `0` is a measurement, and rendering one here
        // made an empty series indistinguishable from a channel at zero.
        return '—';
      }

      const sum = points.reduce((acc, curr) => acc + curr, 0);
      const value = p.gauge
        ? // A level, not an amount accrued: three readings of four followers
          // are not twelve followers. The latest reading is the answer.
          points[points.length - 1]
        : p.average
        ? sum / points.length
        : sum;

      // `average` says how to aggregate; `percentage` says how to render. An
      // average view duration is a mean measured in seconds, not a percentage.
      return p.percentage
        ? value.toFixed(2) + '%'
        : new Intl.NumberFormat().format(Math.round(value));
    });
  }, [data]);

  // Every card is built from the same daily snapshots, so their dates are
  // identical on all of them. Stated once, above everything they scope, rather
  // than repeated inside ten cards that would then all say the same thing.
  const readingWindow = useMemo(() => {
    const dates = Array.from(
      new Set(
        ((data || []) as AnalyticsDataItem[]).flatMap((p) =>
          (p?.data || []).map((point) => point.date).filter(Boolean)
        )
      )
    ).sort();

    if (!dates.length) {
      return '';
    }

    const first = dayjs(dates[0]);
    const last = dayjs(dates[dates.length - 1]);
    const span = first.isSame(last, 'day')
      ? last.format('D MMM')
      : first.isSame(last, 'month')
      ? `${first.format('D')}–${last.format('D MMM')}`
      : `${first.format('D MMM')} – ${last.format('D MMM')}`;

    // These are distinct dates, not days. A channel read twice a hundred days
    // apart has two readings in that window, and "2 daily snapshots" claims a
    // cadence nothing in the payload supports. Only readings that laid end to
    // end from the first one reach the last are daily. Walking the calendar
    // rather than dividing a duration: a window straddling a clock change is an
    // hour short of a whole number of days, and would lose the label it earned.
    // A single reading spans one day and so is always daily, which is why the
    // sparse wording needs no singular form.
    const snapshots = first.add(dates.length - 1, 'day').isSame(last, 'day')
      ? dates.length === 1
        ? t('analytics_daily_snapshot', 'daily snapshot')
        : t('analytics_daily_snapshots', 'daily snapshots')
      : t('analytics_readings_count', 'readings');

    return `${t('analytics_readings', 'Readings')} ${span} · ${
      dates.length
    } ${snapshots}`;
  }, [data, t]);

  // The spinner belongs to the very first load only. Past that there is always
  // a previous grid worth holding on screen while the next one arrives.
  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-[48px]">
        <LoadingComponent />
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col gap-[12px] transition-opacity duration-200 ${
        isValidating ? 'opacity-50 pointer-events-none' : ''
      }`}
    >
      {!!readingWindow && (
        <div className="text-[12px] text-newTableText">{readingWindow}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px]">
        {data?.length === 0 && (
          <EmptyState onRefresh={refreshChannel(integration as any)} />
        )}
        {data?.map((item: AnalyticsDataItem, index: number) => (
          <AnalyticsCard
            key={`analytics-${index}`}
            item={item}
            total={totals[index]}
            integrationId={integration.id}
          />
        ))}
      </div>
    </div>
  );
};
