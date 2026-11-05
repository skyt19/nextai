import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  Interaction,
  Message,
  REST,
  Routes,
  TextChannel,
} from 'discord.js';
import { CustomerService } from '../services/customer.service.js';
import { PaymentService } from '../services/payment.service.js';
import { ModelCatalogService } from '../services/catalog.service.js';
import { FrankfurterService } from '../services/frankfurter.service.js';
import { PromptPayService } from '../services/promptpay.service.js';
import { TicketService } from './services/ticket.service.js';
import { TicketLoggerService } from './services/ticket-logger.service.js';
import { TicketHandler } from './handlers/ticket.handler.js';
import { SlipHandler } from './handlers/slip.handler.js';
import { ReviewHandler } from './handlers/review.handler.js';
import { BotEmbeds } from './ui/embeds.js';
import { TicketPanelUI } from './ui/ticket-panel.js';
import { customerSlashCommands, adminSlashCommands } from './commands/definitions.js';
import { KEY_STATUS } from '../config/constants.js';

export interface DiscordBotConfig {
  token?: string;
  clientId?: string;
  guildId?: string;
  ticketCategoryId?: string;
  ticketPanelChannelId?: string;
  ticketLogChannelId?: string;
  supportRoleId?: string;
  adminReviewChannelId?: string;
  adminUserIds: string[];
  gatewayUrl: string;
  promptPayId?: string;
}

export class NextAiDiscordBot {
  public readonly client: Client;
  private readonly config: DiscordBotConfig;

  public readonly customerService: CustomerService;
  public readonly paymentService: PaymentService;
  public readonly catalogService: ModelCatalogService;
  public readonly frankfurterService: FrankfurterService;
  public readonly ticketService: TicketService;
  public readonly ticketLogger: TicketLoggerService;

  public readonly ticketHandler: TicketHandler;
  public readonly slipHandler: SlipHandler;
  public readonly reviewHandler: ReviewHandler;

  private autoDeleteTimer?: NodeJS.Timeout;

  constructor(config: DiscordBotConfig) {
    this.config = config;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.customerService = new CustomerService();
    this.frankfurterService = new FrankfurterService();
    this.paymentService = new PaymentService(this.customerService, this.frankfurterService);
    this.catalogService = new ModelCatalogService();
    this.ticketService = new TicketService();
    this.ticketLogger = new TicketLoggerService(this.client, config.ticketLogChannelId || '');

    this.ticketHandler = new TicketHandler(
      this.ticketService,
      this.ticketLogger,
      config.adminUserIds,
      config.supportRoleId,
      config.ticketCategoryId
    );

    this.slipHandler = new SlipHandler(this.paymentService, config.adminReviewChannelId);
    this.reviewHandler = new ReviewHandler(this.paymentService, config.adminUserIds);

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.client.on('ready', async () => {
      console.log(`[DiscordBot] Logged in as ${this.client.user?.tag}`);

      // Run initial auto-deletion sweep for tickets whose 1-hour delay passed while bot was offline
      try {
        const cleaned = await this.ticketService.processAllExpiredTickets(
          this.client,
          this.ticketLogger
        );
        if (cleaned > 0) {
          console.log(`[DiscordBot] Startup cleanup: Auto-deleted ${cleaned} expired closed tickets.`);
        }
      } catch (err: any) {
        console.error('[DiscordBot] Startup auto-deletion sweep error:', err.message);
      }

      // Start periodic background runner (checks every 60 seconds)
      this.startAutoDeleteScheduler();
    });

    this.client.on('messageCreate', async (message: Message) => {
      await this.slipHandler.handleMessage(message);
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.handleSlashCommand(interaction);
        } else if (interaction.isStringSelectMenu()) {
          await this.handleSelectMenu(interaction);
        } else if (interaction.isButton()) {
          const customId = interaction.customId;
          if (
            customId.startsWith('ticket_ctrl_') ||
            customId.startsWith('ticket_confirm_') ||
            customId.startsWith('ticket_cancel_')
          ) {
            await this.ticketHandler.handleButton(interaction);
          } else if (customId.startsWith('admin_approve_') || customId.startsWith('admin_reject_')) {
            await this.reviewHandler.handleButtonInteraction(interaction);
          } else if (customId.startsWith('ticket_close_')) {
            await interaction.reply({ content: '🔒 กำลังปิดห้อง Ticket...' });
            await interaction.channel?.delete();
          }
        } else if (interaction.isModalSubmit()) {
          await this.reviewHandler.handleModalSubmit(interaction);
        }
      } catch (err: any) {
        console.error('[DiscordBot] Interaction error:', err);
        if (interaction.isRepliable()) {
          const msg = { content: `⚠️ ข้อผิดพลาด: ${err.message}`, ephemeral: true };
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(msg);
          } else {
            await interaction.reply(msg);
          }
        }
      }
    });
  }

  private async handleSlashCommand(interaction: any): Promise<void> {
    const { commandName } = interaction;
    const userId = interaction.user.id;
    const username = interaction.user.username;

    // Customer commands
    if (commandName === 'buy') {
      await interaction.deferReply({ ephemeral: true });
      const existing = await this.ticketService.findActiveTicketByUser(userId, 'PURCHASE_MODEL');
      if (existing) {
        await interaction.editReply({
          content: `🎫 ท่านมี Ticket สั่งซื้อแพ็กเกจที่เปิดอยู่แล้วที่ห้อง <#${existing.discordChannelId}>`,
        });
        return;
      }

      await interaction.editReply({
        content: `🎫 หากท่านต้องการสั่งซื้อแพ็กเกจโมเดล กรุณาไปที่ศูนย์บริการลูกค้าในห้อง <#${this.config.ticketPanelChannelId}> และเลือก **"ซื้อแพ็กเกจโมเดล"** เพื่อเปิดห้อง Ticket ส่วนตัว`,
      });
    } else if (commandName === 'models') {
      await interaction.deferReply({ ephemeral: true });
      const groups = await this.customerService.getCustomerAllowedGroups(userId);
      const availableModels = this.catalogService.getModelsForGroups(
        groups.length > 0 ? groups : ['NxG1']
      );

      // Public presentation: never reveals provider base cost or Bearlab upstream IDs
      const listDesc = availableModels
        .map((m) => `• **${m.displayName}** (\`${m.publicModelId}\`)`)
        .join('\n');

      await interaction.editReply({
        content:
          `### 🤖 โมเดล AI ที่พร้อมใช้งานสำหรับบัญชีของคุณ\n` +
          `กลุ่มโมเดลที่ได้รับสิทธิ์: \`${groups.length > 0 ? groups.join(', ') : 'NxG1 (ตัวอย่างเริ่มต้น)'}\`\n\n` +
          `${listDesc}`,
      });
    } else if (commandName === 'balance') {
      await interaction.deferReply({ ephemeral: true });
      const { profile } = await this.customerService.findOrCreateCustomer(userId, username);
      await interaction.editReply({
        embeds: [BotEmbeds.customerProfile(profile)],
      });
    } else if (commandName === 'account') {
      await interaction.deferReply({ ephemeral: true });
      const { profile } = await this.customerService.findOrCreateCustomer(userId, username);
      await interaction.editReply({
        embeds: [BotEmbeds.customerProfile(profile)],
      });
    } else if (commandName === 'help') {
      await interaction.reply({
        content:
          `### 📖 คู่มือการใช้งาน SealAPI Hub\n\n` +
          `**ศูนย์บริการลูกค้า & การสั่งซื้อ:**\n` +
          `ไปที่ห้อง <#${this.config.ticketPanelChannelId}> เพื่อเปิด Ticket **ซื้อแพ็กเกจโมเดล** หรือ **สอบถามข้อมูล**\n\n` +
          `**คำสั่งสำหรับลูกค้า (Customer Commands):**\n` +
          `• \`/buy\` — แนะนำขั้นตอนการเปิด Ticket เพื่อสั่งซื้อแพ็กเกจ\n` +
          `• \`/models\` — ตรวจสอบรายชื่อโมเดล AI ที่พร้อมใช้งานตามกลุ่มที่ได้รับสิทธิ์\n` +
          `• \`/balance\` — ตรวจสอบยอดคงเหลือและสถานะบัญชี\n` +
          `• \`/account\` — ตรวจสอบข้อมูลบัญชีและสถานะ API Key\n` +
          `• \`/help\` — แสดงคู่มือการใช้งานคำสั่งต่างๆ\n\n` +
          `**การเชื่อมต่อใช้งาน API Proxy Gateway:**\n` +
          `• Base URL: \`${this.config.gatewayUrl}\`\n` +
          `• Authorization: \`Bearer <your_sealapi_api_key>\``,
        ephemeral: true,
      });
    }

    // Admin commands
    else if (['admin', 'ticket-panel', 'payment-review', 'customer', 'customer-key', 'rates'].includes(commandName)) {
      if (!this.reviewHandler.isAuthorizedAdmin(userId)) {
        await interaction.reply({
          content: '⛔ **ไม่มีสิทธิ์:** คำสั่งนี้จำกัดสิทธิ์เฉพาะผู้ดูแลระบบเท่านั้น',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'ticket-panel') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'deploy') {
          await interaction.deferReply({ ephemeral: true });

          const targetChannel =
            interaction.options.getChannel('channel') ||
            (this.config.ticketPanelChannelId
              ? await this.client.channels.fetch(this.config.ticketPanelChannelId).catch(() => null)
              : null);

          if (!targetChannel || !(targetChannel instanceof TextChannel)) {
            await interaction.editReply({
              content: `❌ ไม่พบ Text Channel ที่กำหนด กรุณาระบุตัวเลือก channel หรือตรวจสอบค่า TICKET_PANEL_CHANNEL_ID`,
            });
            return;
          }

          const embed = TicketPanelUI.supportCenterEmbed();
          const menu = TicketPanelUI.categorySelectMenu();

          await targetChannel.send({
            embeds: [embed],
            components: [menu],
          });

          await interaction.editReply({
            content: `✅ **ติดตั้งพาเนลศูนย์บริการลูกค้า (Support Center) สำเร็จเรียบร้อยแล้ว** ที่ห้อง <#${targetChannel.id}>`,
          });
        }
      } else if (commandName === 'rates') {
        await interaction.deferReply({ ephemeral: true });
        const forceRefresh = interaction.options.getBoolean('refresh') || false;
        const rates = await this.frankfurterService.getRates(forceRefresh);

        await interaction.editReply({
          content:
            `📊 **Frankfurter Exchange Rates**\n` +
            `• Base Currency: \`${rates.baseCurrency}\`\n` +
            `• 1 CNY = **฿${rates.rates.THB} THB**\n` +
            `• 1 CNY = **$${rates.rates.USD} USD**\n` +
            `• Rate Date: \`${rates.rateDate}\`\n` +
            `• Retrieved: \`${rates.retrievedAt.toISOString()}\`\n` +
            `• Status: ${rates.isStale ? '⚠️ **STALE (Fallback)**' : '✅ **Fresh**'}\n` +
            `• Source: \`${rates.source}\``,
        });
      } else if (commandName === 'payment-review') {
        await interaction.deferReply({ ephemeral: true });
        const pending = await this.paymentService.getPendingReviews();

        if (pending.length === 0) {
          await interaction.editReply({ content: '✅ ไม่มีรายการชำระเงินที่รอการตรวจสอบในขณะนี้' });
          return;
        }

        const summary = pending
          .map(
            (p) =>
              `• Payment \`${p.id}\` | ลูกค้า: <@${p.customer.discordUserId}> | แพ็กเกจ: ${p.package.name} (฿${p.expectedAmountThb} THB)`
          )
          .join('\n');

        await interaction.editReply({
          content: `### 📋 รายการสลิปที่รอการตรวจสอบ (${pending.length})\n${summary}`,
        });
      } else if (commandName === 'customer') {
        await interaction.deferReply({ ephemeral: true });
        const query = interaction.options.getString('query', true);
        const results = await this.customerService.searchCustomers(query);

        if (results.length === 0) {
          await interaction.editReply({ content: `ไม่พบบัญชีลูกค้าที่ตรงกับคำค้นหา "${query}"` });
          return;
        }

        const embeds = results.slice(0, 3).map((p) => BotEmbeds.customerProfile(p));
        await interaction.editReply({ embeds });
      } else if (commandName === 'customer-key') {
        await interaction.deferReply({ ephemeral: true });
        const targetUserId = interaction.options.getString('user_id', true);
        const action = interaction.options.getString('action', true);

        if (action === 'rotate') {
          const { plainTextApiKey } = await this.customerService.generateOrRotateApiKey(targetUserId);
          await interaction.editReply({
            content:
              `🔑 **สร้าง SealAPI API Key ใหม่สำหรับ <@${targetUserId}>:**\n` +
              `\`\`\`\n${plainTextApiKey}\n\`\`\`\n` +
              `*กรุณาส่งมอบคีย์นี้ให้ลูกค้าอย่างปลอดภัย*`,
          });
        } else if (action === 'disable') {
          await this.customerService.updateKeyStatus(targetUserId, KEY_STATUS.DISABLED);
          await interaction.editReply({ content: `🔒 ระงับการใช้งาน API Key สำหรับ <@${targetUserId}> เรียบร้อยแล้ว (DISABLED)` });
        } else if (action === 'activate') {
          await this.customerService.updateKeyStatus(targetUserId, KEY_STATUS.ACTIVE);
          await interaction.editReply({ content: `✅ เปิดใช้งาน API Key สำหรับ <@${targetUserId}> เรียบร้อยแล้ว (ACTIVE)` });
        }
      }
    }
  }

  private async handleSelectMenu(interaction: any): Promise<void> {
    const customId = interaction.customId;

    if (customId === 'ticket_select_category') {
      await this.ticketHandler.handleCategorySelect(interaction);
    } else if (customId === 'purchase_select_group') {
      await this.ticketHandler.handlePurchaseGroupSelect(interaction);
    } else if (customId.startsWith('purchase_select_requests_')) {
      await this.ticketHandler.handlePurchaseQuantitySelect(
        interaction,
        this.paymentService,
        this.config.promptPayId || '0926671327'
      );
    } else if (customId === 'ticket_select_package') {
      await interaction.deferReply();
      const packageId = interaction.values[0];

      const { payment, calculation } = await this.paymentService.createPendingPayment({
        discordUserId: interaction.user.id,
        username: interaction.user.username,
        ticketChannelId: interaction.channelId,
        packageId,
      });

      const finalAmountThb = calculation.finalPaymentAmountThb.toString();
      let files: AttachmentBuilder[] = [];
      let hasQrAttachment = false;

      try {
        const qrResult = await PromptPayService.generatePromptPayQr({
          recipient: this.config.promptPayId || '0926671327',
          amount: finalAmountThb,
        });

        files.push(new AttachmentBuilder(qrResult.qrBuffer, { name: 'promptpay-qr.png' }));
        hasQrAttachment = true;
      } catch (err: any) {
        console.warn('[DiscordBot] PromptPay QR generation fallback:', err.message);
      }

      const instructionsEmbed = BotEmbeds.paymentInstructions({
        groupDisplayName: `${payment.package.name} [${payment.package.groupId}]`,
        referenceRequests: payment.package.referenceRequests,
        paymentId: payment.id,
        finalAmountThb,
        promptPayId: this.config.promptPayId || '0926671327',
        hasQrAttachment,
      });

      await interaction.editReply({ embeds: [instructionsEmbed], files });
    }
  }

  public async registerSlashCommands(): Promise<void> {
    if (!this.config.token || !this.config.clientId || !this.config.guildId) {
      console.warn('[DiscordBot] Skipping slash command registration (missing token, clientId, or guildId).');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(this.config.token);
    const allCommands = [...customerSlashCommands, ...adminSlashCommands].map((c) => c.toJSON());

    console.log(`[DiscordBot] Registering ${allCommands.length} slash commands to guild ${this.config.guildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(this.config.clientId, this.config.guildId),
      { body: allCommands }
    );
    console.log('[DiscordBot] Slash commands successfully registered.');
  }

  /**
   * Starts periodic background runner to scan and clean up closed tickets expired after 1 hour.
   */
  public startAutoDeleteScheduler(intervalMs: number = 60 * 1000): void {
    if (this.autoDeleteTimer) {
      clearInterval(this.autoDeleteTimer);
    }

    this.autoDeleteTimer = setInterval(async () => {
      try {
        await this.ticketService.processAllExpiredTickets(this.client, this.ticketLogger);
      } catch (err: any) {
        console.error('[DiscordBot] Periodic auto-deletion error:', err?.message || err);
      }
    }, intervalMs);
  }

  /**
   * Stops the background scheduler and destroys the Discord client connection.
   */
  public async stop(): Promise<void> {
    if (this.autoDeleteTimer) {
      clearInterval(this.autoDeleteTimer);
      this.autoDeleteTimer = undefined;
    }
    await this.client.destroy();
  }

  public async start(): Promise<void> {
    if (!this.config.token) {
      console.warn('[DiscordBot] DISCORD_BOT_TOKEN not provided; bot startup skipped.');
      return;
    }

    await this.registerSlashCommands();
    await this.client.login(this.config.token);
  }
}
