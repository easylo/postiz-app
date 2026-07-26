import { FC, Fragment, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  GainTape,
  GainTapePoint,
} from '@gitroom/frontend/components/platform-analytics/gain.tape';

export type AnalyticsVideoRow = {
  id: string;
  title: string;
  url?: string;
  thumbnail?: string;
  date: string;
  views: number;
  likes: number;
  comments: number;
};

type VideoSortKey = 'date' | 'views' | 'likes' | 'comments';

const SortableHeader: FC<{
  label: string;
  sortBy: VideoSortKey;
  active: VideoSortKey;
  ascending: boolean;
  onSort: (key: VideoSortKey) => void;
  className?: string;
}> = ({ label, sortBy, active, ascending, onSort, className = '' }) => (
  <th className={`font-medium py-[8px] ${className}`}>
    <button
      type="button"
      onClick={() => onSort(sortBy)}
      className="inline-flex items-center gap-[4px] hover:text-white transition-colors"
    >
      {label}
      <span
        className={`text-[10px] ${
          active === sortBy ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {ascending ? '▲' : '▼'}
      </span>
    </button>
  </th>
);

/**
 * One hook, one useSWR — the analytics screen already follows that rule and
 * react-hooks/rules-of-hooks depends on it.
 *
 * Loaded on expand rather than with the table: a channel's ten videos carry
 * several thousand points between them, and nobody opens ten at once.
 */
const useVideoHistory = (integrationId: string, videoId: string) => {
  const fetch = useFetch();

  return useSWR(
    `/analytics/${integrationId}/videos/${videoId}`,
    async (url: string) => (await fetch(url)).json(),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
};

// The tape folds from hourly cells to daily ones past three days, and this
// sentence has to count the holes in the tape the reader is looking at, so it
// has to fold on the same boundary.
const HOURLY_SPAN_LIMIT = 72 * 60 * 60 * 1000;

const startOfBucket = (at: Date, daily: boolean) => {
  const floor = new Date(at);
  floor.setMinutes(0, 0, 0);
  if (daily) {
    floor.setHours(0);
  }
  return floor;
};

const dayLabel = (at: Date) =>
  at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// A reading spread across a gap arrives as a fraction — a gain of 1 over three
// missed hours is 0.33 an hour — so only the display is rounded. Rounding the
// values themselves is what turned a genuine +1 into three zeros.
const formatGain = (value: number) =>
  (Math.round(value * 100) / 100).toLocaleString();

/**
 * What this video gained since the sweep started watching it.
 *
 * The payload is deltas only — the server drops the first snapshot because a
 * level has no predecessor to be a gain over — so the running total cannot come
 * from it and is taken from the row instead. The sentence carries the finding,
 * the tape underneath is the evidence it was measured rather than assumed.
 */
const VideoHistory: FC<{
  integrationId: string;
  videoId: string;
  views: number;
}> = ({ integrationId, videoId, views }) => {
  const t = useT();
  const { data, isLoading } = useVideoHistory(integrationId, videoId);

  const summary = useMemo(() => {
    const readings = (Array.isArray(data) ? (data as GainTapePoint[]) : [])
      .map((point) => ({
        at: new Date(point.at),
        value: Number(point.value) || 0,
      }))
      .filter((point) => !isNaN(point.at.getTime()))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    if (!readings.length) {
      return null;
    }

    const first = readings[0].at;
    const last = readings[readings.length - 1].at;
    const span = last.getTime() - first.getTime();
    const daily = span > HOURLY_SPAN_LIMIT;

    // Walked on the calendar rather than divided out of the span, so the 23-
    // and 25-hour days around a DST change still count once each.
    const covered = new Set(
      readings.map((reading) => startOfBucket(reading.at, daily).getTime())
    );
    const cursor = startOfBucket(first, daily);
    const end = startOfBucket(last, daily).getTime();
    let buckets = 0;

    while (cursor.getTime() <= end) {
      buckets++;
      if (daily) {
        cursor.setDate(cursor.getDate() + 1);
      } else {
        cursor.setHours(cursor.getHours() + 1);
      }
    }

    // Fractions are summed before they are shown, so a gain smeared over a
    // missed run survives instead of disappearing a hundredth at a time.
    const perDay = new Map<number, number>();
    for (const reading of readings) {
      const day = startOfBucket(reading.at, true).getTime();
      perDay.set(day, (perDay.get(day) || 0) + reading.value);
    }

    return {
      gain: readings.reduce((sum, reading) => sum + reading.value, 0),
      readings: readings.length,
      hours: Math.round(span / (60 * 60 * 1000)),
      missing: buckets - covered.size,
      daily,
      days: Array.from(perDay.entries()).map(([at, value]) => ({
        at: new Date(at),
        value,
      })),
    };
  }, [data]);

  if (isLoading) {
    return (
      <div className="py-[24px] text-center text-[13px] text-newTableText">
        {t('loading', 'Loading...')}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="py-[24px] text-center text-[13px] text-newTableText">
        {t(
          'video_history_no_reading',
          'No reading yet — the hourly sweep needs at least two passes before a variation can be drawn.'
        )}
      </div>
    );
  }

  const span =
    summary.hours < 48
      ? t('video_history_span_hours', '{{hours}} h', { hours: summary.hours })
      : t('video_history_span_days', '{{days}} d', {
          days: Math.round(summary.hours / 24),
        });

  // Compared on the shown value, not the raw sum: a gain spread over a gap adds
  // up to 0.999… as often as to 1, and both are one view to the reader.
  const gain = Math.round(summary.gain * 100) / 100;

  const headline =
    gain <= 0
      ? t('video_history_no_gain', 'No views gained in {{span}}', { span })
      : gain === 1
      ? t('video_history_gain_one', '+1 view in {{span}}', { span })
      : t('video_history_gain', '+{{gain}} views in {{span}}', {
          gain: formatGain(gain),
          span,
        });

  const context = [
    t('video_history_total_views', '{{total}} views total', {
      total: views.toLocaleString(),
    }),
    t('video_history_readings', '{{readings}} readings', {
      readings: summary.readings,
    }),
    ...(summary.missing > 0
      ? [
          summary.daily
            ? t('video_history_missing_days', '{{missing}} days not measured', {
                missing: summary.missing,
              })
            : t(
                'video_history_missing_hours',
                '{{missing}} hours not measured',
                { missing: summary.missing }
              ),
        ]
      : []),
  ].join(' · ');

  return (
    <div className="py-[12px] flex flex-col gap-[12px]">
      <div>
        <div className="text-[20px] leading-[26px] font-semibold tracking-tight">
          {headline}
        </div>
        <div className="text-[13px] text-newTableText mt-[2px]">{context}</div>
      </div>

      <GainTape points={data} />

      {/* Only while the tape is drawn in hours: past that its own cells are
          already days, and a window that keeps 180 of them would restate every
          one of them here. */}
      {!summary.daily && summary.days.length > 1 && (
        <div className="text-[12px] tabular-nums text-newTableText">
          {summary.days
            .map((day) => `${dayLabel(day.at)} +${formatGain(day.value)}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
};

export const VideoTable: FC<{
  videos: AnalyticsVideoRow[];
  integrationId: string;
}> = ({ videos, integrationId }) => {
  const format = (value: number) => value.toLocaleString();
  // The provider already hands the rows back newest first; this is the same
  // order, just made explicit so the header can toggle it.
  const [sortKey, setSortKey] = useState<VideoSortKey>('date');
  const [ascending, setAscending] = useState(false);
  // One video open at a time: two curves side by side compete for the same
  // vertical space and neither gets enough of it.
  const [openId, setOpenId] = useState<string | null>(null);

  const toggle = useCallback(
    (key: VideoSortKey) => {
      if (key === sortKey) {
        setAscending((current) => !current);
        return;
      }
      setSortKey(key);
      // A freshly picked column starts on its most useful end: biggest numbers
      // and most recent dates first.
      setAscending(false);
    },
    [sortKey]
  );

  const sorted = useMemo(() => {
    const value = (video: (typeof videos)[number]) =>
      sortKey === 'date' ? new Date(video.date).getTime() || 0 : video[sortKey];

    return [...videos].sort((a, b) =>
      ascending ? value(a) - value(b) : value(b) - value(a)
    );
  }, [videos, sortKey, ascending]);

  const headerProps = { active: sortKey, ascending, onSort: toggle };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="text-newTableText text-[13px] text-left">
            <th className="font-medium py-[8px] pr-[12px]">Video</th>
            <SortableHeader
              label="Published"
              sortBy="date"
              className="px-[12px] whitespace-nowrap"
              {...headerProps}
            />
            <SortableHeader
              label="Views"
              sortBy="views"
              className="px-[12px] text-right"
              {...headerProps}
            />
            <SortableHeader
              label="Likes"
              sortBy="likes"
              className="px-[12px] text-right"
              {...headerProps}
            />
            <SortableHeader
              label="Comments"
              sortBy="comments"
              className="pl-[12px] text-right"
              {...headerProps}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((video) => (
            <Fragment key={video.id}>
              <tr
                className="border-t border-newTableBorder cursor-pointer hover:bg-newTableHeader/50"
                onClick={() =>
                  setOpenId((current) =>
                    current === video.id ? null : video.id
                  )
                }
              >
                <td className="py-[10px] pr-[12px]">
                  <div className="flex items-center gap-[10px] min-w-[220px]">
                    <span
                      className={`text-[10px] text-newTableText transition-transform ${
                        openId === video.id ? 'rotate-90' : ''
                      }`}
                    >
                      ▶
                    </span>
                    {video.thumbnail && (
                      <img
                        src={video.thumbnail}
                        alt=""
                        className="w-[64px] h-[36px] object-cover rounded-[4px] flex-none"
                      />
                    )}
                    {video.url ? (
                      <a
                        href={video.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline line-clamp-2"
                      >
                        {video.title}
                      </a>
                    ) : (
                      <span className="line-clamp-2">{video.title}</span>
                    )}
                  </div>
                </td>
                <td className="py-[10px] px-[12px] text-newTableText whitespace-nowrap">
                  {video.date ? new Date(video.date).toLocaleDateString() : '—'}
                </td>
                <td className="py-[10px] px-[12px] text-right tabular-nums">
                  {format(video.views)}
                </td>
                <td className="py-[10px] px-[12px] text-right tabular-nums">
                  {format(video.likes)}
                </td>
                <td className="py-[10px] pl-[12px] text-right tabular-nums">
                  {format(video.comments)}
                </td>
              </tr>
              {openId === video.id && (
                <tr className="border-t border-newTableBorder">
                  <td colSpan={5}>
                    {/* The history payload is deltas only, so the running
                        total has to come from the row that owns it. */}
                    <VideoHistory
                      integrationId={integrationId}
                      videoId={video.id}
                      views={video.views}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
};
