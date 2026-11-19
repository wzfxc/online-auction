import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';
import type { Principal } from '../lots/lots.js';
import { MediaService, requestUploadSchema, type PhotoDto, type PhotoUploadDto } from '../media/media.js';
import { CurrentUser, Public, Roles } from './auth.js';
import { ApiErrors, ZBody, ZQuery, ZResponse, ZUuidParam } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { photoSchema, photoUploadSchema, photoViewQuerySchema, photoViewSchema } from './schemas.js';

const thumbnailsQuerySchema = z.object({
  ids: z.string().trim().min(1).max(4000),
});
const thumbnailsResponseSchema = z.object({
  thumbnails: z.record(z.string()),
});
const uuidSchema = z.string().uuid();

@ApiTags('media')
@Controller('media')
export class ThumbnailsController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Public()
  @Get('thumbnails')
  @ApiOperation({ operationId: 'getLotThumbnails', summary: 'Batch signed preview URLs for public catalog lots' })
  @ZQuery(thumbnailsQuerySchema)
  @ZResponse(200, thumbnailsResponseSchema)
  @ApiErrors(400)
  async thumbnails(@Query() query: unknown): Promise<z.infer<typeof thumbnailsResponseSchema>> {
    const q = thumbnailsQuerySchema.safeParse(query);
    if (!q.success) throw Errors.validation(q.error.issues);
    const ids = q.data.ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 100 || ids.some((id) => !uuidSchema.safeParse(id).success)) {
      throw Errors.validation([{ path: ['ids'], message: 'Expected 1 to 100 comma-separated UUIDs' }]);
    }
    return { thumbnails: await this.media.getThumbnails(ids) };
  }
}

@ApiTags('media')
@ApiBearerAuth()
@Controller('lots/:id/photos')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Roles('seller')
  @Post()
  @ApiOperation({ operationId: 'requestPhotoUpload', summary: 'Presigned POST pinned to one type and size' })
  @ZUuidParam('id')
  @ZBody(requestUploadSchema)
  @ZResponse(201, photoUploadSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422)
  requestUpload(@CurrentUser() user: Principal | null, @Param('id', UuidPipe) lotId: string, @Body() body: unknown): Promise<PhotoUploadDto> {
    return this.media.requestUpload(user!, lotId, body);
  }

  @Roles('seller')
  @Post(':photoId/confirm')
  @HttpCode(200)
  @ApiOperation({ operationId: 'confirmPhotoUpload', summary: 'Confirm the browser upload finished' })
  @ZUuidParam('id')
  @ZUuidParam('photoId')
  @ZResponse(200, photoSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422)
  confirm(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
    @Param('photoId', UuidPipe) photoId: string,
  ): Promise<PhotoDto> {
    return this.media.confirmUpload(user!, lotId, photoId);
  }

  @Roles('seller')
  @Delete(':photoId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deletePhoto', summary: 'Delete a photo of a draft lot' })
  @ZUuidParam('id')
  @ZUuidParam('photoId')
  @ApiErrors(400, 401, 403, 404, 409)
  async remove(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
    @Param('photoId', UuidPipe) photoId: string,
  ): Promise<void> {
    await this.media.deletePhoto(user!, lotId, photoId);
  }

  @Public()
  @Get()
  @ApiOperation({ operationId: 'listPhotos', summary: 'Photos visible to the viewer' })
  @ZUuidParam('id')
  @ZResponse(200, z.array(photoSchema))
  @ApiErrors(400, 404)
  list(@CurrentUser() user: Principal | null, @Param('id', UuidPipe) lotId: string): Promise<PhotoDto[]> {
    return this.media.list(user, lotId);
  }

  @Public()
  @Get(':photoId/url')
  @ApiOperation({ operationId: 'getPhotoUrl', summary: 'Short-lived signed download link' })
  @ZUuidParam('id')
  @ZUuidParam('photoId')
  @ZQuery(photoViewQuerySchema)
  @ZResponse(200, photoViewSchema)
  @ApiErrors(400, 404)
  url(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
    @Param('photoId', UuidPipe) photoId: string,
    @Query() query: unknown,
  ): Promise<z.infer<typeof photoViewSchema>> {
    const q = photoViewQuerySchema.safeParse(query);
    if (!q.success) throw Errors.validation(q.error.issues);
    return this.media.viewUrl(user, lotId, photoId, q.data.variant);
  }
}
