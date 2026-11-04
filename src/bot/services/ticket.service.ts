import { getPrismaClient } from '../../db/client.js';
import { TICKET_CATEGORY, TICKET_STATUS, TicketCategory, TicketStatus } from '../../config/constants.js';
import { CreateTicketParams, TicketRecord } from '../../types/ticket.js';

export class TicketError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'TicketError';
  }
}

export class DuplicateActiveTicketError extends TicketError {
  constructor(public readonly existingChannelId: string, category: string) {
    super(
      `You already have an active ${category} ticket open in <#${existingChannelId}>.`,
      'DUPLICATE_ACTIVE_TICKET'
    );
  }
}

export class TicketNotFoundError extends TicketError {
  constructor(identifier: string) {
    super(`Ticket '${identifier}' was not found.`, 'TICKET_NOT_FOUND');
  }
}

export class TicketStateError extends TicketError {
  constructor(message: string) {
    super(message, 'INVALID_TICKET_STATE');
  }
}

export class TicketService {
  /**
   * Finds an existing active (OPEN or CLAIMED) ticket for a user.
   */
  public async findActiveTicketByUser(
    ownerDiscordId: string,
    category?: TicketCategory | string
  ): Promise<TicketRecord | null> {
    const prisma = getPrismaClient();

    const whereClause: any = {
      ownerDiscordId,
      status: { in: [TICKET_STATUS.OPEN, TICKET_STATUS.CLAIMED] },
    };

    if (category) {
      whereClause.category = category;
    }

    const ticket = await prisma.ticket.findFirst({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });

    return ticket as TicketRecord | null;
  }

  /**
   * Creates a new ticket database record.
   */
  public async createTicketRecord(params: CreateTicketParams): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    // Check if user already has an active ticket of the same category
    const existing = await this.findActiveTicketByUser(params.ownerDiscordId, params.category);
    if (existing) {
      throw new DuplicateActiveTicketError(existing.discordChannelId, params.category);
    }

    const ticket = await prisma.ticket.create({
      data: {
        discordChannelId: params.discordChannelId,
        discordGuildId: params.discordGuildId,
        ownerDiscordId: params.ownerDiscordId,
        customerId: params.customerId || null,
        category: params.category,
        status: TICKET_STATUS.OPEN,
      },
    });

    return ticket as TicketRecord;
  }

  /**
   * Retrieves a ticket record by its Discord Channel ID.
   */
  public async getTicketByChannelId(discordChannelId: string): Promise<TicketRecord | null> {
    const prisma = getPrismaClient();
    const ticket = await prisma.ticket.findUnique({
      where: { discordChannelId },
    });
    return ticket as TicketRecord | null;
  }

  /**
   * Retrieves a ticket record by ID.
   */
  public async getTicketById(ticketId: string): Promise<TicketRecord | null> {
    const prisma = getPrismaClient();
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    return ticket as TicketRecord | null;
  }

  /**
   * Claims an unassigned open ticket for a support staff member.
   */
  public async claimTicket(ticketId: string, staffDiscordId: string): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }

    if (ticket.status === TICKET_STATUS.CLOSED || ticket.status === TICKET_STATUS.DELETED) {
      throw new TicketStateError(`Cannot claim a ticket that is ${ticket.status}.`);
    }

    if (ticket.claimedByDiscordId && ticket.claimedByDiscordId !== staffDiscordId) {
      throw new TicketStateError(`Ticket is already claimed by <@${ticket.claimedByDiscordId}>.`);
    }

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: TICKET_STATUS.CLAIMED,
        claimedByDiscordId: staffDiscordId,
      },
    });

    return updated as TicketRecord;
  }

  /**
   * Releases a claimed ticket back to unassigned status.
   */
  public async releaseTicket(ticketId: string, staffDiscordId: string): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }

    if (ticket.status !== TICKET_STATUS.CLAIMED) {
      throw new TicketStateError('Only claimed tickets can be released.');
    }

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: TICKET_STATUS.OPEN,
        claimedByDiscordId: null,
      },
    });

    return updated as TicketRecord;
  }

  /**
   * Closes a ticket.
   * If there is no pending payment review, schedules auto-deletion in 1 hour.
   * If there is a pending payment review, autoDeleteAt is NOT scheduled.
   */
  public async closeTicket(ticketId: string, closedByDiscordId: string): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }

    if (ticket.status === TICKET_STATUS.CLOSED) {
      return ticket; // Idempotent close
    }

    if (ticket.status === TICKET_STATUS.DELETED) {
      throw new TicketStateError('Cannot close a deleted ticket.');
    }

    // Check for pending payment reviews or unresolved actions
    const pendingPayment = await prisma.payment.findFirst({
      where: {
        ticketChannelId: ticket.discordChannelId,
        paymentStatus: {
          in: ['PENDING_PAYMENT', 'SLIP_SUBMITTED', 'UNDER_REVIEW'],
        },
      },
    });

    const now = new Date();
    // Do NOT schedule deletion for tickets with pending payment review
    const autoDeleteAt = pendingPayment ? null : new Date(now.getTime() + 60 * 60 * 1000);

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: TICKET_STATUS.CLOSED,
        closedAt: now,
        closedByDiscordId,
        autoDeleteAt,
      },
    });

    return updated as TicketRecord;
  }

  /**
   * Explicitly schedules or updates autoDeleteAt for a closed ticket.
   */
  public async scheduleAutoDelete(
    ticketId: string,
    delayMs: number = 60 * 60 * 1000
  ): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }

    if (ticket.status !== TICKET_STATUS.CLOSED) {
      throw new TicketStateError('Only closed tickets can be scheduled for auto-deletion.');
    }

    const autoDeleteAt = new Date(Date.now() + delayMs);
    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: { autoDeleteAt },
    });

    return updated as TicketRecord;
  }

  /**
   * Reopens a closed ticket and cancels scheduled auto-deletion.
   */
  public async reopenTicket(ticketId: string): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }

    if (ticket.status !== TICKET_STATUS.CLOSED) {
      throw new TicketStateError('Only closed tickets can be reopened.');
    }

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: TICKET_STATUS.OPEN,
        closedAt: null,
        closedByDiscordId: null,
        autoDeleteAt: null,
      },
    });

    return updated as TicketRecord;
  }

  /**
   * Marks a ticket as DELETED while preserving the database record and history.
   */
  public async deleteTicket(ticketId: string, deletedByDiscordId: string): Promise<TicketRecord> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: TICKET_STATUS.DELETED,
        deletedAt: new Date(),
        deletedByDiscordId,
      },
    });

    return updated as TicketRecord;
  }

  // Set of in-flight deletion jobs to prevent duplicate scheduler execution
  private readonly activeDeletionJobs = new Set<string>();

  /**
   * Evaluates if a ticket is eligible for safe automatic deletion.
   * Safe Deletion Guard Rules:
   * 1. Ticket must exist.
   * 2. Ticket must be in CLOSED status (Immunity for OPEN and CLAIMED tickets).
   * 3. autoDeleteAt must be set and <= asOf.
   * 4. Must NOT have any pending payment review or unresolved admin actions (PENDING_PAYMENT, SLIP_SUBMITTED, UNDER_REVIEW).
   */
  public async isTicketEligibleForAutoDeletion(
    ticketId: string,
    asOf: Date = new Date()
  ): Promise<{ eligible: boolean; reason?: string; ticket?: TicketRecord }> {
    const prisma = getPrismaClient();

    const ticket = await this.getTicketById(ticketId);
    if (!ticket) {
      return { eligible: false, reason: 'Ticket not found' };
    }

    if (ticket.status !== TICKET_STATUS.CLOSED) {
      return {
        eligible: false,
        reason: `Ticket is not in CLOSED status (current status: ${ticket.status}) - active tickets have deletion immunity`,
        ticket,
      };
    }

    if (!ticket.autoDeleteAt || ticket.autoDeleteAt > asOf) {
      return {
        eligible: false,
        reason: 'Ticket auto-delete time has not arrived yet',
        ticket,
      };
    }

    // Safety check: unresolved payments or pending reviews
    const pendingPayment = await prisma.payment.findFirst({
      where: {
        ticketChannelId: ticket.discordChannelId,
        paymentStatus: {
          in: ['PENDING_PAYMENT', 'SLIP_SUBMITTED', 'UNDER_REVIEW'],
        },
      },
    });

    if (pendingPayment) {
      return {
        eligible: false,
        reason: `Ticket has pending payment review (paymentId: ${pendingPayment.id}, status: ${pendingPayment.paymentStatus})`,
        ticket,
      };
    }

    return { eligible: true, ticket };
  }

  /**
   * Scans database for closed tickets whose autoDeleteAt has arrived.
   */
  public async findExpiredClosedTickets(asOf: Date = new Date()): Promise<TicketRecord[]> {
    const prisma = getPrismaClient();
    const tickets = await prisma.ticket.findMany({
      where: {
        status: TICKET_STATUS.CLOSED,
        autoDeleteAt: {
          not: null,
          lte: asOf,
        },
      },
      orderBy: { autoDeleteAt: 'asc' },
    });
    return tickets as TicketRecord[];
  }

  /**
   * Safely deletes a closed ticket and its associated Discord channel after 1 hour.
   * Concurrency-safe: prevents duplicate deletion jobs.
   * Failure-tolerant: handles Discord API errors and reschedules retry without losing state.
   */
  public async processAutoDeletion(
    ticketId: string,
    client?: any,
    logger?: any
  ): Promise<{ success: boolean; reason?: string }> {
    if (this.activeDeletionJobs.has(ticketId)) {
      return { success: false, reason: 'Deletion job already in progress' };
    }

    this.activeDeletionJobs.add(ticketId);
    try {
      const eligibility = await this.isTicketEligibleForAutoDeletion(ticketId);
      if (!eligibility.eligible || !eligibility.ticket) {
        return { success: false, reason: eligibility.reason };
      }

      const ticket = eligibility.ticket;

      // 1. Delete Discord channel if client is provided
      if (client && client.channels) {
        try {
          const channel = await client.channels.fetch(ticket.discordChannelId).catch(() => null);
          if (channel) {
            await channel.delete('Auto-deleted after 1 hour of closure');
          }
        } catch (discordErr: any) {
          // If Discord API fails (e.g. rate limit, network error, missing permissions):
          // Reschedule retry in 5 minutes so DB state is NOT falsely marked as DELETED
          const retryTime = new Date(Date.now() + 5 * 60 * 1000);
          const prisma = getPrismaClient();
          await prisma.ticket.update({
            where: { id: ticketId },
            data: { autoDeleteAt: retryTime },
          });

          return {
            success: false,
            reason: `Discord channel deletion failed: ${discordErr?.message || discordErr}. Rescheduled retry for ${retryTime.toISOString()}`,
          };
        }
      }

      // 2. Mark ticket as DELETED in database (preserving all records & history)
      await this.deleteTicket(ticketId, 'SYSTEM_AUTO_CLEANUP');

      // 3. Log event
      if (logger && typeof logger.logEvent === 'function') {
        await logger.logEvent({
          eventType: 'TICKET_AUTO_DELETED',
          ticketId: ticket.id,
          channelId: ticket.discordChannelId,
          category: ticket.category,
          ownerDiscordId: ticket.ownerDiscordId,
          status: TICKET_STATUS.DELETED,
          deletedAt: new Date(),
          reason: 'Channel auto-deleted after 1 hour of closure',
        });
      }

      return { success: true };
    } finally {
      this.activeDeletionJobs.delete(ticketId);
    }
  }

  /**
   * Scans and processes all expired closed tickets.
   */
  public async processAllExpiredTickets(client?: any, logger?: any): Promise<number> {
    const expiredTickets = await this.findExpiredClosedTickets();
    let processedCount = 0;

    for (const ticket of expiredTickets) {
      const result = await this.processAutoDeletion(ticket.id, client, logger);
      if (result.success) {
        processedCount++;
      }
    }

    return processedCount;
  }
}
