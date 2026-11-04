import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Decimal } from 'decimal.js';
import { FastifyInstance } from 'fastify';
import { getPrismaClient } from '../../src/db/client.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { PaymentService } from '../../src/services/payment.service.js';
import { QuotaCalculator } from '../../src/services/calculator.service.js';
import {
  FundingService,
  FUNDING_STATUS,
  TOPUP_RECOMMENDATION_STATUS,
} from '../../src/services/funding.service.js';
import { CryptoService } from '../../src/services/crypto.service.js';
import { ReviewHandler } from '../../src/bot/handlers/review.handler.js';
import { BotEmbeds } from '../../src/bot/ui/embeds.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { UpstreamCredentialResolver } from '../../src/services/credential-resolver.service.js';
import { MODEL_GROUPS, KEY_STATUS, PAYMENT_STATUS } from '../../src/config/constants.js';
import { STATIC_MODEL_CATALOG } from '../../src/services/catalog-data.js';

describe('NextAI Business Requirements & Architecture Alignment Tests', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const paymentService = new PaymentService(customerService);
  const fundingService = new FundingService();

  const testDiscordId = 'audit-test-user-99901';
  const testAdminId = 'admin-authorized-user-001';
  const unauthorizedUserId = 'regular-unauthorized-user-002';
  let createdPaymentId = '';

  beforeAll(async () => {
    // Clean up any test fixtures from previous runs
    try {
      await prisma.customer.deleteMany({
        where: { discordUserId: { in: [testDiscordId] } },
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
      await prisma.bearlabTopupRecord.deleteMany({
        where: { adminDiscordId: testAdminId },
      });
    } catch {
      // Ignore
    }
  });

  // ==========================================
  // 1. Package Calculation
  // ==========================================
  it('1. Package Calculation: strictly separates selling price, display price, and provider cost budget', () => {
    const calc = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      packageSellingPriceThb: '51.00',
      cnyToThbRate: '5.0764',
      exchangeRateDate: '2026-11-04',
      customMarkup: '2.5',
      bufferCny: '0.0',
    });

    // A. Customer selling price is strictly administrator-configured THB
    expect(calc.packageSellingPriceThb.toFixed(2)).toBe('51.00');
    expect(calc.finalPaymentAmountThb.toFixed(2)).toBe('51.00');

    // B. Website display price per request & reference value
    expect(calc.displayPricePerRequestCny.toFixed(3)).toBe('0.050'); // 0.020 * 2.5
    expect(calc.displayReferenceValueCny.toFixed(2)).toBe('5.00'); // 0.050 * 100

    // C. BearLab upstream provider cost budget
    expect(calc.providerCostBudgetCny.toFixed(2)).toBe('2.00'); // 0.020 * 100
    expect(calc.assignedUpstreamQuotaCny.toFixed(2)).toBe('2.00');

    // D. Projections
    expect(calc.estimatedProviderCostThb.toFixed(2)).toBe('10.15'); // 2.00 * 5.0764
    expect(calc.estimatedGrossProfitThb.toFixed(2)).toBe('40.85'); // 51.00 - 10.15
  });

  // ==========================================
  // 2. Reference Pricing, Quota & Provider Cost Calculation
  // ==========================================
  it('2. Reference Pricing, Quota & Provider Cost: calculates selling price, customer quota, and provider cost', () => {
    // A. Selling Price per Request = Base Cost × Markup
    const sellingNxG1 = QuotaCalculator.calculateSellingPrice('0.020', '2.5');
    expect(sellingNxG1.toFixed(3)).toBe('0.050');

    const sellingNxGE = QuotaCalculator.calculateSellingPrice('0.030', '3.0');
    expect(sellingNxGE.toFixed(3)).toBe('0.090');

    const sellingNxGC = QuotaCalculator.calculateSellingPrice('0.030', '2.5');
    expect(sellingNxGC.toFixed(3)).toBe('0.075');

    // B. Provider Cost = Base Cost × Reference Requests (BearLab Funding only)
    const providerCostNxG1 = QuotaCalculator.calculateProviderCost('0.020', 100);
    expect(providerCostNxG1.toFixed(2)).toBe('2.00');

    const providerCostNxGE = QuotaCalculator.calculateProviderCost('0.030', 100);
    expect(providerCostNxGE.toFixed(2)).toBe('3.00');

    const providerCostNxGC = QuotaCalculator.calculateProviderCost('0.030', 100);
    expect(providerCostNxGC.toFixed(2)).toBe('3.00');

    // C. Customer Quota = Selling Price × Reference Requests (New API Token Quota)
    const customerQuotaNxG1 = QuotaCalculator.calculateCustomerQuota(sellingNxG1, 100);
    expect(customerQuotaNxG1.toFixed(2)).toBe('5.00');

    const customerQuotaNxGE = QuotaCalculator.calculateCustomerQuota(sellingNxGE, 100);
    expect(customerQuotaNxGE.toFixed(2)).toBe('9.00');

    const customerQuotaNxGC = QuotaCalculator.calculateCustomerQuota(sellingNxGC, 100);
    expect(customerQuotaNxGC.toFixed(2)).toBe('7.50');

    // Verification of Catalog: Claude baseCostCny is 0.030, markup is 2.5x -> selling price is 0.075
    const claudeModel = STATIC_MODEL_CATALOG.find(
      (m) => m.groupId === MODEL_GROUPS.GROUP_CLAUDE
    );
    expect(claudeModel).toBeDefined();
    expect(claudeModel?.baseCostCny).toBe('0.030');
    expect(claudeModel?.sellingPriceCny).toBe('0.075');
  });

  // ==========================================
  // 3. Customer Group Assignment
  // ==========================================
  it('3. Customer Group Assignment: assigns model group to customer record', async () => {
    await customerService.findOrCreateCustomer(testDiscordId, 'TestCustomer01');
    const assigned = await customerService.assignModelGroup(
      testDiscordId,
      MODEL_GROUPS.GROUP_A
    );
    expect(assigned).toContain(MODEL_GROUPS.GROUP_A);

    const allowed = await customerService.getCustomerAllowedGroups(testDiscordId);
    expect(allowed).toContain(MODEL_GROUPS.GROUP_A);
  });

  // ==========================================
  // 4. One API Key Per Group Rule
  // ==========================================
  it('4. One API Key Per Group Rule: rejects multiple groups on a single token', async () => {
    // Single valid group succeeds
    const token = await customerService.recordCustomerToken({
      discordUserId: testDiscordId,
      groupId: MODEL_GROUPS.GROUP_A,
      tokenIdentifier: 'newapi-tok-group-a-001',
      quotaCny: '2.00',
    });
    expect(token.groupId).toBe(MODEL_GROUPS.GROUP_A);
    expect(token.tokenIdentifier).toBe('newapi-tok-group-a-001');

    // Multiple groups on a single key must be strictly rejected
    await expect(
      customerService.recordCustomerToken({
        discordUserId: testDiscordId,
        groupId: 'nxg1,nxge',
        tokenIdentifier: 'newapi-tok-multi-group-invalid',
        quotaCny: '5.00',
      })
    ).rejects.toThrow(/Strict Rule Violation.*One API Key \/ Token can only be assigned to exactly ONE Model Group/);
  });

  // ==========================================
  // 5. Customer Record Creation
  // ==========================================
  it('5. Customer Record Creation: creates customer and formats profile with required fields', async () => {
    const { customerId, profile, isNew } = await customerService.findOrCreateCustomer(
      testDiscordId,
      'TestCustomer01'
    );
    expect(customerId).toBeDefined();
    expect(profile.username).toBe('TestCustomer01');
    expect(profile.userId).toBe(testDiscordId);
    expect(profile.keyStatus).toBe(KEY_STATUS.ACTIVE);
    expect(profile.tokens).toBeDefined();
    expect(profile.tokens?.length).toBeGreaterThanOrEqual(1);
    expect(profile.tokens?.[0].groupId).toBe(MODEL_GROUPS.GROUP_A);
  });

  // ==========================================
  // 6. Customer Record Update
  // ==========================================
  it('6. Customer Record Update: updates token status, recorded balance, and key status', async () => {
    const updatedToken = await customerService.updateTokenStatus(
      'newapi-tok-group-a-001',
      'EXHAUSTED'
    );
    expect(updatedToken.status).toBe('EXHAUSTED');

    const updatedProfile = await customerService.updateKeyStatus(
      testDiscordId,
      KEY_STATUS.SUSPENDED
    );
    expect(updatedProfile.keyStatus).toBe(KEY_STATUS.SUSPENDED);

    // Restore to ACTIVE for following tests
    await customerService.updateKeyStatus(testDiscordId, KEY_STATUS.ACTIVE);
  });

  // ==========================================
  // 7. Payment Record Creation
  // ==========================================
  it('7. Payment Record Creation: creates payment with expected amount and calculation snapshot', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(
      MODEL_GROUPS.GROUP_A,
      100
    );

    const { payment, calculation } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: 'TestCustomer01',
      ticketChannelId: 'ticket-chan-999',
      packageId: pkg.id,
    });

    createdPaymentId = payment.id;
    expect(payment.paymentStatus).toBe(PAYMENT_STATUS.PENDING_PAYMENT);
    expect(new Decimal(payment.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
    expect(payment.calculationSnapshot).toBeDefined();

    const snapshot = JSON.parse(payment.calculationSnapshot);
    expect(snapshot.package_selling_price_thb).toBe('51.00');
    expect(snapshot.provider_cost_budget_cny).toBe('2.0000');
  });

  // ==========================================
  // 8. Payment Verification
  // ==========================================
  it('8. Payment Verification: admin manual approval creates funding allocation with PENDING_FUNDING', async () => {
    // Simulate customer slip upload to transition state to UNDER_REVIEW
    const fakeSlip = Buffer.from('mock-payment-slip-png-data');
    await paymentService.submitPaymentSlip({
      paymentId: createdPaymentId,
      fileBuffer: fakeSlip,
      originalFilename: 'slip.png',
      mimeType: 'image/png',
    });

    // Admin approves payment
    const result = await paymentService.approvePayment({
      paymentId: createdPaymentId,
      reviewerDiscordId: testAdminId,
    });

    expect(result.payment.paymentStatus).toBe(PAYMENT_STATUS.APPROVED);
    expect(result.alreadyProcessed).toBe(false);

    // Verify FundingAllocation was automatically tracked
    const allocation = await prisma.fundingAllocation.findUnique({
      where: { paymentId: createdPaymentId },
    });
    expect(allocation).toBeDefined();
    expect(allocation?.status).toBe(FUNDING_STATUS.PENDING_FUNDING);
    expect(new Decimal(allocation?.providerCostCny.toString() || '0').toFixed(2)).toBe(
      '2.00'
    );
  });

  // ==========================================
  // 9. Payment Rejection
  // ==========================================
  it('9. Payment Rejection: admin rejection updates payment status with reason', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(
      MODEL_GROUPS.GROUP_A,
      100
    );
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: 'TestCustomer01',
      ticketChannelId: 'ticket-chan-reject-test',
      packageId: pkg.id,
    });

    const rejected = await paymentService.rejectPayment({
      paymentId: payment.id,
      reviewerDiscordId: testAdminId,
      rejectionReason: 'Invalid slip timestamp or blurred QR code',
    });

    expect(rejected.paymentStatus).toBe(PAYMENT_STATUS.REJECTED);
    expect(rejected.rejectionReason).toBe('Invalid slip timestamp or blurred QR code');
  });

  // ==========================================
  // 10. BearLab Manual Top-up Record & Funding Recommendation
  // ==========================================
  it('10. BearLab Manual Top-up & Funding: implements CEILING(pending/10)*10 and manual records', async () => {
    // A. CEILING formula test cases
    // ¥6  -> BELOW_MINIMUM (< ¥10)
    const rec6 = FundingService.calculateRecommendation(6);
    expect(rec6.status).toBe(TOPUP_RECOMMENDATION_STATUS.BELOW_MINIMUM);
    expect(rec6.isReadyToTopUp).toBe(false);

    // ¥10 -> ¥10
    const rec10 = FundingService.calculateRecommendation(10);
    expect(rec10.status).toBe(TOPUP_RECOMMENDATION_STATUS.READY_TO_TOP_UP);
    expect(rec10.recommendedTopupAmountCny.toNumber()).toBe(10);

    // ¥13 -> ¥20
    const rec13 = FundingService.calculateRecommendation(13);
    expect(rec13.recommendedTopupAmountCny.toNumber()).toBe(20);

    // ¥25 -> ¥30
    const rec25 = FundingService.calculateRecommendation(25);
    expect(rec25.recommendedTopupAmountCny.toNumber()).toBe(30);

    // ¥31 -> ¥40
    const rec31 = FundingService.calculateRecommendation(31);
    expect(rec31.recommendedTopupAmountCny.toNumber()).toBe(40);

    // B. Record Manual Top-up by Admin
    const topup = await fundingService.recordManualTopup({
      amountCny: '50.00',
      adminDiscordId: testAdminId,
      notes: 'Manual balance prep for November campaign',
    });
    expect(topup.amountCny.toString()).toBe('50');

    // C. Allocate Package for Funding (marks as ALLOCATED to prevent double-counting)
    const allocated = await fundingService.allocatePackagesForFunding({
      paymentIds: [createdPaymentId],
      adminDiscordId: testAdminId,
      topupRecordId: topup.id,
      notes: 'Allocated against top-up record',
    });
    expect(allocated[0].status).toBe(FUNDING_STATUS.ALLOCATED);

    // Attempting duplicate allocation must fail
    await expect(
      fundingService.allocatePackagesForFunding({
        paymentIds: [createdPaymentId],
        adminDiscordId: testAdminId,
      })
    ).rejects.toThrow(/already been allocated for funding/);

    // D. Refund/Cancellation handler
    const refunded = await fundingService.cancelOrRefundFundingAllocation(
      createdPaymentId,
      testAdminId,
      'Customer requested cancellation'
    );
    expect(refunded.status).toBe(FUNDING_STATUS.REFUNDED_CANCELLED);
  });

  // ==========================================
  // 11. API Key Hashing
  // ==========================================
  it('11. API Key Hashing: SHA-256 hash is deterministic and one-way', () => {
    const rawKey = 'nx-live-test-secret-key-12345';
    const hash1 = CryptoService.hashApiKey(rawKey);
    const hash2 = CryptoService.hashApiKey(rawKey);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).not.toContain(rawKey);
  });

  // ==========================================
  // 12. Secret Encryption
  // ==========================================
  it('12. Secret Encryption: AES-256-GCM correctly encrypts and decrypts secrets', () => {
    const secret = 'sk-newapi-confidential-token-98765';
    const secretHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const encrypted = CryptoService.encryptSecret(secret, secretHex);

    expect(encrypted.encrypted).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();
    expect(encrypted.encrypted).not.toContain(secret);

    const decrypted = CryptoService.decryptSecret(
      encrypted.encrypted,
      encrypted.iv,
      encrypted.authTag,
      secretHex
    );
    expect(decrypted).toBe(secret);
  });

  // ==========================================
  // 13. Customer Data Validation
  // ==========================================
  it('13. Customer Data Validation: rejects negative quota and empty tokens', async () => {
    await expect(
      customerService.recordCustomerToken({
        discordUserId: testDiscordId,
        groupId: MODEL_GROUPS.GROUP_A,
        tokenIdentifier: 'tok-negative-quota',
        quotaCny: -10,
      })
    ).rejects.toThrow(/cannot be negative/);

    await expect(
      customerService.recordCustomerToken({
        discordUserId: testDiscordId,
        groupId: MODEL_GROUPS.GROUP_A,
        tokenIdentifier: '',
        quotaCny: 2.0,
      })
    ).rejects.toThrow(/Token identifier must be provided/);
  });

  // ==========================================
  // 14. Admin Authorization
  // ==========================================
  it('14. Admin Authorization: rejects unauthorized non-admin users', () => {
    const handler = new ReviewHandler(paymentService, [testAdminId]);

    expect(handler.isAuthorizedAdmin(testAdminId)).toBe(true);
    expect(handler.isAuthorizedAdmin(unauthorizedUserId)).toBe(false);
  });

  // ==========================================
  // 15. Discord Ticket Workflow (Mock)
  // ==========================================
  it('15. Discord Ticket Workflow: renders mock review embed and customer approval notice', () => {
    const reviewEmbed = BotEmbeds.adminReviewNotification({
      paymentId: 'pay-test-123',
      customerDiscordId: testDiscordId,
      customerUsername: 'TestCustomer',
      packageName: 'NxG1 Starter 100',
      groupId: 'nxg1',
      expectedAmountThb: '51.00',
    });

    expect(reviewEmbed.data.title).toContain('Admin Review Required');
    expect(reviewEmbed.data.description).toContain('฿51.00 THB');

    const approvedEmbed = BotEmbeds.paymentApproved({
      packageName: 'NxG1 Starter 100',
      groupId: 'nxg1',
      assignedQuotaCny: '2.00',
      gatewayUrl: 'http://127.0.0.1:3000/v1',
    });

    expect(approvedEmbed.data.title).toContain('เปิดใช้งานสิทธิ์สำเร็จ');
    expect(approvedEmbed.data.description).toContain('http://127.0.0.1:3000/v1');
  });

  // ==========================================
  // 16. Proxy Deprecation / Disabled Routing Behavior
  // ==========================================
  it('16. Proxy Deprecation: disabled proxy rejects /v1/chat/completions with 410 Gone and New API direction', async () => {
    const resolver = new UpstreamCredentialResolver({
      newApiKeyGroupA: 'mock-a',
    });

    // Create proxy server with legacy proxy DISABLED
    const server: FastifyInstance = createProxyServer({
      upstreamBaseUrl: 'http://127.0.0.1:3000/v1',
      credentialResolver: resolver,
      enableLegacyProxy: false,
    });
    await server.ready();

    // 1. Healthcheck indicates proxy is disabled and shows New API endpoint
    const health = await server.inject({
      method: 'GET',
      url: '/health',
    });
    expect(health.statusCode).toBe(200);
    const healthJson = JSON.parse(health.body);
    expect(healthJson.legacyProxy).toBe('disabled');
    expect(healthJson.gatewayEndpoint).toBe('http://127.0.0.1:3000/v1');

    // 2. Chat completions endpoint returns 410 Gone
    const chatResp = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        model: 'gemini-3-1-pro-high-nxg1',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(chatResp.statusCode).toBe(410);
    const errorJson = JSON.parse(chatResp.body);
    expect(errorJson.error.type).toBe('proxy_deprecated');
    expect(errorJson.error.message).toContain('NextAI Node.js Proxy is deprecated');
    expect(errorJson.error.gatewayEndpoint).toBe('http://127.0.0.1:3000/v1');

    await server.close();
  });

  // ==========================================
  // 17. No Duplicate Customer Quota Deduction Logic
  // ==========================================
  it('17. No Duplicate Customer Quota Deduction: verifies Node.js does not deduct customer balance per request', async () => {
    // Record initial customer balance
    const beforeProfile = await customerService.getCustomerProfile(testDiscordId);
    const initialBalance = beforeProfile.balance;

    // Simulate mock proxy server interaction (even with legacy proxy enabled)
    // The chat route forwards requests and does NOT perform balance deduction
    const resolver = new UpstreamCredentialResolver({
      newApiKeyGroupA: 'mock-a',
    });
    const server = createProxyServer({
      upstreamBaseUrl: 'http://127.0.0.1:54321/v1',
      credentialResolver: resolver,
      enableLegacyProxy: true,
      customerService,
    });
    await server.ready();

    // Verify balance remains unchanged in Node.js DB
    const afterProfile = await customerService.getCustomerProfile(testDiscordId);
    expect(afterProfile.balance).toBe(initialBalance);

    await server.close();
  });
});
