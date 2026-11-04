import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentService } from '../../src/services/payment.service.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { FrankfurterService } from '../../src/services/frankfurter.service.js';
import { PromptPayService } from '../../src/services/promptpay.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS, PAYMENT_STATUS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

/**
 * Standard CCITT CRC-16 (Polynomial 0x1021, Initial 0xFFFF) for EMVCo QR validation.
 */
function computeEmvCoCrc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

describe('Phase 4: Payment and PromptPay Hardening Tests', () => {
  const prisma = getPrismaClient();
  const customerService = new CustomerService();
  const frankfurterService = new FrankfurterService();
  const paymentService = new PaymentService(customerService, frankfurterService);

  const testDiscordId = 'phase4-tester-999';
  const testUsername = 'Phase4Tester';

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

  it('1. Package creation produces exact expected amounts: NxG1 51 THB, NxGE 90 THB, NxGC 75 THB', async () => {
    const pkgA = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const pkgE = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_E, 100);
    const pkgC = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_CLAUDE, 100);

    const { payment: payA } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-a',
      packageId: pkgA.id,
    });

    const { payment: payE } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-e',
      packageId: pkgE.id,
    });

    const { payment: payC } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-c',
      packageId: pkgC.id,
    });

    expect(new Decimal(payA.expectedAmountThb.toString()).toFixed(2)).toBe('51.00');
    expect(new Decimal(payE.expectedAmountThb.toString()).toFixed(2)).toBe('90.00');
    expect(new Decimal(payC.expectedAmountThb.toString()).toFixed(2)).toBe('75.00');
  });

  it('2. PromptPay QR payload contains valid CCITT CRC-16 checksum matching tag 63', async () => {
    const qr = await PromptPayService.generatePromptPayQr({
      recipient: '0812345678',
      amount: '51.00',
    });

    // In EMVCo QR, the last 4 characters are the CRC-16 hex value, preceded by '6304'
    expect(qr.payload).toContain('6304');
    const crcIndex = qr.payload.lastIndexOf('6304');
    const payloadToHash = qr.payload.slice(0, crcIndex + 4);
    const expectedCrc = qr.payload.slice(crcIndex + 4);

    const calculatedCrc = computeEmvCoCrc16(payloadToHash);
    expect(expectedCrc).toBe(calculatedCrc);
  });

  it('3. Concurrent approvals on the same payment cannot grant duplicate entitlements', async () => {
    const pkg = await paymentService.findOrCreatePackageForGroup(MODEL_GROUPS.GROUP_A, 100);
    const { payment } = await paymentService.createPendingPayment({
      discordUserId: testDiscordId,
      username: testUsername,
      ticketChannelId: 'ticket-concurrent',
      packageId: pkg.id,
    });

    await paymentService.submitPaymentSlip({
      paymentId: payment.id,
      fileBuffer: Buffer.from('unique-slip-data-concurrent'),
      originalFilename: 'slip.png',
      mimeType: 'image/png',
    });

    // Fire 2 approval requests concurrently
    const [result1, result2] = await Promise.all([
      paymentService.approvePayment({
        paymentId: payment.id,
        reviewerDiscordId: 'admin-1',
      }),
      paymentService.approvePayment({
        paymentId: payment.id,
        reviewerDiscordId: 'admin-2',
      }),
    ]);

    // Exactly one should be the primary approval, the other alreadyProcessed
    const results = [result1, result2];
    const initialApproval = results.find((r) => !r.alreadyProcessed);
    const duplicateApproval = results.find((r) => r.alreadyProcessed);

    expect(initialApproval).toBeDefined();
    expect(duplicateApproval).toBeDefined();

    // Verify balance was credited exactly once (5.00 CNY, not 10.00 CNY)
    const profile = await customerService.getCustomerProfile(testDiscordId);
    expect(profile.balance).toBe('¥5.00 CNY');
  });
});
