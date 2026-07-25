import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  AnalyticsData,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration, Organization } from '@prisma/client';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import dayjs from 'dayjs';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import { difference, uniq } from 'lodash';
import utc from 'dayjs/plugin/utc';
import { AutopostRepository } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { TemporalService } from 'nestjs-temporal-core';

dayjs.extend(utc);

/**
 * Window the snapshot sweep asks providers for. It only needs today's value;
 * a short window keeps the provider call cheap.
 */
const SNAPSHOT_WINDOW_DAYS = 7;

/**
 * Past this, only the midnight reading of each video survives the purge. Four
 * weeks is what makes the day-by-hour grid readable: it puts four measurements
 * in each of its 168 cells, where two would let a single viral evening pass for
 * a habit.
 */
const HOURLY_RETENTION_DAYS = 28;

/**
 * Fills in `percentageChange` for every metric, comparing the first half of the
 * series against the second one.
 *
 * Providers used to hardcode this value (0, and 5 for a few of them), so the
 * trend arrow in the UI was decorative. Computing it here keeps it generic: any
 * provider returning at least two data points gets a real trend, with no
 * provider-specific code.
 *
 * Rates and averages (`average: true`) are compared as means and the result is
 * a difference in points, which is what the UI renders as `pp`. Counters are
 * compared as sums and the result is a relative percentage.
 */
const withPercentageChange = (analytics: AnalyticsData[]): AnalyticsData[] =>
  (analytics || []).map((metric) => {
    const points = (metric?.data || [])
      .map((p) => Number(p?.total))
      .filter((n) => !isNaN(n));

    if (points.length < 2) {
      return { ...metric, percentageChange: 0 };
    }

    const middle = Math.floor(points.length / 2);
    const first = points.slice(0, middle);
    const second = points.slice(middle);

    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

    const before = metric.average ? sum(first) / first.length : sum(first);
    const after = metric.average ? sum(second) / second.length : sum(second);

    // A rate moves in points; a counter moves relative to where it started.
    const change = metric.average
      ? after - before
      : before === 0
      ? 0
      : ((after - before) / before) * 100;

    return { ...metric, percentageChange: Math.round(change * 10) / 10 };
  });

/**
 * Turns cumulative view counters into what was gained between two readings.
 *
 * Three cases the stored counters cannot express on their own:
 *
 * - The **first** reading has no predecessor. It carries every view the video
 *   collected before we started watching it, so it is dropped rather than drawn
 *   as a spike of twelve thousand views that never happened.
 * - A counter can **go down** — spam removal, a video pulled offline. A negative
 *   gain means nothing here, so it is floored at zero.
 * - A **missed run** leaves a gap of several hours. The gain straddling it is
 *   spread evenly over the hours it covers, instead of landing entirely on the
 *   hour the job came back and inventing a peak there.
 *
 * That spreading is a smoothing, not a measurement: if the sweep skipped a
 * night, the grid will show activity at 4am that nobody actually produced.
 *
 * `value` is left fractional on purpose: this helper runs once per video, and
 * rounding here before the channel-wide sum either erases a small gain (0.33
 * rounds to 0) or doubles one (0.5 rounds up on every one of the hours it
 * spans). Callers round once, after they are done summing.
 */
const toHourlyDeltas = (
  snapshots: { capturedAt: Date; views: number }[]
): Array<{ at: string; value: number }> => {
  const points: Array<{ at: string; value: number }> = [];

  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];

    const hours = Math.max(
      1,
      Math.round(
        (current.capturedAt.getTime() - previous.capturedAt.getTime()) / 3600000
      )
    );
    const perHour = Math.max(0, current.views - previous.views) / hours;

    // Walked backwards from `current`, so the gain is credited to the hours
    // that follow `previous` up to and including `current`.
    for (let hour = hours; hour > 0; hour--) {
      points.push({
        at: new Date(
          current.capturedAt.getTime() - (hour - 1) * 3600000
        ).toISOString(),
        value: perHour,
      });
    }
  }

  return points;
};

@Injectable()
export class IntegrationService {
  private storage = UploadFactory.createStorage();

  constructor(
    private _integrationRepository: IntegrationRepository,
    private _autopostsRepository: AutopostRepository,
    private _integrationManager: IntegrationManager,
    private _notificationService: NotificationService,
    @Inject(forwardRef(() => RefreshIntegrationService))
    private _refreshIntegrationService: RefreshIntegrationService,
    private _temporalService: TemporalService
  ) {}

  /**
   * Gives a history to providers that only expose current counters.
   *
   * Such providers return a single data point, which cannot be charted and
   * leaves the trend at zero forever. We record that point once a day and
   * stitch the stored ones back in, so the metric builds up a series from the
   * first read onwards. Metrics that already carry a real time series — YouTube
   * and the like — have more than one point and are handed back untouched.
   *
   * History is a nicety: a failure here must never break an analytics read.
   */
  private async mergeAnalyticsHistory(
    integrationId: string,
    analytics: AnalyticsData[],
    days: number,
    postId = ''
  ): Promise<AnalyticsData[]> {
    const snapshots = (analytics || []).filter((m) => m?.data?.length === 1);
    if (!snapshots.length) {
      return analytics;
    }

    try {
      await this._integrationRepository.saveAnalyticsSnapshot(
        integrationId,
        snapshots.map((m) => ({
          label: m.label,
          date: m.data[0].date,
          total: m.data[0].total,
        })),
        postId
      );

      const history = await this._integrationRepository.getAnalyticsHistory(
        integrationId,
        dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
        postId
      );

      return analytics.map((metric) => {
        if (metric?.data?.length !== 1) {
          return metric;
        }

        const today = metric.data[0].date;
        const data = [
          // The live value wins for today; stored rows only fill in the past.
          ...history
            .filter((h) => h.label === metric.label && h.date !== today)
            .map(({ date, total }) => ({ date, total })),
          ...metric.data,
        ].sort((a, b) => a.date.localeCompare(b.date));

        return { ...metric, data };
      });
    } catch (e) {
      return analytics;
    }
  }

  /**
   * Records the history and fills in the trend, in that order — the variation
   * has to be computed on the stitched series, not on the single point the
   * provider just returned.
   *
   * Shared by channel-wide analytics and per-post ones; `postId` is what keeps
   * the two sets of rows apart.
   */
  async enrichAnalytics(
    integrationId: string,
    analytics: AnalyticsData[],
    days: number,
    postId = ''
  ): Promise<AnalyticsData[]> {
    return withPercentageChange(
      await this.mergeAnalyticsHistory(integrationId, analytics, days, postId)
    );
  }

  /**
   * Polls every healthy social integration so the history keeps growing on days
   * nobody opens the analytics screen. Without it, a channel left alone for a
   * week comes back with a week-long hole in its charts.
   *
   * One failing integration — expired token, provider outage — must not stop
   * the sweep, so each is isolated.
   */
  async captureAnalyticsSnapshots() {
    const integrations =
      await this._integrationRepository.getIntegrationsForAnalyticsSnapshot();

    for (const integration of integrations) {
      try {
        const provider = this._integrationManager.getSocialIntegration(
          integration.providerIdentifier
        );

        if (!provider?.analytics) {
          continue;
        }

        await this.enrichAnalytics(
          integration.id,
          await provider.analytics(
            integration.internalId,
            integration.token,
            SNAPSHOT_WINDOW_DAYS
          ),
          SNAPSHOT_WINDOW_DAYS
        );
      } catch (e) {
        // Nothing to do: the next run picks it up again.
      }
    }
  }

  /**
   * Records the view counter of every tracked video, once an hour.
   *
   * Providers expose no hourly history at all, so this sweep is the only source
   * of the growth curve and of the day-by-hour grid. It calls `videosAnalytics`
   * rather than `analytics`, which would drag along aggregate queries nobody
   * reads here.
   *
   * One failing integration — expired token, provider outage — must not stop
   * the sweep, so each is isolated.
   */
  async captureVideoAnalyticsSnapshots() {
    const integrations =
      await this._integrationRepository.getIntegrationsForAnalyticsSnapshot();

    // Every video of this run lands on the same hour, so a retry overwrites the
    // same rows instead of scattering readings a few minutes apart.
    const capturedAt = dayjs().utc().startOf('hour');

    for (const integration of integrations) {
      try {
        const provider = this._integrationManager.getSocialIntegration(
          integration.providerIdentifier
        );

        if (!provider?.videosAnalytics) {
          continue;
        }

        const videos = await provider.videosAnalytics(
          integration.internalId,
          integration.token
        );

        if (!videos?.length) {
          continue;
        }

        await this._integrationRepository.saveVideoSnapshots(
          integration.id,
          capturedAt.toDate(),
          capturedAt.hour(),
          videos.map((video) => ({ videoId: video.id, views: video.views }))
        );
      } catch (e) {
        // Nothing to do: the next hour picks it up again.
      }
    }

    await this._integrationRepository.purgeVideoSnapshots(
      dayjs().utc().subtract(HOURLY_RETENTION_DAYS, 'day').toDate()
    );
  }

  /**
   * Views gained hour by hour across every tracked video of a channel.
   *
   * The variation is per video — two videos are two independent counters and
   * subtracting across them would be meaningless — so the series are computed
   * separately and only then summed on the hour.
   */
  private async viewsHeatmap(integrationId: string) {
    const snapshots = await this._integrationRepository.getVideoSnapshots(
      integrationId,
      dayjs().utc().subtract(HOURLY_RETENTION_DAYS, 'day').toDate()
    );

    const byVideo = new Map<string, { capturedAt: Date; views: number }[]>();
    for (const snapshot of snapshots) {
      const readings = byVideo.get(snapshot.videoId) || [];
      readings.push(snapshot);
      byVideo.set(snapshot.videoId, readings);
    }

    const totals = new Map<string, number>();
    for (const readings of byVideo.values()) {
      for (const point of toHourlyDeltas(readings)) {
        totals.set(point.at, (totals.get(point.at) || 0) + point.value);
      }
    }

    return Array.from(totals.entries())
      .map(([at, value]) => ({ at, value: Math.round(value) }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  async changeActiveCron(orgId: string) {
    const data = await this._autopostsRepository.getAutoposts(orgId);

    for (const item of data.filter((f) => f.active)) {
      try {
        await this._temporalService.terminateWorkflow(`autopost-${item.id}`);
      } catch (err) {}
    }

    return true;
  }

  getMentions(platform: string, q: string) {
    return this._integrationRepository.getMentions(platform, q);
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    return this._integrationRepository.insertMentions(platform, mentions);
  }

  async setTimes(
    orgId: string,
    integrationId: string,
    times: IntegrationTimeDto
  ) {
    return this._integrationRepository.setTimes(orgId, integrationId, times);
  }

  updateProviderSettings(org: string, id: string, additionalSettings: string) {
    return this._integrationRepository.updateProviderSettings(
      org,
      id,
      additionalSettings
    );
  }

  checkPreviousConnections(org: string, id: string) {
    return this._integrationRepository.checkPreviousConnections(org, id);
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn?: number,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string
  ) {
    const uploadedPicture = picture
      ? picture?.indexOf('imagedelivery.net') > -1
        ? picture
        : await this.storage.uploadSimple(picture)
      : undefined;

    return this._integrationRepository.createOrUpdateIntegration(
      additionalSettings,
      oneTimeToken,
      org,
      name,
      uploadedPicture,
      type,
      internalId,
      provider,
      token,
      refreshToken,
      expiresIn,
      username,
      isBetweenSteps,
      refresh,
      timezone,
      customInstanceDetails
    );
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integrationRepository.updateIntegrationGroup(org, id, group);
  }

  updateOnCustomerName(org: string, id: string, name: string) {
    return this._integrationRepository.updateOnCustomerName(org, id, name);
  }

  getIntegrationsList(org: string) {
    return this._integrationRepository.getIntegrationsList(org);
  }

  getIntegrationForOrder(id: string, order: string, user: string, org: string) {
    return this._integrationRepository.getIntegrationForOrder(
      id,
      order,
      user,
      org
    );
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integrationRepository.updateNameAndUrl(id, name, url);
  }

  getIntegrationById(org: string, id: string) {
    return this._integrationRepository.getIntegrationById(org, id);
  }

  async refreshToken(provider: SocialProvider, refresh: string) {
    try {
      const { refreshToken, accessToken, expiresIn } =
        await provider.refreshToken(refresh);

      if (!refreshToken || !accessToken || !expiresIn) {
        return false;
      }

      return { refreshToken, accessToken, expiresIn };
    } catch (e) {
      return false;
    }
  }

  async disconnectChannel(orgId: string, integration: Integration) {
    await this._integrationRepository.disconnectChannel(orgId, integration.id);
    await this.informAboutRefreshError(orgId, integration);
  }

  async informAboutRefreshError(
    orgId: string,
    integration: Integration,
    err = ''
  ) {
    await this._notificationService.inAppNotification(
      orgId,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}`,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}. Please go back to the system and connect it again ${process.env.FRONTEND_URL}/launches`,
      true,
      false,
      'info'
    );
  }

  async refreshNeeded(org: string, id: string) {
    return this._integrationRepository.refreshNeeded(org, id);
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integrationRepository.setBetweenRefreshSteps(id);
  }

  async refreshTokens() {
    const integrations = await this._integrationRepository.needsToBeRefreshed();
    for (const integration of integrations) {
      const provider = this._integrationManager.getSocialIntegration(
        integration.providerIdentifier
      );

      const data = await this.refreshToken(provider, integration.refreshToken!);

      if (!data) {
        await this.informAboutRefreshError(
          integration.organizationId,
          integration
        );
        await this._integrationRepository.refreshNeeded(
          integration.organizationId,
          integration.id
        );
        return;
      }

      const { refreshToken, accessToken, expiresIn } = data;

      await this.createOrUpdateIntegration(
        undefined,
        !!provider.oneTimeToken,
        integration.organizationId,
        integration.name,
        undefined,
        'social',
        integration.internalId,
        integration.providerIdentifier,
        accessToken,
        refreshToken,
        expiresIn
      );
    }
  }

  async disableChannel(org: string, id: string) {
    return this._integrationRepository.disableChannel(org, id);
  }

  async enableChannel(org: string, totalChannels: number, id: string) {
    const integrations = (
      await this._integrationRepository.getIntegrationsList(org)
    ).filter((f) => !f.disabled);
    if (
      !!process.env.STRIPE_PUBLISHABLE_KEY &&
      integrations.length >= totalChannels
    ) {
      throw new Error('You have reached the maximum number of channels');
    }

    return this._integrationRepository.enableChannel(org, id);
  }

  async getPostsForChannel(org: string, id: string) {
    return this._integrationRepository.getPostsForChannel(org, id);
  }

  async deleteChannel(org: string, id: string) {
    return this._integrationRepository.deleteChannel(org, id);
  }

  async disableIntegrations(org: string, totalChannels: number) {
    return this._integrationRepository.disableIntegrations(org, totalChannels);
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integrationRepository.checkForDeletedOnceAndUpdate(org, page);
  }

  async saveProviderPage(org: string, id: string, data: any) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (!getIntegration) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }
    if (!getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const provider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!provider.fetchPageInformation) {
      throw new HttpException(
        'Provider does not support page selection',
        HttpStatus.BAD_REQUEST
      );
    }

    const getIntegrationInformation = await provider.fetchPageInformation(
      getIntegration.token,
      data
    );

    await this.checkForDeletedOnceAndUpdate(
      org,
      String(getIntegrationInformation.id)
    );
    await this._integrationRepository.updateIntegration(id, {
      picture: getIntegrationInformation.picture,
      internalId: String(getIntegrationInformation.id),
      organizationId: org,
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      profile: getIntegrationInformation.username,
    });

    return { success: true };
  }

  async checkAnalytics(
    org: Organization,
    integration: string,
    date: string,
    forceRefresh = false
  ): Promise<AnalyticsData[]> {
    const getIntegration = await this.getIntegrationById(org.id, integration);

    if (!getIntegration) {
      throw new Error('Invalid integration');
    }

    if (getIntegration.type !== 'social') {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this.disconnectChannel(org.id, getIntegration);
        return [];
      }
    }

    const getIntegrationData = await ioRedis.get(
      `integration:${org.id}:${integration}:${date}`
    );
    if (getIntegrationData) {
      return JSON.parse(getIntegrationData);
    }

    if (integrationProvider.analytics) {
      try {
        const loadAnalytics = await this.enrichAnalytics(
          getIntegration.id,
          await integrationProvider.analytics(
            getIntegration.internalId,
            getIntegration.token,
            +date
          ),
          +date
        );

        // Built here rather than in enrichAnalytics: that one is also called by
        // the snapshot sweep, which has no use for a heatmap. A failure must not
        // cost the whole screen, so it degrades to no card at all.
        try {
          const hourly = await this.viewsHeatmap(getIntegration.id);
          if (hourly.length) {
            loadAnalytics.push({ label: 'Views by Day and Hour', data: [], hourly });
          }
        } catch (e) {}

        await ioRedis.set(
          `integration:${org.id}:${integration}:${date}`,
          JSON.stringify(loadAnalytics),
          'EX',
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? 1
            : 3600
        );
        return loadAnalytics;
      } catch (e) {
        if (e instanceof RefreshToken) {
          return this.checkAnalytics(org, integration, date, true);
        }
      }
    }

    return [];
  }

  customers(orgId: string) {
    return this._integrationRepository.customers(orgId);
  }

  getPlugsByIntegrationId(org: string, integrationId: string) {
    return this._integrationRepository.getPlugsByIntegrationId(
      org,
      integrationId
    );
  }

  async processInternalPlug(
    data: {
      post: string;
      originalIntegration: string;
      integration: string;
      plugName: string;
      orgId: string;
      delay: number;
      information: any;
    },
    forceRefresh = false
  ): Promise<any> {
    const originalIntegration =
      await this._integrationRepository.getIntegrationById(
        data.orgId,
        data.originalIntegration
      );

    const getIntegration = await this._integrationRepository.getIntegrationById(
      data.orgId,
      data.integration
    );

    if (!getIntegration || !originalIntegration) {
      return;
    }

    const getAllInternalPlugs = this._integrationManager
      .getInternalPlugs(getIntegration.providerIdentifier)
      .internalPlugs.find((p: any) => p.identifier === data.plugName);

    if (!getAllInternalPlugs) {
      return;
    }

    const getSocialIntegration = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    // @ts-ignore
    await getSocialIntegration?.[getAllInternalPlugs.methodName]?.(
      getIntegration,
      originalIntegration,
      data.post,
      data.information
    );

    return;
  }

  async processPlugs(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    const getPlugById = await this._integrationRepository.getPlug(data.plugId);
    if (!getPlugById) {
      return true;
    }

    const integration = this._integrationManager.getSocialIntegration(
      getPlugById.integration.providerIdentifier
    );

    // @ts-ignore
    const process = await integration[getPlugById.plugFunction](
      getPlugById.integration,
      data.postId,
      JSON.parse(getPlugById.data).reduce((all: any, current: any) => {
        all[current.name] = current.value;
        return all;
      }, {})
    );

    if (process) {
      return true;
    }

    if (data.totalRuns === data.currentRun) {
      return true;
    }

    return false;
  }

  async createOrUpdatePlug(
    orgId: string,
    integrationId: string,
    body: PlugDto
  ) {
    const { activated } = await this._integrationRepository.createOrUpdatePlug(
      orgId,
      integrationId,
      body
    );

    return {
      activated,
    };
  }

  async changePlugActivation(orgId: string, plugId: string, status: boolean) {
    const { id, integrationId, plugFunction } =
      await this._integrationRepository.changePlugActivation(
        orgId,
        plugId,
        status
      );

    return { id };
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._integrationRepository.getPlugs(orgId, integrationId);
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    const exisingData = await this._integrationRepository.loadExisingData(
      methodName,
      integrationId,
      id
    );
    const loadOnlyIds = exisingData.map((p) => p.value);
    return difference(id, loadOnlyIds);
  }

  async findFreeDateTime(
    orgId: string,
    integrationsId?: string
  ): Promise<number[]> {
    const findTimes = await this._integrationRepository.getPostingTimes(
      orgId,
      integrationsId
    );
    return uniq(
      findTimes.reduce((all: any, current: any) => {
        return [
          ...all,
          ...JSON.parse(current.postingTimes).map(
            (p: { time: number }) => p.time
          ),
        ];
      }, [] as number[])
    );
  }
}
