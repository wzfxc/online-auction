import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { BidService } from '../bids/bids.js';
import { LotService } from '../lots/lots.js';
import { PaymentService } from '../payments/payments.js';
import { MediaService } from '../media/media.js';
import type { ObjectStorage } from '../media/storage.js';
import { ModerationService } from '../moderation/moderation.js';
import { NotificationService } from '../notifications/notifications.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { SearchService } from '../search/search.js';
import type { Meilisearch } from 'meilisearch';
import { MediaController } from './media.controller.js';
import { ModerationController } from './moderation.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { PaymentsController } from './payments.controller.js';
import { SearchController } from './search.controller.js';
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
  paymentProvider: StubPaymentProvider;
  storage: ObjectStorage;
  meili: Meilisearch;
}

export const CONTROLLERS = [
  AuthController, LotsController, BidsController, WalletController,
  ModerationController, MediaController, SearchController, NotificationsController, PaymentsController,
];

/** The API never sends mail itself (the worker drains the outbox); reaching this is a wiring bug. */
const NO_MAIL = { send: (): Promise<void> => Promise.reject(new Error('The API process does not send email')) };

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
      { provide: StubPaymentProvider, useValue: deps.paymentProvider },
      { provide: ModerationService, useValue: new ModerationService(deps.db, deps.clock) },
      { provide: MediaService, useValue: new MediaService(deps.db, deps.clock, deps.storage) },
      { provide: SearchService, useValue: new SearchService(deps.meili, () => deps.clock.now()) },
      { provide: NotificationService, useValue: new NotificationService(deps.db, deps.clock, NO_MAIL) },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ];
    return { module: AppModule, controllers: CONTROLLERS, providers };
  }
}
