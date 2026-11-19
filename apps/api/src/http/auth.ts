import {
  createParamDecorator, Inject, Injectable, SetMetadata,
  type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { verifyToken, type Role } from '../auth/crypto.js';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import type { Principal } from '../lots/lots.js';
import { CLOCK, CONFIG, type ApiConfig } from './tokens.js';

const ROLES_KEY = 'auction:roles';
const PUBLIC_KEY = 'auction:public';

/** Endpoint is open to anyone; a valid token, when sent, still identifies the viewer. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);
/** Endpoint requires one of these roles (checked on the server in every request, invariant 14). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

type AuthedRequest = Request & { principal?: Principal | null };

/** The authenticated user; `null` only on `@Public()` endpoints without a valid token. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal | null =>
  ctx.switchToHttp().getRequest<AuthedRequest>().principal ?? null);

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

/** Global guard: secure by default. Only `@Public()` routes may be reached without a token. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    const token = bearerToken(req.headers.authorization);
    const claims = token ? verifyToken(token, this.config.jwtSecret, Math.floor(this.clock.now().getTime() / 1000)) : null;
    req.principal = claims ? { id: claims.sub, role: claims.role } : null;

    if (isPublic && !roles) return true;
    if (!req.principal) throw Errors.unauthorized();
    if (roles && !roles.includes(req.principal.role)) throw Errors.forbidden('Role is not allowed here');
    return true;
  }
}
