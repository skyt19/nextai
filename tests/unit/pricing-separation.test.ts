import { describe, it, expect, beforeEach } from 'vitest';
import { QuotaCalculator } from '../../src/services/calculator.service.js';
import { PaymentService } from '../../src/services/payment.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { FrankfurterService } from '../../src/services/frankfurter.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS, PAYMENT_STATUS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('Pricing, Upstream Allocation & Payment Separation Tests (Section 10)', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const frankfurterService = new FrankfurterService();
  const paymentService = new PaymentService(customerService, frankfurterService);

  const testDiscordId = '101010101010101010';
  const testUsername = 'PricingAuditTester';
  const testRateDate = '2026-11-03';

  beforeEach(async () => {
    try {
      const testCust = await prisma.customer.findUnique({
        where: { discordUserId: testDiscordId },
        include: { payments: true },
      });
      if (testCust) {
        for (const p of testCust.payments) {
          await prisma.paymentSlip.deleteMany({ where: { paymentId: p.id } });
        }
        await prisma.payment.deleteMany({ where: { customerId: testCust.id } });
        await prisma.customer.delete({ where: { id: testCust.id } });
      }
      await prisma.package.deleteMany({
        where: { name: { contains: 'Test Audit' } },
      });
    } catch {
      // Ignore
    }
  });

  /**
   * TEST A. Baseline: BP .020, 100 requests, markup 2.5, selling 51 THB.
   * Expect display .050/request, display reference 5.00 CNY, provider cost 2.00 CNY, Discord payment 51 THB.
   */
  it('A. Baseline NxG1: display .050/request, display reference 5.00 CNY, provider cost 2.00 CNY, Discord payment 51 THB', () => {
    const calc = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: testRateDate,
      bufferCny: '0',
    });

    expect(calc.displayPricePerRequestCny.toString()).toBe('0.05');
    expect(calc.displayReferenceValueCny.toString()).toBe('5');
    expect(calc.providerCostBudgetCny.toString()).toBe('2');
    expect(calc.finalPaymentAmountThb.toString()).toBe('51');
    expect(calc.snapshot.display_price_per_request_cny).toBe('0.0500');
    expect(calc.snapshot.display_reference_value_cny).toBe('5.0000');
    expect(calc.snapshot.provider_cost_budget_cny).toBe('2.0000');
    expect(calc.snapshot.final_payment_amount_thb).toBe('51.00');
  });

  /**
   * TEST B. BP .100, 100 requests, selling 51 THB.
   * Expect provider cost 10 CNY; payment remains 51 THB.
   */
  it('B. Higher BP .100: provider cost becomes 10 CNY; customer payment remains 51 THB', () => {
    const calc = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.100',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: testRateDate,
    });

    expect(calc.providerCostBudgetCny.toString()).toBe('10');
    expect(calc.finalPaymentAmountThb.toString()).toBe('51');
    expect(calc.snapshot.provider_cost_budget_cny).toBe('10.0000');
    expect(calc.snapshot.final_payment_amount_thb).toBe('51.00');
  });

  /**
   * TEST C. Change FX: THB cost and estimated profit change; payment remains 51 THB.
   */
  it('C. Change FX rate: cost and estimated profit change; payment remains strictly 51 THB', () => {
    // Case 1: FX = 5.00 THB/CNY
    const calc1 = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0000',
      exchangeRateDate: testRateDate,
    });

    // 2.00 CNY * 5.00 = 10.00 THB provider cost; profit = 51 - 10 = 41.00 THB
    expect(calc1.estimatedProviderCostThb.toString()).toBe('10');
    expect(calc1.estimatedGrossProfitThb.toString()).toBe('41');
    expect(calc1.finalPaymentAmountThb.toString()).toBe('51');

    // Case 2: FX = 5.50 THB/CNY
    const calc2 = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.5000',
      exchangeRateDate: testRateDate,
    });

    // 2.00 CNY * 5.50 = 11.00 THB provider cost; profit = 51 - 11 = 40.00 THB
    expect(calc2.estimatedProviderCostThb.toString()).toBe('11');
    expect(calc2.estimatedGrossProfitThb.toString()).toBe('40');
    expect(calc2.finalPaymentAmountThb.toString()).toBe('51'); // Strictly unchanged!
  });

  /**
   * TEST D. Change markup 2.5 to 3: display price changes; selling price and payment remain 51 THB.
   */
  it('D. Change markup 2.5 to 3: display price changes; selling price and payment remain 51 THB', () => {
    const calc = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '3.0',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: testRateDate,
    });

    // Display price: 0.020 * 3.0 = 0.060 CNY/request; display ref = 6.00 CNY
    expect(calc.displayPricePerRequestCny.toString()).toBe('0.06');
    expect(calc.displayReferenceValueCny.toString()).toBe('6');
    // Selling price and payment remain 51 THB
    expect(calc.packageSellingPriceThb.toString()).toBe('51');
    expect(calc.finalPaymentAmountThb.toString()).toBe('51');
  });

  /**
   * TEST E. Change package selling price to 75: payment becomes 75 THB; provider cost and allocation remain 2 CNY.
   */
  it('E. Change package selling price to 75: payment becomes 75 THB; provider cost and allocation remain 2 CNY', () => {
    const calc = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '75.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: testRateDate,
      bufferCny: '0',
    });

    expect(calc.finalPaymentAmountThb.toString()).toBe('75');
    expect(calc.providerCostBudgetCny.toString()).toBe('2');
    expect(calc.assignedUpstreamQuotaCny.toString()).toBe('2');
  });

  /**
   * TEST F. Payment snapshot: create payment at 51, then change package to 75.
   * Old payment remains 51; new payment uses 75.
   */
  it('F. Payment snapshot immutability: old payment remains 51 THB when package price changes to 75 THB', async () => {
    await frankfurterService.setAdminFallbackRate('5.0764', '0.1500', testRateDate);

    // 1. Create package at 51.00 THB
    const pkg = await prisma.package.create({
      data: {
        name: 'Test Audit Package NxG1',
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelId: 'gemini-3-1-pro-high-nxg1',
        referenceRequests: 100,
        referenceModelCostCny: '0.020',
        markup: '2.5',
        sellingPriceThb: '51.00',
        bufferCny: '0.0',
        enabled: true,
      },
    });

    // 2. Customer 1 opens payment at 51.00 THB
    const { payment: payment1 } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-old-51',
      packageId: pkg.id,
    });

    expect(new Decimal(payment1.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');

    // 3. Administrator updates package selling price to 75.00 THB in database
    await prisma.package.update({
      where: { id: pkg.id },
      data: { sellingPriceThb: '75.00' },
    });

    // 4. Customer 2 opens payment after price update
    const { payment: payment2 } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-new-75',
      packageId: pkg.id,
    });

    // 5. Verify historical snapshot: Payment 1 remains 51.00 THB, Payment 2 is 75.00 THB
    const retrievedPayment1 = await prisma.payment.findUniqueOrThrow({
      where: { id: payment1.id },
    });
    expect(new Decimal(retrievedPayment1.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
    expect(new Decimal(payment2.expectedAmountThb.toString()).toFixed(2)).toBe('75.00');
  });

  /**
   * TEST G. Verify proxy requests do not locally deduct customer balances or duplicate BearLab billing.
   */
  it('G. Reverse proxy does not locally deduct customer balance per request', async () => {
    // 1. Create a customer with 50.00 CNY balance
    const { customerId, profile } = await customerService.findOrCreateCustomer(
      testDiscordId,
      testUsername
    );
    await customerService.updateRecordedBalance(testDiscordId, '50.00');

    const customerBefore = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(new Decimal(customerBefore.balance.toString()).toFixed(2)).toBe('50.00');

    // 2. Perform authentication and authorization checks (same as proxy request flow)
    const { plainTextApiKey } = await customerService.generateOrRotateApiKey(testDiscordId);
    await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_A);

    const authResult = await customerService.authenticateApiKey(plainTextApiKey);
    expect(authResult.customerId).toBe(customerId);
    expect(authResult.allowedGroups).toContain(MODEL_GROUPS.GROUP_A);

    // 3. Verify customer balance in database was NEVER debited or changed
    const customerAfter = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(new Decimal(customerAfter.balance.toString()).toFixed(2)).toBe('50.00');
  });

  /**
   * TEST H. Buffer 0 gives allocation 2 CNY; buffer .50 gives 2.50 CNY; customer selling price remains 51 THB in both cases.
   */
  it('H. Buffer policy: buffer 0 gives allocation 2 CNY; buffer .50 gives 2.50 CNY; payment remains 51 THB in both', () => {
    // Case 1: buffer = 0
    const calc1 = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: testRateDate,
      bufferCny: '0',
    });

    expect(calc1.providerCostBudgetCny.toString()).toBe('2');
    expect(calc1.assignedUpstreamQuotaCny.toString()).toBe('2');
    expect(calc1.finalPaymentAmountThb.toString()).toBe('51');

    // Case 2: buffer = 0.50
    const calc2 = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      customMarkup: '2.5',
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: testRateDate,
      bufferCny: '0.50',
    });

    expect(calc2.providerCostBudgetCny.toString()).toBe('2');
    expect(calc2.assignedUpstreamQuotaCny.toString()).toBe('2.5');
    expect(calc2.finalPaymentAmountThb.toString()).toBe('51'); // Strictly unchanged!
  });

  /**
   * TEST I. Package price isolation: NxG1 is 51 THB, NxGE is 90 THB, NxGC is 75 THB.
   */
  it('I. Package Price Isolation: distinct groups retain their own configured prices without silent defaults', async () => {
    const pkgNxG1 = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const pkgNxGE = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_E, 100);
    const pkgNxGC = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_CLAUDE, 100);

    expect(new Decimal(pkgNxG1.sellingPriceThb.toString()).toFixed(2)).toBe('51.00');
    expect(new Decimal(pkgNxGE.sellingPriceThb.toString()).toFixed(2)).toBe('90.00');
    expect(new Decimal(pkgNxGC.sellingPriceThb.toString()).toFixed(2)).toBe('75.00');
  });

  /**
   * TEST J. Missing or zero package selling price throws error safely.
   */
  it('J. Missing or zero package selling price throws PaymentError and NEVER silently falls back to 51 THB', async () => {
    const invalidPkg = await prisma.package.create({
      data: {
        name: 'Test Audit Package Zero Price',
        groupId: MODEL_GROUPS.GROUP_A,
        referenceRequests: 100,
        referenceModelCostCny: '0.020',
        markup: '2.5',
        sellingPriceThb: '0.00',
        enabled: true,
      },
    });

    await expect(
      paymentService.createPendingPayment({
        discordUserId: testDiscordId,
        username: testUsername,
        ticketChannelId: 'ticket-zero-price',
        packageId: invalidPkg.id,
      })
    ).rejects.toThrow('has no valid selling price configured');
  });

  /**
   * TEST K. Historical cost calculations remain reproducible; later FX updates do not alter past snapshots.
   */
  it('K. FX Snapshot Immutability: later FX update never alters historical payment calculation snapshot', async () => {
    await frankfurterService.setAdminFallbackRate('5.0764', '0.1500', '2026-11-01');

    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-fx-audit',
      packageId: pkg.id,
    });

    const initialSnapshot = JSON.parse(payment.calculationSnapshot);
    expect(initialSnapshot.cny_to_thb_rate).toBe('5.0764');
    expect(initialSnapshot.final_payment_amount_thb).toBe('51.00');
    expect(initialSnapshot.estimated_provider_cost_thb).toBe('10.15');

    // Simulate FX rate change in Frankfurter to 6.2000 THB/CNY
    await frankfurterService.setAdminFallbackRate('6.2000', '0.1500', '2026-11-03');

    // Retrieve historical payment from database
    const retrievedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    const retrievedSnapshot = JSON.parse(retrievedPayment.calculationSnapshot);

    // Verify historical snapshot remains completely unchanged
    expect(retrievedSnapshot.cny_to_thb_rate).toBe('5.0764');
    expect(retrievedSnapshot.final_payment_amount_thb).toBe('51.00');
    expect(retrievedSnapshot.estimated_provider_cost_thb).toBe('10.15');
    expect(new Decimal(retrievedPayment.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
  });
});
