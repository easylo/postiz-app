import { proxyActivities, sleep } from '@temporalio/workflow';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';

const { captureAnalyticsSnapshots } = proxyActivities<IntegrationsActivity>({
  startToCloseTimeout: '30 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '5 minutes',
  },
});

/**
 * Records a daily point for every social integration, so providers exposing
 * only current counters keep building a history even when nobody opens the
 * analytics screen.
 *
 * A day is the right cadence: the stored rows are keyed by date, so running
 * more often would only overwrite the same row.
 */
export async function analyticsSnapshotWorkflow() {
  await captureAnalyticsSnapshots();
  while (true) {
    await sleep('1 day');
    await captureAnalyticsSnapshots();
  }
}
