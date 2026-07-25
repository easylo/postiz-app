import { proxyActivities, sleep } from '@temporalio/workflow';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';

const { captureVideoAnalyticsSnapshots } =
  proxyActivities<IntegrationsActivity>({
    startToCloseTimeout: '30 minute',
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '5 minutes',
    },
  });

/**
 * Records the view counter of every tracked video, once an hour.
 *
 * Separate from analyticsSnapshotWorkflow rather than folded into it: that one
 * is keyed by date, so running it hourly would only overwrite the same row, and
 * amending a workflow that may already be running would break the determinism
 * of its live execution.
 */
export async function videoAnalyticsSnapshotWorkflow() {
  await captureVideoAnalyticsSnapshots();
  while (true) {
    await sleep('1 hour');
    await captureVideoAnalyticsSnapshots();
  }
}
