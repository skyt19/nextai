import {
  ButtonInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  TextChannel,
} from 'discord.js';
import { PaymentService } from '../../services/payment.service.js';
import { TokenProvisioningService } from '../../services/token-provisioning.service.js';
import { BotEmbeds } from '../ui/embeds.js';
import { env } from '../../config/env.js';

export class ReviewHandler {
  constructor(
    private readonly paymentService: PaymentService = new PaymentService(),
    private readonly adminAllowlist: string[] = [],
    private readonly tokenProvisioningService: TokenProvisioningService = new TokenProvisioningService()
  ) {}

  /**
   * Verifies if a Discord User ID is allowlisted for admin actions.
   */
  public isAuthorizedAdmin(userId: string): boolean {
    return this.adminAllowlist.includes(userId);
  }

  /**
   * Handles Approve and Reject button interactions.
   */
  public async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (!customId.startsWith('admin_approve_') && !customId.startsWith('admin_reject_')) {
      return;
    }

    // 1. Server-side admin verification
    if (!this.isAuthorizedAdmin(interaction.user.id)) {
      await interaction.reply({
        content: '⛔ **Unauthorized:** Only allowlisted administrators may perform payment approvals or rejections.',
        ephemeral: true,
      });
      return;
    }

    if (customId.startsWith('admin_approve_')) {
      const paymentId = customId.replace('admin_approve_', '');
      await this.processApproval(interaction, paymentId);
    } else if (customId.startsWith('admin_reject_')) {
      const paymentId = customId.replace('admin_reject_', '');
      await this.showRejectionModal(interaction, paymentId);
    }
  }

  /**
   * Executes idempotent manual payment approval.
   */
  private async processApproval(interaction: ButtonInteraction, paymentId: string): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await this.paymentService.approvePayment({
        paymentId,
        reviewerDiscordId: interaction.user.id,
      });

      const { payment, customerProfile, newlyIssuedApiKey, tokenRecord, alreadyProcessed } = result;

      // Update admin review message
      await interaction.editReply({
        content: alreadyProcessed
          ? `⚠️ Payment \`${paymentId}\` was already approved previously.`
          : `✅ **Payment \`${paymentId}\` approved successfully!** Credited to <@${payment.customer.discordUserId}>.`,
      });

      // Notify customer inside their private ticket channel
      const ticketChannel = interaction.guild?.channels.cache.get(
        payment.ticketChannelId
      ) as TextChannel | undefined;

      if (ticketChannel) {
        if (tokenRecord?.id) {
          try {
            await this.tokenProvisioningService.deliverTokenToDiscord(tokenRecord.id, ticketChannel);
          } catch {
            // Non-blocking: If token delivery failed, retain secret and notify customer
            await ticketChannel.send({
              content: `<@${payment.customer.discordUserId}> 🎉 การชำระเงินได้รับการอนุมัติแล้ว แต่ระบบจัดส่ง Token ขัดข้องชั่วคราว แอดมินกำลังดำเนินการจัดส่งให้โดยตรงครับ`,
            });
          }
        } else {
          // Extract specific quota for THIS payment from calculation snapshot
          let paymentQuota = '5.00';
          try {
            const snap = JSON.parse(payment.calculationSnapshot);
            paymentQuota =
              snap.customer_quota_cny ||
              snap.display_reference_value_cny ||
              snap.assigned_quota_cny ||
              '5.00';
          } catch {
            // fallback
          }

          const approvedEmbed = BotEmbeds.paymentApproved({
            packageName: payment.package.name,
            groupId: payment.package.groupId,
            assignedQuotaCny: paymentQuota,
            plainTextApiKey: newlyIssuedApiKey,
            gatewayUrl: env.NEWAPI_PUBLIC_ENDPOINT,
          });

          await ticketChannel.send({
            content: `<@${payment.customer.discordUserId}>`,
            embeds: [approvedEmbed],
          });
        }
      }
    } catch (err: any) {
      await interaction.editReply({
        content: `❌ **Approval Failed:** ${err.message}`,
      });
    }
  }

  /**
   * Displays modal to collect admin rejection reason.
   */
  private async showRejectionModal(interaction: ButtonInteraction, paymentId: string): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId(`modal_reject_${paymentId}`)
      .setTitle('ปฏิเสธสลิปการชำระเงิน');

    const reasonInput = new TextInputBuilder()
      .setCustomId('rejection_reason')
      .setLabel('ระบุเหตุผลในการปฏิเสธ')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('เช่น ยอดเงินไม่ถูกต้อง, สลิปซ้ำ, สลิปไม่ชัดเจน')
      .setRequired(true)
      .setMaxLength(500);

    const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }

  /**
   * Processes submission of the rejection modal.
   */
  public async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith('modal_reject_')) {
      return;
    }

    if (!this.isAuthorizedAdmin(interaction.user.id)) {
      await interaction.reply({
        content: '⛔ **Unauthorized:** Only allowlisted administrators may perform payment reviews.',
        ephemeral: true,
      });
      return;
    }

    const paymentId = interaction.customId.replace('modal_reject_', '');
    const reason = interaction.fields.getTextInputValue('rejection_reason');

    await interaction.deferReply({ ephemeral: true });

    try {
      const updatedPayment = await this.paymentService.rejectPayment({
        paymentId,
        reviewerDiscordId: interaction.user.id,
        rejectionReason: reason,
      });

      await interaction.editReply({
        content: `❌ **Payment \`${paymentId}\` rejected.** Reason recorded: "${reason}".`,
      });

      // Inform customer in ticket channel
      const ticketChannel = interaction.guild?.channels.cache.get(
        updatedPayment.ticketChannelId
      ) as TextChannel | undefined;

      if (ticketChannel) {
        const rejectionEmbed = BotEmbeds.paymentRejected(reason);
        await ticketChannel.send({
          content: `<@${updatedPayment.customer.discordUserId}>`,
          embeds: [rejectionEmbed],
        });
      }
    } catch (err: any) {
      await interaction.editReply({
        content: `❌ **Rejection Failed:** ${err.message}`,
      });
    }
  }
}
