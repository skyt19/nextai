import { Decimal } from 'decimal.js';
import { getPrismaClient } from '../db/client.js';
import { env } from '../config/env.js';
import {
  MODEL_GROUPS,
  NEWAPI_GROUP_MAP,
  NEWAPI_QUOTA_PER_USD,
  DEFAULT_NEWAPI_USD_EXCHANGE_RATE,
  NEWAPI_GROUP_MODELS,
  PROVISIONING_STATUS,
  ProvisioningStatus,
  ModelGroupId,
  KEY_STATUS,
  PAYMENT_STATUS,
} from '../config/constants.js';
import { CryptoService } from './crypto.service.js';
import { ModelCatalogService } from './catalog.service.js';
import {
  NewApiManagementService,
  NewApiTimeoutError,
  NewApiTokenItem,
} from './newapi-management.service.js';
import { BotEmbeds } from '../bot/ui/embeds.js';

export class TokenProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenProvisioningError';
  }
}

export class DuplicateProvisioningError extends TokenProvisioningError {
  constructor(message: string = 'A token provisioning operation is already in-flight for this customer and group.') {
    super(message);
    this.name = 'DuplicateProvisioningError';
  }
}

export class PlaintextKeyUnavailableError extends TokenProvisioningError {
  constructor(message: string = 'Token exists in New API but its plaintext key is unavailable. Admin reconciliation required.') {
    super(message);
    this.name = 'PlaintextKeyUnavailableError';
  }
}

export interface ProvisionResult {
  tokenRecord: any;
  plainTextKey?: string;
  isNewToken: boolean;
  requiresAdminReconciliation?: boolean;
}

export interface IssueManualTokenInput {
  groupId: ModelGroupId | string;
  requests: number;
  discordUserId?: string;
  username?: string;
  markup?: number;
  customTokenName?: string;
}

export interface IssueManualTokenResult {
  plainTextKey: string;
  tokenName: string;
  groupId: string;
  groupDisplayName: string;
  requests: number;
  baseCostCny: number;
  markup: number;
  quotaCny: Decimal;
  quotaUnits: number;
  newApiTokenId?: number;
  allowedModels: string[];
  gatewayUrl: string;
  discordUserId: string;
  username: string;
}

export class TokenProvisioningService {
  private static inFlightLocks = new Set<string>();

  constructor(
    private readonly newApiService: NewApiManagementService = new NewApiManagementService(),
    private readonly catalogService: ModelCatalogService = new ModelCatalogService()
  ) {}

  /**
   * Formats token name according to specification:
   * [NextAI Group] - [Discord ID] - [Discord Username]
   * Example: NxG1 - 791637707318755368 - shiina.chan
   */
  public formatTokenName(groupId: string, discordUserId: string, username: string): string {
    return `${groupId} - ${discordUserId} - ${username.trim()}`;
  }

  /**
   * Maps NextAI model group ID (NxG1, NxGE, NxGC) to New API Group name.
   */
  public mapNextAiGroupToNewApi(groupId: string): string {
    const mapped = NEWAPI_GROUP_MAP[groupId as ModelGroupId];
    if (!mapped) {
      throw new TokenProvisioningError(`Invalid or unmapped NextAI Group ID: ${groupId}`);
    }
    return mapped;
  }

  /**
   * Converts customer quota CNY to New API quota units.
   * Strictly enforces:
   * - New API uses 500,000 quota units per USD
   * - USDExchangeRate default 6.7 (CNY display type)
   * - Formula: quotaUnits = Math.round((customerQuotaCny / usdExchangeRate) * 500,000)
   * Expected:
   * - NxG1 ¥5.00 CNY  -> 373,134 units
   * - NxGE ¥9.00 CNY  -> 671,642 units
   * - NxGC ¥7.50 CNY  -> 559,701 units
   */
  public calculateQuotaUnits(
    customerQuotaCny: Decimal | string | number,
    usdExchangeRate: number = env.NEWAPI_USD_EXCHANGE_RATE || DEFAULT_NEWAPI_USD_EXCHANGE_RATE
  ): number {
    const quotaDecimal = new Decimal(customerQuotaCny);
    if (quotaDecimal.isNegative() || quotaDecimal.isZero()) {
      throw new TokenProvisioningError('Customer quota CNY must be a positive number.');
    }
    if (!usdExchangeRate || usdExchangeRate <= 0) {
      throw new TokenProvisioningError('Invalid USDExchangeRate for New API quota conversion.');
    }

    const unitsDecimal = quotaDecimal
      .div(usdExchangeRate)
      .mul(NEWAPI_QUOTA_PER_USD)
      .round();

    const units = unitsDecimal.toNumber();
    if (!Number.isSafeInteger(units) || units <= 0) {
      throw new TokenProvisioningError(
        `Calculated quota units is not a safe positive integer: ${units}`
      );
    }

    return units;
  }

  /**
   * Retrieves comma-separated allowlisted model IDs for a given group.
   * Uses actual enabled model IDs configured in New API channels for each group.
   * Guarantees non-empty allowlist when restrictions are enabled.
   */
  public getAllowedModelsForGroup(groupId: string): string {
    const groupModels = NEWAPI_GROUP_MODELS[groupId as ModelGroupId];
    if (groupModels && groupModels.length > 0) {
      return groupModels.join(',');
    }

    const models = this.catalogService.getModelsForGroups([groupId], false);
    const modelIds = models.map((m) => m.originalBearlabModelId || m.publicModelId);
    if (modelIds.length === 0) {
      throw new TokenProvisioningError(
        `No allowlisted models found for group ${groupId}. Allowlist cannot be empty.`
      );
    }
    return modelIds.join(',');
  }

  /**
   * Provisions a New API token for an approved payment.
   * Idempotent & Concurrency Safe:
   * - In-flight lock on customerId:groupId
   * - Searches New API before creation to prevent duplicates
   * - Transitions to UNKNOWN on ambiguous timeout
   * - Encrypts plaintext secret with AES-256-GCM for temporary delivery storage
   */
  public async provisionTokenForPayment(paymentId: string): Promise<ProvisionResult> {
    const prisma = getPrismaClient();

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        customer: true,
        package: true,
      },
    });

    if (!payment) {
      throw new TokenProvisioningError(`Payment not found: ${paymentId}`);
    }

    const { customer, package: pkg } = payment;
    const groupId = pkg.groupId;
    const lockKey = `${customer.id}:${groupId}`;

    if (TokenProvisioningService.inFlightLocks.has(lockKey)) {
      throw new DuplicateProvisioningError(
        `Provisioning lock active for customer ${customer.discordUserId} and group ${groupId}`
      );
    }

    TokenProvisioningService.inFlightLocks.add(lockKey);

    try {
      // 1. Snapshot customer quota CNY
      const snapshot = JSON.parse(payment.calculationSnapshot);
      const customerQuotaCny =
        snapshot.customer_quota_cny ||
        snapshot.display_reference_value_cny ||
        snapshot.assigned_upstream_quota_cny ||
        snapshot.assigned_quota_cny;

      if (!customerQuotaCny) {
        throw new TokenProvisioningError('Missing customer_quota_cny in payment calculation snapshot.');
      }

      const quotaUnits = this.calculateQuotaUnits(customerQuotaCny);
      const expectedTokenName = this.formatTokenName(groupId, customer.discordUserId, customer.username);
      const newApiGroup = this.mapNextAiGroupToNewApi(groupId);
      const allowedModels = this.getAllowedModelsForGroup(groupId);

      // 2. Check existing DB token record (1 customer has at most 1 token per group)
      let tokenRecord = await prisma.customerTokenRecord.findUnique({
        where: {
          customerId_groupId: {
            customerId: customer.id,
            groupId,
          },
        },
      });

      // Idempotency: If already delivered for this payment, return immediately
      if (tokenRecord && tokenRecord.paymentId === payment.id && tokenRecord.provisioningStatus === PROVISIONING_STATUS.DELIVERED) {
        return {
          tokenRecord,
          isNewToken: false,
        };
      }

      // If record exists and is PROVISIONED with encrypted secret ready to deliver
      if (tokenRecord && tokenRecord.encryptedKey && tokenRecord.provisioningStatus === PROVISIONING_STATUS.PROVISIONED) {
        return {
          tokenRecord,
          isNewToken: false,
        };
      }

      // Upsert record into PENDING state before contacting New API
      if (!tokenRecord) {
        tokenRecord = await prisma.customerTokenRecord.create({
          data: {
            customerId: customer.id,
            groupId,
            tokenIdentifier: `temp-${Date.now()}-${customer.id.slice(0, 8)}`,
            tokenName: expectedTokenName,
            quotaCny: new Decimal(customerQuotaCny).toFixed(2),
            status: KEY_STATUS.ACTIVE,
            provisioningStatus: PROVISIONING_STATUS.PENDING,
            paymentId: payment.id,
          },
        });
      } else {
        tokenRecord = await prisma.customerTokenRecord.update({
          where: { id: tokenRecord.id },
          data: {
            tokenName: expectedTokenName,
            quotaCny: new Decimal(customerQuotaCny).toFixed(2),
            provisioningStatus: PROVISIONING_STATUS.PROVISIONING,
            paymentId: payment.id,
            lastError: null,
          },
        });
      }

      // 3. Search New API first for existing token with exact name to prevent duplication
      let existingNewApiToken: NewApiTokenItem | undefined;
      try {
        const found = await this.newApiService.searchTokens(expectedTokenName);
        existingNewApiToken = found.find((t) => t.name === expectedTokenName);
      } catch (err: any) {
        // If search fails due to connectivity, do not proceed with blind create
        await prisma.customerTokenRecord.update({
          where: { id: tokenRecord.id },
          data: {
            provisioningStatus: PROVISIONING_STATUS.FAILED,
            lastError: `Failed to search existing New API tokens: ${err.message}`,
          },
        });
        throw err;
      }

      if (existingNewApiToken) {
        // Token exists in New API. New API masks token key (e.g. sk-****).
        // Check if we already have the plaintext secret encrypted in our DB
        if (tokenRecord.keyHash && tokenRecord.encryptedKey) {
          // We have the encrypted key stored from previous provision
          tokenRecord = await prisma.customerTokenRecord.update({
            where: { id: tokenRecord.id },
            data: {
              newApiTokenId: existingNewApiToken.id,
              tokenIdentifier: CryptoService.maskApiKey(existingNewApiToken.key),
              provisioningStatus: PROVISIONING_STATUS.PROVISIONED,
            },
          });
          return {
            tokenRecord,
            isNewToken: false,
          };
        }

        // Plaintext key is NOT available because New API masks it and DB does not have it.
        // DO NOT silently create a duplicate!
        tokenRecord = await prisma.customerTokenRecord.update({
          where: { id: tokenRecord.id },
          data: {
            newApiTokenId: existingNewApiToken.id,
            tokenIdentifier: existingNewApiToken.key,
            provisioningStatus: PROVISIONING_STATUS.UNKNOWN,
            lastError:
              'Existing token found in New API but plaintext key is unavailable. Admin reconciliation required.',
          },
        });

        return {
          tokenRecord,
          isNewToken: false,
          requiresAdminReconciliation: true,
        };
      }

      // 4. Token does not exist in New API; create it
      let createResult;
      try {
        createResult = await this.newApiService.createToken({
          name: expectedTokenName,
          remain_quota: quotaUnits,
          expired_time: -1,
          unlimited_quota: false,
          model_limits_enabled: allowedModels.length > 0,
          models: allowedModels,
          group: newApiGroup,
          allow_ips: '',
        });
      } catch (err: any) {
        if (err instanceof NewApiTimeoutError) {
          // Ambiguous timeout: mark state as UNKNOWN
          tokenRecord = await prisma.customerTokenRecord.update({
            where: { id: tokenRecord.id },
            data: {
              provisioningStatus: PROVISIONING_STATUS.UNKNOWN,
              lastError: `Create request timed out: ${err.message}. Reconciliation needed before retry.`,
            },
          });
          throw err;
        }

        tokenRecord = await prisma.customerTokenRecord.update({
          where: { id: tokenRecord.id },
          data: {
            provisioningStatus: PROVISIONING_STATUS.FAILED,
            lastError: err.message,
          },
        });
        throw err;
      }

      // 5. Successful creation in New API!
      // Plaintext key is available only now.
      const plainTextKey = createResult.key;
      const keyHash = CryptoService.hashApiKey(plainTextKey);
      const maskedIdentifier = CryptoService.maskApiKey(plainTextKey);
      const encrypted = CryptoService.encryptSecret(plainTextKey, env.ENCRYPTION_SECRET);

      let newApiTokenId = createResult.id;
      if (!newApiTokenId) {
        try {
          const searchAfter = await this.newApiService.searchTokens(expectedTokenName);
          const matched = searchAfter.find((t) => t.name === expectedTokenName);
          if (matched) {
            newApiTokenId = matched.id;
          }
        } catch {
          // Non-blocking lookup
        }
      }

      tokenRecord = await prisma.customerTokenRecord.update({
        where: { id: tokenRecord.id },
        data: {
          tokenIdentifier: maskedIdentifier,
          tokenName: expectedTokenName,
          newApiTokenId: newApiTokenId ?? null,
          keyHash,
          encryptedKey: encrypted.encrypted,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          provisioningStatus: PROVISIONING_STATUS.PROVISIONED,
          lastError: null,
        },
      });

      return {
        tokenRecord,
        plainTextKey,
        isNewToken: true,
      };
    } finally {
      TokenProvisioningService.inFlightLocks.delete(lockKey);
    }
  }

  /**
   * Delivers token to Discord Ticket channel.
   * STRICT SECURITY RULES:
   * - Decrypts temporary secret using AES-256-GCM
   * - Sends embed to ticket channel
   * - Confirms message delivery before deleting encryptedKey from DB
   * - If delivery fails, retains encryptedKey and marks DELIVERY_FAILED for admin retry
   */
  public async deliverTokenToDiscord(
    tokenRecordId: string,
    ticketChannel: { send: (msg: any) => Promise<any> }
  ): Promise<{ delivered: boolean; alreadyDelivered?: boolean }> {
    const prisma = getPrismaClient();

    const tokenRecord = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecordId },
      include: {
        customer: true,
      },
    });

    if (!tokenRecord) {
      throw new TokenProvisioningError(`Token record not found: ${tokenRecordId}`);
    }

    if (tokenRecord.provisioningStatus === PROVISIONING_STATUS.DELIVERED) {
      return { delivered: true, alreadyDelivered: true };
    }

    if (!tokenRecord.encryptedKey || !tokenRecord.iv || !tokenRecord.authTag) {
      throw new PlaintextKeyUnavailableError(
        'Encrypted key is missing from database. Cannot decrypt key for delivery.'
      );
    }

    // Decrypt key
    let plainTextKey: string;
    try {
      plainTextKey = CryptoService.decryptSecret(
        tokenRecord.encryptedKey,
        tokenRecord.iv,
        tokenRecord.authTag,
        env.ENCRYPTION_SECRET
      );
    } catch (err: any) {
      await prisma.customerTokenRecord.update({
        where: { id: tokenRecord.id },
        data: {
          provisioningStatus: PROVISIONING_STATUS.DELIVERY_FAILED,
          lastError: `Decryption failed: ${err.message}`,
        },
      });
      throw err;
    }

    // Fetch package details for formatting
    let packageName = `SealAPI [${tokenRecord.groupId}]`;
    if (tokenRecord.paymentId) {
      const payment = await prisma.payment.findUnique({
        where: { id: tokenRecord.paymentId },
        include: { package: true },
      });
      if (payment?.package) {
        packageName = payment.package.name;
      }
    }

    const models = this.catalogService
      .getModelsForGroups([tokenRecord.groupId], false)
      .map((m) => m.publicModelId);

    if (!plainTextKey || !plainTextKey.startsWith('sk-')) {
      throw new TokenProvisioningError('Invalid decrypted customer key format.');
    }

    const embed = BotEmbeds.paymentApproved({
      packageName,
      groupId: tokenRecord.groupId,
      assignedQuotaCny: tokenRecord.quotaCny.toString(),
      plainTextApiKey: plainTextKey,
      gatewayUrl: env.NEWAPI_PUBLIC_ENDPOINT,
      allowedModels: models,
    });

    const description = embed.data.description || '';
    if (!description.includes(plainTextKey)) {
      throw new TokenProvisioningError('Discord payload does not contain customer key in embed description.');
    }

    try {
      await ticketChannel.send({
        content: `<@${tokenRecord.customer.discordUserId}>`,
        embeds: [embed],
      });

      // Confirm delivery: WIPE encrypted key permanently from database
      await prisma.customerTokenRecord.update({
        where: { id: tokenRecord.id },
        data: {
          encryptedKey: null,
          iv: null,
          authTag: null,
          provisioningStatus: PROVISIONING_STATUS.DELIVERED,
          deliveredAt: new Date(),
          lastError: null,
        },
      });

      return { delivered: true };
    } catch (err: any) {
      // Retain encryptedKey for retry and mark DELIVERY_FAILED
      await prisma.customerTokenRecord.update({
        where: { id: tokenRecord.id },
        data: {
          provisioningStatus: PROVISIONING_STATUS.DELIVERY_FAILED,
          lastError: `Discord dispatch failed: ${err.message}`,
        },
      });
      throw err;
    }
  }

  /**
   * Reissues a replacement token for an existing approved payment without:
   * - Creating a new payment record
   * - Re-crediting customer balance
   * - Duplicating provider funding
   * Safely reuses and updates the existing CustomerTokenRecord.
   */
  public async reissueTokenForApprovedPayment(
    paymentId: string,
    adminDiscordId: string = 'system-admin'
  ): Promise<ProvisionResult> {
    const prisma = getPrismaClient();

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        customer: true,
        package: true,
      },
    });

    if (!payment) {
      throw new TokenProvisioningError(`Payment not found: ${paymentId}`);
    }

    if (
      payment.paymentStatus !== PAYMENT_STATUS.APPROVED &&
      payment.paymentStatus !== PAYMENT_STATUS.COMPLETED
    ) {
      throw new TokenProvisioningError(
        `Cannot reissue token for non-approved payment '${payment.paymentStatus}'.`
      );
    }

    const { customer, package: pkg } = payment;
    const groupId = pkg.groupId;

    // Reset status of existing token record so provisionTokenForPayment can proceed cleanly
    await prisma.customerTokenRecord.updateMany({
      where: {
        customerId: customer.id,
        groupId,
      },
      data: {
        provisioningStatus: PROVISIONING_STATUS.PENDING,
        lastError: null,
      },
    });

    const result = await this.provisionTokenForPayment(paymentId);

    await prisma.auditLog.create({
      data: {
        actorDiscordId: adminDiscordId,
        action: 'ADMIN_REISSUE_TOKEN_FOR_APPROVED_PAYMENT',
        targetType: 'CUSTOMER_TOKEN_RECORD',
        targetId: result.tokenRecord.id,
        details: JSON.stringify({
          paymentId,
          status: result.tokenRecord.provisioningStatus,
          isNewToken: result.isNewToken,
        }),
      },
    });

    return result;
  }

  // ==========================================
  // TASK 8: ADMIN OPERATIONS & AUDIT LOGS
  // ==========================================

  /**
   * Safe administrative retry for token provisioning.
   * Guarantees:
   * - Does NOT duplicate payment quota credit
   * - Reconciles before creating
   * - Logs audit event
   */
  public async retryProvisioning(tokenRecordId: string, adminDiscordId: string): Promise<ProvisionResult> {
    const prisma = getPrismaClient();

    const record = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecordId },
    });

    if (!record) {
      throw new TokenProvisioningError(`Token record not found: ${tokenRecordId}`);
    }

    if (record.provisioningStatus === PROVISIONING_STATUS.DELIVERED) {
      throw new TokenProvisioningError('Token has already been delivered to customer.');
    }

    if (!record.paymentId) {
      throw new TokenProvisioningError('Token record is not associated with any payment.');
    }

    const result = await this.provisionTokenForPayment(record.paymentId);

    await prisma.auditLog.create({
      data: {
        actorDiscordId: adminDiscordId,
        action: 'ADMIN_RETRY_TOKEN_PROVISIONING',
        targetType: 'CUSTOMER_TOKEN_RECORD',
        targetId: tokenRecordId,
        details: JSON.stringify({
          status: result.tokenRecord.provisioningStatus,
          isNewToken: result.isNewToken,
        }),
      },
    });

    return result;
  }

  /**
   * Inspects detailed provisioning and New API status.
   */
  public async inspectStatus(tokenRecordId: string) {
    const prisma = getPrismaClient();

    const record = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecordId },
      include: { customer: true },
    });

    if (!record) {
      throw new TokenProvisioningError(`Token record not found: ${tokenRecordId}`);
    }

    let newApiTokenInfo: NewApiTokenItem | null = null;
    if (record.newApiTokenId) {
      try {
        newApiTokenInfo = await this.newApiService.getToken(record.newApiTokenId);
      } catch {
        // Fallback or unavailable
      }
    } else if (record.tokenName) {
      try {
        const found = await this.newApiService.searchTokens(record.tokenName);
        newApiTokenInfo = found.find((t) => t.name === record.tokenName) ?? null;
      } catch {
        // Fallback
      }
    }

    return {
      tokenRecord: record,
      newApiTokenInfo,
      isEncryptedKeyRetained: Boolean(record.encryptedKey),
    };
  }

  /**
   * Disables customer token in both New API and NextAI database.
   */
  public async disableToken(tokenRecordId: string, adminDiscordId: string): Promise<void> {
    const prisma = getPrismaClient();

    const record = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecordId },
    });

    if (!record) {
      throw new TokenProvisioningError(`Token record not found: ${tokenRecordId}`);
    }

    if (record.newApiTokenId) {
      await this.newApiService.disableToken(record.newApiTokenId);
    }

    await prisma.customerTokenRecord.update({
      where: { id: tokenRecordId },
      data: { status: KEY_STATUS.DISABLED },
    });

    await prisma.auditLog.create({
      data: {
        actorDiscordId: adminDiscordId,
        action: 'ADMIN_DISABLE_CUSTOMER_TOKEN',
        targetType: 'CUSTOMER_TOKEN_RECORD',
        targetId: tokenRecordId,
        details: JSON.stringify({ previousStatus: record.status }),
      },
    });
  }

  /**
   * Reconciles token state between NextAI database and New API gateway.
   */
  public async reconcileToken(tokenRecordId: string, adminDiscordId: string) {
    const prisma = getPrismaClient();

    const record = await prisma.customerTokenRecord.findUnique({
      where: { id: tokenRecordId },
    });

    if (!record) {
      throw new TokenProvisioningError(`Token record not found: ${tokenRecordId}`);
    }

    if (!record.tokenName) {
      throw new TokenProvisioningError('Token record has no tokenName for reconciliation.');
    }

    const found = await this.newApiService.searchTokens(record.tokenName);
    const matched = found.find((t) => t.name === record.tokenName);

    let updatedRecord = record;
    if (matched) {
      const nextStatus =
        record.provisioningStatus === PROVISIONING_STATUS.UNKNOWN ||
        record.provisioningStatus === PROVISIONING_STATUS.FAILED
          ? record.encryptedKey
            ? PROVISIONING_STATUS.PROVISIONED
            : PROVISIONING_STATUS.UNKNOWN
          : record.provisioningStatus;

      updatedRecord = await prisma.customerTokenRecord.update({
        where: { id: tokenRecordId },
        data: {
          newApiTokenId: matched.id,
          provisioningStatus: nextStatus,
          lastError: record.encryptedKey
            ? null
            : 'Matched token in New API, but plaintext secret is masked. Cannot deliver automatically.',
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        actorDiscordId: adminDiscordId,
        action: 'ADMIN_RECONCILE_CUSTOMER_TOKEN',
        targetType: 'CUSTOMER_TOKEN_RECORD',
        targetId: tokenRecordId,
        details: JSON.stringify({
          matchedInNewApi: Boolean(matched),
          newApiTokenId: matched?.id,
          finalStatus: updatedRecord.provisioningStatus,
        }),
      },
    });

    return updatedRecord;
  }

  /**
   * Retries Discord delivery without creating a new token in New API.
   */
  public async retryDelivery(
    tokenRecordId: string,
    adminDiscordId: string,
    ticketChannel: { send: (msg: any) => Promise<any> }
  ) {
    const prisma = getPrismaClient();

    const deliveryResult = await this.deliverTokenToDiscord(tokenRecordId, ticketChannel);

    await prisma.auditLog.create({
      data: {
        actorDiscordId: adminDiscordId,
        action: 'ADMIN_RETRY_TOKEN_DELIVERY',
        targetType: 'CUSTOMER_TOKEN_RECORD',
        targetId: tokenRecordId,
        details: JSON.stringify(deliveryResult),
      },
    });

    return deliveryResult;
  }

  /**
   * Manually issues an API Key for a customer based on requested requests count and standard cost formula.
   * Quota formula: Quota (CNY) = Base Cost × Markup × Requests
   */
  public async issueManualToken(input: IssueManualTokenInput): Promise<IssueManualTokenResult> {
    const prisma = getPrismaClient();
    const groupId = input.groupId as ModelGroupId;

    if (![MODEL_GROUPS.GROUP_A, MODEL_GROUPS.GROUP_E, MODEL_GROUPS.GROUP_CLAUDE].includes(groupId)) {
      throw new TokenProvisioningError(`Invalid group ID: ${groupId}. Must be NxG1, NxGE, or NxGC.`);
    }

    if (!input.requests || input.requests <= 0) {
      throw new TokenProvisioningError('Number of requests must be a positive integer.');
    }

    const baseCostCny = groupId === MODEL_GROUPS.GROUP_A ? 0.02 : 0.03;
    const defaultMarkup = groupId === MODEL_GROUPS.GROUP_E ? 3.0 : 2.5;
    const effectiveMarkup = input.markup !== undefined && input.markup > 0 ? input.markup : defaultMarkup;

    // Quota formula: Base Cost × Markup × Requests
    const quotaCny = new Decimal(baseCostCny).mul(effectiveMarkup).mul(input.requests);
    const quotaUnits = this.calculateQuotaUnits(quotaCny);

    const discordUserId = input.discordUserId?.trim() || `manual-${Date.now()}`;
    const username = input.username?.trim() || `user-${discordUserId.slice(-4)}`;

    const tokenName = input.customTokenName?.trim() || this.formatTokenName(groupId, discordUserId, username);
    const newApiGroup = this.mapNextAiGroupToNewApi(groupId);
    const allowedModelsStr = this.getAllowedModelsForGroup(groupId);
    const allowedModels = allowedModelsStr.split(',').map((m) => m.trim()).filter(Boolean);

    // Call New API to create token
    const createResult = await this.newApiService.createToken({
      name: tokenName,
      remain_quota: quotaUnits,
      expired_time: -1,
      unlimited_quota: false,
      model_limits_enabled: allowedModels.length > 0,
      models: allowedModelsStr,
      group: newApiGroup,
      allow_ips: '',
    });

    const plainTextKey = createResult.key;
    const keyHash = CryptoService.hashApiKey(plainTextKey);
    const maskedIdentifier = CryptoService.maskApiKey(plainTextKey);
    const encrypted = CryptoService.encryptSecret(plainTextKey, env.ENCRYPTION_SECRET);

    // 1. Upsert Customer in DB
    let customer = await prisma.customer.findUnique({
      where: { discordUserId },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          discordUserId,
          username,
          keyStatus: KEY_STATUS.ACTIVE,
        },
      });
    }

    // 2. Upsert CustomerModelGroup
    await prisma.customerModelGroup.upsert({
      where: {
        customerId_groupId: {
          customerId: customer.id,
          groupId,
        },
      },
      update: {},
      create: {
        customerId: customer.id,
        groupId,
      },
    });

    const safeTokenIdentifier = createResult.id
      ? `token-${createResult.id}-${customer.id.slice(0, 6)}`
      : `${maskedIdentifier}-${customer.id.slice(0, 8)}`;

    // 3. Upsert CustomerTokenRecord
    await prisma.customerTokenRecord.upsert({
      where: {
        customerId_groupId: {
          customerId: customer.id,
          groupId,
        },
      },
      update: {
        tokenIdentifier: safeTokenIdentifier,
        tokenName,
        newApiTokenId: createResult.id ?? null,
        quotaCny: quotaCny.toFixed(4),
        status: KEY_STATUS.ACTIVE,
        provisioningStatus: PROVISIONING_STATUS.DELIVERED,
        keyHash,
        encryptedKey: encrypted.encrypted,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        deliveredAt: new Date(),
        lastError: null,
      },
      create: {
        customerId: customer.id,
        groupId,
        tokenIdentifier: safeTokenIdentifier,
        tokenName,
        newApiTokenId: createResult.id ?? null,
        quotaCny: quotaCny.toFixed(4),
        status: KEY_STATUS.ACTIVE,
        provisioningStatus: PROVISIONING_STATUS.DELIVERED,
        keyHash,
        encryptedKey: encrypted.encrypted,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        deliveredAt: new Date(),
      },
    });

    // 4. Audit Log
    await prisma.auditLog.create({
      data: {
        actorDiscordId: discordUserId,
        action: 'MANUAL_TOKEN_ISSUED',
        targetType: 'TOKEN',
        targetId: createResult.id ? String(createResult.id) : maskedIdentifier,
        details: JSON.stringify({
          groupId,
          requests: input.requests,
          baseCostCny,
          markup: effectiveMarkup,
          quotaCny: quotaCny.toFixed(4),
          quotaUnits,
          tokenName,
        }),
      },
    });

    let groupDisplayName = `Group Claude [NxGC]`;
    if (groupId === MODEL_GROUPS.GROUP_A) {
      groupDisplayName = 'Group A [NxG1] (Gemini Flash & Fast)';
    } else if (groupId === MODEL_GROUPS.GROUP_E) {
      groupDisplayName = 'Group E [NxGE] (Gemini Pro & Search)';
    } else if (groupId === MODEL_GROUPS.GROUP_CLAUDE) {
      groupDisplayName = 'Group Claude [NxGC] (Claude 3.5/3.7 & Opus)';
    }

    const gatewayUrl = env.NEWAPI_PUBLIC_ENDPOINT || 'https://next-newapi.onrender.com/v1';

    return {
      plainTextKey,
      tokenName,
      groupId,
      groupDisplayName,
      requests: input.requests,
      baseCostCny,
      markup: effectiveMarkup,
      quotaCny,
      quotaUnits,
      newApiTokenId: createResult.id,
      allowedModels,
      gatewayUrl,
      discordUserId,
      username,
    };
  }
}
