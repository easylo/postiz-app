import { Integration } from '@prisma/client';

export interface ClientInformation {
  client_id: string;
  client_secret: string;
  instanceUrl: string;
}
export interface IAuthenticator {
  authenticate(
    params: {
      code: string;
      codeVerifier: string;
      refresh?: string;
    },
    clientInformation?: ClientInformation
  ): Promise<AuthTokenDetails | string>;
  refreshToken(refreshToken: string): Promise<AuthTokenDetails>;
  reConnect?(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>>;
  generateAuthUrl(
    clientInformation?: ClientInformation
  ): Promise<GenerateAuthUrlResponse>;
  analytics?(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]>;
  /**
   * The per-video rows on their own. The hourly snapshot job calls this instead
   * of `analytics`, which would drag along aggregate queries it has no use for.
   */
  videosAnalytics?(id: string, accessToken: string): Promise<AnalyticsVideo[]>;
  postAnalytics?(
    integrationId: string,
    accessToken: string,
    postId: string,
    fromDate: number,
  ): Promise<AnalyticsData[]>;
  changeNickname?(
    id: string,
    accessToken: string,
    name: string
  ): Promise<{ name: string }>;
  changeProfilePicture?(
    id: string,
    accessToken: string,
    url: string
  ): Promise<{ url: string }>;
  missing?(
    id: string,
    accessToken: string
  ): Promise<{ id: string; url: string }[]>;
}

/**
 * One row of the per-video table. Named rather than inlined because the hourly
 * snapshot job consumes it directly, without going through AnalyticsData.
 */
export type AnalyticsVideo = {
  id: string;
  title: string;
  url?: string;
  thumbnail?: string;
  date: string;
  views: number;
  likes: number;
  comments: number;
};

export interface AnalyticsData {
  label: string;
  data: Array<{ total: string; date: string }>;
  /**
   * Set when the metric is already a rate or an average rather than a counter.
   * Changes how the variation is computed (difference in points instead of a
   * relative percentage) and how the UI labels it (`pp` instead of `%`).
   */
  average?: boolean;
  /**
   * Set when the metric is a level read at a point in time — followers, total
   * likes, a video count — rather than an amount accrued over the period.
   * Summing successive readings of a level is meaningless: three readings of
   * four followers are not twelve followers. The UI shows the latest instead.
   *
   * Not set by providers: IntegrationService marks the metrics it stitches a
   * history onto, which are gauges by construction — a provider that returns a
   * single point is reporting a level, not a series.
   */
  gauge?: boolean;
  /**
   * Set when the value is a percentage and should be rendered with a `%`.
   * Distinct from `average`: an average view duration is a mean measured in
   * seconds, and labelling it a percentage makes it nonsense.
   */
  percentage?: boolean;
  /**
   * Computed centrally from `data` in IntegrationService.checkAnalytics.
   * Providers do not need to set it.
   */
  percentageChange?: number;
  /**
   * The same variation in the metric's own unit — followers, views, points of
   * a rate. It is what the UI leads with: a channel that gained four followers
   * gained four followers, while `+100%` says more about how small the starting
   * point was than about the week.
   *
   * Computed centrally alongside `percentageChange`, from the same two
   * readings, so the client never has to derive a second delta that would
   * disagree with the first. Providers do not need to set it.
   */
  absoluteChange?: number;
  /**
   * Date of the earliest reading the change was measured from, so the UI can
   * name the period instead of implying the change happened since forever.
   * Absent when there is nothing to compare against.
   */
  changeFrom?: string;
  /**
   * How many usable readings the series holds. A metric never read, one read
   * once and one genuinely unchanged all produce a change of zero, and only
   * this count tells them apart — which is the difference between "no change"
   * and "no data" on screen.
   */
  readings?: number;
  /**
   * Ranked distribution rather than a time series — top countries, traffic
   * sources, devices. Mutually exclusive with `data`: a metric carries either
   * a series to chart or a breakdown to rank, never both.
   */
  breakdown?: Array<{ key: string; value: number }>;
  /**
   * Per-video rows rather than an aggregate. Mutually exclusive with `data`,
   * `breakdown` and `hourly`: a metric carries a series, a ranking, a list or a
   * grid, never two.
   */
  videos?: AnalyticsVideo[];
  /**
   * Views gained hour by hour, summed over the tracked videos. The client turns
   * it into a day-by-hour grid in its own timezone — which is why the raw
   * series travels rather than a ready-made grid: a server-side axis rotation
   * would be wrong for the timezones offset by half an hour.
   *
   * `estimated` is set on an hour whose gain was inferred rather than read:
   * the sweep missed a run, and the gain straddling the gap was spread over
   * the hours it covered. One video contributing an inferred point is enough,
   * since the sum then stops being a measurement. It cannot be recovered from
   * the value — a gain spread thin is indistinguishable from a small one that
   * really happened — so it has to travel for the grid to mark those cells.
   */
  hourly?: Array<{ at: string; value: number; estimated?: boolean }>;
}


export type GenerateAuthUrlResponse = {
  url: string;
  codeVerifier: string;
  state: string;
};

export type AuthTokenDetails = {
  id: string;
  name: string;
  error?: string;
  accessToken: string; // The obtained access token
  refreshToken?: string; // The refresh token, if applicable
  expiresIn?: number; // The duration in seconds for which the access token is valid
  picture?: string;
  username: string;
  additionalSettings?: {
    title: string;
    description: string;
    type: 'checkbox' | 'text' | 'textarea';
    value: any;
    regex?: string;
  }[];
};

export interface ISocialMediaIntegration {
  post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]>; // Schedules a new post

  comment?(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]>; // Schedules a new post
}

export type PostResponse = {
  id: string; // The db internal id of the post
  postId: string; // The ID of the scheduled post returned by the platform
  releaseURL: string; // The URL of the post on the platform
  status: string; // Status of the operation or initial post status
  /**
   * Set when the provider published something other than what was asked — a
   * downgraded privacy level, a different posting method. It travels to the
   * post so the calendar can say so: without it, a video sitting in TikTok's
   * inbox until it expires looks exactly like a public publication.
   */
  note?: string;
};

export type PostDetails<T = any> = {
  id: string;
  message: string;
  settings: T;
  media?: MediaContent[];
  poll?: PollDetails;
};

export type PollDetails = {
  options: string[]; // Array of poll options
  duration: number; // Duration in hours for which the poll will be active
};

export type MediaContent = {
  type: 'image' | 'video'; // Type of the media content
  path: string;
  alt?: string;
  thumbnail?: string;
  thumbnailTimestamp?: number;
};

export type FetchPageInformationResult = {
  id: string;
  name: string;
  access_token: string;
  picture: string;
  username: string;
};

export interface SocialProvider
  extends IAuthenticator,
    ISocialMediaIntegration {
  identifier: string;
  refreshWait?: boolean;
  convertToJPEG?: boolean;
  stripLinks?: () => boolean;
  refreshCron?: boolean;
  dto?: any;
  maxLength: (additionalSettings?: any) => number;
  checkValidity(
    posts: Array<{ path: string; thumbnail?: string }[]>,
    settings: any,
    additionalSettings: any[]
  ): Promise<string | true>;
  isWeb3?: boolean;
  isChromeExtension?: boolean;
  extensionCookies?: { name: string; domain: string }[];
  editor: 'none' | 'normal' | 'markdown' | 'html';
  customFields?: () => Promise<
    {
      key: string;
      label: string;
      defaultValue?: string;
      validation: string;
      type: 'text' | 'password';
      hint?: string;
    }[]
  >;
  name: string;
  toolTip?: string;
  oneTimeToken?: boolean;
  isBetweenSteps: boolean;
  scopes: string[];
  externalUrl?: (
    url: string
  ) => Promise<{ client_id: string; client_secret: string }>;
  mention?: (
    token: string,
    data: { query: string },
    id: string,
    integration: Integration
  ) => Promise<
    | { id: string; label: string; image: string; doNotCache?: boolean }[]
    | { none: true }
  >;
  mentionFormat?(idOrHandle: string, name: string): string;
  fetchPageInformation?(
    accessToken: string,
    data: any
  ): Promise<FetchPageInformationResult>;
}
