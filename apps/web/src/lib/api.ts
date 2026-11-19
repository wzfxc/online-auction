import { createApiClient, type paths } from '@auction/api-client';

export type ApiClient = ReturnType<typeof createApiClient>;

export type UserDto = paths['/auth/me']['get']['responses'][200]['content']['application/json'];
export type AuthResultDto = paths['/auth/login']['post']['responses'][200]['content']['application/json'];
export type LotDto = paths['/lots/{id}']['get']['responses'][200]['content']['application/json'];
export type OwnLotDto = paths['/lots']['post']['responses'][201]['content']['application/json'];
export type MyLotsResultDto = paths['/lots/mine']['get']['responses'][200]['content']['application/json'];
export type LotEventDto = paths['/lots/{id}/history']['get']['responses'][200]['content']['application/json'][number];
export type BidHistoryDto = paths['/lots/{id}/bids']['get']['responses'][200]['content']['application/json'];
export type BidResultDto = paths['/lots/{id}/bids']['post']['responses'][201]['content']['application/json'];
export type BuyNowResultDto = paths['/lots/{id}/buy-now']['post']['responses'][201]['content']['application/json'];
export type SearchResultDto = paths['/search']['get']['responses'][200]['content']['application/json'];
export type SearchLotItemDto = SearchResultDto['items'][number];
export type CategoryDto = paths['/categories']['get']['responses'][200]['content']['application/json'][number];
export type CityDto = paths['/cities']['get']['responses'][200]['content']['application/json'][number];
export type WalletDto = paths['/wallet']['get']['responses'][200]['content']['application/json'];
export type WalletHistoryDto = paths['/wallet/history']['get']['responses'][200]['content']['application/json'];
export type SaleDto = paths['/sales/{id}']['get']['responses'][200]['content']['application/json'];
export type PhotoDto = paths['/lots/{id}/photos']['get']['responses'][200]['content']['application/json'][number];
export type NotificationDto = paths['/notifications']['get']['responses'][200]['content']['application/json'][number];
export type PeriodReportDto = paths['/reports/period']['get']['responses'][200]['content']['application/json'];
export type ReconciliationReportDto = paths['/reports/reconciliation']['get']['responses'][200]['content']['application/json'];

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function makeClient(baseUrl: string, token: string | null): ApiClient {
  return createApiClient({
    baseUrl,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.data !== undefined) return res.data;
  const err = res.error as Partial<ApiErrorEnvelope> | undefined;
  throw new ApiClientError(
    res.response.status,
    typeof err?.code === 'string' ? err.code : 'INTERNAL_ERROR',
    typeof err?.message === 'string' ? err.message : `HTTP ${res.response.status}`,
    err?.details,
  );
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
