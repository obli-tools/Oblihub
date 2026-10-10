import type { Knex } from 'knex';

/**
 * Track per-certificate notification state so the renewal/expiry alert flow can avoid
 * spamming the operator.
 *
 * - `last_renewal_failed_notified_at`: stamped once when status transitions valid→error so
 *   a single failure produces one alert (not one every 12h tick).
 * - `last_expiry_warning_at`: stamped on each "expiring soon" alert so the next warning
 *   only fires after a cool-down window (default: 7 days).
 *
 * Both columns are nullable; cleared explicitly by the renewal flow when a cert returns to
 * a healthy state so the next failure is alerted again.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('certificates', (t) => {
    t.timestamp('last_renewal_failed_notified_at').nullable();
    t.timestamp('last_expiry_warning_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('certificates', (t) => {
    t.dropColumn('last_renewal_failed_notified_at');
    t.dropColumn('last_expiry_warning_at');
  });
}
