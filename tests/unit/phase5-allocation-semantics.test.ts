import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentService } from '../../src/services/payment.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { FrankfurterService } from '../../src/services/frankfurter.service.js';
import { BotEmbeds } from '../../src/bot/ui/embeds.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';

describe('Phase 5: BearLab Allocation Semantics and Local Reference Audit', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const frankfurterService = new FrankfurterService();
  const paymentService = new PaymentService(customerService, frankfurterService);

  const testDiscordId = 'phase5-allocation-tester-777';
  const testUsername = 'AllocationTester';

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

  it('1. Local administrative reference record is created ONLY after successful payment approval', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);

    // 1. Create payment: status PENDING_PAYMENT -> Customer balance must remain 0
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-alloc-test',
      packageId: pkg.id,
    });

    let profile = await customerService.getCustomerProfile(testDiscordId);
    expect(profile.balance).toBe('¥0.00 CNY');

    // 2. Submit slip: status UNDER_REVIEW -> Customer balance must still remain 0
    await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: Buffer.from('slip-alloc-test'),
      originalFilename: 'slip.png',
      mimeType: 'image/png',
    });

    profile = await customerService.getCustomerProfile(testDiscordId);
    expect(profile.balance).toBe('¥0.00 CNY');

    // 3. Admin approves: status APPROVED -> Customer balance now reflects local reference allocation
    const approval = await paymentService.approvePayment({
      paymentId: payment.id,
      reviewerDiscordId: 'admin-allocator',
    });

    expect(approval.payment.paymentStatus).toBe('APPROVED');
    profile = await customerService.getCustomerProfile(testDiscordId);
    expect(profile.balance).toBe('¥5.00 CNY');
  });

  it('2. Embed UI phrasing explicitly describes local reference credit and does not claim BearLab credit', () => {
    const embed = BotEmbeds.paymentApproved({
      packageName: 'Starter Group A 100',
      groupId: 'NxG1',
      assignedQuotaCny: '2.00',
      gatewayUrl: 'http://localhost:12345/v1',
    });

    const desc = embed.data.description || '';
    // Confirms "เครดิตอ้างอิงที่ได้รับ" (Reference credit received)
    expect(desc).toContain('**เครดิตอ้างอิงที่ได้รับ:** ¥2.00 CNY');
    // Confirms it never claims Bearlab was credited
    expect(desc.toLowerCase()).not.toContain('bearlab');
  });

  it('3. Repeated approval is strictly idempotent and does not create duplicate allocation records', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-alloc-idemp',
      packageId: pkg.id,
    });

    await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: Buffer.from('slip-alloc-idemp'),
      originalFilename: 'slip.png',
      mimeType: 'image/png',
    });

    // First approval
    await paymentService.approvePayment({
      paymentId: payment.id,
      reviewerDiscordId: 'admin-allocator',
    });

    // Second approval
    const second = await paymentService.approvePayment({
      paymentId: payment.id,
      reviewerDiscordId: 'admin-allocator',
    });

    expect(second.alreadyProcessed).toBe(true);
    const profile = await customerService.getCustomerProfile(testDiscordId);
    expect(profile.balance).toBe('¥5.00 CNY'); // Not ¥10.00 CNY
  });
});
