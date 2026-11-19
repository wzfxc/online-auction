import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';
import type { Principal } from '../lots/lots.js';
import { NotificationService, type NotificationDto } from '../notifications/notifications.js';
import { CurrentUser, Roles } from './auth.js';
import { ApiErrors, ZBody, ZQuery, ZResponse } from './openapi-helpers.js';
import { markReadResultSchema, markReadSchema, notificationSchema, notificationsQuerySchema } from './schemas.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Roles('buyer', 'seller', 'moderator', 'finance')
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  /** The user id always comes from the token, so only the caller's own inbox is reachable. */
  @Get()
  @ApiOperation({ operationId: 'listNotifications', summary: 'Own notifications, newest first' })
  @ZQuery(notificationsQuerySchema)
  @ZResponse(200, z.array(notificationSchema))
  @ApiErrors(400, 401, 403)
  list(@CurrentUser() user: Principal | null, @Query() query: unknown): Promise<NotificationDto[]> {
    const q = notificationsQuerySchema.safeParse(query);
    if (!q.success) throw Errors.validation(q.error.issues);
    return this.notifications.list(user!.id, {
      ...(q.data.unreadOnly !== undefined ? { unreadOnly: q.data.unreadOnly === 'true' } : {}),
      ...(q.data.limit !== undefined ? { limit: q.data.limit } : {}),
    });
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({ operationId: 'markNotificationsRead', summary: 'Mark given (or all) own notifications as read' })
  @ZBody(markReadSchema)
  @ZResponse(200, markReadResultSchema)
  @ApiErrors(400, 401, 403)
  async markRead(@CurrentUser() user: Principal | null, @Body() raw: unknown): Promise<z.infer<typeof markReadResultSchema>> {
    const p = markReadSchema.safeParse(raw ?? {});
    if (!p.success) throw Errors.validation(p.error.issues);
    return { updated: await this.notifications.markRead(user!.id, p.data.ids) };
  }
}
