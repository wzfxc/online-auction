export const CLOCK = Symbol('CLOCK');
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export const RATE_LIMIT_POLICY = Symbol('RATE_LIMIT_POLICY');

export interface ApiConfig {
  jwtSecret: string;
  tokenTtlSeconds: number;
  webhookSecret: string;
}
