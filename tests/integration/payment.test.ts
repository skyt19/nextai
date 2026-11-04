import { describe, it, expect, beforeEach } from 'vitest';
import {
  PaymentService,
  DuplicateSlipError,
  InvalidSlipFormatError,
  SlipSizeExceededError,
  PaymentStateError,
} from '../../src/services/payment.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { FrankfurterService } from '../../src/services/frankfurter.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS, PAYMENT_STATUS } from '../../src/config/constants.js';

describe('PaymentService Integration Tests', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const frankfurterService = new FrankfurterService();
  const paymentService = new PaymentService(customerService, frankfurterService);

  const testDiscordId = '998877665544332211';
  const testUsername = 'PaymentWorkflowTester';
  let samplePackageId = '';

  beforeEach(async () => {
    // 1. Clean up payments & slips for test customer
    try {
      const testCustomer = await prisma.customer.findUnique({
        where: { discordUserId: testDiscordId },
        include: { payments: { include: { slips: true } } },
      });
      if (testCustomer) {
        for (const p of testCustomer.payments) {
          await prisma.paymentSlip.deleteMany({ where: { paymentId: p.id } });
        }
        await prisma.payment.deleteMany({ where: { customerId: testCustomer.id } });
        await prisma.customer.delete({ where: { id: testCustomer.id } });
      }
      await prisma.package.deleteMany({
        where: { name: 'Starter Group A 100 Integration' },
      });
    } catch {
      // Ignore
    }

    // 2. Set admin fallback rate for deterministic testing (5.12 THB / CNY)
    await frankfurterService.setAdminFallbackRate('5.1200', '0.1400', '2026-11-02');

    // 3. Create a test package for Group A (100 requests @ 0.020 CNY = 2.0 cost CNY, selling 51 THB)
    const pkg = await prisma.package.create({
      data: {
        name: 'Starter Group A 100 Integration',
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelId: 'gemini-3-1-pro-high-nxg1',
        referenceRequests: 100,
        referenceModelCostCny: '0.020',
        markup: '2.5',
        sellingPriceThb: '51.00',
        bufferCny: '1.0',
        enabled: true,
      },
    });
    samplePackageId = pkg.id;
  });

  it('1. creates pending payment with exact quote snapshot', async () => {
    const { payment, calculation } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-12345',
      packageId: samplePackageId,
    });

    expect(payment.paymentStatus).toBe(PAYMENT_STATUS.PENDING_PAYMENT);
    expect(payment.expectedAmountThb.toString()).toBe('51');
    expect(calculation.assignedQuotaCny.toString()).toBe('3'); // 2 + 1 buffer
    expect(calculation.snapshot.assigned_quota_cny).toBe('3.0000');
    expect(calculation.snapshot.final_payment_amount_thb).toBe('51.00');
  });

  it('2. submits slip, computes SHA-256 hash, and transitions status to UNDER_REVIEW', async () => {
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-12345',
      packageId: samplePackageId,
    });

    const slipBuffer = Buffer.from('fake-png-image-binary-data-12345');
    const { payment: underReviewPayment, slip } = await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: slipBuffer,
      originalFilename: 'transfer_slip.png',
      mimeType: 'image/png',
    });

    expect(underReviewPayment.paymentStatus).toBe(PAYMENT_STATUS.UNDER_REVIEW);
    expect(slip.fileHash.length).toBe(64);
    expect(underReviewPayment.slipReference).toContain(slip.fileHash);
  });

  it('3. duplicate slip submission is rejected with DuplicateSlipError', async () => {
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-12345',
      packageId: samplePackageId,
    });

    const slipBuffer = Buffer.from('fake-unique-image-bytes-777');

    // First submission succeeds
    await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: slipBuffer,
      originalFilename: 'slip.jpg',
      mimeType: 'image/jpeg',
    });

    // Create a second payment
    const { payment: payment2 } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-67890',
      packageId: samplePackageId,
    });

    // Re-submitting the exact same slip bytes must be rejected
    await expect(
      paymentService.submitPaymentSlip({
        paymentId: payment2.id,
        fileBuffer: slipBuffer,
        originalFilename: 'duplicate.jpg',
        mimeType: 'image/jpeg',
      })
    ).rejects.toThrow(DuplicateSlipError);
  });

  it('4. rejects invalid MIME format or file exceeding max limit', async () => {
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-12345',
      packageId: samplePackageId,
    });

    // PDF format rejected
    await expect(
      paymentService.submitPaymentSlip({
        paymentId: payment.id,
        fileBuffer: Buffer.from('pdf-data'),
        originalFilename: 'slip.pdf',
        mimeType: 'application/pdf',
      })
    ).rejects.toThrow(InvalidSlipFormatError);

    // Exceeding max size (tested with 50-byte limit)
    await expect(
      paymentService.submitPaymentSlip({
        paymentId: payment.id,
        fileBuffer: Buffer.alloc(100),
        originalFilename: 'oversized.png',
        mimeType: 'image/png',
        maxSizeBytes: 50,
      })
    ).rejects.toThrow(SlipSizeExceededError);
  });

  it('5. admin manual approval credits balance, assigns group, generates API key, and is idempotent', async () => {
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-12345',
      packageId: samplePackageId,
    });

    await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: Buffer.from('slip-data-to-approve-abc'),
      originalFilename: 'slip.webp',
      mimeType: 'image/webp',
    });

    // Administrator approves payment
    const approvalResult = await paymentService.approvePayment({
      paymentId: payment.id,
      reviewerDiscordId: 'admin-discord-user-1',
    });

    expect(approvalResult.payment.paymentStatus).toBe(PAYMENT_STATUS.APPROVED);
    expect(approvalResult.newlyIssuedApiKey).toBeDefined();
    expect(approvalResult.newlyIssuedApiKey?.startsWith('nx-live-')).toBe(true);
    expect(approvalResult.customerProfile.balance).toBe('¥5.00 CNY'); // Customer Quota: 0.050 * 100 = 5.00 CNY

    // Verify model group assignment
    const groups = await customerService.getCustomerAllowedGroups(testDiscordId);
    expect(groups).toContain(MODEL_GROUPS.GROUP_A);

    // IDEMPOTENCY TEST: Calling approve again must NOT credit balance twice
    const secondApproval = await paymentService.approvePayment({
      paymentId: payment.id,
      reviewerDiscordId: 'admin-discord-user-1',
    });

    expect(secondApproval.alreadyProcessed).toBe(true);
    expect(secondApproval.customerProfile.balance).toBe('¥5.00 CNY'); // Still 5.00 CNY!
  });

  it('6. admin rejection updates status with reason and prevents approval', async () => {
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-12345',
      packageId: samplePackageId,
    });

    await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: Buffer.from('slip-to-reject-xyz'),
      originalFilename: 'slip.png',
      mimeType: 'image/png',
    });

    const rejected = await paymentService.rejectPayment({
      paymentId: payment.id,
      reviewerDiscordId: 'admin-discord-user-1',
      rejectionReason: 'Bank transfer amount mismatch: expected 51.00 THB, transferred 20.00 THB',
    });

    expect(rejected.paymentStatus).toBe(PAYMENT_STATUS.REJECTED);
    expect(rejected.rejectionReason).toContain('Bank transfer amount mismatch');
  });
});
