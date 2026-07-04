import { Module } from '@nestjs/common';
import { MetricsBullService } from './metrics-bull.service';

/**
 * Wires the BullMQ collectors (#355). The queues are provided by the @Global
 * QueueModule (which exports BullModule), so no re-registration is needed here.
 * The HTTP histogram, DB-query and collab-store collectors live in module-level
 * singletons (metrics.registry) and are wired directly at their call sites.
 */
@Module({
  providers: [MetricsBullService],
})
export class MetricsModule {}
