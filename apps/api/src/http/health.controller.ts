import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { Public } from './auth.js';
import { ZResponse } from './openapi-helpers.js';
import { SkipThrottle } from './rate-limit.js';
import { DB } from './tokens.js';

const healthSchema = z.object({ status: z.literal('ok') });

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Used by the compose healthcheck: ok only when the database answers. */
  @Public()
  @Get()
  @ApiOperation({ operationId: 'health', summary: 'Liveness and database check' })
  @ZResponse(200, healthSchema)
  async check(): Promise<z.infer<typeof healthSchema>> {
    await this.db.execute(sql`select 1`);
    return { status: 'ok' };
  }
}
