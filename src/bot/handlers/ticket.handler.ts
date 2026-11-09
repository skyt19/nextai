import {
  AttachmentBuilder,
  ButtonInteraction,
  ChannelType,
  Guild,
  GuildMember,
  OverwriteResolvable,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
  TextChannel,
} from 'discord.js';
import { TicketService } from '../services/ticket.service.js';
import { TicketLoggerService } from '../services/ticket-logger.service.js';
import { TicketPanelUI } from '../ui/ticket-panel.js';
import { BotComponents } from '../ui/components.js';
import { BotEmbeds } from '../ui/embeds.js';
import { getPrismaClient } from '../../db/client.js';
import { TICKET_CATEGORY, TICKET_STATUS, TicketCategory, MODEL_GROUPS } from '../../config/constants.js';
import { PaymentService } from '../../services/payment.service.js';
import { PromptPayService } from '../../services/promptpay.service.js';
import { Decimal } from 'decimal.js';

export interface TicketPermissionOptions {
  guild: Guild;
  customerDiscordId: string;
  adminDiscordIds: string[];
  supportRoleId?: string;
  botUserId: string;
}

export class TicketHandler {
  // In-flight concurrency lock to prevent duplicate ticket creation from rapid/repeated interactions
  private readonly creationLocks = new Set<string>();

  constructor(
    private readonly ticketService: TicketService = new TicketService(),
    private readonly ticketLogger?: TicketLoggerService,
    private readonly adminDiscordIds: string[] = [],
    private readonly supportRoleId?: string,
    private readonly categoryId?: string
  ) {}

  /**
   * Builds strict permission overwrites for a private ticket channel.
   */
  public static buildPermissionOverwrites(options: TicketPermissionOptions): OverwriteResolvable[] {
    const overwrites: OverwriteResolvable[] = [
      // 1. Deny @everyone
      {
        id: options.guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      // 2. Allow Ticket Owner (Customer)
      {
        id: options.customerDiscordId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      // 3. Allow Bot Client
      {
        id: options.botUserId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];

    // 4. Allow configured Administrator Discord IDs
    for (const adminId of options.adminDiscordIds) {
      if (adminId && adminId.trim() !== '') {
        overwrites.push({
          id: adminId.trim(),
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ManageChannels,
          ],
        });
      }
    }

    // 5. Allow Support Role if configured
    if (options.supportRoleId && options.guild.roles.cache.has(options.supportRoleId)) {
      overwrites.push({
        id: options.supportRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }

    return overwrites;
  }

  /**
   * Generates a unique, sanitized channel name complying with Discord rules.
   */
  public static generateChannelName(prefix: string, username: string, guild: Guild): string {
    const sanitizedUsername =
      username
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 15) || 'user';

    const baseName = `${prefix}-${sanitizedUsername}`;

    // Ensure uniqueness within the guild
    let channelName = baseName;
    let counter = 1;
    while (guild.channels.cache.some((c) => c.name === channelName)) {
      channelName = `${baseName}-${counter}`;
      counter++;
    }

    return channelName;
  }

  /**
   * Server-side check if a member is support staff or an administrator.
   */
  public isStaffOrAdmin(member: GuildMember | null): boolean {
    if (!member) return false;
    if (this.adminDiscordIds.includes(member.id)) return true;
    if (this.supportRoleId && member.roles.cache.has(this.supportRoleId)) return true;
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  /**
   * Handles ticket creation when a category is selected in the Support Center menu.
   */
  public async handleCategorySelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const selectedValue = interaction.values[0];
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({
        content: '⛔ สามารถเปิด Ticket ได้เฉพาะภายใน Discord Server เท่านั้น',
        ephemeral: true,
      });
      return;
    }

    let category: TicketCategory;
    let prefix: string;

    if (selectedValue === 'purchase_model') {
      category = TICKET_CATEGORY.PURCHASE_MODEL;
      prefix = 'purchase';
    } else if (selectedValue === 'general_inquiry') {
      category = TICKET_CATEGORY.GENERAL_INQUIRY;
      prefix = 'inquiry';
    } else {
      await interaction.reply({ content: 'ประเภทบริการไม่ถูกต้อง', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const customer = interaction.user;
    const lockKey = `${customer.id}:${category}`;

    // Prevent duplicate ticket creation from concurrent or repeated interactions
    if (this.creationLocks.has(lockKey)) {
      await interaction.editReply({
        content: '⏳ กำลังดำเนินการเปิด Ticket ของท่าน กรุณารอสักครู่...',
      });
      return;
    }

    this.creationLocks.add(lockKey);

    try {
      // 1. Check active ticket policy (at most 1 active ticket per category)
      const existing = await this.ticketService.findActiveTicketByUser(customer.id, category);
      if (existing) {
        const catThai = category === TICKET_CATEGORY.PURCHASE_MODEL ? 'ซื้อแพ็กเกจโมเดล' : 'สอบถามข้อมูล';
        await interaction.editReply({
          content: `⚠️ ท่านมี Ticket ประเภท **${catThai}** ที่เปิดอยู่แล้วที่ห้อง <#${existing.discordChannelId}>`,
        });
        return;
      }

      // 2. Generate unique channel name
      const channelName = TicketHandler.generateChannelName(prefix, customer.username, guild);

      // 3. Configure permissions
      const overwrites = TicketHandler.buildPermissionOverwrites({
        guild,
        customerDiscordId: customer.id,
        adminDiscordIds: this.adminDiscordIds,
        supportRoleId: this.supportRoleId,
        botUserId: interaction.client.user.id,
      });

      // 4. Create Discord private text channel
      let parentId: string | undefined = undefined;
      if (this.categoryId && guild.channels.cache.has(this.categoryId)) {
        parentId = this.categoryId;
      }

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        topic: `SealAPI Ticket [${category}] สำหรับคุณ ${customer.username} (${customer.id})`,
      });

      // 5. Look up existing Customer ID if registered
      const prisma = getPrismaClient();
      const customerRecord = await prisma.customer.findUnique({
        where: { discordUserId: customer.id },
      });

      // 6. Save Ticket Record in Database
      const ticketRecord = await this.ticketService.createTicketRecord({
        discordChannelId: ticketChannel.id,
        discordGuildId: guild.id,
        ownerDiscordId: customer.id,
        category,
        customerId: customerRecord?.id || null,
      });

      // 7. Send Welcome Message inside the ticket channel
      const isPurchase = category === TICKET_CATEGORY.PURCHASE_MODEL;
      const welcomeEmbed = isPurchase
        ? TicketPanelUI.purchaseWelcomeEmbed(customer.username)
        : TicketPanelUI.inquiryWelcomeEmbed(customer.username);

      const components: any[] = [];
      if (isPurchase) {
        // Stage 1: Group Selection Menu
        components.push(BotComponents.modelGroupSelectMenu());
      }

      // Add management controls (Close, Claim, Delete)
      components.push(TicketPanelUI.ticketControls(ticketRecord.id));

      await ticketChannel.send({
        content: `<@${customer.id}> ยินดีต้อนรับสู่ห้องบริการของคุณ`,
        embeds: [welcomeEmbed],
        components,
      });

      // 8. Log Event to Log Channel
      if (this.ticketLogger) {
        await this.ticketLogger.logEvent({
          eventType: 'TICKET_CREATED',
          ticketId: ticketRecord.id,
          channelId: ticketChannel.id,
          category,
          ownerDiscordId: customer.id,
          status: TICKET_STATUS.OPEN,
          details: `ห้อง #${ticketChannel.name} ถูกสร้างขึ้นเรียบร้อยแล้ว`,
        });
      }

      // 9. Respond to customer
      await interaction.editReply({
        content: `🎫 เปิด Ticket เรียบร้อยแล้ว กรุณาไปที่ห้อง: <#${ticketChannel.id}>`,
      });

      // 10. Reset original select menu to default placeholder: "เลือกประเภทบริการที่ต้องการ..."
      if (interaction.message && typeof interaction.message.edit === 'function') {
        try {
          await interaction.message.edit({
            components: [TicketPanelUI.categorySelectMenu()],
          });
        } catch (resetErr: any) {
          console.warn('[TicketHandler] Failed to reset category select menu:', resetErr?.message || resetErr);
        }
      }
    } catch (err: any) {
      console.error('[TicketHandler] Error creating ticket channel:', err);
      if (this.ticketLogger) {
        await this.ticketLogger.logEvent({
          eventType: 'TICKET_CREATION_FAILED',
          category,
          ownerDiscordId: customer.id,
          details: `Error: ${err.message}`,
        });
      }
      await interaction.editReply({
        content: `❌ ไม่สามารถสร้างห้อง Ticket ได้: ${err.message}`,
      });
    } finally {
      this.creationLocks.delete(lockKey);
    }
  }

  /**
   * Stage 1 -> Stage 2: Customer selects Model Group.
   */
  public async handlePurchaseGroupSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferReply();
    const selectedGroup = interaction.values[0];

    const groupNames: Record<string, string> = {
      [MODEL_GROUPS.GROUP_CLAUDE_LM]: 'SxCGL — Claude LLM Hub Group',
      [MODEL_GROUPS.GROUP_CLAUDE]: 'SxGC — Claude Group',
      [MODEL_GROUPS.GROUP_A]: 'SxG1 — Gemini Group A',
      [MODEL_GROUPS.GROUP_E]: 'SxGE — Gemini Group E',
    };

    const groupDisplayName = groupNames[selectedGroup] || selectedGroup;
    const embed = TicketPanelUI.quantitySelectEmbed(groupDisplayName);
    const menu = BotComponents.referenceRequestsSelectMenu(selectedGroup);

    await interaction.editReply({
      embeds: [embed],
      components: [menu],
    });
  }

  /**
   * Stage 2 -> Stage 3: Customer selects Reference Request Quantity.
   * Calculates final payment amount via backend calculator and presents PromptPay QR.
   */
  public async handlePurchaseQuantitySelect(
    interaction: StringSelectMenuInteraction,
    paymentService: PaymentService,
    promptPayId: string
  ): Promise<void> {
    await interaction.deferReply();

    const customId = interaction.customId; // e.g. purchase_select_requests_NxG1
    const groupId = customId.replace('purchase_select_requests_', '');
    const referenceRequests = parseInt(interaction.values[0], 10);

    const groupNames: Record<string, string> = {
      [MODEL_GROUPS.GROUP_CLAUDE_LM]: 'SxCGL — Claude LLM Hub Group',
      [MODEL_GROUPS.GROUP_CLAUDE]: 'SxGC — Claude Group',
      [MODEL_GROUPS.GROUP_A]: 'SxG1 — Gemini Group A',
      [MODEL_GROUPS.GROUP_E]: 'SxGE — Gemini Group E',
    };
    const groupDisplayName = groupNames[groupId] || groupId;

    // 1. Find or create matching package in database
    const pkg = await paymentService.findOrCreatePackageForGroup(groupId, referenceRequests);

    // 2. Initialize pending payment (fetches Frankfurter exchange rate & calculates THB using Decimal.js)
    const { payment, calculation } = await paymentService.createPendingPayment({
      discordUserId: interaction.user.id,
      username: interaction.user.username,
      ticketChannelId: interaction.channelId,
      packageId: pkg.id,
    });

    // Sourced strictly from persisted payment.expectedAmountThb in the database
    const finalAmountThb = new Decimal(payment.expectedAmountThb.toString()).toFixed(2);

    // 3. Generate EMVCo PromptPay QR Code
    let files: AttachmentBuilder[] = [];
    let hasQrAttachment = false;

    try {
      const qrResult = await PromptPayService.generatePromptPayQr({
        recipient: promptPayId,
        amount: finalAmountThb,
      });

      files.push(new AttachmentBuilder(qrResult.qrBuffer, { name: 'promptpay-qr.png' }));
      hasQrAttachment = true;
    } catch (err: any) {
      console.warn('[TicketHandler] PromptPay QR generation fallback:', err.message);
    }

    // 4. Render Stage 3 Payment Instructions embed (never exposes internal costs or Bearlab)
    const paymentEmbed = BotEmbeds.paymentInstructions({
      groupDisplayName,
      referenceRequests,
      paymentId: payment.id,
      finalAmountThb,
      promptPayId,
      hasQrAttachment,
    });

    await interaction.editReply({
      embeds: [paymentEmbed],
      files,
    });
  }

  /**
   * Handles Button interactions for ticket lifecycle management.
   */
  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    const member = interaction.member as GuildMember | null;

    // A. Close Request (Show confirmation)
    if (customId.startsWith('ticket_ctrl_close_')) {
      const ticketId = customId.replace('ticket_ctrl_close_', '');
      const ticket = await this.ticketService.getTicketById(ticketId);

      if (!ticket) {
        await interaction.reply({ content: 'ไม่พบข้อมูล Ticket', ephemeral: true });
        return;
      }

      // Validate owner or staff/admin
      const isOwner = ticket.ownerDiscordId === interaction.user.id;
      const isStaff = this.isStaffOrAdmin(member);

      if (!isOwner && !isStaff) {
        await interaction.reply({
          content: '⛔ เฉพาะเจ้าของ Ticket หรือเจ้าหน้าที่ฝ่ายบริการเท่านั้นที่สามารถปิด Ticket ได้',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: '⚠️ ท่านแน่ใจหรือไม่ว่าต้องการปิด Ticket นี้?',
        components: [TicketPanelUI.closeConfirmationButtons(ticketId)],
        ephemeral: true,
      });
    }

    // A. Confirm Close
    else if (customId.startsWith('ticket_confirm_close_')) {
      const ticketId = customId.replace('ticket_confirm_close_', '');
      const ticket = await this.ticketService.getTicketById(ticketId);

      if (!ticket) {
        await interaction.reply({ content: 'ไม่พบข้อมูล Ticket', ephemeral: true });
        return;
      }

      const isOwner = ticket.ownerDiscordId === interaction.user.id;
      const isStaff = this.isStaffOrAdmin(member);

      if (!isOwner && !isStaff) {
        await interaction.reply({ content: '⛔ ไม่มีสิทธิ์ในการปิด Ticket', ephemeral: true });
        return;
      }

      await interaction.deferUpdate();

      // Update DB to CLOSED
      await this.ticketService.closeTicket(ticketId, interaction.user.id);

      // Lock channel: Remove SendMessages from customer
      const channel = interaction.channel as TextChannel | null;
      if (channel) {
        try {
          await channel.permissionOverwrites.edit(ticket.ownerDiscordId, {
            SendMessages: false,
          });
        } catch (e: any) {
          console.warn('[TicketHandler] Failed to adjust channel permissions on close:', e.message);
        }

        await channel.send({
          content: `🔒 **Ticket ถูกปิดเรียบร้อยแล้วโดย <@${interaction.user.id}>**\nประวัติการสนทนายังคงถูกบันทึกไว้อย่างปลอดภัย`,
          components: [TicketPanelUI.closedTicketControls(ticketId)],
        });
      }

      // Log event
      if (this.ticketLogger) {
        await this.ticketLogger.logEvent({
          eventType: 'TICKET_CLOSED',
          ticketId,
          channelId: ticket.discordChannelId,
          category: ticket.category,
          ownerDiscordId: ticket.ownerDiscordId,
          staffDiscordId: interaction.user.id,
          status: TICKET_STATUS.CLOSED,
        });
      }
    }

    // A. Cancel Close
    else if (customId.startsWith('ticket_cancel_close_')) {
      await interaction.update({
        content: 'ยกเลิกการปิด Ticket เรียบร้อยแล้ว',
        components: [],
      });
    }

    // B. Reopen Ticket
    else if (customId.startsWith('ticket_ctrl_reopen_')) {
      const ticketId = customId.replace('ticket_ctrl_reopen_', '');
      const ticket = await this.ticketService.getTicketById(ticketId);

      if (!ticket) {
        await interaction.reply({ content: 'ไม่พบข้อมูล Ticket', ephemeral: true });
        return;
      }

      // Reopening is restricted to staff or administrators
      if (!this.isStaffOrAdmin(member)) {
        await interaction.reply({
          content: '⛔ เฉพาะเจ้าหน้าที่หรือผู้ดูแลระบบเท่านั้นที่สามารถเปิด Ticket อีกครั้งได้',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      // Update DB
      await this.ticketService.reopenTicket(ticketId);

      // Restore SendMessages permission to owner
      const channel = interaction.channel as TextChannel | null;
      if (channel) {
        try {
          await channel.permissionOverwrites.edit(ticket.ownerDiscordId, {
            SendMessages: true,
          });
        } catch (e: any) {
          console.warn('[TicketHandler] Failed to restore permissions on reopen:', e.message);
        }

        await channel.send({
          content: `🔓 **Ticket ถูกเปิดอีกครั้งโดย <@${interaction.user.id}>**`,
          components: [TicketPanelUI.ticketControls(ticketId, ticket.status === TICKET_STATUS.CLAIMED)],
        });
      }

      await interaction.deleteReply();

      // Log event
      if (this.ticketLogger) {
        await this.ticketLogger.logEvent({
          eventType: 'TICKET_REOPENED',
          ticketId,
          channelId: ticket.discordChannelId,
          category: ticket.category,
          ownerDiscordId: ticket.ownerDiscordId,
          staffDiscordId: interaction.user.id,
          status: TICKET_STATUS.OPEN,
        });
      }
    }

    // C. Delete Request (Show confirmation)
    else if (customId.startsWith('ticket_ctrl_delete_')) {
      const ticketId = customId.replace('ticket_ctrl_delete_', '');

      if (!this.isStaffOrAdmin(member)) {
        await interaction.reply({
          content: '⛔ เฉพาะเจ้าหน้าที่และผู้ดูแลระบบเท่านั้นที่สามารถลบห้อง Ticket ได้',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: '⚠️ **แจ้งเตือน:** ท่านแน่ใจหรือไม่ว่าต้องการลบห้อง Ticket นี้อย่างถาวร?',
        components: [TicketPanelUI.deleteConfirmationButtons(ticketId)],
        ephemeral: true,
      });
    }

    // C. Confirm Delete
    else if (customId.startsWith('ticket_confirm_delete_')) {
      const ticketId = customId.replace('ticket_confirm_delete_', '');

      if (!this.isStaffOrAdmin(member)) {
        await interaction.reply({ content: '⛔ ไม่มีสิทธิ์ในการลบ Ticket', ephemeral: true });
        return;
      }

      const ticket = await this.ticketService.getTicketById(ticketId);
      if (!ticket) {
        await interaction.reply({ content: 'ไม่พบข้อมูล Ticket', ephemeral: true });
        return;
      }

      await interaction.update({
        content: '🗑️ กำลังลบห้อง Ticket...',
        components: [],
      });

      // 1. Update DB to DELETED (Record is permanently preserved!)
      await this.ticketService.deleteTicket(ticketId, interaction.user.id);

      // 2. Log deletion before deleting channel
      if (this.ticketLogger) {
        await this.ticketLogger.logEvent({
          eventType: 'TICKET_DELETED',
          ticketId,
          channelId: ticket.discordChannelId,
          category: ticket.category,
          ownerDiscordId: ticket.ownerDiscordId,
          staffDiscordId: interaction.user.id,
          status: TICKET_STATUS.DELETED,
          details: 'ห้อง Ticket ถูกลบแล้ว (บันทึกข้อมูลในฐานข้อมูลยังคงถูกเก็บรักษาไว้อย่างถาวร)',
        });
      }

      // 3. Delete Discord channel
      const channel = interaction.channel as TextChannel | null;
      if (channel) {
        setTimeout(async () => {
          await channel.delete().catch(() => {});
        }, 1500);
      }
    }

    // C. Cancel Delete
    else if (customId.startsWith('ticket_cancel_delete_')) {
      await interaction.update({
        content: 'ยกเลิกการลบห้อง Ticket เรียบร้อยแล้ว',
        components: [],
      });
    }

    // D. Claim Ticket
    else if (customId.startsWith('ticket_ctrl_claim_')) {
      const ticketId = customId.replace('ticket_ctrl_claim_', '');

      if (!this.isStaffOrAdmin(member)) {
        await interaction.reply({
          content: '⛔ เฉพาะเจ้าหน้าที่ฝ่ายบริการเท่านั้นที่สามารถรับเรื่อง Ticket ได้',
          ephemeral: true,
        });
        return;
      }

      try {
        const claimed = await this.ticketService.claimTicket(ticketId, interaction.user.id);

        await interaction.reply({
          content: `🙋 **Ticket ได้รับการรับเรื่องดูแลโดย <@${interaction.user.id}> แล้ว**`,
        });

        if (this.ticketLogger) {
          await this.ticketLogger.logEvent({
            eventType: 'TICKET_CLAIMED',
            ticketId,
            channelId: claimed.discordChannelId,
            category: claimed.category,
            ownerDiscordId: claimed.ownerDiscordId,
            staffDiscordId: interaction.user.id,
            status: TICKET_STATUS.CLAIMED,
          });
        }
      } catch (err: any) {
        await interaction.reply({ content: `⚠️ ${err.message}`, ephemeral: true });
      }
    }
  }
}
