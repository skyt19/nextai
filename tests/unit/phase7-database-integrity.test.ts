import { describe, it, expect } from 'vitest';
import { getPrismaClient } from '../../src/db/client.js';
import { CryptoService } from '../../src/services/crypto.service.js';

describe('Phase 7: Database Integrity and Constraint Hardening', () => {
  const prisma = getPrismaClient();

  it('1. Enforces unique constraint on Customer.discordUserId', async () => {
    const uniqueDiscordId = 'unique-discord-user-12345';
    await prisma.customer.create({
      data: {
        discordUserId: uniqueDiscordId,
        username: 'UniqueUser',
      },
    });

    // Attempting duplicate creation must throw Prisma Unique constraint error (P2002)
    await expect(
      prisma.customer.create({
        data: {
          discordUserId: uniqueDiscordId,
          username: 'DuplicateUser',
        },
      })
    ).rejects.toThrow();

    await prisma.customer.delete({ where: { discordUserId: uniqueDiscordId } });
  });

  it('2. Enforces unique constraint on ModelCatalogEntry.publicModelId', async () => {
    // 'gemini-3-1-pro-high-nxg1' already exists in catalog
    await expect(
      prisma.modelCatalogEntry.create({
        data: {
          publicModelId: 'gemini-3-1-pro-high-nxg1',
          displayName: 'Duplicate Model',
          originalBearlabModelId: '[A]duplicate',
          groupId: 'NxG1',
          baseCostCny: 0.02,
          markup: 2.5,
          sellingPriceCny: 0.05,
        },
      })
    ).rejects.toThrow();
  });

  it('3. Enforces foreign key constraint on Payment.customerId', async () => {
    // Attempting to create a payment referencing a non-existent customer must fail
    await expect(
      prisma.payment.create({
        data: {
          customerId: 'non-existent-customer-uuid-00000000',
          ticketChannelId: 'ticket-fake',
          packageId: 'fake-pkg',
          expectedAmountThb: 51.0,
          paymentStatus: 'PENDING_PAYMENT',
          calculationSnapshot: '{}',
        },
      })
    ).rejects.toThrow();
  });

  it('4. API Key storage security: plaintext key is NEVER stored in database', async () => {
    const rawApiKey = CryptoService.generateApiKey();
    const hash = CryptoService.hashApiKey(rawApiKey);

    const testCust = await prisma.customer.create({
      data: {
        discordUserId: 'api-key-security-tester-888',
        username: 'ApiKeyTester',
        nextaiApiKeyHash: hash,
      },
    });

    const retrieved = await prisma.customer.findUniqueOrThrow({
      where: { id: testCust.id },
    });

    // Hash matches
    expect(retrieved.nextaiApiKeyHash).toBe(hash);
    // Plaintext key cannot be found in database columns
    expect((retrieved as any).plainTextApiKey).toBeUndefined();
    expect((retrieved as any).apiKey).toBeUndefined();
    expect(retrieved.nextaiApiKeyHash).not.toBe(rawApiKey);

    await prisma.customer.delete({ where: { id: testCust.id } });
  });
});
