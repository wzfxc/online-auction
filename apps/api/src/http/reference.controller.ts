import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { LotService, type CategoryDto, type CityDto, type LotDto, type Principal } from '../lots/lots.js';
import { CurrentUser, Public, Roles } from './auth.js';
import { ApiErrors, ZResponse } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { categorySchema, citySchema, favoriteStatusSchema, lotSchema } from './schemas.js';

@ApiTags('reference')
@Controller()
export class ReferenceController {
  constructor(@Inject(LotService) private readonly lots: LotService) {}

  @Public()
  @Get('categories')
  @ApiOperation({ operationId: 'listCategories', summary: 'All categories (uk/en/pl)' })
  @ZResponse(200, z.array(categorySchema))
  categories(): Promise<CategoryDto[]> {
    return this.lots.listCategories();
  }

  @Public()
  @Get('cities')
  @ApiOperation({ operationId: 'listCities', summary: 'All cities (uk/en/pl)' })
  @ZResponse(200, z.array(citySchema))
  cities(): Promise<CityDto[]> {
    return this.lots.listCities();
  }

  @ApiBearerAuth()
  @Roles('buyer', 'seller')
  @Get('favorites')
  @ApiOperation({ operationId: 'listFavorites', summary: 'Own favorite lots' })
  @ZResponse(200, z.array(lotSchema))
  @ApiErrors(401, 403)
  listFavorites(@CurrentUser() user: Principal | null): Promise<LotDto[]> {
    return this.lots.listFavorites(user!);
  }

  @ApiBearerAuth()
  @Roles('buyer', 'seller')
  @Post('favorites/:id')
  @HttpCode(200)
  @ApiOperation({ operationId: 'addFavorite', summary: 'Add a lot to favorites (1h ending reminder)' })
  @ZResponse(200, favoriteStatusSchema)
  @ApiErrors(400, 401, 403, 404)
  addFavorite(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
  ): Promise<z.infer<typeof favoriteStatusSchema>> {
    return this.lots.addFavorite(user!, lotId);
  }

  @ApiBearerAuth()
  @Roles('buyer', 'seller')
  @Delete('favorites/:id')
  @HttpCode(200)
  @ApiOperation({ operationId: 'removeFavorite', summary: 'Remove a lot from favorites' })
  @ZResponse(200, favoriteStatusSchema)
  @ApiErrors(400, 401, 403)
  removeFavorite(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
  ): Promise<z.infer<typeof favoriteStatusSchema>> {
    return this.lots.removeFavorite(user!, lotId);
  }
}
