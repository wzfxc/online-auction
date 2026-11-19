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
