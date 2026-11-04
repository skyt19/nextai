import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  TokenProvisioningService,
  TokenProvisioningError,
  DuplicateProvisioningError,
  PlaintextKeyUnavailableError,
} from '../../src/services/token-provisioning.service.js';
import {
  NewApiManagementService,
  NewApiError,
  NewApiAuthError,
  NewApiTimeoutError,
  NewApiUnavailableError,
} from '../../src/services/newapi-management.service.js';
import { CryptoService } from '../../src/services/crypto.service.js';
import { PaymentService } from '../../src/services/payment.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import {
  MODEL_GROUPS,
  NEWAPI_GROUP_MAP,
  PROVISIONING_STATUS,
  PAYMENT_STATUS,
  KEY_STATUS,
} from '../../src/config/constants.js';
import { env } from '../../src/config/env.js';

describe('New API Customer Token Provisioning Suite', () => {
  const prisma = getPrismaClient();
  const testDiscordId = '888877776666555544';
  const testUsername = 'provisioning_tester';
  let testCustomerId: string;
  let testPackageA: any;
  let testPaymentA: any;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Clean up test customer, tokens, payments, slips
    const existing = await prisma.customer.findUnique({
      where: { discordUserId: testDiscordId },
      include: {
        tokens: true,
        payments: { include: { slips: true, fundingAllocation: true } },
      },
    });

    if (existing) {
      await prisma.customerTokenRecord.deleteMany({ where: { customerId: existing.id } });
      for (const p of existing.payments) {
        if (p.fundingAllocation) {
          await prisma.fundingAllocation.delete({ where: { paymentId: p.id } });
        }
        await prisma.paymentSlip.deleteMany({ where: { paymentId: p.id } });
      }
      await prisma.payment.deleteMany({ where: { customerId: existing.id } });
      await prisma.customer.delete({ where: { id: existing.id } });
    }

    // Create test customer
    const customer = await prisma.customer.create({
      data: {
        discordUserId: testDiscordId,
        username: testUsername,
        balance: '0',
        balanceCurrency: 'CNY',
        keyStatus: KEY_STATUS.ACTIVE,
      },
    });
    testCustomerId = customer.id;

    // Create test package for Group A
    testPackageA = await prisma.package.upsert({
      where: { id: 'pkg-test-group-a' },
      create: {
        id: 'pkg-test-group-a',
        name: 'Group A [NxG1] — 100 Requests',
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelId: 'gemini-3-1-pro-high-nxg1',
        referenceRequests: 100,
        referenceModelCostCny: '0.020',
        markup: '2.5',
        sellingPriceThb: '51.00',
        bufferCny: '0',
        enabled: true,
      },
      update: {},
    });

    // Create test payment in UNDER_REVIEW status
    const snapshot = JSON.stringify({
      base_model_cny: '0.020',
      markup: '2.5',
      reference_requests: 100,
      customer_quota_cny: '5.00',
      provider_cost_cny: '2.00',
    });

    testPaymentA = await prisma.payment.create({
      data: {
        customerId: testCustomerId,
        packageId: testPackageA.id,
        ticketChannelId: 'ticket-channel-test-101',
        expectedAmountThb: '51.00',
        paymentStatus: PAYMENT_STATUS.UNDER_REVIEW,
        calculationSnapshot: snapshot,
      },
      include: { customer: true, package: true },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // ==========================================
  // SCENARIO 1: Group Mapping
  // ==========================================
  it('1. Maps NextAI groups strictly to New API groups', () => {
    const service = new TokenProvisioningService();
    expect(service.mapNextAiGroupToNewApi(MODEL_GROUPS.GROUP_A)).toBe('nextgroupA');
    expect(service.mapNextAiGroupToNewApi(MODEL_GROUPS.GROUP_E)).toBe('nextgroupE');
    expect(service.mapNextAiGroupToNewApi(MODEL_GROUPS.GROUP_CLAUDE)).toBe('claudegroup');
    expect(() => service.mapNextAiGroupToNewApi('UNKNOWN_GROUP')).toThrow(TokenProvisioningError);
  });

  // ==========================================
  // SCENARIO 2: CNY to Quota-Unit Conversion
  // ==========================================
  it('2. Converts CNY to New API quota units with USDExchangeRate=6.7 and 500,000 units/USD', () => {
    const service = new TokenProvisioningService();
    // Formula: Math.round((customerQuotaCny / 6.7) * 500,000)
    expect(service.calculateQuotaUnits('5.00')).toBe(373_134); // NxG1 ¥5.00
    expect(service.calculateQuotaUnits('9.00')).toBe(671_642); // NxGE ¥9.00
    expect(service.calculateQuotaUnits('7.50')).toBe(559_701); // NxGC ¥7.50
  });

  // ==========================================
  // SCENARIO 3: Safe Integer Validation
  // ==========================================
  it('3. Enforces safe positive integer validation on quota calculation', () => {
    const service = new TokenProvisioningService();
    expect(() => service.calculateQuotaUnits('-5.00')).toThrow(TokenProvisioningError);
    expect(() => service.calculateQuotaUnits('0')).toThrow(TokenProvisioningError);
    expect(() => service.calculateQuotaUnits('5.00', -1)).toThrow(TokenProvisioningError);
  });

  // ==========================================
  // SCENARIO 4: Create API String Response
  // ==========================================
  it('4. Successfully parses string response format from New API Create endpoint', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          message: '',
          data: 'sk-newapi-plain-string-secret-12345678',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await mockNewApi.createToken({
      name: 'NxG1 - 123 - user',
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    expect(result.key).toBe('sk-newapi-plain-string-secret-12345678');
    expect(result.name).toBe('NxG1 - 123 - user');
    expect(result.group).toBe('nextgroupA');
  });

  // ==========================================
  // SCENARIO 5: Create API Object Response
  // ==========================================
  it('5. Successfully parses object response format from New API Create endpoint', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          message: '',
          data: {
            id: 99,
            name: 'NxG1 - 123 - user',
            key: 'sk-newapi-object-secret-99999999',
            remain_quota: 2_500_000,
            group: 'nextgroupA',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await mockNewApi.createToken({
      name: 'NxG1 - 123 - user',
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    expect(result.id).toBe(99);
    expect(result.key).toBe('sk-newapi-object-secret-99999999');
    expect(result.name).toBe('NxG1 - 123 - user');
  });

  // ==========================================
  // SCENARIO 6: Search & Duplicate Detection
  // ==========================================
  it('6. Detects existing token in New API before creation and prevents duplicates', async () => {
    const mockNewApi = new NewApiManagementService();
    const expectedName = `NxG1 - ${testDiscordId} - ${testUsername}`;

    // 1. Search returns an existing token in New API
    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([
      {
        id: 101,
        name: expectedName,
        key: 'sk-existing-masked-****',
        status: 1,
        expired_time: -1,
        remain_quota: 2_500_000,
        unlimited_quota: false,
        group: 'nextgroupA',
      },
    ]);
    const createSpy = vi.spyOn(mockNewApi, 'createToken');

    const service = new TokenProvisioningService(mockNewApi);
    const result = await service.provisionTokenForPayment(testPaymentA.id);

    // Create must NOT be called
    expect(createSpy).not.toHaveBeenCalled();
    expect(result.isNewToken).toBe(false);
    expect(result.requiresAdminReconciliation).toBe(true);

    const recordInDb = await prisma.customerTokenRecord.findUnique({
      where: { customerId_groupId: { customerId: testCustomerId, groupId: MODEL_GROUPS.GROUP_A } },
    });
    expect(recordInDb?.provisioningStatus).toBe(PROVISIONING_STATUS.UNKNOWN);
  });

  // ==========================================
  // SCENARIO 7: Concurrent Provisioning
  // ==========================================
  it('7. Prevents concurrent provisioning for the same customer and group using in-flight lock', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(mockNewApi, 'searchTokens').mockImplementation(async () => {
      // Simulate delay in network
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [];
    });
    vi.spyOn(mockNewApi, 'createToken').mockResolvedValue({
      id: 201,
      key: 'sk-newapi-concurrent-key',
      name: `NxG1 - ${testDiscordId} - ${testUsername}`,
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    const service = new TokenProvisioningService(mockNewApi);

    // Launch two concurrent provisioning calls
    const promise1 = service.provisionTokenForPayment(testPaymentA.id);
    const promise2 = service.provisionTokenForPayment(testPaymentA.id);

    const results = await Promise.allSettled([promise1, promise2]);
    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateProvisioningError);
  });

  // ==========================================
  // SCENARIO 8: Timeout and UNKNOWN Reconciliation
  // ==========================================
  it('8. Transitions to UNKNOWN state on New API timeout and supports reconciliation', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([]);
    vi.spyOn(mockNewApi, 'createToken').mockRejectedValue(
      new NewApiTimeoutError('Create request timed out after 10000ms')
    );

    const service = new TokenProvisioningService(mockNewApi);

    await expect(service.provisionTokenForPayment(testPaymentA.id)).rejects.toThrow(NewApiTimeoutError);

    const recordInDb = await prisma.customerTokenRecord.findUnique({
      where: { customerId_groupId: { customerId: testCustomerId, groupId: MODEL_GROUPS.GROUP_A } },
    });
    expect(recordInDb?.provisioningStatus).toBe(PROVISIONING_STATUS.UNKNOWN);
    expect(recordInDb?.lastError).toContain('timed out');
  });

  // ==========================================
  // SCENARIO 9: Existing Token with Unavailable Plaintext Key
  // ==========================================
  it('9. Handles existing token with unavailable plaintext key by requiring admin reconciliation', async () => {
    const mockNewApi = new NewApiManagementService();
    const expectedName = `NxG1 - ${testDiscordId} - ${testUsername}`;

    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([
      {
        id: 301,
        name: expectedName,
        key: 'sk-masked-****',
        status: 1,
        expired_time: -1,
        remain_quota: 2_500_000,
        unlimited_quota: false,
      },
    ]);

    const service = new TokenProvisioningService(mockNewApi);
    const result = await service.provisionTokenForPayment(testPaymentA.id);

    expect(result.requiresAdminReconciliation).toBe(true);
    expect(result.tokenRecord.provisioningStatus).toBe(PROVISIONING_STATUS.UNKNOWN);
    expect(result.tokenRecord.lastError).toContain('plaintext key is unavailable');
  });

  // ==========================================
  // SCENARIO 10: Database Persistence Failure
  // ==========================================
  it('10. Handles search failure gracefully and records FAILED status', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(mockNewApi, 'searchTokens').mockRejectedValue(
      new NewApiUnavailableError('Database connectivity down')
    );

    const service = new TokenProvisioningService(mockNewApi);
    await expect(service.provisionTokenForPayment(testPaymentA.id)).rejects.toThrow(NewApiUnavailableError);

    const record = await prisma.customerTokenRecord.findUnique({
      where: { customerId_groupId: { customerId: testCustomerId, groupId: MODEL_GROUPS.GROUP_A } },
    });
    expect(record?.provisioningStatus).toBe(PROVISIONING_STATUS.FAILED);
  });

  // ==========================================
  // SCENARIO 11: Encrypted Secret Storage & Retrieval
  // ==========================================
  it('11. Stores secret key encrypted with AES-256-GCM and never in plaintext', async () => {
    const mockNewApi = new NewApiManagementService();
    const testSecretKey = 'sk-super-secret-customer-key-998877';

    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([]);
    vi.spyOn(mockNewApi, 'createToken').mockResolvedValue({
      id: 401,
      key: testSecretKey,
      name: `NxG1 - ${testDiscordId} - ${testUsername}`,
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    const service = new TokenProvisioningService(mockNewApi);
    const result = await service.provisionTokenForPayment(testPaymentA.id);

    expect(result.isNewToken).toBe(true);

    const record = await prisma.customerTokenRecord.findUnique({
      where: { customerId_groupId: { customerId: testCustomerId, groupId: MODEL_GROUPS.GROUP_A } },
    });

    // Encrypted fields exist
    expect(record?.encryptedKey).toBeDefined();
    expect(record?.iv).toBeDefined();
    expect(record?.authTag).toBeDefined();
    // Plaintext key is NOT in record
    expect(record?.tokenIdentifier).not.toBe(testSecretKey);
    expect(record?.keyHash).toBe(CryptoService.hashApiKey(testSecretKey));

    // Can be decrypted using CryptoService
    const decrypted = CryptoService.decryptSecret(
      record!.encryptedKey!,
      record!.iv!,
      record!.authTag!,
      env.ENCRYPTION_SECRET
    );
    expect(decrypted).toBe(testSecretKey);
  });

  // ==========================================
  // SCENARIO 12: Discord Delivery Success & Failure
  // ==========================================
  it('12. Confirms Discord delivery clears encrypted key, whereas failure retains secret for retry', async () => {
    const mockNewApi = new NewApiManagementService();
    const testKey = 'sk-delivery-test-key-12345';
    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([]);
    vi.spyOn(mockNewApi, 'createToken').mockResolvedValue({
      id: 501,
      key: testKey,
      name: `NxG1 - ${testDiscordId} - ${testUsername}`,
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    const service = new TokenProvisioningService(mockNewApi);
    const { tokenRecord } = await service.provisionTokenForPayment(testPaymentA.id);

    // 1. Delivery Failure: ticketChannel.send throws error
    const failingChannel = {
      send: vi.fn().mockRejectedValue(new Error('DiscordAPIError[50001]: Missing Access')),
    };

    await expect(service.deliverTokenToDiscord(tokenRecord.id, failingChannel)).rejects.toThrow(
      'Missing Access'
    );

    let updatedRecord = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecord.id },
    });
    expect(updatedRecord?.provisioningStatus).toBe(PROVISIONING_STATUS.DELIVERY_FAILED);
    expect(updatedRecord?.encryptedKey).not.toBeNull(); // Retained!

    // 2. Delivery Success: ticketChannel.send resolves
    const successfulChannel = {
      send: vi.fn().mockResolvedValue({ id: 'discord-msg-999' }),
    };

    const deliveryResult = await service.deliverTokenToDiscord(tokenRecord.id, successfulChannel);
    expect(deliveryResult.delivered).toBe(true);

    updatedRecord = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecord.id },
    });
    expect(updatedRecord?.provisioningStatus).toBe(PROVISIONING_STATUS.DELIVERED);
    expect(updatedRecord?.encryptedKey).toBeNull(); // Wiped!
    expect(updatedRecord?.iv).toBeNull();
    expect(updatedRecord?.authTag).toBeNull();
    expect(updatedRecord?.deliveredAt).toBeDefined();
  });

  // ==========================================
  // SCENARIO 13: Delivery Retry Without Duplicate Token
  // ==========================================
  it('13. Admin delivery retry delivers retained encrypted key without creating duplicate token', async () => {
    const mockNewApi = new NewApiManagementService();
    const testKey = 'sk-retry-delivery-key-4444';
    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([]);
    vi.spyOn(mockNewApi, 'createToken').mockResolvedValue({
      id: 601,
      key: testKey,
      name: `NxG1 - ${testDiscordId} - ${testUsername}`,
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    const service = new TokenProvisioningService(mockNewApi);
    const { tokenRecord } = await service.provisionTokenForPayment(testPaymentA.id);

    // Fail first delivery
    const failingChannel = { send: vi.fn().mockRejectedValue(new Error('Rate limit')) };
    await expect(service.deliverTokenToDiscord(tokenRecord.id, failingChannel)).rejects.toThrow();

    // Now admin retries delivery
    const createSpy = vi.spyOn(mockNewApi, 'createToken');
    const successfulChannel = { send: vi.fn().mockResolvedValue({ id: 'msg-retry-ok' }) };

    const retryResult = await service.retryDelivery(tokenRecord.id, 'admin-discord-123', successfulChannel);
    expect(retryResult.delivered).toBe(true);
    expect(createSpy).not.toHaveBeenCalled(); // No duplicate token created!

    // Audit log was recorded
    const audit = await prisma.auditLog.findFirst({
      where: {
        targetId: tokenRecord.id,
        action: 'ADMIN_RETRY_TOKEN_DELIVERY',
      },
    });
    expect(audit).toBeDefined();
    expect(audit?.actorDiscordId).toBe('admin-discord-123');
  });

  // ==========================================
  // SCENARIO 14: Payment Approval Retry Without Duplicate Quota
  // ==========================================
  it('14. Retrying payment approval is idempotent and does not credit customer balance twice', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([]);
    vi.spyOn(mockNewApi, 'createToken').mockResolvedValue({
      id: 701,
      key: 'sk-idempotent-payment-key-1111',
      name: `NxG1 - ${testDiscordId} - ${testUsername}`,
      remain_quota: 2_500_000,
      group: 'nextgroupA',
    });

    const tokenProvisioningService = new TokenProvisioningService(mockNewApi);
    const paymentService = new PaymentService(
      new CustomerService(),
      undefined,
      tokenProvisioningService
    );

    // First approval
    const result1 = await paymentService.approvePayment({
      paymentId: testPaymentA.id,
      reviewerDiscordId: 'admin-reviewer-1',
    });
    expect(result1.alreadyProcessed).toBe(false);
    expect(result1.customerProfile.balance).toBe('¥5.00 CNY');

    // Second approval of the same payment
    const result2 = await paymentService.approvePayment({
      paymentId: testPaymentA.id,
      reviewerDiscordId: 'admin-reviewer-1',
    });
    expect(result2.alreadyProcessed).toBe(true);
    // Balance must remain ¥5.00 CNY, NOT ¥10.00 CNY!
    expect(result2.customerProfile.balance).toBe('¥5.00 CNY');
  });

  // ==========================================
  // SCENARIO 15: Disable Token
  // ==========================================
  it('15. Disables token in both New API and database and logs admin audit event', async () => {
    const mockNewApi = new NewApiManagementService();
    const disableSpy = vi.spyOn(mockNewApi, 'disableToken').mockResolvedValue(undefined);

    const tokenRecord = await prisma.customerTokenRecord.create({
      data: {
        customerId: testCustomerId,
        groupId: MODEL_GROUPS.GROUP_A,
        tokenIdentifier: 'sk-disable-test-key-****',
        tokenName: `NxG1 - ${testDiscordId} - ${testUsername}`,
        newApiTokenId: 801,
        quotaCny: '5.00',
        status: KEY_STATUS.ACTIVE,
        provisioningStatus: PROVISIONING_STATUS.DELIVERED,
      },
    });

    const service = new TokenProvisioningService(mockNewApi);
    await service.disableToken(tokenRecord.id, 'admin-discord-user-1');

    expect(disableSpy).toHaveBeenCalledWith(801);

    const updated = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecord.id },
    });
    expect(updated?.status).toBe(KEY_STATUS.DISABLED);

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: tokenRecord.id, action: 'ADMIN_DISABLE_CUSTOMER_TOKEN' },
    });
    expect(audit).toBeDefined();
  });

  // ==========================================
  // SCENARIO 16: PAT Missing or Invalid
  // ==========================================
  it('16. Throws NewApiAuthError when PAT is missing or rejected with 401', async () => {
    const serviceWithoutPat = new NewApiManagementService({ adminAccessToken: '' });
    await expect(serviceWithoutPat.createToken({ name: 'test', remain_quota: 1000 })).rejects.toThrow(
      NewApiAuthError
    );

    const serviceWithInvalidPat = new NewApiManagementService({ adminAccessToken: 'invalid-pat' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, message: 'Invalid PAT' }), { status: 401 })
    );
    await expect(serviceWithInvalidPat.createToken({ name: 'test', remain_quota: 1000 })).rejects.toThrow(
      NewApiAuthError
    );
  });

  // ==========================================
  // SCENARIO 17: New API Unavailable
  // ==========================================
  it('17. Throws NewApiUnavailableError on 503 and payment approval does not rollback', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(mockNewApi, 'searchTokens').mockRejectedValue(
      new NewApiUnavailableError('New API server is down (503)')
    );

    const tokenProvisioningService = new TokenProvisioningService(mockNewApi);
    const paymentService = new PaymentService(
      new CustomerService(),
      undefined,
      tokenProvisioningService
    );

    const result = await paymentService.approvePayment({
      paymentId: testPaymentA.id,
      reviewerDiscordId: 'admin-reviewer-1',
    });

    // Payment remains APPROVED even though New API was unavailable!
    expect(result.payment.paymentStatus).toBe(PAYMENT_STATUS.APPROVED);
    expect(result.customerProfile.balance).toBe('¥5.00 CNY');
  });

  // ==========================================
  // SCENARIO 18: No Plaintext Secret in Logs
  // ==========================================
  it('18. Error messages and inspectStatus sanitize secrets and never log plaintext keys', async () => {
    const rawSecret = 'sk-sensitive-plaintext-token-998877665544';
    const error = new NewApiError(`Failed to process key ${rawSecret}`);

    // Message must have masked the key
    expect(error.message).not.toContain(rawSecret);
    expect(error.message).toContain('sk-****');

    const tokenRecord = await prisma.customerTokenRecord.create({
      data: {
        customerId: testCustomerId,
        groupId: MODEL_GROUPS.GROUP_A,
        tokenIdentifier: CryptoService.maskApiKey(rawSecret),
        tokenName: `NxG1 - ${testDiscordId} - ${testUsername}`,
        newApiTokenId: 901,
        quotaCny: '5.00',
        status: KEY_STATUS.ACTIVE,
        provisioningStatus: PROVISIONING_STATUS.PROVISIONED,
        keyHash: CryptoService.hashApiKey(rawSecret),
      },
    });

    const service = new TokenProvisioningService();
    const status = await service.inspectStatus(tokenRecord.id);

    // Inspect status returns masked tokenIdentifier and record
    expect(JSON.stringify(status)).not.toContain(rawSecret);
    expect(status.tokenRecord.tokenIdentifier).toBe(CryptoService.maskApiKey(rawSecret));
  });

  // ==========================================
  // SCENARIO 19: Non-empty Allowlist from Actual Models
  // ==========================================
  it('19. Populates non-empty allowlists for Group A, Group E, and Group Claude', () => {
    const service = new TokenProvisioningService();
    const groupAModels = service.getAllowedModelsForGroup(MODEL_GROUPS.GROUP_A);
    const groupEModels = service.getAllowedModelsForGroup(MODEL_GROUPS.GROUP_E);
    const groupClaudeModels = service.getAllowedModelsForGroup(MODEL_GROUPS.GROUP_CLAUDE);

    expect(groupAModels).toContain('[A]gemini-2-5-flash');
    expect(groupAModels).toContain('[A]gemini-3-1-pro-high');
    expect(groupEModels).toContain('[E]gemini-2.5-pro');
    expect(groupClaudeModels).toContain('claude-opus-4-5[次]');

    expect(groupAModels.length).toBeGreaterThan(0);
    expect(groupEModels.length).toBeGreaterThan(0);
    expect(groupClaudeModels.length).toBeGreaterThan(0);
  });

  // ==========================================
  // SCENARIO 20: Reissue Token After Soft-Delete / Failure
  // ==========================================
  it('20. Reissues token for existing approved payment without re-crediting customer balance', async () => {
    const mockNewApi = new NewApiManagementService();
    vi.spyOn(mockNewApi, 'searchTokens').mockResolvedValue([]);
    vi.spyOn(mockNewApi, 'createToken').mockResolvedValue({
      id: 999,
      key: 'sk-reissued-token-999999',
      name: `NxG1 - ${testDiscordId} - ${testUsername}`,
      remain_quota: 373_134,
      group: 'nextgroupA',
    });

    // Initial state: token record is FAILED
    const existingRecord = await prisma.customerTokenRecord.create({
      data: {
        customerId: testCustomerId,
        groupId: MODEL_GROUPS.GROUP_A,
        tokenIdentifier: 'temp-failed-123',
        tokenName: `NxG1 - ${testDiscordId} - ${testUsername}`,
        quotaCny: '5.00',
        status: KEY_STATUS.ACTIVE,
        provisioningStatus: PROVISIONING_STATUS.FAILED,
        paymentId: testPaymentA.id,
        lastError: 'Old failure reason',
      },
    });

    // Mark test payment as APPROVED
    await prisma.payment.update({
      where: { id: testPaymentA.id },
      data: { paymentStatus: PAYMENT_STATUS.APPROVED },
    });

    const initialCustomer = await prisma.customer.findUnique({
      where: { id: testCustomerId },
    });

    const service = new TokenProvisioningService(mockNewApi);
    const result = await service.reissueTokenForApprovedPayment(testPaymentA.id, 'admin-reissuer');

    expect(result.tokenRecord.provisioningStatus).toBe(PROVISIONING_STATUS.PROVISIONED);
    expect(result.tokenRecord.newApiTokenId).toBe(999);
    expect(result.isNewToken).toBe(true);

    // Customer balance was NOT increased
    const afterCustomer = await prisma.customer.findUnique({
      where: { id: testCustomerId },
    });
    expect(afterCustomer?.balance.toString()).toBe(initialCustomer?.balance.toString());

    // Still only 1 token record exists for customer + group
    const tokenRecords = await prisma.customerTokenRecord.findMany({
      where: { customerId: testCustomerId, groupId: MODEL_GROUPS.GROUP_A },
    });
    expect(tokenRecords.length).toBe(1);
  });

  // ==========================================
  // SCENARIO 21: Discord Payload Verification
  // ==========================================
  it('21. Verifies payload contains plaintext key before marking DELIVERED', async () => {
    const mockNewApi = new NewApiManagementService();
    const service = new TokenProvisioningService(mockNewApi);

    const tokenRecord = await prisma.customerTokenRecord.create({
      data: {
        customerId: testCustomerId,
        groupId: MODEL_GROUPS.GROUP_A,
        tokenIdentifier: 'sk-verify-payload-****',
        tokenName: `NxG1 - ${testDiscordId} - ${testUsername}`,
        newApiTokenId: 1001,
        quotaCny: '5.00',
        status: KEY_STATUS.ACTIVE,
        provisioningStatus: PROVISIONING_STATUS.PROVISIONED,
        // Encrypted with invalid/tampered data
        encryptedKey: 'deadbeef',
        iv: '0123456789abcdef01234567',
        authTag: '0123456789abcdef0123456789abcdef',
      },
    });

    const channel = { send: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
    await expect(service.deliverTokenToDiscord(tokenRecord.id, channel)).rejects.toThrow();
  });
});
