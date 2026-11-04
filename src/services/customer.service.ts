import { Decimal } from 'decimal.js';
import { getPrismaClient } from '../db/client.js';
import { CryptoService } from './crypto.service.js';
import { CustomerProfile, PaymentSummary } from '../types/customer.js';
import { KEY_STATUS, KeyStatus, MODEL_GROUPS, ModelGroupId } from '../config/constants.js';

export class CustomerNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Customer not found with identifier: '${identifier}'`);
    this.name = 'CustomerNotFoundError';
  }
}

export class CustomerAuthenticationError extends Error {
  public readonly statusCode = 401;
  constructor(message: string = 'Invalid or unauthorized API Key.') {
    super(message);
    this.name = 'CustomerAuthenticationError';
  }
}

export class CustomerKeyDisabledError extends Error {
  public readonly statusCode = 403;
  constructor(status: string) {
    super(`API Key is currently ${status}. Please contact an administrator.`);
    this.name = 'CustomerKeyDisabledError';
  }
}

export class CustomerService {
  /**
   * Finds an existing customer by Discord User ID or creates a new record.
   */
  public async findOrCreateCustomer(
    discordUserId: string,
    username: string
  ): Promise<{ customerId: string; profile: CustomerProfile; isNew: boolean }> {
    const prisma = getPrismaClient();

    let customer = await prisma.customer.findUnique({
      where: { discordUserId },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        tokens: true,
      },
    });

    let isNew = false;
    if (!customer) {
      isNew = true;
      customer = await prisma.customer.create({
        data: {
          discordUserId,
          username,
          balance: new Decimal(0).toString(),
          balanceCurrency: 'CNY',
          keyStatus: KEY_STATUS.ACTIVE,
        },
        include: {
          payments: true,
          tokens: true,
        },
      });
    } else if (customer.username !== username) {
      // Keep username synchronized with Discord username
      customer = await prisma.customer.update({
        where: { discordUserId },
        data: { username },
        include: {
          payments: {
            orderBy: { createdAt: 'desc' },
          },
          tokens: true,
        },
      });
    }

    return {
      customerId: customer.id,
      profile: this.toCustomerProfile(customer, customer.payments, customer.tokens),
      isNew,
    };
  }

  /**
   * Retrieves the strict 6-field Customer Profile by Discord User ID.
   */
  public async getCustomerProfile(discordUserId: string): Promise<CustomerProfile> {
    const prisma = getPrismaClient();
    const customer = await prisma.customer.findUnique({
      where: { discordUserId },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        tokens: true,
      },
    });

    if (!customer) {
      throw new CustomerNotFoundError(discordUserId);
    }

    return this.toCustomerProfile(customer, customer.payments, customer.tokens);
  }

  /**
   * Authenticates an incoming customer API Key for the reverse proxy.
   * Hashes the raw key with SHA-256, verifies key status, and fetches allowed model groups.
   */
  public async authenticateApiKey(rawApiKey: string): Promise<{
    customerId: string;
    discordUserId: string;
    username: string;
    allowedGroups: string[];
    profile: CustomerProfile;
  }> {
    if (!rawApiKey || !rawApiKey.startsWith('nx-live-')) {
      throw new CustomerAuthenticationError('Malformed or missing Next AI API Key.');
    }

    const keyHash = CryptoService.hashApiKey(rawApiKey);
    const prisma = getPrismaClient();

    const customer = await prisma.customer.findUnique({
      where: { nextaiApiKeyHash: keyHash },
      include: {
        modelGroups: true,
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!customer) {
      throw new CustomerAuthenticationError('Invalid Next AI API Key.');
    }

    if (customer.keyStatus !== KEY_STATUS.ACTIVE) {
      throw new CustomerKeyDisabledError(customer.keyStatus);
    }

    const allowedGroups = customer.modelGroups.map((g) => g.groupId);

    return {
      customerId: customer.id,
      discordUserId: customer.discordUserId,
      username: customer.username,
      allowedGroups,
      profile: this.toCustomerProfile(customer, customer.payments),
    };
  }

  /**
   * Generates or rotates a customer's API Key.
   * The unhashed plain-text key is returned ONLY once in this response.
   */
  public async generateOrRotateApiKey(discordUserId: string): Promise<{
    plainTextApiKey: string;
    profile: CustomerProfile;
  }> {
    const prisma = getPrismaClient();
    const plainTextApiKey = CryptoService.generateApiKey();
    const keyHash = CryptoService.hashApiKey(plainTextApiKey);

    const updatedCustomer = await prisma.customer.update({
      where: { discordUserId },
      data: {
        nextaiApiKeyHash: keyHash,
        keyStatus: KEY_STATUS.ACTIVE,
      },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    // Provide the plaintext key explicitly inside the returned profile only once
    const profile = this.toCustomerProfile(updatedCustomer, updatedCustomer.payments);
    profile.apiKey = plainTextApiKey;

    return {
      plainTextApiKey,
      profile,
    };
  }

  /**
   * Updates key status: ACTIVE, DISABLED, or SUSPENDED.
   */
  public async updateKeyStatus(discordUserId: string, status: KeyStatus): Promise<CustomerProfile> {
    const prisma = getPrismaClient();
    const updated = await prisma.customer.update({
      where: { discordUserId },
      data: { keyStatus: status },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    return this.toCustomerProfile(updated, updated.payments);
  }

  /**
   * Updates customer reference balance (e.g. upon payment approval or admin manual adjustment).
   */
  public async updateRecordedBalance(
    discordUserId: string,
    balanceDeltaCny: Decimal | string | number
  ): Promise<CustomerProfile> {
    const prisma = getPrismaClient();
    const customer = await prisma.customer.findUnique({
      where: { discordUserId },
    });

    if (!customer) {
      throw new CustomerNotFoundError(discordUserId);
    }

    const currentBalance = new Decimal(customer.balance.toString());
    const delta = new Decimal(balanceDeltaCny);
    const newBalance = currentBalance.plus(delta);

    const updated = await prisma.customer.update({
      where: { discordUserId },
      data: { balance: newBalance.toString() },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    return this.toCustomerProfile(updated, updated.payments);
  }

  /**
   * Assigns a model group (NxG1, NxGE, NxGC) to a customer.
   */
  public async assignModelGroup(discordUserId: string, groupId: ModelGroupId | string): Promise<string[]> {
    const prisma = getPrismaClient();
    const customer = await prisma.customer.findUnique({
      where: { discordUserId },
    });

    if (!customer) {
      throw new CustomerNotFoundError(discordUserId);
    }

    await prisma.customerModelGroup.upsert({
      where: {
        customerId_groupId: {
          customerId: customer.id,
          groupId,
        },
      },
      create: {
        customerId: customer.id,
        groupId,
      },
      update: {},
    });

    const groups = await prisma.customerModelGroup.findMany({
      where: { customerId: customer.id },
    });

    return groups.map((g) => g.groupId);
  }

  /**
   * Removes a model group assignment from a customer.
   */
  public async removeModelGroup(discordUserId: string, groupId: string): Promise<string[]> {
    const prisma = getPrismaClient();
    const customer = await prisma.customer.findUnique({
      where: { discordUserId },
    });

    if (!customer) {
      throw new CustomerNotFoundError(discordUserId);
    }

    await prisma.customerModelGroup.deleteMany({
      where: {
        customerId: customer.id,
        groupId,
      },
    });

    const groups = await prisma.customerModelGroup.findMany({
      where: { customerId: customer.id },
    });

    return groups.map((g) => g.groupId);
  }

  /**
   * Retrieves customer's assigned model groups.
   */
  public async getCustomerAllowedGroups(discordUserId: string): Promise<string[]> {
    const prisma = getPrismaClient();
    const customer = await prisma.customer.findUnique({
      where: { discordUserId },
      include: { modelGroups: true },
    });

    if (!customer) {
      return [];
    }

    return customer.modelGroups.map((g) => g.groupId);
  }

  /**
   * Searches customers by Discord User ID or Username.
   */
  public async searchCustomers(query: string): Promise<CustomerProfile[]> {
    const prisma = getPrismaClient();
    const cleanQuery = query.trim();

    const customers = await prisma.customer.findMany({
      where: {
        OR: [
          { discordUserId: { contains: cleanQuery } },
          { username: { contains: cleanQuery } },
        ],
      },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        tokens: true,
      },
      take: 20,
    });

    return customers.map((c) => this.toCustomerProfile(c, c.payments, c.tokens));
  }

  /**
   * Registers a New API Token identifier for a customer.
   * STRICT ENFORCEMENT:
   * - One API Key / Token is strictly limited to exactly ONE model group.
   * - Never store raw plaintext token secret; store only token identifier.
   */
  public async recordCustomerToken(params: {
    discordUserId: string;
    groupId: string;
    tokenIdentifier: string;
    quotaCny: Decimal | number | string;
    status?: string;
  }) {
    const prisma = getPrismaClient();

    // 1. Strict One Group Per Key Rule Validation
    const validGroups = Object.values(MODEL_GROUPS) as string[];
    const normalizedGroup = params.groupId.trim();

    if (normalizedGroup.includes(',') || !validGroups.includes(normalizedGroup)) {
      throw new Error(
        `Strict Rule Violation: One API Key / Token can only be assigned to exactly ONE Model Group (${validGroups.join(', ')}). Multiple groups on a single key are prohibited.`
      );
    }

    if (!params.tokenIdentifier || params.tokenIdentifier.trim() === '') {
      throw new Error('Token identifier must be provided.');
    }

    const quota = new Decimal(params.quotaCny);
    if (quota.isNegative()) {
      throw new Error('Token quota cannot be negative.');
    }

    const customer = await prisma.customer.findUnique({
      where: { discordUserId: params.discordUserId },
    });

    if (!customer) {
      throw new CustomerNotFoundError(params.discordUserId);
    }

    // 2. Insert Token Record
    const tokenRecord = await prisma.customerTokenRecord.create({
      data: {
        customerId: customer.id,
        groupId: normalizedGroup,
        tokenIdentifier: params.tokenIdentifier.trim(),
        quotaCny: quota.toFixed(2),
        status: params.status || KEY_STATUS.ACTIVE,
      },
    });

    // 3. Ensure Customer has group assignment
    await this.assignModelGroup(params.discordUserId, normalizedGroup);

    return tokenRecord;
  }

  /**
   * Retrieves all New API token records for a customer.
   */
  public async getCustomerTokens(discordUserId: string) {
    const prisma = getPrismaClient();
    const customer = await prisma.customer.findUnique({
      where: { discordUserId },
      include: { tokens: true },
    });

    if (!customer) {
      throw new CustomerNotFoundError(discordUserId);
    }

    return customer.tokens;
  }

  /**
   * Updates status of a New API token (ACTIVE, DISABLED, EXHAUSTED).
   */
  public async updateTokenStatus(tokenIdentifier: string, status: string) {
    const prisma = getPrismaClient();
    return await prisma.customerTokenRecord.update({
      where: { tokenIdentifier },
      data: { status },
    });
  }

  /**
   * Formats DB record into CustomerProfile with optional token records.
   */
  private toCustomerProfile(
    customer: {
      username: string;
      discordUserId: string;
      nextaiApiKeyHash: string | null;
      balance: Decimal | any;
      balanceCurrency: string;
      keyStatus: string;
    },
    payments: Array<{
      id: string;
      packageId: string;
      expectedAmountThb: Decimal | any;
      verifiedAmountThb: Decimal | any | null;
      paymentStatus: string;
      approvedAt: Date | null;
      createdAt: Date;
    }> = [],
    tokens: Array<{
      id: string;
      groupId: string;
      tokenIdentifier: string;
      quotaCny: Decimal | any;
      status: string;
      createdAt: Date;
    }> = []
  ): CustomerProfile {
    const balanceNum = new Decimal(customer.balance.toString()).toFixed(2);
    const balanceDisplay = `¥${balanceNum} ${customer.balanceCurrency}`;

    let apiKeyDisplay = 'NONE';
    if (customer.nextaiApiKeyHash) {
      apiKeyDisplay = `CONFIGURED (${customer.nextaiApiKeyHash.slice(0, 8)}...)`;
    }

    const paymentHistory: PaymentSummary[] = payments.map((p) => ({
      id: p.id,
      packageId: p.packageId,
      expectedAmountThb: new Decimal(p.expectedAmountThb.toString()).toFixed(2),
      verifiedAmountThb: p.verifiedAmountThb ? new Decimal(p.verifiedAmountThb.toString()).toFixed(2) : null,
      paymentStatus: p.paymentStatus,
      approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    }));

    const profile: CustomerProfile = {
      username: customer.username,
      userId: customer.discordUserId,
      apiKey: apiKeyDisplay,
      balance: balanceDisplay,
      keyStatus: customer.keyStatus as KeyStatus,
      paymentHistory,
    };

    if (tokens && tokens.length > 0) {
      profile.tokens = tokens.map((t) => ({
        id: t.id,
        groupId: t.groupId,
        tokenIdentifier: t.tokenIdentifier,
        quotaCny: new Decimal(t.quotaCny.toString()).toFixed(2),
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      }));
    }

    return profile;
  }
}
