import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { getPrismaClient } from '../db/client.js';
import { PAYMENT_STATUS, PaymentStatus, MODEL_GROUPS, ModelGroupId } from '../config/constants.js';
import { CustomerService } from './customer.service.js';
import { CalculationSnapshot, QuotaCalculator } from './calculator.service.js';
import { FrankfurterService } from './frankfurter.service.js';
import { FundingService } from './funding.service.js';
import { TokenProvisioningService } from './token-provisioning.service.js';

export class PaymentError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

export class DuplicateSlipError extends PaymentError {
  constructor(public readonly fileHash: string) {
    super(
      `Payment slip with SHA-256 hash '${fileHash}' has already been submitted. Duplicate slips are rejected.`,
      'DUPLICATE_SLIP'
    );
  }
}

export class InvalidSlipFormatError extends PaymentError {
  constructor(mimeType: string) {
    super(`Unsupported slip format '${mimeType}'. Allowed formats: PNG, JPG, JPEG, WEBP.`, 'INVALID_SLIP_FORMAT');
  }
}

export class SlipSizeExceededError extends PaymentError {
  constructor(sizeBytes: number, maxBytes: number) {
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(0);
    super(`Slip file size (${sizeMb} MB) exceeds maximum allowed limit (${maxMb} MB).`, 'SLIP_SIZE_EXCEEDED');
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor(paymentId: string) {
    super(`Payment record '${paymentId}' not found.`, 'PAYMENT_NOT_FOUND');
  }
}

export class PaymentStateError extends PaymentError {
  constructor(message: string) {
    super(message, 'INVALID_PAYMENT_STATE');
  }
}

export interface SubmitSlipInput {
  paymentId: string;
  fileBuffer: Buffer;
  originalFilename: string;
  mimeType: string;
  storageDir?: string;
  maxSizeBytes?: number;
}

export class PaymentService {
  private readonly customerService: CustomerService;
  private readonly frankfurterService: FrankfurterService;
  private readonly tokenProvisioningService: TokenProvisioningService;

  constructor(
    customerService?: CustomerService,
    frankfurterService?: FrankfurterService,
    tokenProvisioningService?: TokenProvisioningService
  ) {
    this.customerService = customerService || new CustomerService();
    this.frankfurterService = frankfurterService || new FrankfurterService();
    this.tokenProvisioningService = tokenProvisioningService || new TokenProvisioningService();
  }

  /**
   * Finds or creates a package definition matching the selected model group and reference request quantity.
   * Internal reference models and markups follow the Master Specification:
   * - NxG1: 0.020 CNY/request (gemini-3-1-pro-high), markup 2.5x
   * - NxGE: 0.030 CNY/request (gemini-2.5-pro), markup 3.0x
   * - NxGC: 0.030 CNY/request (Claude), markup 2.5x
   */
  public async findOrCreatePackageForGroup(groupId: string, referenceRequests: number) {
    const prisma = getPrismaClient();

    const existing = await prisma.package.findFirst({
      where: {
        groupId,
        referenceRequests,
        enabled: true,
      },
    });

    if (existing) {
      return existing;
    }

    let referenceModelCostCny = '0.020';
    let markup = '2.5';
    let groupName = 'Group A';
    let referenceModelId = 'gemini-3-1-pro-high-nxg1';
    let sellingPriceThb = '51.00';
    let bufferCny = '0.0';

    if (groupId === MODEL_GROUPS.GROUP_E) {
      referenceModelCostCny = '0.030';
      markup = '3.0';
      groupName = 'Group E';
      referenceModelId = 'gemini-2-5-pro-nxge';
      sellingPriceThb = '90.00';
      bufferCny = '0.0';
    } else if (groupId === MODEL_GROUPS.GROUP_CLAUDE) {
      referenceModelCostCny = '0.030';
      markup = '2.5';
      groupName = 'Group Claude';
      referenceModelId = 'claude-opus-4-5-nxgc';
      sellingPriceThb = '75.00';
      bufferCny = '0.0';
    }

    return await prisma.package.create({
      data: {
        name: `${groupName} [${groupId}] — ${referenceRequests} Requests`,
        groupId,
        referenceModelId,
        referenceRequests,
        referenceModelCostCny,
        markup,
        sellingPriceThb,
        bufferCny,
        enabled: true,
      },
    });
  }

  /**
   * Initializes a pending payment in a Discord ticket channel.
   */
  public async createPendingPayment(params: {
    discordUserId: string;
    username: string;
    ticketChannelId: string;
    packageId: string;
  }) {
    const prisma = getPrismaClient();

    // 1. Ensure customer exists
    const { customerId } = await this.customerService.findOrCreateCustomer(
      params.discordUserId,
      params.username
    );

    // 2. Fetch package definition
    const pkg = await prisma.package.findUnique({
      where: { id: params.packageId },
    });

    if (!pkg || !pkg.enabled) {
      throw new PaymentError(`Package '${params.packageId}' is not found or is disabled.`, 'PACKAGE_DISABLED');
    }

    if (!pkg.sellingPriceThb || new Decimal(pkg.sellingPriceThb.toString()).lessThanOrEqualTo(0)) {
      throw new PaymentError(
        `Package '${params.packageId}' has no valid selling price configured.`,
        'INVALID_PACKAGE_PRICE'
      );
    }

    // 3. Retrieve exchange rate from Frankfurter service
    const rates = await this.frankfurterService.getRates();

    // 4. Calculate exact quota, pricing, and immutable snapshot using Decimal.js
    // Package selling price comes directly from the admin-configured package definition (e.g. 51.00 THB)
    const calculation = QuotaCalculator.calculate({
      groupId: pkg.groupId as any,
      referenceModelCostCny: pkg.referenceModelCostCny.toString(),
      referenceRequests: pkg.referenceRequests,
      packageSellingPriceThb: pkg.sellingPriceThb.toString(),
      cnyToThbRate: rates.rates.THB.toString(),
      exchangeRateDate: rates.rateDate,
      customMarkup: pkg.markup.toString(),
      bufferCny: pkg.bufferCny.toString(),
    });

    // 5. Create payment record
    const payment = await prisma.payment.create({
      data: {
        customerId,
        ticketChannelId: params.ticketChannelId,
        packageId: pkg.id,
        expectedAmountThb: calculation.finalPaymentAmountThb.toFixed(2),
        paymentStatus: PAYMENT_STATUS.PENDING_PAYMENT,
        calculationSnapshot: JSON.stringify(calculation.snapshot),
      },
      include: {
        package: true,
        customer: true,
      },
    });

    return {
      payment,
      calculation,
    };
  }

  /**
   * Handles payment slip submission inside a private Discord ticket.
   * Performs file validation, SHA-256 duplicate detection, local storage, and status transition.
   */
  public async submitPaymentSlip(input: SubmitSlipInput) {
    const prisma = getPrismaClient();

    // 1. Verify payment status
    const payment = await prisma.payment.findUnique({
      where: { id: input.paymentId },
    });

    if (!payment) {
      throw new PaymentNotFoundError(input.paymentId);
    }

    if (
      payment.paymentStatus !== PAYMENT_STATUS.PENDING_PAYMENT &&
      payment.paymentStatus !== PAYMENT_STATUS.REJECTED
    ) {
      throw new PaymentStateError(
        `Cannot submit slip for payment in status '${payment.paymentStatus}'.`
      );
    }

    // 2. Validate MIME type (PNG, JPG, JPEG, WEBP)
    const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowedMimes.includes(input.mimeType.toLowerCase())) {
      throw new InvalidSlipFormatError(input.mimeType);
    }

    // 3. Validate file size (default: 10 MB)
    const maxBytes = input.maxSizeBytes || 10 * 1024 * 1024;
    if (input.fileBuffer.length > maxBytes) {
      throw new SlipSizeExceededError(input.fileBuffer.length, maxBytes);
    }

    // 4. Calculate SHA-256 file hash
    const fileHash = crypto.createHash('sha256').update(input.fileBuffer).digest('hex');

    // 5. Duplicate slip detection
    const existingSlip = await prisma.paymentSlip.findUnique({
      where: { fileHash },
    });

    if (existingSlip) {
      throw new DuplicateSlipError(fileHash);
    }

    // 6. Save slip to private local directory (e.g. storage/slips/<fileHash>.<ext>)
    const storageDir = input.storageDir || './storage/slips';
    await fs.mkdir(storageDir, { recursive: true });

    // Derive file extension strictly from validated MIME type to prevent path traversal risks
    const safeExtMap: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/webp': '.webp',
    };
    const ext = safeExtMap[input.mimeType.toLowerCase()] || '.png';
    const filename = `${fileHash}${ext}`;
    const destinationPath = path.join(storageDir, filename);

    await fs.writeFile(destinationPath, input.fileBuffer);

    // 7. Record slip and transition payment state to UNDER_REVIEW
    const slip = await prisma.paymentSlip.create({
      data: {
        paymentId: payment.id,
        privateFileReference: destinationPath,
        fileHash,
        fileSizeBytes: input.fileBuffer.length,
        mimeType: input.mimeType,
      },
    });

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: PAYMENT_STATUS.UNDER_REVIEW,
        slipReference: destinationPath,
      },
      include: {
        customer: true,
        package: true,
        slips: true,
      },
    });

    return {
      payment: updatedPayment,
      slip,
    };
  }

  /**
   * Manual administrator approval.
   * IDEMPOTENT: Prevents duplicate approvals and safely credits quota reference.
   */
  public async approvePayment(params: {
    paymentId: string;
    reviewerDiscordId: string;
    verifiedAmountThb?: Decimal | string | number;
  }) {
    const prisma = getPrismaClient();

    const payment = await prisma.payment.findUnique({
      where: { id: params.paymentId },
      include: {
        customer: true,
        package: true,
      },
    });

    if (!payment) {
      throw new PaymentNotFoundError(params.paymentId);
    }

    // Idempotency check: If already approved, return without duplicating balance credit
    if (payment.paymentStatus === PAYMENT_STATUS.APPROVED || payment.paymentStatus === PAYMENT_STATUS.COMPLETED) {
      const profile = await this.customerService.getCustomerProfile(payment.customer.discordUserId);
      const tokenRecord = await prisma.customerTokenRecord.findUnique({
        where: {
          customerId_groupId: {
            customerId: payment.customer.id,
            groupId: payment.package.groupId,
          },
        },
      });
      return {
        payment,
        customerProfile: profile,
        tokenRecord,
        alreadyProcessed: true,
      };
    }

    if (
      payment.paymentStatus !== PAYMENT_STATUS.UNDER_REVIEW &&
      payment.paymentStatus !== PAYMENT_STATUS.SLIP_SUBMITTED
    ) {
      throw new PaymentStateError(
        `Cannot approve payment with current status '${payment.paymentStatus}'. Slip must be submitted first.`
      );
    }

    // Parse immutable snapshot to get customer quota (derived from Selling Price)
    const snapshot: CalculationSnapshot = JSON.parse(payment.calculationSnapshot);
    const customerQuotaCny =
      snapshot.customer_quota_cny ||
      snapshot.display_reference_value_cny ||
      snapshot.assigned_upstream_quota_cny ||
      snapshot.assigned_quota_cny;

    const verifiedAmount = params.verifiedAmountThb
      ? new Decimal(params.verifiedAmountThb).toString()
      : payment.expectedAmountThb.toString();

    // Atomic status transition using conditional update:
    // Guarantees strict concurrency safety and idempotency
    const updateResult = await prisma.payment.updateMany({
      where: {
        id: payment.id,
        paymentStatus: { in: [PAYMENT_STATUS.UNDER_REVIEW, PAYMENT_STATUS.SLIP_SUBMITTED] },
      },
      data: {
        paymentStatus: PAYMENT_STATUS.APPROVED,
        reviewerDiscordId: params.reviewerDiscordId,
        verifiedAmountThb: verifiedAmount,
        approvedAt: new Date(),
      },
    });

    if (updateResult.count === 0) {
      const current = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { customer: true, package: true },
      });
      const profile = await this.customerService.getCustomerProfile(current.customer.discordUserId);
      return {
        payment: current,
        customerProfile: profile,
        alreadyProcessed: true,
      };
    }

    const approvedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: {
        customer: true,
        package: true,
      },
    });

    // 1. Credit reference balance with Customer Quota (calculated from Selling Price)
    const updatedProfile = await this.customerService.updateRecordedBalance(
      payment.customer.discordUserId,
      customerQuotaCny
    );

    // 2. Assign package's model group to customer
    await this.customerService.assignModelGroup(
      payment.customer.discordUserId,
      payment.package.groupId
    );

    // 3. Initialize BearLab funding allocation for top-up recommendation (derived ONLY from Base Cost)
    try {
      const fundingService = new FundingService();
      const providerCostCny = snapshot.provider_cost_cny
        ? new Decimal(snapshot.provider_cost_cny)
        : new Decimal(payment.package.referenceModelCostCny.toString())
            .times(payment.package.referenceRequests);
      await fundingService.createFundingAllocationForPayment({
        paymentId: payment.id,
        packageId: payment.package.id,
        providerCostCny,
      });
    } catch {
      // Non-blocking funding tracking
    }

    // 4. Customer Token Provisioning via New API Gateway
    let tokenProvisionResult: any;
    try {
      tokenProvisionResult = await this.tokenProvisioningService.provisionTokenForPayment(payment.id);
    } catch (err: any) {
      // Non-blocking: Payment remains APPROVED even if New API is unavailable or times out
      tokenProvisionResult = {
        error: err.message,
        isNewToken: false,
      };
    }

    // 5. Legacy initial API key if customer has none yet (Deprecated in favor of New API tokens)
    let newlyIssuedApiKey: string | undefined;
    if (!payment.customer.nextaiApiKeyHash) {
      const keyResult = await this.customerService.generateOrRotateApiKey(
        payment.customer.discordUserId
      );
      newlyIssuedApiKey = keyResult.plainTextApiKey;
      updatedProfile.apiKey = newlyIssuedApiKey;
    }

    // 6. Audit Log
    try {
      await prisma.auditLog.create({
        data: {
          actorDiscordId: params.reviewerDiscordId,
          action: 'PAYMENT_APPROVE',
          targetType: 'PAYMENT',
          targetId: payment.id,
          details: JSON.stringify({
            verifiedAmountThb: verifiedAmount,
            customerQuotaCny,
            assignedQuotaCny: customerQuotaCny,
            providerCostCny: snapshot.provider_cost_cny,
            groupId: payment.package.groupId,
            customerDiscordId: payment.customer.discordUserId,
          }),
        },
      });
    } catch {
      // Audit log non-blocking
    }

    return {
      payment: approvedPayment,
      customerProfile: updatedProfile,
      newlyIssuedApiKey,
      tokenRecord: tokenProvisionResult?.tokenRecord,
      tokenProvisionResult,
      alreadyProcessed: false,
    };
  }

  /**
   * Manual administrator rejection.
   */
  public async rejectPayment(params: {
    paymentId: string;
    reviewerDiscordId: string;
    rejectionReason: string;
  }) {
    const prisma = getPrismaClient();

    const payment = await prisma.payment.findUnique({
      where: { id: params.paymentId },
      include: { customer: true },
    });

    if (!payment) {
      throw new PaymentNotFoundError(params.paymentId);
    }

    if (payment.paymentStatus === PAYMENT_STATUS.APPROVED) {
      throw new PaymentStateError('Cannot reject an already approved payment.');
    }

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: PAYMENT_STATUS.REJECTED,
        reviewerDiscordId: params.reviewerDiscordId,
        rejectionReason: params.rejectionReason,
      },
      include: {
        customer: true,
        package: true,
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          actorDiscordId: params.reviewerDiscordId,
          action: 'PAYMENT_REJECT',
          targetType: 'PAYMENT',
          targetId: payment.id,
          details: JSON.stringify({
            reason: params.rejectionReason,
            customerDiscordId: payment.customer.discordUserId,
          }),
        },
      });
    } catch {
      // Non-blocking
    }

    return updatedPayment;
  }

  /**
   * Retrieves pending reviews.
   */
  public async getPendingReviews() {
    const prisma = getPrismaClient();
    return prisma.payment.findMany({
      where: {
        paymentStatus: {
          in: [PAYMENT_STATUS.UNDER_REVIEW, PAYMENT_STATUS.SLIP_SUBMITTED],
        },
      },
      include: {
        customer: true,
        package: true,
        slips: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Fetches payment details by ID.
   */
  public async getPaymentById(paymentId: string) {
    const prisma = getPrismaClient();
    return prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        customer: true,
        package: true,
        slips: true,
      },
    });
  }
}
