import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import type { Principal } from '../lots/lots.js';
import type { PaymentProvider, ProviderStatus } from '../payments-stub/provider.js';

const DAY_MS = 86_400_000;
const DEFAULT_PERIOD_DAYS = 90;

export const periodReportQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
});

export interface CategoryBreakdownDto {
  categoryId: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  namePl: string;
  paidCount: number;
  unpaidCount: number;
  turnover: number;
  commission: number;
}

export interface PeriodReportDto {
  from: string;
  to: string;
  turnover: number;
  commission: number;
  totalWins: number;
  paidWins: number;
  unpaidWins: number;
  awaitingPaymentWins: number;
  /** Fraction of wins in [0, 1] that defaulted without payment. */
  unpaidShare: number;
  byCategory: CategoryBreakdownDto[];
}

export interface WalletMismatchDto {
  accountId: string;
  userId: string | null;
  type: string;
  accountBalance: number;
  entriesSum: number;
}

export interface PaymentDiscrepancyDto {
  paymentId: string;
  userId: string;
  amount: number;
  dbStatus: string;
  providerStatus: ProviderStatus;
  ledgerCredited: boolean;
  reason: 'status_mismatch' | 'missing_ledger_credit' | 'unexpected_ledger_credit';
}

export interface ReconciliationReportDto {
  healthy: boolean;
  entriesSum: number;
  unbalancedTransactions: string[];
  checkedAccounts: number;
  walletMismatches: WalletMismatchDto[];
  checkedPayments: number;
  paymentDiscrepancies: PaymentDiscrepancyDto[];
}

function parseBound(raw: string | undefined, fallback: Date, endOfDayIfDateOnly: boolean): Date {
  if (!raw) return fallback;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const iso = isDateOnly ? `${raw}T${endOfDayIfDateOnly ? '23:59:59.999Z' : '00:00:00.000Z'}` : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw Errors.validation([{ path: ['period'], message: `Invalid date: ${raw}` }]);
  }
  return d;
}

export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly paymentProvider: PaymentProvider,
  ) {}

  /**
   * Finance period report: turnover, commission, share of unpaid wins, and category breakdown
   * over `[from, to]` (defaults to the last 90 days by the server clock).
   */
  async periodReport(viewer: Principal, rawQuery: unknown): Promise<PeriodReportDto> {
    this.assertFinance(viewer);
    const parsed = periodReportQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) throw Errors.validation(parsed.error.issues);

    const now = this.clock.now();
    const defaultFrom = new Date(now.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);
    const from = parseBound(parsed.data.from, defaultFrom, false);
    const to = parseBound(parsed.data.to, now, true);
    if (from.getTime() > to.getTime()) {
      throw Errors.validation([{ path: ['from'], message: 'from must not be after to' }]);
    }

    const summaryRes = await this.db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN s.status IN ('paid', 'shipped', 'completed') THEN s.price ELSE 0 END), 0)::bigint AS turnover,
        COALESCE(SUM(CASE WHEN s.status IN ('paid', 'shipped', 'completed') THEN s.fee ELSE 0 END), 0)::bigint AS commission,
        COUNT(*)::int AS total_wins,
        COUNT(*) FILTER (WHERE s.status IN ('paid', 'shipped', 'completed'))::int AS paid_wins,
        COUNT(*) FILTER (WHERE s.status = 'defaulted')::int AS unpaid_wins,
        COUNT(*) FILTER (WHERE s.status = 'awaiting_payment')::int AS awaiting_wins
      FROM sales s
      WHERE s.created_at >= ${from.toISOString()}::timestamptz
        AND s.created_at <= ${to.toISOString()}::timestamptz
    `);

    const sRow = (summaryRes.rows[0] ?? {}) as {
      turnover?: string | number;
      commission?: string | number;
      total_wins?: number;
      paid_wins?: number;
      unpaid_wins?: number;
      awaiting_wins?: number;
    };

    const turnover = Number(sRow.turnover ?? 0);
    const commission = Number(sRow.commission ?? 0);
    const totalWins = Number(sRow.total_wins ?? 0);
    const paidWins = Number(sRow.paid_wins ?? 0);
    const unpaidWins = Number(sRow.unpaid_wins ?? 0);
    const awaitingPaymentWins = Number(sRow.awaiting_wins ?? 0);
    const unpaidShare = totalWins === 0 ? 0 : Number((unpaidWins / totalWins).toFixed(4));

    const catRes = await this.db.execute(sql`
      SELECT
        c.id AS category_id,
        c.slug,
        c.name_uk,
        c.name_en,
        c.name_pl,
        COUNT(*) FILTER (WHERE s.status IN ('paid', 'shipped', 'completed'))::int AS paid_count,
        COUNT(*) FILTER (WHERE s.status = 'defaulted')::int AS unpaid_count,
        COALESCE(SUM(CASE WHEN s.status IN ('paid', 'shipped', 'completed') THEN s.price ELSE 0 END), 0)::bigint AS turnover,
        COALESCE(SUM(CASE WHEN s.status IN ('paid', 'shipped', 'completed') THEN s.fee ELSE 0 END), 0)::bigint AS commission
      FROM sales s
      INNER JOIN lots l ON l.id = s.lot_id
      INNER JOIN categories c ON c.id = l.category_id
      WHERE s.created_at >= ${from.toISOString()}::timestamptz
        AND s.created_at <= ${to.toISOString()}::timestamptz
      GROUP BY c.id, c.slug, c.name_uk, c.name_en, c.name_pl
      ORDER BY turnover DESC, c.slug ASC
    `);

    const byCategory: CategoryBreakdownDto[] = catRes.rows.map((r) => {
      const x = r as {
        category_id: string;
        slug: string;
        name_uk: string;
        name_en: string;
        name_pl: string;
        paid_count: number;
        unpaid_count: number;
        turnover: string | number;
        commission: string | number;
      };
      return {
        categoryId: x.category_id,
        slug: x.slug,
        nameUk: x.name_uk,
        nameEn: x.name_en,
        namePl: x.name_pl,
        paidCount: Number(x.paid_count),
        unpaidCount: Number(x.unpaid_count),
        turnover: Number(x.turnover),
        commission: Number(x.commission),
      };
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      turnover,
      commission,
      totalWins,
      paidWins,
      unpaidWins,
      awaitingPaymentWins,
      unpaidShare,
      byCategory,
    };
  }

  /**
   * Full financial reconciliation:
   * 1. Sum of all ledger entries == 0 and no transaction is unbalanced.
   * 2. Every account balance equals the sum of its ledger entries.
   * 3. Payments table and ledger credits match the payment stub provider's statuses.
   */
  async reconcileReport(viewer: Principal): Promise<ReconciliationReportDto> {
    this.assertFinance(viewer);

    const sumRes = await this.db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::bigint AS entries_sum FROM ledger_entries
    `);
    const entriesSum = Number((sumRes.rows[0] as { entries_sum?: string | number } | undefined)?.entries_sum ?? 0);

    const unbalRes = await this.db.execute(sql`
      SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0
    `);
    const unbalancedTransactions = unbalRes.rows.map((r) => String((r as { tx_id: string }).tx_id));

    const accCountRes = await this.db.execute(sql`SELECT COUNT(*)::int AS cnt FROM accounts`);
    const checkedAccounts = Number((accCountRes.rows[0] as { cnt?: number } | undefined)?.cnt ?? 0);

    const mismatchRes = await this.db.execute(sql`
      SELECT
        a.id AS account_id,
        a.user_id,
        a.type,
        a.balance::bigint AS account_balance,
        COALESCE(SUM(e.amount), 0)::bigint AS entries_sum
      FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id, a.user_id, a.type, a.balance
      HAVING a.balance <> COALESCE(SUM(e.amount), 0)
      ORDER BY a.id
    `);

    const walletMismatches: WalletMismatchDto[] = mismatchRes.rows.map((r) => {
      const x = r as {
        account_id: string;
        user_id: string | null;
        type: string;
        account_balance: string | number;
        entries_sum: string | number;
      };
      return {
        accountId: x.account_id,
        userId: x.user_id,
        type: x.type,
        accountBalance: Number(x.account_balance),
        entriesSum: Number(x.entries_sum),
      };
    });

    const payRes = await this.db.execute(sql`
      SELECT
        p.id,
        p.user_id,
        p.amount::bigint AS amount,
        p.status,
        EXISTS (
          SELECT 1 FROM ledger_transactions lt WHERE lt.effect_key = 'topup:' || p.id::text
        ) AS ledger_credited
      FROM payments p
      ORDER BY p.created_at DESC
    `);

    const paymentDiscrepancies: PaymentDiscrepancyDto[] = [];
    for (const r of payRes.rows) {
      const p = r as {
        id: string;
        user_id: string;
        amount: string | number;
        status: string;
        ledger_credited: boolean;
      };
      const providerStatus = await this.paymentProvider.getStatus(p.id);
      const amount = Number(p.amount);
      if (p.status !== providerStatus) {
        paymentDiscrepancies.push({
          paymentId: p.id,
          userId: p.user_id,
          amount,
          dbStatus: p.status,
          providerStatus,
          ledgerCredited: p.ledger_credited,
          reason: 'status_mismatch',
        });
      } else if (p.status === 'succeeded' && !p.ledger_credited) {
        paymentDiscrepancies.push({
          paymentId: p.id,
          userId: p.user_id,
          amount,
          dbStatus: p.status,
          providerStatus,
          ledgerCredited: false,
          reason: 'missing_ledger_credit',
        });
      } else if (p.status !== 'succeeded' && p.ledger_credited) {
        paymentDiscrepancies.push({
          paymentId: p.id,
          userId: p.user_id,
          amount,
          dbStatus: p.status,
          providerStatus,
          ledgerCredited: true,
          reason: 'unexpected_ledger_credit',
        });
      }
    }

    const healthy =
      entriesSum === 0
      && unbalancedTransactions.length === 0
      && walletMismatches.length === 0
      && paymentDiscrepancies.length === 0;

    return {
      healthy,
      entriesSum,
      unbalancedTransactions,
      checkedAccounts,
      walletMismatches,
      checkedPayments: payRes.rows.length,
      paymentDiscrepancies,
    };
  }

  private assertFinance(user: Principal): void {
    if (user.role !== 'finance') throw Errors.forbidden('Finance role required');
  }
}
