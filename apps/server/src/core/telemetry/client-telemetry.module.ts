import { Module } from '@nestjs/common';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

/**
 * Client perf-telemetry (#355): the public /api/telemetry/vitals sink that
 * persists web-vitals + custom client metrics into `client_metrics`.
 * Named ClientTelemetryModule to avoid confusion with the unrelated
 * integrations/telemetry (product usage ping) module.
 */
@Module({
  controllers: [VitalsController],
  providers: [VitalsService],
})
export class ClientTelemetryModule {}
