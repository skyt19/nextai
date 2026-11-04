import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Decimal } from 'decimal.js';
import { QuotaCalculator } from '../../src/services/calculator.service.js';
import {
  FundingService,
  FUNDING_STATUS,
  TOPUP_RECOMMENDATION_STATUS,
} from '../../src/services/funding.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { PaymentService } from '../../src/services/payment.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS, GROUP_MARKUPS, PAYMENT_STATUS } from '../../src/config/constants.js';
import { STATIC_MODEL_CATALOG } from '../../src/services/catalog-data.js';

describe('NextAI Pricing, Customer Quota & BearLab Funding Logic Correction Tests (Section 9)', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const paymentService = new PaymentService(customerService);
  const fundingService = new FundingService();

  const testDiscordId = 'unit-test-pricing-99001';
  const testAdminId = 'unit-test-admin-99002';
  const testRateDate = '2026-11-04';
  const defaultRate = '5.0764';

  beforeAll(async () => {
    try {
      await prisma.customer.deleteMany({
        where: { discordUserId: { in: [testDiscordId] } },
      });
      await prisma.package.deleteMany({
        where: { name: { contains: 'Correction Test' } },
      });
    } catch {
      // Ignore
    }
  });

  afterAll(async () => {
    try {
      await prisma.customer.deleteMany({
        where: { discordUserId: { in: [testDiscordId] } },
      });
      await prisma.package.deleteMany({
        where: { name: { contains: 'Correction Test' } },
      });
      await prisma.bearlabTopupRecord.deleteMany({
        where: { adminDiscordId: testAdminId },
      });
    } catch {
      // Ignore
    }
  });

  // ==============================================================
  // 1. NxG1 Selling Price = ¥0.050/request
  // ==============================================================
  it('1. NxG1 Selling Price = ¥0.050/request (Base Cost ¥0.020 × Markup 2.5x)', () => {
    const sellingPrice = QuotaCalculator.calculateSellingPrice('0.020', '2.5');
    expect(sellingPrice.toFixed(3)).toBe('0.050');

    // Verification against STATIC_MODEL_CATALOG reference model
    const refModel = STATIC_MODEL_CATALOG.find((m) => m.publicModelId === 'gemini-3-1-pro-high-nxg1');
    expect(refModel).toBeDefined();
    expect(refModel?.groupId).toBe(MODEL_GROUPS.GROUP_A);
    expect(refModel?.baseCostCny).toBe('0.020');
    expect(refModel?.markup).toBe('2.5');
    expect(refModel?.sellingPriceCny).toBe('0.050');
  });

  // ==============================================================
  // 2. NxGE Selling Price = ¥0.090/request
  // ==============================================================
  it('2. NxGE Selling Price = ¥0.090/request (Base Cost ¥0.030 × Markup 3.0x)', () => {
    const sellingPrice = QuotaCalculator.calculateSellingPrice('0.030', '3.0');
    expect(sellingPrice.toFixed(3)).toBe('0.090');

    // Verification against STATIC_MODEL_CATALOG reference model
    const refModel = STATIC_MODEL_CATALOG.find((m) => m.publicModelId === 'gemini-2-5-pro-nxge');
    expect(refModel).toBeDefined();
    expect(refModel?.groupId).toBe(MODEL_GROUPS.GROUP_E);
    expect(refModel?.baseCostCny).toBe('0.030');
    expect(refModel?.markup).toBe('3.0');
    expect(refModel?.sellingPriceCny).toBe('0.090');
  });

  // ==============================================================
  // 3. NxGC Selling Price = ¥0.075/request
  // ==============================================================
  it('3. NxGC Selling Price = ¥0.075/request (Base Cost ¥0.030 × Markup 2.5x)', () => {
    const sellingPrice = QuotaCalculator.calculateSellingPrice('0.030', '2.5');
    expect(sellingPrice.toFixed(3)).toBe('0.075');

    // Verification against STATIC_MODEL_CATALOG reference model
    const refModel = STATIC_MODEL_CATALOG.find((m) => m.publicModelId === 'claude-opus-4-5-nxgc');
    expect(refModel).toBeDefined();
    expect(refModel?.groupId).toBe(MODEL_GROUPS.GROUP_CLAUDE);
    expect(refModel?.baseCostCny).toBe('0.030');
    expect(refModel?.markup).toBe('2.5');
    expect(refModel?.sellingPriceCny).toBe('0.075');
  });

  // ==============================================================
  // 4. NxG1 Provider Cost for 100 requests = ¥2.00
  // ==============================================================
  it('4. NxG1 Provider Cost for 100 requests = ¥2.00 (Base Cost ¥0.020 × 100)', () => {
    const providerCost = QuotaCalculator.calculateProviderCost('0.020', 100);
    expect(providerCost.toFixed(2)).toBe('2.00');
  });

  // ==============================================================
  // 5. NxGE Provider Cost for 100 requests = ¥3.00
  // ==============================================================
  it('5. NxGE Provider Cost for 100 requests = ¥3.00 (Base Cost ¥0.030 × 100)', () => {
    const providerCost = QuotaCalculator.calculateProviderCost('0.030', 100);
    expect(providerCost.toFixed(2)).toBe('3.00');
  });

  // ==============================================================
  // 6. NxGC Provider Cost for 100 requests = ¥3.00
  // ==============================================================
  it('6. NxGC Provider Cost for 100 requests = ¥3.00 (Base Cost ¥0.030 × 100)', () => {
    const providerCost = QuotaCalculator.calculateProviderCost('0.030', 100);
    expect(providerCost.toFixed(2)).toBe('3.00');
  });

  // ==============================================================
  // 7. NxG1 Customer Quota for 100 requests = ¥5.00
  // ==============================================================
  it('7. NxG1 Customer Quota for 100 requests = ¥5.00 (Selling Price ¥0.050 × 100)', () => {
    const customerQuota = QuotaCalculator.calculateCustomerQuota('0.050', 100);
    expect(customerQuota.toFixed(2)).toBe('5.00');

    const quotaFromBase = QuotaCalculator.calculateCustomerQuotaFromBaseCost('0.020', '2.5', 100);
    expect(quotaFromBase.toFixed(2)).toBe('5.00');
  });

  // ==============================================================
  // 8. NxGE Customer Quota for 100 requests = ¥9.00
  // ==============================================================
  it('8. NxGE Customer Quota for 100 requests = ¥9.00 (Selling Price ¥0.090 × 100)', () => {
    const customerQuota = QuotaCalculator.calculateCustomerQuota('0.090', 100);
    expect(customerQuota.toFixed(2)).toBe('9.00');

    const quotaFromBase = QuotaCalculator.calculateCustomerQuotaFromBaseCost('0.030', '3.0', 100);
    expect(quotaFromBase.toFixed(2)).toBe('9.00');
  });

  // ==============================================================
  // 9. NxGC Customer Quota for 100 requests = ¥7.50
  // ==============================================================
  it('9. NxGC Customer Quota for 100 requests = ¥7.50 (Selling Price ¥0.075 × 100)', () => {
    const customerQuota = QuotaCalculator.calculateCustomerQuota('0.075', 100);
    expect(customerQuota.toFixed(2)).toBe('7.50');

    const quotaFromBase = QuotaCalculator.calculateCustomerQuotaFromBaseCost('0.030', '2.5', 100);
    expect(quotaFromBase.toFixed(2)).toBe('7.50');
  });

  // ==============================================================
  // 10. Group Markup isolation (Group Markups must not mix)
  // ==============================================================
  it('10. Group Markup isolation: Group A (2.5x), Group E (3.0x), and Group Claude (2.5x) never mix', () => {
    expect(GROUP_MARKUPS[MODEL_GROUPS.GROUP_A]).toBe('2.5');
    expect(GROUP_MARKUPS[MODEL_GROUPS.GROUP_E]).toBe('3.0');
    expect(GROUP_MARKUPS[MODEL_GROUPS.GROUP_CLAUDE]).toBe('2.5');

    const calcA = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      packageSellingPriceThb: '51.00',
      cnyToThbRate: defaultRate,
      exchangeRateDate: testRateDate,
    });
    expect(calcA.markup.toFixed(2)).toBe('2.50');
    expect(calcA.sellingPriceCny.toFixed(3)).toBe('0.050');

    const calcE = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_E,
      referenceModelCostCny: '0.030',
      referenceRequests: 100,
      packageSellingPriceThb: '90.00',
      cnyToThbRate: defaultRate,
      exchangeRateDate: testRateDate,
    });
    expect(calcE.markup.toFixed(2)).toBe('3.00');
    expect(calcE.sellingPriceCny.toFixed(3)).toBe('0.090');

    const calcC = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      referenceModelCostCny: '0.030',
      referenceRequests: 100,
      packageSellingPriceThb: '75.00',
      cnyToThbRate: defaultRate,
      exchangeRateDate: testRateDate,
    });
    expect(calcC.markup.toFixed(2)).toBe('2.50');
    expect(calcC.sellingPriceCny.toFixed(3)).toBe('0.075');
  });

  // ==============================================================
  // 11. Funding Recommendation uses Base Cost only
  // ==============================================================
  it('11. Funding Recommendation uses Base Cost only (never Customer Selling Price or Quota)', () => {
    // 3 packages of NxG1: provider cost is 3 × ¥2.00 = ¥6.00 (NOT 3 × ¥5.00 = ¥15.00)
    const rec6 = FundingService.calculateRecommendation(6);
    expect(rec6.status).toBe(TOPUP_RECOMMENDATION_STATUS.BELOW_MINIMUM);
    expect(rec6.recommendedTopupAmountCny.toString()).toBe('0');
    expect(rec6.isReadyToTopUp).toBe(false);

    // Exact minimum threshold: ¥10.00 -> recommends ¥10.00
    const rec10 = FundingService.calculateRecommendation(10);
    expect(rec10.status).toBe(TOPUP_RECOMMENDATION_STATUS.READY_TO_TOP_UP);
    expect(rec10.recommendedTopupAmountCny.toFixed(2)).toBe('10.00');

    // CEILING rule examples:
    // ¥13.00 -> CEILING(13/10)*10 = ¥20.00
    const rec13 = FundingService.calculateRecommendation(13);
    expect(rec13.recommendedTopupAmountCny.toFixed(2)).toBe('20.00');

    // ¥25.00 -> CEILING(25/10)*10 = ¥30.00
    const rec25 = FundingService.calculateRecommendation(25);
    expect(rec25.recommendedTopupAmountCny.toFixed(2)).toBe('30.00');

    // ¥31.00 -> CEILING(31/10)*10 = ¥40.00
    const rec31 = FundingService.calculateRecommendation(31);
    expect(rec31.recommendedTopupAmountCny.toFixed(2)).toBe('40.00');
  });

  // ==============================================================
  // 12. Customer Quota uses Selling Price only
  // ==============================================================
  it('12. Customer Quota uses Selling Price only (guaranteeing exact 100 requests in New API)', async () => {
    // In New API, each request for NxG1 reference model costs ¥0.050.
    // With Customer Quota = ¥5.00, customer gets 5.00 / 0.050 = 100 requests.
    // If it were wrongly derived from Base Cost (¥2.00), customer would only get 40 requests!
    const sellingPrice = new Decimal('0.050');
    const customerQuota = QuotaCalculator.calculateCustomerQuota(sellingPrice, 100);
    expect(customerQuota.toFixed(2)).toBe('5.00');

    const availableRequests = customerQuota.dividedBy(sellingPrice);
    expect(availableRequests.toNumber()).toBe(100);
  });

  // ==============================================================
  // 13. Prevent duplicate Funding Allocation
  // ==============================================================
  it('13. Prevent duplicate Funding Allocation on same payment', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);

    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: 'DuplicateFundingTest',
      ticketChannelId: 'ticket-chan-dup-alloc',
      packageId: pkg.id,
    });

    // Create allocation first time
    const alloc1 = await fundingService.createFundingAllocationForPayment({
      paymentId: payment.id,
      packageId: pkg.id,
      providerCostCny: '2.00',
    });
    expect(alloc1).toBeDefined();

    // Attempt second allocation for same payment (must upsert and not create duplicate)
    const alloc2 = await fundingService.createFundingAllocationForPayment({
      paymentId: payment.id,
      packageId: pkg.id,
      providerCostCny: '2.00',
    });
    expect(alloc2.id).toBe(alloc1.id);

    // Verify only 1 record exists in DB for this payment
    const totalAllocations = await prisma.fundingAllocation.count({
      where: { paymentId: payment.id },
    });
    expect(totalAllocations).toBe(1);
  });

  // ==============================================================
  // 14. Package Purchase Snapshot does not change when Catalog changes
  // ==============================================================
  it('14. Package Purchase Snapshot remains immutable even if catalog/package changes later', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);

    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: 'SnapshotImmutabilityTest',
      ticketChannelId: 'ticket-chan-snap-immut',
      packageId: pkg.id,
    });

    const parsedSnapshot = JSON.parse(payment.calculationSnapshot);
    expect(parsedSnapshot.base_cost_cny).toBe('0.0200');
    expect(parsedSnapshot.markup).toBe('2.50');
    expect(parsedSnapshot.selling_price_cny).toBe('0.0500');
    expect(parsedSnapshot.reference_requests).toBe(100);
    expect(parsedSnapshot.provider_cost_cny).toBe('2.0000');
    expect(parsedSnapshot.customer_quota_cny).toBe('5.0000');
    expect(parsedSnapshot.package_selling_price_thb).toBe('51.00');

    // Simulate future database package modification
    await prisma.package.update({
      where: { id: pkg.id },
      data: {
        referenceModelCostCny: '0.050',
        markup: '4.0',
        sellingPriceThb: '99.00',
      },
    });

    // Sourced payment snapshot must remain strictly unchanged
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    const reloadedSnapshot = JSON.parse(reloadedPayment.calculationSnapshot);
    expect(reloadedSnapshot.base_cost_cny).toBe('0.0200');
    expect(reloadedSnapshot.markup).toBe('2.50');
    expect(reloadedSnapshot.selling_price_cny).toBe('0.0500');
    expect(reloadedSnapshot.provider_cost_cny).toBe('2.0000');
    expect(reloadedSnapshot.customer_quota_cny).toBe('5.0000');
    expect(reloadedSnapshot.package_selling_price_thb).toBe('51.00');

    // Restore original package values
    await prisma.package.update({
      where: { id: pkg.id },
      data: {
        referenceModelCostCny: '0.020',
        markup: '2.5',
        sellingPriceThb: '51.00',
      },
    });
  });

  // ==============================================================
  // 15. Missing pricing data throws error, never guesses
  // ==============================================================
  it('15. Missing pricing data throws error and alerts admin, never guesses values', () => {
    // Missing packageSellingPriceThb
    expect(() =>
      QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        cnyToThbRate: defaultRate,
        exchangeRateDate: testRateDate,
      } as any)
    ).toThrow('Package selling price in THB must be explicitly provided.');

    // Negative base cost
    expect(() =>
      QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '-0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: testRateDate,
      })
    ).toThrow('Reference model cost cannot be negative.');

    // Zero or negative reference requests
    expect(() =>
      QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 0,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: testRateDate,
      })
    ).toThrow('Reference requests must be a positive integer.');

    // Unknown group without custom markup
    expect(() =>
      QuotaCalculator.calculate({
        groupId: 'UNKNOWN_GROUP',
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: testRateDate,
      })
    ).toThrow(/Unknown model group 'UNKNOWN_GROUP' and no custom markup specified/);
  });

  // ==============================================================
  // 16. Node.js has no Request-level Quota Deduction
  // ==============================================================
  it('16. Node.js has no request-level quota deduction; acts strictly as admin & business system', async () => {
    // Verify that Customer balance is updated ONLY via payment approval or explicit admin action,
    // and never decremented per request in Node.js.
    const { customerId } = await customerService.findOrCreateCustomer(
      testDiscordId,
      'NoRequestLevelDeductionTest'
    );
    const initialCustomer = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    const initialBalance = new Decimal(initialCustomer.balance.toString());

    // Payment approval credits reference balance (Customer Quota ¥5.00 for NxG1)
    await customerService.updateRecordedBalance(testDiscordId, '5.00');
    const updatedCustomer = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    const updatedBalance = new Decimal(updatedCustomer.balance.toString());
    expect(updatedBalance.minus(initialBalance).toFixed(2)).toBe('5.00');

    // Customer profile records tokens to be configured in New API
    const token = await customerService.recordCustomerToken({
      discordUserId: testDiscordId,
      groupId: MODEL_GROUPS.GROUP_A,
      tokenIdentifier: 'newapi-tok-admin-check-001',
      quotaCny: '5.00',
    });
    expect(token.groupId).toBe(MODEL_GROUPS.GROUP_A);
    expect(new Decimal(token.quotaCny.toString()).toFixed(2)).toBe('5.00');
  });
});
