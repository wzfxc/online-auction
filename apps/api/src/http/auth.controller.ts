import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { hashPassword, signToken, verifyPassword } from '../auth/crypto.js';
import type { Clock } from '../common/clock/clock.js';
import { AppError, Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Principal } from '../lots/lots.js';
import { CurrentUser, Public } from './auth.js';
import { ApiErrors, ZBody, ZResponse } from './openapi-helpers.js';
import { CLOCK, CONFIG, DB, type ApiConfig } from './tokens.js';
import { authResultSchema, loginSchema, registerSchema, userSchema } from './schemas.js';

type AuthResult = z.infer<typeof authResultSchema>;
type UserDto = z.infer<typeof userSchema>;

const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors; the Postgres code may sit on `cause`. */
function isUniqueViolation(e: unknown): boolean {
  const codeOf = (x: unknown): unknown => (x as { code?: unknown } | null)?.code;
  return codeOf(e) === UNIQUE_VIOLATION || codeOf((e as { cause?: unknown } | null)?.cause) === UNIQUE_VIOLATION;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ operationId: 'register', summary: 'Create a buyer or seller account' })
  @ZBody(registerSchema)
  @ZResponse(201, authResultSchema, 'Account created')
  @ApiErrors(400, 409)
  async register(@Body() raw: unknown): Promise<AuthResult> {
    const p = registerSchema.safeParse(raw);
    if (!p.success) throw Errors.validation(p.error.issues);
    const passwordHash = await hashPassword(p.data.password);
    try {
      const [row] = await this.db.insert(users).values({
        email: p.data.email, displayName: p.data.displayName, role: p.data.role, passwordHash,
        createdAt: this.clock.now(),
      }).returning();
      return this.issue(row!);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw e;
    }
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'login', summary: 'Exchange credentials for a bearer token' })
  @ZBody(loginSchema)
  @ZResponse(200, authResultSchema, 'Signed in')
  @ApiErrors(400, 401)
  async login(@Body() raw: unknown): Promise<AuthResult> {
    const p = loginSchema.safeParse(raw);
    if (!p.success) throw Errors.validation(p.error.issues);
    const [row] = await this.db.select().from(users).where(eq(users.email, p.data.email));
    // Same answer for "no such user" and "wrong password": no account probing.
    const ok = row ? await verifyPassword(p.data.password, row.passwordHash) : false;
    if (!row || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Wrong email or password');
    return this.issue(row);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ operationId: 'getMe', summary: 'Current user' })
  @ZResponse(200, userSchema)
  @ApiErrors(401)
  async me(@CurrentUser() user: Principal | null): Promise<UserDto> {
    const [row] = await this.db.select().from(users).where(eq(users.id, user!.id));
    if (!row) throw Errors.unauthorized();
    return toUser(row);
  }

  private issue(row: typeof users.$inferSelect): AuthResult {
    const exp = Math.floor(this.clock.now().getTime() / 1000) + this.config.tokenTtlSeconds;
    const token = signToken({ sub: row.id, role: row.role, exp }, this.config.jwtSecret);
    return { token, expiresAt: new Date(exp * 1000).toISOString(), user: toUser(row) };
  }
}

function toUser(row: typeof users.$inferSelect): UserDto {
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
}
