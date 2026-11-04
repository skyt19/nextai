import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentService } from '../../src/services/payment.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { FrankfurterService } from '../../src/services/frankfurter.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('Phase 6: FX Snapshot and Financial History Audit', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const frankfurterService = new FrankfurterService();
  const paymentService = new PaymentService(customerService, frankfurterService);

  const testDiscordId = 'phase6-fx-tester-555';
  const testUsername = 'FxHistoryTester';

  beforeEach(async () => {
    try {
      const cust = await prisma.customer.findUnique({
        where: { discordUserId: testDiscordId },
        include: { payments: { include: { slips: true } } },
      });
      if (cust) {
        for (const p of cust.payments) {
          await prisma.paymentSlip.deleteMany({ where: { paymentId: p.id } });
        }
        await prisma.payment.deleteMany({ where: { customerId: cust.id } });
        await prisma.customer.delete({ where: { id: cust.id } });
      }
    } catch {
      // Ignore
    }
  });

  it('1. Persists exact FX snapshot at creation time and remains immutable across FX updates', async () => {
    // 1. Establish initial deterministic FX rate: 5.0764 THB/CNY
    await frankfurterService.setAdminFallbackRate('5.0764', '0.1415', '2026-11-01');

    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-fx-audit-p6',
      packageId: pkg.id,
    });

    const snap1 = JSON.parse(payment.calculationSnapshot);
    expect(snap1.cny_to_thb_rate).toBe('5.0764');
    expect(snap1.exchange_rate_date).toBe('2026-11-01');
    expect(snap1.final_payment_amount_thb).toBe('51.00');
    expect(snap1.provider_cost_budget_cny).toBe('2.0000');
    expect(snap1.estimated_provider_cost_thb).toBe('10.15'); // 2.00 * 5.0764 = 10.1528 -> 10.15

    // 2. Simulate subsequent FX market shift to 6.5000 THB/CNY
    await frankfurterService.setAdminFallbackRate('6.5000', '0.1500', '2026-11-03');

    // 3. Query historical payment from database
    const retrieved = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    const snap2 = JSON.parse(retrieved.calculationSnapshot);

    // Historical payment and snapshot must remain 100% identical
    expect(snap2.cny_to_thb_rate).toBe('5.0764');
    expect(snap2.exchange_rate_date).toBe('2026-11-01');
    expect(snap2.final_payment_amount_thb).toBe('51.00');
    expect(snap2.estimated_provider_cost_thb).toBe('10.15');
    expect(new Decimal(retrieved.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
  });

  it('2. Customer payment amount (51.00 THB) is strictly independent of FX fluctuations', async () => {
    // Create payments at different FX rates
    await frankfurterService.setAdminFallbackRate('4.8000', '0.1350', '2026-10-15');
    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const { payment: payLowFx } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-low-fx',
      packageId: pkg.id,
    });

    await frankfurterService.setAdminFallbackRate('5.8000', '0.1600', '2026-10-20');
    const { payment: payHighFx } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-high-fx',
      packageId: pkg.id,
    });

    // Both must be exactly 51.00 THB
    expect(new Decimal(payLowFx.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
    expect(new Decimal(payHighFx.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
  });
});
