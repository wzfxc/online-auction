import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { ApiBodyOptions } from '@nestjs/swagger';
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Zod → OpenAPI 3 schema. Schemas are inlined, so the generated client needs no `$ref` resolution. */
type SchemaObject = Extract<ApiBodyOptions, { schema: unknown }>['schema'];

export function toSchema(schema: ZodTypeAny): SchemaObject {
  const json: Record<string, unknown> = { ...zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) };
  delete json.$schema;
  return json as SchemaObject;
}

export const ZBody = (schema: ZodTypeAny): MethodDecorator => ApiBody({ schema: toSchema(schema) });

export const ZResponse = (status: number, schema: ZodTypeAny, description = 'OK'): MethodDecorator =>
  ApiResponse({ status, description, schema: toSchema(schema) });

/** One `@ApiQuery` per field of the (flat) query schema. */
export function ZQuery<T extends ZodRawShape>(schema: ZodObject<T>): MethodDecorator {
  return applyDecorators(
    ...Object.entries(schema.shape).map(([name, field]) => {
      const f = field as ZodTypeAny;
      return ApiQuery({ name, required: !f.isOptional() && f._def.typeName !== 'ZodDefault', schema: toSchema(f) });
    }),
  );
}

export const IdempotencyKeyHeader = (): MethodDecorator =>
  ApiHeader({ name: 'idempotency-key', required: true, description: 'Unique key per logical operation (8–128 chars)' });

export const errorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

const ERROR_TEXT: Record<number, string> = {
  400: 'Invalid input (VALIDATION_ERROR)',
  401: 'Authentication required (UNAUTHORIZED)',
  403: 'Not allowed (FORBIDDEN and role/ownership codes)',
  404: 'Not found (NOT_FOUND)',
  409: 'State conflict (business-rule codes)',
  422: 'Rule violation (business-rule codes)',
};

/** Documents the single error envelope `{code, message, details}` for the listed statuses (invariant 15). */
export const ApiErrors = (...statuses: number[]): MethodDecorator =>
  applyDecorators(...statuses.map((s) => ZResponse(s, errorBodySchema, ERROR_TEXT[s] ?? 'Error')));
