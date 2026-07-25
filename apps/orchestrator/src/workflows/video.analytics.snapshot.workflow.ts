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
  while (true) {
    try {
      await captureVideoAnalyticsSnapshots();
    } catch (e) {
      // A failed hour must not end the loop: the next one picks it up again.
      // Without this, one exhausted retry stops the capture until someone
      // restarts the orchestrator, and nothing says so.
    }

    // Sleep to the next hour boundary rather than a flat hour. A fixed sleep
    // makes the period `1 hour + sweep duration`, so the run times drift and
    // whole hour buckets are never captured at all on instances where the
    // sweep is slow. Date.now() is deterministic inside a Temporal workflow.
    await sleep(3600000 - (Date.now() % 3600000));
  }
}
