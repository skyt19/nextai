import { describe, it, expect, beforeEach } from 'vitest';
import {
  CustomerService,
  CustomerNotFoundError,
  CustomerAuthenticationError,
  CustomerKeyDisabledError,
} from '../../src/services/customer.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { KEY_STATUS, MODEL_GROUPS } from '../../src/config/constants.js';

describe('CustomerService Integration & Unit Tests', () => {
  const customerService = new CustomerService();
  const prisma = getPrismaClient();

  const testDiscordId = '112233445566778899';
  const testUsername = 'NextAiTester';

  beforeEach(async () => {
    // Clean up test customer
    try {
      await prisma.customer.deleteMany({
        where: { discordUserId: testDiscordId },
      });
    } catch {
      // Ignore
    }
  });

  describe('1. Customer Profile Integrity & 6 Business Fields', () => {
    it('creates a new customer and exposes EXACTLY the six business fields', async () => {
      const { customerId, profile, isNew } = await customerService.findOrCreateCustomer(
        testDiscordId,
        testUsername
      );

      expect(isNew).toBe(true);
      expect(customerId).toBeDefined();

      // Check strictly the 6 business fields
      expect(profile.username).toBe(testUsername);
      expect(profile.userId).toBe(testDiscordId);
      expect(profile.apiKey).toBe('NONE');
      expect(profile.balance).toBe('¥0.00 CNY');
      expect(profile.keyStatus).toBe(KEY_STATUS.ACTIVE);
      expect(Array.isArray(profile.paymentHistory)).toBe(true);
      expect(profile.paymentHistory.length).toBe(0);

      // Verify no extra unexpected fields on CustomerProfile interface
      const keys = Object.keys(profile).sort();
      expect(keys).toEqual(['apiKey', 'balance', 'keyStatus', 'paymentHistory', 'userId', 'username'].sort());
    });
  });

  describe('2. Secure API Key Generation & Rotation', () => {
    it('generates an API Key, stores only the SHA-256 hash, and displays full key once', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);

      const { plainTextApiKey, profile } = await customerService.generateOrRotateApiKey(testDiscordId);

      expect(plainTextApiKey.startsWith('nx-live-')).toBe(true);
      expect(profile.apiKey).toBe(plainTextApiKey); // Returned once in generation response

      // Check the database directly: raw key must NEVER be stored in DB!
      const dbRecord = await prisma.customer.findUnique({
        where: { discordUserId: testDiscordId },
      });

      expect(dbRecord?.nextaiApiKeyHash).not.toBe(plainTextApiKey);
      expect(dbRecord?.nextaiApiKeyHash?.length).toBe(64); // SHA-256 hex length
    });

    it('authenticates valid API Key and resolves customer details', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);
      const { plainTextApiKey } = await customerService.generateOrRotateApiKey(testDiscordId);

      // Assign Group A
      await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_A);

      const authResult = await customerService.authenticateApiKey(plainTextApiKey);

      expect(authResult.discordUserId).toBe(testDiscordId);
      expect(authResult.username).toBe(testUsername);
      expect(authResult.allowedGroups).toEqual([MODEL_GROUPS.GROUP_A]);
      expect(authResult.profile.keyStatus).toBe(KEY_STATUS.ACTIVE);
    });

    it('rejects invalid or malformed API Key', async () => {
      await expect(customerService.authenticateApiKey('invalid-key')).rejects.toThrow(
        CustomerAuthenticationError
      );

      await expect(
        customerService.authenticateApiKey('nx-live-nonexistent00000000000000000000000000000000000000000000000000000000')
      ).rejects.toThrow(CustomerAuthenticationError);
    });

    it('rejects disabled or suspended API Key', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);
      const { plainTextApiKey } = await customerService.generateOrRotateApiKey(testDiscordId);

      // Disable key
      await customerService.updateKeyStatus(testDiscordId, KEY_STATUS.DISABLED);

      await expect(customerService.authenticateApiKey(plainTextApiKey)).rejects.toThrow(
        CustomerKeyDisabledError
      );

      // Suspend key
      await customerService.updateKeyStatus(testDiscordId, KEY_STATUS.SUSPENDED);

      await expect(customerService.authenticateApiKey(plainTextApiKey)).rejects.toThrow(
        CustomerKeyDisabledError
      );
    });

    it('rotates API Key and invalidates the previous key', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);
      const { plainTextApiKey: oldKey } = await customerService.generateOrRotateApiKey(testDiscordId);

      // Rotate key
      const { plainTextApiKey: newKey } = await customerService.generateOrRotateApiKey(testDiscordId);
      expect(newKey).not.toBe(oldKey);

      // New key works
      const authNew = await customerService.authenticateApiKey(newKey);
      expect(authNew.discordUserId).toBe(testDiscordId);

      // Old key fails
      await expect(customerService.authenticateApiKey(oldKey)).rejects.toThrow(
        CustomerAuthenticationError
      );
    });
  });

  describe('3. Model Group Assignments', () => {
    it('assigns, queries, and removes model groups', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);

      // Initially no groups
      let groups = await customerService.getCustomerAllowedGroups(testDiscordId);
      expect(groups).toEqual([]);

      // Assign Group A
      groups = await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_A);
      expect(groups).toContain(MODEL_GROUPS.GROUP_A);

      // Assign Group Claude
      groups = await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_CLAUDE);
      expect(groups).toEqual(expect.arrayContaining([MODEL_GROUPS.GROUP_A, MODEL_GROUPS.GROUP_CLAUDE]));

      // Remove Group A
      groups = await customerService.removeModelGroup(testDiscordId, MODEL_GROUPS.GROUP_A);
      expect(groups).toEqual([MODEL_GROUPS.GROUP_CLAUDE]);
    });
  });

  describe('4. Balance Reference Updates', () => {
    it('manages reference balance with explicit currency', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);

      // Credit 50.50 CNY
      const profile1 = await customerService.updateRecordedBalance(testDiscordId, '50.50');
      expect(profile1.balance).toBe('¥50.50 CNY');

      // Credit another 20.25 CNY
      const profile2 = await customerService.updateRecordedBalance(testDiscordId, '20.25');
      expect(profile2.balance).toBe('¥70.75 CNY');
    });
  });

  describe('5. Customer Search', () => {
    it('searches customer by Discord User ID or Username', async () => {
      await customerService.findOrCreateCustomer(testDiscordId, testUsername);

      const searchById = await customerService.searchCustomers(testDiscordId);
      expect(searchById.length).toBe(1);
      expect(searchById[0].userId).toBe(testDiscordId);

      const searchByName = await customerService.searchCustomers(testUsername);
      expect(searchByName.length).toBe(1);
      expect(searchByName[0].username).toBe(testUsername);
    });
  });
});
