import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../lots/lots.js';
import {
  periodReportQuerySchema, ReportService,
  type PeriodReportDto, type ReconciliationReportDto,
} from '../reports/reports.js';
import { CurrentUser, Roles } from './auth.js';
import { ApiErrors, ZQuery, ZResponse } from './openapi-helpers.js';
import { periodReportSchema, reconciliationReportSchema } from './schemas.js';

@ApiTags('reports')
@ApiBearerAuth()
@Roles('finance')
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get('period')
  @ApiOperation({
    operationId: 'getPeriodReport',
    summary: 'Turnover, commission, share of unpaid wins and category breakdown for a period (finance)',
  })
  @ZQuery(periodReportQuerySchema)
  @ZResponse(200, periodReportSchema)
  @ApiErrors(400, 401, 403)
  period(@CurrentUser() user: Principal | null, @Query() query: unknown): Promise<PeriodReportDto> {
    return this.reports.periodReport(user!, query);
  }

  @Get('reconciliation')
  @ApiOperation({
    operationId: 'getReconciliationReport',
    summary: 'Ledger zero-sum check, account balance vs entries check, and payment stub discrepancies (finance)',
  })
  @ZResponse(200, reconciliationReportSchema)
  @ApiErrors(401, 403)
  reconciliation(@CurrentUser() user: Principal | null): Promise<ReconciliationReportDto> {
    return this.reports.reconcileReport(user!);
  }
}
