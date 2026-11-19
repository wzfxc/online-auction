import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/schema.js';

export type { paths, components, operations } from './generated/schema.js';

/** Typed client; every request and response type comes from the generated OpenAPI schema. */
export function createApiClient(options: ClientOptions) {
  return createClient<paths>(options);
}
