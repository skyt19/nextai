import { describe, it, expect } from 'vitest';
import { TicketHandler } from '../../src/bot/handlers/ticket.handler.js';
import { ReviewHandler } from '../../src/bot/handlers/review.handler.js';
import { PermissionFlagsBits } from 'discord.js';

describe('Discord Ticket & Security Unit Tests', () => {
  describe('1. Ticket Permission Matrix Isolation', () => {
    it('strictly denies @everyone and allows only customer, admins, and bot', () => {
      const mockGuild = {
        roles: {
          everyone: { id: 'everyone-role-id' },
        },
      } as any;

      const customerId = 'customer-discord-123';
      const botId = 'bot-discord-999';
      const adminIds = ['admin-1', 'admin-2'];

      const overwrites = TicketHandler.buildPermissionOverwrites({
        guild: mockGuild,
        customerDiscordId: customerId,
        adminDiscordIds: adminIds,
        botUserId: botId,
      }) as any[];

      expect(overwrites.length).toBe(5); // everyone + customer + bot + 2 admins = 5 entries

      // 1. Verify @everyone DENIAL
      const everyoneEntry = overwrites.find((o) => o.id === 'everyone-role-id');
      expect(everyoneEntry).toBeDefined();
      expect(everyoneEntry.deny).toContain(PermissionFlagsBits.ViewChannel);
      expect(everyoneEntry.deny).toContain(PermissionFlagsBits.SendMessages);
      expect(everyoneEntry.deny).toContain(PermissionFlagsBits.AttachFiles);

      // 2. Verify Customer ALLOW
      const customerEntry = overwrites.find((o) => o.id === customerId);
      expect(customerEntry).toBeDefined();
      expect(customerEntry.allow).toContain(PermissionFlagsBits.ViewChannel);
      expect(customerEntry.allow).toContain(PermissionFlagsBits.SendMessages);
      expect(customerEntry.allow).toContain(PermissionFlagsBits.AttachFiles);

      // 3. Verify Bot ALLOW
      const botEntry = overwrites.find((o) => o.id === botId);
      expect(botEntry).toBeDefined();
      expect(botEntry.allow).toContain(PermissionFlagsBits.ViewChannel);
      expect(botEntry.allow).toContain(PermissionFlagsBits.ManageChannels);

      // 4. Verify Admins ALLOW
      const admin1Entry = overwrites.find((o) => o.id === 'admin-1');
      expect(admin1Entry).toBeDefined();
      expect(admin1Entry.allow).toContain(PermissionFlagsBits.ViewChannel);

      const admin2Entry = overwrites.find((o) => o.id === 'admin-2');
      expect(admin2Entry).toBeDefined();
    });
  });

  describe('2. ReviewHandler Server-Side Admin Authorization', () => {
    const adminAllowlist = ['admin-discord-user-1', 'admin-discord-user-2'];
    const reviewHandler = new ReviewHandler(undefined, adminAllowlist);

    it('authorizes allowlisted admin IDs', () => {
      expect(reviewHandler.isAuthorizedAdmin('admin-discord-user-1')).toBe(true);
      expect(reviewHandler.isAuthorizedAdmin('admin-discord-user-2')).toBe(true);
    });

    it('rejects regular users not in allowlist', () => {
      expect(reviewHandler.isAuthorizedAdmin('random-customer-user')).toBe(false);
      expect(reviewHandler.isAuthorizedAdmin('malicious-user-id')).toBe(false);
      expect(reviewHandler.isAuthorizedAdmin('')).toBe(false);
    });
  });
});
