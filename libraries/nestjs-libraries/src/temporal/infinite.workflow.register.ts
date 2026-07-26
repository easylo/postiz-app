import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

@Injectable()
export class InfiniteWorkflowRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  onModuleInit(): void {
    if (!process.env.RUN_CRON) {
      return;
    }

    // Deliberately not awaited. Registering these is background bookkeeping,
    // and letting it gate the boot means a stalled Temporal call leaves NestJS
    // short of app.listen(): process alive, port 3000 closed, not one log line,
    // and no probe on the backend to notice. try/catch is no protection — a
    // hang is not a rejection. Seen in production on 2026-07-25, where the
    // backend failed to start twice in a row.
    void this.registerInfiniteWorkflows();
  }

  private async registerInfiniteWorkflows(): Promise<void> {
    const workflows: Array<[name: string, workflowId: string]> = [
      ['missingPostWorkflow', 'missing-post-workflow'],
      ['analyticsSnapshotWorkflow', 'analytics-snapshot-workflow'],
      ['videoAnalyticsSnapshotWorkflow', 'video-analytics-snapshot-workflow'],
    ];

    for (const [name, workflowId] of workflows) {
      try {
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start(name, { workflowId, taskQueue: 'main' });
      } catch (err) {
        // Already running, or Temporal is unreachable — either way the next
        // boot retries, and nothing here is worth failing a startup over.
      }
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [InfiniteWorkflowRegister],
  get exports() {
    return this.providers;
  },
})
export class InfiniteWorkflowRegisterModule {}
