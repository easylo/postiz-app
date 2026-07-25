import { FC, Fragment, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ChartSocial } from '@gitroom/frontend/components/analytics/chart-social';

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

const VideoHistory: FC<{ integrationId: string; videoId: string }> = ({
  integrationId,
  videoId,
}) => {
  const { data, isLoading } = useVideoHistory(integrationId, videoId);
  const [granularity, setGranularity] = useState<'hour' | 'day'>('hour');

  const series = useMemo(() => {
    const points: Array<{ at: string; value: number }> = data || [];

    if (granularity === 'hour') {
      return points.map((point) => ({
        date: new Date(point.at).toLocaleString(),
        total: Math.round(point.value),
      }));
    }

    // The day view is this same payload regrouped, not a second request. The
    // fractions are summed before rounding, so a gain spread across a missed
    // run survives instead of vanishing into per-hour rounding.
    const perDay = new Map<string, number>();
    for (const point of points) {
      const day = new Date(point.at).toLocaleDateString();
      perDay.set(day, (perDay.get(day) || 0) + point.value);
    }

    return Array.from(perDay.entries()).map(([date, total]) => ({
      date,
      total: Math.round(total),
    }));
  }, [data, granularity]);

  if (isLoading) {
    return (
      <div className="py-[24px] text-center text-[13px] text-newTableText">
        Loading…
      </div>
    );
  }

  if (!series.length) {
    return (
      <div className="py-[24px] text-center text-[13px] text-newTableText">
        No reading yet — the hourly sweep needs at least two passes before a
        variation can be drawn.
      </div>
    );
  }

  return (
    <div className="py-[12px]">
      <div className="flex items-center gap-[8px] mb-[8px]">
        {(['hour', 'day'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setGranularity(option)}
            className={`px-[10px] py-[4px] text-[12px] rounded-[6px] transition-colors ${
              granularity === option
                ? 'bg-[#612bd3] text-white'
                : 'bg-newTableHeader text-newTableText hover:text-white'
            }`}
          >
            {option === 'hour' ? 'Hour' : 'Day'}
          </button>
        ))}
      </div>
      <div className="h-[160px]">
        {/* ChartSocial builds its chart once and ignores later data changes,
            so switching granularity has to remount it. */}
        <ChartSocial
          key={`${videoId}-${granularity}`}
          data={series}
          color="purple"
          points={granularity === 'hour' ? 72 : 30}
        />
      </div>
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
                    <VideoHistory
                      integrationId={integrationId}
                      videoId={video.id}
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
