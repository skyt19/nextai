import { Decimal } from 'decimal.js';
import { GROUP_MARKUPS, ModelGroupId } from '../config/constants.js';

export interface CalculationInput {
  groupId: ModelGroupId | string;
  referenceModelCostCny: Decimal | string | number; // reference_model_bp_cny
  referenceRequests: number;
  packageSellingPriceThb: Decimal | string | number; // admin-configured selling price THB (e.g. 51.00)
  cnyToThbRate: Decimal | string | number; // FX rate snapshot (e.g. 5.0764)
  exchangeRateDate: string;
  customMarkup?: Decimal | string | number;
  bufferCny?: Decimal | string | number; // default: 0
  fxSpreadPercent?: Decimal | string | number;
  includeBufferInSellingPrice?: boolean;
}

export interface CalculationSnapshot {
  // Section 7 Primary Terminology
  base_cost_cny: string;
  markup: string;
  selling_price_cny: string;
  reference_requests: number;
  provider_cost_cny: string;
  customer_quota_cny: string;
  package_selling_price_thb: string;

  // Existing Financial Fields
  reference_model_bp_cny: string;
  group_markup: string;
  display_price_per_request_cny: string;
  display_reference_value_cny: string;
  provider_cost_budget_cny: string;
  configured_buffer_cny: string;
  assigned_upstream_quota_cny: string;
  final_payment_amount_thb: string;
  cny_to_thb_rate: string;
  exchange_rate_date: string;
  fx_spread_percent: string;
  estimated_provider_cost_thb: string;
  estimated_gross_profit_thb: string;
  estimated_gross_margin_percent: string;
  calculation_timestamp: string;

  // Backward-compatibility aliases for existing consumers and historical snapshots
  provider_base_price_cny: string;
  selling_price_per_request_cny: string;
  package_selling_price_cny: string;
  buffer_cny: string;
  assigned_quota_cny: string;
}

export interface CalculationResult {
  // Section 7 Primary Terminology
  baseCostCny: Decimal;
  markup: Decimal;
  sellingPriceCny: Decimal;
  referenceRequests: number;
  providerCostCny: Decimal;
  customerQuotaCny: Decimal;
  packageSellingPriceThb: Decimal;

  // Existing Fields
  referenceModelBpCny: Decimal;
  groupMarkup: Decimal;
  displayPricePerRequestCny: Decimal;
  displayReferenceValueCny: Decimal;
  providerCostBudgetCny: Decimal;
  bufferCny: Decimal;
  assignedUpstreamQuotaCny: Decimal;
  finalPaymentAmountThb: Decimal;
  cnyToThbRate: Decimal;
  estimatedProviderCostThb: Decimal;
  estimatedGrossProfitThb: Decimal;
  estimatedGrossMarginPercent: Decimal;
  snapshot: CalculationSnapshot;

  // Backward-compatibility aliases
  providerBasePriceCny: Decimal;
  sellingPricePerRequestCny: Decimal;
  packageSellingPriceCny: Decimal;
  assignedQuotaCny: Decimal;
}

export class QuotaCalculator {
  /**
   * Calculates Selling Price per request:
   * Selling Price = Base Cost × Group Markup
   * e.g. NxG1: ¥0.020 × 2.5 = ¥0.050/request
   * e.g. NxGE: ¥0.030 × 3.0 = ¥0.090/request
   * e.g. NxGC: ¥0.030 × 2.5 = ¥0.075/request
   */
  public static calculateSellingPrice(
    baseCostCny: Decimal | string | number,
    markup: Decimal | string | number
  ): Decimal {
    const cost = new Decimal(baseCostCny);
    const m = new Decimal(markup);
    if (cost.isNegative()) {
      throw new Error('Base cost cannot be negative.');
    }
    if (m.lessThanOrEqualTo(0)) {
      throw new Error('Markup must be positive.');
    }
    return cost.times(m);
  }

  /**
   * Calculates Provider Cost (BearLab):
   * Provider Cost = Base Cost × Reference Requests
   * e.g. NxG1: ¥0.020 × 100 = ¥2.00
   * e.g. NxGE: ¥0.030 × 100 = ¥3.00
   * e.g. NxGC: ¥0.030 × 100 = ¥3.00
   * STRICT SEPARATION: Sourced ONLY from Base Cost for BearLab Provider Cost Budget and Funding Recommendations.
   * NEVER calculated from Selling Price or Customer Quota!
   */
  public static calculateProviderCost(
    baseCostCny: Decimal | string | number,
    referenceRequests: number
  ): Decimal {
    if (referenceRequests <= 0 || !Number.isInteger(referenceRequests)) {
      throw new Error('Reference requests must be a positive integer.');
    }
    const cost = new Decimal(baseCostCny);
    if (cost.isNegative()) {
      throw new Error('Base cost cannot be negative.');
    }
    return cost.times(new Decimal(referenceRequests));
  }

  /**
   * Calculates Customer Quota granted to Customer API Token in New API:
   * Customer Quota = Selling Price × Reference Requests
   * or Customer Quota = Base Cost × Group Markup × Reference Requests
   * e.g. NxG1: ¥0.050 × 100 = ¥5.00
   * e.g. NxGE: ¥0.090 × 100 = ¥9.00
   * e.g. NxGC: ¥0.075 × 100 = ¥7.50
   * STRICT SEPARATION: Calculated from Selling Price AFTER markup, NEVER from Base Cost directly!
   */
  public static calculateCustomerQuota(
    sellingPriceCny: Decimal | string | number,
    referenceRequests: number
  ): Decimal {
    if (referenceRequests <= 0 || !Number.isInteger(referenceRequests)) {
      throw new Error('Reference requests must be a positive integer.');
    }
    const price = new Decimal(sellingPriceCny);
    if (price.isNegative()) {
      throw new Error('Selling price cannot be negative.');
    }
    return price.times(new Decimal(referenceRequests));
  }

  /**
   * Calculates Customer Quota directly from Base Cost, Markup, and Requests:
   * Customer Quota = Base Cost × Group Markup × Reference Requests
   */
  public static calculateCustomerQuotaFromBaseCost(
    baseCostCny: Decimal | string | number,
    markup: Decimal | string | number,
    referenceRequests: number
  ): Decimal {
    const sellingPrice = QuotaCalculator.calculateSellingPrice(baseCostCny, markup);
    return QuotaCalculator.calculateCustomerQuota(sellingPrice, referenceRequests);
  }

  /**
   * Calculates Original Provider Reference Cost (BearLab cost):
   * Provider Cost = Original Provider Price * Number of Requests
   * Used strictly for funding and top-up recommendations (NEVER replaced by selling price).
   */
  public static calculateOriginalProviderCost(
    originalProviderPriceCny: Decimal | string | number,
    referenceRequests: number
  ): Decimal {
    return QuotaCalculator.calculateProviderCost(originalProviderPriceCny, referenceRequests);
  }

  /**
   * Calculates the website display price per request in CNY:
   * display_price_per_request_cny = reference_bp * markup (e.g. 0.020 * 2.5 = 0.050 CNY/request)
   */
  public static calculateDisplayPrice(
    referenceModelBpCny: Decimal | string | number,
    markup: Decimal | string | number
  ): Decimal {
    return QuotaCalculator.calculateSellingPrice(referenceModelBpCny, markup);
  }

  /**
   * Calculates the theoretical website display price for reference requests in CNY:
   * display_price_for_reference_requests_cny = display_price_per_request_cny * reference_requests (e.g. 0.050 * 100 = 5.00 CNY)
   * NOTE: This is only a theoretical display-price reference. It is NOT customer payment and NOT BearLab allocation.
   */
  public static calculateDisplayReferenceValue(
    displayPricePerRequestCny: Decimal | string | number,
    referenceRequests: number
  ): Decimal {
    return QuotaCalculator.calculateCustomerQuota(displayPricePerRequestCny, referenceRequests);
  }

  /**
   * Calculates BearLab upstream provider cost budget in CNY:
   * provider_cost_budget_cny = reference_bp * reference_requests (e.g. 0.020 * 100 = 2.00 CNY)
   */
  public static calculateProviderCostBudget(
    referenceBpCny: Decimal | string | number,
    referenceRequests: number
  ): Decimal {
    return QuotaCalculator.calculateProviderCost(referenceBpCny, referenceRequests);
  }

  /**
   * Calculates BearLab upstream allocation quota in CNY:
   * assigned_upstream_quota_cny = provider_cost_budget_cny + configured_buffer_cny (e.g. 2.00 + 0 = 2.00 CNY)
   * Default buffer is zero unless explicitly configured.
   */
  public static calculateUpstreamAllocation(
    providerCostBudgetCny: Decimal | string | number,
    bufferCny: Decimal | string | number = 0
  ): Decimal {
    return new Decimal(providerCostBudgetCny).plus(new Decimal(bufferCny ?? 0));
  }

  /**
   * Calculates estimated gross profit based on admin-configured selling price THB, provider cost budget CNY, and FX rate:
   * estimated_provider_cost_thb = provider_cost_budget_cny * fx_rate
   * estimated_gross_profit_thb = package_selling_price_thb - estimated_provider_cost_thb
   * estimated_gross_margin_percent = (estimated_gross_profit_thb / package_selling_price_thb) * 100
   */
  public static calculateEstimatedGrossProfit(
    sellingPriceThb: Decimal | string | number,
    providerCostBudgetCny: Decimal | string | number,
    cnyToThbRate: Decimal | string | number
  ): {
    estimatedProviderCostThb: Decimal;
    estimatedGrossProfitThb: Decimal;
    estimatedGrossMarginPercent: Decimal;
  } {
    const sellingPrice = new Decimal(sellingPriceThb);
    const providerCostBudget = new Decimal(providerCostBudgetCny);
    const fxRate = new Decimal(cnyToThbRate);

    const estimatedProviderCostThb = providerCostBudget.times(fxRate);
    const estimatedGrossProfitThb = sellingPrice.minus(estimatedProviderCostThb);
    const estimatedGrossMarginPercent = sellingPrice.isPositive()
      ? estimatedGrossProfitThb.dividedBy(sellingPrice).times(100)
      : new Decimal(0);

    return {
      estimatedProviderCostThb,
      estimatedGrossProfitThb,
      estimatedGrossMarginPercent,
    };
  }

  /**
   * Calculates complete package parameters, separate display price, upstream budget/allocation,
   * and estimated gross profit. Ensures zero floating-point error using Decimal.js.
   *
   * STRICT SEPARATION:
   * - Final payment amount THB comes directly from the admin-configured package selling price (default: 51.00 THB).
   * - Never derived from BP * markup * requests * FX.
   */
  public static calculate(input: CalculationInput): CalculationResult {
    // 1. Strict input validation
    if (input.referenceRequests <= 0 || !Number.isInteger(input.referenceRequests)) {
      throw new Error('Reference requests must be a positive integer.');
    }

    const providerBasePriceCny = new Decimal(input.referenceModelCostCny);
    if (providerBasePriceCny.isNegative()) {
      throw new Error('Reference model cost cannot be negative.');
    }

    // Determine group markup (use default unless explicit custom markup is provided)
    const defaultMarkup = GROUP_MARKUPS[input.groupId as ModelGroupId];
    if (!defaultMarkup && !input.customMarkup) {
      throw new Error(`Unknown model group '${input.groupId}' and no custom markup specified.`);
    }
    const groupMarkup = new Decimal(input.customMarkup ?? defaultMarkup);

    const baseExchangeRate = new Decimal(input.cnyToThbRate);
    if (baseExchangeRate.lessThanOrEqualTo(0)) {
      throw new Error('Exchange rate must be positive.');
    }

    const fxSpread = new Decimal(input.fxSpreadPercent ?? 0);
    // Adjusted rate = baseExchangeRate * (1 + fxSpread / 100)
    const effectiveExchangeRate = baseExchangeRate.times(new Decimal(1).plus(fxSpread.dividedBy(100)));

    // Buffer is added ONCE per package, not per request (default: 0)
    const bufferCny = new Decimal(input.bufferCny ?? 0);
    if (bufferCny.isNegative()) {
      throw new Error('Buffer amount cannot be negative.');
    }

    // 2. Exact Calculations per Specification
    const baseCostCny = providerBasePriceCny;
    const markup = groupMarkup;

    // A. NextAI Selling Price per request: Base Cost × Markup (e.g. 0.020 * 2.5 = 0.050 CNY/request)
    const sellingPriceCny = QuotaCalculator.calculateSellingPrice(baseCostCny, markup);
    const displayPricePerRequestCny = sellingPriceCny;

    // B. BearLab Upstream Cost Budget: Base Cost × Reference Requests (e.g. 0.020 * 100 = 2.00 CNY)
    const providerCostCny = QuotaCalculator.calculateProviderCost(baseCostCny, input.referenceRequests);
    const providerCostBudgetCny = providerCostCny;

    // C. Customer Quota (granted in New API for customer token): Selling Price × Reference Requests (e.g. 0.050 * 100 = 5.00 CNY)
    let customerQuotaCny = QuotaCalculator.calculateCustomerQuota(sellingPriceCny, input.referenceRequests);
    if (input.includeBufferInSellingPrice && bufferCny.isPositive()) {
      customerQuotaCny = customerQuotaCny.plus(bufferCny.times(markup));
    }
    const displayReferenceValueCny = customerQuotaCny;

    // Upstream Allocation (Provider Cost + Buffer):
    const assignedUpstreamQuotaCny = QuotaCalculator.calculateUpstreamAllocation(providerCostBudgetCny, bufferCny);

    // D. Actual Package Selling Price (Configured by Administrator, NEVER derived from BP, markup, or FX)
    // Explicit selling price is strictly required; never falls back to an implicit or silent default.
    if (input.packageSellingPriceThb === undefined || input.packageSellingPriceThb === null) {
      throw new Error('Package selling price in THB must be explicitly provided.');
    }
    const rawSellingPrice = new Decimal(input.packageSellingPriceThb);
    if (rawSellingPrice.lessThanOrEqualTo(0)) {
      throw new Error('Package selling price in THB must be a positive number.');
    }
    const packageSellingPriceThb = rawSellingPrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const finalPaymentAmountThb = packageSellingPriceThb;

    // E. Estimated Gross Profit (Projection only)
    const profit = QuotaCalculator.calculateEstimatedGrossProfit(
      packageSellingPriceThb,
      providerCostBudgetCny,
      effectiveExchangeRate
    );

    const calculationTimestamp = new Date().toISOString();

    // 3. Immutable snapshot
    const snapshot: CalculationSnapshot = {
      // Section 7 Primary Terminology
      base_cost_cny: baseCostCny.toFixed(4),
      markup: markup.toFixed(2),
      selling_price_cny: sellingPriceCny.toFixed(4),
      reference_requests: input.referenceRequests,
      provider_cost_cny: providerCostCny.toFixed(4),
      customer_quota_cny: customerQuotaCny.toFixed(4),
      package_selling_price_thb: packageSellingPriceThb.toFixed(2),

      // Existing Financial Fields
      reference_model_bp_cny: baseCostCny.toFixed(4),
      group_markup: markup.toFixed(2),
      display_price_per_request_cny: displayPricePerRequestCny.toFixed(4),
      display_reference_value_cny: displayReferenceValueCny.toFixed(4),
      provider_cost_budget_cny: providerCostBudgetCny.toFixed(4),
      configured_buffer_cny: bufferCny.toFixed(4),
      assigned_upstream_quota_cny: assignedUpstreamQuotaCny.toFixed(4),
      final_payment_amount_thb: finalPaymentAmountThb.toFixed(2),
      cny_to_thb_rate: effectiveExchangeRate.toFixed(4),
      exchange_rate_date: input.exchangeRateDate,
      fx_spread_percent: fxSpread.toFixed(2),
      estimated_provider_cost_thb: profit.estimatedProviderCostThb.toFixed(2),
      estimated_gross_profit_thb: profit.estimatedGrossProfitThb.toFixed(2),
      estimated_gross_margin_percent: profit.estimatedGrossMarginPercent.toFixed(2),
      calculation_timestamp: calculationTimestamp,

      // Backward-compatibility aliases:
      provider_base_price_cny: baseCostCny.toFixed(4),
      selling_price_per_request_cny: displayPricePerRequestCny.toFixed(4),
      package_selling_price_cny: displayReferenceValueCny.toFixed(4),
      buffer_cny: bufferCny.toFixed(4),
      assigned_quota_cny: assignedUpstreamQuotaCny.toFixed(4),
    };

    return {
      // Section 7 Primary Terminology
      baseCostCny,
      markup,
      sellingPriceCny,
      referenceRequests: input.referenceRequests,
      providerCostCny,
      customerQuotaCny,
      packageSellingPriceThb,

      // Existing Fields
      referenceModelBpCny: baseCostCny,
      groupMarkup: markup,
      displayPricePerRequestCny,
      displayReferenceValueCny,
      providerCostBudgetCny,
      bufferCny,
      assignedUpstreamQuotaCny,
      finalPaymentAmountThb,
      cnyToThbRate: effectiveExchangeRate,
      estimatedProviderCostThb: profit.estimatedProviderCostThb,
      estimatedGrossProfitThb: profit.estimatedGrossProfitThb,
      estimatedGrossMarginPercent: profit.estimatedGrossMarginPercent,
      snapshot,

      // Backward-compatibility aliases:
      providerBasePriceCny: baseCostCny,
      sellingPricePerRequestCny: displayPricePerRequestCny,
      packageSellingPriceCny: displayReferenceValueCny,
      assignedQuotaCny: assignedUpstreamQuotaCny,
    };
  }

  /**
   * Helper to compute request selling price given model base cost and group.
   */
  public static calculateRequestPrice(
    baseCostCny: Decimal | string | number,
    groupId: ModelGroupId
  ): Decimal {
    const markup = new Decimal(GROUP_MARKUPS[groupId]);
    return new Decimal(baseCostCny).times(markup);
  }
}
