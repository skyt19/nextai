import { Client, EmbedBuilder, TextChannel } from 'discord.js';

export interface TicketLogPayload {
  eventType:
    | 'TICKET_CREATED'
    | 'TICKET_CREATION_FAILED'
    | 'TICKET_CLAIMED'
    | 'TICKET_RELEASED'
    | 'TICKET_CLOSED'
    | 'TICKET_REOPENED'
    | 'TICKET_DELETED'
    | 'TICKET_AUTO_DELETED';
  ticketId?: string;
  channelId?: string;
  category?: string;
  ownerDiscordId?: string;
  staffDiscordId?: string;
  status?: string;
  details?: string;
  reason?: string;
  deletedAt?: Date | string;
}

export class TicketLoggerService {
  constructor(private readonly client: Client, private readonly logChannelId: string) {}

  /**
   * Logs a ticket lifecycle event to the configured log channel.
   * STRICT SECURITY: Never logs API keys, passwords, or customer private data.
   */
  public async logEvent(payload: TicketLogPayload): Promise<void> {
    try {
      if (!this.logChannelId) return;

      const channel = await this.client.channels.fetch(this.logChannelId).catch(() => null);
      if (!channel || !(channel instanceof TextChannel)) {
        console.warn(
          `[TicketLogger] Log channel ${this.logChannelId} is not accessible or is not a text channel.`
        );
        return;
      }

      const colorMap: Record<string, number> = {
        TICKET_CREATED: 0x57f287, // Green
        TICKET_CREATION_FAILED: 0xed4245, // Red
        TICKET_CLAIMED: 0x3498db, // Blue
        TICKET_RELEASED: 0x9b59b6, // Purple
        TICKET_CLOSED: 0xfee75c, // Yellow
        TICKET_REOPENED: 0x2ecc71, // Light green
        TICKET_DELETED: 0x95a5a6, // Grey
        TICKET_AUTO_DELETED: 0xe67e22, // Orange
      };

      const embed = new EmbedBuilder()
        .setTitle(`📋 Ticket Activity: ${payload.eventType.replace(/_/g, ' ')}`)
        .setColor(colorMap[payload.eventType] || 0x5865f2)
        .setTimestamp()
        .setFooter({ text: 'Next AI Ticket Audit Log' });

      if (payload.ticketId) {
        embed.addFields({ name: 'Ticket ID', value: `\`${payload.ticketId}\``, inline: true });
      }

      if (payload.category) {
        embed.addFields({ name: 'Category', value: payload.category, inline: true });
      }

      if (payload.channelId) {
        embed.addFields({ name: 'Channel', value: `<#${payload.channelId}>`, inline: true });
      }

      if (payload.ownerDiscordId) {
        embed.addFields({
          name: 'Owner',
          value: `<@${payload.ownerDiscordId}> (\`${payload.ownerDiscordId}\`)`,
          inline: true,
        });
      }

      if (payload.staffDiscordId) {
        embed.addFields({
          name: 'Staff Action By',
          value: `<@${payload.staffDiscordId}> (\`${payload.staffDiscordId}\`)`,
          inline: true,
        });
      }

      if (payload.status) {
        embed.addFields({ name: 'Status', value: `\`${payload.status}\``, inline: true });
      }

      if (payload.deletedAt) {
        const dateStr = payload.deletedAt instanceof Date ? payload.deletedAt.toISOString() : String(payload.deletedAt);
        embed.addFields({ name: 'Deleted At', value: dateStr, inline: true });
      }

      if (payload.reason) {
        embed.addFields({ name: 'Reason', value: payload.reason, inline: false });
      }

      if (payload.details) {
        embed.addFields({ name: 'Details', value: payload.details, inline: false });
      }

      await channel.send({ embeds: [embed] });
    } catch (err: any) {
      console.error('[TicketLogger] Failed to send ticket log embed:', err?.message || err);
    }
  }
}
