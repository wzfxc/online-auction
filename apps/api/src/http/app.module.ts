import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { BidService } from '../bids/bids.js';
import { LotService } from '../lots/lots.js';
import { PaymentService } from '../payments/payments.js';
import type { PaymentProvider } from '../payments-stub/provider.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.js';
import { BidsController } from './bids.controller.js';
import { ErrorFilter } from './error.filter.js';
import { LotsController } from './lots.controller.js';
import { CLOCK, CONFIG, DB, type ApiConfig } from './tokens.js';
import { WalletController } from './wallet.controller.js';

export interface ApiDeps {
  db: Db;
  clock: Clock;
  config: ApiConfig;
  paymentProvider: PaymentProvider;
}

export const CONTROLLERS = [AuthController, LotsController, BidsController, WalletController];

/** Composition root: every collaborator is passed in, so tests can swap the database, clock and gateway. */
@Module({})
export class AppModule {
  static register(deps: ApiDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: DB, useValue: deps.db },
      { provide: CLOCK, useValue: deps.clock },
      { provide: CONFIG, useValue: deps.config },
      { provide: LotService, useValue: new LotService(deps.db, deps.clock) },
      { provide: BidService, useValue: new BidService(deps.db, deps.clock) },
      {
        provide: PaymentService,
        useValue: new PaymentService(deps.db, deps.clock, deps.paymentProvider, deps.config.webhookSecret),
      },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ];
    return { module: AppModule, controllers: CONTROLLERS, providers };
  }
}
