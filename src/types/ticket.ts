import { TicketCategory, TicketStatus } from '../config/constants.js';

export interface TicketRecord {
  id: string;
  discordChannelId: string;
  discordGuildId: string;
  ownerDiscordId: string;
  customerId: string | null;
  category: TicketCategory | string;
  status: TicketStatus | string;
  claimedByDiscordId: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  closedByDiscordId: string | null;
  autoDeleteAt?: Date | null;
  deletedAt: Date | null;
  deletedByDiscordId: string | null;
}

export interface CreateTicketParams {
  discordChannelId: string;
  discordGuildId: string;
  ownerDiscordId: string;
  category: TicketCategory;
  customerId?: string | null;
}
