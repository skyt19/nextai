import { Decimal } from 'decimal.js';
import { getPrismaClient } from '../db/client.js';

export const FUNDING_STATUS = {
  PENDING_FUNDING: 'PENDING_FUNDING',
  ALLOCATED: 'ALLOCATED',
  REFUNDED_CANCELLED: 'REFUNDED_CANCELLED',
} as const;

export type FundingStatus = (typeof FUNDING_STATUS)[keyof typeof FUNDING_STATUS];

export const TOPUP_RECOMMENDATION_STATUS = {
  BELOW_MINIMUM: 'BELOW_MINIMUM',
  READY_TO_TOP_UP: 'READY_TO_TOP_UP',
  TOP_UP_RECORDED: 'TOP_UP_RECORDED',
} as const;

export type TopupRecommendationStatus =
  (typeof TOPUP_RECOMMENDATION_STATUS)[keyof typeof TOPUP_RECOMMENDATION_STATUS];

export interface FundingRecommendation {
  status: TopupRecommendationStatus;
  pendingFundingAmountCny: Decimal;
  recommendedTopupAmountCny: Decimal;
  minimumTopupCny: Decimal;
  isReadyToTopUp: boolean;
  message: string;
}

export interface FundingDashboardData {
  totalReferenceProviderCostCny: string;
  pendingFundingAmountCny: string;
  recommendedTopupAmountCny: string;
  status: TopupRecommendationStatus;
  minimumTopupCny: string;
  totalActualRecordedTopupCny: string;
  topupHistory: Array<{
    id: string;
    amountCny: string;
    topupDate: string;
    adminDiscordId: string;
    notes: string | null;
  }>;
  allocatedPackagesCount: number;
  pendingPackagesCount: number;
}

export class FundingService {
  public static readonly MINIMUM_TOPUP_CNY = new Decimal(10);

  /**
   * Calculates the recommended BearLab top-up amount using the CEILING rule:
   * Recommended Top-up = CEILING(Pending Funding Amount / 10) * 10
   * Minimum Top-up = ¥10
   */
  public static calculateRecommendation(
    pendingFundingAmount: Decimal | number | string
  ): FundingRecommendation {
    const pending = new Decimal(pendingFundingAmount);

    if (pending.lessThan(FundingService.MINIMUM_TOPUP_CNY)) {
      return {
        status: TOPUP_RECOMMENDATION_STATUS.BELOW_MINIMUM,
        pendingFundingAmountCny: pending,
        recommendedTopupAmountCny: new Decimal(0),
        minimumTopupCny: FundingService.MINIMUM_TOPUP_CNY,
        isReadyToTopUp: false,
        message: 'ยอดต้นทุนสะสมยังไม่ถึงขั้นต่ำการเติมเงิน (ขั้นต่ำ ¥10)',
      };
    }

    // CEILING(pending / 10) * 10
    const divided = pending.dividedBy(10);
    const ceilingUnits = divided.ceil();
    const recommendedTopup = ceilingUnits.times(10);

    return {
      status: TOPUP_RECOMMENDATION_STATUS.READY_TO_TOP_UP,
      pendingFundingAmountCny: pending,
      recommendedTopupAmountCny: recommendedTopup,
      minimumTopupCny: FundingService.MINIMUM_TOPUP_CNY,
      isReadyToTopUp: true,
      message: `ยอดต้นทุนสะสมถึงขั้นต่ำแล้ว แนะนำเติมเงิน ¥${recommendedTopup.toFixed(2)} CNY`,
    };
  }

  /**
   * Creates or links a funding allocation record for an approved payment.
   * STRICT INTEGRITY: One Package Purchase can only have ONE Funding Allocation.
   */
  public async createFundingAllocationForPayment(params: {
    paymentId: string;
    packageId: string;
    providerCostCny: Decimal | number | string;
    notes?: string;
  }) {
    const prisma = getPrismaClient();
    const cost = new Decimal(params.providerCostCny).toFixed(4);

    return await prisma.fundingAllocation.upsert({
      where: { paymentId: params.paymentId },
      create: {
        paymentId: params.paymentId,
        packageId: params.packageId,
        providerCostCny: cost,
        status: FUNDING_STATUS.PENDING_FUNDING,
        notes: params.notes,
      },
      update: {
        // If already exists, do not overwrite if allocated
      },
    });
  }

  /**
   * Retrieves the comprehensive BearLab Funding Dashboard.
   * STRICT SECURITY: Pure administrative view; never connects to BearLab API.
   */
  public async getFundingDashboard(): Promise<FundingDashboardData> {
    const prisma = getPrismaClient();

    // 1. Fetch all funding allocations
    const allocations = await prisma.fundingAllocation.findMany();

    let totalCost = new Decimal(0);
    let pendingFunding = new Decimal(0);
    let allocatedCount = 0;
    let pendingCount = 0;

    for (const alloc of allocations) {
      if (alloc.status === FUNDING_STATUS.REFUNDED_CANCELLED) {
        continue;
      }

      const cost = new Decimal(alloc.providerCostCny.toString());
      totalCost = totalCost.plus(cost);

      if (alloc.status === FUNDING_STATUS.PENDING_FUNDING) {
        pendingFunding = pendingFunding.plus(cost);
        pendingCount++;
      } else if (alloc.status === FUNDING_STATUS.ALLOCATED) {
        allocatedCount++;
      }
    }

    // 2. Fetch manual top-up history
    const topups = await prisma.bearlabTopupRecord.findMany({
      orderBy: { topupDate: 'desc' },
    });

    let totalRecordedTopup = new Decimal(0);
    for (const topup of topups) {
      totalRecordedTopup = totalRecordedTopup.plus(new Decimal(topup.amountCny.toString()));
    }

    const recommendation = FundingService.calculateRecommendation(pendingFunding);

    let status = recommendation.status;
    if (pendingFunding.isZero() && topups.length > 0) {
      status = TOPUP_RECOMMENDATION_STATUS.TOP_UP_RECORDED;
    }

    return {
      totalReferenceProviderCostCny: totalCost.toFixed(2),
      pendingFundingAmountCny: pendingFunding.toFixed(2),
      recommendedTopupAmountCny: recommendation.recommendedTopupAmountCny.toFixed(2),
      status,
      minimumTopupCny: FundingService.MINIMUM_TOPUP_CNY.toFixed(2),
      totalActualRecordedTopupCny: totalRecordedTopup.toFixed(2),
      topupHistory: topups.map((t) => ({
        id: t.id,
        amountCny: new Decimal(t.amountCny.toString()).toFixed(2),
        topupDate: t.topupDate.toISOString(),
        adminDiscordId: t.adminDiscordId,
        notes: t.notes,
      })),
      allocatedPackagesCount: allocatedCount,
      pendingPackagesCount: pendingCount,
    };
  }

  /**
   * Records a manual BearLab top-up by an Administrator.
   * NO AUTO TOP-UP: Recorded solely for bookkeeping and decision support.
   */
  public async recordManualTopup(params: {
    amountCny: Decimal | number | string;
    adminDiscordId: string;
    notes?: string;
  }) {
    const prisma = getPrismaClient();
    const amount = new Decimal(params.amountCny);

    if (amount.lessThanOrEqualTo(0)) {
      throw new Error('Top-up amount must be greater than zero.');
    }

    const topup = await prisma.bearlabTopupRecord.create({
      data: {
        amountCny: amount.toFixed(2),
        adminDiscordId: params.adminDiscordId,
        notes: params.notes,
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          actorDiscordId: params.adminDiscordId,
          action: 'BEARLAB_MANUAL_TOPUP_RECORDED',
          targetType: 'BEARLAB_TOPUP',
          targetId: topup.id,
          details: JSON.stringify({
            amountCny: amount.toFixed(2),
            notes: params.notes,
          }),
        },
      });
    } catch {
      // Non-blocking audit log
    }

    return topup;
  }

  /**
   * Marks specific packages as having their provider cost allocated/funded.
   * STRICT INTEGRITY:
   * - One Package Purchase can only be allocated once.
   * - Prevents duplicate cost allocation.
   */
  public async allocatePackagesForFunding(params: {
    paymentIds: string[];
    adminDiscordId: string;
    topupRecordId?: string;
    notes?: string;
  }) {
    const prisma = getPrismaClient();
    const results = [];

    for (const paymentId of params.paymentIds) {
      const allocation = await prisma.fundingAllocation.findUnique({
        where: { paymentId },
      });

      if (!allocation) {
        throw new Error(`Funding allocation for payment '${paymentId}' not found.`);
      }

      if (allocation.status === FUNDING_STATUS.ALLOCATED) {
        throw new Error(`Package purchase for payment '${paymentId}' has already been allocated for funding.`);
      }

      if (allocation.status === FUNDING_STATUS.REFUNDED_CANCELLED) {
        throw new Error(`Cannot allocate cancelled or refunded payment '${paymentId}'.`);
      }

      const updated = await prisma.fundingAllocation.update({
        where: { paymentId },
        data: {
          status: FUNDING_STATUS.ALLOCATED,
          allocatedAt: new Date(),
          allocatedByDiscordId: params.adminDiscordId,
          topupRecordId: params.topupRecordId,
          notes: params.notes || allocation.notes,
        },
      });

      try {
        await prisma.auditLog.create({
          data: {
            actorDiscordId: params.adminDiscordId,
            action: 'PACKAGE_FUNDING_ALLOCATED',
            targetType: 'FUNDING_ALLOCATION',
            targetId: updated.id,
            details: JSON.stringify({
              paymentId,
              providerCostCny: updated.providerCostCny.toString(),
              topupRecordId: params.topupRecordId,
            }),
          },
        });
      } catch {
        // Non-blocking audit log
      }

      results.push(updated);
    }

    return results;
  }

  /**
   * Cancels or refunds a package's funding allocation.
   * Preserves audit trail; does not delete the database row.
   */
  public async cancelOrRefundFundingAllocation(
    paymentId: string,
    adminDiscordId: string,
    reason: string
  ) {
    const prisma = getPrismaClient();

    const allocation = await prisma.fundingAllocation.findUnique({
      where: { paymentId },
    });

    if (!allocation) {
      throw new Error(`Funding allocation for payment '${paymentId}' not found.`);
    }

    if (allocation.status === FUNDING_STATUS.REFUNDED_CANCELLED) {
      return allocation;
    }

    const updated = await prisma.fundingAllocation.update({
      where: { paymentId },
      data: {
        status: FUNDING_STATUS.REFUNDED_CANCELLED,
        notes: `Refunded/Cancelled: ${reason}`,
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          actorDiscordId: adminDiscordId,
          action: 'PACKAGE_FUNDING_CANCELLED',
          targetType: 'FUNDING_ALLOCATION',
          targetId: updated.id,
          details: JSON.stringify({ paymentId, reason }),
        },
      });
    } catch {
      // Non-blocking audit log
    }

    return updated;
  }
}
