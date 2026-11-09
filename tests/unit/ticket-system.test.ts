import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TicketService, DuplicateActiveTicketError, TicketStateError } from '../../src/bot/services/ticket.service.js';
import { TicketHandler } from '../../src/bot/handlers/ticket.handler.js';
import { SlipHandler } from '../../src/bot/handlers/slip.handler.js';
import { TicketLoggerService } from '../../src/bot/services/ticket-logger.service.js';
import { TicketPanelUI } from '../../src/bot/ui/ticket-panel.js';
import { BotComponents } from '../../src/bot/ui/components.js';
import { BotEmbeds } from '../../src/bot/ui/embeds.js';
import { getPrismaClient } from '../../src/db/client.js';
import { TICKET_CATEGORY, TICKET_STATUS, PAYMENT_STATUS, MODEL_GROUPS } from '../../src/config/constants.js';
import { PermissionFlagsBits, TextChannel } from 'discord.js';

describe('Discord Ticket Management System Tests', () => {
  const prisma = getPrismaClient();
  const ticketService = new TicketService();

  const testOwnerId = 'user-discord-ticket-owner-123';
  const testStaffId = 'staff-discord-user-456';
  const testAdminId = 'admin-discord-user-789';
  const testGuildId = 'guild-test-999';

  beforeEach(async () => {
    vi.restoreAllMocks();
    try {
      await prisma.paymentSlip.deleteMany({});
      await prisma.payment.deleteMany({});
      await prisma.ticket.deleteMany({});
    } catch {
      // Ignore
    }
  });

  describe('1. TicketService & Database Lifecycle', () => {
    it('creates a Purchase Model ticket in database with OPEN status', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-purchase-101',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      expect(ticket.id).toBeDefined();
      expect(ticket.category).toBe(TICKET_CATEGORY.PURCHASE_MODEL);
      expect(ticket.status).toBe(TICKET_STATUS.OPEN);
      expect(ticket.ownerDiscordId).toBe(testOwnerId);
      expect(ticket.claimedByDiscordId).toBeNull();
      expect(ticket.closedAt).toBeNull();
    });

    it('creates a General Inquiry ticket in database', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-inquiry-102',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.GENERAL_INQUIRY,
      });

      expect(ticket.category).toBe(TICKET_CATEGORY.GENERAL_INQUIRY);
      expect(ticket.status).toBe(TICKET_STATUS.OPEN);
    });

    it('prevents creating duplicate active tickets of the same category', async () => {
      await ticketService.createTicketRecord({
        discordChannelId: 'channel-active-1',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      // Second attempt while first is OPEN must throw DuplicateActiveTicketError
      await expect(
        ticketService.createTicketRecord({
          discordChannelId: 'channel-active-2',
          discordGuildId: testGuildId,
          ownerDiscordId: testOwnerId,
          category: TICKET_CATEGORY.PURCHASE_MODEL,
        })
      ).rejects.toThrow(DuplicateActiveTicketError);
    });

    it('allows opening a new ticket after prior ticket is closed', async () => {
      const ticket1 = await ticketService.createTicketRecord({
        discordChannelId: 'channel-to-close',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      // Close the first ticket
      await ticketService.closeTicket(ticket1.id, testOwnerId);

      // Now opening a second ticket in the same category is permitted
      const ticket2 = await ticketService.createTicketRecord({
        discordChannelId: 'channel-new-purchase',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      expect(ticket2.id).not.toBe(ticket1.id);
      expect(ticket2.status).toBe(TICKET_STATUS.OPEN);
    });

    it('claims an open ticket and prevents duplicate claims by other staff', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-claim-test',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.GENERAL_INQUIRY,
      });

      // Staff claims ticket
      const claimed = await ticketService.claimTicket(ticket.id, testStaffId);
      expect(claimed.status).toBe(TICKET_STATUS.CLAIMED);
      expect(claimed.claimedByDiscordId).toBe(testStaffId);

      // Another staff attempts to claim the same ticket
      await expect(ticketService.claimTicket(ticket.id, 'other-staff-999')).rejects.toThrow(
        TicketStateError
      );
    });

    it('releases a claimed ticket back to unassigned OPEN state', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-release-test',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.GENERAL_INQUIRY,
      });

      await ticketService.claimTicket(ticket.id, testStaffId);
      const released = await ticketService.releaseTicket(ticket.id, testStaffId);

      expect(released.status).toBe(TICKET_STATUS.OPEN);
      expect(released.claimedByDiscordId).toBeNull();
    });

    it('closes a ticket idempotently, recording closer and timestamp', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-close-test',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      const closed = await ticketService.closeTicket(ticket.id, testStaffId);
      expect(closed.status).toBe(TICKET_STATUS.CLOSED);
      expect(closed.closedByDiscordId).toBe(testStaffId);
      expect(closed.closedAt).toBeDefined();

      // Second close is idempotent
      const secondClose = await ticketService.closeTicket(ticket.id, testStaffId);
      expect(secondClose.status).toBe(TICKET_STATUS.CLOSED);
    });

    it('reopens a closed ticket', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-reopen-test',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.GENERAL_INQUIRY,
      });

      await ticketService.closeTicket(ticket.id, testStaffId);
      const reopened = await ticketService.reopenTicket(ticket.id);

      expect(reopened.status).toBe(TICKET_STATUS.OPEN);
      expect(reopened.closedAt).toBeNull();
      expect(reopened.closedByDiscordId).toBeNull();
    });

    it('deletes a ticket: marks DELETED in DB while preserving history', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-delete-test',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      const deleted = await ticketService.deleteTicket(ticket.id, testAdminId);
      expect(deleted.status).toBe(TICKET_STATUS.DELETED);
      expect(deleted.deletedByDiscordId).toBe(testAdminId);
      expect(deleted.deletedAt).toBeDefined();

      // Record remains in DB (never deleted from database)
      const inDb = await ticketService.getTicketById(ticket.id);
      expect(inDb).not.toBeNull();
      expect(inDb?.status).toBe(TICKET_STATUS.DELETED);
    });
  });

  describe('2. Ticket Channel Naming & Permissions', () => {
    it('generates sanitized and unique channel names', () => {
      const mockGuild = {
        channels: {
          cache: [
            { name: 'purchase-alice' }, // Already exists
          ],
        },
      } as any;

      // When name does not collide
      const name1 = TicketHandler.generateChannelName('inquiry', 'Bob_123!', mockGuild);
      expect(name1).toBe('inquiry-bob-123');

      // When name collides with an existing channel, append unique counter
      const name2 = TicketHandler.generateChannelName('purchase', 'Alice', mockGuild);
      expect(name2).toBe('purchase-alice-1');
    });

    it('builds strict permission overwrites with support role and admin allowlist', () => {
      const mockGuild = {
        roles: {
          everyone: { id: 'role-everyone' },
          cache: new Map([['support-role-123', { id: 'support-role-123' }]]),
        },
      } as any;

      const overwrites = TicketHandler.buildPermissionOverwrites({
        guild: mockGuild,
        customerDiscordId: testOwnerId,
        adminDiscordIds: [testAdminId],
        supportRoleId: 'support-role-123',
        botUserId: 'bot-client-user-id',
      }) as any[];

      // @everyone denied
      const everyone = overwrites.find((o) => o.id === 'role-everyone');
      expect(everyone.deny).toContain(PermissionFlagsBits.ViewChannel);
      expect(everyone.deny).toContain(PermissionFlagsBits.SendMessages);

      // Customer allowed
      const customer = overwrites.find((o) => o.id === testOwnerId);
      expect(customer.allow).toContain(PermissionFlagsBits.ViewChannel);
      expect(customer.allow).toContain(PermissionFlagsBits.SendMessages);

      // Support Role allowed
      const support = overwrites.find((o) => o.id === 'support-role-123');
      expect(support).toBeDefined();
      expect(support.allow).toContain(PermissionFlagsBits.ViewChannel);

      // Admin allowed
      const admin = overwrites.find((o) => o.id === testAdminId);
      expect(admin).toBeDefined();
      expect(admin.allow).toContain(PermissionFlagsBits.ViewChannel);
    });

    it('identifies staff and administrators server-side correctly', () => {
      const handler = new TicketHandler(
        ticketService,
        undefined,
        [testAdminId],
        'support-role-123'
      );

      // Admin ID
      const adminMember = {
        id: testAdminId,
        roles: { cache: new Map() },
        permissions: { has: () => false },
      } as any;
      expect(handler.isStaffOrAdmin(adminMember)).toBe(true);

      // Member with Support Role
      const staffMember = {
        id: 'some-user',
        roles: { cache: new Map([['support-role-123', {}]]) },
        permissions: { has: () => false },
      } as any;
      expect(handler.isStaffOrAdmin(staffMember)).toBe(true);

      // Member with Administrator Discord permission
      const discordAdmin = {
        id: 'other-user',
        roles: { cache: new Map() },
        permissions: { has: (p: any) => p === PermissionFlagsBits.Administrator },
      } as any;
      expect(handler.isStaffOrAdmin(discordAdmin)).toBe(true);

      // Regular customer
      const regularCustomer = {
        id: testOwnerId,
        roles: { cache: new Map() },
        permissions: { has: () => false },
      } as any;
      expect(handler.isStaffOrAdmin(regularCustomer)).toBe(false);
    });
  });

  describe('3. Ticket Logger Service', () => {
    it('dispatches lifecycle audit log embed to log channel', async () => {
      const sendMock = vi.fn().mockResolvedValue({});
      const mockChannel = {
        send: sendMock,
      };

      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue(Object.assign(Object.create(TextChannel.prototype), mockChannel)),
        },
      } as any;

      const logger = new TicketLoggerService(mockClient, '1566804177848369286');

      await logger.logEvent({
        eventType: 'TICKET_CREATED',
        ticketId: 'ticket-uuid-123',
        channelId: 'channel-456',
        category: 'PURCHASE_MODEL',
        ownerDiscordId: testOwnerId,
        status: 'OPEN',
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const sentPayload = sendMock.mock.calls[0][0];
      expect(sentPayload.embeds).toBeDefined();
      const embed = sentPayload.embeds[0];
      expect(embed.data.title).toContain('TICKET CREATED');
    });

    it('gracefully degrades without crashing when log channel is unavailable', async () => {
      const mockClient = {
        channels: {
          fetch: vi.fn().mockRejectedValue(new Error('Channel not found')),
        },
      } as any;

      const logger = new TicketLoggerService(mockClient, 'invalid-channel-id');

      // Should not throw
      await expect(
        logger.logEvent({
          eventType: 'TICKET_DELETED',
          ticketId: 'ticket-789',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('4. Ticket Panel UI Components', () => {
    it('generates Support Center embed with required categories in Thai', () => {
      const embed = TicketPanelUI.supportCenterEmbed();
      expect(embed.data.title).toBe('SealAPI Hub | ศูนย์บริการลูกค้า');
      expect(embed.data.description).toContain('ซื้อแพ็กเกจโมเดล');
      expect(embed.data.description).toContain('สอบถามข้อมูล');
    });

    it('generates category select menu with purchase_model and general_inquiry in Thai', () => {
      const menuRow = TicketPanelUI.categorySelectMenu();
      const menu = menuRow.components[0] as any;

      expect(menu.data.custom_id).toBe('ticket_select_category');
      expect(menu.options.length).toBe(2);

      const values = menu.options.map((o: any) => o.data.value);
      expect(values).toContain('purchase_model');
      expect(values).toContain('general_inquiry');

      const labels = menu.options.map((o: any) => o.data.label);
      expect(labels).toContain('ซื้อแพ็กเกจโมเดล');
      expect(labels).toContain('สอบถามข้อมูล');
    });

    it('generates Stage 1 Model Group select menu', () => {
      const groupRow = BotComponents.modelGroupSelectMenu();
      const menu = groupRow.components[0] as any;

      expect(menu.data.custom_id).toBe('purchase_select_group');
      expect(menu.options.length).toBe(4);
      const values = menu.options.map((o: any) => o.data.value);
      expect(values).toContain('SxG1');
      expect(values).toContain('SxGE');
      expect(values).toContain('SxGC');
      expect(values).toContain('SxCGL');
    });

    it('generates Stage 2 Reference Requests select menu', () => {
      const reqRow = BotComponents.referenceRequestsSelectMenu('NxG1', [100, 500, 1000]);
      const menu = reqRow.components[0] as any;

      expect(menu.data.custom_id).toBe('purchase_select_requests_NxG1');
      expect(menu.options.length).toBe(3);
      const values = menu.options.map((o: any) => o.data.value);
      expect(values).toContain('100');
      expect(values).toContain('500');
      expect(values).toContain('1000');
    });

    it('verifies /balance embed privacy: strictly omits Bearlab and internal execution notes', () => {
      const embed = BotEmbeds.customerProfile({
        username: 'testuser',
        userId: '123456789',
        apiKey: 'CONFIGURED (nx-live-...)',
        balance: '¥10.00 CNY',
        keyStatus: 'ACTIVE',
        paymentHistory: [],
      });

      const fullText = `${embed.data.title} ${embed.data.description}`;
      expect(fullText).not.toContain('Bearlab');
      expect(fullText).not.toContain('Upstream model execution is managed by Bearlab AI');
      expect(fullText).not.toContain('exchange rate');
      expect(fullText).not.toContain('markup');
      expect(embed.data.title).toContain('ข้อมูลบัญชีและยอดคงเหลือ');
      expect(embed.data.description).toContain('**ยอดคงเหลือ:** **¥10.00 CNY**');
      expect(embed.data.description).toContain('**สถานะ API Key:** `ACTIVE`');
    });

    it('verifies Stage 3 Payment embed privacy: strictly omits provider cost, CNY, exchange rate, and markup', () => {
      const embed = BotEmbeds.paymentInstructions({
        groupDisplayName: 'NxG1 — Gemini Group A',
        referenceRequests: 100,
        paymentId: 'pay-uuid-1234',
        finalAmountThb: '51.00',
        promptPayId: '0812345678',
        hasQrAttachment: true,
      });

      const fullText = `${embed.data.title} ${embed.data.description}`;
      expect(fullText).not.toContain('Bearlab');
      expect(fullText).not.toContain('CNY');
      expect(fullText).not.toContain('markup');
      expect(fullText).not.toContain('Exchange Rate');
      expect(fullText).not.toContain('Provider Cost');
      expect(embed.data.description).toContain('NxG1 — Gemini Group A');
      expect(embed.data.description).toContain('100 คำขอ');
      expect(embed.data.description).toContain('฿51.00 THB');
      expect(embed.data.description).toContain('pay-uuid-1234');
      expect(embed.data.image?.url).toBe('attachment://promptpay-qr.png');
    });

    it('generates persistent management control buttons', () => {
      const controls = TicketPanelUI.ticketControls('test-ticket-id', false);
      const buttons = controls.components as any[];

      expect(buttons.length).toBe(3);
      expect(buttons[0].data.custom_id).toBe('ticket_ctrl_close_test-ticket-id');
      expect(buttons[1].data.custom_id).toBe('ticket_ctrl_claim_test-ticket-id');
      expect(buttons[2].data.custom_id).toBe('ticket_ctrl_delete_test-ticket-id');
    });
  });

  describe('5. Task 1: Reset Ticket Choice & In-flight Concurrency Lock', () => {
    it('resets the original select menu to default placeholder after handling', async () => {
      const mockChannel = {
        id: 'new-ticket-channel-1',
        name: 'purchase-testuser',
        send: vi.fn().mockResolvedValue({}),
      };

      const mockGuild = {
        id: testGuildId,
        channels: {
          cache: { some: () => false, has: () => false },
          create: vi.fn().mockResolvedValue(mockChannel),
        },
        roles: {
          everyone: { id: 'role-everyone' },
          cache: new Map(),
        },
      } as any;

      const editMenuMock = vi.fn().mockResolvedValue({});
      const editReplyMock = vi.fn().mockResolvedValue({});
      const deferReplyMock = vi.fn().mockResolvedValue({});

      const mockInteraction = {
        values: ['purchase_model'],
        guild: mockGuild,
        user: { id: 'user-reset-test', username: 'testuser' },
        client: { user: { id: 'bot-id' } },
        deferReply: deferReplyMock,
        editReply: editReplyMock,
        message: {
          edit: editMenuMock,
        },
      } as any;

      const handler = new TicketHandler(ticketService, undefined, [testAdminId]);
      await handler.handleCategorySelect(mockInteraction);

      expect(deferReplyMock).toHaveBeenCalledWith({ ephemeral: true });
      expect(mockGuild.channels.create).toHaveBeenCalled();
      expect(editReplyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('🎫 เปิด Ticket เรียบร้อยแล้ว'),
        })
      );

      // Verify the message select menu was reset to default placeholder
      expect(editMenuMock).toHaveBeenCalledTimes(1);
      const resetPayload = editMenuMock.mock.calls[0][0];
      expect(resetPayload.components).toBeDefined();
      expect(resetPayload.components.length).toBe(1);
      const menu = resetPayload.components[0].components[0];
      expect(menu.data.placeholder).toBe('เลือกประเภทบริการที่ต้องการ...');
    });

    it('blocks concurrent duplicate ticket creation from rapid double clicks', async () => {
      let resolveChannelCreation: any;
      const delayedChannelPromise = new Promise((res) => {
        resolveChannelCreation = res;
      });

      const mockGuild = {
        id: testGuildId,
        channels: {
          cache: { some: () => false, has: () => false },
          create: vi.fn().mockImplementation(async () => {
            await delayedChannelPromise;
            return {
              id: 'concurrent-channel-1',
              name: 'purchase-concurrent',
              send: vi.fn().mockResolvedValue({}),
            };
          }),
        },
        roles: {
          everyone: { id: 'role-everyone' },
          cache: new Map(),
        },
      } as any;

      const user = { id: 'user-concurrent-double-click', username: 'fastclicker' };

      const interaction1 = {
        values: ['purchase_model'],
        guild: mockGuild,
        user,
        client: { user: { id: 'bot-id' } },
        deferReply: vi.fn().mockResolvedValue({}),
        editReply: vi.fn().mockResolvedValue({}),
        message: { edit: vi.fn().mockResolvedValue({}) },
      } as any;

      const interaction2 = {
        values: ['purchase_model'],
        guild: mockGuild,
        user,
        client: { user: { id: 'bot-id' } },
        deferReply: vi.fn().mockResolvedValue({}),
        editReply: vi.fn().mockResolvedValue({}),
        message: { edit: vi.fn().mockResolvedValue({}) },
      } as any;

      const handler = new TicketHandler(ticketService, undefined, [testAdminId]);

      // Fire both nearly concurrently
      const call1 = handler.handleCategorySelect(interaction1);
      const call2 = handler.handleCategorySelect(interaction2);

      // Allow first creation to finish
      resolveChannelCreation();
      await Promise.all([call1, call2]);

      // Exactly ONE channel created
      expect(mockGuild.channels.create).toHaveBeenCalledTimes(1);

      // Interaction 2 was intercepted by the in-flight lock
      expect(interaction2.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('กำลังดำเนินการเปิด Ticket ของท่าน'),
        })
      );
    });
  });

  describe('6. Task 2: Auto-delete Closed Tickets After 1 Hour & Immunities', () => {
    it('schedules autoDeleteAt = closedAt + 1 hour upon closure', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-sched-1',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      const beforeClose = Date.now();
      const closed = await ticketService.closeTicket(ticket.id, testStaffId);
      const afterClose = Date.now();

      expect(closed.status).toBe(TICKET_STATUS.CLOSED);
      expect(closed.closedAt).toBeDefined();
      expect(closed.autoDeleteAt).toBeDefined();

      const autoDeleteMs = new Date(closed.autoDeleteAt!).getTime();
      const closedMs = new Date(closed.closedAt!).getTime();
      const diff = autoDeleteMs - closedMs;

      // Exactly 1 hour = 3600000 ms
      expect(diff).toBe(60 * 60 * 1000);
      expect(autoDeleteMs).toBeGreaterThanOrEqual(beforeClose + 3600000);
      expect(autoDeleteMs).toBeLessThanOrEqual(afterClose + 3600000);
    });

    it('cancels scheduled autoDeleteAt when a closed ticket is reopened', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-reopen-sched',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.GENERAL_INQUIRY,
      });

      await ticketService.closeTicket(ticket.id, testStaffId);
      const reopened = await ticketService.reopenTicket(ticket.id);

      expect(reopened.status).toBe(TICKET_STATUS.OPEN);
      expect(reopened.autoDeleteAt).toBeNull();
      expect(reopened.closedAt).toBeNull();
    });

    it('guarantees active ticket immunity: OPEN and CLAIMED tickets are never eligible', async () => {
      const openTicket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-open-immunity',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      // Even 100 days into the future, open tickets are NOT eligible
      const farFuture = new Date(Date.now() + 100 * 24 * 3600 * 1000);
      const openCheck = await ticketService.isTicketEligibleForAutoDeletion(openTicket.id, farFuture);
      expect(openCheck.eligible).toBe(false);
      expect(openCheck.reason).toContain('active tickets have deletion immunity');

      // Claimed tickets also immune
      const claimedTicket = await ticketService.claimTicket(openTicket.id, testStaffId);
      const claimedCheck = await ticketService.isTicketEligibleForAutoDeletion(claimedTicket.id, farFuture);
      expect(claimedCheck.eligible).toBe(false);
      expect(claimedCheck.reason).toContain('active tickets have deletion immunity');
    });

    it('guarantees pending payment review immunity: tickets with pending payments are never scheduled or deleted', async () => {
      const customer = await prisma.customer.upsert({
        where: { discordUserId: 'cust-immunity-test' },
        create: {
          username: 'ImmunityCustomer',
          discordUserId: 'cust-immunity-test',
        },
        update: {},
      });

      const pkg = await prisma.package.findFirst();

      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-payment-immunity',
        discordGuildId: testGuildId,
        ownerDiscordId: customer.discordUserId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
        customerId: customer.id,
      });

      const payment = await prisma.payment.create({
        data: {
          customerId: customer.id,
          ticketChannelId: ticket.discordChannelId,
          packageId: pkg!.id,
          expectedAmountThb: 51,
          paymentStatus: PAYMENT_STATUS.UNDER_REVIEW,
          calculationSnapshot: '{}',
        },
      });

      // Closing ticket with pending payment must NOT schedule autoDeleteAt
      const closed = await ticketService.closeTicket(ticket.id, testStaffId);
      expect(closed.autoDeleteAt).toBeNull();

      // Even if autoDeleteAt is artificially set in past, eligibility check must reject deletion
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { autoDeleteAt: new Date(Date.now() - 3600000) },
      });

      const check = await ticketService.isTicketEligibleForAutoDeletion(ticket.id);
      expect(check.eligible).toBe(false);
      expect(check.reason).toContain('pending payment review');

      // processAutoDeletion must refuse to delete
      const result = await ticketService.processAutoDeletion(ticket.id);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('pending payment review');

      // Clean up test payment
      await prisma.payment.delete({ where: { id: payment.id } });
    });
  });

  describe('7. Task 3: Safe Deletion, Scheduler & Failure-Tolerant Retry', () => {
    it('executes successful auto-deletion: deletes channel, updates DB status to DELETED, and logs event', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-delete-success-1',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });

      await ticketService.closeTicket(ticket.id, testStaffId);
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { autoDeleteAt: new Date(Date.now() - 3600000) },
      });

      const channelDeleteMock = vi.fn().mockResolvedValue({});
      const mockChannel = {
        id: ticket.discordChannelId,
        delete: channelDeleteMock,
      };

      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue(mockChannel),
        },
      };

      const logEventMock = vi.fn().mockResolvedValue({});
      const mockLogger = { logEvent: logEventMock };

      const result = await ticketService.processAutoDeletion(ticket.id, mockClient, mockLogger);

      expect(result.success).toBe(true);
      expect(channelDeleteMock).toHaveBeenCalledWith('Auto-deleted after 1 hour of closure');

      const inDb = await ticketService.getTicketById(ticket.id);
      expect(inDb?.status).toBe(TICKET_STATUS.DELETED);
      expect(inDb?.deletedByDiscordId).toBe('SYSTEM_AUTO_CLEANUP');
      expect(inDb?.deletedAt).toBeDefined();

      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'TICKET_AUTO_DELETED',
          ticketId: ticket.id,
          channelId: ticket.discordChannelId,
          status: TICKET_STATUS.DELETED,
        })
      );
    });

    it('recovers and processes expired closed tickets after bot restart via processAllExpiredTickets', async () => {
      const t1 = await ticketService.createTicketRecord({
        discordChannelId: 'channel-restart-1',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });
      const t2 = await ticketService.createTicketRecord({
        discordChannelId: 'channel-restart-2',
        discordGuildId: testGuildId,
        ownerDiscordId: 'another-user-restart',
        category: TICKET_CATEGORY.GENERAL_INQUIRY,
      });

      await ticketService.closeTicket(t1.id, testStaffId);
      await ticketService.closeTicket(t2.id, testStaffId);

      const past = new Date(Date.now() - 7200000);
      await prisma.ticket.update({ where: { id: t1.id }, data: { autoDeleteAt: past } });
      await prisma.ticket.update({ where: { id: t2.id }, data: { autoDeleteAt: past } });

      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue({ delete: vi.fn().mockResolvedValue({}) }),
        },
      };

      const cleanedCount = await ticketService.processAllExpiredTickets(mockClient);
      expect(cleanedCount).toBeGreaterThanOrEqual(2);

      const check1 = await ticketService.getTicketById(t1.id);
      const check2 = await ticketService.getTicketById(t2.id);
      expect(check1?.status).toBe(TICKET_STATUS.DELETED);
      expect(check2?.status).toBe(TICKET_STATUS.DELETED);
    });

    it('prevents duplicate deletion executions with concurrency lock', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-dup-delete-lock',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });
      await ticketService.closeTicket(ticket.id, testStaffId);
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { autoDeleteAt: new Date(Date.now() - 3600000) },
      });

      let resolveSlowDelete: any;
      const slowDeletePromise = new Promise((res) => {
        resolveSlowDelete = res;
      });

      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            delete: vi.fn().mockImplementation(async () => {
              await slowDeletePromise;
            }),
          }),
        },
      };

      const call1 = ticketService.processAutoDeletion(ticket.id, mockClient);
      const call2 = ticketService.processAutoDeletion(ticket.id, mockClient);

      const result2 = await call2;
      expect(result2.success).toBe(false);
      expect(result2.reason).toContain('already in progress');

      resolveSlowDelete();
      const result1 = await call1;
      expect(result1.success).toBe(true);
    });

    it('tolerates Discord API failures: reschedules retry and does NOT falsely mark DELETED', async () => {
      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-delete-failure-retry',
        discordGuildId: testGuildId,
        ownerDiscordId: testOwnerId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
      });
      await ticketService.closeTicket(ticket.id, testStaffId);
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { autoDeleteAt: new Date(Date.now() - 3600000) },
      });

      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            delete: vi.fn().mockRejectedValue(new Error('DiscordAPIError[50001]: Missing Permissions')),
          }),
        },
      };

      const result = await ticketService.processAutoDeletion(ticket.id, mockClient);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('Discord channel deletion failed');

      // State is preserved!
      const ticketInDb = await ticketService.getTicketById(ticket.id);
      expect(ticketInDb?.status).toBe(TICKET_STATUS.CLOSED);
      expect(ticketInDb?.deletedAt).toBeNull();

      // autoDeleteAt rescheduled ~5 minutes into the future
      const futureMs = new Date(ticketInDb!.autoDeleteAt!).getTime();
      expect(futureMs).toBeGreaterThan(Date.now());
    });
  });

  describe('8. Task 4: Payment Slip Decoupling & Admin Notification Retry', () => {
    it('confirms slip receipt to customer even when admin review channel notification fails (Missing Access 50001)', async () => {
      const customer = await prisma.customer.upsert({
        where: { discordUserId: 'cust-slip-decouple' },
        create: {
          username: 'SlipDecoupleCustomer',
          discordUserId: 'cust-slip-decouple',
        },
        update: {},
      });

      const pkg = await prisma.package.findFirst();

      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-slip-decouple',
        discordGuildId: testGuildId,
        ownerDiscordId: customer.discordUserId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
        customerId: customer.id,
      });

      const payment = await prisma.payment.create({
        data: {
          customerId: customer.id,
          ticketChannelId: ticket.discordChannelId,
          packageId: pkg!.id,
          expectedAmountThb: 51,
          paymentStatus: PAYMENT_STATUS.PENDING_PAYMENT,
          calculationSnapshot: '{}',
        },
      });

      const replyMock = vi.fn().mockResolvedValue({});
      const mockMessage = {
        author: { bot: false },
        channel: { id: ticket.discordChannelId },
        guild: { id: testGuildId },
        attachments: {
          size: 1,
          first: () => ({
            url: 'http://127.0.0.1:54321/mock-slip.png',
            name: 'receipt.png',
            contentType: 'image/png',
          }),
        },
        reply: replyMock,
      } as any;

      const originalFetch = globalThis.fetch;
      const fakeImageBytes = Buffer.from('FAKE_PNG_BINARY_DATA_TEST_SLIP_123');
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        if (typeof url === 'string' && url.includes('mock-slip.png')) {
          return new Response(fakeImageBytes, {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        return originalFetch(url);
      });

      const adminReviewChannelId = '1566804089658937414';
      const slipHandler = new SlipHandler(undefined as any, adminReviewChannelId);

      mockMessage.client = {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            send: vi.fn().mockRejectedValue(new Error('DiscordAPIError[50001]: Missing Access')),
          }),
        },
      };

      await slipHandler.handleMessage(mockMessage);

      // Customer receives underReviewEmbed
      expect(replyMock).toHaveBeenCalledTimes(1);
      const replyArg = replyMock.mock.calls[0][0];
      expect(replyArg.embeds).toBeDefined();
      expect(replyArg.embeds[0].data.title).toContain('ได้รับสลิปการโอนเงินแล้ว');

      // Crucial: Customer must NOT receive error message
      expect(replyArg.content).toBeUndefined();

      // Payment updated to UNDER_REVIEW in DB
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id },
        include: { slips: true },
      });
      expect(updatedPayment?.paymentStatus).toBe(PAYMENT_STATUS.UNDER_REVIEW);
      expect(updatedPayment?.slips.length).toBe(1);

      // Clean up
      await prisma.paymentSlip.deleteMany({ where: { paymentId: payment.id } });
      await prisma.payment.delete({ where: { id: payment.id } });
    });

    it('retries admin notification without duplicating payment_slips records', async () => {
      const customer = await prisma.customer.upsert({
        where: { discordUserId: 'cust-slip-retry' },
        create: {
          username: 'SlipRetryCustomer',
          discordUserId: 'cust-slip-retry',
        },
        update: {},
      });

      const pkg = await prisma.package.findFirst();

      const ticket = await ticketService.createTicketRecord({
        discordChannelId: 'channel-slip-retry',
        discordGuildId: testGuildId,
        ownerDiscordId: customer.discordUserId,
        category: TICKET_CATEGORY.PURCHASE_MODEL,
        customerId: customer.id,
      });

      const payment = await prisma.payment.create({
        data: {
          customerId: customer.id,
          ticketChannelId: ticket.discordChannelId,
          packageId: pkg!.id,
          expectedAmountThb: 51,
          paymentStatus: PAYMENT_STATUS.UNDER_REVIEW,
          calculationSnapshot: '{}',
        },
      });

      await prisma.paymentSlip.create({
        data: {
          paymentId: payment.id,
          privateFileReference: 'mock-file-ref-123.png',
          fileHash: 'sha256-test-hash-retry-123',
          fileSizeBytes: 1024,
          mimeType: 'image/png',
        },
      });

      const adminReviewChannelId = '1566804089658937414';
      const slipHandler = new SlipHandler(undefined as any, adminReviewChannelId);

      const sendMock = vi.fn().mockResolvedValue({});
      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            send: sendMock,
          }),
        },
      };

      const success = await slipHandler.resendAdminReviewNotification(payment.id, mockClient);

      expect(success).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = sendMock.mock.calls[0][0];
      expect(call.content).toContain('มีรายการชำระเงินรอการตรวจสอบ');
      expect(call.components).toBeDefined();

      // Slip count remains exactly 1 — NO DUPLICATES!
      const slipsCount = await prisma.paymentSlip.count({
        where: { paymentId: payment.id },
      });
      expect(slipsCount).toBe(1);

      // Clean up
      await prisma.paymentSlip.deleteMany({ where: { paymentId: payment.id } });
      await prisma.payment.delete({ where: { id: payment.id } });
    });
  });

  describe('9. Task 5: Ticket Logger TICKET_AUTO_DELETED Event', () => {
    it('dispatches TICKET_AUTO_DELETED event with reason and deletedAt fields', async () => {
      const sendMock = vi.fn().mockResolvedValue({});
      const mockChannel = { send: sendMock };
      const mockClient = {
        channels: {
          fetch: vi.fn().mockResolvedValue(Object.assign(Object.create(TextChannel.prototype), mockChannel)),
        },
      } as any;

      const logger = new TicketLoggerService(mockClient, '1566804177848369286');
      const now = new Date();

      await logger.logEvent({
        eventType: 'TICKET_AUTO_DELETED',
        ticketId: 'ticket-auto-del-123',
        channelId: 'channel-auto-del-456',
        category: 'PURCHASE_MODEL',
        ownerDiscordId: testOwnerId,
        status: 'DELETED',
        reason: 'Auto-deleted after 1 hour of closure',
        deletedAt: now,
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const embed = sendMock.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toContain('TICKET AUTO DELETED');
      expect(embed.data.color).toBe(0xe67e22); // Orange

      const fields = embed.data.fields;
      const reasonField = fields.find((f: any) => f.name === 'Reason');
      expect(reasonField?.value).toBe('Auto-deleted after 1 hour of closure');

      const deletedAtField = fields.find((f: any) => f.name === 'Deleted At');
      expect(deletedAtField?.value).toBe(now.toISOString());
    });
  });
});
