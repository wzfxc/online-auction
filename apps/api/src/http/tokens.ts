export const CLOCK = Symbol('CLOCK');
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');

export interface ApiConfig {
  jwtSecret: string;
  tokenTtlSeconds: number;
  webhookSecret: string;
}
