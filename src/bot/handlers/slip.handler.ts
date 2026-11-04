import { Message, TextChannel } from 'discord.js';
import { PaymentService } from '../../services/payment.service.js';
import { getPrismaClient } from '../../db/client.js';
import { BotEmbeds } from '../ui/embeds.js';
import { BotComponents } from '../ui/components.js';
import { PAYMENT_STATUS } from '../../config/constants.js';

export class SlipHandler {
  constructor(
    private readonly paymentService: PaymentService = new PaymentService(),
    private readonly adminReviewChannelId?: string
  ) {}

  /**
   * Processes messages sent in ticket channels to detect and validate payment slip uploads.
   */
  public async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages or messages without attachments
    if (message.author.bot || message.attachments.size === 0) {
      return;
    }

    const prisma = getPrismaClient();

    // Find the latest pending payment for this ticket channel
    const payment = await prisma.payment.findFirst({
      where: {
        ticketChannelId: message.channel.id,
        paymentStatus: {
          in: [PAYMENT_STATUS.PENDING_PAYMENT, PAYMENT_STATUS.REJECTED],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        package: true,
        customer: true,
      },
    });

    if (!payment) {
      return; // No pending payment awaiting slip in this channel
    }

    const attachment = message.attachments.first();
    if (!attachment) return;

    try {
      // 1. Download attachment buffer
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error('Failed to download payment slip from Discord attachment.');
      }
      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);

      // 2. Process slip submission (validation, SHA-256 hash, duplicate check)
      const { payment: updatedPayment, slip } = await this.paymentService.submitPaymentSlip({
        paymentId: payment.id,
        fileBuffer,
        originalFilename: attachment.name || 'slip.png',
        mimeType: attachment.contentType || 'image/png',
      });

      // 3. Confirm receipt to customer in the ticket channel immediately
      const underReviewEmbed = BotEmbeds.slipReceivedUnderReview(updatedPayment.id);
      await message.reply({ embeds: [underReviewEmbed] });

      // 4. Decoupled admin review notification: failure does NOT affect customer confirmation
      await this.sendAdminReviewNotification(
        updatedPayment.id,
        message.client || message.guild,
        attachment.url
      );
    } catch (err: any) {
      await message.reply({
        content: `⚠️ **ไม่สามารถบันทึกสลิปการโอนเงินได้:** ${err.message}`,
      });
    }
  }

  /**
   * Dispatches admin review notification to the admin review channel.
   * Decoupled from slip persistence: Discord API errors (e.g. Missing Access 50001)
   * never falsely report slip saving failure to customers.
   */
  public async sendAdminReviewNotification(
    paymentId: string,
    clientOrGuild: any,
    slipUrl?: string
  ): Promise<boolean> {
    if (!this.adminReviewChannelId) {
      return false;
    }

    try {
      const prisma = getPrismaClient();
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          package: true,
          customer: true,
          slips: { orderBy: { submittedAt: 'desc' }, take: 1 },
        },
      });

      if (!payment) {
        console.warn(`[SlipHandler] Payment ${paymentId} not found for admin review notification.`);
        return false;
      }

      let reviewChannel: TextChannel | null = null;
      if (clientOrGuild?.channels?.fetch) {
        reviewChannel = (await clientOrGuild.channels
          .fetch(this.adminReviewChannelId)
          .catch(() => null)) as TextChannel | null;
      } else if (clientOrGuild?.channels?.cache?.get) {
        reviewChannel = clientOrGuild.channels.cache.get(this.adminReviewChannelId) as TextChannel | null;
      }

      if (!reviewChannel) {
        console.warn(
          `[SlipHandler] Admin review channel ${this.adminReviewChannelId} is not accessible or not found.`
        );
        return false;
      }

      let displaySlipUrl: string | undefined = undefined;
      const candidateUrl =
        slipUrl ||
        (payment.slips.length > 0 ? payment.slips[0].privateFileReference : undefined);

      if (
        candidateUrl &&
        (candidateUrl.startsWith('http://') ||
          candidateUrl.startsWith('https://') ||
          candidateUrl.startsWith('attachment://'))
      ) {
        displaySlipUrl = candidateUrl;
      }

      const adminEmbed = BotEmbeds.adminReviewNotification({
        paymentId: payment.id,
        customerDiscordId: payment.customer.discordUserId,
        customerUsername: payment.customer.username,
        packageName: payment.package.name,
        groupId: payment.package.groupId,
        expectedAmountThb: payment.expectedAmountThb.toString(),
        slipUrl: displaySlipUrl,
      });

      await reviewChannel.send({
        content: `🔔 **มีรายการชำระเงินรอการตรวจสอบจากห้อง <#${payment.ticketChannelId}>**`,
        embeds: [adminEmbed],
        components: [BotComponents.adminReviewButtons(payment.id)],
      });

      return true;
    } catch (err: any) {
      console.warn(
        `[SlipHandler] Failed to dispatch admin review notification for payment ${paymentId}:`,
        err?.message || err
      );
      return false;
    }
  }

  /**
   * Retries admin review notification for an existing payment record
   * without creating duplicate payment_slips or re-submitting files.
   */
  public async resendAdminReviewNotification(
    paymentId: string,
    clientOrGuild: any
  ): Promise<boolean> {
    return this.sendAdminReviewNotification(paymentId, clientOrGuild);
  }
}
